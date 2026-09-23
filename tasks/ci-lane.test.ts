import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { shuffleNotice } from "@commonfabric/test-support/shuffle";
import {
  type TestIdentity,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import {
  CAPABILITY_LOG_TAIL_LINES,
  type CapabilityId,
} from "./ci-capabilities.ts";
import {
  capabilitiesBySuite,
  loadTopology,
  wholeUnits,
} from "./test-topology.ts";

import {
  accountFor,
  batchCoverage,
  batchesOf,
  batchRepeats,
  changedFiles,
  convertCoverage,
  COVERAGE_FAILURE_MARKER,
  COVERAGE_PROFILE_DIR,
  COVERAGE_REPORT_DIR,
  COVERAGE_REPORT_FILE,
  describeAccounting,
  describeCapabilityLogs,
  describeConflicts,
  describeCoverage,
  describePlan,
  describeWithheld,
  fullLanes,
  main,
  manifestMoment,
  markMeasuredFailures,
  measuredSetOfReport,
  parseLaneArgs,
  runBatch,
  runInvocation,
  runLane,
  spoolRecords,
  unitsForRun,
} from "./ci-lane.ts";
import {
  batchMeasurement,
  batchMeasurementName,
  MEASURED_BATCH_SUFFIX,
} from "./lane-measurement.ts";
import { census, standIn } from "./test-selection/census.ts";
import type { CommandContext, Suite } from "./test-topology/suite.ts";
import {
  plan,
  type Selection,
  type SelectionReason,
} from "./test-selection/plan.ts";
import {
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  type ManifestEntry,
} from "./test-selection/manifest.ts";
import {
  FULL_LANE_BOUND_SECONDS,
  FULL_LANE_BUDGET_SECONDS,
  LANE_BUDGET_SECONDS,
  UNMEASURED_COST_SECONDS,
} from "./test-selection/policy.ts";

/**
 * The repository, found from this file rather than from the process's
 * own directory: a package's tests run with that package as the working
 * directory, and the paths the topology reads are the repository's.
 */
const REPOSITORY = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/** A suite holding exactly what a case describes. */
function suite(partial: Partial<Suite> & { id: string }): Suite {
  return {
    recordSurfaces: [{ kind: "unit", scope: "bakery" }],
    needs: ["deno"],
    units: [],
    unavailable: [],
    whole: [],
    locate: () => undefined,
    command: () => Promise.resolve([]),
    ...partial,
  };
}

/** A manifest carrying exactly these entries. */
function manifestOf(entries: readonly Partial<ManifestEntry>[]): Manifest {
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    generatedAt: "2026-09-01T00:00:00.000Z",
    seed: "seed",
    commit: "c".repeat(40),
    runs: 1,
    dials: {},
    calibration: { setupCost: {}, suites: {}, prologue: 40 },
    entries: entries.map((entry) => ({
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      suite: "workspace-unit",
      unit: "packages/bakery/glaze.test.ts",
      cost: 1,
      score: 0.5,
      inputs: { catches: 0, sources: 0, churn: 0 },
      flakeRate: 0,
      repeats: 1,
      ...entry,
    })),
    withheld: [],
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: { count: 0, digest: "" },
    coverageBaselines: [],
  };
}

describe("reading the lane's command line", () => {
  it("names the seed it settled on even when it refuses the command line", async () => {
    // The lane settles one seed for every command it builds, and says
    // which before it reads anything, so a log that stops early still
    // names the order its tests would have run in.
    const result = await runDenoCommandWithTemporaryLock({
      root: fromFileUrl(new URL("..", import.meta.url)),
      args: (lock) => [
        "run",
        `--lock=${lock}`,
        "-A",
        fromFileUrl(new URL("./ci-lane.ts", import.meta.url)),
        "--bogus",
      ],
      env: { CF_TEST_SHUFFLE_SEED: "7" },
    });
    expect(result.code).toBe(2);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain(shuffleNotice(7));
    expect(stderr).toContain("usage: ci-lane.ts");
    expect(stderr.indexOf(shuffleNotice(7))).toBeLessThan(
      stderr.indexOf("usage: ci-lane.ts"),
    );
  });

  it("takes the lane, its share, and the moment to resolve at", () => {
    const options = parseLaneArgs([
      "--lane",
      "3",
      "--of",
      "5",
      "--base",
      "origin/main",
      "--at",
      "2026-09-01T12:00:00Z",
    ], "/repo");
    expect(options?.lane).toBe(3);
    expect(options?.of).toBe(5);
    expect(options?.base).toBe("origin/main");
    expect(options?.at).toBe("2026-09-01T12:00:00Z");
  });

  it("refuses a lane outside the run it belongs to", () => {
    expect(parseLaneArgs(["--lane", "6", "--of", "5"])).toBeUndefined();
    expect(parseLaneArgs(["--lane", "0", "--of", "5"])).toBeUndefined();
  });

  it("refuses to count lanes for a run that is not the full one", () => {
    // Only `main` works its lane count out; a pull request's is a dial.
    expect(parseLaneArgs(["--lane-count"])).toBeUndefined();
    expect(parseLaneArgs(["--full", "--lane-count"])?.laneCount).toBe(true);
  });

  it("refuses a flag it does not know", () => {
    expect(parseLaneArgs(["--shard", "1/5"])).toBeUndefined();
  });
});

describe("the moment a lane resolves its manifest at", () => {
  const lane = { lane: 1, of: 5, full: false, dryRun: false, laneCount: false };

  /** A repository whose one commit was made at a moment a case chose. */
  async function repository(committed: string): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "ci-lane-commit-" });
    const git = (...args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: root,
        env: {
          ...Deno.env.toObject(),
          GIT_AUTHOR_DATE: committed,
          GIT_COMMITTER_DATE: committed,
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: "a@example.com",
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: "a@example.com",
        },
        stdout: "null",
        stderr: "null",
      }).output();
    await git("init", "-q");
    await Deno.writeTextFile(`${root}/a.txt`, "a");
    await git("add", "a.txt");
    await git("commit", "-q", "-m", "one");
    return root;
  }

  it("takes the commit's date, normalized to UTC", async () => {
    // Git writes the committer's own offset and manifest names carry
    // UTC, so the two are only comparable once this one is normalized.
    const root = await repository("2026-09-01T10:41:59-07:00");
    expect(manifestMoment({ ...lane, root }).at).toBe(
      "2026-09-01T17:41:59.000Z",
    );
  });

  it("takes the same moment however many times a run is attempted", async () => {
    // The property the whole thing turns on: nothing about the moment
    // comes from the run, so a re-run resolves what the first attempt
    // resolved.
    const root = await repository("2026-09-01T10:41:59-07:00");
    const first = manifestMoment({ ...lane, root });
    const again = manifestMoment({ ...lane, root });
    expect(again.at).toBe(first.at);
    expect(first.note).toBeUndefined();
  });

  it("lets a caller ask about a moment that is not this tree's", async () => {
    const root = await repository("2026-09-01T10:41:59-07:00");
    const moment = manifestMoment({
      ...lane,
      root,
      at: "2026-08-01T00:00:00.000Z",
    });
    expect(moment.at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("falls back to the newest manifest outside a repository, and says so", async () => {
    const root = await Deno.makeTempDir({ prefix: "ci-lane-nogit-" });
    const moment = manifestMoment({ ...lane, root });
    expect(moment.note).toContain("cannot read the commit's date");
    expect(Number.isNaN(new Date(moment.at).getTime())).toBe(false);
  });
});

describe("turning a lane's selections into batches", () => {
  const bakery = suite({
    id: "workspace-unit",
    units: ["packages/bakery/glaze.test.ts"],
  });

  it("skips the identities inside a chosen unit that were not chosen", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 1,
    }]);
    expect(batches.length).toBe(1);
    expect(batches[0]!.units).toEqual([{
      unit: "packages/bakery/glaze.test.ts",
      skip: ["glaze > browns"],
    }]);
  });

  it("skips nothing inside a unit its suite declares whole", () => {
    // The runner of such a unit reads no skip list. The batch therefore carries
    // none, and the lane's report of what it ran lists every test in the unit.

    const member = suite({
      id: "workspace-unit",
      units: ["packages/bakery"],
      whole: ["packages/bakery"],
    });
    const manifest = manifestOf([
      { unit: "packages/bakery" },
      {
        test: { k: "unit", s: "bakery", n: "glaze > browns" },
        unit: "packages/bakery",
      },
    ]);
    const batches = batchesOf([member], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 1,
    }]);
    expect(batches[0]!.units).toEqual([{ unit: "packages/bakery", skip: [] }]);
  });

  it("skips nothing when every identity of a unit was chosen", () => {
    const manifest = manifestOf([{}]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 1,
    }]);
    expect(batches[0]!.units[0]!.skip).toEqual([]);
  });

  it("takes the most runs any identity in the batch asked for", () => {
    const manifest = manifestOf([{}]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "value",
      repeats: 3,
    }]);
    expect(batchRepeats(batches[0]!)).toBe(3);
  });

  it("holds the most runs when a later identity asks for fewer", () => {
    // The count answers for every identity in the unit, so one asking
    // for a single run after another asked for three still gets three.
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const batches = batchesOf([bakery], manifest, [
      { entry: manifest.entries[0]!, reason: "value", repeats: 3 },
      { entry: manifest.entries[1]!, reason: "value", repeats: 1 },
    ]);
    expect(batchRepeats(batches[0]!)).toBe(3);
  });

  it("runs each unit of a batch as many times as that unit asked for", () => {
    // A unit that asked for fewer runs stops when it has had them: one
    // flaky unit is not a reason to run the rest of the batch again.
    const twoUnits = suite({
      id: "workspace-unit",
      units: ["packages/bakery/glaze.test.ts", "packages/bakery/ice.test.ts"],
    });
    const manifest = manifestOf([
      {},
      {
        test: { k: "unit", s: "bakery", n: "ice > sets" },
        unit: "packages/bakery/ice.test.ts",
      },
    ]);
    const batches = batchesOf([twoUnits], manifest, [
      { entry: manifest.entries[0]!, reason: "value", repeats: 4 },
      { entry: manifest.entries[1]!, reason: "value", repeats: 2 },
    ]);
    expect(batches.length).toBe(1);
    expect(batchRepeats(batches[0]!)).toBe(4);
    const round = (run: number) =>
      unitsForRun(batches[0]!, run).map((request) => request.unit);
    expect(round(1)).toEqual([
      "packages/bakery/glaze.test.ts",
      "packages/bakery/ice.test.ts",
    ]);
    expect(round(2)).toEqual([
      "packages/bakery/glaze.test.ts",
      "packages/bakery/ice.test.ts",
    ]);
    expect(round(3)).toEqual(["packages/bakery/glaze.test.ts"]);
    expect(round(4)).toEqual(["packages/bakery/glaze.test.ts"]);
  });

  it("runs a unit nothing asked to repeat exactly once", () => {
    const manifest = manifestOf([{}]);
    const batches = batchesOf([bakery], manifest, [{
      entry: manifest.entries[0]!,
      reason: "coverage-gate",
      repeats: 1,
    }]);
    expect(batchRepeats(batches[0]!)).toBe(1);
    expect(unitsForRun(batches[0]!, 2)).toEqual([]);
  });
});

/** Every unit each lane of a plan would run, in lane order. */
function unitsPerLane(
  suites: readonly Suite[],
  manifest: Manifest | undefined,
  lanes: number,
  policy?: "everything",
): string[][] {
  const seen = census(suites, manifest, new Set());
  const laid = plan({
    manifest: seen.manifest,
    mandatory: seen.mandatory,
    capabilities: capabilitiesBySuite(suites),
    wholeUnits: wholeUnits(suites),
    lanes,
    ...(policy === undefined ? {} : { policy }),
  });
  return laid.lanes.map((lane) =>
    batchesOf(suites, seen.manifest, lane.selections)
      .flatMap((batch) => batch.units.map((unit) => unit.unit))
      .toSorted()
  );
}

