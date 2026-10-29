/**
 * Channel-2 console capture for the pattern test runner: logger-level
 * error/warn detection via count deltas.
 *
 * Runtime-internal `logger.error` / `logger.warn` calls (e.g. pattern-manager,
 * cfc, llm) do not flow through the scheduler's harness console event, so the
 * runner detects them by snapshotting every logger's per-key error/warn counts
 * after compile and diffing at the end of the run. Message text is not
 * retained by the counts; the logger name + message key identify the source.
 *
 * Shared by the single-runtime runner (test-runner.ts) and the multi-user
 * worker (multi-user-test-worker.ts) — each worker process has its own logger
 * globals, so each captures its own deltas.
 *
 * A single-user run on the server-execution arm hosts its serving loop in the
 * same process, so the loop logs into the same loggers. `ServedLoggerCounts`
 * keeps what the loop logs apart, by the serving context the runner package
 * carries, so that the deltas are the test's own.
 */

import { setLoggerCountObserver } from "@commonfabric/utils/logger";

import { isPerfDiagnosticWarnKey } from "./perf-diagnostic-logs.ts";

interface LevelCounts {
  error: number;
  warn: number;
}

interface LoggerGlobal {
  counts: LevelCounts;
  countsByKey?: Record<string, LevelCounts>;
}

/** The error/warn counts of one (logger, key), with the logger and key. */
interface ServedEntry extends LevelCounts {
  /** The logger's name. */
  name: string;

  /** The message key. */
  key: string;
}

/** Per-(logger, key) snapshot of error/warn counts at a point in time. */
export type LoggerErrorWarnSnapshot = Map<string, LevelCounts>;

const loggerGlobals = (): Record<string, LoggerGlobal> => {
  const global = globalThis as unknown as {
    commonfabric?: { logger?: Record<string, LoggerGlobal> };
  };
  return global.commonfabric?.logger ?? {};
};

const entryKey = (loggerName: string, key: string): string =>
  `${loggerName}\x00${key}`;

/**
 * Capture the current per-key error/warn counts for every registered logger.
 * Call right after compile, before the pattern run phase begins, so compile
 * infrastructure noise (cache misses etc.) is excluded while everything the
 * run phase logs is in scope.
 */
export function snapshotLoggerErrorWarnCounts(): LoggerErrorWarnSnapshot {
  const snapshot: LoggerErrorWarnSnapshot = new Map();
  for (const [name, logger] of Object.entries(loggerGlobals())) {
    for (const [key, counts] of Object.entries(logger.countsByKey ?? {})) {
      snapshot.set(entryKey(name, key), {
        error: counts.error,
        warn: counts.warn,
      });
    }
  }
  return snapshot;
}

/**
 * Diff current logger counts against the pre-run snapshot and append a
 * `[logger:<name>] <n> error(s)/warning(s) (key: <key>)` line per (logger,
 * key) that logged during the run. A warn key that
 * `perf-diagnostic-logs.ts` names a perf diagnostic is skipped. Counts
 * `served` holds are not part of the diff.
 */
export function appendLoggerDeltaMessages(
  snapshot: LoggerErrorWarnSnapshot,
  errors: string[],
  warnings: string[],
  served?: ServedLoggerCounts,
): void {
  for (const [name, logger] of Object.entries(loggerGlobals())) {
    for (const [key, counts] of Object.entries(logger.countsByKey ?? {})) {
      const entry = entryKey(name, key);
      const pre = snapshot.get(entry) ?? { error: 0, warn: 0 };
      const excluded = served?.counts.get(entry) ?? { error: 0, warn: 0 };
      const deltaError = counts.error - pre.error - excluded.error;
      const deltaWarn = counts.warn - pre.warn - excluded.warn;
      if (deltaError > 0) {
        errors.push(`[logger:${name}] ${deltaError} error(s) (key: ${key})`);
      }
      if (deltaWarn > 0 && !isPerfDiagnosticWarnKey(name, key)) {
        warnings.push(`[logger:${name}] ${deltaWarn} warning(s) (key: ${key})`);
      }
    }
  }
}

/**
 * Per-(logger, key) error/warn counts logged in a serving loop's context,
 * from construction until disposal. Only one instance counts at a time,
 * since it holds the process's one logger count observer.
 */
export class ServedLoggerCounts implements Disposable {
  #counts = new Map<string, ServedEntry>();

  /**
   * Constructs an instance which counts each error and warning logged while
   * `inServingContext()` returns `true`. The unnamed global `log` is left
   * out, as the run's deltas leave it out: no registry entry holds it.
   */
  constructor(inServingContext: () => boolean) {
    setLoggerCountObserver((name, key, level) => {
      if (level !== "error" && level !== "warn") return;
      if (name === undefined || !inServingContext()) return;
      const entry = entryKey(name, key);
      let counts = this.#counts.get(entry);
      if (counts === undefined) {
        counts = { name, key, error: 0, warn: 0 };
        this.#counts.set(entry, counts);
      }
      counts[level]++;
    });
  }

  /** The counts so far. */
  get counts(): ReadonlyMap<string, Readonly<LevelCounts>> {
    return this.#counts;
  }

  /**
   * Appends a `[served] [logger:<name>] <n> error(s)/warning(s) (key: <key>)`
   * line per (logger, key) counted, errors to `errors` and warnings to
   * `warnings`. A warn key that `perf-diagnostic-logs.ts` names a perf
   * diagnostic is skipped.
   */
  appendMessages(errors: string[], warnings: string[]): void {
    for (const { name, key, ...counts } of this.#counts.values()) {
      if (counts.error > 0) {
        errors.push(
          `[served] [logger:${name}] ${counts.error} error(s) (key: ${key})`,
        );
      }
      if (counts.warn > 0 && !isPerfDiagnosticWarnKey(name, key)) {
        warnings.push(
          `[served] [logger:${name}] ${counts.warn} warning(s) (key: ${key})`,
        );
      }
    }
  }

  /** Stops counting, by removing the logger count observer. */
  [Symbol.dispose](): void {
    setLoggerCountObserver(undefined);
  }
}
