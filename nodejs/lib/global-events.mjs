// The main thread's global scope as an `EventTarget`, as Deno's is:
// `addEventListener`, `removeEventListener`, and `dispatchEvent` on
// `globalThis`, with the `unhandledrejection`, `error`, and `unload` events
// Deno dispatches there, and `PromiseRejectionEvent`.
//
// The process hooks are installed only while a listener for their event is
// registered, because a Node `unhandledRejection` or `uncaughtException`
// listener replaces Node's default handling. Each hook restores that default
// for an event no listener cancels: it rethrows the reason or error.
//
// A worker thread's scope is set up by `web-globals.mjs` instead.

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

/** Process hooks, by global event type, installed while a listener exists. */
const HOOKS = {
  unhandledrejection: {
    name: "unhandledRejection",
    handler(reason, promise) {
      const event = new PromiseRejectionEvent("unhandledrejection", {
        cancelable: true,
        promise,
        reason,
      });
      globalThis.dispatchEvent(event);
      if (!event.defaultPrevented) throw reason;
    },
  },
  error: {
    name: "uncaughtException",
    handler(error) {
      const event = new ErrorEvent("error", {
        cancelable: true,
        error,
        message: error instanceof Error ? error.message : String(error),
      });
      globalThis.dispatchEvent(event);
      if (!event.defaultPrevented) {
        process.removeListener("uncaughtException", HOOKS.error.handler);
        throw error;
      }
    },
  },
  unload: {
    name: "exit",
    handler() {
      globalThis.dispatchEvent(new Event("unload"));
    },
  },
};

function install() {
  const target = new EventTarget();
  const listeners = new Map();

  globalThis.addEventListener = (type, listener, options) => {
    target.addEventListener(type, listener, options);
    const hook = HOOKS[type];
    if (!hook || !listener) return;
    let set = listeners.get(type);
    if (!set) listeners.set(type, set = new Set());
    if (set.size === 0) process.on(hook.name, hook.handler);
    set.add(listener);
  };
  globalThis.removeEventListener = (type, listener, options) => {
    target.removeEventListener(type, listener, options);
    const set = listeners.get(type);
    if (!set?.delete(listener)) return;
    if (set.size === 0) {
      process.removeListener(HOOKS[type].name, HOOKS[type].handler);
    }
  };
  globalThis.dispatchEvent = (event) => target.dispatchEvent(event);
}

globalThis.PromiseRejectionEvent ??= PromiseRejectionEvent;
if (isMainThread && typeof globalThis.addEventListener !== "function") {
  install();
}
