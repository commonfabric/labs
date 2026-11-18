// First, so that the document it installs is there when Lit loads.
import { mount } from "../../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../../test-utils/mock-cell-handle.ts";
import { CFDotMark } from "../index.ts";

/** Every `mark-update` event `target` hears from now on. */
function markUpdatesAt(target: EventTarget): Event[] {
  const seen: Event[] = [];
  target.addEventListener("mark-update", (event) => seen.push(event));
  return seen;
}

describe("MarkElement", () => {
  // `MarkElement` is abstract, so these cases drive it through `CFDotMark`.

  afterEach(() => document.body.replaceChildren());

  it("is not displayed", async () => {
    const mark = await mount(new CFDotMark());
    expect(getComputedStyle(mark).display).toBe("none");
  });

  describe("getData()", () => {
    it("returns an empty array before `data` is set", async () => {
      const mark = await mount(new CFDotMark());
      expect(mark.getData()).toEqual([]);
    });

    it("returns the `data` array it was given", async () => {
      const mark = await mount(new CFDotMark());
      mark.data = [{ v: 1 }, { v: 2 }];
      await mark.updateComplete;
      expect(mark.getData()).toEqual([{ v: 1 }, { v: 2 }]);

      mark.data = [3, 4, 5];
      await mark.updateComplete;
      expect(mark.getData()).toEqual([3, 4, 5]);
    });

    it("returns the value a bound `data` cell holds, and follows the cell", async () => {
      const cell = createMockCellHandle<number[]>([1, 2]);
      const mark = await mount(Object.assign(new CFDotMark(), { data: cell }));
      expect(mark.getData()).toEqual([1, 2]);

      pushUpdate(cell, [1, 2, 3]);
      expect(mark.getData()).toEqual([1, 2, 3]);
    });
  });

  describe("mark-update", () => {
    it("is emitted, bubbling out of the shadow tree, each time the mark updates", async () => {
      const parent = document.createElement("div");
      const updates = markUpdatesAt(parent);
      const mark = new CFDotMark();
      parent.append(mark);
      document.body.append(parent);
      await mark.updateComplete;
      expect(updates.length).toBe(1);
      expect(updates[0].bubbles).toBe(true);
      expect(updates[0].composed).toBe(true);

      mark.color = "red";
      await mark.updateComplete;
      expect(updates.length).toBe(2);
    });

    it("is emitted when a bound `data` cell changes, and not otherwise", async () => {
      const cell = createMockCellHandle<number[]>([1, 2]);
      const mark = await mount(Object.assign(new CFDotMark(), { data: cell }));
      const updates = markUpdatesAt(mark);
      await mark.updateComplete;
      expect(updates.length).toBe(0);

      pushUpdate(cell, [1, 2, 3]);
      expect(updates.length).toBe(1);
    });
  });
});
