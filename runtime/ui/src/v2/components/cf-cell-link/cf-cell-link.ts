import { consume } from "@lit/context";
import { css, html, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";

import "../cf-chip/index.ts";

import { CFC_POLICY_PLACEHOLDER_TEXT } from "@commonfabric/html/client";
import type { DID } from "@commonfabric/identity/did";
import {
  navigate,
  type NavigationCommand,
  NEW_TAB_RESERVE_AFTER_MS,
  openInNewTab,
  openInNewTabWhenReady,
} from "@commonfabric/navigation";
import {
  type CellHandle,
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
 * A press on a labelled link: the pointer that began it, what it resolves,
 * and what it resolved.
 */
type LinkPress = {
  readonly pointerId: number;
  readonly resolution: Promise<CellHandle | undefined>;
  target?: CellHandle;
};

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
 * A link given a `label` shows that label and never its target's name, so it
 * reads nothing of its target while it is only on screen. It resolves where it
 * points when it is pressed or clicked, or when `resolveTarget()` is called,
 * and a click navigates to where it points at that moment. Following every
 * shown link would make a list of N labelled links read N targets for each
 * viewer, and under server execution a read of a piece's result document
 * starts that piece for the reader.
 *
 * @element cf-cell-link
 *
 * @property {string} link - The serialized path to a cell (e.g. /of:fid1:abc.../path)
 * @property {CellHandle} cell - The live Cell reference
 * @property {string} label - Text shown in place of the target's name; a
 *   labelled link resolves only when acted on
 * @property {boolean} static - Suppress drag behavior
 *
 * @example
 * <cf-cell-link .link=${"/of:fid1:abc.../path"}></cf-cell-link>
 * <cf-cell-link .cell=${myCell}></cf-cell-link>
 * <cf-cell-link .cell=${myCell} static></cf-cell-link>
 */
export class CFCellLink extends BaseElement {
  /**
   * How long a labelled link's Cmd- or Ctrl-click waits for its target before
   * it reserves the new tab (`openInNewTabWhenReady`). A target found sooner
   * opens while the click still allows a host to open a tab of its own.
   */
  static newTabReserveAfterMs = NEW_TAB_RESERVE_AFTER_MS;

  /**
   * How long a released press is kept for the click that ends it. A touch
   * screen dispatches that click a while after the release; a press no click
   * follows is let go after this.
   */
  static releasedPressHoldMs = 1000;

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
   * The press in progress on a labelled link: the resolution it started, and
   * its target once that lands. Only the click that ends the press uses the
   * resolution, and a drag moves only its target. A press that ends without
   * a click, cancelled or released elsewhere, leaves nothing for a later one.
   */
  private _press: LinkPress | undefined = undefined;

  /**
   * Whether the link resolves only when acted on: a labelled link shows its
   * label, never its target's name, so nothing is read while it is shown.
   */
  private get _resolvesOnDemand(): boolean {
    return !!this.label;
  }

  /**
   * Resolves where the link points now, records it as the resolved cell, and
   * returns it: `undefined` when the link names nothing readable, or when the
   * element's input changes or it is detached before the resolution lands. An
   * unlabelled link follows its target from the moment it is shown, so this
   * returns the target it already follows.
   */
  resolveTarget(): Promise<CellHandle | undefined> {
    if (!this._resolvesOnDemand) return Promise.resolve(this._resolvedCell);
    const generation = this._resolveCellGeneration;
    const superseded = () =>
      generation !== this._resolveCellGeneration || !this.isConnected;
    let source: CellHandle | undefined;
    try {
      source = this.cell ?? this._cellForLink();
    } catch (e) {
      console.error("Failed to resolve link:", e);
      return Promise.resolve(undefined);
    }
    if (!source) return Promise.resolve(undefined);
    const resolving = source;
    // A click navigates to the answer at once, so it waits for the documents
    // the links pass through rather than take the first one still to arrive.
    return resolving.resolveAsCell({ loaded: true }).then(
      (resolved) => {
        if (superseded()) return undefined;
        this._setResolvedCell(resolved);
        return resolved;
      },
      (e) => {
        // A disposal race (logout, runtime swap) cancels the resolve, as it
        // does for a followed link.
        if (superseded() || resolving.runtime().signal.aborted) {
          return undefined;
        }
        console.error("Failed to resolve cell:", e);
        return undefined;
      },
    );
  }

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
      // The press ended in a drag, so no click will use what it resolved.
      this._press = undefined;
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
      changedProperties.has("runtime") || changedProperties.has("space") ||
      changedProperties.has("label")
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
    const superseded = () => generation !== this._resolveCellGeneration;
    const cell = this.cell;
    const link = this.link;
    const runtime = this.runtime;

    if (this._resolvesOnDemand) {
      // A labelled link reads nothing until it is acted on; whatever an
      // earlier input resolved or followed no longer applies.
      this._press = undefined;
      this.#linkTarget.cancel();
      this._prepareSubscriptionTarget(undefined);
      this._setResolvedCell(undefined);
      return;
    }

    if (cell) {
      this._prepareSubscriptionTarget(this._cellKey(cell));
      try {
        const followed = await this.#linkTarget.follow(cell, superseded);
        if (followed) this._setResolvedCell(followed.cell);
      } catch (e) {
        if (superseded()) return;
        // A disposal race (logout, runtime swap) cancels the resolve; that is
        // cancellation, not a failure to surface. Read the cell's own runtime,
        // not the ambient `this.runtime` (cleared to undefined on logout).
        if (cell.runtime().signal.aborted) return;
        console.error("Failed to resolve cell:", e);
        this.#linkTarget.cancel();
        this._prepareSubscriptionTarget(undefined);
        this._setResolvedCell(undefined);
      }
      return;
    }

    if (link && runtime) {
      try {
        const linkedCell = this._cellForLink()!;
        this._prepareSubscriptionTarget(this._cellKey(linkedCell));
        const followed = await this.#linkTarget.follow(linkedCell, superseded);
        if (followed) this._setResolvedCell(followed.cell);
      } catch (e) {
        if (superseded()) return;
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
   * The cell `link` names, in the space the element is shown in: `undefined`
   * with no link or no runtime to resolve it in.
   *
   * @throws when the link names no space.
   */
  private _cellForLink(): CellHandle | undefined {
    const link = this.link;
    const runtime = this.runtime;
    if (!link || !runtime) return undefined;
    // TODO(runtime-worker-refactor): Making some changes here, but
    // `this.space` will be Shell's active space, not necessarily the
    // space for `this.link`.
    const parsedLink = parseLLMFriendlyLink(link, this.space);
    if (!parsedLink.space) {
      throw new Error("Link missing space.");
    }
    return runtime.getCellFromRef(parsedLink as CellRef);
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

    // A labelled link never shows its target's name, so it does not ask for it.
    if (cell && !this._resolvesOnDemand) {
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
    // A press is the first sign of intent, so a labelled link starts resolving
    // here, for the click or the drag that follows.
    if (this._resolvesOnDemand) this._beginPress(e.pointerId);
    if (this.isStatic || (!this._resolvedCell && !this._resolvesOnDemand)) {
      return;
    }

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

  /**
   * Helper for `_onPointerDown()`, which starts resolving a labelled link's
   * target for the press that has begun, and lets the press go once it ends.
   * Only the pointer that began the press, `pointerId`, ends it. A cancelled
   * press ends no click and is let go at once. A released one is kept for the
   * click that ends it, which a mouse dispatches right after its `pointerup`
   * and a touch screen a while later, and is let go after
   * `releasedPressHoldMs` if no click comes. A later press replaces it.
   */
  private _beginPress(pointerId: number) {
    const press: LinkPress = {
      pointerId,
      resolution: this.resolveTarget().then((target) => {
        if (this._press === press) press.target = target;
        return target;
      }),
    };
    this._press = press;
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      const letGo = () => {
        if (this._press === press) this._press = undefined;
      };
      if (event.type === "pointercancel") letGo();
      else setTimeout(letGo, CFCellLink.releasedPressHoldMs);
    };
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  }

  private _onPointerMove(e: PointerEvent) {
    if (!this._isTracking || e.pointerId !== this._pointerId) return;

    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;

    // A labelled link drags only what this press resolved, which may still be
    // on its way; the drag starts on the first move after it lands.
    const target = this._resolvesOnDemand
      ? this._press?.target
      : this._resolvedCell;
    if (!this._isDragging && target && Math.sqrt(dx * dx + dy * dy) > 5) {
      this._isDragging = true;
      this._beginDrag(e, target);
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

  /** Starts dragging `target`, the cell the link resolved to. */
  private _beginDrag(e: PointerEvent, target: CellHandle) {
    this.classList.add("dragging");

    const { preview, cleanup } = createDragPreview(target);
    document.body.appendChild(preview);

    preview.style.left = `${e.clientX + 10}px`;
    preview.style.top = `${e.clientY + 10}px`;
    this._preview = preview;

    startDrag({
      cell: target,
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
    const newTab = e.metaKey || e.ctrlKey;
    if (this._resolvesOnDemand) {
      // Only a click the press's own pointer made ends the press. A click the
      // keyboard makes (no detail, no pointer) resolves on its own, and
      // leaves a press another pointer holds to the click that ends it.
      const pointerId = (e as Partial<PointerEvent>).pointerId;
      const press = this._press !== undefined && e.detail > 0 &&
          (pointerId === undefined || pointerId === this._press.pointerId)
        ? this._press
        : undefined;
      if (press !== undefined) this._press = undefined;
      // A target the press this click ends has already resolved opens now,
      // within the click.
      if (press?.target !== undefined) {
        this._open(press.target, newTab);
        return;
      }
      // Otherwise where the link points at the click: what that press is
      // resolving, or, for a click with no press of its own (the keyboard's,
      // or one after a press was let go), a resolution now. A press survives
      // only while the link's input is unchanged, so its resolution started
      // in the generation the click sees.
      const generation = this._resolveCellGeneration;
      const resolving = press?.resolution ?? this.resolveTarget();
      // A link taken off the page, or whose input changed, before its target
      // arrived was cancelled, not left unfollowable, so it neither opens nor
      // warns. A target that did arrive for the link as clicked still opens.
      const cancelled = (target: CellHandle | undefined) =>
        !this.isConnected ||
        (target === undefined && generation !== this._resolveCellGeneration);
      if (newTab) {
        // A browser opens a tab only close to the gesture that asked for it.
        // A target found soon opens as usual; a slow one gets a tab reserved
        // for it while the gesture still allows one.
        void openInNewTabWhenReady(
          resolving.then((target) => {
            if (cancelled(target)) return undefined;
            if (!target) this._warnUnfollowed();
            return target && this._viewOf(target);
          }),
          { reserveAfterMs: CFCellLink.newTabReserveAfterMs },
        );
        return;
      }
      void resolving.then((target) => {
        if (cancelled(target)) return;
        this._open(target, false);
      });
      return;
    }
    this._open(this._resolvedCell, newTab);
  }

  /**
   * Helper for `_handleClick()`, which shows `target` in this tab, or in a new
   * one when `newTab` is set, and says which link it could not follow when
   * there is no target.
   */
  private _open(target: CellHandle | undefined, newTab: boolean) {
    if (!target) {
      this._warnUnfollowed();
      return;
    }
    const view = this._viewOf(target);
    // Cmd (Mac) or Ctrl (Windows/Linux) opens in new tab
    if (newTab) {
      openInNewTab(view);
    } else {
      navigate(view);
    }
  }

  /** The view a click on a link that lands on `target` navigates to. */
  private _viewOf(target: CellHandle): NavigationCommand {
    const { scope, path } = target.ref();
    return {
      spaceDid: target.space(),
      pieceId: target.id(),
      ...(scope === "space" ? {} : { pieceScope: scope }),
      ...(path.length === 0 ? {} : { piecePath: [...path] }),
    };
  }

  /**
   * Says which link a click could not follow. The pill shows its label
   * whether or not the link resolved, so a click that opens nothing says so.
   */
  private _warnUnfollowed() {
    console.warn(
      "cf-cell-link: the click opens nothing: the link names no cell to open.",
      this._unfollowedLinkSummary(),
    );
  }

  /**
   * Helper for `_handleClick()`, which describes the link a click could not
   * follow: the label it shows, and the cell or link it was given.
   */
  private _unfollowedLinkSummary(): Record<string, unknown> {
    const ref = this.cell?.ref();
    return {
      label: this.label ?? this._name,
      ...(ref === undefined ? {} : {
        cell: {
          space: ref.space,
          id: ref.id,
          scope: ref.scope ?? "space",
          path: [...ref.path],
        },
      }),
      ...(this.link === undefined ? {} : { link: this.link }),
    };
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
