import type { CellHandle } from "@commonfabric/runtime-client";
import { css, html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import {
  createDragPreview,
  endDrag,
  startDrag,
  updateDragPointer,
} from "../../core/drag-state.ts";

/**
 * CFDragSource - Wraps draggable content and initiates drag operations
 *
 * This component makes any content draggable and manages the drag lifecycle.
 *
 * @element cf-drag-source
 *
 * @property {CellHandle} cell - Required: the cell being dragged
 * @property {string} type - Optional: type identifier for filtering drop zones
 * @property {boolean} disabled - Disable dragging
 *
 * @fires cf-drag-start - Fired when drag starts with { cell: SigilLink }
 * @fires cf-drag-end - Fired when drag ends with { cell: SigilLink }
 *
 * What a drop delivers is the cell that `cell` resolves to when the press
 * begins, which a drop zone waits for. `cell` itself is what the preview
 * shows and what `cf-drag-start` and `cf-drag-end` name. Resolving at any
 * other time would drop a stale row: a `.map()` row keeps its `cell` while
 * the list moves another entry into that row, and a resolution through an
 * inline list entry names that entry's content as it was. Where that
 * resolution fails, a drop delivers nothing.
 *
 * Each detail carries the dragged cell's link rather than its `CellHandle`,
 * so that the detail is a `FabricValue` and can cross to a handler in the
 * worker; `cf-drop-zone` says the same of its events.
 *
 * @slot - Default slot for draggable content
 *
 * @example
 * <cf-drag-source .cell=${myCellHandle} type="item">
 *   <div>Drag me!</div>
 * </cf-drag-source>
 */
export class CFDragSource extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      :host([disabled]) {
        opacity: 0.5;
        cursor: not-allowed;
      }

      :host(:not([disabled])) .drag-body {
        cursor: grab;
      }

      :host(:not([disabled])) .drag-body.dragging {
        cursor: grabbing;
        opacity: 0.5;
      }
    `,
  ];

  @property({ attribute: false })
  accessor cell: CellHandle | undefined = undefined;

  @property({ type: String })
  accessor type: string | undefined = undefined;

  @property({ type: Boolean, reflect: true })
  accessor disabled: boolean | undefined = undefined;

  /** The cell being dragged, from the start of a drag until it ends. */
  #draggedCell: CellHandle | undefined;
  /** What `cell` resolved to when the press under way began. */
  #pressedCell: Promise<CellHandle> | undefined;
  private _isTracking = false;
  private _startX = 0;
  private _startY = 0;
  private _pointerId?: number;
  private _preview?: HTMLElement;
  private _boundPointerMove = this._handlePointerMove.bind(this);
  private _boundPointerUp = this._handlePointerUp.bind(this);

  override disconnectedCallback() {
    super.disconnectedCallback();
    // A press removed before it became a drag starts none. A drag under way
    // runs on until release, as a list reordering mid-drag removes and
    // re-adds its source, and ending the drag here would drop it at once.
    if (!this.#draggedCell) this.#stopTracking();
  }

  protected override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);
    // A press that has not yet become a drag drops what the cell bound now
    // resolves to.
    if (
      changedProperties.has("cell") && this.cell && this._isTracking &&
      !this.#draggedCell
    ) {
      this.#resolvePress(this.cell);
    }
  }

  private _handlePointerDown(e: PointerEvent) {
    // Skip if disabled
    if (this.disabled || !this.cell) {
      return;
    }

    // Skip if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (this._isInteractiveElement(target)) {
      return;
    }

    // Don't preventDefault or setPointerCapture here - wait until we confirm
    // it's a drag. This allows clicks to work on non-interactive content.

    // Store initial position
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._pointerId = e.pointerId;
    this._isTracking = true;
    this.#resolvePress(this.cell);

    // Add document-level listeners for move and up
    document.addEventListener("pointermove", this._boundPointerMove);
    document.addEventListener("pointerup", this._boundPointerUp);
    document.addEventListener("pointercancel", this._boundPointerUp);
  }

  private _handlePointerMove(e: PointerEvent) {
    // Ignore events from other pointers (multi-touch, secondary mouse buttons)
    if (!this.cell || !this._isTracking || e.pointerId !== this._pointerId) {
      return;
    }

    const deltaX = e.clientX - this._startX;
    const deltaY = e.clientY - this._startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Start drag after threshold (~5px)
    if (!this.#draggedCell && distance > 5) {
      this.#draggedCell = this.cell;
      this._startDrag(e, this.#draggedCell, this.#pressedCell);
    }

    // Update preview position and notify drop zones if dragging
    if (this.#draggedCell && this._preview) {
      this._preview.style.left = `${e.clientX + 10}px`;
      this._preview.style.top = `${e.clientY + 10}px`;
      // Update drag state so drop zones can check intersection
      updateDragPointer(e.clientX, e.clientY);
    }
  }

  private _handlePointerUp(e: PointerEvent) {
    // Ignore events from other pointers (multi-touch releases shouldn't cancel drag)
    if (e.pointerId !== this._pointerId) {
      return;
    }

    this.#stopTracking();
  }

  /**
   * Stops following the pointer pressed on the source, ending the drag it
   * started, if any. Drop zones detect a drop themselves, from the drag state.
   */
  #stopTracking(): void {
    document.removeEventListener("pointermove", this._boundPointerMove);
    document.removeEventListener("pointerup", this._boundPointerUp);
    document.removeEventListener("pointercancel", this._boundPointerUp);

    if (this.#draggedCell) this._endDrag(this.#draggedCell);

    this.#draggedCell = undefined;
    this.#pressedCell = undefined;
    this._isTracking = false;
    this._pointerId = undefined;
  }

  /** Starts resolving `cell` for the press under way. */
  #resolvePress(cell: CellHandle): void {
    const pressed = cell.resolveAsCell();
    // A drop zone reports a failure, where a drop waits for it; a press that
    // drops nowhere has nothing to report.
    pressed.catch(() => {});
    this.#pressedCell = pressed;
  }

  private _isInteractiveElement(element: HTMLElement): boolean {
    // Check if element or any ancestor (up to this component) is interactive.
    // This ensures clicks on descendants of buttons/links work correctly.
    const interactiveSelector =
      "input, button, select, textarea, a, [role='button']";
    const interactive = element.closest(interactiveSelector);
    return interactive !== null && this.contains(interactive);
  }

  private _startDrag(
    e: PointerEvent,
    cell: CellHandle,
    droppedCell: Promise<CellHandle> | undefined,
  ) {
    // Now that we're actually dragging, capture the pointer and add dragging class
    const body = this.shadowRoot?.querySelector(".drag-body") as HTMLElement;
    if (body) {
      if (this._pointerId !== undefined) {
        body.setPointerCapture(this._pointerId);
      }
      body.classList.add("dragging");
    }

    // Create preview element
    const { preview, cleanup } = createDragPreview(cell);
    this._preview = preview;
    document.body.appendChild(this._preview);

    // Position preview near cursor
    this._preview.style.left = `${e.clientX + 10}px`;
    this._preview.style.top = `${e.clientY + 10}px`;

    // Start drag in drag state
    startDrag({
      cell,
      droppedCell,
      type: this.type,
      sourceElement: this,
      preview: this._preview,
      previewCleanup: cleanup,
      pointerX: e.clientX,
      pointerY: e.clientY,
    });

    // Emit drag start event
    this.emit("cf-drag-start", { cell: cell.toSigilLink() });
  }

  private _endDrag(cell: CellHandle) {
    // Remove dragging class
    this.shadowRoot?.querySelector(".drag-body")?.classList.remove("dragging");

    // End drag in drag state (this will clean up preview)
    // Drop zones handle their own detection and emit cf-drop events
    endDrag();

    // Emit drag end event
    this.emit("cf-drag-end", { cell: cell.toSigilLink() });

    this._preview = undefined;
  }

  override render() {
    return html`
      <div class="drag-body" @pointerdown="${this._handlePointerDown}">
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-drag-source": CFDragSource;
  }
}
