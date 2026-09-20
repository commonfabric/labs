/**
 * Test runner for pattern-native tests.
 *
 * Test patterns (.test.tsx) are patterns that:
 * 1. Import and instantiate the pattern under test
 * 2. Define test steps as an array of { assertion } or { action } objects
 * 3. Return { [TESTS]: TestStep[] } under the reserved `[TESTS]` output key
 *
 * TestStep is a discriminated union:
 * - { assertion: Reactive<AssertRecord> } from assert(() => condition)
 * - { action: Stream<unknown> } from action(() => sideEffect)
 * - { render: unknown } naming a UI target to materialize
 * - { settle: true } settling fully at a point the author names
 * - { label: string } and { await: string } coordinating participants
 *   in a multi-user test
 *
 * The discriminated union avoids TypeScript declaration emit issues
 * that occur when mixing Cell and Stream types in the same array.
 *
 * Example:
 * [TESTS]: [
 *   { assertion: assert(() => game.phase === "playing") },
 *   { action: action(() => game.start.send(undefined)) },
 *   { assertion: assert(() => game.phase === "started") },
 * ]
 *
 * Note: A test pattern's imports resolve within its root directory: an
 * explicit --root when given, otherwise the nearest ancestor whose
 * deno.json(c) declares a package name, otherwise the test file's own
 * directory. An import that climbs above that root is refused by name.
 */

import { basename } from "@std/path";

import {
  FragmentWriter,
  repositoryRelativePath,
} from "@commonfabric/test-support/records";

import { internSchema } from "@commonfabric/data-model-schema";
import { debugStr, toDebugKindString } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  ConsoleMethod,
  experimentalOptionsFromEnv,
  parseLink,
  PatternCoverageCollector,
  patternCoverageOutputPath,
  type PatternInstantiationObserver,
  Runtime,
  type RuntimeOptions,
  runtimePresets,
  RuntimeTelemetryEvent,
  TESTS,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import type {
  Cell,
  ConsoleHandler,
  ErrorWithContext,
  ModuleByteCache,
  Pattern,
  SettleStats,
  Stream,
} from "@commonfabric/runner";
import type {
  CfcEnforcementMode,
  CfcFlowLabelsMode,
} from "@commonfabric/runner/cfc";
import {
  type CDFPoint,
  clearTimingMeasures,
  getLogger,
  getLoggerCountsBreakdown,
  getTimingMeasuresState,
  getTimingStatsBreakdown,
  resetAllCountBaselines,
  resetAllLoggerCounts,
  resetAllTimingBaselines,
  resetAllTimingStats,
  resetTimingMeasureBudget,
  setTimingMeasuresEnabled,
  TIMING_MEASURE_PREFIX,
} from "@commonfabric/utils/logger";

import { assertionOutcome } from "./assert-record.ts";
import { ActionReadReport } from "./action-read-report.ts";
import {
  evaluateReadBudget,
  parseReadBudgets,
  type ReadBudget,
  readBudgetForStep,
  ReadBudgetMeasurement,
  type ReadBudgets,
} from "./read-budgets.ts";
import { getDefaultModuleByteCache } from "./compile-byte-cache.ts";
import {
  appendLoggerDeltaMessages,
  snapshotLoggerErrorWarnCounts,
} from "./console-capture.ts";
import {
  type FetchMockEntry,
  makeMockFetch,
  readFetchMocks,
} from "./fetch-mock.ts";
import { materializeTestVDOM, mountTestVDOM } from "./materialize-test-vdom.ts";
import {
  multiUserDescriptorMeta,
  runMultiUserTestPattern,
} from "./multi-user-test-runner.ts";
import { inferProgramRoot } from "./program-root.ts";
import { buildActionEvent } from "./trusted-action-event.ts";

/**
 * How many idle-then-sync rounds a step's settle performs before it gives up
 * on the runtime converging. A round that resolves at once ends the loop, so
 * the cap is reached only by a graph that keeps scheduling work.
 */
const MAX_SETTLE_ROUNDS = 20;

const phaseLogger = getLogger("test-runner-phase", {
  enabled: false,
  level: "debug",
  logCountEvery: 0,
});

type TimeStampConsole = Console & {
  timeStamp?: (label?: string) => void;
};

let phaseMarkSequence = 0;

function markPhaseBoundary(label: string, boundary: "start" | "end"): string {
  const markName = `${label}:${boundary}#${++phaseMarkSequence}`;
  performance.mark(markName);
  (console as TimeStampConsole).timeStamp?.(`${label}:${boundary}`);
  return markName;
}
async function withPhase<T>(
  keys: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const label = `cf-test/${keys.join("/")}`;
  const startMark = markPhaseBoundary(label, "start");
  phaseLogger.timeStart(...keys);
  try {
    return await fn();
  } finally {
    const endMark = markPhaseBoundary(label, "end");
    phaseLogger.timeEnd(...keys);
    performance.measure(`${label}#${phaseMarkSequence}`, startMark, endMark);
  }
}

interface CapturedMeasure {
  name: string;
  startTime: number;
  duration: number;
}

/**
 * Take this file's emitted measures off the timeline.
 *
 * Draining per file rather than reading once at the end is what makes a
 * multi-file run work at all: each file starts by clearing the timeline, so
 * anything not collected before the next one begins is gone.
 */
function drainTimingMeasures(into: CapturedMeasure[]): void {
  for (const entry of performance.getEntriesByType("measure")) {
    if (!entry.name.startsWith(TIMING_MEASURE_PREFIX)) continue;
    into.push({
      name: entry.name,
      startTime: entry.startTime,
      duration: entry.duration,
    });
  }
  clearTimingMeasures();
}

async function writeTimingMeasures(
  path: string,
  entries: readonly CapturedMeasure[],
): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(entries));
  console.log(
    `\nWrote ${entries.length} timing measure(s) to ${path}. Aggregate with:` +
      `\n  deno run --allow-read ` +
      `skills/perf-investigation/scripts/aggregate-measures.ts ${path}`,
  );
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.stack || error.message || String(error)
    : String(error);
}

/** Indents every line, so a multi-line failure stays aligned under its step. */
function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * The loose shape the runner reads a step cell as, to classify it by which
 * field is present. The authored `TestStep` union (in the api) is already
 * type-checked at the pattern's return; here the fields arrive from storage as
 * `unknown`, so this is deliberately permissive.
 */
type HarnessTestStepMeta = {
  readBudget?: unknown;
  action?: unknown;
  assertion?: unknown;
  event?: unknown;
  trustedUi?: unknown;
  render?: unknown;
  skip?: boolean;
  // `{ settle: true }` step: wait for full settlement (scheduler + storage +
  // in-flight async builtin I/O) via `runtime.settled()` before the next step.
  settle?: boolean;
  // `{ label }` / `{ await }` synchronize participants in a multi-user test.
  // A single-user run has no participant to synchronize with, so they carry
  // no work here — but they still have to be recognized, or a step holding
  // one matches no discriminant and the run reports it as malformed.
  label?: string;
  await?: string;
};

type HarnessTestStepCell = Cell<unknown>;

const testStepPeekSchema = internSchema(
  {
    type: "object",
    properties: {
      action: { type: "unknown" },
      assertion: { type: "unknown" },
      // The payload is what the step sends, so it is read as authored: an
      // object arrives as an object, reaching the handler as a reference into
      // this step rather than a snapshot of it. `type: "unknown"` marks a
      // value the traversal must not descend into, which is right for the
      // fields this schema only tests for presence and wrong here, where it
      // drops an object payload to `undefined`.
      event: true,
      trustedUi: {
        type: "object",
        properties: {
          surface: { type: "string" },
          action: { type: "string" },
        },
      },
      render: { type: "unknown" },
      skip: { type: "boolean" },
      readBudget: true,
      settle: { type: "boolean" },
      label: { type: "string" },
      await: { type: "string" },
    },
  },
);

const testStepEntrySchema = internSchema(
  {
    type: "object",
    asCell: ["cell"],
  },
);

const testStepListSchema = internSchema(
  {
    type: "array",
    items: testStepEntrySchema,
    default: [],
  },
);

function actionStreamForStep(stepCell: HarnessTestStepCell): Stream<unknown> {
  const actionCell = stepCell.key("action") as unknown;
  if (
    typeof actionCell !== "object" || actionCell === null ||
    typeof (actionCell as { send?: unknown }).send !== "function"
  ) {
    throw new Error("Test step action is not a stream");
  }
  return actionCell as Stream<unknown>;
}

export interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  afterAction: string | null;
  error?: string;
  durationMs: number;
}

export interface NavigationEvent {
  /** Name ($NAME) of the navigation target, if available */
  name?: string;

  /** Index of the action that triggered this navigation */
  afterActionIndex: number;
}

export interface TestRunResult {
  path: string;
  results: TestResult[];
  totalDurationMs: number;
  error?: string;

  /** Navigation events recorded during the test run */
  navigations: NavigationEvent[];

  /** Runtime errors captured via errorHandlers during the test run */
  runtimeErrors: string[];

  /** If true, runtime errors are expected and should not fail the test */
  allowRuntimeErrors?: boolean;

  /** If set, runtime errors are REQUIRED: the run fails when none (or, for a
   * number, a different count) were captured. Like expectNonIdempotent, this
   * asserts the loudness fires — it is not a mere tolerance — so reverting a
   * throwing rejection to a silent return fails the suite. Implies
   * allowRuntimeErrors for the captured errors themselves. */
  expectRuntimeErrors?: boolean | number;

  /** Non-idempotent computation names detected by the idempotency check */
  nonIdempotent: string[];

  /** If true, non-idempotent computations are expected: detected violations
   * don't fail the test, and detecting NONE fails it (the flag asserts the
   * detector fires; it is not a mere tolerance). */
  expectNonIdempotent?: boolean;

  /**
   * console.error() calls captured via the harness console event during the
   * run phase, plus logger-level error activity detected via count deltas.
   */
  consoleErrors: string[];

  /** If true, console errors are expected and should not fail the test. */
  allowConsoleErrors?: boolean;

  /**
   * console.warn() calls captured via the harness console event during the
   * run phase, plus logger-level warn activity detected via count deltas.
   */
  consoleWarnings: string[];

