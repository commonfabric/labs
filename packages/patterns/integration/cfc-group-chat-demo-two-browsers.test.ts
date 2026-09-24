/**
 * Multi-browser-profile test for the CFC group chat demo.
 *
 * Unlike cfc-group-chat-demo.test.ts (which switches identity on ONE page),
 * this drives N SIMULTANEOUS browser instances — separate profiles, separate
 * identities, same piece — and checks the multi-user contract that a single
 * page cannot: per-user state isolation while every user is live, live
 * propagation of shared state, and admin lockdown not interfering with the
 * other users' ability to post.
 *
 * The profile count defaults to 2 (the historical "two browsers" case) and is
 * configurable via `CFC_BROWSER_PROFILE_COUNT` — raise it to amplify the
 * cross-browser sync contention behind the dual-browser slowness. Every
 * reactive step is timed, and after the run each browser's aggregate IPC /
 * worker timing is dumped, so a slow or flaky run reports WHERE the wall-clock
 * went (chiefly main-thread `runtime-client` IPC round-trips waiting on a
 * saturated worker). Raising the count to 3+ reliably reproduced the
 * handler-lifetime race fixed in #4146 (Bob's save lost, status stuck at
 * "Name not set"); the save steps drive the trusted action by its marker and
 * retry, so a single dropped dispatch can no longer wedge the run.
 *
 * The deeper state-machine coverage lives in the headless
 * cfc-group-chat-demo-multi-runtime.test.ts; this test guards the real
 * browser stack (DOM input binding, event provenance, login flow).
 */

import { env } from "@commonfabric/integration";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { UI } from "@commonfabric/runner";
import { debugVDOMSchema } from "@commonfabric/runner/schemas";
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
  clickTrustedAction,
  clickTrustedActionAndWaitForText,
  collectBrowserLoadSummary,
  fillCfInput,
  installSenderEchoProbe,
  logBrowserLoadSummary,
  logSenderEchoSummary,
  logStepTimings,
  readSenderEchoReport,
  StepTimer,
  submitViaEnter,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME, CFC_BROWSER_PROFILE_COUNT } = env;
// The opt-in propagation-benchmark leg (see the series step below).
const CHAT_SERIES = Math.max(
  0,
  Number.parseInt(Deno.env.get("CF_CHAT_MESSAGE_SERIES") ?? "0", 10) || 0,
);
const CHAT_SERIES_DELAY_MS = Math.max(
  0,
  Number.parseInt(Deno.env.get("CF_CHAT_MESSAGE_DELAY_MS") ?? "2000", 10) ||
    0,
);
const CHAT_SERIES_ARM = (() => {
  const raw = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
  const on = raw === undefined
    ? SERVER_EXECUTION_DEFAULT_ENABLED
    : raw === "true";
  return on ? "ON" : "OFF";
})();
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const SEND_ACTION = "TrustedGroupChatSendMessage";
const ADD_ROOM_ACTION = "TrustedGroupChatAddRoom";
const PROFILE_COUNT = Math.max(2, CFC_BROWSER_PROFILE_COUNT);

// Deterministic, distinct names so isolation/liveness assertions read clearly.
const NAME_POOL = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Erin",
  "Frank",
  "Grace",
  "Heidi",
  "Ivan",
  "Judy",
];
const profileName = (index: number): string =>
  NAME_POOL[index] ?? `User${index + 1}`;

