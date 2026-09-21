import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  byDayThenName,
  dayPartitions,
  inputChoice,
  liveBaselines,
  namingSurfaces,
  parseArgs,
  partitionOf,
  publish,
  SHARD_CHUNK,
  type StoreAccess,
  writeToken,
} from "./test-selection-publish.ts";
import {
  AliasResolver,
  buildObjectBody,
  gunzipToText,
  parseManifest,
  type RunContext,
  testIdentityKey,
  type TestRecord,
} from "@commonfabric/test-support/records";
import {
  emptyAggregate,
  Fold,
  parseAggregate,
  reportFromText,
} from "./test-selection/build.ts";
import { emptyState } from "./test-selection/score.ts";
import { CATCH_WEIGHT_MAIN } from "./test-selection/policy.ts";
import { stateObjectName, statePrefix } from "./test-selection/store.ts";
import { MANIFEST_SCHEMA_VERSION } from "./test-selection/manifest.ts";
import type { Suite } from "./test-topology/suite.ts";
import { join } from "@std/path";

/**
 * A topology holding the one suite these cases record against. Supplied
 * rather than read from the tree: what the publisher does with a
 * classified identity is the subject, and walking the repository for
 * every case would make each of them depend on what the tree holds.
 */
const TOPOLOGY: Suite[] = [{
  id: "workspace-unit",
  recordSurfaces: [{ kind: "unit", scope: "memory" }],
  needs: ["deno"],
  units: ["packages/memory/test/space.test.ts"],
  unavailable: [],
  locate: (record) =>
    record.test.k === "unit" && record.test.s === "memory"
      ? { level: "unit", unit: "packages/memory/test/space.test.ts" }
      : undefined,
  command: () => Promise.resolve([]),
}];

const suites = () => Promise.resolve(TOPOLOGY);

/**
 * No coverage baselines. Reading real ones asks GitHub what its recent
 * runs published, which is not a question a test of the fold should
 * reach the network to answer.
 */
const noBaselines = () => Promise.resolve([]);

/** The one unit that topology holds. */
const UNIT = "packages/memory/test/space.test.ts";

/**
 * A topology whose one suite places a record by the file it carries, the
 * way a suite whose units are files does. A record with no file reaches
 * no unit, which is what leaves an identity unplaced in practice.
 */
const needsFile = () =>
  Promise.resolve<Suite[]>([{
    ...TOPOLOGY[0]!,
    locate: (record) =>
      record.file === UNIT ? { level: "unit", unit: UNIT } : undefined,
  }]);

/**
 * A topology whose two suites both claim what the records carry, which
 * is the defect the drift guard fails on: nothing in a record says which
 * of them owns it.
 */
const twoSuites = () =>
  Promise.resolve<Suite[]>([
    TOPOLOGY[0]!,
    { ...TOPOLOGY[0]!, id: "runner-unit" },
  ]);

/** Everything a call said on one console stream, as one string. */
async function saying(
  call: () => Promise<unknown>,
  stream: "log" | "warn" = "log",
): Promise<string> {
  const lines: string[] = [];
  const said = console[stream];
  console[stream] = (line: string) => lines.push(line);
  try {
    await call();
  } finally {
    console[stream] = said;
  }
  return lines.join("\n");
}

/** The manifest a run created. */
async function publishedManifest(created: Map<string, Uint8Array>) {
  const name = [...created.keys()].find((one) => one.includes("/manifest-"))!;
  return parseManifest(await gunzipToText(created.get(name)!))!;
}

/**
 * A topology whose suite has lost the unit the records name, the way it
 * looks once a test file is deleted or moved.
 */
const lostUnit = () =>
  Promise.resolve<Suite[]>([{
    ...TOPOLOGY[0]!,
    units: [],
    locate: () => undefined,
  }]);

/** The identities the newest manifest a run created holds. */
async function newestManifest(
  created: Map<string, Uint8Array>,
): Promise<string[]> {
  const newest = [...created.keys()].filter((name) =>
    name.includes("/manifest-")
  ).sort().at(-1)!;
  const manifest = parseManifest(await gunzipToText(created.get(newest)!))!;
  return manifest.entries.map((entry) => entry.test.n).sort();
}

const CI = (day: string, run: string) =>
  `labs/test-records/submissions/ci/v1/${day}/run-${run}-a.ndjson`;
const LOCAL = (day: string, who: string) =>
  `labs/test-records/submissions/local/${who}/v1/${day}/01K3-branch.ndjson`;

