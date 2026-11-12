// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { CFTabBar, CFTabBarItem } from "./index.ts";

/**
 * A bar bound to `value`, holding an item for each of `values`, and every
 * `cf-change` it fires.
 */
async function barWith(
  value: CellHandle<string> | string,
  values: string[] = ["home", "search", "inbox"],
) {
  const bar = new CFTabBar();
  bar.value = value;
  const items = values.map((itemValue) =>
    Object.assign(new CFTabBarItem(), { value: itemValue, label: itemValue })
  );
  bar.append(...items);
  const changes: unknown[] = [];
  bar.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  await mount(bar);
  return { bar, items, changes };
}

/** The values of the items that are selected. */
const selected = (bar: CFTabBar) =>
  Array.from(
    bar.querySelectorAll<CFTabBarItem>("cf-tab-bar-item"),
    (item) => item.selected ? item.value : null,
  ).filter((value) => value !== null);

/** Clicks the button inside `item`, as a user does. */
async function click(bar: CFTabBar, item: CFTabBarItem) {
  item.button!.click();
  await bar.updateComplete;
}

/** Presses `key` on `item` and resolves with the event. */
async function press(bar: CFTabBar, item: Element, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  item.dispatchEvent(event);
  await bar.updateComplete;
  return event;
}

describe("CFTabBar", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tab-bar`", () => {
    expect(customElements.get("cf-tab-bar")).toBe(CFTabBar);
  });

  describe("connected", () => {
    it("exposes itself as the main navigation along the bottom", async () => {
      const { bar } = await barWith("");
      expect(bar.getAttribute("role")).toBe("navigation");
      expect(bar.getAttribute("aria-label")).toBe("Main navigation");
      expect(bar.getAttribute("position")).toBe("bottom");
      expect(bar.getAttribute("variant")).toBe("default");
    });

    it("keeps a label the page gave it", async () => {
      const bar = new CFTabBar();
      bar.setAttribute("aria-label", "Sections");
      await mount(bar);
      expect(bar.getAttribute("aria-label")).toBe("Sections");
    });
  });

  describe("selection", () => {
    it("selects the item matching a plain value, and no other", async () => {
      const { bar, changes } = await barWith("search");
      expect(selected(bar)).toEqual(["search"]);
      expect(changes).toEqual([]);
    });

    it("selects nothing when no item matches", async () => {
      const { bar } = await barWith("settings");
      expect(selected(bar)).toEqual([]);
    });

    it("follows a new plain value", async () => {
      const { bar, changes } = await barWith("home");
      bar.value = "inbox";
      await bar.updateComplete;
      expect(selected(bar)).toEqual(["inbox"]);
      expect(changes).toEqual([]);
    });

    it("follows the bound cell without announcing its changes", async () => {
      const cell = createMockCellHandle("home");
      const { bar, changes } = await barWith(cell);
      expect(selected(bar)).toEqual(["home"]);

      pushUpdate(cell, "inbox");
      await bar.updateComplete;
      expect(selected(bar)).toEqual(["inbox"]);
      expect(changes).toEqual([]);
    });

    it("selects an item added later when it matches", async () => {
      const { bar } = await barWith("profile");
      bar.append(
        Object.assign(new CFTabBarItem(), { value: "profile" }),
      );
      await settle();
      expect(selected(bar)).toEqual(["profile"]);
    });
  });

  describe("a click on an item", () => {
    it("writes the bound cell, selects the item, and announces it once", async () => {
      const cell = createMockCellHandle("home");
      const { bar, items, changes } = await barWith(cell);
      await click(bar, items[2]);
      expect(cell.get()).toBe("inbox");
      expect(selected(bar)).toEqual(["inbox"]);
      expect(changes).toEqual([{ value: "inbox", oldValue: "home" }]);
    });

    it("selects the item under a plain value, and stays there when the page passes it back", async () => {
      const { bar, items, changes } = await barWith("home");
      await click(bar, items[1]);
      expect(selected(bar)).toEqual(["search"]);

      bar.value = "search";
      await bar.updateComplete;
      expect(selected(bar)).toEqual(["search"]);

      await click(bar, items[0]);
      expect(selected(bar)).toEqual(["home"]);
      expect(changes).toEqual([
        { value: "search", oldValue: "home" },
        { value: "home", oldValue: "search" },
      ]);
    });

    it("keeps a click under a plain value across an unrelated update", async () => {
      const { bar, items, changes } = await barWith("home");
      await click(bar, items[1]);
      bar.position = "top";
      await bar.updateComplete;
      expect(selected(bar)).toEqual(["search"]);
      expect(changes).toEqual([{ value: "search", oldValue: "home" }]);
    });

    it("does nothing on the selected item", async () => {
      const cell = createMockCellHandle("home");
      const { bar, items, changes } = await barWith(cell);
      await click(bar, items[0]);
      expect(cell.get()).toBe("home");
      expect(changes).toEqual([]);
    });

    it("does nothing on a disabled item", async () => {
      const cell = createMockCellHandle("home");
      const { bar, items, changes } = await barWith(cell);
      items[1].disabled = true;
      await items[1].updateComplete;
      await click(bar, items[1]);
      expect(cell.get()).toBe("home");
      expect(changes).toEqual([]);
    });

    it("ignores a `tab-bar-click` naming no item with a value", async () => {
      const { bar, changes } = await barWith("home");
      bar.dispatchEvent(new CustomEvent("tab-bar-click"));
      bar.dispatchEvent(
        new CustomEvent("tab-bar-click", {
          detail: { item: new CFTabBarItem() },
        }),
      );
      expect(selected(bar)).toEqual(["home"]);
      expect(changes).toEqual([]);
    });
  });

  describe("a key press on an item", () => {
    const moves: [string, number, string][] = [
      ["ArrowRight", 0, "search"],
      ["ArrowRight", 2, "home"],
      ["ArrowLeft", 1, "home"],
      ["ArrowLeft", 0, "inbox"],
      ["Home", 2, "home"],
      ["End", 0, "inbox"],
    ];
    for (const [key, from, to] of moves) {
      it(`moves focus and selection from item ${from} to ${JSON.stringify(to)} on ${key}`, async () => {
        const values = ["home", "search", "inbox"];
        const { bar, items, changes } = await barWith(values[from]);
        const event = await press(bar, items[from], key);
        expect(event.defaultPrevented).toBe(true);
        expect(selected(bar)).toEqual([to]);
        expect(document.activeElement).toBe(items[values.indexOf(to)]);
        expect(changes).toEqual([{ value: to, oldValue: values[from] }]);
      });
    }

    it("skips disabled items", async () => {
      const { bar, items } = await barWith("home");
      items[1].disabled = true;
      await items[1].updateComplete;
      await press(bar, items[0], "ArrowRight");
      expect(selected(bar)).toEqual(["inbox"]);
    });

    for (const [key, to] of [["ArrowRight", "home"], ["ArrowLeft", "inbox"]]) {
      it(`moves from a disabled item to ${JSON.stringify(to)} on ${key}`, async () => {
        const { bar, items } = await barWith("search");
        items[1].disabled = true;
        await items[1].updateComplete;
        await press(bar, items[1], key);
        expect(selected(bar)).toEqual([to]);
      });
    }

    it("does nothing when every item is disabled", async () => {
      const { bar, items, changes } = await barWith("home");
      for (const item of items) item.disabled = true;
      const event = await press(bar, items[0], "ArrowRight");
      expect(event.defaultPrevented).toBe(false);
      expect(changes).toEqual([]);
    });

    it("ignores other keys", async () => {
      const { bar, items, changes } = await barWith("home");
      const event = await press(bar, items[0], "a");
      expect(event.defaultPrevented).toBe(false);
      expect(selected(bar)).toEqual(["home"]);
      expect(changes).toEqual([]);
    });

    it("ignores keys pressed outside an item", async () => {
      const { bar, changes } = await barWith("home");
      const action = document.createElement("button");
      action.slot = "action";
      bar.append(action);
      const event = await press(bar, action, "ArrowRight");
      expect(event.defaultPrevented).toBe(false);
      expect(changes).toEqual([]);
    });
  });

  describe("the action slot", () => {
    const wrapper = (bar: CFTabBar) =>
      bar.shadowRoot!.querySelector("[part=action]")!;

    it("hides its wrapper while it is empty, and shows it once filled", async () => {
      const { bar } = await barWith("home");
      expect(wrapper(bar).classList.contains("empty")).toBe(true);

      const action = document.createElement("button");
      action.slot = "action";
      bar.append(action);
      await settle();
      await bar.updateComplete;
      expect(wrapper(bar).classList.contains("empty")).toBe(false);
    });
  });

  describe("getValue() and setValue()", () => {
    it("read and write the bound cell without announcing it", async () => {
      const cell = createMockCellHandle("home");
      const { bar, changes } = await barWith(cell);
      expect(bar.getValue()).toBe("home");
      bar.setValue("search");
      await bar.updateComplete;
      expect(cell.get()).toBe("search");
      expect(bar.getValue()).toBe("search");
      expect(selected(bar)).toEqual(["search"]);
      expect(changes).toEqual([]);
    });
  });

  describe("disconnected", () => {
    it("stops answering clicks and keys", async () => {
      const cell = createMockCellHandle("home");
      const { bar, items, changes } = await barWith(cell);
      bar.remove();
      items[1].button!.click();
      await press(bar, items[0], "ArrowRight");
      expect(cell.get()).toBe("home");
      expect(changes).toEqual([]);
    });
  });
});
