// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFAccordionItem } from "../cf-accordion-item/index.ts";
import { CFAccordion } from "./index.ts";

/**
 * An accordion holding one item per entry of `values`, with `attributes` set,
 * mounted in the document. A value written `!b` names a disabled item.
 */
async function accordion(
  values: readonly string[],
  attributes: Record<string, string> = {},
): Promise<{ accordion: CFAccordion; items: CFAccordionItem[] }> {
  const element = new CFAccordion();
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  const items = values.map((spec) => {
    const item = new CFAccordionItem();
    item.setAttribute("value", spec.replace(/^!/, ""));
    if (spec.startsWith("!")) item.setAttribute("disabled", "");
    return item;
  });
  element.append(...items);
  await mount(element);
  await settled(element, items);
  return { accordion: element, items };
}

/** Resolves once `accordion` and `items` have no update pending. */
async function settled(
  accordion: CFAccordion,
  items: readonly CFAccordionItem[],
): Promise<void> {
  await accordion.updateComplete;
  for (const item of items) await item.updateComplete;
}

/** The values of the items in `items` that are expanded. */
function expanded(items: readonly CFAccordionItem[]): string[] {
  return items.filter((item) => item.expanded).map((item) => item.value);
}

/** Clicks the trigger of `item`, as a user would. */
function click(item: CFAccordionItem): void {
  const trigger = item.shadowRoot!.querySelector("button.trigger");
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error("cf-accordion-item rendered no trigger");
  }
  trigger.click();
}

/** The details of the cf-change events `element` emits while `act()` runs. */
function changes(element: CFAccordion, act: () => void): unknown[] {
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  element.addEventListener("cf-change", listener);
  try {
    act();
  } finally {
    element.removeEventListener("cf-change", listener);
  }
  return seen;
}