describe("the order a runner is handed its work in", () => {
  const bakery = [
    suite({
      id: "workspace-unit",
      units: ["c.test.ts", "a.test.ts", "b.test.ts"],
    }),
    suite({
      id: "repo-gates",
      recordSurfaces: [{ kind: "gate", scope: "repo" }],
      units: ["deno-fmt"],
    }),
  ];

  /** The units of one batch, in the order `batchesOf` returns them. */
  function handed(selections: readonly Selection[]): string[] {
    const seen = census(bakery, undefined, new Set());
    return batchesOf(bakery, seen.manifest, selections)
      .flatMap((batch) => batch.units.map((unit) => unit.unit));
  }

  it("hands the units over in the order the suite enumerates them", () => {
    const seen = census(bakery, undefined, new Set());
    const entries = seen.manifest.entries.filter((entry) =>
      entry.suite === "workspace-unit"
    );
    const selections = entries.map((entry) => ({
      entry,
      reason: "value" as const,
      repeats: 1,
    }));
    expect(handed(selections)).toEqual(["c.test.ts", "a.test.ts", "b.test.ts"]);
    // The same set chosen in a different order is handed over the same
    // way, which is what stops the two runs ordering one batch's work
    // differently from each other.
    expect(handed([...selections].reverse())).toEqual(handed(selections));
  });

  it("puts the batches themselves in one order whatever chose them", () => {
    const seen = census(bakery, undefined, new Set());
    const selections = seen.manifest.entries.map((entry) => ({
      entry,
      reason: "value" as const,
      repeats: 1,
    }));
    const suiteIds = (chosen: readonly Selection[]) =>
      batchesOf(bakery, seen.manifest, chosen).map((batch) => batch.suite.id);
    expect(suiteIds(selections)).toEqual(["repo-gates", "workspace-unit"]);
    expect(suiteIds([...selections].reverse())).toEqual(suiteIds(selections));
  });
});

describe("running everything", () => {
  const four = [
    suite({
      id: "workspace-unit",
      units: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
    }),
  ];

  it("gives each lane its own share and no unit twice", () => {
    const lanes = unitsPerLane(four, undefined, 3, "everything");
    expect(lanes.flat().toSorted()).toEqual([
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
    ]);
  });

  it("spreads the units rather than piling them into one lane", () => {
    // Nothing has measured any of these, so they cost the same as one
    // another. Costing them nothing would make every lane after the
    // first look more expensive than the one already holding the suite,
    // and the whole suite would land in lane one.
    const lanes = unitsPerLane(four, undefined, 4, "everything");
    expect(lanes.map((units) => units.length)).toEqual([1, 1, 1, 1]);
  });

  it("leaves out a unit a configuration declares unavailable", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        units: ["a.test.ts", "b.test.ts"],
        unavailable: [{ unit: "a.test.ts", reason: "not landed yet" }],
      }),
    ];
    expect(unitsPerLane(suites, undefined, 1, "everything")[0])
      .toEqual(["b.test.ts"]);
  });

  it("keeps a unit whose unavailability names only one leaf", () => {
    const suites = [
      suite({
        id: "package-integration-on",
        units: ["a.test.ts", "b.test.ts"],
        unavailable: [{
          unit: "a.test.ts",
          leafName: "bakes > slowly",
          reason: "that step's surface has not landed",
        }],
      }),
    ];
    expect(unitsPerLane(suites, undefined, 1, "everything")[0])
      .toEqual(["a.test.ts", "b.test.ts"]);
  });
});

describe("how many lanes the full run asks for", () => {
  const options = {
    lane: 1,
    of: 1,
    full: true,
    dryRun: true,
    laneCount: true,
    root: REPOSITORY,
  };

  /** A topology holding `count` units of one suite, each costing `cost`. */
  function corpus(count: number, cost: number) {
    const units = Array.from({ length: count }, (_, i) => `unit-${i}.test.ts`);
    return {
      topology: () => Promise.resolve([suite({ id: "workspace-unit", units })]),
      manifest: () =>
        Promise.resolve({
          manifest: manifestOf(units.map((unit, i) => ({
            test: { k: "unit", s: "bakery", n: `case ${i}` },
            unit,
            cost,
          }))),
          objectName: "manifest-fixture.json.gz",
        }),
    };
  }

  it("asks for one lane for work that fits in one", async () => {
    expect(await fullLanes(options, corpus(10, 1))).toBe(1);
  });

  it("asks for enough lanes that none of them runs long", async () => {
    const deps = corpus(FULL_LANE_BUDGET_SECONDS * 4, 1);
    expect(await fullLanes(options, deps)).toBe(4);
  });

  /**
   * A corpus with the shapes that make packing hard: several suites, the
   * measured skew the plan document records with a tenth of the tests
   * holding most of the time, capabilities whose setup a lane pays once,
   * fitted overheads, and one identity larger than a whole lane.
   */
  function awkward() {
    const suites = [
      suite({ id: "workspace-unit", needs: ["deno"], units: [] }),
      suite({
        id: "pattern-integration",
        needs: ["deno", "browser"],
        units: [],
      }),
      suite({ id: "cli-core", needs: ["deno", "toolshed"], units: [] }),
    ].map((s, i) => ({
      ...s,
      units: Array.from({ length: 40 }, (_, u) => `s${i}/unit-${u}.test.ts`),
    }));
    const entries = suites.flatMap((s, i) =>
      s.units.map((unit, u) => ({
        test: { k: "unit", s: "bakery", n: `s${i} case ${u}` },
        suite: s.id,
        unit,
        // A tenth of them hold most of the time, and one is larger than
        // any lane can hold.
        cost: u === 0 && i === 0
          ? FULL_LANE_BUDGET_SECONDS * 2
          : u % 10 === 0
          ? 40
          : 0.4,
      }))
    );
    const manifest = manifestOf(entries);
    manifest.calibration = {
      setupCost: { deno: 15, browser: 60, toolshed: 45 },
      suites: Object.fromEntries(
        suites.map((
          s,
        ) => [s.id, { overhead: 12, correction: 1.3, unitOverhead: 0 }]),
      ),
      prologue: 40,
    };
    return {
      suites,
      topology: () => Promise.resolve(suites),
      manifest: () =>
        Promise.resolve({ manifest, objectName: "manifest-fixture.json.gz" }),
    };
  }

  it("gives every unit a lane at the count it asked for", async () => {
    // The integer is the whole of what the job ahead of the full run
    // emits, so it has to be a count the lanes can honor. Every identity
    // placed exactly once is the property that matters: what the full
    // run does not run, nothing runs.
    const deps = awkward();
    const lanes = await fullLanes(options, deps);
    const seen = census(
      deps.suites,
      (await deps.manifest()).manifest,
      new Set(),
    );
    const laid = plan({
      manifest: seen.manifest,
      mandatory: seen.mandatory,
      capabilities: capabilitiesBySuite(deps.suites),
      wholeUnits: wholeUnits(deps.suites),
      policy: "everything",
      lanes,
    });
    const placed = laid.lanes.flatMap((lane) =>
      lane.selections.map((s) => testIdentityKey(s.entry.test))
    );
    expect(placed.length).toBe(seen.manifest.entries.length);
    expect(new Set(placed).size).toBe(seen.manifest.entries.length);
    // The lanes the count was chosen for hold what it promised, save the
    // one carrying an identity larger than any lane, which carries it
    // alone because nothing else would fit beside it.
    const over = laid.lanes.filter((lane) =>
      lane.projectedSeconds > laid.budgetSeconds
    );
    expect(over.length).toBe(1);
    expect(over[0]!.selections.length).toBe(1);
  });

  it("gives every unit a lane when nothing has been measured", async () => {
    // The same property down the fallback path, where the count comes
    // from the shape of the topology rather than from a cost model.
    const deps = awkward();
    const lanes = await fullLanes(options, {
      topology: deps.topology,
      manifest: () => Promise.resolve({ absent: "the store is gone" }),
    });
    const seen = census(deps.suites, undefined, new Set());
    const laid = plan({
      manifest: seen.manifest,
      mandatory: seen.mandatory,
      capabilities: capabilitiesBySuite(deps.suites),
      wholeUnits: wholeUnits(deps.suites),
      policy: "everything",
      lanes,
    });
    const placed = laid.lanes.flatMap((lane) =>
      lane.selections.map((s) => testIdentityKey(s.entry.test))
    );
    expect(placed.length).toBe(120);
    expect(new Set(placed).size).toBe(120);
    expect(laid.overBudgetSeconds).toBe(0);
  });

  it("takes the topology's shape when a manifest knows none of it", async () => {
    // A manifest that arrived is not the question. One published before
    // this tree existed arrives and still knows none of it, and a cost
    // model reading it is as blind as one reading nothing.
    const suites = [
      suite({ id: "workspace-unit", units: ["a.test.ts", "b.test.ts"] }),
      suite({ id: "repo-gates", units: ["deno-fmt"] }),
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(line);
    let lanes: number;
    try {
      lanes = await fullLanes(options, {
        topology: () => Promise.resolve(suites),
        manifest: () =>
          Promise.resolve({
            manifest: manifestOf([{ unit: "somewhere/else.test.ts" }]),
            objectName: "manifest-fixture.json.gz",
          }),
      });
    } finally {
      console.error = error;
    }
    expect(lanes).toBe(2);
    expect(errors.join("\n")).toContain("measured");
  });

  it("grows the fallback with the units, not only with the suites", async () => {
    // A repository can gain units without gaining a suite, and the suite
    // count alone would not notice. Two suites here hold more units than
    // two lanes can, so the count comes from packing them instead.
    const perLane = Math.floor(
      FULL_LANE_BUDGET_SECONDS / UNMEASURED_COST_SECONDS,
    );
    const suites = [0, 1].map((i) =>
      suite({
        id: `suite-${i}`,
        units: Array.from(
          { length: perLane + 40 },
          (_, u) => `s${i}/unit-${u}.test.ts`,
        ),
      })
    );
    const lanes = await fullLanes(options, {
      topology: () => Promise.resolve(suites),
      manifest: () => Promise.resolve({ absent: "the store is gone" }),
    });
    expect(lanes).toBeGreaterThan(suites.length);
    expect(lanes).toBe(Math.ceil((perLane + 40) * 2 / perLane));
  });

  it("charges a stand-in what the census charged it, not the dial", async () => {
    // A suite whose measured units have all been renamed away carries
    // what the units it lost cost onto every stand-in, so the units cost
    // far more than the bare unmeasured figure. A count that assumed the
    // figure would be out by that whole multiple, and each lane would
    // run past the bound its job is killed at.
    const units = Array.from({ length: 300 }, (_, i) => `new/u-${i}.test.ts`);
    const suites = [suite({ id: "pattern-integration", units })];
    const renamed = manifestOf(
      Array.from({ length: 50 }, (_, i) => ({
        test: { k: "unit", s: "bakery", n: `old ${i}` },
        suite: "pattern-integration",
        unit: `old/u-${i}.test.ts`,
        cost: 40,
      })),
    );
    const lanes = await fullLanes(options, {
      topology: () => Promise.resolve(suites),
      manifest: () =>
        Promise.resolve({ manifest: renamed, objectName: "m.json.gz" }),
    });
    const seen = census(suites, renamed, new Set());
    expect(seen.unmeasured).toBe(seen.manifest.entries.length);
    expect(seen.manifest.entries[0]!.cost).toBe(40);
    const laid = plan({
      manifest: seen.manifest,
      mandatory: seen.mandatory,
      capabilities: capabilitiesBySuite(suites),
      wholeUnits: wholeUnits(suites),
      policy: "everything",
      lanes,
    });
    expect(laid.overBudgetSeconds).toBe(0);
  });

  it("takes the topology's shape when there is no manifest", async () => {
    // Nothing has a measured cost, so a projection from costs would be
    // arithmetic over an invented figure, and being wrong downward means
    // every lane runs past the bound its job is killed at.
    const suites = [
      suite({ id: "workspace-unit", units: ["a.test.ts", "b.test.ts"] }),
      suite({ id: "repo-gates", units: ["deno-fmt"] }),
      suite({
        id: "package-integration-opposite",
        units: ["c.test.ts"],
        unavailable: [{ unit: "c.test.ts", reason: "not in this posture" }],
      }),
    ];
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(line);
    let lanes: number;
    try {
      lanes = await fullLanes(options, {
        topology: () => Promise.resolve(suites),
        manifest: () => Promise.resolve({ absent: "the store is gone" }),
      });
    } finally {
      console.error = error;
    }
    // A lane for each suite with anything to run, so the suite whose
    // every unit this configuration declares unavailable takes none.
    expect(lanes).toBe(2);
    expect(errors.join("\n")).toContain("measured");
  });

  it("answers with an integer on its own, and exits zero", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    let status: number;
    try {
      status = await main(
        ["--full", "--lane-count"],
        REPOSITORY,
        corpus(10, 1),
      );
    } finally {
      console.log = log;
    }
    expect(status).toBe(0);
    expect(lines).toEqual(["1"]);
  });
});

