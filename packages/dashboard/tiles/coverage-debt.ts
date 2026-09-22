/**
 * Reports the repository's whole coverage debt and which way it is moving,
 * from what each day's `main` runs measured.
 *
 * The headline is the count of uncovered lines. Under it is the median day's
 * change over the recent window, which is the part that says whether the tests
 * are catching up with the code or falling behind it. A median rather than the
 * distance between the ends of the window: the series has steps in it, because
 * a change to what the metric counts moves the whole level in a single day, and
 * one such day cannot carry a median. The chart spans the longer window and
 * highlights the days used for the median. Those days' values set the vertical
 * scale.
 *
 * Amber means that median is a rise. Half the days in the window have to have
 * risen for it to be one, so a day that added debt says nothing on its own. The
 * tile never turns red: nothing about coverage is a thing to act on at 2am, and
 * a red that nobody can act on costs the dashboard the color.
 *
 * Following the dashboard's values (README.md): it reports on the system. The
 * number is the repository's, never a package's owner's and never a person's,
 * and nothing here is aggregated per person.
 */

import type { Status, Tile, TileView } from "../types.ts";
import {
  type CoverageDebtGitHub,
  type CoverageDebtSample,
  CoverageDebtStore,
  refreshCoverageDebt,
} from "../coverage-debt-history.ts";
import {
  friendlyError,
  github,
  githubDownload,
  groupDigits,
  median,
  sparkline,
} from "../lib.ts";
import { CHART_HIGHLIGHT, CHART_LINE } from "../theme.ts";

/** Days of history the tile charts. */
export const COVERAGE_WINDOW_DAYS = 56;

/** Days the median daily change is taken over. */
export const COVERAGE_TREND_DAYS = 21;

/** Days that must have measured in that window before it says a rate. */
export const COVERAGE_MIN_DAYS = 7;

/**
 * How far the debt has to move across the trend window, as a share of where it
 * stands, before the median day counts as moving at all. Half a percent over
 * three weeks comes to about twenty lines a day on a repository of this size,
 * which is above what two runs of one day disagree by.
 */
export const COVERAGE_STEADY_SHARE = 0.005;

/** Days without a measurement after which the history stops being trusted. */
export const COVERAGE_STALE_DAYS = 5;

/**
 * How often the tile looks for a landing. The figure it reports cannot exist
 * sooner than about twelve minutes after a commit lands, because that is when
 * the `main` run's Coverage Check finishes and uploads it, and commits land
 * about that often. So five minutes tracks the number about as closely as the
 * number can be known, and a refresh that finds nothing new costs one request.
 */
export const COVERAGE_REFRESH_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

const startOf = (day: string): number => Date.parse(`${day}T00:00:00Z`);

// Both windows below are counted in whole days from the start of today, so
// which days they hold does not turn on what time of day the tile collected.
const todayAt = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS;

/** The tail of `samples` the median is taken over: the recent days. */
export function trendWindow(
  samples: readonly CoverageDebtSample[],
  now: number,
): CoverageDebtSample[] {
  const cutoff = todayAt(now) - (COVERAGE_TREND_DAYS - 1) * DAY_MS;
  return samples.filter((sample) => startOf(sample.day) >= cutoff);
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
    const days = (startOf(samples[at].day) - startOf(samples[at - 1].day)) /
      DAY_MS;
    if (days <= 0) continue;
    const moved = samples[at].uncoveredLines - samples[at - 1].uncoveredLines;
    rates.push(moved / days);
  }
  return rates.length === 0 ? 0 : median(rates);
}

/**
 * The median day's move, signed so a reader takes the direction from it. A move
 * inside `band` is flat, and says so rather than reporting a rate the
 * measurement cannot tell from nothing. The unit is the headline's, which sits
 * directly above: repeating it here is what pushes the window off the end of
 * the line at the width the dashboard lays a tile out at.
 */
export function dailyChangeLabel(change: number, band: number): string {
  if (Math.abs(change) <= band) return "flat";
  const sign = change > 0 ? "+" : "-";
  return `${sign}${groupDigits(Math.abs(change))} per day`;
}

// Places each point at its date's share of the charted span, so a day nothing
// measured leaves a gap rather than closing one up.
function dayPositions(
  samples: readonly CoverageDebtSample[],
): number[] | undefined {
  const first = startOf(samples[0].day);
  const span = startOf(samples[samples.length - 1].day) - first;
  return span === 0
    ? undefined
    : samples.map((sample) => (startOf(sample.day) - first) / span);
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
  if (newest !== undefined && startOf(newest.day) <= staleAfter) {
    return {
      status: "unknown",
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
  const lines = newest.uncoveredLines;
  // The band is what the whole window would have to move to be worth calling a
  // move, shared out over its days.
  const band = lines * COVERAGE_STEADY_SHARE / COVERAGE_TREND_DAYS;
  const change = medianDailyChange(trend);
  const status: Status = change > band ? "warn" : "good";
  // The unit is on the headline because the count means nothing without it:
  // uncovered lines, not files and not a percentage.
  const headline = `${groupDigits(lines)} lines`;
  return {
    status,
    value: headline,
    valueLabel: headline,
    sub: `${dailyChangeLabel(change, band)} (median) · ` +
      `last ${trend.length} days`,
    extra: sparkline(
      samples.map((sample) => sample.uncoveredLines),
      CHART_LINE,
      { count: trend.length, color: CHART_HIGHLIGHT },
      true,
      dayPositions(samples),
    ),
    duration: startOf(newest.day) - startOf(samples[0].day) + DAY_MS,
  };
}

/** Builds the tile against a store, a clock and a GitHub client. */
export function makeCoverageDebt(
  options: {
    github?: CoverageDebtGitHub;
    store?: CoverageDebtStore;
    now?: () => number;
  } = {},
): Tile {
  const client: CoverageDebtGitHub = options.github ??
    { json: github, download: githubDownload };
  let store = options.store;
  return {
    label: "coverage debt",
    intervalMs: COVERAGE_REFRESH_MS,
    async collect(ctx): Promise<TileView> {
      const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
      if (!token) {
        return { status: "unknown", value: "—", sub: "set GH_TOKEN" };
      }
      store ??= new CoverageDebtStore();
      const now = options.now?.() ?? Date.now();
      const history = await refreshCoverageDebt({
        token,
        days: COVERAGE_WINDOW_DAYS,
        now,
        github: client,
        store,
      });
      if (history.samples.length === 0 && history.error !== undefined) {
        const message = history.error instanceof Error
          ? history.error.message
          : String(history.error);
        console.error("coverage debt: could not read main runs:", message);
        return {
          status: "unknown",
          value: "—",
          sub: friendlyError(message),
        };
      }
      return coverageDebtView(history.samples, now);
    },
  };
}

export const coverageDebt = makeCoverageDebt();
