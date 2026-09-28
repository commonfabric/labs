import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  churn,
  COST_BUCKETS_PER_DOUBLING,
  COST_RULE,
  costSeconds,
  daysBetween,
  emptyContext,
  emptyState,
  flakeCounts,
  flakeRate,
  foldObservations,
  type IdentityState,
  mergeSamples,
  type Observation,
  parseContext,
  percentile90,
  readCostsForward,
  sampledPercentile90,
  sampleDuration,
  samplesOf,
  scoreInputs,
  sealDay,
  serializeContext,
  trimContext,
  trimWindows,
  value,
} from "./score.ts";
import {
  CATCH_BREADTH_WINDOW_DAYS,
  COST_WINDOW_DAYS,
  FLAKE_COMMIT_REACH,
  FLAKE_EXCLUSION_RATE,
  SAME_COMMIT_REACH_DAYS,
  VALUE_FLOOR,
} from "./policy.ts";
import { testIdentityKey } from "@commonfabric/test-support/records";

const TEST = { k: "unit", s: "memory", n: "space > writes a fact" };
const KEY = testIdentityKey(TEST);

/** One observation, with the parts a case does not care about filled in. */
function saw(
  outcome: "pass" | "fail" | "skip",
  fields: Partial<Observation> = {},
): Observation {
  return {
    test: TEST,
    outcome,
    day: "2026-08-20",
    startedAt: "2026-08-20T00:00:00.000Z",
    commit: "c1",
    source: "main",
    place: "main",
    ...fields,
  };
}

function stateFrom(observations: readonly Observation[]) {
  const state = foldObservations(observations).get(KEY);
  expect(state).toBeDefined();
  return state!;
}