describe("test-selection-publish", () => {
  describe("parseArgs()", () => {
    it("defaults to the incremental path", () => {
      const options = parseArgs([]);
      expect(options?.bootstrap).toBe(false);
      expect(options?.dryRun).toBe(false);
    });

    it("widens the window for a bootstrap", () => {
      expect(parseArgs(["--bootstrap"])?.days).toBe(60);
    });

    it("lets an asked-for window win, whichever order it was typed", () => {
      expect(parseArgs(["--days", "3", "--bootstrap"])?.days).toBe(3);
      expect(parseArgs(["--bootstrap", "--days", "3"])?.days).toBe(3);
    });

    it("takes a window, an output directory, and a concurrency", () => {
      const options = parseArgs([
        "--days",
        "3",
        "--out",
        "/tmp/out",
        "--concurrency",
        "8",
      ]);
      expect(options?.days).toBe(3);
      expect(options?.out).toBe("/tmp/out");
      expect(options?.concurrency).toBe(8);
    });

    it("returns undefined for anything it does not understand", () => {
      expect(parseArgs(["--nonsense"])).toBeUndefined();
      expect(parseArgs(["--days", "0"])).toBeUndefined();
      expect(parseArgs(["--days"])).toBeUndefined();
      expect(parseArgs(["--concurrency", "x"])).toBeUndefined();
      expect(parseArgs(["--out"])).toBeUndefined();
    });
  });

  describe("namingSurfaces()", () => {
    const key = (kind: string, scope: string, name: string, variant?: string) =>
      JSON.stringify(
        variant === undefined
          ? [kind, scope, name]
          : [kind, scope, name, variant],
      );

    it("names the worst first, with its own count", () => {
      expect(namingSurfaces([
        key("unit", "utils", "a"),
        key("unit", "llm", "b"),
        key("unit", "utils", "c"),
      ])).toBe("2 surface(s): unit:utils 2, unit:llm 1");
    });

    it("separates a variant from the surface it varies", () => {
      // The two run in different configurations and are fixed in
      // different places, so they are not one surface.
      expect(namingSurfaces([
        key("integration", "patterns", "a"),
        key("integration", "patterns", "b", "server-execution"),
      ])).toBe(
        "2 surface(s): integration:patterns 1, " +
          "integration:patterns:server-execution 1",
      );
    });

    it("counts the surfaces it does not name", () => {
      const keys = ["a", "b", "c", "d", "e", "f", "g"].map((scope) =>
        key("unit", scope, "one")
      );
      expect(namingSurfaces(keys)).toContain("7 surface(s): ");
      expect(namingSurfaces(keys)).toContain(", and 2 more");
    });

    it("passes over a key that names no identity", () => {
      expect(namingSurfaces(["not an identity key", key("unit", "utils", "a")]))
        .toBe("1 surface(s): unit:utils 1");
    });
  });

  describe("dayPartitions()", () => {
    it("lists the window oldest first", () => {
      expect(dayPartitions(new Date("2026-08-20T04:00:00Z"), 3)).toEqual([
        "2026/08/18",
        "2026/08/19",
        "2026/08/20",
      ]);
    });

    it("lists one day for a window of one", () => {
      expect(dayPartitions(new Date("2026-08-20T04:00:00Z"), 1)).toEqual([
        "2026/08/20",
      ]);
    });
  });

  describe("partitionOf()", () => {
    it("reads the day out of either area's names", () => {
      expect(partitionOf(CI("2026/08/20", "1"))).toBe("2026/08/20");
      expect(partitionOf(LOCAL("2026/08/20", "ianh"))).toBe("2026/08/20");
    });

    it("reads nothing out of a name that carries no day", () => {
      expect(partitionOf("labs/test-selection/v1/state/x.json.gz")).toBe("");
    });
  });

  describe("inputChoice()", () => {
    it("passes over a pair whose receipt says its rollup is folded", () => {
      // Rollups of this format carry no record of which arrivals they
      // cover, so nothing can say how much a raw object would repeat.
      expect(
        inputChoice({ settled: true, foldedRaw: false, rollup: true }),
      ).toBe("settled");
      expect(
        inputChoice({ settled: true, foldedRaw: true, rollup: true }),
      ).toBe("settled");
    });

    it("takes the rollup of a pair nothing has been folded from", () => {
      expect(
        inputChoice({ settled: false, foldedRaw: false, rollup: true }),
      ).toBe("rollup");
    });

    it("keeps a pair with raw contributions on the raw path", () => {
      // A rollup written afterwards would overlap them.
      expect(
        inputChoice({ settled: false, foldedRaw: true, rollup: true }),
      ).toBe("raw");
    });

    it("reads raw where there is no rollup, which is every local source", () => {
      expect(
        inputChoice({ settled: false, foldedRaw: false, rollup: false }),
      ).toBe("raw");
    });
  });

  describe("byDayThenName()", () => {
    it("interleaves the two areas by the day they recorded", () => {
      // Sorted by name alone, every local object lands after every
      // continuous-integration one, and the fold would judge a
      // workstation's failure against a state from days later.
      const ordered = [
        LOCAL("2026/08/20", "ianh"),
        CI("2026/08/18", "1"),
        LOCAL("2026/08/19", "ianh"),
        CI("2026/08/20", "2"),
      ].sort(byDayThenName);
      expect(ordered.map(partitionOf)).toEqual([
        "2026/08/18",
        "2026/08/19",
        "2026/08/20",
        "2026/08/20",
      ]);
    });

    it("falls back to the name inside one day", () => {
      const ordered = [CI("2026/08/20", "2"), CI("2026/08/20", "1")]
        .sort(byDayThenName);
      expect(ordered[0]).toBe(CI("2026/08/20", "1"));
    });
  });
});

/** A store held in memory, answering the way the real one answers. */
function fakeStore(
  objects: Record<string, string>,
  rollups: Record<string, string[]> = {},
) {
  const created = new Map<string, Uint8Array>();
  const store: StoreAccess = {
    list: (prefix) =>
      Promise.resolve(
        [...Object.keys(objects), ...created.keys()]
          .filter((name) => name.startsWith(prefix))
          .sort(),
      ),
    read: (objectName) => {
      const text = objects[objectName];
      if (text === undefined) throw new Error(`no such object ${objectName}`);
      return Promise.resolve(reportFromText(objectName, text));
    },
    readText: (objectName) => {
      const stored = created.get(objectName);
      if (stored !== undefined) return gunzipToText(stored);
      const text = objects[objectName];
      if (text === undefined) throw new Error(`no such object ${objectName}`);
      return Promise.resolve(text);
    },
    create: (name, body) => {
      created.set(name, body);
      return Promise.resolve();
    },
    rollupShards: (day) => Promise.resolve(rollups[day]),
    token: () => "a token",
  };
  return { store, created };
}

const DAY = "2026/08/20";

