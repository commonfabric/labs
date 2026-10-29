import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  brandTrustedBuilderArtifact,
  brandTrustedPattern,
  getArtifactEntryRef,
  getLeastArtifactEntryRef,
  isTrustedBuilderArtifact,
  isTrustedPattern,
  noteDerivedCopy,
  resolveOriginal,
  setArtifactEntryRef,
} from "../src/builder/pattern-metadata.ts";

/**
 * Derived-copy identity carry (PR B of
 * docs/history/specs/content-addressed-action-identity-implementation-plan.md).
 *
 * Copies of builder artifacts (build-time graph serialization, traversal,
 * binding) register `copy → original` in a module-level WeakMap via
 * `noteDerivedCopy` — replacing the `unsafe_originalPattern` symbol backref.
 * Trust propagates eagerly (brands always precede copies: builders brand at
 * creation time); entry refs resolve lazily through `resolveOriginal` because
 * refs are indexed only post-evaluation, AFTER build-time copies were made.
 */

const patternShape = () => ({
  argumentSchema: { type: "object" as const },
  resultSchema: { type: "object" as const },
  nodes: [],
  result: {},
});

describe("noteDerivedCopy trust carry", () => {
  it("a copy of a branded pattern is trusted; a forged object is not", () => {
    const original = brandTrustedPattern(patternShape());
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    expect(isTrustedPattern(copy)).toBe(true);

    // Forged values gain nothing: no own property can grant trust...
    const forged = {
      ...patternShape(),
      ["unsafe_originalPattern"]: original,
    };
    expect(isTrustedPattern(forged)).toBe(false);
    // ...and a forged value never reaches noteDerivedCopy with a trusted
    // original, so it stays untrusted.
    expect(isTrustedBuilderArtifact({ forged: true })).toBe(false);
  });

  it("copies of copies resolve to the root original", () => {
    const original = brandTrustedBuilderArtifact({ kind: "factory" });
    const copy1 = { kind: "copy1" };
    noteDerivedCopy(copy1, original);
    const copy2 = { kind: "copy2" };
    noteDerivedCopy(copy2, copy1);
    expect(resolveOriginal(copy2)).toBe(original);
    expect(isTrustedBuilderArtifact(copy2)).toBe(true);
  });

  it("an untrusted original confers nothing", () => {
    const original = patternShape();
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    expect(isTrustedPattern(copy)).toBe(false);
  });

  it("records nothing when either side cannot be a key", () => {
    // Derivation is tracked in identity-keyed tables, so a value with no
    // identity -- a primitive, `null` -- has nowhere to be recorded. The
    // guard exists so callers may pass whatever they replaced without
    // checking first.
    const original = brandTrustedPattern(patternShape());
    expect(() => noteDerivedCopy("not-an-object", original)).not.toThrow();
    expect(() => noteDerivedCopy(null, original)).not.toThrow();
    expect(() => noteDerivedCopy(patternShape(), 7)).not.toThrow();

    const copy = patternShape();
    noteDerivedCopy(copy, undefined);
    expect(resolveOriginal(copy)).toBe(copy);
    expect(isTrustedPattern(copy)).toBe(false);
  });

  it("records nothing for a value derived from itself", () => {
    // A walk returns an unchanged subtree by identity, so a caller can reach
    // here with one object for both sides. Recording that would make the
    // value its own ancestor.
    const value = brandTrustedPattern(patternShape());
    noteDerivedCopy(value, value);
    expect(resolveOriginal(value)).toBe(value);
  });
});

describe("entry-ref resolution through copies", () => {
  it("resolves a ref registered BEFORE the copy (eager)", () => {
    const original = brandTrustedPattern(patternShape());
    setArtifactEntryRef(original, { identity: "id-eager", symbol: "default" });
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    expect(getArtifactEntryRef(copy)).toEqual({
      identity: "id-eager",
      symbol: "default",
    });
  });

  it("resolves a ref registered AFTER the copy (lazy — the build-time order)", () => {
    // Build-time copies are made during module evaluation; refs are indexed
    // post-evaluation by registerEvaluatedModules. The lookup must therefore
    // walk to the original at resolution time.
    const original = brandTrustedPattern(patternShape());
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    setArtifactEntryRef(original, { identity: "id-lazy", symbol: "op" });
    expect(getArtifactEntryRef(copy)).toEqual({
      identity: "id-lazy",
      symbol: "op",
    });
  });

  it("first-write-wins for a value's ref", () => {
    const original = brandTrustedPattern(patternShape());
    setArtifactEntryRef(original, { identity: "first", symbol: "a" });
    setArtifactEntryRef(original, { identity: "second", symbol: "b" });
    expect(getArtifactEntryRef(original)).toEqual({
      identity: "first",
      symbol: "a",
    });
  });
});

describe("getLeastArtifactEntryRef()", () => {
  it("returns the least symbol a value is registered under, whatever the order", () => {
    const first = brandTrustedPattern(patternShape());
    const second = brandTrustedPattern(patternShape());
    for (const symbol of ["Tally", "Counter", "default"]) {
      setArtifactEntryRef(first, { identity: "aliased", symbol });
    }
    for (const symbol of ["default", "Tally", "Counter"]) {
      setArtifactEntryRef(second, { identity: "aliased", symbol });
    }

    expect(getArtifactEntryRef(first)?.symbol).toBe("Tally");
    expect(getArtifactEntryRef(second)?.symbol).toBe("default");
    expect(getLeastArtifactEntryRef(first)).toEqual({
      identity: "aliased",
      symbol: "Counter",
    });
    expect(getLeastArtifactEntryRef(second)).toEqual({
      identity: "aliased",
      symbol: "Counter",
    });
  });

  it("returns a symbol registered under the identity `getArtifactEntryRef()` returns", () => {
    const original = brandTrustedPattern(patternShape());
    setArtifactEntryRef(original, { identity: "first", symbol: "b" });
    setArtifactEntryRef(original, { identity: "second", symbol: "a" });

    expect(getLeastArtifactEntryRef(original)).toEqual({
      identity: "first",
      symbol: "b",
    });
  });

  it("returns the root original's least symbol for a copy holding a ref of its own", () => {
    // A ref registered before the copy is made is pinned on the copy, and
    // the names registered after it are the root original's.
    const original = brandTrustedPattern(patternShape());
    setArtifactEntryRef(original, { identity: "id-copy", symbol: "b" });
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    setArtifactEntryRef(original, { identity: "id-copy", symbol: "a" });

    expect(getArtifactEntryRef(copy)?.symbol).toBe("b");
    expect(getLeastArtifactEntryRef(copy)).toEqual({
      identity: "id-copy",
      symbol: "a",
    });
  });

  it("returns `undefined` for a value with no ref", () => {
    expect(getLeastArtifactEntryRef(patternShape())).toBeUndefined();
  });
});
