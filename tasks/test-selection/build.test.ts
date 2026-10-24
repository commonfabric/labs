import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  AliasResolver,
  buildObjectBody,
  type RunContext,
  type StoredReport,
  type StoredReportGroup,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";

import {
  buildManifest,
  CI_SOURCE,
  coldStart,
  dayOf,
  departed,
  emptyAggregate,
  executionsFor,
  firstDay,
  Fold,
  foldReports,
  lastReadDay,
  lastRun,
  localReporter,
  locateSurfaces,
  parseAggregate,
  provenance,
  readReport,
  recordSurface,
  reportFromText,
  resolveHistory,
} from "./build.ts";
import {
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
} from "./manifest.ts";
import type { Suite } from "../test-topology/suite.ts";
import {
  excusedMeasurementName,
  hooksMeasurementName,
} from "../lane-measurement.ts";
import {
  COST_RULE,
  costSeconds,
  daysBetween,
  emptyContext,
  emptyState,
  flakeRate,
  type IdentityState,
  lastMainIn,
  NEW_REAL_TEST_FAILURE_RULE,
  parseContext,
  samplesOf,
  sealDay,
  serializeContext,
  value,
} from "./score.ts";
import {
  COST_WINDOW_DAYS,
  FLAKE_ANCHOR_EXECUTIONS,
  FLAKE_ANCHOR_RATE,
  FLAKE_EXCLUSION_RATE,
  FLAKE_MIN_EXECUTIONS,
  MAX_EXECUTIONS,
} from "./policy.ts";

const NO_ALIASES = new AliasResolver([]);

function context(fields: Partial<RunContext> = {}): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId: "01K3",
    repo: "commonfabric/labs",
    commit: "c1",
    dirty: false,
    branch: "main",
    env: "ci",
    ci: {
      workflowRunId: "1",
      runAttempt: 1,
      workflow: "deno.yml",
      job: "Test (1/8)",
      event: "push",
      fork: false,
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: "2026-08-20T00:00:00.000Z",
    ...fields,
  };
}

function record(fields: Partial<TestRecord> = {}): TestRecord {
  return {
    line: "record",
    test: { k: "unit", s: "memory", n: "space > writes" },
    outcome: "pass",
    durationMs: 40,
    ...fields,
  };
}

/**
 * A run context the fold cannot place, because it names no branch. What
 * decides a group's place is read from the run's own facts, and this one
 * says nothing about where it ran.
 */
function placeless(): RunContext {
  const context_ = context();
  delete context_.branch;
  return context_;
}

/** Reports as the rollup path hands them over, one at a time. */
async function* replaying(reports: readonly StoredReport[]) {
  for (const report of reports) yield report;
}

/** One stored object, built the way the relay builds one. */
function stored(
  objectName: string,
  runContext: RunContext,
  records: readonly TestRecord[],
) {
  return reportFromText(objectName, buildObjectBody(runContext, records));
}

const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });
/** The file a record of that identity names. */
const UNIT = "packages/memory/test/space.test.ts";
const CI_NAME = "labs/test-records/submissions/ci/v1/2026/08/20/run-1-a.ndjson";
const LOCAL_NAME =
  "labs/test-records/submissions/local/ianh/v1/2026/08/20/01K3-branch.ndjson";

