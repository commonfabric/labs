/**
 * Tests the Word Search Maker end to end through its cells: the typed word
 * list becomes the hidden words, the direction switches govern which ways they
 * run, a shuffle rearranges the same words, an over-long word is reported
 * rather than dropped, and the PDF follows the puzzle.
 *
 * Run: deno task cf test packages/patterns/wordsearch/main.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import { textContent } from "../test/vnode-helpers.ts";
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
  const title = new Writable("Fruit");
  const wordText = new Writable("apple\nbanana, cherry\n\nkiwi");
  const rows = new Writable(10);
  const cols = new Writable(10);
  const diagonals = new Writable(false);
  const backwards = new Writable(false);
  const seed = new Writable(1);
  const maker = WordSearchMaker({
    title,
    wordText,
    rows,
    cols,
    diagonals,
    backwards,
    seed,
  });

  const firstGrid = new Writable("");
  const firstPdf = new Writable("");
  const remember = action(() => {
    // Strings, so these hold a copy rather than a link to the live value.
    firstGrid.set(maker.puzzle.grid.join(""));
    firstPdf.set(maker.pdf);
  });

  return {
    [TESTS]: [
      // The typed list, split on lines and commas, is what gets hidden.
      {
        assertion: assert(() =>
          hides(maker.puzzle, ["APPLE", "BANANA", "CHERRY", "KIWI"])
        ),
      },
      { assertion: assert(() => maker.puzzle.grid.length === 10) },
      {
        assertion: assert(() =>
          maker.puzzle.cols === 10 &&
          maker.puzzle.grid.join("").length === 100
        ),
      },
      { assertion: assert(() => onlyForwards(maker.puzzle)) },
      { assertion: assert(() => textContent(maker[UI]).includes("BANANA")) },
      { assertion: assert(() => maker.pdf.startsWith("%PDF-1.4\n")) },

      // A shuffle keeps the words and moves them.
      { action: remember },
      { action: action(() => seed.set(2)) },
      {
        assertion: assert(() =>
          hides(maker.puzzle, ["APPLE", "BANANA", "CHERRY", "KIWI"])
        ),
      },
      {
        assertion: assert(() => maker.puzzle.grid.join("") !== firstGrid.get()),
      },
      { assertion: assert(() => maker.pdf !== firstPdf.get()) },

      // With both switches on, across a few seeds, some word leaves the two
      // forward directions; with them off again, none does.
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

      // A word that cannot fit is named, not silently dropped.
      { action: action(() => wordText.set("cat\nunbelievably")) },
      { assertion: assert(() => hides(maker.puzzle, ["CAT"])) },
      {
        assertion: assert(() =>
          maker.puzzle.unplaced.length === 1 &&
          maker.puzzle.unplaced[0] === "UNBELIEVABLY"
        ),
      },
      {
        assertion: assert(() =>
          textContent(maker[UI]).includes("Didn't fit: UNBELIEVABLY")
        ),
      },

      // An out-of-range size is brought into range rather than refused.
      { action: action(() => rows.set(99)) },
      { assertion: assert(() => maker.puzzle.rows === 30) },
      { assertion: assert(() => hides(maker.puzzle, ["CAT", "UNBELIEVABLY"])) },
    ],
  };
});
