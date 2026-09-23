/**
 * Differential property coverage for equality and canonical hashing. A seeded
 * grammar builds related containers together, with representational changes
 * and single-site perturbations. Both equal and unequal hashes must occur:
 * unrelated random values would mostly test the trivial unequal case.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze, type FabricValue, hashStringOf, valueEqual } from "@";
import { codecOf, NULL_LIVE_ENVIRONMENT, UnknownValue } from "@/codec-common";
import { FabricError } from "@/fabric-instances";
import { FabricBytes } from "@/fabric-primitives";

/** A bounded, deterministic draw from a sample's private generator. */
type Draw = (limit: number) => number;

/** Two values built from the same grammar decisions. */
type Pair = [FabricValue, FabricValue];

/** Creates a reproducible generator; the reported sample seed replays a failure. */
function drawsFrom(seed: number): Draw {
  let state = seed;
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x1_0000_0000) * limit);
  };
}

/** Generates strings across UTF-8 boundaries and lone UTF-16 surrogates. */
function textFrom(draw: Draw): string {
  const units = [
    "",
    "a",
    "0",
    "\x00",
    "\u007f",
    "\u0080",
    "\u07ff",
    "\u0800",
    "\ud800",
    "\ud801",
    "\udc00",
    "\ue000",
    "\ufffd",
    "\uffff",
    "😀",
    "__proto__",
    "constructor",
  ];
  return Array.from({ length: 1 + draw(3) }, () => units[draw(units.length)]!)
    .join("");
}

/** Generates corresponding leaves, optionally changing their contents. */
function leavesFrom(draw: Draw, perturb: boolean): Pair {
  switch (draw(6)) {
    case 0: {
      const values = [undefined, null, false, true];
      const index = draw(values.length);
      return [
        values[index],
        values[(index + (perturb ? 1 : 0)) % values.length],
      ];
    }
    case 1: {
      const values = [
        -0,
        0,
        NaN,
        Infinity,
        -Infinity,
        draw(1_000),
        draw(100) / 7,
      ];
      const index = draw(values.length);
      return [
        values[index],
        values[(index + (perturb ? 1 : 0)) % values.length],
      ];
    }
    case 2: {
      const value = BigInt(draw(1_000)) - 500n;
      return [value, perturb ? value + 1n : value];
    }
    case 3: {
      const value = textFrom(draw);
      return [value, perturb ? `${value}\x00` : value.toWellFormed()];
    }
    case 4: {
      const value = textFrom(draw);
      return [
        Symbol.for(value),
        Symbol.for(perturb ? `${value}\x00` : value.toWellFormed()),
      ];
    }
    default: {
      const bytes = Uint8Array.from({ length: 1 + draw(4) }, () => draw(256));
      const other = bytes.slice();
      if (perturb) other[0] = other[0]! ^ 1;
      return [new FabricBytes(bytes), new FabricBytes(other)];
    }
  }
}

/** Builds acyclic related values, varying shape, sharing, keys, and codec state. */
function pairFrom(draw: Draw, depth: number, perturb: boolean): Pair {
  if (depth === 0) return leavesFrom(draw, perturb);
  switch (draw(6)) {
    case 0:
      return leavesFrom(draw, perturb);
    case 1: {
      const length = 1 + draw(4);
      const selected = draw(length);
      const left = new Array<FabricValue>(length);
      const right = new Array<FabricValue>(length);
      for (let index = 0; index < length; index++) {
        const change = perturb && index === selected;
        if (draw(3) === 0) {
          if (change) right[index] = undefined;
        } else {
          [left[index], right[index]] = pairFrom(draw, depth - 1, change);
        }
      }
      return [left, right];
    }
    case 2: {
      const length = 1 + draw(4);
      const selected = draw(length);
      const addKey = perturb && draw(2) === 0;
      const left: [string, FabricValue][] = [];
      const right: [string, FabricValue][] = [];
      for (let index = 0; index < length; index++) {
        const key = `${textFrom(draw)}${index}`;
        const pair = pairFrom(
          draw,
          depth - 1,
          perturb && !addKey && index === selected,
        );
        left.push([key, pair[0]]);
        right.push([draw(2) === 0 ? key : key.toWellFormed(), pair[1]]);
      }
      if (addKey) right.push(["extra", undefined]);
      return [Object.fromEntries(left), Object.fromEntries(right.reverse())];
    }
    case 3: {
      const changeTag = perturb && draw(2) === 0;
      const [left, right] = pairFrom(draw, depth - 1, perturb && !changeTag);
      const tag = `Generated${draw(4)}@1`;
      return [
        new UnknownValue(tag, left),
        new UnknownValue(changeTag ? `${tag}1` : tag, right),
      ];
    }
    case 4: {
      const [left, right] = pairFrom(draw, depth - 1, perturb);
      const message = textFrom(draw);
      const leftError = new FabricError({
        type: "Error",
        message,
        stack: undefined,
        cause: left,
      });
      const rightError = new FabricError({
        type: "Error",
        message: message.toWellFormed(),
        stack: undefined,
        cause: right,
      });
      const codec = codecOf(rightError);
      return [
        leftError,
        draw(2) === 0 ? rightError : new UnknownValue(
          codec.tagForValue(rightError),
          codec.encode(rightError, NULL_LIVE_ENVIRONMENT),
        ),
      ];
    }
    default: {
      const [left, right] = pairFrom(draw, depth - 1, perturb);
      return [{ left, right: left }, { left: right, right }];
    }
  }
}

describe("value equality and content hashing", () => {
  it("returns hash equality for generated near-identical containers in every cache state", () => {
    const samples = 8_192;
    let equal = 0;
    let unequal = 0;
    for (let sample = 0; sample < samples; sample++) {
      const seed = 0x6969_0000 + sample;
      const draw = drawsFrom(seed);
      const [first, second] = pairFrom(draw, 1 + draw(4), sample % 3 === 0);
      const left = { value: first };
      const right = { value: second };
      const actual = valueEqual(left, right);
      const expected = hashStringOf(left) === hashStringOf(right);
      if (expected) equal++;
      else unequal++;
      const context = `seed ${seed}`;
      expect(valueEqual(first, second), `${context}, unwrapped`).toBe(
        hashStringOf(first) === hashStringOf(second),
      );
      expect(actual, `${context}, mutable`).toBe(expected);
      expect(valueEqual(right, left), `${context}, reversed`).toBe(expected);

      hashStringOf(deepFreeze(left));
      expect(valueEqual(left, right), `${context}, one cached hash`).toBe(
        expected,
      );
      hashStringOf(deepFreeze(right));
      expect(valueEqual(left, right), `${context}, both cached hashes`).toBe(
        expected,
      );
    }
    // Keep the oracle exercise balanced; agreement on mostly unrelated,
    // unequal inputs is weak evidence about preservation of logical content.
    expect(equal).toBeGreaterThan(samples / 3);
    expect(unequal).toBeGreaterThan(samples / 8);
  });
});
