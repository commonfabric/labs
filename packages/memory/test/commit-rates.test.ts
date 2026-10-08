import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type CommitRatesReport,
  CommitRateTracker,
  type CommitStormThresholds,
  commitStormThresholds,
} from "../v2/commit-rates.ts";

/** A clock the test moves by hand, starting on a whole second. */
const clock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance(ms: number): void {
      now += ms;
    },
  };
};

const space = "did:key:z6Mk-commit-rates-space";
const otherSpace = "did:key:z6Mk-commit-rates-other-space";
const principal = "did:key:z6Mk-commit-rates-principal";

/** Thresholds a test can cross in a few commits and a few seconds. */
const storm: CommitStormThresholds = {
  commitsPerMinute: 3,
  sustainedSeconds: 10,
};

const commit = (
  tracker: CommitRateTracker,
  overrides: {
    space?: string;
    session?: string;
    principal?: string;
    accepted?: boolean;
    operations?: number;
  } = {},
) =>
  tracker.record({
    space: overrides.space ?? space,
    session: overrides.session ?? "session:a",
    ...(overrides.principal === undefined
      ? {}
      : { principal: overrides.principal }),
    accepted: overrides.accepted ?? true,
    operations: overrides.operations ?? 1,
  });

const counts = (
  accepted: number,
  rejected: number,
  operations: number,
) => ({ accepted, rejected, operations });

const spaceOf = (report: CommitRatesReport, id: string) => {
  const found = report.spaces.find((entry) => entry.space === id);
  expect(found).toBeDefined();
  return found!;
};

