/**
 * A serving worker's thread (serving-loop-worker.md), and the serving port on
 * each side of it. A thread given a heap limit is a `node:worker_threads`
 * worker whose old generation the limit bounds, so that reaching the limit
 * stops what grew the heap and the process that started the thread goes on.
 * Deno's `Worker` takes no such limit, and a Deno `Worker` that reaches the
 * isolate's heap limit aborts the whole process, so a thread without one is a
 * Deno `Worker`, which lets a test stand in for it through the global
 * `Worker`.
 *
 * What a thread does at its limit depends on where it was:
 *
 * - While it evaluated its modules, or in a timer's callback, it ends, and
 *   `onFailed` reports it.
 * - In a message's handler, Deno ends the handler and nothing else. The
 *   thread reports no error, takes no further message, and keeps running its
 *   timers.
 * - In a promise's continuation, Deno ends the continuation. Its promise
 *   never settles, and the thread goes on taking messages.
 *
 * In the last two, Deno also raises the thread's limit, so what the thread
 * does next can grow past it. Such a thread is not ended by itself and what
 * it was doing is gone, so whoever started it has to end it: the thread says
 * that it reached its limit through {@link watchHeapLimit}, which the serving
 * worker's heartbeat carries to `ServingWorkerPool`.
 *
 * The limit bounds the JavaScript heap. The memory of array buffers is
 * outside it, and V8 bounds it nowhere.
 */

import { getHeapStatistics } from "@node/v8";
import { parentPort, Worker as ThreadWorker } from "@node/worker_threads";
import { terminateWorker } from "@commonfabric/platform/worker-lifetime";
import type { PortLike } from "./serving-port-protocol.ts";

/**
 * The least heap limit a thread is started with, in megabytes. Deno aborts
 * the whole process when it starts a thread with a limit of a few megabytes,
 * where a thread with a limit it cannot load its modules in fails alone.
 */
export const MIN_SERVING_THREAD_HEAP_LIMIT_MB = 16;

/** One serving worker's thread, however it was started. */
export type ServingThread = {
  /** The pool's end of the serving port. */
  readonly port: PortLike;

  /**
   * Ends the thread. A Deno `Worker` given the `lifetimeLock` it handed over
   * settles once its runtime has been torn down. A thread with a heap limit,
   * and one with no `lifetimeLock`, which a thread that never handed one over
   * or that a watchdog killed has, settle once the thread has been told to
   * end: a stalled thread may never reach its teardown, and Deno releases the
   * locks of a `node:worker_threads` thread as it is told to end.
   */
  terminate(lifetimeLock: string | undefined): Promise<void>;
};

/** What a thread that failed says of why. */
export type ServingThreadFailure = {
  /** Whether the thread ended because its heap reached `heapLimitMb`. */
  atHeapLimit: boolean;
};

/** How {@link startServingThread} starts a thread. */
export type ServingThreadOptions = {
  /**
   * The largest the thread's old generation may grow, in megabytes: a whole
   * number, {@link MIN_SERVING_THREAD_HEAP_LIMIT_MB} or more. Absent, the
   * thread is a Deno `Worker` under the process's own heap limit.
   */
  heapLimitMb?: number;

  /**
   * Called with what ended the thread, when anything but `terminate()` ended
   * it: an uncaught error, reaching its heap limit, or an exit of its own.
   * Called at most once.
   */
  onFailed(message: string, cause: ServingThreadFailure): void;
};

/**
 * Throws unless `heapLimitMb` is a limit a thread can be started with
 * ({@link ServingThreadOptions.heapLimitMb}).
 */
export function assertServingThreadHeapLimit(heapLimitMb: number): void {
  if (
    !Number.isSafeInteger(heapLimitMb) ||
    heapLimitMb < MIN_SERVING_THREAD_HEAP_LIMIT_MB
  ) {
    throw new RangeError(
      `\`heapLimitMb\` is ${heapLimitMb}; a serving worker's heap limit is ` +
        `a whole number of megabytes, ${MIN_SERVING_THREAD_HEAP_LIMIT_MB} ` +
        "or more",
    );
  }
}

/**
 * Starts a serving worker's thread running `module`.
 *
 * @throws RangeError for a heap limit a thread cannot be started with.
 */
export function startServingThread(
  module: URL,
  options: ServingThreadOptions,
): ServingThread {
  if (options.heapLimitMb !== undefined) {
    assertServingThreadHeapLimit(options.heapLimitMb);
  }
  let failed = false;
  const fail = (message: string, atHeapLimit = false) => {
    if (failed) return;
    failed = true;
    options.onFailed(message, { atHeapLimit });
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
    fail(
      error instanceof Error ? error.message : String(error),
      error instanceof Error && "code" in error &&
        error.code === "ERR_WORKER_OUT_OF_MEMORY",
    );
  });
  thread.on("exit", (code: number) => {
    if (!terminating) fail(`the serving worker exited with code ${code}`);
  });
  return {
    port: threadPort(thread),
    terminate: async () => {
      terminating = true;
      await thread.terminate();
    },
  };
}

/**
 * Starts watching the heap limit of the thread this is called in, and returns
 * a function that says whether the thread has reached the limit since. Deno
 * raises a thread's limit each time the thread reaches it, and at no other
 * time, so a limit above the one the watch began with is a limit reached,
 * however long ago and whatever the heap has shrunk to since. A Deno `Worker`
 * aborts its process at its limit, so the function returns `false` there for
 * as long as it can be called.
 */
export function watchHeapLimit(): () => boolean {
  const limit = getHeapStatistics().heap_size_limit;
  return () => getHeapStatistics().heap_size_limit > limit;
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