  /** If true, console warnings are expected and should not fail the test. */
  allowConsoleWarnings?: boolean;
}

export interface TestRunnerOptions {
  /**
   * Compile the file's program and run nothing: no steps, no coverage
   * written, no multi-user participants started. What the run leaves behind
   * is the compile byte cache. `compileTestPatterns()` is the caller.
   */
  compileOnly?: boolean;
  verbose?: boolean;
  /** Disables diagnostic replay for timing measurements. */
  noIdempotencyCheck?: boolean;

  /**
   * Root directory for resolving imports. If not provided, the nearest
   * ancestor of the test file whose deno.json(c) declares a package name is
   * used, falling back to the test file's directory.
   */
  root?: string;

  /**
   * Data file paths to attach, so a pattern under test that reads one with
   * `dataFile` reads here what it will read once deployed.
   */
  dataFilePaths?: string[];

  /** Print logger stats for steps slower than this (ms). 0 = every step. Default 5000. Only applies when verbose is true. */
  statsThreshold?: number;

  /** Timing categories to always print in verbose stats output. Matched by exact name or prefix. */
  statsInclude?: string[];

  /** Number of per-step scheduler action deltas to print. Default 10. */
  statsActionLimit?: number;

  /** Override CFC enforcement mode for the test runtime. */
  cfcEnforcementMode?: CfcEnforcementMode;

  /** Override flow-label propagation for every test runtime. */
  cfcFlowLabels?: CfcFlowLabelsMode;

  /** Shared compiled-module-byte cache for direct harness compiles. */
  moduleByteCache?: ModuleByteCache;

  /** Print storage-related logger timings and counts after each test file. */
  storageStats?: boolean;

  /** Limit for storage timing/count tables when storageStats is enabled. */
  storageStatsLimit?: number;

  /** Directory for pattern runtime coverage LCOV artifacts. */
  patternCoverageDir?: string;

  /** Keep the test descriptor's `$UI` demanded for the full test run. */
  continuousUI?: boolean;

  /**
   * Spool one test record per file run, named by the file's
   * repository-relative path.
   *
   * The `cf test` command sets this: the files it was pointed at are the
   * tests of a run. A caller inside another test leaves it unset, because
   * the files it hands over are that test's fixtures, and a fixture is data
   * rather than a test of this repository.
   */
  recordResults?: boolean;

  /**
   * Emit a `performance.measure` per logger time span and write them here.
   *
   * The statistics a run prints are aggregates: they say a key was reached
   * 4,000 times and what that cost on average, and nothing about which of
   * them nested inside which. The measures keep each span's own interval, so
   * a consumer can roll them up by key prefix and find the level where the
   * count starts multiplying.
   */
  timingMeasuresOut?: string;

  /**
   * Run against a caller-supplied identity and storage manager, and observe
   * what the run instantiates.
   *
   * Why: `StorageManager.emulate` runs its memory server against `:memory:`,
   * so an ordinary test run leaves no file behind. The pattern-update
   * state-continuity capture (`tasks/pattern-vintage-run.ts`) runs a pattern's
   * OWN tests against a file-backed store and snapshots the result, which is
   * what puts real pattern state — written through real handlers — into a
   * fixture instead of a bare materialized root.
   *
   * The caller OWNS the lifecycle: the runner will not close this storage
   * manager, because a callee must not tear down a resource its caller is
   * still using — the snapshot happens after the run returns.
   *
   * The RUNTIME is still torn down (`dispose({ closeStorage: false })`), which
   * is what makes reading the store afterwards a statement about the state the
   * run reached: the runtime that wrote it can no longer commit into it. A
   * teardown that does not complete is RAISED, so a caller never reads a store
   * whose writer never stopped.
   *
   * A multi-user test refuses this option: its participants instantiate and
   * write in workers of their own, against a storage server the multi-user
   * runner starts, so neither the store nor the observer below would see them.
   */
  storageHost?: {
    identity: Identity;
    storageManager: RuntimeOptions["storageManager"];

    /**
     * Cause for the test pattern's result cell, pinning its entity id.
     *
     * The default is `test-pattern-result-${Date.now()}` — fine for a store
     * that is thrown away, fatal for one that is kept, since an id that
     * differs every run can never be addressed again.
     */
    resultCause?: unknown;

    /** Records every pattern the run materializes; see the vintage capture. */
    onPatternInstantiated?: PatternInstantiationObserver;
  };
}

//
// Verbose-mode logger stats helpers
//