describe("score", () => {
  describe("a stored fold context", () => {
    it("round-trips what a run learned", () => {
      const context = emptyContext();
      context.mainAtCommit.set("k c1", { day: "2026-08-20", outcome: "fail" });
      context.credited.set("k c1 branch", "2026-08-20");
      const back = parseContext(serializeContext(context));
      expect(back.mainAtCommit.get("k c1")?.outcome).toBe("fail");
      expect(back.credited.get("k c1 branch")).toBe("2026-08-20");
    });

    it("drops what it cannot read rather than believing it", () => {
      // An unknown outcome would read as one more thing the identity did
      // at that commit, and two of them is the test disagreeing with
      // itself, which suppresses a real catch. A credited entry with no
      // readable day can never be aged out, so it suppresses one forever.
      const back = parseContext({
        outcomesAtCommit: [
          ["c1", { day: "2026-08-20", identities: [["k", ["wat"]]] }],
        ],
        mainAtCommit: [["k c1", { day: "nope", outcome: "fail" }]],
        credited: [["k c1 branch", "not a day"]],
        failures: [["k", [{ day: "2026-08-20", source: "branch" }]]],
      });
      expect(back.outcomesAtCommit.size).toBe(0);
      expect(back.mainAtCommit.size).toBe(0);
      expect(back.credited.size).toBe(0);
      expect(back.failures.size).toBe(1);
    });

    it("rejects a day the calendar does not have", () => {
      // "2026-02-31" parses, rolling forward into March. Believed, it
      // would be aged from three days later than it claims, so a stored
      // entry outlives the window it was meant to be dropped from.
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [
          ["k a", { day: "2026-02-31", outcome: "fail" }],
          ["k b", { day: "2026-02-30", outcome: "fail" }],
          ["k c", { day: "2025-02-29", outcome: "fail" }],
          ["k d", { day: "2026-02-28", outcome: "fail" }],
        ],
        credited: [],
        failures: [],
      });
      expect([...back.mainAtCommit.keys()]).toEqual(["k d"]);
    });

    it("keeps the last day of a month, and a real leap day", () => {
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [
          ["k a", { day: "2026-01-31", outcome: "fail" }],
          ["k b", { day: "2024-02-29", outcome: "fail" }],
          ["k c", { day: "2026-12-31", outcome: "fail" }],
        ],
        credited: [],
        failures: [],
      });
      expect(back.mainAtCommit.size).toBe(3);
    });

    it(
      "starts from nothing rather than believing a shape it cannot read",
      () => {
        // A context is an optimization over re-reading, so an unreadable
        // one costs the two cross-run rules their reach and nothing else.
        for (const value of [undefined, null, 7, "a context", []]) {
          const back = parseContext(value);
          expect(back.outcomesAtCommit.size).toBe(0);
          expect(back.mainAtCommit.size).toBe(0);
          expect(back.credited.size).toBe(0);
          expect(back.failures.size).toBe(0);
        }
      },
    );

    it("keeps only the pairs that are pairs", () => {
      const back = parseContext({
        outcomesAtCommit: "not a list",
        mainAtCommit: [7, ["k a"], [9, { day: "2026-08-20", outcome: "fail" }]],
        credited: [["k a b", "2026-08-20"], [7, "2026-08-20"]],
        failures: 7,
      });
      expect(back.mainAtCommit.size).toBe(0);
      expect([...back.credited.keys()]).toEqual(["k a b"]);
    });

    it("drops an entry whose held value is not a record", () => {
      const back = parseContext({
        outcomesAtCommit: [["c1", "yesterday"], ["c2", null]],
        mainAtCommit: [["k a", 7], ["k b", null]],
        credited: [],
        failures: [["k a", "not a list"], ["k b", 7]],
      });
      expect(back.outcomesAtCommit.size).toBe(0);
      expect(back.mainAtCommit.size).toBe(0);
      expect(back.failures.size).toBe(0);
    });

    it("drops an outcome record with no readable day or outcomes", () => {
      const back = parseContext({
        outcomesAtCommit: [
          ["ca", { day: 7, identities: [["k", ["pass"]]] }],
          ["cb", { day: "2026-08-20", identities: "not a list" }],
          ["cc", { day: "2026-08-20", identities: [["k", ["wat"]]] }],
          ["cd", { day: "2026-08-20", identities: [["k", "pass"]] }],
          ["ce", {
            day: "2026-08-20",
            identities: [["k", ["pass", "fail"]]],
          }],
        ],
        mainAtCommit: [
          ["k a", { day: "2026-08-20", outcome: "skip" }],
          ["k b", { day: "2026-08-20", outcome: "pass" }],
        ],
        credited: [],
        failures: [],
      });
      expect([...back.outcomesAtCommit.keys()]).toEqual(["ce"]);
      // A skip is not an outcome the cross-run rules act on, so a stored
      // one is not a main verdict to be resumed from.
      expect([...back.mainAtCommit.keys()]).toEqual(["k b"]);
    });

    it("keeps a failure list, dropping the failures it cannot read", () => {
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [],
        credited: [],
        failures: [["k a", [
          { day: "2026-08-20", source: "branch" },
          { day: "nope", source: "branch" },
          { day: "2026-08-20", source: 7 },
          null,
        ]]],
      });
      expect(back.failures.get("k a")?.length).toBe(1);
    });

    it("drops a whole entry when nothing in it survives", () => {
      const back = parseContext({
        outcomesAtCommit: [],
        mainAtCommit: [],
        credited: [],
        failures: [["k a", [{ day: "nope", source: "branch" }]]],
      });
      expect(back.failures.size).toBe(0);
    });

    it("ages out what the rules can no longer reach", () => {
      const context = emptyContext();
      context.mainAtCommit.set("k old", { day: "2026-01-01", outcome: "fail" });
      context.mainAtCommit.set("k new", { day: "2026-08-20", outcome: "fail" });
      context.credited.set("k old branch", "2026-01-01");
      trimContext(context, "2026-08-20");
      expect([...context.mainAtCommit.keys()]).toEqual(["k new"]);
      expect(context.credited.size).toBe(0);
    });

    it("drops a failure list once every failure in it is stale", () => {
      const context = emptyContext();
      context.failures.set("k gone", [{ day: "2020-01-01", source: "a" }]);
      context.failures.set("k here", [
        { day: "2020-01-01", source: "a" },
        { day: "2026-08-20", source: "b" },
      ]);
      context.outcomesAtCommit.set("old", {
        day: "2020-01-01",
        identities: new Map([["k", new Set(["fail"])]]),
      });
      trimContext(context, "2026-08-20");
      expect([...context.failures.keys()]).toEqual(["k here"]);
      expect(context.failures.get("k here")?.length).toBe(1);
      expect(context.outcomesAtCommit.size).toBe(0);
    });
  });

  describe("the batch it is handed", () => {
    it("refuses an iterator, which replays nothing after the first pass", () => {
      function* once(): Generator<Observation> {
        yield saw("fail", { commit: "c1" });
      }
      expect(() => foldObservations(once())).toThrow(
        "needs an iterable that replays",
      );
    });

    it("takes an iterable that hands out a fresh iterator each time", () => {
      const batch = [saw("fail", { commit: "c1" })];
      expect(foldObservations({
        *[Symbol.iterator]() {
          yield* batch;
        },
      }))
        .toEqual(foldObservations(batch));
    });
  });

  describe("what counts as a catch", () => {
    it("counts a failure on a branch where main was green", () => {
      const state = stateFrom([
        saw("pass", { day: "2026-08-19", commit: "c0" }),
        saw("fail", { commit: "c1", place: "pr", source: "fix-writes" }),
      ]);
      expect(state.prCatches).toBe(1);
      expect(state.lastCatch).toBe("2026-08-20");
    });

    it("counts nothing at a commit where main was already red", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("fail", { commit: "c1", place: "pr", source: "fix-writes" }),
      ]);
      expect(state.prCatches).toBe(0);
    });

    it("counts a failure on a branch after main went green again", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-18", commit: "c0" }),
        saw("pass", { day: "2026-08-19", commit: "c1" }),
        saw("fail", { commit: "c2", place: "pr", source: "fix-writes" }),
      ]);
      expect(state.prCatches).toBe(1);
    });

    it("reads a pass and a failure at one commit as a flake", () => {
      const state = stateFrom([
        saw("pass", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
      ]);
      expect(state.prCatches).toBe(0);
      expect(state.flakesByDay["2026-08-20"]).toBe(1);
      // Two runs, one of them a disagreement. Nothing is charged
      // against that, so it reads as the half it is and the test is too
      // noisy to judge a change by until it has run enough to say
      // otherwise.
      expect(flakeRate(state, "2026-08-20")).toBe(0.5);
      expect(flakeRate(state, "2026-08-20")).toBeGreaterThan(
        FLAKE_EXCLUSION_RATE,
      );
    });

    it("reads a failure across many branches as the environment", () => {
      const branches = ["a", "b", "c", "d", "e", "f"];
      const state = stateFrom(
        branches.map((branch, i) =>
          saw("fail", { commit: `c${i}`, place: "pr", source: branch })
        ),
      );
      expect(state.prCatches).toBe(0);
    });

    it("counts one catch however often a broken commit is re-run", () => {
      const state = stateFrom([
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
      ]);
      expect(state.prCatches).toBe(1);
    });

    it("weighs a catch on a workstation double", () => {
      const state = stateFrom([
        saw("fail", { commit: "c1", place: "local", source: "ianh" }),
      ]);
      expect(state.localCatches).toBe(1);
      expect(scoreInputs(state, "2026-08-20").catches).toBe(2);
    });
  });

  describe("a failure on main, judged by what came next", () => {
    it("waits while the same failure is still there", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("fail", { commit: "c1" }),
      ]);
      expect(state.mainCatches).toBe(0);
      expect(state.pendingMain.length).toBe(2);
    });

    it("counts a catch once a later run passes", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0" }),
        saw("pass", { commit: "c1" }),
      ]);
      expect(state.mainCatches).toBe(1);
      expect(state.pendingMain).toEqual([]);
    });

    it("counts one catch for a run of failures one change ended", () => {
      // A test red across several commits on the default branch has one
      // thing wrong with it, and the change that makes it green fixed
      // that one thing.
      const state = stateFrom([
        saw("fail", { day: "2026-08-17", commit: "c0" }),
        saw("fail", { day: "2026-08-18", commit: "c1" }),
        saw("fail", { day: "2026-08-19", commit: "c2" }),
        saw("pass", { commit: "c3" }),
      ]);
      expect(state.mainCatches).toBe(1);
      expect(state.lastCatch).toBe("2026-08-17");
      expect(state.pendingMain).toEqual([]);
      // One catch and nothing else: the run resolved, so none of the
      // failures in it is also flake evidence.
      expect(flakeRate(state, "2026-08-20")).toBe(0);
    });

    it("reads a green rerun of the same commit as a flake", () => {
      // The two runs can arrive in separate batches, so the same-commit
      // check inside one batch does not see this pair.
      const state = stateFrom([
        saw("fail", { commit: "c1" }),
        saw("pass", {
          commit: "c1",
          day: "2026-08-21",
          startedAt: "2026-08-21T00:00:00.000Z",
        }),
      ]);
      expect(state.mainCatches).toBe(0);
      expect(state.flakesByDay["2026-08-20"]).toBe(1);
      expect(flakeRate(state, "2026-08-21")).toBeGreaterThan(
        FLAKE_EXCLUSION_RATE,
      );
    });
  });

  describe("the order a run's tests were shuffled into", () => {
    it("reads a pass and a failure at one commit in two orders as no flake", () => {
      // An order-dependent test passes in one order and fails in another.
      // That is a bug in the test, not chance, and a flake rate high
      // enough would withhold it from pull requests rather than get it
      // fixed.
      const state = stateFrom([
        saw("pass", { seed: 20260921, place: "pr", source: "branch" }),
        saw("fail", { seed: 20260922, place: "pr", source: "branch" }),
      ]);
      expect(state.flakesByDay["2026-08-20"] ?? 0).toBe(0);
      expect(flakeRate(state, "2026-08-20")).toBe(0);
    });

    it("still reads a pass and a failure in one order as a flake", () => {
      const state = stateFrom([
        saw("pass", { seed: 20260922, place: "pr", source: "branch" }),
        saw("fail", { seed: 20260922, place: "pr", source: "branch" }),
      ]);
      expect(state.flakesByDay["2026-08-20"]).toBe(1);
    });

    it("keeps a seeded run apart from one in declaration order", () => {
      // A run with no seed ran its tests in the order they were declared,
      // which is an order of its own.
      const state = stateFrom([
        saw("pass", { place: "pr", source: "branch" }),
        saw("fail", { seed: 20260922, place: "pr", source: "branch" }),
      ]);
      expect(state.flakesByDay["2026-08-20"] ?? 0).toBe(0);
    });

    it("credits no catch to a failure on main that a new order ended", () => {
      // The order moved on and the test stopped failing, which says
      // nothing about whether any change fixed it.
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0", seed: 20260819 }),
        saw("pass", { commit: "c1", seed: 20260820 }),
      ]);
      expect(state.mainCatches).toBe(0);
      expect(state.pendingMain).toEqual([]);
      expect(flakeRate(state, "2026-08-20")).toBe(0);
    });

    it("judges a failure in the pass's order beside one in another", () => {
      // An older failure in another order is dropped, and does not take
      // the same-order failure after it down with it.
      const state = stateFrom([
        saw("fail", { day: "2026-08-19", commit: "c0", seed: 20260819 }),
        saw("fail", { day: "2026-08-20", commit: "c1", seed: 20260820 }),
        saw("pass", { commit: "c2", seed: 20260820 }),
      ]);
      expect(state.mainCatches).toBe(1);
      expect(state.lastCatch).toBe("2026-08-20");
      expect(state.pendingMain).toEqual([]);
    });

    it("still credits a catch to a failure a later commit in one order ended", () => {
      const state = stateFrom([
        saw("fail", { day: "2026-08-20", commit: "c0", seed: 20260820 }),
        saw("pass", { commit: "c1", seed: 20260820 }),
      ]);
      expect(state.mainCatches).toBe(1);
    });

    it("reads a rerun of one commit in another order as neither flake nor catch", () => {
      const state = stateFrom([
        saw("fail", { commit: "c1", seed: 20260820 }),
        saw("pass", {
          commit: "c1",
          seed: 20260821,
          day: "2026-08-21",
          startedAt: "2026-08-21T00:00:00.000Z",
        }),
      ]);
      expect(state.mainCatches).toBe(0);
      expect(state.flakesByDay["2026-08-20"] ?? 0).toBe(0);
    });
  });

  describe("variants", () => {
    it("scores a variant apart from the default it shadows", () => {
      const marked = { ...TEST, v: "server-execution" };
      const folded = foldObservations([
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
        saw("pass", {
          test: marked,
          commit: "c1",
          place: "pr",
          source: "branch",
        }),
      ]);
      const markedKey = JSON.stringify([
        marked.k,
        marked.s,
        marked.n,
        marked.v,
      ]);
      expect(folded.get(KEY)!.prCatches).toBe(1);
      expect(folded.get(markedKey)!.prCatches).toBe(0);
    });
  });

  describe("the value formula", () => {
    it("scores a test that never failed anywhere at exactly the floor", () => {
      const state = stateFrom([saw("pass")]);
      expect(value(scoreInputs(state, "2026-08-20"), "2026-08-20")).toBe(
        VALUE_FLOOR,
      );
    });

    it("scores failures that were not catches at the floor plus churn", () => {
      // Every failure here disagrees with a pass at the same commit, so
      // none is a catch, and what is left is the churn term alone.
      const state = stateFrom([
        saw("pass", { commit: "c1", place: "pr", source: "branch" }),
        saw("fail", { commit: "c1", place: "pr", source: "branch" }),
      ]);
      const inputs = scoreInputs(state, "2026-08-20");
      expect(inputs.catches).toBe(0);
      expect(inputs.lastCatch).toBeUndefined();
      const scored = value(inputs, "2026-08-20");
      expect(Number.isFinite(scored)).toBe(true);
      expect(scored).toBeGreaterThan(VALUE_FLOOR);
      expect(scored).toBeCloseTo(VALUE_FLOOR + 0.15 * inputs.churn, 10);
    });

    it("keeps an old proven test ahead of one with no record", () => {
      const proven = {
        catches: 4,
        lastCatch: "2024-08-20",
        sources: 2,
        churn: 0,
      };
      const unproven = {
        catches: 0,
        sources: 0,
        churn: 0,
      };
      expect(value(proven, "2026-08-20")).toBeGreaterThan(
        value(unproven, "2026-08-20"),
      );
    });

    it("saturates, so a fifth catch cannot crowd everything out", () => {
      const at = (catches: number) =>
        value(
          {
            catches,
            lastCatch: "2026-08-20",
            sources: 1,
            churn: 0,
          },
          "2026-08-20",
        );
      expect(at(3) - at(2)).toBeLessThan(at(2) - at(1));
      expect(at(5) - at(4)).toBeLessThan(at(3) - at(2));
      expect(at(100)).toBeLessThan(1);
    });

    it("decays a catch slowly and never below the freshness floor", () => {
      const at = (lastCatch: string) =>
        value(
          { catches: 4, lastCatch, sources: 0, churn: 0 },
          "2026-08-20",
        );
      expect(at("2026-08-13")).toBeGreaterThan(at("2026-04-20"));
      expect(at("2024-08-20")).toBeGreaterThan(VALUE_FLOOR);
    });
  });

  describe("churn", () => {
    it("puts a live failure ahead of a long-dead outage", () => {
      const live = emptyState();
      for (let age = 0; age < 3; age++) {
        const day = dayBefore("2026-08-20", age);
        live.runsByDay[day] = 250;
        live.failuresByDay[day] = 250;
      }
      const healed = emptyState();
      for (let age = 240; age < 247; age++) {
        const day = dayBefore("2026-08-20", age);
        healed.runsByDay[day] = 250;
        healed.failuresByDay[day] = 150;
      }
      for (let age = 0; age < 240; age++) {
        healed.runsByDay[dayBefore("2026-08-20", age)] = 250;
      }
      expect(churn(live, "2026-08-20")).toBeGreaterThan(
        churn(healed, "2026-08-20"),
      );
    });

    it("is zero for a test that has never run", () => {
      expect(churn(emptyState(), "2026-08-20")).toBe(0);
    });
  });

  describe("cost", () => {
    it("combines a day read across two runs without double counting", () => {
      // A day arrives over as many runs as it takes, so sealing combines
      // rather than replaces — and nothing else writes a day's sample, or
      // the combination would fold a running value into itself.
      const state = emptyState();
      sealDay(state, "2026-08-20", samplesOf([100, 100, 900]));
      sealDay(state, "2026-08-20", samplesOf([200]));
      expect(state.costByDay["2026-08-20"]).toEqual({
        ...samplesOf([100, 100, 200, 900]),
        rule: COST_RULE,
      });
    });

    it("reads a day the same whatever runs it arrived over", () => {
      // The day is one population; which run carried which part of it is
      // an accident of when objects reached the store.
      const whole = Array.from({ length: 40 }, (_, i) => (i + 1) * 10);
      const once = emptyState();
      sealDay(once, "2026-08-20", samplesOf(whole));
      const split = emptyState();
      const cuts = [0, 7, 9, 31, whole.length];
      for (let part = 1; part < cuts.length; part++) {
        sealDay(
          split,
          "2026-08-20",
          samplesOf(whole.slice(cuts[part - 1], cuts[part])),
        );
      }
      expect(costSeconds(split, "2026-08-20"))
        .toBe(costSeconds(once, "2026-08-20"));
    });

    it("does not let one execution sealed alone stand for its day", () => {
      // The batch a slow execution arrives in can hold nothing else, and
      // a percentile of that batch would be that execution.
      const state = emptyState();
      sealDay(state, "2026-08-20", samplesOf(Array(45).fill(64)));
      sealDay(state, "2026-08-20", samplesOf([300_000]));
      expect(costSeconds(state, "2026-08-20")).toBe(0.064);
    });

    it("reads the window's executions as one population, in seconds", () => {
      // The one slow execution is the slowest tenth of the ten, which a
      // ninetieth percentile reads past, whichever day it fell on.
      const state = emptyState();
      sealDay(state, "2026-08-19", samplesOf(Array(9).fill(1024)));
      sealDay(state, "2026-08-20", samplesOf([8192]));
      expect(costSeconds(state, "2026-08-20")).toBe(1.024);
    });

    it("weighs a slow day by how many executions it holds", () => {
      // A slow day decides the cost once it holds more than a tenth of
      // the window's executions, and not before.
      const fast = Array(100).fill(1024);
      const few = emptyState();
      sealDay(few, "2026-08-14", samplesOf(Array(11).fill(8192)));
      sealDay(few, "2026-08-20", samplesOf(fast));
      expect(costSeconds(few, "2026-08-20")).toBe(1.024);
      const many = emptyState();
      sealDay(many, "2026-08-14", samplesOf(Array(12).fill(8192)));
      sealDay(many, "2026-08-20", samplesOf(fast));
      expect(costSeconds(many, "2026-08-20")).toBe(8.192);
    });

    it("forgets a day past the window", () => {
      const state = emptyState();
      sealDay(state, "2026-08-01", samplesOf([9000]));
      expect(costSeconds(state, "2026-08-20")).toBe(0);
    });
  });

  describe("trimming", () => {
    it("drops the days each window has passed", () => {
      const state = emptyState();
      state.runsByDay["2026-01-01"] = 1;
      state.runsByDay["2026-08-20"] = 1;
      sealDay(state, "2026-01-01", samplesOf([10]));
      trimWindows(state, "2026-08-20");
      expect(Object.keys(state.runsByDay)).toEqual(["2026-08-20"]);
      expect(Object.keys(state.costByDay)).toEqual([]);
    });

    it("drops a failure on the default branch nothing has judged", () => {
      // A failure waits here for a later run to pass the test, and a
      // test the branch does not go red for is one no such run has to
      // arrive for. Nothing would bound this otherwise.
      const state = emptyState();
      state.pendingMain = [
        { day: "2026-01-01", commit: "old", source: "main" },
        { day: "2026-08-19", commit: "new", source: "main" },
      ];
      trimWindows(state, "2026-08-20");
      expect(state.pendingMain.map((pending) => pending.commit)).toEqual([
        "new",
      ]);
    });
  });

  describe("days", () => {
    it("counts calendar days between two of them", () => {
      expect(daysBetween("2026-08-19", "2026-08-20")).toBe(1);
      expect(daysBetween("2026-08-20", "2026-08-20")).toBe(0);
      expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    });
  });
});

