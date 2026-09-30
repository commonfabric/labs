/**
 * Multi-browser voting test for the lunch poll.
 *
 * Drives two simultaneous browser profiles (separate identities, same piece):
 * a host who joins first and adds options, and a second user who joins and
 * votes. Each user joins profile-first — creating their shared profile through
 * the `#profile` wish's create surface rendered inside the join card — since
 * the poll's identity IS the profile cell and there is no typed-name path. It
 * exercises the path the headless multiUserTest cannot — real DOM
 * event provenance through cf-button, login, and live cross-browser propagation
 * — and checks that two users voting on the SAME option end up with both votes
 * counted: the tally reaches "2 love it" on both browsers. The two greens are
 * cast CONCURRENTLY (both clicks dispatched before either side settles), so the
 * second voter is not guaranteed to have observed the first vote, and the votes
 * are distinct entities (one per voter), so "2 love it" requires two surviving
 * votes rather than one double-counted one.
 *
 * The deterministic stale-base no-clobber proof — where the second writer
 * commits against a base that provably lacks the first vote — lives in the
 * runner-level packages/runner/test/array-push-mergeable.test.ts, which can pin
 * the base exactly. This test is the end-to-end smoke that the same behavior
 * holds through the browser stack.
 */

import {
  createTestSpace,
  env,
  type Page,
  waitFor,
} from "@commonfabric/integration";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { type DID, Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  armSenderEcho,
  clickCfButton,
  clickCfButtonsConcurrently,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  installSenderEchoProbe,
  logBrowserLoadSummary,
  logSenderEchoSummary,
  logStepTimings,
  readSenderEchoReport,
  StepTimer,
  waitForActiveSpaceRoot,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;
const PROPAGATION_TIMEOUT = 60_000;
// The opt-in sender-echo instrument (W4): time each authored click to the
// SENDER's own speculative render, beside the cross-browser waits. Off by
// default: the ordinary gate run is unchanged.
const SENDER_ECHO = Deno.env.get("CF_SENDER_ECHO") === "1";
const SENDER_ECHO_ARM = (() => {
  const raw = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
  const on = raw === undefined
    ? SERVER_EXECUTION_DEFAULT_ENABLED
    : raw === "true";
  return on ? "ON" : "OFF";
})();
// The `#profile` wish's create surface: its input id and trusted action are
// pinned by the runner (wish.ts `inputId`) and the profile-create pattern —
// the same pair shared-profile.test.ts drives.
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

const HOST = "Alice";
const GUEST = "Bob";
const OPTION_A = "Sushi Place";
const OPTION_B = "Taco Stand";

const optionCard = (title: string) => `[data-option-title="${title}"]`;
const voteButton = (title: string, color: "green" | "yellow" | "red") =>
  `${optionCard(title)} cf-button[data-vote="${color}"]`;

// The voter names that currently have a vote swatch in the "All options"
// summary, descending through shadow roots. Each swatch carries a
// `data-vote-swatch-name` hook with the voter's name. On a given browser this
// includes every voter whose vote that browser can see — so checking the host's
// swatches names the votes that crossed from the guest's browser.
const voteSwatchVoters = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const names = new Set<string>();
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("[data-vote-swatch-name]")) {
        const name = el.getAttribute("data-vote-swatch-name");
        if (name) names.add(name);
      }
      for (const el of root.querySelectorAll("*")) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(document);
    return [...names];
  });

// Every swatch node the "All options" summary rendered, named or not.
// `voteSwatchVoters` above drops a swatch whose name is empty, so the two
// counts together separate a summary still holding the pre-vote subtree, which
// has no swatch node at all, from one whose swatches carry no name, which is a
// roster the tally could not match a vote's voter against.
const voteSwatchCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    let count = 0;
    const walk = (root: Document | ShadowRoot) => {
      count += root.querySelectorAll("[data-vote-swatch-name]").length;
      for (const el of root.querySelectorAll("*")) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(document);
    return count;
  });

// The participant chips currently rendered in the board's participants strip
// (`data-participant-guest` — typed-name joins are guests; profile-backed
// participants render `data-participant-badge`), descending through shadow
// roots, DUPLICATES KEPT: under server execution the joiner's own browser
// renders its speculative join echo and the confirmed join through one read
// path, so a stranded echo shows as the SAME name twice (W0 l3: "3 joined,
// Alice, Alice, Bob"). The confirmed roster is exactly one chip per name.
const participantChipNames = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const names: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (
        const el of root.querySelectorAll(
          "[data-participant-guest], [data-participant-badge]",
        )
      ) {
        const name = el.getAttribute("data-participant-guest") ??
          el.getAttribute("data-participant-badge");
        if (name) names.push(name);
      }
      for (const el of root.querySelectorAll("*")) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(document);
    return names;
  });

