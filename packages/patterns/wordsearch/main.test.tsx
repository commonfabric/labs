/**
 * Tests the Word Search Maker's wiring: the typed word list becomes the hidden
 * words, the direction switches govern which ways they run, and the size
 * settings shape the grid, brought into range when they are out of it.
 * `wordsearch.test.tsx` covers the puzzle's own controls.
 *
 * Run: deno task cf test packages/patterns/wordsearch/main.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { findNodeByProp, textContent } from "../test/vnode-helpers.ts";
import { type WordSearch as Puzzle } from "./generator.ts";
import WordSearchMaker from "./main.tsx";

const hides = (puzzle: Puzzle, words: string[]) =>
  JSON.stringify(puzzle.placements.map((p) => p.word).sort()) ===
    JSON.stringify([...words].sort());

const onlyForwards = (puzzle: Puzzle) =>
  puzzle.placements.every((p) =>
    (p.dRow === 0 && p.dCol === 1) || (p.dRow === 1 && p.dCol === 0)
  );

export default pattern(() => {
  const wordText = new Writable("apple\nbanana, cherry\n\nkiwi");
  const rows = new Writable(10);
  const cols = new Writable(10);
  const diagonals = new Writable(false);
  const backwards = new Writable(false);
  const maker = WordSearchMaker({
    title: new Writable("Fruit"),
    wordText,
    rows,
    cols,
    diagonals,
    backwards,
    seed: new Writable(1),
  });

  return {
    [TESTS]: [
      // The typed list, split on lines and commas, is what gets hidden.
      {
        assertion: assert(() =>
          hides(maker.puzzle, ["APPLE", "BANANA", "CHERRY", "KIWI"])
        ),
      },
      {
        assertion: assert(() =>
          maker.puzzle.rows === 10 && maker.puzzle.cols === 10 &&
          maker.puzzle.grid.join("").length === 100
        ),
      },
      { assertion: assert(() => onlyForwards(maker.puzzle)) },
      { assertion: assert(() => textContent(maker[UI]).includes("banana")) },

      // With both switches on, some word leaves the two forward directions;
      // with them off again, none does.
      {
        action: action(() => {
          diagonals.set(true);
          backwards.set(true);
          wordText.set(
            "apple\nbanana\ncherry\nkiwi\nlemon\nmango\npeach\nplum\npear",
          );
        }),
      },
      { assertion: assert(() => !onlyForwards(maker.puzzle)) },
      {
        action: action(() => {
          diagonals.set(false);
          backwards.set(false);
        }),
      },
      { assertion: assert(() => onlyForwards(maker.puzzle)) },

      // An out-of-range size is brought into range, and the label says so.
      { action: action(() => rows.set(99)) },
      { assertion: assert(() => maker.puzzle.rows === 30) },
      {
        assertion: assert(() =>
          findNodeByProp(maker[UI], "label", "Rows: 30") !== undefined
        ),
      },
    ],
  };
});
