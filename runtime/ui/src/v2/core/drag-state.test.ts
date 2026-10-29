import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  $conn,
  type CellHandle,
  type CellRef,
} from "@commonfabric/runtime-client";
import { createMockCellHandle } from "../test-utils/mock-cell-handle.ts";
import {
  installMockDocument,
  type MockElement,
} from "../test-utils/mock-document.ts";
import { createRenderableCellHandle } from "../test-utils/mock-vdom-connection.ts";
import {
  createDragPreview,
  type DragState,
  endDrag,
  getCurrentDrag,
  isDragging,
  startDrag,
  subscribeToDrag,
  subscribeToEndDrag,
  updateDragPointer,
} from "./drag-state.ts";

/** Create a minimal DragState for testing (no real DOM elements). */
function createMockDragState(overrides?: Partial<DragState>): DragState {
  return {
    cell: createMockCellHandle({ name: "test" }) as CellHandle,
    sourceElement: {} as HTMLElement,
    preview: { parentNode: null } as unknown as HTMLElement,
    pointerX: 0,
    pointerY: 0,
    ...overrides,
  };
}

/** Reset module-level singleton state between tests. */
function cleanup() {
  // End any active drag to reset state
  if (isDragging()) {
    endDrag();
  }
}

//
// Core state management
//

describe("drag-state — core", () => {
  afterEach(cleanup);

  it("isDragging() is false initially", () => {
    expect(isDragging()).toBe(false);
    expect(getCurrentDrag()).toBeNull();
  });

  it("startDrag sets active drag state", () => {
    const state = createMockDragState();
    startDrag(state);
    expect(isDragging()).toBe(true);
    expect(getCurrentDrag()).toBe(state);
  });

  it("endDrag clears drag state", () => {
    startDrag(createMockDragState());
    endDrag();
    expect(isDragging()).toBe(false);
    expect(getCurrentDrag()).toBeNull();
  });

  it("endDrag is a no-op when not dragging", () => {
    endDrag(); // should not throw
    expect(isDragging()).toBe(false);
  });

  it("endDrag calls previewCleanup if provided", () => {
    let cleaned = false;
    startDrag(createMockDragState({
      previewCleanup: () => {
        cleaned = true;
      },
    }));
    endDrag();
    expect(cleaned).toBe(true);
  });

  it("endDrag removes preview from parent if attached", () => {
    let childRemoved = false;
    const mockParent = {
      removeChild: () => {
        childRemoved = true;
      },
    };
    startDrag(createMockDragState({
      preview: { parentNode: mockParent } as unknown as HTMLElement,
    }));
    endDrag();
    expect(childRemoved).toBe(true);
  });
});

//
// Pointer updates
//

describe("drag-state — pointer updates", () => {
  afterEach(cleanup);

  it("updateDragPointer updates position on active drag", () => {
    startDrag(createMockDragState());
    updateDragPointer(100, 200);

    const state = getCurrentDrag()!;
    expect(state.pointerX).toBe(100);
    expect(state.pointerY).toBe(200);
  });

  it("updateDragPointer is a no-op when not dragging", () => {
    updateDragPointer(50, 50); // should not throw
  });
});

//
// Subscribers
//

describe("drag-state — subscribeToDrag", () => {
  afterEach(cleanup);

  it("calls listener immediately with current state", () => {
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    expect(received).toEqual([null]); // no active drag
  });

  it("calls listener immediately with active drag state", () => {
    const state = createMockDragState();
    startDrag(state);

    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    expect(received[0]).toBe(state);
  });

  it("notifies on startDrag", () => {
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    received.length = 0; // clear initial

    const state = createMockDragState();
    startDrag(state);
    expect(received.length).toBe(1);
    expect(received[0]).toBe(state);
  });

  it("notifies with null on endDrag", () => {
    startDrag(createMockDragState());
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    received.length = 0;

    endDrag();
    const lastNotification = received[received.length - 1];
    expect(lastNotification).toBeNull();
  });

  it("notifies on updateDragPointer", () => {
    startDrag(createMockDragState());
    const received: (DragState | null)[] = [];
    subscribeToDrag((s) => received.push(s));
    received.length = 0;

    updateDragPointer(42, 84);
    expect(received.length).toBe(1);
    expect(received[0]!.pointerX).toBe(42);
    expect(received[0]!.pointerY).toBe(84);
  });

  it("unsubscribe stops notifications", () => {
    const received: (DragState | null)[] = [];
    const unsub = subscribeToDrag((s) => received.push(s));
    received.length = 0;

    unsub();
    startDrag(createMockDragState());
    expect(received).toEqual([]);
  });
});

//
// End drag subscribers
//

describe("drag-state — subscribeToEndDrag", () => {
  afterEach(cleanup);

  it("fires with final state before cleanup", () => {
    const state = createMockDragState();
    startDrag(state);

    const endStates: DragState[] = [];
    subscribeToEndDrag((s) => endStates.push(s));

    endDrag();
    expect(endStates.length).toBe(1);
    expect(endStates[0]).toBe(state);
  });

  it("does not fire when endDrag is called with no active drag", () => {
    const endStates: DragState[] = [];
    subscribeToEndDrag((s) => endStates.push(s));

    endDrag();
    expect(endStates).toEqual([]);
  });

  it("unsubscribe stops end notifications", () => {
    const endStates: DragState[] = [];
    const unsub = subscribeToEndDrag((s) => endStates.push(s));
    unsub();

    startDrag(createMockDragState());
    endDrag();
    expect(endStates).toEqual([]);
  });
});

