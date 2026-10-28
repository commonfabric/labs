/// <cts-enable />
/**
 * One WordSearchPlay shared by two players, each in a runtime of their own,
 * with no `found` passed in, as the Word Search Maker embeds it: each
 * player's finds are their own. Bob, after Alice finds a word, has found
 * nothing; Alice, after Bob finds another, has still found only hers.
 *
 * Run: deno task cf test packages/patterns/wordsearch/multi-user.test.tsx
 */
import {
  action,
  assert,
  computed,
  multiUserTest,
  pattern,
  TESTS,
} from "commonfabric";
import { generateWordSearch, placementCells } from "./generator.ts";
import WordSearchPlay, { type WordSearchPlayOutput } from "./play.tsx";

interface Setup {
  play: WordSearchPlayOutput;
}

export const setup = pattern(() => {
  const puzzle = computed(() =>
    generateWordSearch({
      words: ["apple", "kiwi", "plum"],
      rows: 8,
      cols: 8,
      diagonals: true,
      backwards: true,
      seed: 1,
    })
  );
  return { play: WordSearchPlay({ puzzle }) };
});

/** The cells of the setup puzzle's placement at `n`. */
const cellsOf = (n: number) => {
  const ws = generateWordSearch({
    words: ["apple", "kiwi", "plum"],
    rows: 8,
    cols: 8,
    diagonals: true,
    backwards: true,
    seed: 1,
  });
  return placementCells(ws.placements[n], ws.cols);
};

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const play = setup.play;
  return {
    [TESTS]: [
      {
        action: action(() => {
          const c0 = cellsOf(0);
          play.tap.send({ index: c0[0] });
          play.tap.send({ index: c0[c0.length - 1] });
        }),
      },
      { assertion: assert(() => play.foundCount === 1) },
      { label: "alice-found" },
      { await: "bob-done" },
      { assertion: assert(() => play.foundCount === 1) },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const play = setup.play;
  return {
    [TESTS]: [
      { await: "alice-found" },
      { assertion: assert(() => (play.foundCount ?? 0) === 0) },
      {
        action: action(() => {
          play.tap.send({ index: cellsOf(1)[0] });
        }),
      },
      {
        action: action(() => {
          const c1 = cellsOf(1);
          play.tap.send({ index: c1[c1.length - 1] });
        }),
      },
      { assertion: assert(() => play.foundCount === 1) },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
