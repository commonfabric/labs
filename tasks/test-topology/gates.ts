/**
 * The repository's own gates: formatting, linting, the type check, the
 * pattern type check, the pattern update gates, and the checks that hold
 * a file or a document to a shape.
 *
 * The gates are two suites rather than one because a lane opens what a
 * suite needs before it runs any of it. Two of them read the revision the
 * change is measured against, which takes a checkout carrying history;
 * the rest read the working tree and need nothing but the toolchain. A
 * gate reaches a lane the way a test does: because the change touches
 * what it reads, on what it is worth, or because nothing has a record of
 * it.
 */

import { collectPathsByScope, scopeOfPath } from "../typecheck.ts";
import * as path from "@std/path";
import {
  collectPatternFiles,
  normalizePatternPath,
  PATTERN_TREES,
  patternKey,
} from "../pattern-files.ts";
import {
  claimsIdentity,
  type Invocation,
  type Location,
  type ReachedBy,
  reachedByChange,
  type RecordSurface,
  type Suite,
  type UnitRequest,
} from "./suite.ts";
import type { CapabilityId } from "../ci-capabilities.ts";
import {
  collectVintages,
  VINTAGE_GATE,
  vintageRecordName,
  VINTAGES_DIR,
} from "../pattern-vintage-layout.ts";

/** One repository gate: what it is called, and what runs it. */
export interface Gate {
  /** The name its record carries. */
  name: string;

  /** The record kind, which is `gate` for all but formatting and linting. */
  kind: string;

  /** What runs it, as the arguments Deno takes beyond its own path. */
  run: readonly string[];

  /** Further arguments, for a gate that reads the base revision. */
  args?: (context: { baseRef: string }) => string[];

  /** Where it runs, repository-relative, when that is not the root. */
  cwd?: string;

  /**
   * The paths a change reaches this gate by, in the vocabulary
   * {@link ReachedBy} defines. A change touching one of them makes the
   * gate mandatory, ahead of everything the score chooses, and
   * `gates.test.ts` holds every gate's declaration to the two bounds
   * that vocabulary is under.
   *
   * This is not a claim about everything the gate opens. A gate whose
   * input runs to a large part of the repository names the small and
   * specific part of it, or names nothing at all and is left to the
   * score.
   *
   * Within the bounds the answer errs toward running, since a suite
   * mapping a change onto its units wrongly runs too much or too little
   * rather than reporting anything. So a gate reading a set of files
   * names the directory holding them, and a gate examining live code
   * stops at the package declaring what it examines rather than naming
   * everything that package imports.
   */
  reachedBy: ReachedBy;
}

