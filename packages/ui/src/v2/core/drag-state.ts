import { type CellHandle, UI, type VNode } from "@commonfabric/runtime-client";
import { render } from "@commonfabric/html/client";

import { createNameChip } from "./name-chip.ts";

/**
 * State information for an active drag operation.
 */
export interface DragState {
  /** The CellHandle being dragged */
  cell: CellHandle;

  /** Optional type identifier for filtering drop zones */
  type?: string;

  /** The source element that initiated the drag */
  sourceElement: HTMLElement;

  /** The preview element being shown during drag */
  preview: HTMLElement;

  /** Optional cleanup function to call when drag ends */
  previewCleanup?: () => void;

  /** Current pointer X position (updated during drag) */
  pointerX: number;

  /** Current pointer Y position (updated during drag) */
  pointerY: number;
}

/**
 * Callback function invoked when drag state changes.
 * Receives the new drag state, or null when drag ends.
 */
export type DragListener = (state: DragState | null) => void;

//
// Module-level singleton state
//

let currentDrag: DragState | null = null;
const listeners: Set<DragListener> = new Set();

/**
 * Begin a drag operation with the given state.
 * Notifies all subscribers of the new drag state.
 *
 * @param state - The drag state to set
 */
export function startDrag(state: DragState): void {
  currentDrag = state;
  notifyListeners(state);
}

/**
 * End the current drag operation.
 * First notifies listeners with the final state (so drop zones can emit drop events),
 * then cleans up the preview element and notifies with null.
 */
export function endDrag(): void {
  if (!currentDrag) {
    return;
  }

  // Store reference before clearing
  const finalState = currentDrag;

  // Notify listeners that drag is ending (with isEnding flag)
  // Drop zones use this to emit cf-drop if pointer is over them
  notifyListenersOfEnd(finalState);

  // Call cleanup function if provided
  if (finalState.previewCleanup) {
    finalState.previewCleanup();
  }

  // Remove preview element from DOM
  if (finalState.preview.parentNode) {
    finalState.preview.parentNode.removeChild(finalState.preview);
  }

  // Clear state
  currentDrag = null;

  // Notify all subscribers that drag has ended
  notifyListeners(null);
}

/** A callback run when a drag is ending, before cleanup. */
type DragEndListener = (state: DragState) => void;

/** The registered such callbacks; drop zones use them to emit drop events. */
const endListeners: Set<DragEndListener> = new Set();

/**
 * Subscribe to drag end events.
 * Called with the final drag state BEFORE it's cleared.
 * Use this to emit drop events if the pointer is over your drop zone.
 *
 * @param listener - Callback invoked when drag ends
 * @returns Unsubscribe function
 */
export function subscribeToEndDrag(listener: DragEndListener): () => void {
  endListeners.add(listener);
  return () => {
    endListeners.delete(listener);
  };
}

/**
 * Internal helper to notify end listeners.
 */
function notifyListenersOfEnd(state: DragState): void {
  endListeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error("[drag-state] Error in drag end listener:", error);
    }
  });
}

/**
 * Get the current drag state.
 *
 * @returns The current drag state, or null if no drag is active
 */
export function getCurrentDrag(): DragState | null {
  return currentDrag;
}

/**
 * Check if a drag operation is currently active.
 *
 * @returns true if a drag is active, false otherwise
 */
export function isDragging(): boolean {
  return currentDrag !== null;
}

/**
 * Update the current pointer position during drag.
 * This is called by drag-source on pointermove to keep drop zones informed.
 *
 * @param x - Current pointer X position
 * @param y - Current pointer Y position
 */
export function updateDragPointer(x: number, y: number): void {
  if (!currentDrag) {
    return;
  }

  currentDrag.pointerX = x;
  currentDrag.pointerY = y;

  // Notify listeners of position update
  notifyListeners(currentDrag);
}

/**
 * Subscribe to drag state changes.
 * The listener will be called immediately with the current state,
 * and then on every state change.
 *
 * @param listener - Callback function to invoke on state changes
 * @returns Unsubscribe function to remove the listener
 */
export function subscribeToDrag(listener: DragListener): () => void {
  listeners.add(listener);

  // Call immediately with current state
  listener(currentDrag);

  // Return unsubscribe function
  return () => {
    listeners.delete(listener);
  };
}

/** A drag preview element and, when it renders a piece, its teardown. */
export interface DragPreview {
  /** The preview element (not yet added to the DOM). */
  preview: HTMLElement;

  /** Stops the preview's render; pass as {@link DragState.previewCleanup}. */
  cleanup?: () => void;
}

/**
 * Create a drag preview element for a cell.
 * Uses the cell's [UI] property if available, otherwise falls back to
 * a chip naming the cell.
 *
 * The preview renders the cell's `[UI]`, or the name in the chip, through the
 * same renderer the page uses, so the confidentiality policy that decides
 * what a piece may show decides what its drag preview shows. When even the
 * name cannot be rendered, the preview shows the short form of the cell's id.
 *
 * @param cell - The CellHandle to create a preview for
 * @returns The preview element and its teardown
 */
export function createDragPreview(cell: CellHandle): DragPreview {
  const preview = document.createElement("div");
  preview.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 10000;
    opacity: 0.9;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    background: white;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 0.5rem;
    max-width: 300px;
    max-height: 200px;
    overflow: hidden;
  `;

  const cellValue = cell.get();
  if (!cellValue || typeof cellValue !== "object" || !(UI in cellValue)) {
    return { preview, cleanup: _addFallbackPreview(preview, cell) };
  }

  try {
    const cleanup = render(
      preview,
      (cell as CellHandle<Record<string, VNode>>).key(UI),
      {
        onError: (error) => {
          console.warn("[drag-state] Failed to render [UI] preview:", error);
        },
      },
    );
    return { preview, cleanup };
  } catch (error) {
    console.warn("[drag-state] Failed to render [UI] preview:", error);
    return { preview, cleanup: _addFallbackPreview(preview, cell) };
  }
}

/**
 * Adds a chip naming `cell` to `container` and returns the teardown of its
 * render, or shows the short form of the cell's id when the name cannot be
 * rendered.
 */
function _addFallbackPreview(
  container: HTMLElement,
  cell: CellHandle,
): (() => void) | undefined {
  const onError = (error: unknown) => {
    console.warn("[drag-state] Failed to render the name preview:", error);
  };
  try {
    const { chip, cleanup } = createNameChip(cell, { onError });
    container.appendChild(chip);
    return cleanup;
  } catch (error) {
    onError(error);
    container.textContent = `#${cell.id().slice(-6)}`;
    return undefined;
  }
}

/**
 * Internal helper to notify all listeners of state change.
 */
function notifyListeners(state: DragState | null): void {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error("[drag-state] Error in drag listener:", error);
    }
  });
}
