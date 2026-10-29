/**
 * Play a word search: tap a hidden word's first letter, then its last, and
 * the word is marked found. The found words are each player's own and
 * follow them across tabs; the letter waiting for its partner is this tab's
 * alone.
 *
 * A find is recorded by where the word runs as well as what it is, so a word
 * that moves (a reshuffle, an edit that rearranges the grid) is unfound
 * again, and `found` holds only the current arrangement's finds once the next
 * one is made.
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import {
  placementCells,
  placementKey,
  placementsBetween,
  type WordSearch as Puzzle,
} from "./generator.ts";
import { byWord, cellStyle, gridStyle, WORD_LIST_STYLE } from "./view.ts";

const EMPTY_PUZZLE: Puzzle = {
  rows: 0,
  cols: 0,
  grid: [],
  placements: [],
  skipped: [],
};

/** What WordSearchPlay plays, and where each player's finds are kept. */
export interface WordSearchPlayInput {
  /** Heading, as on the puzzle it plays. */
  title?: string | Default<"Word Search">;

  /** The puzzle to play, as `WordSearch` or `generateWordSearch` makes it. */
  puzzle?: Puzzle | Default<typeof EMPTY_PUZZLE>;

  /** Each player's found words, by `placementKey`. */
  found?: PerUser<Writable<string[] | Default<[]>>>;
}

/** A player's progress, and the two things a player does. */
export interface WordSearchPlayOutput {
  [NAME]: string;
  [UI]: VNode;
  /** How many of the puzzle's hidden words this player has found. */
  foundCount: number;
  /** Whether every hidden word is found. */
  solved: boolean;
  /** Tap the cell at `index` (row * cols + col); an index off the grid is refused. */
  tap: Stream<{ index: number }>;
  /** Forget this player's finds. */
  restart: Stream<void>;
}

/** A word search to solve by tapping each word's two ends. */
export const WordSearchPlay = pattern<
  WordSearchPlayInput,
  WordSearchPlayOutput
