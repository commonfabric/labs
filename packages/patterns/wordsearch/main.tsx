/**
 * Word Search Maker: a form for the words and settings beside the puzzle they
 * make, which updates as the form changes and downloads as a PDF.
 *
 * The form owns the settings and hands its cells to `WordSearch`, which owns
 * generation, the answer view, shuffling and export. The word list is typed as
 * free text, one word or phrase per line (commas also separate), so pasting a
 * list from anywhere works.
 */
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import {
  MAX_SIZE,
  MIN_SIZE,
  parseWordList,
  type WordSearch as Puzzle,
} from "./generator.ts";
import { WordSearch } from "./wordsearch.tsx";

interface WordSearchMakerInput {
  title?: Writable<string | Default<"Word Search">>;
  wordText?: Writable<
    string | Default<"apple\nbanana\ncherry\ngrape\nlemon\nmango\npeach">
  >;
  rows?: Writable<number | Default<12>>;
  cols?: Writable<number | Default<12>>;
  diagonals?: Writable<boolean | Default<false>>;
  backwards?: Writable<boolean | Default<false>>;
  seed?: Writable<number | Default<1>>;
}

// cf-slider holds a plain number rather than a cell, so its change event is
// how a move reaches the setting.
const setSize = handler<
  { detail: { value: number } },
  { size: Writable<number> }
>(
  (event, { size }) => size.set(event.detail.value),
);

export interface WordSearchMakerOutput {
  [NAME]: string;
  [UI]: VNode;
  puzzle: Puzzle;
}

export default pattern<WordSearchMakerInput, WordSearchMakerOutput>(
  ({ title, wordText, rows, cols, diagonals, backwards, seed }) => {
    const words = computed(() => parseWordList(wordText.get()));
    const puzzle = WordSearch({
      title,
      words,
      rows,
      cols,
      diagonals,
      backwards,
      seed,
    });
    // The size the grid has, which a typed-in value may have been brought to.
    const rowsLabel = computed(() => `Rows: ${puzzle.puzzle.rows}`);
    const colsLabel = computed(() => `Columns: ${puzzle.puzzle.cols}`);

    return {
      [NAME]: computed(() => title.get() || "Word Search"),
      [UI]: (
        <cf-screen>
          <cf-hstack gap="4" padding="4" align="start" wrap>
            <cf-vstack gap="3" style="flex: 1 1 16rem; max-width: 22rem;">
              <cf-field label="Title">
                <cf-input $value={title} />
              </cf-field>
              <cf-field label="Words, one per line">
                <cf-textarea $value={wordText} rows={10} />
              </cf-field>
              <cf-field label={rowsLabel}>
                <cf-slider
                  value={rows}
                  min={MIN_SIZE}
                  max={MAX_SIZE}
                  oncf-change={setSize({ size: rows })}
                />
              </cf-field>
              <cf-field label={colsLabel}>
                <cf-slider
                  value={cols}
                  min={MIN_SIZE}
                  max={MAX_SIZE}
                  oncf-change={setSize({ size: cols })}
                />
              </cf-field>
              <cf-hstack gap="2" align="center">
                <cf-switch $checked={diagonals} />
                <cf-text>Diagonals</cf-text>
              </cf-hstack>
              <cf-hstack gap="2" align="center">
                <cf-switch $checked={backwards} />
                <cf-text>Backwards</cf-text>
              </cf-hstack>
            </cf-vstack>
            <div style="flex: 2 1 20rem; min-width: 0;">{puzzle}</div>
          </cf-hstack>
        </cf-screen>
      ),
      puzzle: puzzle.puzzle,
    };
  },
);
