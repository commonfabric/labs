import { css, html, type PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { CFResizablePanel } from "../cf-resizable-panel/cf-resizable-panel.ts";
import {
  adopt,
  owningGroupElement,
  type PanelGroupMembers,
} from "./membership.ts";

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
 *
 * A group whose panels sit side by side where it is wide and stack where it
 * is narrow, by its own width rather than the window's:
 * ```html
 * <cf-resizable-panel-group stack-below="768">…</cf-resizable-panel-group>
 * ```
 *
 * A panel with nothing to show while stacked steps aside then, and the other
 * panels take its room:
 * ```html
 * <cf-resizable-panel default-size="64" hide-when-stacked>…</cf-resizable-panel>
 * ```
 */

export type PanelGroupDirection = "horizontal" | "vertical";

interface PanelInfo {
  element: CFResizablePanel;
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
 * @property {number} stackBelow - A width in pixels: while a horizontal
 *   group is itself narrower, its panels lie vertically (the group is
 *   stacked), and a panel marked `hideWhenStacked` is not drawn. A vertical
 *   group is never stacked. Unset, the group always follows `direction`.
 *
 * @attribute {string} direction - Sets the layout direction for panels
 * @attribute {number} stack-below - Sets `stackBelow`
 * @attribute {string} data-orientation - Set by the group: the direction its
 *   panels lie in now, "horizontal" or "vertical"
 *
 * @event {CustomEvent} cf-resize - Fired on the group when a person resizes
 *   its panels. It does not bubble, so a group nested in a panel does not
 *   reach a listener on the outer group.
 *   @detail {Object} detail - Event detail object
 *   @detail {number[]} detail.sizes - Each panel's size, a percentage of the
 *   group, in document order
 *
 * @slot default - Container for cf-resizable-panel and cf-resizable-handle elements
 *
 * @csspart panel-group - The main container element
 */
export class CFResizablePanelGroup extends BaseElement
  implements PanelGroupMembers {
  static override properties = {
    direction: { type: String },
    stackBelow: { type: Number, attribute: "stack-below" },
    _width: { state: true },
  };
  declare direction: PanelGroupDirection;
  /** Null when the attribute is removed. */
  declare stackBelow: number | null | undefined;
  /** The group's own width, as last measured; undefined before the first. */
  declare _width: number | undefined;

  /** The direction the panels lie in now: `direction`, or vertical while the
   * group is narrower than `stackBelow`. */
  get orientation(): PanelGroupDirection {
    return this.stacked ? "vertical" : this.direction;
  }

  /** Whether the group lies vertically only because it is narrower than
   * `stackBelow`. */
  get stacked(): boolean {
    return this.direction === "horizontal" && this.stackBelow != null &&
      this._width !== undefined && this._width < this.stackBelow;
  }

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

    /* Panels and handles lay themselves out by the data-orientation this
    * group gives them, so one wrapped in another element, as an array's
    * items are, is drawn as a direct child is. */
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
  /** Each handle with a panel on both sides of it, and the indexes of those
   * two panels. A handle at either end moves nothing. */
  #handleNeighbors = new Map<HTMLElement, [number, number]>();
  /** The panels and handles that joined this group, in no order. */
  #members = new Set<HTMLElement>();
  /** Set while the group adopts the members already in place, so that it
   * reads them once rather than once for each. */
  #adopting = false;
  /** The axis the panels' sizes were last written along. */
  #sizedDimension: "width" | "height" | undefined;
  /** The orientation the handles and panels were last given. */
  #laidOut: PanelGroupDirection | undefined;
  /** Whether the panels were last laid out stacked. */
  #laidOutStacked = false;
  /** The panels and handles this group stopped drawing, each with the
   * inline display it had, so it shows again only what it hid, as it was. */
  #hidden = new Map<HTMLElement, string>();
  /** How much larger the drawn panels are than their stored sizes, while a
   * panel is hidden; 1 otherwise. */
  #scale = 1;
  /** Measures the group's own width, for `stackBelow`. The first report
   * arrives after layout and before paint, so a narrow group is never drawn
   * side by side first. */
  #resizeObserver: ResizeObserver | undefined;

  override connectedCallback() {
    super.connectedCallback();

    this.addEventListener("mousedown", this.handleMouseDown);
    this.addEventListener("touchstart", this.handleTouchStart);
    this.#resizeObserver ??= new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) this._width = entry.contentRect.width;
    });
    this.#resizeObserver.observe(this);

    // Members join as they connect. Those already in place connected before
    // this element was upgraded, or connect just after it in the same
    // insertion; either way the group adopts them now.
    this.#adopting = true;
    try {
      for (
        const member of this.querySelectorAll<HTMLElement>(
          "cf-resizable-panel, cf-resizable-handle",
        )
      ) {
        if (owningGroupElement(member) === this) adopt(member, this);
      }
    } finally {
      this.#adopting = false;
    }
    this.updatePanels();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();

    if (this._activeHandle) this.#cancelResize();
    this.removeEventListener("mousedown", this.handleMouseDown);
    this.removeEventListener("touchstart", this.handleTouchStart);
    this.#resizeObserver?.disconnect();
    // Children taken out with the group are drawn wherever they go next.
    for (const [element, display] of this.#hidden) {
      element.style.display = display;
    }
    this.#hidden.clear();
    this.#laidOut = undefined;
  }

  override render() {
    return html`
      <div
        class="panel-group direction-${this.orientation}"
        part="panel-group"
      >
        <slot></slot>
      </div>
    `;
  }

  override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    const below = this.stackBelow;
    if (below != null && !(Number.isFinite(below) && below > 0)) {
      throw new RangeError(
        "cf-resizable-panel-group: stackBelow must be a positive width " +
          `in pixels, not ${below}`,
      );
    }
  }

  override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    const orientation = this.orientation;
    if (
      orientation === this.#laidOut && this.stacked === this.#laidOutStacked
    ) return;
    this.#relayOut();
  }

  /** Lays the panels and handles out for the group's orientation now. The
   * direction can arrive after the panels are in place, before the first
   * render or after it, and the group can cross `stackBelow` at any time:
   * the panels' sizes move to the new axis and the handles' grips turn with
   * it. A drag measures along one axis from where it started, so a drag in
   * progress ends when the axis moves, and only then. */
  #relayOut(): void {
    if (this.orientation !== this.#laidOut) {
      if (this._activeHandle) this.#cancelResize();
      for (const handle of this._handles) this.#orient(handle);
    }
    this.applyPanelSizes();
  }

  memberJoined(member: HTMLElement): void {
    this.#members.add(member);
    if (this.isConnected && !this.#adopting) this.updatePanels();
  }

  memberLeft(member: HTMLElement): void {
    if (!this.#members.delete(member)) return;
    // A member leaves as this group found it: unsized and unoriented.
    if (this.#sizedDimension) member.style[this.#sizedDimension] = "";
    delete member.dataset.orientation;
    member.removeAttribute("aria-orientation");
    // The members leave after the group when it is taken out with them.
    if (this.isConnected) this.updatePanels();
  }

  panelSizesChanged(panel: HTMLElement): void {
    if (this.#members.has(panel)) this.updatePanels();
  }

  /** A panel's hideWhenStacked changed: its sizes did not, so a drag goes
   * on. */
  panelShownChanged(panel: HTMLElement): void {
    if (this.#members.has(panel)) this.#relayOut();
  }

  /** The members, in document order. */
  #ordered(): HTMLElement[] {
    return [...this.#members].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
  }

  private updatePanels(): void {
    // A drag measures from the sizes it started with, so a re-read ends it.
    if (this._activeHandle) this.#cancelResize();
    const previous = new Map(this._panels);
    this._panels.clear();

    const members = this.#ordered();
    // A member is a panel or a handle by its element name. A panel not yet
    // upgraded has no sizes to read and takes no room until it upgrades: its
    // first update reports its sizes, and the group reads its panels again.
    const panels = members.filter((member) =>
      member instanceof CFResizablePanel
    );
    this._handles = members.filter((member) =>
      member.localName === "cf-resizable-handle"
    );

    // A panel's sizes are its properties, which its attributes set too: a
    // renderer assigns properties and sets no attribute. The sizes a person
    // dragged to stay while the same panels have the same defaults and each
    // size is still within its panel's bounds; otherwise every panel returns
    // to its default, so the sizes still add up.
    const kept = panels.length === previous.size &&
      panels.every((panel) => {
        const known = previous.get(panel);
        return known !== undefined &&
          known.defaultSize === panel.defaultSize &&
          known.currentSize >= panel.minSize &&
          known.currentSize <= panel.maxSize;
      });
    panels.forEach((panel) => {
      const { minSize, maxSize, defaultSize } = panel;
      this._panels.set(panel, {
        element: panel,
        minSize,
        maxSize,
        defaultSize,
        currentSize: kept
          ? previous.get(panel)?.currentSize ?? defaultSize
          : defaultSize,
      });
    });

    // A handle moves the nearest panel on each side of it.
    this.#handleNeighbors.clear();
    let before = -1;
    let pending: HTMLElement[] = [];
    for (const member of members) {
      if (member.localName === "cf-resizable-handle") pending.push(member);
      else if (member instanceof CFResizablePanel) {
        const index = panels.indexOf(member);
        for (const handle of pending) {
          if (before !== -1) this.#handleNeighbors.set(handle, [before, index]);
        }
        pending = [];
        before = index;
      }
    }

    for (const handle of this._handles) this.#orient(handle);
    this.applyPanelSizes();
  }

  /** The handle a pointer went down on, if it is one of this group's: a
   * press on a nested group's handle reaches this group too. */
  #pressedHandle(event: Event): HTMLElement | undefined {
    const path = event.composedPath();
    return this._handles.find((handle) => path.includes(handle));
  }

  private handleMouseDown = (e: MouseEvent): void => {
    const handle = this.#pressedHandle(e);
    if (!handle) return;
    e.preventDefault();
    this.startResize(handle, e.clientX, e.clientY);

    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
  };

  private handleTouchStart = (e: TouchEvent): void => {
    const handle = this.#pressedHandle(e);
    if (!handle) return;
    e.preventDefault();
    const touch = e.touches[0];
    this.startResize(handle, touch.clientX, touch.clientY);

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
    this._startPosition = this.orientation === "horizontal" ? x : y;

    // Store current sizes
    this._startSizes = Array.from(this._panels.values()).map((info) =>
      info.currentSize
    );

    // Add resizing class
    this.classList.add("resizing");
  }

  private resize(x: number, y: number): void {
    if (!this._activeHandle) return;

    const neighbors = this.#handleNeighbors.get(this._activeHandle);
    if (!neighbors) return;
    const [before, after] = neighbors;

    const panels = Array.from(this._panels.values());
    const horizontal = this.orientation === "horizontal";
    const totalSize = horizontal ? this.offsetWidth : this.offsetHeight;
    const currentPosition = horizontal ? x : y;
    const delta = currentPosition - this._startPosition;
    // The sizes are stored unscaled, so a move is too: the handle follows
    // the pointer while a panel is hidden and the rest are drawn larger.
    const deltaPercent = (delta / totalSize) * 100 / this.#scale;

    // Update sizes of panels adjacent to the handle
    const leftPanel = panels[before];
    const rightPanel = panels[after];

    if (leftPanel && rightPanel) {
      const newLeftSize = Math.max(
        leftPanel.minSize,
        Math.min(
          leftPanel.maxSize,
          this._startSizes[before] + deltaPercent,
        ),
      );
      const newRightSize = Math.max(
        rightPanel.minSize,
        Math.min(
          rightPanel.maxSize,
          this._startSizes[after] - deltaPercent,
        ),
      );

      // Ensure the total size remains constant
      const totalNewSize = newLeftSize + newRightSize;
      const totalOldSize = this._startSizes[before] +
        this._startSizes[after];

      if (Math.abs(totalNewSize - totalOldSize) < 0.1) {
        leftPanel.currentSize = newLeftSize;
        rightPanel.currentSize = newRightSize;
        this.applyPanelSizes();

        // Emit resize event
        this.#emitResize(panels);
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

  handleAdjusted(handle: HTMLElement, delta: number): void {
    const neighbors = this.#handleNeighbors.get(handle);
    if (!neighbors) return;

    const panels = Array.from(this._panels.values());
    const leftPanel = panels[neighbors[0]];
    const rightPanel = panels[neighbors[1]];

    if (leftPanel && rightPanel) {
      const adjustAmount = Math.min(Math.abs(delta), 5) * Math.sign(delta) /
        this.#scale;

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
        this.#emitResize(panels);
      }
    }
  }

  /** Tells listeners on this group the panels' sizes. It does not bubble,
   * so a listener on a group never hears a group nested inside it. */
  #emitResize(panels: PanelInfo[]): void {
    this.emit("cf-resize", {
      sizes: panels.map((panel) => panel.currentSize),
    }, { bubbles: false, composed: false });
  }

  /** Gives a handle the group's orientation: its grip reads
   * `data-orientation`, and assistive technology reads `aria-orientation`,
   * which names the line itself, so panels side by side have a vertical
   * separator between them. */
  #orient(handle: Element): void {
    const orientation = this.orientation;
    handle.setAttribute("data-orientation", orientation);
    handle.setAttribute(
      "aria-orientation",
      orientation === "horizontal" ? "vertical" : "horizontal",
    );
  }

  private applyPanelSizes(): void {
    const panels = Array.from(this._panels.values());
    const orientation = this.orientation;
    const stacked = this.stacked;
    const dimension = orientation === "horizontal" ? "width" : "height";
    // Only a size this group wrote is cleared, and only when the axis moves.
    const stale = this.#sizedDimension === dimension
      ? undefined
      : this.#sizedDimension;

    // While stacked, a panel marked hideWhenStacked is not drawn, nor is a
    // handle beside it, and the panels drawn share the whole length in
    // proportion to their sizes; the sizes themselves are kept for when the
    // group widens. If every panel is marked, every panel is drawn.
    const marked = panels.map((panel) =>
      stacked && panel.element.hideWhenStacked
    );
    const hide = marked.every(Boolean) ? marked.map(() => false) : marked;
    const shown = panels.reduce(
      (sum, panel, i) => hide[i] ? sum : sum + panel.currentSize,
      0,
    );
    const scale = hide.some(Boolean) && shown > 0 ? 100 / shown : 1;
    const hidden = new Set<HTMLElement>();
    panels.forEach((panel, i) => {
      if (hide[i]) hidden.add(panel.element);
      if (stale) panel.element.style[stale] = "";
      panel.element.style[dimension] = `${panel.currentSize * scale}%`;
      panel.element.dataset.orientation = orientation;
    });
    for (const handle of this._handles) {
      const neighbors = this.#handleNeighbors.get(handle);
      if (neighbors?.some((i) => hide[i])) hidden.add(handle);
    }
    for (const [element, display] of this.#hidden) {
      if (hidden.has(element)) continue;
      element.style.display = display;
      this.#hidden.delete(element);
    }
    for (const element of hidden) {
      if (this.#hidden.has(element)) continue;
      this.#hidden.set(element, element.style.display);
      element.style.display = "none";
    }
    this.#scale = scale;

    this.#sizedDimension = dimension;
    this.#laidOut = orientation;
    this.#laidOutStacked = stacked;
    // On the group too, so a host can style either orientation.
    this.dataset.orientation = orientation;
  }
}
