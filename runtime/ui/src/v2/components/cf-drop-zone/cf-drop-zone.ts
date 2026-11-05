import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";
import { subscribeToDrag, subscribeToEndDrag } from "../../core/drag-state.ts";
import type { DragState } from "../../core/drag-state.ts";

/**
 * CFDropZone - Marks a region as droppable and emits events when valid drops occur
 *
 * Purely behavioral component with no visual representation except CSS feedback
 * during drag-over. Subscribes to drag state and checks if pointer intersects
 * this element's bounding box.
 *
 * @element cf-drop-zone
 *
 * @property {string} accept - Optional filter by drag source type (comma-separated)
 *
 * @fires cf-drag-enter - When a valid drag enters the zone
 * @fires cf-drag-leave - When a drag leaves the zone
 * @fires cf-drop - When a valid drop occurs (drag ends while over this zone)
 *
 * @slot - Default slot for wrapped content
 *
 * @example
 * <cf-drop-zone accept="item" oncf-drop=${handleDrop}>
 *   <div>Drop items here</div>
 * </cf-drop-zone>
 */
export class CFDropZone extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        position: relative;
      }

      :host([drag-over])::after {
        content: "";
        position: absolute;
        inset: 0;
        border: 2px dashed var(--cf-theme-color-primary, #0066cc);
        border-radius: inherit;
        z-index: 1000;
        pointer-events: none;
      }
    `,
  ];

  @property({ type: String })
  accessor accept: string | undefined = undefined;

  @state()
  private accessor _isDragOver: boolean = false;

  private _unsubscribeDrag?: () => void;
  private _unsubscribeEndDrag?: () => void;

  override connectedCallback() {
    super.connectedCallback();

    // Subscribe to global drag state changes
    // This fires on every pointer move during drag
    this._unsubscribeDrag = subscribeToDrag((state) => {
      this._handleDragStateChange(state);
    });

    // Subscribe to drag end events to emit drop
    this._unsubscribeEndDrag = subscribeToEndDrag((state) => {
      this._handleDragEnd(state);
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();

    // Unsubscribe from drag state
    if (this._unsubscribeDrag) {
      this._unsubscribeDrag();
      this._unsubscribeDrag = undefined;
    }
    if (this._unsubscribeEndDrag) {
      this._unsubscribeEndDrag();
      this._unsubscribeEndDrag = undefined;
    }
  }

  /**
   * Handle drag state changes - check if pointer is over us
   */
  private _handleDragStateChange(state: DragState | null): void {
    if (!state) {
      // Drag ended - if we were in drag-over state, emit drop event
      if (this._isDragOver) {
        // We need to get the cell from the previous state, but it's gone now
        // The drag-source will have already cleaned up, so we can't emit drop here
        // Instead, we need to track the last known drag state
        this._setDragOver(false);
      }
      return;
    }

    // Check if this drag type is accepted
    if (!this._isAccepted(state.type)) {
      if (this._isDragOver) {
        this._setDragOver(false);
      }
      return;
    }

    // Check if pointer is within our bounding box
    const isOver = this._isPointerOver(state.pointerX, state.pointerY);

    if (isOver && !this._isDragOver) {
      this._setDragOver(true, state);
    } else if (!isOver && this._isDragOver) {
      this._setDragOver(false);
    }
  }

  /**
   * Check if a drag type is accepted by this drop zone
   */
  private _isAccepted(dragType?: string): boolean {
    if (!this.accept) return true; // Accept all if no filter
    if (!dragType) return false; // Reject untyped drags when filter is set

    const types = this.accept.split(",").map((t) => t.trim());
    return types.includes(dragType);
  }

  /**
   * Check if the pointer is within this element's bounding box
   */
  private _isPointerOver(x: number, y: number): boolean {
    const rect = this.getBoundingClientRect();
    return (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  }

  /**
   * Update drag-over state and emit appropriate events
   */
  private _setDragOver(isOver: boolean, dragState?: DragState): void {
    if (isOver === this._isDragOver) return;

    this._isDragOver = isOver;
    this.toggleAttribute("drag-over", isOver);

    if (isOver && dragState) {
      this.emit("cf-drag-enter", {
        sourceCell: dragState.cell,
        type: dragState.type,
      });
    } else {
      this.emit("cf-drag-leave", {});
    }
  }

  /**
   * Handle drag end - if we're in drag-over state, emit drop
   */
  private _handleDragEnd(dragState: DragState): void {
    if (this._isDragOver && this._isAccepted(dragState.type)) {
      // Clean up visual state
      this._isDragOver = false;
      this.toggleAttribute("drag-over", false);

      // Emit leave event before drop (dropping is a form of leaving)
      this.emit("cf-drag-leave", {});

      // Get drop zone bounding rect for position calculation in handler
      const dropZoneRect = this.getBoundingClientRect();

      // Emit drop event with pointer coordinates and drop zone rect
      this.emit("cf-drop", {
        sourceCell: dragState.cell,
        sourceCellRef: dragState.cell.ref(),
        type: dragState.type,
        pointerX: dragState.pointerX,
        pointerY: dragState.pointerY,
        dropZoneRect: {
          left: dropZoneRect.left,
          top: dropZoneRect.top,
          width: dropZoneRect.width,
          height: dropZoneRect.height,
        },
      });
    }
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-drop-zone": CFDropZone;
  }
}
