/**
 * The logic behind the shell debugger panel (`XDebuggerView`): which telemetry
 * events the topic filters and the search keep, what each event's summary
 * shows, how the main-thread and worker logger counts combine, and the
 * geometry of a timing chart. None of it touches the element, so the view
 * only renders what these functions compute.
 */

import {
  type DebugValueOptions,
  toCompactDebugString,
} from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import type { LogCounts, LoggerBreakdown } from "@commonfabric/logger";
import type {
  CDFPoint,
  RuntimeTelemetryMarkerResult,
  TimingStats,
} from "@commonfabric/runtime-client";

/**
 * Rendering options for a value shown in the debugger: a bounded glimpse on
 * every axis, since a marker can hold anything a cell can and the search
 * renders every marker on each keystroke. The replacer keeps an action's
 * metadata, which it carries as enumerable properties on the function.
 */
export const DEBUGGER_VALUE_OPTIONS: DebugValueOptions = {
  maxDepth: 3,
  maxArrayLength: 5,
  maxProperties: 20,
  maxStringLength: 200,
  replacer: (value) => {
    if (typeof value === "function") {
      return { name: value.name || "[anonymous]", ...value };
    }
    return value;
  },
};

/**
 * Rendering options for the runs of a non-idempotent report. The panel is an
 * inspector, so every run and every cell a run read or wrote is shown, deep
 * enough to reach the values; a long string, or a value nested past the
 * depth, is still cut.
 */
export const RUN_DETAIL_OPTIONS: DebugValueOptions = {
  ...DEBUGGER_VALUE_OPTIONS,
  maxDepth: 6,
  maxArrayLength: Infinity,
  maxProperties: Infinity,
};

/**
 * Hierarchical topic definitions for filtering telemetry events. A subtopic
 * matches an event whose type starts with its pattern.
 */
export const TOPIC_HIERARCHY = {
  scheduler: {
    label: "Scheduler",
    icon: "⚙️",
    color: "#3b82f6", // blue
    subtopics: {
      run: { label: "Run", pattern: "scheduler.run" },
      invocation: { label: "Invocation", pattern: "scheduler.invocation" },
    },
  },
  storage: {
    label: "Storage",
    icon: "💾",
    color: "#10b981", // green
    subtopics: {
      push: { label: "Push", pattern: "storage.push" },
      pull: { label: "Pull", pattern: "storage.pull" },
    },
  },
  cells: {
    label: "Cells",
    icon: "📝",
    color: "#8b5cf6", // violet
    subtopics: {
      update: { label: "Update", pattern: "cell.update" },
    },
  },
} as const;

/** The name of one topic in `TOPIC_HIERARCHY`. */
export type TopicKey = keyof typeof TOPIC_HIERARCHY;

/** How many of a topic's subtopics the filter keeps. */
export type TopicState = "active" | "partial" | "inactive";

/** The color of an event no topic matches. */
const UNMATCHED_EVENT_COLOR = "#64748b";

/** The icon of an event no topic matches. */
const UNMATCHED_EVENT_ICON = "📊";

/** Every topic with its key, in the order the hierarchy declares them. */
function topicEntries() {
  return Object.entries(TOPIC_HIERARCHY).map((
    [key, topic],
  ) => [key as TopicKey, topic] as const);
}

/**
 * The filter keys (`topic.subtopic`) of one topic's subtopics, in declaration
 * order.
 */
export function subtopicKeys(topicKey: TopicKey): string[] {
  return Object.keys(TOPIC_HIERARCHY[topicKey].subtopics).map((subtopicKey) =>
    `${topicKey}.${subtopicKey}`
  );
}

/** The filter keys of every subtopic of every topic: a filter keeping all. */
export function allSubtopics(): Set<string> {
  return new Set(topicEntries().flatMap(([key]) => subtopicKeys(key)));
}

/** How many of a topic's subtopics `active` holds. */
export function activeSubtopicCount(
  active: ReadonlySet<string>,
  topicKey: TopicKey,
): number {
  return subtopicKeys(topicKey).filter((key) => active.has(key)).length;
}

/** Whether `active` holds all, some, or none of a topic's subtopics. */
export function topicState(
  active: ReadonlySet<string>,
  topicKey: TopicKey,
): TopicState {
  const count = activeSubtopicCount(active, topicKey);
  if (count === 0) return "inactive";
  if (count === subtopicKeys(topicKey).length) return "active";
  return "partial";
}

