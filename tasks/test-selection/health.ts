/**
 * Whether the cost model a manifest carries still describes what lanes
 * spend, and the alarms that say it has stopped.
 *
 * The packer trusts the model entirely. A suite charged more than a lane
 * can hold has every one of its tests listed as too long for any lane,
 * and those tests stop running on pull requests without anything
 * failing. A suite charged far less than it spends puts lanes past the
 * bound they were packed to finish inside. Neither shows up anywhere a
 * person is looking, so the publisher measures the model against what
 * lanes recorded, and the dashboard's test selection tile goes red when
 * it has broken.
 *
 * Every figure here is a pure function of a manifest, the manifest before
 * it, and the lanes' own measurements over the cost window. The
 * publisher writes the figures into the manifest it creates, with what
 * it found broken in them. The dashboard shows what it found, and
 * `deno task test-selection health` reports it for any stored manifest.
 */

import type {
  CalibrationHealth,
  Manifest,
  PreviousSuiteHealth,
  SuiteHealth,
} from "./manifest.ts";
import type { Observations } from "./calibrate.ts";
import { fixedCharges } from "./plan.ts";
import {
  COST_WINDOW_DAYS,
  HEALTH_DRIFT_FACTOR,
  HEALTH_MIN_BATCHES,
  HEALTH_MIN_LANES,
  HEALTH_OVERRUN_SHARE,
  HEALTH_TOO_LONG_FACTOR,
  HEALTH_TOO_LONG_JUMP,
  LANE_BUDGET_SECONDS,
} from "./policy.ts";
import { percentile90 } from "./score.ts";
import { duration } from "./duration.ts";

/** A manifest's figures about its cost model, before they are judged. */
export type HealthFigures = Omit<CalibrationHealth, "alarms">;

/** What the publisher knows when it measures the model it is publishing. */
export interface HealthInput {
  /** The manifest being published, with its unschedulable list filled. */
  manifest: Manifest;

  /** The newest manifest before it, where one could be read. */
  previous: Manifest | undefined;

  /** Which capabilities each suite needs, from the topology. */
  capabilities: ReadonlyMap<string, readonly string[]>;

  /** What lanes measured about themselves over the cost window. */
  observations: Pick<Observations, "charges" | "lanes">;
}

/**
 * Each suite's fixed charge and count of identities too long for any
 * lane, in one manifest. A suite with identities too long for any lane
 * and none left in the manifest to charge is charged nothing.
 */
export function suiteCharges(
  manifest: Manifest,
  topology: Pick<HealthInput, "capabilities">,
): Record<string, PreviousSuiteHealth> {
  const fixed = fixedCharges({
    manifest,
    capabilities: topology.capabilities,
  });
  const tooLong = new Map<string, number>();
  for (const { suite } of manifest.unschedulable) {
    tooLong.set(suite, (tooLong.get(suite) ?? 0) + 1);
  }
  const suites: Record<string, PreviousSuiteHealth> = {};
  for (const suite of new Set([...Object.keys(fixed), ...tooLong.keys()])) {
    suites[suite] = {
      fixed: fixed[suite] ?? 0,
      tooLong: tooLong.get(suite) ?? 0,
    };
  }
  return suites;
}

/**
 * What each suite's batches spent over what they were charged, sorted. A
 * batch charged nothing has no ratio to give.
 */
function ratiosBySuite(
  charges: Observations["charges"],
): Map<string, number[]> {
  const ratios = new Map<string, number[]>();
  for (const batch of charges) {
    if (batch.projected <= 0) continue;
    ratios.set(batch.suite, [
      ...ratios.get(batch.suite) ?? [],
      batch.spent / batch.projected,
    ]);
  }
  for (const sorted of ratios.values()) sorted.sort((a, b) => a - b);
  return ratios;
}

/**
 * The figures a manifest carries about its own cost model, and what is
 * broken in them.
 */
export function calibrationHealth(input: HealthInput): CalibrationHealth {
  const figures = healthFigures(input);
  return { ...figures, alarms: alarms(figures) };
}

