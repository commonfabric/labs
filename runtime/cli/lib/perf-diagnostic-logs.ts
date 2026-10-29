/**
 * The warn-level logger keys that are PERF DIAGNOSTICS.
 *
 * A perf diagnostic fires on wall time — how fast the machine is and how
 * loaded it happens to be — rather than on anything the program did. Failing a
 * test on one would make that test's outcome a function of load, so every
 * place that holds a run's warnings to account skips them: the pattern test
 * runner's logger count deltas in `console-capture.ts`, and the stderr budget
 * the CLI tests assert in `test/utils.ts`. They stay visible in the console
 * either way, which is what they are for.
 *
 * Keep the list to timing-triggered diagnostics only. A warning about behavior
 * must keep failing tests.
 */

const PERF_DIAGNOSTIC_WARN_KEYS: ReadonlyArray<
  { logger: string; keyPrefix: string }
> = [
  // cell.ts: logger.warn(`get >NNNms`, ...) — slow Cell.get, 10ms buckets.
  { logger: "cell", keyPrefix: "get >" },
  // traverse.ts: logger.warn("slow-traverse", ...) — slow traversal report.
  { logger: "traverse", keyPrefix: "slow-traverse" },
];

/**
 * True when `key`, logged by `loggerName`, names a perf diagnostic. A key that
 * carries a measurement, as the slow-`Cell.get` report's bucket does, matches
 * on its prefix.
 */
export function isPerfDiagnosticWarnKey(
  loggerName: string,
  key: string,
): boolean {
  return PERF_DIAGNOSTIC_WARN_KEYS.some((entry) =>
    entry.logger === loggerName && key.startsWith(entry.keyPrefix)
  );
}
