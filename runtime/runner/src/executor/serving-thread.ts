/**
 * A serving worker's thread (serving-loop-worker.md), and the serving port on
 * each side of it. A thread given a heap limit is a `node:worker_threads`
 * worker whose old generation the limit bounds: one that reaches the limit is
 * ended by itself, and the process that started it goes on. Deno's `Worker`
 * takes no such limit, and a Deno `Worker` that reaches the isolate's heap
 * limit aborts the whole process, so a thread without one is a Deno `Worker`,
 * which lets a test stand in for it through the global `Worker`.
 */

// deno-lint-ignore no-external-import -- Deno takes a per-thread heap limit only through Node's worker threads.
import { parentPort, Worker as ThreadWorker } from "node:worker_threads";
import { terminateWorker } from "@commonfabric/platform/worker-lifetime";
import type { PortLike } from "./serving-port-protocol.ts";

/** One serving worker's thread, however it was started. */
export type ServingThread = {
  /** The pool's end of the serving port. */
  readonly port: PortLike;

  /**
   * Ends the thread, and settles once its runtime has been torn down. With no
   * `lifetimeLock`, which a thread that never handed one over or that a
   * watchdog killed has, it settles once the thread has been told to end,
   * since a stalled thread may never reach its teardown.
   */
  terminate(lifetimeLock: string | undefined): Promise<void>;
};

/** How {@link startServingThread} starts a thread. */
export type ServingThreadOptions = {
  /**
   * The largest the thread's old generation may grow, in megabytes. Absent,
   * the thread is a Deno `Worker` under the process's own heap limit.
   */
  heapLimitMb?: number;

  /**
   * Called with what ended the thread, when anything but `terminate()` ended
   * it: an uncaught error, reaching its heap limit, or an exit of its own.
   * Called at most once.
   */
  onFailed(message: string): void;
};

/** Starts a serving worker's thread running `module`. */
export function startServingThread(
  module: URL,
  options: ServingThreadOptions,
): ServingThread {
  let failed = false;
  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    options.onFailed(message);
  };
  if (options.heapLimitMb === undefined) {
    const worker = new Worker(module, { type: "module", name: "serving-loop" });
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message);
    };
    return {
      port: worker,
      terminate: (lifetimeLock) => terminateWorker(worker, lifetimeLock),
    };
  }
  const thread = new ThreadWorker(module, {
    name: "serving-loop",
    resourceLimits: { maxOldGenerationSizeMb: options.heapLimitMb },
  });
  let terminating = false;
  thread.on("error", (error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
  thread.on("exit", (code: number) => {
    if (!terminating) fail(`the serving worker exited with code ${code}`);
  });
  return {
    port: threadPort(thread),
    terminate: async (lifetimeLock) => {
      terminating = true;
      const exited = thread.terminate();
      // Deno releases a thread's locks once it ends, so a lock it handed over
      // stands for the thread still running.
      if (lifetimeLock !== undefined) await exited;
    },
  };
}

/**
 * The serving port of the thread this module runs in, for a worker's entry
 * module: `node:worker_threads`' parent port in a thread started with a heap
 * limit, and the worker's global scope in a Deno `Worker`.
 */
export function servingWorkerPort(): PortLike {
  if (parentPort !== null && parentPort !== undefined) {
    return threadPort(parentPort);
  }
  return self as unknown as PortLike;
}

/** What {@link threadPort} adapts: either end of a `node:worker_threads` port. */
type ThreadEnd = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  off(event: "message", listener: (data: unknown) => void): unknown;
};

/**
 * `end` as a `PortLike`: the data each message carries is handed to a
 * listener as a `MessageEvent`'s, as a Deno `Worker` hands it.
 */
function threadPort(end: ThreadEnd): PortLike {
  const wrapped = new Map<
    (event: MessageEvent) => void,
    (data: unknown) => void
  >();
  return {
    postMessage: (message) => end.postMessage(message),
    addEventListener: (_type, listener) => {
      if (wrapped.has(listener)) return;
      const onData = (data: unknown) =>
        listener(new MessageEvent("message", { data }));
      wrapped.set(listener, onData);
      end.on("message", onData);
    },
    removeEventListener: (_type, listener) => {
      const onData = wrapped.get(listener);
      if (onData === undefined) return;
      wrapped.delete(listener);
      end.off("message", onData);
    },
  };
}