type GlobalWithLoggers = {
  commonfabric?: {
    logger?: Record<
      string,
      {
        counts: {
          debug: number;
          info: number;
          warn: number;
          error: number;
          total: number;
        };
        getCountDeltas(): {
          debug: number;
          info: number;
          warn: number;
          error: number;
          total: number;
        };
        countsByKey?: Record<
          string,
          {
            debug: number;
            info: number;
            warn: number;
            error: number;
            total: number;
          }
        >;
      }
    >;
  };
};

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 10) return `${Math.round(ms)}ms`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(2)}ms`;
}

function printSettleStats(stats: SettleStats | null): void {
  if (!stats || stats.iterations.length <= 1) return;
  console.log(
    `           Settle: ${stats.iterations.length} iterations, ${
      fmtMs(stats.totalDurationMs)
    }, ${stats.initialSeedCount} initial seeds, settled=${stats.settledEarly}`,
  );
  for (let i = 0; i < stats.iterations.length; i++) {
    const iter = stats.iterations[i];
    const effects = iter.actions.filter((a) => a.type === "effect").length;
    const comps = iter.actions.filter((a) => a.type === "computation").length;
    console.log(
      `             iter ${i}: workSet=${iter.workSetSize} order=${iter.orderSize} (${effects}E ${comps}C), ran=${iter.actionsRun}, ${
        fmtMs(iter.durationMs)
      }`,
    );
    // Show which actions are in the workSet (truncated)
    if (iter.actions.length > 0 && iter.workSetSize <= 40) {
      for (const a of iter.actions) {
        const tag = a.type === "effect" ? "E" : "C";
        // Shorten action ID for readability
        const shortId = a.id.length > 70 ? a.id.slice(0, 67) + "..." : a.id;
        console.log(`               [${tag}] ${shortId}`);
      }
    }
  }
}

function getGlobalLogCounts(): {
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
} {
  const g = globalThis as unknown as GlobalWithLoggers;
  const r = { debug: 0, info: 0, warn: 0, error: 0, total: 0 };
  if (g.commonfabric?.logger) {
    for (const logger of Object.values(g.commonfabric.logger)) {
      const c = logger.counts;
      r.debug += c.debug;
      r.info += c.info;
      r.warn += c.warn;
      r.error += c.error;
      r.total += c.total;
    }
  }
  return r;
}

function getGlobalLogCountDeltas(): {
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
} {
  const g = globalThis as unknown as GlobalWithLoggers;
  const r = { debug: 0, info: 0, warn: 0, error: 0, total: 0 };
  if (g.commonfabric?.logger) {
    for (const logger of Object.values(g.commonfabric.logger)) {
      const d = logger.getCountDeltas();
      r.debug += d.debug;
      r.info += d.info;
      r.warn += d.warn;
      r.error += d.error;
      r.total += d.total;
    }
  }
  return r;
}

function cdfPercentile(cdf: CDFPoint[], p: number): number {
  for (const point of cdf) {
    if (point.y >= p) return point.x;
  }
  return cdf[cdf.length - 1]?.x ?? 0;
}

function matchesTimingPrefix(name: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) =>
    name === prefix || name.startsWith(`${prefix}/`)
  );
}

/** Prints timing and call-count summaries, using absolute or baseline deltas. */
export function printLoggerStats(
  elapsedMs: number,
  useDelta: boolean,
  label?: string,
  statsInclude: string[] = [],
): void {
  statsInclude = [
    "cfc",
    "extended-storage-transaction/prepareCfc",
    ...statsInclude,
  ];
  const counts = useDelta ? getGlobalLogCountDeltas() : getGlobalLogCounts();
  const dp = useDelta ? "Δ" : "";
  const labelStr = label ? ` | ${label}:` : ":";
  console.log(
    `  ⏱ ${
      fmtMs(elapsedMs)
    }${labelStr} ${dp}${counts.total} calls (d:${counts.debug} i:${counts.info} w:${counts.warn} e:${counts.error})`,
  );

  const breakdown = getTimingStatsBreakdown();
  const entries: {
    name: string;
    n: number;
    total: number;
    avg: number;
    p50: number;
    p95: number;
    max: number;
  }[] = [];

  for (const [loggerName, timings] of Object.entries(breakdown)) {
    for (const [key, timing] of Object.entries(timings)) {
      if (useDelta) {
        if (timing.countSinceBaseline === 0) {
          continue;
        }
        const cdf = timing.cdfSinceBaseline ?? [];
        entries.push({
          name: `${loggerName}/${key}`,
          n: timing.countSinceBaseline,
          total: timing.totalTimeSinceBaseline,
          avg: timing.averageSinceBaseline,
          p50: cdf.length > 0 ? cdfPercentile(cdf, 0.5) : 0,
          p95: cdf.length > 0 ? cdfPercentile(cdf, 0.95) : 0,
          max: cdf.length > 0 ? cdf[cdf.length - 1].x : 0,
        });
      } else {
        if (timing.count === 0) continue;
        entries.push({
          name: `${loggerName}/${key}`,
          n: timing.count,
          total: timing.totalTime,
          avg: timing.average,
          p50: timing.p50,
          p95: timing.p95,
          max: timing.max,
        });
      }
    }
  }

  // Zero rows distinguish a phase that did no CFC work from a missing probe.
  for (
    const name of [
      "extended-storage-transaction/prepareCfc",
      "cfc/deriveFlowJoin",
      "cfc/collectConsumedLabel",
      "cfc/preparedDigestFor",
    ]
  ) {
    if (!entries.some((entry) => entry.name === name)) {
      entries.push({ name, n: 0, total: 0, avg: 0, p50: 0, p95: 0, max: 0 });
    }
  }

  if (entries.length > 0) {
    entries.sort((a, b) => b.total - a.total);
    const topEntries = entries.slice(0, 10);
    const topNames = new Set(topEntries.map((entry) => entry.name));
    const includedEntries = statsInclude.length > 0
      ? entries.filter((entry) =>
        !topNames.has(entry.name) &&
        matchesTimingPrefix(entry.name, statsInclude)
      )
      : [];

    console.log(`           Timings (top 10 by total time):`);
    for (const entry of topEntries) {
      const name = entry.name.padEnd(35);
      const np = useDelta ? "Δn" : " n";
      console.log(
        `             ${name} ${np}=${String(entry.n).padStart(5)} total=${
          fmtMs(entry.total).padStart(7)
        } avg=${fmtMs(entry.avg).padStart(7)} p95=${
          fmtMs(entry.p95).padStart(7)
        }`,
      );
    }

    if (includedEntries.length > 0) {
      console.log(`           Included Timings:`);
      for (const entry of includedEntries) {
        const name = entry.name.padEnd(35);
        const np = useDelta ? "Δn" : " n";
        console.log(
          `             ${name} ${np}=${String(entry.n).padStart(5)} total=${
            fmtMs(entry.total).padStart(7)
          } avg=${fmtMs(entry.avg).padStart(7)} p95=${
            fmtMs(entry.p95).padStart(7)
          }`,
        );
      }
    }
  }

  // Count breakdown: per-logger/per-key for absolute, per-logger for delta
  type CountEntry = {
    name: string;
    d: number;
    i: number;
    w: number;
    e: number;
    total: number;
  };
  const countEntries: CountEntry[] = [];
  if (useDelta) {
    const g = globalThis as unknown as GlobalWithLoggers;
    if (g.commonfabric?.logger) {
      for (const [name, logger] of Object.entries(g.commonfabric.logger)) {
        const c = logger.getCountDeltas();
        if (c.total > 0) {
          countEntries.push({
            name,
            d: c.debug,
            i: c.info,
            w: c.warn,
            e: c.error,
            total: c.total,
          });
        }
      }
    }
  } else {
    const countBreakdown = getLoggerCountsBreakdown();
    for (const [loggerName, loggerData] of Object.entries(countBreakdown)) {
      if (loggerName === "total") continue;
      for (
        const [key, keyCounts] of Object.entries(
          loggerData as Record<
            string,
            {
              debug: number;
              info: number;
              warn: number;
              error: number;
              total: number;
            }
          >,
        )
      ) {
        if (key === "total") continue;
        if (keyCounts.total > 0) {
          countEntries.push({
            name: `${loggerName}/${key}`,
            d: keyCounts.debug,
            i: keyCounts.info,
            w: keyCounts.warn,
            e: keyCounts.error,
            total: keyCounts.total,
          });
        }
      }
    }
  }

  if (countEntries.length > 0) {
    countEntries.sort((a, b) => b.total - a.total);
    const np = useDelta ? "Δ" : "";
    console.log(`           Counts (top 10 by calls):`);
    for (const entry of countEntries.slice(0, 10)) {
      const name = entry.name.padEnd(35);
      const parts: string[] = [];
      if (entry.d > 0) parts.push(`d:${entry.d}`);
      if (entry.i > 0) parts.push(`i:${entry.i}`);
      if (entry.w > 0) parts.push(`w:${entry.w}`);
      if (entry.e > 0) parts.push(`e:${entry.e}`);
      const levels = parts.length > 0 ? ` (${parts.join(" ")})` : "";
      console.log(
        `             ${name} ${np}n=${
          String(entry.total).padStart(7)
        }${levels}`,
      );
    }
  }
}

function isStorageLoggerName(name: string): boolean {
  return name === "traverse" ||
    name === "memory-provider" ||
    name === "memory-v2-query" ||
    name === "memory-v2-server" ||
    name.startsWith("storage") ||
    name === "extended-storage-transaction";
}

function printStorageStats(elapsedMs: number, limit = 16): void {
  type StorageCountEntry = {
    name: string;
    d: number;
    i: number;
    w: number;
    e: number;
    total: number;
  };

  type StorageCountKeyEntry = {
    logger: string;
    key: string;
    d: number;
    i: number;
    w: number;
    e: number;
    total: number;
  };

  console.log(`  🗄 ${fmtMs(elapsedMs)} | Storage totals:`);

  const timingBreakdown = getTimingStatsBreakdown();
  const timingEntries: {
    name: string;
    n: number;
    p50: number;
    p95: number;
    max: number;
  }[] = [];

  for (const [loggerName, timings] of Object.entries(timingBreakdown)) {
    if (!isStorageLoggerName(loggerName)) continue;
    for (const [key, timing] of Object.entries(timings)) {
      if (timing.count === 0) continue;
      timingEntries.push({
        name: `${loggerName}/${key}`,
        n: timing.count,
        p50: timing.p50,
        p95: timing.p95,
        max: timing.max,
      });
    }
  }

  if (timingEntries.length > 0) {
    timingEntries.sort((a, b) => b.p95 - a.p95);
    console.log(
      `           Timings (top ${
        Math.min(limit, timingEntries.length)
      } by p95):`,
    );
    for (const entry of timingEntries.slice(0, limit)) {
      const name = entry.name.padEnd(35);
      console.log(
        `             ${name}  n=${String(entry.n).padStart(5)} p50=${
          fmtMs(entry.p50).padStart(7)
        } p95=${fmtMs(entry.p95).padStart(7)} max=${
          fmtMs(entry.max).padStart(7)
        }`,
      );
    }
  }

  const g = globalThis as unknown as GlobalWithLoggers;
  const countEntries: StorageCountEntry[] = [];
  if (g.commonfabric?.logger) {
    for (const [name, logger] of Object.entries(g.commonfabric.logger)) {
      if (!isStorageLoggerName(name)) continue;
      const c = logger.counts;
      if (c.total > 0) {
        countEntries.push({
          name,
          d: c.debug,
          i: c.info,
          w: c.warn,
          e: c.error,
          total: c.total,
        });
      }
    }
  }

  if (countEntries.length > 0) {
    countEntries.sort((a, b) => b.total - a.total);
    console.log(`           Counts (all storage loggers):`);
    for (const entry of countEntries) {
      const parts: string[] = [];
      if (entry.d > 0) parts.push(`d:${entry.d}`);
      if (entry.i > 0) parts.push(`i:${entry.i}`);
      if (entry.w > 0) parts.push(`w:${entry.w}`);
      if (entry.e > 0) parts.push(`e:${entry.e}`);
      const levels = parts.length > 0 ? ` (${parts.join(" ")})` : "";
      console.log(
        `             ${entry.name.padEnd(35)} n=${
          String(entry.total).padStart(7)
        }${levels}`,
      );
    }
  }

  const keyEntries: StorageCountKeyEntry[] = [];
  if (g.commonfabric?.logger) {
    for (const [loggerName, logger] of Object.entries(g.commonfabric.logger)) {
      if (!isStorageLoggerName(loggerName) || !logger.countsByKey) continue;
      for (const [key, counts] of Object.entries(logger.countsByKey)) {
        if (counts.total === 0) continue;
        keyEntries.push({
          logger: loggerName,
          key,
          d: counts.debug,
          i: counts.info,
          w: counts.warn,
          e: counts.error,
          total: counts.total,
        });
      }
    }
  }

  if (keyEntries.length > 0) {
    keyEntries.sort((a, b) => b.total - a.total);
    console.log(
      `           Count keys (top ${Math.min(limit, keyEntries.length)}):`,
    );
    for (const entry of keyEntries.slice(0, limit)) {
      const parts: string[] = [];
      if (entry.d > 0) parts.push(`d:${entry.d}`);
      if (entry.i > 0) parts.push(`i:${entry.i}`);
      if (entry.w > 0) parts.push(`w:${entry.w}`);
      if (entry.e > 0) parts.push(`e:${entry.e}`);
      const levels = parts.length > 0 ? ` (${parts.join(" ")})` : "";
      console.log(
        `             ${`${entry.logger}/${entry.key}`.padEnd(55)} n=${
          String(entry.total).padStart(7)
        }${levels}`,
      );
    }
  }
}

/**
 * Print a table of scheduler action stats, sorted by total time descending.
 * Mirrors the table view in the shell's SchedulerGraphView debug UI.
 *
 * Stats are keyed by action ID (source location), so multiple action instances
 * from the same source share the same stats. We deduplicate by ID and count
 * how many live nodes share each ID.
 */
function printActionStatsTable(runtime: Runtime): void {
  const snapshot = runtime.scheduler.getGraphSnapshot();
  const nodes = snapshot.nodes.filter((n) => n.stats && n.stats.runCount > 0);
  if (nodes.length === 0) return;

  // Deduplicate by id since stats are shared across instances with same source.
  // Count how many live nodes share each id.
  const seen = new Map<
    string,
    {
      stats: NonNullable<(typeof nodes)[0]["stats"]>;
      type: string;
      instances: number;
      childIds: Set<string>;
      preview?: string;
    }
  >();

  for (const node of nodes) {
    if (!node.stats) continue;
    const existing = seen.get(node.id);
    if (existing) {
      existing.instances++;
    } else {
      seen.set(node.id, {
        stats: node.stats,
        type: node.type,
        instances: 1,
        childIds: new Set(),
        preview: node.preview,
      });
    }
  }

  // Track parent-child: aggregate children into parents
  for (const node of nodes) {
    if (node.parentId && seen.has(node.parentId) && seen.has(node.id)) {
      seen.get(node.parentId)!.childIds.add(node.id);
    }
  }

  // Build rows: only top-level (not a child of another visible node)
  const allChildIds = new Set<string>();
  for (const entry of seen.values()) {
    for (const cid of entry.childIds) allChildIds.add(cid);
  }

  const rows: {
    id: string;
    type: string;
    instances: number;
    runs: number;
    totalMs: number;
    avgMs: number;
    lastMs: number;
    childCount: number;
    preview?: string;
  }[] = [];

  for (const [id, entry] of seen) {
    if (allChildIds.has(id)) continue;
    let totalMs = entry.stats.totalTime;
    let runs = entry.stats.runCount;
    for (const cid of entry.childIds) {
      const child = seen.get(cid);
      if (child) {
        totalMs += child.stats.totalTime;
        runs += child.stats.runCount;
      }
    }
    rows.push({
      id,
      type: entry.type,
      instances: entry.instances,
      runs,
      totalMs,
      avgMs: runs > 0 ? totalMs / runs : 0,
      lastMs: entry.stats.lastRunTime,
      childCount: entry.childIds.size,
      preview: entry.preview,
    });
  }

  rows.sort((a, b) => b.totalMs - a.totalMs);

  // Print table
  console.log(`\n  ⚡ Action Stats (top 20 by total time):`);
  console.log(
    `    ${"Action".padEnd(55)} ${"Runs".padStart(5)} ${"Total".padStart(9)} ${
      "Avg".padStart(9)
    } ${"Last".padStart(9)}`,
  );
  console.log(`    ${"─".repeat(90)}`);

  for (const row of rows.slice(0, 20)) {
    const suffix = [
      row.instances > 1 ? `${row.instances}x` : "",
      row.childCount > 0 ? `+${row.childCount}ch` : "",
    ].filter(Boolean).join(" ");
    // Use first line of preview if available, otherwise the action id
    const base = row.preview
      ? row.preview.split("\n")[0].trim().slice(0, 40)
      : row.id;
    const label = suffix ? `${base} (${suffix})` : base;
    const truncated = label.length > 54
      ? "…" + label.slice(label.length - 53)
      : label;
    console.log(
      `    ${truncated.padEnd(55)} ${String(row.runs).padStart(5)} ${
        fmtMs(row.totalMs).padStart(9)
      } ${fmtMs(row.avgMs).padStart(9)} ${fmtMs(row.lastMs).padStart(9)}`,
    );
  }

  const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
  const totalTimeMs = rows.reduce((s, r) => s + r.totalMs, 0);
  console.log(`    ${"─".repeat(90)}`);
  console.log(
    `    ${"TOTAL".padEnd(55)} ${String(totalRuns).padStart(5)} ${
      fmtMs(totalTimeMs).padStart(9)
    }`,
  );
}

/**
 * Run a single test pattern file.
 */
export async function runTestPattern(
  testPath: string,
  options: TestRunnerOptions = {},
): Promise<TestRunResult> {
  // The effective import root: an explicit `root` wins; otherwise the nearest
  // package root above the test file, so imports that span the package (shared
  // helpers, sibling patterns) resolve without a flag. When neither exists the
  // resolver anchors at the file's own directory.
  const root = options.root ?? inferProgramRoot(testPath);
  if (options.verbose && !options.root && root !== undefined) {
    console.log(
      `  Resolving imports from ${root} (nearest package root; --root overrides)`,
    );
  }
  const startTime = performance.now();
  performance.clearMarks();
  performance.clearMeasures();
  // The line above drops this run's emitted measures along with everything
  // else, so the budget they were charged against has to come back too.
  resetTimingMeasureBudget();
  resetAllLoggerCounts();
  resetAllTimingStats();

  // Collect runtime errors via the scheduler's error handler
  const runtimeErrors: ErrorWithContext[] = [];
  const patternCoverage = options.patternCoverageDir
    ? new PatternCoverageCollector()
    : undefined;
  let writeLocalPatternCoverage = patternCoverage !== undefined;
  let continuousUiCancel: (() => void) | undefined;
  const continuousUiErrors: Error[] = [];

  // Collect pattern-code console.error / console.warn calls (channel 1: harness
  // console event) and logger-level error/warn activity (channel 2: logger count
  // deltas).  Both are populated during the run phase only (after compile).
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  // Both channels cover the RUN phase only: the channel-1 handler is
  // registered at runtime setup (the scheduler accepts one handler), but it
  // stays inert until this flips at the same post-compile point where the
  // channel-2 snapshot is taken — compile/module-evaluation output is
  // infrastructure noise, not the test's behavior.
  let consoleCaptureActive = false;

  // 1. Create emulated runtime (same as piece step)
  const identity = await withPhase(
    ["runTestPattern", "identity"],
    () =>
      options.storageHost?.identity ?? Identity.fromPassphrase("test-runner"),
  );
  const space = identity.did();
  // A caller-supplied store is FILE-BACKED, which the default emulation is not:
  // `StorageManager.emulate` runs against `:memory:` and leaves nothing to
  // snapshot. See `TestRunnerOptions.storageHost`.
  const storageManager = options.storageHost?.storageManager ??
    await withPhase(
      ["runTestPattern", "storageManager"],
      async () => {
        // The Deno storage cache opens SQLite as it loads, which a
        // caller-supplied storage host makes unnecessary.
        // deno-lint-ignore cf-imports/no-inline-module-import
        const { StorageManager } = await import(
          "@commonfabric/runner/storage/cache.deno"
        );
        return StorageManager.emulate({ as: identity });
      },
    );

  // Track navigation events for assertions and verbose output
  const navigations: NavigationEvent[] = [];
  let currentActionIndex = -1;

  // Fetch mocking: a test opts in by exporting a module-scope `fetchMocks` array.
  // We can't read it until after compile, so the injected fetch closes over a
  // late-populated `fetchMockEntries` and falls through to the real fetch until
  // (and unless) the test declares mocks. Driving the in-flight fetchJson to
  // completion is the harness's existing job — the assertion whose read starts
  // it, a `{ settle: true }` step, and any action's settle all wait on
  // `runtime.settled()`, which awaits the fetch chain.
  const realFetch = globalThis.fetch.bind(globalThis);
  let fetchMockEntries: FetchMockEntry[] | undefined;
  const mockFetch = makeMockFetch(() => fetchMockEntries, realFetch);

  const runtime = await withPhase(
    ["runTestPattern", "runtime"],
    () =>
      // `runtimePresets.patternTest` carries the shared first-party posture
      // (CT-1814). Params below are this harness's declared deltas.
      new Runtime(runtimePresets.patternTest({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: experimentalOptionsFromEnv(Deno.env.get),
        moduleByteCache: options.moduleByteCache ??
          getDefaultModuleByteCache(),
        // Inject a fetch that honors test-declared `fetchMocks` (scoped to this
        // runtime; no process-global mutation).
        fetch: mockFetch,
        // Tests that need a different mode than the harness posture opt in
        // per test.
        ...(options.cfcEnforcementMode !== undefined
          ? { cfcEnforcementMode: options.cfcEnforcementMode }
          : {}),
        ...(options.cfcFlowLabels !== undefined
          ? { cfcFlowLabels: options.cfcFlowLabels }
          : {}),
        ...(options.storageHost?.onPatternInstantiated !== undefined
          ? { onPatternInstantiated: options.storageHost.onPatternInstantiated }
          : {}),
        errorHandlers: [(error: ErrorWithContext) => runtimeErrors.push(error)],
        navigateCallback: (target) => {
          const name = (target.key("$NAME") as Cell<string | undefined>).get();
          navigations.push({
            name,
            afterActionIndex: currentActionIndex,
          });
          if (options.verbose) {
            const label = typeof name === "string" ? name : "(unnamed)";
            console.log(`    → navigateTo: ${label}`);
          }
        },
      })),
  );
  console.log(
    `  CFC posture: enforcement=${runtime.cfcEnforcementMode} flowLabels=${runtime.cfcFlowLabels}`,
  );
  if (!options.noIdempotencyCheck) runtime.enableIdempotencyCheck();
  else if (options.verbose) {
    console.log("  Idempotency verification disabled for this measurement.");
  }
  const readCost = options.verbose ? new ActionReadReport() : undefined;
  let readBudgets: ReadBudgets | undefined;
  let initializationBudgetPending = false;
  let initializationBudgetSettlement: Promise<void> | undefined;
  const budgetMeasurement = new ReadBudgetMeasurement();
  const budgetFailures: string[] = [];
  const budgetResults: TestResult[] = [];
  const checkBudget = (label: string, budget: ReadBudget | undefined) => {
    const failures = evaluateReadBudget(budget, budgetMeasurement).map((v) =>
      `${label}: read budget ${v.kind} exceeded: ${v.actual} accesses > ${v.limit}\n${
        budgetMeasurement.contributors(v.kind).map((line) => `      ${line}`)
          .join("\n")
      }`
    );
    budgetFailures.push(...failures);
    if (options.verbose && readBudgets !== undefined) {
      console.log(
        `    Read budget (${label}): ${budgetMeasurement.total} attempt accesses, ${budgetMeasurement.perRun} maximum body accesses${
          failures.length ? " — FAIL" : ""
        }`,
      );
    }
    return failures;
  };
  const onReadCost = (event: Event) => {
    if (event instanceof RuntimeTelemetryEvent) {
      readCost?.record(event.marker);
      if (readBudgets !== undefined) budgetMeasurement.record(event.marker);
    }
  };
  const printReadCost = (label: string, started: number) => {
    if (
      readCost === undefined ||
      performance.now() - started < (options.statsThreshold ?? 5000)
    ) return;
    for (const line of readCost.format(label, options.statsActionLimit ?? 10)) {
      console.log(line);
    }
  };
  const printStepTimings = (label: string, started: number) => {
    const duration = performance.now() - started;
    if (options.verbose && duration >= (options.statsThreshold ?? 5000)) {
      printLoggerStats(
        performance.now() - startTime,
        true,
        `${label} took ${fmtMs(duration)}`,
        options.statsInclude,
      );
    }
  };
  if (readCost !== undefined) {
    runtime.scheduler.setReadStatsEnabled(true);
  }
  runtime.telemetry.addEventListener("telemetry", onReadCost);
  // Channel 1: capture pattern-code console.error / console.warn calls that
  // flow through the scheduler's harness console event.  The handler must
  // return args unchanged so the call still appears in the host console.
  runtime.scheduler.onConsole(
    (({ method, args }) => {
      if (!consoleCaptureActive) {
        return args;
      }
      if (method === ConsoleMethod.Error) {
        const text = args.map((a) => String(a)).join(" ");
        consoleErrors.push(`[console.error] ${text}`);
      } else if (method === ConsoleMethod.Warn) {
        const text = args.map((a) => String(a)).join(" ");
        consoleWarnings.push(`[console.warn] ${text}`);
      }
      return args;
    }) satisfies ConsoleHandler,
  );
  if (options.verbose) {
    runtime.scheduler.enableSettleStats();
  }
  // Compile/evaluate through the runtime's OWN harness, not a second Engine.
  // Verified-load registration, source maps, and module hashes all live on the
  // engine that evaluates the bundle; the runner and the builder's source-
  // location annotation consult `runtime.harness`. A separate Engine splits
  // that state, so `fn.src` stays a raw bundle coordinate and CFC verified-
  // binding identities (writeAuthorizedBy) fail under enforcement.
  const engine = await withPhase(
    ["runTestPattern", "engine"],
    () => runtime.harness,
  );

  try {
    // 2. Compile the test pattern
    const program = await withPhase(
      ["runTestPattern", "resolve"],
      () =>
        resolveLocalProgram((r) => engine.resolve(r), {
          main: testPath,
          ...(root === undefined ? {} : { root }),
          ...(options.dataFilePaths === undefined
            ? {}
            : { dataFilePaths: options.dataFilePaths }),
        }),
    );
    const evalResult = await withPhase(
      ["runTestPattern", "compile"],
      // `compileAndRegisterModules` seals compile + evaluate + register, so the
      // evaluated artifacts are indexed exactly as the deployed runtime's load
      // path does (`patternFromEvaluation`). Without registration, anonymous
      // map/filter/flatMap ops fall back to a defer-corrupted embedded graph and a
      // grandchild derived-internal output throws at bind time (CT-1811).
      () =>
        runtime.patternManager.compileAndRegisterModules(program, {
          patternCoverage,
        }),
    );
    const { main } = evalResult;

    if (!main?.default) {
      throw new Error(
        `Test pattern must export a pattern function as default`,
      );
    }

    // Read the test's opt-in fetch mocks now (after compile, before the run):
    // a fetchJson with a non-empty URL fires as soon as something reads its
    // result, which the pattern's own graph can do during the initial settle,
    // so the entries must be in place before `runtime.run(...)` below. `main` is the
    // module namespace, so a named `fetchMocks` export is reachable.
    fetchMockEntries = readFetchMocks(main);
    readBudgets = parseReadBudgets(main.readBudgets);

    // A compile-only run ends here: the program's modules are in the byte
    // cache, which is all it was asked for. Nothing ran, so there is no
    // coverage to write, and a multi-user descriptor's participants are not
    // started, since they compile this same program from that cache.
    if (options.compileOnly) {
      writeLocalPatternCoverage = false;
      return {
        path: testPath,
        results: [],
        totalDurationMs: performance.now() - startTime,
        navigations: [],
        runtimeErrors: [],
        nonIdempotent: [],
        consoleErrors: [],
        consoleWarnings: [],
      };
    }

    // Multi-user tests export a descriptor ({ setup?, participants }) as the
    // default export. They run in worker-isolated runtimes against a shared
    // storage server — hand off to the multi-user orchestrator (this local
    // runtime is only used for detection; the try/finally below disposes it).
    const multiUserMeta = multiUserDescriptorMeta(main.default);
    if (multiUserMeta) {
      if (readBudgets !== undefined) {
        throw new Error("Read budgets are not supported in multi-user tests");
      }
      writeLocalPatternCoverage = false;
      return await withPhase(
        ["runTestPattern", "multiUser"],
        // The participant workers compile the file again in their own
        // processes; passing the resolved root keeps their import resolution
        // identical to the detection compile above.
        () =>
          runMultiUserTestPattern(testPath, multiUserMeta, {
            ...options,
            root,
          }),
      );
    }

    const testPatternFactory = main.default as Pattern;

    if (typeof testPatternFactory !== "function") {
      throw new Error(
        `Test pattern must export a pattern function as default, got ${typeof testPatternFactory}`,
      );
    }

    // 3. Set up defaultPattern so wish({ query: "#default" }) resolves.
    // In production, default-app.tsx provides this. The test harness must
    // create a minimal equivalent so patterns that use wish("#default") to
    // access the piece registry and related space services work correctly.
    await withPhase(["runTestPattern", "defaultPatternSetup"], async () => {
      const setupTx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, setupTx);
      const defaultPatternCell = runtime.getCell(
        space,
        "default-pattern",
        undefined,
        setupTx,
      );
      const pieceRegistry = (defaultPatternCell as any).key("pieceRegistry");
      pieceRegistry.set([]);
      const addPiece = runtime.getCell(
        space,
        "test-default-add-piece",
        undefined,
        setupTx,
      );
      addPiece.setRaw({ $stream: true });
      (defaultPatternCell as any).key("addPiece").set(addPiece);
      const testPieceRegistrationCount = (defaultPatternCell as any).key(
        "testPieceRegistrationCount",
      );
      testPieceRegistrationCount.set(0);
      runtime.scheduler.addEventHandler(
        (handlerTx, event) => {
          const piece = event?.piece;
          if (!piece) return;
          pieceRegistry.withTx(handlerTx).addUnique(piece);
          testPieceRegistrationCount.withTx(handlerTx).increment();
        },
        parseLink(addPiece),
      );
      (defaultPatternCell as any).key("backlinksIndex").set({
        mentionable: [],
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);
      runtime.prepareTxForCommit?.(setupTx);
      await setupTx.commit();
      await runtime.idle();
    });

    // Channel 2: snapshot logger error/warn counts AFTER compile but BEFORE the
    // run/assert phase.  This excludes compile-cache and infrastructure noise
    // (e.g. cache-miss warnings emitted during engine.compileAndEvaluateModules)
    // while capturing everything the pattern's own handlers log at error/warn
    // level through the runtime logger.
    const loggerCountsBeforeRun = snapshotLoggerErrorWarnCounts();
    consoleCaptureActive = true;
    if (readBudgets !== undefined) {
      runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
      initializationBudgetPending = true;
    }

    // 4. Instantiate the test pattern using runtime.run() for proper space context
    const patternResult = await withPhase(
      ["runTestPattern", "patternRun"],
      async () => {
        const tx = runtime.edit();
        runtime.scheduler.beginReadAttempt(tx, "initialization");

        // Create a result cell for the pattern
        const resultCell = runtime.getCell<Record<string, unknown>>(
          space,
          options.storageHost?.resultCause ??
            `test-pattern-result-${Date.now()}`,
          undefined,
          tx,
        );

        try {
          // Run the pattern with proper space context
          const value = runtime.run(tx, testPatternFactory, {}, resultCell);

          // Commit the transaction
          runtime.prepareTxForCommit?.(tx);
          await tx.commit();
          return value;
        } catch (error) {
          tx.abort(error);
          throw error;
        }
      },
    );

    if (options.continuousUI) {
      continuousUiCancel = await withPhase(
        ["runTestPattern", "continuousUI", "mount"],
        () =>
          mountTestVDOM(
            patternResult.key("$UI") as Cell<unknown>,
            (error) => continuousUiErrors.push(error),
          ),
      );
      if (options.verbose) {
        console.log("  Continuous $UI demand enabled");
      }
    }

    initializationBudgetSettlement = withPhase([
      "runTestPattern",
      "initialSettle",
    ], async () => {
      // Wait for initial setup to complete
      await runtime.idle();
      // Also wait for all in-flight storage subscriptions to settle.
      // replica.poll() fires without await during mount(), so subscription
      // updates can arrive after idle() resolves, scheduling more work.
      await storageManager.synced();
      await runtime.idle();
    });
    await initializationBudgetSettlement;
    initializationBudgetSettlement = undefined;

    // 4. Get the tests array from pattern output (the reserved [TESTS] key)
    const testsCell = await withPhase(
      ["runTestPattern", "testsCell"],
      () => patternResult.key(TESTS) as Cell<unknown>,
    );
    const testSteps = await withPhase(
      ["runTestPattern", "testsValue"],
      () => testsCell.asSchema(testStepListSchema).get(),
    );

    // Validate it's an array
    if (!Array.isArray(testSteps)) {
      throw new Error(
        "Test pattern must return { [TESTS]: TestStep[] }. Got: " +
          toDebugKindString(testSteps),
      );
    }

    // Check for allowRuntimeErrors, expectNonIdempotent, and console opt-out flags
    const allowRuntimeErrors = await withPhase(
      ["runTestPattern", "allowRuntimeErrors"],
      async () =>
        await (patternResult.key("allowRuntimeErrors") as Cell<unknown>)
          .pull() === true,
    );
    const expectRuntimeErrors = await withPhase(
      ["runTestPattern", "expectRuntimeErrors"],
      async () =>
        await (patternResult.key("expectRuntimeErrors") as Cell<unknown>)
          .pull() as boolean | number | undefined,
    );
    const expectNonIdempotent = await withPhase(
      ["runTestPattern", "expectNonIdempotent"],
      async () =>
        await (patternResult.key("expectNonIdempotent") as Cell<unknown>)
          .pull() === true,
    );
    const allowConsoleErrors = await withPhase(
      ["runTestPattern", "allowConsoleErrors"],
      async () =>
        await (patternResult.key("allowConsoleErrors") as Cell<unknown>)
          .pull() === true,
    );
    const allowConsoleWarnings = await withPhase(
      ["runTestPattern", "allowConsoleWarnings"],
      async () =>
        await (patternResult.key("allowConsoleWarnings") as Cell<unknown>)
          .pull() === true,
    );

    if (options.verbose) {
      console.log(`  Found ${testSteps.length} test steps`);
      printLoggerStats(
        performance.now() - startTime,
        false,
        "Setup",
        options.statsInclude,
      );
      printSettleStats(runtime.scheduler.getSettleStats());
      resetAllCountBaselines();
      resetAllTimingBaselines();
    }

    let settlementFailed = false;
    const settleRuntime = async (stepLabel: string): Promise<void> => {
      await withPhase(
        ["runTestPattern", "step", stepLabel, "settle"],
        async () => {
          for (let settle = 0; settle < MAX_SETTLE_ROUNDS; settle++) {
            const iterStart = performance.now();
            await withPhase(
              [
                "runTestPattern",
                "step",
                stepLabel,
                "settle",
                `iter-${settle}`,
                "idle",
              ],
              () => runtime.idle(),
            );
            await withPhase(
              [
                "runTestPattern",
                "step",
                stepLabel,
                "settle",
                `iter-${settle}`,
                "synced",
              ],
              () => storageManager.synced(),
            );
            const totalMs = performance.now() - iterStart;
            if (options.verbose && totalMs > 1) {
              console.log(`      settle[${settle}]: ${fmtMs(totalMs)}`);
            }
            // If both resolved nearly instantly, the system is settled.
            // synced() has ~1ms of overhead even when idle, so use 2ms.
            if (settle > 0 && totalMs < 2) break;
          }
          await withPhase(
            ["runTestPattern", "step", stepLabel, "settle", "finalIdle"],
            () => runtime.idle(),
          );
        },
      ).catch((error) => {
        settlementFailed = true;
        throw error;
      });
    };

    // Explicit `{ settle: true }` test step: in addition to the light per-action
    // settle above, wait for ALL in-flight async builtin work — the sqlite query
    // RPC + result writeback, fetch / llm calls — via `runtime.settled()`. Only
    // work something has already read is in flight; a built-in nothing has read
    // yet has not started, and the assertion that first reads it waits for it
    // on its own. The step is for a point the author names — before an action
    // that must see the work of an earlier one landed, say.
    const settleFully = async (stepIndex: number): Promise<void> => {
      await withPhase(
        ["runTestPattern", "step", `settle_${stepIndex}`, "settled"],
        () => runtime.settled(),
      ).catch((error) => {
        settlementFailed = true;
        throw error;
      });
    };

    // 5. Process tests sequentially
    const results: TestResult[] = readBudgets === undefined
      ? []
      : budgetResults;
    if (readBudgets !== undefined) {
      initializationBudgetSettlement = runtime.settled(Infinity);
      await initializationBudgetSettlement;
      initializationBudgetPending = false;
      for (
        const error of checkBudget("initialization", readBudgets.initialization)
      ) {
        results.push({
          name: "initialization read budget",
          passed: false,
          afterAction: null,
          error,
          durationMs: 0,
        });
      }
    }
    let lastActionIndex: number | null = null;
    let assertionCount = 0;
    let actionCount = 0;
    let renderCount = 0;

    if (readCost !== undefined) {
      for (
        const line of readCost.format(
          "initialization",
          options.statsActionLimit ?? 10,
        )
      ) console.log(line);
    }
    for (let i = 0; i < testSteps.length; i++) {
      readCost?.clear();
      budgetMeasurement.clear();
      if (options.verbose) {
        resetAllCountBaselines();
        resetAllTimingBaselines();
      }
      const itemStart = performance.now();
      const stepCell = testSteps[i] as HarnessTestStepCell;
      const stepValue = stepCell.asSchema(testStepPeekSchema)
        .get() as HarnessTestStepMeta;

      // Check which discriminant this step carries.
      const isAction = Object.hasOwn(stepValue, "action");
      const isAssertion = Object.hasOwn(stepValue, "assertion");
      const isRender = Object.hasOwn(stepValue, "render");
      const isSettle = Object.hasOwn(stepValue, "settle");
      const isMarker = Object.hasOwn(stepValue, "label") ||
        Object.hasOwn(stepValue, "await");

      // A multi-user marker in a single-user run: inert, and transparent to
      // the reported results.
      if (isMarker) continue;
      const stepBudget = readBudgetForStep(
        readBudgets,
        stepValue.readBudget,
        i + 1,
      );
      let stepFailed = false;
      settlementFailed = false;
      try {
        // `{ settle: true }` step: wait for FULL settlement (scheduler + storage +
        // in-flight async builtin I/O — sqlite query RPC + writeback, fetch / llm)
        // before the next step. A test inserts this before an assertion that reads
        // an async-builtin result so it never observes a half-settled state. The
        // step is transparent: it produces no result. A settlement error
        // propagates to the outer handler and fails the whole run.
        if (isSettle) {
          try {
            if (!stepValue.skip) await settleFully(i);
          } finally {
            printReadCost(`settle_${i}`, itemStart);
            printStepTimings(`settle_${i}`, itemStart);
          }
          continue;
        }

        // `{ render: subject[UI] }` is a headless, per-step demand window. Run
        // the VDOM through the worker reconciler, discard its DOM
        // operations, wait for all recursively discovered UI cells, then remove
        // the demand before advancing to the next step.
        if (isRender) {
          renderCount++;
          const renderName = `render_${renderCount}`;
          try {
            if (!stepValue.skip) {
              await withPhase(
                ["runTestPattern", "step", renderName, "materialize"],
                () =>
                  materializeTestVDOM(
                    stepCell.key("render") as Cell<unknown>,
                    () => settleRuntime(renderName),
                  ),
              );
              if (options.verbose) console.log(`  ◇ ${renderName}`);
            } else if (options.verbose) {
              console.log(`  ⊘ ${renderName} (skipped)`);
            }
          } finally {
            printReadCost(renderName, itemStart);
            printStepTimings(renderName, itemStart);
          }
          continue;
        }

        if (!isAction && !isAssertion) {
          throw new Error(
            `Test step at index ${i} must have an 'action', 'assertion', ` +
              debugStr`'render', 'settle', 'label', or 'await' key. Got: $quote,long${
                Object.keys(stepCell.get() as object)
              }`,
          );
        }

        // Handle skipped steps
        if (stepValue.skip) {
          if (isAction) {
            actionCount++;
            const actionName = `action_${actionCount}`;
            if (options.verbose) {
              console.log(`  ⊘ ${actionName} (skipped)`);
            }
          } else {
            assertionCount++;
            const assertionName = `assertion_${assertionCount}`;
            const suffix = lastActionIndex !== null
              ? ` (after action_${actionCount})`
              : "";
            results.push({
              name: assertionName,
              passed: true,
              skipped: true,
              afterAction: lastActionIndex !== null
                ? `action_${actionCount}`
                : null,
              durationMs: 0,
            });
            if (options.verbose) {
              console.log(`  ⊘ ${assertionName}${suffix} (skipped)`);
            }
          }
          continue;
        }

        if (isAction) {
          // It's an action - invoke it
          actionCount++;
          lastActionIndex = i;
          currentActionIndex = i;
          const actionName = `action_${actionCount}`;

          if (options.verbose) {
            console.log(`  → Running ${actionName}...`);
          }

          // Snapshot action stats before running (for delta tracking)
          const statsThreshold = options.statsThreshold ?? 5000;
          let preRunCounts: Map<string, number> | undefined;
          if (options.verbose) {
            preRunCounts = new Map();
            for (const node of runtime.scheduler.getGraphSnapshot().nodes) {
              if (node.stats) {
                preRunCounts.set(node.id, node.stats.runCount);
              }
            }
          }

          // Get the action stream via .key()
          const actionStream = await withPhase(
            ["runTestPattern", "step", actionName, "stream"],
            () => actionStreamForStep(stepCell),
          );

          // Send the step's event (undefined for plain void actions), wrapped
          // with renderer-trusted provenance when the step declares `trustedUi`.
          await withPhase(
            ["runTestPattern", "step", actionName, "send"],
            () => {
              actionStream.send(
                buildActionEvent(stepValue.event, stepValue.trustedUi),
              );
            },
          );

          // Wait for idle, then settle commits and re-idle.
          // Optimistic commits can fail (CAS conflicts), causing rollbacks
          // and reactive re-scheduling. We loop idle→synced until both
          // resolve quickly (< 1ms), indicating quiescence. Max iterations
          // as a safety net against infinite loops.
          try {
            await settleRuntime(actionName);
          } catch (err) {
            results.push({
              name: actionName,
              passed: false,
              afterAction: null,
              error: err instanceof Error ? err.message : String(err),
              durationMs: performance.now() - itemStart,
            });
          }

          // Print per-action run deltas for slow actions
          if (
            options.verbose && preRunCounts &&
            (performance.now() - itemStart > statsThreshold ||
              statsThreshold === 0)
          ) {
            const postSnapshot = runtime.scheduler.getGraphSnapshot();
            const deltas: { id: string; preview?: string; delta: number }[] =
              [];
            const seen = new Set<string>();
            for (const node of postSnapshot.nodes) {
              if (!node.stats || seen.has(node.id)) continue;
              seen.add(node.id);
              const pre = preRunCounts.get(node.id) ?? 0;
              const delta = node.stats.runCount - pre;
              if (delta > 0) {
                deltas.push({
                  id: node.id,
                  preview: node.preview,
                  delta,
                });
              }
            }
            if (deltas.length > 0) {
              deltas.sort((a, b) => b.delta - a.delta);
              const totalDelta = deltas.reduce((s, d) => s + d.delta, 0);
              const actionLimit = options.statsActionLimit ?? 10;
              console.log(
                `    ⟳ ${totalDelta} scheduler runs across ${deltas.length} actions:`,
              );
              // Build reads/writes lookup from post-snapshot
              const nodeInfo = new Map<
                string,
                { reads?: string[]; writes?: string[] }
              >();
              for (const node of postSnapshot.nodes) {
                if (!nodeInfo.has(node.id)) {
                  nodeInfo.set(node.id, {
                    reads: node.reads,
                    writes: node.writes,
                  });
                }
              }
              // Helper to shorten cell paths: did:key:z6Mk.../of:fid1:abc.../value/foo → …abc.../value/foo
              const shortenPath = (r: string): string => {
                // Format: did:key:.../of:fid1:abc.../path/parts
                const ofIdx = r.indexOf("/of:");
                if (ofIdx < 0) return r.length > 40 ? "…" + r.slice(-39) : r;
                const afterOf = r.slice(ofIdx + 4);
                const slashIdx = afterOf.indexOf("/");
                if (slashIdx < 0) return "…" + afterOf.slice(-20);
                const entityId = afterOf.slice(0, slashIdx);
                const path = afterOf.slice(slashIdx);
                const shortEntity = entityId.length > 10
                  ? entityId.slice(0, 8) + "…"
                  : entityId;
                return shortEntity + path;
              };
              // Collect all entity IDs read by re-triggered actions
              const entityReadCounts = new Map<string, number>();
              for (const d of deltas) {
                const info = nodeInfo.get(d.id);
                if (info?.reads) {
                  for (const r of info.reads) {
                    // Extract entity: everything between /of: and the next /
                    const ofIdx = r.indexOf("/of:");
                    if (ofIdx < 0) continue;
                    const afterOf = r.slice(ofIdx + 4);
                    const slashIdx = afterOf.indexOf("/");
                    const entity = slashIdx < 0
                      ? afterOf
                      : afterOf.slice(0, slashIdx);
                    const path = slashIdx < 0 ? "" : afterOf.slice(slashIdx);
                    const key = entity.slice(0, 8) + "…" + path;
                    entityReadCounts.set(
                      key,
                      (entityReadCounts.get(key) ?? 0) + d.delta,
                    );
                  }
                }
              }

              for (const d of deltas.slice(0, actionLimit)) {
                const label = d.preview
                  ? d.preview.split("\n")[0].trim().slice(0, 50)
                  : d.id;
                const info = nodeInfo.get(d.id);
                const reads = info?.reads;
                const writes = info?.writes;
                // Show non-schema reads (skip the first entry which is typically the schema query)
                const nonSchemaReads = reads?.filter((r) =>
                  !r.includes("%22query%22")
                ) ?? [];
                const rStr = nonSchemaReads.length > 0
                  ? ` r:[${
                    nonSchemaReads.slice(0, 3).map(shortenPath).join(", ")
                  }${
                    nonSchemaReads.length > 3
                      ? ` +${nonSchemaReads.length - 3}`
                      : ""
                  }]`
                  : reads && reads.length > 0
                  ? ` r:[schema-query +${reads.length - 1}]`
                  : "";
                const wStr = writes && writes.length > 0
                  ? ` w:[${writes.slice(0, 2).map(shortenPath).join(", ")}${
                    writes.length > 2 ? ` +${writes.length - 2}` : ""
                  }]`
                  : "";
                console.log(
                  `      ${
                    String(d.delta).padStart(4)
                  }× ${label}${rStr}${wStr}`,
                );
              }

              // Show top read entities across all re-triggered actions
              const topReads = [...entityReadCounts.entries()]
                .filter(([k]) => !k.includes("%22query%22"))
                .sort((a, b) => b[1] - a[1]);
              if (topReads.length > 0) {
                console.log(`    📖 Most-read entities:`);
                for (const [entity, count] of topReads.slice(0, 5)) {
                  console.log(`      ${String(count).padStart(4)}× ${entity}`);
                }
              }
              if (deltas.length > actionLimit) {
                const rest = deltas.slice(actionLimit).reduce(
                  (s, d) => s + d.delta,
                  0,
                );
                console.log(
                  `      ${String(rest).padStart(4)}× (${
                    deltas.length - actionLimit
                  } more actions)`,
                );
              }
            }
          }
        } else {
          // It's an assertion - check the boolean value
          assertionCount++;
          const assertionName = `assertion_${assertionCount}`;

          let passed = false;
          let error: string | undefined;

          const assertionCell = () =>
            stepCell.key("assertion") as Cell<unknown>;
          const evaluateAssertion = async (): Promise<
            { passed: boolean; error?: string }
          > => {
            try {
              const value = await assertionCell().pull();
              // An `assert(...)` assertion carries the operands recorded while
              // the condition ran, so a failure names them and their values.
              return assertionOutcome(value);
            } catch (err) {
              return {
                passed: false,
                error: `Error reading assertion: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              };
            }
          };

          // An asynchronous built-in — a fetch, a model call, a query — is a
          // computation that runs only while something demands its result, so
          // demanding the assertion is what starts one. Hold that demand while
          // waiting for the work it set going, which is what keeps the
          // built-in's cascade alive long enough to reach the assertion, and
          // read once. With nothing in flight the wait returns at once. The
          // read is the only one, so a value arriving after it is reported as
          // a failure rather than waited out.
          let releaseDemand: (() => void) | undefined;
          try {
            releaseDemand = assertionCell().sink(() => {});
            await withPhase(
              ["runTestPattern", "step", assertionName, "asyncWork"],
              () => runtime.settled(),
            );
            ({ passed, error } = await withPhase(
              ["runTestPattern", "step", assertionName, "evaluate"],
              () => evaluateAssertion(),
            ));
          } catch (err) {
            passed = false;
            error = err instanceof Error ? err.message : String(err);
          } finally {
            releaseDemand?.();
          }

          results.push({
            name: assertionName,
            passed,
            afterAction: lastActionIndex !== null
              ? `action_${actionCount}`
              : null,
            error,
            durationMs: performance.now() - itemStart,
          });

          if (options.verbose) {
            const status = passed ? "✓" : "✗";
            const suffix = lastActionIndex !== null
              ? ` (after action_${actionCount})`
              : "";
            console.log(`  ${status} ${assertionName}${suffix}`);
          }
        }

        // Print delta stats for slow steps
        if (options.verbose) {
          const statsThreshold = options.statsThreshold ?? 5000;
          const stepDuration = performance.now() - itemStart;
          if (stepDuration > statsThreshold || statsThreshold === 0) {
            printReadCost(
              isAction
                ? `action_${actionCount}`
                : `assertion_${assertionCount}`,
              itemStart,
            );
            const stepLabel = isAction
              ? `action_${actionCount}`
              : `assertion_${assertionCount}`;
            printLoggerStats(
              performance.now() - startTime,
              true,
              `${stepLabel} took ${fmtMs(stepDuration)}`,
              options.statsInclude,
            );
            printSettleStats(runtime.scheduler.getSettleStats());
          }
        }
      } catch (error) {
        stepFailed = true;
        throw error;
      } finally {
        if (readBudgets !== undefined) {
          if (settlementFailed) {
            budgetFailures.push(
              `step ${
                i + 1
              }: read budget measurement incomplete after a settlement failure`,
            );
          }
          const settled = !settlementFailed &&
            await runtime.settled(Infinity).then(
              () => true,
              (error) => {
                if (!stepFailed) throw error;
                budgetFailures.push(
                  `step ${
                    i + 1
                  }: read budget measurement incomplete because settlement failed: ${
                    String(error)
                  }`,
                );
                return false;
              },
            );
          for (
            const error of settled
              ? checkBudget(
                `${stepValue.skip ? "skipped " : ""}step ${i + 1}`,
                stepValue.skip ? undefined : stepBudget,
              )
              : []
          ) {
            results.push({
              name: `step ${i + 1} read budget`,
              passed: false,
              afterAction: null,
              error,
              durationMs: performance.now() - itemStart,
            });
          }
        }
      }
      if (readBudgets !== undefined && settlementFailed) {
        throw new Error(
          `step ${
            i + 1
          }: read budget measurement incomplete after a settlement failure`,
        );
      }
    }

    // Print action stats table (sorted by total time, like the shell debug UI)
    if (options.verbose) {
      printActionStatsTable(runtime);
    }
    if (options.storageStats) {
      printStorageStats(
        performance.now() - startTime,
        options.storageStatsLimit ?? 16,
      );
    }

    // Collect idempotency violations detected during normal execution
    const nonIdempotent = runtime.getIdempotencyViolations()
      .map((r) => {
        const id = r.actionInfo?.patternName ?? r.actionId;
        return r.differingWriteKeys.length
          ? `${id} (differing writes: ${r.differingWriteKeys.join(", ")})`
          : id;
      });

    // Channel 2: compute logger error/warn deltas since the run-phase snapshot
    // and append any new activity to the console capture lists.
    appendLoggerDeltaMessages(
      loggerCountsBeforeRun,
      consoleErrors,
      consoleWarnings,
    );

    const errorMessages = [
      ...runtimeErrors.map((e) => String(e)),
      ...continuousUiErrors.map((e) => `[continuous $UI] ${String(e)}`),
    ];
    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
      allowRuntimeErrors,
      expectRuntimeErrors,
      nonIdempotent,
      expectNonIdempotent,
      consoleErrors,
      allowConsoleErrors,
      consoleWarnings,
      allowConsoleWarnings,
    };
  } catch (err) {
    let errorMessage = err instanceof Error ? err.message : String(err);
    if (initializationBudgetPending) {
      try {
        await (initializationBudgetSettlement ?? runtime.settled(Infinity));
        checkBudget("initialization", readBudgets?.initialization);
      } catch (error) {
        budgetFailures.push(
          `initialization: read budget measurement incomplete because settlement failed: ${
            String(error)
          }`,
        );
      }
    }
    if (budgetFailures.length > 0) {
      errorMessage += `\n${budgetFailures.join("\n")}`;
    }
    const functionalFailures = budgetResults.filter((result) =>
      !result.passed && !result.name.endsWith("read budget")
    );
    if (functionalFailures.length > 0) {
      errorMessage += `\n${
        functionalFailures.map((result) =>
          `${result.name}: ${result.error ?? "assertion failed"}`
        ).join("\n")
      }`;
    }

    // Add helpful hint for import resolution errors when --root wasn't provided
    if (
      (errorMessage.includes("escapes the program root") ||
        (errorMessage.includes("No such file or directory") &&
          errorMessage.includes("readfile"))) &&
      !options.root
    ) {
      errorMessage +=
        "\n    Hint: If the test imports from sibling directories (e.g., ../shared/), use --root to specify a common ancestor.";
    }

    const errorMessages = [
      ...runtimeErrors.map((e) => String(e)),
      ...continuousUiErrors.map((e) => `[continuous $UI] ${String(e)}`),
    ];
    return {
      path: testPath,
      results: budgetResults,
      totalDurationMs: performance.now() - startTime,
      navigations,
      runtimeErrors: errorMessages,
      nonIdempotent: [],
      error: errorMessage,
      consoleErrors,
      consoleWarnings,
    };
  } finally {
    runtime.telemetry.removeEventListener("telemetry", onReadCost);
    if (
      patternCoverage && options.patternCoverageDir &&
      writeLocalPatternCoverage
    ) {
      await withPhase(
        ["runTestPattern", "coverage", "write"],
        () =>
          writePatternCoverageLcov(
            patternCoverage,
            patternCoverageOutputPath(options.patternCoverageDir!, testPath),
            { root },
          ),
      ).catch((error) => {
        console.error(
          `[cf test] failed to write pattern coverage for ${testPath}: ${
            formatError(error)
          }`,
        );
      });
    }
    // 6. Cleanup
    // The run is over, so pattern-code output during teardown is no longer the
    // test's behavior. This matters more than it used to: `engine.dispose()`
    // was the FIRST cleanup step and killed the SES runtime immediately, while
    // `Runtime.dispose()` reaches `harness.dispose()` only at the end — so the
    // drain below now runs with pattern code still able to log. Both capture
    // lists are returned BY REFERENCE, so a late push would still fail the run.
    consoleCaptureActive = false;
    continuousUiCancel?.();
    continuousUiCancel = undefined;
    // Await disposal before returning so the runtime has stopped writing when
    // a caller reads its store. A caller-supplied store stays open. Log failures
    // before raising them: a throw from `finally` replaces the pending result,
    // which may already contain step failures.
    const teardown = withPhase(
      ["runTestPattern", "cleanup", "runtimeDispose"],
      () =>
        runtime.dispose({ closeStorage: options.storageHost === undefined }),
    );
    await teardown.catch((error) => {
      console.error(
        `[cf test] teardown failed for ${testPath}: ${formatError(error)}`,
      );
      throw error;
    });
  }
}

