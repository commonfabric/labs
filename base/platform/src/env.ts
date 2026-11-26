/**
 * Predicates for the JavaScript environment the calling code finds itself in.
 * Each is a feature test, not a build-time constant, so a single bundle can
 * ask at runtime which of its supported hosts it landed in. Each tests the
 * globals of `scope`, which is `globalThis` unless a caller names another.
 */

/** Indicates whether the current environment is Deno. */
export function isDeno(scope: object = globalThis): boolean {
  // Also check for `Deno.build`, because in `deno-web-test` a shim of
  // `Deno.test` runs in the browser in order to run the same test suite.
  return "Deno" in scope && typeof scope.Deno === "object" &&
    scope.Deno !== null && "build" in scope.Deno;
}

/** Indicates whether the current environment is a browser. */
export function isBrowser(scope: object = globalThis): boolean {
  return !isDeno(scope) && ("fetch" in scope);
}

/**
 * Indicates whether the current environment is a worker thread, as opposed to
 * the main thread of its host.
 */
export function isWorkerThread(scope: object = globalThis): boolean {
  return isDeno(scope) ? ("close" in scope) : ("importScripts" in scope);
}

/**
 * Throws if the current environment is a browser's main thread, which is the
 * one thread that must stay free to render.
 */
export function ensureNotRenderThread(scope: object = globalThis) {
  if (isBrowser(scope) && !isWorkerThread(scope)) {
    throw new Error(
      "This component must not run in the browser's main thread.",
    );
  }
}
