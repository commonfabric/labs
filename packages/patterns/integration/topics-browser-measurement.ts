/**
 * Browser-tier measurement of one operation on a Topics board, for
 * `docs/plans/topics-computation-cost.md`: reactive-body reads for the board's
 * pivot and for each topic's backlink, comment-count, and activity lifts,
 * scheduler graph size, and timing split between the main thread and the
 * worker as far as the shell's timing records that split.
 *
 * `measureTopicsReads()` turns telemetry and body read accounting on around the
 * operation, so its elapsed time carries their overhead.
 * `timeTopicsOperation()` turns both off, for an interval a benchmark times.
 * Neither records transaction-attempt reads; {@link ATTEMPT_READS_NOTE} says
 * why. Both need the runtime client that signing in creates, so neither
 * brackets cold initialization, and a sample whose client is replaced during
 * the operation fails.
 *
 * A measured sample attributes runs to lifts by position, against a
 * {@link TopicsProgram} that {@link prepareTopicsProgram} compiles from the
 * sources the board was seeded from. It requires the board to run that
 * program's module identities, without coverage instrumentation, and each
 * lift's preview to equal the first characters of its compiled text. The
 * decisions that need no page are in `topics-browser-measurement-core.ts`.
 */

import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import type { Page } from "@commonfabric/integration";
import {
  experimentalOptionsFromEnv,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { RequestType, type RuntimeClient } from "@commonfabric/runtime-client";

import { describeThrown } from "../../integration/describe-thrown.ts";
import { settleView, waitForRuntimeIdle } from "./cfc-browser-helpers.ts";
import type { TopicsBrowserPosture } from "./topics-browser-posture.ts";
import {
  compiledLiftText,
  type CompiledTopicsLift,
  confirmSampledLifts,
  locateLift,
  parseSrc,
  requireNoCoverageCollector,
  runThenStop,
  timingDelta,
  type TimingRow,
  type TimingSnapshot,
  type TopicsLift,
  type TopicsLiftSite,
  workerRunCount,
} from "./topics-browser-measurement-core.ts";

/** Why no sample carries transaction-attempt reads. */
export const ATTEMPT_READS_NOTE =
  "Body reads only: transaction-attempt reads come from the headless tier, " +
  "because the runtime client's read-stats request enables body accounting " +
  "only.";

/** What the timing rows measure, and what no row measures. */
export const TIMING_NOTE =
  "Timing: a row sums spans that can overlap, so its total can exceed the " +
  "elapsed time. `vdomApply` is the main thread's " +
  "`vdom-applicator/apply-batch`, applying worker VDOM batches' operations " +
  "to the DOM. The other main-thread spans, some of which wait on the " +
  'worker, are listed under "Topics browser measurement" in ' +
  "`docs/development/BENCHMARKS.md`. Lit element updates, style, layout, " +
  "and paint have no timing of their own and fall only in the elapsed time.";

/** Why a timed interval reports no event commit error. */
export const COMMIT_ERRORS_NOTE =
  "Event commit errors: not observed with telemetry off. A measured sample of " +
  "the same operation, which the caller pairs with this one, checks them.";

const ACCOUNTING_ON_NOTE =
  "Read accounting and telemetry were on around this operation, so its " +
  "elapsed time and timing rows include their overhead: not a latency sample.";

const ACCOUNTING_OFF_NOTE =
  "Read accounting and telemetry were turned off before this interval, which " +
  "records no reads.";

const WORKER_RUNS_NOTE =
  "Worker runs: action runs the scheduler timed with `runSchedulerAction`'s " +
  "`scheduler/run` span, a lower bound when runs overlap.";

/**
 * The program root the topic board fixture deploys a board from, against which
 * a lift's module path is read.
 */
export const TOPICS_SOURCE_ROOT = join(import.meta.dirname!, "..");

/** The board's pivot, and the per-topic lifts that read it or report activity. */
export const TOPICS_LIFTS: readonly TopicsLift[] = [
  { name: "crossrefTable", module: "topics/main.tsx", role: "producer" },
  { name: "backlinksOf", module: "topics/topic.tsx", role: "consumer" },
  {
    name: "presentCommentCountOf",
    module: "topics/topic.tsx",
    role: "consumer",
  },
  { name: "lastActivityOf", module: "topics/topic.tsx", role: "consumer" },
];

/** The board's entry module, relative to the program root. */
const TOPICS_MAIN = "topics/main.tsx";

/** One module of a compiled Topics program. */
interface CompiledTopicsModule {
  /** Module path, grounded at the program root. */
  readonly filename: string;

  /** Content identity, which is the `<identity>` in a run's `src`. */
  readonly identity: string;

  /** The JavaScript the compiler emitted for it. */
  readonly js: string;
}

/** The Topics program compiled from the sources a board was seeded from. */
export interface TopicsProgram {
  /** Each named lift, with its authored site and its compiled text. */
  readonly lifts: readonly CompiledTopicsLift[];

  /** Content identity of each compiled Topics module, by `/<module>`. */
  readonly identities: ReadonlyMap<string, string>;
}

/** Counters summed over a set of completed runs. */
export interface ReadTotals {
  /** Completed runs carrying a read sample. */
  runs: number;

  /** Sum of the runs' `durationMs`. */
  durationMs: number;

  /** Sum of proxy accesses. */
  proxyAccesses: number;

  /** Largest proxy-access count of any one run. */
  maxProxyAccesses: number;

  /** Sum of stored-link traversal attempts. */
  linkResolutions: number;

  /** Sum of each run's distinct-document count, not a union across runs. */
  distinctDocuments: number;

  /** Sum of each run's registered dependency count. */
  registeredDependencies: number;
}

/** One named lift's totals over a measured operation. */
export interface TopicsLiftRow extends ReadTotals, TopicsLiftSite {
  /**
   * Whether an action's `src` named `/<module>`, in a graph snapshot taken
   * before or after the operation or in a run marker during it. A lift reports
   * `false`, with zero runs, only when no such `src` named the module's file
   * under any path.
   */
  readonly running: boolean;

  /**
   * The graph snapshot's preview of the implementation running at the lift's
   * site, which the helper confirmed equals the first characters of the lift's
   * compiled text. Absent for a lift that is not running.
   */
  readonly implementation?: string;
}

/** Scheduler graph size at one instant. */
export interface GraphSize {
  /** Scheduler actions. */
  readonly nodes: number;

  /** Dependency edges between them. */
  readonly edges: number;
}

/** Timing accumulated over an operation, less the helper's own requests. */
export interface TopicsTiming {
  /** The shell page's timing statistics, slowest total first. */
  readonly mainThread: readonly TimingRow[];

  /** The runtime worker's timing statistics, slowest total first. */
  readonly worker: readonly TimingRow[];

  /** The main thread's VDOM batch application; see {@link TIMING_NOTE}. */
  readonly vdomApply: TimingRow;
}

/** What every sample records. */
interface TopicsSampleBase {
  /** The caller's name for the operation. */
  readonly label: string;

  /**
   * What the deployment under measurement says about the posture it ran, and
   * where the shell's half of that was read from. A sample prints both, and
   * prints a deployment that declares no posture as `posture undeclared`
   * rather than as a mode, so no reader takes it for a measured one.
   */
  readonly posture: TopicsBrowserPosture;

  /** From starting the operation to a settled view over an idle runtime. */
  readonly elapsedMs: number;

  /** Graph size before and after the operation. */
  readonly graph: { readonly before: GraphSize; readonly after: GraphSize };

  /** Timing split between the main thread and the worker. */
  readonly timing: TopicsTiming;

  /** Statements about what the sample's figures include and exclude. */
  readonly notes: readonly string[];
}

/** An operation measured with telemetry and body read accounting on. */
export interface TopicsReadSample extends TopicsSampleBase {
  /** Read accounting was on for this sample. */
  readonly readAccounting: true;

  /** One row per named lift, in {@link TOPICS_LIFTS} order. */
  readonly lifts: readonly TopicsLiftRow[];

  /** Every run this sample could not place against a named lift. */
  readonly remaining: ReadTotals;

  /** Completed runs with no read sample, having started before accounting. */
  readonly runsWithoutReads: number;

  /**
   * Completed runs that carried a read sample but no authored source location,
   * and so could not be placed against a lift. Counted in
   * {@link TopicsReadSample.remaining} as well; reported here so that a sample
   * recording no lift runs says which kind of zero it is — one taken beside
   * runs it could not place, or one taken beside no runs at all.
   */
  readonly runsWithoutSource: number;

  /** Successful event-commit markers. */
  readonly eventCommits: number;

  /**
   * Whether the caller declared that the operation may complete no run
   * carrying an authored source location. A sample with this set and no such
   * run is a measured zero; without it such an operation fails instead, so the
   * two are never confused for one another.
   */
  readonly mayRunNothing: boolean;
}

/** An operation timed with telemetry and read accounting off. */
export interface TopicsTimedSample extends TopicsSampleBase {
  /** Read accounting was off for this sample. */
  readonly readAccounting: false;

  /** Telemetry and read accounting were turned off before the interval. */
  readonly accountingTurnedOff: true;

  /** Whether the caller declared that the operation may run nothing. */
  readonly mayRunNothing: boolean;

  /**
   * Action runs the worker's scheduler timed with `runSchedulerAction`'s
   * `scheduler/run` span. Runs that overlap share that span's timer, so this
   * is a lower bound.
   */
  readonly workerRuns: number;
}

/** Either kind of sample. */
export type TopicsSample = TopicsReadSample | TopicsTimedSample;

/** The operation a sample drives, and what to call it. */
export interface TopicsOperationOptions {
  /** Names the operation in the sample and in failures. */
  readonly label: string;

  /**
   * The posture the deployment under measurement runs, which labels the
   * sample. Read from the deployment once per benchmark run with
   * `readTopicsBrowserPosture()`, so a sample cannot be labeled with a mode
   * the run did not exercise.
   */
  readonly posture: TopicsBrowserPosture;

  /** Drives the page; the helper waits for the view and runtime afterward. */
  readonly operation: () => Promise<unknown>;
}

/** Options for {@link measureTopicsReads}. */
export interface MeasureTopicsReadsOptions extends TopicsOperationOptions {
  /** The program compiled from the sources the board was seeded from. */
  readonly program: TopicsProgram;

  /**
   * Declares that the operation may complete no run carrying an authored
   * source location. Without it, such an operation fails; with it, the sample
   * records the zero and says the caller declared it.
   *
   * It permits a zero rather than asserting one: an operation that does
   * complete such runs is attributed as usual, so a zero that stops being one
   * shows up as rows rather than being suppressed. It also reaches only this
   * one outcome. A run carrying a source location this helper cannot parse is
   * a sample that cannot be read rather than an absence of work, and fails
   * whether or not this is declared.
   */
  readonly mayRunNothing?: boolean;
}

/** The part of a `Deno.bench` context that brackets a timed interval. */
export interface TimedInterval {
  /** Starts the timed interval. */
  start(): void;

  /** Ends the timed interval. */
  end(): void;
}

/** Options for {@link timeTopicsOperation}. */
export interface TimeTopicsOperationOptions extends TopicsOperationOptions {
  /**
   * Started just before the operation, and ended at its settled boundary or
   * where the operation or the wait for that boundary throws.
   */
  readonly interval?: TimedInterval;

  /**
   * Declares that the operation may run nothing in the worker. Without it, a
   * timed operation that records no scheduler run fails.
   */
  readonly mayRunNothing?: boolean;
}

/**
 * Compiles the Topics program under `sourceRoot` the way the topic board
 * fixture deploys it, with that directory as the program root, on an emulated
 * runtime, and returns each named lift's authored site and compiled text with
 * the content identity of every compiled module under `/topics/`. A compile
 * takes about a second, so a caller prepares one program and passes it to
 * every {@link measureTopicsReads} call against boards seeded from those
 * sources.
 *
 * @throws If a module does not declare its lift as `locateLift()` requires, if
 *   the compiled program lacks a lift's module, or if a compiled module does
 *   not declare its lift as `compiledLiftText()` requires.
 */
export async function prepareTopicsProgram(
  sourceRoot: string = TOPICS_SOURCE_ROOT,
  lifts: readonly TopicsLift[] = TOPICS_LIFTS,
): Promise<TopicsProgram> {
  const modules = await compileTopicsProgram(sourceRoot);
  const identities = new Map(
    modules.filter((module) => module.filename.startsWith("/topics/"))
      .map((module) => [module.filename, module.identity]),
  );
  const texts = new Map<string, string>();
  const compiled: CompiledTopicsLift[] = [];
  for (const lift of lifts) {
    const module = `/${lift.module}`;
    const emitted = modules.find((candidate) => candidate.filename === module);
    if (emitted === undefined) {
      throw new Error(
        `Compiling \`${join(sourceRoot, TOPICS_MAIN)}\` produced no module ` +
          `\`${module}\``,
      );
    }
    const path = join(sourceRoot, lift.module);
    let text = texts.get(path);
    if (text === undefined) {
      text = await Deno.readTextFile(path);
      texts.set(path, text);
    }
    const { line, col } = locateLift(text, lift.name, path);
    compiled.push({
      ...lift,
      site: `${module}:${line}:${col}`,
      compiledText: compiledLiftText(emitted.js, lift.name, module),
    });
  }
  return { lifts: compiled, identities };
}

/**
 * Compiles the Topics program under `sourceRoot` the way the topic board
 * fixture deploys it, with that directory as the program root, on an emulated
 * runtime, and returns every module it emits. Helper for
 * {@link prepareTopicsProgram}.
 */
async function compileTopicsProgram(
  sourceRoot: string,
): Promise<CompiledTopicsModule[]> {
  const runtime = new Runtime(runtimePresets.localDev({
    apiUrl: new URL(import.meta.url),
    storageManager: StorageManager.emulate({
      as: await Identity.fromPassphrase("topics browser measurement"),
    }),
    experimental: experimentalOptionsFromEnv(Deno.env.get),
  }));
  try {
    const resolved = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: join(sourceRoot, TOPICS_MAIN), root: sourceRoot },
    );
    const { modules } = await runtime.harness.compileToRecordGraph(
      resolved,
      { noCheck: true },
    );
    return modules.map(({ filename, identity, js }) => ({
      filename,
      identity,
      js,
    }));
  } finally {
    await runtime.dispose();
  }
}

