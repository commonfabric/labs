import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  hostGestureProvenance,
  isTrustedGestureOn,
} from "../../src/cfc/host-review.ts";
import { markRendererTrustedEvent } from "../../src/cfc/ui-contract.ts";

describe("host-review", () => {
  describe("hostGestureProvenance()", () => {
    it("returns `native` provenance naming the surface", () => {
      expect(hostGestureProvenance("ShareSnapshot")).toStrictEqual({
        origin: "native",
        trusted: true,
        ui: { pattern: "ShareSnapshot" },
      });
    });

    it("returns provenance that `isTrustedGestureOn()` accepts on a marked event for its surface, and not for another", () => {
      const event = {
        type: "click",
        provenance: hostGestureProvenance("ShareSnapshot"),
      };
      const unmarked = { ...event };
      markRendererTrustedEvent(event);

      expect(isTrustedGestureOn(event, "ShareSnapshot")).toBe(true);
      expect(isTrustedGestureOn(event, "CustodySeal")).toBe(false);
      expect(isTrustedGestureOn(unmarked, "ShareSnapshot")).toBe(false);
    });

    it("returns a fresh object on each call", () => {
      const first = hostGestureProvenance("ShareSnapshot");
      const second = hostGestureProvenance("ShareSnapshot");
      expect(second).not.toBe(first);
      expect(second.ui).not.toBe(first.ui);
    });
  });
});
