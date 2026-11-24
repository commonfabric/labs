import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ExecutableRegistry } from "../../src/harness/executable-registry.ts";

describe("ExecutableRegistry", () => {
  describe("instance members", () => {
    describe("trustHostValue()", () => {
      it("registers each function the value holds under a fresh host identity", () => {
        const registry = new ExecutableRegistry();
        const helper = () => {};

        registry.trustHostValue({ helper }, { reason: "a host helper" });

        expect(registry.getVerifiedImplementation("host:0", "fn0")).toBe(
          helper,
        );
      });

      it("throws for a reason that is empty or blank, and registers nothing", () => {
        const registry = new ExecutableRegistry();
        const helper = () => {};

        for (const reason of ["", "  \n"]) {
          expect(() => registry.trustHostValue({ helper }, { reason }))
            .toThrow("unsafe host trust requires a non-empty reason");
        }

        expect(registry.getVerifiedImplementation("host:0", "fn0"))
          .toBeUndefined();
      });
    });
  });
});
