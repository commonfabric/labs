/**
 * Tests that a program which imports this package has the debug renderers,
 * whichever entry of the export map it imports. The entries come from the
 * package's manifest, so one added later is covered without an edit here.
 */

import { expect } from "@std/expect";
import { parse as parseJsonc } from "@std/jsonc";
import { describe, it } from "@std/testing/bdd";

import { reportFromFreshRealm } from "./value-debug-internal-worker-client.ts";

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
      const url = new URL(`../${modulePath}`, import.meta.url).href;

      expect(await reportFromFreshRealm(url)).toMatchObject({
        installed: expected,
      });
    });
  }
});
