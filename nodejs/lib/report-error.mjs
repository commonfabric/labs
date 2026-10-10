// `reportError()`, which Deno has as a global and Node lacks: dispatches an
// `error` event on the global scope and, when no listener cancels it, ends
// the process as an uncaught exception does under Deno.

import process from "node:process";

function reportError(error) {
  const event = new ErrorEvent("error", {
    cancelable: true,
    error,
    message: error instanceof Error ? error.message : String(error),
  });
  globalThis.dispatchEvent?.(event);
  if (event.defaultPrevented) return;
  console.error("error: Uncaught (reported)", error);
  process.exit(1);
}

globalThis.reportError ??= reportError;
