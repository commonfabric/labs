/**
 * Starts the serving loop in a Worker of this process and keeps it running
 * (serving-loop-worker.md): one `ServingPortBridge` per worker over the
 * worker's own port, the service key and the host's options handed over as
 * the first request, and a fresh worker, under a fresh lease-holder process
 * component, when one dies.
 */

import { type Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import {
  adoptProcessInstanceId,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import type { Server } from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";
import { terminateWorker } from "@commonfabric/utils/worker-lifetime";
import type { ExperimentalOptions } from "../runtime.ts";
import type { MemorySpace } from "../storage/interface.ts";
import {
  type ExecutorHost,
  failureParkBackoffDelayMs,
  SpaceNotServedError,
} from "./host.ts";
import { ServingPortBridge } from "./serving-port-bridge.ts";
import type {
  LifecycleVerbDescriptor,
  LifecycleVerbRun,
  ServingLoopDiagnostics,
  ServingWorkerInit,
  ServingWorkerPolicy,
} from "./serving-port-protocol.ts";
import {
  emptyServingLoopStats,
  registerServingLoopStatsProvider,
  type ServingLoopStats,
} from "./stats.ts";

const logger = getLogger("serving-worker-host", {
  enabled: true,
  level: "warn",
});

/**
 * The serving loop as whatever starts it hands it back, whichever thread
 * runs it: a toolshed's bootstrap, or the serving memory server tests build.
 */
export type ServingLoopHandle = {
  /** The loop's counters: the host's, or the last the worker posted. */
  stats(): ServingLoopStats | undefined;

  /**
   * What the loop's realm logged: this process's loggers where the loop
   * runs on its main thread, the worker's where it runs there.
   */
  diagnostics(): Promise<ServingLoopDiagnostics>;

  /** The host, when the loop runs on this thread; `undefined` in a worker. */
  readonly host: ExecutorHost | undefined;

  close(): Promise<void>;
};

export type { ServingLoopDiagnostics } from "./serving-port-protocol.ts";

/** What a serving worker is built from, and the observers of its host. */
export type ServingWorkerOptions = {
  server: Server;

  /** The service identity the worker's host serves as; its key crosses. */
  identity: Identity;

  /** The serving runtimes' patterns and compile base. */
  apiUrl: URL;

  /**
   * The worker's entry module. Default: the runner's own, which builds no
   * lifecycle verbs; a deployment names an entry of its own that calls
   * `serveFromPort()` with the verbs and fetch it uses.
   */
  workerModule?: URL;

  /** The loop's policy, its data fields alone, since a closure cannot cross. */
  policy?: ServingWorkerPolicy;

  /** The host's space-root ensure switch (`ExecutorHostOptions`). */
  ensureSpaceRoots?: boolean;

  /** The serving runtimes' experimental options. */
  experimental?: ExperimentalOptions;

  /** DIAGNOSTIC (tests): the worker's activation outcomes. */
  onActivationSettled?: (
    space: MemorySpace,
    outcome: "active" | "refused" | "failed",
  ) => void;

  /** DIAGNOSTIC (tests): the worker's parks. */
  onSpaceParked?: (space: MemorySpace, reason: string) => void;
};

/** One running worker and the bridge serving it. */
type WorkerGeneration = {
  worker: Worker;
  bridge: ServingPortBridge;
  /** The lease holder this worker's rows name. */
  holder: string;

  /** Settles once the worker's host serves. */
  ready: Promise<void>;

  /** Whether `ready` has settled with the worker's host serving. */
  serving: boolean;

  /** The lifetime lock the worker's host holds, if it holds one. */
  lifetimeLock: string | undefined;
};

/**
 * The serving loop running in a Worker. Constructing one spawns it; `ready`
 * settles once the worker's host serves; `close()` closes the host and the
 * worker. A worker that fails is replaced after the same backoff the host
 * applies to a space whose tenures keep failing, widening until a worker
 * commits a wave, and the replacement adopts a new lease-holder process
 * component, so its commits never meet its predecessor's under the engine's
 * replay keying.
 */
export class ServingWorker {
  readonly #options: ServingWorkerOptions;
  #generation: WorkerGeneration | undefined;

  /** The teardown of the last worker that failed, while it runs. */
  #terminating: Promise<void> | undefined;

  /** The timer that starts the next worker, while it is pending. */
  #respawn: ReturnType<typeof setTimeout> | undefined;

  #failures = 0;
  #closed = false;

  constructor(options: ServingWorkerOptions) {
    this.#options = options;
    this.#generation = this.#spawn();
  }

  /** Settles once the current worker's host serves; rejects when it cannot. */
  get ready(): Promise<void> {
    return this.#generation?.ready ?? Promise.reject(this.#notRunning());
  }

  /** The counters the worker last posted, or none before its first. */
  stats(): ServingLoopStats | undefined {
    return this.#generation?.bridge.stats();
  }

  /** The worker's counters as of now, once its host serves. */
  async requestStats(): Promise<ServingLoopStats> {
    await this.ready;
    return await this.#bridge().requestStats();
  }

  /** What the worker's realm logged, as of now, once its host serves. */
  async diagnostics(): Promise<ServingLoopDiagnostics> {
    await this.ready;
    return await this.#bridge().requestDiagnostics();
  }

  /**
   * Runs a lifecycle verb on the worker's host, once it serves. Throws
   * {@link SpaceNotServedError} while no worker runs: once closed, and between
   * a worker that failed and its replacement.
   */
  async runLifecycleVerb(
    space: MemorySpace,
    verb: LifecycleVerbDescriptor,
  ): Promise<LifecycleVerbRun> {
    const generation = this.#generation;
    if (generation === undefined) throw new SpaceNotServedError(space);
    await generation.ready;
    return await generation.bridge.runLifecycleVerb(space, verb);
  }

  /**
   * Closes the worker's host, then the worker; settles once both are gone,
   * and once a worker that failed before the call has been torn down. A
   * worker whose host has not yet reported serving is terminated without
   * asking its host to close, since one that stalls in its startup never
   * answers. A host that does not close, for that reason or because the
   * worker fails first, leaves the lease rows its worker held to be released
   * here.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#respawn);
    this.#respawn = undefined;
    const generation = this.#generation;
    this.#generation = undefined;
    await this.#terminating;
    if (generation === undefined) {
      registerServingLoopStatsProvider(undefined);
      return;
    }
    let hostClosed = false;
    try {
      if (generation.serving) {
        await generation.bridge.closeHost();
        hostClosed = true;
      }
    } catch (error) {
      logger.warn("worker-close-failed", () => [
        "closing the serving worker's host failed; terminating the worker",
        error,
      ]);
    } finally {
      generation.bridge.close();
      await terminateWorker(generation.worker, generation.lifetimeLock);
    }
    if (!hostClosed) await generation.bridge.releaseLeasesOf(generation.holder);
  }

  #bridge(): ServingPortBridge {
    const generation = this.#generation;
    if (generation === undefined) throw this.#notRunning();
    return generation.bridge;
  }

  /** Helper for `ready` and `#bridge()`, which says why no worker runs. */
  #notRunning(): Error {
    return new Error(
      this.#closed
        ? "the serving worker is closed"
        : "the serving worker failed, and its replacement has not started",
    );
  }

  #spawn(): WorkerGeneration {
    const { server, identity } = this.#options;
    // Both realms adopt the component before the worker writes a lease row
    // under it: the server's synchronous lease scan matches it from here.
    const processInstanceId = crypto.randomUUID();
    adoptProcessInstanceId(processInstanceId);
    const worker = new Worker(
      this.#options.workerModule ??
        new URL("./serving-worker.ts", import.meta.url),
      { type: "module", name: "serving-loop" },
    );
    const bridge = new ServingPortBridge({
      server,
      port: worker,
      // A committed wave is the progress a worker that keeps failing never
      // makes, as the host's own failure streak counts it: an activation is
      // not, since a worker can activate a space and fail at its first wave.
      onWaveCommitted: () => {
        this.#failures = 0;
      },
      ...(this.#options.onActivationSettled === undefined
        ? {}
        : { onActivationSettled: this.#options.onActivationSettled }),
      ...(this.#options.onSpaceParked === undefined
        ? {}
        : { onSpaceParked: this.#options.onSpaceParked }),
    });
    const generation: WorkerGeneration = {
      worker,
      bridge,
      holder: executionLeaseHolder(identity.did(), processInstanceId),
      lifetimeLock: undefined,
      ready: Promise.resolve(),
      serving: false,
    };
    const init: ServingWorkerInit = {
      serviceKeyPair: realmValueFromKeyPair(identity.keyPair),
      processInstanceId,
      apiUrl: this.#options.apiUrl.href,
      policy: this.#options.policy,
      ensureSpaceRoots: this.#options.ensureSpaceRoots,
      experimental: this.#options.experimental,
    };
    generation.ready = bridge.init(init).then(({ lifetimeLock }) => {
      generation.lifetimeLock = lifetimeLock;
      generation.serving = true;
    });
    generation.ready.catch((error) => {
      this.#onWorkerFailed(generation, String(error));
    });
    worker.onerror = (event) => {
      event.preventDefault();
      this.#onWorkerFailed(generation, event.message);
    };
    return generation;
  }

  /**
   * Replaces a worker that reported an error it did not handle. Its bridge
   * closes first, which closes the loopback connections its runtimes held, so
   * the server sees their sessions detach, and fails whatever still waits on
   * the worker, a `close()` already under way included; once the worker is
   * gone, the lease rows it held are released, so its successor, which
   * carries a holder of its own, acquires them without waiting out their TTL.
   */
  #onWorkerFailed(generation: WorkerGeneration, message: string): void {
    const stats = generation.bridge.stats();
    generation.bridge.close();
    if (this.#generation !== generation) return;
    this.#generation = undefined;
    this.#terminating = terminateWorker(
      generation.worker,
      generation.lifetimeLock,
    ).then(() => generation.bridge.releaseLeasesOf(generation.holder)).catch(
      (error) => {
        logger.warn("worker-teardown-failed", () => [
          "tearing down the failed serving worker failed",
          error,
        ]);
      },
    );
    if (this.#closed) return;
    // The health route reads a process with no serving-loop counters as one
    // whose loop is off, so until the next worker's bridge reports its own,
    // the failed worker's last counters stand in.
    registerServingLoopStatsProvider(() => stats ?? emptyServingLoopStats());
    this.#failures += 1;
    const delayMs = failureParkBackoffDelayMs(
      this.#failures,
      this.#options.policy,
    );
    logger.error(
      "worker-failed",
      `the serving worker failed (${message}); starting another in ${delayMs}ms`,
    );
    const terminating = this.#terminating;
    this.#respawn = setTimeout(() => {
      this.#respawn = undefined;
      terminating.then(() => {
        if (this.#closed) return;
        this.#generation = this.#spawn();
      });
    }, delayMs);
  }
}