/** One object holding one run of one test, at one commit. */
function object(
  commit: string,
  outcome: TestRecord["outcome"],
  at: string,
  branch = "main",
  file?: string,
  name = "space > writes",
): string {
  const context: RunContext = {
    schema: 1,
    line: "context",
    reportId: `report-${commit}-${outcome}`,
    repo: "commonfabric/labs",
    commit,
    dirty: false,
    branch,
    env: "ci",
    ci: {
      workflowRunId: commit,
      runAttempt: 1,
      workflow: "deno.yml",
      job: "Test (1/8)",
      event: branch === "main" ? "push" : "pull_request",
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: at,
  };
  const record: TestRecord = {
    line: "record",
    test: { k: "unit", s: "memory", n: name },
    outcome,
    durationMs: 40,
    ...(file === undefined ? {} : { file }),
  };
  return buildObjectBody(context, [record]);
}

/** One object holding one run of one test on somebody's workstation. */
function localObject(commit: string, at: string): string {
  const context: RunContext = {
    schema: 1,
    line: "context",
    reportId: `report-${commit}`,
    repo: "commonfabric/labs",
    commit,
    dirty: false,
    branch: "fix-writes",
    env: "local",
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: at,
  };
  return buildObjectBody(context, [{
    line: "record",
    test: { k: "unit", s: "memory", n: "space > writes" },
    outcome: "fail",
    durationMs: 40,
  }]);
}

/**
 * One object holding what one lane measured about itself: a capability
 * it opened, and both halves of one batch.
 *
 * `placeless` leaves the run naming no branch, which is a group the
 * fold cannot place and therefore declines. `batch` set to false writes
 * none of a batch's three measurements, which is what a lane killed
 * part way through a batch leaves, and gives a model with a
 * capability setup in it and no suite.
 */
function laneObject(
  commit: string,
  at: string,
  { ran = 40, spent = 92, units = 1, placeless = false, batch = true } = {},
): string {
  const context: RunContext = {
    schema: 1,
    line: "context",
    reportId: `report-${commit}`,
    repo: "commonfabric/labs",
    commit,
    dirty: false,
    ...(placeless ? {} : { branch: "main" }),
    env: "ci",
    ci: {
      workflowRunId: commit,
      runAttempt: 1,
      workflow: "deno.yml",
      job: "Lane 1",
      event: "push",
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: at,
  };
  const measured = (name: string, ms: number): TestRecord => ({
    line: "record",
    test: { k: "gate", s: "ci", n: name },
    outcome: "pass",
    durationMs: ms,
  });
  return buildObjectBody(context, [
    measured("ci-lane setup fuse", 14_800),
    measured("ci-lane batch workspace-unit", spent * 1000),
    ...(batch
      ? [
        measured("ci-lane ran batch workspace-unit", ran * 1000),
        measured("ci-lane units batch workspace-unit", units),
      ]
      : []),
  ]);
}

/** The two runs a fresh store is seeded with: a failure, then its fix. */
function seed(): Record<string, string> {
  return {
    [CI(DAY, "1")]: object("c1", "fail", "2026-08-20T01:00:00.000Z"),
    [CI(DAY, "2")]: object("c2", "pass", "2026-08-20T02:00:00.000Z"),
  };
}

describe("publish()", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  /** A later run of the same day, whose manifest sorts after the first. */
  const LATER = new Date("2026-08-20T13:00:00.000Z");

  it("refuses a first run that was not asked for", async () => {
    // An absent aggregate is either a genuine first run or one that went
    // missing, and an incremental run cannot tell the two apart.
    const { store, created } = fakeStore(seed());
    expect(await publish(["--days", "1"], store, NOW, suites, noBaselines))
      .toBe(1);
    expect(created.size).toBe(0);
  });

  it("writes a manifest and a state from a bootstrap", async () => {
    const { store, created } = fakeStore(seed());
    expect(
      await publish(
        ["--bootstrap", "--days", "1"],
        store,
        NOW,
        suites,
        noBaselines,
      ),
    )
      .toBe(0);
    const names = [...created.keys()];
    const manifestName = names.find((name) => name.includes("/manifest-"));
    expect(manifestName).toBeDefined();
    expect(names.some((name) => name.includes("/state/"))).toBe(true);

    const manifest = parseManifest(
      await gunzipToText(created.get(manifestName!)!),
    );
    expect(manifest).toBeDefined();
    expect(manifest!.entries.length).toBe(1);
    // The suite and the unit are the topology's, which is what a lane
    // looks a suite up by and what the packer charges overheads to. A
    // surface derived from the record's own kind and scope would match
    // no suite the tree holds, and every selection naming it would be
    // dropped for naming a suite that does not exist.
    expect(manifest!.entries[0]!.suite).toBe("workspace-unit");
    expect(manifest!.entries[0]!.unit).toBe(
      "packages/memory/test/space.test.ts",
    );
    // The failure at c1 that c2 went on to fix is a catch on main, and
    // a catch there is weighted by where it happened. The 1.5 is
    // `CATCH_WEIGHT_MAIN` written out: comparing against the dial would
    // hold just as well for a dial of zero and a catch never counted.
    expect(manifest!.entries[0]!.inputs.catches).toBe(1.5);
  });

  it("publishes what a lane costs beyond the tests it runs", async () => {
    const objects = seed();
    objects[CI(DAY, "3")] = laneObject("c3", "2026-08-20T03:00:00.000Z");
    const { store, created } = fakeStore(objects);
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const manifest = await publishedManifest(created);
    expect(manifest.calibration.setupCost).toEqual({ fuse: 14.8 });
    // The lane spent 92 seconds on a batch of one unit whose own tests
    // took 40. With one observation there is nothing to say about how
    // much of the 52 between them was the batch and how much was the
    // unit inside it, so the unit carries it: charging it there errs
    // high for a lane packing more units than that batch held.
    expect(manifest.calibration.suites["workspace-unit"])
      .toEqual({ overhead: 0, correction: 1, unitOverhead: 52 });
  });

  it("publishes a cost model the manifest reader will carry", async () => {
    // A correction at or below zero is refused, and the whole manifest is
    // refused with it, so one suite whose batches held more and more
    // test time while spending less and less would leave every lane
    // reading no manifest at all.
    const objects = seed();
    [[30, 300], [60, 200], [90, 100]].forEach(([ran, spent], lane) => {
      objects[CI(DAY, `lane-${lane}`)] = laneObject(
        `c-lane-${lane}`,
        `2026-08-20T0${lane + 3}:00:00.000Z`,
        { ran, spent },
      );
    });
    const { store, created } = fakeStore(objects);
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const name = [...created.keys()].find((one) => one.includes("/manifest-"))!;
    const manifest = parseManifest(await gunzipToText(created.get(name)!));
    expect(manifest).toBeDefined();
    expect(manifest!.calibration.suites["workspace-unit"]!.correction)
      .toBeGreaterThan(0);
  });

  it("says so when no lane measurement reached the cost model", async () => {
    // Every cause ends in the same empty map — no lane has run, none
    // recorded what it measured, the fold declines the records of the
    // ones that did, or the fold stopped reading a figure. A manifest
    // carrying the empty map says none of that on its own.
    const { store } = fakeStore(seed());
    const said = await saying(() =>
      publish(["--bootstrap", "--days", "1"], store, NOW, suites, noBaselines)
    );
    expect(said).toContain("the cost model holds 0 suite(s) and 0 capability");
    expect(said).toContain("no suite has a measured cost in the last 7 day(s)");
    expect(said).toContain("charged nothing for holding one or for opening");
  });

  it("names the lane measurements it had to decline", async () => {
    // The distinction an operator can act on: a lane that ran and whose
    // measurement cannot be read, rather than a lane that has not run.
    const objects = seed();
    objects[CI(DAY, "3")] = laneObject("c3", "2026-08-20T03:00:00.000Z", {
      placeless: true,
    });
    const { store } = fakeStore(objects);
    const said = await saying(() =>
      publish(["--bootstrap", "--days", "1"], store, NOW, suites, noBaselines)
    );
    expect(said).toContain("no suite has a measured cost in the last 7 day(s)");
    expect(said).toContain("4 lane measurement(s) this run read");
    expect(said).toContain("the fold could not place");
  });

  it("warns for a model holding a setup and no suite", async () => {
    // What a lane is charged for holding a suite at all is the suite's
    // own figure, so a model with a capability setup in it and no suite
    // charges a lane nothing for the batch it runs.
    const objects = seed();
    objects[CI(DAY, "3")] = laneObject("c3", "2026-08-20T03:00:00.000Z", {
      batch: false,
    });
    const { store } = fakeStore(objects);
    const said = await saying(() =>
      publish(["--bootstrap", "--days", "1"], store, NOW, suites, noBaselines)
    );
    expect(said).toContain("holds 0 suite(s) and 1 capability setup(s)");
    expect(said).toContain("no suite has a measured cost");
  });

  it("says what the cost model holds when a lane has measured it", async () => {
    const objects = seed();
    objects[CI(DAY, "3")] = laneObject("c3", "2026-08-20T03:00:00.000Z");
    const { store } = fakeStore(objects);
    const said = await saying(() =>
      publish(["--bootstrap", "--days", "1"], store, NOW, suites, noBaselines)
    );
    expect(said).toContain("the cost model holds 1 suite(s) and 1 capability");
    expect(said).not.toContain("overruns");
  });

  it("publishes an empty cost model when no lane has measured one", async () => {
    const { store, created } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const manifest = await publishedManifest(created);
    expect(manifest.calibration.setupCost).toEqual({});
    expect(manifest.calibration.suites).toEqual({});
  });

  it("leaves out an identity no suite claims, and says how many", async () => {
    // Nothing can be asked to run it, so carrying it would put an entry
    // in the manifest that every pass would consider and no lane could
    // place. Saying how many there are is what keeps that visible.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    const { store, created } = fakeStore(seed());
    try {
      await publish(
        ["--bootstrap", "--days", "1"],
        store,
        NOW,
        () => Promise.resolve([]),
        noBaselines,
      );
    } finally {
      console.log = log;
    }
    const manifestName = [...created.keys()].find((name) =>
      name.includes("/manifest-")
    );
    const manifest = parseManifest(
      await gunzipToText(created.get(manifestName!)!),
    );
    expect(manifest!.entries).toEqual([]);
    expect(lines.join("\n")).toContain(
      "no suite claims 1 identities",
    );
  });

  it("keeps an identity the newest window did not read", async () => {
    // What a run reads decides what it folds, and it used to decide what
    // the manifest held: an identity whose records all sat outside the
    // window left the manifest, while the scores it had always had
    // stayed in the aggregate. The exploration draw picks from the
    // manifest, so a test that has gone a long time without running is
    // exactly the one the draw stops being able to reach.
    const objects: Record<string, string> = {
      [CI("2026/08/01", "1")]: object(
        "c1",
        "pass",
        "2026-08-01T01:00:00.000Z",
        "main",
        UNIT,
        "space > reads",
      ),
      [CI(DAY, "1")]: object(
        "c2",
        "pass",
        "2026-08-20T01:00:00.000Z",
        "main",
        UNIT,
      ),
    };
    const { store, created } = fakeStore(objects);
    await publish(
      ["--bootstrap", "--days", "60"],
      store,
      NOW,
      needsFile,
      noBaselines,
    );
    expect(await newestManifest(created)).toEqual([
      "space > reads",
      "space > writes",
    ]);
    objects[CI(DAY, "2")] = object(
      "c3",
      "pass",
      "2026-08-20T02:00:00.000Z",
      "main",
      UNIT,
    );
    await publish(["--days", "1"], store, LATER, needsFile, noBaselines);
    expect(await newestManifest(created)).toEqual([
      "space > reads",
      "space > writes",
    ]);
  });

  it("holds the corpus through a run that folds nothing new", async () => {
    // The same defect at its limit. A window holding no object the
    // aggregate did not already have left the run with no surfaces at
    // all, so it placed nothing, published a manifest with no entries,
    // and that manifest became the newest one.
    const objects: Record<string, string> = {
      [CI(DAY, "1")]: object(
        "c1",
        "pass",
        "2026-08-20T01:00:00.000Z",
        "main",
        UNIT,
      ),
    };
    const { store, created } = fakeStore(objects);
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      needsFile,
      noBaselines,
    );
    await publish(["--days", "1"], store, LATER, needsFile, noBaselines);
    expect(await newestManifest(created)).toEqual(["space > writes"]);
  });

  it("leaves out an identity whose carried file is no longer a unit", async () => {
    // The file the aggregate carries says what was recorded, not that
    // the tree still holds it. The topology is asked again every run, so
    // an identity it can no longer place leaves the manifest and is
    // counted rather than staying on the strength of what it once
    // recorded.
    const objects: Record<string, string> = {
      [CI(DAY, "1")]: object(
        "c1",
        "pass",
        "2026-08-20T01:00:00.000Z",
        "main",
        UNIT,
      ),
    };
    const { store, created } = fakeStore(objects);
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      needsFile,
      noBaselines,
    );
    expect(await newestManifest(created)).toEqual(["space > writes"]);
    const lines = await saying(() =>
      publish(["--days", "1"], store, LATER, lostUnit, noBaselines)
    );
    expect(await newestManifest(created)).toEqual([]);
    expect(lines).toContain("no suite claims 1 identities");
  });

  it("keeps an identity placed by name through a window it did not run in", async () => {
    // A suite whose units are not files places an identity by the name
    // its records carry, so the aggregate holds no file for it and the
    // seeded surface is the identity's own name. That path has to span
    // the window the same way the file-backed one does, and it is the
    // one every identity travels while an aggregate written before the
    // files fills in.
    const objects: Record<string, string> = {
      [CI(DAY, "1")]: object("c1", "pass", "2026-08-20T01:00:00.000Z"),
    };
    const { store, created } = fakeStore(objects);
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    expect(await newestManifest(created)).toEqual(["space > writes"]);
    await publish(["--days", "1"], store, LATER, suites, noBaselines);
    expect(await newestManifest(created)).toEqual(["space > writes"]);
  });

  it("carries a file into a run whose records do not name one", async () => {
    // A suite whose units are files places an identity by the file its
    // records named, and a report that could not name one says nothing
    // about which unit it is in. The file the aggregate carries is what
    // keeps that identity placed.
    const objects: Record<string, string> = {
      [CI(DAY, "1")]: object(
        "c1",
        "pass",
        "2026-08-20T01:00:00.000Z",
        "main",
        UNIT,
      ),
    };
    const { store, created } = fakeStore(objects);
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      needsFile,
      noBaselines,
    );
    objects[CI(DAY, "2")] = object("c2", "pass", "2026-08-20T02:00:00.000Z");
    await publish(["--days", "1"], store, LATER, needsFile, noBaselines);
    expect(await newestManifest(created)).toEqual(["space > writes"]);
  });

  it("carries what each configuration declares unavailable", async () => {
    // A lane reads it to say why a test is absent. Without it the test
    // looks merely unrecorded, which is reported and never failed on.
    const { store, created } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      () =>
        Promise.resolve([{
          ...TOPOLOGY[0]!,
          variant: "server-execution",
          unavailable: [{
            unit: "packages/memory/test/space.test.ts",
            leafName: "space > writes a fact",
            phase: "phase-2",
            reason: "the ON arm cannot run it yet",
          }],
        }]),
      noBaselines,
    );
    const manifestName = [...created.keys()].find((name) =>
      name.includes("/manifest-")
    );
    const manifest = parseManifest(
      await gunzipToText(created.get(manifestName!)!),
    );
    expect(manifest!.unavailable).toEqual([{
      suite: "workspace-unit",
      variant: "server-execution",
      unit: "packages/memory/test/space.test.ts",
      leafName: "space > writes a fact",
      phase: "phase-2",
      reason: "the ON arm cannot run it yet",
    }]);
  });

  it("says how many identities measure a suite rather than a unit", async () => {
    // An overlapping whole-invocation record names no unit, so nothing
    // can be asked to run one, and it must not be summed with the steps
    // inside it either.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    const { store } = fakeStore(seed());
    try {
      await publish(
        ["--bootstrap", "--days", "1"],
        store,
        NOW,
        () =>
          Promise.resolve([{
            ...TOPOLOGY[0]!,
            locate: () => ({ level: "suite" as const }),
          }]),
        noBaselines,
      );
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain(
      "1 identities measure a whole invocation",
    );
  });

  it("folds from the state it left rather than the objects again", async () => {
    const { store, created } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const first = created.size;
    const readObjects: string[] = [];
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        readObjects.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--days", "1"], watched, NOW, suites, noBaselines))
      .toBe(0);
    expect(readObjects).toEqual([]);
    expect(created.size).toBeGreaterThan(first);
  });

  it("refuses to publish when the state area cannot be listed", async () => {
    const { store, created } = fakeStore(seed());
    const broken: StoreAccess = {
      ...store,
      list: (prefix) =>
        prefix.includes("/state")
          ? Promise.reject(new Error("unreachable"))
          : store.list(prefix),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites, noBaselines))
      .toBe(1);
    expect(created.size).toBe(0);
  });

  it("refuses to publish from a window it could only partly read", async () => {
    const { store, created } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      read: () => Promise.reject(new Error("that object is gone")),
      list: (prefix) =>
        prefix.includes("/state")
          ? store.list(prefix)
          : Promise.resolve([CI(DAY, "9")]),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites, noBaselines))
      .toBe(1);
    expect(created.size).toBe(after);
  });

  it("creates nothing at all for a dry run", async () => {
    const { store, created } = fakeStore(seed());
    const code = await publish(
      ["--bootstrap", "--days", "1", "--dry-run"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    expect(code).toBe(0);
    expect(created.size).toBe(0);
  });

  it("creates nothing without a credential", async () => {
    const { store, created } = fakeStore(seed());
    const anonymous: StoreAccess = { ...store, token: () => undefined };
    const code = await publish(
      ["--bootstrap", "--days", "1"],
      anonymous,
      NOW,
      suites,
      noBaselines,
    );
    expect(created.size).toBe(0);
    expect(code).toBe(0);
  });

  it("reports a malformed command line rather than publishing", async () => {
    const { store, created } = fakeStore(seed());
    expect(await publish(["--nonsense"], store, NOW, suites, noBaselines)).toBe(
      2,
    );
    expect(created.size).toBe(0);
  });
});

