import { WebWorkerRuntimeTransport } from "@commonfabric/runtime-client/transports/web-worker";

import { WORKER_EXIT_LOCK_VARIABLE } from "./worker-exit-lock.ts";

/** The worker entry that holds the exit lock before loading the runtime. */
const WORKER_URL = new URL("./fixtures/runtime-worker.ts", import.meta.url);

/** How long `settle()` waits for the workers by default. */
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;

/** How often `settle()` tries the lock while it waits. */
const SETTLE_POLL_MS = 25;

/**
 * Starts the runtime workers a test file uses, and waits at the end of the file
 * until every one of them is gone.
 *
 * Why: a terminated worker keeps running on its own thread while it writes its
 * coverage profiles, and a test process that exits during that write leaves a
 * truncated profile, which fails the coverage conversion for the whole lane
 * (`worker-exit-lock.ts` has the mechanism). Waiting for the workers rather
 * than for a guessed interval is what makes the exit safe on a slow machine.
 *
 * Each worker holds a shared lock on one file for its whole life. `settle()`
 * terminates whatever this barrier started that is still running, then takes
 * the lock exclusively, which it can do only once every worker's runtime has
 * been torn down, and so only once every profile is written.
 *
 * One barrier serves one test process: the workers find the lock through an
 * environment variable, which a process has one of.
 */
export class WorkerExitBarrier {
  readonly #lockPath: string;
  readonly #transports = new Set<WebWorkerRuntimeTransport>();
  #settled = false;

  /** Whether this process has made a barrier, since it can hold only one. */
  static #created = false;

  private constructor(lockPath: string) {
    this.#lockPath = lockPath;
  }

  /** Makes the lock file and names it to the workers this process starts. */
  static async create(): Promise<WorkerExitBarrier> {
    // Asked of this module rather than of the environment: a process that a
    // test started inherits its parent's variable, naming the parent's lock.
    if (WorkerExitBarrier.#created) {
      throw new Error("One WorkerExitBarrier serves one process");
    }
    WorkerExitBarrier.#created = true;
    const lockPath = await Deno.makeTempFile({
      prefix: "runtime-worker-exit-",
    });
    Deno.env.set(WORKER_EXIT_LOCK_VARIABLE, lockPath);
    return new WorkerExitBarrier(lockPath);
  }

  /**
   * Starts a runtime worker and resolves once it reports ready, as
   * `WebWorkerRuntimeTransport.connect()` does. A worker that fails to become
   * ready is terminated by `connect()` itself, and is waited for with the rest.
   */
  async connect(): Promise<WebWorkerRuntimeTransport> {
    if (this.#settled) {
      throw new Error(
        "WorkerExitBarrier has settled: it starts no more workers",
      );
    }
    const transport = await WebWorkerRuntimeTransport.connect({
      workerUrl: WORKER_URL,
    });
    this.#transports.add(transport);
    return transport;
  }

  /**
   * Terminates every worker this barrier started, then resolves once each is
   * gone and so has finished writing its coverage profiles.
   *
   * Terminating again a worker a test already disposed of does nothing. One a
   * test left running is terminated here rather than waited on, since a worker
   * that is still running would hold the lock forever.
   *
   * @throws If the workers are not all gone within `timeoutMs`. A worker still
   *   holding the lock by then is stuck, and exiting under it could truncate a
   *   profile, so the wait fails loudly rather than letting the process go.
   */
  async settle(
    { timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.#settled = true;
    for (const transport of this.#transports) await transport.dispose();
    this.#transports.clear();

    const file = await Deno.open(this.#lockPath, { read: true });
    try {
      const deadline = Date.now() + timeoutMs;
      while (!await file.tryLock(true)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `A runtime worker still held ${this.#lockPath} ${timeoutMs}ms after every worker was terminated. It may still be writing its coverage profiles, so the test process must not exit under it.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }
      await file.unlock();
    } finally {
      file.close();
    }
    Deno.env.delete(WORKER_EXIT_LOCK_VARIABLE);
    await Deno.remove(this.#lockPath);
  }
}