describe("build", () => {
  describe("provenance()", () => {
    it("reads a push to main as a run on main", () => {
      expect(provenance(context(), CI_NAME)).toEqual({
        place: "main",
        source: "main",
      });
    });

    it("reads a scheduled run of main as a run on main", () => {
      const scheduled = context();
      scheduled.ci!.event = "schedule";
      expect(provenance(scheduled, CI_NAME)).toEqual({
        place: "main",
        source: "main",
      });
    });

    it("reads any other branch as a pull request", () => {
      expect(provenance(context({ branch: "fix-writes" }), CI_NAME)).toEqual({
        place: "pr",
        source: "fix-writes",
      });
    });

    it("names the reporting person for a local run", () => {
      const local = context({
        env: "local",
        branch: "fix-writes",
      });
      delete local.ci;
      expect(provenance(local, LOCAL_NAME)).toEqual({
        place: "local",
        source: "ianh",
      });
    });

    it("reads a fork run as a pull request", () => {
      // See `docs/specs/test-records.md`, "Trust boundaries for
      // consumers", for what the store's member gate leaves the fork flag
      // meaning.

      const forked = context({ branch: "fix-writes" });
      forked.ci!.event = "pull_request";
      forked.ci!.fork = true;
      expect(provenance(forked, CI_NAME)).toEqual({
        place: "pr",
        source: "fix-writes",
      });
    });

    it("reads a fork-marked push to main as a pull request", () => {
      // A baseline is code the tree itself carries, and a run this
      // repository cannot place reads as a fork, so one never stands as a
      // baseline.

      const forked = context();
      forked.ci!.fork = true;
      expect(provenance(forked, CI_NAME)).toEqual({
        place: "pr",
        source: "main",
      });
    });

    it("declines a run carrying no continuous-integration facts", () => {
      // Where a run ran is read from those facts, so a context that is
      // not a workstation's and carries none says nothing this can use.

      const bare = context();
      delete bare.ci;
      expect(provenance(bare, CI_NAME)).toBeUndefined();
    });

    it("declines a report with no context", () => {
      expect(provenance(undefined, CI_NAME)).toBeUndefined();
    });

    it("declines a continuous-integration run that names no branch", () => {
      // The branch is the source a new real test failure is attributed
      // to, so a run with none cannot be told apart from any other run
      // with none.
      const nameless = context();
      delete nameless.branch;
      expect(provenance(nameless, CI_NAME)).toBeUndefined();
      expect(provenance(context({ branch: "" }), CI_NAME)).toBeUndefined();
    });
  });

  describe("localReporter()", () => {
    it("reads the person out of a local object's name", () => {
      expect(localReporter(LOCAL_NAME)).toBe("ianh");
    });

    it("finds nobody in a continuous-integration object's name", () => {
      expect(localReporter(CI_NAME)).toBeUndefined();
    });
  });

  describe("dayOf()", () => {
    it("takes the UTC calendar day", () => {
      expect(dayOf("2026-08-20T23:59:59.000Z")).toBe("2026-08-20");
    });
  });

  describe("recordSurface()", () => {
    it("groups by kind and scope, and by variant when there is one", () => {
      expect(recordSurface({ k: "unit", s: "memory", n: "a" }, undefined).suite)
        .toBe("unit:memory");
      expect(
        recordSurface({ k: "unit", s: "memory", n: "a", v: "on" }, undefined)
          .suite,
      ).toBe("unit:memory:on");
    });

    it("takes the file as the invocation unit when one is known", () => {
      expect(
        recordSurface(
          { k: "unit", s: "memory", n: "a" },
          "packages/memory/test/space.test.ts",
        ).unit,
      ).toBe("packages/memory/test/space.test.ts");
    });

    it("keeps a file-backed unit when a later record has none", () => {
      const read = readReport(
        stored(CI_NAME, context(), [
          record({ file: "packages/memory/test/space.test.ts" }),
          record(),
        ]),
        NO_ALIASES,
      );
      expect([...read.surfaces.values()][0]!.unit).toEqual(
        "packages/memory/test/space.test.ts",
      );
    });

    it("falls back to the identity's own name", () => {
      expect(
        recordSurface({ k: "pattern", s: "patterns", n: "a.tsx" }, undefined)
          .unit,
      ).toBe("a.tsx");
    });
  });

  describe("executionsFor()", () => {
    it("runs a test that has never disagreed once", () => {
      expect(executionsFor(0)).toBe(1);
    });

    it("runs a test that has disagreed at all at least twice", () => {
      // One execution cannot tell a pass from a lucky pass.
      expect(executionsFor(Number.MIN_VALUE)).toBe(FLAKE_MIN_EXECUTIONS);
      expect(executionsFor(0.0001)).toBe(FLAKE_MIN_EXECUTIONS);
    });

    it("runs a test at the anchor rate the anchor count of times", () => {
      expect(executionsFor(FLAKE_ANCHOR_RATE)).toBe(FLAKE_ANCHOR_EXECUTIONS);
    });

    it("climbs between the two, and goes on climbing past the anchor", () => {
      const half = executionsFor(FLAKE_ANCHOR_RATE / 2);
      expect(half).toBeGreaterThan(FLAKE_MIN_EXECUTIONS);
      expect(half).toBeLessThan(FLAKE_ANCHOR_EXECUTIONS);
      expect(executionsFor(FLAKE_ANCHOR_RATE * 2)).toBeGreaterThan(
        FLAKE_ANCHOR_EXECUTIONS,
      );
    });

    it("stops climbing at the cap", () => {
      expect(executionsFor(1)).toBe(MAX_EXECUTIONS);
    });
  });

  describe("readReport()", () => {
    it("turns a stored object into observations", () => {
      const read = readReport(
        stored(CI_NAME, context(), [record(), record({ outcome: "fail" })]),
        NO_ALIASES,
      );
      expect(read.observations.length).toBe(2);
      expect(read.observations[0]!.place).toBe("main");
      expect(read.observations[0]!.day).toBe("2026-08-20");
    });

    it("keeps the durations of the executions that passed", () => {
      const read = readReport(
        stored(CI_NAME, context(), [
          record({ durationMs: 10 }),
          record({ durationMs: 90 }),
          record({ outcome: "skip", durationMs: 5000 }),
          record({ outcome: "fail", durationMs: 300_000 }),
        ]),
        NO_ALIASES,
      );
      expect(read.observations.map((seen) => seen.durationMs)).toEqual([
        10,
        90,
        undefined,
        undefined,
      ]);
      expect([...read.durations.keys()]).toEqual([]);
    });

    it("keeps no duration from a workstation, and its observations all the same", () => {
      // A lane's runner is the machine a cost predicts for; a workstation
      // is faster or slower by however it differs from one.
      const local = context({ env: "local", branch: "fix-writes" });
      delete local.ci;
      const read = readReport(
        stored(LOCAL_NAME, local, [record({ durationMs: 10 })]),
        NO_ALIASES,
      );
      expect(read.observations.map((seen) => seen.place)).toEqual(["local"]);
      expect(read.observations[0]!.durationMs).toBeUndefined();
    });

    it("keeps a failed execution as an observation all the same", () => {
      // Its duration is left out of the cost; the execution itself is
      // what the churn and flake terms are counted from.
      const read = readReport(
        stored(CI_NAME, context(), [record({
          outcome: "fail",
          durationMs: 300_000,
        })]),
        NO_ALIASES,
      );
      expect(read.observations.map((seen) => seen.outcome)).toEqual(["fail"]);
      expect(read.observations[0]!.durationMs).toBeUndefined();
    });

    it("reads nothing from a group whose start time is not a time", () => {
      // Every rule reads along the order these are sorted into, and a
      // start time that will not parse has no place in it.
      expect(
        readReport(
          stored(CI_NAME, context({ startedAt: "2026-08-20Tnonsense" }), [
            record(),
          ]),
          NO_ALIASES,
        ).observations,
      ).toEqual([]);
    });

    it("reads a fork run's records", () => {
      const forked = context({ branch: "fix-writes" });
      forked.ci!.event = "pull_request";
      forked.ci!.fork = true;
      expect(
        readReport(stored(CI_NAME, forked, [record()]), NO_ALIASES)
          .observations.map((seen) => seen.place),
      ).toEqual(["pr"]);
    });

    it("reads nothing from a lane measuring itself", () => {
      // The lane's own measurements travel as ordinary records, so they
      // arrive here beside the tests they were recorded with. A lane is
      // not a test: scoring one reads the batch it ran going red as the
      // lane disagreeing with itself, which is the shape of a flake and
      // is nothing of the kind.
      const read = readReport(
        stored(CI_NAME, context(), [
          record(),
          record({
            test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
            outcome: "fail",
          }),
          record({
            test: { k: "gate", s: "ci", n: "ci-lane setup deno" },
          }),
          // A lane's record of excusing the test beside it names that
          // test, and is not a run of it.
          record({
            test: { k: "gate", s: "ci", n: excusedMeasurementName(KEY) },
            durationMs: 0,
          }),
        ]),
        NO_ALIASES,
      );
      // The test beside them is read, so this is the measurements being
      // left out rather than the whole group.
      expect(read.observations.map((seen) => seen.test.n)).toEqual([
        "space > writes",
      ]);
      expect([...read.surfaces.keys()]).toEqual([KEY]);
      expect(read.observations[0]!.durationMs).toBe(40);
      expect([...read.durations.keys()]).toEqual([]);
    });

    it("asks the alias file nothing about a lane measuring itself", () => {
      // What a record is, is read from the identity the lane wrote, so a
      // line in the alias file settles neither half: it cannot score a
      // lane's overhead as the test it renames to, and it cannot take
      // that overhead away from the cost model either.
      const read = readReport(
        stored(CI_NAME, context(), [
          record({
            test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
            durationMs: 92_000,
          }),
          record({
            test: {
              k: "gate",
              s: "ci",
              n: "ci-lane ran batch workspace-unit",
            },
            durationMs: 40_000,
          }),
          record({
            test: {
              k: "gate",
              s: "ci",
              n: "ci-lane units batch workspace-unit",
            },
            durationMs: 17,
          }),
          record({
            test: {
              k: "gate",
              s: "ci",
              n: "ci-lane passes batch workspace-unit",
            },
            durationMs: 1,
          }),
        ]),
        new AliasResolver([{
          date: "2026-08-21",
          from: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
          to: { k: "unit", s: "memory", n: "space > writes" },
        }]),
      );
      expect(read.observations).toEqual([]);
      expect([...read.surfaces.keys()]).toEqual([]);
      expect([...read.durations.keys()]).toEqual([]);
      expect(read.lanes).toEqual([{
        day: "2026-08-20",
        suite: "workspace-unit",
        measured: false,
        ran: 40,
        spent: 92,
        units: 17,
        passes: 1,
      }]);
    });

    it("keeps a lane's measurements of itself for the cost model", () => {
      // Left out of everything scored, and not discarded either: what
      // the packer charges a lane beyond its tests is fitted from them.
      // One group is one lane's artifact, so a batch's three
      // measurements are here together.
      const read = readReport(
        stored(CI_NAME, context(), [
          record(),
          record({
            test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
            durationMs: 14_800,
          }),
          record({
            test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
            durationMs: 92_000,
          }),
          record({
            test: {
              k: "gate",
              s: "ci",
              n: "ci-lane ran batch workspace-unit",
            },
            durationMs: 40_000,
          }),
          record({
            test: {
              k: "gate",
              s: "ci",
              n: "ci-lane units batch workspace-unit",
            },
            durationMs: 17,
          }),
          record({
            test: {
              k: "gate",
              s: "ci",
              n: "ci-lane passes batch workspace-unit",
            },
            durationMs: 1,
          }),
        ]),
        NO_ALIASES,
      );
      expect(read.lanes).toEqual([
        { day: "2026-08-20", capability: "fuse", seconds: 14.8 },
        {
          day: "2026-08-20",
          suite: "workspace-unit",
          measured: false,
          ran: 40,
          spent: 92,
          units: 17,
          passes: 1,
        },
      ]);
    });

    it("keeps what a unit's hooks took in a passing batch, by the measurement's name", () => {
      // A batch that went red stopped part way, so what it says about a
      // unit's hooks is left out, as a failed test's duration is.
      const name = hooksMeasurementName("pattern-integration", true, UNIT);
      const read = readReport(
        stored(CI_NAME, context(), [
          record({ test: { k: "gate", s: "ci", n: name }, durationMs: 3500 }),
          record({ test: { k: "gate", s: "ci", n: name }, durationMs: 4000 }),
          record({
            test: { k: "gate", s: "ci", n: name },
            outcome: "fail",
            durationMs: 900,
          }),
        ]),
        NO_ALIASES,
      );
      expect(read.durations).toEqual(
        new Map([[name, new Map([["2026-08-20", [3500, 4000]]])]]),
      );
      expect(read.observations).toEqual([]);
      expect([...read.surfaces.keys()]).toEqual([]);
    });

    it("keeps nothing a workstation measured of a unit's hooks", () => {
      // A workstation is another machine, faster or slower by however it
      // differs, so what it measured is no evidence of what a lane spends.
      const local = context({ env: "local", branch: "fix-writes" });
      delete local.ci;
      const name = hooksMeasurementName("pattern-integration", true, UNIT);
      const read = readReport(
        stored(LOCAL_NAME, local, [
          record({ test: { k: "gate", s: "ci", n: name }, durationMs: 3500 }),
        ]),
        NO_ALIASES,
      );
      expect([...read.durations.keys()]).toEqual([]);
    });

    it("counts a lane measurement it had to decline", () => {
      // A lane whose run the fold cannot place records what it measured
      // like any other lane. Counting what was declined is what tells a
      // lane whose measurement cannot be used from a lane that has not
      // run. A run naming no branch is the case here, because what
      // decides a group's place is read from the run's own facts and
      // this one says nothing about where it ran.
      const read = readReport(
        stored(CI_NAME, placeless(), [
          record({
            test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
            durationMs: 14_800,
          }),
          record({
            test: { k: "gate", s: "ci", n: "ci-lane batch workspace-unit" },
            durationMs: 92_000,
          }),
          record(),
        ]),
        NO_ALIASES,
      );
      expect(read.lanes).toEqual([]);
      // The test beside them is not one, so this counts the lane's own
      // measurements rather than everything the group held.
      expect(read.declinedDays).toEqual(["2026-08-20", "2026-08-20"]);
    });

    it("counts nothing declined in a group it could read", () => {
      expect(
        readReport(stored(CI_NAME, context(), [record()]), NO_ALIASES)
          .declinedDays,
      ).toEqual([]);
    });

    it("keeps a fork run's measurements of itself", () => {
      const forked = context({ branch: "fix-writes" });
      forked.ci!.event = "pull_request";
      forked.ci!.fork = true;
      expect(
        readReport(
          stored(CI_NAME, forked, [
            record({
              test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
              durationMs: 14_800,
            }),
          ]),
          NO_ALIASES,
        ).lanes,
      ).toEqual([{ day: "2026-08-20", capability: "fuse", seconds: 14.8 }]);
    });
  });

  describe("the fold", () => {
    it("folds a stream in chunks the way it folds one batch", () => {
      const reports = [
        stored(CI_NAME, context({ commit: "c1" }), [record()]),
        stored(
          `${CI_NAME}2`,
          context({
            commit: "c2",
            startedAt: "2026-08-20T01:00:00.000Z",
          }),
          [record({ outcome: "fail" })],
        ),
        stored(
          `${CI_NAME}3`,
          context({
            commit: "c3",
            startedAt: "2026-08-20T02:00:00.000Z",
          }),
          [record()],
        ),
      ];
      const whole = foldReports(
        emptyAggregate("2026-08-20"),
        reports,
        NO_ALIASES,
        "2026-08-20",
      );
      const streamed = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      for (const report of reports) streamed.add([report]);
      expect(streamed.finish().states).toEqual(whole.states);
    });

    it("carries what units' hooks took into the next run, inside the cost window", () => {
      // A day's sample is counted by bucket, so what this run reads adds
      // to what the aggregate held of the same day, and a day past the
      // window stops deciding what the packer charges.
      const name = hooksMeasurementName("pattern-integration", true, UNIT);
      const carried = emptyAggregate("2026-08-20");
      carried.hooks = {
        [name]: {
          "2026-08-20": samplesOf([3000]),
          "2026-08-01": samplesOf([60_000]),
        },
      };
      const fold = new Fold(carried, NO_ALIASES, "2026-08-20");
      fold.add([
        stored(CI_NAME, context(), [
          record({ test: { k: "gate", s: "ci", n: name }, durationMs: 3500 }),
        ]),
      ]);
      expect(fold.finish().aggregate.hooks).toEqual({
        [name]: { "2026-08-20": samplesOf([3000, 3500]) },
      });
    });

    it("drops a unit whose every day has left the cost window", () => {
      const name = hooksMeasurementName("pattern-integration", true, UNIT);
      const carried = emptyAggregate("2026-08-20");
      carried.hooks = { [name]: { "2026-08-01": samplesOf([3000]) } };
      expect(
        new Fold(carried, NO_ALIASES, "2026-08-20").finish().aggregate.hooks,
      ).toEqual({});
    });

    it("gives every identity the aggregate scores a surface", () => {
      // The publisher keeps the identities it can place, and it places
      // from these. A fold that gathered them from its own reads alone
      // would hand it the identities that ran inside its window and
      // nothing else, so every identity that did not run inside it would
      // leave the manifest while its scores stayed in the aggregate.
      const carried = emptyAggregate("2026-08-20");
      carried.states[KEY] = emptyState();
      carried.files[KEY] = UNIT;
      const surfaces = new Fold(carried, NO_ALIASES, "2026-08-20")
        .finish().surfaces;
      expect(surfaces.get(KEY)).toEqual({
        suite: "unit:memory",
        unit: UNIT,
        fromFile: true,
      });
    });

    it("reads an identity with no recorded file as its own unit", () => {
      // A suite whose units are not files places an identity by its
      // recorded name, and an identity whose records never named a file
      // has nothing else to be placed by either.
      const carried = emptyAggregate("2026-08-20");
      carried.states[KEY] = emptyState();
      const surfaces = new Fold(carried, NO_ALIASES, "2026-08-20")
        .finish().surfaces;
      expect(surfaces.get(KEY)).toEqual({
        suite: "unit:memory",
        unit: "space > writes",
        fromFile: false,
      });
    });

    it("writes the file a record named into the aggregate", () => {
      const folded = foldReports(
        emptyAggregate("2026-08-20"),
        [stored(CI_NAME, context(), [record({ file: UNIT })])],
        NO_ALIASES,
        "2026-08-20",
      );
      expect(folded.aggregate.files).toEqual({ [KEY]: UNIT });
    });

    it("gives no surface to a state key that names no identity", () => {
      // The aggregate is stored input like every other object in the
      // store, so a key that cannot be read back into a test is passed
      // over rather than thrown on. The state stays where it is and
      // nothing downstream is built from it: the manifest is built from
      // the identities the surfaces place.
      const carried = emptyAggregate("2026-08-20");
      carried.states["not an identity key"] = emptyState();
      carried.states[KEY] = emptyState();
      const folded = new Fold(carried, NO_ALIASES, "2026-08-20").finish();
      expect(folded.states.has("not an identity key")).toBe(true);
      expect(folded.surfaces.has("not an identity key")).toBe(false);
      expect(folded.surfaces.has(KEY)).toBe(true);
    });

    it("drops a carried file for an identity it holds no state for", () => {
      // The files are seeded from the states and written back from the
      // surfaces those seeded, so the map cannot name an identity the
      // aggregate does not score. Without that it would only ever grow:
      // nothing else removes an entry from it.
      const carried = emptyAggregate("2026-08-20");
      carried.files[KEY] = UNIT;
      const folded = new Fold(carried, NO_ALIASES, "2026-08-20").finish();
      expect(folded.surfaces.has(KEY)).toBe(false);
      expect(folded.aggregate.files).toEqual({});
    });

    it("keeps a carried file a later record does not name", () => {
      // A record with no file says what an unmapped record can say, and
      // the file an earlier one named is the better answer.
      const carried = emptyAggregate("2026-08-20");
      carried.states[KEY] = emptyState();
      carried.files[KEY] = UNIT;
      const fold = new Fold(carried, NO_ALIASES, "2026-08-20");
      fold.add([stored(CI_NAME, context(), [record()])]);
      expect(fold.finish().aggregate.files).toEqual({ [KEY]: UNIT });
    });

    it("does not fold a day it took from a rollup", () => {
      // A rollup carries the day's reports whole, so its raw objects
      // never reach `folded`; a later run over a wide window has to ask
      // about the day or it folds the day twice and doubles its new real
      // test failures.
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      expect(fold.settled(CI_SOURCE, "2026/08/18")).toBe(false);
      fold.markSettled(CI_SOURCE, "2026/08/18");
      expect(fold.settled(CI_SOURCE, "2026/08/18")).toBe(true);
      expect(fold.finish().aggregate.compacted).toEqual(["ci\t2026/08/18"]);
    });

    it("leaves a local source of a settled day still owing", () => {
      // Rollups cover the continuous-integration area alone, so a receipt
      // naming the day by itself would say the day is accounted for and
      // that day's local submissions would never be read.
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      fold.markSettled(CI_SOURCE, "2026/08/10");
      expect(fold.settled("local/ianh", "2026/08/10")).toBe(false);
    });

    it("knows which source and date it holds raw objects from", () => {
      // A rollup written after them would overlap what they contributed,
      // and nothing in one of this format says by how much.
      const fold = new Fold(
        {
          ...emptyAggregate("2026-08-20"),
          folded: [CI_NAME, LOCAL_NAME],
        },
        NO_ALIASES,
        "2026-08-20",
      );
      expect(fold.hasRaw(CI_SOURCE, "2026/08/20")).toBe(true);
      expect(fold.hasRaw("local/ianh", "2026/08/20")).toBe(true);
      expect(fold.hasRaw(CI_SOURCE, "2026/08/19")).toBe(false);
      expect(fold.hasRaw("local/someone-else", "2026/08/20")).toBe(false);
    });

    it("carries the settled pairs across a saved aggregate", () => {
      const first = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      first.markSettled(CI_SOURCE, "2026/08/10");
      const saved = parseAggregate(
        JSON.stringify(first.finish().aggregate),
      );
      expect(saved).toBeDefined();
      const second = new Fold(saved!, NO_ALIASES, "2026-08-21");
      expect(second.settled(CI_SOURCE, "2026/08/10")).toBe(true);
    });

    it("reads an aggregate written before rollups as settling nothing", () => {
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      delete older.compacted;
      const parsed = parseAggregate(JSON.stringify(older));
      expect(parsed?.compacted).toEqual([]);
    });

    it("reads a receipt naming a day alone as the shared area's", () => {
      // That area is the only one a rollup has ever covered, so nothing
      // else could have written the receipt, and reading it forward is
      // exact rather than a guess.
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      delete older.compacted;
      older.compactedDays = ["2026/08/10"];
      expect(parseAggregate(JSON.stringify(older))?.compacted).toEqual([
        "ci\t2026/08/10",
      ]);
    });

    it("carries what the cross-run rules saw into the next run", () => {
      // A commit's runs can arrive in two publisher runs. Without the
      // context, the second would not see that the identity had already
      // passed at that commit, and would read the failure as a new real
      // test failure rather than as the test disagreeing with itself.
      const first = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      first.add([stored(CI_NAME, context({ commit: "c1" }), [record()])]);
      const saved = parseAggregate(JSON.stringify(first.finish().aggregate))!;
      expect(saved.context!.outcomesAtCommit.length).toBeGreaterThan(0);

      const second = new Fold(saved, NO_ALIASES, "2026-08-20");
      second.add([
        stored(
          `${CI_NAME}2`,
          context({ commit: "c1", startedAt: "2026-08-20T01:00:00.000Z" }),
          [record({ outcome: "fail" })],
        ),
      ]);
      const state = second.finish().states.get(KEY)!;
      expect(state.mainCatches).toBe(0);
      expect(state.flakesByDay["2026-08-20"]).toBe(1);
      // One run of two disagreed, which is what holds it out until it
      // has run enough to say the rate is lower than that.
      expect(flakeRate(state, "2026-08-20")).toBeGreaterThan(
        FLAKE_EXCLUSION_RATE,
      );
    });

    it("drops a lane measurement an earlier aggregate carried", () => {
      // Nothing adds one now, and nothing has ever removed one, so an
      // aggregate written while they were still folded would carry them
      // for good.
      const aggregate = emptyAggregate("2026-08-20");
      const measurement = testIdentityKey({
        k: "gate",
        s: "ci",
        n: "ci-lane batch workspace-unit",
      });
      aggregate.states[measurement] = emptyState();
      aggregate.states[KEY] = emptyState();
      aggregate.files[measurement] = "tasks/ci-lane.ts";

      const folded = new Fold(aggregate, NO_ALIASES, "2026-08-20").finish();
      const states = folded.states;
      expect(states.has(measurement)).toBe(false);
      // The file goes with the state, so the aggregate does not carry
      // one for an identity nothing scores.
      expect(folded.aggregate.files).toEqual({});
      // The test beside it survives, so this drains the measurements
      // rather than the aggregate.
      expect(states.has(KEY)).toBe(true);
    });

    it("counts an object once however often it is handed over", () => {
      // The counters add rather than replace, so a second fold of one
      // object would count every execution in it twice.
      const report = stored(CI_NAME, context(), [record()]);
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      fold.add([report]);
      fold.add([report]);
      const finished = fold.finish();
      expect(finished.observations).toBe(1);
      const state = finished.states.get(KEY)!;
      expect(state.runsByDay["2026-08-20"]).toBe(1);
      expect(state.costByDay["2026-08-20"]!.counts).toEqual([1]);
      expect(finished.aggregate.folded).toEqual([CI_NAME]);
    });

    it("counts a declined measurement once however often it arrives", () => {
      // The count of what was declined adds the way every other counter
      // does, so a second fold of one object would report a lane twice
      // over as having measured something the model was fitted without.
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      const report = stored(CI_NAME, placeless(), [
        record({
          test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
          durationMs: 14_800,
        }),
      ]);
      fold.add([report]);
      fold.add([report]);
      expect(fold.declined).toBe(1);
    });

    it("counts a declined measurement in a shard once", async () => {
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      const report = stored(CI_NAME, placeless(), [
        record({
          test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
          durationMs: 14_800,
        }),
      ]);
      await fold.addUnordered(replaying([report, report]));
      expect(fold.declined).toBe(1);
    });

    it("passes over a declined measurement past the cost window", () => {
      // A bootstrap reads far wider than the model is fitted across, so
      // a count taking every day it read would offer a measurement from
      // a day the model cannot reach as the reason it holds nothing.
      const older = placeless();
      older.startedAt = "2026-07-20T00:00:00.000Z";
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      fold.add([
        stored(CI_NAME, older, [
          record({
            test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
            durationMs: 14_800,
          }),
        ]),
      ]);
      expect(fold.declined).toBe(0);
    });

    it("counts no declined measurement from a group with no context", () => {
      // A group carrying no context at all says neither where it ran nor
      // when, so its measurements are declined and dated nowhere.
      const read = readReport({
        objectName: CI_NAME,
        context: undefined,
        records: [],
        reports: [{
          context: undefined,
          records: [
            record({
              test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
              durationMs: 14_800,
            }),
          ],
        }],
      }, NO_ALIASES);
      expect(read.lanes).toEqual([]);
      expect(read.declinedDays).toEqual([]);
    });

    it("counts no declined measurement it cannot put in a day", () => {
      // The group's own start time is the only thing that dates it, and
      // one that will not read as a time dates nothing.
      const undated = placeless();
      undated.startedAt = "the other day";
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      fold.add([
        stored(CI_NAME, undated, [
          record({
            test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
            durationMs: 14_800,
          }),
        ]),
      ]);
      expect(fold.declined).toBe(0);
    });

    it("counts an object once when one batch carries it twice", () => {
      // The rule lives in the fold rather than in each caller, because a
      // caller filtering by what the aggregate already holds cannot see
      // a copy the same batch folded a moment ago.
      const report = stored(CI_NAME, context(), [record()]);
      const folded = foldReports(
        emptyAggregate("2026-08-20"),
        [report, report],
        NO_ALIASES,
        "2026-08-20",
      );
      expect(folded.observations).toBe(1);
      expect(folded.states.get(KEY)!.runsByDay["2026-08-20"]).toBe(1);
      expect(folded.aggregate.folded).toEqual([CI_NAME]);
    });

    it("counts a shard once however often it is handed over", async () => {
      const report = stored(CI_NAME, context(), [record()]);
      const fold = new Fold(
        emptyAggregate("2026-08-20"),
        NO_ALIASES,
        "2026-08-20",
      );
      await fold.addUnordered(replaying([report, report]));
      const finished = fold.finish();
      expect(finished.observations).toBe(1);
      expect(finished.states.get(KEY)!.runsByDay["2026-08-20"]).toBe(1);
      expect(finished.aggregate.folded).toEqual([CI_NAME]);
    });

    it("counts nothing from an object a saved aggregate already held", () => {
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.folded.push(CI_NAME);
      const fold = new Fold(aggregate, NO_ALIASES, "2026-08-20");
      fold.add([stored(CI_NAME, context(), [record()])]);
      const finished = fold.finish();
      expect(finished.observations).toBe(0);
      expect(finished.aggregate.folded).toEqual([CI_NAME]);
    });

    it("does not fold an object it has already folded", () => {
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.folded.push(CI_NAME);
      const fold = new Fold(aggregate, NO_ALIASES, "2026-08-20");
      expect(fold.knows(CI_NAME)).toBe(true);
      expect(fold.knows(`${CI_NAME}2`)).toBe(false);
    });
  });

  describe("firstDay()", () => {
    it("is the earliest day folded from an object or from a rollup", () => {
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.folded.push(
        "labs/test-records/submissions/ci/v1/2026/08/19/run-2-a.ndjson",
        "labs/test-records/submissions/local/someone/v1/2026/08/18/x.ndjson",
      );
      aggregate.compacted.push(`${CI_SOURCE}\t2026/08/17`);
      expect(firstDay(aggregate)).toBe("2026-08-17");
      aggregate.compacted.length = 0;
      expect(firstDay(aggregate)).toBe("2026-08-18");
    });

    it("is absent for an aggregate that has folded nothing", () => {
      expect(firstDay(emptyAggregate("2026-08-20"))).toBeUndefined();
    });

    it("survives a fold that closes it", () => {
      // Every publisher reads the day a whole history starts on from the
      // names, so closing a day keeps the first day's and drops the rest.
      const aggregate = {
        ...emptyAggregate("2026-08-19"),
        folded: [
          "labs/test-records/submissions/ci/v1/2026/08/05/run-1-a.ndjson",
          "labs/test-records/submissions/ci/v1/2026/08/06/run-2-a.ndjson",
        ],
        compacted: [`${CI_SOURCE}\t2026/08/05`, `${CI_SOURCE}\t2026/08/07`],
      };
      const after = new Fold(aggregate, NO_ALIASES, "2026-08-20").finish({
        from: "2026/08/19",
        through: "2026/08/20",
      }).aggregate;
      expect(after.closed).toBe("2026/08/13");
      expect(after.folded).toEqual([
        "labs/test-records/submissions/ci/v1/2026/08/05/run-1-a.ndjson",
      ]);
      expect(after.compacted).toEqual([`${CI_SOURCE}\t2026/08/05`]);
      expect(firstDay(after)).toBe("2026-08-05");
    });
  });

  describe("the rules an aggregate's new real test failures were credited under", () => {
    it("are the ones in force for a fresh aggregate", () => {
      expect(emptyAggregate("2026-08-20").catchRule).toBe(
        NEW_REAL_TEST_FAILURE_RULE,
      );
    });

    it("are carried through a fold and a stored copy", () => {
      const stamped = new Fold(
        emptyAggregate("2026-08-19"),
        NO_ALIASES,
        "2026-08-20",
      ).finish().aggregate;
      expect(parseAggregate(JSON.stringify(stamped))?.catchRule).toBe(
        NEW_REAL_TEST_FAILURE_RULE,
      );
    });

    it("are none for an aggregate written before the stamps began", () => {
      // A fold onto it adds new real test failures under the rules in
      // force to ones credited under others, which is still not a
      // stamp's worth.
      const older = { ...emptyAggregate("2026-08-19") } as Record<
        string,
        unknown
      >;
      delete older.catchRule;
      const parsed = parseAggregate(JSON.stringify(older))!;
      expect(parsed.catchRule).toBeUndefined();
      expect(
        new Fold(parsed, NO_ALIASES, "2026-08-20").finish().aggregate
          .catchRule,
      ).toBeUndefined();
    });
  });

  describe("parseAggregate()", () => {
    it("round-trips an aggregate", () => {
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.folded.push(CI_NAME);
      expect(parseAggregate(JSON.stringify(aggregate))).toEqual(aggregate);
    });

    it("carries the file each identity's records named", () => {
      // Which identities a manifest holds is decided from these, so a
      // run that lost them would publish only what ran inside its own
      // window.
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.files[KEY] = UNIT;
      expect(parseAggregate(JSON.stringify(aggregate))?.files)
        .toEqual({ [KEY]: UNIT });
    });

    it("reads an aggregate written before the files as holding none", () => {
      // Every identity in it is then read as its own invocation unit
      // until one of its records names a file again.
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      delete older.files;
      expect(parseAggregate(JSON.stringify(older))?.files).toEqual({});
    });

    it("gives back the cost a day carrying a percentile was giving", () => {
      // The shape a state written before the samples were kept carries.
      const aggregate = emptyAggregate("2026-08-20");
      const held = emptyState();
      (held.costByDay as Record<string, unknown>)["2026-08-20"] = {
        p90: 4096,
        count: 45,
      };
      aggregate.states[KEY] = held;
      const parsed = parseAggregate(JSON.stringify(aggregate))!;
      expect(costSeconds(parsed.states[KEY]!, "2026-08-20")).toBe(4.096);
    });

    it("keeps a day these rules stored as its slowest runs", () => {
      // Stored before days were counted by bucket, and sealed by the
      // rules in force, so a fold sealing a later day counts it too.
      const aggregate = emptyAggregate("2026-08-20");
      const held = emptyState();
      (held.costByDay as Record<string, unknown>)["2026-08-19"] = {
        slowest: [8192, 8192],
        count: 2,
        rule: COST_RULE,
      };
      aggregate.states[KEY] = held;
      const fold = new Fold(
        parseAggregate(JSON.stringify(aggregate))!,
        NO_ALIASES,
        "2026-08-20",
      );
      fold.add([stored(CI_NAME, context(), [record({ durationMs: 1024 })])]);
      const state = fold.finish().states.get(KEY)!;
      expect(Object.keys(state.costByDay).sort())
        .toEqual(["2026-08-19", "2026-08-20"]);
      expect(costSeconds(state, "2026-08-20")).toBe(8.192);
    });

    /** Four new real test failures on the default branch, on one day. */
    const FOUR_ON_MAIN = { local: 0, pr: 0, main: 4, sources: ["main"] };

    it("drops an identity whose state is not one, and reads the rest", () => {
      // The aggregate holds the new real test failures, which no window
      // of records rebuilds, so one identity nothing can be read out of
      // must not cost every other identity its history. The one dropped
      // is then read as a test with no history, which is mandatory, so it
      // runs.
      for (const held of ["oops", 7, null, []]) {
        const aggregate = JSON.parse(
          JSON.stringify(emptyAggregate("2026-08-20")),
        );
        const kept = emptyState();
        kept.newRealTestFailureDays["2026-08-19"] = FOUR_ON_MAIN;
        aggregate.states["broken"] = held;
        aggregate.states[KEY] = kept;
        const read = parseAggregate(JSON.stringify(aggregate));
        expect(read?.states[KEY]?.mainCatches).toBe(4);
        expect(Object.hasOwn(read!.states, "broken")).toBe(false);
      }
    });

    it("reads an aggregate written in an earlier shape forward", () => {
      // An aggregate holds every new real test failure a test has ever
      // been credited with, over unbounded history, and a window of
      // records cannot give them back. Refusing one written before the
      // newest shape would cost all of them and leave nothing to publish
      // from until an operator ran a bootstrap by hand.
      const aggregate = emptyAggregate("2026-08-20");
      const held = emptyState();
      held.newRealTestFailureDays["2026-08-19"] = FOUR_ON_MAIN;
      aggregate.states[KEY] = held;
      const older = {
        ...JSON.parse(JSON.stringify(aggregate)),
        schema: MANIFEST_SCHEMA_VERSION - 1,
      };
      expect(parseAggregate(JSON.stringify(older))?.states[KEY]?.mainCatches)
        .toBe(4);
    });

    it("refuses an aggregate that does not say which shape it is", () => {
      for (const schema of [undefined, "1", 1.5, 0, -1, null]) {
        const object = JSON.parse(
          JSON.stringify(emptyAggregate("2026-08-20")),
        );
        if (schema === undefined) delete object.schema;
        else object.schema = schema;
        expect(parseAggregate(JSON.stringify(object))).toBeUndefined();
      }
    });

    it("refuses an aggregate written in a shape from further ahead", () => {
      // A reader that does not know a field cannot know what folding on
      // top of the rest would mean, and what it would write back is an
      // aggregate carrying half of each.
      const ahead = {
        ...JSON.parse(JSON.stringify(emptyAggregate("2026-08-20"))),
        schema: MANIFEST_SCHEMA_VERSION + 1,
      };
      expect(parseAggregate(JSON.stringify(ahead))).toBeUndefined();
    });

    it("reads a body already parsed as it reads the text of one", () => {
      // A reader asking this and `writtenAhead` about one body parses it
      // once, and an aggregate is the whole corpus.
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.states[KEY] = {
        ...emptyState(),
        mainCatches: 4,
        lastCatch: "2026-08-19",
        newRealTestFailureDays: {
          "2026-08-19": { local: 0, pr: 0, main: 4, sources: [] },
        },
      };
      const text = JSON.stringify(aggregate);
      expect(parseAggregate(JSON.parse(text))).toEqual(aggregate);
      expect(parseAggregate(text)).toEqual(aggregate);
    });

    /** The one state an aggregate holding it, as stored, is read back as. */
    function storedState(state: Record<string, unknown>) {
      const aggregate = parseAggregate(JSON.stringify({
        ...emptyAggregate("2026-08-20"),
        states: { [KEY]: { ...emptyState(), ...state } },
      }));
      return aggregate!.states[KEY]!;
    }

    it("counts new real test failures from their days alone", () => {
      // A state stored without days was credited under other rules, and a
      // fold of the whole history counts it again.
      const { newRealTestFailureDays: _, ...withoutDays } = emptyState();
      const state = storedState({
        ...withoutDays,
        prCatches: 3,
        lastCatch: "2026-08-12",
        sources: ["main"],
      });
      expect(state.newRealTestFailureDays).toEqual({});
      expect(state.prCatches).toBe(0);
      expect(state.lastCatch).toBeUndefined();
      expect(state.sources).toEqual([]);
    });

    it("drops a day that is not a count of new real test failures, and totals the rest", () => {
      const state = storedState({
        prCatches: 1,
        lastCatch: "2026-08-10",
        newRealTestFailureDays: {
          "2026-08-10": { local: 0, pr: 1, main: 0, sources: ["a"] },
          "2026-08-11": { local: -1, pr: "two", main: 0, sources: [] },
        },
      });
      expect(Object.keys(state.newRealTestFailureDays)).toEqual(["2026-08-10"]);
      expect(state.prCatches).toBe(1);
    });

    it("drops new real test failures held against something that is not a day", () => {
      // Taken as the day of the most recent one, it would leave freshness
      // nothing to age from.
      const state = storedState({
        newRealTestFailureDays: {
          "2026-08-10": { local: 0, pr: 1, main: 0, sources: ["a"] },
          "someday": { local: 0, pr: 1, main: 0, sources: ["b"] },
          "2026-02-31": { local: 0, pr: 1, main: 0, sources: ["c"] },
        },
      });
      expect(Object.keys(state.newRealTestFailureDays)).toEqual(["2026-08-10"]);
      expect(state.lastCatch).toBe("2026-08-10");
      expect(state.prCatches).toBe(1);
    });

    it("refuses a closed day that is not a day", () => {
      // Read as later than it is, it would close days nothing has read.
      const stored = { ...emptyAggregate("2026-08-20"), closed: "yesterday" };
      expect(parseAggregate(JSON.stringify(stored))).toBeUndefined();
      // Shaped like a day and not one the calendar has.
      expect(
        parseAggregate(JSON.stringify({ ...stored, closed: "2026/99/99" })),
      ).toBeUndefined();
      expect(
        parseAggregate(JSON.stringify({ ...stored, closed: "2026/08/10" }))
          ?.closed,
      ).toBe("2026/08/10");
    });

    it("refuses a value that is not a body at all", () => {
      // What a caller that could not parse the text hands this, beside
      // the aggregate above, which it reads.
      expect(parseAggregate(undefined)).toBeUndefined();
      expect(parseAggregate(emptyAggregate("2026-08-20"))).toBeDefined();
    });

    it("reads a day a stored state holds under the stamp it carries", () => {
      // The days in a stored state were sealed by whatever rules were in
      // force then, and a state written before the stamps carries none,
      // so what a reader gets back has to say which.
      const aggregate = emptyAggregate("2026-08-20");
      const held = emptyState();
      held.costByDay["2026-08-20"] = samplesOf([300_000, 300_000]);
      aggregate.states[KEY] = held;
      const parsed = parseAggregate(JSON.stringify(aggregate))!;
      expect(parsed.states[KEY]!.costByDay["2026-08-20"]!.rule)
        .toBeUndefined();
      const sealed = emptyAggregate("2026-08-20");
      const measured = emptyState();
      sealDay(measured, "2026-08-20", samplesOf([300_000, 300_000]));
      sealed.states[KEY] = measured;
      expect(
        parseAggregate(JSON.stringify(sealed))!
          .states[KEY]!.costByDay["2026-08-20"]!.rule,
      ).toBe(COST_RULE);
    });

    it("carries what lanes measured into the next run", () => {
      // The fit reads a week of them, and a publisher run folds a few
      // hours of objects, so they survive the aggregate rather than
      // being read again each time.
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.lanes = [
        { day: "2026-08-20", capability: "fuse", seconds: 14.8 },
        {
          day: "2026-08-20",
          suite: "runner-unit",
          measured: true,
          ran: 10,
          spent: 30,
          units: 4,
          passes: 1,
        },
        {
          day: "2026-08-20",
          suite: "runner-unit",
          measured: false,
          ran: 10,
          spent: 20,
          units: 4,
          passes: 2,
        },
      ];
      expect(parseAggregate(JSON.stringify(aggregate))?.lanes)
        .toEqual(aggregate.lanes);
    });

    it("carries what units' hooks took, dropping a day it cannot count with", () => {
      const name = hooksMeasurementName("pattern-integration", false, UNIT);
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.hooks = { [name]: { "2026-08-20": samplesOf([3000, 3500]) } };
      expect(parseAggregate(JSON.stringify(aggregate))?.hooks)
        .toEqual(aggregate.hooks);
      const object = JSON.parse(JSON.stringify(aggregate));
      object.hooks[name]["2026-08-19"] = { lowest: -1, counts: [1] };
      object.hooks.other = "not a unit's days";
      expect(parseAggregate(JSON.stringify(object))?.hooks)
        .toEqual(aggregate.hooks);
    });

    it("drops a stored batch that does not say how many passes it made", () => {
      // The fit charges a suite per pass, so a batch that does not say how
      // many it made is one the fit cannot read.
      const aggregate = emptyAggregate("2026-08-20");
      const stored = {
        day: "2026-08-20",
        suite: "runner-unit",
        measured: false,
        ran: 10,
        spent: 20,
        units: 4,
      };
      const object = JSON.parse(JSON.stringify(aggregate));
      object.lanes = [stored, { ...stored, passes: 1 }];
      expect(parseAggregate(JSON.stringify(object))?.lanes)
        .toEqual([{ ...stored, passes: 1 }]);
    });

    it("carries a figure a later reader stored in a batch", () => {
      // What a later reader stored beside the figures this one knows is
      // left as it was, so that reader finds it again.
      const later = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      const lanes = [{
        day: "2026-08-20",
        suite: "runner-unit",
        measured: false,
        ran: 10,
        spent: 30,
        units: 4,
        passes: 1,
        invocations: 3,
      }];
      later.lanes = lanes;
      const parsed = parseAggregate(JSON.stringify(later));
      expect(parsed?.lanes).toEqual(lanes);
      expect(
        new Fold(parsed!, NO_ALIASES, "2026-08-20").finish().aggregate.lanes,
      ).toEqual(lanes);
    });

    it("drops a stored lane measurement it cannot read", () => {
      // Each one stands alone, so one that will not read is dropped by
      // itself rather than taking a week of measurements with it. The
      // fit reads all three of a batch's figures as numbers, so one
      // short of them says nothing it can use, and a stored `Infinity`
      // or `NaN` arrives here as `null`.
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      older.lanes = [
        { day: "2026-08-20", capability: "fuse", seconds: "a while" },
        { day: "2026-08-20", suite: "runner-unit", ran: 10, units: 4 },
        {
          day: "2026-08-20",
          suite: "runner-unit",
          ran: NaN,
          spent: 30,
          units: 4,
        },
        { day: "2026-08-20", suite: "runner-unit", ran: 10, spent: 30 },
        { day: 7, capability: "fuse", seconds: 1 },
        "fuse took a while",
        null,
        { day: "2026-08-20", capability: "fuse", seconds: 2.1 },
      ];
      expect(parseAggregate(JSON.stringify(older))?.lanes).toEqual([
        { day: "2026-08-20", capability: "fuse", seconds: 2.1 },
      ]);
    });

    it("reads an aggregate written before lanes measured themselves", () => {
      expect(
        parseAggregate(JSON.stringify(emptyAggregate("2026-08-20")))?.lanes,
      )
        .toBeUndefined();
    });

    it("refuses an aggregate whose files it cannot read", () => {
      // These decide which identities the manifest holds, so reading a
      // shape this does not understand as an empty map would drop every
      // identity that did not run inside the window.
      const older = { ...emptyAggregate("2026-08-20") } as Record<
        string,
        unknown
      >;
      older.files = { [KEY]: 7 };
      expect(parseAggregate(JSON.stringify(older))).toBeUndefined();
      older.files = [UNIT];
      expect(parseAggregate(JSON.stringify(older))).toBeUndefined();
      older.files = null;
      expect(parseAggregate(JSON.stringify(older))).toBeUndefined();
    });

    it("returns undefined for anything that is not one", () => {
      expect(parseAggregate("{not json")).toBeUndefined();
      expect(parseAggregate('{"schema":99}')).toBeUndefined();
      expect(
        parseAggregate(
          JSON.stringify({ schema: MANIFEST_SCHEMA_VERSION, day: "x" }),
        ),
      ).toBeUndefined();
    });

    it("refuses a shape it would otherwise have to guess at", () => {
      const whole = {
        schema: MANIFEST_SCHEMA_VERSION,
        day: "2026-08-20",
        folded: [],
        states: {},
        compacted: [],
      };
      const refused: Array<[string, unknown]> = [
        ["a document that is not an object", 7],
        ["a null document", null],
        ["no folded list", { ...whole, folded: undefined }],
        ["a folded list that is not one", { ...whole, folded: "one.ndjson" }],
        ["a folded name that is not one", { ...whole, folded: [7] }],
        ["states that are not a record", { ...whole, states: [] }],
        ["null states", { ...whole, states: null }],
        [
          "a compacted list that is not one",
          { ...whole, compacted: "2026-08-20" },
        ],
        ["a settled pair that is not one", { ...whole, compacted: [7] }],
      ];
      for (const [what, value] of refused) {
        expect(parseAggregate(JSON.stringify(value)), what).toBeUndefined();
      }
    });

    it("reads an aggregate written before rollups were read", () => {
      // No compacted list at all is the truthful reading that nothing
      // was compacted, which is different from a list it cannot read.
      const before = {
        schema: MANIFEST_SCHEMA_VERSION,
        day: "2026-08-20",
        folded: [],
        states: {},
      };
      expect(parseAggregate(JSON.stringify(before))?.compacted).toEqual([]);
    });
  });

  describe("departed()", () => {
    /** A suite claiming nothing, holding the skips a case gives it. */
    function empty(
      unavailable: Suite["unavailable"] = [],
      units: string[] = [],
    ): Suite {
      return {
        id: "workspace-unit",
        recordSurfaces: [{ kind: "unit", scope: "memory" }],
        needs: ["deno"],
        units,
        unavailable,
        whole: [],
        locate: () => undefined,
        command: () => Promise.resolve([]),
      };
    }

    /** A state whose last run was on a day inside the counters' window. */
    function ranOn(day: string): IdentityState {
      return { ...emptyState(), runsByDay: { [day]: 4 } };
    }

    const onFile = new Map([[KEY, {
      suite: "unit:memory",
      unit: UNIT,
      fromFile: true,
    }]]);

    it("drops an identity the topology lost that nothing records", () => {
      // A deleted test keeps its records in the store, so the fold keeps
      // reading it back. Nothing can run it, and carrying it costs a
      // state rescored and rewritten on every publisher run.
      expect(departed(
        [empty()],
        { suiteLevel: [], unclaimed: [KEY], contested: [] },
        { states: new Map([[KEY, emptyState()]]), surfaces: onFile },
      )).toEqual([KEY]);
    });

    it("keeps an identity the topology lost that is still recording", () => {
      // A surface whose records never say which file they came from has
      // no unit either, and it is a wiring defect rather than a test that
      // left. The runs are what tell the two apart.
      expect(departed(
        [empty()],
        { suiteLevel: [], unclaimed: [KEY], contested: [] },
        {
          states: new Map([[KEY, ranOn("2026-08-19")]]),
          surfaces: onFile,
        },
      )).toEqual([]);
    });

    it("keeps an identity a configuration declares unavailable", () => {
      // The declaration is the tree saying the test is there and does not
      // run in this configuration, so it has stopped recording on
      // purpose and its history is waiting for the skip to be lifted.
      expect(departed(
        [empty([{ unit: UNIT, reason: "the surface has not landed" }])],
        { suiteLevel: [], unclaimed: [KEY], contested: [] },
        { states: new Map([[KEY, emptyState()]]), surfaces: onFile },
      )).toEqual([]);
    });

    it("reads a skip registry against the variant that declared it", () => {
      // The registry belongs to one configuration and names a file every
      // configuration of the suite holds. Read across all of them, a file
      // skipped under one variant would pin the default history of the
      // same file for good.
      const variant: Suite = {
        ...empty([{ unit: UNIT, reason: "the surface has not landed" }]),
        variant: "server-execution",
      };
      expect(departed(
        [variant],
        { suiteLevel: [], unclaimed: [KEY], contested: [] },
        { states: new Map([[KEY, emptyState()]]), surfaces: onFile },
      )).toEqual([KEY]);
    });

    it("passes over a leaf a configuration declares unavailable", () => {
      // A leaf entry leaves its unit enumerated and running, which is
      // what the suite here holds, so in the tree the unit is placed by
      // its file and nothing in it reaches this. Reading such an entry
      // as a whole unit would exempt every other test in the file.
      expect(departed(
        [empty([{
          unit: UNIT,
          leafName: "space > writes",
          reason: "the surface has not landed",
        }], [UNIT])],
        { suiteLevel: [], unclaimed: [KEY], contested: [] },
        { states: new Map([[KEY, emptyState()]]), surfaces: onFile },
      )).toEqual([KEY]);
    });

    it("drops an identity whose history is older than the window", () => {
      // The counters are aged before this reads them, so a state with new
      // real test failures and no days is a test that stopped running
      // long enough ago for every window to have passed over it.
      const old = { ...emptyState(), mainCatches: 4, lastCatch: "2026-01-02" };
      expect(departed(
        [empty()],
        { suiteLevel: [], unclaimed: [KEY], contested: [] },
        { states: new Map([[KEY, old]]), surfaces: onFile },
      )).toEqual([KEY]);
    });

    it("keeps an identity more than one suite claims", () => {
      // Two suites claiming it is a topology defect over a test the tree
      // holds twice, and the drift guard is what fails on it. Dropping
      // its history would answer a defect by discarding the evidence.
      expect(departed(
        [empty()],
        { suiteLevel: [], unclaimed: [], contested: [KEY] },
        { states: new Map([[KEY, emptyState()]]), surfaces: onFile },
      )).toEqual([]);
    });

    it("keeps an identity the topology placed", () => {
      expect(departed(
        [empty()],
        { suiteLevel: [], unclaimed: [], contested: [] },
        { states: new Map([[KEY, emptyState()]]), surfaces: onFile },
      )).toEqual([]);
    });

    it("keeps an identity that measures a whole invocation", () => {
      // Those are left out of the manifest because no lane can be asked
      // to run one, not because the tree has lost them, and the lane
      // cost fit reads what they measured.
      expect(departed(
        [empty()],
        { suiteLevel: [KEY], unclaimed: [], contested: [] },
        { states: new Map([[KEY, emptyState()]]), surfaces: onFile },
      )).toEqual([]);
    });
  });

  describe("locateSurfaces()", () => {
    /** A suite claiming what a case tells it to. */
    function claiming(id: string, locate: Suite["locate"]): Suite {
      return {
        id,
        recordSurfaces: [{ kind: "unit", scope: "memory" }],
        needs: ["deno"],
        units: [],
        unavailable: [],
        whole: [],
        locate,
        command: () => Promise.resolve([]),
      };
    }

    it("names the suite and unit the topology says, not the record's own", () => {
      const { placed } = locateSurfaces(
        [claiming("workspace-unit", () => ({
          level: "unit",
          unit: "packages/memory/test/space.test.ts",
        }))],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "packages/memory/test/space.test.ts",
          fromFile: true,
        }]]),
      );
      expect(placed.get(KEY)).toEqual({
        suite: "workspace-unit",
        unit: "packages/memory/test/space.test.ts",
        fromFile: true,
      });
    });

    it("passes on an identity that measures the suite rather than a unit", () => {
      // An overlapping whole-invocation record names no unit, so nothing
      // can be asked to run one of them.
      const { placed, unplaced } = locateSurfaces(
        [claiming("cli-core", () => ({ level: "suite" }))],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced.suiteLevel).toEqual([KEY]);
    });

    it("passes on an identity no suite claims", () => {
      const { placed, unplaced } = locateSurfaces(
        [claiming("workspace-unit", () => undefined)],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced.unclaimed).toEqual([KEY]);
    });

    it("leaves out the lane measuring itself", () => {
      // A lane measures its own setup and its own batches through the
      // record machinery every test uses. Those are not test surfaces, so
      // they are neither placed nor counted as unplaced, and the suite
      // here claims everything to show which of the two decides.
      const key = testIdentityKey({
        k: "gate",
        s: "ci",
        n: "ci-lane batch workspace-unit",
      });
      const { placed, unplaced } = locateSurfaces(
        [claiming("workspace-unit", () => ({ level: "unit", unit: "one" }))],
        new Map([[key, {
          suite: "gate:ci",
          unit: "ci-lane batch workspace-unit",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced)
        .toEqual({ suiteLevel: [], unclaimed: [], contested: [] });
    });

    it("passes over a key that names no identity", () => {
      // The surfaces come from a stored aggregate, which is untrusted
      // input like every other object in the store, so a key nothing can
      // read is skipped rather than thrown on.
      const { placed, unplaced } = locateSurfaces(
        [claiming("workspace-unit", () => ({ level: "unit", unit: "one" }))],
        new Map([["not an identity key", {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      expect(unplaced)
        .toEqual({ suiteLevel: [], unclaimed: [], contested: [] });
    });

    it("passes on an identity two suites claim", () => {
      // Two claims on one identity is a topology defect that the drift
      // guard fails on, and placing it either way would put the work in
      // whichever suite happened to come first.
      const unit = { level: "unit" as const, unit: "one" };
      const { placed, unplaced } = locateSurfaces(
        [claiming("a", () => unit), claiming("b", () => unit)],
        new Map([[KEY, {
          suite: "unit:memory",
          unit: "space > writes",
          fromFile: false,
        }]]),
      );
      expect(placed.size).toBe(0);
      // Apart from an identity no suite claims: the tree holds this test
      // twice over rather than not at all, and what is done about a test
      // the tree has lost must not be done about one it holds.
      expect(unplaced.unclaimed).toEqual([]);
      expect(unplaced.contested).toEqual([KEY]);
    });
  });

  describe("what records from off the default branch may change", () => {
    /** Where a branch that reorganizes the tree puts the same test. */
    const MOVED = "runtime/memory/test/space.test.ts";

    /** A test only a branch holds. */
    const ADDED = { k: "unit", s: "memory", n: "space > forgets" };

    /** A workstation's run of a branch, the hour after `context()`. */
    function workstation(): RunContext {
      const local = context({
        env: "local",
        branch: "reorganize",
        commit: "c9",
        startedAt: "2026-08-20T01:00:00.000Z",
      });
      delete local.ci;
      return local;
    }

    /** A pull request's run of a branch, the hour after `context()`. */
    function pullRequest(): RunContext {
      return context({
        branch: "reorganize",
        commit: "c9",
        startedAt: "2026-08-20T01:00:00.000Z",
      });
    }

    /** The aggregate holding the identity, under `UNIT`. */
    function carrying() {
      const aggregate = emptyAggregate("2026-08-20");
      aggregate.states[KEY] = emptyState();
      aggregate.files[KEY] = UNIT;
      return aggregate;
    }

    const fold = (aggregate = carrying()) =>
      new Fold(aggregate, NO_ALIASES, "2026-08-20");

    for (
      const { name, objectName, runContext } of [
        {
          name: "a workstation",
          objectName: LOCAL_NAME,
          runContext: workstation,
        },
        {
          name: "a pull request",
          objectName: `${CI_NAME}2`,
          runContext: pullRequest,
        },
      ]
    ) {
      it(`keeps the file main named when ${name} names another`, () => {
        const folding = fold();
        folding.add([
          stored(objectName, runContext(), [record({ file: MOVED })]),
        ]);
        const folded = folding.finish();
        expect(folded.aggregate.files[KEY]).toBe(UNIT);
        expect(folded.surfaces.get(KEY)?.unit).toBe(UNIT);
        // The record is still evidence about the test.
        expect(folded.states.get(KEY)?.runsByDay["2026-08-20"]).toBe(1);
      });

      it(`adds no identity that only ${name} recorded`, () => {
        const folding = fold();
        folding.add([
          stored(objectName, runContext(), [
            record({ test: ADDED, file: UNIT }),
          ]),
        ]);
        const folded = folding.finish();
        const added = testIdentityKey(ADDED);
        expect(folded.states.has(added)).toBe(false);
        expect(folded.surfaces.has(added)).toBe(false);
        expect(folded.aggregate.files[added]).toBeUndefined();
      });
    }

    it("takes the file main names once a move lands", () => {
      const folding = fold();
      folding.add([stored(CI_NAME, context(), [record({ file: MOVED })])]);
      const folded = folding.finish();
      expect(folded.aggregate.files[KEY]).toBe(MOVED);
      expect(folded.surfaces.get(KEY)?.unit).toBe(MOVED);
    });

    /**
     * A pull request's run of the added test, main's first record of it,
     * and a pull request's run after that, an hour apart and in time
     * order, each in an object of its own.
     */
    function landing() {
      const at = (hour: number) => `2026-08-20T0${hour}:00:00.000Z`;
      return [
        stored(
          `${CI_NAME}1`,
          context({ branch: "feature", startedAt: at(0) }),
          [record({ test: ADDED, durationMs: 90_000 })],
        ),
        stored(`${CI_NAME}2`, context({ startedAt: at(1) }), [
          record({ test: ADDED, file: UNIT, durationMs: 40 }),
        ]),
        stored(
          `${CI_NAME}3`,
          context({ branch: "feature", startedAt: at(2) }),
          [record({ test: ADDED, outcome: "fail" })],
        ),
      ];
    }

    it("folds what else said about an added test once main recorded it", () => {
      const folding = fold(emptyAggregate("2026-08-20"));
      folding.add(landing());
      const state = folding.finish().states.get(testIdentityKey(ADDED));
      // The first pull request's run came before main's record, and is
      // not counted; the second came after it, and is.
      expect(state?.runsByDay).toEqual({ "2026-08-20": 2 });
      expect(state?.failuresByDay).toEqual({ "2026-08-20": 1 });
    });

    it("decides the same way however the records are batched", async () => {
      const whole = fold(emptyAggregate("2026-08-20"));
      whole.add(landing());
      const expected = whole.finish().states.get(testIdentityKey(ADDED));

      const apart = fold(emptyAggregate("2026-08-20"));
      for (const object of landing()) apart.add([object]);
      expect(apart.finish().states.get(testIdentityKey(ADDED)))
        .toEqual(expected);

      const aside = fold(emptyAggregate("2026-08-20"));
      await aside.addUnordered(replaying(landing().reverse()));
      expect(aside.finish().states.get(testIdentityKey(ADDED)))
        .toEqual(expected);
    });

    it("costs an added test only by runs it counts", () => {
      // The pull request's ninety seconds came before main recorded the
      // test, earlier the same day, so they are not its cost.
      const folding = fold(emptyAggregate("2026-08-20"));
      folding.add([
        stored(`${CI_NAME}1`, context({ branch: "feature" }), [
          record({ test: ADDED, durationMs: 90_000 }),
        ]),
        stored(
          `${CI_NAME}2`,
          context({ startedAt: "2026-08-20T01:00:00.000Z" }),
          [record({ test: ADDED, file: UNIT, durationMs: 40 })],
        ),
      ]);
      const state = folding.finish().states.get(testIdentityKey(ADDED))!;
      expect(costSeconds(state, "2026-08-20")).toBeLessThan(1);
    });

    it("costs an added test by a pull request's runs after main recorded it", async () => {
      const objects = () => [
        stored(`${CI_NAME}1`, context(), [
          record({ test: ADDED, file: UNIT, durationMs: 40 }),
        ]),
        stored(
          `${CI_NAME}2`,
          context({
            branch: "feature",
            startedAt: "2026-08-20T01:00:00.000Z",
          }),
          [record({ test: ADDED, durationMs: 90_000 })],
        ),
      ];
      const folding = fold(emptyAggregate("2026-08-20"));
      folding.add(objects());
      const state = folding.finish().states.get(testIdentityKey(ADDED))!;
      expect(costSeconds(state, "2026-08-20")).toBeGreaterThan(80);
      const aside = fold(emptyAggregate("2026-08-20"));
      await aside.addUnordered(replaying(objects()));
      expect(aside.finish().states.get(testIdentityKey(ADDED))?.costByDay)
        .toEqual(state.costByDay);
    });

    it("keeps main's file, and adds no identity, for a batch read aside", async () => {
      const added = testIdentityKey(ADDED);
      const moved = fold();
      await moved.addUnordered(replaying([
        stored(LOCAL_NAME, workstation(), [
          record({ file: MOVED }),
          record({ test: ADDED, file: MOVED }),
        ]),
      ]));
      const kept = moved.finish();
      expect(kept.aggregate.files[KEY]).toBe(UNIT);
      expect(kept.states.get(KEY)?.runsByDay["2026-08-20"]).toBe(1);
      expect(kept.states.has(added)).toBe(false);
    });
  });

  describe("buildManifest()", () => {
    it("produces a manifest its own validator accepts", () => {
      const folded = foldReports(
        emptyAggregate("2026-08-20"),
        [stored(CI_NAME, context(), [
          record(),
          record({
            test: { k: "unit", s: "memory", n: "space > reads" },
          }),
        ])],
        NO_ALIASES,
        "2026-08-20",
      );
      const manifest = buildManifest({
        states: folded.states,
        surfaces: folded.surfaces,
        today: "2026-08-20",
        generatedAt: "2026-08-20T04:00:00.000Z",
        seed: "01K3",
        commit: "c1",
        runs: 1,
      });
      expect(manifest.entries.length).toBe(2);
      expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    });

    it("takes the last day an identity actually ran, not the last it holds", () => {
      // A day can be carried with no runs in it once the counters have
      // been aged, and reading that as the last run would tell the
      // exploration draw a test it has been ignoring was just run.
      expect(lastRun({
        ...emptyState(),
        runsByDay: { "2026-08-18": 3, "2026-08-19": 0, "2026-08-20": 0 },
      })).toBe("2026-08-18");
    });

    it("has no last day for an identity nothing has run", () => {
      expect(lastRun(emptyState())).toBeUndefined();
    });

    it("carries the last day anything ran an identity", () => {
      // The exploration draw takes the longest-unrun first, so without
      // this it has nothing to order by and sweeps nothing.
      const folded = foldReports(
        emptyAggregate("2026-08-19"),
        [
          stored(CI_NAME, context(), [record()]),
          stored(
            `${CI_NAME}2`,
            context({
              commit: "c2",
              startedAt: "2026-08-19T00:00:00.000Z",
            }),
            [record()],
          ),
        ],
        NO_ALIASES,
        "2026-08-20",
      );
      const manifest = buildManifest({
        states: folded.states,
        surfaces: folded.surfaces,
        today: "2026-08-20",
        generatedAt: "2026-08-20T04:00:00.000Z",
        seed: "01K3",
        commit: "c1",
        runs: 2,
      });
      expect(manifest.entries[0]!.lastRun).toBe("2026-08-20");
    });
  });
});

describe("a fold's count of what it has folded", () => {
  it("counts every execution, not every object", () => {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    expect(fold.observations).toBe(0);
    fold.add([stored(CI_NAME, context(), [record(), record()])]);
    expect(fold.observations).toBe(2);
    expect(fold.finish().observations).toBe(2);
  });
});

describe("what buildManifest() does with the states it is given", () => {
  const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });

  function built(states: Map<string, IdentityState>) {
    return buildManifest({
      states,
      surfaces: new Map(),
      today: "2026-08-20",
      generatedAt: "2026-08-20T00:00:00.000Z",
      seed: "01K3SAMPLE",
      commit: "c8893b3a8",
      runs: 1,
    });
  }

  it("skips a state whose key does not name an identity", () => {
    // A key that is not one cannot be turned back into a test to run, so
    // carrying it would put an entry in the manifest naming nothing.
    const states = new Map([
      ["not a key", emptyState()],
      ["[]", emptyState()],
      [KEY, emptyState()],
    ]);
    expect(built(states).entries.length).toBe(1);
  });

  it("withholds a test that disagrees with itself too often", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 100;
    state.failuresByDay["2026-08-20"] = 10;
    state.flakesByDay["2026-08-20"] = 10;
    const manifest = built(new Map([[KEY, state]]));
    expect(manifest.withheld.length).toBe(1);
    expect(manifest.withheld[0]!.reason).toBe("flaky");
  });

  it("withholds nothing for a test that flaked once and passes since", () => {
    // Every failure it has had was a flake, so a share of its failures
    // would hold it out of every pull request for one bad run.
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 10000;
    state.failuresByDay["2026-08-20"] = 1;
    state.flakesByDay["2026-08-20"] = 1;
    const manifest = built(new Map([[KEY, state]]));
    expect(manifest.withheld).toEqual([]);
    // Selectable, and still run twice: it has disagreed with itself, and
    // one execution cannot tell a pass from a lucky pass.
    expect(manifest.entries[0]!.repeats).toBe(FLAKE_MIN_EXECUTIONS);
  });

  it("records a share as measured, however small it is", () => {
    // One disagreement among a hundred thousand runs. Zero is what says
    // a test has never been seen to disagree, and the execution count
    // steps at it, so a share written to a few places would read this as
    // a test that never has and run it once.
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 100_000;
    state.failuresByDay["2026-08-20"] = 1;
    state.flakesByDay["2026-08-20"] = 1;
    const entry = built(new Map([[KEY, state]])).entries[0]!;
    expect(entry.flakeRate).toBe(1 / 100_000);
    expect(entry.repeats).toBe(FLAKE_MIN_EXECUTIONS);
  });

  it("records a cost and a score as measured", () => {
    // Both are compared against thresholds, and a lane's budget is a sum
    // of costs, so what is written is what was worked out.
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 3;
    sealDay(state, "2026-08-20", samplesOf([37, 41, 43]));
    const entry = built(new Map([[KEY, state]])).entries[0]!;
    expect(entry.cost).toBe(costSeconds(state, "2026-08-20"));
    expect(entry.score).toBe(value(entry.inputs, "2026-08-20"));
  });

  it("carries the counts the share was taken from", () => {
    const state = emptyState();
    state.runsByDay["2026-08-20"] = 80;
    state.failuresByDay["2026-08-20"] = 12;
    state.flakesByDay["2026-08-20"] = 12;
    const entry = built(new Map([[KEY, state]])).entries[0]!;
    expect(entry.flakeEvidence).toEqual({ flakes: 12, runs: 80 });
    // The counts are what was seen, flat. The share weights recent days
    // more heavily, so it is not those counts divided; what it is, is
    // the figure every decision here was taken on.
    expect(entry.flakeRate).toBe(0.15);
    expect(entry.repeats).toBe(executionsFor(entry.flakeRate));
  });

  it("withholds nothing for a test that has never failed", () => {
    expect(built(new Map([[KEY, emptyState()]])).withheld).toEqual([]);
  });
});

describe("a batch whose reports interleave in time", () => {
  const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });

  /** One object holding one run of the test at one commit. */
  function run(commit: string, outcome: TestRecord["outcome"], at: string) {
    return stored(
      `labs/test-records/aggregated/v1/2026/08/20/shard-${commit}.ndjson`,
      context({ commit, startedAt: at }),
      [record({ outcome })],
    );
  }

  function foldedIn(reports: ReturnType<typeof run>[]) {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    fold.add(reports);
    return fold.finish().states.get(KEY)!;
  }

  it("folds a day's shards in the order the runs happened", () => {
    // A rollup holds a whole day, and its shards are read concurrently,
    // so the order they arrive in is not the order they ran in. The
    // rules that decide whether a failure is a new real test failure look
    // backwards and forwards along that order, so it has to be the real
    // one.
    const broke = run("c1", "fail", "2026-08-20T01:00:00.000Z");
    const fixed = run("c2", "pass", "2026-08-20T02:00:00.000Z");
    expect(foldedIn([broke, fixed]).mainCatches).toBe(1);
    expect(foldedIn([fixed, broke]).mainCatches).toBe(1);
  });

  it("reaches the same state whichever order the shards arrive in", () => {
    const reports = [
      run("c1", "fail", "2026-08-20T01:00:00.000Z"),
      run("c2", "pass", "2026-08-20T02:00:00.000Z"),
      run("c3", "fail", "2026-08-20T03:00:00.000Z"),
      run("c4", "pass", "2026-08-20T04:00:00.000Z"),
    ];
    const forwards = foldedIn(reports);
    const backwards = foldedIn([...reports].reverse());
    const shuffled = foldedIn([
      reports[2]!,
      reports[0]!,
      reports[3]!,
      reports[1]!,
    ]);
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
    expect(forwards.mainCatches).toBe(2);
  });
});

