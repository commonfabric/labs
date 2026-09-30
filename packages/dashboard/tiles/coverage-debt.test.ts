/**
 * coverage-debt: the median day's move over a run of daily measurements, and
 * the view it produces. The samples are supplied directly, so nothing here
 * reaches the record store or the filesystem; the tile's own collection is
 * covered by coverage-debt-history.test.ts.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { join } from "@std/path";

import type { Ctx } from "../types.ts";
import {
  type CoverageDebtSample,
  type CoverageDebtSource,
  CoverageDebtStore,
} from "../coverage-debt-history.ts";
import { fakeCoverageStore } from "../test/coverage-store.ts";
import {
  COVERAGE_MIN_DAYS,
  COVERAGE_STALE_DAYS,
  COVERAGE_TREND_DAYS,
  coverageDebtView,
  dailyChangeLabel,
  makeCoverageDebt,
  medianDailyChange,
  trendWindow,
} from "./coverage-debt.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 2, 13, 30);

const context: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

/**
 * A store holding one `main` run a day, each measuring `lines`, or failing
 * every request.
 */
function stubStore(lines: number | Error): CoverageDebtSource {
  return lines instanceof Error
    ? fakeCoverageStore([], lines)
    : fakeCoverageStore(
      Array.from({ length: 70 }, (_, back) => ({
        day: new Date(NOW - back * DAY_MS).toISOString().slice(0, 10),
        runId: 1000 + back,
        lines,
      })),
    );
}

const dayAt = (back: number) =>
  new Date(NOW - back * DAY_MS).toISOString().slice(0, 10);

/** Daily samples ending today, oldest first, one per day. */
function samplesOf(lines: number[]): CoverageDebtSample[] {
  return lines.map((uncoveredLines, index) => ({
    day: dayAt(lines.length - 1 - index),
    uncoveredLines,
    runId: 1000 + index,
  }));
}

/** A run of `days` measurements starting at `from` and moving by `perDay`. */
const drift = (from: number, perDay: number, days: number) =>
  samplesOf(Array.from({ length: days }, (_, day) => from + day * perDay));