/**
 * Runs `operation` with telemetry and body read accounting on, and returns
 * each named lift's read totals with graph size and timing. Accounting is
 * enabled just before the operation and disabled once the view has settled
 * over an idle runtime, whether or not the operation succeeds. The page must
 * show a board seeded from the sources `program` was compiled from, whose
 * producer lift has to be running.
 *
 * @throws If the page's worker collects pattern coverage; if the sample's runs
 *   cannot be attributed to the lifts of `program`, as `confirmSampledLifts()`
 *   decides, each of whose messages names its cause; if the runtime client is
 *   replaced, after read accounting and telemetry are turned off on the client
 *   they were enabled on; or if the operation fails an event commit or raises
 *   a page error. It also throws when the operation completes no run carrying
 *   an authored source location, unless the caller declared `mayRunNothing`;
 *   that declaration reaches this one failure and none of the others, a run
 *   whose source location cannot be parsed among them. When the
 *   operation throws and disabling accounting or releasing the sample also
 *   fails, an `AggregateError` holds the operation's error first. The sample's
 *   hold on the page is released on every exit.
 */
export async function measureTopicsReads(
  page: Page,
  options: MeasureTopicsReadsOptions,
): Promise<TopicsReadSample> {
  const sites = options.program.lifts;
  const pageErrors = watchPageErrors(page);
  const token = crypto.randomUUID();
  try {
    const { value } = await runThenStop(async (): Promise<TopicsReadSample> => {
      requireNoCoverageCollector(await patternCoverageCollecting(page));
      await startSampling(page, token);
      const { value: measured, stopped: state } = await runThenStop(
        async () => {
          const before = await readRuntimeState(page, token);
          const startedAt = performance.now();
          await options.operation();
          await settleOperation(page);
          return { before, elapsedMs: performance.now() - startedAt };
        },
        () => stopSampling(page, token),
      );
      const after = await readRuntimeState(page, token);

      assertNoPageErrors(options.label, pageErrors.errors);
      if (state.eventCommitErrors.length > 0) {
        throw new Error(
          `${options.label}: ${state.eventCommitErrors.length} event commit(s) ` +
            `failed: ${state.eventCommitErrors.join("; ")}`,
        );
      }
      // Runs the sample could place: those whose marker carried a `src`. A run
      // without one is counted apart, because it is a different fact about the
      // operation from a run carrying a location this helper cannot read, and
      // only the first is waivable.
      const attributableRuns = Object.values(state.bySrc)
        .reduce((sum, totals) => sum + totals.runs, 0);
      const mayRunNothing = options.mayRunNothing ?? false;
      if (attributableRuns === 0 && !mayRunNothing) {
        throw new Error(
          `${options.label}: the measured operation completed no run carrying ` +
            "an authored source location; declare `mayRunNothing` for an " +
            "operation that may complete none",
        );
      }

      const { running, implementations } = confirmSampledLifts(
        sites,
        options.program.identities,
        [measured.before.actions, after.actions],
        Object.keys(state.bySrc),
      );
      const bySite = new Map(sites.map((lift) => [lift.site, {
        totals: emptyTotals(),
        implementation: implementations.get(lift.site),
      }]));
      const remaining = emptyTotals();
      addTotals(remaining, state.withoutSource);
      for (const [src, totals] of Object.entries(state.bySrc)) {
        const site = parseSrc(src)?.site;
        addTotals(
          (site === undefined ? undefined : bySite.get(site)?.totals) ??
            remaining,
          totals,
        );
      }
      return {
        label: options.label,
        posture: options.posture,
        readAccounting: true,
        elapsedMs: measured.elapsedMs,
        graph: { before: measured.before.graph, after: after.graph },
        timing: timingBetween(measured.before, after),
        lifts: sites.map((lift) => {
          const entry = bySite.get(lift.site)!;
          return {
            name: lift.name,
            module: lift.module,
            role: lift.role,
            site: lift.site,
            ...entry.totals,
            running: running.get(lift.site)!,
            implementation: entry.implementation,
          };
        }),
        remaining,
        runsWithoutReads: state.runsWithoutReads,
        runsWithoutSource: state.withoutSource.runs,
        eventCommits: state.eventCommits,
        mayRunNothing,
        notes: [ACCOUNTING_ON_NOTE, ATTEMPT_READS_NOTE, TIMING_NOTE],
      };
    }, () => releaseSample(page, token));
    return value;
  } finally {
    pageErrors.stop();
  }
}