describe("a run of main under the next day's seed", () => {
  // The daily run of every suite at the head of `main` under the seed the
  // next day's commits will take, beside that commit's own push.
  const pushed = context({ shuffleSeed: 20260820 });
  const scheduled = context({
    shuffleSeed: 20260821,
    startedAt: "2026-08-20T11:00:00.000Z",
  });
  scheduled.ci!.event = "schedule";
  scheduled.ci!.workflowRunId = "2";

  function folded(
    pushOutcome: TestRecord["outcome"],
    outcome: TestRecord["outcome"],
  ) {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    fold.add([
      stored(CI_NAME, pushed, [record({ outcome: pushOutcome })]),
      stored(CI_NAME.replace("run-1", "run-2"), scheduled, [
        record({ outcome }),
      ]),
    ]);
    return fold.finish().states.get(KEY)!;
  }

  it("holds a failure only that order shows as a failure on main", () => {
    // Nothing between the two runs changed the code, so the failure says
    // nothing about a change. It waits for a run of `main` in the same
    // order, as a failure in a push there does.
    const state = folded("pass", "fail");
    expect(state.prCatches).toBe(0);
    expect(state.mainCatches).toBe(0);
    expect(state.pendingMain).toEqual([{
      day: "2026-08-20",
      commit: "c1",
      seed: 20260821,
      source: "main",
    }]);
    expect(lastMainIn(state.lastMainByOrder, 20260821)).toBe("fail");
    expect(lastMainIn(state.lastMainByOrder, 20260820)).toBe("pass");
  });

  it("records a pass as main's outcome in its own order only", () => {
    // The push's failure is in another order, so the pass leaves it
    // waiting for a run in its own, and `main` is still failing the test
    // in the push's order.
    const state = folded("fail", "pass");
    expect(state.runsByDay["2026-08-20"]).toBe(2);
    expect(state.pendingMain).toEqual([{
      day: "2026-08-20",
      commit: "c1",
      seed: 20260820,
      source: "main",
    }]);
    expect(lastMainIn(state.lastMainByOrder, 20260821)).toBe("pass");
    expect(lastMainIn(state.lastMainByOrder, 20260820)).toBe("fail");
  });
});