describe("coverage-debt", () => {
  describe("trendWindow()", () => {
    it("returns the samples inside the trend window", () => {
      const samples = samplesOf(Array(COVERAGE_TREND_DAYS + 10).fill(100));
      expect(trendWindow(samples, NOW).length).toBe(COVERAGE_TREND_DAYS);
    });

    it("returns every sample when the history is shorter than the window", () => {
      const samples = samplesOf([1, 2, 3]);
      expect(trendWindow(samples, NOW)).toEqual(samples);
    });
  });

  describe("medianDailyChange()", () => {
    it("returns the median of the day-to-day changes", () => {
      expect(medianDailyChange(samplesOf([100, 110, 130, 135]))).toBe(10);
    });

    it("returns a rate one big step does not stand for", () => {
      // The shape a change in what the metric counts leaves behind: one
      // enormous fall among days that each drifted up a little.
      expect(medianDailyChange(samplesOf([1000, 1010, 300, 320, 340, 360])))
        .toBe(20);
    });

    it("spreads a change across the days between two measurements", () => {
      // The two-day gap moved 40 lines, which is 20 a day, matching the step
      // beside it rather than reading as twice the move.
      const samples: CoverageDebtSample[] = [
        { day: dayAt(4), uncoveredLines: 100, runId: 1 },
        { day: dayAt(2), uncoveredLines: 140, runId: 2 },
        { day: dayAt(1), uncoveredLines: 160, runId: 3 },
      ];
      expect(medianDailyChange(samples)).toBe(20);
    });

    it("returns zero for fewer than two measurements", () => {
      expect(medianDailyChange([])).toBe(0);
      expect(medianDailyChange(samplesOf([100]))).toBe(0);
    });

    it("passes over a pair of measurements no days apart", () => {
      // One sample a day is what the collection produces, so a second sample
      // of the same day is a store somebody edited: there is no rate between
      // two measurements of one moment, and dividing would be a division by
      // zero rather than a small number.
      const sameDay: CoverageDebtSample[] = [
        { day: dayAt(2), uncoveredLines: 100, runId: 1 },
        { day: dayAt(2), uncoveredLines: 900, runId: 2 },
        { day: dayAt(1), uncoveredLines: 930, runId: 3 },
      ];
      expect(medianDailyChange(sameDay)).toBe(30);
    });
  });

  describe("dailyChangeLabel()", () => {
    it("returns a signed rate for a fall", () => {
      expect(dailyChangeLabel(-1234, 20)).toBe("-1,234 per day");
    });

    it("returns a signed rate for a rise", () => {
      expect(dailyChangeLabel(45, 20)).toBe("+45 per day");
    });

    it("returns `flat` for a move inside the band, in either direction", () => {
      expect(dailyChangeLabel(20, 20)).toBe("flat");
      expect(dailyChangeLabel(-19, 20)).toBe("flat");
      expect(dailyChangeLabel(0, 20)).toBe("flat");
    });
  });

  describe("coverageDebtView()", () => {
    it("returns the current uncovered-line count, with its unit, as the headline", () => {
      const view = coverageDebtView(drift(80000, -100, 30), NOW);
      expect(view.value).toBe("77,100 lines");
      expect(view.valueLabel).toBe("77,100 lines");
    });

    it("returns a green tile and a falling rate for debt coming down", () => {
      const view = coverageDebtView(drift(80000, -100, 30), NOW);
      expect(view.status).toBe("good");
      expect(view.sub).toBe("-100 per day (median) · last 21 days");
    });

    it("returns an amber tile and a rising rate for debt going up", () => {
      const view = coverageDebtView(drift(70000, 100, 30), NOW);
      expect(view.status).toBe("warn");
      expect(view.sub).toBe("+100 per day (median) · last 21 days");
    });

    it("stays green and flat for a move the measurement cannot resolve", () => {
      const view = coverageDebtView(drift(80000, 5, 30), NOW);
      expect(view.status).toBe("good");
      expect(view.sub).toBe("flat (median) · last 21 days");
    });

    it("stays green when one day added debt among days that did not", () => {
      const steady = Array(29).fill(80000);
      steady[20] = 90000;
      const view = coverageDebtView(samplesOf(steady), NOW);
      expect(view.status).toBe("good");
    });

    it("counts only the days inside the window toward the median", () => {
      const view = coverageDebtView(drift(80000, -100, 40), NOW);
      expect(view.sub).toContain(`· last ${COVERAGE_TREND_DAYS} days`);
    });

    it("returns a chart whose highlight covers the days the median rests on", () => {
      const view = coverageDebtView(drift(80000, -100, 40), NOW);
      // Two polylines: the whole window, then the highlighted recent days.
      expect([...(view.extra ?? "").matchAll(/<polyline/g)].length).toBe(2);
      expect(view.extra).toContain("var(--chart-highlight)");
      expect(view.duration).toBe(40 * DAY_MS);
    });

    it("expands recent debt changes while older extremes extend outside the chart", () => {
      const recent = Array.from(
        { length: COVERAGE_TREND_DAYS },
        (_, day) => 80000 - day * 100,
      );
      const view = coverageDebtView(samplesOf([0, 200000, ...recent]), NOW);
      const chart = view.extra ?? "";
      const [history, highlight] = [
        ...chart.matchAll(/<polyline points="([^"]+)"/g),
      ].map((match) =>
        match[1].split(" ").map((point) => Number(point.split(",")[1]))
      );
      const height = Number(chart.match(/viewBox="0 0 [\d.]+ ([\d.]+)"/)?.[1]);

      expect(history).toHaveLength(recent.length + 2);
      expect(highlight).toHaveLength(recent.length);
      expect(history[0]).toBeGreaterThan(height);
      expect(history[1]).toBeLessThan(0);
      expect(Math.min(...highlight)).toBeGreaterThan(0);
      expect(Math.max(...highlight)).toBeLessThan(height);
      expect(Math.max(...highlight) - Math.min(...highlight))
        .toBeGreaterThan(height / 2);
    });

    it("returns no pop-out link", () => {
      const view = coverageDebtView(drift(80000, -100, 30), NOW);
      expect(view.href).toBeUndefined();
      expect(view.hint).toBeUndefined();
    });

    it("returns gray with no history at all", () => {
      const view = coverageDebtView([], NOW);
      expect(view.status).toBe("unknown");
      expect(view.value).toBe("—");
      expect(view.sub).toContain("no main run");
    });

    it("returns gray with too few days to state a rate", () => {
      const short = drift(80000, -100, COVERAGE_MIN_DAYS - 1);
      const view = coverageDebtView(short, NOW);
      expect(view.status).toBe("unknown");
      expect(view.sub).toContain("not enough history");
    });

    it("returns gray on the day the run of unmeasured days reaches the threshold", () => {
      // A newest sample `COVERAGE_STALE_DAYS` days back leaves that many days
      // — the ones after it, today included — with nothing measured, so the
      // threshold is reached rather than passed.
      const upTo = (back: number) =>
        drift(80000, -100, 40).filter((sample) =>
          Date.parse(`${sample.day}T00:00:00Z`) <= NOW - back * DAY_MS
        );
      expect(coverageDebtView(upTo(COVERAGE_STALE_DAYS), NOW).status)
        .toBe("unknown");
      expect(coverageDebtView(upTo(COVERAGE_STALE_DAYS - 1), NOW).status)
        .toBe("good");
    });

    it("returns gray when nothing has measured for days", () => {
      // Standing still on a stale number would read as a repository that had
      // stopped adding debt, which is not what a silent CI says.
      const stale = drift(80000, -100, 30).filter((sample) =>
        Date.parse(`${sample.day}T00:00:00Z`) < NOW - 6 * DAY_MS
      );
      const view = coverageDebtView(stale, NOW);
      expect(view.status).toBe("unknown");
      expect(view.sub).toContain("no measurement since");
    });
  });

  describe("collect()", () => {
    it("returns the view its window of days supports", async () => {
      const directory = await Deno.makeTempDir({ prefix: "coverage-tile-" });
      try {
        const tile = makeCoverageDebt({
          source: stubStore(64000),
          store: new CoverageDebtStore(join(directory, "history.json")),
          now: () => NOW,
        });
        const view = await tile.collect(context);
        expect(view.status).toBe("good");
        expect(view.value).toBe("64,000 lines");
        // Every day of the window measured the same number, so the median day
        // moved it by nothing at all.
        expect(view.sub).toBe("flat (median) · last 21 days");
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("returns gray naming the failure when no day could be read", async () => {
      const directory = await Deno.makeTempDir({ prefix: "coverage-tile-" });
      const logged: unknown[] = [];
      const error = console.error;
      console.error = (...parts: unknown[]) => void logged.push(parts[0]);
      try {
        const tile = makeCoverageDebt({
          source: stubStore(new Error("HTTP 500")),
          store: new CoverageDebtStore(join(directory, "history.json")),
          now: () => NOW,
        });
        const view = await tile.collect(context);
        expect(view.status).toBe("unknown");
        expect(view.value).toBe("—");
        expect(view.sub).toBeDefined();
      } finally {
        console.error = error;
        await Deno.remove(directory, { recursive: true });
      }
      expect(logged).toEqual(["coverage debt: could not read the store:"]);
    });

    it("keeps its history in the dashboard cache directory by default", async () => {
      const directory = await Deno.makeTempDir({ prefix: "coverage-tile-" });
      const previous = Deno.env.get("DASHBOARD_CACHE_DIR");
      Deno.env.set("DASHBOARD_CACHE_DIR", directory);
      try {
        const tile = makeCoverageDebt({
          source: stubStore(64000),
          now: () => NOW,
        });
        expect((await tile.collect(context)).status).toBe("good");
        expect([...Deno.readDirSync(directory)].map((entry) => entry.name))
          .toEqual(["fabric-wall-coverage-debt.json"]);
      } finally {
        if (previous === undefined) Deno.env.delete("DASHBOARD_CACHE_DIR");
        else Deno.env.set("DASHBOARD_CACHE_DIR", previous);
        await Deno.remove(directory, { recursive: true });
      }
    });
  });
});
