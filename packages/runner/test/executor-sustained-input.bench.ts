/**
 * How long the serving watermark takes to cover an input while input keeps
 * arriving (serving-loop.md §3's prefix coverage). Each iteration opens a
 * fresh served space (outside the timed interval), starts a stream that
 * commits one new input at every settle barrier, and stops the stream once
 * the serving loop has ended `STREAM_CYCLES` wave cycles. The timed interval
 * runs from the moment the stream starts, which commits its first input, to
 * the moment the space's watermark document covers that input's seq. A loop
 * that waits for input to pause before it covers anything reports roughly the
 * stream's whole length here; one that covers each input as its consequences
 * complete reports a cycle or two.
 *
 * Each iteration also writes one diagnostic line to stderr: quantiles of the
 * admission-to-coverage time and the cycles-to-coverage over every input the
 * stream committed, from the serving loop's own `settle.series`, and the
 * loop's exhaustion counters.
 */

import { readWatermarkSeq } from "../src/executor/watermark.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import { awaitAdmitted } from "./support/serving-waits.ts";
import { openSustainedInputFixture } from "./support/sustained-input.ts";

/** Wave cycles the stream runs for before it stops. */
const STREAM_CYCLES = 8;

/** Returns the `fraction` quantile of `values`, nearest rank. */
const quantile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[rank];
};

Deno.bench({
  name: "first input covered",
  group: "serving watermark under sustained input",
  n: 5,
  warmup: 1,
  async fn(b) {
    const fixture = await openSustainedInputFixture({ flushDeadlineMs: 100 });
    try {
      const { cycles, engine, host, server } = fixture;
      const stopAt = cycles.entries.length + STREAM_CYCLES;
      b.start();
      const stream = fixture.stream();
      const stopped = cycles.reached(stopAt).then(() => stream.stop());
      await awaitAdmitted(
        server,
        () =>
          stream.inputs.length > 0 &&
          readWatermarkSeq(engine) >= stream.inputs[0].seq,
      );
      b.end();
      await stopped;
      const last = stream.inputs[stream.inputs.length - 1].seq;
      await awaitAdmitted(server, () => readWatermarkSeq(engine) >= last);

      const stats = host.stats();
      const rows = stats.settle.series.filter((row) =>
        stream.inputs.some((input) => input.seq === row.seq)
      );
      const ms = rows.map((row) => row.ms);
      const rowCycles = rows.map((row) => row.cycles);
      benchDiagnostic(
        "[executor-sustained-input] " + JSON.stringify({
          inputs: stream.inputs.length,
          coverageMsP50: Math.round(quantile(ms, 0.5)),
          coverageMsP90: Math.round(quantile(ms, 0.9)),
          coverageMsMax: Math.round(Math.max(...ms)),
          cyclesP50: quantile(rowCycles, 0.5),
          cyclesMax: Math.max(...rowCycles),
          wavesBudgetExhausted: stats.wavesBudgetExhausted,
          exhaustedAdvances: stats.exhaustedAdvances,
          waves: stats.waves,
        }),
      );
    } finally {
      await fixture.close();
    }
  },
});