describe("a read that fails part way", () => {
  /** A read that hands over what it has and then fails. */
  async function* breaking(reports: readonly StoredReport[]) {
    for (const report of reports) yield report;
    throw new Error("that shard is gone");
  }

  const fresh = () =>
    new Fold(emptyAggregate("2026-08-20"), NO_ALIASES, "2026-08-20");

  it("leaves the fold holding nothing of what did arrive", async () => {
    // Nothing can replace a shard that will not read, so the day is read
    // from its raw objects instead — and that is only open to a caller
    // whose fold took nothing from the shards that did read.
    const fold = fresh();
    await expect(
      fold.addUnordered(breaking([
        stored(CI_NAME, context(), [record({ file: UNIT })]),
      ])),
    ).rejects.toThrow();
    expect(fold.knows(CI_NAME)).toBe(false);
    expect(fold.declined).toBe(0);
    // Which is the whole of what the caller asks before reading those
    // records another way.
    expect(fold.intact).toBe(true);
    const after = fold.finish();
    expect(after.observations).toBe(0);
    expect(after.aggregate).toEqual(fresh().finish().aggregate);
    expect(after.surfaces.size).toBe(0);
  });

  it("folds the day afterwards as though nothing had been read", async () => {
    // What the fold ends up with must not depend on how far the read
    // that failed got, or the part it kept would be counted twice.
    const reports = [
      stored(CI_NAME, context(), [record({ durationMs: 40 })]),
      stored(
        `${CI_NAME}2`,
        context({ commit: "c2", startedAt: "2026-08-20T01:00:00.000Z" }),
        [record({ durationMs: 900 })],
      ),
    ];
    const recovered = fresh();
    await expect(recovered.addUnordered(breaking(reports))).rejects.toThrow();
    recovered.add(reports);
    const whole = fresh();
    whole.add(reports);
    expect(recovered.intact).toBe(true);
    expect(recovered.finish().aggregate).toEqual(whole.finish().aggregate);
  });

  it("says an ordered read is not intact from its first report", () => {
    // `add` folds as it reads, so anything it throws is thrown with part
    // of the batch already counted. A fold that said otherwise would
    // offer those records to be read a second time.
    const fold = fresh();
    const gone: StoredReport = {
      objectName: CI_NAME,
      context: undefined,
      records: [],
      get reports(): StoredReportGroup[] {
        throw new Error("that object is gone");
      },
    };
    expect(() => fold.add([gone])).toThrow();
    expect(fold.intact).toBe(false);
  });
});