/**
 * The ninetieth percentile of a list, by nearest rank, worked out here
 * rather than through the module under test so that the two are two
 * answers to compare.
 */
function exactPercentile90(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)]!;
}

function dayBefore(day: string, ago: number): string {
  const stamp = Date.parse(`${day}T00:00:00Z`) - ago * 86_400_000;
  return new Date(stamp).toISOString().slice(0, 10);
}

/**
 * A population of durations with repeats and no order to it, spread over
 * several doublings so that the buckets it lands in are far apart.
 */
function scattered(length: number): number[] {
  return Array.from({ length }, (_, i) => ((i * 37) % 211 + 1) ** 2);
}

describe("a day's sample of its runs", () => {
  it("counts every run it is given", () => {
    const samples = samplesOf([30, 10, 20, 20]);
    expect(samples.counts.reduce((sum, each) => sum + each, 0)).toBe(4);
  });

  it("reads a duration on a bucket's bound as that duration", () => {
    for (const ms of [1, 2, 1024, 4096, 2 ** 20]) {
      expect(sampledPercentile90(samplesOf([ms]))).toBe(ms);
    }
  });

  it("reads a duration no lower than itself, and under a bucket above", () => {
    // The bound a cost is read at covers every duration the bucket
    // counts, and is within one bucket's width of each of them.
    const width = 2 ** (1 / COST_BUCKETS_PER_DOUBLING);
    for (let ms = 1; ms < 100_000; ms = Math.ceil(ms * 1.07) + 0.5) {
      const read = sampledPercentile90(samplesOf([ms]));
      expect(read).toBeGreaterThanOrEqual(ms);
      expect(read).toBeLessThan(ms * width);
    }
  });

  it("reads a run of a millisecond or less as a millisecond", () => {
    expect(sampledPercentile90(samplesOf([0, 0.5, 1]))).toBe(1);
  });

  it("reads the percentile at or above the exact one, within a bucket", () => {
    const width = 2 ** (1 / COST_BUCKETS_PER_DOUBLING);
    for (const length of [1, 9, 10, 11, 64, 65, 1000]) {
      const durations = scattered(length);
      const exact = exactPercentile90(durations);
      const read = sampledPercentile90(samplesOf(durations));
      expect(read).toBeGreaterThanOrEqual(exact);
      expect(read).toBeLessThan(exact * width);
    }
  });

  it("has no percentile for a day nothing ran on", () => {
    expect(sampledPercentile90(samplesOf([]))).toBe(0);
  });
});

