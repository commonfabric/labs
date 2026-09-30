/**
 * Every fixture here is a `deno bench --json` report built by hand, so the
 * shape under test is the one the artifact carries.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type Bench,
  benchKey,
  benchmarkReportProblem,
  CALIBRATION_FILE,
  isCalibrationKey,
  isKeyBenchmark,
  KEY_BENCHMARKS,
  parseBenchmarkReport,
} from "./bench-report.ts";

const NAVIGATION =
  "packages/patterns/integration/topic-board-navigation.bench.ts";
const SCALE = "packages/patterns/integration/topic-board-scale.bench.ts";

const STATS = {
  min: 1,
  avg: 2,
  max: 3,
  p75: 2,
  p99: 3,
  p995: 3,
  p999: 3,
};

const bench = (
  origin: string,
  group: string | null,
  name: string,
  ok: Partial<typeof STATS> = STATS,
): Bench => ({
  origin: `file:///home/runner/work/labs/labs/${origin}`,
  group,
  name,
  results: [{ ok }],
});

/** The entry `deno bench` writes for a benchmark whose body threw. */
const threw = (b: Bench): Bench => ({ ...b, results: [{}] });

const report = (benches: Bench[]): string =>
  JSON.stringify({ version: 1, cpu: "AMD EPYC 9V74", benches });

/** A report carrying everything the tiles read. */
const completeBenches = (): Bench[] => [
  bench(CALIBRATION_FILE, null, "integer arithmetic"),
  bench(NAVIGATION, "topic board", "journey"),
  bench(SCALE, "topic board scale", "100"),
];

