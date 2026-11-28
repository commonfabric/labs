import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";

import {
  boardView,
  ideasPrompt,
  type Level,
  pinsLostByRemovingLevel,
  type Spindle,
  withExtraPrompt,
  withPinned,
} from "./story-logic.ts";

const LEVELS: Level[] = [
  { title: "Characters", prompt: "Name them.", branch: 2 },
  { title: "Chapters", prompt: "Write chapters.", branch: 1 },
];

const pinned = (path: string, text: string, parent: string): Spindle =>
  withPinned([], path, 0, text, parent)[0];

describe("story-logic", () => {
  describe("ideasPrompt()", () => {
    it("asks for nothing until the first attempt", () => {
      expect(ideasPrompt(0)).toBe("");
    });

    it("asks for four synopsis ideas, tagged with the attempt", () => {
      const first = ideasPrompt(1);
      const second = ideasPrompt(2);
      expect(first).toContain("Generate 4 creative story synopsis ideas.");
      expect(first.endsWith("[Generation attempt: 1]")).toBe(true);
      expect(second.endsWith("[Generation attempt: 2]")).toBe(true);
      expect(second).not.toBe(first);
    });
  });

  describe("withExtraPrompt()", () => {
    it("adds a record with the instruction for an untouched spindle", () => {
      const next = withExtraPrompt([], "0.1", "Be brief.");
      expect(next).toEqual([{
        path: "0.1",
        pinned: -1,
        pinnedText: "",
        parentHash: "",
        extraPrompt: "Be brief.",
        respins: 0,
        requested: false,
      }]);
    });

    it("drops the pin when the instruction changes", () => {
      const records = [pinned("0", "Bo", "seed"), pinned("1", "Cy", "seed")];
      const next = withExtraPrompt(records, "0", "Be brief.");
      expect(next[0]).toMatchObject({
        path: "0",
        extraPrompt: "Be brief.",
        pinned: -1,
        pinnedText: "",
        parentHash: "",
      });
      expect(next[1]).toBe(records[1]);
      expect(records[0].pinnedText).toBe("Bo");
      expect(boardView(LEVELS, "seed", next)[0].spindles[0].prompt).toContain(
        "Be brief.",
      );
    });

    it("keeps the pin when the instruction is unchanged", () => {
      const records = withExtraPrompt([pinned("0", "Bo", "seed")], "0", "x");
      const repinned = withPinned(records, "0", 2, "Bo", "seed");
      const next = withExtraPrompt(repinned, "0", "x");
      expect(next[0]).toBe(repinned[0]);
      expect(next[0].pinnedText).toBe("Bo");
    });
  });

  describe("pinsLostByRemovingLevel()", () => {
    it("counts the pins on the board at the last level", () => {
      const records = [
        pinned("0", "a", "seed"),
        pinned("1", "b", "seed"),
        pinned("0.0", "c", "a"),
        pinned("1.0", "d", "b"),
      ];
      expect(pinsLostByRemovingLevel(LEVELS, "seed", records)).toBe(2);
    });

    it("does not count pins above the last level or hidden from the board", () => {
      // "1.0" sits under an unpinned "1", so the board does not show it.
      const records = [
        pinned("0", "a", "seed"),
        pinned("1.0", "d", "b"),
        { ...pinned("0.0", "c", "a"), pinned: -1, pinnedText: "" },
      ];
      expect(pinsLostByRemovingLevel(LEVELS, "seed", records)).toBe(0);
      expect(pinsLostByRemovingLevel(LEVELS, "", [pinned("0.0", "c", "a")]))
        .toBe(0);
    });
  });
});
