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
  type PerSession,
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
  stripAccents,
  type WordSearch as Puzzle,
} from "./generator.ts";
import { wordSearchPdf } from "./pdf.ts";

export interface WordSearchInput {
  /** Heading on screen and in the PDF. */
  title?: string | Default<"Word Search">;

  /**
   * Words to hide, as they should be listed. In the grid, accents, spaces and
   * punctuation are dropped.
   */
  words?: string[] | Default<[]>;

  /** Grid size; values outside 4–30 are brought to the nearest end. */
  rows?: number | Default<12>;
  cols?: number | Default<12>;

  /** Also run words along the two left-to-right diagonals. */
  diagonals?: boolean | Default<false>;

  /** Also run every allowed direction in reverse. */
  backwards?: boolean | Default<false>;

  /**
   * Chooses the arrangement; the same seed gives the same puzzle. The one
   * input written here: `shuffle` sets a new one.
   */
  seed?: Writable<number | Default<1>>;

  /**
   * Whether the hidden words are marked. Each viewer's own, for this sitting:
   * one person checking the answers does not reveal them to another.
   */
  showAnswers?: PerSession<Writable<boolean | Default<false>>>;
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
    stripAccents(title).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "word-search"
  }.pdf`;

export const WordSearch = pattern<WordSearchInput, WordSearchOutput>(
  ({ title, words, rows, cols, diagonals, backwards, seed, showAnswers }) => {
    const puzzle = computed(() =>
      generateWordSearch({
        words,
        rows: gridSize(rows),
        cols: gridSize(cols),
        diagonals,
        backwards,
        seed: seed.get(),
      })
    );

    const pdf = computed(() => wordSearchPdf(puzzle, title));
    const pdfName = computed(() => fileName(title));

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

    const listed = computed(() =>
      [...puzzle.placements]
        .sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
        .map((p) => p.label)
    );
    const hasSkipped = computed(() => puzzle.skipped.length > 0);
    const skippedNote = computed(() =>
      `Left out: ${
        puzzle.skipped.map((s) =>
          `${s.label} (${
            s.reason === "too-short" ? "needs 2+ letters" : "no room"
          })`
        ).join(", ")
      }.`
    );
    const isEmpty = computed(() => puzzle.placements.length === 0);

    return {
      [NAME]: computed(() => title || "Word Search"),
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
                {listed.map((label) => <span>{label}</span>)}
              </div>
            )}

          {hasSkipped ? <cf-text tone="warning">{skippedNote}</cf-text> : null}
        </cf-vstack>
      ),
      puzzle,
      pdf,
      shuffle,
    };
  },
);

export default WordSearch;
