// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CellHandle } from "@commonfabric/runtime-client";

import { CFDragSource } from "./index.ts";
import {
  endDrag,
  getCurrentDrag,
  isDragging,
  subscribeToEndDrag,
} from "../../core/drag-state.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
import { boundHandler } from "../../test-utils/template.ts";

/** A cell whose value renders a piece, with the log its render writes to. */
function pieceCell(id = "of:piece") {
  return createRenderableCellHandle<unknown>(
    { $UI: { type: "vnode", name: "div", props: {}, children: [] } },
    { id: id as `${string}:${string}` },
  );
}

/**
 * Mounts a drag source holding `content` with `properties`, and returns it
 * with the `type` and `detail` of every `cf-drag-start` and `cf-drag-end` it
 * dispatches.
 */
async function mountSource(
  properties: Partial<CFDragSource>,
  content = "<span>Card</span><button>Edit</button>",
): Promise<{
  source: CFDragSource;
  events: { type: string; detail: unknown }[];
}> {
  const source = Object.assign(new CFDragSource(), properties);
  source.innerHTML = content;
  const events: { type: string; detail: unknown }[] = [];
  for (const type of ["cf-drag-start", "cf-drag-end"]) {
    source.addEventListener(type, (event) => {
      events.push({ type, detail: (event as CustomEvent).detail });
    });
  }
  await mount(source);
  return { source, events };
}

/**
 * Presses pointer `pointerId` at (`x`, `y`) on `target`, content slotted into
 * `source`. happy-dom does not route an event from slotted content through the
 * slot into the shadow tree, so this hands the shadow tree's `pointerdown`
 * listener the event a browser would deliver to it.
 */
function press(
  source: CFDragSource,
  target: Element,
  x: number,
  y: number,
  pointerId = 1,
): void {
  boundHandler<
    Pick<PointerEvent, "target" | "clientX" | "clientY" | "pointerId">
  >(source.render(), "@pointerdown", source)({
    target,
    clientX: x,
    clientY: y,
    pointerId,
  });
}

/** Dispatches pointer event `type` at (`x`, `y`) on the document. */
function pointer(type: string, x: number, y: number, pointerId = 1): void {
  document.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, pointerId }),
  );
}

/** The element in `source`'s shadow tree that the pointer drags by. */
function dragBody(source: CFDragSource): HTMLElement {
  return source.shadowRoot!.querySelector<HTMLElement>(".drag-body")!;
}

/** The inline position of the drag's preview. */
function previewPosition(): [string, string] {
  const { style } = getCurrentDrag()!.preview;
  return [style.left, style.top];
}