/**
 * Turns telemetry and read accounting off, runs `operation`, and returns its
 * elapsed time, graph size, and timing. `interval`, when given, starts just
 * before the operation and ends at the settled boundary, or where the
 * operation or the wait for that boundary throws. Event commit errors are not
 * observed with telemetry off; {@link COMMIT_ERRORS_NOTE} says what checks them.
 *
 * @throws If the page raises an error; if the runtime client is replaced; if
 *   the worker's timing has no run span to count; or if the worker records no
 *   scheduler run and the caller did not declare `mayRunNothing`. When the
 *   operation throws and releasing the sample also fails, an `AggregateError`
 *   holds the operation's error first. The sample's hold on the page is
 *   released on every exit.
 */
export async function timeTopicsOperation(
  page: Page,
  options: TimeTopicsOperationOptions,
): Promise<TopicsTimedSample> {
  const pageErrors = watchPageErrors(page);
  const token = crypto.randomUUID();
  try {
    const { value } = await runThenStop(
      async (): Promise<TopicsTimedSample> => {
        await turnAccountingOff(page, token);
        const before = await readRuntimeState(page, token);
        const startedAt = performance.now();
        options.interval?.start();
        try {
          await options.operation();
          await settleOperation(page);
        } finally {
          options.interval?.end();
        }
        const elapsedMs = performance.now() - startedAt;
        const after = await readRuntimeState(page, token);

        assertNoPageErrors(options.label, pageErrors.errors);
        const workerRuns = workerRunCount(
          before.workerTiming,
          after.workerTiming,
        );
        const mayRunNothing = options.mayRunNothing ?? false;
        if (workerRuns === 0 && !mayRunNothing) {
          throw new Error(
            `${options.label}: the timed operation ran nothing in the worker; ` +
              "declare `mayRunNothing` for an operation that may run nothing",
          );
        }
        return {
          label: options.label,
          posture: options.posture,
          readAccounting: false,
          accountingTurnedOff: true,
          mayRunNothing,
          elapsedMs,
          graph: { before: before.graph, after: after.graph },
          timing: timingBetween(before, after),
          workerRuns,
          notes: [
            ACCOUNTING_OFF_NOTE,
            COMMIT_ERRORS_NOTE,
            WORKER_RUNS_NOTE,
            ATTEMPT_READS_NOTE,
            TIMING_NOTE,
          ],
        };
      },
      () => releaseSample(page, token),
    );
    return value;
  } finally {
    pageErrors.stop();
  }
}

