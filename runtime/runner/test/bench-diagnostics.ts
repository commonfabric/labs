/**
 * Writes a benchmark diagnostic line to stderr.
 *
 * `deno bench --json` puts its report on stdout and captures whatever a
 * benchmark body writes through `console`, on either stream. A body diagnostic
 * written with `console.error` therefore reaches nothing: not the report, not
 * stderr, not the workflow log. A write straight to `Deno.stderr` passes
 * through, and the Benchmarks workflow tees stderr into `diagnostics.log` in
 * the results artifact.
 *
 * See docs/development/BENCHMARKS.md.
 */

const encoder = new TextEncoder();

/** Writes `line` and a newline to stderr, whole. */
export function benchDiagnostic(line: string): void {
  const bytes = encoder.encode(`${line}\n`);
  // `writeSync` reports how much of the buffer it took, which on a pipe can be
  // less than all of it. Resume from there until the line is out.
  let written = 0;
  while (written < bytes.length) {
    written += Deno.stderr.writeSync(bytes.subarray(written));
  }
}
