// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  holdReads,
  pushRefusal,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFSwitch } from "./index.ts";

/** A switch mounted with `properties`, and every `cf-change` it fires. */
async function switchWith(properties: Partial<CFSwitch> = {}) {
  const element = Object.assign(new CFSwitch(), properties);
  const changes: unknown[] = [];
  element.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) changes.push(event.detail);
  });
  return { element: await mount(element), changes };
}

const track = (element: CFSwitch) =>
  element.shadowRoot!.querySelector(".switch")!;

const checkbox = (element: CFSwitch) =>
  element.shadowRoot!.querySelector("input")!;

const written = (cell: CellHandle<boolean>) =>
  writesSent(cell).map((write) => write.value);

describe("CFSwitch", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-switch`", () => {
    expect(customElements.get("cf-switch")).toBe(CFSwitch);
  });

  describe("connected", () => {
    it("exposes itself as an unchecked, focusable switch", async () => {
      const { element } = await switchWith();
      expect(element.getAttribute("role")).toBe("switch");
      expect(element.getAttribute("exportparts")).toBe("switch,thumb");
      expect(element.getAttribute("aria-checked")).toBe("false");
      expect(element.getAttribute("aria-disabled")).toBe("false");
      expect(element.tabIndex).toBe(0);
    });

    it("keeps a role and exported parts the page gave it", async () => {
      const element = new CFSwitch();
      element.setAttribute("role", "checkbox");
      element.setAttribute("exportparts", "switch: track");
      await mount(element);
      expect(element.getAttribute("role")).toBe("checkbox");
      expect(element.getAttribute("exportparts")).toBe("switch: track");
    });

    it("takes a disabled switch out of the tab order", async () => {
      const { element } = await switchWith({ disabled: true });
      expect(element.getAttribute("aria-disabled")).toBe("true");
      expect(element.tabIndex).toBe(-1);
      expect(track(element).classList.contains("disabled")).toBe(true);
      expect(checkbox(element).disabled).toBe(true);
    });

    it("follows `disabled` as it changes", async () => {
      const { element } = await switchWith();
      element.disabled = true;
      await element.updateComplete;
      expect(element.getAttribute("aria-disabled")).toBe("true");
      expect(element.tabIndex).toBe(-1);
    });
  });

  describe("render()", () => {
    it("draws an unchecked switch with a hidden checkbox carrying its value", async () => {
      const { element } = await switchWith();
      expect([...track(element).classList]).toEqual(["switch"]);
      expect(checkbox(element).checked).toBe(false);
      expect(checkbox(element).hasAttribute("name")).toBe(false);
      expect(checkbox(element).value).toBe("on");
    });

    it("draws a checked switch, named for a form", async () => {
      const { element } = await switchWith({
        checked: true,
        name: "alerts",
        value: "yes",
      });
      expect([...track(element).classList]).toEqual(["switch", "checked"]);
      expect(checkbox(element).checked).toBe(true);
      expect(checkbox(element).name).toBe("alerts");
      expect(checkbox(element).value).toBe("yes");
      expect(element.getAttribute("aria-checked")).toBe("true");
    });
  });

  describe("given a plain boolean", () => {
    it("flips on a click, reflects it, and announces it once", async () => {
      const { element, changes } = await switchWith();
      element.click();
      await element.updateComplete;
      expect(element.checked).toBe(true);
      expect(element.hasAttribute("checked")).toBe(true);
      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(checkbox(element).checked).toBe(true);

      element.click();
      await element.updateComplete;
      expect(element.checked).toBe(false);
      expect(element.getAttribute("aria-checked")).toBe("false");
      expect(changes).toEqual([{ checked: true }, { checked: false }]);
    });

    it("does nothing on a click while disabled, and lets the click go no further", async () => {
      const { element, changes } = await switchWith({ disabled: true });
      let reachedPage = false;
      document.body.addEventListener("click", () => reachedPage = true);
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(reachedPage).toBe(false);
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });

    for (const key of [" ", "Spacebar", "Enter"]) {
      it(`flips on ${JSON.stringify(key)}`, async () => {
        const { element, changes } = await switchWith();
        const press = new KeyboardEvent("keydown", { key, cancelable: true });
        element.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
        expect(element.checked).toBe(true);
        expect(changes).toEqual([{ checked: true }]);
      });
    }

    it("ignores other keys", async () => {
      const { element, changes } = await switchWith();
      const press = new KeyboardEvent("keydown", {
        key: "a",
        cancelable: true,
      });
      element.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });

    it("ignores every key while disabled", async () => {
      const { element, changes } = await switchWith({ disabled: true });
      const press = new KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
      });
      element.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(false);
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });

    it("stops answering clicks and keys once removed", async () => {
      const { element, changes } = await switchWith();
      element.remove();
      element.click();
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(element.checked).toBe(false);
      expect(changes).toEqual([]);
    });
  });

  describe("bound to a cell", () => {
    // A bound cell's first delivery is announced as it arrives, so each case
    // that counts announcements starts counting once the switch is mounted.

    it("shows the cell's value", async () => {
      const { element } = await switchWith({
        checked: createMockCellHandle(true),
      });
      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(track(element).classList.contains("checked")).toBe(true);
      expect(checkbox(element).checked).toBe(true);
    });

    it("writes the toggle of the cell's value once on a click, and announces it", async () => {
      const checked = createMockCellHandle(false);
      const { element, changes } = await switchWith({ checked });
      changes.length = 0;

      element.click();
      await settle();
      await element.updateComplete;

      expect(written(checked)).toEqual([true]);
      expect(changes).toContainEqual({ checked: true });
      expect(changes).not.toContainEqual({ checked: false });
      expect(track(element).classList.contains("checked")).toBe(true);
      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(element.checked).toBe(checked);
    });

    it("redraws and announces a value the cell is pushed", async () => {
      const checked = createMockCellHandle(false);
      const { element, changes } = await switchWith({ checked });
      changes.length = 0;

      pushUpdate(checked, true);
      await element.updateComplete;

      expect(track(element).classList.contains("checked")).toBe(true);
      expect(checkbox(element).checked).toBe(true);
      expect(element.getAttribute("aria-checked")).toBe("true");
      expect(changes).toEqual([{ checked: true }]);
      expect(written(checked)).toEqual([]);
    });

    it("writes nothing until the worker answers a cell it has not read, then the toggle of the answer", async () => {
      const checked = createMockCellHandle<boolean>();
      const answer = holdReads(checked);
      const { element } = await switchWith({ checked });

      element.click();
      await settle();
      expect(written(checked)).toEqual([]);

      answer({ value: true });
      await settle();

      expect(written(checked)).toEqual([false]);
    });

    it("writes nothing while the worker refuses the cell's read", async () => {
      const checked = createMockCellHandle(false);
      const { element, changes } = await switchWith({ checked });
      pushRefusal(checked);
      changes.length = 0;

      element.click();
      await settle();

      expect(written(checked)).toEqual([]);
      expect(changes).toEqual([]);
    });

    it("writes to the cell bound last", async () => {
      const first = createMockCellHandle(false);
      const second = createMockCellHandle(true, { id: "of:second" });
      const { element } = await switchWith({ checked: first });
      element.checked = second;
      await element.updateComplete;
      expect(element.getAttribute("aria-checked")).toBe("true");

      element.click();
      await settle();

      expect(written(first)).toEqual([]);
      expect(written(second)).toEqual([false]);
    });
  });
});
