import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { createModuleCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";

describe("compartment-globals", () => {
  // Each test file runs in an isolate of its own, and nothing this file loads
  // locks SES down, so `Date.prototype.constructor` is still the real `Date`.

  it("throws when asked for the gated Date before SES lockdown", () => {
    expect(Date.prototype.constructor).toBe(Date);
    expect(() => createModuleCompartmentGlobals()).toThrow(
      "createGatedDate() requires SES lockdown to have run first",
    );
  });
});
