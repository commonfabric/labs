import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cellChipClasses,
  cellLabelView,
  cellName,
  type ConsoleCellLabelView,
  schemaSummary,
  spaceHoldsNoLabel,
} from "../../../console/src/cell-chip.ts";

describe("console/src/cell-chip", () => {
  describe("cellName", () => {
    it("calls a cell by the name a person gave it", () => {
      expect(cellName({ slug: "reading-list", token: "cfh:a:1", ref: "of:x" }))
        .toBe("reading-list");
    });

    it("falls back to the handle the model held", () => {
      expect(cellName({ token: "cfh:a:1", ref: "of:x" })).toBe("cfh:a:1");
    });

    it("falls back to the address when nothing else names it", () => {
      expect(cellName({ ref: "of:x" })).toBe("of:x");
    });

    it("says cell for one nothing names", () => {
      expect(cellName({})).toBe("cell");
    });
  });

  describe("schemaSummary", () => {
    it("summarizes an object by its property names", () => {
      expect(schemaSummary({ properties: { title: {}, done: {} } }))
        .toBe("{ title, done }");
    });

    it("elides the properties past the fourth", () => {
      expect(
        schemaSummary({ properties: { a: {}, b: {}, c: {}, d: {}, e: {} } }),
      )
        .toBe("{ a, b, c, d, … }");
    });

    it("names the type of a schema declaring no properties", () => {
      expect(schemaSummary({ type: "string" })).toBe("string");
    });

    it("summarizes nothing for a schema that is not one", () => {
      expect(schemaSummary("string")).toBeUndefined();
    });
  });

  describe("cellLabelView", () => {
    it("keeps what a call recorded apart from what the space holds", () => {
      const view = cellLabelView({
        confidentiality: ["prompt"],
        labels: {
          confidentiality: ["private"],
          integrity: ["verified"],
          derived: false,
          transformedBy: [],
          entries: [],
        },
      });
      expect(view.onCall).toEqual(["prompt"]);
      expect(view.confidentiality).toEqual(["private"]);
      expect(view.integrity).toEqual(["verified"]);
    });

    it("keeps the integrity a call recorded apart from its confidentiality", () => {
      const view = cellLabelView({
        confidentiality: ["prompt"],
        integrity: ["PromptSlotInfluence"],
      });
      expect(view.onCall).toEqual(["prompt"]);
      expect(view.onCallIntegrity).toEqual(["PromptSlotInfluence"]);
      expect(view.integrity).toEqual([]);
    });

    it("reads a cell the run holds no labels record for as unrecorded", () => {
      expect(cellLabelView({ confidentiality: ["prompt"] }).recorded).toBe(
        false,
      );
    });

    it("reads a cell the space labelled nothing on as recorded", () => {
      const view = cellLabelView({
        labels: {
          confidentiality: [],
          integrity: [],
          derived: false,
          transformedBy: [],
          entries: [],
        },
      });
      expect(view.recorded).toBe(true);
      expect(view.confidentiality).toEqual([]);
    });

    it("reads a cell the whole of which was read as read in full", () => {
      const view = cellLabelView({
        labels: {
          confidentiality: [],
          integrity: [],
          derived: false,
          transformedBy: [],
          entries: [],
        },
      });
      // The card says the space holds no label for such a cell, which is a
      // claim only a reading that covered the whole of it can make.
      expect(view.partial).toBe(false);
      expect(view.unfinished).toBe(false);
      expect(view.unreadPaths).toEqual([]);
    });

    it("reads a cell whose reading ran out as read in part", () => {
      const view = cellLabelView({
        labels: {
          confidentiality: [],
          integrity: [],
          derived: false,
          transformedBy: [],
          entries: [],
          truncationReason: "node-budget-exhausted",
        },
      });
      // An empty entry list under a reading that stopped is not a space with
      // no label for the cell; it is a reading that cannot say either way.
      expect(view.partial).toBe(true);
      expect(view.unfinished).toBe(true);
      // What it missed it never reached, so it names no path.
      expect(view.unreadPaths).toEqual([]);
    });

    it("reads a cell holding a path nothing was read at as read in part", () => {
      const view = cellLabelView({
        labels: {
          confidentiality: [],
          integrity: [],
          derived: false,
          transformedBy: [],
          entries: [],
          unreadPaths: [["notes"]],
        },
      });
      expect(view.partial).toBe(true);
      // A declined path is named, which is more than a reading that ran out
      // can say, so the two reach the card as separate facts.
      expect(view.unreadPaths).toEqual([["notes"]]);
      expect(view.unfinished).toBe(false);
    });

    it("carries the paths and the implementations that produced them", () => {
      const view = cellLabelView({
        labels: {
          confidentiality: ["private"],
          integrity: [],
          derived: true,
          transformedBy: ["summarize in inbox.tsx"],
          entries: [
            {
              path: ["notes", "0"],
              confidentiality: ["private"],
              integrity: [],
              origin: "derived",
              transformedBy: "summarize in inbox.tsx",
            },
          ],
        },
      });
      expect(view.derived).toBe(true);
      expect(view.transformedBy).toEqual(["summarize in inbox.tsx"]);
      expect(view.paths.map((entry) => entry.path)).toEqual([["notes", "0"]]);
    });
  });

  describe("cellChipClasses", () => {
    it("wears no state for a cell no atom rides on", () => {
      expect(cellChipClasses({ token: "cfh:a:1" })).toBe("cell");
    });

    it("wears the labelled state for an atom a call recorded", () => {
      expect(cellChipClasses({ confidentiality: ["prompt"] }))
        .toBe("cell labelled");
    });

    it("wears the labelled state for an integrity atom a call recorded", () => {
      expect(cellChipClasses({ integrity: ["PromptSlotInfluence"] }))
        .toBe("cell labelled");
    });

    it("wears the labelled state for an atom only the space holds", () => {
      expect(cellChipClasses({
        labels: {
          confidentiality: ["private"],
          integrity: [],
          derived: false,
          transformedBy: [],
          entries: [],
        },
      })).toBe("cell labelled");
    });

    it("wears the derived state for a value computed from a read", () => {
      expect(cellChipClasses({
        labels: {
          confidentiality: ["private"],
          integrity: [],
          derived: true,
          transformedBy: [],
          entries: [],
        },
      })).toBe("cell labelled derived");
    });

    it("marks a carried atom apart from a derived one", () => {
      const carried = cellChipClasses({
        labels: {
          confidentiality: ["private"],
          integrity: [],
          derived: false,
          transformedBy: [],
          entries: [],
        },
      });
      const derived = cellChipClasses({
        labels: {
          confidentiality: ["private"],
          integrity: [],
          derived: true,
          transformedBy: [],
          entries: [],
        },
      });
      expect(carried).not.toBe(derived);
    });
  });

  describe("spaceHoldsNoLabel()", () => {
    const view = (over: Partial<ConsoleCellLabelView> = {}) =>
      ({
        onCall: [],
        confidentiality: [],
        integrity: [],
        derived: false,
        transformedBy: [],
        paths: [],
        unreadPaths: [],
        unfinished: false,
        partial: false,
        recorded: true,
        ...over,
      }) as ConsoleCellLabelView;

    //
    // The positive half
    //

    it("lets a reading that covered the whole of a bare cell say so", () => {
      expect(spaceHoldsNoLabel(view())).toBe(true);
    });

    //
    // The negative half
    //
    // Stated state by state. The claim is a conjunction, so an edit that drops
    // one of its terms widens it without failing anything that only checks the
    // positive case.
    //

    it("refuses a cell no reading recorded", () => {
      expect(spaceHoldsNoLabel(view({ recorded: false }))).toBe(false);
    });

    it("refuses a cell whose reading stopped at a path", () => {
      expect(
        spaceHoldsNoLabel(
          view({ partial: true, unreadPaths: [["inner"]] }),
        ),
      ).toBe(false);
    });

    it("refuses a cell whose reading ran out", () => {
      expect(spaceHoldsNoLabel(view({ partial: true, unfinished: true })))
        .toBe(false);
    });

    it("refuses a cell the space labelled", () => {
      expect(spaceHoldsNoLabel(view({ confidentiality: ["secret"] })))
        .toBe(false);
      expect(spaceHoldsNoLabel(view({ integrity: ["signed"] }))).toBe(false);
    });
  });
});
