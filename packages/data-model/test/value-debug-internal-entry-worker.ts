/**
 * Loads one module as the first of this package in a realm of its own, and
 * reports whether the debug renderers are installed afterwards. A worker is
 * what gives the load a realm in which nothing else has been evaluated.
 *
 * Not a `*.test.ts` file, so the runner does not pick it up as a suite.
 */

import { areDebugRenderersInstalled } from "@/value-debug-internal.ts";

/** What the worker reports back about one load. */
export type EntryLoadReport = {
  /** Whether the debug renderers were installed once the module had loaded. */
  installed?: boolean;

  /** The failure message, when the load threw. */
  error?: string;
};

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<string>) => void) | null;
  postMessage(report: EntryLoadReport): void;
};

scope.onmessage = async (ev) => {
  try {
    // The load is the thing under test, and which module it is arrives in the
    // message.
    await import(ev.data);
    scope.postMessage({ installed: areDebugRenderersInstalled() });
  } catch (e) {
    scope.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
