/**
 * Minimal logging library for both Deno and browser environments.
 *
 * @module
 * This module provides a flexible logging system with:
 * - Severity levels (debug, info, warn, error)
 * - Lazy evaluation for expensive computations
 * - Module-specific tagging with module names
 * - Per-logger configuration
 * - Console styling support
 * - Call counting and metrics tracking
 * - Automatic periodic count summaries
 *
 * @example Typical usage - disabled by default with debug level
 * ```typescript
 * import { getLogger } from "@commonfabric/utils/logger";
 *
 * // Common pattern: create a debug logger that's disabled by default
 * // pass in function for lazy evaluation of parameters
 * const logger = getLogger("my-module", { enabled: false, level: "debug" });
 * logger.debug("processing-data", () => ["Processing:", data]);
 * ```
 *
 * @example Basic usage
 * ```typescript
 * import { log } from "@commonfabric/utils/logger";
 *
 * // Global logger instance - no module tag
 * // First parameter is always a string key for tracking
 * log.info("app-started", "Application started");
 * // Won't show unless `log.level` is `"debug"`.
 * log.debug("debug-info", "Debug info");
 *
 * // Change global log level
 * log.level = "debug";
 * ```
 *
 * @example Module-tagged logging
 * ```typescript
 * import { getLogger } from "@commonfabric/utils/logger";
 *
 * // Explicitly specify module name - recommended approach
 * const logger = getLogger("user-service");
 *
 * // First parameter is the message key for metrics tracking
 * // Logs will show: [INFO][user-service::HH:MM:SS.mmm] key message
 * logger.log("processing-started", "Processing started"); // Same as info().
 * logger.info("processing-user", "Processing user data");
 * logger.debug("cache-hit", "Cache hit for user", userId);
 * logger.warn("rate-limit", "API rate limit approaching");
 * logger.error("save-failed", "Failed to save user", error);
 * ```
 *
 * @example Lazy evaluation for expensive operations
 * ```typescript
 * const logger = getLogger("data-processor");
 *
 * // Function is only called if debug level is active
 * logger.debug(
 *   "computed-value",
 *   () => `Computed value: ${expensiveComputation()}`,
 * );
 *
 * // Works with arrays that get flattened
 * logger.info("processing-items", () => ["Processing", count, "items"]);
 * ```
 *
 * @example Per-logger configuration
 * ```typescript
 * // Create a debug logger for development
 * const debugLogger = getLogger("debug-module", {
 *   level: "debug",  // Show all messages for this logger
 *   enabled: true    // Explicitly enable
 * });
 *
 * // Create a disabled logger for verbose sections
 * const verboseLogger = getLogger("verbose-module", { enabled: false });
 *
 * // Enable/disable at runtime
 * verboseLogger.disabled = false; // Now it will log
 * verboseLogger.info("message-key", "This will show");
 * ```
 *
 * @example Call counting and metrics
 * ```typescript
 * const logger = getLogger("metrics-test");
 *
 * logger.info("event-1", "Event 1");
 * logger.info("event-2", "Event 2");
 * logger.warn("warning", "Warning");
 *
 * // Check overall counts (increments even when logger is disabled or filtered)
 * console.log(logger.counts);
 * // { debug: 0, info: 2, warn: 1, error: 0, total: 3 }
 *
 * // Check counts by message key
 * console.log(logger.countsByKey);
 * // { "event-1": { debug: 0, info: 1, warn: 0, error: 0, total: 1 }, ... }
 *
 * // Reset individual logger counts
 * logger.resetCounts();
 *
 * // Get total across ALL loggers (in TypeScript/Deno)
 * import { getTotalLoggerCounts } from "@commonfabric/utils/logger";
 * const total = getTotalLoggerCounts(); // Sum of all logger counts
 *
 * // Get breakdown by logger and message key (in TypeScript/Deno)
 * import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
 * const breakdown = getLoggerCountsBreakdown();
 * // {
 * //   "module-1": {
 * //     "user-login": { debug: 5, info: 10, warn: 2, error: 0, total: 17 },
 * //     "data-fetch": { debug: 2, info: 5, warn: 0, error: 1, total: 8 },
 * //     total: 25
 * //   },
 * //   total: 25
 * // }
 *
 * // Reset all logger counts (in TypeScript/Deno)
 * import { resetAllLoggerCounts } from "@commonfabric/utils/logger";
 * resetAllLoggerCounts();
 * ```
 *
 * @example Browser console usage for metrics
 * ```javascript
 * // Get breakdown of all logger counts by name and message key
 * globalThis.commonfabric.getLoggerCountsBreakdown()
 * // Returns: {
 * //   "module-1": {
 * //     "user-login": { debug: 5, info: 10, warn: 2, error: 0, total: 17 },
 * //     total: 17
 * //   },
 * //   total: 17
 * // }
 *
 * // Get just the total count
 * globalThis.commonfabric.getTotalLoggerCounts()
 * // Returns: 17
 *
 * // Reset all counts
 * globalThis.commonfabric.resetAllLoggerCounts()
 *
 * // Access individual logger counts
 * globalThis.commonfabric.logger["module-name"].counts
 * // Returns: { debug: 5, info: 10, warn: 2, error: 1, total: 18 }
 *
 * // Access individual logger counts by key
 * globalThis.commonfabric.logger["module-name"].countsByKey
 * // Returns:
 * // { "user-login": { debug: 5, info: 10, warn: 2, error: 0, total: 17 } }
 *
 * // Reset specific logger
 * globalThis.commonfabric.logger["module-name"].resetCounts()
 * ```
 *
 * @example Automatic count summaries
 * ```typescript
 * // By default, logs a debug message every 100 calls
 * const logger = getLogger("my-module");
 * // After 100 calls:
 * //   [DEBUG][my-module::HH:MM:SS.mmm] my-module: 100 log calls made
 * //   (debug: 20, info: 50, warn: 25, error: 5)
 *
 * // Customize the threshold
 * const customLogger = getLogger("custom-module", { logCountEvery: 50 });
 * // Logs summary every 50 calls instead
 *
 * // Disable automatic summaries
 * const quietLogger = getLogger("quiet-module", { logCountEvery: 0 });
 * // No automatic summaries (but counts still tracked)
 *
 * // Note: Summary logs don't increment counters and only appear when
 * // logger is enabled and debug level is active
 * ```
 */

import { isDeno } from "./env.ts";

/**
 * A message argument: either the value to log, or a function returning it,
 * which is called only when the message is actually going to be emitted.
 */
export type LogMessage = unknown | (() => unknown);

/** Active log levels used for actual log messages. */
export type ActiveLogLevel = "debug" | "info" | "warn" | "error";

/** All log levels including "silent" which suppresses all output. */
export type LogLevel = ActiveLogLevel | "silent";

/** Point in a CDF (cumulative distribution function). */
export interface CDFPoint {
  /** Latency, in milliseconds. */
  x: number;

  /** Cumulative probability, from `0` to `1`. */
  y: number;
}

/** One of the slowest measurements recorded on a key. */
export interface SlowTiming {
  /** How long it took, in milliseconds. */
  elapsed: number;

  /** When it ended, on the `performance.now()` clock. */
  at: number;

  /** When it ended, in milliseconds since the epoch. */
  epochMs: number;