describe("commit-rates", () => {
  describe("commitStormThresholds()", () => {
    const defaults = { commitsPerMinute: 120, sustainedSeconds: 300 };

    it("returns the defaults when neither variable is set", () => {
      expect(commitStormThresholds(() => undefined)).toEqual(defaults);
    });

    it("returns the defaults when the reader throws", () => {
      expect(commitStormThresholds(() => {
        throw new Error("env is not readable");
      })).toEqual(defaults);
    });

    it("returns each variable's value when it is a positive number", () => {
      const env: Record<string, string> = {
        CF_COMMIT_STORM_PER_MINUTE: "30",
        CF_COMMIT_STORM_SUSTAINED_SECONDS: "0.5",
      };
      expect(commitStormThresholds((name) => env[name])).toEqual({
        commitsPerMinute: 30,
        sustainedSeconds: 0.5,
      });
    });

    it("returns the default for a variable that is empty, not a number, zero, or negative", () => {
      for (const raw of ["", "soon", "0", "-5", "Infinity"]) {
        const env: Record<string, string> = {
          CF_COMMIT_STORM_PER_MINUTE: raw,
          CF_COMMIT_STORM_SUSTAINED_SECONDS: "7",
        };
        expect(commitStormThresholds((name) => env[name])).toEqual({
          commitsPerMinute: 120,
          sustainedSeconds: 7,
        });
      }
    });
  });

  describe("CommitRateTracker", () => {
    describe("instance members", () => {
      describe("record()", () => {
        it("returns `storm: false` for a commit under the threshold", () => {
          const tracker = new CommitRateTracker({ now: clock().now, storm });
          expect(commit(tracker)).toEqual({ storm: false });
        });

        it("returns `storm: true` once the minute's commits have stayed at the threshold for the sustained window", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker);
          commit(tracker);
          // The third commit reaches the threshold and starts the run.
          expect(commit(tracker)).toEqual({ storm: false });
          time.advance(9_999);
          expect(commit(tracker)).toEqual({ storm: false });
          time.advance(1);
          expect(commit(tracker)).toEqual({ storm: true });
        });

        it("counts a rejected commit toward the threshold", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker, { accepted: false });
          commit(tracker, { accepted: false });
          commit(tracker, { accepted: false });
          time.advance(10_000);
          expect(commit(tracker, { accepted: false })).toEqual({
            storm: true,
          });
        });

        it("returns `storm: false` again once the minute's commits fall under the threshold, and a new run needs the whole sustained window", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker);
          commit(tracker);
          commit(tracker);
          time.advance(10_000);
          expect(commit(tracker)).toEqual({ storm: true });
          // Sixty seconds on, every earlier commit has left the minute.
          time.advance(60_000);
          expect(commit(tracker)).toEqual({ storm: false });
          commit(tracker);
          // Back at the threshold, but the run has only just begun.
          expect(commit(tracker)).toEqual({ storm: false });
          time.advance(10_000);
          expect(commit(tracker)).toEqual({ storm: true });
        });

        it("judges each space's storm on its own commits", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker);
          commit(tracker);
          commit(tracker);
          time.advance(10_000);
          expect(commit(tracker, { space: otherSpace })).toEqual({
            storm: false,
          });
          expect(commit(tracker)).toEqual({ storm: true });
        });
      });

      describe("report()", () => {
        it("returns the thresholds and no spaces before any commit", () => {
          const tracker = new CommitRateTracker({ now: clock().now, storm });
          expect(tracker.report()).toEqual({
            storm,
            activeSpaces: 0,
            storms: 0,
            spaces: [],
          });
        });

        it("returns the default thresholds when none are given", () => {
          expect(new CommitRateTracker().report().storm).toEqual({
            commitsPerMinute: 120,
            sustainedSeconds: 300,
          });
        });

        it("returns a space's accepted, rejected, and operation counts in both windows", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker, { operations: 2 });
          commit(tracker, { accepted: false, operations: 3 });
          expect(spaceOf(tracker.report(), space)).toEqual({
            space,
            minute: counts(1, 1, 5),
            tenMinutes: counts(1, 1, 5),
            activeWriters: 1,
            writers: [{
              session: "session:a",
              minute: counts(1, 1, 5),
              tenMinutes: counts(1, 1, 5),
            }],
          });
        });

        it("counts a commit in the minute for sixty seconds from the start of its second, and in the ten minutes for six hundred", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker);
          time.advance(59_999);
          expect(spaceOf(tracker.report(), space).minute).toEqual(
            counts(1, 0, 1),
          );
          time.advance(1);
          expect(spaceOf(tracker.report(), space).minute).toEqual(
            counts(0, 0, 0),
          );
          expect(spaceOf(tracker.report(), space).tenMinutes).toEqual(
            counts(1, 0, 1),
          );
          time.advance(539_999);
          expect(spaceOf(tracker.report(), space).tenMinutes).toEqual(
            counts(1, 0, 1),
          );
          time.advance(1);
          expect(tracker.report()).toEqual({
            storm,
            activeSpaces: 0,
            storms: 0,
            spaces: [],
          });
        });

        it("drops a writer that went quiet while another kept its space active", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker, { session: "session:a" });
          commit(tracker, { session: "session:b" });
          time.advance(599_000);
          commit(tracker, { session: "session:b" });
          time.advance(1_000);
          const rates = spaceOf(tracker.report(), space);
          expect(rates.activeWriters).toBe(1);
          expect(rates.writers.map((writer) => writer.session)).toEqual([
            "session:b",
          ]);
          expect(rates.tenMinutes).toEqual(counts(1, 0, 1));
        });

        it("counts a commit recorded after the clock stepped backwards", () => {
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          time.advance(5_000);
          commit(tracker);
          time.advance(-4_000);
          commit(tracker);
          const rates = spaceOf(tracker.report(), space);
          expect(rates.minute).toEqual(counts(2, 0, 2));
          expect(rates.tenMinutes).toEqual(counts(2, 0, 2));
        });

        it("keys a writer by its session and its principal, and omits an absent principal", () => {
          const tracker = new CommitRateTracker({ now: clock().now, storm });
          commit(tracker, { session: "session:a" });
          commit(tracker, { session: "session:a", principal });
          commit(tracker, { session: "session:a", principal });
          const { writers } = spaceOf(tracker.report(), space);
          expect(writers).toStrictEqual([
            {
              session: "session:a",
              principal,
              minute: counts(2, 0, 2),
              tenMinutes: counts(2, 0, 2),
            },
            {
              session: "session:a",
              minute: counts(1, 0, 1),
              tenMinutes: counts(1, 0, 1),
            },
          ]);
        });

        it("lists the top writers over each window as one list, by the minute's commits and then the ten minutes'", () => {
          const time = clock();
          const tracker = new CommitRateTracker({
            now: time.now,
            storm,
            topWriters: 1,
          });
          for (let i = 0; i < 5; i++) commit(tracker, { session: "session:a" });
          time.advance(120_000);
          commit(tracker, { session: "session:b" });
          commit(tracker, { session: "session:b" });
          commit(tracker, { session: "session:c" });
          const rates = spaceOf(tracker.report(), space);
          expect(rates.activeWriters).toBe(3);
          expect(rates.writers.map((writer) => writer.session)).toEqual([
            "session:b",
            "session:a",
          ]);
        });

        it("lists the top spaces over each window the same way", () => {
          const time = clock();
          const tracker = new CommitRateTracker({
            now: time.now,
            storm,
            topSpaces: 1,
          });
          for (let i = 0; i < 5; i++) commit(tracker, { space: "did:a" });
          time.advance(120_000);
          commit(tracker, { space: "did:b" });
          commit(tracker, { space: "did:b" });
          commit(tracker, { space: "did:c" });
          const report = tracker.report();
          expect(report.activeSpaces).toBe(3);
          expect(report.spaces.map((entry) => entry.space)).toEqual([
            "did:b",
            "did:a",
          ]);
        });

        it("evicts the writer that committed least recently once a space holds the cap", () => {
          const time = clock();
          const tracker = new CommitRateTracker({
            now: time.now,
            storm,
            maxWritersPerSpace: 2,
          });
          commit(tracker, { session: "session:a" });
          time.advance(1_000);
          commit(tracker, { session: "session:b" });
          time.advance(1_000);
          commit(tracker, { session: "session:c" });
          const rates = spaceOf(tracker.report(), space);
          // The space's own count keeps every commit; only the writer is gone.
          expect(rates.minute).toEqual(counts(3, 0, 3));
          expect(rates.writers.map((writer) => writer.session).sort())
            .toEqual(["session:b", "session:c"]);
        });

        it("keeps the writer that committed last among writers active in one second", () => {
          const time = clock();
          const tracker = new CommitRateTracker({
            now: time.now,
            storm,
            maxWritersPerSpace: 2,
          });
          commit(tracker, { session: "session:hot" });
          time.advance(100);
          commit(tracker, { session: "session:cold" });
          time.advance(100);
          for (let i = 0; i < 100; i++) {
            commit(tracker, { session: "session:hot" });
          }
          time.advance(100);
          commit(tracker, { session: "session:new" });
          const rates = spaceOf(tracker.report(), space);
          expect(rates.writers.map((writer) => writer.session).sort())
            .toEqual(["session:hot", "session:new"]);
        });

        it("evicts the space that committed least recently once the tracker holds the cap", () => {
          const time = clock();
          const tracker = new CommitRateTracker({
            now: time.now,
            storm,
            maxSpaces: 2,
          });
          commit(tracker, { space: "did:a" });
          time.advance(1_000);
          commit(tracker, { space: "did:b" });
          time.advance(1_000);
          commit(tracker, { space: "did:c" });
          expect(tracker.report().spaces.map((entry) => entry.space).sort())
            .toEqual(["did:b", "did:c"]);
        });

        it("ends a run that a dip between commits broke, whether or not a report observed the dip", () => {
          // Three commits start the run; two more at thirty seconds keep
          // the minute at five; at sixty the first three expire and the
          // minute dips to two; three at sixty-one restore it, then one a
          // second holds it. The run restarted at sixty-one, so the storm
          // matures at seventy-one and not before, with or without a report
          // reading the tracker during the dip.
          const outcomes = (reportDuringDip: boolean) => {
            const time = clock();
            const tracker = new CommitRateTracker({ now: time.now, storm });
            for (let i = 0; i < 3; i++) commit(tracker);
            time.advance(30_000);
            commit(tracker);
            commit(tracker);
            time.advance(30_000);
            if (reportDuringDip) {
              expect(spaceOf(tracker.report(), space).minute).toEqual(
                counts(2, 0, 2),
              );
            }
            time.advance(1_000);
            commit(tracker);
            commit(tracker);
            commit(tracker);
            const seen: boolean[] = [];
            for (let second = 62; second <= 71; second++) {
              time.advance(1_000);
              seen.push(commit(tracker).storm);
            }
            return seen;
          };
          const expected = [...Array(9).fill(false), true];
          expect(outcomes(false)).toEqual(expected);
          expect(outcomes(true)).toEqual(expected);
        });

        it("keeps a run going when a commit lands on the second its predecessor leaves the minute", () => {
          // One commit every twenty seconds holds the minute at exactly the
          // threshold of three once three are in: at sixty the first leaves
          // on the instant the fourth lands, so the count never stood under
          // the threshold and the run that began at forty carries on.
          const time = clock();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker);
          time.advance(20_000);
          commit(tracker);
          time.advance(20_000);
          expect(commit(tracker)).toEqual({ storm: false });
          time.advance(20_000);
          expect(commit(tracker)).toEqual({ storm: true });
          expect(spaceOf(tracker.report(), space).storm).toEqual({
            since: time.now() - 20_000,
          });
        });

        it("counts a storm in `storms` even when its space is not among the listed ones", () => {
          const time = clock();
          const tracker = new CommitRateTracker({
            now: time.now,
            storm,
            topSpaces: 1,
          });
          for (let i = 0; i < 3; i++) commit(tracker, { space: "did:a" });
          for (let second = 1; second <= 10; second++) {
            time.advance(1_000);
            commit(tracker, { space: "did:a" });
          }
          expect(spaceOf(tracker.report(), "did:a").storm).toBeDefined();
          for (let i = 0; i < 100; i++) commit(tracker, { space: "did:b" });
          const report = tracker.report();
          expect(report.spaces.map((entry) => entry.space)).toEqual(["did:b"]);
          expect(report.storms).toBe(1);
          expect(report.activeSpaces).toBe(2);
        });

        it("reports a storm with when its run began, and clears it on a later report once the minute has fallen under the threshold", () => {
          const time = clock();
          const since = time.now();
          const tracker = new CommitRateTracker({ now: time.now, storm });
          commit(tracker);
          commit(tracker);
          commit(tracker);
          expect(spaceOf(tracker.report(), space).storm).toBeUndefined();
          time.advance(10_000);
          commit(tracker);
          expect(spaceOf(tracker.report(), space).storm).toEqual({ since });
          time.advance(60_000);
          expect(spaceOf(tracker.report(), space).storm).toBeUndefined();
        });
      });
    });
  });
});
