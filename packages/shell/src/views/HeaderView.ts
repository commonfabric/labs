import type { FavoriteEntry } from "@commonfabric/home-schemas";
import { type DID, KeyStore } from "@commonfabric/identity";
import { navigate } from "@commonfabric/navigation";
import { hasEntityUriScheme } from "@commonfabric/runner/entity-kind";
import { type NameSchema, nameSchema } from "@commonfabric/runner/schemas";
import { NAME } from "@commonfabric/runner/shared";
import {
  type CellHandle,
  type FavoritePieceAddress,
} from "@commonfabric/runtime-client";
import { Task, TaskStatus } from "@lit/task";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import { RuntimeInternals } from "../lib/runtime.ts";
import { BaseView } from "./BaseView.ts";

import "../components/PieceList.ts";

import {
  iconArrowLeft,
  iconBug,
  iconChevronDown,
  iconChevronRight,
  iconClose,
  iconFolder,
  iconLink,
  iconLogOut,
  iconStar,
  iconThemeToggle,
} from "../components/icons.ts";
import type { PieceItem } from "../components/PieceList.ts";
import { getEffectiveTheme, toggleTheme } from "../lib/theme-preference.ts";

type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "conflict";

/**
 * Whether two addresses name the same document. Compared by value rather than
 * by identity, an address arriving as a fresh object on each update, so that
 * two objects standing for one document are the ordinary case.
 */
function samePieceAddress(
  a: FavoritePieceAddress,
  b: FavoritePieceAddress,
): boolean {
  return a.space === b.space && a.pieceId === b.pieceId && a.scope === b.scope;
}

