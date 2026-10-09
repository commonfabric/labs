/**
 * The write-storm alarm against the commit stream of the Topics social space
 * (`topics-dev-476ea34f`), taken from the 2026-08-18 export of that space's
 * database. `fixtures/topics-commit-stretches.json.gz` holds six ten-minute
 * stretches of it, each a list of `[session, secondsSinceStart]` commits:
 *
 * - two `storm` stretches, the densest ten minutes of the 2026-07-22 and
 *   2026-07-24 storms, at four to seven hundred commits a minute;
 * - one `loop-under-threshold` stretch, ten minutes of the 2026-07-22 storm
 *   running at about a hundred commits a minute. It is the same loop, two
 *   sessions alternating a result slot, at the cadence a saturated server
 *   gave it, and it sits under the default threshold for the whole ten
 *   minutes. The space-wide alarm is not what catches that; the scheduler's
 *   remote-echo breaker, which counts one session's rewrites of one document,
 *   is (`docs/plans/scheduler-remote-echo-breaker.md`);
 * - three `quiet` stretches, the busiest ten minutes of the three weeks after
 *   the storms: cold board loads re-persisting one derivation per session,
 *   which put up to 346 commits into one minute and nothing into the next.
 *
 * The replay feeds every commit to one tracker at the export's one-second
 * timestamps, as accepted and carrying one operation, since the export does
 * not say how many an original carried. The alarm judges the commit count
 * alone, so neither approximation touches what is asserted.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CommitRateTracker } from "../v2/commit-rates.ts";

type StretchKind = "storm" | "loop-under-threshold" | "quiet";

interface Stretch {
  readonly label: string;
  readonly kind: StretchKind;
  readonly note: string;
  readonly sessions: number;
  readonly events: readonly (readonly [number, number])[];
}

const space = "did:key:z6Mk-commit-rates-topics";

/** The stretches start on a whole second, as the export's timestamps do. */
const START_MS = 1_000_000_000;

const stretches: readonly Stretch[] = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(
      await new Response(
        new Blob([
          Deno.readFileSync(
            new URL(
              "./fixtures/topics-commit-stretches.json.gz",
              import.meta.url,
            ),
          ) as BlobPart,
        ]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer(),
    ),
  ),
).stretches;

/** Lists the stretches of `kind`, of which there is at least one. */
const ofKind = (kind: StretchKind): Stretch[] => {
  const found = stretches.filter((stretch) => stretch.kind === kind);
  expect(found.length).toBeGreaterThan(0);
  return found;
};

/**
 * Replays one stretch through a tracker at the default thresholds and
 * returns the second at which the space first stood in a storm, or
 * `undefined` if it never did, and whether it was in one at the last commit.
 */
const replay = (
  stretch: Stretch,
): { stormAt: number | undefined; stormAtEnd: boolean } => {
  let now = START_MS;
  const tracker = new CommitRateTracker({ now: () => now });
  let stormAt: number | undefined;
  let stormAtEnd = false;
  for (const [session, seconds] of stretch.events) {
    now = START_MS + seconds * 1000;
    const { storm } = tracker.record({
      space,
      session: `session:${session}`,
      accepted: true,
      operations: 1,
    });
    stormAt ??= storm ? seconds : undefined;
    stormAtEnd = storm;
  }
  return { stormAt, stormAtEnd };
};

describe("commit-rates-traces", () => {
  describe("the storm stretches", () => {
    it("reports a storm once the sustained window has passed, and still at the end", () => {
      // The threshold is met inside the first minute of each stretch, so the
      // storm is reported within the sustained window plus that minute.
      for (const stretch of ofKind("storm")) {
        const { stormAt, stormAtEnd } = replay(stretch);
        expect(stormAt).toBeDefined();
        expect(stormAt!).toBeLessThanOrEqual(360);
        expect(stormAtEnd).toBe(true);
      }
    });
  });

  describe("the loop under the threshold", () => {
    it("reports no storm for a loop the space-wide rate does not reach", () => {
      // A hundred commits a minute from two sessions alternating one slot is
      // a loop the breaker on each session's scheduler is for; the alarm is
      // for the rate at which a space saturates its server.
      for (const stretch of ofKind("loop-under-threshold")) {
        expect(replay(stretch)).toEqual({
          stormAt: undefined,
          stormAtEnd: false,
        });
      }
    });
  });

  describe("the quiet stretches", () => {
    it("reports no storm for a cold board load", () => {
      // A load's burst crosses the threshold for a minute and is gone before
      // the sustained window is up.
      for (const stretch of ofKind("quiet")) {
        expect(replay(stretch)).toEqual({
          stormAt: undefined,
          stormAtEnd: false,
        });
      }
    });
  });
});
