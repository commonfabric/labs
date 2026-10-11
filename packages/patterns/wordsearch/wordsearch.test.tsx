/**
 * Tests the WordSearch puzzle's own controls: Shuffle rearranges the same
 * words, the Answers switch marks exactly the hidden words' cells, the PDF
 * follows the puzzle and its title, and a word left out is named with why.
 *
 * Run: deno task cf test packages/patterns/wordsearch/wordsearch.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  childNodes,
  clickButton,
  findElement,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { placementCells, type WordSearch as Puzzle } from "./generator.ts";
import WordSearch from "./wordsearch.tsx";

const WORDS = ["apple", "banana", "cherry", "kiwi"];

const hides = (puzzle: Puzzle, words: string[]) =>
  JSON.stringify(puzzle.placements.map((p) => p.label).sort()) ===
    JSON.stringify([...words].sort());

/** The style of every styled span under `node`: the grid's cells, in order. */
const cellStyles = (node: unknown): string[] => [
  ...(readValue(propValue(node, "style")) !== undefined &&
      isSpan(node)
    ? [String(propValue(node, "style"))]
    : []),
  ...childNodes(node).flatMap(cellStyles),
];

const isSpan = (node: unknown): boolean =>
  findElement(node, "span") === readValue(node);

/** The indices of the grid cells drawn highlighted, in order. */
const highlighted = (ui: unknown): number[] =>
  cellStyles(ui).flatMap((style, i) =>
    style.includes("color-primary)") ? [i] : []
  );

/** Every cell a hidden word covers, in order. */
const answerCells = (puzzle: Puzzle): number[] =>
  [
    ...new Set(
      puzzle.placements.flatMap((p) => placementCells(p, puzzle.cols)),
    ),
  ].sort((a, b) => a - b);

export default pattern(() => {
  const title = new Writable("Fruit");
  const seed = new Writable(1);
  const words = new Writable(WORDS);
  const showAnswers = new Writable(false);
  const puzzle = WordSearch({
    title,
    words,
    rows: 9,
    cols: 9,
    seed,
    showAnswers,
  });

  const before = new Writable({ seed: 0, grid: "", pdf: "" });
  // Strings and numbers, so this holds a copy rather than a link to the live
  // values.
  const remember = action(() =>
    before.set({
      seed: seed.get(),
      grid: puzzle.puzzle.grid.join(""),
      pdf: puzzle.pdf,
    })
  );

  return {
    [TESTS]: [
      { assertion: assert(() => hides(puzzle.puzzle, WORDS)) },
      { assertion: assert(() => highlighted(puzzle[UI]).length === 0) },

      // Shuffle, pressed as a person would, picks a new seed and with it a
      // new arrangement of the same words.
      { action: remember },
      { action: action(() => clickButton(puzzle[UI], "Shuffle")) },
      { assertion: assert(() => seed.get() !== before.get().seed) },
      {
        assertion: assert(() =>
          puzzle.puzzle.grid.join("") !== before.get().grid
        ),
      },
      { assertion: assert(() => hides(puzzle.puzzle, WORDS)) },
      { assertion: assert(() => puzzle.pdf !== before.get().pdf) },

      // The Answers switch marks the hidden words' cells and nothing else.
      { action: action(() => showAnswers.set(true)) },
      {
        assertion: assert(() =>
          JSON.stringify(highlighted(puzzle[UI])) ===
            JSON.stringify(answerCells(puzzle.puzzle))
        ),
      },

      // The PDF carries the title.
      { action: action(() => title.set("Orchard")) },
      { assertion: assert(() => puzzle.pdf.includes("(Orchard) Tj")) },

      // A word left out is named, with the reason.
      { action: action(() => words.set(["cat", "x", "unbelievably"])) },
      {
        assertion: assert(() =>
          textContent(puzzle[UI]).includes(
            "Left out: x (needs 2+ letters), unbelievably (no room).",
          )
        ),
      },
    ],
  };
});
