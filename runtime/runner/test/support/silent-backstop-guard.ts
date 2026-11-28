import { wrapSuites } from "@commonfabric/test-support/test";

// A production backstop is a timer that lets a wait give up: the caller
// proceeds as if the event it waited for had arrived, and the only trace is a
// counted log line the module's logger sits above (`storage.v2` logs at
// `error`, so its `warn` is never printed). Under the runner's auto-advance
// clock such a backstop fires the moment nothing else is pending, so a test
// whose awaited event never arrives still passes, riding a silent logical
// jump instead of the event. This guard turns that ride into a failure: it
// records every firing of a listed backstop and fails a suite across which one
// fired, naming the backstop.

/** One backstop the guard watches, identified by the log line it counts. */
export interface SilentBackstop {
  /** The logger's module name, as passed to `getLogger`. */
  logger: string;
  /** The message key the backstop logs under when it fires. */
  key: string;
  /** What a firing means, for the failure message. */
  meaning: string;
}

/** A firing the guard found: the backstop and how many times it fired. */
export interface FiredBackstop {
  backstop: SilentBackstop;
  fired: number;
}

const countKey = (backstop: SilentBackstop): string =>
  `${backstop.logger}\0${backstop.key}`;

// A firing is recorded here the instant the backstop's `warn` runs, and
// nothing a test does clears it. This is the difference from reading the
// logger's own counters: a test may `resetCounts()` (or `resetAllLoggerCounts`)
// mid-run — `scheduler-events.test.ts` and the resume-presync suite do — and
// because the guard wraps a whole suite, a reset in a later `it` would erase a
// firing from an earlier one before the wrapper could read it. A store the reset cannot reach closes that hole. Keyed by
// `logger\0key`.
//
// The store is process-global, and a per-suite before/after difference reads
// firings back correctly because guarded suites never overlap. The guard lives
// in the same preload as the fake clock, whose per-suite wrapper replaces the
// global `setTimeout` and `Date.now` at the start of a suite and restores them
// in a `finally` — coherent only when one suite runs at a time — and the
// package task starts no parallel run. So exactly one suite's before/after
// window is ever open, and a firing during it is that suite's.
const firedTotals = new Map<string, number>();
const wrappedLoggers = new WeakSet<object>();

/** A logger as the guard uses it: something whose `warn(key, …)` it can wrap. */
type CountingLogger = { warn: (key: string, ...rest: unknown[]) => void };

/**
 * The process-global logger registry that `@commonfabric/logger` writes into,
 * keyed by the module name a backstop names. Undefined before any logger is created.
 */
function loggerRegistry(): Record<string, CountingLogger> | undefined {
  return (globalThis as {
    commonfabric?: { logger?: Record<string, CountingLogger> };
  }).commonfabric?.logger;
}

/**
 * Wrap each watched logger's `warn` so a firing lands in `firedTotals`.
 * Idempotent per logger instance, and only ever adds a side counter — `warn`
 * still counts and prints exactly as before. Only a logger the production
 * module has already created is wrapped, so the guard never creates one with
 * options that differ from the module's. A test that could fire a backstop
 * imports the module that owns it, which creates the logger at load, before
 * the test body runs — so by the guard's pre-body read the logger is present.
 */
function ensureWrapped(backstops: readonly SilentBackstop[]): void {
  const registry = loggerRegistry();
  if (registry === undefined) return;
  const keysByLogger = new Map<string, Set<string>>();
  for (const backstop of backstops) {
    let keys = keysByLogger.get(backstop.logger);
    if (keys === undefined) {
      keys = new Set();
      keysByLogger.set(backstop.logger, keys);
    }
    keys.add(backstop.key);
  }
  for (const [name, keys] of keysByLogger) {
    const logger = registry[name];
    if (logger === undefined || wrappedLoggers.has(logger)) continue;
    const original = logger.warn.bind(logger);
    logger.warn = (key: string, ...rest: unknown[]): void => {
      if (keys.has(key)) {
        const k = `${name}\0${key}`;
        firedTotals.set(k, (firedTotals.get(k) ?? 0) + 1);
      }
      original(key, ...rest);
    };
    wrappedLoggers.add(logger);
  }
}

/**
 * The number of firings recorded for each backstop so far this process. Read
 * before and after a test body; a positive difference is a firing across it,
 * whatever the test did to the logger's own counters in between.
 */
export function readBackstopFirings(
  backstops: readonly SilentBackstop[],
): Map<string, number> {
  ensureWrapped(backstops);
  const firings = new Map<string, number>();
  for (const backstop of backstops) {
    const k = countKey(backstop);
    firings.set(k, firedTotals.get(k) ?? 0);
  }
  return firings;
}

/** The backstops whose firing total rose between two readings. */
export function firedBackstops(
  backstops: readonly SilentBackstop[],
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): FiredBackstop[] {
  const fired: FiredBackstop[] = [];
  for (const backstop of backstops) {
    const key = countKey(backstop);
    const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    if (delta > 0) fired.push({ backstop, fired: delta });
  }
  return fired;
}

/** The failure a fired backstop produces, naming each one and its meaning. */
export function describeFiredBackstops(
  fired: readonly FiredBackstop[],
): string {
  const lines = fired.map(({ backstop, fired }) =>
    `${backstop.logger} "${backstop.key}" fired ${fired} time${
      fired === 1 ? "" : "s"
    }: ${backstop.meaning}`
  );
  return `silent backstop fired during this test — the test rode a ` +
    `timeout instead of the event it waits for:\n  ${lines.join("\n  ")}`;
}

/**
 * Fails every suite of the file when one of `backstops` fires
 * while it runs. Install it after the fake clock, so the check runs inside
 * the clock's wrapper — right after the suite and before the clock's own
 * post-suite settle — where a firing is still this suite's. A suite that
 * fails on its own is checked too: a backstop that fired is the likelier
 * explanation of that failure than anything the suite asserts, so the
 * guard's error leads and carries the suite's as its cause.
 */
export function installSilentBackstopGuard(
  backstops: readonly SilentBackstop[],
): void {
  ensureWrapped(backstops);
  wrapSuites(async (run) => {
    const before = readBackstopFirings(backstops);
    let failure: { error: unknown } | undefined;
    try {
      await run();
    } catch (error) {
      failure = { error };
    }
    const fired = firedBackstops(
      backstops,
      before,
      readBackstopFirings(backstops),
    );
    if (fired.length > 0) {
      throw new Error(
        describeFiredBackstops(fired) +
          (failure === undefined ? "" : "\nThe suite failed as well."),
        failure === undefined ? undefined : { cause: failure.error },
      );
    }
    if (failure !== undefined) throw failure.error;
  });
}
