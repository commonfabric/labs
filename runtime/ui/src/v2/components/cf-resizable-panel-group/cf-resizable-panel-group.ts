import { css, html, type PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * @fileoverview UI Resizable Panel Group Component - Container for resizable panels
 *
 * @module cf-resizable-panel-group
 * @description
 * A container component that manages multiple resizable panels with draggable handles between them.
 * Works in conjunction with cf-resizable-panel and cf-resizable-handle components to create
 * flexible layouts where users can adjust panel sizes by dragging dividers.
 *
 * @example
 * ```html
 * <cf-resizable-panel-group direction="horizontal">
 *   <cf-resizable-panel default-size="30" min-size="20">
 *     Left panel content
 *   </cf-resizable-panel>
 *   <cf-resizable-handle></cf-resizable-handle>
 *   <cf-resizable-panel default-size="70">
 *     Right panel content
 *   </cf-resizable-panel>
 * </cf-resizable-panel-group>
 * ```
 */

export type PanelGroupDirection = "horizontal" | "vertical";

interface PanelInfo {
  element: HTMLElement;
  minSize: number;
  maxSize: number;
  defaultSize: number;
  currentSize: number;
}

/**
 * CFResizablePanelGroup manages a collection of resizable panels separated by draggable handles.
 *
 * @tag cf-resizable-panel-group
 * @extends BaseElement
 *
 * @property {PanelGroupDirection} direction - Layout direction ("horizontal" | "vertical")
 *
 * @attribute {string} direction - Sets the layout direction for panels
 *
 * @event {CustomEvent} cf-resize - Fired when panels are resized
 *   @detail {Object} detail - Event detail object
 *   @detail {Array<{element: HTMLElement, size: number}>} detail.panels - Array of panel elements with their current sizes
 *
 * @slot default - Container for cf-resizable-panel and cf-resizable-handle elements
 *
 * @csspart panel-group - The main container element
 */
export class CFResizablePanelGroup extends BaseElement {
  static override properties = {
    direction: { type: String },
  };
  declare direction: PanelGroupDirection;

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
    }

    .panel-group {
      display: flex;
      width: 100%;
      height: 100%;
      position: relative;
    }

    .panel-group.direction-horizontal {
      flex-direction: row;
    }

    .panel-group.direction-vertical {
      flex-direction: column;
    }

    :host(.resizing) {
      user-select: none;
    }

    :host(.resizing) * {
      pointer-events: none;
    }

    :host(.resizing) ::slotted(cf-resizable-handle) {
      pointer-events: auto;
    }

    ::slotted(cf-resizable-panel) {
      overflow: hidden;
      position: relative;
    }

    ::slotted(cf-resizable-handle) {
      flex-shrink: 0;
      z-index: 10;
    }

    /* Horizontal layout */
    .panel-group.direction-horizontal ::slotted(cf-resizable-panel) {
      height: 100%;
    }

    .panel-group.direction-horizontal ::slotted(cf-resizable-handle) {
      width: 6px;
      height: 100%;
      cursor: col-resize;
    }

    /* Vertical layout */
    .panel-group.direction-vertical ::slotted(cf-resizable-panel) {
      width: 100%;
    }

    .panel-group.direction-vertical ::slotted(cf-resizable-handle) {
      width: 100%;
      height: 6px;
      cursor: row-resize;
    }
  `;

  constructor() {
    super();
    this.direction = "horizontal";
  }

  private _panels: Map<HTMLElement, PanelInfo> = new Map();
  private _handles: HTMLElement[] = [];
  private _activeHandle: HTMLElement | null = null;
  private _startPosition = 0;
  private _startSizes: number[] = [];
  private _observer: MutationObserver | null = null;
  /** The axis the panels' sizes were last written along. */
  #sizedDimension: "width" | "height" | undefined;

  override connectedCallback() {
    super.connectedCallback();

    // Set up mutation observer to watch for panel changes
    this._observer = new MutationObserver(() => this.updatePanels());
    this._observer.observe(this, { childList: true });

    // Initial panel setup
    this.updatePanels();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();

    // Clean up observer
    this._observer?.disconnect();

    // Clean up event listeners
    this._handles.forEach((handle) => {
      handle.removeEventListener("mousedown", this.handleMouseDown);
      handle.removeEventListener("touchstart", this.handleTouchStart);
      handle.removeEventListener(
        "cf-handle-adjust",
        this.handleAdjust as EventListener,
      );
    });
  }

  override render() {
    return html`
      <div
        class="panel-group direction-${this.direction}"
        part="panel-group"
      >
        <slot></slot>
      </div>
    `;
  }

  override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (!changed.has("direction")) return;
    // The direction can arrive after the panels are in place, before the
    // first render or after it: the panels' sizes move to its axis and the
    // handles' grips turn with it. A drag measures along one axis from where
    // it started, so a drag in progress ends.
    if (this._activeHandle) this.#cancelResize();
    for (const handle of this._handles) {
      handle.setAttribute("data-orientation", this.direction);
    }
    this.applyPanelSizes();
  }

  private updatePanels(): void {
    this._panels.clear();
    this._handles = [];

    const panels = Array.from(this.querySelectorAll("cf-resizable-panel"));
    const handles = Array.from(this.querySelectorAll("cf-resizable-handle"));

    // Store panel information
    panels.forEach((panel) => {
      const minSize = panel.getAttribute("min-size")
        ? parseFloat(panel.getAttribute("min-size")!)
        : 0;
      const maxSize = panel.getAttribute("max-size")
        ? parseFloat(panel.getAttribute("max-size")!)
        : 100;
      const defaultSize = panel.getAttribute("default-size")
        ? parseFloat(panel.getAttribute("default-size")!)
        : 50;

      this._panels.set(panel as HTMLElement, {
        element: panel as HTMLElement,
        minSize,
        maxSize,
        defaultSize,
        currentSize: defaultSize,
      });
    });

    // Set up handle event listeners
    handles.forEach((handle) => {
      this._handles.push(handle as HTMLElement);
      (handle as HTMLElement).addEventListener(
        "mousedown",
        this.handleMouseDown,
      );
      (handle as HTMLElement).addEventListener(
        "touchstart",
        this.handleTouchStart,
      );
      handle.addEventListener(
        "cf-handle-adjust",
        this.handleAdjust as EventListener,
      );
      // Set orientation on handle
      (handle as HTMLElement).setAttribute("data-orientation", this.direction);
    });

    // Apply initial sizes
    this.applyPanelSizes();
  }

  private handleMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    this.startResize(e.target as HTMLElement, e.clientX, e.clientY);

    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
  };

  private handleTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    const touch = e.touches[0];
    this.startResize(e.target as HTMLElement, touch.clientX, touch.clientY);

    document.addEventListener("touchmove", this.handleTouchMove);
    document.addEventListener("touchend", this.handleTouchEnd);
  };

  private handleMouseMove = (e: MouseEvent): void => {
    this.resize(e.clientX, e.clientY);
  };

  private handleTouchMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    this.resize(touch.clientX, touch.clientY);
  };

  private handleMouseUp = (): void => {
    this.endResize();
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
  };

  private handleTouchEnd = (): void => {
    this.endResize();
    document.removeEventListener("touchmove", this.handleTouchMove);
    document.removeEventListener("touchend", this.handleTouchEnd);
  };

  private startResize(handle: HTMLElement, x: number, y: number): void {
    this._activeHandle = handle;
    this._startPosition = this.direction === "horizontal" ? x : y;

    // Store current sizes
    this._startSizes = Array.from(this._panels.values()).map((info) =>
      info.currentSize
    );

    // Add resizing class
    this.classList.add("resizing");
  }

  private resize(x: number, y: number): void {
    if (!this._activeHandle) return;

    const handleIndex = this._handles.indexOf(this._activeHandle);
    if (handleIndex === -1) return;

    const panels = Array.from(this._panels.values());
    const totalSize = this.direction === "horizontal"
      ? this.offsetWidth
      : this.offsetHeight;
    const currentPosition = this.direction === "horizontal" ? x : y;
    const delta = currentPosition - this._startPosition;
    const deltaPercent = (delta / totalSize) * 100;

    // Update sizes of panels adjacent to the handle
    const leftPanel = panels[handleIndex];
    const rightPanel = panels[handleIndex + 1];

    if (leftPanel && rightPanel) {
      const newLeftSize = Math.max(
        leftPanel.minSize,
        Math.min(
          leftPanel.maxSize,
          this._startSizes[handleIndex] + deltaPercent,
        ),
      );
      const newRightSize = Math.max(
        rightPanel.minSize,
        Math.min(
          rightPanel.maxSize,
          this._startSizes[handleIndex + 1] - deltaPercent,
        ),
      );

      // Ensure the total size remains constant
      const totalNewSize = newLeftSize + newRightSize;
      const totalOldSize = this._startSizes[handleIndex] +
        this._startSizes[handleIndex + 1];

      if (Math.abs(totalNewSize - totalOldSize) < 0.1) {
        leftPanel.currentSize = newLeftSize;
        rightPanel.currentSize = newRightSize;
        this.applyPanelSizes();

        // Emit resize event
        this.emit("cf-resize", {
          panels: panels.map((p) => ({
            element: p.element,
            size: p.currentSize,
          })),
        });
      }
    }
  }

  private endResize(): void {
    this._activeHandle = null;
    this.classList.remove("resizing");
  }

  /** Ends a drag in progress, whichever pointer started it. */
  #cancelResize(): void {
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
    document.removeEventListener("touchmove", this.handleTouchMove);
    document.removeEventListener("touchend", this.handleTouchEnd);
    this.endResize();
  }

  private handleAdjust = (e: CustomEvent<{ delta: number }>): void => {
    const handle = e.target as HTMLElement;
    const handleIndex = this._handles.indexOf(handle);
    if (handleIndex === -1) return;

    const panels = Array.from(this._panels.values());
    const leftPanel = panels[handleIndex];
    const rightPanel = panels[handleIndex + 1];

    if (leftPanel && rightPanel) {
      const delta = e.detail.delta;
      const adjustAmount = Math.min(Math.abs(delta), 5) * Math.sign(delta);

      const newLeftSize = Math.max(
        leftPanel.minSize,
        Math.min(leftPanel.maxSize, leftPanel.currentSize + adjustAmount),
      );
      const newRightSize = Math.max(
        rightPanel.minSize,
        Math.min(rightPanel.maxSize, rightPanel.currentSize - adjustAmount),
      );

      // Ensure the total size remains constant
      const totalNewSize = newLeftSize + newRightSize;
      const totalOldSize = leftPanel.currentSize + rightPanel.currentSize;

      if (Math.abs(totalNewSize - totalOldSize) < 0.1) {
        leftPanel.currentSize = newLeftSize;
        rightPanel.currentSize = newRightSize;
        this.applyPanelSizes();

        // Update ARIA value on handle
        const percentage = Math.round(
          (leftPanel.currentSize /
            (leftPanel.currentSize + rightPanel.currentSize)) * 100,
        );
        handle.setAttribute("aria-valuenow", percentage.toString());

        // Emit resize event
        this.emit("cf-resize", {
          panels: panels.map((p) => ({
            element: p.element,
            size: p.currentSize,
          })),
        });
      }
    }
  };

  private applyPanelSizes(): void {
    const panels = Array.from(this._panels.values());
    const dimension = this.direction === "horizontal" ? "width" : "height";
    // Only a size this group wrote is cleared, and only when the axis moves.
    const stale = this.#sizedDimension === dimension
      ? undefined
      : this.#sizedDimension;

    panels.forEach((panel) => {
      if (stale) panel.element.style[stale] = "";
      panel.element.style[dimension] = `${panel.currentSize}%`;
    });
    this.#sizedDimension = dimension;
  }
}
