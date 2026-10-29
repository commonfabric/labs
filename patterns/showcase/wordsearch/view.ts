/**
 * How a word search is drawn, shared by the puzzle view (`wordsearch.tsx`)
 * and the play view (`play.tsx`) so the two look alike: the grid, a cell
 * marked as part of a word, the cell waiting for a word's other end, and the
 * list of words to find.
 */
import { type Placement } from "./generator.ts";

/** The grid of `cols` columns of round cells. */
export const gridStyle = (cols: number): string =>
  `display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 2px; ` +
  `width: min(100%, ${cols * 2.25}rem); user-select: none; ` +
  `font-family: var(--cf-theme-mono-font-family, monospace); font-weight: 600;`;

/**
 * One cell: `marked` fills it as part of a word; `waiting` rings it as the
 * first tap of a selection, in the text color so it reads on a filled cell.
 */
export const cellStyle = (
  { marked, waiting }: { marked: boolean; waiting: boolean },
): string =>
  "aspect-ratio: 1; display: flex; align-items: center; " +
  "justify-content: center; border-radius: 999px; border: none; " +
  "padding: 0; font: inherit; " +
  (marked
    ? "background: var(--cf-theme-color-primary); " +
      "color: var(--cf-theme-color-primary-foreground);"
    : waiting
    ? "background: var(--cf-theme-color-surface-hover); " +
      "color: var(--cf-theme-color-text);"
    : "background: transparent; color: var(--cf-theme-color-text);") +
  (waiting ? " box-shadow: inset 0 0 0 2px var(--cf-theme-color-text);" : "");

/** The list of words to find, laid out as a wrapping row. */
export const WORD_LIST_STYLE =
  "display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; font-weight: 600; " +
  "letter-spacing: 0.05em;";

/** Placements in the order the word list shows them: alphabetical by word. */
export const byWord = (placements: readonly Placement[]): Placement[] =>
  [...placements].sort((a, b) =>
    a.word < b.word ? -1 : a.word > b.word ? 1 : 0
  );
