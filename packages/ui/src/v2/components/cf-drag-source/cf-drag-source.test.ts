import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CellHandle } from "@commonfabric/runtime-client";
import { CFDragSource } from "./index.ts";
import { installMockDocument } from "../../test-utils/mock-document.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
import { endDrag, getCurrentDrag, isDragging } from "../../core/drag-state.ts";

/** The subset of a PointerEvent the drag handlers read. */
function pointerEvent(x: number, y: number): PointerEvent {
  return {
    clientX: x,
    clientY: y,
    pointerId: 1,
    stopPropagation: () => {},
    preventDefault: () => {},
  } as unknown as PointerEvent;
}

describe("CFDragSource", () => {
  let mockDocument: ReturnType<typeof installMockDocument>;

  beforeEach(() => {
    mockDocument = installMockDocument();
  });

  afterEach(() => {
    if (isDragging()) endDrag();
    mockDocument.restore();
  });

  it("is registered as `cf-drag-source`", () => {
    expect(customElements.get("cf-drag-source")).toBe(CFDragSource);
  });

  it("starting a drag publishes the preview and its teardown", () => {
    const { cell } = createRenderableCellHandle({
      $UI: { type: "vnode", name: "div", props: {}, children: [] },
    });
    const element = new CFDragSource() as any;
    element._resolvedCell = cell;
    element.type = "note";

    element._startDrag(pointerEvent(40, 60));

    const drag = getCurrentDrag();
    expect(drag).not.toBeNull();
    expect(drag!.cell).toBe(cell as CellHandle);
    expect(drag!.type).toBe("note");
    expect(drag!.sourceElement).toBe(element);
    // The render's teardown travels with the drag, so ending it stops the
    // preview's render rather than leaving it mounted.
    expect(typeof drag!.previewCleanup).toBe("function");

    // The preview is placed in the document and positioned near the pointer.
    expect(mockDocument.document.body.children).toContain(drag!.preview);
    expect(
      (drag!.preview as unknown as { style: Record<string, string> }).style,
    )
      .toMatchObject({ left: "50px", top: "70px" });
  });

  it("carries the teardown of the render that names the cell in its preview", () => {
    // A cell with nothing cached renders no piece; its preview names it
    // through a render of its own, which the drag state tears down.
    const { cell } = createRenderableCellHandle(undefined);
    const element = new CFDragSource() as any;
    element._resolvedCell = cell;

    element._startDrag(pointerEvent(0, 0));

    expect(getCurrentDrag()!.previewCleanup).toBeDefined();
  });

  it("runs the preview teardown once when the drag ends", () => {
    const { cell, log } = createRenderableCellHandle({
      $UI: { type: "vnode", name: "div", props: {}, children: [] },
    });
    const element = new CFDragSource() as any;
    element._resolvedCell = cell;

    element._startDrag(pointerEvent(10, 10));
    let cleanupCalls = 0;
    const real = getCurrentDrag()!.previewCleanup!;
    getCurrentDrag()!.previewCleanup = () => {
      cleanupCalls++;
      real();
    };

    endDrag();

    expect(cleanupCalls).toBe(1);
    expect(isDragging()).toBe(false);
    expect(log.attached).toBe(true);
  });

  it("does not start a drag without a cell", () => {
    const element = new CFDragSource() as any;
    element._startDrag(pointerEvent(0, 0));
    expect(isDragging()).toBe(false);
  });
});