describe("drag-state — createDragPreview", () => {
  let mockDocument: ReturnType<typeof installMockDocument>;

  /** The preview is built by the mock document, so read it back as one. */
  const asMock = (element: HTMLElement) => element as unknown as MockElement;

  beforeEach(() => {
    mockDocument = installMockDocument();
  });

  afterEach(() => {
    mockDocument.restore();
    cleanup();
  });

  /**
   * Builds the preview for a cell caching `value`, settles the mount it
   * starts, and returns what it built and mounted.
   */
  const fallbackPreview = async (value: unknown) => {
    const { cell, log } = createRenderableCellHandle(value, {
      id: "of:fid1:dragged-abcdef" as CellRef["id"],
    });
    const { preview, cleanup: teardown } = createDragPreview(
      cell as CellHandle,
    );
    await Promise.resolve();
    await Promise.resolve();
    const [chip] = asMock(preview).children;
    return {
      teardown,
      tags: asMock(preview).children.map((child) => child.tagName),
      texts: chip?.children.map((child) => child.textContent),
      mounted: log.mounted.map((reference) => reference.path),
    };
  };

  it("falls back to a chip whose name is a render of its own when the cell has no cached value", async () => {
    const preview = await fallbackPreview(undefined);

    expect(preview.teardown).toBeDefined();
    expect(preview.tags).toEqual(["cf-chip"]);
    expect(preview.texts).toEqual(["", " #abcdef"]);
    expect(preview.mounted).toEqual([["$NAME"]]);
  });

  it("falls back to a name chip, and shows no name it reads itself, when the cached value carries no `[UI]`", async () => {
    // The cached value holds a name the viewer may not see; only the render
    // of `[NAME]`, which the render policy decides, may show it.

    const preview = await fallbackPreview({ $NAME: "name-behind-the-seal" });

    expect(preview.tags).toEqual(["cf-chip"]);
    expect(preview.texts).toEqual(["", " #abcdef"]);
    expect(preview.mounted).toEqual([["$NAME"]]);
  });

  it("falls back to a name chip for a primitive cached value", async () => {
    const preview = await fallbackPreview("just a string");

    expect(preview.tags).toEqual(["cf-chip"]);
    expect(preview.mounted).toEqual([["$NAME"]]);
  });

  it("gives the preview element its fixed, click-through styling", () => {
    const { cell } = createRenderableCellHandle(undefined);

    const { preview } = createDragPreview(cell as CellHandle);

    expect(asMock(preview).tagName).toBe("div");
    expect(preview.style.cssText).toContain("position: fixed");
    expect(preview.style.cssText).toContain("pointer-events: none");
  });

  it("mounts the piece's `[UI]` cell rather than the piece root", async () => {
    const { cell, log } = createRenderableCellHandle({
      $UI: { type: "vnode", name: "div", props: {}, children: [] },
      secret: "not the thing being rendered",
    });

    const { preview, cleanup: teardown } = createDragPreview(
      cell as CellHandle,
    );

    // No pill: this took the render path.
    expect(asMock(preview).children.length).toBe(0);
    expect(teardown).toBeDefined();

    // The mount is asynchronous; it is in flight as soon as render() returns.
    await Promise.resolve();
    await Promise.resolve();

    expect(log.attached).toBe(true);
    expect(log.mounted.length).toBe(1);
    // The mounted reference addresses the [UI] key, not the piece root, so the
    // renderer subscribes to the rendering rather than to the piece's state.
    expect(log.mounted[0]!.path).toEqual(["$UI"]);
    expect(log.mounted[0]!.id).toBe(cell.ref().id);

    teardown!();
  });

  it("unmounts the render it started when `cleanup` runs", async () => {
    const { cell, log } = createRenderableCellHandle({
      $UI: { type: "vnode", name: "div", props: {}, children: [] },
    });

    const { cleanup: teardown } = createDragPreview(cell as CellHandle);
    await Promise.resolve();
    await Promise.resolve();
    expect(log.mounted.length).toBe(1);

    teardown!();
    // Teardown is asynchronous behind the synchronous cancel.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(log.unmounted.length).toBeGreaterThan(0);
  });

  it("shows the short id when neither the view nor the name can be rendered", () => {
    const { cell } = createRenderableCellHandle({
      $UI: { type: "vnode", name: "div", props: {}, children: [] },
    });
    // Addressing the [UI] key builds a new handle, and that constructor reaches
    // for the runtime's connection. A piece torn down between the pointer press
    // and the drag makes that reach fail; the preview must still be something
    // rather than throwing out of the pointer handler that asked for it.
    const runtimeClient = cell.runtime() as unknown as Record<symbol, unknown>;
    runtimeClient[$conn] = () => {
      throw new Error("connection is gone");
    };

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    let preview;
    try {
      ({ preview } = createDragPreview(cell as CellHandle));
    } finally {
      console.warn = originalWarn;
    }

    expect(asMock(preview).children).toEqual([]);
    expect(preview.textContent).toBe(`#${cell.id().slice(-6)}`);
    expect(warnings.length).toBe(2);
  });
});
