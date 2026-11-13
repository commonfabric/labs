// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFDropZone } from "./index.ts";
import {
  endDrag,
  isDragging,
  startDrag,
  updateDragPointer,
} from "../../core/drag-state.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";

/**
 * A cell to drag, distinguishable by its id, whose ref carries the main
 * thread's display copy of its label.
 */
const cell = createMockCellHandle<unknown>({ title: "Card" }, {
  id: "of:dragged" as `${string}:${string}`,
  path: ["items", "2"],
  cfcLabelView: { version: 1, entries: [] },
});
const { id, space, path } = cell.ref();

/** Starts a drag of `cell` with the pointer at (`x`, `y`). */
function beginDrag(x: number, y: number, type?: string): void {
  startDrag({
    cell,
    type,
    sourceElement: document.createElement("div"),
    preview: document.createElement("div"),
    pointerX: x,
    pointerY: y,
  });
}

/**
 * Mounts a drop zone occupying the rectangle from (100, 100) to (200, 150),
 * and returns it with the `type` and `detail` of every event it dispatches
 * whose name starts with `cf-`.
 */
async function mountZone(accept?: string): Promise<{
  zone: CFDropZone;
  events: { type: string; detail: Record<string, unknown> }[];
}> {
  const zone = new CFDropZone();
  zone.accept = accept;
  // happy-dom lays nothing out, so the zone states where it is.
  zone.getBoundingClientRect = () => new DOMRect(100, 100, 100, 50);
  const events: { type: string; detail: Record<string, unknown> }[] = [];
  for (const type of ["cf-drag-enter", "cf-drag-leave", "cf-drop"]) {
    zone.addEventListener(type, (event) => {
      events.push({ type, detail: (event as CustomEvent).detail });
    });
  }
  await mount(zone);
  return { zone, events };
}

describe("CFDropZone", () => {
  afterEach(() => {
    if (isDragging()) endDrag();
    document.body.replaceChildren();
  });

  it("is registered as `cf-drop-zone`", () => {
    expect(customElements.get("cf-drop-zone")).toBe(CFDropZone);
  });

  it("renders its content through a slot", async () => {
    const { zone } = await mountZone();
    expect(zone.shadowRoot!.querySelector("slot")).not.toBeNull();
  });

  describe("while a drag moves", () => {
    it("dispatches `cf-drag-enter` and marks itself when the pointer comes over it", async () => {
      const { zone, events } = await mountZone();

      beginDrag(10, 10, "card");
      expect(events).toEqual([]);
      expect(zone.hasAttribute("drag-over")).toBe(false);

      updateDragPointer(150, 125);
      expect(events).toEqual([
        {
          type: "cf-drag-enter",
          detail: { sourceCell: cell.toSigilLink(), type: "card" },
        },
      ]);
      expect(zone.hasAttribute("drag-over")).toBe(true);

      // Moving within the zone dispatches nothing further.
      updateDragPointer(100, 150);
      expect(events).toHaveLength(1);
    });

    it("dispatches `cf-drag-leave` and unmarks itself when the pointer leaves it", async () => {
      const { zone, events } = await mountZone();
      beginDrag(150, 125);

      updateDragPointer(201, 125);
      expect(events.map((event) => event.type)).toEqual([
        "cf-drag-enter",
        "cf-drag-leave",
      ]);
      expect(zone.hasAttribute("drag-over")).toBe(false);

      // Moving about outside the zone dispatches nothing further.
      updateDragPointer(300, 300);
      expect(events).toHaveLength(2);
    });

    it("accepts a drag whose type is in its comma-separated `accept` list", async () => {
      const { events } = await mountZone("note, card");
      beginDrag(150, 125, "card");
      expect(events.map((event) => event.type)).toEqual(["cf-drag-enter"]);
    });

    it("ignores a drag whose type is not in its `accept` list", async () => {
      const { zone, events } = await mountZone("note");
      beginDrag(150, 125, "card");
      expect(events).toEqual([]);
      expect(zone.hasAttribute("drag-over")).toBe(false);
    });

    it("ignores a drag with no type when it has an `accept` list", async () => {
      const { events } = await mountZone("note");
      beginDrag(150, 125);
      expect(events).toEqual([]);
    });

    it("dispatches `cf-drag-leave` when its `accept` list stops admitting the drag over it", async () => {
      const { zone, events } = await mountZone();
      beginDrag(150, 125, "card");

      zone.accept = "note";
      updateDragPointer(151, 125);

      expect(events.map((event) => event.type)).toEqual([
        "cf-drag-enter",
        "cf-drag-leave",
      ]);
      expect(zone.hasAttribute("drag-over")).toBe(false);

      // Still refused, the drag dispatches nothing further.
      updateDragPointer(152, 125);
      expect(events).toHaveLength(2);
    });
  });

  describe("when a drag ends", () => {
    it("dispatches `cf-drag-leave` then `cf-drop` when the pointer is over it", async () => {
      const { zone, events } = await mountZone();
      beginDrag(150, 125, "card");
      updateDragPointer(160, 130);

      endDrag();

      expect(events).toEqual([
        {
          type: "cf-drag-enter",
          detail: { sourceCell: cell.toSigilLink(), type: "card" },
        },
        { type: "cf-drag-leave", detail: {} },
        {
          type: "cf-drop",
          detail: {
            sourceCell: cell.toSigilLink(),
            // The ref names the cell without its label's display copy.
            sourceCellRef: { id, space, path },
            type: "card",
            pointerX: 160,
            pointerY: 130,
            dropZoneRect: { left: 100, top: 100, width: 100, height: 50 },
          },
        },
      ]);
      expect(zone.hasAttribute("drag-over")).toBe(false);
    });

    it("dispatches nothing when the pointer is elsewhere", async () => {
      const { events } = await mountZone();
      beginDrag(10, 10, "card");
      endDrag();
      expect(events).toEqual([]);
    });

    it("dispatches `cf-drag-leave` but no `cf-drop` when its `accept` list stopped admitting the drag", async () => {
      const { zone, events } = await mountZone();
      beginDrag(150, 125, "card");

      zone.accept = "note";
      endDrag();

      expect(events.map((event) => event.type)).toEqual([
        "cf-drag-enter",
        "cf-drag-leave",
      ]);
      expect(zone.hasAttribute("drag-over")).toBe(false);
    });
  });

  it("dispatches nothing for a drag once removed from the document", async () => {
    const { zone, events } = await mountZone();
    zone.remove();

    beginDrag(150, 125, "card");
    endDrag();

    expect(events).toEqual([]);
  });
});