/** The gates that read nothing but the working tree. */
export const WORKING_TREE_GATES: readonly Gate[] = [
  {
    name: "deno-fmt",
    kind: "format",
    run: ["fmt", "--check"],
    // Reads every file the root configuration does not exclude.
    reachedBy: [],
  },
  {
    name: "deno-lint",
    kind: "lint",
    run: ["lint"],
    // The same, over the extensions the linter opens.
    reachedBy: [],
  },
  {
    name: "check-test-topology",
    kind: "gate",
    run: ["task", "check-test-topology"],
    // Walks every tree this repository keeps source in for anything
    // that looks like a test, and holds the topology to what it finds.
    // The topology enumerates from those same trees, so a set stated
    // here names every directory holding code and comes to all but a
    // change that touches none of it.
    reachedBy: [],
  },
  {
    name: "check-skill-facts",
    kind: "gate",
    run: ["task", "check-skill-facts"],
    // Holds every path a skill, an `AGENTS.md`, a rule or a hook script
    // cites to resolving against the tree, so a file moved or removed
    // anywhere can fail it.
    reachedBy: [],
  },
  {
    name: "check-address-examples",
    kind: "gate",
    run: ["task", "check-address-examples"],
    // Reads every Markdown document and the comments of every TypeScript
    // file, so a comment added anywhere can fail it.
    reachedBy: [],
  },
  {
    name: "check-tripwires",
    kind: "gate",
    run: ["task", "check-tripwires"],
    // Probes the weakness each tripwire asserts is still present, and
    // reads the test file carrying the same assertion. A tripwire added
    // against another package widens this list. The workflow is here
    // because a tripwire reads the shape of the job matrix, so a change
    // to it is a change to what that tripwire probes.
    reachedBy: [
      ".github/workflows/deno.yml",
      "packages/identity/",
      "packages/toolshed/routes/ingest-channels/",
      "tasks/check-tripwires.ts",
      "tasks/post-test-jobs-tripwire.test.ts",
    ],
  },
  {
    name: "check-docs",
    kind: "gate",
    run: ["task", "check-docs"],
    // The documents holding the blocks, and the import map they
    // compile through. The historical tree is walked past: those blocks
    // reflect the API of their era. A block also compiles against this
    // repository's own modules, which is most of `packages/` and so
    // stays with the score.
    reachedBy: ["deno.jsonc", "docs/", "!docs/history/"],
  },
  {
    name: "check-bench-workflow",
    kind: "gate",
    run: ["task", "check-bench-workflow"],
    // The workflow holding the `deno bench` list, the module holding the
    // names, and each file named. `gates.test.ts` compares the last of
    // those against the names themselves, so a name added here without a
    // declaration fails there.
    reachedBy: [
      ".github/workflows/benchmarks.yml",
      "packages/dashboard/bench-report.ts",
      "packages/dashboard/machine-calibration.bench.ts",
      "packages/patterns/integration/topic-board-navigation.bench.ts",
      "packages/patterns/integration/topic-board-scale.bench.ts",
      "tasks/check-bench-workflow.ts",
    ],
  },
  {
    name: "check-docs-history-index",
    kind: "gate",
    run: ["task", "check-docs-history-index"],
    reachedBy: ["docs/history/", "tasks/check-docs-history-index.ts"],
  },
  {
    name: "check-no-waitfor",
    kind: "gate",
    run: ["task", "check-no-waitfor"],
    // The `integration` directories under `packages`, less the package
    // declaring the polling helper, which is out of the check's scope.
    reachedBy: [
      "packages/**/integration/",
      "!packages/integration/",
      "tasks/check-no-waitfor.ts",
    ],
  },
  {
    name: "check-conflict-markers",
    kind: "gate",
    run: ["task", "check-conflict-markers"],
    // Reads every tracked file: a marker left behind is a mistake
    // wherever it lands.
    reachedBy: [],
  },
  {
    name: "check-test-shuffle",
    kind: "gate",
    run: ["task", "check-test-shuffle"],
    // Reads every manifest, workflow and shell script in the tree, so a
    // command that starts a test runner is reached wherever it is
    // written.
    reachedBy: [],
  },
  {
    name: "check-control-characters",
    kind: "gate",
    run: ["task", "check-control-characters"],
    // The same, over every tracked file the extension list does not
    // call binary.
    reachedBy: [],
  },
  {
    name: "check-verb-session-sync",
    kind: "gate",
    run: ["task", "check-verb-session-sync"],
    reachedBy: [
      "docs/common/verbs/",
      "docs/common/workflows/",
      "packages/cli/integration/",
      "tasks/check-verb-session-sync.ts",
    ],
  },
  {
    name: "check-pattern-tiers",
    kind: "gate",
    run: ["task", "check-pattern-tiers"],
    // The pattern sources, the tier tables, and the collector deciding
    // which files take a marker at all. The baselines are data beside
    // the patterns and carry no marker.
    reachedBy: [
      "packages/patterns/",
      "!packages/patterns/baselines/",
      "tasks/check-pattern-tiers.ts",
      "tasks/pattern-files.ts",
      "tasks/pattern-tiers.ts",
    ],
  },
  {
    name: "check-unused-deps",
    kind: "gate",
    run: ["task", "check-unused-deps"],
    // Reads every tracked code file, since the import that justifies a
    // declared dependency can sit in any of them.
    reachedBy: [],
  },
  {
    name: "check-deno-pins",
    kind: "gate",
    run: ["task", "check-deno-pins"],
    reachedBy: [
      ".github/actions/deno-setup/action.yml",
      "Dockerfile.dashboard",
      "Dockerfile.toolshed",
      "mise.toml",
      "tasks/check-deno-pins.ts",
      "tasks/check.sh",
    ],
  },
  {
    name: "check-action-pins",
    kind: "gate",
    run: ["task", "check-action-pins"],
    reachedBy: [".github/", "tasks/check-action-pins.ts"],
  },
  {
    name: "check-single-copy-deps",
    kind: "gate",
    run: ["task", "check-single-copy-deps"],
    reachedBy: ["deno.lock", "tasks/check-single-copy-deps.ts"],
  },
  {
    name: "check-package-cycles",
    kind: "gate",
    run: ["task", "check-package-cycles"],
    // Reads every production module under `packages/` for its imports,
    // which is most of the repository, and no smaller part of it
    // decides the verdict.
    reachedBy: [],
  },
  {
    name: "check-local-program",
    kind: "gate",
    run: ["task", "check-local-program"],
    // Reads every tracked TypeScript file, since the resolver it looks
    // for can be named from any of them.
    reachedBy: [],
  },
  {
    name: "check-completion-slots",
    kind: "gate",
    run: ["task", "check-completion-slots"],
    // The command tree it walks and the two provider tables it
    // subtracts against.
    reachedBy: [
      "packages/cli/commands/",
      "packages/cli/lib/completion/",
      "tasks/check-completion-slots.ts",
    ],
  },
  {
    name: "check-command-docs",
    kind: "gate",
    run: ["task", "check-command-docs"],
    // The command tree and the shuttle verbs, against the documents
    // that could describe them: the documentation tree less the two
    // parts of it no live document sits in, the authored skills, and
    // the README of each workspace member the root config names.
    reachedBy: [
      "deno.jsonc",
      "docs/",
      "!docs/history/",
      "!docs/plans/",
      "packages/**/README.md",
      "packages/cli/commands/",
      "packages/cli/lib/shuttle/",
      "skills/",
      "tasks/check-command-docs.ts",
    ],
  },
  {
    name: "check-cfc-types",
    kind: "gate",
    run: ["task", "check-cfc-types"],
    cwd: "packages/static",
    reachedBy: [
      "packages/api/",
      "packages/static/assets/types/",
      "packages/static/scripts/",
    ],
  },
  {
    name: "check-commonfabric-types",
    kind: "gate",
    run: ["task", "check-commonfabric-types"],
    cwd: "packages/static",
    // The pattern API and the workspace modules it re-exports, whose
    // text this one inlines.
    reachedBy: [
      "packages/api/",
      "packages/data-model/",
      "packages/static/assets/types/",
      "packages/static/scripts/",
    ],
  },
  {
    name: "check-withheld-globals",
    kind: "gate",
    run: ["task", "check-withheld-globals"],
    cwd: "packages/static",
    // The type libraries, and the sandbox contract naming the globals
    // to be stripped from them.
    reachedBy: [
      "packages/static/assets/types/",
      "packages/static/scripts/",
      "packages/utils/",
    ],
  },
];