/** Helper for `calibrationHealth()`, which returns its figures. */
function healthFigures(input: HealthInput): HealthFigures {
  const charges = suiteCharges(input.manifest, input);
  const ratios = ratiosBySuite(input.observations.charges);
  const suites: Record<string, SuiteHealth> = {};
  for (const suite of new Set([...Object.keys(charges), ...ratios.keys()])) {
    const sorted = ratios.get(suite) ?? [];
    suites[suite] = {
      fixed: charges[suite]?.fixed ?? 0,
      tooLong: charges[suite]?.tooLong ?? 0,
      batches: sorted.length,
      ...(sorted.length === 0 ? {} : {
        ratio: {
          // The higher of the two middle readings where the count is
          // even, as the calibration takes it.
          median: sorted[Math.floor(sorted.length / 2)]!,
          p90: percentile90(sorted),
        },
      }),
    };
  }
  const lanes = input.observations.lanes;
  const inside = lanes.filter((lane) => lane.projected <= lane.bound);
  return {
    suites,
    lanes: {
      observed: lanes.length,
      pastBound: lanes.filter((lane) => lane.spent > lane.bound).length,
      projectedInside: inside.length,
      overran: inside.filter((lane) => lane.spent > lane.bound).length,
    },
    ...(input.previous === undefined ? {} : {
      previous: {
        generatedAt: input.previous.generatedAt,
        suites: previousCharges(input.previous, input),
      },
      tooLongBaseline: tooLongBaseline(input.previous),
    }),
  };
}

/**
 * The charges of the manifest before, as it recorded them where it carries
 * health, and otherwise read from it with this topology.
 */
function previousCharges(
  previous: Manifest,
  topology: Pick<HealthInput, "capabilities">,
): Record<string, PreviousSuiteHealth> {
  const recorded = previous.health?.suites;
  if (recorded === undefined) return suiteCharges(previous, topology);
  return Object.fromEntries(
    Object.entries(recorded).map(([suite, { fixed, tooLong }]) => [
      suite,
      { fixed, tooLong },
    ]),
  );
}

/**
 * Whether a count of tests too long for any lane has grown past
 * `baseline` by enough to say the model broke.
 */
function tooLongGrew(count: number, baseline: number): boolean {
  return count > HEALTH_TOO_LONG_FACTOR * baseline &&
    count - baseline > HEALTH_TOO_LONG_JUMP;
}

/**
 * The count of tests too long for any lane that the next manifest's count
 * is judged against: the previous manifest's count, unless that count had
 * itself grown past the baseline it was judged against, in which case that
 * baseline. A jump is then reported for as long as the count stays up,
 * rather than only by the manifest it first appears in, and stops being
 * reported once the count falls back.
 */
function tooLongBaseline(previous: Manifest): number {
  const count = previous.unschedulable.length;
  const judged = previous.health?.tooLongBaseline;
  return judged !== undefined && tooLongGrew(count, judged) ? judged : count;
}

