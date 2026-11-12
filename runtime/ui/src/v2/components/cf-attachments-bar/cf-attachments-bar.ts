import { css, html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { CellHandle } from "@commonfabric/runtime-client";

import { BaseElement } from "../../core/base-element.ts";
import { createArrayCellController } from "../../core/cell-controller.ts";

import "../cf-chip/index.ts";

/** A cell pinned to a conversation, as `BuiltInLLMDialogState` lists it. */
export interface PinnedCell {
  path: string;
  name: string;
}

/**
 * CFAttachmentsBar - Display pinned cells as a horizontal list of chips
 *
 * @element cf-attachments-bar
 *
 * @attr {boolean} removable - Whether pinned cells can be removed (default: false)
 *
 * @prop {CellHandle<PinnedCell[]>|PinnedCell[]} pinnedCells - The pinned
 *   cells to display, or a cell holding them
 *
 * @fires cf-remove - Fired when a pinned cell's remove button is clicked. detail: { path: string }
 * @fires cf-click - Fired when a pinned cell is clicked. detail: { path: string, name: string }
 *
 * @example
 * <cf-attachments-bar .pinnedCells=${pinnedCells}></cf-attachments-bar>
 * <cf-attachments-bar .pinnedCells=${pinnedCells} removable></cf-attachments-bar>
 */
export class CFAttachmentsBar extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .attachments-list {
        display: flex;
        flex-wrap: wrap;
        gap: var(--cf-theme-spacing-tight, var(--cf-spacing-1, 0.25rem));
        align-items: center;
      }

      .empty-state {
        color: var(
          --cf-theme-color-text-muted,
          #9ca3af
        );
        font-size: 0.8125rem;
      }
    `,
  ];

  @property({ attribute: false })
  accessor pinnedCells: CellHandle<PinnedCell[]> | PinnedCell[] = [];

  @property({ type: Boolean })
  accessor removable = false;

  #pinned = createArrayCellController<PinnedCell>(this);

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("pinnedCells")) this.#pinned.bind(this.pinnedCells);
  }

  override render() {
    const pinned = this.#pinned.getValue();
    if (pinned.length === 0) {
      return html`
        <div class="empty-state">No pinned cells</div>
      `;
    }

    return html`
      <div class="attachments-list">
        ${pinned.map(
          (cell) =>
            html`
              <cf-chip
                ?removable="${this.removable}"
                interactive
                @cf-remove="${(e: Event) =>
                  this.#handle(e, "cf-remove", { path: cell.path })}"
                @cf-click="${(e: Event) =>
                  this.#handle(e, "cf-click", {
                    path: cell.path,
                    name: cell.name,
                  })}"
              >
                ${cell.name}
              </cf-chip>
            `,
        )}
      </div>
    `;
  }

  /** Replaces a chip's own event with one naming the pinned cell. */
  #handle(
    event: Event,
    type: "cf-click" | "cf-remove",
    detail: Pick<PinnedCell, "path"> & Partial<PinnedCell>,
  ): void {
    event.stopPropagation();
    this.emit(type, detail);
  }
}
