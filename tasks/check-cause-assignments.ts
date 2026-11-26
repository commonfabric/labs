#!/usr/bin/env -S deno run -A

/**
 * Fails when a change moves an anonymous cell of an in-tree pattern to a new
 * `{ $generated: N }` number while the pattern's source stays as it was.
 *
 * The runtime mints an anonymous cell's entity id from that number, so a
 * deployed piece set up under the old numbering reads each moved cell's state
 * from the document another cell wrote, and nothing at the piece notices: its
 * pattern identity, which hashes the source, did not change. Only a change to
 * the compiler can do this, so the gate compiles every pattern with the base
 * revision's compiler and with the change's, and compares the two builds of
 * each pattern whose source files are the same on both sides.
 * `runtime/runner/src/cause-assignment.ts` describes how a cell is told
 * apart from its neighbors across the two builds.
 *
 * A move the repository decides to ship is declared in
 * `cause-assignments-accepted-moves.ts`.
 *
 * A comparison only protects the patterns it reaches, so the gate also fails
 * on a pattern the base builds and the change compiles from the same source to
 * no assignment, and on a run that compares no patterns at all.
 *
 * The patterns are compared in `CAUSE_ASSIGNMENT_PARTS` parts, each its own
 * run, so that each fits in a lane: `--part K/N` compares every Nth pattern
 * of the sorted list, starting from the Kth. A run with no `--part` compares
 * them all.
 *
 * Usage: check-cause-assignments.ts [base-ref] [--part K/N]
 *        (default base: upstream/main where that exists, and origin/main
 *        otherwise)
 */

import { parse as parseJsonc } from "@std/jsonc";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { EXPERIMENTAL_ENV_VARS } from "../runtime/runner/src/experimental-posture.ts";
import { collectAllPatternFiles, patternKey } from "./pattern-files.ts";
import { defaultBase, type Git, git } from "./repository-files.ts";
import { type CommandOutput, emit } from "./command-output.ts";
import {
  type AmbiguousCells,
  ambiguousCells,
  assignmentDigest,
  type MovedCell,
  movedCells,
} from "./cause-assignments-lib.ts";
import type { DumpOutput } from "./cause-assignments-dump.ts";
import { UNEVALUABLE_PATTERNS } from "./pattern-compat-unevaluable.ts";
import {
  ACCEPTED_MOVES,
  type AcceptedMove,
} from "./cause-assignments-accepted-moves.ts";

/**
 * The paths a pattern's numbering is built by: the transformer that lowers
 * pattern source, the compiler and harness driving it, the builder that
 * numbers the cells and classifies them, the builtins whose node factories
 * and result schemas the builder takes in (`sqliteQuery`'s factory runs
 * `lift()` as its module evaluates), the schema generator that
 * classification reads, and the local defaults of the experimental flags a
 * runtime consumes itself, any of which can change what the compiler builds.
 * The gate passes a change touching none of them, or its own files, without
 * compiling anything; a change elsewhere that moves a cell is one it does not
 * see.
 */
export const COMPILER_PATHS: readonly string[] = [
  "base/js-compiler/",
  "runtime/runner/src/builder/",
  "runtime/runner/src/builtins/",
  "runtime/runner/src/experimental-defaults.ts",
  "runtime/runner/src/harness/",
  "base/schema-generator/src/",
  "base/ts-transformers/src/",
];

/**
 * This gate's own modules, the runner module that describes and matches each
 * level's cells, the moves it forgives and the patterns it excuses from
 * compiling, a change to any of which can change its verdict.
 */
export const GATE_PATHS: readonly string[] = [
  "runtime/runner/src/cause-assignment.ts",
  "tasks/cause-assignments-accepted-moves.ts",
  "tasks/cause-assignments-dump.ts",
  "tasks/cause-assignments-lib.ts",
  "tasks/check-cause-assignments.ts",
  "tasks/command-output.ts",
  "tasks/pattern-compat-unevaluable.ts",
  "tasks/pattern-files.ts",
  "tasks/repository-files.ts",
];

