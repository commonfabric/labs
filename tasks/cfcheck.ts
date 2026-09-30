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

import type { RuntimeProgram } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { FragmentWriter } from "@commonfabric/test-support/records";
import { createRuntime } from "../packages/cli/lib/dev.ts";
import { formatError, selectionFor, USAGE } from "./cfcheck-lib.ts";
import { collectAllPatternFiles } from "./pattern-files.ts";

let filesToCheck: string[];
try {
  filesToCheck = selectionFor(await collectAllPatternFiles(), Deno.args);
} catch (error) {
  console.error(formatError(error));
  console.error(USAGE);
  Deno.exit(2);
}
console.log(`Common Fabric checking ${filesToCheck.length} pattern files.`);

const failures: Array<{ file: string; error: string }> = [];
const cwd = Deno.cwd();

// Resolve every pattern's authored module graph (the pattern + its local
// imports). A resolve failure — e.g. a malformed import — is a per-file
// failure, reported like any other.
const runtime = await createRuntime();
const resolved: Array<{ file: string; program: RuntimeProgram }> = [];
for (const file of filesToCheck) {
  try {
    resolved.push({
      file,
      program: await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: `${cwd}/${file}`, root: cwd },
      ),
    });
  } catch (error) {
    failures.push({ file, error: formatError(error) });
  }
}

// Type-check + transform + SES-verify ALL patterns in ONE TypeScript program,
// so the lib/API parse and bind is paid once for the whole run rather than
// once per pattern. Diagnostics come back attributed per file, and so does
// the time each file took.
const result = await runtime.harness.typeCheckBatch(
  resolved.map((entry) => entry.program),
);
for (const diagnostic of result.diagnostics) {
  // Strip the engine's internal `/fid1:<hash>` path prefix back to a repo path.
  const file = (diagnostic.file ?? "")
    .replace(/^\/fid1:[^/]+\//, "")
    .replace(`${cwd}/`, "") || "(batch)";
  failures.push({ file, error: diagnostic.message });
}

// One typecheck-kind record per file checked, named "cfcheck <file>",
// carrying what the batch spent on that pattern's own files. A file the
// resolve step rejected never reached the batch and carries no time. A
// diagnostic attributed to "(batch)" fails the run without belonging to a
// file record.
const recordsFragment = FragmentWriter.openForRun();
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

if (failures.length > 0) {
  failures.sort((a, b) => a.file.localeCompare(b.file));
  console.error("Common Fabric pattern checks failed:");
  for (const failure of failures) {
    console.error(`\n${failure.file}`);
    console.error(failure.error);
  }
  Deno.exit(1);
}