describe("the ninetieth percentile of a list", () => {
  it("answers by nearest rank", () => {
    // Each size is checked against the nearest rank worked out
    // separately, since an off-by-one here moves every charge the lane
    // model reads.
    for (let size = 1; size <= 40; size++) {
      const values = Array.from({ length: size }, (_, i) => (i + 1) * 10);
      expect(percentile90(values)).toBe(exactPercentile90(values));
    }
  });

  it("has no percentile for a list of nothing", () => {
    expect(percentile90([])).toBe(0);
  });
});

describe("mergeSamples()", () => {
  it("counts the runs of both", () => {
    const a = samplesOf([10, 40]);
    const b = samplesOf([20, 30]);
    expect(mergeSamples(a, b)).toEqual(samplesOf([10, 20, 30, 40]));
  });

  it("counts what accumulating the whole would have, at every cut", () => {
    // The property a fold reading a day in parts rests on, shown over a
    // population rather than asserted: what the merge counts cannot
    // depend on where the day was divided.
    const whole = scattered(256);
    const direct = samplesOf(whole);
    for (let at = 0; at <= whole.length; at++) {
      expect(
        mergeSamples(samplesOf(whole.slice(0, at)), samplesOf(whole.slice(at))),
      ).toEqual(direct);
    }
  });

  it("counts the same over any number of parts", () => {
    // A fold merges each batch into what it holds, so the parts arrive
    // one at a time and every merge but the first is against a merge.
    const whole = scattered(256);
    const cuts = [0, 1, 13, 64, 65, whole.length];
    let merged = samplesOf([]);
    for (let part = 1; part < cuts.length; part++) {
      merged = mergeSamples(
        merged,
        samplesOf(whole.slice(cuts[part - 1], cuts[part])),
      );
    }
    expect(merged).toEqual(samplesOf(whole));
  });

  it("leaves both sides as they were", () => {
    const a = samplesOf([10, 40]);
    const b = samplesOf([2]);
    mergeSamples(a, b);
    expect(a).toEqual(samplesOf([10, 40]));
    expect(b).toEqual(samplesOf([2]));
  });
});