/**
 * Formats a sample as lines for a diagnostic stream: the graph and elapsed
 * time, the lift rows when reads were recorded, the `timingRows` slowest timing
 * keys on each thread, and the sample's notes.
 */
export function formatTopicsSample(
  sample: TopicsSample,
  timingRows = 8,
): string[] {
  const { before, after } = sample.graph;
  const lines = [
    `${sample.label} [${
      sample.posture.declared
        ? `${sample.posture.mode} via ${sample.posture.clientFrom}`
        : "posture undeclared"
    }]: ${sample.elapsedMs.toFixed(0)}ms, read accounting ${
      sample.readAccounting ? "on" : "off"
    }; graph ${before.nodes} -> ${after.nodes} nodes, ${before.edges} -> ${after.edges} edges`,
  ];
  if (sample.readAccounting) {
    const columns = (values: readonly (string | number)[]) =>
      values.map((value) => String(value).padStart(10)).join(" ");
    const row = (label: string, totals: ReadTotals, site: string) =>
      `  ${label.padEnd(32)} ${
        columns([
          totals.runs,
          totals.durationMs.toFixed(1),
          totals.proxyAccesses,
          totals.maxProxyAccesses,
          totals.linkResolutions,
          totals.distinctDocuments,
          totals.registeredDependencies,
        ])
      }  ${site}`;
    lines.push(
      `  ${"lift".padEnd(32)} ${
        columns([
          "runs",
          "ms",
          "accesses",
          "max/run",
          "link hops",
          "docs Σ",
          "deps Σ",
        ])
      }  site`,
    );
    for (const lift of sample.lifts) {
      lines.push(row(
        `${lift.role} ${lift.name}`,
        lift,
        lift.running ? lift.site : `${lift.site} (not running)`,
      ));
    }
    lines.push(row("remaining", sample.remaining, ""));
    lines.push(
      `  ${sample.runsWithoutReads} runs without a read sample; ` +
        `${sample.runsWithoutSource} with a read sample but no source ` +
        `location; ${sample.eventCommits} event commits${
          sample.mayRunNothing
            ? ", declared that it may complete no located run"
            : ""
        }`,
    );
  } else {
    lines.push(
      `  ${sample.workerRuns} worker scheduler runs${
        sample.mayRunNothing
          ? ", declared that it may run nothing in the worker"
          : ""
      }; telemetry and read accounting turned off before the interval`,
    );
  }
  const timingLine = (row: TimingRow) =>
    `    ${row.totalMs.toFixed(1).padStart(9)}ms ${
      String(row.count).padStart(6)
    }x  ${row.key}`;
  const { vdomApply } = sample.timing;
  lines.push(
    `  main thread, ${vdomApply.totalMs.toFixed(1)}ms applying ` +
      `${vdomApply.count} VDOM batches:`,
    ...sample.timing.mainThread.slice(0, timingRows).map(timingLine),
    "  worker:",
    ...sample.timing.worker.slice(0, timingRows).map(timingLine),
    ...sample.notes.map((note) => `  note: ${note}`),
  );
  return lines;
}

