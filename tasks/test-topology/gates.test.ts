import { expect } from "@std/expect";
import { parse as parseJsonc } from "@std/jsonc";
import { describe, it } from "@std/testing/bdd";
import { DOC_DEMOS } from "../check-verb-session-sync.ts";
import { TRIPWIRES } from "../check-tripwires.ts";
import { namedBenchmarkFiles } from "../check-bench-workflow.ts";
import { matchesPatternFilter } from "../pattern-files.ts";
import {
  parseVintagePath,
  vintageRecordName,
  VINTAGES_DIR,
} from "../pattern-vintage-layout.ts";
import {
  type Gate,
  HISTORY_GATES,
  loadGateSuites,
  REACHED_BY_ABSENT_PATHS,
  WORKING_TREE_GATES,
} from "./gates.ts";
import { entryNames, type Suite } from "./suite.ts";

const gates: readonly Gate[] = [...WORKING_TREE_GATES, ...HISTORY_GATES];

/**
 * The most of the tree one gate may be reached by, as a divisor. A gate
 * more than one file in eight reaches is one most changes would run.
 */
const TREE_SHARE_DIVISOR = 8;

/** The most gates one file may reach. */
const GATES_PER_FILE = 4;

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const suites = await loadGateSuites(root);
const byId = (id: string): Suite => suites.find((s) => s.id === id)!;
const context = { root: "/repo", outputDir: "/out", spoolDir: "/spool" };

/**
 * Every record name the vintage gate writes for the tree's own fixtures.
 *
 * The fixture set is read from git rather than from the walk the gate
 * replays with, so what the topology claims is compared against the tree
 * rather than against a second copy of that walk. What each fixture is
 * called comes from the layout module, which is where the gate takes it
 * from as well, so the two cannot disagree about the name; the record
 * name's own spelling is held by `tasks/pattern-vintage-run.test.ts`.
 */
function vintageRecordNames(): string[] {
  const listed = new Deno.Command("git", {
    args: ["-C", root, "ls-files", "-z", VINTAGES_DIR],
  }).outputSync();
  const names = new Set<string>();
  for (const file of new TextDecoder().decode(listed.stdout).split("\0")) {
    const fixture = parseVintagePath(file);
    if (fixture !== undefined) names.add(vintageRecordName(fixture));
  }
  return [...names].sort();
}