describe("a batch read one shard at a time", () => {
  /** Everything one object gives a fold beyond the records in it. */
  const corpus = () => [
    stored(CI_NAME, context(), [
      record({ durationMs: 40 }),
      record({
        test: { k: "gate", s: "ci", n: "ci-lane batch runner-unit" },
        durationMs: 30_000,
      }),
      record({
        test: { k: "gate", s: "ci", n: "ci-lane ran batch runner-unit" },
        durationMs: 10_000,
      }),
      record({
        test: { k: "gate", s: "ci", n: "ci-lane units batch runner-unit" },
        durationMs: 4,
      }),
      record({
        test: { k: "gate", s: "ci", n: "ci-lane passes batch runner-unit" },
        durationMs: 1,
      }),
    ]),
    stored(
      `${CI_NAME}2`,
      context({ commit: "c2", startedAt: "2026-08-20T01:00:00.000Z" }),
      [record({ durationMs: 900, file: UNIT })],
    ),
    stored(`${CI_NAME}3`, placeless(), [
      record({
        test: { k: "gate", s: "ci", n: "ci-lane setup fuse" },
        durationMs: 14_800,
      }),
    ]),
  ];

  const fresh = () =>
    new Fold(emptyAggregate("2026-08-20"), NO_ALIASES, "2026-08-20");

  it("gives a fold what reading it in order gives", async () => {
    // A shard read gives what it reads to the batch and merges the batch
    // in once the last report has arrived, so each of the five things a
    // read gives — the surfaces it names, the lane measurements it
    // carries, the durations it sampled, the objects it came from, and
    // the measurements it declined — has to come out where reading the
    // same objects in order puts it.
    const ordered = fresh();
    ordered.add(corpus());
    const shards = fresh();
    await shards.addUnordered(replaying(corpus()));
    const aggregate = shards.finish().aggregate;
    // Named one at a time as well, so that none of the five is compared
    // empty against empty.
    expect(aggregate.lanes?.length).toBe(1);
    expect(shards.declined).toBe(1);
    expect(aggregate.folded.length).toBe(3);
    expect(Object.keys(aggregate.files)).toEqual([KEY]);
    expect(
      aggregate.states[KEY]?.costByDay["2026-08-20"]?.counts
        .reduce((sum, each) => sum + each, 0),
    ).toBe(2);
    expect(aggregate).toEqual(ordered.finish().aggregate);
  });

  it("does not let a shard with no file replace one that had it", async () => {
    // The rule holds across the merge as it holds inside one batch: a
    // file names something a runner can be pointed at, and an identity's
    // own name does not.
    const fold = fresh();
    fold.add([stored(CI_NAME, context(), [record({ file: UNIT })])]);
    await fold.addUnordered(replaying([
      stored(
        `${CI_NAME}2`,
        context({ commit: "c2", startedAt: "2026-08-20T01:00:00.000Z" }),
        [record()],
      ),
    ]));
    expect(fold.finish().aggregate.files).toEqual({ [KEY]: UNIT });
  });
});

