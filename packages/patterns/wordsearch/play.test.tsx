/**
 * Tests WordSearchPlay: a word is found by tapping its two ends, in either
 * order; taps that are not a word's two ends find nothing; tapping the
 * waiting letter again lets it go; finding every word solves the puzzle;
 * starting over forgets this puzzle's finds; and a reshuffled puzzle, with
 * the same words elsewhere, starts unsolved.
 *
 * Run: deno task cf test packages/patterns/wordsearch/play.test.tsx
 */
import {
  action,
  assert,
  computed,
  handler,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  childNodes,
  findNode,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import {
  generateWordSearch,
  type Placement,
  placementCells,
  type WordSearch as Puzzle,
} from "./generator.ts";
import WordSearchPlay from "./play.tsx";

/** The first and last cell of the placement at `n` (in placement order). */
const ends = (
  puzzle: { readonly cols: number; readonly placements: readonly Placement[] },
  n: number,
): [number, number] => {
  const cells = placementCells(puzzle.placements[n], puzzle.cols);
  return [cells[0], cells[cells.length - 1]];
};

/** The cells' buttons under `node`, in grid order. */
const cellButtons = (node: unknown): unknown[] => {
  const value = readValue(node);
  const isButton = typeof value === "object" && value !== null &&
    "name" in value && readValue(value.name) === "button";
  return [
    ...(isButton ? [value] : []),
    ...childNodes(value).flatMap(cellButtons),
  ];
};

/** The cell waiting for a word's other end, as labelled; -1 for none. */
const waiting = (ui: unknown): number =>
  cellButtons(ui).findIndex((b) =>
    String(propValue(b, "aria-label")).endsWith(", selected")
  );

/** The cells drawn as part of a found word, in grid order. */
const marked = (ui: unknown): number[] =>
  cellButtons(ui).flatMap((b, i) =>
    String(propValue(b, "style")).includes("color-primary)") ? [i] : []
  );

/** Whether the Start over button is disabled. */
const startOverDisabled = (ui: unknown): boolean =>
  propValue(
    findNode(ui, (n) =>
      textContent(n).trim() === "Start over" &&
      propValue(n, "disabled") !== undefined),
    "disabled",
  ) === true;

/** Tap the two ends of the placement at `n`, last end first when `reversed`. */
const tapEnds = handler<
  void,
  {
    puzzle: Puzzle;
    tap: Stream<{ index: number }>;
    n: number;
    reversed: boolean;
  }
>((_, { puzzle, tap, n, reversed }) => {
  const [first, last] = ends(puzzle, n);
  tap.send({ index: reversed ? last : first });
  tap.send({ index: reversed ? first : last });
});

export default pattern(() => {
  const seed = new Writable(1);
  const puzzle = computed(() =>
    generateWordSearch({
      words: ["apple", "kiwi", "plum"],
      rows: 8,
      cols: 8,
      diagonals: true,
      backwards: true,
      seed: seed.get(),
    })
  );
  const found = new Writable<string[]>([]);
  const play = WordSearchPlay({ puzzle, found });

  // A word and its reversal, which share one run when words run backwards.
  const pairPuzzle = computed(() =>
    generateWordSearch({
      words: ["star", "rats"],
      rows: 8,
      cols: 8,
      diagonals: true,
      backwards: true,
      seed: 2,
    })
  );
  const pair = WordSearchPlay({
    puzzle: pairPuzzle,
    found: new Writable<string[]>([]),
  });
  const pairTap = pair.tap;

  const tap = play.tap;

  return {
    [TESTS]: [
      { assertion: assert(() => play.foundCount === 0 && !play.solved) },
      { assertion: assert(() => startOverDisabled(play[UI])) },

      // A word's first letter, then its last: found.
      { action: tapEnds({ puzzle, tap, n: 0, reversed: false }) },
      { assertion: assert(() => play.foundCount === 1) },
      { assertion: assert(() => waiting(play[UI]) === -1) },
      // The find is said, in a status region a screen reader reads out.
      {
        assertion: assert(() =>
          textContent(
            findNode(play[UI], (n) => propValue(n, "role") === "status"),
          ).includes(`Found ${puzzle.placements[0].label}`)
        ),
      },
      // Its cells are drawn found, and no others.
      {
        assertion: assert(() =>
          JSON.stringify(marked(play[UI])) ===
            JSON.stringify(
              [...placementCells(puzzle.placements[0], puzzle.cols)].sort(
                (a, b) => a - b,
              ),
            )
        ),
      },

      // Its last letter, then its first: found too.
      { action: tapEnds({ puzzle, tap, n: 1, reversed: true }) },
      { assertion: assert(() => play.foundCount === 2) },

      // Two letters that are not a word's two ends find nothing, and the
      // second tap is the start of a new selection.
      {
        action: action(() => {
          const cells = placementCells(puzzle.placements[2], puzzle.cols);
          play.tap.send({ index: cells[0] });
          play.tap.send({ index: cells[1] });
        }),
      },
      { assertion: assert(() => play.foundCount === 2) },
      {
        assertion: assert(() =>
          waiting(play[UI]) ===
            placementCells(puzzle.placements[2], puzzle.cols)[1]
        ),
      },
      { assertion: assert(() => textContent(play[UI]).includes("Not a word")) },

      // Tapping the waiting letter again lets it go.
      {
        action: action(() => play.tap.send({ index: waiting(play[UI]) })),
      },
      { assertion: assert(() => waiting(play[UI]) === -1) },

      // The last word solves the puzzle.
      { action: tapEnds({ puzzle, tap, n: 2, reversed: false }) },
      { assertion: assert(() => play.foundCount === 3 && play.solved) },
      {
        assertion: assert(() => textContent(play[UI]).includes("All 3 found")),
      },

      // Finding a word twice counts it once.
      { action: tapEnds({ puzzle, tap, n: 0, reversed: true }) },
      { assertion: assert(() => found.get().length === 3) },

      // Starting over forgets the finds, and any waiting first tap.
      { assertion: assert(() => !startOverDisabled(play[UI])) },
      { action: action(() => play.tap.send({ index: 0 })) },
      { assertion: assert(() => waiting(play[UI]) === 0) },
      { action: action(() => play.restart.send()) },
      { assertion: assert(() => waiting(play[UI]) === -1) },
      { assertion: assert(() => play.foundCount === 0 && !play.solved) },
      { assertion: assert(() => found.get().length === 0) },

      // A reshuffle hides the same words elsewhere: last arrangement's finds
      // do not count for it.
      { action: tapEnds({ puzzle, tap, n: 0, reversed: false }) },
      { assertion: assert(() => play.foundCount === 1) },
      // A miss leaves a first tap waiting and "Not a word" said.
      {
        action: action(() => {
          const cells = placementCells(puzzle.placements[2], puzzle.cols);
          play.tap.send({ index: cells[0] });
          play.tap.send({ index: cells[1] });
        }),
      },
      { action: action(() => seed.set(2)) },
      { assertion: assert(() => play.foundCount === 0) },
      {
        assertion: assert(() =>
          textContent(play[UI]).includes("Puzzle changed")
        ),
      },
      // What was said in the old arrangement is not said in this one.
      {
        assertion: assert(() => !textContent(play[UI]).includes("Not a word")),
      },
      // A first tap made in the old arrangement waits for nothing.
      { assertion: assert(() => waiting(play[UI]) === -1) },
      // The next find keeps only this arrangement's finds.
      { action: tapEnds({ puzzle, tap, n: 1, reversed: false }) },
      { assertion: assert(() => found.get().length === 1) },

      // A word and its reversal share a run: tapping its ends twice, the
      // same way both times, finds both, so the puzzle can be solved.
      {
        action: tapEnds({
          puzzle: pairPuzzle,
          tap: pairTap,
          n: 0,
          reversed: false,
        }),
      },
      { assertion: assert(() => pair.foundCount === 1) },
      {
        action: tapEnds({
          puzzle: pairPuzzle,
          tap: pairTap,
          n: 0,
          reversed: false,
        }),
      },
      { assertion: assert(() => pair.foundCount === 2 && pair.solved) },
    ],
  };
});