describe("sealDay()", () => {
  it("writes nothing for a day with no runs in it", () => {
    const state = emptyState();
    sealDay(state, "2026-08-20", samplesOf([]));
    expect(state.costByDay["2026-08-20"]).toBeUndefined();
  });

  it("leaves the other days these rules sealed where they are", () => {
    // Sealing clears what another set of rules left, and every day this
    // set sealed is not that.
    const state = emptyState();
    sealDay(state, "2026-08-19", samplesOf([1024]));
    sealDay(state, "2026-08-20", samplesOf([16]));
    expect(Object.keys(state.costByDay).sort())
      .toEqual(["2026-08-19", "2026-08-20"]);
    expect(costSeconds(state, "2026-08-20")).toBe(1.024);
  });

  it("keeps the sample it was handed out of the state it wrote", () => {
    const state = emptyState();
    const batch = samplesOf([10, 20]);
    sealDay(state, "2026-08-20", batch);
    sampleDuration(batch, 900);
    expect(state.costByDay["2026-08-20"]).toEqual({
      ...samplesOf([10, 20]),
      rule: COST_RULE,
    });
  });
});

describe("readCostsForward()", () => {
  /** A state holding one day in a shape an earlier set of rules stored. */
  const held = (stored: unknown): IdentityState => {
    const state = emptyState();
    (state.costByDay as Record<string, unknown>)["2026-08-20"] = stored;
    return state;
  };

  it("gives back the cost a day carrying a percentile was giving", () => {
    for (const count of [1, 45, 10_000]) {
      const state = held({ p90: 4096, count });
      readCostsForward(state);
      expect(costSeconds(state, "2026-08-20")).toBe(4.096);
    }
  });

  it("counts the runs a day kept only the slowest of at the least kept", () => {
    // Every run that was not kept was no slower than the least that
    // was, so counting it there reads the day at or above what it was.
    // The rank is taken over every run: the three kept alone would read
    // at the slowest of them.
    const state = held({ slowest: [2048, 4096, 4096], count: 20 });
    readCostsForward(state);
    expect(state.costByDay["2026-08-20"]).toEqual(
      samplesOf([...Array(18).fill(2048), 4096, 4096]),
    );
    expect(costSeconds(state, "2026-08-20")).toBe(2.048);
  });

  it("reads a day kept whole as the runs it kept, under its own rules", () => {
    const state = held({ slowest: [16, 1024, 1024], count: 3, rule: 7 });
    readCostsForward(state);
    expect(state.costByDay["2026-08-20"]).toEqual({
      ...samplesOf([16, 1024, 1024]),
      rule: 7,
    });
  });

  it("keeps a day these rules stored as its slowest runs beside new ones", () => {
    // How a day was stored is not which executions it holds, so a day
    // these rules sealed before they counted by bucket stays in the
    // window, and its slow runs weigh against the new day's fast ones.
    const state = emptyState();
    (state.costByDay as Record<string, unknown>)["2026-08-19"] = {
      slowest: Array(12).fill(8192),
      count: 12,
      rule: COST_RULE,
    };
    readCostsForward(state);
    sealDay(state, "2026-08-20", samplesOf(Array(100).fill(1024)));
    expect(Object.keys(state.costByDay).sort())
      .toEqual(["2026-08-19", "2026-08-20"]);
    expect(costSeconds(state, "2026-08-20")).toBe(8.192);
  });

  it("gives way to the day these rules seal, on the same day", () => {
    // The figures it carries are ones an earlier set of rules produced,
    // so the part of the day that lands under these replaces them rather
    // than joining them.
    for (
      const stored of [{ p90: 32_768, count: 45 }, {
        slowest: [32_768],
        count: 45,
      }]
    ) {
      const state = held(stored);
      readCostsForward(state);
      sealDay(state, "2026-08-20", samplesOf([16, 32]));
      expect(costSeconds(state, "2026-08-20")).toBe(0.032);
    }
  });

  it("reads a day whose stored figures are not numbers as empty", () => {
    // The read of one such day ends that day rather than the state it
    // sits in, which the aggregate reports rather than throwing over.
    for (
      const stored of [
        { p90: 4000 },
        { p90: 4000, count: 2.5 },
        { p90: 4000, count: -1 },
        { p90: "slow", count: 45 },
        { slowest: [], count: 3 },
        { slowest: "fast", count: 3 },
        { slowest: [10, "slow"], count: 3 },
        { slowest: [10, 20], count: 1 },
        { counts: [1] },
        { lowest: 1.5, counts: [1] },
        { lowest: -1, counts: [1] },
        { lowest: 0, counts: "1" },
        { lowest: 0, counts: [1, -1] },
        { lowest: 0, counts: [0.5] },
      ]
    ) {
      const state = held(stored);
      readCostsForward(state);
      expect(state.costByDay["2026-08-20"]).toEqual(samplesOf([]));
      expect(costSeconds(state, "2026-08-20")).toBe(0);
    }
  });

  it("reads a day that is not a record of figures as an empty one", () => {
    // A state is read back through this before anything has looked at
    // what it holds, and the reader of a stored aggregate reports one it
    // cannot read rather than ending over it. A day holding a string
    // would end it here.
    for (const stored of ["slowest", 7, null, true]) {
      const state = held(stored);
      readCostsForward(state);
      expect(state.costByDay["2026-08-20"]).toEqual(samplesOf([]));
    }
  });

  it("reads days that are not a record at all as none", () => {
    for (const stored of ["days", 7, [], null]) {
      const state = emptyState();
      (state as { costByDay: unknown }).costByDay = stored;
      readCostsForward(state);
      expect(state.costByDay).toEqual({});
    }
  });

  it("reads a state carrying no days at all as carrying none", () => {
    // The aggregate reports a state it cannot read rather than throwing
    // partway through one.
    const state = emptyState();
    delete (state as { costByDay?: unknown }).costByDay;
    readCostsForward(state);
    expect(state.costByDay).toEqual({});
  });

  it("leaves a day that already carries its samples alone", () => {
    const state = emptyState();
    sealDay(state, "2026-08-20", samplesOf([10, 20, 900]));
    const kept = state.costByDay["2026-08-20"];
    readCostsForward(state);
    expect(state.costByDay["2026-08-20"]).toBe(kept);
  });
});

