/**
 * Piece list component for displaying navigable pieces in a space.
 * Used in both the mobile dropdown menu and the desktop header
 * piece switcher.
 *
 * Emits a `piece-selected` CustomEvent with `{ id, name }` when
 * a piece is clicked.
 */

import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

export interface PieceItem {
  id: string;
  name: string;
}

export class XPieceList extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      padding: 0.25rem 0;
      margin-left: 1rem;
      max-height: 15rem;
      overflow-y: auto;
    }

    button {
      font-family: inherit;
      color: inherit;
    }

    .piece-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 1rem;
      border: none;
      border-radius: 6px;
      background: none;
      cursor: pointer;
      font-weight: 400;
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--shell-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
      width: 100%;
      flex-shrink: 0;
    }

    .piece-item:hover {
      background: var(--shell-surface-hover);
      color: inherit;
    }

    .piece-item.active {
      color: inherit;
    }

    .piece-item.active::before {
      content: "";
      width: 0.375rem;
      height: 0.375rem;
      border-radius: 50%;
      background: var(--accent-blue, #4979fa);
      flex-shrink: 0;
    }

    .empty {
      font-weight: 500;
      font-size: 0.6875rem;
      line-height: 1rem;
      color: var(--shell-text-muted);
      padding: 0.375rem 1rem;
    }
  `;

  @property({ attribute: false })
  accessor pieces: PieceItem[] = [];

  @property({ type: Boolean })
  accessor loading = false;

  @property({ attribute: false })
  accessor activePieceId: string | undefined = undefined;

  #handleClick(e: Event) {
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-piece-id]",
    );
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const id = target.dataset.pieceId!;
    const piece = this.pieces.find((p) => p.id === id);
    if (piece) {
      this.dispatchEvent(
        new CustomEvent("piece-selected", {
          detail: piece,
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  override render() {
    if (this.loading) {
      return html`
        <span class="empty" role="status">Loading pieces…</span>
      `;
    }
    if (this.pieces.length === 0) {
      return html`
        <span class="empty">No pieces found</span>
      `;
    }
    return html`
      ${this.pieces.map(
        (piece) =>
          html`
            <button
              class="piece-item ${piece.id === this.activePieceId
                ? "active"
                : ""}"
              data-piece-id="${piece.id}"
              @click="${this.#handleClick}"
            >
              ${piece.name}
            </button>
          `,
      )}
    `;
  }
}

globalThis.customElements.define("x-piece-list", XPieceList);
