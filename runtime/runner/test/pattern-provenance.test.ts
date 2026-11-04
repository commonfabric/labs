import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isPattern } from "../src/builder/types.ts";
import {
  brandTrustedPattern,
  isTrustedPattern,
} from "../src/builder/pattern-metadata.ts";
import { freezeVerifiedPlainData } from "../src/sandbox/plain-data.ts";

describe("pattern provenance brand", () => {
  // `isPattern` is a purely structural check, so an attacker can forge the
  // shape via `__cf_data({...})` (a frozen plain object). Trust-granting sites
  // use `isTrustedPattern`, which additionally requires the value to carry the
  // provenance brand stamped only by the trusted `pattern()` builder — so a
  // forged pattern-shaped export cannot launder program / verified-load-id
  // metadata.

  const patternShape = {
    argumentSchema: {},
    resultSchema: {},
    result: {},
    nodes: [] as unknown[],
  };

  it("a __cf_data-forged pattern shape is isPattern but NOT isTrustedPattern", () => {
    const forged = freezeVerifiedPlainData({ ...patternShape });
    expect(isPattern(forged)).toBe(true); // structural check passes…
    expect(isTrustedPattern(forged)).toBe(false); // …but it carries no brand
  });

  it("a branded pattern shape is a trusted pattern", () => {
    const branded = brandTrustedPattern({ ...patternShape });
    expect(isPattern(branded)).toBe(true);
    expect(isTrustedPattern(branded)).toBe(true);
  });

  it("branding a non-pattern-shaped object does not make it trusted", () => {
    const notAPattern = brandTrustedPattern({ foo: 1 });
    expect(isTrustedPattern(notAPattern)).toBe(false); // fails the shape check
  });

  it("plain / primitive values are never trusted patterns", () => {
    expect(isTrustedPattern({})).toBe(false);
    expect(isTrustedPattern(null)).toBe(false);
    expect(isTrustedPattern(42)).toBe(false);
    expect(isTrustedPattern(() => {})).toBe(false);
  });
});
