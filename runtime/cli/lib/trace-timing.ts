/**
 * Phase timing for the CLI's own code paths, written to stderr when
 * `CF_CLI_TRACE_TIMINGS=1` (docs/development/CONFIGURATION.md). Every phase
 * line has one shape, `[cf-phase] <ms>ms :: <label>`, so a trace from any
 * command greps the same way. Labels are `<operation>.<step>`, and phases
 * can nest: when an operation wraps a call to another traced operation, its
 * phase encloses theirs — on `cf cell get`, `getCellValue.selection` encloses
 * the `deriveSelectedValue.*` lines — so the lines of a trace do not sum;
 * total a run from its outermost phases. Only phases with a common parent are
 * siblings that add up, and an operation reached without a wrapper (a
 * selection on `cf piece call` or `cf wish`) reports its own phases with no
 * encloser at all.
 * The piece package keeps its own `[piece-phase]` lines behind the same
 * variable; together they attribute a command's latency across the
 * CLI/controller boundary.
 */

/** Where a phase reports, and whether it does. Injected by tests; commands
 * use {@link cliPhaseTrace}. */
export interface PhaseTrace {
  readonly enabled: boolean;
  readonly log: (line: string) => void;
}

/** The process-wide trace: read once, since the flag is a property of the
 * process rather than of any one call. */
export const cliPhaseTrace: PhaseTrace = {
  enabled: Deno.env.get("CF_CLI_TRACE_TIMINGS") === "1",
  log: (line) => console.error(line),
};

/**
 * Run `run` as one named phase. With tracing off this is `run` itself; with
 * it on, the elapsed time is reported whether the phase returned or threw, so
 * a failing command's trace still says where its time went.
 */
export async function timeCliPhase<T>(
  label: string,
  run: () => T | Promise<T>,
  trace: PhaseTrace = cliPhaseTrace,
): Promise<T> {
  if (!trace.enabled) return await run();
  const start = performance.now();
  try {
    return await run();
  } finally {
    reportCliPhase(label, performance.now() - start, trace);
  }
}

/**
 * Report a phase timed elsewhere — a step the serving side measured and
 * returned with its receipt — in the same shape as one timed here.
 */
export function reportCliPhase(
  label: string,
  elapsedMs: number,
  trace: PhaseTrace = cliPhaseTrace,
): void {
  if (!trace.enabled) return;
  trace.log(`[cf-phase] ${Math.round(elapsedMs)}ms :: ${label}`);
}