describe("what the two runs agree about", () => {
  const bakery = [
    suite({
      id: "workspace-unit",
      units: ["packages/bakery/glaze.test.ts", "packages/bakery/proof.test.ts"],
      unavailable: [{
        unit: "packages/bakery/gone.test.ts",
        reason: "not in this configuration",
      }],
    }),
  ];

  /**
   * A manifest naming a unit this tree does not have and one it declares
   * unavailable, which is what a manifest published before the tree
   * changed looks like.
   */
  const stale = manifestOf([
    { unit: "packages/bakery/glaze.test.ts" },
    {
      test: { k: "unit", s: "bakery", n: "gone > entirely" },
      unit: "packages/bakery/gone.test.ts",
    },
    {
      test: { k: "unit", s: "bakery", n: "deleted > long ago" },
      unit: "packages/bakery/deleted.test.ts",
    },
  ]);

  it("runs the same units in both, since both read the same tree", () => {
    const full = unitsPerLane(bakery, stale, 1, "everything")[0];
    const budgeted = unitsPerLane(bakery, stale, 1)[0];
    expect(full).toEqual([
      "packages/bakery/glaze.test.ts",
      "packages/bakery/proof.test.ts",
    ]);
    expect(budgeted).toEqual(full);
  });

  it("selects the same set as a full run when nothing is scarce", () => {
    // The one difference between the two policies is what a run can
    // afford. Given a budget nothing exhausts and a corpus nothing is
    // withheld from, they must choose the same tests; if they ever stop
    // doing so, something has been added to one and not the other.
    const suites = [
      suite({
        id: "workspace-unit",
        units: Array.from({ length: 12 }, (_, i) => `unit-${i}.test.ts`),
      }),
    ];
    const seen = census(suites, undefined, new Set());
    const shared = {
      manifest: seen.manifest,
      mandatory: new Map<string, SelectionReason>(),
      capabilities: capabilitiesBySuite(suites),
      wholeUnits: wholeUnits(suites),
      lanes: 3,
      budgetSeconds: 1_000_000,
    };
    const full = plan({ ...shared, policy: "everything" as const });
    const budgeted = plan(shared);
    const keys = (result: ReturnType<typeof plan>) =>
      result.lanes.flatMap((lane) =>
        lane.selections.map((s) => testIdentityKey(s.entry.test))
      ).toSorted();
    expect(keys(budgeted)).toEqual(keys(full));
  });
});

describe("running a lane's work", () => {
  const lane = {
    lane: 1,
    of: 5,
    full: false,
    dryRun: false,
    laneCount: false,
    root: REPOSITORY,
  };

  /** A suite that runs the command a case gives it. */
  function runnable(command: readonly string[], id = "probe"): Suite {
    return suite({
      id,
      units: ["one"],
      command: (_units, context) =>
        Promise.resolve([{ command: [...command], cwd: context.root }]),
    });
  }

  it("reports what an invocation cost and whether it passed", async () => {
    const ok = await runInvocation(
      { command: [Deno.execPath(), "eval", "0"], cwd: Deno.cwd() },
      {},
    );
    expect(ok.ok).toBe(true);
    expect(ok.seconds).toBeGreaterThan(0);
    const bad = await runInvocation(
      { command: [Deno.execPath(), "eval", "Deno.exit(3)"], cwd: Deno.cwd() },
      {},
    );
    expect(bad.ok).toBe(false);
  });

  it("hands a measured batch the directory and members to measure", async () => {
    // The suite decides where under that directory each member's
    // profiles land, so what the lane passes is the directory and which
    // members are being scored.
    const workDir = await Deno.makeTempDir({ prefix: "lane-batch-" });
    let given: CommandContext | undefined;
    const recording: Suite = {
      id: "workspace-unit",
      recordSurfaces: [{ kind: "unit", scope: "bakery" }],
      needs: [],
      units: ["packages/bakery/glaze.test.ts"],
      unavailable: [],
      whole: [],
      locate: () => undefined,
      command: (_units, context) => {
        given = context;
        return Promise.resolve([]);
      },
    };
    await runBatch(
      {
        suite: recording,
        units: [{ unit: "packages/bakery/glaze.test.ts", skip: [] }],
        runs: new Map([["packages/bakery/glaze.test.ts", 1]]),
      },
      lane,
      workDir,
      undefined,
      {},
      { dir: "/cov/workspace-unit", members: new Set(["packages/bakery"]) },
    );
    expect(given?.coverageDir).toBe("/cov/workspace-unit");
    expect([...(given?.measuredMembers ?? [])]).toEqual(["packages/bakery"]);
    await Deno.remove(workDir, { recursive: true });
  });

  it("measures every member a full run's batch holds", async () => {
    const workDir = await Deno.makeTempDir({ prefix: "lane-batch-" });
    let given: CommandContext | undefined;
    const recording: Suite = {
      id: "workspace-unit",
      recordSurfaces: [{ kind: "unit", scope: "bakery" }],
      needs: [],
      units: ["packages/bakery/glaze.test.ts"],
      unavailable: [],
      whole: [],
      locate: () => undefined,
      command: (_units, context) => {
        given = context;
        return Promise.resolve([]);
      },
    };
    await runBatch(
      {
        suite: recording,
        units: [{ unit: "packages/bakery/glaze.test.ts", skip: [] }],
        runs: new Map([["packages/bakery/glaze.test.ts", 1]]),
      },
      { ...lane, full: true },
      workDir,
      undefined,
      {},
      { dir: "/cov/workspace-unit" },
    );
    expect(given?.coverageDir).toBe("/cov/workspace-unit");
    expect(given?.measuredMembers).toBeUndefined();
    await Deno.remove(workDir, { recursive: true });
  });

  it("runs a batch once per repeat, and every one must pass", async () => {
    // A repeat is not a retry: three runs of a test is strictly stricter
    // than one, so a batch that fails once has failed.
    const workDir = await Deno.makeTempDir({ prefix: "lane-batch-" });
    const passing = await runBatch(
      {
        suite: runnable([Deno.execPath(), "eval", "0"]),
        units: [{ unit: "a-unit", skip: [] }],
        runs: new Map([["a-unit", 3]]),
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(passing.ok).toBe(true);

    const failing = await runBatch(
      {
        suite: runnable([Deno.execPath(), "eval", "Deno.exit(1)"], "red"),
        units: [{ unit: "a-unit", skip: [] }],
        runs: new Map([["a-unit", 2]]),
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(failing.ok).toBe(false);
    await Deno.remove(workDir, { recursive: true });
  });

  it("keeps the records a batch's producers wrote", async () => {
    // Each execution writes into a spool of its own and is gathered
    // before another can reuse a runner-owned path.
    const workDir = await Deno.makeTempDir({ prefix: "lane-records-" });
    const written = JSON.stringify({
      line: "record",
      test: { k: "gate", s: "repo", n: "probe" },
      outcome: "pass",
      durationMs: 1,
    });
    const result = await runBatch(
      {
        suite: runnable([
          Deno.execPath(),
          "eval",
          `Deno.writeTextFileSync(
            Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-a.ndjson",
            ${JSON.stringify(written + "\n")},
          )`,
        ]),
        units: [{ unit: "a-unit", skip: [] }],
        runs: new Map([["a-unit", 1]]),
      },
      lane,
      workDir,
      undefined,
      {},
    );
    expect(result.records.map((record) => record.test.n)).toEqual(["probe"]);
    await Deno.remove(workDir, { recursive: true });
  });

  it("says which manifest it read and what it will run", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [{
          suite: runnable(["true"], "workspace-unit"),
          units: [{ unit: "a-unit", skip: [] }],
          runs: new Map([["a-unit", 2]]),
        }],
        ["deno", "toolshed"],
        { objectName: "manifest-x.json.gz" },
        [{
          test: { k: "unit", s: "toolshed", n: "build-binary toolshed" },
          suite: "binaries",
          cost: 900,
        }],
        [],
        { manifest: manifestOf([]), selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("manifest-x.json.gz");
    expect(printed).toContain("deno, toolshed");
    expect(printed).toContain("workspace-unit");
    // What no lane can hold is named rather than left silently absent.
    expect(printed).toContain("build-binary toolshed");
  });

  it("names a suite no lane can hold instead of each test in it", () => {
    // Thousands of identities of one suite are all past the bound by the
    // suite's fixed charge and by nothing about themselves. The summary
    // names the costliest few, so left in they are all it has room for,
    // and every one of them names a test that is not the problem while
    // the suite that is goes unnamed.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [],
        [],
        { objectName: "manifest-x.json.gz" },
        [{
          test: { k: "unit", s: "bakery", n: "glaze > sets" },
          suite: "workspace-unit",
          cost: 706,
        }, {
          test: { k: "unit", s: "toolshed", n: "build-binary toolshed" },
          suite: "binaries",
          cost: 900,
        }],
        [{
          suite: "workspace-unit",
          fixed: 705,
          identities: 21889,
          heldNowhere: 21889,
        }],
        { manifest: manifestOf([]), selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("workspace-unit costs 705.0s before it runs");
    expect(printed).toContain("21889 tests");
    expect(printed).not.toContain("glaze > sets");
    // A suite a lane can hold still names the test that cannot fit in it.
    expect(printed).toContain("build-binary toolshed");
  });

  it("says a suite is taking a lane per test where it is", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [],
        [],
        { objectName: "manifest-x.json.gz" },
        [],
        [{
          suite: "workspace-unit",
          fixed: 250,
          identities: 12,
          heldNowhere: 0,
        }],
        { manifest: manifestOf([]), selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n"))
      .toContain(
        "each of the 12 tests it can still run takes a lane to itself",
      );
  });

  it("says what each batch costs and why each test is in it", () => {
    // "Why did my test not run" is the question a selected run provokes,
    // and a summary naming only the suites cannot begin to answer it.
    const entry: ManifestEntry = {
      test: { k: "unit", s: "bakery", n: "glaze > sets" },
      suite: "workspace-unit",
      unit: "packages/bakery/glaze.test.ts",
      cost: 1.5,
      score: 0.5,
      inputs: { catches: 0, sources: 0, churn: 0 },
      flakeRate: 0,
      repeats: 1,
    };
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [{
          suite: runnable(["true"], "workspace-unit"),
          units: [{ unit: "packages/bakery/glaze.test.ts", skip: [] }],
          runs: new Map([["packages/bakery/glaze.test.ts", 2]]),
        }],
        ["deno"],
        { objectName: "manifest-x.json.gz" },
        [],
        [],
        {
          manifest: manifestOf([]),
          selections: [{ entry, reason: "value", repeats: 2 }],
          projectedSeconds: 96,
        },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("Projected: 96s");
    expect(printed).toContain("3.0s");
    expect(printed).toContain("value 1");
    // Every cost in this lane was measured, so the projection stands on
    // nothing but measurements and the line says only what it comes to.
    expect(printed).not.toContain("nothing has measured");
  });

  /**
   * What `describePlan` prints for a lane holding these selections
   * against a suite whose correction is `correction`, projected at 96
   * seconds.
   */
  function projectionLine(
    selections: readonly Selection[],
    correction: number,
  ): string {
    const manifest = manifestOf([]);
    manifest.calibration.suites["workspace-unit"] = {
      overhead: 0,
      correction,
      unitOverhead: 0,
    };
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [],
        ["deno"],
        { objectName: "manifest-x.json.gz" },
        [],
        [],
        { manifest, selections, projectedSeconds: 96 },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
    }
    return lines.join("\n").split("\n")
      .find((line) => line.startsWith("Projected:")) ?? "";
  }

  /** A measured entry of the workspace unit suite, costing `cost`. */
  function measured(unit: string, cost: number): ManifestEntry {
    return {
      test: { k: "unit", s: "bakery", n: `${unit} > sets` },
      suite: "workspace-unit",
      unit: `packages/bakery/${unit}.test.ts`,
      cost,
      score: 0.5,
      inputs: { catches: 0, sources: 0, churn: 0 },
      flakeRate: 0,
      repeats: 1,
    };
  }

  /** A stand-in of that suite, charged what a suite of `costs` gives it. */
  function unmeasured(unit: string, costs: readonly number[]): ManifestEntry {
    return standIn(
      runnable(["true"], "workspace-unit"),
      `packages/bakery/${unit}.test.ts`,
      costs,
    );
  }

  it("says how much of the projection stands on unmeasured units", () => {
    // Two stand-ins beside a measured entry: one at 30 seconds run
    // twice, one at 25 run once, which is 85 of the 96 seconds
    // projected. The measured entry's own 4 are not in that figure.
    expect(
      projectionLine([
        { entry: measured("glaze", 4), reason: "value", repeats: 1 },
        { entry: unmeasured("proof", [30]), reason: "unknown", repeats: 2 },
        { entry: unmeasured("knead", [25]), reason: "unknown", repeats: 1 },
      ], 1),
    ).toBe(
      "Projected: 96s of 230s, 85s of it charged to 2 units " +
        "nothing has measured",
    );
  });

  it("reads a stand-in's seconds through its suite's correction", () => {
    // A suite whose batches run their files in parallel has a correction
    // below one, and the packer charged the stand-in at that. Reading
    // its bare cost instead would report 80 seconds of a 96-second
    // projection that holds 20.
    expect(projectionLine([
      { entry: unmeasured("proof", [40]), reason: "unknown", repeats: 2 },
    ], 0.25)).toBe(
      "Projected: 96s of 230s, 20s of it charged to 1 unit " +
        "nothing has measured",
    );
  });

  it("says it is running unselected when there is no manifest", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describePlan(
        lane,
        [],
        [],
        { absent: "the store is unreachable" },
        [],
        [],
        { manifest: manifestOf([]), selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("the store is unreachable");
  });

  it("names what the manifest withheld, and what came back", () => {
    const touched = { k: "unit", s: "bakery", n: "glaze > sets" };
    const untouched = { k: "unit", s: "bakery", n: "proof > rises" };
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeWithheld(
        [
          { test: touched, suite: "workspace-unit", reason: "flaky" },
          { test: untouched, suite: "workspace-unit", reason: "flaky" },
        ],
        new Map([[testIdentityKey(touched), "changed"]]),
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("too noisy to judge a change by");
    // The change reaches one of them, which is very likely a fix, so it
    // runs in spite of being withheld.
    expect(printed).toContain("yes, the change reaches it");
    expect(printed).toContain("| no |");
  });

  it("prints the end of a capability's log, saying what it dropped", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    const written = Array.from(
      { length: CAPABILITY_LOG_TAIL_LINES + 30 },
      (_unused, index) => `line ${index}`,
    );
    try {
      await describeCapabilityLogs(
        [{ capability: "toolshed", path: "/tmp/toolshed-1.log" }],
        () => Promise.resolve(`${written.join("\n")}\n`),
      );
    } finally {
      console.log = log;
    }
    const printed = lines.join("\n");
    expect(printed).toContain("--- toolshed log ---");
    expect(printed).toContain(
      `last ${CAPABILITY_LOG_TAIL_LINES} of ${written.length} ` +
        "line(s); 30 earlier dropped",
    );
    // The end is what a run that went wrong wrote last, so it is the end
    // that is kept.
    expect(printed).toContain(`line ${written.length - 1}`);
    expect(printed).not.toContain("line 29\n");
  });

  it("reports a log it could not read rather than throwing", async () => {
    // The lane is already failing when this runs, and a report that threw
    // would replace the failure it was printed beside.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await describeCapabilityLogs(
        [{ capability: "toolshed", path: "/tmp/never-written.log" }],
        () => Promise.reject(new Error("no such file")),
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("--- toolshed log ---");
    expect(lines.join("\n")).toContain("(unreadable:");
    expect(lines.join("\n")).toContain("no such file");
  });

  it("names the records no suite describes", () => {
    // The only report they get before the store half of the drift guard
    // fails on them on the next run on `main`.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeConflicts([{
        line: "record",
        test: { k: "integration", s: "runner", n: "attaches" },
        outcome: "pass",
        durationMs: 1,
      }]);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain(
      testIdentityKey({ k: "integration", s: "runner", n: "attaches" }),
    );
    expect(lines.join("\n")).toContain("kept as written");
  });

  it("says nothing when every record was one its suite describes", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeConflicts([]);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual([]);
  });

  it("says nothing about a manifest that withheld nothing", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeWithheld([], new Map());
    } finally {
      console.log = log;
    }
    expect(lines).toEqual([]);
  });
});