//
// Page access
//

/** Run markers summed in the page while a sampling is active. */
interface PageSampling {
  /**
   * Totals by run `src`, for the runs that carried one. A run whose marker has
   * no `src` is counted in {@link PageSampling.withoutSource} instead, so that
   * a location the helper cannot read stays distinguishable from no location
   * at all.
   */
  bySrc: Record<string, ReadTotals>;

  /** Totals over the completed runs whose marker carried no `src`. */
  withoutSource: ReadTotals;

  /** Completed runs that carried no read sample. */
  runsWithoutReads: number;

  /** Successful event-commit markers. */
  eventCommits: number;

  /** Messages of failed event-commit markers. */
  eventCommitErrors: string[];
}

/** One sample's hold on the page: the client it started with, and any listener. */
interface PageSampleEntry {
  /** The runtime client the sample started against. */
  client: RuntimeClient;

  /** Run markers collected, for a sample measuring reads. */
  sampling?: PageSampling;

  /** Unsubscribes the telemetry listener, for a sample measuring reads. */
  unsubscribe?: () => void;
}

/** Shell globals a sample reads, and the samples in progress in the page. */
type MeasurementGlobal = typeof globalThis & {
  /** The shell's debugging globals. */
  commonfabric?: {
    /** The runtime client the shell's views run against. */
    rt?: RuntimeClient;

    /** Main-thread timing statistics by logger and key. */
    getTimingStatsBreakdown?: () => Record<
      string,
      Record<string, { count: number; totalTime: number }>
    >;
  };

  /** Samples in progress, by token. */
  __cfTopicsSamples?: Record<string, PageSampleEntry>;
};