/**
 * Entries of a gate's `reachedBy` that name a path the tree never holds,
 * because the path's presence is what the gate fails on. A change that adds
 * such a path has to reach the gate, and nothing else about the entry can
 * be checked against the tree.
 */
export const REACHED_BY_ABSENT_PATHS: ReadonlySet<string> = new Set([
  // TODO(danfuzz): Remove this entry, and its line in
  // `check-test-aliases`'s `reachedBy`, once the branches cut while the
  // aliases were this single file can all be expected to have merged
  // `main` — a couple of weeks after 2026-09-18.
  "tasks/test-identity-aliases.jsonl",
]);

/**
 * The gates that hold a file to being appended to. Each reads the file as
 * it stood at the merge base with the revision the change is measured
 * against, which takes a checkout carrying history.
 */
export const HISTORY_GATES: readonly Gate[] = [
  {
    name: "check-baselines-append-only",
    kind: "gate",
    run: ["task", "check-baselines-append-only"],
    args: ({ baseRef }) => [baseRef],
    // The baselines. A deleted pattern file is what excuses deleting
    // the baselines beside it, so it can turn this gate's verdict from
    // a failure into a pass but never the other way, and reaches the
    // gate by nothing on its own.
    reachedBy: [
      "packages/patterns/baselines/",
      "tasks/check-baselines-append-only.ts",
      "tasks/pattern-files.ts",
    ],
  },
  {
    name: "check-test-aliases",
    kind: "gate",
    run: ["task", "check-test-aliases"],
    args: ({ baseRef }) => [baseRef],
    // The alias files, and the module holding the line format the task
    // parses and the graph rules it applies; the task itself is a
    // `git show` wrapper around those. The `.jsonl` file beside the
    // directory is one the gate fails on sight, so a change adding it has
    // to reach the gate; `REACHED_BY_ABSENT_PATHS` records it as absent.
    reachedBy: [
      "packages/test-support/",
      "tasks/check-test-aliases.ts",
      "tasks/test-identity-aliases/",
      "tasks/test-identity-aliases.jsonl",
    ],
  },
];