describe("a day another set of cost rules sealed", () => {
  /** A state holding one day of executions, sealed by no known set. */
  const sealedBefore = (day: string, ms: number): IdentityState => {
    const state = emptyState();
    state.costByDay[day] = samplesOf(Array.from({ length: 20 }, () => ms));
    return state;
  };

  it("answers while these rules have sealed nothing", () => {
    // A test that has not passed since the rules changed has only what
    // the earlier ones measured, and that is a better answer than none.
    const state = sealedBefore("2026-08-20", 262_144);
    expect(costSeconds(state, "2026-08-20")).toBe(262.144);
  });

  it("stops answering once these rules have sealed anything", () => {
    // Read beside the day these rules sealed, the earlier day's twenty
    // executions would be most of the window and would decide the cost,
    // so this says the day is out of the reckoning rather than merely
    // outweighed.
    const state = sealedBefore("2026-08-20", 262_144);
    sealDay(state, "2026-08-20", samplesOf([16_384, 16_384]));
    expect(costSeconds(state, "2026-08-20")).toBe(16.384);
  });

  it("stops answering on a day of its own, not only on the same day", () => {
    // A record of an older day can reach the store late, so the day
    // these rules seal need not be the newest the state holds. Left
    // behind, the earlier rules' figure would come back the moment the
    // sealed day aged out from under it.
    const state = sealedBefore("2026-08-19", 262_144);
    state.costByDay["2026-08-20"] = samplesOf([262_144, 262_144]);
    sealDay(state, "2026-08-19", samplesOf([1024, 1024]));
    expect(costSeconds(state, "2026-08-20")).toBe(1.024);
    trimWindows(state, "2026-08-27");
    expect(costSeconds(state, "2026-08-27")).toBe(0);
  });

  it("gives way to a day these rules sealed under any other stamp", () => {
    // Nothing orders the stamps; a day answers as one of these days or
    // it does not.
    for (const rule of [undefined, COST_RULE - 1, COST_RULE + 1]) {
      const state = sealedBefore("2026-08-20", 262_144);
      state.costByDay["2026-08-20"]!.rule = rule;
      sealDay(state, "2026-08-20", samplesOf([1024]));
      expect(costSeconds(state, "2026-08-20")).toBe(1.024);
    }
    const held = sealedBefore("2026-08-20", 262_144);
    held.costByDay["2026-08-20"]!.rule = COST_RULE;
    sealDay(held, "2026-08-20", samplesOf([1024]));
    expect(costSeconds(held, "2026-08-20")).toBe(262.144);
  });

  it("ages out of the window as a day these rules sealed does", () => {
    const inside = sealedBefore(
      dayBefore("2026-08-20", COST_WINDOW_DAYS),
      262_144,
    );
    trimWindows(inside, "2026-08-20");
    expect(costSeconds(inside, "2026-08-20")).toBe(262.144);
    const past = sealedBefore(
      dayBefore("2026-08-20", COST_WINDOW_DAYS + 1),
      262_144,
    );
    trimWindows(past, "2026-08-20");
    expect(costSeconds(past, "2026-08-20")).toBe(0);
  });
});

describe("flakeCounts()", () => {
  it("reports both halves of the share, so a reader can weigh it", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 200;
    state.flakesByDay["2026-08-20"] = 10;
    expect(flakeCounts(state, "2026-08-20")).toEqual({ flakes: 10, runs: 200 });
  });

  it("counts neither half from a day the window cannot reach", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 200;
    state.flakesByDay["2026-08-20"] = 10;
    state.runsByDay["2020-01-01"] = 9000;
    state.flakesByDay["2020-01-01"] = 500;
    expect(flakeCounts(state, "2026-08-20")).toEqual({ flakes: 10, runs: 200 });
  });
});

describe("flakeRate()", () => {
  it("counts flakes against the runs they happened among", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 200;
    state.flakesByDay["2026-08-20"] = 10;
    expect(flakeRate(state, "2026-08-20")).toBe(10 / 200);
  });

  it("keeps a flake whose pass has aged out of the window", () => {
    // A disagreement is a pass and a failure at one commit, and the two
    // can be days apart. Where the pass falls outside the window and the
    // failure inside it, the window holds a disagreement with no pass
    // beside it, and the share reads at its ceiling until the test runs
    // again.
    const state = stateFrom([
      saw("pass", { day: "2026-06-20", commit: "c1", place: "pr" }),
      saw("fail", { day: "2026-06-22", commit: "c1", place: "pr" }),
    ]);
    expect(flakeCounts(state, "2026-06-22")).toEqual({ flakes: 1, runs: 2 });
    trimWindows(state, "2026-08-20");
    expect(flakeCounts(state, "2026-08-20")).toEqual({ flakes: 1, runs: 1 });
    expect(flakeRate(state, "2026-08-20")).toBe(1);
  });

  it("counts a disagreement for less as the test settles after it", () => {
    // The same counts on both, and not the same test. One disagreed and
    // has passed since; the other passed and has just disagreed. A share
    // that summed the window flat would call them equally flaky.
    const today = "2026-08-20";
    const settled = emptyState();
    settled.runsByDay["2026-07-23"] = 2;
    settled.flakesByDay["2026-07-23"] = 2;
    settled.runsByDay[today] = 200;

    const started = emptyState();
    started.runsByDay["2026-07-23"] = 200;
    started.runsByDay[today] = 2;
    started.flakesByDay[today] = 2;

    expect(flakeCounts(settled, today)).toEqual(flakeCounts(started, today));
    expect(flakeRate(settled, today)).toBeLessThan(flakeRate(started, today));
  });

  it("holds a test out until it has settled for long enough", () => {
    // Forty disagreements among a hundred runs in one day. It goes on
    // running on the default branch and never disagrees again, and what
    // brings it back is those runs together with the age of what it did.
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 100;
    state.flakesByDay["2026-08-20"] = 40;
    expect(flakeRate(state, "2026-08-20")).toBeGreaterThan(
      FLAKE_EXCLUSION_RATE,
    );
    for (let day = 21; day <= 23; day++) {
      state.runsByDay[`2026-08-${day}`] = 100;
    }
    expect(flakeRate(state, "2026-08-23")).toBeGreaterThan(
      FLAKE_EXCLUSION_RATE,
    );
    for (let day = 24; day <= 30; day++) {
      state.runsByDay[`2026-08-${day}`] = 100;
    }
    expect(flakeRate(state, "2026-08-30")).toBeLessThan(FLAKE_EXCLUSION_RATE);
  });

  it("tells two tests apart that fail only ever as flakes", () => {
    // Every failure either of these has is a flake, so a share of their
    // failures reads them both as wholly unreliable. What separates them
    // is how much of the time they pass.
    const noisy = emptyState();
    noisy.runsByDay["2026-08-20"] = 20;
    noisy.failuresByDay["2026-08-20"] = 10;
    noisy.flakesByDay["2026-08-20"] = 10;
    const reliable = emptyState();
    reliable.runsByDay["2026-08-20"] = 10000;
    reliable.failuresByDay["2026-08-20"] = 1;
    reliable.flakesByDay["2026-08-20"] = 1;
    expect(flakeRate(noisy, "2026-08-20")).toBeGreaterThan(
      FLAKE_EXCLUSION_RATE,
    );
    expect(flakeRate(reliable, "2026-08-20")).toBeLessThan(
      FLAKE_EXCLUSION_RATE,
    );
  });

  it("falls as the test goes on passing", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 4;
    state.flakesByDay["2026-08-20"] = 2;
    const held = flakeRate(state, "2026-08-20");
    expect(held).toBeGreaterThan(FLAKE_EXCLUSION_RATE);
    state.runsByDay["2026-08-21"] = 400;
    expect(flakeRate(state, "2026-08-21")).toBeLessThan(FLAKE_EXCLUSION_RATE);
  });

  it("counts only the days inside the window", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 20;
    state.flakesByDay["2026-08-20"] = 1;
    // Far enough back that the window cannot reach it, so neither its
    // runs nor its flakes are in the share.
    state.runsByDay["2020-01-01"] = 10000;
    state.flakesByDay["2020-01-01"] = 500;
    expect(flakeRate(state, "2026-08-20")).toBe(1 / 20);
  });

  it("is zero for a test that has never flaked", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 50;
    state.failuresByDay["2026-08-20"] = 5;
    expect(flakeRate(state, "2026-08-20")).toBe(0);
    expect(flakeRate(emptyState(), "2026-08-20")).toBe(0);
  });
});

