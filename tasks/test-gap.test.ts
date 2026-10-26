import { expect } from "@std/expect";
import { exists } from "@std/fs";
import { dirname, fromFileUrl, join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import type { TestIdentity } from "@commonfabric/test-support/records";
import { shuffleNotice } from "@commonfabric/test-support/shuffle";
import {
  CAPABILITIES,
  type Capability,
  type CapabilityId,
  openCapabilities,
} from "./ci-capabilities.ts";
import { LaneStop } from "./ci-lane.ts";
import { pricedForRun } from "./test-selection/census.ts";
import type { Manifest, ManifestEntry } from "./test-selection/manifest.ts";
import type { Plan } from "./test-selection/plan.ts";
import { sampleEntry, sampleManifest } from "./test-selection/testing.ts";
import { testTitle } from "./test-summary.ts";
import type { Suite } from "./test-topology.ts";
import {
  afterSummaryLines,
  defaultBase,
  describeGap,
  type Gap,
  GAP_SECONDS,
  gapOf,
  type GapRun,
  localChanges,
  main,
  parseGapArgs,
  runGap,
  setupCosts,
  snapshotTree,
  sourceModules,
  unitSources,
  unitsReached,
  workstationRegistry,
} from "./test-gap.ts";

/** The repository this file is in. */
const REPOSITORY = dirname(dirname(fromFileUrl(import.meta.url)));

/** A test of the bakery scope named `name`. */
function test(name: string): TestIdentity {
  return { k: "unit", s: "bakery", n: name };
}

/** An entry for the test `name` in `unit` of the suite `suite`. */
function entry(
  name: string,
  unit: string,
  fields: Partial<ManifestEntry> = {},
): ManifestEntry {
  return sampleEntry(test(name), { suite: "bakery", unit, ...fields });
}

/** A pull request's plan running exactly `entries`, in one lane. */
function running(entries: readonly ManifestEntry[]): Pick<Plan, "lanes"> {
  return {
    lanes: [{
      lane: 1,
      selections: entries.map((held) => ({
        entry: held,
        reason: "value",
        repeats: 1,
      })),
      projectedSeconds: 0,
      capabilities: [],
    }],
  };
}

/** What a test of the bakery suite does when it runs, or `missing` for none. */
type Outcome = "pass" | "fail" | "missing";

/**
 * A suite of the bakery scope holding `units`, which places a record in the
 * unit `units` names it under and needs `needs`. Its command writes, for
 * each test of the units it is handed, the record `outcomes` names for that
 * test, which is a pass where it names nothing, and no record where it names
 * `missing`.
 */
function bakery(
  units: Record<string, readonly string[]>,
  outcomes: Record<string, Outcome> = {},
  needs: Suite["needs"] = ["deno"],
): Suite {
  const unitOf = new Map<string, string>();
  for (const [unit, names] of Object.entries(units)) {
    for (const name of names) unitOf.set(name, unit);
  }
  return {
    id: "bakery",
    recordSurfaces: [{ kind: "unit", scope: "bakery" }],
    needs,
    units: Object.keys(units),
    unavailable: [],
    whole: [],
    locate(record) {
      const unit = unitOf.get(record.test.n);
      return unit === undefined ? undefined : { level: "unit", unit };
    },
    command(asked, context) {
      const lines = asked.flatMap(({ unit }) =>
        (units[unit] ?? []).flatMap((name) =>
          outcomes[name] === "missing" ? [] : [
            JSON.stringify({
              line: "record",
              test: test(name),
              outcome: outcomes[name] ?? "pass",
              durationMs: 1,
            }) + "\n",
          ]
        )
      ).join("");
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "eval",
          `Deno.writeTextFileSync(
            Deno.env.get("CF_TEST_RECORDS_DIR") + "/fragment-bakery.ndjson",
            ${JSON.stringify(lines)},
          )`,
        ],
        cwd: context.root,
      }]);
    },
  };
}

/** A gap choosing `units` of the bakery suite, whose tests `manifest` holds. */
function gapOver(manifest: Manifest, units: readonly string[]): Gap {
  return gapOf({
    manifest,
    suites: [bakery({})],
    ci: running([]),
    reached: new Map(units.map((unit) => [`bakery\t${unit}`, 1])),
    budgetSeconds: 600,
  });
}

/** Runs git in `root`, and throws where git fails. */
async function git(root: string, ...args: string[]): Promise<void> {
  const result = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd: root,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
}