describe("publish() --out", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("writes the manifest and the state it would have created", async () => {
    const out = await Deno.makeTempDir();
    try {
      const { store, created } = fakeStore(seed());
      const code = await publish(
        ["--bootstrap", "--days", "1", "--dry-run", "--out", out],
        store,
        NOW,
        suites,
        noBaselines,
      );
      expect(code).toBe(0);
      // A dry run creates nothing in the store, and the directory is how
      // the run's answer is looked at instead.
      expect(created.size).toBe(0);

      const manifest = parseManifest(
        await Deno.readTextFile(join(out, "manifest.json")),
      );
      expect(manifest?.entries.length).toBe(1);

      const state = JSON.parse(
        await Deno.readTextFile(join(out, "state.json")),
      );
      expect(Object.keys(state.states).length).toBe(1);
      expect(state.day).toBe("2026-08-20");
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });

  it("makes the directory when it does not exist yet", async () => {
    const parent = await Deno.makeTempDir();
    try {
      const out = join(parent, "a", "b");
      const { store } = fakeStore(seed());
      expect(
        await publish(
          ["--bootstrap", "--days", "1", "--dry-run", "--out", out],
          store,
          NOW,
          suites,
          noBaselines,
        ),
      ).toBe(0);
      expect((await Deno.stat(join(out, "manifest.json"))).isFile).toBe(true);
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  });
});

const ROLLUP = `labs/test-records/aggregated/v1/${DAY}/shard-0.ndjson`;

describe("publish() over a day that has been compacted", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("folds a bootstrap day from its rollup instead of its objects", async () => {
    const read: string[] = [];
    const { store } = fakeStore({
      ...seed(),
      [ROLLUP]: object("c3", "fail", "2026-08-20T03:00:00.000Z"),
    }, { [DAY]: [ROLLUP] });
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(
      await publish(
        ["--bootstrap", "--days", "1"],
        watched,
        NOW,
        suites,
        noBaselines,
      ),
    )
      .toBe(0);
    expect(read).toEqual([ROLLUP]);
  });

  it("asks nothing about a source and date already settled", async () => {
    // The receipt answers, so the store is not asked at all. It is the
    // rule that decides, rather than which flag the run was given.
    const { store } = fakeStore({
      ...seed(),
      [ROLLUP]: object("c3", "fail", "2026-08-20T03:00:00.000Z"),
    }, { [DAY]: [ROLLUP] });
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const asked: string[] = [];
    const watched: StoreAccess = {
      ...store,
      rollupShards: (day) => {
        asked.push(day);
        return store.rollupShards(day);
      },
    };
    expect(await publish(["--days", "1"], watched, NOW, suites, noBaselines))
      .toBe(0);
    expect(asked).toEqual([]);
  });

  it("takes a rollup on an incremental run over a day it has not seen", async () => {
    // One rule, so a run catching up after an outage or a widened window
    // reaches a day the same way a bootstrap does. A flag is permission
    // to start from an empty aggregate and a wider window, not a second
    // way to choose inputs.
    const older = "2026/08/19";
    const olderRollup =
      `labs/test-records/aggregated/v1/${older}/shard-0.ndjson`;
    const { store } = fakeStore({
      ...seed(),
      [CI(older, "9")]: object("c9", "pass", "2026-08-19T01:00:00.000Z"),
      [olderRollup]: object("c9", "pass", "2026-08-19T01:00:00.000Z"),
    }, { [older]: [olderRollup] });
    // The first run's window holds only the newer day, so the older one
    // is a day the aggregate has never seen.
    expect(
      await publish(
        ["--bootstrap", "--days", "1"],
        store,
        NOW,
        suites,
        noBaselines,
      ),
    )
      .toBe(0);
    const read: string[] = [];
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--days", "2"], watched, NOW, suites, noBaselines))
      .toBe(0);
    expect(read).toContain(olderRollup);
    expect(read).not.toContain(CI(older, "9"));
  });

  it("stays on the raw path for a day it already holds raw objects from", async () => {
    // A rollup written afterwards would overlap those contributions, and
    // nothing in one of this format says by how much, so the pair that
    // has raw objects in the aggregate keeps taking raw ones.
    const { store } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const read: string[] = [];
    const asked: string[] = [];
    const later: StoreAccess = {
      ...store,
      // The rollup arrives after the raw objects were folded, which is
      // the order compaction runs in.
      rollupShards: (day) => {
        asked.push(day);
        return Promise.resolve(day === DAY ? [ROLLUP] : undefined);
      },
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--days", "1"], later, NOW, suites, noBaselines))
      .toBe(0);
    expect(read).not.toContain(ROLLUP);
    // Nor was the store asked: the aggregate already answers for the pair.
    expect(asked).toEqual([]);
  });

  it("still reads the local submissions of a settled day", async () => {
    // Rollups cover the continuous-integration area alone. A receipt
    // naming the day by itself would say the day is accounted for, and
    // the local submissions of that day — the evidence the score weighs
    // highest — would never be read.
    const local = LOCAL(DAY, "ianh");
    const { store } = fakeStore({
      [ROLLUP]: object("c3", "pass", "2026-08-20T03:00:00.000Z"),
      [local]: localObject("c4", "2026-08-20T04:00:00.000Z"),
    }, { [DAY]: [ROLLUP] });
    const read: string[] = [];
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(
      await publish(
        ["--bootstrap", "--days", "1"],
        watched,
        NOW,
        suites,
        noBaselines,
      ),
    )
      .toBe(0);
    expect(read).toContain(ROLLUP);
    expect(read).toContain(local);
  });

  /**
   * A day whose rollup is several shards, the last of which will not
   * read, over a store that also holds that day's raw objects. The
   * shards carry a run the raw objects do not, and name a file the raw
   * objects do not, so anything the fold kept from the shards that did
   * read shows up in what was published.
   */
  function withBrokenRollup() {
    const shards = Array.from(
      { length: SHARD_CHUNK + 1 },
      (_, index) =>
        `labs/test-records/aggregated/v1/${DAY}/shard-${index}.ndjson`,
    );
    const objects: Record<string, string> = { ...seed() };
    for (const shard of shards) {
      objects[shard] = object(
        "c3",
        "pass",
        "2026-08-20T03:00:00.000Z",
        "main",
        UNIT,
      );
    }
    const { store, created } = fakeStore(objects, { [DAY]: shards });
    const broken: StoreAccess = {
      ...store,
      read: (name) =>
        name === shards.at(-1)
          ? Promise.reject(new Error("that shard is gone"))
          : store.read(name),
    };
    return { objects, broken, created };
  }

  it("reads a day from its raw objects when a shard will not read", async () => {
    // Ending the run would end every later one the same way: the store
    // holds create and nothing else, so the shard stays where it is and
    // the day is never recorded as folded. A rollup is a read
    // optimization and the day's raw objects are all still there, so the
    // day is read the long way instead.
    const { objects, broken, created } = withBrokenRollup();
    expect(
      await publish(
        ["--bootstrap", "--days", "1"],
        broken,
        NOW,
        suites,
        noBaselines,
      ),
    )
      .toBe(0);
    const stateName = [...created.keys()].find((name) =>
      name.includes("/state/")
    )!;
    const state = parseAggregate(await gunzipToText(created.get(stateName)!));
    const raw = [CI(DAY, "1"), CI(DAY, "2")];
    expect(state?.folded).toEqual(raw);
    // Left open rather than settled, so later runs read it the same way
    // rather than taking a rollup nothing read as accounted for.
    expect(state?.compacted).toEqual([]);
    // What the shards that did read carried reaches neither the scores
    // nor the files the next run seeds its surfaces from.
    const whole = new Fold(
      emptyAggregate("2026-08-20"),
      new AliasResolver([]),
      "2026-08-20",
    );
    whole.add(raw.map((name) => reportFromText(name, objects[name]!)));
    expect(state?.states).toEqual(whole.finish().aggregate.states);
    expect(state?.files).toEqual({});
  });

  it("says which day it read the long way", async () => {
    const { broken } = withBrokenRollup();
    const said = await saying(
      () =>
        publish(
          ["--bootstrap", "--days", "1"],
          broken,
          NOW,
          suites,
          noBaselines,
        ),
      "warn",
    );
    expect(said).toContain("that shard is gone");
    expect(said).toContain(`reading ${DAY} from its raw objects instead`);
  });

  for (
    const { name, first, last } of [
      {
        name: "orders main runs across shard batches",
        first: object("c2", "pass", "2026-08-20T02:00:00.000Z"),
        last: object("c1", "fail", "2026-08-20T01:00:00.000Z"),
      },
      {
        name:
          "classifies same-commit disagreement across shard batches as a flake",
        first: object("c1", "fail", "2026-08-20T01:00:00.000Z", "feature"),
        last: object("c1", "pass", "2026-08-20T02:00:00.000Z", "feature"),
      },
    ]
  ) {
    it(name, async () => {
      const shards = Array.from(
        { length: SHARD_CHUNK + 1 },
        (_, index) =>
          `labs/test-records/aggregated/v1/${DAY}/shard-${index}.ndjson`,
      );
      const objects = Object.fromEntries(shards.map((shard, index) => [
        shard,
        index === 0
          ? first
          : index === SHARD_CHUNK
          ? last
          : object(`skip-${index}`, "skip", "2026-08-20T01:30:00.000Z"),
      ]));
      const whole = new Fold(
        emptyAggregate("2026-08-20"),
        new AliasResolver([]),
        "2026-08-20",
      );
      whole.add(shards.map((shard) => reportFromText(shard, objects[shard]!)));
      const { store, created } = fakeStore(objects, { [DAY]: shards });
      expect(
        await publish(
          ["--bootstrap", "--days", "1"],
          store,
          NOW,
          suites,
          noBaselines,
        ),
      )
        .toBe(0);
      const stateName = [...created.keys()].find((name) =>
        name.includes("/state/")
      )!;
      const state = parseAggregate(await gunzipToText(created.get(stateName)!));
      expect(state?.states).toEqual(whole.finish().aggregate.states);
      expect(state?.folded).toEqual(shards);
      expect(state?.compacted).toEqual([`ci\t${DAY}`]);
    });
  }

  it("consumes each batch before requesting the next shards", async () => {
    const shards = Array.from(
      { length: SHARD_CHUNK * 2 + 1 },
      (_, index) =>
        `labs/test-records/aggregated/v1/${DAY}/shard-${index}.ndjson`,
    );
    const objects: Record<string, string> = { ...seed() };
    for (const shard of shards) {
      objects[shard] = object("c3", "fail", "2026-08-20T03:00:00.000Z");
    }
    const { store } = fakeStore(objects, { [DAY]: shards });
    const read: string[] = [];
    let live = 0;
    let peak = 0;
    const consumed = new Set<string>();
    const watched: StoreAccess = {
      ...store,
      read: async (name) => {
        expect(read.length - consumed.size).toBeLessThan(SHARD_CHUNK);
        read.push(name);
        live++;
        peak = Math.max(peak, live);
        try {
          const report = await store.read(name);
          return {
            ...report,
            reports: report.reports.map((group) => ({
              ...group,
              get records() {
                consumed.add(name);
                return group.records;
              },
            })),
          };
        } finally {
          live--;
        }
      },
    };
    expect(
      await publish(
        ["--bootstrap", "--days", "1"],
        watched,
        NOW,
        suites,
        noBaselines,
      ),
    )
      .toBe(0);
    expect(read).toEqual(shards);
    expect(peak).toBeLessThanOrEqual(SHARD_CHUNK);
  });
});

describe("publish() over an aggregate holding tests the tree has lost", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");
  // Named through the store rather than written out, so that a spelled-out
  // path cannot drift from the one the publisher looks under.
  const STATE = stateObjectName("2026-08-19", "0");
  const DELETED = JSON.stringify(["unit", "memory", "space > erases"]);
  const SILENT = JSON.stringify(["unit", "memory", "space > unreported"]);

  /** An aggregate carrying two identities this topology cannot place. */
  function carrying(): string {
    return JSON.stringify({
      schema: MANIFEST_SCHEMA_VERSION,
      day: "2026-08-19",
      folded: [],
      compacted: [],
      states: {
        // A test deleted long enough ago for every window to have passed
        // over it: no unit, and no run inside what a state still holds.
        [DELETED]: { ...emptyState(), mainCatches: 2 },
        // A test that runs and whose records never say which file it is
        // in: no unit either, and running all the same.
        [SILENT]: { ...emptyState(), runsByDay: { "2026-08-20": 3 } },
      },
      files: {
        [DELETED]: "packages/memory/test/erase.test.ts",
        [SILENT]: "packages/memory/test/unreported.test.ts",
      },
    });
  }

  it("stops carrying the deleted test and keeps the silent one", async () => {
    const { store, created } = fakeStore({ ...seed(), [STATE]: carrying() });
    expect(
      await publish(["--days", "1"], store, NOW, needsFile, noBaselines),
    ).toBe(0);
    const written = [...created.keys()].find((name) =>
      name.includes("/state/")
    )!;
    const after = parseAggregate(await gunzipToText(created.get(written)!))!;
    expect(Object.keys(after.states)).not.toContain(DELETED);
    expect(Object.keys(after.files)).not.toContain(DELETED);
    // Nothing places this one either, and dropping it would throw away
    // the history of a test that is running right now.
    expect(Object.keys(after.states)).toContain(SILENT);
  });

  it("says which identities left the tree and which are still recording", async () => {
    const { store } = fakeStore({ ...seed(), [STATE]: carrying() });
    const said = await saying(() =>
      publish(["--days", "1"], store, NOW, needsFile, noBaselines)
    );
    expect(said).toContain("1 identities have left the tree");
    // The seeded runs record no file either, so they are unplaced and
    // running, which is the other half of what the count separates.
    expect(said).toContain(
      "no suite claims 2 identities the aggregate still carries",
    );
  });
});

