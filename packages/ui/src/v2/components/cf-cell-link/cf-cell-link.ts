import { consume } from "@lit/context";
import { css, html, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";

import "../cf-chip/index.ts";

import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";
import type { DID } from "@commonfabric/identity/did";
import { navigate, openInNewTab } from "@commonfabric/navigation";
import {
  type CellHandle,
  CellReadRefusedError,
  CellRef,
  cellRefToKey,
  NAME,
  parseLLMFriendlyLink,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import {
  createDragPreview,
  endDrag,
  startDrag,
  suppressClickAfterDrag,
  updateDragPointer,
} from "../../core/drag-state.ts";
import { LinkTargetWatch } from "../../core/link-target-watch.ts";
import { runtimeContext, spaceContext } from "../../runtime-context.ts";

/**
 * CFCellLink - Renders a link or cell as a clickable, draggable pill
 *
 * Every cell link is a drag source by default. Set `static` to suppress
 * drag behavior (used in drag previews to avoid recursion).
 *
 * A cell holding a link is followed while the element is connected: when the
 * link moves to another cell, the pill names and navigates to the new target
 * though `cell` itself is unchanged.
 *
 * @element cf-cell-link
 *
 * @property {string} link - The serialized path to a cell (e.g. /of:fid1:abc.../path)
 * @property {CellHandle} cell - The live Cell reference
 * @property {boolean} static - Suppress drag behavior
 *
 * @example
 * <cf-cell-link .link=${"/of:fid1:abc.../path"}></cf-cell-link>
 * <cf-cell-link .cell=${myCell}></cf-cell-link>
 * <cf-cell-link .cell=${myCell} static></cf-cell-link>
 */
export class CFCellLink extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        vertical-align: middle;
      }

      cf-chip {
        cursor: pointer;
        max-width: 100%;
      }

      :host(.dragging) cf-chip {
        cursor: grabbing;
        opacity: 0.5;
      }
    `,
  ];

  @property({ type: String })
  accessor link: string | undefined = undefined;

  @property({ type: String })
  accessor label: string | undefined = undefined;

  @property({ type: String })
  accessor spaceName: string | undefined = undefined;

  @property({ attribute: false })
  accessor cell: CellHandle | undefined = undefined;

  @property({ type: Boolean, reflect: true, attribute: "static" })
  accessor isStatic: boolean | undefined = undefined;

  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  @consume({ context: spaceContext, subscribe: true })
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  @state()
  private accessor _resolvedCell: CellHandle | undefined = undefined;

  @state()
  private accessor _name: string | undefined = undefined;

  @state()
  private accessor _handle: string | undefined = undefined;

  private _unsubscribe?: () => void;
  private _resolvedCellKey: string | undefined = undefined;
  private _subscribedCell: CellHandle | undefined = undefined;
  private _subscribedCellKey: string | undefined = undefined;
  private _resolveCellGeneration = 0;

  /**
   * Follows the target of a cell holding a link, so that the pill names and
   * navigates to where the link points now.
   */
  #linkTarget = new LinkTargetWatch({
    // A detached element follows nothing; reconnecting resolves again.
    isCurrent: () => this.isConnected,
    // Resolving again reads the element's current input, so a watch left on
    // a cell it has since replaced cannot install that cell's target, and a
    // resolution still in flight is dropped for the newer one.
    onRetarget: () => void this._resolveCell(),
  });

  //
  // Drag state
  //

  private _isDragging = false;
  private _isTracking = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _pointerId?: number;
  private _preview?: HTMLElement;
  private _boundPointerMove = this._onPointerMove.bind(this);
  private _boundPointerUp = this._onPointerUp.bind(this);

  override connectedCallback() {
    super.connectedCallback();
    this._updateSubscription();
    // A disconnect stopped following the link; a first connect resolves
    // through `willUpdate()` instead.
    if (this.hasUpdated) void this._resolveCell();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupSubscription();
    // A resolution still in flight would follow the link again once it lands.
    this._resolveCellGeneration++;
    this.#linkTarget.cancel();
    this._endDrag();
  }

  private _cleanupSubscription() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
    this._subscribedCell = undefined;
    this._subscribedCellKey = undefined;
  }

  private _endDrag() {
    document.removeEventListener("pointermove", this._boundPointerMove);
    document.removeEventListener("pointerup", this._boundPointerUp);
    document.removeEventListener("pointercancel", this._boundPointerUp);

    if (this._isDragging) {
      endDrag();
      this.classList.remove("dragging");
      suppressClickAfterDrag(this);
    }

    this._isDragging = false;
    this._isTracking = false;
    this._pointerId = undefined;
    this._preview = undefined;
  }

  protected override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    if (
      changedProperties.has("cell") || changedProperties.has("link") ||
      changedProperties.has("runtime") || changedProperties.has("space")
    ) {
      this._resolveCell();
    }
  }

  protected override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);

    if (changedProperties.has("_resolvedCell")) {
      this._updateSubscription();
      this._updateDisplayInfo();
    }

    // Also update display info when link changes without resolving to a new cell
    if (
      changedProperties.has("link") && !changedProperties.has("_resolvedCell")
    ) {
      this._updateDisplayInfo();
    }
  }

  private async _resolveCell() {
    const generation = ++this._resolveCellGeneration;
    const cell = this.cell;
    const link = this.link;
    const runtime = this.runtime;
    const space = this.space;

    if (cell) {
      this._prepareSubscriptionTarget(this._cellKey(cell));
      try {
        const followed = await this.#follow(cell, generation);
        if (followed) this._setResolvedCell(followed.cell);
      } catch (e) {
        if (generation !== this._resolveCellGeneration) return;
        // A disposal race (logout, runtime swap) cancels the resolve; that is
        // cancellation, not a failure to surface. Read the cell's own runtime,
        // not the ambient `this.runtime` (cleared to undefined on logout).
        if (cell.runtime().signal.aborted) return;
        this.#linkTarget.cancel();
        this._prepareSubscriptionTarget(undefined);
        this._setResolvedCell(undefined);
        // A link the worker will not say where it leads is named as
        // withheld, an answer rather than a failure.
        if (e instanceof CellReadRefusedError) {
          this._name = CFC_POLICY_PLACEHOLDER_TEXT;
          this.requestUpdate();
          return;
        }
        console.error("Failed to resolve cell:", e);
      }
      return;
    }

    if (link && runtime) {
      try {
        // TODO(runtime-worker-refactor): Making some changes here, but
        // `this.space` will be Shell's active space, not necessarily the
        // space for `this.link`.
        const parsedLink = parseLLMFriendlyLink(link, space);
        if (!parsedLink.space) {
          throw new Error("Link missing space.");
        }
        const linkedCell = runtime.getCellFromRef(parsedLink as CellRef);
        this._prepareSubscriptionTarget(this._cellKey(linkedCell));
        const followed = await this.#follow(linkedCell, generation);
        if (followed) this._setResolvedCell(followed.cell);
      } catch (e) {
        if (generation !== this._resolveCellGeneration) return;
        // A disposal race (logout, runtime swap) cancels the resolve; that is
        // cancellation, not a failure to surface. Read the runtime the linked
        // cell was built from, not the ambient `this.runtime` (cleared on logout).
        if (runtime.signal.aborted) return;
        console.error("Failed to resolve link:", e);
        this.#linkTarget.cancel();
        this._prepareSubscriptionTarget(undefined);
        this._setResolvedCell(undefined);
      }
    } else {
      this.#linkTarget.cancel();
      this._prepareSubscriptionTarget(undefined);
      this._setResolvedCell(undefined);
    }
  }

  /**
   * Helper for `_resolveCell()`, which resolves `source`, follows its link,
   * and returns the cell to show: `undefined` where the link names nothing
   * readable. Returns `undefined` in place of the result once a later
   * resolution or a disconnect supersedes the one numbered `generation`.
   */
  async #follow(
    source: CellHandle,
    generation: number,
  ): Promise<{ cell: CellHandle | undefined } | undefined> {
    const superseded = () => generation !== this._resolveCellGeneration;
    let resolved = await source.resolveAsCell();
    if (superseded()) return undefined;
    const target = await this.#linkTarget.watch(source, resolved);
    if (superseded()) return undefined;
    if (target === undefined) return { cell: undefined };
    if (!target.equals(resolved)) {
      // The watch reports every move from here on. A first hop other than the
      // first resolution means the link moved before the watch began, or
      // leads through further links, so resolving again finds where it ends.
      resolved = await source.resolveAsCell();
      if (superseded()) return undefined;
    }
    return { cell: resolved };
  }

  private _updateSubscription() {
    if (!this.isConnected) {
      this._cleanupSubscription();
      return;
    }

    const cell = this._resolvedCell;
    const nextCellKey = this._cellKey(cell);
    if (
      this._unsubscribe && nextCellKey &&
      nextCellKey === this._subscribedCellKey &&
      cell === this._subscribedCell
    ) {
      return;
    }

    this._cleanupSubscription();

    if (cell) {
      // Subscribe with a minimal schema that only resolves $NAME.
      // Without this, cells from $cell bindings arrive with schema: {}
      // (stripped from the VDOM prop's asCell wrapper), causing
      // handleCellSubscribe to walk the entire piece output graph.
      const namedCell = cell.asSchema<{ [NAME]?: string }>({
        type: "object",
        properties: { [NAME]: { type: "string" } },
      });
      this._subscribedCell = cell;
      this._subscribedCellKey = nextCellKey;
      this._unsubscribe = namedCell.subscribe((val) => {
        this._updateNameFromValue(val);
      }, {
        // A name the worker will not show is named as withheld, not shown as
        // a link that has none.
        onRefused: () => {
          this._name = CFC_POLICY_PLACEHOLDER_TEXT;
          this.requestUpdate();
        },
      });
    }
  }

  private _setResolvedCell(cell: CellHandle | undefined) {
    const nextCellKey = this._cellKey(cell);
    if (cell === this._resolvedCell && nextCellKey === this._resolvedCellKey) {
      // `_prepareSubscriptionTarget()` drops the `$NAME` subscription when the
      // cell being resolved differs from its target, and no update follows an
      // unchanged target to restore it.
      this._updateSubscription();
      return;
    }
    this._resolvedCell = cell;
    this._resolvedCellKey = nextCellKey;
  }

  private _cellKey(cell: CellHandle | undefined): string | undefined {
    return cell
      ? cellRefToKey({ ...cell.ref(), schema: undefined })
      : undefined;
  }

  private _prepareSubscriptionTarget(nextCellKey: string | undefined) {
    if (this._unsubscribe && nextCellKey !== this._subscribedCellKey) {
      this._cleanupSubscription();
    }
  }

  private _updateNameFromValue(val: unknown) {
    if (val && typeof val === "object" && NAME in val) {
      this._name = (val as any)[NAME];
    } else {
      this._name = undefined;
    }
    this.requestUpdate();
  }

  private _updateDisplayInfo() {
    if (this._resolvedCell) {
      const shortId = this._resolvedCell.id().slice(-6);
      this._handle = `#${shortId}`;
    } else if (this.link) {
      // Fallback if we can't resolve the cell but have a link string
      try {
        const parsed = parseLLMFriendlyLink(this.link);
        const id = parsed.id;
        const shortId = id ? id.split(":").pop()?.slice(0, 6) ?? "???" : "???";
        this._handle = `#${shortId}`;
      } catch {
        this._handle = this.link;
      }
    } else {
      this._handle = undefined;
    }
  }

  private _onPointerDown(e: PointerEvent) {
    if (this.isStatic || !this._resolvedCell) return;

    // Prevent parent cf-drag-source elements from also starting a drag
    e.stopPropagation();

    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._pointerId = e.pointerId;
    this._isTracking = true;

    document.addEventListener("pointermove", this._boundPointerMove);
    document.addEventListener("pointerup", this._boundPointerUp);
    document.addEventListener("pointercancel", this._boundPointerUp);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._isTracking || e.pointerId !== this._pointerId) return;

    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;

    if (!this._isDragging && Math.sqrt(dx * dx + dy * dy) > 5) {
      this._isDragging = true;
      this._beginDrag(e);
    }

    if (this._isDragging && this._preview) {
      this._preview.style.left = `${e.clientX + 10}px`;
      this._preview.style.top = `${e.clientY + 10}px`;
      updateDragPointer(e.clientX, e.clientY);
    }
  }

  private _onPointerUp(e: PointerEvent) {
    if (e.pointerId !== this._pointerId) return;
    this._endDrag();
  }

  private _beginDrag(e: PointerEvent) {
    if (!this._resolvedCell) return;

    this.classList.add("dragging");

    const { preview, cleanup } = createDragPreview(this._resolvedCell);
    document.body.appendChild(preview);

    preview.style.left = `${e.clientX + 10}px`;
    preview.style.top = `${e.clientY + 10}px`;
    this._preview = preview;

    startDrag({
      cell: this._resolvedCell,
      type: "cell-link",
      sourceElement: this,
      preview,
      previewCleanup: cleanup,
      pointerX: e.clientX,
      pointerY: e.clientY,
    });
  }

  private _handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (this._resolvedCell) {
      const { scope, path } = this._resolvedCell.ref();
      const view = {
        spaceDid: this._resolvedCell.space(),
        pieceId: this._resolvedCell.id(),
        ...(scope === "space" ? {} : { pieceScope: scope }),
        ...(path.length === 0 ? {} : { piecePath: [...path] }),
      };

      // Cmd (Mac) or Ctrl (Windows/Linux) opens in new tab
      if (e.metaKey || e.ctrlKey) {
        openInNewTab(view);
      } else {
        navigate(view);
      }
    }
  }

  override render() {
    // Priority: label (from markdown) > [NAME] field > handle > "Unknown Link"
    const displayText = this.label
      ? this.label
      : this._name
      ? `${this._name} ${this._handle}`
      : (this._handle || "Unknown Link");

    return html`
      <cf-chip
        color="primary"
        interactive
        @pointerdown="${this._onPointerDown}"
        @click="${this._handleClick}"
      >
        ${displayText}
      </cf-chip>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-cell-link": CFCellLink;
  }
}