/**
 * The filter after a click on a topic: a topic with no subtopic kept gains
 * them all, and a topic with any kept loses them all.
 */
export function toggleTopic(
  active: ReadonlySet<string>,
  topicKey: TopicKey,
): Set<string> {
  const result = new Set(active);
  const keys = subtopicKeys(topicKey);
  if (activeSubtopicCount(active, topicKey) === 0) {
    keys.forEach((key) => result.add(key));
  } else {
    keys.forEach((key) => result.delete(key));
  }
  return result;
}

/**
 * The filter after the toggle-all button: empty when anything is kept, and
 * every subtopic when nothing is.
 */
export function toggleAllTopics(active: ReadonlySet<string>): Set<string> {
  return active.size > 0 ? new Set() : allSubtopics();
}

/** A copy of `set` with `member` removed if it was there, added if not. */
export function toggleMember<T>(set: ReadonlySet<T>, member: T): Set<T> {
  const result = new Set(set);
  if (result.has(member)) result.delete(member);
  else result.add(member);
  return result;
}

/** The first topic, in declaration order, with a subtopic matching `type`. */
function topicOfEventType(type: string) {
  return topicEntries().find(([, topic]) =>
    Object.values(topic.subtopics).some((subtopic) =>
      type.startsWith(subtopic.pattern)
    )
  )?.[1];
}

/** The icon of the topic an event type belongs to. */
export function eventIcon(type: string): string {
  return topicOfEventType(type)?.icon ?? UNMATCHED_EVENT_ICON;
}

/** The color of the topic an event type belongs to. */
export function eventColor(type: string): string {
  return topicOfEventType(type)?.color ?? UNMATCHED_EVENT_COLOR;
}

/** Whether a subtopic `active` holds matches an event type. */
export function matchesActiveTopics(
  active: ReadonlySet<string>,
  type: string,
): boolean {
  return topicEntries().some(([topicKey, topic]) =>
    Object.entries(topic.subtopics).some(([subtopicKey, subtopic]) =>
      active.has(`${topicKey}.${subtopicKey}`) &&
      type.startsWith(subtopic.pattern)
    )
  );
}

/**
 * Whether an event's rendering holds `searchText`, ignoring case. An empty
 * search matches every event.
 */
export function matchesSearch(
  marker: RuntimeTelemetryMarkerResult,
  searchText: string,
): boolean {
  if (!searchText) return true;
  // A bounded rendering, so that a search does not render a huge marker
  // whole each keystroke.
  return toCompactDebugString(marker, {
    ...DEBUGGER_VALUE_OPTIONS,
    maxLength: 5000,
  }).toLowerCase().includes(searchText.toLowerCase());
}

/** The events the topic filter and the search both keep, in order. */
export function filterEvents(
  markers: readonly RuntimeTelemetryMarkerResult[],
  active: ReadonlySet<string>,
  searchText: string,
): RuntimeTelemetryMarkerResult[] {
  return markers.filter((marker) =>
    matchesActiveTopics(active, marker.type) &&
    matchesSearch(marker, searchText)
  );
}

