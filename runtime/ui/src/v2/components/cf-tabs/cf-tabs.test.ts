// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFTab } from "../cf-tab/index.ts";
import { CFTabList } from "../cf-tab-list/index.ts";
import { CFTabPanel } from "../cf-tab-panel/index.ts";
import { CFTabs } from "./index.ts";

/** A tab list holding a tab for each of `values`. */
function tabListOf(values: string[]) {
  const list = new CFTabList();
  list.append(
    ...values.map((value) =>
      Object.assign(new CFTab(), { value, textContent: value })
    ),
  );
  return list;
}

/**
 * Tabs bound to `value`, mounted, then given a tab and a panel for each of
 * `values`, and every `cf-change` they fire.
 */
async function tabsWith(
  value: CellHandle<string> | string,
  values = ["active", "progress", "pending", "feed"],
) {
  const tabs = new CFTabs();
  tabs.value = value;
  const changes: unknown[] = [];
  tabs.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  await mount(tabs);
  tabs.append(
    tabListOf(values),
    ...values.map((panelValue) =>
      Object.assign(new CFTabPanel(), { value: panelValue })
    ),
  );
  await settle();
  return { tabs, changes };
}

/** The tab whose value is `value`. */
const tab = (tabs: CFTabs, value: string) =>
  Array.from(tabs.querySelectorAll<CFTab>("cf-tab")).find((each) =>
    each.value === value
  )!;

/** The values of the selected tabs. */
const selectedTabs = (tabs: CFTabs) =>
  Array.from(tabs.querySelectorAll<CFTab>("cf-tab"))
    .filter((each) => each.selected)
    .map((each) => each.value);

/** The values of the panels that show. */
const visiblePanels = (tabs: CFTabs) =>
  Array.from(tabs.querySelectorAll<CFTabPanel>("cf-tab-panel"))
    .filter((each) => !each.hidden)
    .map((each) => each.value);

/** Clicks the button inside the tab whose value is `value`. */
async function click(tabs: CFTabs, value: string) {
  tab(tabs, value).button!.click();
  await tabs.updateComplete;
}

/** Presses `key` on `target` and resolves with the event. */
async function press(tabs: CFTabs, target: Element, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  await tabs.updateComplete;
  return event;
}

