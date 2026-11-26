/**
 * The pattern type check: every authored pattern compiled, type-checked,
 * transformed and SES-verified in the JSX and runtime-type environment
 * patterns actually run under.
 *
 *   deno task cfcheck                        # the whole corpus
 *   deno task cfcheck --only home            # restrict to matching paths
 *
 * `--only` takes one pattern per flag and may be repeated, and a run given
 * none checks everything.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { Runtime, RuntimeProgram } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  type Environment,
  FragmentWriter,
} from "@commonfabric/test-support/records";
import { createRuntime } from "../runtime/cli/lib/dev.ts";
import { selectionFor, USAGE } from "./cfcheck-lib.ts";
import { collectAllPatternFiles, REPO_ROOT } from "./pattern-files.ts";
import { type CommandOutput, emit } from "./command-output.ts";

/** What a run reads from the machine it runs on. */
export interface CfcheckContext {
  /** Reads every pattern file of the corpus, relative to `root`. */
  readonly corpus: () => Promise<readonly string[]>;

  /**
   * The directory the pattern paths are relative to, which also bounds the
   * local imports a pattern may resolve.
   */
  readonly root: string;

  /** Builds the runtime whose engine resolves and checks the patterns. */
  readonly runtime: () => Promise<Runtime>;

  /** The environment, which says whether the run is recorded. */
  readonly env: Environment;

  /** Prints a line while the run goes on. */
  readonly say: (line: string) => void;
}

/** The context of a run over this repository's own corpus. */
export function checkoutContext(): CfcheckContext {
  return {
    corpus: () => collectAllPatternFiles(REPO_ROOT),
    root: REPO_ROOT,
    runtime: createRuntime,
    env: Deno.env.get,
    say: console.log,
  };
}

/**
 * The pattern a batch diagnostic belongs to, as a path relative to `root`:
 * the engine's name for the file without its internal `/fid1:<hash>`
 * prefix, or "(batch)" for a diagnostic that names no file.
 */
export function diagnosticFile(name: string | undefined, root: string): string {
  return (name ?? "")
    .replace(/^\/fid1:[^/]+\//, "")
    .replace(`${root}/`, "") || "(batch)";
}

/**
 * Checks the patterns a command line selects from the corpus, and returns
 * what the run says and the code it exits with: 2 for a command line it
 * cannot read or a corpus it cannot read, 1 when any pattern fails, and 0
 * otherwise.
 */
export async function cfcheck(
  argv: readonly string[],
  context: CfcheckContext,
): Promise<CommandOutput> {
  const { root } = context;
  let filesToCheck: string[];
  try {
    filesToCheck = selectionFor(await context.corpus(), argv);
  } catch (error) {
    return { err: `${describeFailure(error)}\n${USAGE}`, code: 2 };
  }
  context.say(`Common Fabric checking ${filesToCheck.length} pattern files.`);

  const failures: Array<{ file: string; error: string }> = [];
  const runtime = await context.runtime();
  try {
    // Resolve every pattern's authored module graph (the pattern + its local
    // imports). A resolve failure — e.g. a malformed import — is a per-file
    // failure, reported like any other.
    const resolved: Array<{ file: string; program: RuntimeProgram }> = [];
    for (const file of filesToCheck) {
      try {
        resolved.push({
          file,
          program: await resolveLocalProgram(
            (resolver) => runtime.harness.resolve(resolver),
            { main: `${root}/${file}`, root },
          ),
        });
      } catch (error) {
        failures.push({ file, error: describeFailure(error) });
      }
    }

    // Type-check + transform + SES-verify ALL patterns in ONE TypeScript
    // program, so the lib/API parse and bind is paid once for the whole run
    // rather than once per pattern. Diagnostics come back attributed per
    // file, and so does the time each file took.
    const result = await runtime.harness.typeCheckBatch(
      resolved.map((entry) => entry.program),
    );
    for (const diagnostic of result.diagnostics) {
      failures.push({
        file: diagnosticFile(diagnostic.file, root),
        error: diagnostic.message,
      });
    }

    // One typecheck-kind record per file checked, named "cfcheck <file>",
    // carrying what the batch spent on that pattern's own files. A file the
    // resolve step rejected never reached the batch and carries no time. A
    // diagnostic attributed to "(batch)" fails the run without belonging to
    // a file record.
    const recordsFragment = FragmentWriter.openForRun(context.env);
    if (recordsFragment !== undefined) {
      const failedFiles = new Set(failures.map((failure) => failure.file));
      const durations = new Map(
        resolved.map(({ file, program }) =>
          [file, result.durations.get(program.main) ?? 0] as const
        ),
      );
      for (const file of filesToCheck) {
        recordsFragment.append({
          line: "record",
          test: { k: "typecheck", s: "repo", n: `cfcheck ${file}` },
          outcome: failedFiles.has(file) ? "fail" : "pass",
          durationMs: Math.round(durations.get(file) ?? 0),
        });
      }
      recordsFragment.close();
    }
  } finally {
    await runtime.dispose();
  }

  if (failures.length === 0) return { code: 0 };
  failures.sort((a, b) => a.file.localeCompare(b.file));
  return {
    err: [
      "Common Fabric pattern checks failed:",
      ...failures.map((failure) => `\n${failure.file}\n${failure.error}`),
    ].join("\n"),
    code: 1,
  };
}

if (import.meta.main) emit(await cfcheck(Deno.args, checkoutContext()));
