// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFTable } from "./index.ts";

/**
 * A `display: contents` span holding `children`, as the renderer wraps the
 * elements of a list it renders.
 */
function listWrapper(...children: Element[]): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("style", "display:contents");
  span.append(...children);
  return span;
}

/**
 * A table with a head of one header cell and a body of one-cell rows, built as
 * the renderer builds one whose pattern writes the header cell in place and
 * maps its rows, and the cells of each row, from lists: element by element,
 * each list wrapped in a span.
 */
function tableWithRows(...names: string[]): CFTable {
  const element = new CFTable();
  const head = document.createElement("thead");
  const headerRow = head.appendChild(document.createElement("tr"));
  headerRow.appendChild(document.createElement("th")).textContent = "Name";
  const body = document.createElement("tbody");
  body.append(listWrapper(...names.map((name) => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.textContent = name;
    row.append(listWrapper(cell));
    return row;
  })));
  element.append(head, body);
  return element;
}

const bodyRows = (
  element: CFTable,
) => [...element.querySelectorAll("tbody tr")];

const header = (element: CFTable) => element.querySelector("th")!;

/** The style rules of the sheets adopted by `root`, within any `@scope`. */
function rowRules(root: DocumentOrShadowRoot): CSSStyleRule[] {
  const styleRules = (list: CSSRuleList): CSSStyleRule[] =>
    [...list].flatMap((rule) =>
      rule instanceof CSSStyleRule
        ? [rule]
        : rule instanceof CSSGroupingRule
        ? styleRules(rule.cssRules)
        : []
    );
  return root.adoptedStyleSheets.flatMap((sheet) => styleRules(sheet.cssRules));
}

