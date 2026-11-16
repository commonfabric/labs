// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  holdReads,
  pushRefusal,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import type { CFRender } from "../cf-render/cf-render.ts";
import { CFPicker } from "./index.ts";

/** An item a picker can render: a cell named `id`. */
const item = (id: string): CellHandle<unknown> =>
  createMockCellHandle<unknown>({}, { id: `of:${id}` as CellRef["id"] });

/** Three items, named `first`, `second` and `third`. */
const threeItems = () => ["first", "second", "third"].map(item);

/**
 * A picker mounted over `items`, selecting through `selectedIndex`, with every
 * event of `events` it fires.
 */
async function pickerWith(
  { items, selectedIndex = createMockCellHandle(0), ...properties }:
    & Partial<Omit<CFPicker, "items">>
    & { items?: CellHandle<unknown>[] },
  events: string[] = [],
) {
  const element = Object.assign(new CFPicker(), properties, {
    items,
    selectedIndex,
  });
  const fired: { type: string; detail: unknown }[] = [];
  for (const type of events) {
    element.addEventListener(type, (event) => {
      fired.push({
        type,
        detail: event instanceof CustomEvent ? event.detail : undefined,
      });
    });
  }
  return { element: await mount(element), selectedIndex, fired };
}

/**
 * Resolves once every promise the mock worker's answers settle has run: the
 * answers arrive as microtasks, so one macrotask boundary is past them all.
 */
const answersDelivered = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The values written to `selectedIndex`, in order. */
const indicesWritten = (selectedIndex: CellHandle<number>) =>
  writesSent(selectedIndex).map((write) => write.value);

const shadow = (element: CFPicker) => element.shadowRoot!;

/** The id of the item the picker hands its `cf-render` to show. */
const shownId = (element: CFPicker) =>
  shadow(element).querySelector<CFRender>("cf-render")?.cell?.ref().id;

function arrow(element: CFPicker, side: "left" | "right"): HTMLButtonElement {
  return shadow(element).querySelector(`.nav-arrow.${side}`)!;
}

