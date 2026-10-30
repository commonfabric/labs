import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EXCERPT_CODE_POINTS,
  excerptOf,
  locateQuote,
  mapAnchor,
  mapPosition,
  precedes,
} from "./anchors.ts";

describe("anchors", () => {
  describe("locateQuote()", () => {
    it("returns the start of a quote the text holds once", () => {
      expect(locateQuote("one two three", "two")).toBe(4);
    });

    it("returns `empty` for an empty quote, whatever the text", () => {
      expect(locateQuote("one two", "")).toBe("empty");
      expect(locateQuote("", "")).toBe("empty");
    });

    it("returns `absent` for a quote the text holds nowhere", () => {
      expect(locateQuote("one two three", "four")).toBe("absent");
    });

    it("returns `repeated` for a quote the text holds more than once", () => {
      expect(locateQuote("two one two", "two")).toBe("repeated");
    });

    it("compares code unit for code unit, so case and spacing count", () => {
      expect(locateQuote("one two", "Two")).toBe("absent");
      expect(locateQuote("one  two", "one two")).toBe("absent");
    });
  });

  describe("mapPosition()", () => {
    it("leaves a position before the change alone, and shifts one after it by the change in length", () => {
      const changes = [{ from: 2, to: 4, insert: "xyz" }];
      expect(mapPosition(1, 1, changes)).toBe(1);
      expect(mapPosition(6, 1, changes)).toBe(7);
      expect(mapPosition(6, -1, changes)).toBe(7);
    });

    it("keeps a position after text inserted at it with side 1, and before it with side -1", () => {
      const changes = [{ from: 3, insert: "ab" }];
      expect(mapPosition(3, 1, changes)).toBe(5);
      expect(mapPosition(3, -1, changes)).toBe(3);
    });

    it("moves a position inside replaced text to the replacement's start with side -1, and its end with side 1", () => {
      const changes = [{ from: 2, to: 6, insert: "xy" }];
      expect(mapPosition(4, -1, changes)).toBe(2);
      expect(mapPosition(4, 1, changes)).toBe(4);
    });

    it("moves the start of replaced text to the replacement's start and its end to the replacement's end, whatever the side", () => {
      const changes = [{ from: 2, to: 6, insert: "xy" }];
      expect(mapPosition(2, 1, changes)).toBe(2);
      expect(mapPosition(2, -1, changes)).toBe(2);
      expect(mapPosition(6, 1, changes)).toBe(4);
      expect(mapPosition(6, -1, changes)).toBe(4);
    });

    it("applies several changes in order, each against the text before any of them", () => {
      const changes = [{ from: 0, insert: "a" }, { from: 2, to: 3 }, {
        from: 5,
        insert: "bb",
      }];
      expect(mapPosition(4, 1, changes)).toBe(4);
      expect(mapPosition(5, 1, changes)).toBe(7);
      expect(mapPosition(5, -1, changes)).toBe(5);
    });

    it("lands two insertions at one position in list order, both after a position with side 1", () => {
      const changes = [{ from: 3, insert: "a" }, { from: 3, insert: "b" }];
      expect(mapPosition(3, 1, changes)).toBe(5);
      expect(mapPosition(3, -1, changes)).toBe(3);
    });
  });

  describe("mapAnchor()", () => {
    it("returns the range itself when nothing moved it", () => {
      const range = { from: 4, to: 7 };
      expect(mapAnchor(range, [{ from: 8, insert: "x" }])).toBe(range);
    });

    it("moves a range after an insertion before it", () => {
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 0, insert: "ab" }]))
        .toEqual({ from: 6, to: 9 });
    });

    it("keeps text inserted at either end outside the range", () => {
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 4, insert: "ab" }]))
        .toEqual({ from: 6, to: 9 });
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 7, insert: "ab" }]))
        .toEqual({ from: 4, to: 7 });
    });

    it("grows a range by text inserted inside it, and shrinks it by a deletion overlapping it", () => {
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 5, insert: "ab" }]))
        .toEqual({ from: 4, to: 9 });
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 6, to: 9 }]))
        .toEqual({ from: 4, to: 6 });
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 2, to: 5 }]))
        .toEqual({ from: 2, to: 4 });
    });

    it("empties a range a deletion covers, at the deletion's start", () => {
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 3, to: 8 }]))
        .toEqual({ from: 3, to: 3 });
      expect(mapAnchor({ from: 4, to: 7 }, [{ from: 4, to: 7 }]))
        .toEqual({ from: 4, to: 4 });
    });

    it("keeps an empty range a point, before text inserted at it", () => {
      expect(mapAnchor({ from: 4, to: 4 }, [{ from: 4, insert: "ab" }]))
        .toEqual({ from: 4, to: 4 });
      expect(mapAnchor({ from: 4, to: 4 }, [{ from: 0, insert: "ab" }]))
        .toEqual({ from: 6, to: 6 });
      expect(mapAnchor({ from: 4, to: 4 }, [{ from: 2, to: 6 }]))
        .toEqual({ from: 2, to: 2 });
    });
  });

  describe("precedes()", () => {
    it("returns `true` for an earlier version of the same epoch", () => {
      expect(precedes({ epoch: 1, version: 4 }, { epoch: 1, version: 5 }))
        .toBe(true);
    });

    it("returns `false` for the same version, and for a later one", () => {
      expect(precedes({ epoch: 1, version: 5 }, { epoch: 1, version: 5 }))
        .toBe(false);
      expect(precedes({ epoch: 1, version: 6 }, { epoch: 1, version: 5 }))
        .toBe(false);
    });

    it("orders by epoch first, whatever the versions", () => {
      expect(precedes({ epoch: 1, version: 500 }, { epoch: 2, version: 1 }))
        .toBe(true);
      expect(precedes({ epoch: 2, version: 1 }, { epoch: 1, version: 500 }))
        .toBe(false);
    });
  });

  describe("excerptOf()", () => {
    it("returns a short quote as it is", () => {
      expect(excerptOf("a short quote")).toBe("a short quote");
    });

    it("collapses line breaks and runs of spaces to one space, and trims", () => {
      expect(excerptOf("  two\n\nlines   here ")).toBe("two lines here");
    });

    it("cuts a long quote to the excerpt length in code points, with an ellipsis", () => {
      const quote = "😀".repeat(EXCERPT_CODE_POINTS + 1);
      expect(excerptOf(quote)).toBe("😀".repeat(EXCERPT_CODE_POINTS) + "…");
      expect(excerptOf("x".repeat(EXCERPT_CODE_POINTS))).toBe(
        "x".repeat(EXCERPT_CODE_POINTS),
      );
    });
  });
});
