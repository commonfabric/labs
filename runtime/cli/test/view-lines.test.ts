/**
 * The pager's line-offset helpers: where each line starts, which line an
 * offset is on, and the code-point column of an offset.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { cpLen } from "../lib/view/ansi.ts";
import {
  codePointColumns,
  computeLineStarts,
  lineIndexOf,
} from "../lib/view/lines.ts";

describe("lines", () => {
  describe("codePointColumns()", () => {
    it("returns what `cpLen()` counts from the start of the offset's line", () => {
      // A surrogate pair, a lone high surrogate, a lone low surrogate, and a
      // CRLF line ending, across three lines.
      const text = "a𝑻b\n\uD835x\uDC7By\r\n𝑻𝑻";
      const lineStarts = computeLineStarts(text);
      const columnOf = codePointColumns(text, lineStarts);
      for (let offset = 0; offset <= text.length; offset++) {
        const line = lineIndexOf(lineStarts, offset);
        expect(columnOf(line, offset)).toBe(
          cpLen(text.slice(lineStarts[line], offset)),
        );
      }
    });

    it("counts a surrogate pair as one column", () => {
      const text = "𝑻𝑻x";
      const columnOf = codePointColumns(text, computeLineStarts(text));
      expect(columnOf(0, 4)).toBe(2);
      expect(columnOf(0, 5)).toBe(3);
    });

    it("counts from the start of the given line, not of the text", () => {
      const text = "𝑻ab\ncd";
      const columnOf = codePointColumns(text, computeLineStarts(text));
      expect(columnOf(1, 6)).toBe(1);
    });
  });
});
