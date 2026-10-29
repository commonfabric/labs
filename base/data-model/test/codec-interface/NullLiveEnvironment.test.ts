/**
 * The stand-in used when a decode has no runtime behind it: a shared singleton
 * that refuses every cell resolution, and the class it is an instance of.
 *
 * Refusing is the entire behavior, so what is left to get right is that it
 * refuses informatively and cannot be talked out of it -- the failure names
 * the ref it was asked for, and the singleton is frozen so `getCell()` cannot
 * be swapped. The class is exported so a caller can frame that failure for its
 * own situation, and only the clause after the colon is the caller's to
 * supply.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { NULL_LIVE_ENVIRONMENT, NullLiveEnvironment } from "@/codec-common";

describe("NullLiveEnvironment", () => {
  describe("NULL_LIVE_ENVIRONMENT", () => {
    it("is a singleton (re-import yields the same instance)", async () => {
      const reimported =
        // Loading the module a second time and getting the same instance back
        // is the assertion.
        // deno-lint-ignore cf-imports/no-inline-module-import
        (await import("@/codec-interface/NullLiveEnvironment.ts"))
          .NULL_LIVE_ENVIRONMENT;
      expect(reimported).toBe(NULL_LIVE_ENVIRONMENT);
    });

    it("throws on `getCell()`", () => {
      expect(() =>
        NULL_LIVE_ENVIRONMENT.getCell({
          id: "of:bafyabc",
          path: [],
          space: "did:key:z1",
        })
      ).toThrow();
    });

    it("includes the requested ref id in the throw for debuggability", () => {
      expect(() =>
        NULL_LIVE_ENVIRONMENT.getCell({
          id: "of:bafySPECIFIC",
          path: [],
          space: "did:key:z1",
        })
      ).toThrow(/of:bafySPECIFIC/);
    });

    it("is frozen (cannot have `getCell()` replaced)", () => {
      expect(Object.isFrozen(NULL_LIVE_ENVIRONMENT)).toBe(true);
    });
  });

  describe("`NullLiveEnvironment` (exported class)", () => {
    it("throws the expected default message (default ctor)", () => {
      const ctx = new NullLiveEnvironment();
      expect(() =>
        ctx.getCell({ id: "of:bafyDEFAULT", path: [], space: "did:key:z1" })
      ).toThrow(
        "Cannot decode cell reference `of:bafyDEFAULT`: no live environment provided.",
      );
    });

    it("parameterizes only the after-colon clause via the `getCellMessage` arg", () => {
      const ctx = new NullLiveEnvironment("custom");
      expect(() =>
        ctx.getCell({ id: "of:bafyCUSTOM", path: [], space: "did:key:z1" })
      ).toThrow("Cannot decode cell reference `of:bafyCUSTOM`: custom");
    });
  });
});