/** Presses `key` on the picker, and returns the event pressed. */
function press(element: CFPicker, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

/** Swipes across the picker from `fromX` to `toX`. */
function swipe(element: CFPicker, fromX: number, toX: number): void {
  const container = shadow(element).querySelector(".picker-container")!;
  const at = (clientX: number) => [
    new Touch({ identifier: 0, target: container, clientX }),
  ];
  container.dispatchEvent(new TouchEvent("touchstart", { touches: at(fromX) }));
  container.dispatchEvent(
    new TouchEvent("touchend", { changedTouches: at(toX) }),
  );
}

describe("cf-picker-mounted", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-picker`", () => {
    expect(customElements.get("cf-picker")).toBe(CFPicker);
  });

  describe("connected", () => {
    it("exposes itself as a focusable listbox whose active item is the selection", async () => {
      const { element } = await pickerWith({
        items: threeItems(),
        selectedIndex: createMockCellHandle(1),
      });

      expect(element.getAttribute("role")).toBe("listbox");
      expect(element.tabIndex).toBe(0);
      expect(element.getAttribute("aria-activedescendant")).toBe(
        "picker-item-1",
      );
      expect(element.getAttribute("aria-disabled")).toBe("false");
    });

    it("takes a disabled picker out of the tab order", async () => {
      const { element } = await pickerWith({
        items: threeItems(),
        disabled: true,
      });

      expect(element.tabIndex).toBe(-1);
      expect(element.getAttribute("aria-disabled")).toBe("true");
    });

    it("follows a change of `disabled` in its tab order and its ARIA state", async () => {
      const { element } = await pickerWith({ items: threeItems() });

      element.disabled = true;
      await element.updateComplete;
      expect(element.tabIndex).toBe(-1);
      expect(element.getAttribute("aria-disabled")).toBe("true");

      element.disabled = false;
      await element.updateComplete;
      expect(element.tabIndex).toBe(0);
      expect(element.getAttribute("aria-disabled")).toBe("false");
    });

    it("sets the card's minimum height from `min-height`, and follows a change of it", async () => {
      const { element } = await pickerWith({
        items: threeItems(),
        minHeight: "300px",
      });
      expect(element.style.getPropertyValue("--cf-picker-min-height")).toBe(
        "300px",
      );

      element.minHeight = "10rem";
      await element.updateComplete;
      expect(element.style.getPropertyValue("--cf-picker-min-height")).toBe(
        "10rem",
      );
    });
  });

  describe("render()", () => {
    it("shows only its children while no items are bound", async () => {
      // A view's render policy withholds an `items` binding the viewer may not
      // see, and then no items arrive. The view puts the access placeholder in
      // the picker's children while the list's space is out of reach.
      const { element } = await pickerWith({});

      expect(shadow(element).querySelectorAll("slot").length).toBe(1);
      expect(shadow(element).querySelectorAll(".picker-container").length)
        .toBe(0);
    });

    it("shows its empty state for an empty list, with no arrows", async () => {
      const { element } = await pickerWith({ items: [] });

      expect(shadow(element).querySelector(".empty-state")?.textContent)
        .toBe("No items");
      expect(shadow(element).querySelectorAll("slot").length).toBe(0);
      expect(arrow(element, "left").classList.contains("hidden")).toBe(true);
      expect(arrow(element, "right").classList.contains("hidden")).toBe(true);
    });

    it("renders the selected item, with arrows and a dot per item marking it", async () => {
      const items = threeItems();
      const { element } = await pickerWith({
        items,
        selectedIndex: createMockCellHandle(1),
      });

      expect(shownId(element)).toBe("of:second");
      expect(
        [...shadow(element).querySelectorAll(".dot")].map((dot) =>
          dot.classList.contains("active")
        ),
      ).toEqual([false, true, false]);
      expect(arrow(element, "left").classList.contains("hidden")).toBe(false);
      expect(arrow(element, "right").classList.contains("hidden")).toBe(false);
    });

    it("renders the last item for a selection past the end", async () => {
      const items = threeItems();
      const { element } = await pickerWith({
        items,
        selectedIndex: createMockCellHandle(5),
      });

      expect(shownId(element)).toBe("of:third");
      expect(shadow(element).querySelector(".card-wrapper")?.id).toBe(
        "picker-item-2",
      );
    });

    it("shows a single item with no arrows and no dots", async () => {
      const { element } = await pickerWith({ items: [item("only")] });

      expect(shadow(element).querySelectorAll(".card-wrapper").length).toBe(1);
      expect(shadow(element).querySelectorAll(".dot").length).toBe(0);
      expect(arrow(element, "left").classList.contains("hidden")).toBe(true);
      expect(arrow(element, "right").classList.contains("hidden")).toBe(true);
    });
  });

  describe("stepping", () => {
    // Previous and next move the selection from the index its cell holds,
    // wrapping at either end, so they compute their write from that read: from
    // the worker's answer, never from a cell it has not read or may not show.

    /** The index each arrow from `held` writes. */
    const written = async (held: number, side: "left" | "right") => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
        selectedIndex: createMockCellHandle(held),
      });
      arrow(element, side).click();
      return indicesWritten(selectedIndex);
    };

    it("steps from an index in range, wrapping at either end", async () => {
      expect(await written(1, "right")).toEqual([2]);
      expect(await written(1, "left")).toEqual([0]);
      expect(await written(2, "right")).toEqual([0]);
      expect(await written(0, "left")).toEqual([2]);
    });

    it("steps from an index past the end as from that index, wrapped", async () => {
      // Three items, index 5: next is (5 + 1) mod 3, previous (5 - 1) mod 3.
      expect(await written(5, "right")).toEqual([0]);
      expect(await written(5, "left")).toEqual([1]);
    });

    it("shows the item it steps to", async () => {
      const items = threeItems();
      const { element } = await pickerWith({ items });

      arrow(element, "right").click();
      await answersDelivered();
      await element.updateComplete;

      expect(shownId(element)).toBe("of:second");
      expect(element.getAttribute("aria-activedescendant")).toBe(
        "picker-item-1",
      );
    });

    it("writes nothing while the worker has not answered the selection's read", async () => {
      const selectedIndex = createMockCellHandle<number>();
      holdReads(selectedIndex);
      const { element } = await pickerWith({
        items: threeItems(),
        selectedIndex,
      });

      arrow(element, "right").click();
      arrow(element, "left").click();

      expect(writesSent(selectedIndex)).toEqual([]);
    });

    it("lands a step, then a pick made while the step waits on the worker, in that order", async () => {
      const selectedIndex = createMockCellHandle<number>();
      const answer = holdReads(selectedIndex);
      const { element } = await pickerWith({
        items: threeItems(),
        selectedIndex,
      });

      arrow(element, "right").click();
      element.selectByIndex(2);
      answer({ value: 0 });
      await answersDelivered();

      expect(indicesWritten(selectedIndex)).toEqual([1, 2]);
    });

    it("writes a pick of the index shown while a step waits on the worker", async () => {
      // The step will move the selection on from the shown 0, so picking 0 is
      // a move of its own.
      const selectedIndex = createMockCellHandle<number>();
      const answer = holdReads(selectedIndex);
      const { element } = await pickerWith({
        items: threeItems(),
        selectedIndex,
      });

      arrow(element, "right").click();
      element.selectByIndex(0);
      answer({ value: 0 });
      await answersDelivered();

      expect(indicesWritten(selectedIndex)).toEqual([1, 0]);
    });

    it("writes nothing for a pick of the index the cell holds", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
      });

      element.selectByIndex(0);
      element.selectByIndex(1);
      await answersDelivered();

      expect(indicesWritten(selectedIndex)).toEqual([1]);
    });

    it("writes nothing for a pick of the first item on a cell holding nothing", async () => {
      // Nothing selected shows the first item.
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
        selectedIndex: createMockCellHandle<number>(),
      });

      element.selectByIndex(0);
      await answersDelivered();
      element.selectByIndex(1);
      await answersDelivered();

      expect(indicesWritten(selectedIndex)).toEqual([1]);
    });

    it("writes nothing for a pick outside the list", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
      });

      element.selectByIndex(-1);
      element.selectByIndex(3);
      await answersDelivered();

      expect(indicesWritten(selectedIndex)).toEqual([]);
    });

    it("writes nothing while the worker refuses the selection's read", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
        selectedIndex: createMockCellHandle(1),
      });
      pushRefusal(selectedIndex);

      arrow(element, "right").click();
      arrow(element, "left").click();

      expect(writesSent(selectedIndex)).toEqual([]);
    });
  });

  describe("a key press", () => {
    for (
      const [key, written] of [
        ["ArrowRight", 2],
        ["ArrowDown", 2],
        ["ArrowLeft", 0],
        ["ArrowUp", 0],
        ["Home", 0],
        ["End", 2],
      ] as const
    ) {
      it(`selects index ${written} from index 1 on ${key}, and takes the key`, async () => {
        const { element, selectedIndex } = await pickerWith({
          items: threeItems(),
          selectedIndex: createMockCellHandle(1),
        });

        const event = press(element, key);
        await answersDelivered();

        expect(event.defaultPrevented).toBe(true);
        expect(indicesWritten(selectedIndex)).toEqual([written]);
      });
    }

    for (const key of ["Enter", " "]) {
      it(`fires \`cf-confirm\` for the selection on ${JSON.stringify(key)}`, async () => {
        const items = threeItems();
        const { element, selectedIndex, fired } = await pickerWith({
          items,
          selectedIndex: createMockCellHandle(1),
        }, ["cf-confirm"]);

        const event = press(element, key);

        expect(event.defaultPrevented).toBe(true);
        // The detail is compared field by field, as a failing comparison of
        // the item would print the whole handle.
        expect(fired.map(({ type }) => type)).toEqual(["cf-confirm"]);
        const { index, value } = fired[0].detail as {
          index: number;
          value: unknown;
        };
        expect(index).toBe(1);
        expect(value === items[1]).toBe(true);
        expect(writesSent(selectedIndex)).toEqual([]);
      });
    }

    it("leaves any other key alone", async () => {
      const { element, selectedIndex, fired } = await pickerWith({
        items: threeItems(),
      }, ["cf-confirm"]);

      const event = press(element, "a");
      await answersDelivered();

      expect(event.defaultPrevented).toBe(false);
      expect(writesSent(selectedIndex)).toEqual([]);
      expect(fired).toEqual([]);
    });

    it("does nothing on a disabled picker", async () => {
      const { element, selectedIndex, fired } = await pickerWith({
        items: threeItems(),
        disabled: true,
      }, ["cf-confirm"]);

      const event = press(element, "ArrowRight");
      press(element, "Enter");
      await answersDelivered();

      expect(event.defaultPrevented).toBe(false);
      expect(writesSent(selectedIndex)).toEqual([]);
      expect(fired).toEqual([]);
    });

    it("does nothing on an empty list", async () => {
      const { element, fired } = await pickerWith({ items: [] }, [
        "cf-confirm",
      ]);

      expect(press(element, "Enter").defaultPrevented).toBe(false);
      expect(fired).toEqual([]);
    });

    it("does nothing once the picker is removed from the page", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
      });
      element.remove();

      const event = press(element, "ArrowRight");
      await answersDelivered();

      expect(event.defaultPrevented).toBe(false);
      expect(writesSent(selectedIndex)).toEqual([]);
    });
  });

  describe("a swipe", () => {
    it("selects the next item on a swipe to the left, and the previous on one to the right", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
        selectedIndex: createMockCellHandle(1),
      });

      swipe(element, 200, 100);
      await answersDelivered();
      swipe(element, 100, 200);
      await answersDelivered();

      expect(indicesWritten(selectedIndex)).toEqual([2, 1]);
    });

    it("selects nothing for a movement of 50 pixels or less", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
      });

      swipe(element, 200, 150);
      swipe(element, 200, 250);
      await answersDelivered();

      expect(writesSent(selectedIndex)).toEqual([]);
    });

    it("selects nothing for a touch the browser canceled", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
      });
      const container = shadow(element).querySelector(".picker-container")!;
      const at = (clientX: number) => [
        new Touch({ identifier: 0, target: container, clientX }),
      ];

      container.dispatchEvent(
        new TouchEvent("touchstart", { touches: at(200) }),
      );
      container.dispatchEvent(new TouchEvent("touchcancel"));
      container.dispatchEvent(
        new TouchEvent("touchend", { changedTouches: at(0) }),
      );
      await answersDelivered();

      expect(writesSent(selectedIndex)).toEqual([]);
    });

    it("selects nothing on a disabled picker", async () => {
      const { element, selectedIndex } = await pickerWith({
        items: threeItems(),
        disabled: true,
      });

      swipe(element, 200, 0);
      await answersDelivered();

      expect(writesSent(selectedIndex)).toEqual([]);
    });

    it("selects nothing on an empty list", async () => {
      const { element, selectedIndex } = await pickerWith({ items: [] });

      swipe(element, 200, 0);
      await answersDelivered();

      expect(writesSent(selectedIndex)).toEqual([]);
    });
  });

  describe("focus", () => {
    it("fires `cf-focus` when focused and `cf-blur` when it loses focus", async () => {
      const { element, fired } = await pickerWith({ items: threeItems() }, [
        "cf-focus",
        "cf-blur",
      ]);

      element.dispatchEvent(new FocusEvent("focus"));
      element.dispatchEvent(new FocusEvent("blur"));

      expect(fired.map(({ type }) => type)).toEqual(["cf-focus", "cf-blur"]);
    });

    it("fires nothing once the picker is removed from the page", async () => {
      const { element, fired } = await pickerWith({ items: threeItems() }, [
        "cf-focus",
        "cf-blur",
      ]);
      element.remove();

      element.dispatchEvent(new FocusEvent("focus"));
      element.dispatchEvent(new FocusEvent("blur"));

      expect(fired).toEqual([]);
    });
  });

  describe("getSelectedIndex()", () => {
    it("returns the index the selection cell holds", async () => {
      const { element } = await pickerWith({
        items: threeItems(),
        selectedIndex: createMockCellHandle(2),
      });

      expect(element.getSelectedIndex()).toBe(2);
    });

    it("returns 0 for a selection cell holding nothing", async () => {
      const { element } = await pickerWith({
        items: threeItems(),
        selectedIndex: createMockCellHandle<number>(),
      });

      expect(element.getSelectedIndex()).toBe(0);
    });
  });

  describe("getSelectedItem()", () => {
    it("returns the selected item, or the last for a selection past the end", async () => {
      const items = threeItems();
      const { element: atOne } = await pickerWith({
        items,
        selectedIndex: createMockCellHandle(1),
      });
      const { element: pastEnd } = await pickerWith({
        items,
        selectedIndex: createMockCellHandle(7),
      });

      expect(atOne.getSelectedItem().ref().id).toBe("of:second");
      expect(pastEnd.getSelectedItem().ref().id).toBe("of:third");
    });

    it("returns `undefined` for an empty list, given as an array or as a cell", async () => {
      const { element: overArray } = await pickerWith({ items: [] });
      const overCell = await mount(
        Object.assign(new CFPicker(), {
          items: createMockCellHandle<unknown[]>([]),
          selectedIndex: createMockCellHandle(0),
        }),
      );

      expect(overArray.getSelectedItem() === undefined).toBe(true);
      expect(overCell.getSelectedItem() === undefined).toBe(true);
    });
  });
});