describe("a main failure resolved in a later batch", () => {
  it("is a flake when the same commit later passes", () => {
    // The two runs of one commit can arrive in separate batches, so the
    // same-commit check inside a batch does not see this pair. Dropping
    // the pending failure would lose the flake as well as the catch.
    const context = emptyContext();
    const first = foldObservations([saw("fail", { commit: "c1" })], {
      context,
    });
    const second = foldObservations([saw("pass", { commit: "c1" })], {
      context,
      prior: first,
    });
    const state = second.get(KEY)!;
    expect(state.flakesByDay["2026-08-20"]).toBe(1);
    // A flake at one commit is not a catch: nothing was fixed between the
    // failure and the pass, because there is nothing between them.
    expect(state.mainCatches).toBe(0);
  });

  it("is a catch when a later commit passes", () => {
    const context = emptyContext();
    const first = foldObservations([saw("fail", { commit: "c1" })], {
      context,
    });
    const second = foldObservations([saw("pass", { commit: "c2" })], {
      context,
      prior: first,
    });
    const state = second.get(KEY)!;
    expect(state.flakesByDay["2026-08-20"]).toBeUndefined();
    expect(state.mainCatches).toBe(1);
  });

  it("is nothing at all when the failure is older than the window", () => {
    // A failure nothing has judged for the longest window a state keeps
    // is one the default branch has carried for that long, and the
    // change that passes now did not fix it. A fold resolves every
    // observation it reads before it ages anything, so the age is
    // checked here as well as in `trimWindows`.
    const context = emptyContext();
    const first = foldObservations([
      saw("fail", { commit: "c1", day: "2026-01-01" }),
    ], { context });
    const second = foldObservations([
      saw("pass", { commit: "c2", day: "2026-08-20" }),
    ], { context, prior: first });
    const state = second.get(KEY)!;
    expect(state.mainCatches).toBe(0);
    expect(state.flakesByDay["2026-01-01"]).toBeUndefined();
    // And the wait is over either way, so nothing keeps accumulating.
    expect(state.pendingMain).toEqual([]);
  });
});

