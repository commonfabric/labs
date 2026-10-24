import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  parseUnlistedPlacement,
  unlistedToolshed,
} from "../v2/routed-directory.ts";

const LAST_CHARACTER = Object.freeze({
  "1": 0,
  "2": 0,
  "3": 0,
  "4": 0,
  "5": 0,
  "6": 0,
  "7": 0,
  "8": 0,
  "9": 0,
  A: 0,
  B: 0,
  C: 0,
  D: 0,
  E: 0,
  F: 0,
  G: 0,
  H: 0,
  J: 0,
  K: 0,
  L: 0,
  M: 0,
  N: 0,
  P: 0,
  Q: 0,
  R: 0,
  S: 0,
  T: 0,
  U: 0,
  V: 0,
  W: 0,
  X: 0,
  Y: 0,
  Z: 0,
  a: 1,
  b: 1,
  c: 1,
  d: 1,
  e: 1,
  f: 1,
  g: 1,
  h: 1,
  i: 1,
  j: 1,
  k: 1,
  m: 1,
  n: 1,
  o: 1,
  p: 1,
  q: 1,
  r: 1,
  s: 1,
  t: 1,
  u: 1,
  v: 1,
  w: 1,
  x: 1,
  y: 1,
  z: 1,
});

describe("routed-directory", () => {
  it("places unlisted DIDs at the configured owners and retains their epoch", () => {
    const rule = parseUnlistedPlacement({
      epoch: 7,
      last_character: LAST_CHARACTER,
    }, 2);
    expect(rule?.epoch).toBe(7);
    if (rule === undefined) throw new Error("Expected an unlisted placement");
    expect(unlistedToolshed(
      rule,
      "did:key:z6MkixsGj3MVGKMug2VMC2JbtzX3UjaAcfRs7G1RjbSnZJaH",
    )).toBe(0);
    expect(unlistedToolshed(
      rule,
      "did:key:z6MktojHN9D8obak7C9wjpTzCRrdE5zC6cxt5ANUFnQskgbs",
    )).toBe(1);
  });

  it("returns no unlisted placement for an omitted or null rule", () => {
    expect(parseUnlistedPlacement(undefined, 2)).toBeUndefined();
    expect(parseUnlistedPlacement(null, 2)).toBeUndefined();
  });

  it("throws for an incomplete or extraneous suffix assignment", () => {
    const { z: _z, ...missing } = LAST_CHARACTER;
    for (
      const lastCharacter of [
        missing,
        { ...LAST_CHARACTER, "0": 0 },
        { ...missing, "0": 0 },
      ]
    ) {
      expect(() =>
        parseUnlistedPlacement({ epoch: 7, last_character: lastCharacter }, 2)
      ).toThrow();
    }
  });

  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null]) {
    it(`throws for the invalid placement epoch \`${epoch}\``, () => {
      expect(() =>
        parseUnlistedPlacement({ epoch, last_character: LAST_CHARACTER }, 2)
      ).toThrow();
    });
  }

  for (const index of [-1, 2, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    it(`throws for the invalid toolshed index \`${index}\``, () => {
      expect(() =>
        parseUnlistedPlacement({
          epoch: 7,
          last_character: { ...LAST_CHARACTER, z: index },
        }, 2)
      ).toThrow();
    });
  }

  it("throws when an assignment names a toolshed in an empty directory", () => {
    expect(() =>
      parseUnlistedPlacement({ epoch: 7, last_character: LAST_CHARACTER }, 0)
    ).toThrow();
  });
});
