/**
 * A minimal async-context store: read the current value with `getStore()`, and
 * bind a value for the (sync or async) duration of `run`. A thin shared shape
 * over Deno/Node `AsyncLocalStorage` and the promise-aware fallback below.
 *
 * This module is intentionally free of top-level `await`: resolving the Deno
 * `AsyncLocalStorage` constructor needs `await import("node:async_hooks")`,
 * which stays at the (runner) call sites. A top-level await in this
 * widely-imported utils module stalls module evaluation in some Deno test
 * graphs ("Module evaluation is still pending after multiple event loop
 * iterations"). Call sites pick the backing class like:
 *
 *     const Storage = (isDeno()
 *       ? (await import("node:async_hooks")).AsyncLocalStorage
 *       : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;
 */
export interface AsyncLocalStore<T> {
  /** Returns the currently bound value, or `undefined` if there is none. */
  getStore(): T | undefined;

  /** Calls `fn` with `value` bound, and returns what it returns. */
  run<R>(value: T, fn: () => R): R;
}

/**
 * Promise-aware synchronous fallback for runtimes without `AsyncLocalStorage`
 * (e.g. the browser). The previous value is restored in a `.finally` for
 * promise results and synchronously otherwise — so the bound value
 * conservatively spans the whole pending promise.
 */
export class FallbackAsyncLocalStore<T> implements AsyncLocalStore<T> {
  #store: T | undefined;

  getStore(): T | undefined {
    return this.#store;
  }

  run<R>(value: T, fn: () => R): R {
    const previous = this.#store;
    this.#store = value;
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.finally(() => {
          this.#store = previous;
        }) as R;
      }
      this.#store = previous;
      return result;
    } catch (error) {
      this.#store = previous;
      throw error;
    }
  }
}