>(({ title, puzzle, found }) => {
  // The cell tapped first, waiting for a word's other end, in the
  // arrangement it was tapped in, and what the last second tap came to (a
  // find or a miss) in the arrangement it was said in, to say until the next
  // tap: this tab's alone.
  const anchor = Writable.perSession.of({ at: "", index: -1 });
  const said = Writable.perSession.of({ at: "", text: "" });

  // The arrangement: a first tap in another one waits for nothing.
  const arrangement = computed(() =>
    `${puzzle.rows}x${puzzle.cols}:${puzzle.grid.join("")}`
  );
  const waitingAt = computed(() =>
    anchor.get().at === arrangement ? anchor.get().index : -1
  );

  const keys = computed(() => puzzle.placements.map(placementKey));
  // Finds in this arrangement: a key from another one is not one.
  const foundHere = computed(() =>
    found.get().filter((key) => keys.includes(key))
  );
  const foundCount = computed(() => foundHere.length);
  const solved = computed(() =>
    puzzle.placements.length > 0 &&
    foundHere.length === puzzle.placements.length
  );
  // The puzzle moved under finds made in another arrangement.
  const changed = computed(() =>
    foundHere.length === 0 && found.get().length > 0
  );

  const tap = action<{ index: number }>(({ index }) => {
    if (
      !Number.isInteger(index) || index < 0 ||
      index >= puzzle.rows * puzzle.cols
    ) {
      throw new RangeError(
        `WordSearchPlay: no cell ${index} in a ${puzzle.rows}×${puzzle.cols} grid`,
      );
    }
    said.set({ at: "", text: "" });
    const first = anchor.get().at === arrangement ? anchor.get().index : -1;
    if (first < 0) {
      anchor.set({ at: arrangement, index });
      return;
    }
    if (first === index) {
      anchor.set({ at: "", index: -1 });
      return;
    }
    const hits = placementsBetween(puzzle, first, index);
    if (hits.length === 0) {
      // Not a word's two ends: say so, and take this tap as a new first one.
      said.set({ at: arrangement, text: "Not a word" });
      anchor.set({ at: arrangement, index });
      return;
    }
    anchor.set({ at: "", index: -1 });
    // Only this arrangement's finds are kept.
    const current = found.get().filter((k) => keys.includes(k));
    // A word and its reversal share a run: the first not yet found is found.
    const hit = hits.find((p) => !current.includes(placementKey(p)));
    if (hit !== undefined) {
      found.set([...current, placementKey(hit)]);
      said.set({ at: arrangement, text: `Found ${hit.label}` });
    }
  });

  const restart = action(() => {
    found.set([]);
    anchor.set({ at: "", index: -1 });
    said.set({ at: "", text: "" });
  });

  const grid = computed(() => gridStyle(puzzle.cols));

  // One entry per cell, row by row: its letter, a label for assistive
  // technology, whether it waits for a word's other end, and its style.
  const cells = computed(() => {
    const marked = new Set(
      puzzle.placements
        .filter((p) => foundHere.includes(placementKey(p)))
        .flatMap((p) => placementCells(p, puzzle.cols)),
    );
    const first = waitingAt;
    return puzzle.grid.join("").split("").map((letter, index) => ({
      index,
      letter,
      label: `${letter}, row ${Math.floor(index / puzzle.cols) + 1}, ` +
        `column ${(index % puzzle.cols) + 1}` +
        (marked.has(index) ? ", found" : "") +
        (index === first ? ", selected" : ""),
      style: cellStyle({ marked: marked.has(index), waiting: index === first }),
    }));
  });

  const words = computed(() =>
    byWord(puzzle.placements).map((p) => ({
      label: p.label,
      spoken: foundHere.includes(placementKey(p))
        ? `${p.label}, found`
        : p.label,
      style: foundHere.includes(placementKey(p))
        ? "text-decoration: line-through; " +
          "color: var(--cf-theme-color-text-muted);"
        : "",
    }))
  );
  const progress = computed(() =>
    solved
      ? `All ${puzzle.placements.length} found`
      : `${foundHere.length} of ${puzzle.placements.length} found`
  );
  const status = computed(() =>
    // What the last tap came to, unless the puzzle has moved since.
    said.get().at === arrangement && said.get().text
      ? said.get().text
      : changed
      ? "Puzzle changed"
      : foundHere.length === 0
      ? "Tap a word's first letter, then its last."
      : ""
  );
  const isEmpty = computed(() => puzzle.placements.length === 0);
  const nothingFound = computed(() => foundHere.length === 0);

  return {
    [NAME]: computed(() =>
      `${title || "Word Search"}${solved ? ", solved" : ""}`
    ),
    [UI]: (
      <cf-vstack gap="3">
        <cf-heading level={4}>{title}</cf-heading>
        {isEmpty
          ? <cf-text tone="muted">Nothing to find yet.</cf-text>
          : (
            <cf-vstack gap="3">
              <cf-hstack gap="2" align="center" justify="between" wrap>
                <cf-text tone={solved ? "success" : "default"}>
                  {progress}
                </cf-text>
                <cf-button
                  variant="ghost"
                  size="sm"
                  disabled={nothingFound}
                  onClick={restart}
                >
                  Start over
                </cf-button>
              </cf-hstack>
              {/* Read out as it changes: a find, a miss, a moved puzzle. */}
              <div role="status" aria-live="polite">
                <cf-text tone="muted">{status}</cf-text>
              </div>
              <div style={grid}>
                {cells.map((cell) => (
                  <button
                    type="button"
                    style={cell.style}
                    aria-label={cell.label}
                    onClick={() => tap.send({ index: cell.index })}
                  >
                    {cell.letter}
                  </button>
                ))}
              </div>
              <div style={WORD_LIST_STYLE}>
                {words.map((word) => (
                  <span style={word.style} aria-label={word.spoken}>
                    {word.label}
                  </span>
                ))}
              </div>
            </cf-vstack>
          )}
      </cf-vstack>
    ),
    foundCount,
    solved,
    tap,
    restart,
  };
});

export default WordSearchPlay;
