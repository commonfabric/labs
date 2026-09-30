/**
 * Reads a `deno bench --json` report, and says what a report lacks for the
 * benchmark tiles to use it.
 *
 * Both halves belong together because both turn on one thing: the key a
 * measurement is filed under, which is its file, its group, and its name. That
 * key is the identity of a chart series across runs and across months, so the
 * text of a benchmark's group is part of the dashboard's contract with the
 * benchmark, not a label the benchmark owns. Renaming a group starts a new
 * series and abandons the old one; the key tile trends two keys and nothing
 * else, so renaming one costs it half of what it reads.
 *
 * Nothing here reads the environment or the network, so the Benchmarks
 * workflow can run the check over the report it is about to upload with no
 * grant beyond reading the file. `tasks/check-bench-report.ts` is the
 * command that does.
 */

import type { BenchmarkStats } from "./benchmark-history-cache.ts";

/** One benchmark in a `deno bench --json` report. */
export interface Bench {
  origin: string;
  group: string | null;
  name: string;
  results: { ok?: Partial<BenchmarkStats> }[];
}

/** The identity of a chart series: file, group, and benchmark name. */
export const benchKey = (b: Bench): string =>
  `${b.origin.replace(/^file:\/\/.*\/packages\//, "packages/")} > ${
    b.group ? b.group + "/" : ""
  }${b.name}`;

// The benchmarks that measure the machine rather than the repository. The
// Benchmarks workflow runs this file alongside the product benchmarks and its
// bodies call no repository code, so what moves them between two runs on one
// processor is the host. They are the tile's ruler, not one of the things it
// measures: they set each run's machine factor and take no other part, so they
// are absent from the index, from the benchmark count, and from the
// drill-down. Runs from before the calibration landed carry none, and read
// uncorrected.
export const CALIBRATION_FILE =
  "packages/dashboard/machine-calibration.bench.ts";

export const isCalibrationKey = (key: string): boolean =>
  key.startsWith(`${CALIBRATION_FILE} > `);

/**
 * The measurements the key tile and its drill-down trend. Written as whole
 * keys rather than as the names alone, so that moving one of these benchmarks
 * to another file is caught here as well: the file is a third of what makes a
 * chart series, and moving it abandons that series the same way a rename does.
 */
export const KEY_BENCHMARKS: readonly string[] = [
  "packages/patterns/integration/topic-board-navigation.bench.ts > " +
  "topic board/journey",
  "packages/patterns/integration/topic-board-scale.bench.ts > " +
  "topic board scale/100",
];

/**
 * Selects the product measurements shared by the key tile and its drilldown.
 */
export const isKeyBenchmark = (key: string): boolean =>
  KEY_BENCHMARKS.includes(key);

/** Where the report begins, wherever stdout put it. */
const REPORT_START = /\{\s*"version"\s*:/;

// deno bench --json -> processor identity plus benchmark timings. A benchmark's
// own console output can precede the JSON report on stdout, so parse from the
// report object.
export function parseBenchmarkReport(
  json: string,
): { cpu?: string; metrics: Map<string, BenchmarkStats> } {
  const at = json.match(REPORT_START);
  const data = JSON.parse(at ? json.slice(at.index) : json) as {
    cpu?: unknown;
    benches?: Bench[];
  };
  const cpu = typeof data.cpu === "string" && data.cpu.trim().length > 0
    ? data.cpu.trim()
    : undefined;
  const m = new Map<string, BenchmarkStats>();
  for (const b of data.benches ?? []) {
    const ok = b.results?.[0]?.ok;
    if (!ok || typeof ok.avg !== "number") continue;
    const n = (v: number | undefined, d: number) =>
      typeof v === "number" ? v : d;
    m.set(benchKey(b), {
      min: n(ok.min, ok.avg),
      avg: ok.avg,
      max: n(ok.max, ok.avg),
      p75: n(ok.p75, ok.avg),
      p99: n(ok.p99, ok.avg),
      p995: n(ok.p995, ok.avg),
      p999: n(ok.p999, ok.avg),
    });
  }
  return { cpu, metrics: m };
}

/**
 * What a report lacks for the tiles to read it, or undefined when it lacks
 * nothing. Each of these is something the collection passes over in silence: a
 * report that will not parse or names no processor is dropped whole, and
 * measurements a selection does not match leave that tile's series empty. A
 * chart that quietly thins says nothing about when it started, so the run that
 * produced such a report fails instead, and names what went missing.
 */
export function benchmarkReportProblem(json: string): string | undefined {
  const at = json.match(REPORT_START);
  if (at === null) return "stdout carries no deno bench --json report";
  const stray = json.slice(0, at.index).trim();
  if (stray.length) {
    const quoted = JSON.stringify(
      stray.length > 60 ? `${stray.slice(0, 60)}\u2026` : stray,
    );
    return `stdout carried ${quoted} ahead of the report; the workflow sends ` +
      "the whole of stdout to the artifact, so a line printed a moment later " +
      "lands inside the report and takes every benchmark in the run with it";
  }
  let report: { cpu?: string; metrics: Map<string, BenchmarkStats> };
  try {
    report = parseBenchmarkReport(json);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `the report does not parse: ${reason}`;
  }
  if (report.cpu === undefined) {
    return "the report names no processor, so every chart drops the run";
  }
  const keys = [...report.metrics.keys()];
  if (!keys.some((key) => !isCalibrationKey(key))) {
    return "the report carries no product benchmark measurements";
  }
  if (!keys.some(isCalibrationKey)) {
    return `the report carries no ${CALIBRATION_FILE} measurements, so a ` +
      "busy host cannot be told from a code change";
  }
  const missing = KEY_BENCHMARKS.filter((key) => !report.metrics.has(key));
  if (missing.length) {
    return `the report carries no ${
      missing.map((key) => JSON.stringify(key)).join(" or ")
    }, which is the whole of what the key benchmarks tile trends; a ` +
      "benchmark that moved takes its dashboard history with it";
  }
  return undefined;
}