describe("a report holding a whole day", () => {
  it("folds a rollup shard larger than a call can carry arguments", () => {
    // A rollup shard is a whole day of records in one object. Appending
    // its observations by spreading them as arguments overflows the
    // stack, and the rollup path is the one that reads these.
    const many = Array.from(
      { length: 200_000 },
      (_, i) => record({ test: { k: "unit", s: "memory", n: `case ${i}` } }),
    );
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    fold.add([stored(CI_NAME, context(), many)]);
    expect(fold.observations).toBe(many.length);
  });
});

describe("the days a fold keeps a lane's measurements over", () => {
  /** One lane's artifact: what a batch took, beside what its tests did. */
  function laneRanOn(day: string, spentSeconds: number) {
    return stored(
      `labs/test-records/submissions/ci/v1/${
        day.replaceAll("-", "/")
      }/lane.ndjson`,
      context({ startedAt: `${day}T00:00:00.000Z`, commit: `c-${day}` }),
      [
        record({
          test: { k: "gate", s: "ci", n: "ci-lane batch runner-unit" },
          durationMs: spentSeconds * 1000,
        }),
        record({
          test: { k: "gate", s: "ci", n: "ci-lane ran batch runner-unit" },
          durationMs: 10_000,
        }),
        record({
          test: { k: "gate", s: "ci", n: "ci-lane units batch runner-unit" },
          durationMs: 4,
        }),
        record({
          test: { k: "gate", s: "ci", n: "ci-lane passes batch runner-unit" },
          durationMs: 1,
        }),
      ],
    );
  }

  function keptAfterFolding(days: readonly string[]) {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      NO_ALIASES,
      "2026-08-20",
    );
    for (const day of days) fold.add([laneRanOn(day, 30)]);
    return fold.finish().aggregate.lanes;
  }

  it("keeps what a lane measured on a day inside the window", () => {
    expect(keptAfterFolding(["2026-08-20"])).toEqual([
      {
        day: "2026-08-20",
        suite: "runner-unit",
        measured: false,
        ran: 10,
        spent: 30,
        units: 4,
        passes: 1,
      },
    ]);
  });

  it("keeps nothing a lane measured on a day the window cannot reach", () => {
    // Reading one buys nothing, since the same `finish` that would keep
    // it drops it again, and a bootstrap would hold sixty days of them
    // at once.
    const old = "2026-06-01";
    expect(daysBetween(old, "2026-08-20")).toBeGreaterThan(COST_WINDOW_DAYS);
    expect(keptAfterFolding([old])).toEqual([]);
    expect(keptAfterFolding([old, "2026-08-20"])).toEqual(
      keptAfterFolding(["2026-08-20"]),
    );
  });

  it("keeps nothing whose day will not parse as one", () => {
    // Both ends of the fold ask the same question, so a day that answers
    // neither yes nor no is dropped at both rather than accepted at one.
    const aggregate = emptyAggregate("2026-08-20");
    aggregate.lanes = [
      { day: "whenever", capability: "fuse", seconds: 14.8 },
      { day: "2026-08-20", capability: "fuse", seconds: 2.1 },
    ];
    expect(
      new Fold(aggregate, NO_ALIASES, "2026-08-20").finish().aggregate.lanes,
    ).toEqual([{ day: "2026-08-20", capability: "fuse", seconds: 2.1 }]);
  });

  it("drops one it was already keeping once the window has passed it", () => {
    // The two sides age separately. One already in the aggregate was
    // inside the window when it arrived, and the window moved under it.
    const aggregate = emptyAggregate("2026-08-20");
    aggregate.lanes = [
      { day: "2026-06-01", capability: "fuse", seconds: 14.8 },
      { day: "2026-08-20", capability: "fuse", seconds: 2.1 },
    ];
    expect(
      new Fold(aggregate, NO_ALIASES, "2026-08-20").finish().aggregate.lanes,
    ).toEqual([{ day: "2026-08-20", capability: "fuse", seconds: 2.1 }]);
  });

  it("carries what lanes measured across a saved aggregate", () => {
    const first = new Fold(
      emptyAggregate("2026-08-20"),
      NO_ALIASES,
      "2026-08-20",
    );
    first.add([laneRanOn("2026-08-20", 30)]);
    const saved = parseAggregate(JSON.stringify(first.finish().aggregate));
    expect(saved).toBeDefined();
    const second = new Fold(saved!, NO_ALIASES, "2026-08-20");
    expect(second.finish().aggregate.lanes).toEqual([
      {
        day: "2026-08-20",
        suite: "runner-unit",
        measured: false,
        ran: 10,
        spent: 30,
        units: 4,
        passes: 1,
      },
    ]);
  });
});