/** A new repository holding `files`, committed once and tagged `base`. */
async function repository(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "test-gap-" });
  await git(root, "init", "-q");
  for (const [file, text] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(root, file)), { recursive: true });
    await Deno.writeTextFile(join(root, file), text);
  }
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "base");
  await git(root, "tag", "base");
  return root;
}

describe("test-gap", () => {
  describe("parseGapArgs()", () => {
    it("returns a run of the default budget for no arguments", () => {
      expect(parseGapArgs([])).toEqual({ dryRun: false, seconds: GAP_SECONDS });
    });

    it("returns each flag it is given", () => {
      expect(
        parseGapArgs(["--dry-run", "--base", "main", "--seconds", "90"]),
      ).toEqual({ dryRun: true, base: "main", seconds: 90 });
    });

    it("returns `undefined` for an unknown flag or a flag missing its value", () => {
      expect(parseGapArgs(["--lane", "1"])).toBeUndefined();
      expect(parseGapArgs(["--base"])).toBeUndefined();
    });

    it("returns `undefined` for a budget that is not a positive number", () => {
      for (const seconds of ["0", "-5", "soon", " "]) {
        expect(parseGapArgs(["--seconds", seconds])).toBeUndefined();
      }
    });
  });

  describe("defaultBase()", () => {
    let root: string;

    beforeEach(async () => {
      root = await repository({ "a.ts": "" });
    });

    afterEach(async () => {
      await Deno.remove(root, { recursive: true });
    });

    it("returns `origin/main` where the checkout has no `upstream/main`", async () => {
      expect(await defaultBase(root)).toBe("origin/main");
    });

    it("returns `upstream/main` where the checkout has one", async () => {
      await git(root, "update-ref", "refs/remotes/upstream/main", "HEAD");
      expect(await defaultBase(root)).toBe("upstream/main");
    });
  });

  describe("localChanges()", () => {
    it("returns what was committed since the base, what is uncommitted, and what is new", async () => {
      const root = await repository({
        "committed.ts": "",
        "edited.ts": "",
        "untouched.ts": "",
        ".gitignore": "*.log\n",
      });
      try {
        await Deno.writeTextFile(join(root, "committed.ts"), "1");
        await git(root, "commit", "-q", "-am", "change");
        await Deno.writeTextFile(join(root, "edited.ts"), "1");
        await Deno.writeTextFile(join(root, "new.ts"), "");
        await Deno.writeTextFile(join(root, "ignored.log"), "");
        expect([...await localChanges(root, "base")].sort()).toEqual([
          "committed.ts",
          "edited.ts",
          "new.ts",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("unitSources()", () => {
    it("returns the files a suite declares a unit runs, or the file it is named for", async () => {
      const root = await repository({
        "a.test.ts": "",
        "data.json": "",
        "member/b.test.ts": "",
      });
      try {
        const suite: Suite = {
          ...bakery({
            "a.test.ts": [],
            "data.json": [],
            "gone.test.ts": [],
            "member": [],
            "a gate": [],
          }),
          sourcesOf: (unit) =>
            unit === "member"
              ? ["member/b.test.ts", "member/gone.test.ts"]
              : [],
        };
        expect(unitSources(root, [suite])).toEqual(
          new Map([
            ["bakery\ta.test.ts", ["a.test.ts"]],
            ["bakery\tdata.json", ["data.json"]],
            ["bakery\tgone.test.ts", []],
            ["bakery\tmember", ["member/b.test.ts"]],
            ["bakery\ta gate", []],
          ]),
        );
        expect(unitSources(root, [{ ...suite, judges: new Map() }]).size)
          .toBe(0);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("sourceModules()", () => {
    it("returns each module among the sources once, and nothing else", () => {
      expect(
        sourceModules(
          new Map([
            ["bakery\ta", ["a.test.ts", "data.sqlite"]],
            ["other\ta", ["a.test.ts"]],
          ]),
        ),
      ).toEqual(["a.test.ts"]);
    });
  });

  describe("unitsReached()", () => {
    // `near.test.ts` is one step from the change and `far.test.ts` three.
    // The member's unit runs `member/a.test.ts`, two steps out, and
    // `member/b.test.ts`, four out. `other.test.ts` is not reached.

    const reach = new Map([
      ["lib.ts", 0],
      ["near.test.ts", 1],
      ["member/a.test.ts", 2],
      ["member/b.test.ts", 4],
      ["far.test.ts", 3],
    ]);
    const sources = new Map([
      ["bakery\tnear.test.ts", ["near.test.ts"]],
      ["bakery\tfar.test.ts", ["far.test.ts"]],
      ["bakery\tother.test.ts", ["other.test.ts"]],
      ["bakery\tmember", ["member/b.test.ts", "member/a.test.ts"]],
      ["bakery\ta gate", []],
    ]);

    it("returns each unit the change reaches, at the nearest file it runs", () => {
      expect(unitsReached(new Set(["lib.ts"]), reach, sources)).toEqual(
        new Map([
          ["bakery\tnear.test.ts", 1],
          ["bakery\tfar.test.ts", 3],
          ["bakery\tmember", 2],
        ]),
      );
    });

    it("returns every unit running a file, and a touched one at no steps, where the change reaches everything", () => {
      expect(
        unitsReached(
          new Set(["a gate", "member/b.test.ts"]),
          "everything",
          sources,
        ),
      ).toEqual(
        new Map([
          ["bakery\tnear.test.ts", 1],
          ["bakery\tfar.test.ts", 1],
          ["bakery\tother.test.ts", 1],
          ["bakery\tmember", 0],
          ["bakery\ta gate", 0],
        ]),
      );
    });
  });

  describe("setupCosts()", () => {
    it("returns what opening a capability costs, and what building its binary costs where it builds one", () => {
      const costs = setupCosts(sampleManifest({
        entries: [
          sampleEntry(test("build-binary toolshed"), {
            suite: "binaries-opposite",
            unit: "toolshed",
            cost: 90,
          }),
          sampleEntry(test("build-binary cf"), {
            suite: "binaries",
            unit: "cf",
            cost: 70,
          }),
        ],
        calibration: {
          setupCost: { "toolshed-baked-opposite": 20, toolshed: 5 },
          suites: {},
          prologue: 0,
        },
      }));
      expect(costs.get("toolshed-baked-opposite")).toBe(110);
      expect(costs.get("toolshed-baked")).toBe(0);
      expect(costs.get("toolshed")).toBe(5);
    });
  });

  describe("snapshotTree()", () => {
    it("returns a worktree of the working tree as it stands, leaving the repository's own index alone", async () => {
      const root = await repository({
        "tracked.ts": "1",
        "untouched.ts": "1",
        "gone.ts": "1",
        ".gitignore": "*.log\n",
      });
      try {
        await Deno.writeTextFile(join(root, "tracked.ts"), "2");
        await Deno.writeTextFile(join(root, "new.ts"), "3");
        await Deno.writeTextFile(join(root, "ignored.log"), "4");
        await Deno.remove(join(root, "gone.ts"));
        const snapshot = await snapshotTree(root);
        const read = (file: string) =>
          Deno.readTextFile(join(snapshot.tree, file)).catch(() => undefined);
        expect(await read("tracked.ts")).toBe("2");
        expect(await read("new.ts")).toBe("3");
        expect(await read("untouched.ts")).toBe("1");
        expect(await read("ignored.log")).toBeUndefined();
        expect(await read("gone.ts")).toBeUndefined();
        const status = await new Deno.Command("git", {
          args: ["status", "--porcelain"],
          cwd: root,
          stdout: "piped",
        }).output();
        expect(new TextDecoder().decode(status.stdout).split("\n").sort())
          .toEqual(["", " D gone.ts", " M tracked.ts", "?? new.ts"]);
        await snapshot.remove();
        expect(await exists(dirname(snapshot.tree))).toBe(false);
        const listed = await new Deno.Command("git", {
          args: ["worktree", "list", "--porcelain"],
          cwd: root,
          stdout: "piped",
        }).output();
        expect(new TextDecoder().decode(listed.stdout)).not.toContain(
          snapshot.tree,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("throws what failed, and leaves nothing behind, where the snapshot cannot be made", async () => {
      const root = await Deno.makeTempDir({ prefix: "test-gap-not-git-" });
      const under = await Deno.makeTempDir({ prefix: "test-gap-under-" });
      try {
        await expect(snapshotTree(root, under)).rejects.toThrow(
          "cannot snapshot the working tree",
        );
        expect([...Deno.readDirSync(under)]).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
        await Deno.remove(under, { recursive: true });
      }
    });
  });

  describe("gapOf()", () => {
    const near = entry("near > runs", "near.test.ts", { score: 0.1 });
    const shared = entry("shared > runs", "shared.test.ts");
    const sharedRun = entry("shared > also runs", "shared.test.ts");
    const valuable = entry("valuable > runs", "valuable.test.ts", {
      score: 0.9,
    });
    const far = entry("far > runs", "far.test.ts", { score: 0.9 });
    const unreached = entry("unreached > runs", "unreached.test.ts");
    const manifest = sampleManifest({
      entries: [near, shared, sharedRun, valuable, far, unreached],
    });
    const reached = new Map([
      ["bakery\tnear.test.ts", 1],
      ["bakery\tshared.test.ts", 1],
      ["bakery\tvaluable.test.ts", 1],
      ["bakery\tfar.test.ts", 3],
    ]);
    const gap = (budgetSeconds: number, ci = running([sharedRun])) =>
      gapOf({ manifest, suites: [bakery({})], ci, reached, budgetSeconds });

    it("returns the tests of reached units the pull request does not run", () => {
      const units = gap(600).chosen;
      expect(units.flatMap((unit) => unit.selections).map((s) => s.entry))
        .toEqual([valuable, near, shared, far]);
      expect(units.find((unit) => unit.unit === "shared.test.ts")?.partly)
        .toBe(true);
      expect(units.find((unit) => unit.unit === "near.test.ts")?.partly)
        .toBe(false);
    });

    it("counts a unit the pull request runs whole as covered, and leaves it out", () => {
      const result = gap(600, running([shared, sharedRun]));
      expect(result.reached).toBe(4);
      expect(result.covered).toBe(1);
      expect(result.chosen.map((unit) => unit.unit)).not.toContain(
        "shared.test.ts",
      );
    });

    it("leaves out a unit that would take the run past its budget, and runs a cheaper one after it", () => {
      const costly = entry("costly > runs", "costly.test.ts", {
        cost: 50,
        score: 1,
      });
      const result = gapOf({
        manifest: sampleManifest({ entries: [costly, near] }),
        suites: [bakery({})],
        ci: running([]),
        reached: new Map([
          ["bakery\tcostly.test.ts", 1],
          ["bakery\tnear.test.ts", 1],
        ]),
        budgetSeconds: 10,
      });
      expect(result.over.map((unit) => unit.unit)).toEqual(["costly.test.ts"]);
      expect(result.chosen.map((unit) => unit.unit)).toEqual(["near.test.ts"]);
      expect(result.projectedSeconds).toBeCloseTo(near.cost);
    });

    it("sets apart a unit whose suite shares the checkout with its owner's servers", () => {
      const result = gapOf({
        manifest: sampleManifest({ entries: [near] }),
        suites: [bakery({}, {}, ["local-dev-servers"])],
        ci: running([]),
        reached: new Map([["bakery\tnear.test.ts", 1]]),
        budgetSeconds: 600,
      });
      expect(result.apart.map(({ unit }) => unit.unit)).toEqual([
        "near.test.ts",
      ]);
      expect(result.apart[0]?.reason).toMatch(/share the checkout/);
      expect(result.chosen).toEqual([]);
      expect(result.over).toEqual([]);
    });

    it("sets apart a unit needing what the machine lacks, before charging anything, and runs the rest", () => {
      const fused = { ...bakery({}, {}, ["deno", "fuse"]), id: "fused" };
      const fusing = entry("fusing > mounts", "fusing.test.ts", {
        suite: "fused",
        cost: 500,
      });
      const result = gapOf({
        manifest: sampleManifest({ entries: [fusing, near] }),
        suites: [fused, bakery({})],
        ci: running([]),
        reached: new Map([
          ["fused\tfusing.test.ts", 0],
          ["bakery\tnear.test.ts", 1],
        ]),
        budgetSeconds: 10,
        lacking: new Map([["fuse", "no FUSE"]]),
      });
      expect(result.apart.map(({ unit, reason }) => [unit.unit, reason]))
        .toEqual([["fusing.test.ts", "no FUSE"]]);
      expect(result.chosen.map((unit) => unit.unit)).toEqual(["near.test.ts"]);
      expect(result.over).toEqual([]);
    });

    it("charges the setup of the capabilities the run opens", () => {
      const result = gapOf({
        manifest: sampleManifest({
          entries: [near],
          calibration: {
            setupCost: { toolshed: 20, fuse: 1000 },
            suites: {},
            prologue: 0,
          },
        }),
        suites: [bakery({}, {}, ["toolshed", "fuse"])],
        ci: running([]),
        reached: new Map([["bakery\tnear.test.ts", 1]]),
        budgetSeconds: 600,
      });
      expect(result.projectedSeconds).toBeCloseTo(20 + near.cost);
    });
  });

  describe("workstationRegistry()", () => {
    it("returns capabilities that prepare a runner as ones that open nothing, and leaves the rest", async () => {
      const registry = workstationRegistry(CAPABILITIES);
      const asked: string[] = [];
      const opened = await openCapabilities(["fuse", "jq", "git-history"], {
        root: Deno.cwd(),
        dryRun: false,
        workDir: Deno.cwd(),
        exec: (command, args) => {
          asked.push([command, ...args].join(" "));
          return Promise.reject(new Error("nothing may run"));
        },
      }, registry);
      expect(asked).toEqual([]);
      expect(opened.envFor(["fuse", "jq"])).toEqual({});
      expect(registry.get("toolshed")).toBe(CAPABILITIES.get("toolshed"));
    });
  });

  describe("runGap()", () => {
    const passing = entry("good > passes", "good.test.ts");
    const failing = entry("bad > fails", "bad.test.ts");
    const flaky = entry("flaky > fails", "flaky.test.ts");
    const beside = entry("flaky > other", "flaky.test.ts");
    const units = {
      "good.test.ts": ["good > passes"],
      "bad.test.ts": ["bad > fails"],
      "flaky.test.ts": ["flaky > fails", "flaky > other"],
    };
    let spool: string;
    let printed: string[];
    const log = console.log;

    beforeEach(async () => {
      spool = await Deno.makeTempDir({ prefix: "test-gap-spool-" });
      printed = [];
      console.log = (line: string) => printed.push(line);
    });

    afterEach(async () => {
      console.log = log;
      await Deno.remove(spool, { recursive: true });
      // Whatever a case's run kept, removed even where the case failed.
      for (const line of printed) {
        const kept = line.match(/^test-gap: kept (.*), which holds/)?.[1];
        if (kept !== undefined) {
          await Deno.remove(kept, { recursive: true }).catch(() => {});
        }
      }
    });

    /**
     * Runs `chosen` of the units above, which do what `outcomes` says, with
     * `flaky > fails` held back from pull requests as too flaky.
     */
    async function run(
      chosen: readonly string[],
      outcomes: Record<string, Outcome>,
      suite = bakery(units, outcomes, []),
      stop = new LaneStop(),
      registry: ReadonlyMap<CapabilityId, Capability> = CAPABILITIES,
    ): Promise<GapRun> {
      const manifest = sampleManifest({
        entries: [passing, failing, flaky, beside],
        withheld: [{ test: flaky.test, suite: "bakery", reason: "flaky" }],
      });
      return await runGap(gapOver(manifest, chosen), {
        root: REPOSITORY,
        base: "HEAD",
        suites: [suite],
        manifest: pricedForRun(
          { manifest, mandatory: new Map(), unmeasured: 0, gates: [] },
          [suite],
          () => false,
        ).manifest,
        spool,
        stop,
        registry,
      });
    }

    /** Each test a run's summary holds, as its outcome and title, in order. */
    function outcomes(result: GapRun): string[] {
      return result.summary.tests
        .map(({ record }) => `${record.outcome} ${testTitle(record)}`)
        .sort();
    }

    /** Checks that a run kept a directory, which `afterEach` removes. */
    async function expectKept(kept: string | undefined): Promise<void> {
      expect(kept).toBeDefined();
      expect(await exists(kept ?? "")).toBe(true);
    }

    /** The names of every record written to the spool. */
    async function spooled(): Promise<string[]> {
      const names: string[] = [];
      for await (const file of Deno.readDir(spool)) {
        const text = await Deno.readTextFile(join(spool, file.name));
        for (const line of text.split("\n")) {
          if (line.trim() !== "") names.push(JSON.parse(line).test.n);
        }
      }
      return names.sort();
    }

    it("returns a pass where every test it ran passed, and keeps no directory", async () => {
      const result = await run(["good.test.ts"], {});
      expect(result.ok).toBe(true);
      expect(outcomes(result)).toEqual(["pass unit/bakery: good > passes"]);
      expect(result.kept).toBeUndefined();
    });

    /**
     * `CAPABILITIES` with each capability that prepares a runner made to
     * throw where it is opened.
     */
    function preparing() {
      const registry = new Map<CapabilityId, Capability>(CAPABILITIES);
      for (const [id, capability] of CAPABILITIES) {
        if (capability.preparesRunner !== true) continue;
        registry.set(id, {
          ...capability,
          open: () => Promise.reject(new Error(`${id} was opened`)),
        });
      }
      return registry;
    }

    it("runs a suite needing capabilities that prepare a runner without opening them", async () => {
      const result = await run(
        ["good.test.ts"],
        {},
        bakery(units, {}, ["deno", "jq", "fuse", "browser"]),
        new LaneStop(),
        preparing(),
      );
      expect(result.ok).toBe(true);
      expect(outcomes(result)).toEqual(["pass unit/bakery: good > passes"]);
    });

    it("returns a failure naming the test, and keeps its directory", async () => {
      const result = await run(["good.test.ts", "bad.test.ts"], {
        "bad > fails": "fail",
      });
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual([
        "fail unit/bakery: bad > fails",
        "pass unit/bakery: good > passes",
      ]);
      expect(result.excused).toEqual([]);
      await expectKept(result.kept);
    });

    it("returns a pass where only a test too flaky for a pull request failed", async () => {
      const result = await run(["flaky.test.ts"], { "flaky > fails": "fail" });
      expect(result.ok).toBe(true);
      expect(outcomes(result)).toEqual(["pass unit/bakery: flaky > other"]);
      expect(result.excused.map(testTitle)).toEqual([
        "unit/bakery: flaky > fails",
      ]);
    });

    it("returns a failure where a flaky failure sits beside a test that recorded nothing", async () => {
      // The runner recorded the flaky failure and then stopped, so it has
      // not run what it was asked to, and a lane fails it.

      const result = await run(["flaky.test.ts"], {
        "flaky > fails": "fail",
        "flaky > other": "missing",
      });
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual(["fail unit/bakery: flaky > fails"]);
      expect(result.excused).toEqual([]);
      await expectKept(result.kept);
    });

    it("returns a failure naming a unit that recorded nothing", async () => {
      const result = await run(["good.test.ts"], {
        "good > passes": "missing",
      });
      expect(result.ok).toBe(false);
      expect(result.summary.commands).toEqual([
        { label: "bakery good.test.ts", reason: "ran no test" },
      ]);
      await expectKept(result.kept);
    });

    it("returns a failure, having run nothing, when told to stop", async () => {
      const stop = new LaneStop();
      stop.receive("SIGINT");
      const result = await run(
        ["good.test.ts"],
        {},
        bakery(units, {}, []),
        stop,
      );
      expect(result.ok).toBe(false);
      expect(outcomes(result)).toEqual([]);
      expect(result.summary.notes).toEqual([
        "Stopped by SIGINT before running everything.",
      ]);
      await expectKept(result.kept);
    });

    it("keeps its directory, and says where, when a batch throws", async () => {
      const throwing: Suite = {
        ...bakery(units, {}, []),
        command: () => Promise.reject(new Error("no runner")),
      };
      await expect(run(["good.test.ts"], {}, throwing)).rejects.toThrow(
        "no runner",
      );
      const kept = printed.find((line) => line.startsWith("test-gap: kept "))
        ?.match(/^test-gap: kept (.*), which holds/)?.[1];
      await expectKept(kept);
    });

    describe("a run holding a suite whose capability builds a binary", () => {
      /**
       * A registry whose `toolshed-baked` notes the tree it builds from, and
       * throws `failure` once it has, where one is given.
       */
      function noting(
        seen: { from?: string; there: boolean }[],
        failure?: Error,
      ) {
        const registry = new Map<CapabilityId, Capability>(CAPABILITIES);
        registry.set("toolshed-baked", {
          id: "toolshed-baked",
          description: "a stand-in that builds nothing",
          builds: "toolshed-baked-default",
          async open(context) {
            seen.push({
              ...(context.buildFrom === undefined
                ? {}
                : { from: context.buildFrom }),
              there: context.buildFrom !== undefined &&
                await exists(join(context.buildFrom, "good.test.ts")),
            });
            if (failure !== undefined) throw failure;
            return { env: {}, close: () => Promise.resolve() };
          },
        });
        return registry;
      }

      /** Runs `good.test.ts` from `root`, through `registry`. */
      function runFrom(
        root: string,
        registry: ReadonlyMap<CapabilityId, Capability>,
      ): Promise<GapRun> {
        const suite = bakery(units, {}, ["toolshed-baked"]);
        const manifest = sampleManifest({ entries: [passing] });
        return runGap(gapOver(manifest, ["good.test.ts"]), {
          root,
          base: "HEAD",
          suites: [suite],
          manifest: pricedForRun(
            { manifest, mandatory: new Map(), unmeasured: 0, gates: [] },
            [suite],
            () => false,
          ).manifest,
          spool,
          stop: new LaneStop(),
          registry,
        });
      }

      it("builds from a snapshot of the working tree, which is gone when the run ends", async () => {
        const root = await repository({ "good.test.ts": "" });
        const seen: { from?: string; there: boolean }[] = [];
        try {
          const result = await runFrom(root, noting(seen));
          expect(result.ok).toBe(true);
          expect(seen).toHaveLength(1);
          expect(seen[0]?.there).toBe(true);
          expect(seen[0]?.from).not.toBe(root);
          expect(await exists(seen[0]?.from ?? root)).toBe(false);
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      });

      it("throws what stopped a capability opening, having removed the snapshot", async () => {
        const root = await repository({ "good.test.ts": "" });
        const seen: { from?: string; there: boolean }[] = [];
        try {
          await expect(
            runFrom(root, noting(seen, new Error("the build failed"))),
          ).rejects.toThrow("the build failed");
          expect(seen[0]?.there).toBe(true);
          expect(await exists(seen[0]?.from ?? root)).toBe(false);
          const kept = printed.find((line) =>
            line.startsWith("test-gap: kept ")
          )?.match(/^test-gap: kept (.*), which holds/)?.[1];
          await expectKept(kept);
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      });

      it("throws what stopped the snapshot, and keeps its directory, where none can be made", async () => {
        const root = await Deno.makeTempDir({ prefix: "test-gap-not-git-" });
        const seen: { from?: string; there: boolean }[] = [];
        try {
          await expect(runFrom(root, noting(seen))).rejects.toThrow(
            "cannot snapshot the working tree",
          );
          expect(seen).toEqual([]);
          const kept = printed.find((line) =>
            line.startsWith("test-gap: kept ")
          )?.match(/^test-gap: kept (.*), which holds/)?.[1];
          await expectKept(kept);
        } finally {
          await Deno.remove(root, { recursive: true });
        }
      });
    });

    it("spools its tests' records and none of the lane's own measurements", async () => {
      await run(["good.test.ts"], {});
      expect(await spooled()).toEqual(["good > passes"]);
    });
  });

  describe("describeGap()", () => {
    it("returns what runs and what the budget left out", () => {
      const lines = describeGap(
        {
          reached: 3,
          covered: 1,
          chosen: [{
            suite: "bakery",
            unit: "near.test.ts",
            hops: 1,
            selections: [],
            partly: true,
          }],
          over: [{
            suite: "bakery",
            unit: "far.test.ts",
            hops: 2,
            selections: [],
            partly: false,
          }],
          apart: [],
          projectedSeconds: 30,
          budgetSeconds: 60,
        },
        2,
        "upstream/main",
      );
      expect(lines.join("\n")).toContain(
        "near.test.ts (bakery; 1 step from the change; 0 tests the pull " +
          "request skips)",
      );
      expect(lines.join("\n")).toContain(
        "left out 1 test unit(s) the change reaches",
      );
      expect(lines.join("\n")).toContain(
        "far.test.ts (bakery; 2 steps from the change; 0 tests)",
      );
    });

    it("returns that nothing runs where nothing was chosen", () => {
      expect(
        describeGap(
          {
            reached: 0,
            covered: 0,
            chosen: [],
            over: [],
            apart: [],
            projectedSeconds: 0,
            budgetSeconds: 60,
          },
          1,
          "main",
        ).at(-1),
      ).toBe("test-gap: nothing to run.");
    });
  });

  describe("afterSummaryLines()", () => {
    const gap: Gap = {
      reached: 2,
      covered: 0,
      chosen: [],
      over: [{
        suite: "bakery",
        unit: "far.test.ts",
        hops: 2,
        selections: [],
        partly: false,
      }],
      apart: [],
      projectedSeconds: 0,
      budgetSeconds: 60,
    };
    const flakyRecord = {
      line: "record" as const,
      test: test("flaky > fails"),
      outcome: "fail" as const,
      durationMs: 1,
    };

    it("returns the excused failures and the units left out", () => {
      const lines = afterSummaryLines({
        ...gap,
        apart: [{
          unit: {
            suite: "cli-fuse",
            unit: "fuse-exec.sh exec",
            hops: 1,
            selections: [],
            partly: false,
          },
          reason: "no FUSE",
        }],
      }, {
        ok: true,
        summary: { tests: [], commands: [], seconds: 1 },
        excused: [flakyRecord],
        leftovers: ["could not remove /tmp/x: busy"],
      });
      expect(lines).toContain("  could not remove /tmp/x: busy");
      expect(lines).toContain("  unit/bakery: flaky > fails");
      expect(lines.join("\n")).toContain(
        "that this machine does not run:\n" +
          "  fuse-exec.sh exec (cli-fuse; 1 step from the change; 0 tests): " +
          "no FUSE",
      );
      expect(lines.join("\n")).toContain(
        "far.test.ts (bakery; 2 steps from the change; 0 tests)",
      );
    });

    it("returns nothing where nothing was excused or left out", () => {
      expect(
        afterSummaryLines({ ...gap, over: [] }, {
          ok: true,
          summary: { tests: [], commands: [], seconds: 1 },
          excused: [],
          leftovers: [],
        }),
      ).toEqual([]);
    });
  });

  describe("main()", () => {
    // `lib.ts` changes after the base, and `reached.test.ts` imports it
    // while `apart.test.ts` does not. The reached test costs more than a
    // lane can hold, so the pull request's plan cannot choose it.

    const reachedTest = entry("reached > runs", "reached.test.ts", {
      cost: 1000,
    });
    const apartTest = entry("apart > runs", "apart.test.ts");
    const units = {
      "reached.test.ts": ["reached > runs"],
      "apart.test.ts": ["apart > runs"],
    };
    let root: string;
    let spool: string;
    let printed: string[];
    const log = console.log;

    beforeEach(async () => {
      root = await repository({
        "deno.jsonc": '{ "workspace": [] }\n',
        "lib.ts": "export const x = 1;\n",
        "reached.test.ts": 'import "./lib.ts";\n',
        "apart.test.ts": "",
      });
      await Deno.writeTextFile(join(root, "lib.ts"), "export const x = 2;\n");
      spool = await Deno.makeTempDir({ prefix: "test-gap-spool-" });
      printed = [];
      console.log = (line: string) => printed.push(line);
    });

    afterEach(async () => {
      console.log = log;
      await Deno.remove(root, { recursive: true });
      await Deno.remove(spool, { recursive: true });
    });

    /** Runs the command over the repository, whose tests fail as `outcomes` says. */
    const command = (
      args: readonly string[],
      outcomes: Record<string, Outcome> = {},
    ) =>
      main(args, root, {
        manifest: () =>
          Promise.resolve({
            manifest: sampleManifest({ entries: [reachedTest, apartTest] }),
          }),
        topology: () => Promise.resolve([bakery(units, outcomes, [])]),
        recording: () => Promise.resolve({ mode: "join", dir: spool }),
        stop: () => new LaneStop(),
      });

    it("returns 2 for a command line it cannot read", async () => {
      const error = console.error;
      console.error = () => {};
      try {
        expect(await command(["--soon"])).toBe(2);
      } finally {
        console.error = error;
      }
    });

    it("exits 2 as a program given a command line it cannot read, naming its shuffle seed", async () => {
      const result = await runDenoCommandWithTemporaryLock({
        root: REPOSITORY,
        args: (lock) => [
          "run",
          `--lock=${lock}`,
          "-A",
          fromFileUrl(new URL("./test-gap.ts", import.meta.url)),
          "--soon",
        ],
        env: { CF_TEST_SHUFFLE_SEED: "7" },
      });
      expect(result.code).toBe(2);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toContain(shuffleNotice(7));
      expect(stderr).toContain("usage: test-gap");
    });

    it("prints what would run and runs nothing on a dry run", async () => {
      expect(
        await command(["--dry-run", "--base", "base", "--seconds", "5000"]),
      )
        .toBe(0);
      expect(printed.join("\n")).toContain("reached.test.ts");
      expect(printed.join("\n")).not.toContain("apart.test.ts");
      expect([...Deno.readDirSync(spool)]).toEqual([]);
    });

    it("returns 0 where the tests it ran passed, and 1 where one failed", async () => {
      const args = ["--base", "base", "--seconds", "5000"];
      expect(await command(args)).toBe(0);
      expect(printed.some((line) => line.includes(" test summary "))).toBe(
        true,
      );
      expect(await command(args, { "reached > runs": "fail" })).toBe(1);
      expect(printed).toContain("FAIL unit/bakery: reached > runs");
      const kept = printed.find((line) => line.startsWith("test-gap: kept "))
        ?.match(/^test-gap: kept (.*), which holds/)?.[1];
      await Deno.remove(kept ?? "", { recursive: true });
    });

    it("runs nothing where the budget holds none of what the change reaches", async () => {
      expect(await command(["--base", "base", "--seconds", "5"])).toBe(0);
      expect(printed.some((line) => line.includes(" test summary "))).toBe(
        false,
      );
    });

    it("refuses to plan where the manifest store could not be read", async () => {
      await expect(
        main(["--base", "base"], root, {
          manifest: () =>
            Promise.resolve({ unreachable: true, absent: "refused" }),
          topology: () => Promise.resolve([bakery(units)]),
          recording: () => Promise.resolve({ mode: "off" }),
          stop: () => new LaneStop(),
        }),
      ).rejects.toThrow("could not be read (refused)");
    });
  });
});