describe(
  `cfc group chat demo with ${PROFILE_COUNT} concurrent browser profiles`,
  () => {
    const shells = Array.from(
      { length: PROFILE_COUNT },
      () => new ShellIntegration(),
    );
    shells.forEach((shell) => shell.bindLifecycle());

    const userNames = Array.from(
      { length: PROFILE_COUNT },
      (_, index) => profileName(index),
    );

    let identities: Identity[];
    let cc: PiecesController;
    let pieceId: string;
    let pieceSinkCancel: (() => void) | undefined;
    let uiSinkCancel: (() => void) | undefined;

    beforeAll(async () => {
      identities = await Promise.all(
        Array.from(
          { length: PROFILE_COUNT },
          () => Identity.generate({ implementation: "noble" }),
        ),
      );
      cc = await initializePiecesController({
        space: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identities[0],
      });

      // Pre-create the space-root (default) pattern so each browser's
      // `pattern:getSpaceRoot` storage-RESUMEs it instead of racing the create
      // path and cold-compiling default-app inside its worker — see the
      // beforeAll comment in lunch-poll-vote.test.ts.
      await cc.ensureDefaultPattern();

      const sourcePath = join(
        import.meta.dirname!,
        "..",
        "cfc-group-chat-demo",
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
      pieceSinkCancel = resultCell.sink(() => {});
      // Pull on [UI] with the cell-less vdom schema (children expanded inline,
      // no asCell) so the controller materializes the WHOLE tree: every UI
      // computed runs and stays subscribed. That extra generation churn on the
      // shared space is what makes the concurrent-browser reproduction
      // realistic — more writes to race, more chances to conflict.
      uiSinkCancel = resultCell.key(UI).asSchema(debugVDOMSchema).sink(
        () => {},
      );
    });

    afterAll(async () => {
      uiSinkCancel?.();
      pieceSinkCancel?.();
      await cc?.dispose();
    });

    it("keeps per-user state isolated and shared state live across browsers", async () => {
      const timer = new StepTimer();
      const view = { spaceName: SPACE_NAME, pieceId };
      const pages = shells.map((shell) => shell.page());
      const others = (index: number) =>
        pages.filter((_, other) => other !== index);

      try {
        await timer.run(
          "navigate + login all profiles",
          () =>
            Promise.all(shells.map((shell, index) =>
              shell.goto({
                frontendUrl: FRONTEND_URL,
                view,
                identity: identities[index],
              })
            )),
        );
        await timer.run(
          "runtime idle (all)",
          () =>
            Promise.all(
              pages.map((page) => waitForRuntimeIdle(page)),
            ),
        );
        await timer.run(
          "initial 'No profile' (all)",
          () =>
            Promise.all(
              pages.map((page) =>
                waitForText(page, "#group-chat-manager-chip", "No profile")
              ),
            ),
        );

        // First user saves. The trusted action is driven by its marker and
        // retried until the status flips, so a dropped dispatch can't wedge
        // the run. Every other user's profile must stay unset (not clobbered).
        await fillCfInput(pages[0], "#trusted-profile-name", userNames[0]);
        await timer.run(
          `${userNames[0]} save + own status`,
          () =>
            clickTrustedActionAndWaitForText(
              pages[0],
              SAVE_PROFILE_ACTION,
              "#trusted-profile-status",
              userNames[0],
            ),
        );
        await Promise.all(
          pages.map((page) => waitForRuntimeIdle(page)),
        );
        for (let index = 1; index < pages.length; index++) {
          await waitForText(
            pages[index],
            "#trusted-profile-status",
            "Name not set",
          );
          await waitForText(
            pages[index],
            "#group-chat-manager-chip",
            "No profile",
          );
        }

        // Each remaining user, after the prior saver's name has reached them,
        // saves their own profile.
        for (let index = 1; index < pages.length; index++) {
          await timer.run(
            `${userNames[index]} sees ${userNames[index - 1]} before save`,
            () =>
              waitForText(
                pages[index],
                "#trusted-admin-user-list",
                userNames[index - 1],
              ),
          );
          await waitForRuntimeIdle(pages[index]);
          await fillCfInput(
            pages[index],
            "#trusted-profile-name",
            userNames[index],
          );
          await timer.run(
            `${userNames[index]} save + own status`,
            () =>
              clickTrustedActionAndWaitForText(
                pages[index],
                SAVE_PROFILE_ACTION,
                "#trusted-profile-status",
                userNames[index],
              ),
          );
        }

        // Every user's view must show every OTHER user by their actual name
        // (not an unnamed placeholder), and each user's own profile must
        // survive. This is the cross-browser propagation that the dual-browser
        // slowness most visibly degrades.
        await timer.run(
          "cross-browser name propagation (all pairs)",
          () =>
            Promise.all(pages.map(async (page, index) => {
              for (let other = 0; other < pages.length; other++) {
                if (other === index) continue;
                await waitForText(
                  page,
                  "#trusted-admin-user-list",
                  userNames[other],
                );
              }
              await waitForText(
                page,
                "#trusted-profile-status",
                userNames[index],
              );
            })),
        );

        // Shared transcript propagates live to every other browser, with
        // snapshot author names intact.
        const helloMessage = `Hello from ${userNames[0]}`;
        await fillCfInput(pages[0], "#trusted-message-draft", helloMessage);
        await submitViaEnter(pages[0], "#trusted-message-draft");
        await timer.run(
          "message propagation (first -> all)",
          () =>
            Promise.all(
              others(0).map((page) =>
                waitForText(
                  page,
                  "#trusted-conversation-preview",
                  helloMessage,
                )
              ),
            ),
        );

        // First user locks down admin. Every other user loses admin (cannot
        // add rooms) but must still be able to POST — sending is never
        // admin-gated.
        await clickCfButton(pages[0], "#trusted-everyone-admin-checkbox");
        await waitForText(
          pages[0],
          "#group-chat-manager-chip",
          "Can manage admins",
        );
        await timer.run(
          "lockdown propagation (first -> others)",
          () =>
            Promise.all(
              others(0).map((page) =>
                waitForText(
                  page,
                  "#trusted-room-admin-hint",
                  "Ask an admin manager to make you an admin",
                )
              ),
            ),
        );

        // A now-non-admin user can still post, and the admin sees it.
        const lastIndex = pages.length - 1;
        const lockdownMessage = `${userNames[lastIndex]} posts after lockdown`;
        await fillCfInput(
          pages[lastIndex],
          "#trusted-message-draft",
          lockdownMessage,
        );
        await clickTrustedAction(pages[lastIndex], SEND_ACTION);
        await timer.run(
          "post-lockdown message (non-admin -> admin)",
          () =>
            waitForText(
              pages[0],
              "#trusted-conversation-preview",
              lockdownMessage,
            ),
        );

        // The Phase-7 cross-user PROPAGATION BENCHMARK leg (opt-in;
        // docs/plans/server-execution-v2.md Phase 7's criterion — the
        // README §1 "faster, not tolerably slower" bar): with
        // CF_CHAT_MESSAGE_SERIES=N set, the first browser posts N further
        // messages, DELAY apart, and each post is timed from the send
        // (Enter) until the SECOND browser renders it — the byte-identical
        // workload run in adjacent ON/OFF pairs by the measurement
        // protocol (fresh store, load recorded, medians + quartiles). Off
        // by default: the ordinary gate run is unchanged.
        if (CHAT_SERIES > 0) {
          // The sender-echo probe (W4): beside each post's arrival at the
          // OTHER browser, time the sender's OWN speculative render of it
          // (Enter → the text in the sender's transcript), page-clock only.
          await installSenderEchoProbe(pages[0]);
          const perPost: number[] = [];
          for (let i = 0; i < CHAT_SERIES; i++) {
            const text = `series ${i} ${userNames[0]}`;
            await fillCfInput(pages[0], "#trusted-message-draft", text);
            await armSenderEcho(
              pages[0],
              `series ${i}`,
              "#trusted-conversation-preview",
              text,
            );
            const t0 = performance.now();
            await submitViaEnter(pages[0], "#trusted-message-draft");
            await waitForText(pages[1], "#trusted-conversation-preview", text);
            perPost.push(performance.now() - t0);
            if (CHAT_SERIES_DELAY_MS > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, CHAT_SERIES_DELAY_MS)
              );
            }
          }
          const sorted = [...perPost].sort((a, b) => a - b);
          const q = (f: number) =>
            sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
          const load = (() => {
            try {
              return Deno.loadavg().map((v) => v.toFixed(2)).join("/");
            } catch {
              return "n/a";
            }
          })();
          console.log(
            `[chat-series] arm=${CHAT_SERIES_ARM} n=${perPost.length} ` +
              `median=${q(0.5).toFixed(0)}ms q1=${q(0.25).toFixed(0)}ms ` +
              `q3=${q(0.75).toFixed(0)}ms min=${sorted[0].toFixed(0)}ms ` +
              `max=${sorted[sorted.length - 1].toFixed(0)}ms ` +
              `delay=${CHAT_SERIES_DELAY_MS}ms load1/5/15=${load}`,
          );
          console.log(
            `[chat-series] per-post ms: ${
              perPost.map((v) => v.toFixed(0)).join(" ")
            }`,
          );
          logSenderEchoSummary(
            "chat-series sender",
            CHAT_SERIES_ARM,
            await readSenderEchoReport(pages[0]),
          );
        }

        // Admin can still add rooms, and every other user sees the shared room.
        await fillCfInput(pages[0], "#trusted-room-name", "Ops");
        await waitForDisabled(pages[0], "#trusted-room-add-button", false);
        await clickTrustedAction(pages[0], ADD_ROOM_ACTION);
        await waitForText(pages[0], "#rooms-panel", "Ops");
        await timer.run(
          "room propagation (first -> all)",
          () =>
            Promise.all(
              others(0).map((page) => waitForText(page, "#rooms-panel", "Ops")),
            ),
        );
      } finally {
        // Always report where the wall-clock went — on success to track the
        // contention trend, on failure to localize the slow propagation.
        logStepTimings(`group-chat ${PROFILE_COUNT}-profile`, timer);
        const summaries = await Promise.all(
          pages.map((page, index) =>
            collectBrowserLoadSummary(page, userNames[index]).catch(() =>
              undefined
            )
          ),
        );
        for (const summary of summaries) {
          if (summary) logBrowserLoadSummary(summary);
        }
      }
    });
  },
);
