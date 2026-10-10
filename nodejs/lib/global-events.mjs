// The global scope as an event target, as Deno (like a browser) has it:
//
// * `addEventListener()`, `removeEventListener()`, and `dispatchEvent()` on
//   `globalThis`.
// * `error` events for uncaught exceptions and `unhandledrejection` events for
//   unhandled rejections, dispatched before Node's own handling; a listener
//   that calls `preventDefault()` keeps it from going further.
// * `unload` on process exit.
// * `reportError()`, which dispatches an `error` event and, unless a listener
//   prevents its default, goes on as an uncaught exception.
// * `ErrorEvent` and `PromiseRejectionEvent`, where Node lacks them.
//
// Only on the main thread: a worker started by the `Worker` shim gets its own
// global scope from `web-globals.mjs`, whose `message` events this would
// otherwise replace.

import { isMainThread } from "node:worker_threads";

if (isMainThread) installGlobalEvents();

function installGlobalEvents() {
  const target = new EventTarget();
  globalThis.addEventListener = target.addEventListener.bind(target);
  globalThis.removeEventListener = target.removeEventListener.bind(target);
  globalThis.dispatchEvent = target.dispatchEvent.bind(target);

  if (typeof globalThis.ErrorEvent !== "function") {
    globalThis.ErrorEvent = class ErrorEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.message = init.message ?? "";
        this.filename = init.filename ?? "";
        this.lineno = init.lineno ?? 0;
        this.colno = init.colno ?? 0;
        this.error = init.error;
      }
    };
  }

  if (typeof globalThis.PromiseRejectionEvent !== "function") {
    globalThis.PromiseRejectionEvent = class PromiseRejectionEvent
      extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.promise = init.promise;
        this.reason = init.reason;
      }
    };
  }

  /** An error `reportError()` already dispatched, on its way to Node. */
  let reportedError = undefined;
  let hasReportedError = false;

  /** Dispatches an `error` event for `error`; returns whether it was handled. */
  function dispatchError(error) {
    const event = new ErrorEvent("error", {
      cancelable: true,
      error,
      message: error instanceof Error ? error.message : String(error),
    });
    return !globalThis.dispatchEvent(event);
  }

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
      const event = new PromiseRejectionEvent("unhandledrejection", {
        cancelable: true,
        promise,
        reason,
      });
      if (!globalThis.dispatchEvent(event)) return true;
    }
    return originalEmit.call(this, name, ...args);
  };

  process.on("exit", () => globalThis.dispatchEvent(new Event("unload")));

  globalThis.reportError = function reportError(error) {
    if (dispatchError(error)) return;
    process.nextTick(() => {
      reportedError = error;
      hasReportedError = true;
      throw error;
    });
  };
}
