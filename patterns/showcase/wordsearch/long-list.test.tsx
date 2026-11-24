/**
 * Tests the Word Search's PDF for a word list too long to fit under a
 * readable grid: the grid keeps its own page, and the list moves to pages of
 * its own, between the puzzle and the answer key. `pdf.test.ts` checks the
 * layout of those pages in detail.
 *
 * Run: deno task cf test patterns/showcase/wordsearch/long-list.test.tsx
 */
import { assert, pattern, TESTS } from "commonfabric";
import WordSearch from "./wordsearch.tsx";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** Two hundred distinct four-letter words. */
const WORDS = Array.from(
  { length: 200 },
  (_, i) => `w${ALPHABET[i % 26]}${ALPHABET[Math.floor(i / 26)]}q`,
);

/** Where in `pdf` each drawing of the title `title` starts, in order. */
const titleAt = (pdf: string, title: string): number[] =>
  [...pdf.matchAll(new RegExp(`\\(${title}\\) Tj`, "g"))].map((m) => m.index);

export default pattern(() => {
  const puzzle = WordSearch({
    title: "Many",
    words: WORDS,
    rows: 30,
    cols: 30,
    seed: 3,
  });

  return {
    [TESTS]: [
      {
        assertion: assert(() => puzzle.puzzle.placements.length > 150),
      },
      {
        assertion: assert(() => {
          const puzzlePage = titleAt(puzzle.pdf, "Many");
          const listPages = titleAt(puzzle.pdf, "Many - Words");
          const keyPage = titleAt(puzzle.pdf, "Many - Answer key");
          return puzzlePage.length === 1 && listPages.length > 1 &&
            keyPage.length === 1 && puzzlePage[0] < listPages[0] &&
            listPages[listPages.length - 1] < keyPage[0];
        }),
      },
    ],
  };
});
