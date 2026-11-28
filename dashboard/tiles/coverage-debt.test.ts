/**
 * coverage-debt: the median day's move over a run of daily measurements, and
 * the view it produces. The samples are supplied directly, so nothing here
 * reaches the record store or the filesystem; the tile's own collection is
 * covered by coverage-debt-history.test.ts.
 */

import { expect } from "@std/expect";

import { join } from "@std/path";
import { maxOf, minOf } from "@commonfabric/collections/math";
import { describe, it } from "@commonfabric/test-support/test";

import type { Ctx } from "../types.ts";
import { GitHubStatusError } from "../lib.ts";
import {
  type CoverageDebtSample,
  type CoverageDebtSource,
  CoverageDebtStore,
} from "../coverage-debt-history.ts";
import {
  type GitHubRun,
  type RunReading,
  RunLists,
  type RunRequest,
} from "../github-runs.ts";
import {
  type CoverageRun,
  fakeCoverageRuns,
  fakeCoverageStore,
} from "../test/coverage-store.ts";
import {
  compactDays,
  COVERAGE_MIN_DAYS,
  COVERAGE_STALE_DAYS,
  COVERAGE_TREND_DAYS,
  coverageDebtView,
  coverageRunsOf,
  makeCoverageDebt,
  medianDailyChange,
  trendLabel,
  trendWindow,
} from "./coverage-debt.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 2, 13, 30);

const context: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

const dayAt = (back: number) =>
  new Date(NOW - back * DAY_MS).toISOString().slice(0, 10);

/** One passing `main` run a day for seventy days, each measuring `lines`. */
const steadyRuns = (lines: number): CoverageRun[] =>
  Array.from({ length: 70 }, (_, back) => ({
    day: dayAt(back),
    runId: 1000 + back,
    lines,
  }));

/** A store holding `steadyRuns(lines)`, or failing every request. */
function stubStore(lines: number | Error): CoverageDebtSource {
  return lines instanceof Error
    ? fakeCoverageStore([], lines)
    : fakeCoverageStore(steadyRuns(lines));
}

/** Daily samples ending today, oldest first, one per day. */
function samplesOf(lines: number[]): CoverageDebtSample[] {
  return lines.map((uncoveredLines, index) => ({
    day: dayAt(lines.length - 1 - index),
    uncoveredLines,
    newestUncoveredLines: uncoveredLines,
  }));
}

/** A run of `days` measurements starting at `from` and moving by `perDay`. */
const drift = (from: number, perDay: number, days: number) =>
  samplesOf(Array.from({ length: days }, (_, day) => from + day * perDay));

