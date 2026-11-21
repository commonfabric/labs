import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { nothing } from "lit";
import type { ConsoleCellLabels } from "../../../console/cell-labels.ts";
import {
  cellChipClasses,
  cellLabelView,
  cellName,
  ConsoleCell,
  type ConsoleCellFacts,
  type ConsoleCellLabelView,
  schemaSummary,
  spaceHoldsNoLabel,
} from "../../../console/src/cell-chip.ts";
import { handlerOn, templateBindings, templateText } from "./lit-template.ts";

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

  describe("ConsoleCell", () => {
    class TestCell extends ConsoleCell {
      view(): unknown {
        return this.render();
      }

      /**
       * A connected chip schedules updates, and committing one needs a DOM to
       * write into. These tests render by calling `view()` themselves.
       */
      protected override performUpdate(): void {}
    }

    /** The space's labels for a cell read whole that carries none. */
    const bareLabels = (
      over: Partial<ConsoleCellLabels> = {},
    ): ConsoleCellLabels => ({
      confidentiality: [],
      integrity: [],
      derived: false,
      transformedBy: [],
      entries: [],
      ...over,
    });

    const cardText = (cell: ConsoleCellFacts): string => {
      const view = new TestCell();
      view.cell = cell;
      return templateText(view.view()).replace(/\s+/g, " ");
    };

    it("renders into the element itself, where the page's stylesheet reaches", () => {
      const view = new TestCell();

      view.connectedCallback();
      view.disconnectedCallback();

      expect(view.renderRoot).toBe(view);
    });

    it("renders nothing for a chip with no cell", () => {
      expect(new TestCell().view()).toBe(nothing);
    });

    it("renders the name, handle, address, shape, and producing step on the card", () => {
      const text = cardText({
        slug: "orders",
        token: "cfh:a:1",
        ref: "of:orders",
        schema: { type: "array" },
        producedByStep: 3,
      });

      expect(text).toContain('<span class="cell-name">orders</span>');
      expect(text).toContain("name</span> <span>orders</span>");
      expect(text).toContain('handle</span> <span class="cell-mono">cfh:a:1');
      expect(text).toContain("address</span>");
      expect(text).toContain("of:orders");
      expect(text).toContain('shape</span> <span class="cell-mono">array');
      expect(text).toContain("<span>step 3</span>");
    });

    it("leaves out the card rows for facts the cell does not carry", () => {
      const text = cardText({});

      expect(text).toContain('<span class="cell-name">cell</span>');
      for (const row of ["name", "handle", "address", "shape", "from"]) {
        expect(text).not.toContain(`<span class="cell-label">${row}</span>`);
      }
    });

    it("counts the atoms the call recorded on the chip itself", () => {
      expect(cardText({ confidentiality: ["a"], integrity: ["b"] }))
        .toContain('<span class="cell-atoms">2</span>');
      expect(cardText({})).not.toContain("cell-atoms");
    });

    it("names its own card as the chip's description, apart from another chip's", () => {
      const ids = [new TestCell(), new TestCell()].map((view) => {
        view.cell = {};
        const bindings = templateBindings(view.view());
        const described = bindings.find((binding) =>
          binding.name === "aria-describedby"
        )?.value;
        const card = bindings.find((binding) => binding.name === "id")?.value;
        expect(typeof described).toBe("string");
        expect(card).toBe(described);
        return card;
      });

      expect(ids[0]).not.toBe(ids[1]);
    });

    describe("labels", () => {
      it("renders the atoms a call recorded on their two axes", () => {
        const text = cardText({
          confidentiality: ["secret"],
          integrity: ["slot"],
        });

        expect(text).toContain('<span class="atom conf">secret</span>');
        expect(text).toContain('<span class="atom integ">slot</span>');
        expect(text).not.toContain("no atom on this call");
      });

      it("says no atom rode on a call that recorded none", () => {
        expect(cardText({})).toContain("no atom on this call");
      });

      it("says no label was read for a cell the run's labels never name", () => {
        const text = cardText({});

        expect(text).toContain(
          "no label read for this cell; the map heads with what this run read",
        );
        expect(text).not.toContain("the space holds no label");
      });

      it("says the space holds no label for a bare cell read whole", () => {
        const text = cardText({ labels: bareLabels() });

        expect(text).toContain("the space holds no label for this cell");
        expect(text).not.toContain("no label read for this cell");
        expect(text).not.toContain('<span class="cell-label">reading</span>');
      });

      it("says only that no label was read for a bare cell read in part", () => {
        const text = cardText({
          labels: bareLabels({ truncationReason: "node-budget-exhausted" }),
        });

        expect(text).toContain("no label read for this cell</span>");
        expect(text).not.toContain("the map heads");
        expect(text).not.toContain("the space holds no label");
        expect(text).toContain("did not finish");
      });

      it("renders the atoms the space holds on their two axes", () => {
        const text = cardText({
          labels: bareLabels({
            confidentiality: ["private"],
            integrity: ["signed"],
          }),
        });

        expect(text).toContain('<span class="atom conf">private</span>');
        expect(text).toContain('<span class="atom integ">signed</span>');
        expect(text).not.toContain("no label read");
      });

      it("names the paths a reading declined, the cell itself included", () => {
        const text = cardText({
          labels: bareLabels({ unreadPaths: [["notes", "0"], []] }),
        });

        expect(text).toContain("read but for notes/0, (the cell) —");
        expect(text).not.toContain("did not finish");
      });

      it("says whether the labelled paths were computed or carried", () => {
        const entry = {
          path: ["title"],
          confidentiality: ["private"],
          integrity: [],
        };
        const computed = cardText({
          labels: bareLabels({ derived: true, entries: [entry] }),
        });
        const carried = cardText({ labels: bareLabels({ entries: [entry] }) });

        expect(computed).toContain("computed from what a function read");
        expect(computed).not.toContain("carried, not computed");
        expect(carried).toContain("carried, not computed from a read");
        expect(cardText({ labels: bareLabels() })).not.toContain(
          '<span class="cell-label">derived</span>',
        );
      });

      it("renders each labelled path with its origin and atoms, and what transformed it", () => {
        const text = cardText({
          labels: bareLabels({
            derived: true,
            transformedBy: ["summarize in inbox.tsx", "rank"],
            entries: [{
              path: ["notes"],
              confidentiality: ["private"],
              integrity: ["signed"],
              origin: "derived",
            }, { path: [], confidentiality: [], integrity: [] }],
          }),
        });

        expect(text).toContain("summarize in inbox.tsx, rank");
        expect(text).toContain(
          '<span class="label-path">notes</span> <span class="path-origin">derived</span>',
        );
        expect(text).toContain('<span class="label-path">(the cell)</span>');
        expect(text.match(/path-origin/g)).toHaveLength(1);
        expect(cardText({ labels: bareLabels() })).not.toContain(
          "transformed by",
        );
      });
    });

    describe("card placement", () => {
      // The card is placed against the chip's box in the window, so each case
      // stands up the window's size, the chip's box and the card's, and reads
      // where the chip put its card off the card's style.

      const views: TestCell[] = [];

      afterEach(() => {
        for (const view of views.splice(0)) view.disconnectedCallback();
        for (const name of ["innerWidth", "innerHeight", "getComputedStyle"]) {
          Reflect.deleteProperty(globalThis, name);
        }
      });

      interface Box {
        left: number;
        top: number;
        bottom: number;
      }

      const windowOf = (width: number, height: number, minWidth = "0px") => {
        for (
          const [name, value] of Object.entries({
            innerWidth: width,
            innerHeight: height,
            getComputedStyle: () => ({ minWidth }),
          })
        ) {
          Object.defineProperty(globalThis, name, {
            value,
            configurable: true,
          });
        }
      };

      /** A chip at `chip` whose card measures `width` by `height`. */
      const chipAt = (chip: Box, width = 200, height = 100) => {
        const view = new TestCell();
        views.push(view);
        view.cell = { token: "cfh:a:1" };
        const at = { ...chip };
        const style: Record<string, string> = {};
        const elements: Record<string, unknown> = {
          ".cell": { getBoundingClientRect: () => at },
          ".cell-card": {
            style,
            getBoundingClientRect: () => ({ width, height }),
          },
        };
        Object.defineProperty(view, "querySelector", {
          value: (selector: string) => elements[selector] ?? null,
        });
        const on = (name: string) => handlerOn(view.view(), name)();
        return { view, at, style, elements, on };
      };

      it("places the card just below the chip when the pointer enters it", () => {
        windowOf(1000, 800);
        const { style, on } = chipAt({ left: 100, top: 50, bottom: 70 });

        on("@mouseenter");

        expect(style.left).toBe("100px");
        expect(style.top).toBe("76px");
        expect(style.maxWidth).toBe("984px");
        expect(style.minWidth).toBe("");
      });

      it("places the card above a chip too near the window's bottom to fit it below", () => {
        windowOf(1000, 800);
        const { style, on } = chipAt({ left: 100, top: 760, bottom: 780 });

        on("@focusin");

        expect(style.top).toBe("654px");
      });

      it("pulls the card back inside the window's right edge", () => {
        windowOf(1000, 800);
        const { style, on } = chipAt({ left: 900, top: 50, bottom: 70 });

        on("@mouseenter");

        expect(style.left).toBe("792px");
      });

      it("lowers the card's minimum width to a window narrower than it", () => {
        windowOf(300, 800, "320px");
        const { style, on } = chipAt({ left: 10, top: 50, bottom: 70 });

        on("@mouseenter");

        expect(style.maxWidth).toBe("284px");
        expect(style.minWidth).toBe("284px");
      });

      it("places the card again as a column scrolls under it, until the pointer leaves", () => {
        windowOf(1000, 800);
        const { at, style, on } = chipAt({ left: 100, top: 50, bottom: 70 });
        on("@mouseenter");

        at.bottom = 170;
        globalThis.dispatchEvent(new Event("scroll"));
        expect(style.top).toBe("176px");

        on("@mouseleave");
        at.bottom = 270;
        globalThis.dispatchEvent(new Event("scroll"));
        expect(style.top).toBe("176px");
      });

      it("places the card again when the window is resized", () => {
        windowOf(1000, 800);
        const { at, style, on } = chipAt({ left: 100, top: 50, bottom: 70 });
        on("@mouseenter");

        at.left = 300;
        globalThis.dispatchEvent(new Event("resize"));

        expect(style.left).toBe("300px");
      });

      it("keeps following the chip while focus holds the card up after the pointer leaves", () => {
        windowOf(1000, 800);
        const { at, style, on } = chipAt({ left: 100, top: 50, bottom: 70 });
        on("@mouseenter");
        on("@focusin");
        on("@mouseleave");

        at.bottom = 170;
        globalThis.dispatchEvent(new Event("scroll"));
        expect(style.top).toBe("176px");

        on("@focusout");
        at.bottom = 270;
        globalThis.dispatchEvent(new Event("scroll"));
        expect(style.top).toBe("176px");
      });

      it("stops following the chip once it leaves the page", () => {
        windowOf(1000, 800);
        const { view, at, style, on } = chipAt({
          left: 100,
          top: 50,
          bottom: 70,
        });
        on("@mouseenter");
        on("@focusin");

        view.disconnectedCallback();
        at.bottom = 170;
        globalThis.dispatchEvent(new Event("scroll"));

        expect(style.top).toBe("76px");
      });

      it("leaves the card's style alone while no chip is rendered to place it against", () => {
        windowOf(1000, 800);
        const { style, elements, on } = chipAt({
          left: 100,
          top: 50,
          bottom: 70,
        });
        on("@mouseenter");
        delete elements[".cell"];
        for (const name of Object.keys(style)) delete style[name];

        globalThis.dispatchEvent(new Event("scroll"));

        expect(style).toEqual({});
      });
    });
  });
});