export class XHeaderView extends BaseView {
  static override styles = css`
    :host {
      box-sizing: border-box;
      display: block;
      width: 100%;
      height: auto;
      color: var(--font-color);
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    button {
      font-family: inherit;
      color: inherit;
    }

    svg {
      width: 100%;
      height: 100%;
    }

    /* Header bar */
    .header {
      display: flex;
      align-items: center;
      padding: 1.5rem;
      position: sticky;
      top: 0;
      z-index: 3;
      background-color: var(--shell-surface);
    }

    @media (max-width: 768px) {
      .header {
        padding: 1rem;
      }
    }

    .header-start {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 0.5rem;
    }

    /* Logo picker button */
    .nav-picker {
      display: flex;
      align-items: center;
      cursor: pointer;
      border: none;
      background: none;
      border-radius: 6px;
      padding: 0;
      overflow: hidden;
    }

    .nav-picker:hover {
      background: var(--shell-surface-hover);
    }

    .nav-picker-container {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem;
      border-radius: 6px;
    }

    .nav-picker cf-logo {
      width: 1.5rem;
      height: 1.5rem;
    }

    .chevron-down {
      width: 0.75rem;
      height: 0.75rem;
    }

    /* Header breadcrumbs (desktop only) */
    .header-breadcrumbs {
      display: none;
      align-items: center;
      gap: 0.375rem;
      min-width: 0;
    }

    @media (min-width: 769px) {
      .header-breadcrumbs {
        display: flex;
      }
    }

    .header-breadcrumbs .header-space {
      font-weight: 500;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--shell-text-muted);
      white-space: nowrap;
      cursor: pointer;
      text-decoration: none;
    }

    .header-breadcrumbs .header-space:hover {
      color: inherit;
    }

    .header-breadcrumbs .header-separator {
      color: var(--shell-text-muted);
      font-size: 0.75rem;
    }

    .header-piece-wrapper {
      position: relative;
    }

    .header-piece-trigger {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      cursor: pointer;
      border: none;
      background: none;
      padding: 0.25rem 0.375rem;
      border-radius: 6px;
      font-weight: 500;
      font-size: 0.8125rem;
      line-height: 1rem;
      font-family: inherit;
    }

    .header-piece-trigger:hover {
      background: var(--shell-surface-hover);
    }

    .header-piece-chevron {
      width: 0.625rem;
      height: 0.625rem;
      color: var(--shell-text-muted);
      display: flex;
      align-items: center;
      transition: transform 0.15s ease;
    }

    .header-piece-chevron.expanded {
      transform: rotate(180deg);
    }

    .header-piece-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 0.25rem;
      min-width: 15rem;
      max-width: 20rem;
      background: var(--shell-surface);
      border-radius: 8px;
      box-shadow:
        0px 4px 16px 0px rgba(0, 0, 0, 0.08),
        0px 3px 8px 0px rgba(0, 0, 0, 0.04),
        0px 0px 3px 0px rgba(0, 0, 0, 0.12);
      padding: 0.5rem;
      z-index: 10;
      max-height: 20rem;
      overflow-y: auto;
    }

    /* Menu overlay - desktop: dropdown, mobile: full-width */
    .menu-container {
      position: fixed;
      inset: 0;
      z-index: 4;
      pointer-events: none;
    }

    .menu-container.open {
      pointer-events: auto;
    }

    .menu-backdrop {
      position: fixed;
      inset: 0;
    }

    .menu-panel {
      background: var(--shell-surface);
      display: flex;
      flex-direction: column;
      box-shadow:
        0px 4px 16px 0px rgba(0, 0, 0, 0.08),
        0px 3px 8px 0px rgba(0, 0, 0, 0.04),
        0px 0px 3px 0px rgba(0, 0, 0, 0.12);
      z-index: 1;
      position: relative;
    }

    :host(.resizing) *,
    :host(.resizing) *::before,
    :host(.resizing) *::after {
      transition: none !important;
    }

    /* Desktop: positioned dropdown */
    @media (min-width: 769px) {
      .menu-backdrop {
        background: transparent;
      }

      .menu-panel {
        position: absolute;
        top: 0;
        left: 1rem;
        width: 20rem;
        padding: 1rem;
        border-radius: 12px;
        transform: translateY(4rem);
        opacity: 0;
        transition: opacity 0.15s ease;
        overflow: visible;
      }

      .menu-container.open .menu-panel {
        opacity: 1;
      }
    }

    /* Mobile: clip-path reveal */
    @media (max-width: 768px) {
      .menu-backdrop {
        background: var(--shell-overlay-bg);
        opacity: 0;
        transition: opacity 0.25s ease;
      }

      .menu-container.open .menu-backdrop {
        opacity: 1;
      }

      .menu-panel {
        width: 100%;
        padding: 1.5rem;
        border-radius: 0 0 16px 16px;
        overflow: hidden;
        clip-path: inset(0 0 100% 0);
        transition: clip-path 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .menu-container.open .menu-panel {
        clip-path: inset(0 0 0 0);
      }

      .menu-panel .menu-inner {
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      .menu-container.open .menu-panel .menu-inner {
        opacity: 1;
        transition: opacity 0.2s ease 0.1s;
      }
    }

    .menu-close {
      display: flex;
      align-items: center;
      cursor: pointer;
      border: none;
      background: none;
      border-radius: 6px;
      padding: 0.25rem;
      align-self: flex-start;
      margin-bottom: 1.5rem;
    }

    @media (min-width: 769px) {
      .menu-close {
        margin-bottom: 0.5rem;
      }
    }

    .menu-close:hover {
      background: var(--shell-surface-hover);
    }

    .menu-close-icon {
      width: 1.5rem;
      height: 1.5rem;
    }

    /* Menu title section */
    .menu-title {
      display: flex;
      flex-direction: column;
      padding-bottom: 0.75rem;
    }

    @media (min-width: 769px) {
      .menu-title {
        display: none;
      }
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      padding: 0.25rem 1rem;
    }

    .breadcrumb-icon {
      width: 0.75rem;
      height: 0.75rem;
      color: var(--shell-text-muted);
      flex-shrink: 0;
      display: flex;
      align-items: center;
    }

    .breadcrumb-text {
      font-weight: 500;
      font-size: 0.6875rem;
      line-height: 1rem;
      color: var(--shell-text-muted);
      letter-spacing: -0.22px;
      white-space: nowrap;
      margin-left: 0.375rem;
    }

    .breadcrumb-chevron {
      width: 0.75rem;
      height: 0.75rem;
      color: var(--shell-text-muted);
      opacity: 0.5;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      margin-left: 0.5rem;
    }

    .piece-title-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      cursor: pointer;
      border-radius: 6px;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }

    .piece-title-row:hover {
      background: var(--shell-surface-hover);
    }

    .piece-title-text {
      font-weight: 500;
      font-size: 1rem;
      line-height: 1.5rem;

      letter-spacing: -0.32px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .piece-title-chevron {
      width: 0.75rem;
      height: 0.75rem;

      flex-shrink: 0;
      margin-left: 0.125rem;
      display: flex;
      align-items: center;
      transition: transform 0.15s ease;
    }

    .piece-title-chevron.expanded {
      transform: rotate(180deg);
    }

    /* Menu items */
    .menu-rows {
      display: flex;
      flex-direction: column;
    }

    .menu-item {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      border-radius: 8px;
      cursor: pointer;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }

    .menu-item:hover {
      background: var(--shell-surface-hover);
    }

    .menu-item-icon {
      width: 1.5rem;
      height: 1.5rem;
      flex-shrink: 0;
    }

    .menu-item-label {
      font-weight: 600;
      font-size: 0.8125rem;
      line-height: 1.5rem;

      letter-spacing: 0.3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .menu-item-detail {
      font-family: var(--font-primary, ui-monospace, monospace);
      font-size: 0.75rem;
      line-height: 1.5rem;
      margin-left: auto;
      opacity: 0.7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .divider {
      height: 1rem;
      display: flex;
      align-items: center;
      width: 100%;
      padding: 0 1rem;
      box-sizing: border-box;
    }

    .divider-line {
      height: 1px;
      width: 100%;
      background: var(--shell-divider);
    }
  `;

