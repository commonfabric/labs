/**
 * Unit tests for the pure recipe logic: timing edits and their wording, the
 * extraction prompt and how its answer applies, and the word diff shown when
 * reviewing a notes change. The pattern-level flow is in
 * `food-recipe.test.tsx`.
 */
import { expect } from "@std/expect";

import { describe, it } from "@commonfabric/test-support/test";

import {
  type DiffChunk,
  extractionParts,
  extractionText,
  formatTiming,
  fromWire,
  type RecipeScalars,
  scalarChanges,
  scalarUpdates,
  withGroupNumber,
  wordDiff,
} from "./recipe-logic.ts";
import type { StepGroup } from "./schemas.tsx";

const group = (timing: Partial<StepGroup>): StepGroup => ({
  id: "g",
  name: "Prep",
  steps: [],
  ...timing,
});

const scalars: RecipeScalars = {
  name: "Soup",
  cuisine: "",
  servings: 4,
  yield: "",
  difficulty: "medium",
  prepTime: 0,
  cookTime: 0,
  restTime: 0,
  holdTime: 0,
  category: "other",
  source: "",
  notes: "",
};

const words = (chunks: DiffChunk[], type: DiffChunk["type"]) =>
  chunks.filter((c) => c.type === type && c.word.trim()).map((c) => c.word);

describe("recipe-logic", () => {
  describe("withGroupNumber()", () => {
    it("clears the nights when minutes before serving are set", () => {
      const next = withGroupNumber(
        group({ nightsBeforeServing: 2 }),
        "minutesBeforeServing",
        30,
      );
      expect(next.minutesBeforeServing).toBe(30);
      expect("nightsBeforeServing" in next).toBe(false);
    });

    it("keeps the timing when another field is set", () => {
      const next = withGroupNumber(
        group({ nightsBeforeServing: 2 }),
        "duration",
        30,
      );
      expect(next.nightsBeforeServing).toBe(2);
      expect(next.duration).toBe(30);
    });

    it("keeps the minutes when nights are set to 0", () => {
      const next = withGroupNumber(
        group({ minutesBeforeServing: 45 }),
        "nightsBeforeServing",
        0,
      );
      expect(next.minutesBeforeServing).toBe(45);
      expect(next.nightsBeforeServing).toBe(0);
    });

    it("removes a field set to undefined and leaves the other", () => {
      const next = withGroupNumber(
        group({ minutesBeforeServing: 45, duration: 10 }),
        "minutesBeforeServing",
        undefined,
      );
      expect("minutesBeforeServing" in next).toBe(false);
      expect(next.duration).toBe(10);
    });
  });

  describe("formatTiming()", () => {
    it("says minutes alone when under an hour", () => {
      expect(formatTiming(group({ minutesBeforeServing: 45 }))).toBe(
        "45m before serving",
      );
    });

    it("says hours, with minutes only when there are some", () => {
      expect(formatTiming(group({ minutesBeforeServing: 120 }))).toBe(
        "2h before serving",
      );
      expect(formatTiming(group({ minutesBeforeServing: 90 }))).toBe(
        "1h 30m before serving",
      );
    });

    it("names serving time, nights, and no schedule", () => {
      expect(formatTiming(group({ minutesBeforeServing: 0 }))).toBe(
        "At serving time",
      );
      expect(formatTiming(group({ nightsBeforeServing: 2 }))).toBe(
        "2 nights before serving",
      );
      expect(formatTiming(group({}))).toBe("Unscheduled");
    });
  });

  describe("fromWire()", () => {
    it("drops blank and zero fields and an oven at 0°F", () => {
      expect(fromWire({
        name: "Roast",
        cuisine: "",
        servings: 0,
        difficulty: "",
        tags: [],
        remainingNotes: "",
        stepGroups: [{
          name: "Cook",
          nightsBeforeServing: 0,
          minutesBeforeServing: 0,
          duration: 0,
          maxWaitMinutes: 0,
          oven: { temperature: 0, duration: 0, heightSlots: 1, width: "full" },
          steps: ["Roast"],
        }],
      })).toEqual({
        name: "Roast",
        remainingNotes: "",
        stepGroups: [{
          name: "Cook",
          minutesBeforeServing: 0,
          steps: ["Roast"],
        }],
      });
    });

    it("keeps nights over minutes and an oven that is on", () => {
      const oven = {
        temperature: 350,
        duration: 20,
        heightSlots: 2,
        width: "half" as const,
      };
      expect(fromWire({
        stepGroups: [{
          name: "Bake",
          nightsBeforeServing: 1,
          minutesBeforeServing: 60,
          duration: 30,
          maxWaitMinutes: 15,
          oven,
          steps: [],
        }],
      })).toEqual({
        stepGroups: [{
          name: "Bake",
          nightsBeforeServing: 1,
          duration: 30,
          maxWaitMinutes: 15,
          oven,
          steps: [],
        }],
      });
    });

    it("reads no answer as no extraction", () => {
      expect(fromWire(null)).toBeNull();
      expect(fromWire(undefined)).toBeNull();
    });
  });

  describe("extractionParts()", () => {
    it("sends the text, then each photo in order", () => {
      expect(extractionParts("Extract", ["a.png", "", "b.png"])).toEqual([
        { type: "text", text: "Extract" },
        { type: "image", image: "a.png" },
        { type: "image", image: "b.png" },
      ]);
    });

    it("sends only the text when there are no photos", () => {
      expect(extractionParts("Extract", [])).toEqual([
        { type: "text", text: "Extract" },
      ]);
    });
  });

  describe("extractionText()", () => {
    it("asks for the photos and includes the notes", () => {
      expect(extractionText("  two eggs ", 2)).toBe(
        "Extract the recipe.\n\nRead the recipe in the attached photos." +
          "\n\nNotes:\ntwo eggs",
      );
    });

    it("mentions no photo when there is none", () => {
      expect(extractionText("two eggs", 0)).toBe(
        "Extract the recipe.\n\nNotes:\ntwo eggs",
      );
    });
  });

  describe("scalarChanges()", () => {
    it("shows a change to a known difficulty", () => {
      expect(scalarChanges(scalars, { difficulty: "hard" })).toEqual([
        { field: "Difficulty", from: "medium", to: "hard" },
      ]);
      expect(scalarUpdates({ difficulty: "hard" })).toEqual({
        difficulty: "hard",
      });
    });

    it("ignores a difficulty that is not one of the choices", () => {
      const extraction = { difficulty: "extreme" as never };
      expect(scalarChanges(scalars, extraction)).toEqual([]);
      expect(scalarUpdates(extraction)).toEqual({});
    });
  });

  describe("wordDiff()", () => {
    it("shows a word inserted before common words as added", () => {
      const diff = wordDiff("p q z", "r p q y");
      expect(diff.map((c) => `${c.type}:${c.word}`)).toEqual([
        "added:r",
        "added: ",
        "unchanged:p",
        "unchanged: ",
        "unchanged:q",
        "unchanged: ",
        "removed:z",
        "added:y",
      ]);
    });

    it("reads back as the old text without additions and the new without removals", () => {
      const from = "salt the bird well and rest";
      const to = "brine the bird and rest overnight";
      const diff = wordDiff(from, to);
      expect(diff.filter((c) => c.type !== "added").map((c) => c.word).join(""))
        .toBe(from);
      expect(
        diff.filter((c) => c.type !== "removed").map((c) => c.word).join(""),
      ).toBe(to);
      expect(words(diff, "added")).toEqual(["brine", "overnight"]);
      expect(words(diff, "removed")).toEqual(["salt", "well"]);
    });
  });
});