describe("a fold reading cost days another set of rules sealed", () => {
  /** A stored aggregate holding one slow day under no stamp. */
  function aggregateSealedBefore(): string {
    const aggregate = emptyAggregate("2026-08-20");
    const held = emptyState();
    held.costByDay["2026-08-20"] = samplesOf([262_144, 262_144]);
    aggregate.states[KEY] = held;
    return JSON.stringify(aggregate);
  }

  function folded(reports: readonly ReturnType<typeof stored>[]) {
    const fold = new Fold(
      parseAggregate(aggregateSealedBefore())!,
      NO_ALIASES,
      "2026-08-20",
    );
    if (reports.length > 0) fold.add(reports);
    return fold.finish();
  }

  it("charges the day it sealed once it has one", () => {
    const run = folded([
      stored(CI_NAME, context(), [record({ durationMs: 1024 })]),
    ]);
    expect(costSeconds(run.states.get(KEY)!, "2026-08-20")).toBe(1.024);
    // And the aggregate it writes says so, so the next run reads it as a
    // day these rules sealed rather than dropping it again.
    const next = parseAggregate(JSON.stringify(run.aggregate))!;
    expect(next.states[KEY]!.costByDay["2026-08-20"]!.rule).toBe(COST_RULE);
  });

  it("charges the day that set sealed while it has none", () => {
    // A test that has not passed since the rules changed has nothing
    // else to be charged, and charging it nothing is the direction that
    // overruns a lane.
    expect(costSeconds(folded([]).states.get(KEY)!, "2026-08-20"))
      .toBe(262.144);
  });
});