/**
 * A suite of repository gates. Each gate is one unit holding one
 * identity, and running it is the whole of what a lane does with it, so
 * there is nothing finer to reach.
 */
function gateSuite(
  id: string,
  gates: readonly Gate[],
  needs: readonly CapabilityId[],
): Suite {
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  const recordSurfaces: RecordSurface[] = [
    ...new Set(gates.map((gate) => gate.kind)),
  ].map((kind) => ({ kind, scope: "repo" }));
  return {
    id,
    recordSurfaces,
    needs,
    units: gates.map((gate) => gate.name),
    unavailable: [],
    // Each gate is one identity, so a unit holds nothing to leave out.
    whole: gates.map((gate) => gate.name),
    // A gate's unit is the name of a gate rather than a path, so what a
    // change reaches is what each gate declares it reads. A gate that
    // declares nothing reads the whole tree, and reaches a lane on what
    // it is worth or because nothing has a record of it.
    unitsForChange(changed) {
      return gates
        .filter((gate) => reachedByChange(gate.reachedBy, changed))
        .map((gate) => gate.name);
    },
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      return byName.has(record.test.n)
        ? { level: "unit", unit: record.test.n }
        : undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      const baseRef = context.baseRef ?? "origin/main";
      const invocations: Invocation[] = [];
      for (const request of requests) {
        const gate = byName.get(request.unit);
        if (gate === undefined) continue;
        invocations.push({
          command: [
            Deno.execPath(),
            "task",
            "run-recorded",
            gate.kind,
            "repo",
            gate.name,
            "--",
            Deno.execPath(),
            ...gate.run,
            ...gate.args?.({ baseRef }) ?? [],
          ],
          cwd: gate.cwd === undefined
            ? context.root
            : `${context.root}/${gate.cwd}`,
        });
      }
      return Promise.resolve(invocations);
    },
  };
}

/**
 * The type check, one unit per package group. The store records one
 * identity per group and the mapping from a changed file to its group is
 * direct, so `unitsForChange` names exactly the groups a change touches.
 */