/** A clock time with milliseconds, in the viewer's locale. */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toLocaleTimeString()}.${
    date.getMilliseconds().toString().padStart(3, "0")
  }`;
}

/** One labeled value in an event's summary line. */
export type EventDetail = {
  readonly label: string;
  readonly value: string;
  /** Whether the value reports an error, which the panel shows in red. */
  readonly isError: boolean;
};

/** A detail that is not an error. */
function detail(label: string, value: string): EventDetail {
  return { label, value, isError: false };
}

/**
 * The summary of an event: for a scheduler run or invocation, the action or
 * handler and what its info says; for a cell update, the address and the kind
 * of change; for anything else, each field other than the type and the time.
 */
export function eventDetails(
  marker: RuntimeTelemetryMarkerResult,
): EventDetail[] {
  if (marker.type === "cell.update") return cellUpdateDetails(marker.change);
  const { type, timeStamp: _, ...rest } = marker;
  const fields: Record<string, unknown> = rest;
  if (type === "scheduler.run" || type === "scheduler.invocation") {
    return schedulerEventDetails(fields);
  }
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => detail(key, fieldText(value)));
}

/** The details of a scheduler run or invocation. */
function schedulerEventDetails(fields: Record<string, unknown>): EventDetail[] {
  const details: EventDetail[] = [];
  const actionId = typeof fields.actionId === "string"
    ? fields.actionId
    : undefined;
  const handlerId = typeof fields.handlerId === "string"
    ? fields.handlerId
    : undefined;
  const idValue = actionId ?? handlerId;
  if (idValue) details.push(detail(actionId ? "action" : "handler", idValue));

  const info = isObjectOrArray(fields.actionInfo)
    ? fields.actionInfo
    : isObjectOrArray(fields.handlerInfo)
    ? fields.handlerInfo
    : undefined;
  if (info) {
    if (typeof info.patternName === "string") {
      details.push(detail("pattern", info.patternName));
    }
    if (typeof info.moduleName === "string") {
      details.push(detail("module", info.moduleName));
    }
    if (Array.isArray(info.reads) && info.reads.length > 0) {
      details.push(detail("reads", `${info.reads.length} dependencies`));
    }
    if (Array.isArray(info.writes) && info.writes.length > 0) {
      details.push(detail("writes", `${info.writes.length} outputs`));
    }
  }

  if (fields.error) {
    details.push({
      label: "error",
      value: String(fields.error),
      isError: true,
    });
  }
  return details;
}

/** The details of a cell update, from the change it carries. */
function cellUpdateDetails(
  change: Extract<RuntimeTelemetryMarkerResult, { type: "cell.update" }>[
    "change"
  ],
): EventDetail[] {
  const details: EventDetail[] = [];
  const { address } = change;
  if (address.id) details.push(detail("cell", address.id));
  details.push(detail("path", address.path.join("/")));
  if (address.type) details.push(detail("type", address.type));
  if (change.before !== undefined || change.after !== undefined) {
    details.push(
      detail(
        "change",
        change.before === undefined
          ? "created"
          : change.after === undefined
          ? "deleted"
          : "updated",
      ),
    );
  }
  return details;
}

/** A field's value as the summary line shows it. */
function fieldText(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "boolean" || typeof value === "number"
    ? value.toString()
    : toCompactDebugString(value, {
      ...DEBUGGER_VALUE_OPTIONS,
      maxLength: 100,
    });
}

/**
 * Log counts by logger name, with the grand total under `total`. A logger's
 * entry is a per-message breakdown, or a bare count.
 */
export type LoggerCounts = Record<string, LoggerBreakdown | number>;

/** Timing statistics by logger name and then by operation. */
export type LoggerTiming = Record<string, Record<string, TimingStats>>;

/** The grand total of a set of counts, or 0 when it has none. */
export function countsTotal(counts: LoggerCounts | null): number {
  const total = counts?.total;
  return typeof total === "number" ? total : 0;
}

/**
 * The main thread's logger counts and the worker's added together, logger by
 * logger and message by message. Without worker counts, the main thread's
 * stand alone.
 */
export function mergeLoggerCounts(
  main: LoggerCounts,
  worker: LoggerCounts | null,
): LoggerCounts {
  if (!worker) return main;

  const merged: LoggerCounts = {};
  const names = new Set([
    ...Object.keys(main).filter((key) => key !== "total"),
    ...Object.keys(worker).filter((key) => key !== "total"),
  ]);
  for (const name of names) {
    const mainValue = main[name];
    const workerValue = worker[name];
    if (typeof mainValue === "number" || typeof workerValue === "number") {
      merged[name] = (typeof mainValue === "number" ? mainValue : 0) +
        (typeof workerValue === "number" ? workerValue : 0);
    } else if (mainValue && workerValue) {
      merged[name] = mergeBreakdown(mainValue, workerValue);
    } else {
      merged[name] = mainValue ?? workerValue;
    }
  }
  merged.total = countsTotal(main) + countsTotal(worker);
  return merged;
}

/** Two breakdowns of one logger added together, message by message. */
function mergeBreakdown(
  a: LoggerBreakdown,
  b: LoggerBreakdown,
): LoggerBreakdown {
  const messages: Record<string, LogCounts> = {};
  const keys = new Set([
    ...Object.keys(a).filter((key) => key !== "total"),
    ...Object.keys(b).filter((key) => key !== "total"),
  ]);
  for (const key of keys) {
    const aCounts = a[key];
    const bCounts = b[key];
    messages[key] = aCounts && bCounts
      ? {
        debug: aCounts.debug + bCounts.debug,
        info: aCounts.info + bCounts.info,
        warn: aCounts.warn + bCounts.warn,
        error: aCounts.error + bCounts.error,
        total: aCounts.total + bCounts.total,
      }
      : aCounts ?? bCounts;
  }
  return Object.assign(messages, { total: a.total + b.total });
}

/**
 * The main thread's timing statistics with the worker's laid over them: a
 * logger only one side has is taken whole, and an operation both sides time
 * takes the worker's statistics.
 */
export function mergeLoggerTiming(
  main: LoggerTiming,
  worker: LoggerTiming | null,
): LoggerTiming {
  if (!worker) return main;
  const merged: LoggerTiming = { ...main };
  for (const [name, operations] of Object.entries(worker)) {
    merged[name] = { ...merged[name], ...operations };
  }
  return merged;
}

/** A logger's per-message counts, the busiest message first. */
export function messageCountsByTotal(
  breakdown: LoggerBreakdown,
): Array<[string, LogCounts]> {
  return Object.keys(breakdown)
    .filter((key) => key !== "total")
    .map((key): [string, LogCounts] => [key, breakdown[key]])
    .sort((a, b) => b[1].total - a[1].total);
}

/**
 * The operations of a logger worth charting, the most often timed first: those
 * with at least one sample in their distribution.
 */
export function chartedOperations(
  operations: Record<string, TimingStats>,
): Array<[string, TimingStats]> {
  return Object.entries(operations)
    .filter(([, stats]) => stats.cdf.length > 0)
    .sort((a, b) => b[1].count - a[1].count);
}

/** A duration in milliseconds, in microseconds, milliseconds, or seconds. */
export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * One sample on a cumulative-time curve: the samples sorted by latency, each
 * carrying the time spent in it and every faster sample.
 */
export type CumulativePoint = {
  readonly latency: number;
  readonly cumulativeTime: number;
  /** The sample's one-based rank by latency. */
  readonly eventIndex: number;
  /** The rank as a fraction of the sample count, in (0, 1]. */
  readonly normalizedPosition: number;
};

/** The points of the cumulative-time curve through some samples. */
export function cumulativePoints(
  samples: readonly CDFPoint[],
): CumulativePoint[] {
  const sorted = [...samples].sort((a, b) => a.x - b.x);
  let cumulativeTime = 0;
  return sorted.map((sample, index) => {
    cumulativeTime += sample.x;
    return {
      latency: sample.x,
      cumulativeTime,
      eventIndex: index + 1,
      normalizedPosition: (index + 1) / sorted.length,
    };
  });
}

/** The size of a timing chart, and the margin around its plot area. */
export const CDF_CHART_FRAME = {
  width: 600,
  height: 200,
  margin: { top: 25, right: 50, bottom: 40, left: 60 },
} as const;

const PLOT_WIDTH = CDF_CHART_FRAME.width - CDF_CHART_FRAME.margin.left -
  CDF_CHART_FRAME.margin.right;
const PLOT_HEIGHT = CDF_CHART_FRAME.height - CDF_CHART_FRAME.margin.top -
  CDF_CHART_FRAME.margin.bottom;

/** How many intervals each axis is divided into. */
const TICK_COUNT = 5;

/** How close, in pixels, the pointer must be to a point to describe it. */
const TOOLTIP_REACH = 30;

/**
 * The geometry of one operation's timing chart: a cumulative-time curve over
 * every sample, and one over the samples since the baseline when there has
 * been one. Each curve has its own vertical scale, so that both fill the plot.
 */
export type CdfChart = {
  readonly points: readonly CumulativePoint[];
  readonly baselinePoints: readonly CumulativePoint[] | null;
  /** The total time of every sample, the top of the main curve. */
  readonly maxTime: number;
  /** The total time since the baseline, the top of the baseline curve. */
  readonly maxBaselineTime: number;
  /** Positions along the horizontal axis to label, as fractions. */
  readonly xTicks: readonly number[];
  /** Cumulative times to label on the vertical axis. */
  readonly yTicks: readonly number[];
  /** The position of the sample nearest the average latency. */
  readonly averagePosition: number;
  /** The SVG path of the main curve. */
  readonly path: string;
  /** The SVG path of the baseline curve, if there is one. */
  readonly baselinePath: string | null;
  /** The horizontal pixel of a position along the curve. */
  x(normalizedPosition: number): number;
  /** The vertical pixel of a cumulative time on the main curve. */
  y(cumulativeTime: number): number;
  /** The vertical pixel of a cumulative time on the baseline curve. */
  yBaseline(cumulativeTime: number): number;
};

/** The chart of an operation's timing statistics. */
export function cdfChart(stats: TimingStats): CdfChart {
  const { margin } = CDF_CHART_FRAME;
  const points = cumulativePoints(stats.cdf);
  const baselinePoints = stats.cdfSinceBaseline
    ? cumulativePoints(stats.cdfSinceBaseline)
    : null;
  const maxTime = points.at(-1)?.cumulativeTime ?? 0.001;
  const maxBaselineTime = baselinePoints?.at(-1)?.cumulativeTime ?? maxTime;
  const x = (normalizedPosition: number) =>
    margin.left + normalizedPosition * PLOT_WIDTH;
  const yScale = (top: number) => (cumulativeTime: number) =>
    margin.top + PLOT_HEIGHT - (cumulativeTime / top) * PLOT_HEIGHT;
  const y = yScale(maxTime);
  const yBaseline = yScale(maxBaselineTime);
  const pathThrough = (
    curve: readonly CumulativePoint[],
    yOf: (cumulativeTime: number) => number,
  ) =>
    curve.map((point, index) =>
      `${index === 0 ? "M" : "L"} ${x(point.normalizedPosition)} ${
        yOf(point.cumulativeTime)
      }`
    ).join(" ");
  const ticks = Array.from(
    { length: TICK_COUNT + 1 },
    (_, i) => i / TICK_COUNT,
  );
  const yTop = Math.max(maxTime, maxBaselineTime);

  let averagePosition = 0.5;
  let nearest = Infinity;
  for (const point of points) {
    const distance = Math.abs(point.latency - stats.average);
    if (distance < nearest) {
      nearest = distance;
      averagePosition = point.normalizedPosition;
    }
  }

  return {
    points,
    baselinePoints,
    maxTime,
    maxBaselineTime,
    xTicks: ticks,
    yTicks: ticks.map((fraction) => fraction * yTop),
    averagePosition,
    path: pathThrough(points, y),
    baselinePath: baselinePoints
      ? pathThrough(baselinePoints, yBaseline)
      : null,
    x,
    y,
    yBaseline,
  };
}

/**
 * The tooltip for the pointer at (`pointerX`, `pointerY`) within a chart drawn
 * `width` by `height`: the nearest point of each curve within reach, or `null`
 * when the pointer is outside the plot or near neither curve.
 */
export function cdfChartTooltip(
  chart: CdfChart,
  pointerX: number,
  pointerY: number,
  width: number,
  height: number,
): string | null {
  const { margin } = CDF_CHART_FRAME;
  if (
    pointerX < margin.left || pointerX > width - margin.right ||
    pointerY < margin.top || pointerY > height - margin.bottom
  ) {
    return null;
  }

  const nearestOn = (
    curve: readonly CumulativePoint[],
    yOf: (cumulativeTime: number) => number,
  ) => {
    let nearest: CumulativePoint | undefined;
    let nearestDistance = Infinity;
    for (const point of curve) {
      const distance = Math.hypot(
        pointerX - chart.x(point.normalizedPosition),
        pointerY - yOf(point.cumulativeTime),
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = point;
      }
    }
    return nearestDistance < TOOLTIP_REACH ? nearest : undefined;
  };
  const describe = (heading: string, point: CumulativePoint) => [
    `${heading}: ${formatDuration(point.latency)}`,
    `  Cumulative: ${formatDuration(point.cumulativeTime)}`,
    `  Event #${point.eventIndex}`,
  ];

  const sections: string[][] = [];
  const main = nearestOn(chart.points, chart.y);
  if (main) sections.push(describe("All time", main));
  const baseline = chart.baselinePoints &&
    nearestOn(chart.baselinePoints, chart.yBaseline);
  if (baseline) sections.push(describe("Since baseline", baseline));
  return sections.length > 0
    ? sections.map((lines) => lines.join("\n")).join("\n\n")
    : null;
}
