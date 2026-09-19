/**
 * Tests that a program which imports this package has the debug renderers,
 * whichever entry of the export map it imports. The entries come from the
 * package's manifest, so one added later is covered without an edit here.
 */

import { expect } from "@std/expect";
import { parse as parseJsonc } from "@std/jsonc";
import { describe, it } from "@std/testing/bdd";
import { defer } from "@commonfabric/utils/defer";

import type { EntryLoadReport } from "./value-debug-internal-entry-worker.ts";

/**
 * The entries which are a single module that renders nothing, and so have no
 * reason to load `value-debug`.
 */
const RENDERS_NOTHING: ReadonlySet<string> = new Set([
  "./api",
  "./frozen-builtins",
]);

/** The package's export map: entry name to module path. */
const EXPORTS = (parseJsonc(
  Deno.readTextFileSync(new URL("../deno.jsonc", import.meta.url)),
) as { exports: Record<string, string> }).exports;

/** Loads `modulePath` first in a worker, and returns the worker's report. */
async function loadAlone(modulePath: string): Promise<EntryLoadReport> {
  const worker = new Worker(
    new URL("./value-debug-internal-entry-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const report = defer<EntryLoadReport>();

  worker.onmessage = (ev) => report.resolve(ev.data as EntryLoadReport);
  worker.onerror = (ev) => report.reject(new Error(ev.message));

  try {
    worker.postMessage(new URL(`../${modulePath}`, import.meta.url).href);
    return await report.promise;
  } finally {
    worker.terminate();
  }
}

describe("value-debug-internal-entries", () => {
  it("finds the export map", () => {
    expect(Object.keys(EXPORTS)).toContain(".");
    for (const entry of RENDERS_NOTHING) {
      expect(Object.keys(EXPORTS)).toContain(entry);
    }
  });

  for (const [entry, modulePath] of Object.entries(EXPORTS)) {
    const expected = !RENDERS_NOTHING.has(entry);

    it(`reports the renderers ${expected ? "installed" : "not installed"} once \`${entry}\` alone has loaded`, async () => {
      expect(await loadAlone(modulePath)).toEqual({ installed: expected });
    });
  }
});
