import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CellHandle } from "@commonfabric/runtime-client";
import { CFDropZone } from "./index.ts";
import type { DragState } from "../../core/drag-state.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";

/** A drag of a cell whose ref carries a main-thread label display copy. */
function dragOf(type: string): { state: DragState; cell: CellHandle } {
  const { cell } = createRenderableCellHandle({ title: "Item C" }, {
    id: "of:dragged-item",
    path: ["items", "2"],
    cfcLabelView: { confidentiality: [], integrity: [] },
  } as never);
  const state = {
    cell,
    type,
    sourceElement: {} as HTMLElement,
    preview: {} as HTMLElement,
    pointerX: 12,
    pointerY: 34,
  } as DragState;
  return { state, cell: cell as CellHandle };
}

/** A drop zone over the box (0, 0)-(100, 50), recording what it emits. */
function dropZone(): { zone: any; emitted: Map<string, unknown> } {
  const zone = new CFDropZone() as any;
  zone.accept = "item";
  zone.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 100,
    bottom: 50,
    width: 100,
    height: 50,
  });
  const emitted = new Map<string, unknown>();
  zone.emit = (name: string, detail: unknown) => {
    emitted.set(name, detail);
    return true;
  };
  return { zone, emitted };
}

describe("CFDropZone", () => {
  it("is registered as `cf-drop-zone`", () => {
    expect(customElements.get("cf-drop-zone")).toBe(CFDropZone);
  });

  it("names the dragged cell by link when a drag enters", () => {
    // A detail crosses to the worker as data, which a handle is not.

    const { zone, emitted } = dropZone();
    const { state, cell } = dragOf("item");

    zone._setDragOver(true, state);

    expect(emitted.get("cf-drag-enter")).toEqual({
      sourceCell: cell.toSigilLink(),
      type: "item",
    });
  });

  it("names the dropped cell by link and by a ref with no label display copy", () => {
    const { zone, emitted } = dropZone();
    const { state, cell } = dragOf("item");
    zone._setDragOver(true, state);

    zone._handleDragEnd(state);

    const { id, space, path } = cell.ref();
    expect(emitted.get("cf-drop")).toEqual({
      sourceCell: cell.toSigilLink(),
      sourceCellRef: { id, space, path },
      type: "item",
      pointerX: 12,
      pointerY: 34,
      dropZoneRect: { left: 0, top: 0, width: 100, height: 50 },
    });
  });
});
