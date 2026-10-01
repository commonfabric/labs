/**
 * Dragging the default chip `cf-render` shows for a piece, inside a drag
 * source of the page's own, with real DOM events.
 */

import { expect } from "@std/expect";
import type { CellRef } from "@commonfabric/runtime-client";

import { getCurrentDrag, isDragging } from "../../core/drag-state.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
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