/** How many parts continuous integration compares the patterns in. */
export const CAUSE_ASSIGNMENT_PARTS = 3;

/**
 * One part of the patterns: the ones at `index`, `index + count`, and so on,
 * counting from zero, in the sorted list.
 */
export interface Part {
  index: number;
  count: number;
}

/** What a run of the gate is asked to compare. */
export interface Arguments {
  /** The base revision named, or undefined where none is. */
  baseRef: string | undefined;
  part: Part;
}

/**
 * The base revision and part `args` name. Throws on a `--part` that is not
 * `K/N` with `1 <= K <= N`, on an argument it does not know, and on a second
 * base revision.
 */
export function parseArguments(args: readonly string[]): Arguments {
  let baseRef: string | undefined;
  let part: Part = { index: 0, count: 1 };
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--part") {
      const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(args[++at] ?? "");
      const [k, n] = match === null
        ? [0, 0]
        : [Number(match[1]), Number(match[2])];
      if (!Number.isSafeInteger(n) || k < 1 || k > n) {
        throw new Error(
          `--part takes K/N with 1 <= K <= N, not ${args[at] ?? "nothing"}`,
        );
      }
      part = { index: k - 1, count: n };
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown argument ${arg}`);
    } else if (baseRef !== undefined) {
      throw new Error(`a second base revision, ${arg}`);
    } else {
      baseRef = arg;
    }
  }
  return { baseRef, part };
}

/** The entries of the sorted `items` that `part` holds. */
export function inPart<T>(items: readonly T[], part: Part): T[] {
  return items.filter((_, index) => index % part.count === part.index);
}

/**
 * The accepted moves a run comparing `part` of `files` judges: those naming
 * one of its patterns, and in the first part, those naming no pattern the
 * tree holds, so that every entry is reported by some part as forgiving
 * nothing once it does.
 */
export function acceptedInPart(
  accepted: readonly AcceptedMove[],
  files: readonly string[],
  part: Part,
): AcceptedMove[] {
  const held = new Set(files.map((file) => patternKey(file)));
  const mine = new Set(inPart(files, part).map((file) => patternKey(file)));
  return accepted.filter(({ pattern }) =>
    mine.has(pattern) || (part.index === 0 && !held.has(pattern))
  );
}

/** The verdict on one comparison of two dumps. */
export interface Comparison {
  /**
   * The moves no accepted entry forgives, by pattern, and the descriptions
   * whose cells cannot be matched. A move among the cells of such a
   * description is not among `moved`, since the pairing that found it is not
   * to be trusted there. A pattern fails on a move, or on such a description
   * of cells holding state; one of cells holding none fails it only through
   * a move the pairing finds among them, and is listed for the report.
   */
  failing: {
    pattern: string;
    base: string;
    head: string;
    moved: MovedCell[];
    ambiguous: AmbiguousCells[];
  }[];

  /**
   * The patterns whose moves, and cells that cannot be matched, an accepted
   * entry forgives.
   */
  forgiven: string[];

  /** The accepted entries that forgave nothing. */
  unused: AcceptedMove[];

  /** The patterns compared, which compiled on both sides from one source. */
  compared: number;

  /**
   * The patterns the base built and the head compiled from the same source to
   * no assignment. Such a pattern is not among `compared`, so it would
   * otherwise pass unseen.
   */
  dropped: string[];

  /** How many patterns each side's build gave an assignment. */
  built: { base: number; head: number };

  /**
   * The patterns either side failed to compile, less those that side's own
   * `UNEVALUABLE_PATTERNS` lists. Such a pattern is in neither side's
   * builds, so it would otherwise pass unseen.
   */
  compileErrors: { side: "base" | "head"; pattern: string; error: string }[];
}

/** The patterns each side lists as unevaluable, and so excuses. */
export interface Unevaluable {
  base: ReadonlySet<string>;
  head: ReadonlySet<string>;
}

/**
 * Compares the build of each pattern `head` holds with the build of it in
 * `base`, where the two were built from the same source files. Each side's
 * compile errors are excused by that side's own list of unevaluable
 * patterns, so that a change which makes a listed pattern evaluate, and so
 * takes it off the list, is not failed for the base's error on it.
 */
export function compareDumps(
  base: DumpOutput,
  head: DumpOutput,
  accepted: readonly AcceptedMove[],
  unevaluable: Unevaluable,
): Comparison {
  const before = new Map(
    base.assignments.map((assignment) => [assignment.pattern, assignment]),
  );
  const unassigned = new Map(
    head.unassigned.map(({ pattern, source }) => [pattern, source]),
  );
  const comparison: Comparison = {
    failing: [],
    forgiven: [],
    unused: [],
    compared: 0,
    dropped: base.assignments
      .filter(({ pattern, source }) => unassigned.get(pattern) === source)
      .map(({ pattern }) => pattern),
    built: { base: base.assignments.length, head: head.assignments.length },
    compileErrors: [
      ...base.errors
        .filter((error) => !unevaluable.base.has(error.pattern))
        .map((error) => ({ side: "base" as const, ...error })),
      ...head.errors
        .filter((error) => !unevaluable.head.has(error.pattern))
        .map((error) => ({ side: "head" as const, ...error })),
    ],
  };
  const used = new Set<AcceptedMove>();
  for (const after of head.assignments) {
    const prior = before.get(after.pattern);
    if (prior === undefined || prior.source !== after.source) continue;
    comparison.compared++;
    const ambiguous = ambiguousCells(prior, after);
    const pairedMoves = movedCells(prior, after);
    // TODO(danfuzz): A shift among cells holding no state that the pairing
    // reports no move for passes here, though the cells are listed in the
    // report where the pattern fails for another reason. Fail it too, once how
    // those cells are to be matched is settled; the case is pinned in
    // `check-cause-assignments.test.ts`.
    if (
      pairedMoves.length === 0 && !ambiguous.some((found) => found.hasState)
    ) {
      continue;
    }
    const ambiguousKeys = new Set(
      ambiguous.map(({ level, description }) =>
        JSON.stringify([level, description])
      ),
    );
    const moved = pairedMoves.filter(({ level, description }) =>
      !ambiguousKeys.has(JSON.stringify([level, description]))
    );
    const baseDigest = assignmentDigest(prior);
    const headDigest = assignmentDigest(after);
    const entry = accepted.find((candidate) =>
      candidate.pattern === after.pattern && candidate.base === baseDigest &&
      candidate.head === headDigest
    );
    if (entry !== undefined) {
      used.add(entry);
      comparison.forgiven.push(after.pattern);
    } else {
      comparison.failing.push({
        pattern: after.pattern,
        base: baseDigest,
        head: headDigest,
        moved,
        ambiguous,
      });
    }
  }
  comparison.unused = accepted.filter((entry) => !used.has(entry));
  return comparison;
}

/**
 * What is wrong with `entries` as accepted moves: an entry with no reason, a
 * digest not spelled as the gate prints one, or a pattern and pair of builds
 * named twice. An empty list says nothing is.
 */
export function acceptedMoveProblems(
  entries: readonly AcceptedMove[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = `${entry.pattern} (${entry.base} -> ${entry.head})`;
    if (entry.reason.trim() === "") {
      problems.push(`${name} gives no reason`);
    }
    for (const digest of [entry.base, entry.head]) {
      if (!/^[0-9a-f]{16}$/.test(digest)) {
        problems.push(`${name} names ${JSON.stringify(digest)}, not a digest`);
      }
    }
    if (seen.has(name)) problems.push(`${name} is named twice`);
    seen.add(name);
  }
  return problems;
}

/** The report of the patterns either side failed to compile. */
export function describeCompileErrors(comparison: Comparison): string {
  const lines = [
    "These patterns did not compile, so their numbering could not be " +
    "compared:",
    "",
  ];
  for (const { side, pattern, error } of comparison.compileErrors) {
    lines.push(`${pattern} (${side} build): ${error}`);
  }
  return lines.join("\n");
}

/** The report of `comparison`'s failing patterns. */
export function describeFailures(comparison: Comparison): string {
  const lines = [
    "A compiler change moves anonymous cells of these patterns to new " +
    "numbers while their source stays the same. A deployed piece set up " +
    "before the change would read each moved cell's state from the document " +
    "another cell wrote. Where cells share a description and their count or " +
    "their numbers changed, which cell went where cannot be told, so the " +
    "report gives each build's numbers for them, or names them added or " +
    "removed where only one build has any.",
    "",
  ];
  const where = (level: string) => level === "" ? "entry pattern" : level;
  const list = (numbers: readonly number[]) => `[${numbers.join(", ")}]`;
  for (const { pattern, base, head, moved, ambiguous } of comparison.failing) {
    lines.push(`${pattern} (base build ${base}, this build ${head}):`);
    for (const cell of moved) {
      lines.push(
        `  ${cell.from} -> ${cell.to}${cell.hasState ? ", holds state" : ""}` +
          `: ${cell.description} (${where(cell.level)})`,
      );
    }
    for (const cells of ambiguous) {
      const [kind, numbers] = cells.after.length === 0
        ? ["removed", list(cells.before)]
        : cells.before.length === 0
        ? ["added", list(cells.after)]
        : ["ambiguous", `${list(cells.before)} -> ${list(cells.after)}`];
      lines.push(
        `  ${kind}${cells.hasState ? ", holds state" : ""}: ${numbers}: ` +
          `${cells.description} (${where(cells.level)})`,
      );
    }
  }
  lines.push(
    "",
    "Keep the numbering where the change can. A move that has to ship is " +
      "declared in tasks/cause-assignments-accepted-moves.ts, naming the two " +
      "builds above.",
  );
  return lines.join("\n");
}

/** The report of `comparison`'s dropped patterns. */
export function describeDropped(comparison: Comparison): string {
  return [
    "The base build gives these patterns a cause assignment and this build " +
    "compiles the same source to none, so their numbering could not be " +
    "compared. `buildAssignment()` in tasks/cause-assignments-dump.ts found " +
    "no pattern among what each module evaluated to:",
    "",
    ...comparison.dropped,
  ].join("\n");
}

/** The report of a run that compared no patterns. */
export function describeNothingCompared({ built }: Comparison): string {
  return "This run compared no patterns, so it checked nothing. The base " +
    `build gave ${built.base} patterns an assignment and this build ` +
    `${built.head}, with no pattern on both sides from the same source. ` +
    "Either a build yields nothing tasks/cause-assignments-dump.ts can read, " +
    "or the change moves or edits every pattern, which has to land apart " +
    "from a change to what numbers them.";
}

/**
 * A report of each kind of failure in `comparison`. An empty list says the gate
 * passes.
 */
export function failureReports(comparison: Comparison): string[] {
  const reports: string[] = [];
  if (comparison.compileErrors.length > 0) {
    reports.push(describeCompileErrors(comparison));
  }
  if (comparison.failing.length > 0) {
    reports.push(describeFailures(comparison));
  }
  if (comparison.dropped.length > 0) {
    reports.push(describeDropped(comparison));
  }
  if (comparison.compared === 0) {
    reports.push(describeNothingCompared(comparison));
  }
  return reports;
}

/**
 * The patterns the checkout at `root` lists as unevaluable, which is none
 * where it holds no such list.
 */
export async function unevaluableIn(
  root: string,
): Promise<ReadonlySet<string>> {
  const list = join(root, "tasks/pattern-compat-unevaluable.ts");
  try {
    await Deno.stat(list);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Set();
    throw error;
  }
  const { UNEVALUABLE_PATTERNS: listed } = await import(
    toFileUrl(list).href
  );
  return listed;
}

/** What the dumper needs of a workspace package to load it by name. */
export interface WorkspacePackage {
  /** The URL of the package's directory, with a trailing slash. */
  dir: string;

  /** Each specifier the package exports, mapped to the URL of its file. */
  exports: Map<string, string>;

  /**
   * The package's own import map, which its modules resolve through, with
   * each relative target made a URL.
   */
  imports: Record<string, string>;
}

/** The workspace packages of the checkout at `root`, by package name. */
export async function workspacePackages(
  root: string,
): Promise<Map<string, WorkspacePackage>> {
  const config = parseJsonc(await Deno.readTextFile(join(root, "deno.jsonc")));
  const members = isObjectNotArray(config) && Array.isArray(config.workspace)
    ? config.workspace
    : [];
  const packages = new Map<string, WorkspacePackage>();
  for (const member of members) {
    if (typeof member !== "string") continue;
    const manifest = await memberManifest(join(root, member));
    if (!isObjectNotArray(manifest) || typeof manifest.name !== "string") {
      continue;
    }
    const name = manifest.name;
    const dir = toFileUrl(join(root, member, "/")).href;
    const exports = typeof manifest.exports === "string"
      ? { ".": manifest.exports }
      : isObjectNotArray(manifest.exports)
      ? manifest.exports
      : {};
    const specifiers = new Map<string, string>();
    for (const [key, file] of Object.entries(exports)) {
      if (typeof file !== "string") continue;
      specifiers.set(
        key === "." ? name : `${name}${key.slice(1)}`,
        new URL(file, dir).href,
      );
    }
    const imports: Record<string, string> = {};
    if (isObjectNotArray(manifest.imports)) {
      for (const [key, target] of Object.entries(manifest.imports)) {
        if (typeof target !== "string") continue;
        imports[key] = target.startsWith(".")
          ? new URL(target, dir).href
          : target;
      }
    }
    packages.set(name, { dir, exports: specifiers, imports });
  }
  return packages;
}

/** The parsed manifest of the workspace member at `dir`, if it has one. */
async function memberManifest(dir: string): Promise<unknown> {
  for (const file of ["deno.jsonc", "deno.json"]) {
    try {
      return parseJsonc(await Deno.readTextFile(join(dir, file)));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return undefined;
}

/**
 * The configuration the dumper runs under against the checkout at `root`.
 * The dumper's own modules come from the change at `head`, so they may name a
 * package that the change adds and `root` lacks. The configuration is the
 * checkout's own, with an import for every module of each such package, which
 * then comes from the change as the dumper does, and that package's own
 * import map scoped to its directory. It is written beside the checkout's
 * own, so that the paths of its workspace members still resolve.
 */
export async function dumperConfig(
  root: string,
  head: string,
): Promise<string> {
  const own = join(root, "deno.jsonc");
  const present = await workspacePackages(root);
  const added: Record<string, string> = {};
  const scopes: Record<string, Record<string, string>> = {};
  for (const [name, pkg] of await workspacePackages(head)) {
    if (present.has(name)) continue;
    for (const [specifier, url] of pkg.exports) added[specifier] = url;
    if (Object.keys(pkg.imports).length > 0) scopes[pkg.dir] = pkg.imports;
  }
  if (Object.keys(added).length === 0) return own;
  const config = parseJsonc(await Deno.readTextFile(own));
  if (!isObjectNotArray(config)) throw new Error(`${own} is not an object`);
  const imports = isObjectNotArray(config.imports) ? config.imports : {};
  const ownScopes = isObjectNotArray(config.scopes) ? config.scopes : {};
  const path = join(root, "deno.cause-assignments.json");
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      ...config,
      imports: { ...imports, ...added },
      scopes: { ...ownScopes, ...scopes },
    }),
  );
  return path;
}

/**
 * The environment the dumper runs in: `env`, without the variables that set
 * an experimental flag (`EXPERIMENTAL_ENV_VARS`), and with logging quieted.
 * Each build is then compiled under its own revision's defaults. An inherited
 * flag would set both builds alike, and so hide a change to its default from
 * the comparison.
 *
 * `DENO_COVERAGE_DIR` goes too. The dumper runs under a configuration of its
 * own, so a profile it wrote could not be converted, and a tracked file that
 * will not convert fails the lane (docs/development/COVERAGE.md).
 */
export function dumperEnvironment(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const leftOut = new Set<string>([
    "DENO_COVERAGE_DIR",
    ...Object.values(EXPERIMENTAL_ENV_VARS).filter((name) => name !== null),
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !leftOut.has(name)),
    ),
    LOG_LEVEL: "error",
  };
}

/**
 * Dumps the patterns `files` names with the compiler of the checkout at
 * `root`, in `shards` processes at once, running the dumper under the
 * configuration at `config`. Throws when a dumper fails.
 */
export async function dumpTree(
  root: string,
  config: string,
  files: readonly string[],
  shards: number,
  outDir: string,
  label: string,
): Promise<DumpOutput> {
  const dumper = fromFileUrl(
    new URL("./cause-assignments-dump.ts", import.meta.url),
  );
  const parts = Array.from(
    { length: shards },
    (_, shard) => files.filter((_, index) => index % shards === shard),
  ).filter((part) => part.length > 0);
  const outputs = await Promise.all(parts.map(async (part, shard) => {
    const out = join(outDir, `${label}-${shard}.json`);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        config,
        "-A",
        dumper,
        "--root",
        root,
        "--out",
        out,
        ...part,
      ],
      cwd: root,
      env: dumperEnvironment(Deno.env.toObject()),
      clearEnv: true,
      stdout: "inherit",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      throw new Error(
        `dumping the ${label} build failed:\n` +
          new TextDecoder().decode(stderr),
      );
    }
    return JSON.parse(await Deno.readTextFile(out)) as DumpOutput;
  }));
  return {
    assignments: outputs.flatMap((output) => output.assignments),
    unassigned: outputs.flatMap((output) => output.unassigned),
    errors: outputs.flatMap((output) => output.errors),
  };
}

/** What the gate asks of the checkout it runs in. */
export interface GateCheckout {
  /** Runs git in the working directory. */
  git: Git;

  /** Dumps one tree's patterns, as {@link dumpTree} does. */
  dumpTree: typeof dumpTree;
}

const CHECKOUT: GateCheckout = { git, dumpTree };

/**
 * Runs the gate as `args` asks, against the merge base of its base revision
 * and `HEAD` in `checkout`, forgiving each move `accepted` names, and returns
 * what to say: exit code 0 where it passes, 1 where it fails, and 2 for an
 * argument it cannot read or a merge base git cannot find.
 */
export async function main(
  args: readonly string[],
  checkout: GateCheckout = CHECKOUT,
  accepted: readonly AcceptedMove[] = ACCEPTED_MOVES,
): Promise<CommandOutput> {
  const problems = acceptedMoveProblems(accepted);
  if (problems.length > 0) {
    return {
      err: "tasks/cause-assignments-accepted-moves.ts:\n" +
        problems.map((problem) => `  ${problem}`).join("\n"),
      code: 1,
    };
  }
  let parsed: Arguments;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    return {
      err: `${String(error)}\n` +
        "Usage: check-cause-assignments.ts [base-ref] [--part K/N]",
      code: 2,
    };
  }
  const { part } = parsed;
  const baseRef = parsed.baseRef ?? await defaultBase(checkout.git);
  let mergeBase: string;
  try {
    mergeBase = (await checkout.git("merge-base", baseRef, "HEAD")).trim();
  } catch {
    return {
      err: `Could not resolve a merge base against ${baseRef}. This check ` +
        "needs real history — CI must check out with fetch-depth: 0.",
      code: 2,
    };
  }
  const changed = (await checkout.git(
    "diff",
    "--name-only",
    mergeBase,
    "--",
    ...COMPILER_PATHS,
    ...GATE_PATHS,
  )).trim();
  if (changed === "") {
    return {
      out: "check-cause-assignments: nothing a pattern's numbering is built " +
        `by changed since ${mergeBase.slice(0, 10)}.`,
      code: 0,
    };
  }

  const head = (await checkout.git("rev-parse", "--show-toplevel")).trim();
  const scratch = await Deno.makeTempDir({ prefix: "cause-assignments-" });
  const baseTree = join(scratch, "base");
  await checkout.git("worktree", "add", "--detach", baseTree, mergeBase);
  let found: CommandOutput;
  try {
    const all = await collectAllPatternFiles(head);
    const files = inPart(all, part);
    const inBase: string[] = [];
    for (const file of files) {
      try {
        await Deno.stat(join(baseTree, file));
        inBase.push(file);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    // Each tree's patterns are split over processes of their own, and the
    // two trees are dumped at once.
    const shards = Math.max(
      1,
      Math.min(4, Math.floor(navigator.hardwareConcurrency / 2)),
    );
    const started = performance.now();
    const [baseDump, headDump] = await Promise.all([
      checkout.dumpTree(
        baseTree,
        await dumperConfig(baseTree, head),
        inBase,
        shards,
        scratch,
        "base",
      ),
      checkout.dumpTree(
        head,
        join(head, "deno.jsonc"),
        files,
        shards,
        scratch,
        "head",
      ),
    ]);
    const comparison = compareDumps(
      baseDump,
      headDump,
      acceptedInPart(accepted, all, part),
      { base: await unevaluableIn(baseTree), head: UNEVALUABLE_PATTERNS },
    );
    const out = [
      `check-cause-assignments${
        part.count === 1 ? "" : ` part ${part.index + 1} of ${part.count}`
      }: compared ${comparison.compared} patterns ` +
      `built from the same source by ${mergeBase.slice(0, 10)} and this ` +
      `change, in ${Math.round((performance.now() - started) / 1000)}s.`,
      ...comparison.forgiven.map((pattern) =>
        `  ${pattern}: moves forgiven by an accepted entry`
      ),
      ...comparison.unused.map((entry) =>
        `  the accepted entry for ${entry.pattern} (${entry.base} -> ` +
        `${entry.head}) forgives nothing in this run and can be removed`
      ),
    ].join("\n");
    const reports = failureReports(comparison);
    found = reports.length > 0
      ? { out, err: reports.join("\n"), code: 1 }
      : { out, code: 0 };
  } catch (error) {
    // A removal that fails is reported beside the error that ended the run.
    const leftBehind = await removeBase(checkout.git, baseTree, scratch);
    if (leftBehind === undefined) throw error;
    throw new Error(`${error}\n${leftBehind}`, { cause: error });
  }
  // What the run found stands whether or not the base checkout went.
  const leftBehind = await removeBase(checkout.git, baseTree, scratch);
  return leftBehind === undefined ? found : {
    out: found.out,
    err: [found.err, leftBehind].filter((text) => text !== undefined)
      .join("\n"),
    code: 1,
  };
}

/**
 * Removes the base checkout at `baseTree` and the scratch directory holding
 * it, and returns what could not be removed, or nothing where both went.
 */
async function removeBase(
  run: Git,
  baseTree: string,
  scratch: string,
): Promise<string | undefined> {
  try {
    await run("worktree", "remove", "--force", baseTree);
    await Deno.remove(scratch, { recursive: true });
    return undefined;
  } catch (error) {
    return `Could not clean up the base checkout at ${baseTree}: ${error}`;
  }
}

if (import.meta.main) emit(await main(Deno.args));
