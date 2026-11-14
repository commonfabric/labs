/**
 * Runs the serving loop in Workers of this process, one per served space
 * (serving-loop-worker.md, "One worker per space"): a pool that places each
 * space on a worker of its own when the space first has something to serve,
 * routes the memory server's observer events to the worker a space is placed
 * on, closes a worker once its host holds nothing, and starts another, under
 * a fresh lease-holder component, for the spaces of one that died or that
 * its watchdog found stalled.
 */

import { type Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { acquireServerExecutionEnabler } from "@commonfabric/memory/v2";
import { executionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import type {
  AdmittedCommitNotice,
  Server,
} from "@commonfabric/memory/v2/server";
import type { CollectedMemory } from "../collected-memory.ts";
import type { ModuleCompilerPool } from "../harness/module-compiler-pool.ts";
import type { ExperimentalOptions } from "../runtime.ts";
import type { MemorySpace } from "../storage/interface.ts";
import { mergeServingLoopDiagnostics } from "./diagnostics-merge.ts";
import { compileWorkerLoopDiagnostics } from "./serving-loop-diagnostics.ts";
import {
  admissionActivates,
  DEFAULT_MAX_PARKED_RUNTIMES,
  type ExecutorHost,
  failureParkBackoffDelayMs,
  type HostOccupancy,
  SpaceNotServedError,
  writesSpaceAcl,
} from "./host.ts";
import { ServingPortBridge } from "./serving-port-bridge.ts";
import {
  assertServingThreadHeapLimit,
  type ServingThread,
  type ServingThreadOptions,
  startServingThread,
} from "./serving-thread.ts";
import type {
  LifecycleVerbDescriptor,
  LifecycleVerbRun,
  ServingLoopDiagnostics,
  ServingWorkerInit,
  ServingWorkerPolicy,
  WorkerHeartbeat,
} from "./serving-port-protocol.ts";
import {
  emptyServingLoopStats,
  registerServingLoopStatsProvider,
  type ServingLoopStats,
} from "./stats.ts";
import {
  closedHostServingLoopStats,
  mergeServingLoopStats,
} from "./stats-merge.ts";

const logger = getLogger("serving-worker-host", {
  enabled: true,
  level: "warn",
});

/** How often a worker posts a heartbeat and its watchdog checks for messages. */
const WATCHDOG_INTERVAL_MS = 10_000;

/**
 * How many whole intervals a worker may pass without a message before its
 * watchdog kills it: at the default interval, a minute of silence.
 */
const WATCHDOG_SILENT_INTERVALS = 6;

/**
 * How many workers a pool places spaces on unless told otherwise. Each one
 * is an isolate holding the serving runtime's whole module graph, so the cap
 * bounds what the pool costs before any space's own state is counted.
 */
export const DEFAULT_MAX_SERVING_WORKERS = 16;

/**
 * The serving loop as whatever starts it hands it back, whichever thread
 * runs it: a toolshed's bootstrap, or the serving memory server tests build.
 */
export type ServingLoopHandle = {
  /** The loop's counters: the host's, or the last its workers posted. */
  stats(): ServingLoopStats | undefined;

  /**
   * What the loop's realm logged: this process's loggers where the loop
   * runs on its main thread, its workers' taken together where it runs
   * there.
   */
  diagnostics(): Promise<ServingLoopDiagnostics>;

  /** The host, when the loop runs on this thread; `undefined` in workers. */
  readonly host: ExecutorHost | undefined;

  close(): Promise<void>;
};

export type { ServingLoopDiagnostics } from "./serving-port-protocol.ts";

/** What a pool builds its serving workers from, and the observers of them. */
export type ServingWorkerPoolOptions = {
  server: Server;

  /** The service identity each worker's host serves as; its key crosses. */
  identity: Identity;

  /** The serving runtimes' patterns and compile base. */
  apiUrl: URL;

  /**
   * The workers' entry module. Default: the runner's own, which builds no
   * lifecycle verbs; a deployment names an entry of its own that calls
   * `serveFromPort()` with the verbs and fetch it uses.
   */
  workerModule?: URL;

  /** The loop's policy, its data fields alone, since a closure cannot cross. */
  policy?: ServingWorkerPolicy;

  /** The hosts' space-root ensure switch (`ExecutorHostOptions`). */
  ensureSpaceRoots?: boolean;

  /** The serving runtimes' experimental options. */
  experimental?: ExperimentalOptions;

  /**
   * The deployment's memory endpoint, through which each worker's host
   * reaches the owner of a space it does not serve
   * (`ExecutorHostOptions.route`). A worker dials it itself, signing its
   * sessions with the key that crosses.
   */
  route?: URL;

  /**
   * The compile workers this process shares, which every serving worker's
   * runtimes compile in, over their port, in place of a compile worker of
   * each serving worker's own. Their diagnostics join the workers'. Absent,
   * each serving worker compiles where its entry module says.
   */
  moduleCompiler?: ModuleCompilerPool;

  /**
   * The compiled-module cache directory every process on the host shares
   * (`openSharedCompileCache()`), which every serving worker's runtimes read
   * and put compiled modules in. Absent, each serving worker uses the cache
   * its entry module gives, if any.
   */
  compileCacheDir?: string;

  /**
   * How many workers spaces are placed on at most. A space gets a worker of
   * its own while fewer are placed on; at the cap it joins the worker that
   * serves the fewest spaces, one holding only parked runtimes first. `1`
   * serves every space from one worker. Default:
   * {@link DEFAULT_MAX_SERVING_WORKERS}.
   */
  maxWorkers?: number;

  /**
   * How many workers the pool keeps started with no space placed on them,
   * so that a placement finds one whose modules have loaded. They do not
   * count toward `maxWorkers`. Default: none.
   */
  spareWorkers?: number;

  /**
   * The largest each worker's heap may grow, in megabytes: a whole number,
   * `MIN_SERVING_THREAD_HEAP_LIMIT_MB` or more. A worker that reaches it is
   * ended alone, at the error that reports it or at its next heartbeat, and
   * the process goes on. So is one whose heartbeat reports that many
   * megabytes of buffers outside the heap, which the limit itself does not
   * bound. What becomes of its spaces is in the class's doc comment: one
   * that was alone on the worker is left unplaced, and those that shared it
   * get a worker each. Absent, a worker grows to the process's own heap
   * limit, and one that reaches it aborts the process.
   */
  heapLimitMb?: number;

  /**
   * Starts a worker's thread. Default: {@link startServingThread}. A test
   * passes one that starts a stand-in, which a thread with a heap limit
   * otherwise leaves no room for.
   */
  startThread?: typeof startServingThread;

  /**
   * How large the workers' JavaScript heaps may be together, in bytes, as
   * their heartbeats report them, before the pool closes workers that hold
   * only parked runtimes, the longest parked first. Workers serving a space
   * are never closed for it. Default: no budget.
   */
  heapBudgetBytes?: number;

  /**
   * How often a worker posts a heartbeat and the watchdog checks for
   * messages; a worker is killed after six such intervals in which it sent
   * none. Default: ten seconds. A test shortens it, to see a kill in less time
   * than the test is allowed.
   */
  watchdogIntervalMs?: number;

  /** DIAGNOSTIC (tests): the workers' activation outcomes. */
  onActivationSettled?: (
    space: MemorySpace,
    outcome: "active" | "refused" | "failed",
  ) => void;

  /** DIAGNOSTIC (tests): the workers' parks. */
  onSpaceParked?: (space: MemorySpace, reason: string) => void;

  /**
   * DIAGNOSTIC (tests): each worker taken out of the pool while the pool is
   * open, with the spaces that were placed on it and why it went: its host
   * `retired` holding nothing, was `evicted` holding only parked runtimes,
   * or the worker `failed`.
   */
  onWorkerClosed?: (
    spaces: readonly string[],
    cause: "retired" | "evicted" | "failed",
  ) => void;
};

/** One isolate's collected memory, with the spaces placed on its worker. */
export type CollectedWorkerMemory = CollectedMemory & {
  /** The spaces placed on the worker; none for a spare. */
  spaces: string[];
};

/** One running worker, the bridge serving it, and what is placed on it. */
type PoolWorker = {
  worker: ServingThread;
  bridge: ServingPortBridge;

  /** The lease holder this worker's leases name. */
  holder: string;

  /** Settles once the worker's host serves; rejects when it cannot. */
  ready: Promise<void>;

  /** Whether `ready` has settled with the worker's host serving. */
  serving: boolean;

  /** Whether the worker has failed or been closed, and is out of the pool. */
  gone: boolean;

  /** The lifetime lock the worker's host holds, if it holds one. */
  lifetimeLock: string | undefined;

  /** The timer that watches this worker for silence. */
  watchdog: ReturnType<typeof setInterval> | undefined;

  /** The spaces placed on this worker; none for a spare. */
  spaces: Set<string>;

  /**
   * Whether the one space placed on this worker stays its only one: a space
   * whose last worker reached its heap limit, which no other space shares a
   * worker with (`ServingWorkerPool`'s `#heapKills`).
   */
  alone: boolean;

  /** Commits admitted for its spaces before its host served, in order. */
  backlog: AdmittedCommitNotice[];

  /** What the worker's host last said it holds, once it has said. */
  occupancy: HostOccupancy | undefined;

  /** The pool's park count when the host last said `parked`. */
  parkedAt: number;

  /** The worker's heap as its last heartbeat reported it, in bytes. */
  heapUsed: number;

  /**
   * The request that closes the worker's host if it holds nothing, while it
   * is in flight; settles with whether the host closed.
   */
  retiring: Promise<boolean> | undefined;

  /**
   * The commits sent to the worker while `retiring` that would start a
   * tenure, which a host that closed did not take.
   */
  sentWhileRetiring: AdmittedCommitNotice[];

  /**
   * The warm-marked commits the worker's host has been sent for which no
   * wave has committed in their space since. A warm request is a one-shot
   * signal nothing sends again, so a worker that fails owes these to its
   * spaces' next placement.
   */
  warmOutstanding: AdmittedCommitNotice[];

  /** The spaces a client session opened on while `retiring`. */
  openedWhileRetiring: Set<string>;

  /** Whether the host said what it holds while `retiring`. */
  reportedWhileRetiring: boolean;
};

/** A space between two workers: its last one is being torn down. */
type WaitingSpace = {
  /** The commits admitted meanwhile that would start a tenure. */
  notices: AdmittedCommitNotice[];

  /** Whether the space's last worker failed. */
  failed: boolean;

  /**
   * Whether a client session on the space places it again once the wait
   * ends: one opened since the worker's host was asked to close, or any
   * live one where the worker failed. A session that was live when a host
   * closed holding nothing is one whose tenure that host turned down, as it
   * does while another holder has the space's lease, and it does not place
   * the space on worker after worker.
   */
  sessionsPlace: boolean;

  /** Settles once the space has been placed again or left unplaced. */
  resumed: Promise<void>;
};

/**
 * The serving loop running in Workers, one per served space. A space is
 * placed on a worker when it first meets the serving loop's ACTIVE criteria
 * (serving-loop.md §1) or is named by a lifecycle verb, and stays placed
 * there until that worker is gone. A worker's host parks its spaces as an
 * in-process host does, and the pool closes the worker once its host holds
 * nothing: no tenure, no runtime kept from an idle park, no notice owed to a
 * tenure to come. It closes one that holds only kept runtimes to stay within
 * `maxParkedRuntimes` such workers and within the heap budget.
 *
 * A worker counts as failed when it reports an error it did not handle, when
 * its host cannot start, and when it stops sending messages (`#watch()`).
 * Only its own spaces are affected. Once it is gone and the leases it held
 * are released, each of them is placed again if it still has something to
 * serve, after the backoff the host applies to a space whose tenures keep
 * failing, widening until a worker commits a wave for the space. Every
 * worker acquires under a lease-holder component of its own, so a
 * successor's commits never share a replay key with its predecessor's in
 * the engine.
 *
 * A worker that reaches its heap limit (`heapLimitMb`) is taken out the same
 * way, but its spaces are not simply placed again, since a program that grew
 * a heap to the limit does so again wherever it runs. The limit is the
 * worker's, so the pool learns which space grew by where it was:
 *
 * - A space that was alone on the worker is left unplaced, whatever session
 *   it has and whatever events its store holds. It is placed again by what
 *   can change what its program does: a commit admitted afterwards that would
 *   start a tenure, or a lifecycle verb. Each such placement waits out a
 *   backoff that widens with every worker the space has had ended, which
 *   waves committed in between do not reset.
 * - Spaces that shared the worker are each placed on a worker of their own,
 *   beyond `maxWorkers` if need be, and no other space joins those workers.
 *   The space that grew then ends a worker with nothing else on it, and the
 *   others go on being served. The kill counts as no failure of theirs.
 *
 * A space stays on workers of its own until one of them closes with nothing
 * left to serve.
 */
export class ServingWorkerPool {
  readonly #options: ServingWorkerPoolOptions;
  readonly #maxWorkers: number;
  readonly #spareWorkers: number;
  readonly #maxParkedWorkers: number;

  /** Every worker running, spares included, in the order they started. */
  readonly #workers = new Set<PoolWorker>();

  /** The worker each placed space is on. */
  readonly #placements = new Map<string, PoolWorker>();

  /** The spaces whose last worker is being torn down. */
  readonly #waiting = new Map<string, WaitingSpace>();

  /**
   * Consecutive worker failures per space, which pace the space's next
   * placement. A wave committed for the space, or a worker of its own
   * closed with nothing left to serve, clears it.
   */
  readonly #failures = new Map<string, number>();

  /**
   * The spaces whose last worker reached its heap limit, each with how many
   * workers it has had ended there while alone on them. A space here is
   * placed on a worker no other space joins. A worker of its own that closes
   * with nothing left to serve clears it.
   */
  readonly #heapKills = new Map<string, number>();

  /**
   * The spaces left unplaced since a worker they were alone on reached its
   * heap limit. Only a commit admitted since, or a lifecycle verb, places
   * one; its next placement clears it.
   */
  readonly #heapStopped = new Set<string>();

  /** Teardowns of workers that failed or were closed, while they run. */
  readonly #teardowns = new Set<Promise<void>>();

  /**
   * The timers that pace placements after a failure, while pending, each
   * with what ends its wait early.
   */
  readonly #backoffs = new Map<ReturnType<typeof setTimeout>, () => void>();

  /** The counters of every host that has closed, taken together. */
  #closedStats: ServingLoopStats = emptyServingLoopStats();

  /** What the realms of the hosts that closed in order had logged. */
  #closedDiagnostics: ServingLoopDiagnostics | undefined;

  /** The pool's own counters, the `workers` block's accumulating half. */
  readonly #counts = {
    started: 0,
    retired: 0,
    evicted: 0,
    failed: 0,
    shared: 0,
    heapLimited: 0,
  };

  /** The leases the watchdog released, across every worker it killed. */
  #leasesLost = 0;

  /**
   * Consecutive failures of workers no space was placed on, which pace the
   * next spare. A worker that starts to serve clears it.
   */
  #spareFailures = 0;

  /** How many failed spares' backoffs are pending, which hold spares back. */
  #spareBackoffs = 0;

  /** How many times a worker's host has reported `parked`. */
  #parks = 0;

  readonly #ready: Promise<void>;
  readonly #releaseServerExecution: () => void;
  #closed = false;

  /**
   * Constructs an instance which serves `options.server`'s spaces: it
   * installs the server's execution observer, starts the spare workers, and
   * places every space a client session is already live on.
   */
  constructor(options: ServingWorkerPoolOptions) {
    const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_SERVING_WORKERS;
    const spareWorkers = options.spareWorkers ?? 0;
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
      throw new Error(
        `\`maxWorkers\` is ${maxWorkers}; a pool places spaces on one worker or more`,
      );
    }
    if (!Number.isInteger(spareWorkers) || spareWorkers < 0) {
      throw new Error(
        `\`spareWorkers\` is ${spareWorkers}; a pool keeps none or more`,
      );
    }
    if (options.heapLimitMb !== undefined) {
      assertServingThreadHeapLimit(options.heapLimitMb);
    }
    this.#options = options;
    this.#maxWorkers = maxWorkers;
    this.#spareWorkers = spareWorkers;
    this.#maxParkedWorkers = options.policy?.maxParkedRuntimes ??
      DEFAULT_MAX_PARKED_RUNTIMES;
    // The pool's own claim on the ambient flag, which stands while no worker
    // runs: the server's admission of derived commits reads it.
    this.#releaseServerExecution = acquireServerExecutionEnabler();
    registerServingLoopStatsProvider(() => this.stats());
    // Installing the observer replays the server's sessions. No space is
    // placed yet, so the replay reaches no worker; what it tells the pool is
    // which spaces were opened before this, each of which then gets the
    // activation trigger its open would have been.
    const replayed = new Set<string>();
    let replaying = true;
    options.server.setServerExecutionObserver({
      commitAdmitted: (notice) => this.#onCommitAdmitted(notice),
      sessionOpened: (space) => this.#onSessionOpened(space),
      demandChanged: (space, reason, principal, sessionId, servingOwn) => {
        this.#servingWorkerOf(space)?.bridge.observer.demandChanged(
          space,
          reason,
          principal,
          sessionId,
          servingOwn,
        );
      },
      viewsChanged: (space, sessionId) => {
        this.#servingWorkerOf(space)?.bridge.observer.viewsChanged(
          space,
          sessionId,
        );
      },
      sessionChanged: (event) => {
        if (replaying && event.kind === "opened") replayed.add(event.space);
        this.#servingWorkerOf(event.space)?.bridge.observer.sessionChanged(
          event,
        );
      },
    });
    replaying = false;
    const spares: Promise<void>[] = [];
    for (let spare = 0; spare < this.#spareWorkers; spare += 1) {
      spares.push(this.#spawn().ready);
    }
    this.#ready = Promise.all(spares).then(() => {});
    this.#ready.catch(() => {});
    for (const space of replayed) this.#onSessionOpened(space);
  }

  /**
   * The worker each placed space is on, and the spaces between workers,
   * each with the promise that settles once it has been placed again or
   * left unplaced.
   */
  get accessForTestingOnly(): {
    readonly placements: ReadonlyMap<string, PoolWorker>;
    readonly waiting: ReadonlyMap<string, WaitingSpace>;
  } {
    return { placements: this.#placements, waiting: this.#waiting };
  }

  /**
   * Settles once the spare workers started at construction serve, and at
   * once for a pool that keeps none; rejects when one of them cannot start.
   */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /**
   * The counters the workers last posted, taken together with those of
   * every host that has closed, and the pool's own `workers` block.
   */
  stats(): ServingLoopStats {
    const live = [...this.#workers].flatMap((worker) =>
      worker.bridge.stats() ?? []
    );
    const stats = mergeServingLoopStats([this.#closedStats, ...live]);
    stats.lease.lost += this.#leasesLost;
    let serving = 0;
    let spare = 0;
    let parked = 0;
    let heapUsed = 0;
    for (const worker of this.#workers) {
      heapUsed += worker.heapUsed;
      if (worker.spaces.size === 0) spare += 1;
      else serving += 1;
      if (worker.spaces.size > 0 && worker.occupancy === "parked") parked += 1;
    }
    stats.workers = {
      serving,
      spare,
      parked,
      heapUsed,
      heapStopped: this.#heapStopped.size,
      ...this.#counts,
    };
    return stats;
  }

  /**
   * The counters as of now, each worker asked for its own once those that
   * are starting serve. Rejects once the pool is closed.
   */
  async requestStats(): Promise<ServingLoopStats> {
    const workers = await this.#startedWorkers();
    await Promise.allSettled(
      workers.map((worker) => worker.bridge.requestStats()),
    );
    return this.stats();
  }

  /**
   * What the workers' realms logged, as of now, once those that are
   * starting serve, taken together with what the realm of each host that
   * closed in order had logged, and with the latest snapshots of the compile
   * workers the process shares (`moduleCompiler`). A worker that fails takes
   * what its realm logged with it. Rejects once the pool is closed.
   */
  async diagnostics(): Promise<ServingLoopDiagnostics> {
    const workers = await this.#startedWorkers();
    const answers = await Promise.allSettled(
      workers.map((worker) => worker.bridge.requestDiagnostics()),
    );
    // A worker that left the pool while another's answer was awaited is left
    // out, so the result is of the pool as it is now. One whose host closed
    // in order is in the closed hosts' sum already, with what its realm
    // logged last, and one that failed took what its realm logged with it,
    // as it would have had it failed before it was asked.
    const compiler = this.#options.moduleCompiler;
    return mergeServingLoopDiagnostics([
      ...(compiler === undefined
        ? []
        : [compileWorkerLoopDiagnostics(compiler)]),
      ...(this.#closedDiagnostics === undefined
        ? []
        : [this.#closedDiagnostics]),
      ...answers.flatMap((answer, index) =>
        answer.status === "fulfilled" && !workers[index].gone
          ? [answer.value]
          : []
      ),
    ]);
  }

  /**
   * Collects the whole heap of each worker, once those that are starting
   * serve, and returns the memory each isolate still holds with the spaces
   * placed on it, leaving out a worker that left the pool before it
   * answered. Rejects once the pool is closed, and unless
   * `exposeGarbageCollector()` has run in this process.
   */
  async collectedMemory(): Promise<CollectedWorkerMemory[]> {
    const workers = await this.#startedWorkers();
    const answers = await Promise.allSettled(
      workers.map((worker) => worker.bridge.requestCollectedMemory()),
    );
    const collected: CollectedWorkerMemory[] = [];
    for (const [index, answer] of answers.entries()) {
      const worker = workers[index];
      if (answer.status === "fulfilled") {
        collected.push({ ...answer.value, spaces: [...worker.spaces] });
      } else if (!worker.gone) {
        // A worker that left the pool meanwhile has no memory to report;
        // any other refusal is the caller's to hear of.
        throw answer.reason;
      }
    }
    return collected;
  }

  /**
   * Runs a lifecycle verb on the host of the worker `space` is placed on,
   * placing the space first if it is on none: a verb is an activation
   * trigger of its own. Throws {@link SpaceNotServedError} once the pool is
   * closed, while the space waits for a successor to a worker that failed,
   * when another holder on this memory server has the space's lease, and
   * when the worker it is placed on cannot start.
   */
  async runLifecycleVerb(
    space: MemorySpace,
    verb: LifecycleVerbDescriptor,
  ): Promise<LifecycleVerbRun> {
    for (;;) {
      if (this.#closed) throw new SpaceNotServedError(space);
      const waiting = this.#waiting.get(space);
      if (waiting !== undefined) {
        if (waiting.failed) throw new SpaceNotServedError(space);
        await waiting.resumed;
        continue;
      }
      const placed = this.#placements.get(space);
      if (placed === undefined && this.#leasedElsewhere(space)) {
        throw new SpaceNotServedError(space);
      }
      const worker = placed ?? this.#place(space, []);
      if (worker.retiring !== undefined) {
        await worker.retiring;
        continue;
      }
      try {
        await worker.ready;
      } catch {
        throw new SpaceNotServedError(space);
      }
      // The wait let other work run, which may have closed the worker's
      // host or moved the space.
      if (
        this.#placements.get(space) !== worker || worker.retiring !== undefined
      ) {
        continue;
      }
      return await worker.bridge.runLifecycleVerb(space, verb);
    }
  }

  /**
   * Closes every worker's host, then the worker; settles once all are gone,
   * and once every worker that failed or was closed before the call has been
   * torn down. A worker whose host has not yet reported serving is
   * terminated without asking its host to close, since one that stalls in
   * its startup never answers; a host that stalls in closing is the
   * watchdog's to fail. A host that does not close, for either reason or
   * because the worker fails first, leaves the leases its worker held to be
   * released here.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Nothing the server reports from here on reaches the pool.
    this.#options.server.setServerExecutionObserver(undefined);
    // A pending backoff ends now, so that the teardown waiting behind it
    // settles.
    for (const [timer, wake] of [...this.#backoffs]) {
      clearTimeout(timer);
      wake();
    }
    this.#backoffs.clear();
    await Promise.all(
      [...this.#workers].map((worker) => this.#closeWorker(worker)),
    );
    await Promise.allSettled([...this.#teardowns]);
    this.#placements.clear();
    this.#waiting.clear();
    registerServingLoopStatsProvider(undefined);
    this.#releaseServerExecution();
  }

  /** Helper for `close()`, which closes one worker's host and the worker. */
  async #closeWorker(worker: PoolWorker): Promise<void> {
    await worker.retiring;
    if (worker.gone) return;
    let hostClosed = false;
    try {
      if (worker.serving) {
        await worker.bridge.closeHost();
        hostClosed = true;
      }
    } catch (error) {
      logger.warn("worker-close-failed", () => [
        "closing a serving worker's host failed; terminating the worker",
        error,
      ]);
    }
    // A worker that failed while its host closed is the failure path's to
    // tear down, leases included.
    if (worker.gone) return;
    this.#forget(worker);
    await worker.worker.terminate(worker.lifetimeLock);
    if (!hostClosed) worker.bridge.releaseLeasesOf(worker.holder);
  }

  /**
   * Helper for the methods that ask every worker something, which waits for
   * the workers that are starting and returns those whose hosts serve and
   * are not being asked to close. Throws once the pool is closed.
   */
  async #startedWorkers(): Promise<PoolWorker[]> {
    if (this.#closed) throw new Error("the serving workers are closed");
    await Promise.allSettled([...this.#workers].map((worker) => worker.ready));
    return [...this.#workers].filter((worker) =>
      worker.serving && worker.retiring === undefined
    );
  }

  /** The worker `space` is placed on, if its host serves. */
  #servingWorkerOf(space: string): PoolWorker | undefined {
    const worker = this.#placements.get(space);
    return worker?.serving === true ? worker : undefined;
  }

  /**
   * Whether another holder has `space`'s lease. A space is placed nowhere
   * only once the leases of the worker it was on are released, so a holder
   * found then is a rival on this memory server, which serves the space
   * (serving-loop.md §2). The pool leaves it the space, as a host leaves a
   * space parked on a rival's lease, and starts no worker a rival's lease
   * would refuse.
   */
  #leasedElsewhere(space: string): boolean {
    return this.#options.server.executionLeases.holderOf(space) !== undefined;
  }

  /**
   * Whether `space`'s store holds events no serving loop has delivered.
   * A store that cannot be read counts as holding some, as it does for a
   * host deciding whether to serve a space again after a park: the
   * activation opens the store itself, and backs off if that fails too.
   */
  async #hasUndeliveredEvents(space: string): Promise<boolean> {
    try {
      return await this.#options.server.hasUndeliveredEvents(space);
    } catch (error) {
      logger.warn("undelivered-events-check-failed", () => [
        `space ${space}: undelivered-events check failed after its worker ` +
        "failed; placing it to check again",
        error,
      ]);
      return true;
    }
  }

  /** Whether a session other than the serving loop's own is live on `space`. */
  #hasClientSessions(space: string): boolean {
    return this.#options.server.hasLiveSessionsForSpace(space, {
      excludePrincipal: this.#options.identity.did(),
    });
  }

  /**
   * The server's `commitAdmitted`: the commit goes to the worker its space
   * is placed on, and a commit that would start a tenure in a space placed
   * nowhere places it (serving-loop.md §1's admission-side hook), unless
   * another holder has the space's lease (`#leasedElsewhere()`). A commit
   * for a space between workers is kept for its next placement.
   */
  #onCommitAdmitted(notice: AdmittedCommitNotice): void {
    const worker = this.#placements.get(notice.space);
    if (writesSpaceAcl(notice)) {
      // The space's own worker hears of the commit itself; the others may
      // hold a session on the space as a cross-space replica.
      for (const other of this.#workers) {
        if (other !== worker && other.serving) {
          other.bridge.noteSpaceAclChanged(notice.space);
        }
      }
    }
    const activates = () =>
      admissionActivates(notice, () => this.#hasClientSessions(notice.space));
    if (worker !== undefined) {
      if (!worker.serving) {
        worker.backlog.push(notice);
        return;
      }
      if (worker.retiring !== undefined && activates()) {
        worker.sentWhileRetiring.push(notice);
      }
      this.#send(worker, notice);
      return;
    }
    if (!activates()) return;
    const waiting = this.#waiting.get(notice.space);
    if (waiting !== undefined) waiting.notices.push(notice);
    else if (!this.#leasedElsewhere(notice.space)) {
      this.#place(notice.space, [notice]);
    }
  }

  /**
   * The server's `sessionOpened`: a first client session on a space placed
   * nowhere places it, unless another holder has the space's lease
   * (`#leasedElsewhere()`) or the space was left unplaced at a heap limit
   * (`#heapStopped`); one on a placed space is the worker's host's to weigh.
   */
  #onSessionOpened(space: string): void {
    const worker = this.#placements.get(space);
    if (worker !== undefined) {
      // A worker not yet serving is told of its spaces' sessions as it
      // starts to (`#introduce()`).
      if (!worker.serving) return;
      if (worker.retiring !== undefined) worker.openedWhileRetiring.add(space);
      worker.bridge.observer.sessionOpened(space);
      return;
    }
    if (!this.#hasClientSessions(space) || this.#heapStopped.has(space)) return;
    // A space between workers is weighed again once its wait ends.
    const waiting = this.#waiting.get(space);
    if (waiting !== undefined) waiting.sessionsPlace = true;
    else if (!this.#leasedElsewhere(space)) this.#place(space, []);
  }

  /**
   * Places `space` on a worker and hands it `notices`, the commits admitted
   * for the space that its tenure is owed. Returns the worker.
   */
  #place(space: string, notices: readonly AdmittedCommitNotice[]): PoolWorker {
    const worker = this.#workerToPlaceOn(space);
    this.#heapStopped.delete(space);
    worker.spaces.add(space);
    this.#placements.set(space, worker);
    if (worker.serving) this.#introduce(worker, [space], notices);
    else for (const notice of notices) worker.backlog.push(notice);
    this.#keepSpares();
    return worker;
  }

  /**
   * Helper for `#place()`, which picks the worker `space` is placed on next:
   * a spare, or a fresh one, while fewer than `maxWorkers` are placed on;
   * at the cap, the placed-on worker with the fewest spaces, one that holds
   * only parked runtimes first. A space whose last worker reached its heap
   * limit gets a spare or a fresh worker whatever the cap, and keeps it to
   * itself; so a pool at its cap whose workers are all kept that way starts
   * a fresh one for any other space too.
   */
  #workerToPlaceOn(space: string): PoolWorker {
    const usable = [...this.#workers].filter((worker) =>
      worker.retiring === undefined
    );
    const unplacedOn = (): PoolWorker => {
      const spares = usable.filter((worker) => worker.spaces.size === 0);
      return spares.find((worker) => worker.serving) ?? spares[0] ??
        this.#spawn();
    };
    if (this.#heapKills.has(space)) {
      const own = unplacedOn();
      own.alone = true;
      return own;
    }
    const placedOn = usable.filter((worker) => worker.spaces.size > 0);
    if (placedOn.length < this.#maxWorkers) return unplacedOn();
    const joinable = placedOn.filter((worker) => !worker.alone);
    if (joinable.length === 0) return unplacedOn();
    this.#counts.shared += 1;
    const rank = (worker: PoolWorker) =>
      (worker.occupancy === "parked" ? 0 : 1) + 2 * worker.spaces.size;
    return joinable.reduce((best, worker) =>
      rank(worker) < rank(best) ? worker : best
    );
  }

  /**
   * Starts spares until the pool keeps `spareWorkers` of them. A pool at
   * its cap starts none, since no placement would take one, and neither
   * does one waiting out a failed spare's backoff.
   */
  #keepSpares(): void {
    if (this.#closed || this.#spareBackoffs > 0) return;
    let spares = 0;
    let placedOn = 0;
    for (const worker of this.#workers) {
      if (worker.spaces.size > 0) placedOn += 1;
      else if (worker.retiring === undefined) spares += 1;
    }
    if (placedOn >= this.#maxWorkers) return;
    for (; spares < this.#spareWorkers; spares += 1) this.#spawn();
  }

  /**
   * Tells a serving worker of `spaces`, placed on it: each space's sessions
   * as the server holds them, which brings the worker's mirror up to date,
   * then `notices`, then the activation trigger a client session's open
   * would have been, once per space that has one.
   */
  #introduce(
    worker: PoolWorker,
    spaces: readonly string[],
    notices: readonly AdmittedCommitNotice[],
  ): void {
    const { observer } = worker.bridge;
    for (const space of spaces) {
      for (const event of this.#options.server.sessionSnapshot(space)) {
        observer.sessionChanged(event);
      }
    }
    for (const notice of notices) this.#send(worker, notice);
    for (const space of spaces) {
      if (this.#hasClientSessions(space)) observer.sessionOpened(space);
    }
  }

  /**
   * Sends `notice` to a serving worker's host, keeping a warm-marked one as
   * outstanding until a wave commits in its space.
   */
  #send(worker: PoolWorker, notice: AdmittedCommitNotice): void {
    if (notice.warm === true) worker.warmOutstanding.push(notice);
    worker.bridge.observer.commitAdmitted(notice);
  }

  /** Starts a worker, which serves once its host answers `worker.init`. */
  #spawn(): PoolWorker {
    const { server, identity } = this.#options;
    // The component is this worker's own: its loopback connections name it
    // to the server, whose lease read then matches the holder the worker's
    // host acquires under.
    const processInstanceId = crypto.randomUUID();
    // The worker reports a failure only after `started` is built below.
    let onFailed: ServingThreadOptions["onFailed"] = () => {};
    const worker = (this.#options.startThread ?? startServingThread)(
      this.#options.workerModule ??
        new URL("./serving-worker.ts", import.meta.url),
      {
        ...(this.#options.heapLimitMb === undefined
          ? {}
          : { heapLimitMb: this.#options.heapLimitMb }),
        onFailed: (message, cause) => onFailed(message, cause),
      },
    );
    const intervalMs = this.#options.watchdogIntervalMs ??
      WATCHDOG_INTERVAL_MS;
    const started: PoolWorker = {
      worker,
      bridge: new ServingPortBridge({
        server,
        port: worker.port,
        leaseHolderInstance: processInstanceId,
        // A committed wave is the progress a space whose workers keep
        // failing never makes, as the host's own failure streak counts it:
        // an activation is not, since a worker can activate a space and
        // fail at its first wave.
        onWaveCommitted: (space) => {
          this.#failures.delete(space);
          started.warmOutstanding = started.warmOutstanding.filter((notice) =>
            notice.space !== space
          );
        },
        onOccupancy: (occupancy) => this.#onOccupancy(started, occupancy),
        onHeartbeat: (heartbeat) => this.#onHeartbeat(started, heartbeat),
        ...(this.#options.moduleCompiler === undefined
          ? {}
          : { moduleCompiler: this.#options.moduleCompiler }),
        ...(this.#options.onActivationSettled === undefined
          ? {}
          : { onActivationSettled: this.#options.onActivationSettled }),
        ...(this.#options.onSpaceParked === undefined
          ? {}
          : { onSpaceParked: this.#options.onSpaceParked }),
      }),
      holder: executionLeaseHolder(identity.did(), processInstanceId),
      ready: Promise.resolve(),
      serving: false,
      gone: false,
      lifetimeLock: undefined,
      watchdog: undefined,
      spaces: new Set(),
      alone: false,
      backlog: [],
      occupancy: undefined,
      parkedAt: 0,
      heapUsed: 0,
      retiring: undefined,
      sentWhileRetiring: [],
      warmOutstanding: [],
      openedWhileRetiring: new Set(),
      reportedWhileRetiring: false,
    };
    started.watchdog = this.#watch(started, intervalMs);
    const init: ServingWorkerInit = {
      serviceKeyPair: realmValueFromKeyPair(identity.keyPair),
      processInstanceId,
      heartbeatIntervalMs: intervalMs,
      apiUrl: this.#options.apiUrl.href,
      policy: this.#options.policy,
      ensureSpaceRoots: this.#options.ensureSpaceRoots,
      experimental: this.#options.experimental,
      route: this.#options.route?.href,
      compileOnHost: this.#options.moduleCompiler !== undefined,
      compileCacheDir: this.#options.compileCacheDir,
    };
    started.ready = started.bridge.init(init).then(({ lifetimeLock }) => {
      // The worker's answer and its error event can reach this thread in one
      // turn, and the error's handler then runs ahead of this continuation:
      // a worker that failed that way counts toward the backoff, and is not
      // serving.
      if (started.gone) return;
      started.lifetimeLock = lifetimeLock;
      started.serving = true;
      this.#spareFailures = 0;
      const backlog = started.backlog;
      started.backlog = [];
      this.#introduce(started, [...started.spaces], backlog);
    });
    started.ready.catch((error) => {
      this.#onWorkerFailed(started, String(error));
    });
    onFailed = (message, cause) =>
      this.#onWorkerFailed(started, message, cause);
    this.#workers.add(started);
    this.#counts.started += 1;
    return started;
  }

  /**
   * Helper for `#spawn()`, which starts the timer that watches `watched`
   * for silence (serving-loop.md §2). It counts its own firings instead of
   * reading a clock, so nothing but the worker's silence moves the count: a
   * main thread that itself stalled, or a process that was suspended, fires the
   * timer once on waking, with the worker's messages already queued behind it.
   * The count starts at the worker's first message, since until its modules
   * have loaded a worker has no timer to post from and no lease to release.
   */
  #watch(
    watched: PoolWorker,
    intervalMs: number,
  ): ReturnType<typeof setInterval> {
    let lastSeen = 0;
    let silentIntervals = 0;
    return setInterval(() => {
      const seen = watched.bridge.messagesReceived;
      if (seen === 0) return;
      if (seen !== lastSeen) {
        lastSeen = seen;
        silentIntervals = 0;
        return;
      }
      silentIntervals += 1;
      if (silentIntervals < WATCHDOG_SILENT_INTERVALS) return;
      this.#onWorkerFailed(
        watched,
        `no message in ${silentIntervals} watchdog intervals`,
        { killed: true },
      );
    }, intervalMs);
  }

  /**
   * What a worker's host says it holds. A host that holds nothing is asked
   * to close; one that holds only parked runtimes counts toward the cap on
   * such workers. A spare's host holds nothing by design and is kept.
   */
  #onOccupancy(worker: PoolWorker, occupancy: HostOccupancy): void {
    worker.occupancy = occupancy;
    if (occupancy === "parked") {
      this.#parks += 1;
      worker.parkedAt = this.#parks;
    }
    if (worker.retiring !== undefined) worker.reportedWhileRetiring = true;
    this.#actOnOccupancy(worker);
  }

  /**
   * Helper for `#onOccupancy()`, which does what the host's last report
   * calls for: a request to close for `vacant`, and a look at the cap on
   * parked workers for `parked`.
   */
  #actOnOccupancy(worker: PoolWorker): void {
    if (worker.spaces.size === 0) return;
    if (worker.occupancy === "vacant") {
      this.#retire(worker, { evenIfParked: false });
    } else if (worker.occupancy === "parked") {
      this.#evictParkedWorkers();
    }
  }

  /**
   * A worker's heartbeat: its heap, which the heap budget adds up. A worker
   * that says its heap has reached its limit is taken out of the pool as one
   * that failed: what it was doing then is gone, and a worker that was in a
   * message's handler takes no further message, though its timers go on
   * posting heartbeats. The size of its heap does not say so, since the heap
   * a worker reports can stop short of the limit that ended a handler, pass
   * it without reaching it, and shrink once the handler is gone. A worker
   * whose buffers outside the heap come to the limit is taken out the same
   * way, at the heartbeat that reports them, since nothing else bounds them.
   */
  #onHeartbeat(worker: PoolWorker, heartbeat: WorkerHeartbeat): void {
    worker.heapUsed = heartbeat.heapUsed;
    const limitMb = this.#options.heapLimitMb;
    const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));
    let reached: string | undefined;
    if (heartbeat.heapLimitReached) {
      reached = "its heap reached its limit" +
        (limitMb === undefined ? "" : ` of ${limitMb} MB`) +
        `, and holds ${megabytes(heartbeat.heapUsed)} MB now`;
    } else if (
      limitMb !== undefined && heartbeat.external >= limitMb * 1024 * 1024
    ) {
      reached = "its buffers outside the heap hold " +
        `${megabytes(heartbeat.external)} MB, at the ${limitMb} MB its heap ` +
        "is limited to";
    }
    if (reached !== undefined) {
      this.#onWorkerFailed(worker, reached, {
        killed: true,
        atHeapLimit: true,
      });
      return;
    }
    this.#evictParkedWorkers();
  }

  /**
   * Asks the workers that hold only parked runtimes to close, the longest
   * parked first, until no more than `maxParkedRuntimes` remain and the
   * workers' heaps fit the heap budget, as far as closing such workers can
   * make them.
   */
  #evictParkedWorkers(): void {
    const parked = [...this.#workers].filter((worker) =>
      worker.spaces.size > 0 && worker.occupancy === "parked" &&
      worker.retiring === undefined
    ).sort((a, b) => a.parkedAt - b.parkedAt);
    const budget = this.#options.heapBudgetBytes;
    let overBudget = 0;
    if (budget !== undefined) {
      for (const worker of this.#workers) overBudget += worker.heapUsed;
      overBudget -= budget;
    }
    let kept = parked.length;
    for (const worker of parked) {
      if (kept <= this.#maxParkedWorkers && overBudget <= 0) break;
      this.#retire(worker, { evenIfParked: true });
      kept -= 1;
      overBudget -= worker.heapUsed;
    }
  }

  /**
   * Asks `worker`'s host to close if it holds nothing, or with
   * `evenIfParked` nothing but parked runtimes, and tears the worker down
   * once it has. The host decides as of every message sent to it before the
   * request, so a trigger already on its way keeps it open. What is sent to
   * it while the request is in flight reaches a host that may have closed,
   * so the commits among it that would start a tenure are kept for the
   * spaces' next placement.
   */
  #retire(
    worker: PoolWorker,
    { evenIfParked }: { evenIfParked: boolean },
  ): void {
    if (
      this.#closed || worker.gone || !worker.serving ||
      worker.retiring !== undefined
    ) {
      return;
    }
    worker.reportedWhileRetiring = false;
    worker.openedWhileRetiring.clear();
    worker.retiring = (async () => {
      let diagnostics: ServingLoopDiagnostics | undefined;
      try {
        diagnostics = await worker.bridge.retireHost({ evenIfParked });
      } catch (error) {
        // A worker that failed with the request in flight is the failure
        // path's already. Otherwise the host's close threw part way, which
        // leaves a host that may hold a lease and serves nothing, so the
        // worker goes the way a failed one does.
        worker.retiring = undefined;
        this.#onWorkerFailed(worker, `closing its host failed: ${error}`);
        return false;
      }
      worker.retiring = undefined;
      if (diagnostics === undefined || worker.gone) {
        worker.sentWhileRetiring = [];
        // A report that arrived with the request in flight asked for
        // nothing then, so it is acted on now that the host has stayed.
        if (!worker.gone && worker.reportedWhileRetiring) {
          this.#actOnOccupancy(worker);
        }
        return false;
      }
      const cause = evenIfParked && worker.occupancy === "parked"
        ? "evicted"
        : "retired";
      this.#counts[cause] += 1;
      this.#closedDiagnostics = mergeServingLoopDiagnostics([
        ...(this.#closedDiagnostics === undefined
          ? []
          : [this.#closedDiagnostics]),
        diagnostics,
      ]);
      // The host served every space it held until nothing was left, as an
      // idle park says of one tenure.
      for (const space of worker.spaces) {
        this.#failures.delete(space);
        this.#heapKills.delete(space);
      }
      const owed = worker.sentWhileRetiring;
      this.#forget(worker);
      this.#resumeAfter(
        worker,
        owed,
        worker.worker.terminate(worker.lifetimeLock).then(() => {
          worker.bridge.releaseLeasesOf(worker.holder);
        }),
        { failed: false },
      );
      this.#reportWorkerClosed(worker, cause);
      return true;
    })();
  }

  /**
   * Takes `worker` out of the pool: its watchdog stops; its bridge closes,
   * which closes the loopback connections its runtimes held, fails whatever
   * still waits on the worker, and drops every message the worker sends
   * afterwards; and its host's counters join those of the hosts that closed
   * before it. Its spaces stay placed on it for the caller to move.
   */
  #forget(worker: PoolWorker): void {
    worker.gone = true;
    clearInterval(worker.watchdog);
    this.#closedStats = mergeServingLoopStats([
      this.#closedStats,
      closedHostServingLoopStats(
        worker.bridge.stats() ?? emptyServingLoopStats(),
      ),
    ]);
    worker.bridge.close();
    this.#workers.delete(worker);
  }

  /** Tells the `onWorkerClosed` observer that `worker` left the pool. */
  #reportWorkerClosed(
    worker: PoolWorker,
    cause: "retired" | "evicted" | "failed",
  ): void {
    try {
      this.#options.onWorkerClosed?.([...worker.spaces], cause);
    } catch (error) {
      logger.warn("worker-closed-observer-failed", () => [
        "worker-closed observer threw",
        error,
      ]);
    }
  }

  /**
   * Leaves the spaces placed on `worker`, which is gone, waiting until
   * `teardown` has settled, and then places each one that still has
   * something to serve: a commit among `owed` or admitted meanwhile that
   * would start a tenure, a client session that counts toward a placement
   * (`WaitingSpace.sessionsPlace`), or, where the worker failed, events its
   * store still holds undelivered. A space left unplaced at a heap limit
   * (`#heapStopped`) is placed for such a commit alone.
   */
  #resumeAfter(
    worker: PoolWorker,
    owed: readonly AdmittedCommitNotice[],
    teardown: Promise<void>,
    { failed }: { failed: boolean },
  ): void {
    const spaces = [...worker.spaces];
    const resumed = teardown.catch((error) => {
      logger.warn("worker-teardown-failed", () => [
        "tearing down a serving worker failed",
        error,
      ]);
    }).then(async () => {
      // A failed worker may have taken events it never served, which the
      // store still holds undelivered and nothing announces again.
      const undelivered = failed && !this.#closed
        ? new Set(
          (await Promise.all(spaces.map(async (space) =>
            await this.#hasUndeliveredEvents(space) ? [space] : []
          ))).flat(),
        )
        : new Set<string>();
      this.#teardowns.delete(resumed);
      for (const space of spaces) {
        const waiting = this.#waiting.get(space);
        this.#waiting.delete(space);
        if (
          this.#closed || waiting === undefined || this.#leasedElsewhere(space)
        ) {
          continue;
        }
        if (
          waiting.notices.length > 0 ||
          (!this.#heapStopped.has(space) &&
            (undelivered.has(space) ||
              (waiting.sessionsPlace && this.#hasClientSessions(space))))
        ) {
          this.#place(space, waiting.notices);
        }
      }
      this.#keepSpares();
    });
    this.#teardowns.add(resumed);
    for (const space of spaces) {
      this.#placements.delete(space);
      this.#waiting.set(space, {
        notices: owed.filter((notice) => notice.space === space),
        failed,
        sessionsPlace: failed || worker.openedWhileRetiring.has(space),
        resumed,
      });
    }
  }

  /**
   * Takes a worker that failed out of the pool, as the class's doc comment
   * describes. Once the worker is gone, the leases it held are released, so
   * that the workers its spaces are placed on next, which carry holders of
   * their own, acquire them at once. The leases of a worker the watchdog
   * `killed` count as lost.
   *
   * `terminate()` takes effect when a worker's thread next reaches its event
   * loop, and a stalled thread may never do so, nor release its lifetime lock.
   * So nothing waits for a killed worker's teardown. What its thread still does
   * cannot reach the memory server, whose port to it closed here, and the
   * commits it left in flight name a holder no lease is held under.
   *
   * A worker that failed `atHeapLimit` has its spaces dealt with as the
   * class's doc comment describes.
   */
  #onWorkerFailed(
    worker: PoolWorker,
    message: string,
    { killed = false, atHeapLimit = false }: {
      killed?: boolean;
      atHeapLimit?: boolean;
    } = {},
  ): void {
    if (worker.gone) return;
    if (killed) worker.lifetimeLock = undefined;
    if (atHeapLimit) this.#counts.heapLimited += 1;
    const spare = worker.spaces.size === 0;
    // The one space the worker served, which is left unplaced: the commits
    // the worker was owed or took would only start the same program again.
    const [stopped] = atHeapLimit && worker.spaces.size === 1
      ? worker.spaces
      : [];
    // A commit the worker never took, since its host never served, is owed
    // to the space's next placement like one sent to a host that closed,
    // and so is a warm request the worker took and committed no wave for.
    const owed = stopped !== undefined ? [] : [
      ...new Set([
        ...worker.warmOutstanding,
        ...worker.backlog,
        ...worker.sentWhileRetiring,
      ]),
    ].filter((notice) =>
      admissionActivates(notice, () => this.#hasClientSessions(notice.space))
    );
    this.#forget(worker);
    this.#counts.failed += 1;
    const terminated = worker.worker.terminate(worker.lifetimeLock)
      .then(() => {
        const released = worker.bridge.releaseLeasesOf(worker.holder);
        if (killed) this.#leasesLost += released;
      });
    let streak: number;
    if (spare) {
      this.#spareFailures += 1;
      streak = this.#spareFailures;
    } else if (stopped !== undefined) {
      streak = (this.#heapKills.get(stopped) ?? 0) + 1;
      this.#heapKills.set(stopped, streak);
      this.#heapStopped.add(stopped);
    } else if (atHeapLimit) {
      // Which of them grew the heap is not known yet, so none is charged
      // with a failure; each is watched on a worker of its own.
      streak = 1;
      for (const space of worker.spaces) {
        if (!this.#heapKills.has(space)) this.#heapKills.set(space, 0);
      }
    } else {
      streak = 0;
      for (const space of worker.spaces) {
        const failures = (this.#failures.get(space) ?? 0) + 1;
        this.#failures.set(space, failures);
        streak = Math.max(streak, failures);
      }
    }
    if (this.#closed) {
      this.#resumeAfter(worker, [], terminated, { failed: true });
      return;
    }
    const delayMs = failureParkBackoffDelayMs(streak, this.#options.policy);
    logger.error(
      "worker-failed",
      `a serving worker failed (${message}); ` +
        (spare
          ? `starting another spare in ${delayMs}ms`
          : stopped !== undefined
          ? `leaving space ${stopped}, the only one it served, unplaced ` +
            "until a commit or a lifecycle verb names it, and no sooner " +
            `than in ${delayMs}ms`
          : atHeapLimit
          ? `placing its ${worker.spaces.size} spaces ` +
            `(${[...worker.spaces].join(", ")}) again in ${delayMs}ms, ` +
            "each on a worker of its own"
          : `placing its ${worker.spaces.size} space(s) again in ${delayMs}ms`),
    );
    this.#reportWorkerClosed(worker, "failed");
    const { promise: waited, resolve: wake } = Promise.withResolvers<void>();
    const backoff = setTimeout(() => {
      this.#backoffs.delete(backoff);
      wake();
    }, delayMs);
    this.#backoffs.set(backoff, wake);
    if (spare) this.#spareBackoffs += 1;
    this.#resumeAfter(
      worker,
      owed,
      Promise.all([terminated, waited]).then(() => {
        if (spare) this.#spareBackoffs -= 1;
      }),
      { failed: true },
    );
  }
}
