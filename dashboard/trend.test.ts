import { expect } from "@std/expect";

import { levelChanges } from "./trend.ts";
import { describe, it } from "@commonfabric/test-support/test";

// A source of normally distributed numbers that gives the same sequence for
// the same seed, so a series reads the same on every run.
function normal(seed: number): () => number {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 1) / 2 ** 32;
  };
  return () =>
    Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

// `count` samples around `level`, each off it by noise of the given relative
// size, two percent unless named.
const noisy = (
  level: number,
  count: number,
  seed: number,
  size = 0.02,
): number[] => {
  const next = normal(seed);
  return Array.from({ length: count }, () => level * Math.exp(size * next()));
};

describe("trend", () => {
  describe("levelChanges()", () => {
    it("returns nothing for a series that stays on one level", () => {
      expect(levelChanges(noisy(100, 40, 1))).toEqual([]);
      expect(levelChanges(Array(12).fill(5))).toEqual([]);
    });

    it("returns nothing for long runs of noise", () => {
      for (let seed = 1; seed <= 10; seed++) {
        expect(levelChanges(noisy(100, 270, seed, 0.03))).toEqual([]);
      }
    });

    it("returns nothing for a series that alternates between two close values at random", () => {
      const next = normal(7);
      const series = Array.from(
        { length: 270 },
        () => next() > 0 ? 100 : 101,
      );
      expect(levelChanges(series)).toEqual([]);
    });

    it("returns nothing for a series measured on two kinds of host in turn", () => {
      const next = normal(12);
      const series = Array.from(
        { length: 300 },
        (_, i) => (i % 2 ? 130 : 100) * Math.exp(0.02 * next()),
      );
      expect(levelChanges(series)).toEqual([]);
    });

    it("returns nothing for a series measured on two kinds of host at random", () => {
      const next = normal(24);
      const series = Array.from(
        { length: 270 },
        () => (next() > 0 ? 130 : 100) * Math.exp(0.03 * next()),
      );
      expect(levelChanges(series)).toEqual([]);
    });

    it("returns nothing for a series measured now and then on a slower host", () => {
      // The slower host takes about one sample in five, then one in ten.
      for (const [seed, cut] of [[25, 0.84], [28, 1.2816]]) {
        const next = normal(seed);
        const series = Array.from(
          { length: 270 },
          () => (next() > cut ? 130 : 100) * Math.exp(0.03 * next()),
        );
        expect(levelChanges(series)).toEqual([]);
      }
    });

    it("returns nothing for a series whose noise wanders, which the distance from neighbors alone splits", () => {
      const next = normal(27);
      let wander = 0;
      const series = Array.from({ length: 270 }, () => {
        wander = 0.5 * wander + 0.03 * next();
        return 100 * Math.exp(wander);
      });
      expect(levelChanges(series)).toEqual([]);
    });

    it("returns a step beside a single sample far out of line", () => {
      const series = [...noisy(100, 135, 26, 0.03), ...noisy(110, 135, 27, 0.03)];
      series[60] *= 4;
      expect(levelChanges(series).map(({ index }) => index)).toEqual([135]);
    });

    it("returns nothing for a short burst of slow samples", () => {
      const series = noisy(100, 60, 13);
      for (let i = 30; i < 34; i++) series[i] *= 2;
      expect(levelChanges(series)).toEqual([]);
    });

    it("returns nothing for a series that rises by the same share each sample", () => {
      expect(levelChanges(Array.from({ length: 40 }, (_, i) => 100 + i)))
        .toEqual([]);
      const next = normal(14);
      expect(levelChanges(Array.from(
        { length: 270 },
        (_, i) => 100 * 2 ** (i / 270) * Math.exp(0.02 * next()),
      ))).toEqual([]);
    });

    it("returns nothing for a series too short to hold two levels", () => {
      expect(levelChanges([1, 1, 2, 2, 2])).toEqual([]);
      expect(levelChanges([])).toEqual([]);
    });

    it("returns the sample at which a noisy level steps, and the step's size", () => {
      const changes = levelChanges([
        ...noisy(100, 180, 2, 0.03),
        ...noisy(115, 90, 3, 0.03),
      ]);
      expect(changes).toHaveLength(1);
      const [change] = changes;
      expect(change).toMatchObject({ start: 0, index: 180, end: 270 });
      expect(change.ratio).toBeCloseTo(1.15, 1);
    });

    it("returns one change at the step of a series that is otherwise exact", () => {
      // Every split from the third sample on leaves the two medians as far
      // apart as the step does, so the boundary is placed by how closely each
      // side keeps to its median. A shorter exact series has too few samples
      // away from the step to measure its noise by, and returns nothing.
      expect(levelChanges([...Array(10).fill(4), ...Array(10).fill(6)]))
        .toEqual([{ start: 0, index: 10, end: 20, ratio: 1.5 }]);
    });

    it("returns a small step that a large one elsewhere in the series hides from the first search", () => {
      const changes = levelChanges([
        ...noisy(100, 60, 73),
        ...noisy(200, 60, 74),
        ...noisy(210, 60, 75),
      ]);
      expect(changes.map(({ index }) => index)).toEqual([60, 120]);
    });

    it("returns nothing for a short burst that opens the series, and a step for a longer one", () => {
      const burst = (length: number) =>
        noisy(100, 60, 18).map((value, i) => i < length ? value * 2 : value);
      expect(levelChanges(burst(4))).toEqual([]);
      expect(levelChanges(burst(6)).map(({ index }) => index)).toEqual([6]);
    });

    it("returns a short level that ends the series", () => {
      const series = noisy(100, 60, 19);
      for (let i = 57; i < 60; i++) series[i] *= 1.5;
      expect(levelChanges(series).map(({ index }) => index)).toEqual([57]);
    });

    it("returns each of three steps three samples apart", () => {
      // The levels one search leaves are searched again for as long as more
      // boundaries last, which is what finds all three here.
      expect(levelChanges([
        ...noisy(100, 20, 1),
        ...noisy(130, 3, 2),
        ...noisy(170, 3, 3),
        ...noisy(220, 20, 4),
      ]).map(({ index }) => index)).toEqual([20, 23, 26]);
    });

    it("returns nothing for a single sample out of line", () => {
      const series = noisy(100, 30, 11);
      series[12] = 400;
      expect(levelChanges(series)).toEqual([]);
    });

    it("throws for a value that is not finite and above zero", () => {
      expect(() => levelChanges([1, 2, 0, 3])).toThrow(RangeError);
      expect(() => levelChanges([1, 2, Infinity, 3])).toThrow(RangeError);
    });
  });
});