/**
 * Compiles each file's program the way `runTests()` would, and runs none of
 * them. What it leaves behind is the compile byte cache: with
 * `CF_COMPILE_CACHE_FILE` set, every module the files reach is in that file
 * once the process exits, so a later run of the same files compiles nothing.
 * Returns the files whose compile failed. Each of those is reported again,
 * with its error, by the run that tests it; this pass only says which.
 * `compileOne` is the per-file run, `runTestPattern` unless a test supplies
 * a stand-in.
 */
export async function compileTestPatterns(
  paths: readonly string[],
  options: TestRunnerOptions = {},
  compileOne: typeof runTestPattern = runTestPattern,
): Promise<{ compiled: number; failed: string[] }> {
  const failed: string[] = [];
  const started = performance.now();
  for (const testPath of paths) {
    let error: string | undefined;
    try {
      error = (await compileOne(testPath, { ...options, compileOnly: true }))
        .error;
    } catch (caught) {
      error = formatError(caught);
    }
    if (error === undefined) {
      console.log(`  compiled ${basename(testPath)}`);
    } else {
      failed.push(testPath);
      console.log(`  ✗ ${basename(testPath)}: ${error}`);
    }
  }
  const compiled = paths.length - failed.length;
  console.log(
    `\n${compiled} compiled, ${failed.length} failed (${
      Math.round(performance.now() - started)
    }ms)`,
  );
  return { compiled, failed };
}