describe("bench-report", () => {
  describe("benchKey()", () => {
    it("returns the file relative to `packages/`, then the group and the benchmark", () => {
      expect(benchKey(bench(NAVIGATION, "topic board", "journey")))
        .toBe(`${NAVIGATION} > topic board/journey`);
    });

    it("returns a key without a group for a benchmark that has none", () => {
      expect(benchKey(bench(CALIBRATION_FILE, null, "integer arithmetic")))
        .toBe(`${CALIBRATION_FILE} > integer arithmetic`);
    });
  });

  describe("isCalibrationKey()", () => {
    it("returns `true` for a measurement from the calibration file", () => {
      expect(isCalibrationKey(`${CALIBRATION_FILE} > integer arithmetic`))
        .toBe(true);
    });

    it("returns `false` for a product measurement", () => {
      expect(isCalibrationKey(`${NAVIGATION} > topic board/journey`))
        .toBe(false);
    });
  });

  describe("KEY_BENCHMARKS", () => {
    // Spelled out rather than read from the constant: these two strings are
    // the dashboard's side of a contract with two benchmark files, and a test
    // that reads the constant agrees with whatever it comes to say.

    it("is the topic board journey and the 100-topic board load", () => {
      expect([...KEY_BENCHMARKS]).toEqual([
        `${NAVIGATION} > topic board/journey`,
        `${SCALE} > topic board scale/100`,
      ]);
    });
  });

  describe("isKeyBenchmark()", () => {
    it("returns `true` for each key benchmark", () => {
      expect(isKeyBenchmark(`${NAVIGATION} > topic board/journey`)).toBe(true);
      expect(isKeyBenchmark(`${SCALE} > topic board scale/100`)).toBe(true);
    });

    it("returns `false` for a group that carries more than its stable name", () => {
      expect(
        isKeyBenchmark(`${NAVIGATION} > topic board (index demand)/journey`),
      ).toBe(false);
    });

    it("returns `false` for the same group and name in another file", () => {
      expect(isKeyBenchmark(`${SCALE} > topic board/journey`)).toBe(false);
    });

    it("returns `false` for another benchmark in the same file", () => {
      expect(isKeyBenchmark(`${NAVIGATION} > topic board/crossref`))
        .toBe(false);
    });
  });

  describe("parseBenchmarkReport()", () => {
    it("returns the processor the report names", () => {
      expect(parseBenchmarkReport(report(completeBenches())).cpu)
        .toBe("AMD EPYC 9V74");
    });

    it("returns each measurement under its key", () => {
      const { metrics } = parseBenchmarkReport(report(completeBenches()));
      expect([...metrics.keys()]).toEqual([
        `${CALIBRATION_FILE} > integer arithmetic`,
        `${NAVIGATION} > topic board/journey`,
        `${SCALE} > topic board scale/100`,
      ]);
    });

    it("returns the mean in place of a timing the report leaves out", () => {
      const benches = [bench(NAVIGATION, "topic board", "journey", { avg: 7 })];
      const { metrics } = parseBenchmarkReport(report(benches));
      expect(metrics.get(`${NAVIGATION} > topic board/journey`))
        .toEqual({ min: 7, avg: 7, max: 7, p75: 7, p99: 7, p995: 7, p999: 7 });
    });

    it("returns no measurement for a benchmark that threw", () => {
      const benches = [threw(bench(NAVIGATION, "topic board", "journey"))];
      expect(parseBenchmarkReport(report(benches)).metrics.size).toBe(0);
    });
  });

  describe("benchmarkReportProblem()", () => {
    it("returns `undefined` for a report carrying everything the tiles read", () => {
      expect(benchmarkReportProblem(report(completeBenches())))
        .toBe(undefined);
    });

    it("returns `undefined` for a report stdout carries nothing else beside", () => {
      expect(benchmarkReportProblem(`\n${report(completeBenches())}\n`))
        .toBe(undefined);
    });

    it("returns the absence for output carrying no report at all", () => {
      expect(benchmarkReportProblem("Task bench deno bench --json\n"))
        .toBe("stdout carries no deno bench --json report");
    });

    it("returns the parse failure for a report that was cut short", () => {
      const json = report(completeBenches());
      expect(benchmarkReportProblem(json.slice(0, json.length - 20)))
        .toMatch(/^the report does not parse: /);
    });

    it("returns the stray output a benchmark printed ahead of the report", () => {
      // The tiles read past a prefix, so this one report charts. The next line
      // that module prints lands inside the report instead, which is why the
      // run that printed it fails here rather than the run that follows.

      expect(benchmarkReportProblem(`seeding\n${report(completeBenches())}`))
        .toMatch(/stdout carried "seeding" ahead of the report/);
    });

    it("returns long stray output cut down", () => {
      const stray = "x".repeat(200);
      const problem = benchmarkReportProblem(
        `${stray}\n${report(completeBenches())}`,
      );
      expect(problem).toContain(`${"x".repeat(60)}…`);
      expect(problem).not.toContain("x".repeat(61));
    });

    it("returns the missing processor for a report that names none", () => {
      const json = JSON.stringify({ version: 1, benches: completeBenches() });
      expect(benchmarkReportProblem(json)).toMatch(/names no processor/);
    });

    it("returns the missing measurements for a report of calibration alone", () => {
      const benches = [bench(CALIBRATION_FILE, null, "integer arithmetic")];
      expect(benchmarkReportProblem(report(benches)))
        .toMatch(/no product benchmark measurements/);
    });

    it("returns the missing calibration for a report of product benchmarks alone", () => {
      const benches = completeBenches().filter((b) =>
        !b.origin.endsWith(CALIBRATION_FILE)
      );
      expect(benchmarkReportProblem(report(benches)))
        .toContain(`no ${CALIBRATION_FILE} measurements`);
    });

    it("returns the key benchmark a renamed group took out of the report", () => {
      const benches = completeBenches().map((b) =>
        b.group === "topic board" ? { ...b, group: "topic board (x)" } : b
      );
      expect(benchmarkReportProblem(report(benches)))
        .toContain(`no "${NAVIGATION} > topic board/journey"`);
    });

    it("returns the key benchmark a moved file took out of the report", () => {
      const benches = completeBenches().map((b) =>
        b.origin.endsWith(SCALE)
          ? {
            ...b,
            origin: b.origin.replace(SCALE, "packages/x/scale.bench.ts"),
          }
          : b
      );
      expect(benchmarkReportProblem(report(benches)))
        .toContain(`no "${SCALE} > topic board scale/100"`);
    });

    it("returns both key benchmarks when neither is in the report", () => {
      const benches = [
        bench(CALIBRATION_FILE, null, "integer arithmetic"),
        bench(NAVIGATION, "topic board", "crossref"),
      ];
      const problem = benchmarkReportProblem(report(benches));
      for (const key of KEY_BENCHMARKS) expect(problem).toContain(key);
    });

    it("returns the key benchmark that threw rather than measured", () => {
      // `deno bench` writes a complete report when one benchmark throws, and
      // the entry it writes carries no `ok`. The tiles skip it, so a key
      // benchmark that threw is a key benchmark that is not there.

      const benches = completeBenches().map((b) =>
        b.group === "topic board scale" ? threw(b) : b
      );
      expect(benchmarkReportProblem(report(benches)))
        .toContain(`no "${SCALE} > topic board scale/100"`);
    });
  });
});
