/**
 * Reports the repository's whole coverage debt and which way it is moving,
 * from what each day's `main` runs measured.
 *
 * The headline is the count of uncovered lines the newest qualifying run
 * measured. Under it is the median day's change over the recent window, which
 * is the part that says whether the tests are catching up with the code or
 * falling behind it, and how long that pace takes to double the debt or to
 * clear it. A median rather than the distance between the ends of the window:
 * the series has steps in it, because a change to what the metric counts moves
 * the whole level in a single day, and one such day cannot carry a median. The
 * chart spans the longer window and highlights the days used for the median.
 * Those days' values set the vertical scale.
 *
 * Amber means that pace doubles the debt within a year. Half the days in the
 * window have to have risen for the median to be a rise at all, so a day that
 * added debt says nothing on its own. Red means nothing has measured the debt
 * for days: the measurement itself has stopped, which is something to act on.
 *
 * Following the dashboard's values (README.md): it reports on the system. The
 * number is the repository's, never a package's owner's and never a person's,
 * and nothing here is aggregated per person.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type { Ctx, Status, Tile, TileView } from "../types.ts";
import {
  type CoverageDebtSample,
  type CoverageDebtSource,
  CoverageDebtStore,
  type CoverageRunLookup,
  dayStart,
  liveCoverageDebtSource,
  refreshCoverageDebt,
} from "../coverage-debt-history.ts";
import { CI_WORKFLOW, REPO } from "../config.ts";
import {
  type GitHubRun,
  runById,
  RunLists,
  type RunRequest,
} from "../github-runs.ts";
import {
  friendlyError,
  github,
  groupDigits,
  median,
  sparkline,
} from "../lib.ts";
import { TEST_RECORDS_REPO } from "../test-records-history.ts";
import { CHART_HIGHLIGHT, CHART_LINE } from "../theme.ts";

/** Days of history the tile charts. */
export const COVERAGE_WINDOW_DAYS = 56;

/** Days the median daily change is taken over. */
export const COVERAGE_TREND_DAYS = 21;

/** Days that must have measured in that window before it says a rate. */
export const COVERAGE_MIN_DAYS = 7;

/**
 * Days within which a rise that keeps its median pace doubles the debt, for
 * the tile to call that rise a problem.
 */
export const COVERAGE_DOUBLING_DAYS = 365;

/** Days without a measurement after which the history stops being trusted. */
export const COVERAGE_STALE_DAYS = 5;

/**
 * How often the tile looks for a landing. The figure it reports cannot exist
 * until the `main` run for a landed commit has finished and the relay has
 * stored that run's coverage measurements, which takes longer than this, so
 * five minutes tracks the number about as closely as the number can be known.
 * A refresh that finds nothing new costs a listing of the store for each of
 * today and yesterday, and a reading of the shared run lists, which the
 * webhook relay keeps current.
 */
export const COVERAGE_REFRESH_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

// Both windows below are counted in whole days from the start of today, so
// which days they hold does not turn on what time of day the tile collected.
const todayAt = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;

/** The tail of `samples` the median is taken over: the recent days. */
export function trendWindow(
  samples: readonly CoverageDebtSample[],
  now: number,
): CoverageDebtSample[] {
  const cutoff = todayAt(now) - (COVERAGE_TREND_DAYS - 1) * DAY_MS;
  return samples.filter((sample) => dayStart(sample.day) >= cutoff);
}

/**
 * What the debt does in a median day, in uncovered lines. Each pair of
 * measurements gives the rate over the days between them, so a day nothing
 * measured spreads its neighbors' difference rather than putting the whole of
 * it into one step.
 */
export function medianDailyChange(
  samples: readonly CoverageDebtSample[],
): number {
  const rates: number[] = [];
  for (let at = 1; at < samples.length; at++) {
    const days = (dayStart(samples[at].day) - dayStart(samples[at - 1].day)) /
      DAY_MS;
    if (days <= 0) continue;
    const moved = samples[at].uncoveredLines - samples[at - 1].uncoveredLines;
    rates.push(moved / days);
  }
  return rates.length === 0 ? 0 : median(rates);
}

/**
 * A number of days in the least room it can be read in: days, then weeks,
 * then months, then years, up to a hundred years.
 */
export function compactDays(days: number): string {
  const whole = Math.round(days);
  if (whole < 1) return "<1d";
  if (whole < 14) return `${whole}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks}w`;
  const months = Math.round(days / 30.4375);
  if (months < 24) return `${months}mo`;
  const years = Math.round(days / 365.25);
  return years < 100 ? `${years}y` : "100y+";
}

/**
 * The median day's move, `change` whole lines, signed so a reader takes the
 * direction from it, and how long `lines` of debt takes at that pace to
 * double, when it is rising, or to reach zero, when it is falling. The unit is
 * the headline's, which sits directly above.
 */