/**
 * Run all test patterns in a directory or a single test file.
 */
export async function runTests(
  pathOrPaths: string | string[],
  options: TestRunnerOptions = {},
): Promise<{
  passed: number;
  failed: number;
  skipped: number;
  results: TestRunResult[];
}> {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  // Emission is process-global, so a run that turns it on owes the process its
  // previous state back — otherwise a later `runTests()` without the option
  // keeps emitting into a buffer nobody will read.
  const priorMeasures = getTimingMeasuresState();
  const captured: CapturedMeasure[] | undefined = options.timingMeasuresOut
    ? []
    : undefined;
  if (options.timingMeasuresOut) {
    // Draining per file means the buffer never holds more than one file's
    // worth, so the default ceiling — which exists to bound a process that
    // never drains — would only truncate the capture for no benefit.
    setTimingMeasuresEnabled(true, { cap: Number.MAX_SAFE_INTEGER });
  }
  const allResults: TestRunResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  // One record per file, spooled with the file's final verdict — the one
  // that includes the runtime-error, console, and idempotence checks below,
  // not just the assertion results. Written only for a caller that asked
  // for records, and inert unless CF_TEST_RECORDS_DIR is set; the
  // integration orchestrator clears that variable for its cf children and
  // records from its own clock instead.
  const recordsFragment = options.recordResults === true
    ? FragmentWriter.openForRun()
    : undefined;
  const recordFile = (testPath: string, failed: boolean, durationMs: number) =>
    recordsFragment?.append({
      line: "record",
      test: {
        k: "pattern",
        s: "patterns",
        n: repositoryRelativePath(testPath),
      },
      outcome: failed ? "fail" : "pass",
      durationMs: Math.round(durationMs),
    });

  for (const testPath of paths) {
    console.log(`\n${basename(testPath)}`);
    const failedBefore = totalFailed;
    const fileStarted = performance.now();

    // `runTestPattern` RAISES a teardown that did not complete, which is the
    // right contract for a direct caller — the vintage capture is about to read
    // what the run wrote, so it must refuse rather than snapshot. A multi-file
    // run is the other case: one wedged file is a failure of that file, not a
    // reason the remaining ones go unreported. Counted and skipped past, so the
    // exit code is still non-zero.
    let result: TestRunResult;
    try {
      result = await runTestPattern(testPath, options);
    } catch (error) {
      totalFailed++;
      console.log(`  ✗ ${formatError(error)}`);
      recordFile(testPath, true, performance.now() - fileStarted);
      continue;
    } finally {
      // Before the next file clears the timeline, and on the failure path too:
      // a file that wedged is often the one whose measures are wanted.
      if (captured) drainTimingMeasures(captured);
    }
    allResults.push(result);

    if (result.error) {
      console.log(`  ✗ Error: ${result.error}`);
      totalFailed++;
    } else {
      for (const test of result.results) {
        if (test.skipped) {
          totalSkipped++;
        } else if (test.passed) {
          totalPassed++;
        } else {
          totalFailed++;
        }

        const status = test.skipped ? "⊘" : test.passed ? "✓" : "✗";
        const suffix = test.afterAction ? ` (after ${test.afterAction})` : "";
        const skipLabel = test.skipped ? " (skipped)" : "";
        console.log(`  ${status} ${test.name}${suffix}${skipLabel}`);
        if (!test.passed && !test.skipped && test.error) {
          console.log(indentLines(test.error, "    "));
        }
      }

      // Print navigation summary if any navigations occurred
      if (result.navigations.length > 0) {
        console.log(
          `  📍 ${result.navigations.length} navigation(s): ${
            result.navigations
              .map((n) => n.name ?? "(unnamed)")
              .join(", ")
          }`,
        );
      }

      // Report non-idempotent computations
      if (result.nonIdempotent.length > 0) {
        if (result.expectNonIdempotent) {
          console.log(
            `  ⊘ ${result.nonIdempotent.length} non-idempotent computation(s) (expected)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.nonIdempotent.length} non-idempotent computation(s):`,
          );
          for (const name of result.nonIdempotent) {
            console.log(`    ${name}`);
          }
        }
      } else if (result.expectNonIdempotent) {
        // The flag asserts the detector fires — passing silently here would
        // let detection regressions defang the non-idempotent fixtures.
        totalFailed++;
        console.log(
          "  ✗ expected non-idempotent computation(s), none detected",
        );
      }

      // Report runtime errors. An expectation both tolerates the captured
      // errors and REQUIRES them (exact count when numeric): the flag asserts
      // the loudness fires, so silently-absorbed rejections fail here.
      const expectedErrors = result.expectRuntimeErrors;
      if (expectedErrors !== undefined && expectedErrors !== false) {
        const want = typeof expectedErrors === "number"
          ? expectedErrors
          : undefined;
        const got = result.runtimeErrors.length;
        if (got === 0 || (want !== undefined && got !== want)) {
          totalFailed++;
          console.log(
            `  ✗ expected ${want ?? "some"} runtime error(s), saw ${got}`,
          );
        } else {
          console.log(`  ⊘ ${got} runtime error(s) (expected)`);
        }
      } else if (result.runtimeErrors.length > 0) {
        if (result.allowRuntimeErrors) {
          console.log(
            `  ⊘ ${result.runtimeErrors.length} runtime error(s) (allowed)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.runtimeErrors.length} runtime error(s) during test:`,
          );
          for (const msg of result.runtimeErrors) {
            // Show first line of each error, truncated
            const firstLine = msg.split("\n")[0];
            const truncated = firstLine.length > 120
              ? firstLine.slice(0, 120) + "..."
              : firstLine;
            console.log(`    ${truncated}`);
          }
        }
      }

      // Report console errors (channel 1: console.error; channel 2: logger errors)
      if (result.consoleErrors && result.consoleErrors.length > 0) {
        if (result.allowConsoleErrors) {
          console.log(
            `  ⊘ ${result.consoleErrors.length} console error(s) (allowed)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.consoleErrors.length} console error(s) during test:`,
          );
          for (const msg of result.consoleErrors) {
            const truncated = msg.length > 120
              ? msg.slice(0, 120) + "..."
              : msg;
            console.log(`    ${truncated}`);
          }
        }
      }

      // Report console warnings (channel 1: console.warn; channel 2: logger warns)
      if (result.consoleWarnings && result.consoleWarnings.length > 0) {
        if (result.allowConsoleWarnings) {
          console.log(
            `  ⊘ ${result.consoleWarnings.length} console warning(s) (allowed)`,
          );
        } else {
          totalFailed++;
          console.log(
            `  ✗ ${result.consoleWarnings.length} console warning(s) during test:`,
          );
          for (const msg of result.consoleWarnings) {
            const truncated = msg.length > 120
              ? msg.slice(0, 120) + "..."
              : msg;
            console.log(`    ${truncated}`);
          }
        }
      }
    }

    recordFile(testPath, totalFailed > failedBefore, result.totalDurationMs);
  }
  recordsFragment?.close();

  try {
    if (options.timingMeasuresOut && captured) {
      await writeTimingMeasures(options.timingMeasuresOut, captured);
    }
  } finally {
    // Both halves of what was borrowed, and in a `finally` because a failed
    // write must not strand them: the switch left on costs every later run in
    // the process, and the raised ceiling left behind removes the retention
    // bound entirely.
    setTimingMeasuresEnabled(priorMeasures.enabled, { cap: priorMeasures.cap });
  }

  // Summary
  const totalTime = allResults.reduce((sum, r) => sum + r.totalDurationMs, 0);
  const parts = [`${totalPassed} passed`, `${totalFailed} failed`];
  if (totalSkipped > 0) {
    parts.push(`${totalSkipped} skipped`);
  }
  console.log(`\n${parts.join(", ")} (${Math.round(totalTime)}ms)`);

  return {
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    results: allResults,
  };
}

/**
 * Discover test files in a directory.
 */
export async function discoverTestFiles(dir: string): Promise<string[]> {
  const testFiles: string[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".test.tsx")) {
        testFiles.push(`${dir}/${entry.name}`);
      } else if (entry.isDirectory) {
        // Recursively search subdirectories
        const subFiles = await discoverTestFiles(`${dir}/${entry.name}`);
        testFiles.push(...subFiles);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return testFiles;
}
