import { expect } from "@std/expect";
import { parse as parseJsonc } from "@std/jsonc";
import * as path from "@std/path";
import { describe, it } from "@std/testing/bdd";
import {
  capabilitiesBySuite,
  claimsFor,
  identityKeys,
  loadTopology,
  suiteById,
  topologyUnits,
} from "./test-topology.ts";
import {
  parseSkipList,
  SKIP_LIST_VARIABLE,
} from "@commonfabric/test-support/records";
import { CAPABILITIES } from "./ci-capabilities.ts";
import { collectMeasuredSetDebt } from "./coverage-metrics.ts";
import { DENO_TEST_FILE } from "./test-topology/deno-task.ts";
import { MEASURED_BATCH_SUFFIX } from "./lane-measurement.ts";
import { serverExecutionCiLane } from "./server-execution-ci.ts";
import { readWorkspaceMembers } from "./workspace-tests.ts";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const suites = await loadTopology(root);

/** The Deno subcommands a suite's runner is allowed to be. */
const SUBCOMMANDS = new Set(["task", "test", "run", "check", "fmt", "lint"]);

/** The task names the manifest in a directory defines, if it has one. */
async function tasksOf(dir: string): Promise<Set<string>> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await Deno.readTextFile(path.join(dir, name)).catch(
      () => undefined,
    );
    if (text === undefined) continue;
    const manifest = parseJsonc(text) as { tasks?: Record<string, unknown> };
    return new Set(Object.keys(manifest.tasks ?? {}));
  }
  return new Set();
}