describe("publish() over a topology two suites read the same way", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("names the identities neither suite can be given", async () => {
    // Placing one either way would put the work in whichever suite came
    // first, so the publisher holds them out and says how many. The
    // count is apart from the tests that have left because the tree
    // holds these twice over rather than not at all.
    const { store, created } = fakeStore(seed());
    const said = await saying(() =>
      publish(
        ["--bootstrap", "--days", "1"],
        store,
        NOW,
        twoSuites,
        noBaselines,
      )
    );
    expect(said).toContain("1 identities are claimed by more than one suite");
    expect(said).toContain("unit:memory 1");
    // Held out of the manifest rather than placed under one of them.
    const manifest = await publishedManifest(created);
    expect(manifest.entries).toEqual([]);
  });
});

describe("publish() over an aggregate it cannot make sense of", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("refuses rather than starting again from nothing", async () => {
    const { store, created } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const state = [...created.keys()].find((name) => name.includes("/state/"))!;
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      readText: (name) =>
        name === state
          ? Promise.resolve('{"schema":1,"nonsense":true}')
          : store.readText(name),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites, noBaselines))
      .toBe(1);
    expect(created.size).toBe(after);
  });
});

describe("publish() over a state written further ahead than it reads", () => {
  // Nothing but the publisher creates a state, and it creates one only
  // where it folded, so a newest state it cannot read is one every later
  // run comes to in the same condition. These turn on whether such a
  // state stops the publisher or is passed over for the one behind it.

  const NOW = new Date("2026-08-20T12:00:00.000Z");
  const KEPT = JSON.stringify(["unit", "memory", "space > writes"]);
  const AHEAD = MANIFEST_SCHEMA_VERSION + 1;

  /** A state carrying one identity's catches, in the shape given. */
  function carrying(schema: number, day: string): string {
    return JSON.stringify({
      schema,
      day,
      folded: [],
      compacted: [],
      states: { [KEPT]: { ...emptyState(), mainCatches: 2 } },
      files: { [KEPT]: "packages/memory/test/space.test.ts" },
    });
  }

  it("folds onto the newest state behind it and keeps its catches", async () => {
    const behind = stateObjectName("2026-08-20", "0");
    const over = stateObjectName("2026-08-20", "1");
    const { store, created } = fakeStore({
      ...seed(),
      [behind]: carrying(MANIFEST_SCHEMA_VERSION, "2026-08-20"),
      [over]: carrying(AHEAD, "2026-08-20"),
    });
    // The two lines the recovery procedure reads a run's log for: which
    // state it could not use, and which it took instead.
    const said = await saying(() =>
      publish(["--days", "1"], store, NOW, suites, noBaselines)
    );
    expect(said).toContain(`passing over ${over}: it is written in shape`);
    expect(said).toContain(`folding onto ${behind}`);
    const entry = (await publishedManifest(created)).entries.find((one) =>
      testIdentityKey(one.test) === KEPT
    );
    // Two main catches stood in the state that was folded onto, and the
    // window holds one more. A run that had lost that state would carry
    // the window's alone, and one that folded the window twice would
    // carry four.
    expect(entry?.inputs.catches).toBe(CATCH_WEIGHT_MAIN * 3);
  });

  it("names both shapes and what to deploy when nothing behind it reads", async () => {
    const { store, created } = fakeStore({
      ...seed(),
      [stateObjectName("2026-08-20", "1")]: carrying(AHEAD, "2026-08-20"),
    });
    const said = await saying(
      () => publish(["--days", "1"], store, NOW, suites, noBaselines),
      "warn",
    );
    expect(said).toContain(
      `it is written in shape ${AHEAD}, and this publisher reads shape ` +
        `${MANIFEST_SCHEMA_VERSION}`,
    );
    expect(said).toContain(
      `deploy a publisher that reads shape ${AHEAD} or above`,
    );
    // The remedy that would lose the history the state holds is named as
    // the one not to reach for.
    expect(said).toContain("do not bootstrap");
    expect(created.size).toBe(0);
  });

  it("passes over a body that arrived and is not JSON at all", async () => {
    // A truncated or half-written body is the other way a stored state
    // is one no publisher will ever read, beside a shape from further
    // ahead, and nothing can replace it under create-only credentials.
    const garbage = stateObjectName("2026-08-20", "1");
    const { store, created } = fakeStore({
      ...seed(),
      [stateObjectName("2026-08-20", "0")]: carrying(
        MANIFEST_SCHEMA_VERSION,
        "2026-08-20",
      ),
      [garbage]: "{not json at all",
    });
    const said = await saying(() =>
      publish(["--days", "1"], store, NOW, suites, noBaselines)
    );
    expect(said).toContain(
      `passing over ${garbage}: it is not an aggregate this publisher`,
    );
    const entry = (await publishedManifest(created)).entries.find((one) =>
      testIdentityKey(one.test) === KEPT
    );
    expect(entry?.inputs.catches).toBe(CATCH_WEIGHT_MAIN * 3);
  });

  it("refuses a state the store names and will not give", async () => {
    // A read that does not arrive says nothing about the object, so the
    // state behind it is not taken in its place: the run that did so
    // would write a state superseding the one it skipped.
    const missing = stateObjectName("2026-08-20", "1");
    const { store, created } = fakeStore({
      ...seed(),
      [stateObjectName("2026-08-20", "0")]: carrying(
        MANIFEST_SCHEMA_VERSION,
        "2026-08-20",
      ),
      [missing]: carrying(MANIFEST_SCHEMA_VERSION, "2026-08-20"),
    });
    const refusing: StoreAccess = {
      ...store,
      readText: (name) =>
        name === missing
          ? Promise.reject(new Error("HTTP 503"))
          : store.readText(name),
    };
    const said = await saying(
      () => publish(["--days", "1"], refusing, NOW, suites, noBaselines),
      "warn",
    );
    expect(said).toContain(`reading ${missing} failed`);
    expect(created.size).toBe(0);
  });

  it("reads an area holding no state object as a first run", async () => {
    // An object under the prefix named some other way is not one of the
    // publisher's states, so it is neither read as an aggregate nor
    // counted as evidence that one is stored.
    const { store, created } = fakeStore({
      ...seed(),
      [`${statePrefix()}/notes.json.gz`]: "{}",
    });
    const said = await saying(
      () => publish(["--days", "1"], store, NOW, suites, noBaselines),
      "warn",
    );
    expect(said).toContain("no aggregate exists yet");
    expect(said).not.toContain("notes.json.gz");
    expect(created.size).toBe(0);
  });

  it("refuses a state from before the days it reads", async () => {
    const { store, created } = fakeStore({
      ...seed(),
      [stateObjectName("2026-08-18", "0")]: carrying(
        MANIFEST_SCHEMA_VERSION,
        "2026-08-18",
      ),
      [stateObjectName("2026-08-20", "1")]: carrying(AHEAD, "2026-08-20"),
    });
    const said = await saying(
      () => publish(["--days", "1"], store, NOW, suites, noBaselines),
      "warn",
    );
    expect(said).toContain(
      "named for days before 2026-08-20, which is the first day this run " +
        "reads",
    );
    expect(created.size).toBe(0);
  });

  it("reaches that state once the window reads its day", async () => {
    const { store, created } = fakeStore({
      ...seed(),
      [stateObjectName("2026-08-18", "0")]: carrying(
        MANIFEST_SCHEMA_VERSION,
        "2026-08-18",
      ),
      [stateObjectName("2026-08-20", "1")]: carrying(AHEAD, "2026-08-20"),
    });
    expect(await publish(["--days", "3"], store, NOW, suites, noBaselines))
      .toBe(0);
    const entry = (await publishedManifest(created)).entries.find((one) =>
      testIdentityKey(one.test) === KEPT
    );
    // The state named for a day the wider window reaches carried two of
    // these, and the window carries the third.
    expect(entry?.inputs.catches).toBe(CATCH_WEIGHT_MAIN * 3);
  });
});