export function trendLabel(change: number, lines: number): string {
  if (change === 0) return "no change";
  const rate = `${change > 0 ? "+" : "-"}${
    groupDigits(Math.abs(change))
  } per day`;
  if (lines === 0) return rate;
  const outcome = change > 0 ? "doubles" : "zero";
  return `${rate}, ${outcome} in ${compactDays(lines / Math.abs(change))}`;
}

// Places each point at its date's share of the charted span, so a day nothing
// measured leaves a gap rather than closing one up.
function dayPositions(
  samples: readonly CoverageDebtSample[],
): number[] | undefined {
  const first = dayStart(samples[0].day);
  const span = dayStart(samples[samples.length - 1].day) - first;
  return span === 0
    ? undefined
    : samples.map((sample) => (dayStart(sample.day) - first) / span);
}

/** Builds the view the samples support. */
export function coverageDebtView(
  samples: readonly CoverageDebtSample[],
  now: number,
): TileView {
  const newest = samples[samples.length - 1];
  // At the boundary the day itself is one of the days nothing measured: a
  // newest sample of five days ago leaves the four days after it and today
  // without one, which is the five the threshold counts.
  const staleAfter = todayAt(now) - COVERAGE_STALE_DAYS * DAY_MS;
  if (newest !== undefined && dayStart(newest.day) <= staleAfter) {
    return {
      status: "bad",
      value: "—",
      sub: `no measurement since ${newest.day}`,
    };
  }
  const trend = trendWindow(samples, now);
  if (trend.length < COVERAGE_MIN_DAYS) {
    return {
      status: "unknown",
      value: "—",
      sub: samples.length === 0
        ? "no main run has measured coverage yet"
        : "not enough history for a direction yet",
    };
  }
  const lines = newest.newestUncoveredLines;
  // Whole lines, so that the color and the label judge the same number.
  const change = Math.round(medianDailyChange(trend));
  const status: Status = change * COVERAGE_DOUBLING_DAYS > lines
    ? "warn"
    : "good";
  // The unit is on the headline because the count means nothing without it:
  // uncovered lines, not files and not a percentage.
  const headline = `${groupDigits(lines)} lines`;
  return {
    status,
    value: headline,
    valueLabel: headline,
    sub: trendLabel(change, lines),
    extra: sparkline(
      samples.map((sample) => sample.uncoveredLines),
      CHART_LINE,
      { count: trend.length, color: CHART_HIGHLIGHT },
      true,
      dayPositions(samples),
    ),
    duration: dayStart(newest.day) - dayStart(samples[0].day) + DAY_MS,
  };
}

/**
 * Returns where to read whether the runs of the workflow that writes the
 * coverage measurements passed: its `main` runs through `lists`, the
 * dashboard's shared lists of workflow runs, and one run by its id, with
 * `request`, which defaults to the dashboard's own GitHub client.
 */
export function coverageRunsOf(
  lists: RunLists,
  request: RunRequest = (path, options) => github(path, undefined, options),
): CoverageRunLookup {
  return {
    list: (since) =>
      lists.runs(request, TEST_RECORDS_REPO, CI_WORKFLOW, {
        reader: "coverage debt",
        wants: (run) => run.head_branch === "main",
        recheck: [{ branch: "main" }],
        until: (run) => Date.parse(run.created_at) < since,
      }),
    get: (id) => runById<GitHubRun>(request, TEST_RECORDS_REPO, id),
  };
}

/**
 * Builds the tile against a history file, a clock, the record store, and the
 * runs it reads whether each attempt passed from, which default to those read
 * through the collection context's shared lists.
 */
export function makeCoverageDebt(
  options: {
    source?: CoverageDebtSource;
    store?: CoverageDebtStore;
    now?: () => number;
    runs?: CoverageRunLookup;
  } = {},
): Tile {
  const source = options.source ?? liveCoverageDebtSource();
  let store = options.store;
  let lists: RunLists | undefined;
  return {
    label: "labs coverage debt",
    repo: REPO,
    intervalMs: COVERAGE_REFRESH_MS,
    async collect(ctx: Ctx): Promise<TileView> {
      store ??= new CoverageDebtStore();
      const now = options.now?.() ?? Date.now();
      const history = await refreshCoverageDebt({
        days: COVERAGE_WINDOW_DAYS,
        now,
        source,
        runs: options.runs ??
          coverageRunsOf(ctx.runLists ?? (lists ??= new RunLists())),
        store,
      });
      const view = coverageDebtView(history.samples, now);
      // A history that stopped because the tile could not read it says
      // nothing about whether the measurement stopped.
      if (
        history.error !== undefined &&
        (history.samples.length === 0 || view.status === "bad")
      ) {
        const message = describeFailure(history.error);
        console.error("coverage debt: could not collect:", message);
        return {
          status: "unknown",
          value: "—",
          sub: friendlyError(message),
        };
      }
      return view;
    },
  };
}

export const coverageDebt = makeCoverageDebt();