  /** What the caller named this one measurement with, when it named it. */
  detail?: string;
}

/** Statistics for timing measurements. */
export interface TimingStats {
  /** Total number of measurements. */
  count: number;

  /** Shortest measurement, in milliseconds. */
  min: number;

  /** Longest measurement, in milliseconds. */
  max: number;

  /** Sum of all measurements, from which `average` is computed. */
  totalTime: number;

  /** `totalTime` divided by `count`. */
  average: number;

  /** Number of measurements since the most recent baseline reset. */
  countSinceBaseline: number;

  /** Sum of the measurements since the most recent baseline reset. */
  totalTimeSinceBaseline: number;

  /** `totalTimeSinceBaseline` divided by `countSinceBaseline`. */
  averageSinceBaseline: number;

  /** Median measurement, that is, the 50th percentile. */
  p50: number;

  /** 95th percentile measurement. */
  p95: number;

  /** Most recent measurement. */
  lastTime: number;

  /** When the most recent measurement was recorded. */
  lastTimestamp: number;

  /**
   * The slowest measurements, longest first, at most `TIMING_SLOWEST_SIZE` of
   * them. Where `max` says how slow the worst one was, these say when each of
   * the worst few ended and, when the caller named them, what they were.
   */
  slowest: SlowTiming[];

  /** CDF over every sample taken. */
  cdf: CDFPoint[];

  /** CDF over the samples since the most recent baseline reset. */
  cdfSinceBaseline: CDFPoint[] | null;
}

/**
 * Default reservoir size for timing samples.
 * 1000 samples provides good percentile accuracy with bounded memory.
 */
const TIMING_RESERVOIR_SIZE = 1000;

/**
 * How many of the slowest measurements a key keeps: enough to tell one
 * outlier from the head of a tail, few enough that keeping them costs a
 * handful of comparisons per measurement.
 */
const TIMING_SLOWEST_SIZE = 5;

/**
 * Internal class for storing timing data with reservoir sampling.
 * Uses Algorithm R for random sampling to maintain representative distribution
 * with O(1) memory regardless of measurement count.
 */
class TimingDataStore {
  #count = 0;
  #min = Infinity;
  #max = -Infinity;
  #totalTime = 0;
  #lastTime = 0;
  #lastTimestamp = 0;
  #samples: number[] = [];
  #hasBaseline = false;
  #baselineCount = 0;
  #baselineTotalTime = 0;
  #deltaSamples: number[] = []; // Reservoir for samples since baseline
  #deltaCount = 0; // Count of samples since baseline
  #slowest: SlowTiming[] = [];