/** Graph, implementations, and timing as they stand at one instant. */
interface RuntimeState {
  /** Graph size. */
  graph: GraphSize;

  /** Distinct implementation previews of the graph's actions, by `src`. */
  actions: Record<string, string[]>;

  /** Main-thread timing. */
  mainTiming: TimingSnapshot;

  /** Worker timing. */
  workerTiming: TimingSnapshot;
}

/** Requests the helper itself sends, whose timing is not the operation's. */
const HELPER_REQUESTS: ReadonlySet<string> = new Set([
  RequestType.GetGraphSnapshot,
  RequestType.GetLoggerCounts,
  RequestType.GetPatternCoverage,
  RequestType.SetReadStatsEnabled,
  RequestType.SetTelemetryEnabled,
]);

/**
 * Helper for the samplers, which collects page errors until `stop()` is
 * called.
 */
function watchPageErrors(page: Page): { errors: string[]; stop(): void } {
  const errors: string[] = [];
  const listening = new AbortController();
  page.addEventListener("pageerror", (event) => {
    errors.push(event.detail.message);
  }, { signal: listening.signal });
  return { errors, stop: () => listening.abort() };
}

/** Helper for the samplers, which fails a sample that raised page errors. */
function assertNoPageErrors(label: string, errors: readonly string[]): void {
  if (errors.length > 0) {
    throw new Error(
      `${label}: the page raised ${errors.length} error(s): ${
        errors.join("; ")
      }`,
    );
  }
}

/**
 * Helper for the samplers, which waits for the operation's boundary: a
 * settled view, then an idle runtime with its commits confirmed.
 */
async function settleOperation(page: Page): Promise<void> {
  await settleView(page);
  await waitForRuntimeIdle(page);
}

/**
 * Helper for {@link measureTopicsReads}, which returns whether the page's
 * worker holds a pattern coverage collector.
 */
async function patternCoverageCollecting(page: Page): Promise<boolean> {
  return await inPage(() =>
    page.evaluate(async () => {
      const rt = (globalThis as MeasurementGlobal).commonfabric?.rt;
      if (!rt) {
        throw new Error("The shell exposes no runtime client to measure");
      }
      return (await rt.getPatternCoverage()) !== null;
    })
  );
}

/**
 * Helper for {@link measureTopicsReads}, which subscribes to the page's
 * telemetry under `token` and enables telemetry and read accounting, leaving
 * the page as it found it when enabling fails.
 */