describe("planning a lane without running it", () => {
  it("plans the full run against the working tree", async () => {
    // What this reaches is the topology and the packing. Selection is
    // off, but the manifest is read either way for what things cost, so
    // the store is held out the way the no-share case holds it out:
    // otherwise this packs against whatever was published last.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    let ok: boolean;
    try {
      ok = await runLane({
        lane: 2,
        of: 5,
        full: true,
        dryRun: true,
        laneCount: false,
        root: REPOSITORY,
      }, {
        manifest: ({ at }) =>
          Promise.resolve({ absent: `no manifest at ${at}: held out here` }),
      });
    } finally {
      console.log = log;
    }
    expect(ok).toBe(true);
    const printed = lines.join("\n");
    expect(printed).toContain("Lane 2 of 5");
    // A lane's share of the full run is a real share of real suites,
    // measured against the full run's own budget rather than a pull
    // request's.
    expect(printed).toContain("workspace-unit");
    expect(printed).toContain(`of ${FULL_LANE_BUDGET_SECONDS}s`);
    expect(FULL_LANE_BUDGET_SECONDS).toBeLessThan(FULL_LANE_BOUND_SECONDS);
  });
});

describe("planning a lane the manifest chose", () => {
  const root = REPOSITORY;

  /** What a lane prints, with the store answering as a case describes. */
  async function planned(
    entries: readonly Partial<ManifestEntry>[],
    lane = 1,
  ): Promise<string> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane,
          of: 5,
          full: false,
          dryRun: true,
          laneCount: false,
          root,
          at: "2026-09-01T00:00:00Z",
        },
        {
          manifest: () =>
            Promise.resolve({
              manifest: manifestOf(entries),
              objectName: "manifest-fixture.json.gz",
            }),
        },
      );
    } finally {
      console.log = log;
    }
    return lines.join("\n");
  }

  it("refuses a lane the plan has no share for", async () => {
    // Taking an empty share instead would run nothing and exit zero,
    // reporting a pass over a set no lane ran.
    await expect(runLane(
      {
        lane: 3,
        of: 2,
        full: false,
        dryRun: true,
        laneCount: false,
        root,
        at: "2026-09-01T00:00:00Z",
      },
      {
        manifest: () =>
          Promise.resolve({
            manifest: manifestOf([{}]),
            objectName: "manifest-fixture.json.gz",
          }),
      },
    )).rejects.toThrow("lane 3 has no share of a plan for 2 lanes");
  });

  it("names the manifest it planned from", async () => {
    const printed = await planned([]);
    expect(printed).toContain("manifest-fixture.json.gz");
  });

  it("gives the five lanes the whole corpus, and no unit twice", async () => {
    // Every lane packs the same manifest over the same inputs and takes
    // its own share, so the five partition the work by construction
    // rather than by anything coordinating them.
    const counted = (printed: string): number =>
      printed.split("\n")
        .map((line) => /^\| \S+ \| (\d+) \| /.exec(line))
        .reduce((total, row) => total + (row === null ? 0 : Number(row[1])), 0);
    let placed = 0;
    for (const lane of [1, 2, 3, 4, 5]) {
      placed += counted(await planned([], lane));
    }
    const suites = await loadTopology(root);
    const available = suites.reduce(
      (total, suite) =>
        total + suite.units.length -
        suite.unavailable.filter((entry) => entry.leafName === undefined)
          .length,
      0,
    );
    expect(placed).toBe(available);
  });

  it("runs everything when the store has no manifest to give", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        { lane: 1, of: 5, full: false, dryRun: true, laneCount: false, root },
        { manifest: () => Promise.resolve({ absent: "the store is gone" }) },
      );
    } finally {
      console.log = log;
    }
    // A lane with no manifest runs the mandatory set plus a
    // deterministic slice rather than failing, so pull requests keep
    // flowing while the store is unreachable.
    const printed = lines.join("\n");
    expect(printed).toContain("the store is gone");
    expect(printed).toContain("workspace-unit");
  });
});

