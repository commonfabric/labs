/**
 * Tests of `value-debug-internal.ts`, the late-bound route to the debug
 * renderers. What the module does depends on whether `value-debug` has loaded
 * in the realm, so each case asks a worker, which is a realm of its own, and
 * no case depends on another having run.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { BaseFabricSpecialObject } from "@/fabric-bases/BaseFabricSpecialObject.ts";
import * as valueDebug from "@/value-debug/index.ts";

import { rendererCalls } from "./value-debug-internal-calls.ts";
import { reportFromFreshRealm } from "./value-debug-internal-worker-client.ts";

/** The URL of `value-debug`'s own module, for a worker to load. */
const VALUE_DEBUG_URL =
  new URL("../src/value-debug/index.ts", import.meta.url).href;

/** What each renderer returns, in this realm, for the calls the worker makes. */
const RENDERER_RESULTS: Readonly<Record<string, unknown>> = Object.fromEntries(
  Object.entries(rendererCalls(valueDebug)).map((
    [name, call],
  ) => [name, call()]),
);

/**
 * A class of the name and shape the worker inspects an instance of, so that
 * this realm's renderer says what that instance's rendering is.
 */
class Probe extends BaseFabricSpecialObject {}

describe("value-debug-internal", () => {
  describe("in a realm where `value-debug` has not loaded", () => {
    it("reports that the renderers are not installed", async () => {
      const report = await reportFromFreshRealm(null);

      expect(report).toMatchObject({ installed: false });
    });

    for (const name of Object.keys(RENDERER_RESULTS)) {
      it(`throws from \`${name}\`, naming how a test gets the renderers`, async () => {
        const report = await reportFromFreshRealm(null);
        const outcome = "forwarders" in report
          ? report.forwarders[name]
          : undefined;

        expect(outcome).toEqual({
          threw: expect.stringContaining("`@/for-testing-only.ts`"),
        });
      });
    }

    it("inspects a `BaseFabricSpecialObject` as its class name", async () => {
      const report = await reportFromFreshRealm(null);

      expect(report).toMatchObject({ inspected: "[Probe]" });
    });
  });

  describe("in a realm where `value-debug` has loaded", () => {
    it("reports that the renderers are installed", async () => {
      const report = await reportFromFreshRealm(VALUE_DEBUG_URL);

      expect(report).toMatchObject({ installed: true });
    });

    for (const [name, expected] of Object.entries(RENDERER_RESULTS)) {
      it(`returns from \`${name}\` what the renderer of that name returns`, async () => {
        const report = await reportFromFreshRealm(VALUE_DEBUG_URL);
        const outcome = "forwarders" in report
          ? report.forwarders[name]
          : undefined;

        expect(outcome).toEqual({ returned: expected });
      });
    }

    it("inspects a `BaseFabricSpecialObject` as its compact debug string", async () => {
      const report = await reportFromFreshRealm(VALUE_DEBUG_URL);

      expect(report).toMatchObject({
        inspected: valueDebug.toCompactDebugString(new Probe()),
      });
      expect(report).not.toMatchObject({ inspected: "[Probe]" });
    });
  });
});