describe("CFTabs", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-tabs`", () => {
    expect(customElements.get("cf-tabs")).toBe(CFTabs);
  });

  it("exposes itself as a horizontal tab list", async () => {
    const { tabs } = await tabsWith("active");
    expect(tabs.getAttribute("role")).toBe("tablist");
    expect(
      tabs.shadowRoot!.querySelector("[part=tabs]")!.getAttribute(
        "data-orientation",
      ),
    ).toBe("horizontal");
  });

  describe("selection", () => {
    it("selects the tab and shows the panel matching the value, and no others", async () => {
      const { tabs } = await tabsWith("pending");
      expect(selectedTabs(tabs)).toEqual(["pending"]);
      expect(visiblePanels(tabs)).toEqual(["pending"]);
      expect(tab(tabs, "pending").getAttribute("aria-selected")).toBe("true");
      expect(tab(tabs, "pending").getAttribute("data-selected")).toBe("true");
      expect(tab(tabs, "feed").getAttribute("aria-selected")).toBe("false");
      expect(tab(tabs, "feed").hasAttribute("data-selected")).toBe(false);
    });

    it("selects the matching tab among children it connects with", async () => {
      const tabs = new CFTabs();
      tabs.value = "b";
      tabs.append(tabListOf(["a", "b"]));
      await mount(tabs);
      expect(selectedTabs(tabs)).toEqual(["b"]);
    });

    it("follows the bound cell without announcing it", async () => {
      const cell = createMockCellHandle("active");
      const { tabs, changes } = await tabsWith(cell);
      pushUpdate(cell, "pending");
      expect(changes).toEqual([]);
      expect(selectedTabs(tabs)).toEqual(["pending"]);
      expect(visiblePanels(tabs)).toEqual(["pending"]);
    });

    it("selects a tab added to the list later", async () => {
      const { tabs } = await tabsWith("archived", ["active"]);
      expect(selectedTabs(tabs)).toEqual(["active"]);
      tabs.querySelector("cf-tab-list")!.append(
        Object.assign(new CFTab(), { value: "archived" }),
      );
      await settle();
      expect(selectedTabs(tabs)).toEqual(["archived"]);
    });

    it("hears about tabs added to a tab list that replaced the first", async () => {
      const { tabs } = await tabsWith("c", ["a", "b"]);
      tabs.querySelector("cf-tab-list")!.replaceWith(tabListOf(["a", "b"]));
      await settle();
      // The value matches no tab, so the first shows.
      expect(selectedTabs(tabs)).toEqual(["a"]);

      tabs.querySelector("cf-tab-list")!.append(
        Object.assign(new CFTab(), { value: "c" }),
      );
      await settle();
      expect(selectedTabs(tabs)).toEqual(["c"]);
    });
  });

  describe("cf-change", () => {
    it("fires exactly once on a user click, which writes the cell", async () => {
      const cell = createMockCellHandle("active");
      const { tabs, changes } = await tabsWith(cell);
      await click(tabs, "progress");
      expect(changes).toEqual([{ value: "progress", oldValue: "active" }]);
      expect(cell.get()).toBe("progress");
      expect(selectedTabs(tabs)).toEqual(["progress"]);
      expect(visiblePanels(tabs)).toEqual(["progress"]);
    });

    it("does not fire on a click on the selected tab", async () => {
      const cell = createMockCellHandle("active");
      const { tabs, changes } = await tabsWith(cell);
      await click(tabs, "active");
      expect(changes).toEqual([]);
      expect(cell.get()).toBe("active");
      expect(writesSent(cell)).toEqual([]);
    });

    it("does not fire on a click on a disabled tab", async () => {
      const cell = createMockCellHandle("active");
      const { tabs, changes } = await tabsWith(cell);
      tab(tabs, "progress").disabled = true;
      tabs.dispatchEvent(
        new CustomEvent("tab-click", {
          detail: { tab: tab(tabs, "progress") },
        }),
      );
      expect(changes).toEqual([]);
      expect(cell.get()).toBe("active");
    });
  });

  describe("a key press on a tab", () => {
    const values = ["active", "progress", "pending", "feed"];
    const moves: [string, string, string][] = [
      ["ArrowRight", "active", "progress"],
      ["ArrowRight", "feed", "active"],
      ["ArrowLeft", "progress", "active"],
      ["ArrowLeft", "active", "feed"],
      ["Home", "pending", "active"],
      ["End", "active", "feed"],
    ];
    for (const [key, from, to] of moves) {
      it(`moves from ${JSON.stringify(from)} to ${JSON.stringify(to)} on ${key}, firing \`cf-change\` once`, async () => {
        const cell = createMockCellHandle(from);
        const { tabs, changes } = await tabsWith(cell, values);
        const event = await press(tabs, tab(tabs, from), key);
        expect(event.defaultPrevented).toBe(true);
        expect(changes).toEqual([{ value: to, oldValue: from }]);
        expect(cell.get()).toBe(to);
        expect(selectedTabs(tabs)).toEqual([to]);
        expect(tab(tabs, to).shadowRoot!.activeElement).toBe(
          tab(tabs, to).button,
        );
      });
    }

    it("uses the up and down arrows when vertical", async () => {
      const { tabs } = await tabsWith("active", values);
      tabs.orientation = "vertical";
      await tabs.updateComplete;
      await press(tabs, tab(tabs, "active"), "ArrowDown");
      expect(selectedTabs(tabs)).toEqual(["progress"]);
      await press(tabs, tab(tabs, "progress"), "ArrowUp");
      expect(selectedTabs(tabs)).toEqual(["active"]);
      const ignored = await press(tabs, tab(tabs, "active"), "ArrowRight");
      expect(ignored.defaultPrevented).toBe(false);
    });

    it("skips disabled tabs", async () => {
      const { tabs } = await tabsWith("active", values);
      tab(tabs, "progress").disabled = true;
      await press(tabs, tab(tabs, "active"), "ArrowRight");
      expect(selectedTabs(tabs)).toEqual(["pending"]);
    });

    for (const [key, to] of [["ArrowRight", "active"], ["ArrowLeft", "feed"]]) {
      it(`moves from a disabled tab to ${JSON.stringify(to)} on ${key}`, async () => {
        const { tabs } = await tabsWith("progress", values);
        tab(tabs, "progress").disabled = true;
        await press(tabs, tab(tabs, "progress"), key);
        expect(selectedTabs(tabs)).toEqual([to]);
      });
    }

    it("does nothing when every tab is disabled", async () => {
      const { tabs, changes } = await tabsWith("active", values);
      for (const value of values) tab(tabs, value).disabled = true;
      const event = await press(tabs, tab(tabs, "active"), "ArrowRight");
      expect(event.defaultPrevented).toBe(false);
      expect(changes).toEqual([]);
    });

    it("ignores other keys", async () => {
      const { tabs, changes } = await tabsWith("active", values);
      const event = await press(tabs, tab(tabs, "active"), "a");
      expect(event.defaultPrevented).toBe(false);
      expect(changes).toEqual([]);
    });

    it("ignores keys pressed outside a tab", async () => {
      const { tabs, changes } = await tabsWith("active", values);
      const panel = tabs.querySelector("cf-tab-panel")!;
      const event = await press(tabs, panel, "ArrowRight");
      expect(event.defaultPrevented).toBe(false);
      expect(changes).toEqual([]);
    });
  });

  // cf-tabs may be created inside a render `computed()` that reads the cell
  // it is bound to, so it writes that cell only on a user gesture: a write
  // while mounting or syncing would re-run the computed, which would mount it
  // again, and the scheduler would never settle.
  describe("writes to the bound cell", () => {
    it("are none on mount while the value is empty, and no tab flashes", async () => {
      const cell = createMockCellHandle("");
      const { tabs } = await tabsWith(cell);
      expect(writesSent(cell)).toEqual([]);
      expect(cell.get()).toBe("");
      expect(selectedTabs(tabs)).toEqual([]);
      expect(visiblePanels(tabs)).toEqual([]);
    });

    it("are none across repeated mounts over an empty cell", async () => {
      const cell = createMockCellHandle("");
      for (let mounts = 0; mounts < 3; mounts++) {
        const { tabs } = await tabsWith(cell);
        expect(selectedTabs(tabs)).toEqual([]);
        tabs.remove();
      }
      expect(writesSent(cell)).toEqual([]);
      expect(cell.get()).toBe("");
    });

    it("are none while the value resolves, which goes straight to its tab", async () => {
      const cell = createMockCellHandle("");
      const { tabs } = await tabsWith(cell);
      expect(selectedTabs(tabs)).toEqual([]);
      pushUpdate(cell, "pending");
      expect(selectedTabs(tabs)).toEqual(["pending"]);
      expect(visiblePanels(tabs)).toEqual(["pending"]);
      expect(writesSent(cell)).toEqual([]);
    });

    it("are none when the value is cleared, which drops the selection", async () => {
      const cell = createMockCellHandle("progress");
      const { tabs } = await tabsWith(cell);
      expect(selectedTabs(tabs)).toEqual(["progress"]);
      expect(visiblePanels(tabs)).toEqual(["progress"]);
      pushUpdate(cell, "");
      expect(selectedTabs(tabs)).toEqual([]);
      expect(visiblePanels(tabs)).toEqual([]);
      expect(writesSent(cell)).toEqual([]);
    });

    it("are none for a value no tab matches, which shows the first tab", async () => {
      const cell = createMockCellHandle("active");
      const { tabs } = await tabsWith(cell, ["active", "progress"]);
      pushUpdate(cell, "archived");
      expect(writesSent(cell)).toEqual([]);
      expect(cell.get()).toBe("archived");
      expect(selectedTabs(tabs)).toEqual(["active"]);
    });

    it("are none for a value no tab matches when every tab is disabled, and nothing shows", async () => {
      const cell = createMockCellHandle("active");
      const { tabs } = await tabsWith(cell, ["active", "progress"]);
      tab(tabs, "active").disabled = true;
      tab(tabs, "progress").disabled = true;
      pushUpdate(cell, "archived");
      expect(writesSent(cell)).toEqual([]);
      expect(selectedTabs(tabs)).toEqual([]);
    });

    it("are exactly one on a user click", async () => {
      const cell = createMockCellHandle("");
      const { tabs } = await tabsWith(cell, ["active", "progress"]);
      await click(tabs, "progress");
      expect(writesSent(cell).length).toBe(1);
      expect(cell.get()).toBe("progress");
    });
  });

  // A page whose selection is not a single cell binds a plain value and
  // listens for `cf-change`, typically re-creating the tabs on each render
  // with the value the click produced.
  describe("a plain value", () => {
    /** Re-creates the tabs unselected and passes `value` back, as a render does. */
    async function rerender(tabs: CFTabs, value: string) {
      for (const each of tabs.querySelectorAll<CFTab>("cf-tab")) {
        each.replaceWith(
          Object.assign(new CFTab(), { value: each.value }),
        );
      }
      tabs.value = value;
      await tabs.updateComplete;
    }

    it("shows a user click at once, and announces it", async () => {
      const { tabs, changes } = await tabsWith("steps", [
        "steps",
        "notes",
        "log",
      ]);
      await click(tabs, "notes");
      expect(changes).toEqual([{ value: "notes", oldValue: "steps" }]);
      expect(selectedTabs(tabs)).toEqual(["notes"]);
    });

    it("selects re-created tabs when the page passes the clicked value back", async () => {
      const { tabs } = await tabsWith("steps", ["steps", "notes", "log"]);
      await click(tabs, "notes");
      await rerender(tabs, "notes");
      expect(selectedTabs(tabs)).toEqual(["notes"]);

      await click(tabs, "log");
      await rerender(tabs, "log");
      expect(selectedTabs(tabs)).toEqual(["log"]);

      await click(tabs, "steps");
      await rerender(tabs, "steps");
      expect(selectedTabs(tabs)).toEqual(["steps"]);
    });

    it("returns to the first tab on a click before the page passes anything back", async () => {
      const { tabs, changes } = await tabsWith("steps", ["steps", "notes"]);
      await click(tabs, "notes");
      await click(tabs, "steps");
      expect(selectedTabs(tabs)).toEqual(["steps"]);
      expect(changes).toEqual([
        { value: "notes", oldValue: "steps" },
        { value: "steps", oldValue: "notes" },
      ]);
    });

    it("keeps a click the page has not passed back across an unrelated update", async () => {
      const { tabs, changes } = await tabsWith("steps", [
        "steps",
        "notes",
        "log",
      ]);
      await click(tabs, "notes");
      tabs.orientation = "vertical";
      await tabs.updateComplete;
      expect(selectedTabs(tabs)).toEqual(["notes"]);
      expect(visiblePanels(tabs)).toEqual(["notes"]);
      expect(changes).toEqual([{ value: "notes", oldValue: "steps" }]);
    });

    it("lets a value the page passes back override the click", async () => {
      const { tabs } = await tabsWith("steps", ["steps", "notes", "log"]);
      await click(tabs, "log");
      await rerender(tabs, "notes");
      expect(selectedTabs(tabs)).toEqual(["notes"]);
    });
  });

  describe("getValue() and setValue()", () => {
    it("read and write the bound cell without announcing it", async () => {
      const cell = createMockCellHandle("active");
      const { tabs, changes } = await tabsWith(cell);
      expect(tabs.getValue()).toBe("active");
      tabs.setValue("feed");
      expect(cell.get()).toBe("feed");
      expect(selectedTabs(tabs)).toEqual(["feed"]);
      expect(changes).toEqual([]);
    });
  });

  describe("selectFirst() and selectLast()", () => {
    it("select the first and last enabled tabs", async () => {
      const cell = createMockCellHandle("pending");
      const { tabs } = await tabsWith(cell);
      tab(tabs, "active").disabled = true;
      tab(tabs, "feed").disabled = true;
      tabs.selectFirst();
      expect(cell.get()).toBe("progress");
      tabs.selectLast();
      expect(cell.get()).toBe("pending");
    });

    it("do nothing when every tab is disabled", async () => {
      const cell = createMockCellHandle("pending");
      const { tabs } = await tabsWith(cell, ["active"]);
      tab(tabs, "active").disabled = true;
      tabs.selectFirst();
      tabs.selectLast();
      expect(writesSent(cell)).toEqual([]);
    });
  });

  describe("disconnected", () => {
    it("stops answering clicks and keys", async () => {
      const cell = createMockCellHandle("active");
      const { tabs, changes } = await tabsWith(cell);
      tabs.remove();
      tab(tabs, "progress").button!.click();
      await press(tabs, tab(tabs, "active"), "ArrowRight");
      expect(cell.get()).toBe("active");
      expect(changes).toEqual([]);
    });
  });
});