async function typecheckSuite(root: string): Promise<Suite> {
  const byScope = await collectPathsByScope(root);
  const scopes = [...byScope.keys()].sort();
  const known = new Set(scopes);
  const recordSurfaces = scopes.map((scope) => ({ kind: "typecheck", scope }));
  return {
    id: "typecheck",
    recordSurfaces,
    needs: ["deno"],
    units: scopes,
    unavailable: [],
    // One `deno check` over a group records one identity.
    whole: scopes,
    // A group's unit is the scope it checks rather than a path, so the
    // diff is mapped onto scopes the same way the check itself groups
    // the paths it walks.
    unitsForChange(changed) {
      const touched = new Set<string>();
      for (const path of changed) {
        const scope = scopeOfPath(path);
        if (known.has(scope)) touched.add(scope);
      }
      return [...touched];
    },
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      // `cfcheck` records under the same kind and its own names, so the
      // name is what separates the two.
      if (record.test.n !== "deno-check") return undefined;
      return known.has(record.test.s)
        ? { level: "unit", unit: record.test.s }
        : undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      const named = requests
        .map((request) => request.unit)
        .filter((unit) => known.has(unit));
      if (named.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "check",
          ...named.map((scope) => `--scope=${scope}`),
        ],
        cwd: context.root,
      }]);
    },
  };
}

/**
 * Every authored pattern in the tree, repository-relative.
 *
 * Collected against the root the topology was given rather than the
 * process's own directory: a lane runs from the repository root, and a
 * test of the topology runs from wherever its package does.
 */
async function patternFiles(root: string): Promise<string[]> {
  const found = await Promise.all(
    PATTERN_TREES.map((tree) =>
      collectPatternFiles(path.join(root, tree.directory))
    ),
  );
  return found.flat()
    .map((file) => normalizePatternPath(path.relative(root, file)))
    .sort();
}

/**
 * The `--only` arguments that restrict a pattern task to `chosen`. The
 * flag takes a single value, so it is repeated rather than given a list.
 *
 * A run asked for every pattern passes no filter at all, which leaves it
 * the task's own unfiltered run. That is what a task with a whole-tree
 * question of its own needs, and what makes a full run's command the one
 * a person types.
 */
function onlyArguments(chosen: readonly string[], whole: boolean): string[] {
  return whole ? [] : chosen.flatMap((value) => ["--only", value]);
}

/**
 * The pattern type check, one unit per pattern. Its task takes `--only`
 * to restrict which patterns it compiles, so a lane checks the ones it
 * was given, and a run given every pattern passes no `--only` at all.
 *
 * A unit is the pattern's own path, so the diff naming it is the whole of
 * what makes it mandatory and this suite maps nothing itself. The task
 * writes one record per pattern named `cfcheck <path>`; the record the
 * wrapper writes for the invocation is named for the suite, and carries
 * what the whole run took rather than what any pattern took.
 */
async function cfcheckSuite(root: string): Promise<Suite> {
  const units = await patternFiles(root);
  const known = new Set(units);
  const name = "cfcheck";
  const recordSurfaces = [{ kind: "typecheck", scope: "repo" }];
  return {
    id: name,
    recordSurfaces,
    needs: ["deno"],
    units,
    unavailable: [],
    // A unit here is a pattern file, and checking one records one identity. A
    // lane restricts the task with `--only`, which selects whole patterns.
    whole: units,
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      if (record.test.n === name) return { level: "suite" };
      if (!record.test.n.startsWith(`${name} `)) return undefined;
      const unit = record.test.n.slice(name.length + 1);
      return known.has(unit) ? { level: "unit", unit } : undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      const chosen = requests
        .map((request) => request.unit)
        .filter((unit) => known.has(unit));
      if (chosen.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "run-recorded",
          "typecheck",
          "repo",
          name,
          "--",
          Deno.execPath(),
          "task",
          name,
          ...onlyArguments(chosen, chosen.length === units.length),
        ],
        cwd: context.root,
      }]);
    },
  };
}

/**
 * The pattern update compatibility gate, one unit per pattern. Its task
 * takes `--only` to restrict which patterns it reads, so a lane runs the
 * ones it was given, and a run given every pattern passes no `--only` at
 * all — the whole-tree questions this gate also answers, whether a
 * retired pattern still has a baseline and whether an accepted break has
 * gone orphaned, are only asked of an unfiltered run.
 */