  /**
   * Records a timing measurement of `elapsed` milliseconds. `detail` names
   * this one measurement; given as a function, it is called only when the
   * measurement is among the slowest this store keeps.
   */
  record(
    elapsed: number,
    detail?: string | (() => string | undefined),
  ): void {
    this.#count++;
    this.#totalTime += elapsed;
    this.#lastTime = elapsed;
    this.#lastTimestamp = performance.now();

    if (elapsed < this.#min) this.#min = elapsed;
    if (elapsed > this.#max) this.#max = elapsed;

    // Reservoir sampling (Algorithm R) for full history
    if (this.#samples.length < TIMING_RESERVOIR_SIZE) {
      this.#samples.push(elapsed);
    } else {
      const j = Math.floor(Math.random() * this.#count);
      if (j < TIMING_RESERVOIR_SIZE) {
        this.#samples[j] = elapsed;
      }
    }

    // Also record to delta reservoir if baseline is set
    if (this.#hasBaseline) {
      this.#deltaCount++;
      if (this.#deltaSamples.length < TIMING_RESERVOIR_SIZE) {
        this.#deltaSamples.push(elapsed);
      } else {
        const j = Math.floor(Math.random() * this.#deltaCount);
        if (j < TIMING_RESERVOIR_SIZE) {
          this.#deltaSamples[j] = elapsed;
        }
      }
    }

    this.#recordSlowest(elapsed, detail);
  }

  /**
   * Sets the baseline for delta tracking.
   * After calling this, new samples will be tracked separately for delta CDF.
   */
  setBaseline(): void {
    this.#hasBaseline = true;
    this.#baselineCount = this.#count;
    this.#baselineTotalTime = this.#totalTime;
    this.#deltaSamples = [];
    this.#deltaCount = 0;
  }

  /** Returns computed statistics over the recorded data. */
  getStats(): TimingStats {
    if (this.#count === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        totalTime: 0,
        average: 0,
        countSinceBaseline: 0,
        totalTimeSinceBaseline: 0,
        averageSinceBaseline: 0,
        p50: 0,
        p95: 0,
        lastTime: 0,
        lastTimestamp: 0,
        slowest: [],
        cdf: [],
        cdfSinceBaseline: null,
      };
    }

    // Sort samples for percentile calculation
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    const median = sorted[p50Index] ?? 0;

    // Calculate CDF of all samples
    const cdf = this.#calculateCDF(sorted);

    // Calculate CDF of samples since baseline (if baseline exists and has data)
    let cdfSinceBaseline: CDFPoint[] | null = null;
    if (this.#deltaCount > 0 && this.#deltaSamples.length > 0) {
      const deltaSorted = [...this.#deltaSamples].sort((a, b) => a - b);
      cdfSinceBaseline = this.#calculateCDF(deltaSorted);
    }

    const countSinceBaseline = this.#hasBaseline
      ? this.#count - this.#baselineCount
      : 0;
    const totalTimeSinceBaseline = this.#hasBaseline
      ? this.#totalTime - this.#baselineTotalTime
      : 0;
    const averageSinceBaseline = countSinceBaseline > 0
      ? totalTimeSinceBaseline / countSinceBaseline
      : 0;

    return {
      count: this.#count,
      min: this.#min,
      max: this.#max,
      totalTime: this.#totalTime,
      average: this.#totalTime / this.#count,
      countSinceBaseline,
      totalTimeSinceBaseline,
      averageSinceBaseline,
      p50: median,
      p95: sorted[p95Index] ?? sorted[sorted.length - 1] ?? 0,
      lastTime: this.#lastTime,
      lastTimestamp: this.#lastTimestamp,
      slowest: this.#slowest.map((entry) => ({ ...entry })),
      cdf,
      cdfSinceBaseline,
    };
  }

  /**
   * Keeps a measurement of `elapsed` milliseconds among the slowest when it
   * is one, building its detail only then.
   */
  #recordSlowest(
    elapsed: number,
    detail: string | (() => string | undefined) | undefined,
  ): void {
    const slowest = this.#slowest;
    const shortest = slowest[slowest.length - 1];
    if (
      shortest !== undefined && slowest.length === TIMING_SLOWEST_SIZE &&
      elapsed <= shortest.elapsed
    ) {
      return;
    }
    const entry: SlowTiming = {
      elapsed,
      at: this.#lastTimestamp,
      epochMs: Date.now(),
    };
    const named = typeof detail === "function" ? detail() : detail;
    if (named !== undefined) entry.detail = named;
    const index = slowest.findIndex((kept) => kept.elapsed < elapsed);
    slowest.splice(index === -1 ? slowest.length : index, 0, entry);
    if (slowest.length > TIMING_SLOWEST_SIZE) slowest.pop();
  }

  /**
   * Returns the CDF (cumulative distribution function) of `sorted`, as
   * points where `(x, y)` means that a `y` fraction of the samples are at
   * most `x` milliseconds.
   */
  #calculateCDF(sorted: number[]): CDFPoint[] {
    if (sorted.length === 0) return [];

    return sorted.map((x, i) => ({
      x,
      y: (i + 1) / sorted.length,
    }));
  }
}

/** Numeric values for log levels, so that they can be compared. */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** Colors for each log level. */
export const LOG_COLORS = {
  debug: "color: #6b7280",
  info: "color: #6b7280",
  warn: "color: #eab308",
  error: "color: #ef4444",
  // Tagged logger colors
  taggedDebug: "color: #6b7280; font-weight: 500",
  taggedInfo: "color: #10b981; font-weight: 500",
  taggedWarn: "color: #eab308; font-weight: 500",
  taggedError: "color: #ef4444; font-weight: 500",
} as const;

/**
 * Global log level floor. When set, `shouldLog()` uses the more restrictive
 * of (floor, per-logger level). This allows suppressing all logging by
 * default (e.g. in CLI mode) while still letting individual loggers be more
 * restrictive.
 */
let _globalLevelFloor: LogLevel | undefined;

/**
 * Sets the global log-level floor. Pass `undefined` to remove the floor
 * entirely.
 */
export function setGlobalLogFloor(level: LogLevel | undefined): void {
  _globalLevelFloor = level;
}

/** Returns the current global log-level floor. */
export function getGlobalLogFloor(): LogLevel | undefined {
  return _globalLevelFloor;
}

/**
 * Function told of each call a logger counts, with the logger's module name
 * (`undefined` for the unnamed global {@link log}), the message key, and the
 * level. It runs synchronously inside the logging call, so it can read the
 * caller's async context.
 */
export type LoggerCountObserver = (
  moduleName: string | undefined,
  key: string,
  level: ActiveLogLevel,
) => void;

/** The process's one {@link LoggerCountObserver}, if one is set. */
let _countObserver: LoggerCountObserver | undefined;

/**
 * Sets the process's one {@link LoggerCountObserver}, replacing any earlier
 * one. Pass `undefined` to remove it. A count taken under the reserved key
 * `total`, which the loggers refuse, is not reported.
 */
export function setLoggerCountObserver(
  observer: LoggerCountObserver | undefined,
): void {
  _countObserver = observer;
}

/**
 * Returns the log level named by the `CF_LOG_LEVEL` environment variable, or
 * `undefined` when it is unset, is not a valid level, or cannot be read.
 * Always `undefined` outside Deno.
 */
function getEnvFloor(): LogLevel | undefined {
  if (isDeno()) {
    try {
      const envLevel = Deno.env.get("CF_LOG_LEVEL");
      if (envLevel && envLevel in LOG_LEVELS) return envLevel as LogLevel;
    } catch { /* ignore permission errors */ }
  }
  return undefined;
}

// Auto-initialize floor from CF_LOG_LEVEL so workers inherit it.
_globalLevelFloor = getEnvFloor();

/**
 * Whether every recorded time span also emits a `performance.measure`.
 *
 * Off unless asked for, because these are for a tool rather than for a person.
 * A run emits hundreds of thousands of them — a topics pattern test produces
 * over 800,000 — and a human opening the timeline wants to see the handful of
 * phases someone named, not every span the runtime recorded. Emission is turned
 * on for the length of an investigation and read by something that aggregates.
 *
 * The cost is real but secondary: a measure runs about three and a half times
 * what recording the span into the statistics does, which is worth knowing for
 * a hot path and is not what decides the default.
 *
 * Turned on, every span already carried by a logger becomes an entry on the
 * timeline of the process that ran it — which is the whole point, because a
 * sampling profile knows nothing about phases and marks only reach the profile
 * taken in their own process.
 */
let _emitTimingMeasures = false;

/**
 * How many measures may be emitted before emission stops.
 *
 * Entries are retained until something clears them, so an unbounded run would
 * grow the buffer without limit and eventually distort the measurement it was
 * turned on to take. Emission stops at the cap and says so once, rather than
 * silently continuing to grow or silently dropping.
 */
let _timingMeasureCap = 200_000;

let _timingMeasuresEmitted = 0;
let _timingMeasureCapReported = false;

/** A monotonic suffix, so two spans on one key stay distinguishable. */
let _timingMeasureSequence = 0;

/**
 * Whether the next span would actually reach the timeline.
 *
 * Emission being on is not the same as a measure being emitted: once the cap is
 * reached nothing more is written, and a caller that pays to build a detail
 * should stop paying at the same moment — which is precisely the longest run,
 * where it would otherwise cost the most.
 */
export function willEmitTimingMeasure(): boolean {
  return _emitTimingMeasures && _timingMeasuresEmitted < _timingMeasureCap;
}

/**
 * What marks a measure as this logger's.
 *
 * The performance timeline is shared with whatever else the host instruments,
 * so emitted entries carry a prefix for two reasons: a drain can then tell
 * what this emitted from a page's own measures, which it keeps, and a human
 * scanning a timeline can tell logger spans from application ones.
 */
export const TIMING_MEASURE_PREFIX = "cf:";

/**
 * What separates a span's key from the detail naming that one instance.
 *
 * A detail identifies which of many spans on a key this one was — which action
 * ran, which document was read — and it reaches the emitted measure and the
 * slowest measurements the statistics keep, never the key itself. Putting it
 * in the key instead would multiply the statistics by every value it
 * takes, which is the cost the keys are deliberately shaped to avoid: a key is
 * a place in the code, not an occurrence.
 */
export const TIMING_MEASURE_DETAIL = "|";

/**
 * Make a key or a detail safe to put in a measure name.
 *
 * Reversibly, because both are arbitrary strings a caller chose: substituting
 * the separators away would map `a|b` and `a/b` onto one name, and two actions
 * that differ only there would then report as one row. Percent-encoding is the
 * cheapest thing that survives a round trip, and `%` goes first so decoding
 * cannot mistake an encoded byte for one the caller wrote.
 */
export function encodeMeasureField(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll(TIMING_MEASURE_DETAIL, "%7C")
    .replaceAll("#", "%23");
}

/** The inverse of {@link encodeMeasureField}. */
export function decodeMeasureField(value: string): string {
  return value
    .replaceAll("%23", "#")
    .replaceAll("%7C", TIMING_MEASURE_DETAIL)
    .replaceAll("%25", "%");
}

/** The detail carried by an emitted measure, if it has one. */
export function detailOfMeasure(name: string): string | undefined {
  const body = name.startsWith(TIMING_MEASURE_PREFIX)
    ? name.slice(TIMING_MEASURE_PREFIX.length)
    : name;
  const hash = body.lastIndexOf("#");
  const withoutSequence = hash === -1 ? body : body.slice(0, hash);
  const bar = withoutSequence.indexOf(TIMING_MEASURE_DETAIL);
  return bar === -1
    ? undefined
    : decodeMeasureField(withoutSequence.slice(bar + 1));
}

function getEnvMeasuresEnabled(): boolean {
  if (isDeno()) {
    try {
      const raw = Deno.env.get("CF_TIMING_MEASURES");
      return raw !== undefined && raw !== "" && raw !== "0";
    } catch { /* ignore permission errors */ }
  }
  return false;
}

/**
 * What `CF_TIMING_MEASURES_CAP` means, separated from reading it.
 *
 * Separate because the decision is the part with a rule in it — anything that
 * does not name a positive integer is ignored rather than applied, since a cap
 * of zero or `NaN` would disable the guard from outside the process. Reading an
 * environment variable needs a permission this package's test suite
 * deliberately does not grant, and the rule should be testable without one.
 */
export function parseTimingMeasureCap(
  raw: string | undefined,
): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The cap named by `CF_TIMING_MEASURES_CAP`, when it names a positive integer.
 *
 * Separate from the on/off variable because a run that hits the cap stops
 * emitting partway through, which leaves an early-run prefix rather than a
 * sample — and a reader who does not know that will attribute a whole run from
 * its setup. Raising it has to be reachable from wherever emission is.
 */
function getEnvMeasureCap(): number | undefined {
  if (isDeno()) {
    try {
      return parseTimingMeasureCap(Deno.env.get("CF_TIMING_MEASURES_CAP"));
    } catch { /* ignore permission errors */ }
  }
  return undefined;
}

_emitTimingMeasures = getEnvMeasuresEnabled();
_timingMeasureCap = getEnvMeasureCap() ?? _timingMeasureCap;

/**
 * Turn `performance.measure` emission on or off for every logger.
 *
 * The environment variable `CF_TIMING_MEASURES` sets the initial value in Deno;
 * this is how a browser or worker, which has no environment to read, asks for
 * the same thing. Passing a `cap` resets the budget along with it.
 */
export function setTimingMeasuresEnabled(
  enabled: boolean,
  options?: { cap?: number },
): void {
  // Validated before anything is assigned, so a rejected call leaves the
  // switch exactly as it found it rather than half-applied.
  if (
    options?.cap !== undefined && (!Number.isInteger(options.cap) ||
      options.cap <= 0)
  ) {
    // A cap of `NaN`, `Infinity`, or zero would disable the guard rather than
    // configure it, and the guard is the only thing bounding retention.
    throw new RangeError(
      `Timing measure cap must be a positive integer: ${options.cap}`,
    );
  }
  _emitTimingMeasures = enabled;
  if (options?.cap !== undefined) {
    _timingMeasureCap = options.cap;
  } else {
    // Coalesced rather than branched: an environment that names no usable cap
    // leaves the current one alone, and there is nothing here that only some
    // runs execute.
    _timingMeasureCap = getEnvMeasureCap() ?? _timingMeasureCap;
  }
  // The budget deliberately survives this. It counts entries that are still on
  // the timeline, so returning it without draining them would let a caller
  // toggling emission retain another whole cap's worth — the growth the cap
  // exists to bound. `clearTimingMeasures()` is what gives it back.
}

/** Whether measure emission is currently on, and what it has spent. */
export function getTimingMeasuresState(): {
  enabled: boolean;
  emitted: number;
  cap: number;
} {
  return {
    enabled: _emitTimingMeasures,
    emitted: _timingMeasuresEmitted,
    cap: _timingMeasureCap,
  };
}

/**
 * Drops every emitted measure and gives the budget back.
 *
 * A consumer that has read the entries should call this: the entries are the
 * only copy, so draining is what keeps a long run from growing without bound.
 *
 * The cost is proportional to the size of the timeline. A measure this did
 * not emit stays on the timeline, as a new entry with the name, start,
 * duration, and detail of the one it replaces, so whatever observes the
 * timeline is handed that measure a second time. One the host refuses to
 * record again is dropped, and the others are kept. A timeline holding no
 * emitted measure is not touched.
 */
export function clearTimingMeasures(): void {
  try {
    const others: PerformanceMeasure[] = [];
    let holdsEmitted = false;
    for (const entry of performance.getEntriesByType("measure")) {
      if (entry.name.startsWith(TIMING_MEASURE_PREFIX)) {
        holdsEmitted = true;
      } else if (entry instanceof PerformanceMeasure) {
        // Every entry of this type is one; the check is what gives the
        // recording below a typed `.detail` to read.
        others.push(entry);
      }
    }
    if (holdsEmitted) {
      // One call removes every measure, and the others are then recorded
      // again. The only narrower removal the timeline has is by name, which
      // costs a host that keeps its timeline as a list a read of all of it,
      // and every emitted measure has a name of its own: that is a read of
      // the timeline per measure. Recording the others again is what keeps a
      // page or worker that instruments itself from losing its measures to a
      // call that claims only to drain this feature's.
      performance.clearMeasures();
      for (const entry of others) {
        recordAgain(entry);
      }
    }
  } catch { /* not every host implements it */ }
  resetTimingMeasureBudget();
}

/**
 * Helper for `clearTimingMeasures()`, which records a measure that the drain
 * removed along with the emitted ones.
 *
 * Never throws: a host refusing this measure costs this measure alone, and
 * the caller goes on to record the ones after it.
 */
function recordAgain(entry: PerformanceMeasure): void {
  try {
    performance.measure(entry.name, {
      start: entry.startTime,
      // The end and not the duration: a measure may end before it starts, and
      // a host admits that end while refusing the negative duration it makes.
      end: entry.startTime + entry.duration,
      detail: entry.detail,
    });
  } catch { /* the host refused this one */ }
}

/**
 * Give the budget back without touching the timeline.
 *
 * Something other than this feature may clear the timeline — a test runner
 * resetting between files does — and the count of what has been emitted has to
 * follow, or emission stays stopped against a cap it no longer owes anything
 * to.
 */
export function resetTimingMeasureBudget(): void {
  _timingMeasuresEmitted = 0;
  _timingMeasureCapReported = false;
}

/**
 * Indicates whether a message at the given level should be logged. Respects
 * the global floor when set — the effective threshold is the more restrictive
 * of (floor, per-logger level).
 */
function shouldLog(level: LogLevel, loggerLevel?: LogLevel): boolean {
  const effectiveLevel = loggerLevel ?? "info";
  const floor = _globalLevelFloor;
  if (floor !== undefined) {
    const floorNum = LOG_LEVELS[floor];
    const loggerNum = LOG_LEVELS[effectiveLevel];
    return LOG_LEVELS[level] >= Math.max(floorNum, loggerNum);
  }
  return LOG_LEVELS[level] >= LOG_LEVELS[effectiveLevel];
}

/** Returns the current time, in `HH:MM:SS.mmm` format. */
function getTimeStamp(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Resolves log messages, evaluating functions where given. */
function resolveMessages(messages: LogMessage[]): unknown[] {
  return messages.flatMap((msg) => {
    const resolved = typeof msg === "function" ? msg() : msg;
    // `flatMap()` flattens an array result and wraps a non-array one, so hand
    // it an array either way.
    return Array.isArray(resolved) ? resolved : [resolved];
  });
}

/** Options for creating a logger. */
export interface GetLoggerOptions {
  /** Whether this logger should be enabled. Defaults to `true`. */
  enabled?: boolean;

  /**
   * Minimum log level for this logger. Defaults to the level named by the
   * environment, or `info` when it names none.
   */
  level?: LogLevel;

  /**
   * How many total calls to go between debug messages summarizing the
   * counts. `0` disables the summaries entirely. Defaults to `100`.
   */
  logCountEvery?: number;
}

/** Call counts for each log level. */
export interface LogCounts {
  /** Number of debug-level calls. */
  debug: number;

  /** Number of info-level calls. */
  info: number;

  /** Number of warn-level calls. */
  warn: number;

  /** Number of error-level calls. */
  error: number;

  /** Number of calls at any level. */
  readonly total: number;
}

/** Breakdown of counts by message key, for a single logger. */
export type LoggerBreakdown = {
  /** Counts for one message key. */
  [messageKey: string]: LogCounts;
} & {
  /** Number of calls across every message key. */
  total: number;
};

/**
 * `detail` as a function that builds it once, however often it is read. A
 * builder that throws names nothing: the measurement is kept without a
 * detail, since instrumentation never fails the thing it is measuring.
 */
function detailOnce(
  detail: string | (() => string),
): () => string | undefined {
  if (typeof detail === "string") return () => detail;
  let built: string | undefined;
  let tried = false;
  return () => {
    if (tried) return built;
    tried = true;
    try {
      built = detail();
    } catch {
      built = undefined;
    }
    return built;
  };
}

/** Logger, which handles both basic and tagged logging. */
export class Logger {
  #moduleName: string | undefined;
  #disabled: boolean;
  #level: LogLevel | undefined;
  #counts: { debug: number; info: number; warn: number; error: number };
  #countsByKey: Record<
    string,
    { debug: number; info: number; warn: number; error: number }
  >;
  #logCountEvery: number;
  #lastLoggedAt: number;
  #timingsByKey: Map<string, TimingDataStore> = new Map();
  #activeTimers: Map<string, number> = new Map();
  #timingBaselineActive = false;
  #countBaseline: {
    debug: number;
    info: number;
    warn: number;
    error: number;
  } | null = null;
  #flags: Map<string, Map<string, Record<string, unknown> | true>> = new Map();

  /**
   * Constructs an instance which tags its output with `moduleName`, if given,
   * and which is configured per `options`.
   */
  constructor(moduleName?: string, options?: GetLoggerOptions) {
    this.#moduleName = moduleName;

    // Set initial disabled state from options
    // Default to false (enabled) if not specified
    this.#disabled = options?.enabled === undefined ? false : !options.enabled;

    // Set logger-specific level if provided, falling back to the environment
    // and then to "info", so that every instance reports a level rather than
    // leaving callers to interpret its absence.
    this.#level = options?.level ?? getEnvLevel() ?? "info";

    // Initialize call counts
    this.#counts = { debug: 0, info: 0, warn: 0, error: 0 };
    this.#countsByKey = {};

    // Set logCountEvery threshold (default to 100, 0 to disable)
    this.#logCountEvery = options?.logCountEvery ?? 100;
    this.#lastLoggedAt = 0;
  }

  /**
   * Controls whether this logger instance is disabled.
   * - true: Logger is disabled, all logs are skipped
   * - false: Logger is enabled, logs are shown based on level (default)
   */
  get disabled(): boolean {
    return this.#disabled;
  }

  /** @inheritDoc */
  set disabled(value: boolean) {
    this.#disabled = value;
  }

  /**
   * Minimum level at which this logger emits. A message below it is counted
   * but not printed.
   */
  get level(): LogLevel | undefined {
    return this.#level;
  }

  /** @inheritDoc */
  set level(value: LogLevel | undefined) {
    this.#level = value;
  }

  /**
   * Call counts for each log level, including a computed total.
   * Counts are incremented even when the logger is disabled or the log level
   * filters out the message.
   */
  get counts(): LogCounts {
    const { debug, info, warn, error } = this.#counts;
    return { debug, info, warn, error, total: debug + info + warn + error };
  }

  /**
   * Call counts broken down by message key. Each key holds counts for
   * `debug`, `info`, `warn`, and `error`, plus a computed total.
   */
  get countsByKey(): Record<string, LogCounts> {
    const result: Record<string, LogCounts> = {};
    for (const [key, counts] of Object.entries(this.#countsByKey)) {
      const { debug, info, warn, error } = counts;
      result[key] = {
        debug,
        info,
        warn,
        error,
        total: debug + info + warn + error,
      };
    }
    return result;
  }

  /**
   * Returns all timing statistics for this logger.
   * Returns a flat map with "/" joined keys.
   */
  get timeStats(): Record<string, TimingStats> {
    const result: Record<string, TimingStats> = {};
    for (const [key, store] of this.#timingsByKey) {
      result[key] = store.getStats();
    }
    return result;
  }

  /**
   * All active flags, as a record from flag name to a record from id to
   * metadata. The metadata is whatever was passed to `flag()`, or `null` when
   * none was. A flag name with no active id is omitted entirely.
   */
  get flags(): Record<string, Record<string, Record<string, unknown> | null>> {
    const result: Record<
      string,
      Record<string, Record<string, unknown> | null>
    > = {};
    for (const [name, group] of this.#flags) {
      if (group.size > 0) {
        const entries: Record<string, Record<string, unknown> | null> = {};
        for (const [id, value] of group) {
          entries[id] = value === true ? null : value;
        }
        result[name] = entries;
      }
    }
    return result;
  }

  /** Resets all call counts to zero, both the overall and the by-key ones. */
  resetCounts(): void {
    this.#counts.debug = 0;
    this.#counts.info = 0;
    this.#counts.warn = 0;
    this.#counts.error = 0;
    this.#countsByKey = {};
    this.#lastLoggedAt = 0;
  }

  /** Logs a debug message. */
  debug(key: string, ...messages: LogMessage[]): void {
    this.#counts.debug++;
    this.#incrementKeyCount(key, "debug");
    if (this.#disabled) return;
    this.#maybeLogCountSummary();
    if (shouldLog("debug", this.#level)) {
      const { prefix, color } = this.#getLogFormat("debug");
      if (shouldLogToStderr()) {
        logToStderr(
          prefix.replace("%c", ""),
          key,
          ...resolveMessages(messages),
        );
      } else {
        console.debug(prefix, color, key, ...resolveMessages(messages));
      }
    }
  }

  /** Logs a message at info level, this being the default method. */
  log(key: string, ...messages: LogMessage[]): void {
    this.info(key, ...messages);
  }

  /** Logs an info message. */
  info(key: string, ...messages: LogMessage[]): void {
    this.#counts.info++;
    this.#incrementKeyCount(key, "info");
    if (this.#disabled) return;
    this.#maybeLogCountSummary();
    if (shouldLog("info", this.#level)) {
      const { prefix, color } = this.#getLogFormat("info");
      if (shouldLogToStderr()) {
        logToStderr(
          prefix.replace("%c", ""),
          key,
          ...resolveMessages(messages),
        );
      } else {
        console.log(prefix, color, key, ...resolveMessages(messages));
      }
    }
  }

  /** Logs a warning message. */
  warn(key: string, ...messages: LogMessage[]): void {
    this.#counts.warn++;
    this.#incrementKeyCount(key, "warn");
    if (this.#disabled) return;
    this.#maybeLogCountSummary();
    if (shouldLog("warn", this.#level)) {
      const { prefix, color } = this.#getLogFormat("warn");
      if (shouldLogToStderr()) {
        logToStderr(
          prefix.replace("%c", ""),
          key,
          ...resolveMessages(messages),
        );
      } else {
        console.warn(prefix, color, key, ...resolveMessages(messages));
      }
    }
  }

  /** Logs an error message. */
  error(key: string, ...messages: LogMessage[]): void {
    this.#counts.error++;
    this.#incrementKeyCount(key, "error");
    if (this.#disabled) return;
    this.#maybeLogCountSummary();
    if (shouldLog("error", this.#level)) {
      const { prefix, color } = this.#getLogFormat("error");
      if (shouldLogToStderr()) {
        logToStderr(
          prefix.replace("%c", ""),
          key,
          ...resolveMessages(messages),
        );
      } else {
        console.error(prefix, color, key, ...resolveMessages(messages));
      }
    }
  }

  //
  // Timing methods
  //

  /**
   * Starts a timer for the given key path. Multiple segments name one path,
   * joined with `/`; they are not a hierarchy that gets rolled up, so
   * `timeEnd()` records against that single joined path and against nothing
   * shorter.
   *
   * @example
   * logger.timeStart("cell", "get", "user-data");
   * // ... operation ...
   * logger.timeEnd("cell", "get", "user-data");
   * // Records to `cell/get/user-data`, and not to `cell` or `cell/get`.
   */
  timeStart(...keys: string[]): void {
    const keyPath = keys.join("/");
    this.#activeTimers.set(keyPath, performance.now());
  }

  /**
   * Ends a timer and records the elapsed time, returning it in milliseconds,
   * or `undefined` if there is no matching timer. The time is recorded against
   * the full joined key path only; see `timeStart()`.
   */
  timeEnd(...keys: string[]): number | undefined {
    const keyPath = keys.join("/");
    const startTime = this.#activeTimers.get(keyPath);
    if (startTime === undefined) {
      return undefined;
    }
    this.#activeTimers.delete(keyPath);

    const endTime = performance.now();
    const elapsed = endTime - startTime;
    this.#recordTime(elapsed, keys, startTime);
    return elapsed;
  }

  /**
   * Ends a timer as `timeEnd()` does, and names this one span with `detail`.
   *
   * The detail reaches the emitted measure and the slowest measurements the
   * statistics keep for the path, and nothing else: the statistics stay keyed
   * by the path alone, so a caller can identify an occurrence without
   * multiplying the rows by every value the detail takes. A caller whose
   * detail costs anything to produce passes a function, which is called only
   * when something keeps the detail: when the span is among the slowest, or
   * when it reaches the timeline.
   */
  timeEndDetailed(
    detail: string | (() => string),
    ...keys: string[]
  ): number | undefined {
    const keyPath = keys.join("/");
    const startTime = this.#activeTimers.get(keyPath);
    if (startTime === undefined) return undefined;
    this.#activeTimers.delete(keyPath);
    const elapsed = performance.now() - startTime;
    this.#recordTime(elapsed, keys, startTime, detail);
    return elapsed;
  }

  /**
   * Records a timing measurement directly. Useful for measuring IPC latency,
   * or any other case where the timestamps are already in hand.
   *
   * Overloads:
   * - time(startTime, ...keys) - end time defaults to performance.now()
   * - time(startTime, endTime, ...keys) - explicit end time
   *
   * @example
   * // End time defaults to now
   * logger.time(startTimestamp, "ipc", "CellGet");
   *
   * // Explicit end time
   * logger.time(startTimestamp, endTimestamp, "ipc", "CellGet");
   *
   * @returns The elapsed time in milliseconds
   */
  time(startTime: number, ...rest: (string | number)[]): number {
    return this.#time(startTime, rest, undefined);
  }

  /**
   * Records a timing measurement directly, as `time()` does with the same
   * `startTime` and `rest`, and names this one measurement with `detail`, as
   * `timeEndDetailed()` does.
   */
  timeDetailed(
    detail: string | (() => string),
    startTime: number,
    ...rest: (string | number)[]
  ): number {
    return this.#time(startTime, rest, detail);
  }

  /**
   * Returns timing statistics for a specific key path.
   * Accepts either separate key segments or a single "/" joined path.
   *
   * @example
   * logger.getTimeStats("cell", "get");  // Using segments
   * logger.getTimeStats("cell/get");     // Using joined path
   */
  getTimeStats(...keys: string[]): TimingStats | undefined {
    const keyPath = keys.join("/");
    const store = this.#timingsByKey.get(keyPath);
    return store?.getStats();
  }

  /** Resets all timing statistics for this logger. */
  resetTimeStats(): void {
    this.#timingsByKey.clear();
    this.#activeTimers.clear();
    this.#timingBaselineActive = false;
  }

  //
  // Baseline methods
  //

  /**
   * Resets the count baseline to the current counts, so that
   * `getCountDeltas()` reports relative to them.
   */
  resetCountBaseline(): void {
    this.#countBaseline = { ...this.#counts };
  }

  /**
   * Resets the timing baseline to the current timings, so that CDF delta
   * curves show the samples taken since.
   */
  resetTimingBaseline(): void {
    this.#timingBaselineActive = true;
    for (const store of this.#timingsByKey.values()) {
      store.setBaseline();
    }
  }

  /**
   * Returns count deltas since the baseline was set.
   * If no baseline exists, returns the current counts.
   */
  getCountDeltas(): {
    debug: number;
    info: number;
    warn: number;
    error: number;
    total: number;
  } {
    if (!this.#countBaseline) {
      return { ...this.#counts, total: this.#getTotal() };
    }
    return {
      debug: this.#counts.debug - this.#countBaseline.debug,
      info: this.#counts.info - this.#countBaseline.info,
      warn: this.#counts.warn - this.#countBaseline.warn,
      error: this.#counts.error - this.#countBaseline.error,
      total: this.#getTotal() - (
        this.#countBaseline.debug + this.#countBaseline.info +
        this.#countBaseline.warn + this.#countBaseline.error
      ),
    };
  }

  //
  // Flag methods
  //

  /**
   * Sets or clears the flag `name` for `id`. A flag is named boolean state
   * held per id, such as `action invalid input` for `action:myModule`.
   *
   * A `value` of `true` stores `metadata` when given and `true` otherwise; a
   * `value` of `false` deletes the entry, so that the active flags are exactly
   * the present entries.
   */
  flag(
    name: string,
    id: string,
    value: boolean,
    metadata?: Record<string, unknown>,
  ): void {
    let group = this.#flags.get(name);
    if (!group) {
      group = new Map();
      this.#flags.set(name, group);
    }
    if (value) {
      group.set(id, metadata ?? true);
    } else {
      group.delete(id);
    }
  }

  /** Resets all flags for this logger. */
  resetFlags(): void {
    this.#flags.clear();
  }

  //
  // Private helpers
  //

  /** Increments the count for a specific message key and log level. */
  #incrementKeyCount(key: string, level: ActiveLogLevel): void {
    // Skip reserved key name "total" to prevent corruption of breakdown totals
    if (key === "total") {
      console.warn(
        `[Logger] Message key \`total\` is reserved and cannot be used. ` +
          `Please use a different key.`,
      );
      return;
    }
    if (!this.#countsByKey[key]) {
      this.#countsByKey[key] = { debug: 0, info: 0, warn: 0, error: 0 };
    }
    this.#countsByKey[key][level]++;
    _countObserver?.(this.#moduleName, key, level);
  }

  /**
   * Logs the count summary, if incrementing the counter has just carried the
   * total past another multiple of the configured threshold.
   */
  #maybeLogCountSummary(): void {
    // Skip if disabled or logCountEvery is 0
    if (this.#logCountEvery === 0) return;

    const total = this.counts.total;
    const threshold = Math.floor(total / this.#logCountEvery);

    // Check if we've crossed a new threshold
    if (threshold > this.#lastLoggedAt) {
      this.#lastLoggedAt = threshold;

      // Only log if debug level is enabled
      if (shouldLog("debug", this.#level)) {
        const { prefix, color } = this.#getLogFormat("debug");
        const moduleName = this.#moduleName || "logger";
        const message =
          `${moduleName}: ${total} log calls made (debug: ${this.#counts.debug}, info: ${this.#counts.info}, warn: ${this.#counts.warn}, error: ${this.#counts.error})`;
        console.debug(prefix, color, message);
      }
    }
  }

  /** Returns the prefix and color for a log level. */
  #getLogFormat(
    level: ActiveLogLevel,
  ): { prefix: string; color: string } {
    const levelUpper = level.toUpperCase();
    const timestamp = getTimeStamp();

    if (this.#moduleName) {
      const prefix = `%c[${levelUpper}][${this.#moduleName}::${timestamp}]`;
      const color = LOG_COLORS[
        `tagged${
          levelUpper.charAt(0) + level.slice(1)
        }` as keyof typeof LOG_COLORS
      ];
      return { prefix, color };
    } else {
      const prefix = `%c[${levelUpper}][${timestamp}]`;
      const color = LOG_COLORS[level];
      return { prefix, color };
    }
  }

  /**
   * Helper for `time()` and `timeDetailed()`: `rest` is an end time followed
   * by the key path, or the key path alone, in which case the measurement
   * ends now.
   */
  #time(
    startTime: number,
    rest: (string | number)[],
    detail: string | (() => string) | undefined,
  ): number {
    let endTime: number;
    let keys: string[];

    if (rest.length > 0 && typeof rest[0] === "number") {
      endTime = rest[0] as number;
      keys = rest.slice(1) as string[];
    } else {
      endTime = performance.now();
      keys = rest as string[];
    }

    const elapsed = endTime - startTime;
    if (keys.length > 0) {
      this.#recordTime(elapsed, keys, startTime, detail);
    }
    return elapsed;
  }

  /**
   * Records timing against the full key path only, with no rollup to the
   * shorter paths. A `detail` given as a function is built at most once,
   * and only for a measurement something keeps the detail of.
   */
  #recordTime(
    elapsed: number,
    keys: string[],
    startTime?: number,
    detail?: string | (() => string),
  ): void {
    const path = keys.join("/");
    let store = this.#timingsByKey.get(path);
    if (!store) {
      store = new TimingDataStore();
      if (this.#timingBaselineActive) {
        store.setBaseline();
      }
      this.#timingsByKey.set(path, store);
    }
    const named = detail === undefined ? undefined : detailOnce(detail);
    store.record(elapsed, named);
    if (_emitTimingMeasures && startTime !== undefined) {
      this.#emitMeasure(
        path,
        startTime,
        elapsed,
        named !== undefined && willEmitTimingMeasure() ? named() : undefined,
      );
    }
  }

  /**
   * Put this span on the timeline as well as into the statistics.
   *
   * Named `<path>#<n>`, because two spans on one key are two different events
   * and a shared name would leave a reader unable to tell them apart. The
   * suffix is what an aggregating consumer strips to recover the key.
   *
   * The timestamp form is deliberate: the caller already holds the start, so
   * there is nothing to gain from marking the boundaries and looking them up
   * again — the mark-based spelling costs several times as much.
   */
  #emitMeasure(
    path: string,
    startTime: number,
    elapsed: number,
    detail?: string,
  ): void {
    if (_timingMeasuresEmitted >= _timingMeasureCap) {
      if (!_timingMeasureCapReported) {
        _timingMeasureCapReported = true;
        console.warn(
          `[logger] timing measures stopped at the cap of ` +
            `${_timingMeasureCap}; call clearTimingMeasures() after reading ` +
            `them, or raise the cap with setTimingMeasuresEnabled().`,
        );
      }
      return;
    }
    try {
      // Both fields are encoded, not just the detail: a key is a caller's
      // string as much as a detail is, and one containing a separator would
      // otherwise be parsed back as a key and a detail that were never there.
      const named = detail === undefined
        ? encodeMeasureField(path)
        : `${encodeMeasureField(path)}${TIMING_MEASURE_DETAIL}${
          encodeMeasureField(detail)
        }`;
      performance.measure(
        `${TIMING_MEASURE_PREFIX}${named}#${++_timingMeasureSequence}`,
        {
          start: startTime,
          end: startTime + elapsed,
        },
      );
      _timingMeasuresEmitted++;
    } catch {
      // Instrumentation never fails the thing it is measuring.
    }
  }

  /** Returns the total count of all log calls, over all four levels. */
  #getTotal(): number {
    return this.#counts.debug + this.#counts.info + this.#counts.warn +
      this.#counts.error;
  }
}

/** Global logger instance, for basic logging. */
export const log = new Logger();

/**
 * Returns the log level named by the `LOG_LEVEL` environment variable, or
 * `undefined` when it is unset, is `silent`, is not a valid level, or cannot
 * be read. Always `undefined` outside Deno.
 */
function getEnvLevel() {
  if (isDeno()) {
    try {
      const envLevel = Deno.env.get("LOG_LEVEL");
      if (envLevel && envLevel !== "silent" && envLevel in LOG_LEVELS) {
        return envLevel as LogLevel;
      }
    } catch {
      // Ignore permission errors - use default log level
    }
  }
  return undefined;
}

/**
 * Indicates whether the `LOG_TO_STDERR` environment variable is set. When it
 * is, all log output goes to stderr, so that stdout stays clean for a CLI
 * tool whose real output a caller is parsing.
 */
function shouldLogToStderr(): boolean {
  if (isDeno()) {
    try {
      return Deno.env.get("LOG_TO_STDERR") === "1";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Logs to stderr, via `Deno.stderr.writeSync()`. Falls back to
 * `console.error()` outside Deno, or if the write fails.
 */
function logToStderr(...args: unknown[]): void {
  if (isDeno()) {
    try {
      const message = args
        .map((arg) =>
          typeof arg === "string" ? arg : Deno.inspect(arg, { colors: false })
        )
        .join(" ");
      Deno.stderr.writeSync(new TextEncoder().encode(message + "\n"));
      return;
    } catch {
      // Fall back to console.error
    }
  }
  console.error(...args);
}

/**
 * Returns the logger tagged with `moduleName`, creating and registering it if
 * there is not already one. `options` therefore takes effect only on the call
 * that creates the logger.
 */
export function getLogger(
  moduleName: string,
  options?: GetLoggerOptions,
): Logger {
  // Initialize global storage if needed
  const global = globalThis as unknown as {
    commonfabric: { logger: Record<string, Logger> };
  };
  if (!global.commonfabric) {
    global.commonfabric = { logger: {} };
  }
  if (!global.commonfabric.logger) {
    global.commonfabric.logger = {};
  }

  // Return existing logger if one exists
  if (global.commonfabric.logger[moduleName]) {
    return global.commonfabric.logger[moduleName];
  }

  // Create and store new logger
  const logger = new Logger(moduleName, options);
  global.commonfabric.logger[moduleName] = logger;

  return logger;
}

/** Resets call counts for every registered logger. */
export function resetAllLoggerCounts(): void {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };
  if (global.commonfabric?.logger) {
    Object.values(global.commonfabric.logger).forEach((logger) =>
      logger.resetCounts()
    );
  }
}

/**
 * Returns the sum of all log calls, over all four levels and over every
 * registered logger.
 */
export function getTotalLoggerCounts(): number {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };
  if (!global.commonfabric?.logger) {
    return 0;
  }
  return Object.values(global.commonfabric.logger)
    .reduce((sum, logger) => sum + logger.counts.total, 0);
}

/**
 * Returns a breakdown of log counts by logger name and message key, with a
 * `total` alongside each level of nesting.
 */
export function getLoggerCountsBreakdown(): Record<string, LoggerBreakdown> & {
  total: number;
} {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };

  const breakdown: Record<string, LoggerBreakdown> = {};
  let total = 0;

  if (global.commonfabric?.logger) {
    for (const [name, logger] of Object.entries(global.commonfabric.logger)) {
      const loggerBreakdown = { total: 0 } as LoggerBreakdown;

      // Add counts by key, skipping `total` so that the reserved property is
      // not overwritten.
      for (const [key, counts] of Object.entries(logger.countsByKey)) {
        if (key === "total") {
          continue; // Skip reserved property name
        }
        loggerBreakdown[key] = counts;
        loggerBreakdown.total += counts.total;
      }

      breakdown[name] = loggerBreakdown;
      total += loggerBreakdown.total;
    }
  }

  return { ...breakdown, total } as Record<string, LoggerBreakdown> & {
    total: number;
  };
}

/** Breakdown of timing stats by logger name. */
export type TimingStatsBreakdown = {
  /** Stats for one logger, by key path. */
  [loggerName: string]: Record<string, TimingStats>;
};

/**
 * Returns a breakdown of timing statistics by logger name and key.
 *
 * @example
 * getTimingStatsBreakdown()
 * // {
 * //   "runtime-client": {
 * //     "ipc":
 * //       { count: 2415, min: 0.1, max: 45.2, average: 1.9, p50: 1.5, ... },
 * //     "ipc/CellGet":
 * //       { count: 1523, min: 0.1, max: 45.2, average: 2.3, p50: 1.8, ... }
 * //   },
 * //   "runner": {
 * //     "cell": { count: 500, min: 0.1, p50: 2.0, p95: 8.5, max: 45.0, ... },
 * //     "cell/get":
 * //       { count: 450, min: 0.1, p50: 2.1, p95: 8.7, max: 45.0, ... }
 * //   }
 * // }
 */
export function getTimingStatsBreakdown(): TimingStatsBreakdown {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };

  const breakdown: TimingStatsBreakdown = {};

  if (global.commonfabric?.logger) {
    for (const [name, logger] of Object.entries(global.commonfabric.logger)) {
      const stats = logger.timeStats;
      if (Object.keys(stats).length > 0) {
        breakdown[name] = stats;
      }
    }
  }

  return breakdown;
}

/**
 * Breakdown of flags by logger name, shaped as
 * `{ loggerName: { flagName: { id: metadata | null } } }`.
 */
export type LoggerFlagsBreakdown = Record<
  string,
  Record<string, Record<string, Record<string, unknown> | null>>
>;

/**
 * Returns a breakdown of active flags by logger name and flag name, e.g.
 * `{ runner: { "action invalid input": { "action:myModule": {...} } } }`.
 */
export function getLoggerFlagsBreakdown(): LoggerFlagsBreakdown {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };

  const breakdown: LoggerFlagsBreakdown = {};

  if (global.commonfabric?.logger) {
    for (const [name, logger] of Object.entries(global.commonfabric.logger)) {
      const flags = logger.flags;
      if (Object.keys(flags).length > 0) {
        breakdown[name] = flags;
      }
    }
  }

  return breakdown;
}

/** Resets timing statistics for every registered logger. */
export function resetAllTimingStats(): void {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };
  if (global.commonfabric?.logger) {
    Object.values(global.commonfabric.logger).forEach((logger) =>
      logger.resetTimeStats()
    );
  }
}

/**
 * Resets the count baseline for every registered logger, so that each
 * logger's `getCountDeltas()` reports relative to its current counts.
 */
export function resetAllCountBaselines(): void {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };
  if (global.commonfabric?.logger) {
    Object.values(global.commonfabric.logger).forEach((logger) =>
      logger.resetCountBaseline()
    );
  }
}

/**
 * Resets the timing baseline for every registered logger, so that each
 * logger's `getTimeStats()` reports its `*SinceBaseline` figures relative to
 * its current timings.
 */
export function resetAllTimingBaselines(): void {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, Logger> };
  };
  if (global.commonfabric?.logger) {
    Object.values(global.commonfabric.logger).forEach((logger) =>
      logger.resetTimingBaseline()
    );
  }
}

// Make helper functions available globally for browser console access
if (typeof globalThis !== "undefined") {
  const global = globalThis as unknown as {
    commonfabric: {
      logger: Record<string, Logger>;
      getTotalLoggerCounts?: typeof getTotalLoggerCounts;
      getLoggerCountsBreakdown?: typeof getLoggerCountsBreakdown;
      resetAllLoggerCounts?: typeof resetAllLoggerCounts;
      getTimingStatsBreakdown?: typeof getTimingStatsBreakdown;
      getLoggerFlagsBreakdown?: typeof getLoggerFlagsBreakdown;
      resetAllTimingStats?: typeof resetAllTimingStats;
      resetAllCountBaselines?: typeof resetAllCountBaselines;
      resetAllTimingBaselines?: typeof resetAllTimingBaselines;
      setGlobalLogFloor?: typeof setGlobalLogFloor;
      getGlobalLogFloor?: typeof getGlobalLogFloor;
    };
  };
  if (!global.commonfabric) {
    global.commonfabric = { logger: {} } as typeof global.commonfabric;
  }
  global.commonfabric.getTotalLoggerCounts = getTotalLoggerCounts;
  global.commonfabric.getLoggerCountsBreakdown = getLoggerCountsBreakdown;
  global.commonfabric.resetAllLoggerCounts = resetAllLoggerCounts;
  global.commonfabric.getTimingStatsBreakdown = getTimingStatsBreakdown;
  global.commonfabric.getLoggerFlagsBreakdown = getLoggerFlagsBreakdown;
  global.commonfabric.resetAllTimingStats = resetAllTimingStats;
  global.commonfabric.resetAllCountBaselines = resetAllCountBaselines;
  global.commonfabric.resetAllTimingBaselines = resetAllTimingBaselines;
  global.commonfabric.setGlobalLogFloor = setGlobalLogFloor;
  global.commonfabric.getGlobalLogFloor = getGlobalLogFloor;
}
