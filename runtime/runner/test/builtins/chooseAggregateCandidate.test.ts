import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type AggregateCandidate,
  chooseAggregateCandidate,
} from "../../src/builtins/aggregate-extremum.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import {
  combineInRandomGrouping,
  seededRandom,
  shuffled,
} from "../combine-order.ts";

describe("chooseAggregateCandidate()", () => {
  // Scores come from a small set, so NaNs, signed zeros, and equal scores
  // coincide often. Keys mix characters whose UTF-8 and UTF-16 orders differ,
  // and a serial suffix keeps them distinct, as the contract requires.

  const scores = [NaN, 0, -0, 1, -1, 2, Infinity, -Infinity, Number.MIN_VALUE];
  const glyphs = ["a", "z", "é", "", "�", "\u{1f600}"];
  const modes = {
    min: { minimum: true, distinguishZero: true },
    max: { minimum: false, distinguishZero: true },
    minBy: { minimum: true, distinguishZero: false },
    maxBy: { minimum: false, distinguishZero: false },
  };

  for (const [mode, { minimum, distinguishZero }] of Object.entries(modes)) {
    it(`returns one ${mode} winner for each seeded order and grouping`, () => {
      const random = seededRandom(7259);
      const below = (n: number) => Math.floor(random() * n);
      let serial = 0;
      const candidate = (): AggregateCandidate => ({
        score: scores[below(scores.length)],
        key: glyphs[below(glyphs.length)] + glyphs[below(glyphs.length)] +
          serial++,
        element: {} as NormalizedFullLink,
      });
      const choose = (
        left: AggregateCandidate | undefined,
        right: AggregateCandidate | undefined,
      ) => chooseAggregateCandidate(left, right, minimum, distinguishZero);

      for (let i = 0; i < 2000; i++) {
        const [a, b, c] = [candidate(), candidate(), candidate()];
        expect(choose(a, b)).toBe(choose(b, a));
        expect(choose(choose(a, b), c)).toBe(choose(a, choose(b, c)));
      }
      for (let i = 0; i < 300; i++) {
        const candidates = Array.from({ length: 1 + below(64) }, candidate);
        const expected = candidates.reduce<AggregateCandidate | undefined>(
          choose,
          undefined,
        );
        for (let arrangement = 0; arrangement < 3; arrangement++) {
          expect(
            combineInRandomGrouping<AggregateCandidate | undefined>(
              shuffled(candidates, random),
              choose,
              undefined,
              random,
            ),
          ).toBe(expected);
        }
      }
    });
  }
});
