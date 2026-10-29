import { assertEquals } from "@std/assert";
import type { Document } from "../lib/view/model.ts";
import { findMatches } from "../lib/view/actions.ts";

/** A document whose lines are exactly `texts`, with no spans/structure. Enough
 * for `findMatches`, which only reads each line's `text`. */
function linesDoc(...texts: string[]): Document {
  return {
    text: texts.join("\n"),
    lines: texts.map((text) => ({ text, spans: [] })),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

Deno.test(
  "findMatches: case-sensitive columns map non-BMP characters to one column (line 88)",
  () => {
    // An upper-case letter in the query forces the case-sensitive path, which
    // builds the verbatim haystack and maps offsets to columns with cpLen.
    // `𝑻` (U+1D47B) is one code point but two UTF-16 units, so the match after
    // it must still report column 3, not column 4.
    assertEquals(
      findMatches(linesDoc("𝑻x Bar"), "Bar"),
      [{ line: 0, start: 3, end: 6 }],
    );
    // Two non-BMP characters before the match still leave it at column 4.
    assertEquals(
      findMatches(linesDoc("𝑻𝑻 Baz"), "Baz"),
      [{ line: 0, start: 3, end: 6 }],
    );
    // The match itself spanning a non-BMP character keeps its width at one
    // column per code point: `X𝑻Y` is three columns, start 0 end 3.
    assertEquals(
      findMatches(linesDoc("X𝑻Y rest"), "X𝑻Y"),
      [{ line: 0, start: 0, end: 3 }],
    );
    // A bare ASCII case-sensitive match also routes through the verbatim
    // haystack and the cpLen column map.
    assertEquals(
      findMatches(linesDoc("foo Bar"), "Bar"),
      [{ line: 0, start: 4, end: 7 }],
    );
  },
);

Deno.test(
  "findMatches: case-insensitive fold maps offsets back to original columns (line 79)",
  () => {
    // A lower-case query takes the folded haystack path, whose colOf maps each
    // folded UTF-16 offset back to its original code-point column. `İ` (U+0130)
    // lowercases to two code units (`i` + combining dot), so a match after it
    // must not be shifted by the extra folded unit: `foo` stays at column 3.
    assertEquals(
      findMatches(linesDoc("İx foo"), "foo"),
      [{ line: 0, start: 3, end: 6 }],
    );
    // Matching the `i` that `İ` folds to highlights the single original column
    // the fold came from, exercising the colOf map at offset 0.
    assertEquals(
      findMatches(linesDoc("İx"), "i"),
      [{ line: 0, start: 0, end: 1 }],
    );
    // A match whose last folded unit is the final unit of the haystack still
    // resolves its end column through the same map.
    assertEquals(
      findMatches(linesDoc("xyİ"), "i"),
      [{ line: 0, start: 2, end: 3 }],
    );
  },
);
