// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFTab } from "../cf-tab/index.ts";
import { CFTabList } from "./index.ts";

/** A list mounted with `properties`, holding two tabs and a divider. */
async function listWith(properties: Partial<CFTabList> = {}) {
  const list = Object.assign(new CFTabList(), properties);
  list.append(new CFTab(), document.createElement("hr"), new CFTab());
  return await mount(list);
}

/** The `data-variant` of each child of `list`. */
const childVariants = (list: CFTabList) =>
  Array.from(list.children, (child) => child.getAttribute("data-variant"));

const inner = (list: CFTabList) =>
  list.shadowRoot!.querySelector("[part=list]")!;

describe("CFTabList", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tab-list`", () => {
    expect(customElements.get("cf-tab-list")).toBe(CFTabList);
  });

  it("starts horizontal, with underlined tabs", () => {
    const list = new CFTabList();
    expect(list.orientation).toBe("horizontal");
    expect(list.variant).toBe("underline");
  });

  it("start-aligns horizontal tabs so that overflowing ones stay reachable", () => {
    const styles = CFTabList.elementStyles.map((style) => String(style))
      .join();
    expect(styles).toContain('.tab-list[data-orientation="horizontal"]');
    expect(styles).toContain("justify-content: flex-start");
  });

  describe("orientation", () => {
    it("exposes itself as a tab list oriented as it is", async () => {
      const list = await listWith();
      expect(list.getAttribute("role")).toBe("tablist");
      expect(list.getAttribute("aria-orientation")).toBe("horizontal");
      expect(list.getAttribute("orientation")).toBe("horizontal");
      expect(inner(list).getAttribute("data-orientation")).toBe("horizontal");
    });

    it("reflects a new orientation onto the host for its tabs' styles", async () => {
      const list = await listWith();
      list.orientation = "vertical";
      await list.updateComplete;
      expect(list.getAttribute("orientation")).toBe("vertical");
      expect(list.getAttribute("aria-orientation")).toBe("vertical");
      expect(inner(list).getAttribute("data-orientation")).toBe("vertical");
    });
  });

  describe("variant", () => {
    it("leaves underlined tabs unmarked", async () => {
      const list = await listWith();
      expect(childVariants(list)).toEqual([null, null, null]);
      expect(inner(list).getAttribute("data-variant")).toBe("underline");
    });

    it("marks each tab, and only tabs, with the chip variant, and unmarks them", async () => {
      const list = await listWith({ variant: "chip" });
      expect(childVariants(list)).toEqual(["chip", null, "chip"]);

      list.variant = "underline";
      await list.updateComplete;
      expect(childVariants(list)).toEqual([null, null, null]);
    });

    it("marks a tab added later", async () => {
      const list = await listWith({ variant: "chip" });
      list.append(new CFTab());
      await settle();
      expect(childVariants(list)).toEqual(["chip", null, "chip", "chip"]);
    });
  });

  it("falls back to the defaults for an unknown orientation and variant", async () => {
    const list = await listWith({
      // @ts-expect-error: a page can set any string as the attribute.
      orientation: "diagonal",
      // @ts-expect-error: as above.
      variant: "pills",
    });
    expect(list.orientation).toBe("horizontal");
    expect(list.variant).toBe("underline");
  });
});
