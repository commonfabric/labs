import { getPieceBoundary, render } from "@commonfabric/html/client";
import type { DID } from "@commonfabric/identity";
import { navigate, openInNewTab } from "@commonfabric/navigation";
import {
  type CellHandle,
  CHIP_UI,
  isCellHandle,
  TILE_UI,
  type VNode,
} from "@commonfabric/runtime-client";
import { css, html, PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";

import { BaseElement } from "../../core/base-element.ts";

import "../cf-loader/index.ts";
import "../cf-cell-link/index.ts";
import "../cf-piece-menu/index.ts";

import {
  closePieceMenuFor,
  openPieceMenu,
} from "../cf-piece-menu/cf-piece-menu.ts";

// Set to true to enable debug logging
const DEBUG_LOGGING = false;

/**
 * UI variants (CT-1321): the size/representation spectrum a piece can expose.
 * Each variant is an optional sibling key on the piece output, addressed by a
 * vended symbol; absent variants fail over to a per-variant platform default,
 * with the full [UI] as the universal floor. Patterns that export only [UI]
 * still render correctly at every variant.
 *
 * - `full`   — the main [UI] export; standalone rendering (default).
 * - `chip`   — inline-block in text/lists. Key: [CHIP_UI].
 *              Default: a `cf-cell-link` bound to the piece (renders by [NAME]).
 * - `tile`   — gallery/grid card. Key: [TILE_UI].
 *              Default: the full [UI] rendered small at ~0.5 scale.
 */
export type UIVariant = "full" | "chip" | "tile";

/**
 * The event a right-click on a rendered piece dispatches, announcing which
 * piece the pointer is over before the piece menu opens.
 *
 * It is cancellable: a host that calls `preventDefault()` takes the click and
 * is responsible for what happens next, and the built-in menu does not open.
 */
export const PIECE_CONTEXT_MENU_EVENT = "cf-piece-context-menu";

/** Where the click landed, and which piece it landed on. */
export interface PieceContextMenuDetail {
  /** The space holding the piece. */
  space: DID;

  /** The piece's full schemed id. */
  pieceId: string;

  /** Client X coordinate of the click, for placing the menu. */
  x: number;

  /** Client Y coordinate of the click, read the same way. */
  y: number;

  /** The variant the piece was rendered at. */
  variant: UIVariant;
}

/**
 * True for a target whose own context menu is the useful one: text editing
 * offers cut, copy, and paste, which a piece menu would replace. Read
 * structurally, so a target from another document or realm still matches.
 */
function isTextEntry(target: EventTarget | undefined): boolean {
  const element = target as
    | { tagName?: unknown; isContentEditable?: unknown }
    | undefined;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
    element.isContentEditable === true;
}

/**
 * Normalize the `variant` attribute to the size spectrum. Anything unrecognized
 * (undefined, legacy values) resolves to "full", the universal floor.
 */
export function normalizeVariant(variant: string | undefined): UIVariant {
  return variant === "chip" ? "chip" : variant === "tile" ? "tile" : "full";
}

/**
 * True when a piece output value carries a renderable variant at `key` (e.g.
 * `"$CHIP_UI"`). Used to decide whether to render the exported variant or fall
 * over to the platform default.
 */
export function hasVariantValue(value: unknown, key: string): boolean {
  return !!(value && typeof value === "object" &&
    (value as Record<string, unknown>)[key]);
}

/**
 * CFRender - Renders a cell that contains a piece pattern with UI
 *
 * @element cf-render
 *
 * @property {CellHandle | undefined} cell - The cell containing the piece to
 *   render
 * @property {UIVariant} variant - UI variant to render: "full" | "chip" | "tile"
 *   (default "full"). Renders the piece's matching variant key ([CHIP_UI] /
 *   [TILE_UI]) when exported, otherwise the per-variant platform default. The
 *   full [UI] is the universal floor, so every piece renders at every variant.
 *
 * @example
 * // Full standalone rendering (default)
 * <cf-render .cell=${myPieceCell}></cf-render>
 *
 * @example
 * // Chip: inline, renders [CHIP_UI] or a cf-cell-link default
 * <cf-render .cell=${myPieceCell} variant="chip"></cf-render>
 *
 * @example
 * // Tile: gallery card, renders [TILE_UI] or the full [UI] at ~0.5 scale
 * <cf-render .cell=${myPieceCell} variant="tile"></cf-render>
 */
export class CFRender extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    /* Chip is an inline, content-sized rendering for text/list/row contexts —
      not a full-size block. */
    :host([variant="chip"]) {
      display: inline-block;
      width: auto;
      height: auto;
      overflow: visible;
    }

    .render-stack {
      display: grid;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }

    .render-container,
    .piece-menu-highlight {
      grid-area: 1 / 1;
      min-width: 0;
      min-height: 0;
    }

    .render-container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: auto;
    }

    .piece-menu-highlight {
      z-index: 1;
      pointer-events: none;
      opacity: 0;
    }

    :host([data-cf-piece-menu-open]) .render-stack,
    :host([data-cf-piece-menu-open]) .render-container {
      isolation: isolate;
    }

    :host([data-cf-piece-menu-open]) .piece-menu-highlight {
      opacity: 1;
      background-color: rgba(99, 102, 241, 0.14);
      background-image: linear-gradient(
        135deg,
        rgba(255, 255, 255, 0) 26%,
        rgba(255, 255, 255, 0.64) 48%,
        rgba(103, 232, 249, 0.36) 54%,
        rgba(255, 255, 255, 0) 72%
      );
      background-position: 200% 0;
      background-repeat: no-repeat;
      background-size: 250% 100%;
      box-shadow: inset 0 0 2.5rem rgba(129, 140, 248, 0.38);
      animation: cf-piece-menu-shine 1.7s ease-in-out;
    }

    @keyframes cf-piece-menu-shine {
      from {
        background-position: 200% 0;
      }
      to {
        background-position: -200% 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host([data-cf-piece-menu-open]) .piece-menu-highlight {
        animation: none;
        background-position: 50% 0;
      }
    }

    @media (forced-colors: active) {
      :host([data-cf-piece-menu-open]) .piece-menu-highlight {
        forced-color-adjust: none;
        background-color: transparent;
        background-image: linear-gradient(
          135deg,
          transparent 26%,
          Highlight 48%,
          transparent 72%
        );
        box-shadow: inset 0 0 0 0.25rem Highlight;
      }
    }

    :host([variant="chip"]) .render-container {
      display: inline-block;
      width: auto;
      height: auto;
      overflow: visible;
    }

    :host([variant="chip"]) .render-stack {
      display: inline-grid;
      width: auto;
      height: auto;
      align-items: baseline;
      vertical-align: baseline;
    }

    :host([variant="chip"]) .piece-menu-highlight {
      align-self: stretch;
    }

    /* Tile default: a fixed, clickable preview that navigates to the piece.
      The clip box pins the viewport (no panning/scrolling); the inner box is
      laid out at 2x then scaled to 0.5 so the full [UI] fills the tile. */
    .tile-clip {
      width: 100%;
      height: 100%;
      overflow: hidden;
      cursor: pointer;
    }

    .tile-default {
      width: 200%;
      height: 200%;
      transform: scale(0.5);
      transform-origin: top left;
      /* Clicks fall through to .tile-clip so the whole tile navigates,
        rather than activating controls inside the embedded UI. */
      pointer-events: none;
    }

    .loading-spinner {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }

    :host {
      position: relative;
    }
  `;

  static override properties = {
    cell: { attribute: false },
    // Reflected so the host can size itself per variant (chip is inline).
    variant: { type: String, reflect: true },
  };

  declare cell: CellHandle | undefined;
  declare variant: UIVariant | undefined;

  /** Lit ref to the container, which stays stable across re-renders. */
  private _containerRef: Ref<HTMLDivElement> = createRef();

  private _cleanup?: () => void;
  private _linkTargetCell?: CellHandle;
  private _linkTargetObserved?: CellHandle;
  private _linkTargetSetup?: Promise<CellHandle | undefined>;
  private _linkTargetToken?: object;
  private _linkTargetUnsubscribe?: () => void;

  /**
   * Render generation. Each render captures one, so older asynchronous work
   * cannot install a result after the cell or variant changes.
   */
  private _renderGeneration = 0;

  #needsReconnectRender = false;

  /**
   * The root piece cell after resolving the (possibly link) `cell`. Reset
   * whenever `cell` changes.
   */
  private _resolvedCell?: CellHandle;

  @state()
  private accessor _hasRendered = false;
  private _startPromise?: Promise<boolean>;

  //
  // Debug helpers
  //

  private _instanceId = DEBUG_LOGGING
    ? Math.random().toString(36).substring(7)
    : "";
  private _log(...args: unknown[]) {
    if (DEBUG_LOGGING) {
      console.log(`[cf-render ${this._instanceId}]`, ...args);
    }
  }

  /** Exposes the render container, generation, and render entry for focused tests. */
  get accessForTestingOnly(): {
    containerRef: Ref<HTMLDivElement>;
    readonly renderGeneration: number;
    renderCell(): Promise<void>;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get containerRef() {
        return outerThis._containerRef;
      },
      set containerRef(value) {
        outerThis._containerRef = value;
      },
      get renderGeneration() {
        return outerThis._renderGeneration;
      },
      renderCell: () => this._renderCell(),
    };
  }

  protected override render() {
    // Chip is inline and resolves to a lightweight default fast — a full-size
    // spinner would reserve the wrong space, so skip it for chip.
    return html`
      ${!this._hasRendered && this.variant !== "chip"
        ? html`
          <div class="loading-spinner">
            <cf-loader size="lg"></cf-loader>
          </div>
        `
        : null}
      <div class="render-stack">
        <div class="render-container" ${ref(this._containerRef)}></div>
        <div class="piece-menu-highlight" aria-hidden="true"></div>
      </div>
    `;
  }

  protected override updated(changedProperties: PropertyValues) {
    if (!this.isConnected) return;
    this._log(
      "updated called, changedProperties:",
      Array.from(changedProperties.keys()),
    );

    const cellChanged = changedProperties.has("cell");
    const variantChanged = changedProperties.has("variant");

    if (cellChanged || variantChanged || this.#needsReconnectRender) {
      let shouldRerender = this.#needsReconnectRender;
      this.#needsReconnectRender = false;

      if (cellChanged) {
        const oldCell = changedProperties.get("cell") as CellHandle | undefined;
        // A reconnect also invalidates the cached target, even for an equal cell.
        shouldRerender ||= !oldCell || !this.cell || !oldCell.equals(this.cell);
        this._log("cell property changed, should rerender:", shouldRerender);

        if (shouldRerender) {
          closePieceMenuFor(this);
          // Reset render state when cell changes - ensures we'll render the new cell
          this._cleanupLinkTargetSubscription();
          this._hasRendered = false;
          this._resolvedCell = undefined;
        }
      }

      if (variantChanged) {
        const oldVariant = changedProperties.get("variant") as
          | UIVariant
          | undefined;
        if (oldVariant !== this.variant) {
          shouldRerender = true;
          this._log("variant changed:", oldVariant, "->", this.variant);
        }
      }

      if (shouldRerender) {
        this._log("re-rendering due to cell or variant change");
        this._renderCell();
      }
    }
  }

  private async _renderCell() {
    const generation = ++this._renderGeneration;
    const container = this._containerRef.value;
    const cell = this.cell;
    this._cleanupRender();
    if (!container || !cell || cell.runtime().signal.aborted) return;
    const cancelled = () =>
      this._renderGeneration !== generation ||
      cell.runtime().signal.aborted;

    const cellId = cell.id();
    this._log(`_renderCell called: ${cellId}`);

    try {
      // Normalize to the size spectrum; anything unknown renders full.
      const kind = normalizeVariant(this.variant);

      // Pieces passed through patterns (e.g. piece-grid) arrive as LINKS, not
      // the root piece cell. Resolve every variant to the target piece so full
      // nested rendering and its piece menu address the same entity.
      await this._startPromise;
      if (cancelled()) return;
      const resolved = await cell.resolveAsCell();
      if (cancelled()) return;
      const currentTarget = await this._watchLinkTarget(cell, resolved);
      if (cancelled()) return;
      if (currentTarget === undefined) {
        this._resolvedCell = undefined;
        this.#showUnavailable();
        return;
      }
      this._resolvedCell = currentTarget;

      // Full is the universal floor: render the piece's [UI] chain directly.
      if (kind === "full") {
        this._log("rendering full [UI] into container");
        this._cleanup = render(
          container,
          cell as CellHandle<VNode>,
          this.#renderErrorOptions(generation),
        );
        this._hasRendered = true;
        return;
      }

      // Chip and tile inspect exported variant keys before falling back.
      await currentTarget.sync();
      if (cancelled()) return;

      const variantKey = kind === "chip" ? CHIP_UI : TILE_UI;
      if (this._cellHasKey(currentTarget, variantKey)) {
        this._log(`rendering exported ${variantKey}`);
        this._cleanup = render(
          container,
          (currentTarget as CellHandle<Record<string, VNode>>)
            .key(variantKey) as CellHandle<VNode>,
          this.#renderErrorOptions(generation),
        );
        this._hasRendered = true;
        return;
      }

      // Failover to the per-variant platform default.
      this._cleanup = kind === "chip"
        ? this._renderChipDefault(container, currentTarget)
        : this._renderTileDefault(container, currentTarget);
      this._hasRendered = true;
    } catch (error) {
      // Only show error if we're still rendering this cell
      if (!cancelled()) {
        this._handleRenderError(error);
      }
    }
  }

  private async _watchLinkTarget(
    cell: CellHandle,
    resolved: CellHandle,
  ): Promise<CellHandle | undefined> {
    if (
      this._linkTargetToken !== undefined &&
      this._linkTargetCell?.equals(cell)
    ) {
      if (this._linkTargetSetup !== undefined) {
        return await this._linkTargetSetup;
      }
      return this._linkTargetObserved;
    }
    if (resolved.equals(cell)) {
      this._cleanupLinkTargetSubscription();
      return resolved;
    }

    this._cleanupLinkTargetSubscription();
    const token = {};
    this._linkTargetCell = cell;
    this._linkTargetToken = token;
    const setup = this._setupLinkTargetSubscription(cell, token);
    this._linkTargetSetup = setup;
    try {
      return await setup;
    } finally {
      if (this._linkTargetSetup === setup) {
        this._linkTargetSetup = undefined;
      }
    }
  }

  private async _setupLinkTargetSubscription(
    cell: CellHandle,
    token: object,
  ): Promise<CellHandle | undefined> {
    // This schema reports the current target as a Cell. The subscription can
    // also wake for a write within that target, so the callback compares target
    // identity before starting another render.
    const linkCell = cell.asSchema<CellHandle>({ asCell: ["cell"] });
    try {
      const synchronizedTarget = await linkCell.sync();
      if (
        this._linkTargetToken !== token ||
        !this.cell?.equals(cell)
      ) {
        return undefined;
      }
      let observedTarget = isCellHandle(synchronizedTarget)
        ? synchronizedTarget
        : undefined;
      this._linkTargetObserved = observedTarget;
      const unsubscribe = linkCell.subscribe((nextTarget) => {
        const validTarget = isCellHandle(nextTarget) ? nextTarget : undefined;
        if (
          validTarget === undefined
            ? observedTarget === undefined
            : validTarget.equals(observedTarget)
        ) {
          return;
        }
        if (this._linkTargetToken !== token) return;
        if (!this.cell?.equals(cell)) return;
        closePieceMenuFor(this);
        observedTarget = validTarget;
        this._linkTargetObserved = validTarget;
        this._resolvedCell = undefined;
        if (validTarget === undefined) {
          this._renderGeneration++;
          this._hasRendered = true;
          this._cleanupRender();
          this.#showUnavailable();
        } else {
          this._hasRendered = false;
          void this._renderCell();
        }
      });
      if (this._linkTargetToken === token) {
        this._linkTargetUnsubscribe = unsubscribe;
      } else {
        unsubscribe();
      }
      return observedTarget;
    } catch (error) {
      if (this._linkTargetToken === token) {
        this._linkTargetToken = undefined;
        this._linkTargetCell = undefined;
        this._linkTargetObserved = undefined;
      }
      throw error;
    }
  }

  private _cleanupLinkTargetSubscription(): void {
    const unsubscribe = this._linkTargetUnsubscribe;
    this._linkTargetToken = undefined;
    this._linkTargetUnsubscribe = undefined;
    this._linkTargetCell = undefined;
    this._linkTargetObserved = undefined;
    this._linkTargetSetup = undefined;
    unsubscribe?.();
  }

  /** True when the piece output exports a value at `key` (e.g. a variant UI). */
  private _cellHasKey(cell: CellHandle, key: string): boolean {
    try {
      return hasVariantValue(cell.get(), key);
    } catch {
      return false;
    }
  }

  /** Chip default: a cf-cell-link bound to the piece (renders by [NAME]). */
  private _renderChipDefault(
    container: HTMLElement,
    cell: CellHandle,
  ): () => void {
    const link = globalThis.document.createElement(
      "cf-cell-link",
    ) as HTMLElement & { cell?: CellHandle };
    link.cell = cell;
    container.appendChild(link);
    return () => link.remove();
  }

  /**
   * Tile default: the full [UI] rendered small at ~0.5 scale, clipped to a
   * fixed preview (no panning) and clickable to navigate to the piece —
   * mirroring cf-cell-link's navigation.
   */
  private _renderTileDefault(
    container: HTMLElement,
    cell: CellHandle,
  ): () => void {
    const clip = globalThis.document.createElement("div");
    clip.className = "tile-clip";
    const scaler = globalThis.document.createElement("div");
    scaler.className = "tile-default";
    clip.appendChild(scaler);
    container.appendChild(clip);
    const inner = render(
      scaler,
      cell as CellHandle<VNode>,
      this.#renderErrorOptions(this._renderGeneration),
    );
    const onClick = (e: MouseEvent) => this._navigateToPiece(e);
    clip.addEventListener("click", onClick);
    return () => {
      clip.removeEventListener("click", onClick);
      inner?.();
      clip.remove();
    };
  }

  /**
   * The piece this element renders, when the rendered cell IS a piece: a
   * whole result cell, not a value inside one. Every variant resolves its
   * possibly linked cell during render, so that resolved root is the target.
   */
  private _pieceTarget(): CellHandle | undefined {
    const cell = this._resolvedCell ?? this.cell;
    if (!cell) return undefined;
    try {
      return cell.ref().path.length === 0 ? cell : undefined;
    } catch {
      return undefined;
    }
  }

  /** The deepest nested pattern root in the click path, when there is one. */
  private _nestedPieceTarget(
    event: MouseEvent,
  ): { cell: CellHandle; element: Element } | undefined {
    const path = event.composedPath();
    const rendererIndex = path.indexOf(this);
    if (rendererIndex < 0) return undefined;
    return getPieceBoundary(path[0], (target) => {
      const providerIndex = path.indexOf(target.element);
      if (
        providerIndex < 0 || providerIndex >= rendererIndex ||
        !isCellHandle(target.cell)
      ) return false;
      try {
        return target.cell.ref().path.length === 0;
      } catch {
        return false;
      }
    });
  }

  /**
   * Open the piece's menu on right-click. The innermost rendered piece claims
   * the click, so right-clicking a tile inside a piece addresses the tile.
   *
   * The announcement goes out first, so a host can cancel it and show its own
   * menu for the piece instead. Either way the platform menu is suppressed,
   * because either way something replaces it.
   *
   * A click with no piece target, one on a text entry, and one held with Shift
   * are not announced at all; Shift is how to reach the browser's own menu over
   * piece content.
   */
  private _onContextMenu = (e: MouseEvent) => {
    if (e.shiftKey || isTextEntry(e.composedPath()[0])) return;
    const nestedTarget = this._nestedPieceTarget(e);
    const target = nestedTarget?.cell ?? this._pieceTarget();
    if (!target) return;
    const detail: PieceContextMenuDetail = {
      space: target.space(),
      pieceId: target.id(),
      x: e.clientX,
      y: e.clientY,
      variant: nestedTarget ? "full" : normalizeVariant(this.variant),
    };
    const claimed = !this.dispatchEvent(
      new CustomEvent<PieceContextMenuDetail>(PIECE_CONTEXT_MENU_EVENT, {
        detail,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    e.preventDefault();
    e.stopPropagation();
    // A host that cancelled is showing its own menu for this piece.
    if (claimed) return;
    openPieceMenu({
      cell: target,
      x: e.clientX,
      y: e.clientY,
      themeFrom: this,
      highlightedPiece: this,
      highlightTarget: nestedTarget?.element,
    });
  };

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("contextmenu", this._onContextMenu);
    // DOM moves reconnect this instance with unchanged properties, after its
    // previous render and link subscription have been released.
    if (this.hasUpdated) this.requestUpdate();
  }

  /** Navigate to the rendered piece (same behavior as cf-cell-link). */
  private _navigateToPiece(e: MouseEvent) {
    e.stopPropagation();
    try {
      const target = this._resolvedCell ?? this.cell;
      if (!target) return;
      const reference = target.ref();
      const view = {
        spaceDid: target.space(),
        pieceId: target.id(),
        ...(reference.scope === "space" ? {} : { pieceScope: reference.scope }),
        ...(reference.path.length === 0
          ? {}
          : { piecePath: [...reference.path] }),
      };
      // Cmd (Mac) / Ctrl (Win/Linux) opens in a new tab.
      if (e.metaKey || e.ctrlKey) {
        openInNewTab(view);
      } else {
        navigate(view);
      }
    } catch (error) {
      console.error("[cf-render] tile navigation failed:", error);
    }
  }

  private _cleanupRender() {
    if (this._cleanup) {
      this._log("cleaning up previous render");
      this._cleanup();
      this._cleanup = undefined;
    }
  }

  private _handleRenderError(error: unknown) {
    // A disposal race (runtime swap, logout) cancels an in-flight cell sync;
    // that is cancellation, not a render failure to surface.
    if (this.cell?.runtime().signal.aborted) return;
    this._cleanupRender();
    this._hasRendered = true;
    console.error("[cf-render] Error rendering cell:", error);

    const container = this._containerRef.value;
    if (container) {
      // The message can carry anything a failing pattern put in it, so it goes
      // in as text rather than as markup.
      const message = document.createElement("div");
      message.style.color =
        "var(--cf-theme-color-error, var(--cf-colors-error, #ff6057))";
      message.textContent = `Error rendering content: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      container.replaceChildren(message);
      this._cleanup = () => {
        container.replaceChildren();
      };
    }
  }

  #renderErrorOptions(generation: number) {
    return {
      onError: (error: unknown) => {
        if (this._renderGeneration === generation) {
          this._handleRenderError(error);
        }
      },
    };
  }

  #showUnavailable() {
    this._hasRendered = true;
    const container = this._containerRef.value;
    if (!container) return;
    container.textContent =
      "This piece is unavailable or you do not have access.";
    this._cleanup = () => {
      container.textContent = "";
    };
  }

  override disconnectedCallback() {
    this._log("disconnectedCallback called");
    closePieceMenuFor(this);
    this.removeEventListener("contextmenu", this._onContextMenu);
    super.disconnectedCallback();
    this._renderGeneration++;
    this.#needsReconnectRender = true;
    this._cleanupLinkTargetSubscription();
    this._resolvedCell = undefined;
    this._hasRendered = false;
    this._cleanupRender();
  }
}
