#!/usr/bin/env -S deno run -A

/**
 * Compiles pattern files with the compiler of one checkout and writes each
 * one's cause assignment (`cause-assignments-lib.ts`) as JSON, for
 * `check-cause-assignments.ts`.
 *
 * The checkout is the one `--root` names, which need not be the one this file
 * is in: the gate runs this file against a checkout of the base revision, so
 * that one description of a cell, this file's, is applied to what each of the
 * two compilers built. It reaches the checkout's compiler only through modules
 * it loads from under `--root`, and runs under that checkout's configuration.
 *
 *   cause-assignments-dump.ts --root <dir> --out <file> <pattern path>...
 *
 * Each pattern path is relative to the root. A file that compiles to no
 * pattern is left out; one that fails to compile is written as an error.
 */

import { encodeHex } from "@std/encoding/hex";
import { sha256 } from "@commonfabric/content-hash";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { patternKey } from "./pattern-files.ts";
import {
  assignmentLevels,
  type PatternAssignment,
  type PatternAssignmentError,
} from "./cause-assignments-lib.ts";

/** What `main()` writes. */
export interface DumpOutput {
  assignments: PatternAssignment[];
  errors: PatternAssignmentError[];
}

/** A digest of the files `files` names, in an order of its own. */
function sourceDigest(
  files: readonly { name: string; contents: string }[],
): string {
  const text = [...files]
    .sort((a, b) => utf8Compare(a.name, b.name))
    .map((file) => `${file.name}\0${file.contents}`)
    .join("\0");
  return encodeHex(sha256(new TextEncoder().encode(text)));
}

/**
 * The runtime surface the dump reaches, which is the same in every checkout
 * the gate compiles with.
 */
export interface DumpRuntime {
  harness: {
    compileToRecordGraph(
      program: Program,
      options: { noCheck: boolean },
    ): Promise<{ id: string; graph: unknown; mainSpecifier: string }>;
    evaluateRecordGraph(
      id: string,
      graph: unknown,
      mainSpecifier: string,
      program: Program,
    ): { main?: Record<string, unknown> };
  };
  patternManager: {
    registerEvaluatedModules(evaluated: unknown): void;
    getArtifactEntryRef(
      artifact: object,
    ): { identity: string; symbol: string } | undefined;
  };
}

/** A program to compile, as `resolveLocalProgram()` returns one. */
export interface Program {
  main: string;
  files: { name: string; contents: string }[];
}

/**
 * The cause assignment of the pattern `program` exports by default, built by
 * `runtime`'s compiler and named `pattern`, or `undefined` where it exports
 * none.
 */
export async function buildAssignment(
  runtime: DumpRuntime,
  program: Program,
  pattern: string,
): Promise<PatternAssignment | undefined> {
  // `noCheck`: the compile exists only to reach the built pattern, and
  // `cfcheck` type-checks this tree in its own job.
  const { id, graph, mainSpecifier } = await runtime.harness
    .compileToRecordGraph(program, { noCheck: true });
  const evaluated = runtime.harness.evaluateRecordGraph(
    id,
    graph,
    mainSpecifier,
    program,
  );
  // Indexes each evaluated artifact's pattern identity, which names a
  // sub-pattern child.
  runtime.patternManager.registerEvaluatedModules(evaluated);
  const entry = evaluated.main?.default;
  if (
    (typeof entry !== "object" && typeof entry !== "function") ||
    entry === null
  ) {
    return undefined;
  }
  const levels = assignmentLevels(
    entry,
    (artifact) => runtime.patternManager.getArtifactEntryRef(artifact),
  );
  if (levels.length === 0) return undefined;
  return { pattern, source: sourceDigest(program.files), levels };
}

function parseArgs(args: readonly string[]): {
  root: string;
  out: string;
  files: string[];
} {
  let root: string | undefined;
  let out: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") root = args[++i];
    else if (args[i] === "--out") out = args[++i];
    else files.push(args[i]);
  }
  if (root === undefined || out === undefined) {
    throw new Error(
      "usage: cause-assignments-dump.ts --root <dir> --out <file> <path>...",
    );
  }
  return { root: root.replace(/\/$/, ""), out, files };
}

async function main() {
  const { root, out, files } = parseArgs(Deno.args);
  // Loaded from under `root`, so that the compiler is that checkout's.
  const { createRuntime } = await import(`${root}/packages/cli/lib/dev.ts`);
  const { resolveLocalProgram } = await import(
    `${root}/packages/runner/src/harness/local-program.deno.ts`
  );
  const runtime = await createRuntime();
  const output: DumpOutput = { assignments: [], errors: [] };
  try {
    for (const file of files) {
      const pattern = patternKey(file);
      try {
        const program = await resolveLocalProgram(
          (resolver: unknown) => runtime.harness.resolve(resolver),
          { main: `${root}/${file}`, root },
        );
        const assignment = await buildAssignment(runtime, program, pattern);
        if (assignment !== undefined) output.assignments.push(assignment);
      } catch (error) {
        output.errors.push({
          pattern,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await runtime.dispose();
  }
  await Deno.writeTextFile(out, JSON.stringify(output));
}

if (import.meta.main) {
  await main();
}
