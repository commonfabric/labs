/**
 * A word search puzzle built from a list of words: the letter grid, the words
 * to find, a switch that shows where each one is hidden, and a button that
 * downloads the puzzle and its answer key as a PDF.
 *
 * The puzzle is a pure function of its inputs, `seed` included, so it stays
 * put while the reader works on it and the PDF always matches the screen.
 * `shuffle` picks a new seed, and with it a new arrangement of the same words.
 * A host that owns the inputs, such as the form in `main.tsx`, passes its own
 * cells and the puzzle follows them.
 */
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import {
  generateWordSearch,
  MAX_SIZE,
  MIN_SIZE,
  placementCells,
  type WordSearch as Puzzle,
} from "./generator.ts";
import { wordSearchPdf } from "./pdf.ts";

export interface WordSearchInput {
  /** Heading on screen and in the PDF. */
  title?: Writable<string | Default<"Word Search">>;

  /** Words to hide. Accents, spaces and punctuation are dropped. */
  words?: Writable<string[] | Default<[]>>;

  /** Grid size; values outside 4–30 are brought to the nearest end. */
  rows?: Writable<number | Default<12>>;
  cols?: Writable<number | Default<12>>;

  /** Also run words along the two left-to-right diagonals. */
  diagonals?: Writable<boolean | Default<false>>;

  /** Also run every allowed direction in reverse. */
  backwards?: Writable<boolean | Default<false>>;

  /** Chooses the arrangement; the same seed gives the same puzzle. */
  seed?: Writable<number | Default<1>>;
}

export interface WordSearchOutput {
  [NAME]: string;
  [UI]: VNode;
  puzzle: Puzzle;
  /** The two-page PDF (puzzle, then answer key) as an ASCII string. */
  pdf: string;
  shuffle: Stream<void>;
}

/** A form value as a grid dimension the generator accepts. */
const gridSize = (value: number): number =>
  Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(Number(value) || 0)));

/** A file name from the title: lower case, dashes, never empty. */
const fileName = (title: string): string =>
  `${
    title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "word-search"
  }.pdf`;

export const WordSearch = pattern<WordSearchInput, WordSearchOutput>(
  ({ title, words, rows, cols, diagonals, backwards, seed }) => {
    // Whether the answers show is this viewer's own, for this sitting.
    const showAnswers = Writable.perSession.of<boolean>(false);

    const puzzle = computed(() =>
      generateWordSearch({
        words: words.get(),
        rows: gridSize(rows.get()),
        cols: gridSize(cols.get()),
        diagonals: diagonals.get(),
        backwards: backwards.get(),
        seed: seed.get(),
      })
    );

    const pdf = computed(() => wordSearchPdf(puzzle, title.get()));
    const pdfName = computed(() => fileName(title.get()));

    const shuffle = action(() => {
      seed.set(Math.floor(Math.random() * 0x100000000));
    });

    const gridStyle = computed(() =>
      `display: grid; grid-template-columns: repeat(${puzzle.cols}, 1fr); ` +
      `gap: 2px; width: min(100%, ${puzzle.cols * 2.25}rem); ` +
      `font-family: var(--cf-theme-mono-font-family, monospace); ` +
      `font-weight: 600; user-select: none;`
    );

    // One entry per grid cell, row by row, with whether it is part of an
    // answer when answers are showing.
    const cells = computed(() => {
      const answers = new Set(
        showAnswers.get()
          ? puzzle.placements.flatMap((p) => placementCells(p, puzzle.cols))
          : [],
      );
      return puzzle.grid.join("").split("").map((letter, i) => ({
        letter,
        style: `aspect-ratio: 1; display: flex; align-items: center; ` +
          `justify-content: center; border-radius: 999px; ` +
          (answers.has(i)
            ? "background: var(--cf-theme-color-primary); " +
              "color: var(--cf-theme-color-primary-foreground);"
            : "color: var(--cf-theme-color-text);"),
      }));
    });

    const foundWords = computed(() =>
      puzzle.placements.map((p) => p.word).sort()
    );
    const hasUnplaced = computed(() => puzzle.unplaced.length > 0);
    const unplacedNote = computed(() =>
      `Didn't fit: ${puzzle.unplaced.join(", ")}. ` +
      `Try a bigger grid or more directions.`
    );
    const isEmpty = computed(() => puzzle.placements.length === 0);

    return {
      [NAME]: computed(() => title.get() || "Word Search"),
      [UI]: (
        <cf-vstack gap="3">
          <cf-hstack gap="2" align="center" justify="between" wrap>
            <cf-heading level={4}>{title}</cf-heading>
            <cf-hstack gap="2" align="center">
              <cf-hstack gap="1" align="center">
                <cf-switch $checked={showAnswers} />
                <cf-text tone="muted">Answers</cf-text>
              </cf-hstack>
              <cf-button variant="secondary" size="sm" onClick={shuffle}>
                Shuffle
              </cf-button>
              <cf-file-download
                $data={pdf}
                $filename={pdfName}
                mime-type="application/pdf"
                variant="primary"
                size="sm"
              >
                PDF
              </cf-file-download>
            </cf-hstack>
          </cf-hstack>

          <div style={gridStyle}>
            {cells.map((cell) => <span style={cell.style}>{cell.letter}</span>)}
          </div>

          {isEmpty
            ? <cf-text tone="muted">Add some words to hide.</cf-text>
            : (
              <div style="display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; font-weight: 600; letter-spacing: 0.05em;">
                {foundWords.map((word) => <span>{word}</span>)}
              </div>
            )}

          {hasUnplaced
            ? <cf-text tone="warning">{unplacedNote}</cf-text>
            : null}
        </cf-vstack>
      ),
      puzzle,
      pdf,
      shuffle,
    };
  },
);

export default WordSearch;
