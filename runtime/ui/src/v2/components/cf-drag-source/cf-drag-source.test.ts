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
  const piece = createRenderableCellHandle<unknown>(
    { $UI: { type: "vnode", name: "div", props: {}, children: [] } },
    { id: id as `${string}:${string}` },
  );
  // The piece holds no link, so it resolves to itself.
  piece.cell.resolveAsCell = () => Promise.resolve(piece.cell);
  return piece;
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
 * `source`, and returns once the press has resolved the cell it drags.
 * happy-dom does not route an event from slotted content through the slot into
 * the shadow tree, so this hands the shadow tree's `pointerdown` listener the
 * event a browser would deliver to it.
 */
async function press(
  source: CFDragSource,
  target: Element,
  x: number,
  y: number,
  pointerId = 1,
): Promise<void> {
  pressWithoutWaiting(source, target, x, y, pointerId);
  await source.accessForTestingOnly.press;
}

/** Presses as `press()` does, returning before the press has resolved. */
function pressWithoutWaiting(
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
      await press(source, source.querySelector("span")!, 10, 10);

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
      await press(source, source.querySelector("span")!, 10, 10);

      pointer("pointermove", 40, 60);

      const drag = getCurrentDrag()!;
      expect(drag.preview.parentNode).toBe(document.body);
      expect(previewPosition()).toEqual(["50px", "70px"]);
    });

    it("captures the pointer and marks its body as dragging", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      await press(source, source.querySelector("span")!, 10, 10, 7);
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
        await press(source, target, 10, 10);
        pointer("pointermove", 50, 50);
      }

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });

    it("does not start a drag while disabled", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell, disabled: true });

      await press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });

    it("does not start a drag without a cell", async () => {
      const { source, events } = await mountSource({});

      await press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });

    it("does not start a drag once its cell is taken away mid-press", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      await press(source, source.querySelector("span")!, 10, 10);

      source.cell = undefined;
      pointer("pointermove", 50, 50);

      expect(isDragging()).toBe(false);
    });

    it("does not start a drag for the movement of another pointer", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      await press(source, source.querySelector("span")!, 10, 10, 1);

      pointer("pointermove", 50, 50, 2);

      expect(isDragging()).toBe(false);
    });
  });

  describe("during a drag", () => {
    it("moves the preview and the drag's pointer with the pointer", async () => {
      const { cell } = pieceCell();
      const { source } = await mountSource({ cell });
      await press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 20, 20);

      pointer("pointermove", 80, 90);

      const drag = getCurrentDrag()!;
      expect([drag.pointerX, drag.pointerY]).toEqual([80, 90]);
      expect(previewPosition()).toEqual(["90px", "100px"]);
    });

    it("ignores the movement and release of another pointer", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell });
      await press(source, source.querySelector("span")!, 10, 10, 1);
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
        await press(source, source.querySelector("span")!, 10, 10);
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
      await press(source, source.querySelector("span")!, 10, 10);
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
      await press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 20, 20);
      expect(log.detached).toBe(false);

      pointer("pointerup", 20, 20);

      expect(log.detached).toBe(true);
    });

    it("dispatches no `cf-drag-end` for a press released without a drag", async () => {
      const { cell } = pieceCell();
      const { source, events } = await mountSource({ cell });
      await press(source, source.querySelector("span")!, 10, 10);

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
      await press(source, source.querySelector("span")!, 10, 10);

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
        await press(source, source.querySelector("span")!, 10, 10);
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
    // A bound cell may hold a link. What a drag carries is the cell the link
    // leads to when the press begins: a `.map()` row keeps its bound cell
    // while the list moves another entry into that row.

    /**
     * A cell holding a link to `target`, whose target the test moves with
     * `moveTo()`. Each resolution waits for `resolution` and lands on the
     * target as it then stands.
     */
    function linkCell(
      target: CellHandle,
      resolution: Promise<void> = Promise.resolve(),
    ) {
      const { cell: link } = pieceCell("of:link");
      let current = target;
      link.resolveAsCell = () => resolution.then(() => current);
      const moveTo = (next: CellHandle) => {
        current = next;
      };
      return { link, moveTo };
    }

    /** Drags `source`, ends the drag, and returns the cell it carried. */
    async function draggedCell(source: CFDragSource): Promise<CellHandle> {
      await press(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 50, 50);
      const { cell } = getCurrentDrag()!;
      pointer("pointerup", 50, 50);
      return cell;
    }

    it("is the cell its bound cell resolves to", async () => {
      const { cell: target } = pieceCell("of:target");
      const { link } = linkCell(target);
      const { source } = await mountSource({ cell: link });

      expect(await draggedCell(source)).toBe(target);
    });

    it("is the cell its bound cell resolves to when the press begins", async () => {
      const { cell: first } = pieceCell("of:first");
      const { cell: second } = pieceCell("of:second");
      const { link, moveTo } = linkCell(first);
      const { source } = await mountSource({ cell: link });
      const before = await draggedCell(source);

      moveTo(second);

      expect([before, await draggedCell(source)]).toEqual([first, second]);
    });

    it("is the bound cell where resolving it fails", async () => {
      const { cell: link } = pieceCell("of:link");
      link.resolveAsCell = () => Promise.reject(new Error("refused"));
      const { source } = await mountSource({ cell: link });
      const error = console.error;
      console.error = () => {};
      try {
        expect(await draggedCell(source)).toBe(link);
      } finally {
        console.error = error;
      }
    });

    it("is what the cell bound mid-press resolves to", async () => {
      const { link } = linkCell(pieceCell("of:stale").cell);
      const { cell: target } = pieceCell("of:target");
      const { link: next } = linkCell(target);
      const { source } = await mountSource({ cell: link });
      await press(source, source.querySelector("span")!, 10, 10);

      source.cell = next;
      await source.updateComplete;
      await source.accessForTestingOnly.press;
      pointer("pointermove", 50, 50);

      expect(getCurrentDrag()!.cell).toBe(target);
    });

    it("starts no drag until the press has resolved, then starts one where the pointer is", async () => {
      const resolution = Promise.withResolvers<void>();
      const { cell: target } = pieceCell("of:target");
      const { link } = linkCell(target, resolution.promise);
      const { source, events } = await mountSource({ cell: link });
      pressWithoutWaiting(source, source.querySelector("span")!, 10, 10);
      pointer("pointermove", 30, 30);
      pointer("pointermove", 40, 60);
      expect(isDragging()).toBe(false);

      resolution.resolve();
      await source.accessForTestingOnly.press;

      const drag = getCurrentDrag()!;
      expect(drag.cell).toBe(target);
      expect([drag.pointerX, drag.pointerY]).toEqual([40, 60]);
      expect(events).toEqual([{
        type: "cf-drag-start",
        detail: { cell: target.toSigilLink() },
      }]);
    });

    it("starts no drag from a press released before it resolved", async () => {
      const resolution = Promise.withResolvers<void>();
      const { link } = linkCell(
        pieceCell("of:target").cell,
        resolution.promise,
      );
      const { source, events } = await mountSource({ cell: link });
      pressWithoutWaiting(source, source.querySelector("span")!, 10, 10);
      const press = source.accessForTestingOnly.press;
      pointer("pointermove", 40, 60);
      pointer("pointerup", 40, 60);

      resolution.resolve();
      await press;

      expect(isDragging()).toBe(false);
      expect(events).toEqual([]);
    });
  });
});
