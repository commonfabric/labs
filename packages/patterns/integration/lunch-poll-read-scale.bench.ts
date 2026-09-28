/**
 * A rendered lunch-poll vote update across declared vote-list sizes.
 * Setup and an instrumented diagnostic vote are outside the timed interval;
 * timed votes run with read accounting disabled. `EXPERIMENTAL_SERVER_EXECUTION`
 * selects the arm, which requires a local toolshed and shell running it too.
 */

import { debugStr } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  Browser,
  env,
  type Page,
  waitForCondition,
} from "@commonfabric/integration";
import { login } from "@commonfabric/integration/shell-utils";
import type { Cell } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { join } from "@std/path";
import { initializePiecesController } from "./pieces-controller.ts";
import {
  clickCfButton,
  settleView,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import { readDeclaredTopicsBrowserPosture } from "./topics-browser-posture.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

const SIZES = [74, 296, 1184];
const OPTIONS = 14;
const profileLocation = Deno.env.get("CF_READ_SCALE_PROFILE_LOCATION") ??
  "same-space";
if (profileLocation !== "same-space" && profileLocation !== "cross-space") {
  throw new Error(
    "`CF_READ_SCALE_PROFILE_LOCATION` must be `same-space` or `cross-space`",
  );
}
const identity = await Identity.fromPassphrase(
  "lunch poll read scale benchmark",
  { implementation: "noble" },
);
const encoder = new TextEncoder();
const note = (message: string) =>
  Deno.stderr.writeSync(encoder.encode(`${message}\n`));

/** Worker diagnostics collected over one untimed vote change. */
interface ReadSample {
  /** Completed reactive bodies carrying a read sample. */
  runs: number;

  /** Sum of reactive-body proxy accesses. */
  accesses: number;

  /** Largest reactive-body proxy-access count. */
  maxAccesses: number;

  /** Sum of reactive-body stored-link traversal attempts. */
  linkHops: number;

  /** Successful event-commit markers, including nested handlers. */
  eventCommits: number;

  /** Failed event-commit markers. */
  eventCommitErrors: number;
}

/** Browser runtime handle and the current untimed diagnostic sample. */
type DiagnosticGlobal = typeof globalThis & {
  /** Shell's exposed runtime client. */
  commonfabric?: { rt?: RuntimeClient };

  /** Sample mutated by worker telemetry notifications. */
  lunchReadSample?: ReadSample;
};

/**
 * Verifies that the server, served shell, and seeding process all run the arm
 * `EXPERIMENTAL_SERVER_EXECUTION` names, which must be set explicitly. The
 * served shell's arm is read from the bundle `FRONTEND_URL` serves, so a shell
 * served apart from the toolshed is checked rather than taken on the
 * toolshed's word.
 */
async function verifyPosture(): Promise<void> {
  const arm = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
  if (arm !== "true" && arm !== "false") {
    throw new Error(
      "Read-scale benchmark requires EXPERIMENTAL_SERVER_EXECUTION to be `true` or `false`",
    );
  }
  const serving = arm === "true";
  const [posture, statsResponse] = await Promise.all([
    readDeclaredTopicsBrowserPosture(
      env.API_URL,
      env.FRONTEND_URL,
      "The read-scale benchmark",
    ),
    fetch(new URL("api/health/stats", env.API_URL)),
  ]);
  if (!statsResponse.ok) {
    throw new Error("Posture probe failed");
  }
  const stats = await statsResponse.json();
  if (posture.served !== serving || (stats.servingLoop != null) !== serving) {
    throw new Error(`Toolshed does not run serverExecution=${arm}`);
  }
  // The posture reader refuses a shell whose arm differs from the toolshed's,
  // so the shell now runs the same arm.
  note(
    `[lunch-read-scale] verified toolshed, shell (from ${posture.clientFrom}), and seed client: serverExecution=${arm}`,
  );
}

const fixtures = new Map<
  number,
  Promise<{
    spaceName: string;
    pieceId: string;
    profileLocation: string;
    profileSpace: string;
  }>
>();
/** Seeds one dedicated space per size and releases the seeding runtime. */
function fixture(voteCount: number) {
  let created = fixtures.get(voteCount);
  if (!created) {
    created = (async () => {
      await verifyPosture();
      const spaceName =
        `${env.SPACE_NAME}-${profileLocation}-read-${voteCount}`;
      const cc = await initializePiecesController({
        space: spaceName,
        apiUrl: new URL(env.API_URL),
        identity,
      });
      try {
        await cc.ensureDefaultPattern();
        const voterCount = Math.ceil(voteCount / OPTIONS) + 2;
        let profileSpace = cc.getSpace();
        let input: { profiles: Cell<{ name: string }[]> } | undefined;
        if (profileLocation === "cross-space") {
          const profileController = await initializePiecesController({
            space: `${spaceName}-profiles`,
            apiUrl: new URL(env.API_URL),
            identity,
          });
          try {
            profileSpace = profileController.getSpace();
            const profiles = cc.runtime.getCell<{ name: string }[]>(
              profileSpace,
              "benchmark-voter-profiles",
            );
            const initialized = await cc.runtime.editWithRetry((tx) => {
              const writable = profiles.withTx(tx);
              writable.set([]);
              for (let index = 0; index < voterCount; index++) {
                const profile = writable.elementById(String(index));
                profile.set({ name: `Voter ${index}` });
                writable.addUnique(profile);
              }
            });
            if (initialized.error) throw new Error(initialized.error.message);
            await cc.synced();
            input = { profiles };
          } finally {
            await profileController.dispose();
          }
        }
        const root = join(import.meta.dirname!, "..");
        const program = await resolveLocalProgram(
          (resolver) => cc.runtime.harness.resolve(resolver),
          {
            main: join(
              root,
              "integration/fixtures/lunch-poll-read-scale/main.tsx",
            ),
            root,
            testPaths: ["main", "296-votes", "1184-votes"].map((name) =>
              join(
                root,
                `integration/fixtures/lunch-poll-read-scale/${name}.test.tsx`,
              )
            ),
          },
        );
        const piece = await cc.create<
          {
            votes: { voter: unknown }[];
            seed: {
              voteCount: number;
              voterCount: number;
              optionCount: number;
              requireExistingProfiles?: boolean;
            };
          }
        >(program, { start: true, input });
        const result = cc.getResult<
          {
            votes: { voter: unknown }[];
            seed: {
              voteCount: number;
              voterCount: number;
              optionCount: number;
              requireExistingProfiles?: boolean;
            };
          }
        >(piece.getCell());
        const stop = result.sink(() => {});
        try {
          const sent = await cc.runtime.editWithRetry((tx) =>
            result.key("seed").withTx(tx).send({
              voteCount,
              voterCount,
              optionCount: OPTIONS,
              requireExistingProfiles: profileLocation === "cross-space",
            })
          );
          if (sent.error) throw new Error(sent.error.message);
          await cc.runtime.settled(Infinity);
          await cc.synced();
          const voterSpace = result.key("votes").key(0).key("voter")
            .resolveAsCell().space;
          if (voterSpace !== profileSpace) {
            throw new Error("Seeded vote does not reference the profile space");
          }
          note(
            `[lunch-read-scale] verified ${profileLocation} voter links: ${profileSpace}`,
          );
          note(
            `[lunch-read-scale] seeded ${voteCount} votes, ${voterCount} voters, ${OPTIONS} options`,
          );
        } finally {
          stop();
        }
        return { spaceName, pieceId: piece.id, profileLocation, profileSpace };
      } finally {
        await cc.dispose();
      }
    })();
    fixtures.set(voteCount, created);
  }
  return created;
}

/** Changes Lunch 0's vote and waits for its selected button and summary swatch. */
async function vote(page: Page, color: "green" | "yellow"): Promise<void> {
  await clickCfButton(
    page,
    `[data-option-title="Lunch 0"] cf-button[data-vote="${color}"]`,
  );
  await settleView(page);
  await waitForCondition(
    page,
    (probe, expected: string) =>
      probe.collect(
        `[data-option-title="Lunch 0"] cf-button[data-vote="${expected}"]`,
      ).some((button) => getComputedStyle(button).fontWeight === "700") &&
      probe.collect('[data-vote-swatch-name="Voter 0"]').some((swatch) => {
        if (
          getComputedStyle(swatch).backgroundColor !==
            (expected === "green" ? "rgb(47, 138, 100)" : "rgb(212, 168, 47)")
        ) return false;
        for (let row = swatch.parentElement; row; row = row.parentElement) {
          if (row.firstElementChild?.textContent?.trim() === "Lunch 0") {
            return true;
          }
        }
        return false;
      }),
    { args: [color] },
  );
  await settleView(page);
}

for (const voteCount of SIZES) {
  Deno.bench({
    name: `${voteCount} votes`,
    group: "lunch poll rendered read scale",
    n: 3,
    warmup: 1,
  }, async (b) => {
    const target = await fixture(voteCount);
    const browser = await Browser.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.addEventListener("pageerror", (event) => {
        pageErrors.push(event.detail.message);
      });
      await page.goto(
        `${env.FRONTEND_URL}${target.spaceName}/${target.pieceId}`,
      );
      await waitForPieceView(page, target.spaceName, target.pieceId);
      await login(page, identity);
      await waitForSettledText(page, "body", "Lunch 13");
      await clickCfButton(page, "[data-benchmark-claim]");
      await settleView(page);
      note(`[lunch-read-scale] ${voteCount} votes: viewer ready`);
      await vote(page, "yellow");
      await vote(page, "green");
      note(`[lunch-read-scale] ${voteCount} votes: warmup complete`);
      await page.evaluate(async () => {
        const scope = globalThis as DiagnosticGlobal;
        const rt = scope.commonfabric?.rt;
        if (!rt) throw new Error("No browser runtime");
        scope.lunchReadSample = {
          runs: 0,
          accesses: 0,
          maxAccesses: 0,
          linkHops: 0,
          eventCommits: 0,
          eventCommitErrors: 0,
        };
        rt.on("telemetry", (marker) => {
          const sample = scope.lunchReadSample!;
          if (marker.type === "scheduler.event.commit") {
            if (marker.error) sample.eventCommitErrors++;
            else sample.eventCommits++;
          }
          if (marker.type !== "scheduler.run.complete" || !marker.reads) return;
          sample.runs++;
          sample.accesses += marker.reads.proxyAccesses;
          sample.linkHops += marker.reads.linkResolutions;
          sample.maxAccesses = Math.max(
            sample.maxAccesses,
            marker.reads.proxyAccesses,
          );
        });
        await rt.setTelemetryEnabled(true);
        await rt.setReadStatsEnabled(true);
      });
      await vote(page, "yellow");
      const sample = await page.evaluate(async () => {
        const scope = globalThis as DiagnosticGlobal;
        await scope.commonfabric!.rt!.setReadStatsEnabled(false);
        await scope.commonfabric!.rt!.setTelemetryEnabled(false);
        return scope.lunchReadSample!;
      });
      if (sample.runs === 0) {
        throw new Error("The demanded vote produced no measured worker runs");
      }
      if (sample.eventCommits === 0 || sample.eventCommitErrors !== 0) {
        throw new Error(
          `The diagnostic vote did not commit cleanly: ` +
            debugStr`$quote,long${sample}`,
        );
      }
      note(
        debugStr`[lunch-read-scale] ${voteCount} votes: $quote,long${sample}`,
      );
      b.start();
      await vote(page, "green");
      b.end();
      if (pageErrors.length > 0) {
        throw new Error(`Browser errors: ${pageErrors.join("; ")}`);
      }
      const artifactDir = Deno.env.get("CF_READ_SCALE_ARTIFACT_DIR");
      if (artifactDir) {
        await Deno.mkdir(artifactDir, { recursive: true });
        await page.screenshot(join(artifactDir, `${voteCount}-votes.png`));
        await Deno.writeTextFile(
          join(artifactDir, `${voteCount}-votes.json`),
          JSON.stringify({ voteCount, ...target, sample }, null, 2),
        );
      }
    } finally {
      await browser.close();
    }
  });
}