describe("the repository's gate suites", () => {
  it("gives the base revision to the gates whose suite asks for history", async () => {
    // A lane opens what a suite needs before it runs any of it, so which
    // suite a gate sits in decides whether the lane it runs in has
    // history to read. Both lists are built over every gate of both
    // suites, so a gate that reaches for the base revision from the suite
    // that asks for no history fails this.

    const reading: string[] = [];
    const declared: string[] = [];
    for (const suite of [byId("repo-gates"), byId("repo-history-gates")]) {
      for (const unit of suite.units) {
        const [invocation] = await suite.command([{ unit, skip: [] }], {
          ...context,
          baseRef: "origin/release",
        });
        if (invocation!.command.includes("origin/release")) reading.push(unit);
        if (suite.needs.includes("git-history")) declared.push(unit);
      }
    }
    expect(reading.toSorted()).toEqual([
      "check-baselines-append-only",
      "check-test-aliases",
    ]);
    expect(declared.toSorted()).toEqual(reading.toSorted());
  });

  it("gives a token to the gates whose suite asks the GitHub API", async () => {
    // Read off what each gate's task is allowed to reach rather than off
    // a list written here, so a gate that starts asking the service a
    // question without its suite declaring the capability fails this.
    // Without the token GitHub allows sixty requests an hour from an
    // address, which a shared runner reaches on its own.
    const { tasks } = parseJsonc(
      await Deno.readTextFile(`${root}/deno.jsonc`),
    ) as { tasks: Record<string, string> };
    const asking: string[] = [];
    const undeclared: string[] = [];
    for (const suite of [byId("repo-gates"), byId("repo-history-gates")]) {
      for (const gate of [...WORKING_TREE_GATES, ...HISTORY_GATES]) {
        if (!suite.units.includes(gate.name)) continue;
        const [verb, named] = gate.run;
        const line = verb === "task" ? tasks[named!] ?? "" : "";
        if (!line.includes("api.github.com")) continue;
        asking.push(gate.name);
        if (!suite.needs.includes("github-api")) undeclared.push(gate.name);
      }
    }
    // Both sides are read off the tree, and the relation between them is
    // what the declaration means. The list is here as well because it is
    // what says the search found anything: a probe that matched nothing
    // would leave the relation to hold over an empty set.
    expect(asking.toSorted()).toEqual(["check-action-pins"]);
    expect(undeclared).toEqual([]);
  });

  it("reaches the gates a change names, and no others", () => {
    // Built over every gate of both suites, so a declaration wider than
    // the change fails this rather than quietly running more.
    const reached = (...changed: string[]): string[] =>
      [byId("repo-gates"), byId("repo-history-gates")]
        .flatMap((suite) => [...suite.unitsForChange!(new Set(changed))])
        .toSorted();
    expect(reached("tasks/test-identity-aliases/tags.test.ts.jsonl")).toEqual([
      "check-test-aliases",
    ]);
    expect(reached("tasks/test-identity-aliases.jsonl")).toEqual([
      "check-test-aliases",
    ]);
    expect(reached(".github/workflows/deno.yml")).toEqual([
      "check-action-pins",
    ]);
    // The baselines and the patterns beside them reach one gate each,
    // rather than both reaching both.
    expect(reached("packages/patterns/baselines/system/home.tsx/a.json"))
      .toEqual(["check-baselines-append-only"]);
    expect(reached("packages/patterns/system/home.tsx")).toEqual([
      "check-pattern-tiers",
    ]);
    // A `**` segment stands for any run of directories, so every
    // package's integration tree reaches the gate reading them.
    expect(reached("packages/cli/integration/verb-session-demo.sh")).toEqual([
      "check-no-waitfor",
      "check-verb-session-sync",
    ]);
    expect(reached("packages/static/assets/types/dom.d.ts")).toEqual([
      "check-cfc-types",
      "check-commonfabric-types",
      "check-withheld-globals",
    ]);
    expect(reached("packages/toolshed/routes/ingest-channels/route.ts"))
      .toEqual(["check-tripwires"]);
    // The historical tree is taken back out of the two gates reading
    // `docs/`, since neither compiles nor reads a document in it.
    expect(reached("docs/history/INDEX.md")).toEqual([
      "check-docs-history-index",
    ]);
    expect(reached("mise.toml")).toEqual(["check-deno-pins"]);
    expect(reached("deno.lock")).toEqual(["check-single-copy-deps"]);
    // An ordinary source file reaches no gate. What runs for it is what
    // the score chose, which is what keeps this feature a fraction of a
    // lane rather than the bulk of one.
    expect(reached("packages/runner/src/cell.ts")).toEqual([]);
    expect(reached("elsewhere/thing.txt")).toEqual([]);
  });

  it("holds a gate to little of the tree, and a file to few gates", async () => {
    // The two bounds that keep this feature a fraction of what a lane
    // runs. A declaration wide enough to break either places its gate in
    // every lane on the strength of what it says rather than of what it
    // has caught, which is the decision the score exists to make. Every
    // entry is held to naming something as well, so one whose directory
    // the tree no longer has fails here rather than going quiet behind a
    // sibling entry that still matches.
    const listed = await new Deno.Command("git", {
      args: ["-C", root, "ls-files", "-z"],
    }).output();
    const files = new TextDecoder().decode(listed.stdout)
      .split("\0").filter((path) => path !== "");
    const reached = (at: string): readonly string[] =>
      [byId("repo-gates"), byId("repo-history-gates")]
        .flatMap((suite) => [...suite.unitsForChange!(new Set([at]))]);
    const share = new Map<string, number>();
    let crowded: { at: string; names: readonly string[] } = {
      at: "",
      names: [],
    };
    for (const at of files) {
      const names = reached(at);
      if (names.length > crowded.names.length) crowded = { at, names };
      for (const name of names) share.set(name, (share.get(name) ?? 0) + 1);
    }
    const over: string[] = [];
    for (const gate of gates) {
      for (const entry of gate.reachedBy) {
        const at = entry.replace(/^!/, "");
        if (REACHED_BY_ABSENT_PATHS.has(entry)) continue;
        if (!files.some((path) => entryNames(at, path))) {
          over.push(`${gate.name} names ${entry}, which the tree has not`);
        }
      }
      const reaching = share.get(gate.name) ?? 0;
      if (reaching * TREE_SHARE_DIVISOR > files.length) {
        over.push(
          `${gate.name} is reached by ${reaching} of ${files.length} files`,
        );
      }
    }
    if (crowded.names.length > GATES_PER_FILE) {
      over.push(
        `${crowded.at} reaches ${crowded.names.length} gates: ` +
          crowded.names.toSorted().join(", "),
      );
    }
    expect(over).toEqual([]);
  });

  it("declares nothing for the gates whose input is most of the tree", () => {
    // No small and specific part of the tree decides any of these, so
    // each is left to the score. The list is exact, so a gate added with
    // no declaration fails here rather than joining them in silence.
    const everything = gates
      .filter((gate) => gate.reachedBy.length === 0)
      .map((gate) => gate.name)
      .toSorted();
    expect(everything).toEqual([
      "check-conflict-markers",
      "check-control-characters",
      "check-local-program",
      "check-package-cycles",
      "check-skill-facts",
      "check-test-topology",
      "check-unused-deps",
      "deno-fmt",
      "deno-lint",
    ]);
  });

  it("names paths the tree holds, as the kind the entry says", async () => {
    // A renamed input leaves the gate reachable by a path nobody edits,
    // which reads as a gate nothing touches rather than as a mistake.
    const kindOf = async (entry: string): Promise<string> => {
      try {
        const info = await Deno.stat(`${root}/${entry}`);
        return info.isDirectory ? "directory" : "file";
      } catch {
        return "missing";
      }
    };
    const found: string[] = [];
    const declared: string[] = [];
    for (const gate of gates) {
      for (const entry of gate.reachedBy) {
        const at = entry.replace(/^!/, "");
        // An entry carrying a `**` segment names no one path, and the
        // bounds test is what holds it to reaching something.
        if (at.includes("**/")) continue;
        // A path recorded as absent is declared missing, and is held to it.
        if (REACHED_BY_ABSENT_PATHS.has(entry)) {
          found.push(`${entry} ${await kindOf(at)}`);
          declared.push(`${entry} missing`);
          continue;
        }
        found.push(`${entry} ${await kindOf(at)}`);
        declared.push(`${entry} ${at.endsWith("/") ? "directory" : "file"}`);
      }
    }
    expect(found).toEqual(declared);
  });

  it("is reached by the inputs the gates that enumerate their own name", () => {
    // Two gates hold their inputs as constants, and the declarations
    // here are a second copy of the same facts. Comparing the copies is
    // what catches a gate that grows an input its declaration does not
    // name, which the two tests above cannot see.
    const reachedBy = (name: string, at: string): string =>
      `${name} ${
        byId("repo-gates").unitsForChange!(new Set([at])).includes(name)
          ? "runs for"
          : "misses"
      } ${at}`;
    const found: string[] = [];
    const declared: string[] = [];
    for (const { doc, demo } of DOC_DEMOS) {
      for (const at of [doc, demo]) {
        found.push(reachedBy("check-verb-session-sync", at));
        declared.push(`check-verb-session-sync runs for ${at}`);
      }
    }
    for (const tripwire of TRIPWIRES) {
      found.push(reachedBy("check-tripwires", tripwire.testFile));
      declared.push(`check-tripwires runs for ${tripwire.testFile}`);
    }
    for (const file of namedBenchmarkFiles()) {
      found.push(reachedBy("check-bench-workflow", file));
      declared.push(`check-bench-workflow runs for ${file}`);
    }
    expect(found).toEqual(declared);
  });

  it("runs a gate through the recorder that names its identity", async () => {
    const [invocation] = await byId("repo-gates").command(
      [{ unit: "deno-lint", skip: [] }],
      context,
    );
    // The wrapper is what turns a command's exit code into a record, so
    // the gate's identity is written on the command line rather than
    // being inferred from anything.
    expect(invocation!.command).toContain("run-recorded");
    expect(invocation!.command).toContain("lint");
    expect(invocation!.command).toContain("deno-lint");
    expect(invocation!.cwd).toBe("/repo");
  });

  it("runs the two Deno subcommands as subcommands", async () => {
    // `fmt` and `lint` are subcommands of Deno rather than tasks this
    // repository defines, so a command asking for either as a task
    // prints the list of tasks that do exist and exits one. The tail of
    // the command line is what the recorder runs, and it is the whole of
    // what decides this.

    const suite = byId("repo-gates");
    for (
      const [unit, run] of [
        ["deno-fmt", ["fmt", "--check"]],
        ["deno-lint", ["lint"]],
      ] as const
    ) {
      const [invocation] = await suite.command([{ unit, skip: [] }], context);
      expect(invocation!.command.slice(-run.length - 1)).toEqual([
        Deno.execPath(),
        ...run,
      ]);
    }
  });

  it("gives a gate that compares against a base the base to use", async () => {
    const [invocation] = await byId("repo-history-gates").command(
      [{ unit: "check-test-aliases", skip: [] }],
      { ...context, baseRef: "origin/release" },
    );
    expect(invocation!.command).toContain("origin/release");
  });

  it("compares against main where the lane names no base", async () => {
    const [invocation] = await byId("repo-history-gates").command(
      [{ unit: "check-baselines-append-only", skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("origin/main");
  });

  it("runs a gate that belongs to a package in that package", async () => {
    const [invocation] = await byId("repo-gates").command(
      [{ unit: "check-cfc-types", skip: [] }],
      context,
    );
    expect(invocation!.cwd).toBe("/repo/packages/static");
  });

  it("locates a gate by the name its record carries", () => {
    // Both gate suites record under the `gate` kind and the `repo` scope,
    // so the name is what separates one's records from the other's.
    expect(
      byId("repo-gates").locate({
        test: { k: "format", s: "repo", n: "deno-fmt" },
      }),
    ).toEqual({ level: "unit", unit: "deno-fmt" });
    expect(
      byId("repo-history-gates").locate({
        test: { k: "gate", s: "repo", n: "check-test-aliases" },
      }),
    ).toEqual({ level: "unit", unit: "check-test-aliases" });
    expect(
      byId("repo-gates").locate({
        test: { k: "gate", s: "repo", n: "check-test-aliases" },
      }),
    ).toBeUndefined();
  });

  it("checks only the package groups it was asked for", async () => {
    const typecheck = byId("typecheck");
    const [invocation] = await typecheck.command(
      [{ unit: "memory", skip: [] }, { unit: "runner", skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("--scope=memory");
    expect(invocation!.command).toContain("--scope=runner");
    expect(invocation!.command).not.toContain("--scope=cli");
  });

  it("maps a changed path to the group that checks it", () => {
    const typecheck = byId("typecheck");
    expect(typecheck.unitsForChange!(new Set(["packages/memory/mod.ts"])))
      .toEqual(["memory"]);
    // A path no group checks makes nothing mandatory, rather than making
    // every group mandatory or throwing.
    expect(typecheck.unitsForChange!(new Set(["README.md"]))).toEqual([]);
  });

  it("keeps the type check and the pattern check apart by name", () => {
    // Both record under `typecheck` and the pattern check under scope
    // `repo`, so only the name separates them.
    expect(
      byId("typecheck").locate({
        test: { k: "typecheck", s: "memory", n: "deno-check" },
      }),
    ).toEqual({ level: "unit", unit: "memory" });
    const pattern = byId("cfcheck").units[0]!;
    expect(
      byId("cfcheck").locate({
        test: { k: "typecheck", s: "repo", n: `cfcheck ${pattern}` },
      }),
    ).toEqual({ level: "unit", unit: pattern });
    expect(
      byId("typecheck").locate({
        test: { k: "typecheck", s: "repo", n: `cfcheck ${pattern}` },
      }),
    ).toBeUndefined();
    // The pattern check declines a name of its own surface that is
    // neither its suite's nor one of its patterns', rather than reading
    // the tail of any name at all as a path.
    expect(
      byId("cfcheck").locate({
        test: { k: "typecheck", s: "repo", n: "deno-check" },
      }),
    ).toBeUndefined();
    expect(
      byId("cfcheck").locate({
        test: { k: "typecheck", s: "repo", n: "cfcheck no/such/pattern.tsx" },
      }),
    ).toBeUndefined();
  });

  it("restricts a pattern gate to the patterns it was given", async () => {
    // One `--only` per pattern: the flag takes a single value, so a run
    // handed a list after one flag would be rejected by the task for the
    // second value it found.
    for (const id of ["cfcheck", "pattern-compat"]) {
      const suite = byId(id);
      const [invocation] = await suite.command(
        suite.units.slice(0, 2).map((unit) => ({ unit, skip: [] })),
        context,
      );
      const command = invocation!.command;
      expect(command.filter((word) => word === "--only")).toHaveLength(2);
      for (const [index, word] of command.entries()) {
        if (word !== "--only") continue;
        expect(command[index + 1]).not.toBe("--only");
      }
    }
  });

  it("asks a pattern gate for everything without a filter", async () => {
    // A run given every pattern is the task's own unfiltered run, which
    // is what a gate with a whole-tree question of its own needs: the
    // compatibility gate asks whether a retired pattern still has a
    // baseline and whether an accepted break has gone orphaned, and a
    // filtered run asks neither.
    for (const id of ["cfcheck", "pattern-compat"]) {
      const suite = byId(id);
      const [invocation] = await suite.command(
        suite.units.map((unit) => ({ unit, skip: [] })),
        context,
      );
      expect(invocation!.command).not.toContain("--only");
    }
  });

  it("records a pattern gate's invocation under the suite's name", async () => {
    // The wrapper is what turns the command's exit code into a record,
    // so the identity is written on the command line rather than
    // inferred. `run-recorded <kind> <scope> <name> -- <command>` puts
    // that name three words along.
    for (const id of ["cfcheck", "pattern-compat"]) {
      const suite = byId(id);
      const [invocation] = await suite.command(
        [{ unit: suite.units[0]!, skip: [] }],
        context,
      );
      const command = invocation!.command;
      const wrapper = command.indexOf("run-recorded");
      expect(wrapper).toBeGreaterThan(0);
      expect(command[wrapper + 3]).toBe(id);
      expect(command[wrapper + 4]).toBe("--");
    }
  });

  it("holds a pattern gate's own record to the suite", () => {
    // The wrapper records the whole invocation under the suite's name,
    // and that duration is the run's rather than any one pattern's.
    expect(
      byId("pattern-compat").locate({
        test: { k: "gate", s: "repo", n: "pattern-compat" },
      }),
    ).toEqual({ level: "suite" });
    expect(
      byId("cfcheck").locate({
        test: { k: "typecheck", s: "repo", n: "cfcheck" },
      }),
    ).toEqual({ level: "suite" });
  });

  it("selects one pattern per `--only` the task is given", () => {
    // A lane is charged for the units it asked for, so a filter the task
    // reads more widely than the topology meant would check patterns
    // nobody paid for. The task matches a filter as a substring, and what
    // makes that exact here is that a unit is a whole path.
    const units = byId("cfcheck").units;
    const widened = units.filter((unit) => {
      const hit = units.filter((file) => matchesPatternFilter(file, unit));
      return hit.length !== 1 || hit[0] !== unit;
    });
    expect(widened).toEqual([]);
  });

  it("names the pattern type check's units the way git names a file", async () => {
    // A unit that is a path needs no `unitsForChange`: the census makes
    // it mandatory from the diff naming it, so every unit has to be a
    // path git reports, in git's own spelling.
    const cfcheck = byId("cfcheck");
    expect(cfcheck.unitsForChange).toBeUndefined();
    const listed = await new Deno.Command("git", {
      args: ["-C", root, "ls-files", "-z", "packages"],
    }).output();
    const tracked = new Set(
      new TextDecoder().decode(listed.stdout).split("\0"),
    );
    expect(cfcheck.units.filter((unit) => !tracked.has(unit))).toEqual([]);
    expect(cfcheck.units.length).toBeGreaterThan(0);
  });

  it("claims a vintage record for every fixture the tree holds", () => {
    // The gate writes one record per fixture under the committed vintage
    // tree, named for the fixture's test key, tier and capture stamp. The
    // fixture set is read from git rather than from the enumerator the
    // gate replays with, so this compares the claim against the tree
    // rather than against the same walk twice.
    const vintage = byId("pattern-vintage");
    const names = vintageRecordNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        vintage.locate({ test: { k: "gate", s: "repo", n: name } }),
      ).toEqual({ level: "unit", unit: "pattern-vintage" });
    }
    // The wrapper's own record, which carries what the whole replay took.
    expect(
      vintage.locate({ test: { k: "gate", s: "repo", n: "pattern-vintage" } }),
    ).toEqual({ level: "unit", unit: "pattern-vintage" });
  });

  it("disowns a vintage record no fixture in the tree carries", () => {
    // These name fixtures no tree holds: the gate's own tests build them
    // in a temporary directory, and the record store carries executions
    // under them. An identity a suite claims is one a published manifest
    // carries and the publisher scores on every run, and `departed` in
    // `tasks/test-selection/build.ts` drops an identity from the
    // aggregate only while no suite claims it.
    const vintage = byId("pattern-vintage");
    const stamp = "2026-07-29T12-00-00.000Z";
    for (const key of ["subject", "nested", "undeclared", "crossspace"]) {
      expect(
        vintage.locate({
          test: {
            k: "gate",
            s: "repo",
            n: `pattern-vintage vintage-gate-${key}.test.tsx pinned ${stamp}`,
          },
        }),
      ).toBeUndefined();
    }
  });

  it("runs the vintage replay whole", async () => {
    // It writes a record per vintage and takes no way of running part of
    // itself, so the suite is one unit and the command is the task,
    // wrapped so its exit code becomes that unit's record.
    const vintage = byId("pattern-vintage");
    const [invocation] = await vintage.command(
      [{ unit: vintage.units[0]!, skip: [] }],
      context,
    );
    expect(invocation!.command).toContain("run-recorded");
    expect(invocation!.command.at(-1)).toBe(vintage.units[0]);
    expect(await vintage.command([], context)).toEqual([]);
  });

  it("declines a type-check record whose name is another gate's", () => {
    // Both record under the `typecheck` kind, so within one scope only
    // the name separates them.
    expect(
      byId("typecheck").locate({
        test: { k: "typecheck", s: "memory", n: "cfcheck a/b.tsx" },
      }),
    ).toBeUndefined();
  });

  it("builds no command for units it does not hold", async () => {
    expect(await byId("cfcheck").command([], context)).toEqual([]);
    expect(
      await byId("typecheck").command([{ unit: "nowhere", skip: [] }], context),
    ).toEqual([]);
    expect(
      await byId("repo-gates").command(
        [{ unit: "nowhere", skip: [] }],
        context,
      ),
    ).toEqual([]);
    expect(
      await byId("pattern-compat").command(
        [{ unit: "nowhere", skip: [] }],
        context,
      ),
    ).toEqual([]);
  });
});