async function startSampling(page: Page, token: string): Promise<void> {
  await inPage(() =>
    page.evaluate(async (token: string) => {
      const scope = globalThis as MeasurementGlobal;
      const rt = scope.commonfabric?.rt;
      if (!rt) {
        throw new Error("The shell exposes no runtime client to measure");
      }
      const emptyTotals = () => ({
        runs: 0,
        durationMs: 0,
        proxyAccesses: 0,
        maxProxyAccesses: 0,
        linkResolutions: 0,
        distinctDocuments: 0,
        registeredDependencies: 0,
      });
      const sampling: PageSampling = {
        bySrc: {},
        withoutSource: emptyTotals(),
        runsWithoutReads: 0,
        eventCommits: 0,
        eventCommitErrors: [],
      };
      const listener: Parameters<typeof rt.on<"telemetry">>[1] = (marker) => {
        if (marker.type === "scheduler.event.commit") {
          if (marker.error) sampling.eventCommitErrors.push(marker.error);
          else sampling.eventCommits++;
          return;
        }
        if (marker.type !== "scheduler.run.complete") return;
        if (!marker.reads) {
          sampling.runsWithoutReads++;
          return;
        }
        const totals = marker.src === undefined
          ? sampling.withoutSource
          : (sampling.bySrc[marker.src] ??= emptyTotals());
        totals.runs++;
        totals.durationMs += marker.durationMs;
        totals.proxyAccesses += marker.reads.proxyAccesses;
        totals.maxProxyAccesses = Math.max(
          totals.maxProxyAccesses,
          marker.reads.proxyAccesses,
        );
        totals.linkResolutions += marker.reads.linkResolutions;
        totals.distinctDocuments += marker.reads.distinctDocuments;
        totals.registeredDependencies += marker.reads.registeredDependencies;
      };
      rt.on("telemetry", listener);
      const samples = scope.__cfTopicsSamples ??= {};
      samples[token] = {
        client: rt,
        sampling,
        unsubscribe: () => rt.off("telemetry", listener),
      };
      try {
        await rt.setTelemetryEnabled(true);
        await rt.setReadStatsEnabled(true);
      } catch (error) {
        // Leave the page as it was found. The enabling failure is what the
        // caller hears about, so a failure to disable does not replace it.
        rt.off("telemetry", listener);
        delete samples[token];
        await Promise.allSettled([
          rt.setReadStatsEnabled(false),
          rt.setTelemetryEnabled(false),
        ]);
        throw error;
      }
    }, { args: [token] })
  );
}

/**
 * Helper for {@link timeTopicsOperation}, which records the runtime client
 * under `token` and turns read accounting and telemetry off so that a timed
 * interval does not inherit either.
 */
async function turnAccountingOff(page: Page, token: string): Promise<void> {
  await inPage(() =>
    page.evaluate(async (token: string) => {
      const scope = globalThis as MeasurementGlobal;
      const rt = scope.commonfabric?.rt;
      if (!rt) throw new Error("The shell exposes no runtime client to time");
      (scope.__cfTopicsSamples ??= {})[token] = { client: rt };
      await rt.setReadStatsEnabled(false);
      await rt.setTelemetryEnabled(false);
    }, { args: [token] })
  );
}

/**
 * Helper for {@link measureTopicsReads}, which unsubscribes the sampling under
 * `token`, disables read accounting and telemetry on the client the sampling
 * enabled them on, and returns what it collected. Both are disabled on that
 * client even when the page's client has since been replaced, and each is
 * attempted even when the other fails.
 *
 * @throws If the runtime client is not the one the sampling started against,
 *   since its runs were not all observed; a failure to disable either setting
 *   is attached to that error as an `AggregateError` cause. Otherwise, an
 *   `AggregateError` of the failures to disable, if any.
 */
async function stopSampling(page: Page, token: string): Promise<PageSampling> {
  const stopped = await inPage(() =>
    page.evaluate(async (token: string) => {
      const scope = globalThis as MeasurementGlobal;
      const entry = scope.__cfTopicsSamples?.[token];
      if (!entry?.sampling || !entry.unsubscribe) {
        throw new Error("The sampling under this token is gone");
      }
      entry.unsubscribe();
      const disabling = await Promise.allSettled([
        entry.client.setReadStatsEnabled(false),
        entry.client.setTelemetryEnabled(false),
      ]);
      return {
        sampling: entry.sampling,
        replaced: scope.commonfabric?.rt !== entry.client,
        failures: disabling.flatMap((outcome) =>
          outcome.status === "rejected"
            ? [
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason),
            ]
            : []
        ),
      };
    }, { args: [token] })
  );
  const failures = stopped.failures.length === 0
    ? undefined
    : new AggregateError(
      stopped.failures.map((message) => new Error(message)),
      "Turning read accounting and telemetry off on the sampled client failed",
    );
  if (stopped.replaced) {
    throw new Error(
      "The runtime client was replaced during the measured operation, so its " +
        "runs were not all observed",
      failures === undefined ? undefined : { cause: failures },
    );
  }
  if (failures !== undefined) throw failures;
  return stopped.sampling;
}