describe("CFAccordion", () => {
  afterEach(() => document.body.replaceChildren());

  describe("value", () => {
    it("expands the item its value attribute names", async () => {
      const { items } = await accordion(["a", "b"], { value: "b" });
      expect(expanded(items)).toEqual(["b"]);
    });

    it("expands the items a JSON list in its value attribute names", async () => {
      const { accordion: element, items } = await accordion(["a", "b", "c"], {
        type: "multiple",
        value: '["a","c"]',
      });
      expect(element.value).toEqual(["a", "c"]);
      expect(expanded(items)).toEqual(["a", "c"]);
    });

    it("expands an item whose value reads as a JSON number", async () => {
      const { accordion: element, items } = await accordion(["1", "2"], {
        value: "2",
      });
      expect(element.value).toBe("2");
      expect(expanded(items)).toEqual(["2"]);
    });

    it("follows changes to its value attribute, and collapses every item when it is removed", async () => {
      const { accordion: element, items } = await accordion(["a", "b", "c"], {
        type: "multiple",
        value: "a",
      });
      element.setAttribute("value", '["b","c"]');
      await settled(element, items);
      expect(expanded(items)).toEqual(["b", "c"]);

      element.removeAttribute("value");
      await settled(element, items);
      expect(element.value).toEqual([]);
      expect(expanded(items)).toEqual([]);
    });

    it("keeps only the first value of a list when it opens a single item", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        value: '["b","a"]',
      });
      expect(element.value).toBe("b");
      expect(expanded(items)).toEqual(["b"]);
    });

    it("expands no item for an empty list when it opens a single item", async () => {
      const { accordion: element, items } = await accordion(["a", "b"]);
      expect(element.value).toBe("");
      expect(expanded(items)).toEqual([]);
    });

    it("collapses an item its new value no longer names", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        value: "a",
      });
      element.value = "b";
      await settled(element, items);
      expect(expanded(items)).toEqual(["b"]);
    });

    it("leaves an item without a value as it is", async () => {
      const { accordion: element, items } = await accordion(["a"]);
      const loose = new CFAccordionItem();
      loose.expanded = true;
      element.append(loose);
      element.value = "a";
      await settled(element, [...items, loose]);
      expect(expanded(items)).toEqual(["a"]);
      expect(loose.expanded).toBe(true);
    });
  });

  describe("single", () => {
    it("expands a clicked item, collapses the one open before, and emits cf-change", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        value: "a",
      });
      expect(changes(element, () => click(items[1]))).toEqual([
        { value: "b", type: "single" },
      ]);
      await settled(element, items);
      expect(expanded(items)).toEqual(["b"]);
    });

    it("keeps its open item open when that item is clicked", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        value: "a",
      });
      expect(changes(element, () => click(items[0]))).toEqual([
        { value: "a", type: "single" },
      ]);
      await settled(element, items);
      expect(expanded(items)).toEqual(["a"]);
    });

    it("collapses its open item when that item is clicked, if collapsible", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        value: "a",
        collapsible: "",
      });
      expect(changes(element, () => click(items[0]))).toEqual([
        { value: "", type: "single" },
      ]);
      await settled(element, items);
      expect(expanded(items)).toEqual([]);
    });

    it("emits nothing when a disabled item is clicked", async () => {
      const { accordion: element, items } = await accordion(["a", "!b"], {
        value: "a",
      });
      expect(changes(element, () => click(items[1]))).toEqual([]);
      expect(element.value).toBe("a");
    });
  });

  describe("multiple", () => {
    it("adds a clicked item to the open ones", async () => {
      const { accordion: element, items } = await accordion(["a", "b", "c"], {
        type: "multiple",
        value: '["a"]',
      });
      expect(changes(element, () => click(items[2]))).toEqual([
        { value: ["a", "c"], type: "multiple" },
      ]);
      await settled(element, items);
      expect(expanded(items)).toEqual(["a", "c"]);
    });

    it("removes a clicked open item from the open ones", async () => {
      const { accordion: element, items } = await accordion(["a", "b", "c"], {
        type: "multiple",
        value: '["a","c"]',
      });
      expect(changes(element, () => click(items[0]))).toEqual([
        { value: ["c"], type: "multiple" },
      ]);
      await settled(element, items);
      expect(expanded(items)).toEqual(["c"]);
    });

    it("adds a clicked item to a single open value", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        type: "multiple",
        value: "a",
      });
      expect(changes(element, () => click(items[1]))).toEqual([
        { value: ["a", "b"], type: "multiple" },
      ]);
    });

    it("opens only the clicked item when none is open", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        type: "multiple",
      });
      element.value = "";
      await settled(element, items);
      expect(changes(element, () => click(items[1]))).toEqual([
        { value: ["b"], type: "multiple" },
      ]);
    });
  });

  it("stops the toggles of its items from reaching its ancestors", async () => {
    const { items } = await accordion(["a"]);
    let escaped = 0;
    document.body.addEventListener("cf-accordion-toggle", () => escaped++);
    click(items[0]);
    expect(escaped).toBe(0);
  });

  it("stops handling its items' toggles once it leaves the document", async () => {
    const { accordion: element, items } = await accordion(["a", "b"]);
    element.remove();
    expect(changes(element, () => click(items[1]))).toEqual([]);
    expect(element.value).toBe("");
  });

  describe("items", () => {
    it("returns its items", async () => {
      const { accordion: element, items } = await accordion(["a", "b"]);
      expect([...element.items]).toEqual(items);
    });
  });

  describe("expandAll()", () => {
    it("expands every enabled item of a multiple accordion", async () => {
      const { accordion: element, items } = await accordion(["a", "!b", "c"], {
        type: "multiple",
      });
      element.expandAll();
      await settled(element, items);
      expect(element.value).toEqual(["a", "c"]);
      expect(expanded(items)).toEqual(["a", "c"]);
    });

    it("leaves a single accordion as it is", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        value: "a",
      });
      element.expandAll();
      await settled(element, items);
      expect(expanded(items)).toEqual(["a"]);
    });
  });

  describe("collapseAll()", () => {
    it("collapses every item of a multiple accordion", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        type: "multiple",
        value: '["a","b"]',
      });
      element.collapseAll();
      await settled(element, items);
      expect(element.value).toEqual([]);
      expect(expanded(items)).toEqual([]);
    });

    it("collapses the open item of a single accordion", async () => {
      const { accordion: element, items } = await accordion(["a", "b"], {
        value: "a",
      });
      element.collapseAll();
      await settled(element, items);
      expect(element.value).toBe("");
      expect(expanded(items)).toEqual([]);
    });
  });
});
