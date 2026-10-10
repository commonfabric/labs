// The main thread's global scope as an `EventTarget`, as Deno's is (a worker
// thread's scope is set up by `web-globals.mjs` instead):
//
// * `addEventListener()`, `removeEventListener()`, and `dispatchEvent()` on
//   `globalThis`.
// * `error` events for uncaught exceptions and `unhandledrejection` events for
//   unhandled rejections, dispatched ahead of every Node listener for them
//   (including `node:test`'s, which fails the test); a listener that calls
//   `preventDefault()` keeps the error from going further, and otherwise it
//   gets Node's own handling.
// * `unload` on process exit.
//
// And, in every thread:
//
// * `reportError()`, which dispatches an `error` event and, unless a listener
//   prevents its default, goes on as an uncaught exception.
// * `ErrorEvent` and `PromiseRejectionEvent`, where Node lacks them.

import process from "node:process";
import { isMainThread } from "node:worker_threads";

class PromiseRejectionEvent extends Event {
  #promise;
  #reason;

  constructor(type, init) {
    super(type, init);
    this.#promise = init.promise;
    this.#reason = init.reason;
  }

  get promise() {
    return this.#promise;
  }

  get reason() {
    return this.#reason;
  }
}

class ErrorEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.message = init.message ?? "";
    this.filename = init.filename ?? "";
    this.lineno = init.lineno ?? 0;
    this.colno = init.colno ?? 0;
    this.error = init.error;
  }
}

globalThis.PromiseRejectionEvent ??= PromiseRejectionEvent;
globalThis.ErrorEvent ??= ErrorEvent;

/** An error `reportError()` dispatched, on its way to Node's handling. */
let reportedError = undefined;
let hasReportedError = false;

/** Dispatches an `error` event for `error`; returns whether it was handled. */
function dispatchError(error) {
  const event = new globalThis.ErrorEvent("error", {
    cancelable: true,
    error,
    message: error instanceof Error ? error.message : String(error),
  });
  return !globalThis.dispatchEvent(event);
}

function install() {
  const target = new EventTarget();
  globalThis.addEventListener = target.addEventListener.bind(target);
  globalThis.removeEventListener = target.removeEventListener.bind(target);
  globalThis.dispatchEvent = target.dispatchEvent.bind(target);

  // Node's handling of both runs through `process.emit()`: an event no
  // listener takes (`emit()` returning false) crashes the process.
  const originalEmit = process.emit;
  process.emit = function (name, ...args) {
    if (name === "uncaughtException") {
      const [error] = args;
      if (hasReportedError && reportedError === error) {
        hasReportedError = false;
        reportedError = undefined;
      } else if (dispatchError(error)) {
        return true;
      }
    } else if (name === "unhandledRejection") {
      const [reason, promise] = args;
      const event = new globalThis.PromiseRejectionEvent(
        "unhandledrejection",
        { cancelable: true, promise, reason },
      );
      if (!globalThis.dispatchEvent(event)) return true;
    }
    return originalEmit.call(this, name, ...args);
  };

  process.on("exit", () => globalThis.dispatchEvent(new Event("unload")));
}

if (isMainThread && typeof globalThis.addEventListener !== "function") {
  install();
}

globalThis.reportError ??= function reportError(error) {
  if (typeof globalThis.dispatchEvent === "function" && dispatchError(error)) {
    return;
  }
  process.nextTick(() => {
    reportedError = error;
    hasReportedError = true;
    throw error;
  });
};