describe("writeToken()", () => {
  const NAME = "TEST_RECORDS_GCS_TOKEN";

  /** Runs with the variable set as given, and puts back what was there. */
  function withToken<T>(value: string | undefined, body: () => T): T {
    const before = Deno.env.get(NAME);
    if (value === undefined) Deno.env.delete(NAME);
    else Deno.env.set(NAME, value);
    try {
      return body();
    } finally {
      if (before === undefined) Deno.env.delete(NAME);
      else Deno.env.set(NAME, before);
    }
  }

  it("is the federated token the workflow was given", () => {
    expect(withToken("ya29.a0", writeToken)).toBe("ya29.a0");
  });

  it("is nothing when the variable is unset", () => {
    expect(withToken(undefined, writeToken)).toBeUndefined();
  });

  it("is nothing when the variable is set to empty", () => {
    // A step that failed to mint one leaves the variable set and empty.
    // Read as a token it would reach the store and be refused there.
    expect(withToken("", writeToken)).toBeUndefined();
  });
});

describe("publish() over a store that answers badly", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("refuses when the aggregate object will not read", async () => {
    const { store, created } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      readText: () => Promise.reject(new Error("that object is gone")),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites, noBaselines))
      .toBe(1);
    expect(created.size).toBe(after);
  });

  it("refuses when the submissions cannot be listed", async () => {
    const { store, created } = fakeStore(seed());
    await publish(
      ["--bootstrap", "--days", "1"],
      store,
      NOW,
      suites,
      noBaselines,
    );
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      list: (prefix) =>
        prefix.includes("/submissions/")
          ? Promise.reject(new Error("the store is unreachable"))
          : store.list(prefix),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites, noBaselines))
      .toBe(1);
    expect(created.size).toBe(after);
  });
});

