/**
 * Unit tests for the form the ambient record prints in.
 *
 * The expectations are written as literal lines rather than composed out of
 * the width the module exports, because what the format owes a caller is a
 * value at a column they can count — and an expectation built from the same
 * constant as the code would move with it and say nothing.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { RECORD_LABEL_WIDTH, renderRecord } from "../lib/shuttle/record.ts";

describe("record", () => {
  describe("RECORD_LABEL_WIDTH", () => {
    it("is the column a value starts at", () => {
      expect(renderRecord([{ label: "a", value: "b" }]).indexOf("b"))
        .toBe(RECORD_LABEL_WIDTH);
    });
  });

  describe("renderRecord()", () => {
    it("returns the label padded out to the column, and the value after it", () => {
      expect(renderRecord([{ label: "scope", value: "@space" }]))
        .toBe("scope     @space");
    });

    it("returns one entry to a line, in the order they were given", () => {
      expect(
        renderRecord([
          { label: "api", value: "https://toolshed.example/" },
          { label: "space", value: "board" },
        ]),
      ).toBe("api       https://toolshed.example/\nspace     board");
    });

    it("returns the empty string for no entries at all", () => {
      expect(renderRecord([])).toBe("");
    });

    it("throws for a label as long as the column, which would touch its value", () => {
      // As long as, not longer than: a label filling the column exactly leaves
      // no space between the two, and a value read back by slicing the width
      // would start with the label's last character.

      expect(() => renderRecord([{ label: "abcdefghij", value: "x" }]))
        .toThrow("`abcdefghij` is too long for a column of 10");
    });

    it("returns a label one short of the column with a single space after it", () => {
      expect(renderRecord([{ label: "abcdefghi", value: "x" }]))
        .toBe("abcdefghi x");
    });
  });
});
