/**
 * Predicates for the JavaScript environment the calling code finds itself in.
 * Each is a feature test, not a build-time constant, so a single bundle can
 * ask at runtime which of its supported hosts it landed in.
 */

/** Indicates whether the current environment is Deno. */
export function isDeno(): boolean {
  // Also check for `Deno.build`, because in `deno-web-test` a shim of
  // `Deno.test` runs in the browser in order to run the same test suite.
  return ("Deno" in globalThis) && "build" in globalThis.Deno;
}

/** Indicates whether the current environment is a browser. */
export function isBrowser(): boolean {
  return !isDeno() && ("fetch" in globalThis);
}

/**
 * Indicates whether the current environment is a worker thread, as opposed to
 * the main thread of its host.
 */
export function isWorkerThread(): boolean {
  return isDeno() ? ("close" in globalThis) : ("importScripts" in globalThis);
}

/**
 * Throws if the current environment is a browser's main thread, which is the
 * one thread that must stay free to render.
 */
export function ensureNotRenderThread() {
  if (isBrowser() && !isWorkerThread()) {
    throw new Error(
      "This component must not run in the browser's main thread.",
    );
  }
}