  @property()
  private accessor keyStore: KeyStore | undefined = undefined;

  @property()
  private accessor rt: RuntimeInternals | undefined = undefined;

  @property({ attribute: false })
  accessor pieceTitle: string | undefined = undefined;

  @property({ attribute: false })
  accessor pieceId: string | undefined = undefined;

  /**
   * The whole address of the piece on screen: its space, its id there, and the
   * scope that id resolves in. This is what a favorite is taken at and matched
   * against, `pieceId` alone naming a different document in each scope.
   *
   * Undefined until the piece resolves, which is when its scope is known, so
   * the favorite row appears with the address rather than with the id.
   */
  @property({ attribute: false })
  accessor pieceAddress: FavoritePieceAddress | undefined = undefined;

  /**
   * How this piece is cited from anywhere, when it is a member of a named
   * collection: `//<space>/<collection>/<member>`, the cell reference
   * grammar's fully qualified form, which `cf` reads and this shell opens as a
   * page. Undefined for a piece reached any other way, whose identity is
   * already portable.
   */
  @property({ attribute: false })
  accessor pieceReference: string | undefined = undefined;

  @property({ attribute: false })
  accessor spaceName: string | undefined = undefined;

  @property({ attribute: false })
  accessor spaceDid: DID | undefined = undefined;

  /** The resolved space DID of the current view (view state). */
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  @property({ attribute: false })
  accessor isLoggedIn = false;

  @property()
  accessor showDebuggerView = false;

  @property({ attribute: false })
  accessor isViewingDefaultPattern = false;

  @state()
  private accessor menuOpen = false;

  @state()
  private accessor pieceListExpanded = false;

  @state()
  private accessor headerPieceDropdownOpen = false;

  @state()
  private accessor _serverFavorites: readonly FavoriteEntry[] = [];

  /**
   * What a click just asserted about a favorite, and the address it asserted
   * it at. The value means nothing apart from that address, answering for a
   * different document under any other one, so the two travel together and a
   * read under a different address takes the server's answer instead.
   */
  @state()
  private accessor _localFavorite: {
    readonly address: FavoritePieceAddress;
    readonly isFavorite: boolean;
  } | undefined = undefined;

  #unsubscribeFavorites: (() => void) | undefined;

  /** Whether a favorite toggle is in flight, which refuses a second one. */
  #isFavoriteLoading = false;

