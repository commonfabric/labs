/**
 * What an arriving envelope is recognized by. It runs before anything has
 * established that the data is this format's, so it sniffs rather than
 * validates: nothing here throws.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { markerOf } from "@/codec-realm/marker.ts";

describe("markerOf()", () => {
  it("returns the marker of a well-formed envelope", () => {
    const marker = ["fvr1"];

    expect(markerOf([marker, { a: 1 }])).toBe(marker);
  });

  it("returns `undefined` for an envelope that is not two slots", () => {
    // An envelope is `[marker, tree]`; a tagged form is `[marker, tag, state]`.
    // The slot count is what tells them apart.
    const marker = ["fvr1"];

    expect(markerOf([marker])).toBeUndefined();
    expect(markerOf([marker, "Tagged@1", { a: 1 }])).toBeUndefined();
    expect(markerOf([])).toBeUndefined();
  });

  it("returns `undefined` for a marker of the wrong shape", () => {
    for (
      const bad of [
        "fvr1",
        42,
        null,
        undefined,
        {},
        [],
        ["fvr1", "extra"],
      ]
    ) {
      expect(markerOf([bad, { a: 1 }])).toBeUndefined();
    }
  });

  it("returns `undefined` for a version this build does not implement", () => {
    expect(markerOf([["fvr2"], { a: 1 }])).toBeUndefined();
    expect(markerOf([["FVR1"], { a: 1 }])).toBeUndefined();
  });

  it("returns `undefined` for anything that is not an array", () => {
    for (const bad of ["fvr1", 42, null, undefined, {}, true]) {
      expect(markerOf(bad)).toBeUndefined();
    }
  });
});