/** A share as a whole percentage. */
function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** The suites of a map in a stable order. */
function bySuite<T>(suites: Record<string, T>): [string, T][] {
  return Object.entries(suites).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/**
 * What says the cost model behind a manifest has broken, one sentence
 * each, naming the suite and the figure. Empty for a model that holds.
 *
 * Four things are read. The count of identities too long for any lane
 * jumping means some suite's charge moved past what a lane can hold, and
 * every identity it charges that for has stopped running on pull
 * requests. A suite's fixed charge past a lane's budget means nothing can
 * share a lane with it. Lanes projected to finish inside their bound and
 * running past it mean the model is charging less than lanes spend. And a
 * suite whose batches spend a long way from what they are charged, in
 * either direction, is one the model no longer describes.
 */
export function alarms(health: HealthFigures): string[] {
  const found: string[] = [];
  const previous = health.previous;
  const baseline = health.tooLongBaseline;
  const tooLong = Object.values(health.suites).reduce(
    (sum, suite) => sum + suite.tooLong,
    0,
  );
  if (baseline !== undefined && tooLongGrew(tooLong, baseline)) {
    const named = bySuite(health.suites)
      .filter(([, suite]) => suite.tooLong > 0)
      .sort(([, a], [, b]) => b.tooLong - a.tooLong)
      .map(([suite, { tooLong }]) => `${suite} ${tooLong}`);
    found.push(
      `${tooLong} tests are too long for any lane, up from ${baseline}: ` +
        named.join(", "),
    );
  }
  for (const [suite, { fixed }] of bySuite(health.suites)) {
    if (fixed <= LANE_BUDGET_SECONDS) continue;
    const was = previous?.suites[suite]?.fixed;
    found.push(
      `${suite}: a lane pays ${duration(fixed)} before it runs any of it, ` +
        `past the ${duration(LANE_BUDGET_SECONDS)} a lane may fill` +
        (was === undefined
          ? ""
          : `; it was ${duration(was)} in the manifest before`),
    );
  }
  const { projectedInside, overran } = health.lanes;
  if (
    projectedInside >= HEALTH_MIN_LANES &&
    overran > HEALTH_OVERRUN_SHARE * projectedInside
  ) {
    found.push(
      `${overran} of the ${projectedInside} lanes projected to finish ` +
        `inside their bound over the last ${COST_WINDOW_DAYS} days ran ` +
        `past it, which is ${percent(overran / projectedInside)} against ` +
        `the ${percent(HEALTH_OVERRUN_SHARE)} allowed`,
    );
  }
  for (const [suite, { batches, ratio }] of bySuite(health.suites)) {
    if (ratio === undefined || batches < HEALTH_MIN_BATCHES) continue;
    const over = ratio.p90 > HEALTH_DRIFT_FACTOR;
    if (!over && ratio.p90 >= 1 / HEALTH_DRIFT_FACTOR) continue;
    found.push(
      `${suite}: the ninetieth percentile of what its ${batches} batches ` +
        `spent over what they were charged is ${ratio.p90.toFixed(2)}, ` +
        (over ? "more than" : "less than") +
        ` ${over ? HEALTH_DRIFT_FACTOR : 1 / HEALTH_DRIFT_FACTOR}`,
    );
  }
  return found;
}

/**
 * The figures a manifest carries about its cost model, as lines a person
 * reads: one per suite with anything to say, one for the lanes, and one
 * per alarm.
 */
export function healthLines(health: CalibrationHealth): string[] {
  const lines: string[] = [];
  const previous = health.previous?.suites;
  for (const [suite, figures] of bySuite(health.suites)) {
    const was = previous?.[suite];
    // Compared as printed, so that a charge that moved by less than the
    // printing shows is not said to have moved.
    const fixed = duration(figures.fixed);
    const wasFixed = was === undefined ? fixed : duration(was.fixed);
    const parts = [
      `a lane pays ${fixed} to hold it` +
      (wasFixed === fixed ? "" : ` (was ${wasFixed})`),
    ];
    if (figures.tooLong > 0 || (was?.tooLong ?? 0) > 0) {
      parts.push(
        `${figures.tooLong} too long for any lane` +
          (was === undefined || was.tooLong === figures.tooLong
            ? ""
            : ` (was ${was.tooLong})`),
      );
    }
    if (figures.ratio !== undefined) {
      parts.push(
        `${figures.batches} batches spent ${figures.ratio.median.toFixed(2)} ` +
          `of what they were charged at the median and ` +
          `${figures.ratio.p90.toFixed(2)} at the ` +
          `ninetieth percentile`,
      );
    }
    lines.push(`${suite}: ${parts.join("; ")}`);
  }
  const { observed, pastBound, projectedInside, overran } = health.lanes;
  lines.push(
    observed === 0
      ? `no lane over the last ${COST_WINDOW_DAYS} days recorded its work`
      : `${pastBound} of ${observed} lanes over the last ` +
        `${COST_WINDOW_DAYS} days ran past their bound, ${overran} of them ` +
        `among the ${projectedInside} projected to finish inside it`,
  );
  if (health.alarms.length === 0) lines.push("the cost model holds");
  for (const alarm of health.alarms) {
    lines.push(`the cost model is broken: ${alarm}`);
  }
  return lines;
}
