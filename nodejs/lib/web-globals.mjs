// Web APIs that Deno provides as globals and Node does not:
//
// * `Worker` (the Web Worker API), over `node:worker_threads`. A worker
//   started this way gets the in-worker half too: `self`, `postMessage()`,
//   `close()`, and `message` events on the global scope.
// * `indexedDB` and its classes, from `fake-indexeddb` (in memory; Deno's is
//   persistent).

import * as workerThreads from "node:worker_threads";
import "fake-indexeddb/auto";

/** `workerData` key marking a thread started by the `Worker` shim. */
const WEB_WORKER_MARK = "__cfWebWorker";

/** Dispatches a `message` (or `messageerror`) event and calls `on<type>`. */
function deliver(target, type, init) {
  const event = new MessageEvent(type, init);
  target.dispatchEvent(event);
  const handler = target[`on${type}`];
  if (typeof handler === "function") handler.call(target, event);
}

/**
 * Works around a Node defect (seen in 26.11): when a terminated worker's Web
 * Locks are released, a request for one of them that another thread queued
 * beforehand is not granted; it stays pending although nothing holds the
 * lock. An `ifAvailable` request for the same name makes the lock manager
 * process that name's queue.
 */
async function wakePendingLocks() {
  const { pending = [] } = await navigator.locks.query();
  const names = new Set(pending.map((p) => p.name));
  for (const name of names) {
    await navigator.locks.request(name, { ifAvailable: true }, () => {});
  }
}

class Worker extends EventTarget {
  #thread;

  onmessage = null;
  onmessageerror = null;
  onerror = null;

  constructor(specifier, options = {}) {
    super();
    const url = specifier instanceof URL
      ? specifier
      : new URL(String(specifier));
    if (options.type !== undefined && options.type !== "module") {
      throw new TypeError("Only module workers are supported.");
    }
    this.#thread = new workerThreads.Worker(url, {
      name: options.name,
      workerData: { [WEB_WORKER_MARK]: true },
    });
    this.#thread.on("exit", () => void wakePendingLocks());
    this.#thread.on("message", (data) => deliver(this, "message", { data }));
    this.#thread.on(
      "messageerror",
      (error) => deliver(this, "messageerror", { data: error }),
    );
    this.#thread.on("error", (error) => {
      const event = new ErrorEvent("error", {
        error,
        message: error?.message ?? String(error),
        cancelable: true,
      });
      this.dispatchEvent(event);
      if (typeof this.onerror === "function") this.onerror(event);
      if (!event.defaultPrevented) {
        // As in a browser and Deno: an unhandled worker error is reported.
        console.error(error);
      }
    });
  }

  postMessage(message, transferOrOptions) {
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : transferOrOptions?.transfer;
    this.#thread.postMessage(message, transfer);
  }

  terminate() {
    void this.#thread.terminate();
  }
}

if (typeof globalThis.Worker === "undefined") {
  globalThis.Worker = Worker;
}

/**
 * Makes the global scope of a shim-started worker look like a web worker's.
 * The port's listener attaches on the first `message` handler: Node queues
 * messages on a port until then, which matches a web worker receiving the
 * messages posted before its module finished evaluating.
 */
function installWorkerScope() {
  const port = workerThreads.parentPort;
  const target = new EventTarget();
  const scope = globalThis;
  const handlers = { message: null, messageerror: null };
  const attached = new Set();

  const attach = (type) => {
    if (attached.has(type)) return;
    attached.add(type);
    port.on(type, (data) => {
      const event = new MessageEvent(type, { data });
      target.dispatchEvent(event);
      if (typeof handlers[type] === "function") {
        handlers[type].call(scope, event);
      }
    });
  };

  scope.self = scope;
  scope.addEventListener = (type, ...rest) => {
    target.addEventListener(type, ...rest);
    if (type in handlers) attach(type);
  };
  scope.removeEventListener = target.removeEventListener.bind(target);
  scope.dispatchEvent = target.dispatchEvent.bind(target);
  for (const type of Object.keys(handlers)) {
    Object.defineProperty(scope, `on${type}`, {
      configurable: true,
      get: () => handlers[type],
      set: (fn) => {
        handlers[type] = fn;
        attach(type);
      },
    });
  }
  scope.postMessage = (message, transferOrOptions) => {
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : transferOrOptions?.transfer;
    port.postMessage(message, transfer);
  };
  scope.close = () => {
    port.close();
    process.exit(0);
  };
}

if (
  !workerThreads.isMainThread &&
  workerThreads.workerData?.[WEB_WORKER_MARK] === true
) {
  installWorkerScope();
}
