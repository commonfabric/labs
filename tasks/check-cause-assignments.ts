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
 * `packages/runner/src/cause-assignment.ts` describes how a cell is told
 * apart from its neighbors across the two builds.
 *
 * A move the repository decides to ship is declared in
 * `cause-assignments-accepted-moves.ts`.
 *
 * Usage: check-cause-assignments.ts [base-ref]   (default: origin/main)
 */

import { join } from "@std/path";
import { collectAllPatternFiles } from "./pattern-files.ts";
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
 * The trees a pattern's numbering is built by: the transformer that lowers
 * pattern source, the compiler and harness driving it, the builder that
 * numbers the cells and classifies them, the builtins whose node factories
 * and result schemas the builder takes in (`sqliteQuery`'s factory runs
 * `lift()` as its module evaluates), and the schema generator that
 * classification reads. The gate passes a change touching none of them, or
 * its own files, without compiling anything; a change elsewhere that moves a
 * cell is one it does not see.
 */
export const COMPILER_PATHS: readonly string[] = [
  "packages/js-compiler/",
  "packages/runner/src/builder/",
  "packages/runner/src/builtins/",
  "packages/runner/src/harness/",
  "packages/schema-generator/src/",
  "packages/ts-transformers/src/",
];

/**
 * This gate's own modules, the runner module that describes and matches each
 * level's cells, the moves it forgives and the patterns it excuses from
 * compiling, a change to any of which can change its verdict.
 */
export const GATE_PATHS: readonly string[] = [
  "packages/runner/src/cause-assignment.ts",
  "tasks/cause-assignments-accepted-moves.ts",
  "tasks/cause-assignments-dump.ts",
  "tasks/cause-assignments-lib.ts",
  "tasks/check-cause-assignments.ts",
  "tasks/pattern-compat-unevaluable.ts",
  "tasks/pattern-files.ts",
];

/** The verdict on one comparison of two dumps. */
export interface Comparison {
  /**
   * The moves no accepted entry forgives, by pattern, and the descriptions of
   * cells holding state whose cells cannot be matched. A move among the
   * cells of such a description is not among `moved`, since the pairing that
   * found it is not to be trusted there.
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
  const comparison: Comparison = {
    failing: [],
    forgiven: [],
    unused: [],
    compared: 0,
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
    const ambiguousKeys = new Set(
      ambiguous.map(({ level, description }) =>
        JSON.stringify([level, description])
      ),
    );
    const moved = movedCells(prior, after).filter(({ level, description }) =>
      !ambiguousKeys.has(JSON.stringify([level, description]))
    );
    if (moved.length === 0 && ambiguous.length === 0) continue;
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
    "another cell wrote. Where cells holding state share a description and " +
    "their count or their numbers changed, which cell went where cannot be " +
    "told, so the report gives each build's numbers for them.",
    "",
  ];
  const where = (level: string) => level === "" ? "entry pattern" : level;
  for (const { pattern, base, head, moved, ambiguous } of comparison.failing) {
    lines.push(`${pattern} (base build ${base}, this build ${head}):`);
    for (const cell of moved) {
      lines.push(
        `  ${cell.from} -> ${cell.to}${
          cell.holdsState ? ", holds state" : ""
        }` +
          `: ${cell.description} (${where(cell.level)})`,
      );
    }
    for (const cells of ambiguous) {
      lines.push(
        `  ambiguous, holds state: [${cells.before.join(", ")}] -> ` +
          `[${cells.after.join(", ")}]: ${cells.description} ` +
          `(${where(cells.level)})`,
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

/**
 * The patterns the checkout at `root` lists as unevaluable, which is none
 * where it holds no such list.
 */
async function unevaluableIn(root: string): Promise<ReadonlySet<string>> {
  const list = join(root, "tasks/pattern-compat-unevaluable.ts");
  try {
    await Deno.stat(list);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return new Set();
    throw error;
  }
  const { UNEVALUABLE_PATTERNS: listed } = await import(
    new URL(`file://${list}`).href
  );
  return listed;
}

async function git(...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

/**
 * Helper for `main()`, which dumps the patterns `files` names with the
 * compiler of the checkout at `root`, in `shards` processes at once.
 */
async function dumpTree(
  root: string,
  files: readonly string[],
  shards: number,
  outDir: string,
  label: string,
): Promise<DumpOutput> {
  const dumper = new URL("./cause-assignments-dump.ts", import.meta.url)
    .pathname;
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
        join(root, "deno.jsonc"),
        "-A",
        dumper,
        "--root",
        root,
        "--out",
        out,
        ...part,
      ],
      cwd: root,
      env: { LOG_LEVEL: "error" },
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
    errors: outputs.flatMap((output) => output.errors),
  };
}

async function main() {
  const problems = acceptedMoveProblems(ACCEPTED_MOVES);
  if (problems.length > 0) {
    console.error(
      "tasks/cause-assignments-accepted-moves.ts:\n" +
        problems.map((problem) => `  ${problem}`).join("\n"),
    );
    Deno.exit(1);
  }
  const baseRef = Deno.args[0] ?? "origin/main";
  let mergeBase: string;
  try {
    mergeBase = (await git("merge-base", baseRef, "HEAD")).trim();
  } catch {
    console.error(
      `Could not resolve a merge base against ${baseRef}. This check needs ` +
        "real history — CI must check out with fetch-depth: 0.",
    );
    Deno.exit(2);
  }
  const changed = (await git(
    "diff",
    "--name-only",
    mergeBase,
    "--",
    ...COMPILER_PATHS,
    ...GATE_PATHS,
  )).trim();
  if (changed === "") {
    console.log(
      "check-cause-assignments: nothing a pattern's numbering is built by " +
        `changed since ${mergeBase.slice(0, 10)}.`,
    );
    return;
  }

  const head = (await git("rev-parse", "--show-toplevel")).trim();
  const scratch = await Deno.makeTempDir({ prefix: "cause-assignments-" });
  const baseTree = join(scratch, "base");
  await git("worktree", "add", "--detach", baseTree, mergeBase);
  try {
    const files = await collectAllPatternFiles();
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
      dumpTree(baseTree, inBase, shards, scratch, "base"),
      dumpTree(head, files, shards, scratch, "head"),
    ]);
    const comparison = compareDumps(baseDump, headDump, ACCEPTED_MOVES, {
      base: await unevaluableIn(baseTree),
      head: UNEVALUABLE_PATTERNS,
    });
    console.log(
      `check-cause-assignments: compared ${comparison.compared} patterns ` +
        `built from the same source by ${mergeBase.slice(0, 10)} and this ` +
        `change, in ${Math.round((performance.now() - started) / 1000)}s.`,
    );
    for (const pattern of comparison.forgiven) {
      console.log(`  ${pattern}: moves forgiven by an accepted entry`);
    }
    for (const entry of comparison.unused) {
      console.log(
        `  the accepted entry for ${entry.pattern} (${entry.base} -> ` +
          `${entry.head}) forgives nothing in this run and can be removed`,
      );
    }
    if (comparison.compileErrors.length > 0) {
      console.error(describeCompileErrors(comparison));
      Deno.exitCode = 1;
    }
    if (comparison.failing.length > 0) {
      console.error(describeFailures(comparison));
      Deno.exitCode = 1;
    }
  } finally {
    await git("worktree", "remove", "--force", baseTree);
    await Deno.remove(scratch, { recursive: true });
  }
}

if (import.meta.main) {
  await main();
}