describe("the lane's own housekeeping", () => {
  const root = REPOSITORY;

  it("answers with the status the job would exit with", async () => {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      // A command line this cannot read is a usage error rather than a
      // lane that ran nothing and reported success, and nothing asks
      // where the manifest is on the way there.
      let asked = 0;
      expect(
        await main(["--shard", "1/5"], REPOSITORY, {
          manifest: () => {
            asked += 1;
            return Promise.resolve({ manifest: manifestOf([{}]) });
          },
        }),
      ).toBe(2);
      expect(asked).toBe(0);
      expect(
        await main(
          ["--lane", "1", "--of", "1", "--full", "--dry-run"],
          REPOSITORY,
          {
            topology: () =>
              Promise.resolve([
                suite({
                  id: "workspace-unit",
                  units: ["packages/bakery/glaze.test.ts"],
                }),
              ]),
            manifest: () => Promise.resolve({ manifest: manifestOf([{}]) }),
          },
        ),
      ).toBe(0);
    } finally {
      console.log = log;
      console.error = err;
    }
  });

  it("reads the two flags that carry no value", () => {
    const options = parseLaneArgs(["--full", "--dry-run", "--lane", "2"]);
    expect(options?.full).toBe(true);
    expect(options?.dryRun).toBe(true);
    expect(parseLaneArgs(["--base"])).toBeUndefined();
  });

  it("takes the files a change touched from the diff", async () => {
    const repo = await Deno.makeTempDir({ prefix: "lane-diff-" });
    const git = (...args: string[]) =>
      new Deno.Command("git", {
        args,
        cwd: repo,
        env: {
          ...Deno.env.toObject(),
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: "a@example.com",
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: "a@example.com",
        },
        stdout: "null",
        stderr: "null",
      }).output();
    await git("init", "-q");
    await Deno.writeTextFile(`${repo}/kept.ts`, "a");
    await git("add", ".");
    await git("commit", "-q", "-m", "first");
    await git("branch", "base");
    await Deno.writeTextFile(`${repo}/added.test.ts`, "b");
    await git("add", ".");
    await git("commit", "-q", "-m", "second");
    expect([...await changedFiles(repo, "base")]).toEqual(["added.test.ts"]);
    // With no base there is no change to speak of, which is what the
    // full run on `main` asks for.
    expect([...await changedFiles(repo, undefined)]).toEqual([]);
    // A diff that cannot be taken is not a change-free pull request:
    // reading it as one would drop every changed unit without a word.
    await expect(changedFiles(repo, "no-such-ref")).rejects.toThrow(
      "cannot diff",
    );
    await Deno.remove(repo, { recursive: true });
  });

  it("writes the plan into the job summary as well as the log", async () => {
    const summary = await Deno.makeTempFile({ prefix: "summary-" });
    const previous = Deno.env.get("GITHUB_STEP_SUMMARY");
    Deno.env.set("GITHUB_STEP_SUMMARY", summary);
    const log = console.log;
    console.log = () => {};
    try {
      describePlan(
        { lane: 1, of: 5, full: false, dryRun: true, laneCount: false, root },
        [],
        [],
        { objectName: "manifest-x.json.gz" },
        [],
        [],
        { manifest: manifestOf([]), selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
      else Deno.env.set("GITHUB_STEP_SUMMARY", previous);
    }
    expect(await Deno.readTextFile(summary)).toContain("manifest-x.json.gz");
    await Deno.remove(summary);
  });

  it("names the costliest of what no lane can run, and counts the rest", async () => {
    // A cost model charging a whole suite more than a lane can hold puts
    // every test in that suite on this list. A bullet each is more than
    // a job summary holds, and GitHub drops a summary past its bound
    // whole rather than shortening it.
    const summary = await Deno.makeTempFile({ prefix: "summary-" });
    const previous = Deno.env.get("GITHUB_STEP_SUMMARY");
    Deno.env.set("GITHUB_STEP_SUMMARY", summary);
    const log = console.log;
    console.log = () => {};
    // Cheapest first, so an order the summary keeps as given would show.
    const tooSlow = Array.from({ length: 25 }, (_, at) => ({
      test: { k: "unit" as const, s: "memory", n: `test ${at}` },
      suite: "workspace-unit",
      cost: 900 + at,
    }));
    try {
      describePlan(
        { lane: 1, of: 5, full: false, dryRun: true, laneCount: false, root },
        [],
        [],
        { objectName: "manifest-x.json.gz" },
        tooSlow,
        [],
        { manifest: manifestOf([]), selections: [], projectedSeconds: 0 },
        LANE_BUDGET_SECONDS,
      );
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("GITHUB_STEP_SUMMARY");
      else Deno.env.set("GITHUB_STEP_SUMMARY", previous);
    }
    const held = await Deno.readTextFile(summary);
    const named = held.split("\n").filter((line) => line.startsWith("- work"));
    expect(named).toHaveLength(10);
    expect(named[0]).toContain("test 24");
    expect(named[0]).toContain("924s");
    expect(named.at(-1)).toContain("test 15");
    expect(held).toContain("- and 15 more");
    await Deno.remove(summary);
  });

  it("fails a lane whose coverage would not convert", async () => {
    // A conversion that lost a tracked file leaves a report every line
    // of which reads as uncovered, so a gate scored from it would fail
    // somebody for a report that was never complete.
    const root = await Deno.makeTempDir({ prefix: "lane-convert-" });
    const temp = await Deno.makeTempDir({ prefix: "lane-tmp-" });
    const previous = Deno.env.get("TMPDIR");
    Deno.env.set("TMPDIR", temp);
    const dir =
      `${root}/coverage/${COVERAGE_PROFILE_DIR}/workspace-unit/packages__bakery`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/broken.json`, "this is not a profile");
    const bare: Suite = {
      id: "workspace-unit",
      recordSurfaces: [{ kind: "unit", scope: "bakery" }],
      needs: [],
      units: [],
      unavailable: [],
      whole: [],
      locate: () => undefined,
      command: () => Promise.resolve([]),
    };
    const log = console.log;
    console.log = () => {};
    let ok: boolean;
    try {
      ok = await runLane({
        lane: 1,
        of: 1,
        full: true,
        dryRun: false,
        laneCount: false,
        root,
      }, {
        topology: () => Promise.resolve([bare]),
        manifest: ({ at }) =>
          Promise.resolve({ absent: `no manifest at ${at}: held out here` }),
      });
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("TMPDIR");
      else Deno.env.set("TMPDIR", previous);
    }
    expect(ok).toBe(false);
    await Deno.remove(temp, { recursive: true });
    await Deno.remove(root, { recursive: true });
  });

  it("gives its work directory back when a capability will not open", async () => {
    // The directory belongs to the lane from the moment it exists, so a
    // capability that refuses is not a reason to leave one behind.
    const root = await Deno.makeTempDir({ prefix: "lane-caps-" });
    const temp = await Deno.makeTempDir({ prefix: "lane-tmp-" });
    const previous = Deno.env.get("TMPDIR");
    Deno.env.set("TMPDIR", temp);
    const wanting: Suite = {
      id: "wanting",
      recordSurfaces: [{ kind: "unit", scope: "wanting" }],
      needs: ["nothing-opens-this" as CapabilityId],
      units: ["packages/bakery/glaze.test.ts"],
      unavailable: [],
      whole: [],
      locate: () => undefined,
      command: () => Promise.resolve([]),
    };
    const log = console.log;
    console.log = () => {};
    try {
      await expect(runLane({
        lane: 1,
        of: 1,
        full: true,
        dryRun: false,
        laneCount: false,
        root,
      }, {
        topology: () => Promise.resolve([wanting]),
        manifest: ({ at }) =>
          Promise.resolve({ absent: `no manifest at ${at}: held out here` }),
      })).rejects.toThrow();
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("TMPDIR");
      else Deno.env.set("TMPDIR", previous);
    }
    expect([...Deno.readDirSync(temp)]).toEqual([]);
    await Deno.remove(temp, { recursive: true });
    await Deno.remove(root, { recursive: true });
  });

  it("runs a lane that was given no share of the work", async () => {
    // The whole path, with nothing in it: no capability is opened, no
    // batch runs, and the directory the lane made for itself goes.
    //
    // The lane is given a temporary root of its own to make that in.
    // The shared one is a namespace every test file writes to at once,
    // so a check over it would answer about its neighbours rather than
    // about this lane.
    // The spool is made before the temporary root is redirected, so it
    // does not end up inside the directory this then checks and clears.
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    const temp = await Deno.makeTempDir({ prefix: "lane-tmp-" });
    const previous = Deno.env.get("TMPDIR");
    Deno.env.set("TMPDIR", temp);
    // The spool is what makes the lane reach the point where it would
    // record what its setup cost. It opened nothing, so there is
    // nothing to record.
    const previousSpool = Deno.env.get("CF_TEST_RECORDS_DIR");
    Deno.env.set("CF_TEST_RECORDS_DIR", spool);
    const log = console.log;
    console.log = () => {};
    let ok: boolean;
    try {
      ok = await runLane({
        lane: 2,
        of: 2,
        full: true,
        dryRun: false,
        laneCount: false,
        root,
        coverageDir: `${spool}/coverage`,
      }, {
        // One unit fills the first lane, leaving this lane empty.
        topology: () =>
          Promise.resolve([
            suite({
              id: "workspace-unit",
              units: ["packages/bakery/glaze.test.ts"],
              command: () => {
                throw new Error("an empty lane must run no batch");
              },
            }),
          ]),
        manifest: ({ at }) =>
          Promise.resolve({ absent: `no manifest at ${at}: held out here` }),
      });
    } finally {
      console.log = log;
      if (previous === undefined) Deno.env.delete("TMPDIR");
      else Deno.env.set("TMPDIR", previous);
      if (previousSpool === undefined) Deno.env.delete("CF_TEST_RECORDS_DIR");
      else Deno.env.set("CF_TEST_RECORDS_DIR", previousSpool);
    }
    expect(ok).toBe(true);
    // Named rather than counted: the private root keeps other test
    // files out, and anything else this process makes a temporary
    // directory for lands here too.
    const left = (await Array.fromAsync(Deno.readDir(temp)))
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("ci-lane-"));
    expect(left).toEqual([]);
    // Narrower than an empty spool: anything else in this process that
    // records writes there too once the variable is set.
    const spooled = (await Promise.all(
      (await Array.fromAsync(Deno.readDir(spool)))
        .filter((entry) => entry.isFile)
        .map((entry) => Deno.readTextFile(`${spool}/${entry.name}`)),
    )).join("");
    expect(spooled).not.toContain("ci-lane setup");
    await Deno.remove(temp, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  });
});

describe("what a lane records about itself", () => {
  const lane = {
    lane: 1,
    of: 5,
    full: false,
    dryRun: false,
    laneCount: false,
    root: REPOSITORY,
  };

  it("records what each batch cost, beside the records it gathered", async () => {
    // The publisher fits the suite overheads and corrections from these,
    // so they travel as ordinary records rather than a pipeline of their
    // own — and they stay unmarked, because they measure the lane rather
    // than an alternate execution of a test.
    const workDir = await Deno.makeTempDir({ prefix: "lane-timing-" });
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    const report = `${workDir}/report.xml`;
    const suiteUnderTest = suite({
      id: "workspace-unit",
      units: ["one"],
      command: (_units, context) =>
        Promise.resolve([{
          command: [
            Deno.execPath(),
            "eval",
            `Deno.writeTextFileSync(${JSON.stringify(report)}, ${
              JSON.stringify(
                '<?xml version="1.0"?><testsuites><testsuite name="s" ' +
                  'tests="1" failures="0"><testcase name="bakes" ' +
                  'classname="test/bake.test.ts" time="0.25"/></testsuite>' +
                  "</testsuites>",
              )
            })`,
          ],
          cwd: context.root,
          junit: [{
            path: report,
            kind: "unit",
            scope: "bakery",
            filePrefix: "packages/bakery",
          }],
        }]),
    });
    const result = await runBatch(
      { suite: suiteUnderTest, units: [], runs: new Map() },
      lane,
      workDir,
      spool,
      {},
    );
    expect(result.ok).toBe(true);
    // The report's case reaches the lane's records with its file joined on.
    expect(result.records.map((record) => record.test.n)).toEqual(["bakes"]);
    expect(result.records[0]!.file).toBe("packages/bakery/test/bake.test.ts");

    const spooled: string[] = [];
    for await (const entry of Deno.readDir(spool)) {
      if (entry.isFile) {
        spooled.push(await Deno.readTextFile(`${spool}/${entry.name}`));
      }
    }
    const written = spooled.join("");
    expect(written).toContain("ci-lane batch workspace-unit");
    expect(written).toContain('"s":"ci"');
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  });

  it("reads back the suite and the coverage a batch measurement names", () => {
    // One place composes the name and one place takes it apart, so a
    // reader that took it apart itself could not part company with the
    // writer.
    expect(batchMeasurement(batchMeasurementName("workspace-unit", false)))
      .toEqual({ suite: "workspace-unit", measured: false, kind: "spent" });
    expect(batchMeasurement(batchMeasurementName("workspace-unit", true)))
      .toEqual({ suite: "workspace-unit", measured: true, kind: "spent" });
    expect(batchMeasurement("ci-lane setup deno")).toBeUndefined();
    expect(batchMeasurement("ci-lane batch ")).toBeUndefined();
  });

  it("names what a measured batch cost apart from an unmeasured one", async () => {
    // Instrumenting a run costs it time, and how much is a property of
    // the suite rather than a constant, so the name records which kind of
    // run the measurement came from.
    const spooledNames = async (coverage?: { dir: string }) => {
      const workDir = await Deno.makeTempDir({ prefix: "lane-measured-" });
      const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
      try {
        await runBatch(
          {
            suite: suite({ id: "workspace-unit", units: ["one"] }),
            units: [],
            runs: new Map(),
          },
          lane,
          workDir,
          spool,
          {},
          coverage,
        );
        const written: string[] = [];
        for await (const entry of Deno.readDir(spool)) {
          if (entry.isFile) {
            written.push(await Deno.readTextFile(`${spool}/${entry.name}`));
          }
        }
        return written.join("");
      } finally {
        await Deno.remove(workDir, { recursive: true });
        await Deno.remove(spool, { recursive: true });
      }
    };
    expect(await spooledNames()).toContain('ci-lane batch workspace-unit"');
    expect(await spooledNames({ dir: "/coverage" })).toContain(
      `ci-lane batch workspace-unit${MEASURED_BATCH_SUFFIX}`,
    );
  });

  it("writes what a batch spent beside what its tests took", async () => {
    // The publisher fits a suite's cost beyond its tests from the pair,
    // and reads a batch only where both halves are there. The tests' own
    // time is summed as the batch runs rather than read back afterwards,
    // because a reader of the report cannot tell which of its records
    // came from which batch.
    const workDir = await Deno.makeTempDir({ prefix: "lane-ran-" });
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    // The second is off the suite's declared surfaces, so it arrives as a
    // conflict rather than as one of the batch's records. The batch spent
    // that time all the same, so it is in the figure.
    const records = [
      { k: "unit", s: "workspace", n: "takes 250ms", durationMs: 250 },
      { k: "unit", s: "elsewhere", n: "takes 1750ms", durationMs: 1750 },
    ].map(({ durationMs, ...test }) =>
      JSON.stringify({ line: "record", test, outcome: "pass", durationMs })
    ).join("\n");
    try {
      await runBatch(
        {
          suite: suite({
            id: "workspace-unit",
            units: ["one"],
            recordSurfaces: [{ kind: "unit", scope: "workspace" }],
            command: (_units, context) =>
              Promise.resolve([{
                command: [
                  Deno.execPath(),
                  "eval",
                  `Deno.writeTextFileSync(
                    Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-a.ndjson",
                    ${JSON.stringify(records + "\n")},
                  )`,
                ],
                cwd: context.root,
              }]),
          }),
          units: [{ unit: "one", skip: [] }],
          runs: new Map([["one", 1]]),
        },
        lane,
        workDir,
        spool,
        {},
      );
      const written: string[] = [];
      for await (const entry of Deno.readDir(spool)) {
        if (entry.isFile) {
          written.push(await Deno.readTextFile(`${spool}/${entry.name}`));
        }
      }
      const spooled = written.join("");
      expect(spooled).toContain('ci-lane batch workspace-unit"');
      expect(spooled).toContain('ci-lane ran batch workspace-unit"');
      // Both records' own time and nothing else. The figure travels as a
      // duration, so it arrives in milliseconds.
      expect(spooled).toContain(
        '"n":"ci-lane ran batch workspace-unit"},"outcome":"pass"' +
          ',"durationMs":2000',
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
      await Deno.remove(spool, { recursive: true });
    }
  });

  /**
   * A batch whose one invocation spools exactly this record, run against
   * a suite declaring the surface and variant given.
   */
  async function spooling(
    record: TestIdentity,
    declared: Partial<Suite>,
  ): Promise<{
    ok: boolean;
    records: TestRecord[];
    conflicts: TestRecord[];
  }> {
    const workDir = await Deno.makeTempDir({ prefix: "lane-variant-" });
    const written = JSON.stringify({
      line: "record",
      test: record,
      outcome: "pass",
      durationMs: 1,
    });
    try {
      return await runBatch(
        {
          suite: suite({
            id: "package-integration-on",
            units: ["one"],
            command: (_units, context) =>
              Promise.resolve([{
                command: [
                  Deno.execPath(),
                  "eval",
                  `Deno.writeTextFileSync(
                    Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-a.ndjson",
                    ${JSON.stringify(written + "\n")},
                  )`,
                ],
                cwd: context.root,
              }]),
            ...declared,
          }),
          units: [{ unit: "a-unit", skip: [] }],
          runs: new Map([["a-unit", 1]]),
        },
        lane,
        workDir,
        undefined,
        {},
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  }

  it("marks a batch's records with the variant its suite declares", async () => {
    // A variant belongs to the suite that ran, not to the producer that
    // reported, so it is written on regardless of what the producer said.
    const result = await spooling(
      { k: "integration", s: "runner", n: "attaches" },
      {
        variant: "server-execution",
        recordSurfaces: [{ kind: "integration", scope: "runner" }],
      },
    );
    expect(result.records[0]!.test.v).toBe("server-execution");
    expect(result.conflicts).toEqual([]);
  });

  it("leaves a record off the suite's surfaces as its producer wrote it", async () => {
    const result = await spooling(
      { k: "integration", s: "runner", n: "attaches" },
      {
        variant: "server-execution",
        recordSurfaces: [{ kind: "integration", scope: "shell" }],
      },
    );
    expect(result.records[0]!.test.v).toBeUndefined();
    expect(result.conflicts.length).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("reports a producer's own variant in a default batch", async () => {
    // The execution was a default one, so a marker on its record
    // describes a configuration that did not run.
    const result = await spooling(
      {
        k: "integration",
        s: "runner",
        n: "attaches",
        v: "server-execution",
      },
      { recordSurfaces: [{ kind: "integration", scope: "runner" }] },
    );
    expect(result.records[0]!.test.v).toBe("server-execution");
    expect(result.conflicts.length).toBe(1);
  });

  it("says how far past a lane's budget the mandatory set went", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane: 1,
          of: 5,
          full: false,
          dryRun: true,
          laneCount: false,
          root: REPOSITORY,
          at: "2026-09-01T00:00:00Z",
        },
        {
          manifest: () =>
            Promise.resolve({
              // A manifest that knows one gate, which leaves every
              // other unit in the tree unknown and therefore mandatory.
              // The lane takes them all and says what that cost rather
              // than dropping work.
              manifest: manifestOf([{
                test: { k: "format", s: "repo", n: "deno-fmt" },
                suite: "repo-gates",
                unit: "deno-fmt",
                // Past a lane's 230-second budget and inside the
                // 300-second bound, so it is placed and reported rather
                // than being unschedulable.
                cost: 280,
              }]),
              objectName: "manifest-fixture.json.gz",
            }),
        },
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("past the");
  });
});

describe("the last corners of a lane's bookkeeping", () => {
  it("puts two identities of one unit in one batch, and skips neither", () => {
    const manifest = manifestOf([
      {},
      { test: { k: "unit", s: "bakery", n: "glaze > browns" } },
    ]);
    const bakery = suite({
      id: "workspace-unit",
      units: ["packages/bakery/glaze.test.ts"],
    });
    const batches = batchesOf(
      [bakery],
      manifest,
      manifest.entries.map((entry) => ({
        entry,
        reason: "value" as const,
        repeats: 1,
      })),
    );
    expect(batches.length).toBe(1);
    expect(batches[0]!.units).toEqual([{
      unit: "packages/bakery/glaze.test.ts",
      skip: [],
    }]);
  });

  it("drops a selection whose suite the topology no longer has", () => {
    // A manifest naming a suite this tree does not declare is a
    // manifest written before the suite was renamed or removed.
    const manifest = manifestOf([{ suite: "a-suite-that-left" }]);
    expect(
      batchesOf([], manifest, [{
        entry: manifest.entries[0]!,
        reason: "value",
        repeats: 1,
      }]),
    ).toEqual([]);
  });
});

describe("writing the lane's records into its spool", () => {
  it("writes nothing when there is nothing to write", async () => {
    // A lane that opened no capability and ran no batch has nothing to
    // say about either, and an empty fragment would be a report of a
    // run that did not happen.
    const spool = await Deno.makeTempDir({ prefix: "lane-empty-" });
    spoolRecords(spool, []);
    expect(await Array.fromAsync(Deno.readDir(spool))).toEqual([]);
    await Deno.remove(spool, { recursive: true });
  });

  it("says nothing where the spool cannot be written", async () => {
    // Recording is telemetry: a spool this process cannot write costs
    // the run its records and must not cost it the run.
    //
    // The spool is a path underneath a file, which no user can make a
    // directory of, so the case occurs whoever the suite runs as. A
    // path that merely does not exist would not do: the superuser
    // creates it and the case never happens.
    const file = await Deno.makeTempFile({ prefix: "lane-not-a-dir-" });
    try {
      expect(() =>
        spoolRecords(`${file}/spool`, [{
          line: "record",
          test: { k: "gate", s: "ci", n: "ci-lane setup deno" },
          outcome: "pass",
          durationMs: 1,
        }])
      ).not.toThrow();
    } finally {
      await Deno.remove(file);
    }
  });
});

describe("reading a batch's records against what it was asked to run", () => {
  const UNIT = "packages/bakery/glaze.test.ts";

  /** A batch of one unit, over a suite that locates by scope. */
  function batch() {
    return {
      suite: suite({
        id: "workspace-unit",
        units: [UNIT],
        locate: (record: { test: { k: string; s: string } }) =>
          record.test.s === "bakery"
            ? { level: "unit" as const, unit: UNIT }
            : undefined,
      }),
      units: [{ unit: UNIT, skip: [] }],
      runs: new Map([[UNIT, 1]]),
    };
  }

  /** One record, as a runner writes it. */
  function record(n: string, outcome: "pass" | "fail"): TestRecord {
    return {
      line: "record",
      test: { k: "unit", s: "bakery", n },
      outcome,
      durationMs: 1,
    };
  }

  /** The selections that ask for one identity of that unit. */
  function asked(n: string) {
    return [{
      entry: {
        test: { k: "unit", s: "bakery", n },
        suite: "workspace-unit",
        unit: UNIT,
        cost: 1,
        score: 0.5,
        inputs: { catches: 0, sources: 0, churn: 0 },
        flakeRate: 0,
        repeats: 1,
      },
      reason: "value" as const,
      repeats: 1,
    }];
  }

  it("says a unit that recorded something ran", () => {
    const found = accountFor(
      batch(),
      asked("glaze > sets"),
      [record("glaze > sets", "pass")],
      new Set(),
    );
    expect(found).toEqual({
      gating: [],
      excused: [],
      unaccounted: [],
      failedUnits: [],
    });
  });

  it("keeps a failure the run fails for apart from one it excuses", () => {
    const excused = testIdentityKey({ k: "unit", s: "bakery", n: "flaky" });
    const found = accountFor(
      batch(),
      asked("flaky"),
      [record("flaky", "fail"), record("glaze > sets", "fail")],
      new Set([excused]),
    );
    expect(found.excused).toEqual([excused]);
    expect(found.gating).toEqual([
      testIdentityKey({ k: "unit", s: "bakery", n: "glaze > sets" }),
    ]);
  });

  it("counts one identity once, however many times it failed", () => {
    // A repeated identity fails once per execution, and the lane has one
    // thing to say about it.
    const found = accountFor(
      batch(),
      asked("glaze > sets"),
      [record("glaze > sets", "fail"), record("glaze > sets", "fail")],
      new Set(),
    );
    expect(found.gating.length).toBe(1);
  });

  it("names the unit a failure was seen in, excused or not", () => {
    // A measured set holding that unit measured its member through a
    // failing test, so its number is short by whatever that test would
    // have reached.
    const excused = testIdentityKey({ k: "unit", s: "bakery", n: "flaky" });
    const found = accountFor(
      batch(),
      asked("flaky"),
      [record("flaky", "fail")],
      new Set([excused]),
    );
    expect(found.failedUnits).toEqual([UNIT]);
  });

  it("names an identity no record accounts for", () => {
    // A manifest is hours old by construction, so an identity it names
    // and the tree has since renamed records under the new name. That
    // costs an excusal rather than the run.
    const found = accountFor(
      batch(),
      asked("glaze > sets"),
      [record("glaze > sets under its new name", "pass")],
      new Set(),
    );
    expect(found.unaccounted).toEqual([
      testIdentityKey({ k: "unit", s: "bakery", n: "glaze > sets" }),
    ]);
  });

  it("reads only the selections its own suite was given", () => {
    // A lane hands every batch the whole lane's selections. Another
    // suite's identity is not this batch's to account for, and counting
    // it would withdraw the excusal of every batch in a mixed lane.
    const elsewhere = asked("pantry > stocks");
    elsewhere[0]!.entry.suite = "runner-unit";
    const found = accountFor(
      batch(),
      [...asked("glaze > sets"), ...elsewhere],
      [record("glaze > sets", "pass")],
      new Set(),
    );
    expect(found.unaccounted).toEqual([]);
  });

  it("says what an excusal turned on, either way round", () => {
    // A reader of a green run needs to know a failure went by, and a
    // reader of a red one needs to know which rule turned it red.
    const said = (excusing: boolean): string => {
      const lines: string[] = [];
      const log = console.log;
      console.log = (line: string) => lines.push(line);
      try {
        describeAccounting(
          "workspace-unit",
          {
            gating: [],
            excused: ["unit\tbakery\tflaky"],
            unaccounted: [],
            failedUnits: [],
          },
          excusing,
          [UNIT],
        );
      } finally {
        console.log = log;
      }
      return lines.join("\n");
    };
    expect(said(true)).toContain("do not fail this run");
    expect(said(false)).toContain("did not account for everything");
    expect(said(true)).toContain(`- ${UNIT}`);
    expect(said(true)).toContain("recorded nothing");
  });

  it("names every list its verdict turns on", () => {
    // The excusal turns on the unaccounted list, and a summary saying a
    // batch left something unaccounted for without saying what is a
    // message nobody can act on. The same goes for what the lane failed
    // for: the runner's own output is buried in a log, and the summary
    // is where a reader looks.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeAccounting(
        "workspace-unit",
        {
          gating: ["unit\tbakery\tglaze > burns"],
          excused: ["unit\tbakery\tflaky"],
          unaccounted: ["unit\tbakery\tglaze > sets"],
          failedUnits: [UNIT],
        },
        false,
        [UNIT],
      );
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    for (
      const named of [
        "unit\tbakery\tglaze > burns",
        "unit\tbakery\tflaky",
        "unit\tbakery\tglaze > sets",
        UNIT,
      ]
    ) {
      expect([named, text.includes(`- ${named}`)]).toEqual([named, true]);
    }
  });

  it("says nothing about a batch that did everything asked of it", () => {
    // A lane that found nothing to say adds nothing to the summary. The
    // batch's own measurement is what says it ran.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeAccounting(
        "workspace-unit",
        {
          gating: [],
          excused: [],
          unaccounted: [],
          failedUnits: [UNIT],
        },
        true,
        [],
      );
    } finally {
      console.log = log;
    }
    expect(lines).toEqual([]);
  });

  it("accounts for a stand-in by its unit having recorded", () => {
    // No record will ever carry a stand-in's name: a real record is
    // named for a test and a stand-in is named for a file.
    const standIn = asked(`unrecorded ${UNIT}`);
    const found = accountFor(
      batch(),
      standIn,
      [record("glaze > sets", "pass")],
      new Set(),
    );
    expect(found.unaccounted).toEqual([]);
  });
});

describe("what a lane does with the batches it was given", () => {
  const UNIT = "packages/bakery/test/glaze.test.ts";

  /**
   * A command that records the unit having run, and then does whatever
   * the case asked for. Every real suite records what it ran, and a lane
   * reads the records to decide what its batches came to, so a fixture
   * that recorded nothing would be testing the lane against a runner
   * shaped like nothing in the tree.
   */
  function recording(then: string, outcome = "pass"): string[] {
    return [
      Deno.execPath(),
      "eval",
      `const dir = Deno.env.get("CF_TEST_RECORDS_DIR");
       Deno.mkdirSync(dir, { recursive: true });
       Deno.writeTextFileSync(
         \`\${dir}/fragment-fixture-\${crypto.randomUUID()}.ndjson\`,
         JSON.stringify({
           line: "record",
           test: { k: "unit", s: "bakery", n: "glaze > sets" },
           outcome: ${JSON.stringify(outcome)},
           durationMs: 1,
         }) + "\\n",
       );
       ${then}`,
    ];
  }

  /** A topology of one suite running the command a case names. */
  function topology(command: readonly string[]) {
    return () =>
      Promise.resolve([
        suite({
          id: "workspace-unit",
          units: [UNIT],
          locate: (record) =>
            record.test.k === "unit" && record.test.s === "bakery"
              ? { level: "unit" as const, unit: UNIT }
              : undefined,
          command: (_units, context) =>
            Promise.resolve([{ command: [...command], cwd: context.root }]),
        }),
      ]);
  }

  /** A manifest selecting that suite's one unit. */
  function selecting(manifest: Manifest = manifestOf([{ unit: UNIT }])) {
    return () =>
      Promise.resolve({
        manifest,
        objectName: "manifest-fixture.json.gz",
      });
  }

  /** The manifest above, holding that one identity back as flaky. */
  function withholding(): Manifest {
    const manifest = manifestOf([{ unit: UNIT, flakeRate: 0.9 }]);
    manifest.withheld = [{
      test: manifest.entries[0]!.test,
      suite: "workspace-unit",
      reason: "flaky",
    }];
    return manifest;
  }

  /**
   * Runs a lane over that suite, and returns its verdict beside the
   * measurements it wrote. The spool is the lane's own, so what it
   * records about itself stays here rather than reaching the spool of
   * the run testing it. Its coverage directory is private too: the lane
   * converts every profile it finds there, including an enclosing CI
   * run's profiles if it shares that run's directory.
   */
  async function run(
    command: readonly string[],
    over: { full?: boolean; manifest?: Manifest } = {},
  ): Promise<{ ok: boolean; measured: TestRecord[] }> {
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    const log = console.log;
    console.log = () => {};
    try {
      const ok = await runLane(
        {
          lane: 1,
          of: 1,
          full: over.full ?? false,
          dryRun: false,
          laneCount: false,
          root: REPOSITORY,
          at: "2026-09-01T00:00:00Z",
          coverageDir: `${spool}/coverage`,
        },
        {
          manifest: selecting(over.manifest),
          topology: topology(command),
          spool: () => spool,
        },
      );
      const written = (await Promise.all(
        (await Array.fromAsync(Deno.readDir(spool)))
          .filter((entry) => entry.isFile)
          .map((entry) => Deno.readTextFile(`${spool}/${entry.name}`)),
      )).join("");
      const measured = written.split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TestRecord);
      return { ok, measured };
    } finally {
      console.log = log;
      await Deno.remove(spool, { recursive: true });
    }
  }

  /**
   * The outcome the lane recorded for its one batch, whether or not that
   * batch ran with coverage on.
   */
  function batchOutcome(measured: readonly TestRecord[]): string | undefined {
    return measured.find((record) =>
      batchMeasurement(record.test.n)?.suite === "workspace-unit"
    )?.outcome;
  }

  it("passes when every batch passed", async () => {
    const { ok, measured } = await run(recording(""));
    expect(ok).toBe(true);
    // The measurement says what the lane says. A batch recorded green
    // while the lane reports red, or the other way about, is one commit
    // carrying both outcomes for the identity.
    expect(batchOutcome(measured)).toBe("pass");
  });

  it("gives each batch the environment its own suite asked for", async () => {
    // `cf` exports the root it puts its command line under, and `deno`
    // exports nothing. A lane opens the union of what its batches asked
    // for, so both suites here run in a lane that opened `cf`, and only
    // the one that asked for it may see what it exports.
    const dir = await Deno.makeTempDir({ prefix: "lane-env-" });
    const reporting = (id: string, needs: readonly CapabilityId[]) =>
      suite({
        id,
        needs,
        units: [`packages/bakery/${id}.test.ts`],
        command: (_units, context) =>
          Promise.resolve([{
            command: [
              Deno.execPath(),
              "eval",
              `Deno.writeTextFileSync(${
                JSON.stringify(`${dir}/${id}`)
              }, Deno.env.get("CF_LABS_ROOT") ?? "");`,
            ],
            cwd: context.root,
          }]),
      });
    const log = console.log;
    console.log = () => {};
    try {
      await runLane(
        {
          lane: 1,
          of: 1,
          full: false,
          dryRun: false,
          laneCount: false,
          root: REPOSITORY,
          at: "2026-09-01T00:00:00Z",
          coverageDir: `${dir}/coverage`,
        },
        {
          manifest: () =>
            Promise.resolve({
              manifest: manifestOf([
                {
                  test: { k: "unit", s: "bakery", n: "asked > runs" },
                  suite: "asked",
                  unit: "packages/bakery/asked.test.ts",
                },
                {
                  test: { k: "unit", s: "bakery", n: "did-not > runs" },
                  suite: "did-not",
                  unit: "packages/bakery/did-not.test.ts",
                },
              ]),
              objectName: "manifest-fixture.json.gz",
            }),
          topology: () =>
            Promise.resolve([
              reporting("asked", ["deno", "cf"]),
              reporting("did-not", ["deno"]),
            ]),
          // What this case reads is the environment each batch ran in,
          // so the lane records nothing about itself.
          spool: () => undefined,
        },
      );
      expect(await Deno.readTextFile(`${dir}/asked`)).toBe(REPOSITORY);
      expect(await Deno.readTextFile(`${dir}/did-not`)).toBe("");
    } finally {
      console.log = log;
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });

  it("fails on the way out when running a batch throws", async () => {
    // A lane whose loop threw has failed, whatever the batches before it
    // said, and it is the one that most needs what its capabilities
    // wrote: the teardown reads their logs out of the work directory
    // before removing it, and a lane still holding `ok` true would have
    // removed them unread.
    const log = console.log;
    console.log = () => {};
    let thrown: unknown;
    try {
      await runLane(
        {
          lane: 1,
          of: 1,
          full: false,
          dryRun: false,
          laneCount: false,
          root: REPOSITORY,
          at: "2026-09-01T00:00:00Z",
        },
        {
          manifest: selecting(),
          topology: () =>
            Promise.resolve([
              suite({
                id: "workspace-unit",
                units: [UNIT],
                locate: () => ({ level: "unit" as const, unit: UNIT }),
                command: () =>
                  Promise.reject(new Error("the command could not be built")),
              }),
            ]),
          spool: () => undefined,
        },
      );
    } catch (error) {
      thrown = error;
    } finally {
      console.log = log;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "the command could not be built",
    );
  });

  it("fails when a batch failed, having run it", async () => {
    // A lane reports what it measured: the batch ran and went red, so
    // the lane is red, and nothing about that is a crash or a timeout.
    const { ok, measured } = await run(recording("Deno.exit(1);"));
    expect(ok).toBe(false);
    expect(batchOutcome(measured)).toBe("fail");
  });

  it("stays green for a failure too flaky to judge a change by", async () => {
    // The default branch runs a test a pull request holds back, because
    // what this run learns about it is the whole of what says whether
    // the exclusion should reverse. Going red for it would redden the
    // branch for something no change caused.
    const { ok, measured } = await run(
      recording("Deno.exit(1);", "fail"),
      { full: true, manifest: withholding() },
    );
    expect(ok).toBe(true);
    // And the batch still recorded what it saw.
    expect(batchOutcome(measured)).toBe("fail");
  });

  it("fails for that same failure on a pull request", async () => {
    // A pull request has no excused set at all: a test this flaky is
    // held back rather than run, so a failure reaching a lane here is
    // one nothing excuses.
    const { ok } = await run(
      recording("Deno.exit(1);", "fail"),
      { manifest: manifestOf([{ unit: UNIT }]) },
    );
    expect(ok).toBe(false);
  });

  it("fails when one execution of a repeated unit died having run nothing", async () => {
    // An excusal is a statement about one invocation. A repeat that
    // recorded the flaky failure sits in the same list of records as a
    // repeat that died before recording anything, and a reader taking
    // the batch's records as one list cannot tell that from a batch
    // where every execution ran. Repeats are what a flaky identity is
    // given, so this is the shape rather than an exotic one.
    const counter = await Deno.makeTempFile({ prefix: "lane-execution-" });
    const manifest = withholding();
    manifest.entries[0]!.repeats = 2;
    try {
      const { ok } = await run([
        Deno.execPath(),
        "eval",
        `const dir = Deno.env.get("CF_TEST_RECORDS_DIR");
         const at = ${JSON.stringify(counter)};
         const before = Number(Deno.readTextFileSync(at) || "0");
         Deno.writeTextFileSync(at, String(before + 1));
         if (before === 0) {
           Deno.mkdirSync(dir, { recursive: true });
           Deno.writeTextFileSync(
             \`\${dir}/fragment-\${crypto.randomUUID()}.ndjson\`,
             JSON.stringify({
               line: "record",
               test: { k: "unit", s: "bakery", n: "glaze > sets" },
               outcome: "fail",
               durationMs: 1,
             }) + "\\n",
           );
         }
         Deno.exit(1);`,
      ], { full: true, manifest });
      expect(ok).toBe(false);
      // Both executions ran, so this is not the batch being cut short.
      expect(Deno.readTextFileSync(counter)).toBe("2");
    } finally {
      await Deno.remove(counter);
    }
  });

  it("fails when a later execution ran nothing and said so with a zero", async () => {
    // The exit status cannot answer this one: the second execution
    // reports success having run none of its unit, and the first
    // execution's record of that unit sits in the same list. Only a
    // reader that keeps the executions apart sees that one of them ran
    // nothing, and a repeated unit is exactly what a flaky identity is
    // given.
    const counter = await Deno.makeTempFile({ prefix: "lane-quiet-" });
    const manifest = withholding();
    manifest.entries[0]!.repeats = 2;
    try {
      const { ok } = await run([
        Deno.execPath(),
        "eval",
        `const dir = Deno.env.get("CF_TEST_RECORDS_DIR");
         const at = ${JSON.stringify(counter)};
         const before = Number(Deno.readTextFileSync(at) || "0");
         Deno.writeTextFileSync(at, String(before + 1));
         if (before === 0) {
           Deno.mkdirSync(dir, { recursive: true });
           Deno.writeTextFileSync(
             \`\${dir}/fragment-\${crypto.randomUUID()}.ndjson\`,
             JSON.stringify({
               line: "record",
               test: { k: "unit", s: "bakery", n: "glaze > sets" },
               outcome: "pass",
               durationMs: 1,
             }) + "\\n",
           );
         }`,
      ], { full: true, manifest });
      expect(ok).toBe(false);
      expect(Deno.readTextFileSync(counter)).toBe("2");
    } finally {
      await Deno.remove(counter);
    }
  });

  it("fails for an excused failure beside an identity nothing accounts for", async () => {
    // An invocation that recorded a withheld failure and then stopped
    // has run almost nothing while satisfying any weaker test, so the
    // excusal is withdrawn.
    const manifest = withholding();
    manifest.entries.push({
      ...manifest.entries[0]!,
      test: { k: "unit", s: "bakery", n: "glaze > cools" },
      flakeRate: 0,
    });
    const { ok } = await run(
      recording("Deno.exit(1);", "fail"),
      { full: true, manifest },
    );
    expect(ok).toBe(false);
  });

  it("fails when a unit it was asked to run recorded nothing", async () => {
    // A unit runs its tests or it does not. Nothing recorded is a runner
    // that ran none of it, and an exit status of zero says otherwise.
    const { ok } = await run([Deno.execPath(), "eval", "0"]);
    expect(ok).toBe(false);
  });

  it("says it could not date the tree it is testing", async () => {
    // Outside a repository there is no commit to resolve the manifest
    // at, so the lane takes the newest manifest there is and prints
    // that it did rather than appearing to have chosen one.
    const outside = await Deno.makeTempDir({ prefix: "lane-nogit-" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await runLane(
        {
          lane: 1,
          of: 1,
          full: false,
          dryRun: true,
          laneCount: false,
          root: outside,
        },
        {
          manifest: () => Promise.resolve({ absent: "nothing published" }),
          topology: () => Promise.resolve([]),
        },
      );
    } finally {
      console.log = log;
      await Deno.remove(outside, { recursive: true });
    }
    expect(lines.join("\n")).toContain("cannot read the commit's date");
  });
});

describe("what a lane measures", () => {
  const options = {
    lane: 1,
    of: 5,
    full: false,
    dryRun: false,
    laneCount: false,
    root: "/repo",
  };

  const gated = (member: string) =>
    census(
      [suite({
        id: "workspace-unit",
        units: [`${member}/one.test.ts`],
        measured: [{
          member,
          reachedBy: [`${member}/`],
          units: [`${member}/one.test.ts`],
        }],
      })],
      undefined,
      new Set([`${member}/src/main.ts`]),
    ).coverage;

  it("measures the members of the sets the gate is scoring", () => {
    const coverage = batchCoverage(
      options,
      "workspace-unit",
      gated("packages/bakery"),
    );
    expect(coverage?.dir)
      .toBe(`/repo/coverage/${COVERAGE_PROFILE_DIR}/workspace-unit`);
    expect([...coverage!.members!]).toEqual(["packages/bakery"]);
  });

  it("measures nothing in a suite the gate is not scoring", () => {
    expect(batchCoverage(options, "runner-unit", gated("packages/bakery")))
      .toBeUndefined();
  });

  it("measures every member of every suite in a full run", () => {
    const coverage = batchCoverage(
      { ...options, full: true },
      "runner-unit",
      gated("packages/bakery"),
    );
    expect(coverage?.members).toBeUndefined();
    expect(coverage?.dir)
      .toBe(`/repo/coverage/${COVERAGE_PROFILE_DIR}/runner-unit`);
  });

  it("puts coverage where the command line said", () => {
    const coverage = batchCoverage(
      { ...options, full: true, coverageDir: "elsewhere" },
      "runner-unit",
      gated("packages/bakery"),
    );
    expect(coverage?.dir)
      .toBe(`/repo/elsewhere/${COVERAGE_PROFILE_DIR}/runner-unit`);
  });
});

describe("converting what a lane collected", () => {
  /** A lane's coverage directory holding one profile per named set. */
  async function collected(sets: readonly string[]): Promise<string> {
    const root = await Deno.makeTempDir({ prefix: "lane-coverage-" });
    for (const set of sets) {
      const dir = `${root}/coverage/${COVERAGE_PROFILE_DIR}/${set}`;
      await Deno.mkdir(dir, { recursive: true });
      // An empty profile directory converts to an empty report, which is
      // enough to prove the walk found it and named it.
      await Deno.writeTextFile(`${dir}/empty.json`, "");
    }
    return root;
  }

  it("writes one report per profile directory, named for the set", async () => {
    const root = await collected([
      "workspace-unit/packages__bakery",
      "runner-unit/packages__runner",
    ]);
    const converted = await convertCoverage({ ...options(root) });
    expect(converted.ok).toBe(true);
    expect(converted.reports).toEqual([
      "runner-unit/packages__runner",
      "workspace-unit/packages__bakery",
    ]);
    const at = `${root}/coverage/${COVERAGE_REPORT_DIR}/workspace-unit/` +
      `packages__bakery/${COVERAGE_REPORT_FILE}`;
    expect((await Deno.stat(at)).isFile).toBe(true);
  });

  it("converts a directory no measured set names", async () => {
    // The repository-wide figure the full run publishes is the merge of
    // every report, so a directory the gate will not score is still
    // converted.
    const root = await collected(["cli-core/packages__cli"]);
    const converted = await convertCoverage({ ...options(root) });
    expect(converted.reports).toEqual(["cli-core/packages__cli"]);
  });

  it("takes the directory its coverage goes under from the command line", () => {
    const options = parseLaneArgs(["--coverage-dir", "/somewhere/coverage"]);
    expect(options?.coverageDir).toBe("/somewhere/coverage");
  });

  it("refuses a profile directory it cannot walk", async () => {
    // An absent directory is a lane that measured nothing, which is
    // ordinary. Anything else is a failure worth ending on.
    const root = await Deno.makeTempDir({ prefix: "lane-coverage-" });
    const at = `${root}/coverage/${COVERAGE_PROFILE_DIR}`;
    await Deno.mkdir(`${root}/coverage`, { recursive: true });
    await Deno.writeTextFile(at, "");
    await expect(convertCoverage({ ...options(root) })).rejects.toThrow();
  });

  it("fails the lane when a conversion loses what it was given", async () => {
    // Every line of a file the report lost reads as uncovered
    // downstream, so a gate scored from it would fail somebody for a
    // report that was never complete.
    const root = await Deno.makeTempDir({ prefix: "lane-coverage-" });
    const dir =
      `${root}/coverage/${COVERAGE_PROFILE_DIR}/workspace-unit/packages__bakery`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/broken.json`, "this is not a profile");
    const converted = await convertCoverage({ ...options(root) });
    expect(converted.ok).toBe(false);
    expect(converted.reports).toEqual(["workspace-unit/packages__bakery"]);
  });

  it("writes nothing where the lane measured nothing", async () => {
    const root = await Deno.makeTempDir({ prefix: "lane-coverage-" });
    const converted = await convertCoverage({ ...options(root) });
    expect(converted).toEqual({ ok: true, reports: [] });
  });

  function options(root: string) {
    return {
      lane: 1,
      of: 5,
      full: false,
      dryRun: false,
      laneCount: false,
      root,
    };
  }

  /** A suite declaring one measured set over the units named. */
  function measuring(id: string, member: string, units: string[]): Suite {
    return suite({ id, units, measured: [{ member, units, reachedBy: [] }] });
  }

  it("belongs to no set where the path is outside the report layout", () => {
    // Every reader of a downloaded artifact walks files the lanes never
    // wrote, so saying which set a path is under has to have an answer
    // for "none of them".
    expect(measuredSetOfReport("lane-1/notes.txt")).toBeUndefined();
    expect(measuredSetOfReport(`lane-1/${COVERAGE_REPORT_DIR}/a/b/c/d.lcov`))
      .toBeUndefined();
    expect(measuredSetOfReport(`x/${COVERAGE_REPORT_DIR}/suite/member/r.lcov`))
      .toBe("suite/member");
  });

  it("marks a set whose unit the lane saw fail", async () => {
    // A run that excused a flaky failure stays green, so nothing
    // downstream would otherwise know the number is short by whatever
    // the failing test would have reached.
    const root = await Deno.makeTempDir({ prefix: "lane-coverage-" });
    try {
      const marked = await markMeasuredFailures(
        options(root),
        [
          measuring("workspace-unit", "packages/bakery", [
            "packages/bakery/glaze.test.ts",
          ]),
          measuring("runner-unit", "packages/runner", [
            "packages/runner/park.test.ts",
          ]),
        ],
        new Set(["workspace-unit\tpackages/bakery/glaze.test.ts"]),
      );
      expect(marked).toEqual(["workspace-unit/packages/bakery"]);
      const at = `${root}/coverage/${COVERAGE_REPORT_DIR}/workspace-unit/` +
        `packages__bakery/${COVERAGE_FAILURE_MARKER}`;
      expect(await Deno.readTextFile(at)).toBe(
        "packages/bakery/glaze.test.ts\n",
      );
      // And nothing beside the set whose unit passed.
      await expect(
        Deno.stat(
          `${root}/coverage/${COVERAGE_REPORT_DIR}/runner-unit/` +
            `packages__runner/${COVERAGE_FAILURE_MARKER}`,
        ),
      ).rejects.toThrow();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("marks a set the same lane wrote no report for", async () => {
    // A lane that ran a set's unit and saw it fail may have collected no
    // profile at all, and another lane's report for that set must still
    // not become the baseline. So the marker goes in the set's own
    // directory whether or not a report is there.
    const root = await Deno.makeTempDir({ prefix: "lane-coverage-" });
    try {
      await markMeasuredFailures(
        options(root),
        [measuring("workspace-unit", "packages/bakery", ["one.test.ts"])],
        new Set(["workspace-unit\tone.test.ts"]),
      );
      const dir =
        `${root}/coverage/${COVERAGE_REPORT_DIR}/workspace-unit/packages__bakery`;
      expect(
        (await Array.fromAsync(Deno.readDir(dir))).map((entry) => entry.name),
      ).toEqual([COVERAGE_FAILURE_MARKER]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("writes nothing where no unit failed", async () => {
    const root = await Deno.makeTempDir({ prefix: "lane-coverage-" });
    try {
      expect(
        await markMeasuredFailures(
          options(root),
          [measuring("workspace-unit", "packages/bakery", ["one.test.ts"])],
          new Set(),
        ),
      ).toEqual([]);
      await expect(Deno.stat(`${root}/coverage`)).rejects.toThrow();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("what a lane says about coverage", () => {
  it("says nothing where the change reaches no set and nothing measured", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeCoverage({ sets: [], reached: [] }, []);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual([]);
  });

  it("names the sets it is scoring, and the reports it wrote", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeCoverage({
        sets: [{
          suite: "workspace-unit",
          set: {
            member: "packages/bakery",
            reachedBy: ["packages/bakery/"],
            units: ["packages/bakery/one.test.ts"],
          },
        }],
        reached: [],
      }, ["workspace-unit/packages__bakery"]);
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    expect(text).toContain("workspace-unit/packages/bakery");
    expect(text).toContain("workspace-unit/packages__bakery");
  });

  it("names a set whose number this run did not stand behind", () => {
    // A run that excused a flaky failure stays green, so a reader of a
    // green run would otherwise have nothing saying the set's number is
    // short by whatever the failing test would have reached.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeCoverage({ sets: [], reached: [] }, [], [
        "workspace-unit/packages/bakery",
      ]);
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    expect(text).toContain("no baseline is published");
    expect(text).toContain("- workspace-unit/packages/bakery");
  });

  it("names a report by its set where the change reached that set", () => {
    // A report belonging to a set is named as the set, so one summary
    // does not spell one thing two ways.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    const ref = {
      suite: "workspace-unit",
      set: {
        member: "packages/bakery",
        reachedBy: ["packages/bakery/"],
        units: ["packages/bakery/one.test.ts"],
      },
    };
    try {
      describeCoverage(
        { sets: [ref], reached: [ref] },
        ["workspace-unit/packages__bakery", "workspace-unit/packages__cellar"],
      );
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    expect(text).toContain("- workspace-unit/packages/bakery");
    // A directory no set is scored from keeps the name the suite wrote.
    expect(text).toContain("- workspace-unit/packages__cellar");
    expect(text).not.toContain("- workspace-unit/packages__bakery");
  });

  it("says why nothing is forced, and what the change reached", () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      describeCoverage({
        sets: [],
        reached: [{
          suite: "workspace-unit",
          set: {
            member: "packages/bakery",
            reachedBy: ["packages/bakery/"],
            units: ["packages/bakery/one.test.ts"],
          },
        }],
        off: "the change reaches 3 measured sets",
      }, []);
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    expect(text).toContain("No measured set is forced");
    expect(text).toContain("workspace-unit/packages/bakery");
  });
});

describe("what a lane hands the children it spawns", () => {
  /**
   * A suite of one unit, whose command writes what the child saw each
   * GitHub token variable as into a file named for the suite.
   */
  function reporting(id: string, needs: CapabilityId[], at: string): Suite {
    return suite({
      id,
      needs,
      units: [id],
      command: () =>
        Promise.resolve([{
          command: [
            Deno.execPath(),
            "eval",
            `Deno.writeTextFileSync(${JSON.stringify(`${at}/${id}`)}, ` +
            `JSON.stringify([Deno.env.get("GITHUB_TOKEN") ?? "", ` +
            `Deno.env.get("GH_TOKEN") ?? ""]))`,
          ],
          cwd: REPOSITORY,
        }]),
    });
  }

  /** What the child of `id` reported seeing, one entry per variable. */
  async function saw(at: string, id: string): Promise<string[]> {
    return JSON.parse(await Deno.readTextFile(`${at}/${id}`)) as string[];
  }

  /** A manifest selecting the one unit of each of those suites. */
  function selecting(ids: readonly string[]): Manifest {
    return manifestOf(ids.map((id) => ({
      test: { k: "unit", s: "bakery", n: `glaze > ${id}` },
      suite: id,
      unit: id,
    })));
  }

  it("gives the token to a declaring suite's child and to no other", async () => {
    // Read off the children rather than off what the lane exported to
    // them: `runInvocation` merges this process's own environment
    // underneath every command it spawns, so a token the lane was still
    // holding would reach both of these whatever either declared.
    const at = await Deno.makeTempDir({ prefix: "lane-token-" });
    const spool = await Deno.makeTempDir({ prefix: "lane-spool-" });
    // Handed under the name the `gh` command line reads, with the other
    // cleared: the capability exports both, so this covers either name a
    // lane may be handed one under. Both are named here rather than left
    // to the ambient environment, since a token a developer exported is
    // exactly what this reads.
    const names = ["GITHUB_TOKEN", "GH_TOKEN"] as const;
    const before = new Map(names.map((name) => [name, Deno.env.get(name)]));
    Deno.env.delete("GITHUB_TOKEN");
    Deno.env.set("GH_TOKEN", "a-token");
    const log = console.log;
    console.log = () => {};
    let heldAfter: (string | undefined)[] = [];
    let reported: Record<string, string[]> = {};
    try {
      await runLane({
        lane: 1,
        of: 1,
        full: false,
        dryRun: false,
        laneCount: false,
        root: REPOSITORY,
        at: "2026-09-01T00:00:00Z",
        coverageDir: `${at}/coverage`,
      }, {
        manifest: () =>
          Promise.resolve({
            manifest: selecting(["repo-gates", "workspace-unit"]),
            objectName: "manifest-fixture.json.gz",
          }),
        topology: () =>
          Promise.resolve([
            reporting("repo-gates", ["deno", "github-api"], at),
            reporting("workspace-unit", ["deno"], at),
          ]),
        spool: () => spool,
      });
      heldAfter = names.map((name) => Deno.env.get(name));
      // Read here rather than beside the assertions, so that the
      // directories holding it can go in the `finally` and a failing
      // assertion leaves nothing behind.
      reported = {
        "repo-gates": await saw(at, "repo-gates"),
        "workspace-unit": await saw(at, "workspace-unit"),
      };
    } finally {
      console.log = log;
      for (const [name, value] of before) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
      await Deno.remove(at, { recursive: true });
      await Deno.remove(spool, { recursive: true });
    }
    expect(reported["repo-gates"]).toEqual(["a-token", "a-token"]);
    expect(reported["workspace-unit"]).toEqual(["", ""]);
    // The lane itself holds nothing for a child to inherit, which is
    // what leaves the declaration as the only way one gets a token.
    expect(heldAfter).toEqual([undefined, undefined]);
  });
});