describe("the days a fold measures cost over", () => {
  const KEY = testIdentityKey({ k: "unit", s: "memory", n: "space > writes" });

  /** One run of the test on `day`, taking `ms`. */
  function ranOn(day: string, ms: number) {
    return stored(
      `labs/test-records/submissions/ci/v1/${
        day.replaceAll("-", "/")
      }/r.ndjson`,
      context({ startedAt: `${day}T00:00:00.000Z`, commit: `c-${day}` }),
      [record({ durationMs: ms })],
    );
  }

  function costsAfterFolding(days: readonly string[]) {
    const fold = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    for (const day of days) fold.add([ranOn(day, 1000)]);
    return fold.finish().states.get(KEY)!.costByDay;
  }

  it("keeps a day inside the window", () => {
    expect(Object.keys(costsAfterFolding(["2026-08-20"]))).toEqual([
      "2026-08-20",
    ]);
  });

  it("holds no cost for a day the window cannot reach", () => {
    // This is what makes not sampling such a day safe: `finish` seals a
    // day's cost and then ages it off in the same call, so a day past
    // the window has no cost either way, and sampling it only costs the
    // memory to hold sixty days of samples during a bootstrap.
    const old = "2026-06-01";
    expect(daysBetween(old, "2026-08-20")).toBeGreaterThan(COST_WINDOW_DAYS);
    expect(costsAfterFolding([old])).toEqual({});
    expect(costsAfterFolding([old, "2026-08-20"])).toEqual(
      costsAfterFolding(["2026-08-20"]),
    );
  });
});

describe("history held under a name an alias has since replaced", () => {
  const OLD = { k: "unit", s: "memory", n: "space > writes" };
  const NEW = { k: "unit", s: "memory", n: "space > records a write" };
  const LATEST = { k: "unit", s: "memory", n: "space > records" };
  const RENAMED = new AliasResolver([
    { date: "2026-08-15", from: OLD, to: NEW },
  ]);

  /**
   * A state with a new real test failure and a run on each of two days
   * either side.
   */
  function either(): IdentityState {
    return {
      ...emptyState(),
      newRealTestFailureDays: {
        "2026-08-10": { local: 0, pr: 1, main: 0, sources: ["fix"] },
        "2026-08-16": { local: 0, pr: 1, main: 0, sources: ["late"] },
      },
      prCatches: 2,
      lastCatch: "2026-08-16",
      sources: ["fix", "late"],
      runsByDay: { "2026-08-10": 3, "2026-08-16": 1 },
    };
  }

  it("moves the days before the alias's date to the new name", () => {
    const states = new Map([[testIdentityKey(OLD), either()]]);
    expect(resolveHistory(states, {}, RENAMED)).toBe(1);
    const moved = states.get(testIdentityKey(NEW))!;
    expect(moved.newRealTestFailureDays).toEqual({
      "2026-08-10": { local: 0, pr: 1, main: 0, sources: ["fix"] },
    });
    expect(moved.runsByDay).toEqual({ "2026-08-10": 3 });
    expect(moved.prCatches).toBe(1);
    // A record of that day under the old name stays the old name's, and
    // so does the history of that day.
    const kept = states.get(testIdentityKey(OLD))!;
    expect(Object.keys(kept.newRealTestFailureDays)).toEqual(["2026-08-16"]);
    expect(kept.prCatches).toBe(1);
  });

  it("adds to the history the new name already holds", () => {
    const states = new Map([
      [testIdentityKey(OLD), { ...either(), newRealTestFailureDays: {} }],
      [testIdentityKey(NEW), {
        ...emptyState(),
        runsByDay: { "2026-08-10": 2, "2026-08-17": 5 },
      }],
    ]);
    resolveHistory(states, {}, RENAMED);
    expect(states.get(testIdentityKey(NEW))!.runsByDay).toEqual({
      "2026-08-10": 5,
      "2026-08-17": 5,
    });
  });

  it("drops the old name once it holds nothing, and gives its file on", () => {
    const old = either();
    old.newRealTestFailureDays = {
      "2026-08-10": { local: 0, pr: 1, main: 0, sources: ["fix"] },
    };
    old.runsByDay = { "2026-08-10": 3 };
    const states = new Map([[testIdentityKey(OLD), old]]);
    const files = { [testIdentityKey(OLD)]: UNIT };
    resolveHistory(states, files, RENAMED);
    expect([...states.keys()]).toEqual([testIdentityKey(NEW)]);
    expect(files).toEqual({ [testIdentityKey(NEW)]: UNIT });
  });

  it("moves what the fold context remembers of the days it moves", () => {
    const context = emptyContext();
    context.credited.set(`${testIdentityKey(OLD)} c1 fix`, "2026-08-10");
    context.credited.set(`${testIdentityKey(OLD)} c2 late`, "2026-08-16");
    const after = new Fold(
      { ...emptyAggregate("2026-08-19"), context: serializeContext(context) },
      RENAMED,
      "2026-08-20",
    ).finish().aggregate;
    expect([...parseContext(after.context).credited.keys()].sort()).toEqual(
      [
        `${testIdentityKey(NEW)} c1 fix`,
        `${testIdentityKey(OLD)} c2 late`,
      ].sort(),
    );
  });

  it("keeps the file the new name's own records named", () => {
    const states = new Map([[testIdentityKey(OLD), either()]]);
    const files = {
      [testIdentityKey(OLD)]: UNIT,
      [testIdentityKey(NEW)]: "packages/memory/test/write.test.ts",
    };
    resolveHistory(states, files, RENAMED);
    expect(files[testIdentityKey(NEW)]).toBe(
      "packages/memory/test/write.test.ts",
    );
  });

  it("follows a chain of renames to the name each day ends at", () => {
    const resolver = new AliasResolver([
      { date: "2026-08-12", from: OLD, to: NEW },
      { date: "2026-08-20", from: NEW, to: LATEST },
    ]);
    const states = new Map([[testIdentityKey(OLD), either()]]);
    resolveHistory(states, {}, resolver);
    // The day before the first rename went through both of them. The day
    // after it was recorded under a name the first rename had already
    // retired, which no alias gives on.
    expect(
      Object.keys(states.get(testIdentityKey(LATEST))!.newRealTestFailureDays),
    )
      .toEqual(["2026-08-10"]);
    expect(
      Object.keys(states.get(testIdentityKey(OLD))!.newRealTestFailureDays),
    )
      .toEqual(["2026-08-16"]);
    expect(states.has(testIdentityKey(NEW))).toBe(false);
  });

  it("moves nothing for a name no alias replaces", () => {
    const states = new Map([[testIdentityKey(NEW), either()]]);
    expect(resolveHistory(states, {}, RENAMED)).toBe(0);
    expect([...states.keys()]).toEqual([testIdentityKey(NEW)]);
  });

  it("is what a fold does with the aggregate it starts from", () => {
    // The history a run carries forward is resolved the way every record
    // it reads is, so a run after an alias line lands puts the new real
    // test failures folded before it under the new name.
    const aggregate = emptyAggregate("2026-08-20");
    aggregate.states[testIdentityKey(OLD)] = either();
    const fold = new Fold(aggregate, RENAMED, "2026-08-20");
    expect(fold.resolved).toBe(1);
    const { states } = fold.finish();
    expect(states.get(testIdentityKey(NEW))?.prCatches).toBe(1);
    expect(states.get(testIdentityKey(OLD))?.prCatches).toBe(1);
  });
});

describe("the days a fold closes", () => {
  const TODAY = "2026-08-20";

  /** A continuous-integration object of one day, by its partition. */
  const on = (day: string, run = "1") =>
    `labs/test-records/submissions/ci/v1/${day}/run-${run}-a.ndjson`;

  it("drops the objects and receipts of a read day past the lag", () => {
    const aggregate: ReturnType<typeof emptyAggregate> = {
      ...emptyAggregate("2026-08-19"),
      folded: [on("2026/08/10"), on("2026/08/14"), on("2026/08/19")],
      compacted: ["ci\t2026/08/09", "ci\t2026/08/18"],
    };
    const after = new Fold(aggregate, NO_ALIASES, TODAY).finish({
      from: "2026/08/19",
      through: "2026/08/20",
    }).aggregate;
    // Seven days behind the twentieth is the thirteenth. The ninth is
    // the first day the history holds, so its receipt stays.
    expect(after.closed).toBe("2026/08/13");
    expect(after.folded).toEqual([on("2026/08/14"), on("2026/08/19")]);
    expect(after.compacted).toEqual(["ci\t2026/08/09", "ci\t2026/08/18"]);
  });

  it("knows an object of a closed day without holding its name", () => {
    const fold = new Fold(
      { ...emptyAggregate("2026-08-19"), closed: "2026/08/13" },
      NO_ALIASES,
      TODAY,
    );
    // A run over a wide window lists it again, and must not fold it again.
    expect(fold.knows(on("2026/08/13"))).toBe(true);
    expect(fold.knows(LOCAL_NAME.replace("2026/08/20", "2026/08/12")))
      .toBe(true);
    expect(fold.settled(CI_SOURCE, "2026/08/13")).toBe(true);
    expect(fold.knows(on("2026/08/14"))).toBe(false);
    expect(fold.settled(CI_SOURCE, "2026/08/14")).toBe(false);
  });

  it("closes no day while a day before it is unread", () => {
    // A window that starts after the last day the aggregate read leaves
    // the days between unread, so nothing after them closes.
    const aggregate: ReturnType<typeof emptyAggregate> = {
      ...emptyAggregate("2026-08-05"),
      closed: "2026/07/29",
      folded: [on("2026/08/05")],
    };
    const after = new Fold(aggregate, NO_ALIASES, TODAY).finish({
      from: "2026/08/19",
      through: "2026/08/20",
    }).aggregate;
    expect(after.closed).toBe("2026/07/29");
    expect(after.folded).toEqual([on("2026/08/05")]);
  });

  it("closes nothing where it was not told what was read", () => {
    const after = new Fold(emptyAggregate("2026-08-19"), NO_ALIASES, TODAY)
      .finish().aggregate;
    expect(after.closed).toBeUndefined();
  });
});

describe("lastReadDay()", () => {
  it("is the day an aggregate was written on", () => {
    expect(lastReadDay(emptyAggregate("2026-08-19"))).toBe("2026/08/19");
  });
});

describe("coldStart()", () => {
  it("holds nothing and closes the days before the window", () => {
    const start = coldStart("2026/08/10", "2026-08-20");
    expect(start.states).toEqual({});
    expect(start.folded).toEqual([]);
    expect(start.closed).toBe("2026/08/09");
    expect(start.day).toBe("2026-08-20");
  });
});