// What one browser can say about the tally, for the message the swatch wait
// below throws when it fails. A bare `waitFor` timeout names neither the
// browser that is behind nor what it is rendering instead, and this step's
// failures are a minority of runs, so the run that fails is the only chance to
// see it. A page that cannot answer reports that instead: the wait fails for
// that reason too, and a report that threw would take the failure it is
// describing down with it.
const swatchReport = async (page: Page, label: string): Promise<string> => {
  try {
    const [voters, swatches, chips] = await Promise.all([
      voteSwatchVoters(page),
      voteSwatchCount(page),
      participantChipNames(page),
    ]);
    return `${label} holds ${swatches} swatch node(s) naming [${
      voters.join(", ")
    }], with participants [${chips.join(", ")}]`;
  } catch (error) {
    return `${label} could not be read (${error})`;
  }
};

describe("lunch poll: two users vote on a shared option", () => {
  const hostShell = new ShellIntegration({
    presentation: { id: "alice", label: "Alice", color: "#7c3aed" },
  });
  const guestShell = new ShellIntegration({
    presentation: { id: "bob", label: "Bob", color: "#0891b2" },
  });
  hostShell.bindLifecycle();
  guestShell.bindLifecycle();

  let hostIdentity: Identity;
  let guestIdentity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let pieceId: string;
  let resultSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    [hostIdentity, guestIdentity] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    spaceDid = await createTestSpace(hostIdentity, {
      grants: { [guestIdentity.did()]: "WRITE" },
    });
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity: hostIdentity,
      cfcFlowLabels: "persist",
    });

    // Create the space-root (default) pattern up front, the way a real space
    // gets it at creation time — so each browser's `pattern:getSpaceRoot` is a
    // storage-RESUME boot (byte-cache read + evaluate) rather than a create.
    // Without this, both browsers race ensureDefaultPattern and each
    // cold-compiles default-app inside its worker (~2s locally, 5-10s on
    // 2-core CI); those synchronous compile stretches wedge the worker event
    // loop, stall unrelated IPC for seconds, and under enough load starve the
    // first fill's commit ack — the "second-boot slow window".
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "lunch-poll",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    const resultCell = cc.getResult(piece.getCell());
    // Keep the piece running without materializing the whole UI tree in this
    // controller process; the two browsers render their own UI.
    resultSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    await cc?.dispose();
  });

  it("both users' votes on the same option survive, and a second option tallies independently", async () => {
    const timer = new StepTimer();
    const view = { spaceDid, pieceId };
    const hostPage = hostShell.page();
    const guestPage = guestShell.page();

    try {
      await timer.run(
        "navigate + login both",
        () =>
          Promise.all([
            hostShell.goto({
              frontendUrl: FRONTEND_URL,
              view,
              identity: hostIdentity,
            }),
            guestShell.goto({
              frontendUrl: FRONTEND_URL,
              view,
              identity: guestIdentity,
            }),
          ]),
      );
      // ShellIntegration.goto() waits for URL/login state, while RootView
      // resolves the space and AppView loads its active pattern
      // independently. A runtime can report idle during that handoff, with the
      // previous or provisional root still rendered. Wait for the PieceHandle
      // on each browser to belong to this poll's space before interacting with
      // either surface.
      await timer.run(
        "both active space roots ready",
        () =>
          Promise.all([
            waitForActiveSpaceRoot(hostPage, spaceDid),
            waitForActiveSpaceRoot(guestPage, spaceDid),
          ]),
      );
      await timer.run(
        "both runtimes idle",
        () =>
          Promise.all([
            waitForRuntimeIdle(hostPage),
            waitForRuntimeIdle(guestPage),
          ]),
      );
      if (SENDER_ECHO) {
        await Promise.all([
          installSenderEchoProbe(hostPage),
          installSenderEchoProbe(guestPage),
        ]);
      }

      // Host joins first -> becomes host/admin. Joining is profile-first:
      // identity is the viewer's shared `#profile` cell, and a fresh identity
      // has none, so the join card renders the wish's own create surface
      // (`data-profile-setup`). Creating a profile there is the only path in —
      // there is no typed-name fallback.
      await timer.run(
        "host profile name filled",
        () => fillCfInput(hostPage, "#wish-profile-name-input", HOST),
      );
      await clickTrustedAction(hostPage, TRUSTED_PROFILE_CREATE_ACTION);
      // Creation is a cross-space commit the runner drives through
      // pending/retry cycles; runtime idle is its completion signal (the
      // shared-profile precedent).
      await waitForRuntimeIdle(hostPage);
      // The join button renders once the `#profileName` wish resolves — the
      // product's own "you can join now" affordance. The `#profile` cell the
      // join gate also reads resolves from the same profiles list, and
      // `clickCfButton` re-settles before clicking; a premature click would
      // surface loudly as the rendered joinMessage, not a silent no-op.
      // Sender echo: the host's own speculative roster render — the joined
      // count ticking to "1 joined" on the CLICKING browser (the count, not
      // the name: the presentation overlay already renders "Alice").
      if (SENDER_ECHO) {
        await armSenderEcho(hostPage, "host-join", "body", "1 joined");
      }
      await clickCfButton(hostPage, "#lp-join-button");
      // "Join as Alice" renders the name before the join lands, so the
      // joined signal is the shared summary count, not the name.
      await timer.run(
        "host joined (count reaches 1)",
        () => waitForSettledText(hostPage, "body", "1 joined"),
      );

      // Guest joins second via the same guest path. Both joins LANDED is the
      // CONFIRMED roster on BOTH browsers: the participants strip shows
      // exactly one chip per name — {Alice, Bob} — and the count reads "2
      // joined". Not a count alone: under server execution the joiner's own
      // speculative echo satisfied "2 joined" on the host (spec-Alice +
      // confirmed Alice) in 7–16 ms, BEFORE the guest's join had landed
      // anywhere (W0 l3's "3 joined, Alice, Alice, Bob" when it did) — the
      // step passed spuriously on the echo and failed when the probe missed
      // the transient. The exact-chip form is RED on a standing echo (a
      // duplicated name, or three chips) and green only on the real
      // landing, so its wall time is at least a server round trip.
      // Guest joins second through the same profile-first flow. The board
      // shows a participant count, so the guest's join landing is observed as
      // "2 joined" on the host plus the guest's roster name crossing over,
      // and on the guest as the non-host's "hosted by Alice" attribution.
      await timer.run(
        "guest profile name filled",
        () => fillCfInput(guestPage, "#wish-profile-name-input", GUEST),
      );
      await clickTrustedAction(guestPage, TRUSTED_PROFILE_CREATE_ACTION);
      await waitForRuntimeIdle(guestPage);
      // Sender echo: the guest's own speculative join — "2 joined" on the
      // CLICKING browser (W0 measured this echo at 7–16 ms; the confirmed
      // exact-chip roster below is the landing, this is the speculation).
      if (SENDER_ECHO) {
        await armSenderEcho(guestPage, "guest-join", "body", "2 joined");
      }
      await clickCfButton(guestPage, "#lp-join-button");
      const confirmedRoster = async (page: Page): Promise<boolean> => {
        const chips = await participantChipNames(page);
        return chips.length === 2 && chips.includes(HOST) &&
          chips.includes(GUEST);
      };
      await timer.run(
        "both join lands (confirmed roster: exactly {Alice, Bob} on both)",
        () =>
          Promise.all([
            waitFor(() => confirmedRoster(hostPage), {
              timeout: PROPAGATION_TIMEOUT,
              delay: 250,
            }),
            waitFor(() => confirmedRoster(guestPage), {
              timeout: PROPAGATION_TIMEOUT,
              delay: 250,
            }),
            waitForSettledText(hostPage, "body", "2 joined"),
            waitForSettledText(guestPage, "body", "2 joined"),
            waitForSettledText(hostPage, "body", GUEST),
            waitForSettledText(guestPage, "body", `hosted by ${HOST}`),
          ]),
      );

      // Host adds the shared option.
      await fillCfInput(hostPage, "#lp-add-option-input", OPTION_A);
      // Sender echo: the host's own speculative render of the added option
      // (the typed draft lives in an input VALUE, so the pre-check cannot
      // trip on it; the option card's TEXT is the render).
      if (SENDER_ECHO) {
        await armSenderEcho(hostPage, "host-add-option-A", "body", OPTION_A);
      }
      await clickCfButton(hostPage, "#lp-add-option-button");
      await timer.run(
        "option A propagates to both",
        () =>
          Promise.all([
            waitForSettledText(hostPage, "body", OPTION_A),
            waitForSettledText(guestPage, "body", OPTION_A),
          ]),
      );

      // Both users vote green on the SAME option CONCURRENTLY. Both page views
      // settle before the pair is dispatched. Neither page settles again until
      // both clicks have been delivered. The second voter is not guaranteed to
      // have seen the first vote. The votes are distinct entities, keyed per
      // voter. Both must survive, and the tally reaches "2 love it" on BOTH
      // browsers. A clobbering whole-list write against a base that missed the
      // other vote would leave it at "1 love it".
      await timer.run(
        "both cast green concurrently",
        () =>
          clickCfButtonsConcurrently([
            {
              page: hostPage,
              selector: voteButton(OPTION_A, "green"),
            },
            {
              page: guestPage,
              selector: voteButton(OPTION_A, "green"),
            },
          ]),
      );
      await timer.run(
        "both browsers see 2 love it (merge)",
        () =>
          Promise.all([
            waitForSettledText(hostPage, "body", "2 love it"),
            waitForSettledText(guestPage, "body", "2 love it"),
          ]),
      );

      // Both voters' swatches are visible on BOTH browsers: the host sees the
      // guest's vote and vice versa. This is the cross-browser visibility the
      // count alone does not name — it identifies WHO voted, sourced from the
      // resolved tally so a remote voter's keyed entity is rendered.
      await timer.run(
        "both voters' swatches visible on both browsers",
        async () => {
          try {
            await waitFor(async () => {
              const [hostVoters, guestVoters] = await Promise.all([
                voteSwatchVoters(hostPage),
                voteSwatchVoters(guestPage),
              ]);
              return hostVoters.includes(HOST) &&
                hostVoters.includes(GUEST) &&
                guestVoters.includes(HOST) && guestVoters.includes(GUEST);
            }, { timeout: PROPAGATION_TIMEOUT, delay: 500 });
          } catch (cause) {
            const [host, guest] = await Promise.all([
              swatchReport(hostPage, HOST),
              swatchReport(guestPage, GUEST),
            ]);
            throw new Error(
              `The wait for both voters' swatches failed. ${host}. ${guest}.`,
              { cause },
            );
          }
        },
      );

      // A second option tallies independently: host adds it, guest vetoes it,
      // and option A's "2 love it" is unaffected.
      await fillCfInput(hostPage, "#lp-add-option-input", OPTION_B);
      await clickCfButton(hostPage, "#lp-add-option-button");
      await Promise.all([
        waitForSettledText(hostPage, "body", OPTION_B),
        waitForSettledText(guestPage, "body", OPTION_B),
      ]);
      // Sender echo: the guest's own speculative tally after its red vote —
      // the board's count ticking to "3 votes" on the CLICKING browser. (The
      // concurrent green pair above carries NO echo sample: two senders share
      // one expectation text, so a render there is not attributable to the
      // observing page's own click.)
      if (SENDER_ECHO) {
        await armSenderEcho(guestPage, "guest-veto-B", "body", "3 votes");
      }
      await clickCfButton(guestPage, voteButton(OPTION_B, "red"));
      // The third vote (red on option B) lands on both browsers — the count
      // reaches "3 votes" — while option A's tally is unchanged at "2 love it".
      // Option A stays the top choice (it has the greens), so its "2 love it"
      // is the surfaced summary either way.
      await timer.run(
        "option B vote lands (3 votes); option A unchanged",
        () =>
          Promise.all([
            waitForSettledText(hostPage, "body", "3 votes"),
            waitForSettledText(guestPage, "body", "3 votes"),
            waitForSettledText(hostPage, "body", "2 love it"),
          ]),
      );
    } finally {
      logStepTimings("lunch-poll vote", timer);
      if (SENDER_ECHO) {
        for (
          const [page, label] of [
            [hostPage, "lunch host"],
            [guestPage, "lunch guest"],
          ] as const
        ) {
          const report = await readSenderEchoReport(page).catch(() =>
            undefined
          );
          if (report) logSenderEchoSummary(label, SENDER_ECHO_ARM, report);
        }
      }
      for (
        const [page, label] of [[hostPage, HOST], [guestPage, GUEST]] as const
      ) {
        const summary = await collectBrowserLoadSummary(page, label).catch(() =>
          undefined
        );
        if (summary) logBrowserLoadSummary(summary);
      }
    }
  });
});
