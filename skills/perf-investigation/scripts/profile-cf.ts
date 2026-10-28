#!/usr/bin/env -S deno run --quiet --allow-net --allow-ffi --allow-read --allow-write --allow-env --allow-run --allow-sys
/**
 * Run one `cf` invocation in this process and write what it measured.
 *
 * The launcher's own flag set plus `--allow-sys`, which the in-process V8
 * profiler needs — the reason this exists rather than `cf` itself: a
 * `.cpuprofile` of a CLI command has to come from inside the command's
 * process, and the launcher does not grant that.
 *
 *   CF_PROF_OUT=/tmp/run CF_PROF_CPU=1 CF_TIMING_MEASURES=1 \
 *     deno run --quiet --config deno.jsonc --allow-net --allow-ffi \
 *     --allow-read --allow-write --allow-env --allow-run --allow-sys \
 *     skills/perf-investigation/scripts/profile-cf.ts cell get <address> ...
 *
 * Writes, under the `CF_PROF_OUT` prefix: `.timing.json` and `.counts.json`
 * (the logger's statistics and counts for the whole run), `.flags.json`,
 * `.measures.json` when `CF_TIMING_MEASURES=1` (the input the other scripts
 * here read), and with `CF_PROF_CPU=1` a `.cpuprofile` that Chrome DevTools
 * and speedscope load beside a `.report.txt` ranked by self time.
 * `CF_PROF_INTERVAL_US` sets the sampling period (500 unless set). Every
 * other variable `cf` reads — `CF_API_URL`, `CF_IDENTITY`, `CF_SPACE`,
 * `CF_CLI_TRACE_TIMINGS`, `CF_MEMORY_FRAME_LOG` — applies as it would to
 * `cf`. Run from the repository root.
 */
// deno-lint-ignore no-external-import
import { Session } from "node:inspector";
import { main } from "../../../packages/cli/mod.ts";
import {
  getLoggerCountsBreakdown,
  getLoggerFlagsBreakdown,
  getTimingStatsBreakdown,
  TIMING_MEASURE_PREFIX,
} from "@commonfabric/utils/logger";
import { renderProfileReport } from "../../../packages/integration/cdp-profiler.ts";

const out = Deno.env.get("CF_PROF_OUT") ?? "cf-prof";
const cpu = Deno.env.get("CF_PROF_CPU") === "1";
const interval = Number(Deno.env.get("CF_PROF_INTERVAL_US") ?? "500");
Deno.env.set("CF_CLI_NAME", Deno.env.get("CF_CLI_NAME") ?? "cf");

let session: Session | undefined;
const post = (method: string, params?: unknown) =>
  new Promise<unknown>((resolve, reject) =>
    session!.post(
      method,
      params as never,
      (error: unknown, result: unknown) =>
        error ? reject(error) : resolve(result),
    )
  );
const started = performance.now();
if (cpu) {
  session = new Session();
  session.connect();
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval });
  await post("Profiler.start");
}

let finalized = false;
// Captured before anything can replace it below.
const realExit = Deno.exit;
async function finalize(code: number): Promise<void> {
  if (finalized) return;
  finalized = true;
  const wall = performance.now() - started;
  try {
    if (cpu) {
      const { profile } = await post("Profiler.stop") as {
        profile: Parameters<typeof renderProfileReport>[0];
      };
      await Deno.writeTextFile(`${out}.cpuprofile`, JSON.stringify(profile));
      await Deno.writeTextFile(
        `${out}.report.txt`,
        renderProfileReport(profile, out, { topFrames: 60, topFiles: 25 }),
      );
    }
    await Deno.writeTextFile(
      `${out}.timing.json`,
      JSON.stringify(getTimingStatsBreakdown()),
    );
    await Deno.writeTextFile(
      `${out}.counts.json`,
      JSON.stringify(getLoggerCountsBreakdown()),
    );
    await Deno.writeTextFile(
      `${out}.flags.json`,
      JSON.stringify(getLoggerFlagsBreakdown()),
    );
    const measures: { name: string; startTime: number; duration: number }[] =
      [];
    // Read and left on the timeline: the process exits below, so nothing
    // reads the entries again and nothing more is emitted against their budget.
    for (const entry of performance.getEntriesByType("measure")) {
      if (entry.name.startsWith(TIMING_MEASURE_PREFIX)) {
        measures.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
    }
    if (measures.length > 0) {
      await Deno.writeTextFile(
        `${out}.measures.json`,
        JSON.stringify(measures),
      );
    }
    console.error(
      `[profile-cf] wall ${wall.toFixed(0)}ms, exit ${code}, ` +
        `measures ${measures.length}, wrote ${out}.*`,
    );
  } catch (error) {
    console.error(
      `[profile-cf] writing the artifacts failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    // The command's own code, whatever became of the artifacts.
    realExit(code);
  }
}

// A command may leave through `Deno.exit` directly rather than through the
// exit `main` is handed. Both routes end in `finalize`, which performs the
// real exit once the artifacts are flushed. Until then the caller must not
// continue past its exit — `Deno.exit` never returns, and code after it
// assumes as much — so the replacement throws a sentinel that unwinds the
// caller and is swallowed wherever it surfaces.
class ExitRequested extends Error {
  constructor(readonly code: number) {
    super(`[profile-cf] exit ${code} requested; writing artifacts`);
    this.name = "ExitRequested";
  }
}
const isExitRequested = (reason: unknown): boolean =>
  reason instanceof ExitRequested;
globalThis.addEventListener("unhandledrejection", (event) => {
  if (isExitRequested(event.reason)) event.preventDefault();
});
globalThis.addEventListener("error", (event) => {
  if (isExitRequested(event.error)) event.preventDefault();
});
Deno.exit = ((code?: number): never => {
  const exitCode = code ?? Deno.exitCode ?? 0;
  void finalize(exitCode);
  throw new ExitRequested(exitCode);
}) as typeof Deno.exit;

try {
  await main(Deno.args, {
    exit: (code) => {
      void finalize(code);
    },
  });
} catch (error) {
  if (!isExitRequested(error)) throw error;
}