/** A sample of `back` days ago whose runs averaged `lines`. */
const sampleAt = (back: number, lines: number): CoverageDebtSample => ({
  day: dayAt(back),
  uncoveredLines: lines,
  newestUncoveredLines: lines,
});

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
      const samples = [sampleAt(4, 100), sampleAt(2, 140), sampleAt(1, 160)];
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
      const sameDay = [sampleAt(2, 100), sampleAt(2, 900), sampleAt(1, 930)];
      expect(medianDailyChange(sameDay)).toBe(30);
    });
  });

  describe("compactDays()", () => {
    it("returns days, then weeks, then months, then years", () => {
      expect(compactDays(0.4)).toBe("<1d");
      expect(compactDays(5)).toBe("5d");
      expect(compactDays(13.4)).toBe("13d");
      expect(compactDays(14)).toBe("2w");
      expect(compactDays(52)).toBe("7w");
      expect(compactDays(56)).toBe("2mo");
      expect(compactDays(365)).toBe("12mo");
      expect(compactDays(36_000)).toBe("99y");
    });

    it("returns the larger unit when rounding reaches it", () => {
      expect(compactDays(13.6)).toBe("2w");
      expect(compactDays(729.9)).toBe("2y");
    });

    it("returns `100y+` for a century or more", () => {
      expect(compactDays(36_525)).toBe("100y+");
      expect(compactDays(1e12)).toBe("100y+");
    });
  });

  describe("trendLabel()", () => {
    it("returns a signed rate and the time the debt takes to double for a rise", () => {
      expect(trendLabel(11, 55)).toBe("+11 per day, doubles in 5d");
      expect(trendLabel(1234, 4_000_000)).toBe(
        "+1,234 per day, doubles in 9y",
      );
    });

    it("returns a signed rate and the time the debt takes to clear for a fall", () => {
      expect(trendLabel(-11, 3000)).toBe("-11 per day, zero in 9mo");
    });

    it("returns `no change` for a median day that moved nothing", () => {
      expect(trendLabel(0, 3000)).toBe("no change");
    });

    it("returns the rate alone when there is no debt", () => {
      expect(trendLabel(3, 0)).toBe("+3 per day");
      expect(trendLabel(-3, 0)).toBe("-3 per day");
    });
  });

  describe("coverageDebtView()", () => {
    it("returns the current uncovered-line count, with its unit, as the headline", () => {
      const view = coverageDebtView(drift(80000, -100, 30), NOW);
      expect(view.value).toBe("77,100 lines");
      expect(view.valueLabel).toBe("77,100 lines");
    });

    it("returns the newest run's count as the headline, not the day's mean", () => {
      const samples = drift(80000, -100, 30);
      samples[samples.length - 1] = {
        ...samples[samples.length - 1],
        newestUncoveredLines: 77000,
      };
      expect(coverageDebtView(samples, NOW).value).toBe("77,000 lines");
    });

    it("returns a green tile and a falling rate for debt coming down", () => {
      const view = coverageDebtView(drift(80000, -100, 30), NOW);
      expect(view.status).toBe("good");
      expect(view.sub).toBe("-100 per day, zero in 2y");
    });

    it("returns an amber tile for debt whose median pace doubles it within a year", () => {
      const view = coverageDebtView(drift(10000, 100, 30), NOW);
      expect(view.status).toBe("warn");
      expect(view.sub).toBe("+100 per day, doubles in 4mo");
    });

    it("returns a green tile for debt rising too slowly to double within a year", () => {
      // 36,500 lines a year on 72,900 lines of debt.
      const view = coverageDebtView(drift(70000, 100, 30), NOW);
      expect(view.status).toBe("good");
      expect(view.sub).toBe("+100 per day, doubles in 2y");
    });

    it("returns green and `no change` for a median under half a line a day", () => {
      // A third of a line a day would double 50 lines within a year, but
      // rounds to no move at all, and the color agrees with the label.
      const view = coverageDebtView(
        samplesOf(Array.from({ length: 30 }, (_, day) => 40 + day / 3)),
        NOW,
      );
      expect(view.status).toBe("good");
      expect(view.sub).toBe("no change");
    });

    it("returns `no change` when the median day moved nothing", () => {
      const view = coverageDebtView(samplesOf(Array(30).fill(80000)), NOW);
      expect(view.status).toBe("good");
      expect(view.sub).toBe("no change");
    });

    it("stays green when one day added debt among days that did not", () => {
      const steady = Array(29).fill(80000);
      steady[20] = 90000;
      const view = coverageDebtView(samplesOf(steady), NOW);
      expect(view.status).toBe("good");
    });

    it("counts only the days inside the window toward the median", () => {
      // Nineteen days of steep rises, then the window's days falling.
      const samples = samplesOf([
        ...Array.from({ length: 19 }, (_, day) => 10000 + day * 1000),
        ...Array.from(
          { length: COVERAGE_TREND_DAYS },
          (_, day) => 28000 - day * 100,
        ),
      ]);
      const view = coverageDebtView(samples, NOW);
      expect(view.status).toBe("good");
      expect(view.sub).toMatch(/^-100 per day/);
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
      expect(minOf(highlight)).toBeGreaterThan(0);
      expect(maxOf(highlight)).toBeLessThan(height);
      expect(maxOf(highlight) - minOf(highlight))
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
      const enough = drift(80000, -100, COVERAGE_MIN_DAYS);
      expect(coverageDebtView(enough, NOW).status).toBe("good");
    });

    it("returns red on the day the run of unmeasured days reaches the threshold", () => {
      // A newest sample `COVERAGE_STALE_DAYS` days back leaves that many days
      // — the ones after it, today included — with nothing measured, so the
      // threshold is reached rather than passed.
      const upTo = (back: number) =>
        drift(80000, -100, 40).filter((sample) =>
          Date.parse(`${sample.day}T00:00:00Z`) <= NOW - back * DAY_MS
        );
      expect(coverageDebtView(upTo(COVERAGE_STALE_DAYS), NOW).status)
        .toBe("bad");
      expect(coverageDebtView(upTo(COVERAGE_STALE_DAYS - 1), NOW).status)
        .toBe("good");
    });

    it("returns red when nothing has measured for days", () => {
      // Standing still on a stale number would read as a repository that had
      // stopped adding debt, when what has stopped is the measurement.
      const stale = drift(80000, -100, 30).filter((sample) =>
        Date.parse(`${sample.day}T00:00:00Z`) < NOW - 6 * DAY_MS
      );
      const view = coverageDebtView(stale, NOW);
      expect(view.status).toBe("bad");
      expect(view.value).toBe("—");
      expect(view.sub).toBe(`no measurement since ${dayAt(6)}`);
    });
  });

  describe("coverageRunsOf()", () => {
    it("returns the `main` runs of the CI workflow back to the time asked for", async () => {
      const at = (back: number) => new Date(NOW - back * DAY_MS).toISOString();
      const listed = (
        id: number,
        back: number,
        fields: Partial<GitHubRun> = {},
      ): GitHubRun => ({
        id,
        event: "push",
        head_branch: "main",
        head_sha: `sha${id}`,
        status: "completed",
        conclusion: "success",
        run_attempt: 1,
        display_title: `run ${id}`,
        created_at: at(back),
        run_started_at: at(back),
        updated_at: at(back),
        html_url: `https://github.com/commonfabric/labs/actions/runs/${id}`,
        head_commit: null,
        ...fields,
      });
      const workflowRuns = [
        listed(5, 0),
        listed(4, 0, { event: "pull_request", head_branch: "topic" }),
        listed(3, 1, { conclusion: "failure", run_attempt: 2 }),
        listed(2, 3),
        listed(1, 4),
      ];
      const paths: string[] = [];
      const request: RunRequest = <T>(path: string) => {
        paths.push(path);
        const byId = path.match(/\/actions\/runs\/(\d+)$/);
        if (byId !== null) {
          const run = workflowRuns.find((run) => run.id === Number(byId[1]));
          return run === undefined
            ? Promise.reject(new GitHubStatusError(`no run ${path}`, 404))
            : Promise.resolve(run as T);
        }
        const answer = path.includes("branch=")
          ? { workflow_runs: [] }
          : { workflow_runs: workflowRuns, total_count: workflowRuns.length };
        return Promise.resolve(answer as T);
      };
      const lookup = coverageRunsOf(new RunLists(), request);
      const runs = await lookup.list(NOW - 2 * DAY_MS);

      // Run 2 is the first created before the time asked for, which tells
      // the reading it has gone far enough.
      expect(runs.map((run) => run.id)).toEqual([5, 3, 2]);
      expect(runs[1]).toMatchObject({ conclusion: "failure", run_attempt: 2 });
      expect(paths[0]).toContain(
        "repos/commonfabric/labs/actions/workflows/deno.yml/runs",
      );
      expect((await lookup.get(1))?.id).toBe(1);
      expect(await lookup.get(9)).toBeUndefined();
      expect(paths.slice(-2)).toEqual([
        "repos/commonfabric/labs/actions/runs/1",
        "repos/commonfabric/labs/actions/runs/9",
      ]);
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
          runs: fakeCoverageRuns(steadyRuns(64000)),
        });
        const view = await tile.collect(context);
        expect(view.status).toBe("good");
        expect(view.value).toBe("64,000 lines");
        // Every day of the window measured the same number, so the median day
        // moved it by nothing at all.
        expect(view.sub).toBe("no change");
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("reads whether each run passed through the context's shared run lists", async () => {
      const directory = await Deno.makeTempDir({ prefix: "coverage-tile-" });
      const asked: string[] = [];
      class RefusingRunLists extends RunLists {
        override runs(
          _request: RunRequest,
          repo: string,
          workflow: string | number,
          reading: RunReading,
        ): Promise<GitHubRun[]> {
          asked.push(`${repo} ${workflow} ${reading.reader}`);
          return Promise.reject(new Error("set GH_TOKEN"));
        }
      }
      try {
        const tile = makeCoverageDebt({
          source: stubStore(64000),
          store: new CoverageDebtStore(join(directory, "history.json")),
          now: () => NOW,
        });
        const view = await tile.collect({
          ...context,
          runLists: new RefusingRunLists(),
        });
        expect(view.status).toBe("unknown");
        expect(view.sub).toBeDefined();
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
      expect(asked).toEqual(["commonfabric/labs deno.yml coverage debt"]);
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
          runs: fakeCoverageRuns([]),
        });
        const view = await tile.collect(context);
        expect(view.status).toBe("unknown");
        expect(view.value).toBe("—");
        expect(view.sub).toBeDefined();
      } finally {
        console.error = error;
        await Deno.remove(directory, { recursive: true });
      }
      expect(logged).toEqual(["coverage debt: could not collect:"]);
    });

    it("returns gray naming the failure, not red, when the runs it could not check leave the history stale", async () => {
      const directory = await Deno.makeTempDir({ prefix: "coverage-tile-" });
      const file = join(directory, "history.json");
      const days: Record<string, unknown> = {};
      for (let back = 7; back < 40; back++) {
        days[dayAt(back)] = {
          runs: [{ runId: 1000 + back, attempt: 1, uncoveredLines: 64000 }],
        };
      }
      await Deno.writeTextFile(file, JSON.stringify({ days }));
      const error = console.error;
      console.error = () => {};
      try {
        const tile = makeCoverageDebt({
          source: stubStore(64000),
          store: new CoverageDebtStore(file),
          now: () => NOW,
          runs: fakeCoverageRuns([], { failure: new Error("set GH_TOKEN") }),
        });
        const view = await tile.collect(context);
        expect(view.status).toBe("unknown");
        expect(view.value).toBe("—");
        expect(view.sub).not.toContain("no measurement since");
      } finally {
        console.error = error;
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("keeps its history in the dashboard cache directory by default", async () => {
      const directory = await Deno.makeTempDir({ prefix: "coverage-tile-" });
      const previous = Deno.env.get("DASHBOARD_CACHE_DIR");
      Deno.env.set("DASHBOARD_CACHE_DIR", directory);
      try {
        const tile = makeCoverageDebt({
          source: stubStore(64000),
          now: () => NOW,
          runs: fakeCoverageRuns(steadyRuns(64000)),
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