describe("CFDragSource", () => {
  afterEach(() => {
    if (isDragging()) endDrag();
    document.body.replaceChildren();
  });

  it("is registered as `cf-drag-source`", () => {
    expect(customElements.get("cf-drag-source")).toBe(CFDragSource);
  });

  describe("starting a drag", () => {
    it("starts a drag of its cell once the pointer moves more than five pixels", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell, type: "card" });
      press(source, source.querySelector("span")!, 10, 10);

      pointer("pointermove", 13, 14);
      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);

      pointer("pointermove", 14, 14);
      const drag = getCurrentDrag()!;
      expect(drag.cell).toBe(cell);
      expect(drag.type).toBe("card");
      expect(drag.sourceElement).toBe(source);
      expect([drag.pointerX, drag.pointerY]).toEqual([14, 14]);
      expect(events).toEqual([{
        type: "cf-drag-start",
        detail: { cell: cell.toSigilLink() },
      }]);
    });

    it("shows a preview of its cell beside the pointer", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10);

      pointer("pointermove", 40, 60);

      const drag = getCurrentDrag()!;
      expect(drag.preview.parentNode).toBe(document.body);
      expect(previewPosition()).toEqual(["50px", "70px"]);
    });

    it("captures the pointer and marks its body as dragging", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10, 7);
      expect(dragBody(source).hasPointerCapture(7)).toBe(false);

      pointer("pointermove", 30, 30, 7);

      expect(dragBody(source).hasPointerCapture(7)).toBe(true);
      expect(dragBody(source).classList.contains("dragging")).toBe(true);
    });

    it("does not start a drag from a press on a control in its content", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({
        cell,
      }, "<a href='#'><span>Open</span></a><div role='button'>Go</div>");

      for (
        const target of [
          source.querySelector("span")!,
          source.lastElementChild!,
        ]
      ) {
        press(source, target, 10, 10);
        pointer("pointermove", 50, 50);
      }

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });

    it("does not start a drag while disabled", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell, disabled: true });

      press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });

    it("does not start a drag without a cell", async () => {
      const { source, events } = await mountSource({});

      press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });

    it("does not start a drag once its cell is taken away mid-press", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10);

      source.cell = undefined;
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
    });

    it("does not start a drag for the movement of another pointer", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10, 1);

      pointer("pointermove", 50, 50, 2);

      expect(isDragging()).toBe(false);
    });
  });

  describe("during a drag", () => {
    it("moves the preview and the drag's pointer with the pointer", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 20, 20);

      pointer("pointermove", 80, 90);

      const drag = getCurrentDrag()!;
      expect([drag.pointerX, drag.pointerY]).toEqual([80, 90]);
      expect(previewPosition()).toEqual(["90px", "100px"]);
    });

    it("ignores the movement and release of another pointer", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10, 1);
      pointer("pointermove", 20, 20, 1);

      pointer("pointermove", 80, 90, 2);
      pointer("pointerup", 80, 90, 2);

      const drag = getCurrentDrag()!;
      expect([drag.pointerX, drag.pointerY]).toEqual([20, 20]);
      expect(events.map((event) => event.type)).toEqual(["cf-drag-start"]);
    });
  });

  describe("ending a drag", () => {
    for (const type of ["pointerup", "pointercancel"]) {
      it(`ends the drag and dispatches \`cf-drag-end\` on \`${type}\``, async () => {
        const { cell } = pieceCell();
        const { source, events } = await mountSource({ cell });
        press(source, source.querySelector("span")!, 10, 10);
        pointer("pointermove", 20, 20);
        const { preview } = getCurrentDrag()!;

        pointer(type, 20, 20);

        expect(isDragging()).toBe(false);
        expect(preview.parentNode).toBeNull();
        expect(dragBody(source).classList.contains("dragging")).toBe(false);
        expect(events).toEqual([
          { type: "cf-drag-start", detail: { cell: cell.toSigilLink() } },
          { type: "cf-drag-end", detail: { cell: cell.toSigilLink() } },
        ]);
      });
    }

    it("ends the drag of the cell it started with once its cell is taken away mid-drag", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 20, 20);
      const { preview } = getCurrentDrag()!;

      source.cell = undefined;
      await source.updateComplete;
      pointer("pointerup", 20, 20);

      expect(isDragging()).toBe(false);
      expect(preview.parentNode).toBeNull();
      expect(events).toEqual([
        { type: "cf-drag-start", detail: { cell: cell.toSigilLink() } },
        { type: "cf-drag-end", detail: { cell: cell.toSigilLink() } },
      ]);
    });

    it("stops the render filling the preview", async () => {
      const { cell, log } = pieceCell();
      const { source } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 20, 20);
      expect(log.detached).toBe(false);

      pointer("pointerup", 20, 20);

      expect(log.detached).toBe(true);
    });

    it("dispatches no `cf-drag-end` for a press released without a drag", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10);

      pointer("pointerup", 12, 12);
      // Released, the pointer no longer drags it.
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });
  });

  describe("once removed from the document", () => {
    it("starts no drag from a press made before it was removed", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell });
      press(source, source.querySelector("span")!, 10, 10);

      source.remove();
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });

    it("carries on the drag it started until the pointer is released", async () => {
      // A list reordering mid-drag removes the source; the drag goes on, and
      // drop zones see it end only on release.

      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell });
      let endings = 0;
      const unsubscribe = subscribeToEndDrag(() => endings++);
      try {
        press(source, source.querySelector("span")!, 10, 10);
        pointer("pointermove", 20, 20);

        source.remove();
        pointer("pointermove", 40, 60);

        expect(isDragging()).toBe(true);
        expect(previewPosition()).toEqual(["50px", "70px"]);
        expect(endings).toBe(0);
        expect(events).toEqual([{
          type: "cf-drag-start",
          detail: { cell: cell.toSigilLink() },
        }]);

        pointer("pointerup", 40, 60);

        expect(isDragging()).toBe(false);
        expect(endings).toBe(1);
        expect(events).toEqual([
          { type: "cf-drag-start", detail: { cell: cell.toSigilLink() } },
          { type: "cf-drag-end", detail: { cell: cell.toSigilLink() } },
        ]);
      } finally {
        unsubscribe();
      }
    });
  });

  describe("the cell it drags", () => {
    // A bound cell may be a link; what a drop zone receives is the cell it
    // resolves to, once known.

    /** A cell whose resolution the test settles. */
    function linkCell() {
      const { cell: link } = pieceCell("of:link");
      const resolution = Promise.withResolvers<CellHandle>();
      link.resolveAsCell = () => resolution.promise;
      return { link, resolution };
    }

    /** Drags `source` and returns the cell its drag carries. */
    function draggedCell(source: CFDragSource): CellHandle {
      press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 50, 50);
      return getCurrentDrag()!.cell;
    }

    it("is the cell its bound cell resolves to", async () => {
      const { link, resolution } = linkCell();
      const { source } = await mountSource({ cell: link });
      const { cell: target } = pieceCell("of:target");

      resolution.resolve(target);
      await resolution.promise;

      expect(draggedCell(source)).toBe(target);
    });

    it("is the bound cell while its resolution is pending", async () => {
      const { link } = linkCell();
      const { source } = await mountSource({ cell: link });

      expect(draggedCell(source)).toBe(link);
    });

    it("is not the resolution of a cell it was bound to before", async () => {
      const { link, resolution } = linkCell();
      const { source } = await mountSource({ cell: link });
      resolution.resolve(pieceCell("of:stale").cell);
      await resolution.promise;

      const { link: next } = linkCell();
      source.cell = next;
      await source.updateComplete;

      expect(draggedCell(source)).toBe(next);
    });
  });
});
