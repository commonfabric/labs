/**
 * Tests of `value-debug-internal.ts`, the late-bound route to the debug
 * renderers. The cases run in order, and the order is the subject: what the
 * module does before `value-debug` has loaded, and then what it does after.
 * This file therefore imports nothing which loads `value-debug`, and loads it
 * itself partway through.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { BaseFabricSpecialObject } from "@/fabric-bases/BaseFabricSpecialObject.ts";
import * as internal from "@/value-debug-internal.ts";

/** A concrete subclass of the root class, to have something to inspect. */
class Probe extends BaseFabricSpecialObject {}

/** Every renderer the module forwards, each called the way a caller might. */
const FORWARDER_CALLS: Readonly<Record<string, () => unknown>> = {
  debugStr: () => internal.debugStr`a value: $quote${[1, 2]}`,
  toCompactDebugString: () => internal.toCompactDebugString({ a: 1 }),
  toDebugKindString: () => internal.toDebugKindString([1]),
  toIndentedDebugString: () => internal.toIndentedDebugString({ a: [1] }),
  toLongQuotedDebugString: () => internal.toLongQuotedDebugString("x"),
  toShortQuotedDebugString: () => internal.toShortQuotedDebugString("x"),
  toStructuredDebugValue: () => internal.toStructuredDebugValue(new Map()),
};

describe("value-debug-internal", () => {
  describe("before `value-debug` has loaded", () => {
    it("reports that the renderers are not installed", () => {
      expect(internal.areDebugRenderersInstalled()).toBe(false);
    });

    for (const [name, call] of Object.entries(FORWARDER_CALLS)) {
      it(`throws from \`${name}\`, naming how a test gets the renderers`, () => {
        expect(call).toThrow("`@/for-testing-only.ts`");
      });
    }

    it("inspects a `BaseFabricSpecialObject` as its class name", () => {
      expect(Deno.inspect(new Probe())).toBe("[Probe]");
    });
  });

  describe("once `value-debug` has loaded", () => {
    it("reports that the renderers are installed", async () => {
      // The load is the thing under test: it is what installs the renderers.
      // deno-lint-ignore cf-imports/no-inline-module-import
      await import("@/value-debug/index.ts");

      expect(internal.areDebugRenderersInstalled()).toBe(true);
    });

    for (const [name, call] of Object.entries(FORWARDER_CALLS)) {
      it(`returns from \`${name}\` what the renderer of that name returns`, async () => {
        // Loaded by the case above; this only names the module.
        // deno-lint-ignore cf-imports/no-inline-module-import
        const real = await import("@/value-debug/index.ts");
        const viaReal: Readonly<Record<string, () => unknown>> = {
          debugStr: () => real.debugStr`a value: $quote${[1, 2]}`,
          toCompactDebugString: () => real.toCompactDebugString({ a: 1 }),
          toDebugKindString: () => real.toDebugKindString([1]),
          toIndentedDebugString: () => real.toIndentedDebugString({ a: [1] }),
          toLongQuotedDebugString: () => real.toLongQuotedDebugString("x"),
          toShortQuotedDebugString: () => real.toShortQuotedDebugString("x"),
          toStructuredDebugValue: () => real.toStructuredDebugValue(new Map()),
        };

        expect(call()).toEqual(viaReal[name]!());
      });
    }

    it("inspects a `BaseFabricSpecialObject` as its compact debug string", () => {
      const probe = new Probe();

      expect(Deno.inspect(probe)).toBe(internal.toCompactDebugString(probe));
      expect(Deno.inspect(probe)).not.toBe("[Probe]");
    });
  });
});