describe("publish() reporting what no lane can hold", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("names it with the cost the bound was judged against", async () => {
    const slow = (commit: string, at: string) => {
      const body = object(commit, "pass", at);
      // One execution taking longer than a lane's whole hard bound.
      return body.replace('"durationMs":40', '"durationMs":400000');
    };
    const { store } = fakeStore({
      [CI(DAY, "1")]: slow("c1", "2026-08-20T01:00:00.000Z"),
      [CI(DAY, "2")]: slow("c2", "2026-08-20T02:00:00.000Z"),
    });
    const said: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => said.push(parts.join(" "));
    try {
      expect(
        await publish(
          ["--bootstrap", "--days", "1"],
          store,
          NOW,
          suites,
          noBaselines,
        ),
      )
        .toBe(0);
    } finally {
      console.log = log;
    }
    const line = said.find((said) => said.includes("unschedulable"));
    expect(line).toBeDefined();
    expect(line).toContain("space > writes");
    expect(line).toContain("400.0s");
  });

  it("names the costliest few and counts the rest", async () => {
    // A cost model charging a whole suite more than a lane can hold puts
    // every test in that suite on this list, which has run to tens of
    // thousands. One line each is more than a job summary holds, and
    // GitHub drops a summary past its bound whole.
    const objects: Record<string, string> = {};
    for (let test = 0; test < 25; test++) {
      for (const attempt of ["a", "b"]) {
        const commit = `c${test}-${attempt}`;
        const body = object(
          commit,
          "pass",
          "2026-08-20T01:00:00.000Z",
          "main",
          undefined,
          `space > writes ${test}`,
        );
        // The last of them is the slowest, so the order the lines come
        // in is visible in what they say.
        objects[CI(DAY, commit)] = body.replace(
          '"durationMs":40',
          `"durationMs":${400000 + test * 1000}`,
        );
      }
    }
    const { store, created } = fakeStore(objects);
    const said = await saying(() =>
      publish(["--bootstrap", "--days", "1"], store, NOW, suites, noBaselines)
    );
    const named = said.split("\n").filter((line) =>
      line.includes("test selection: unschedulable,")
    );
    expect(named.length).toBe(10);
    expect(named[0]).toContain("space > writes 24");
    expect(said).toContain(
      "test selection: 15 further identities cost more than a lane can hold",
    );
    // What the cap holds back from the log it does not hold back from
    // the manifest, which is where a consumer reads the whole of it.
    const manifest = await publishedManifest(created);
    expect(manifest.unschedulable).toHaveLength(25);
    expect(
      manifest.unschedulable.map((entry) => entry.test.n).sort(),
    ).toEqual(
      Array.from({ length: 25 }, (_, at) => `space > writes ${at}`).sort(),
    );
  });
});

describe("the baselines a publish carries", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");

  /** A fetch answering a listing with nothing under the prefix. */
  const empty: typeof globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        '<?xml version="1.0"?><ListBucketResult></ListBucketResult>',
        { status: 200 },
      ),
    );

  it("carries nothing where there is no manifest to read", async () => {
    // The walk over recent runs is then the only source, which is what
    // rebuilds the window over the publishes that follow. A publisher
    // without a credential reads no runs, so this carries nothing.
    expect(await liveBaselines(now, empty)).toEqual([]);
  });
});