describe("a failure seen from many places at once", () => {
  it("is environmental, and credits nobody, when the sources are near", () => {
    // Five sources failing within the breadth window is the environment
    // breaking, not the test catching five separate changes.
    const sources = ["main", "a", "b", "c", "d"];
    const folded = foldObservations(
      sources.map((source) =>
        saw("fail", { source, place: "pr", commit: `c-${source}` })
      ),
    );
    const state = folded.get(KEY)!;
    expect(state.prCatches).toBe(0);
  });

  it("credits each of them when the crowd is one short", () => {
    const sources = ["a", "b", "c", "d"];
    const folded = foldObservations(
      sources.map((source) =>
        saw("fail", { source, place: "pr", commit: `c-${source}` })
      ),
    );
    expect(folded.get(KEY)!.prCatches).toBe(sources.length);
  });

  it("counts a failure outside the window as a separate one", () => {
    // The same five sources, but one of them failed long enough ago that
    // the breadth window cannot reach it, so it is not part of the crowd.
    const near = ["a", "b", "c"].map((source) =>
      saw("fail", {
        source,
        place: "pr",
        commit: `c-${source}`,
        day: "2026-08-20",
      })
    );
    const far = saw("fail", {
      source: "d",
      place: "pr",
      commit: "c-d",
      day: "2026-08-01",
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    const folded = foldObservations([far, ...near]);
    const state = folded.get(KEY)!;
    expect(state.failuresByDay["2026-08-01"]).toBe(1);
    expect(state.failuresByDay["2026-08-20"]).toBe(3);
    // Four sources in all, but never four at once, so each is a catch.
    expect(state.prCatches).toBe(4);
  });
});

describe("a skipped run", () => {
  it("counts as nothing at all", () => {
    const folded = foldObservations([
      saw("skip"),
      saw("skip", { commit: "c2" }),
    ]);
    const state = folded.get(KEY);
    expect(state?.runsByDay["2026-08-20"]).toBeUndefined();
    expect(state?.failuresByDay["2026-08-20"]).toBeUndefined();
  });

  it("does not show that a test failing on main was fixed", () => {
    // The default branch is still where the failure belongs, so the one
    // the pull request sees is not credited to the change in front of it.
    const folded = foldObservations([
      saw("fail", { commit: "c1" }),
      saw("skip", { commit: "c2" }),
      saw("fail", { commit: "c3", place: "pr", source: "branch" }),
    ]);
    expect(folded.get(KEY)?.prCatches).toBe(0);
  });
});

describe("how far back the fold remembers where a test passed", () => {
  /** A pass at each of `count` commits, one after another. */
  function passesAt(count: number): Observation[] {
    return Array.from({ length: count }, (_, i) =>
      saw("pass", {
        commit: `c${i}`,
        startedAt: `2026-08-20T${String(i).padStart(2, "0")}:00:00.000Z`,
      }));
  }

  it("reads a failure at a remembered commit as disagreement", () => {
    const context = emptyContext();
    foldObservations([saw("pass", { commit: "c0" })], { context });
    const second = foldObservations([
      saw("pass", { commit: "c1", startedAt: "2026-08-20T01:00:00.000Z" }),
      saw("fail", { commit: "c0", startedAt: "2026-08-20T02:00:00.000Z" }),
    ], { context });
    const state = second.get(KEY)!;
    expect(state.flakesByDay["2026-08-20"]).toBe(1);
    expect(state.mainCatches).toBe(0);
  });

  it("keeps at most the reach, so the corpus times commits cannot grow", () => {
    // Every identity runs at nearly every commit, so an unbounded map is
    // the whole corpus multiplied by every commit it ever saw.
    const context = emptyContext();
    foldObservations(passesAt(FLAKE_COMMIT_REACH + 6), { context });
    expect(context.recentCommits.length).toBe(FLAKE_COMMIT_REACH);
    expect(context.outcomesAtCommit.size).toBe(FLAKE_COMMIT_REACH);
  });

  it("forgets a clean test's pass once the commit falls out of reach", () => {
    const context = emptyContext();
    foldObservations(passesAt(FLAKE_COMMIT_REACH + 2), { context });
    // c0 is past the reach and the test has never failed, so nothing is
    // held against it and the late failure reads as a first failure.
    const late = foldObservations([
      saw("fail", { commit: "c0", startedAt: "2026-08-21T00:00:00.000Z" }),
    ], { context, prior: new Map() });
    expect(late.get(KEY)!.flakesByDay["2026-08-20"]).toBeUndefined();
  });

  it("keeps a failed test's passes past the reach", () => {
    // Once a test has failed it is a flake candidate, and its passes are
    // what a later disagreement is judged against, so they survive the
    // window that a clean test's do not.
    const context = emptyContext();
    foldObservations([
      saw("fail", { commit: "c0" }),
      saw("pass", { commit: "c0", startedAt: "2026-08-20T00:30:00.000Z" }),
    ], { context });
    foldObservations(
      passesAt(FLAKE_COMMIT_REACH + 6).slice(1),
      { context },
    );
    const held = context.outcomesAtCommit.get("c0");
    expect(held).toBeDefined();
    expect([...held!.identities.get(KEY)!].sort()).toEqual(["fail", "pass"]);
  });

  it("drops the window along with the days it aged out", () => {
    const context = emptyContext();
    foldObservations(passesAt(3), { context });
    expect(context.recentCommits.length).toBe(3);
    trimContext(context, "2027-01-01");
    expect(context.outcomesAtCommit.size).toBe(0);
    expect(context.recentCommits).toEqual([]);
  });
});

describe("the two windows the context ages on", () => {
  it("keeps a failure the breadth rule can still reach", () => {
    // Breadth asks whether many branches saw one test fail around the
    // same time, and same-commit disagreement asks whether a rerun could
    // still arrive. One is weeks, the other hours, so a context aged on
    // a single span must be aged on the longer one and pay for it.
    const context = emptyContext();
    context.failures.set("k", [{ day: "2026-08-20", source: "a" }]);
    context.outcomesAtCommit.set("c1", {
      day: "2026-08-20",
      identities: new Map([["k", new Set(["pass"])]]),
    });
    const past = new Date(
      Date.parse("2026-08-20T00:00:00Z") +
        (SAME_COMMIT_REACH_DAYS + 1) * 86_400_000,
    ).toISOString().slice(0, 10);
    trimContext(context, past);
    expect(context.outcomesAtCommit.size).toBe(0);
    expect(context.failures.size).toBe(
      CATCH_BREADTH_WINDOW_DAYS > SAME_COMMIT_REACH_DAYS ? 1 : 0,
    );
  });
});

describe("a commit the window has already let go of", () => {
  const OTHER = { k: "unit", s: "memory", n: "another test" };
  const OTHER_KEY = testIdentityKey(OTHER);

  /** Passes at `count` commits after `c0`, one after another. */
  function moveOn(count: number): Observation[] {
    return Array.from({ length: count }, (_, i) =>
      saw("pass", {
        commit: `c${i + 1}`,
        startedAt: `2026-08-20T${String(i + 1).padStart(2, "0")}:00:00.000Z`,
      }));
  }

  it("remembers nothing new there about a test that has not failed", () => {
    // The commit is held only for the test that failed at it. Another
    // test arriving there later is not what it is being held for, and
    // remembering it would put the whole corpus back at that commit.
    const context = emptyContext();
    foldObservations([saw("fail", { commit: "c0" })], { context });
    foldObservations(moveOn(FLAKE_COMMIT_REACH + 1), { context });

    const held = context.outcomesAtCommit.get("c0")!;
    expect([...held.identities.keys()]).toEqual([KEY]);
    foldObservations([
      saw("pass", {
        test: OTHER,
        commit: "c0",
        startedAt: "2026-08-20T20:00:00.000Z",
      }),
    ], { context });
    expect([...held.identities.keys()]).toEqual([KEY]);
    expect(held.identities.has(OTHER_KEY)).toBe(false);
  });

  it("lets go of a commit the window names but no longer holds", () => {
    // A stored window can name a commit whose outcomes did not survive
    // being read, so the walk that evicts has to tolerate one that is
    // already gone rather than assume the two agree.
    const context = parseContext({
      outcomesAtCommit: [],
      recentCommits: ["gone"],
      mainAtCommit: [],
      credited: [],
      failures: [],
    });
    expect(context.recentCommits).toEqual(["gone"]);
    foldObservations(moveOn(FLAKE_COMMIT_REACH), { context });
    expect(context.recentCommits).not.toContain("gone");
    expect(context.outcomesAtCommit.has("gone")).toBe(false);
  });
});

describe("a rerun that lands after the window would have let go", () => {
  it("still reads as the test disagreeing with itself", () => {
    // Aging happens once per batch and after it, so an entry past the
    // span survives until the next batch arrives. A pass and a failure
    // at one commit is disagreement however far apart they land, and
    // there is no change between them for a catch to be about, so the
    // later answer is the better one and is left as it is.
    const context = emptyContext();
    const first = foldObservations([saw("pass", { commit: "c0" })], {
      context,
    });
    const late = foldObservations([
      saw("fail", {
        commit: "c0",
        day: "2026-08-30",
        startedAt: "2026-08-30T00:00:00.000Z",
      }),
    ], { context, prior: first });
    const state = late.get(KEY)!;
    expect(state.flakesByDay["2026-08-30"]).toBe(1);
    expect(state.mainCatches).toBe(0);
  });
});
