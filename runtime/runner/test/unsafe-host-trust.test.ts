import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  createUnsafeHostTrustToken,
  registerUnsafeHostTrustedValue,
  type UnsafeHostTrust,
} from "../src/unsafe-host-trust.ts";

describe("unsafe-host-trust", () => {
  describe("registerUnsafeHostTrustedValue()", () => {
    it("hands the value to the registrar of a token this module made", () => {
      const registered: unknown[] = [];
      const token = createUnsafeHostTrustToken(
        { reason: "a test" },
        (value) => registered.push(value),
      );
      const value = { trusted: true };

      registerUnsafeHostTrustedValue(token, value);

      expect(registered).toEqual([value]);
      expect(registered[0]).toBe(value);
    });

    it("throws for a token this module did not make", () => {
      const forged: UnsafeHostTrust = {
        kind: "unsafe-host-trust",
        reason: "forged",
      };

      expect(() => registerUnsafeHostTrustedValue(forged, { trusted: true }))
        .toThrow("Invalid unsafeHostTrust token");
    });
  });
});