describe("CFTable", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.adoptedStyleSheets = [];
  });

  it("is registered as `cf-table`", () => {
    expect(customElements.get("cf-table")).toBe(CFTable);
  });

  describe("constructor()", () => {
    it("makes a medium table with no variants", () => {
      const element = new CFTable();
      expect({
        striped: element.striped,
        hover: element.hover,
        bordered: element.bordered,
        size: element.size,
        stickyHeader: element.stickyHeader,
        fullWidth: element.fullWidth,
      }).toEqual({
        striped: false,
        hover: false,
        bordered: false,
        size: "md",
        stickyHeader: false,
        fullWidth: false,
      });
    });
  });

  describe("attributes", () => {
    it("sets each variant from its attribute", async () => {
      const element = new CFTable();
      for (
        const name of ["striped", "hover", "bordered", "sticky-header"]
      ) {
        element.setAttribute(name, "");
      }
      element.setAttribute("full-width", "");
      element.setAttribute("size", "lg");
      await mount(element);
      expect({
        striped: element.striped,
        hover: element.hover,
        bordered: element.bordered,
        size: element.size,
        stickyHeader: element.stickyHeader,
        fullWidth: element.fullWidth,
      }).toEqual({
        striped: true,
        hover: true,
        bordered: true,
        size: "lg",
        stickyHeader: true,
        fullWidth: true,
      });
    });

    it("turns a variant off when its attribute is removed", async () => {
      const element = new CFTable();
      element.setAttribute("striped", "");
      await mount(element);
      element.removeAttribute("striped");
      expect(element.striped).toBe(false);
    });

    it("reflects each variant set as a property to its attribute", async () => {
      const element = Object.assign(new CFTable(), {
        striped: true,
        hover: true,
        bordered: true,
        size: "sm",
        stickyHeader: true,
        fullWidth: true,
      });
      await mount(element);
      expect(element.getAttributeNames().sort()).toEqual([
        "bordered",
        "full-width",
        "hover",
        "size",
        "sticky-header",
        "striped",
      ]);
      expect(element.getAttribute("size")).toBe("sm");
    });

    it("leaves off the attribute of a variant that is off", async () => {
      const element = await mount(new CFTable());
      expect(element.getAttributeNames()).toEqual(["size"]);
    });
  });

  describe("render()", () => {
    it("renders the slot for its content inside the `table` part", async () => {
      const element = await mount(tableWithRows("Ada", "Grace"));
      const table = element.shadowRoot!.querySelector("[part=table]")!;
      const slot = element.shadowRoot!.querySelector("slot")!;
      expect(slot.parentElement).toBe(table);
      expect(table.parentElement!.getAttribute("part")).toBe("wrapper");
      expect(slot.assignedElements().map((child) => child.localName)).toEqual(
        ["thead", "tbody"],
      );
    });

    it("keeps the rows in the light DOM, in order", async () => {
      const element = await mount(tableWithRows("Ada", "Grace"));
      expect(bodyRows(element).map((row) => row.textContent)).toEqual([
        "Ada",
        "Grace",
      ]);
      expect(element.shadowRoot!.querySelector("td")).toBeNull();
    });
  });

  describe("connectedCallback()", () => {
    it("adds the row styles to the document once", async () => {
      const first = await mount(tableWithRows("Ada"));
      const second = await mount(tableWithRows("Grace"));
      for (const element of [first, second]) {
        expect(getComputedStyle(element.querySelector("td")!).padding).toBe(
          "8px 12px",
        );
      }
      expect(document.adoptedStyleSheets.length).toBe(1);
    });

    it("adds the row styles to the shadow root it is connected in", async () => {
      const host = document.body.appendChild(document.createElement("div"));
      const shadow = host.attachShadow({ mode: "open" });
      const element = tableWithRows("Ada");
      shadow.append(element);
      await element.updateComplete;
      expect(getComputedStyle(element.querySelector("td")!).padding).toBe(
        "8px 12px",
      );
      expect(document.adoptedStyleSheets).toEqual([]);
    });
  });

  describe("row styles", () => {
    it("pads every cell and keeps it on one line", async () => {
      const element = await mount(tableWithRows("Ada"));
      for (const cell of element.querySelectorAll("th, td")) {
        const style = getComputedStyle(cell);
        expect(style.padding).toBe("8px 12px");
        expect(style.whiteSpace).toBe("nowrap");
      }
    });

    it("pads cells by the `size` of the table", async () => {
      const element = await mount(
        Object.assign(tableWithRows("Ada"), { size: "sm" }),
      );
      expect(getComputedStyle(element.querySelector("td")!).padding).toBe(
        "4px 8px",
      );
    });

    it("lets a cell with class `wrap` wrap", async () => {
      const element = await mount(tableWithRows("Ada"));
      const cell = element.querySelector("td")!;
      cell.classList.add("wrap");
      expect(getComputedStyle(cell).whiteSpace).toBe("normal");
    });

    it("aligns and wraps a cell by its classes", async () => {
      const element = await mount(tableWithRows("Ada"));
      const cell = element.querySelector("td")!;
      cell.classList.add("text-right", "align-top");
      const style = getComputedStyle(cell);
      expect({ align: style.textAlign, vertical: style.verticalAlign })
        .toEqual({ align: "right", vertical: "top" });
    });

    it("leaves alone an element with those classes inside a cell", async () => {
      const element = await mount(tableWithRows("Ada"));
      const inner = document.createElement("div");
      inner.className = "wrap text-right align-bottom";
      element.querySelector("td")!.append(inner);
      const style = getComputedStyle(inner);
      // It inherits the cell's `nowrap`; happy-dom reads as "" a property
      // that no rule sets.
      expect({
        wrap: style.whiteSpace,
        align: style.textAlign,
        vertical: style.verticalAlign,
      }).toEqual({ wrap: "nowrap", align: "", vertical: "" });
    });

    it("leaves alone the rows and cells of a table inside a cell", async () => {
      const element = await mount(
        Object.assign(tableWithRows("Ada", "Grace"), { striped: true }),
      );
      const inner = document.createElement("table");
      inner.innerHTML = "<tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody>";
      element.querySelector("td")!.append(inner);
      const [, even] = inner.querySelectorAll("tr");
      expect(getComputedStyle(even).backgroundColor).toBe("");
      expect(getComputedStyle(even.querySelector("td")!).padding).toBe("");
    });

    it("shades every even body row of a `striped` table", async () => {
      const element = await mount(
        Object.assign(tableWithRows("Ada", "Grace", "Hedy", "Joan"), {
          striped: true,
        }),
      );
      expect(
        bodyRows(element).map((row) => getComputedStyle(row).backgroundColor),
      ).toEqual(["", "#f8fafc", "", "#f8fafc"]);
    });

    it("shades no body row of a table that is not `striped`", async () => {
      const element = await mount(tableWithRows("Ada", "Grace"));
      expect(
        bodyRows(element).map((row) => getComputedStyle(row).backgroundColor),
      ).toEqual(["", ""]);
    });

    it("shades a hovered body row, and only of a `hover` table", async () => {
      const element = await mount(tableWithRows("Ada", "Grace"));
      const [rule] = rowRules(document).filter((rule) =>
        rule.selectorText.endsWith(":hover")
      );
      // happy-dom tracks no pointer, so the row stands in as hovered, and the
      // table stands in as the root of the rule's scope.
      const hovered = rule.selectorText.replace(/:hover$/, "").replace(
        ":scope",
        "cf-table",
      );
      expect(rule.style.backgroundColor).toBe("var(--muted, #f1f5f9)");
      expect(bodyRows(element).some((row) => row.matches(hovered))).toBe(
        false,
      );
      element.hover = true;
      await element.updateComplete;
      expect(bodyRows(element).every((row) => row.matches(hovered))).toBe(
        true,
      );
      expect(element.querySelector("thead tr")!.matches(hovered)).toBe(false);
    });

    it("sticks the header cells of a `sticky-header` table", async () => {
      const element = await mount(
        Object.assign(tableWithRows("Ada"), { stickyHeader: true }),
      );
      const style = getComputedStyle(header(element));
      expect({ position: style.position, top: style.top }).toEqual({
        position: "sticky",
        top: "0px",
      });
      expect(
        getComputedStyle(element.querySelector("td")!).position,
      ).not.toBe("sticky");
    });

    it("leaves the header cells of other tables in the flow", async () => {
      const element = await mount(tableWithRows("Ada"));
      expect(getComputedStyle(header(element)).position).not.toBe("sticky");
    });

    it("borders every cell of a `bordered` table", async () => {
      const element = await mount(
        Object.assign(tableWithRows("Ada"), { bordered: true }),
      );
      expect(getComputedStyle(header(element)).borderTopStyle).toBe("solid");
      expect(
        getComputedStyle(element.querySelector("td")!).borderTopStyle,
      ).toBe("solid");
    });
  });
});
