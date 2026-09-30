/**
 * Fails a Benchmarks workflow run whose report the dashboard cannot read.
 *
 *     deno run --allow-read tasks/check-bench-report.ts \
 *       bench-results/results.json
 *
 * The checks are in `packages/dashboard/bench-report.ts`, beside the code the
 * tiles read the report with, so the two cannot drift apart. See
 * `.github/workflows/benchmarks.yml` for what a failure here does and does not
 * mean.
 */

import { benchmarkReportProblem } from "../packages/dashboard/bench-report.ts";

/** Checks the report at `path`, reports, and returns a process code. */
export function main(path: string | undefined): number {
  if (path === undefined) {
    console.error("usage: check-bench-report.ts <results.json>");
    return 2;
  }
  const problem = benchmarkReportProblem(Deno.readTextFileSync(path));
  if (problem !== undefined) {
    console.error(`${path}: ${problem}`);
    return 1;
  }
  console.log(`${path}: readable by every benchmark tile`);
  return 0;
}

if (import.meta.main) Deno.exit(main(Deno.args[0]));