describe("the test topology", () => {
  it("names each suite once", () => {
    const ids = suites.map((suite) => suite.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("names a task every manifest it runs in defines", async () => {
    // `deno fmt` and `deno lint` are subcommands rather than tasks of this
    // repository, and a command asking for one as a task prints the list
    // of tasks that do exist and exits one. A lane reports that the way it
    // reports any failed unit, by exiting one itself, with no failing test
    // under it to say what broke. So every task a suite runs is held to
    // being one Deno can find: defined where the command runs, or in the
    // root manifest, which is where Deno looks next.

    const outputDir = await Deno.makeTempDir({ prefix: "topology-commands-" });
    const rootTasks = await tasksOf(root);
    const missing: string[] = [];
    const named: string[] = [];
    for (const suite of suites) {
      const requests = suite.units.map((unit) => ({ unit, skip: [] }));
      for (
        const invocation of await suite.command(requests, {
          root,
          outputDir,
          spoolDir: "/spool",
          baseRef: "origin/main",
        })
      ) {
        // A suite whose runner is a script of its own runs no Deno
        // subcommand and names no task.
        if (invocation.command[0] !== Deno.execPath()) continue;
        // What the command runs, which for a gate is what the recorder
        // was handed rather than the recorder's own task.
        const separator = invocation.command.indexOf("--");
        const run = separator < 0
          ? invocation.command.slice(1)
          : invocation.command.slice(separator + 2);
        if (!SUBCOMMANDS.has(run[0]!)) {
          missing.push(`${suite.id}: ${run[0]} is no subcommand of Deno`);
          continue;
        }
        if (run[0] !== "task") continue;
        named.push(run[1]!);
        const where = invocation.cwd ?? root;
        const local = await tasksOf(where);
        if (!local.has(run[1]!) && !rootTasks.has(run[1]!)) {
          missing.push(`${suite.id}: no task named ${run[1]} in ${where}`);
        }
      }
    }
    await Deno.remove(outputDir, { recursive: true });
    expect(missing).toEqual([]);

    // A run that read nothing satisfies the check above, and so does one
    // that stopped at the recorder instead of reaching what the recorder
    // was handed. Every gate whose name begins `check-` runs a task of
    // that name, so the two counts agree only where each of them was
    // reached and read past the recorder.
    const gates = ["repo-gates", "repo-history-gates"]
      .flatMap((id) => suiteById(suites, id)!.units)
      .filter((unit) => unit.startsWith("check-"));
    expect(named.filter((task) => task.startsWith("check-")).toSorted())
      .toEqual(gates.toSorted());
  });

  it("asks only for capabilities the registry declares", () => {
    for (const [id, needs] of capabilitiesBySuite(suites)) {
      for (const need of needs) {
        expect([id, CAPABILITIES.has(need)]).toEqual([id, true]);
      }
    }
  });

  it("gives every suite something to run", () => {
    for (const suite of suites) {
      expect([suite.id, suite.units.length > 0]).toEqual([suite.id, true]);
    }
  });

  it("gives every unit a lane may subset a file the skip list keys on", async () => {
    // A lane running part of a unit registers the rest as ignored. The
    // registration preload looks each ignored name up under the
    // repository-relative file that registered the test. A unit that is not
    // such a file therefore cannot be handed a subset, and has to be listed in
    // `whole`. An unlisted unit of that kind would get a skip list that matches
    // nothing, and its lane would run every test while being charged for one.

    const wrong: string[] = [];
    for (const suite of suites) {
      const whole = new Set(suite.whole);
      for (const unit of suite.units) {
        if (whole.has(unit)) continue;
        if (!DENO_TEST_FILE.test(unit)) {
          wrong.push(`${suite.id}: ${unit} is not a test file`);
          continue;
        }
        const holds = await Deno.stat(path.join(root, unit))
          .then((entry) => entry.isFile)
          .catch(() => false);
        if (!holds) wrong.push(`${suite.id}: ${unit} is not in the tree`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names only its own units as the ones that run whole", () => {
    const stray: string[] = [];
    for (const suite of suites) {
      const units = new Set(suite.units);
      for (const unit of suite.whole) {
        if (!units.has(unit)) stray.push(`${suite.id}: ${unit}`);
      }
    }
    expect(stray).toEqual([]);
  });

  it("writes no skip list for a unit it declares whole", async () => {
    // This is the reverse of the check above. A suite that lists a unit in
    // `whole` and still writes a skip list for it has a runner that can take a
    // subset. Listing such a unit in `whole` makes the packer place it whole
    // for no reason.

    const outputDir = await Deno.makeTempDir({ prefix: "topology-whole-" });
    const spoolDir = `${outputDir}/spool`;
    const written: string[] = [];
    for (const suite of suites) {
      if (suite.whole.length === 0) continue;
      const requests = suite.whole.map((unit) => ({
        unit,
        skip: ["a name no unit holds"],
      }));
      for (
        const invocation of await suite.command(requests, {
          root,
          outputDir,
          spoolDir,
        })
      ) {
        const named = invocation.env?.[SKIP_LIST_VARIABLE];
        if (named === undefined) continue;
        const list = parseSkipList(await Deno.readTextFile(named)) ?? {};
        for (const unit of Object.keys(list)) {
          written.push(`${suite.id}: ${unit}`);
        }
      }
    }
    await Deno.remove(outputDir, { recursive: true });
    expect(written).toEqual([]);
  });

  it("lets a default suite and a variant suite hold one source file", () => {
    const defaults = suites.find((suite) =>
      suite.id === "package-integration"
    )!;
    const opposite = suites.find((suite) =>
      suite.id === "package-integration-opposite"
    )!;
    // Pinned to a runner-scope file rather than whichever unit sorts
    // first: a record's scope has to match the part that holds the file,
    // and taking the first shared unit would make this fail for the
    // wrong reason the day a whole-file skip changes the order.
    const shared = defaults.units.filter((unit) =>
      opposite.units.includes(unit) && unit.startsWith("packages/runner/")
    );
    expect(shared.length > 0).toBe(true);
    // They are distinct execution surfaces, so the same file being a unit
    // of both is right; what must not happen is one identity reaching
    // both, and the variant is what keeps them apart.
    for (const unit of shared.slice(0, 1)) {
      const record = {
        test: { k: "integration", s: "runner", n: "x" },
        file: unit,
      };
      expect(claimsFor(suites, record).map((claim) => claim.suite.id))
        .toEqual(["package-integration"]);
      expect(
        claimsFor(suites, {
          ...record,
          test: {
            ...record.test,
            v: serverExecutionCiLane("opposite").recordVariant,
          },
        }).map((claim) => claim.suite.id),
      ).toEqual(["package-integration-opposite"]);
    }
  });

  it("claims a recorded identity for exactly one suite", () => {
    // Every name here is one some suite claims, which is what the count
    // being one says. A name nothing claims satisfies "at most one" as
    // well, so a list holding one says nothing about the topology.

    const records = [
      { test: { k: "format", s: "repo", n: "deno-fmt" } },
      { test: { k: "gate", s: "repo", n: "check-deno-pins" } },
      { test: { k: "gate", s: "repo", n: "check-test-aliases" } },
      { test: { k: "gate", s: "repo", n: "pattern-compat annotation.tsx" } },
      // The vintage gate's wrapper record. Its per-fixture records are
      // named after fixtures in the tree, which `test-topology/gates.test.ts`
      // checks against the tree itself.
      { test: { k: "gate", s: "repo", n: "pattern-vintage" } },
      {
        test: {
          k: "typecheck",
          s: "repo",
          n: "cfcheck packages/patterns/annotation.tsx",
        },
      },
      { test: { k: "typecheck", s: "memory", n: "deno-check" } },
      {
        test: {
          k: "integration",
          s: "cli",
          n: "integration.sh verbs-walkthrough",
        },
      },
      {
        test: {
          k: "integration",
          s: "cli",
          n: "fuse-exec.sh .status reads as a whole JSON document",
        },
      },
    ];
    for (const record of records) {
      const claims = claimsFor(suites, record);
      expect([record.test.n, claims.length]).toEqual([record.test.n, 1]);
    }
  });

  it("keeps the overlapping script record out of every unit", () => {
    // `integration.sh` records its whole invocation as well as each step,
    // and the same identity appears whichever arm dispatched it. Summing
    // it with its own steps would double-count them.
    const claims = claimsFor(suites, {
      test: { k: "integration", s: "cli", n: "integration.sh" },
    });
    expect(claims.map((claim) => [claim.suite.id, claim.level])).toEqual([
      ["cli-core", "suite"],
    ]);
  });
});

describe("reading the topology as a whole", () => {
  it("finds a suite by the identifier its manifest entries carry", () => {
    expect(suiteById(suites, "workspace-unit")?.id).toBe("workspace-unit");
    expect(suiteById(suites, "no-such-suite")).toBeUndefined();
  });

  it("pairs every unit with the suite that runs it", () => {
    // Against suites written out here rather than against the topology:
    // asserting that the pairs come from the units they were built from
    // is a claim about the expression, not about the function.
    const pairs = topologyUnits([
      { ...suites[0]!, id: "one", units: ["a", "b"] },
      { ...suites[0]!, id: "other", units: ["c"] },
    ]);
    expect(pairs.map((pair) => [pair.suite.id, pair.unit])).toEqual([
      ["one", "a"],
      ["one", "b"],
      ["other", "c"],
    ]);
    expect(topologyUnits([])).toEqual([]);
  });

  it("names no suite the batch measurement suffix could swallow", () => {
    // A lane's batch measurement is named for its suite and marked with
    // `MEASURED_BATCH_SUFFIX` when coverage was on. A suite whose id
    // ended with that suffix would have its unmeasured name read as the
    // measured name of a shorter suite, so the two would be fitted as
    // one. Reserving the suffix is cheaper than escaping every id.
    for (const suite of suites) {
      expect([suite.id, suite.id.endsWith(MEASURED_BATCH_SUFFIX)])
        .toEqual([suite.id, false]);
    }
  });

  it("gives every measured set a member with lines a report can name", async () => {
    // The coverage gate fails a forced set whose reports name no line of
    // its member, which is sound only where the member has a line a
    // report could name. An empty report charges every such line, so a
    // member it charges nothing has none.
    const members = await readWorkspaceMembers(path.join(root, "deno.jsonc"));
    for (const suite of suites) {
      for (const set of suite.measured ?? []) {
        const { uncoveredLines } = await collectMeasuredSetDebt({
          rootDir: root,
          lcov: "",
          member: set.member,
          members,
        });
        expect([set.member, uncoveredLines > 0]).toEqual([set.member, true]);
      }
    }
  });

  it("keys a set of records the way the store keys them", () => {
    // A variant is the fourth part of a key, so one identity in two
    // configurations is two keys rather than one.
    const keys = identityKeys([
      { test: { k: "unit", s: "oven", n: "bakes" } },
      { test: { k: "unit", s: "oven", n: "bakes" } },
      { test: { k: "unit", s: "oven", n: "bakes", v: "server-execution" } },
    ]);
    expect(keys.size).toBe(2);
  });
});

describe("what the command-line dispatch table becomes", () => {
  /** Every step the dispatch script begins itself. */
  async function recordedSteps(): Promise<string[]> {
    const script = await Deno.readTextFile(
      new URL("../packages/cli/integration/integration.sh", import.meta.url),
    );
    return [
      ...new Set(
        [...script.matchAll(/^ {4}cf_test_step_begin (\S+)$/gm)]
          .map((found) => found[1]!),
      ),
    ];
  }

  it("makes a unit of every recorded step, and of nothing else", async () => {
    // Both halves matter. A step with no arm running it alone is a step
    // nothing can be asked to run; a group arm that became a unit would
    // run steps another unit already holds, and the packer would pay for
    // them twice.
    const steps = await recordedSteps();
    const suite = suiteById(suites, "cli-core")!;
    const fromSteps = suite.units
      .filter((unit) => unit.startsWith("integration.sh "))
      .map((unit) => unit.slice("integration.sh ".length));
    expect(fromSteps.sort()).toEqual(steps.sort());
  });

  it("gives each recorded step's identity to its own unit", async () => {
    for (const step of await recordedSteps()) {
      const name = `integration.sh ${step}`;
      expect([
        name,
        suiteById(suites, "cli-core")!.locate({
          test: { k: "integration", s: "cli", n: name },
        }),
      ]).toEqual([name, { level: "unit", unit: name }]);
    }
  });
});