/**
 * Helper for the samplers, which reads graph size, implementation previews,
 * and timing.
 *
 * @throws If the runtime client is not the one the sample started against.
 */
async function readRuntimeState(
  page: Page,
  token: string,
): Promise<RuntimeState> {
  return await inPage(() =>
    page.evaluate(async (token: string) => {
      const scope = globalThis as MeasurementGlobal;
      const entry = scope.__cfTopicsSamples?.[token];
      const cf = scope.commonfabric;
      const mainBreakdown = cf?.getTimingStatsBreakdown;
      if (!entry || !mainBreakdown) {
        throw new Error("The sample or the shell's timing to read is gone");
      }
      if (cf?.rt !== entry.client) {
        throw new Error(
          "The runtime client was replaced during the operation, so its graph " +
            "and timing describe another runtime",
        );
      }
      const flatten = (
        groups: Record<
          string,
          Record<string, { count: number; totalTime: number }>
        >,
      ) => {
        const flat: Record<string, [number, number]> = {};
        for (const [logger, keys] of Object.entries(groups)) {
          for (const [key, stats] of Object.entries(keys)) {
            flat[`${logger}/${key}`] = [stats.count, stats.totalTime];
          }
        }
        return flat;
      };
      const graph = await entry.client.getGraphSnapshot();
      const workerTiming = flatten(
        (await entry.client.getLoggerCounts()).timing,
      );
      const actions: Record<string, string[]> = {};
      for (const node of graph.nodes) {
        if (node.src === undefined) continue;
        const previews = actions[node.src] ??= [];
        if (node.preview !== undefined && !previews.includes(node.preview)) {
          previews.push(node.preview);
        }
      }
      return {
        graph: { nodes: graph.nodes.length, edges: graph.edges.length },
        actions,
        mainTiming: flatten(mainBreakdown()),
        workerTiming,
      };
    }, { args: [token] })
  );
}

/**
 * Helper for the samplers, which releases the sample under `token`: its
 * telemetry listener, if still subscribed, and its record of the runtime
 * client. Releasing a sample already released does nothing.
 */
async function releaseSample(page: Page, token: string): Promise<void> {
  await inPage(() =>
    page.evaluate((token: string) => {
      const scope = globalThis as MeasurementGlobal;
      const entry = scope.__cfTopicsSamples?.[token];
      if (entry === undefined) return;
      entry.unsubscribe?.();
      delete scope.__cfTopicsSamples![token];
    }, { args: [token] })
  );
}

/**
 * Helper for the page access above, which runs `evaluate` and rethrows a page
 * exception as an `Error` carrying the page's message. The browser protocol
 * reports an exception thrown in the page as a detail record rather than an
 * `Error`; the record becomes the rethrown error's cause.
 */
async function inPage<T>(evaluate: () => Promise<T>): Promise<T> {
  try {
    return await evaluate();
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(describeThrown(error), { cause: error });
  }
}

//
// Aggregation
//

/** Returns totals of zero. */
function emptyTotals(): ReadTotals {
  return {
    runs: 0,
    durationMs: 0,
    proxyAccesses: 0,
    maxProxyAccesses: 0,
    linkResolutions: 0,
    distinctDocuments: 0,
    registeredDependencies: 0,
  };
}

/** Adds `from` into `into`. */
function addTotals(into: ReadTotals, from: ReadTotals): void {
  into.runs += from.runs;
  into.durationMs += from.durationMs;
  into.proxyAccesses += from.proxyAccesses;
  into.maxProxyAccesses = Math.max(
    into.maxProxyAccesses,
    from.maxProxyAccesses,
  );
  into.linkResolutions += from.linkResolutions;
  into.distinctDocuments += from.distinctDocuments;
  into.registeredDependencies += from.registeredDependencies;
}

/** Helper for the samplers, which returns timing recorded between two states. */
function timingBetween(
  before: RuntimeState,
  after: RuntimeState,
): TopicsTiming {
  const mainThread = timingDelta(
    before.mainTiming,
    after.mainTiming,
    HELPER_REQUESTS,
  );
  return {
    mainThread,
    worker: timingDelta(
      before.workerTiming,
      after.workerTiming,
      HELPER_REQUESTS,
    ),
    vdomApply:
      mainThread.find((row) => row.key === "vdom-applicator/apply-batch") ??
        { key: "vdom-applicator/apply-batch", count: 0, totalMs: 0 },
  };
}