async function patternCompatSuite(root: string): Promise<Suite> {
  const byKey = new Map(
    (await patternFiles(root)).map((file) => [patternKey(file), file]),
  );
  const units = [...byKey.keys()].sort();
  const recordSurfaces = [{ kind: "gate", scope: "repo" }];
  const name = "pattern-compat";
  return {
    id: "pattern-compat",
    recordSurfaces,
    needs: ["deno"],
    units,
    unavailable: [],
    // Each pattern's verdict is one identity, and `--only` selects whole
    // patterns.
    whole: units,
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      if (record.test.n === name) return { level: "suite" };
      if (!record.test.n.startsWith(`${name} `)) return undefined;
      const key = record.test.n.slice(name.length + 1);
      return byKey.has(key) ? { level: "unit", unit: key } : undefined;
    },
    command(requests: readonly UnitRequest[], context): Promise<Invocation[]> {
      const keys = requests
        .map((request) => request.unit)
        .filter((unit) => byKey.has(unit));
      if (keys.length === 0) return Promise.resolve([]);
      const whole = keys.length === units.length;
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "run-recorded",
          "gate",
          "repo",
          name,
          "--",
          Deno.execPath(),
          "task",
          name,
          ...onlyArguments(
            keys.map((key) => byKey.get(key)!),
            whole,
          ),
        ],
        cwd: context.root,
      }]);
    },
  };
}

/**
 * The vintage replay, with one unit per committed fixture. Each fixture
 * restores its own store, drives its own roots, and compares against its own
 * manifest, so its result is the same whether or not other fixtures replay. A
 * lane restricts the run to the fixtures it chose with `--only`. A run given
 * every fixture passes no filter, which lets it also make the checks that need
 * every fixture replayed.
 *
 * A unit is the fixture's repository-relative path, so a change that adds or
 * edits a fixture makes replaying that fixture mandatory. The record the task
 * writes for the whole replay belongs to the suite rather than to a unit. It
 * measures the entire replay, so adding it to the fixtures' times would count
 * that work twice.
 */
async function patternVintageSuite(root: string): Promise<Suite> {
  // Units are repository-relative paths, which is what a diff names.
  // `collectVintages` names each fixture under the root it is given. The root
  // here is absolute, so the task behaves the same from any directory.
  const byRecord = new Map(
    (await collectVintages(path.join(root, VINTAGES_DIR)))
      .map((
        vintage,
      ) => [vintageRecordName(vintage), path.relative(root, vintage.path)]),
  );
  const units = [...byRecord.values()].sort();
  const known = new Set(units);
  const recordSurfaces = [{ kind: "gate", scope: "repo" }];
  return {
    id: VINTAGE_GATE,
    recordSurfaces,
    needs: ["deno", "git-history"],
    units,
    unavailable: [],
    // Each fixture's replay is one identity, so a unit holds nothing to leave
    // out.
    whole: units,
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      if (record.test.n === VINTAGE_GATE) return { level: "suite" };
      const unit = byRecord.get(record.test.n);
      return unit === undefined ? undefined : { level: "unit", unit };
    },
    command(requests, context): Promise<Invocation[]> {
      const chosen = requests
        .map((request) => request.unit)
        .filter((unit) => known.has(unit));
      if (chosen.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "run-recorded",
          "gate",
          "repo",
          VINTAGE_GATE,
          "--",
          Deno.execPath(),
          "task",
          VINTAGE_GATE,
          ...onlyArguments(chosen, chosen.length === units.length),
        ],
        cwd: context.root,
      }]);
    },
  };
}

/** Every gate suite, read from the working tree. */
export async function loadGateSuites(root: string): Promise<Suite[]> {
  return [
    // The action-pin gate asks GitHub what each pin resolves to, and
    // sixty requests an hour is what the service allows a caller with no
    // token.
    gateSuite("repo-gates", WORKING_TREE_GATES, ["deno", "github-api"]),
    gateSuite("repo-history-gates", HISTORY_GATES, ["deno", "git-history"]),
    await typecheckSuite(root),
    await cfcheckSuite(root),
    await patternCompatSuite(root),
    await patternVintageSuite(root),
  ];
}