  /** Subscribe to the favorites list so the menu reflects current state. */
  #setupFavoritesSubscription(): void {
    this.#cleanupFavoritesSubscription();
    if (!this.rt) return;
    this.#unsubscribeFavorites = this.rt
      .favorites()
      .subscribeFavorites((favorites) => {
        this._serverFavorites = favorites;
        this._localFavorite = undefined;
        this.requestUpdate();
      });
  }

  /**
   * Subscribe to favorites the first time a surface that shows them is opened.
   * Reading favorites resolves the home space's default pattern, which on a
   * fresh space the runtime has to create — a one-time cost that, run eagerly
   * at login, lands in the same worker as the user's first write to a piece
   * and delays it. Deferring the subscription to the first menu open keeps that
   * work off the first-write path; the favorite toggle creates the pattern on
   * demand when the user actually favorites something.
   *
   * Idempotent while a subscription is live. After teardown — a disconnect or
   * a runtime swap clears `#unsubscribeFavorites` — the next call re-subscribes,
   * so a reconnected header is not left without favorites.
   */
  #ensureFavoritesSubscription(): void {
    if (this.#unsubscribeFavorites) return;
    this.#setupFavoritesSubscription();
  }

  /** Unsubscribe from favorites when component disconnects or runtime changes. */
  #cleanupFavoritesSubscription(): void {
    if (this.#unsubscribeFavorites) {
      this.#unsubscribeFavorites();
      this.#unsubscribeFavorites = undefined;
    }
  }

  /**
   * Derive whether the piece on screen is favorited. An optimistic value a
   * click set wins over server state, but only where that click was about
   * this same address.
   */
  #isFavorite(): boolean {
    const address = this.pieceAddress;
    if (!address) return false;
    const local = this._localFavorite;
    if (local && samePieceAddress(local.address, address)) {
      return local.isFavorite;
    }
    // CellHandle.id() is the full schemed id; the routing pieceId is bare
    // (piece roots are always of:). Normalize the bare side for equality.
    const pieceUri = hasEntityUriScheme(address.pieceId)
      ? address.pieceId
      : `of:${address.pieceId}`;
    // The whole address decides. Favorites are one list across every space, and
    // one id names a different document in each space and in each scope, so a
    // match on the id alone reports another piece's favorite as this one's.
    return this._serverFavorites.some((f) => {
      const ref = (f.cell as unknown as CellHandle<unknown>).ref();
      return ref.id === pieceUri && ref.space === address.space &&
        ref.scope === address.scope;
    });
  }

  #resizeTimer?: ReturnType<typeof setTimeout>;

  /**
   * The favorites subscription step, the favorited-piece test, the three
   * click handlers, and the piece-name task, which a test drives directly.
   */
  get accessForTestingOnly(): {
    ensureFavoritesSubscription(): void;
    isFavorite(): boolean;
    handleLogoClick(e: Event): void;
    handleToggleFavorite(e: Event): Promise<void>;
    copyReference(e: Event): Promise<void>;
    pieces: Task<
      readonly [RuntimeInternals | undefined, DID | undefined, boolean],
      PieceItem[]
    >;
  } {
    return {
      ensureFavoritesSubscription: () => this.#ensureFavoritesSubscription(),
      isFavorite: () => this.#isFavorite(),
      handleLogoClick: (e) => this.#handleLogoClick(e),
      handleToggleFavorite: (e) => this.#handleToggleFavorite(e),
      copyReference: (e) => this.#handleCopyReference(e),
      pieces: this.#pieces,
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("keydown", this.#handleKeyDown);
    globalThis.addEventListener("resize", this.#handleResize);
    globalThis.addEventListener("click", this.#closeHeaderPieceDropdown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#pieces.abort();
    this.headerPieceDropdownOpen = false;
    this.pieceListExpanded = false;
    this.#cleanupFavoritesSubscription();
    this.removeEventListener("keydown", this.#handleKeyDown);
    globalThis.removeEventListener("resize", this.#handleResize);
    globalThis.removeEventListener("click", this.#closeHeaderPieceDropdown);
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
  }

  /**
   * Temporarily disable all CSS transitions during viewport resize to
   * prevent the menu from flashing when crossing the mobile/desktop
   * breakpoint in DevTools.
   */
  #handleResize = () => {
    this.classList.add("resizing");
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.classList.remove("resizing");
    }, 150);
  };

  /** Close the innermost open dropdown on Escape, prioritizing the piece
   *  switcher over the main menu. Returns focus to the trigger on menu close. */
  #handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (this.headerPieceDropdownOpen) {
        e.preventDefault();
        this.headerPieceDropdownOpen = false;
        return;
      }
      if (this.menuOpen) {
        e.preventDefault();
        this.menuOpen = false;
        this.pieceListExpanded = false;
        this.#focusTrigger();
      }
    }
  };

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has("rt")) {
      this._serverFavorites = [];
      // The write this value records went to a runtime that is gone, and the
      // server list it would stand in front of has been dropped with it.
      this._localFavorite = undefined;
      this.#piecesCache = undefined;
      this.#cleanupFavoritesSubscription();
      // If the menu is already open when a runtime arrives, the favorites
      // surface is showing, so subscribe now; otherwise wait for the first open.
      if (this.menuOpen) this.#ensureFavoritesSubscription();
    }
    // One runtime serves every space, so a space switch no longer
    // replaces rt — the per-space pieces cache must invalidate on the
    // space itself.
    if (changedProperties.has("space")) {
      this.#piecesCache = undefined;
    }
  }

  /** Names fetched on first open, cached until the runtime or space changes. */
  #piecesCache: PieceItem[] | undefined;

  get #piecesVisible(): boolean {
    return this.headerPieceDropdownOpen ||
      (this.menuOpen && this.pieceListExpanded);
  }

  #pieces = new Task(this, {
    task: async ([rt, space, visible], { signal }): Promise<PieceItem[]> => {
      if (!rt || !space || !visible) return [];
      if (this.#piecesCache) return this.#piecesCache;

      await rt.synced(space);
      signal.throwIfAborted();
      const piecesListCell = await rt.getPiecesListCell(space);
      signal.throwIfAborted();
      await piecesListCell.sync();
      signal.throwIfAborted();
      const piecesList = piecesListCell.get() as any[];
      if (!piecesList) return [];

      const ids: string[] = [];
      for (const pieceData of piecesList) {
        const id = pieceData?.id?.() ?? pieceData?.$ID;
        if (id) ids.push(id);
      }

      const results = await Promise.allSettled(
        ids.map(async (id) => {
          // Project the persisted result to its name so menu labels do not
          // materialize each piece's output graph or start its pattern.
          const piece = await rt.getPattern(space, id, { start: false });
          signal.throwIfAborted();
          const name = await piece.cell().asSchema<NameSchema>(nameSchema)
            .sync();
          return {
            id: piece.id(),
            name: name?.[NAME] ?? `Piece #${piece.id().slice(0, 6)}`,
          };
        }),
      );

      signal.throwIfAborted();
      this.#piecesCache = results
        .filter(
          (r): r is PromiseFulfilledResult<PieceItem> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
      return this.#piecesCache;
    },
    args: () => [this.rt, this.space, this.#piecesVisible] as const,
  });

  /** Clear the keystore and identity, logging the user out. */
  #handleAuthClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.keyStore) {
      console.warn("Could not clear keystore.");
    } else {
      this.keyStore.clear().catch(console.error);
    }
    this.command({ type: "set-identity", identity: undefined });
    this.menuOpen = false;
  }

  /** Toggle the debugger panel visibility via app state command. */
  #handleDebuggerToggleClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.command({
      type: "set-config",
      key: "showDebuggerView",
      value: !this.showDebuggerView,
    });
    this.menuOpen = false;
  }

  /** Toggle between light and dark mode. */
  #handleThemeToggle(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    toggleTheme();
    this.requestUpdate();
    this.menuOpen = false;
  }

  /** Navigate to the current space root when the breadcrumb is clicked. */
  #handleSpaceClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (this.spaceName) {
      navigate({ spaceName: this.spaceName });
    } else if (this.spaceDid) {
      navigate({ spaceDid: this.spaceDid });
    }
  }

  /**
   * Open the main dropdown menu and move focus to the close button.
   */
  #handleLogoClick(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = true;
    this.#ensureFavoritesSubscription();
    this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(".menu-close")?.focus();
    });
  }

  /** Return focus to the logo trigger button after the menu closes. */
  #focusTrigger() {
    this.updateComplete.then(() => {
      this.renderRoot.querySelector<HTMLElement>(".nav-picker")?.focus();
    });
  }

  /** Close the main menu via the X button. */
  #handleCloseMenu(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this.#focusTrigger();
  }

  /** Close the main menu when the dark backdrop overlay is clicked. */
  #handleBackdropClick() {
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this.#focusTrigger();
  }

  /** Toggle the piece list inside the mobile menu. */
  #handleTogglePieceList(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.pieceListExpanded = !this.pieceListExpanded;
  }

  /** Toggle the piece switcher dropdown in the desktop header breadcrumb. */
  #handleToggleHeaderPieceDropdown(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.headerPieceDropdownOpen = !this.headerPieceDropdownOpen;
  }

  /** Close the desktop piece switcher when clicking outside of it. */
  #closeHeaderPieceDropdown = (e: Event) => {
    const path = e.composedPath();
    const wrapper = this.renderRoot.querySelector(".header-piece-wrapper");
    if (wrapper && !path.includes(wrapper)) {
      this.headerPieceDropdownOpen = false;
    }
  };

  /** Handle piece selection from either the mobile or desktop piece list. */
  #handlePieceSelected(e: Event) {
    const { id: pieceId } = (e as CustomEvent<PieceItem>).detail;
    this.menuOpen = false;
    this.pieceListExpanded = false;
    this.headerPieceDropdownOpen = false;
    if (this.spaceName) {
      navigate({ spaceName: this.spaceName, pieceId });
    } else if (this.spaceDid) {
      navigate({ spaceDid: this.spaceDid, pieceId });
    }
  }

  /**
   * Contextual navigation: when viewing a piece, go back to the space
   * root. When already at the space root, go to the user's home (/).
   */
  #handleNavigateUp(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.menuOpen = false;
    if (this.#isViewingPiece) {
      // Viewing a piece — go back to the space
      if (this.spaceName) {
        navigate({ spaceName: this.spaceName });
      } else if (this.spaceDid) {
        navigate({ spaceDid: this.spaceDid });
      }
    } else {
      // At space root — go home
      globalThis.location.href = "/";
    }
  }

  /** Whether we have a space identifier (name or DID) to navigate with. */
  get #hasSpace(): boolean {
    return !!(this.spaceName || this.spaceDid);
  }

  /** Human-readable space name, falling back to a truncated DID. */
  get #spaceDisplayName(): string {
    if (this.spaceName) return this.spaceName;
    if (this.spaceDid) return this.spaceDid.slice(0, 20) + "...";
    return "";
  }

  /** True when viewing a specific piece (not the space's default pattern). */
  get #isViewingPiece(): boolean {
    return !!(this.pieceId && this.#hasSpace && !this.isViewingDefaultPattern);
  }

  /** Label for the navigate-up button: "Back to <space>" or "Go Home". */
  get #navigateUpLabel(): string {
    if (this.#isViewingPiece) {
      return `Back to ${this.#spaceDisplayName}`;
    }
    return "Go Home";
  }

  /** Copy the current page URL to the clipboard. */
  async #handleCopyLink(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(globalThis.location.href);
    } catch {
      console.warn("Failed to copy link to clipboard");
    }
    this.menuOpen = false;
  }

  /**
   * Copy this piece's portable reference to the clipboard. It carries its own
   * space, so it depends on no binding of the copier's and resolves for
   * whoever receives it — in this shell's own URLs and in `cf`, each of which
   * reads the form that {@link XHeaderView.pieceReference} holds and walks the
   * collection it names. A pattern's `cellFromUrl` does not: it reads through
   * `parseFabricUrl`, which wants an entity id where the collection's name
   * sits.
   */
  async #handleCopyReference(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    const reference = this.pieceReference;
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
    } catch {
      console.warn("Failed to copy reference to clipboard");
    }
    this.menuOpen = false;
  }

  /**
   * Toggle the current piece's favorite status. Uses optimistic UI —
   * updates local state immediately, then syncs with the server.
   * Rolls back local state on error. Guarded against double-clicks
   * with `#isFavoriteLoading` to prevent conflicting requests.
   */
  async #handleToggleFavorite(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    const piece = this.pieceAddress;
    if (!this.rt || !piece || this.#isFavoriteLoading) {
      return;
    }

    const currentlyFavorite = this.#isFavorite();
    this._localFavorite = { address: piece, isFavorite: !currentlyFavorite };
    this.#isFavoriteLoading = true;
    // Favoriting touches the home pattern anyway; start reflecting server
    // state from here on if the menu was never opened.
    this.#ensureFavoritesSubscription();

    try {
      if (currentlyFavorite) {
        await this.rt.favorites().removeFavorite(piece);
      } else {
        await this.rt
          .favorites()
          .addFavorite(piece, undefined, this.spaceName);
      }
    } catch (err) {
      // A disposal race (logout, runtime swap) cancels the write; that is not
      // a toggle failure to surface.
      if (this.rt?.signal.aborted) return;
      console.error("[HeaderView] Error toggling favorite:", err);
      this._localFavorite = undefined;
    } finally {
      this.#isFavoriteLoading = false;
    }
  }

  /** Derive connection status from runtime availability. */
  #getConnectionStatus(): ConnectionStatus {
    return this.rt ? "connected" : "disconnected";
  }

  override render() {
    const connectionStatus = this.#getConnectionStatus();
    const connectionColor = getConnectionColor(connectionStatus);
    const isFavorite = this.#isFavorite();

    return html`
      <div class="header">
        <div class="header-start">
          <button
            class="nav-picker"
            @click="${this.#handleLogoClick}"
            aria-haspopup="true"
            aria-expanded="${this.menuOpen}"
            aria-label="Open menu"
          >
            <span class="nav-picker-container">
              <cf-logo
                .backgroundColor="${connectionColor}"
                .width="${24}"
                .height="${24}"
              ></cf-logo>
              <span class="chevron-down">${iconChevronDown()}</span>
            </span>
          </button>
          <div class="header-breadcrumbs">
            ${this.#hasSpace
              ? html`
                <a
                  class="header-space"
                  href="${this.spaceName
                    ? `/${this.spaceName}`
                    : `/${this.spaceDid ?? ""}`}"
                  @click="${this.#handleSpaceClick}"
                >${this.#spaceDisplayName}</a>
                ${this.pieceTitle
                  ? html`
                    <span class="header-separator">/</span>
                    <span class="header-piece-wrapper">
                      <button
                        class="header-piece-trigger"
                        @click="${this.#handleToggleHeaderPieceDropdown}"
                        aria-haspopup="true"
                        aria-expanded="${this.headerPieceDropdownOpen}"
                      >
                        ${this.pieceTitle}
                        <span
                          class="header-piece-chevron ${this
                              .headerPieceDropdownOpen
                            ? "expanded"
                            : ""}"
                        >
                          ${iconChevronDown()}
                        </span>
                      </button>
                      ${this.headerPieceDropdownOpen
                        ? html`
                          <div class="header-piece-dropdown">
                            <x-piece-list
                              .pieces="${this.#piecesCache ?? []}"
                              .loading="${!this.#piecesCache &&
                                this.#pieces.status === TaskStatus.PENDING}"
                              .activePieceId="${this.pieceId}"
                              @piece-selected="${this
                                .#handlePieceSelected}"
                            ></x-piece-list>
                          </div>
                        `
                        : nothing}
                    </span>
                  `
                  : nothing}
              `
              : nothing}
          </div>
        </div>
      </div>

      <div class="menu-container ${this.menuOpen ? "open" : ""}">
        <div class="menu-backdrop" @click="${this.#handleBackdropClick}"></div>
        <div class="menu-panel" role="menu">
          <div class="menu-inner">
            <button
              class="menu-close"
              @click="${this.#handleCloseMenu}"
              aria-label="Close menu"
            >
              <span class="menu-close-icon">${iconClose()}</span>
            </button>
            <div class="menu-title">
              ${this.#hasSpace
                ? html`
                  <div class="breadcrumb">
                    <span class="breadcrumb-icon">${iconFolder()}</span>
                    <span class="breadcrumb-text">${this
                      .#spaceDisplayName}</span>
                    <span class="breadcrumb-chevron">
                      ${iconChevronRight()}
                    </span>
                  </div>
                `
                : nothing}
              <button
                class="piece-title-row"
                @click="${this.#handleTogglePieceList}"
                aria-expanded="${this.pieceListExpanded}"
              >
                <span class="piece-title-text">
                  ${this.pieceTitle || "Untitled"}
                </span>
                <span
                  class="piece-title-chevron ${this.pieceListExpanded
                    ? "expanded"
                    : ""}"
                >
                  ${iconChevronDown()}
                </span>
              </button>
              ${this.pieceListExpanded
                ? html`
                  <x-piece-list
                    .pieces="${this.#piecesCache ?? []}"
                    .loading="${!this.#piecesCache &&
                      this.#pieces.status === TaskStatus.PENDING}"
                    .activePieceId="${this.pieceId}"
                    @piece-selected="${this.#handlePieceSelected}"
                  ></x-piece-list>
                `
                : nothing}
            </div>

            <div class="menu-rows">
              <button
                class="menu-item"
                role="menuitem"
                @click="${this.#handleNavigateUp}"
              >
                <span class="menu-item-icon">${iconArrowLeft()}</span>
                <span class="menu-item-label">${this.#navigateUpLabel}</span>
              </button>

              <div class="divider"><div class="divider-line"></div></div>

              ${this.pieceAddress
                ? html`
                  <button
                    class="menu-item"
                    role="menuitem"
                    @click="${this.#handleToggleFavorite}"
                  >
                    <span class="menu-item-icon">${iconStar(isFavorite)}</span>
                    <span class="menu-item-label">${isFavorite
                      ? "Remove from Favorites"
                      : "Add to Favorites"}</span>
                  </button>
                `
                : nothing}

              <button
                class="menu-item"
                role="menuitem"
                @click="${this.#handleCopyLink}"
              >
                <span class="menu-item-icon">${iconLink()}</span>
                <span class="menu-item-label">Copy link</span>
              </button>

              ${this.pieceReference
                ? html`
                  <button
                    class="menu-item"
                    role="menuitem"
                    test-id="header-copy-reference"
                    @click="${this.#handleCopyReference}"
                  >
                    <span class="menu-item-icon">${iconLink()}</span>
                    <span class="menu-item-label">Copy reference</span>
                    <code class="menu-item-detail">
                      ${this.pieceReference}
                    </code>
                  </button>
                `
                : nothing}

              <button
                class="menu-item"
                role="menuitem"
                @click="${this.#handleDebuggerToggleClick}"
              >
                <span class="menu-item-icon">${iconBug()}</span>
                <span class="menu-item-label">Toggle debug mode</span>
              </button>

              <button
                class="menu-item"
                role="menuitem"
                @click="${this.#handleThemeToggle}"
              >
                <span class="menu-item-icon">${iconThemeToggle(
                  getEffectiveTheme() === "dark",
                )}</span>
                <span class="menu-item-label">${getEffectiveTheme() === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"}</span>
              </button>

              <div class="divider"><div class="divider-line"></div></div>

              <button
                class="menu-item"
                role="menuitem"
                @click="${this.#handleAuthClick}"
              >
                <span class="menu-item-icon">${iconLogOut()}</span>
                <span class="menu-item-label">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-header-view", XHeaderView);

function getConnectionColor(connectionStatus: ConnectionStatus): string {
  const saturation = 65;
  const lightness = 50;

  const colorMap = {
    connecting: 60, // Yellow
    connected: 120, // Green
    conflict: 30, // Orange
    disconnected: 0, // Red
    error: 0, // Red
  };

  const hue = colorMap[connectionStatus] ?? 60;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
