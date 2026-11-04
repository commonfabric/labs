import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  aggregateSumLeaf,
  aggregateSumValue,
  combineAggregateSums,
} from "../src/builtins/aggregate-sum.ts";
import {
  combineInRandomGrouping,
  seededRandom,
  shuffled,
} from "./combine-order.ts";

/** Sums leaves in the supplied order without intermediate rounding. */
function sum(values: number[]): number {
  return aggregateSumValue(
    values.map(aggregateSumLeaf).reduce(
      combineAggregateSums,
      aggregateSumLeaf(0),
    ),
  );
}

describe("aggregate-sum", () => {
  it("retains small contributions regardless of combine order", () => {
    for (
      const values of [
        [1e16, 1, -1e16],
        [1e16, -1e16, 1],
        [1, 1e16, -1e16],
        [-1e16, 1, 1e16],
      ]
    ) {
      expect(sum(values)).toBe(1);
    }
    const left = combineAggregateSums(
      aggregateSumLeaf(1e16),
      aggregateSumLeaf(1),
    );
    const right = combineAggregateSums(
      aggregateSumLeaf(1),
      aggregateSumLeaf(-1e16),
    );
    expect(
      aggregateSumValue(combineAggregateSums(left, aggregateSumLeaf(-1e16))),
    )
      .toBe(1);
    expect(
      aggregateSumValue(combineAggregateSums(aggregateSumLeaf(1e16), right)),
    )
      .toBe(1);
  });

  it("rounds halfway results to the even significand", () => {
    expect(sum([1, 2 ** -53])).toBe(1);
    expect(sum([1, 2 ** -52, 2 ** -53])).toBe(1 + 2 ** -51);
    expect(sum([-1, -(2 ** -53)])).toBe(-1);
    expect(sum([1, 2 ** -53, Number.MIN_VALUE])).toBe(1 + 2 ** -52);
  });

  it("preserves subnormals and cancellation at both ends of the finite range", () => {
    expect(sum([Number.MIN_VALUE, Number.MIN_VALUE])).toBe(
      2 * Number.MIN_VALUE,
    );
    expect(sum([Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE]))
      .toBe(Number.MIN_VALUE);
    expect(sum([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Infinity);
    expect(sum([-Number.MAX_VALUE, -Number.MAX_VALUE])).toBe(-Infinity);
    expect(sum([Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]))
      .toBe(Number.MAX_VALUE);
  });

  it("propagates non-finite contributions and returns positive zero for cancellation", () => {
    expect(sum([Infinity, 1])).toBe(Infinity);
    expect(sum([-Infinity, 1])).toBe(-Infinity);
    expect(sum([Infinity, -Infinity])).toBeNaN();
    expect(sum([NaN, 1])).toBeNaN();
    expect(Object.is(sum([]), 0)).toBe(true);
    expect(Object.is(sum([-0]), 0)).toBe(true);
    expect(Object.is(sum([-1, 1]), 0)).toBe(true);
  });

  it("returns the same sum for each seeded order and grouping of its inputs", () => {
    // Each family draws values whose rounded partial sums would depend on
    // their arrangement, or values at an edge of the exact representation.

    const random = seededRandom(7259);
    const below = (n: number) => Math.floor(random() * n);
    const word = () => Math.floor(random() * 2 ** 32);
    const unit = () => (word() * 2 ** 21 + (word() >>> 11)) / 2 ** 53;
    const bits = new DataView(new ArrayBuffer(8));
    const fromWords = (high: number, low: number) => {
      bits.setUint32(0, high >>> 0);
      bits.setUint32(4, low >>> 0);
      return bits.getFloat64(0);
    };
    const draw = (count: number, value: () => number) =>
      Array.from({ length: count }, value);
    const families: Record<string, () => number[]> = {
      cents: () =>
        draw(below(64), () => Math.round((unit() - 0.3) * 1e5) / 100),
      unitInterval: () => draw(below(64), unit),
      wideMagnitudes: () =>
        draw(below(64), () => (unit() - 0.5) * 10 ** (below(41) - 20)),
      cancellations: () =>
        draw(below(24), () => (unit() + 0.5) * 10 ** (15 + below(4)))
          .flatMap((big) => [big, -big * (1 + below(2) * 2 ** -52), unit()]),
      arbitraryFinite: () =>
        draw(below(64), () => fromWords(word(), word()))
          .filter(Number.isFinite),
      subnormals: () =>
        draw(below(64), () => fromWords(word() & 0x800fffff, word())),
      nearMinimumNormal: () =>
        draw(
          below(64),
          () =>
            fromWords((word() & 0x800fffff) | ((1 + below(8)) << 20), word()),
        ),
      halfwayTies: () => {
        const scale = 2 ** (below(106) - 53);
        return [
          scale * (1 + below(2 ** 20) * 2 ** -52),
          ...draw(below(64), () => scale * 2 ** -53 * (below(9) - 4)),
        ];
      },
      nearMaximum: () => [
        1,
        Number.MIN_VALUE,
        ...draw(
          below(16),
          () => (below(2) ? -1 : 1) * Number.MAX_VALUE * (0.5 + unit() / 2),
        ),
      ],
      nonFinite: () =>
        draw(
          below(64),
          () => random() < 0.05 ? [NaN, Infinity, -Infinity][below(3)] : unit(),
        ),
    };
    const formatted = (value: number) =>
      Object.is(value, -0) ? "-0" : String(value);

    for (const [family, generate] of Object.entries(families)) {
      for (let sample = 0; sample < 100; sample++) {
        const values = generate();
        const expected = sum(values);
        const described = `${family}: ${values.map(formatted).join(", ")}`;
        for (let arrangement = 0; arrangement < 3; arrangement++) {
          const arranged = combineInRandomGrouping(
            shuffled(values, random).map(aggregateSumLeaf),
            combineAggregateSums,
            aggregateSumLeaf(0),
            random,
          );
          expect(aggregateSumValue(arranged), described).toBe(expected);
        }
      }
    }
  });
});
