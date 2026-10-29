/**
 * Dragging the default chip `cf-render` shows for a piece, inside a drag
 * source of the page's own, with real DOM events.
 */

import { expect } from "@std/expect";
import type { CellRef } from "@commonfabric/runtime-client";

import { getCurrentDrag, isDragging } from "../../core/drag-state.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
import "../cf-cell-link/index.ts";
import "../cf-drag-source/index.ts";
// The entrypoint registers cf-render in the browser.
import "./index.ts";
import type { CFRender } from "./index.ts";

/** The drag previews in the page, which drag sources add to the body. */
function previews(): Element[] {
  return [...document.body.children].filter((element) =>
    element instanceof HTMLElement && element.style.position === "fixed"
  );
}

Deno.test("a default chip inside a drag source starts one cell-link drag, and leaves no preview behind", async () => {
  const { cell } = createRenderableCellHandle<unknown>(undefined, {
    id: "of:fid1:dragged-abcdef" as CellRef["id"],
  });
  Object.assign(cell.runtime(), { signal: new AbortController().signal });
  cell.resolveAsCell = () => Promise.resolve(cell);

  const outer = document.createElement("cf-drag-source");
  outer.type = "note";
  outer.cell = cell;
  const element = document.createElement("cf-render") as CFRender;
  element.variant = "chip";
  element.cell = cell;
  outer.append(element);
  document.body.append(outer);

  try {
    await element.updateComplete;
    await element.accessForTestingOnly.renderCell();
    const chip = element.shadowRoot?.querySelector("cf-chip");
    if (!chip) throw new Error("the default chip did not render");
    const pointer = { bubbles: true, composed: true, pointerId: 1 };
    chip.dispatchEvent(
      new PointerEvent("pointerdown", { ...pointer, clientX: 10, clientY: 10 }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", { ...pointer, clientX: 40, clientY: 40 }),
    );

    expect(getCurrentDrag()?.type).toBe("cell-link");
    expect(previews()).toHaveLength(1);

    document.dispatchEvent(
      new PointerEvent("pointerup", { ...pointer, clientX: 40, clientY: 40 }),
    );

    expect(isDragging()).toBe(false);
    expect(previews()).toHaveLength(0);
  } finally {
    outer.remove();
  }
});

/**
 * Presses the pointer on `target`, moves it past the drag threshold when
 * `dragged`, releases it, and, when `clicked`, dispatches the click a browser
 * follows a release over the element it was pressed on with. Returns the
 * navigations that followed.
 */
function pressAndRelease(
  target: Element,
  dragged: boolean,
  clicked = true,
): unknown[] {
  const navigations: unknown[] = [];
  const listener = (event: Event) =>
    navigations.push((event as CustomEvent).detail);
  globalThis.addEventListener("cf-navigate", listener);
  try {
    const pointer = { bubbles: true, composed: true, pointerId: 1 };
    const at = dragged ? 40 : 10;
    target.dispatchEvent(
      new PointerEvent("pointerdown", { ...pointer, clientX: 10, clientY: 10 }),
    );
    if (dragged) {
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          ...pointer,
          clientX: at,
          clientY: at,
        }),
      );
    }
    document.dispatchEvent(
      new PointerEvent("pointerup", { ...pointer, clientX: at, clientY: at }),
    );
    if (clicked) {
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
    }
  } finally {
    globalThis.removeEventListener("cf-navigate", listener);
  }
  return navigations;
}

Deno.test("a drag of a default chip, or of a cell link, does not navigate, and a click after it does", async () => {
  // A drag released over something else gets no click on the chip, and the
  // click after it still navigates.

  const { cell } = createRenderableCellHandle<unknown>(undefined, {
    id: "of:fid1:dragged-abcdef" as CellRef["id"],
  });
  Object.assign(cell.runtime(), { signal: new AbortController().signal });
  cell.resolveAsCell = () => Promise.resolve(cell);

  const element = document.createElement("cf-render") as CFRender;
  element.variant = "chip";
  element.cell = cell;
  const link = document.createElement("cf-cell-link");
  link.cell = cell;
  document.body.append(element, link);

  try {
    await element.updateComplete;
    await element.accessForTestingOnly.renderCell();
    await link.updateComplete;
    const chips = {
      "default chip": element.shadowRoot?.querySelector("cf-chip"),
      "cell link": link.shadowRoot?.querySelector("cf-chip"),
    };
    const outcomes: Record<string, number[]> = {};
    for (const [id, chip] of Object.entries(chips)) {
      if (!chip) throw new Error(`the ${id} did not render`);
      outcomes[id] = [
        pressAndRelease(chip, true).length,
        pressAndRelease(chip, false).length,
        pressAndRelease(chip, true, false).length,
        pressAndRelease(chip, false).length,
      ];
    }
    expect(outcomes).toEqual({
      "default chip": [0, 1, 0, 1],
      "cell link": [0, 1, 0, 1],
    });
  } finally {
    element.remove();
    link.remove();
  }
});
