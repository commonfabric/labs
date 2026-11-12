// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFGrid } from "./index.ts";

/** The grid container a mounted `cf-grid` with `properties` renders. */
async function gridOf(properties: Partial<CFGrid> = {}): Promise<Element> {
  const element = await mount(Object.assign(new CFGrid(), properties));
  return element.shadowRoot!.querySelector("[part=grid]")!;
}

/** The class names of a rendered grid container, sorted. */
function classesOf(grid: Element): string[] {
  return [...grid.classList].sort();
}

describe("CFGrid", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-grid")).toBe(CFGrid);
  });

  describe("instance members", () => {
    describe("render()", () => {
      it("renders one column with the default classes", async () => {
        const grid = await gridOf();

        expect(classesOf(grid)).toEqual([
          "align-stretch",
          "flow-row",
          "gap-0",
          "grid",
          "justify-stretch",
          "p-0",
        ]);
        expect(grid.getAttribute("style")).toBe(
          "grid-template-columns: repeat(1, minmax(0, 1fr))",
        );
        expect(grid.querySelector("slot")).not.toBeNull();
      });

      it("renders padding, flow, and gap from their properties", async () => {
        const grid = await gridOf({ padding: "4", flow: "dense", gap: "2" });

        expect(classesOf(grid)).toEqual(expect.arrayContaining([
          "p-4",
          "flow-dense",
          "gap-2",
        ]));
        expect(classesOf(grid)).not.toContain("p-0");
        expect(classesOf(grid)).not.toContain("gap-0");
      });

      it("renders place in place of align and justify", async () => {
        const grid = await gridOf({ place: "center" });

        expect(classesOf(grid)).toContain("place-center");
        expect(classesOf(grid).filter((name) => /^(align|justify)-/.test(name)))
          .toEqual([]);
      });

      it("renders only the align and justify classes that are set", async () => {
        const justified = classesOf(
          await gridOf({ align: "", justify: "end" }),
        );
        expect(justified.filter((name) => /^(align|justify)-/.test(name)))
          .toEqual(["justify-end"]);

        const aligned = classesOf(await gridOf({ align: "end", justify: "" }));
        expect(aligned.filter((name) => /^(align|justify)-/.test(name)))
          .toEqual(["align-end"]);
      });

      it("renders row and column gaps in place of gap", async () => {
        const both = await gridOf({ gap: "2", rowGap: "4", columnGap: "6" });
        expect(classesOf(both)).toEqual(
          expect.arrayContaining(["row-gap-4", "col-gap-6"]),
        );
        expect(classesOf(both)).not.toContain("gap-2");

        const rowOnly = await gridOf({ gap: "2", rowGap: "4" });
        expect(classesOf(rowOnly)).toContain("row-gap-4");
        expect(classesOf(rowOnly).filter((name) => /gap/.test(name)))
          .toEqual(["row-gap-4"]);

        const columnOnly = await gridOf({ gap: "2", columnGap: "6" });
        expect(classesOf(columnOnly).filter((name) => /gap/.test(name)))
          .toEqual(["col-gap-6"]);
      });

      it("renders a count from 1 to 12 as equal columns", async () => {
        expect((await gridOf({ columns: "12" })).getAttribute("style")).toBe(
          "grid-template-columns: repeat(12, minmax(0, 1fr))",
        );
      });

      it("renders any other columns value as a template", async () => {
        for (const columns of ["0", "13", "200px 1fr"]) {
          expect((await gridOf({ columns })).getAttribute("style")).toBe(
            `grid-template-columns: ${columns}`,
          );
        }
      });

      it("renders a positive row count as equal rows", async () => {
        expect((await gridOf({ rows: "3" })).getAttribute("style")).toBe(
          "grid-template-columns: repeat(1, minmax(0, 1fr)); " +
            "grid-template-rows: repeat(3, minmax(0, 1fr))",
        );
      });

      it("renders any other rows value as a template", async () => {
        for (const rows of ["0", "auto 1fr"]) {
          expect((await gridOf({ rows })).getAttribute("style")).toBe(
            "grid-template-columns: repeat(1, minmax(0, 1fr)); " +
              `grid-template-rows: ${rows}`,
          );
        }
      });
    });
  });
});
