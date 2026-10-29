import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";

import "../cf-chip/index.ts";

import { isCellHandle } from "@commonfabric/runtime-client";

/**
 * Attachment data structure
 */
interface Attachment {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: any;
  piece?: any;
  removable?: boolean;
}

/**
 * CFAttachmentsBar - Display pinned cells as a horizontal list of chips
 *
 * @element cf-attachments-bar
 *
 * @attr {boolean} removable - Whether pinned cells can be removed (default: false)
 *
 * @prop {Attachment[]} pinnedCells - Array of pinned cells to display
 *
 * @fires cf-remove - Fired when a pinned cell is removed. detail: { id: string }
 * @fires cf-click - Fired when a pinned cell is clicked. detail: { id: string, attachment: Attachment }
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

  @property({ type: Array })
  accessor pinnedCells: Attachment[] = [];

  @property({ type: Boolean })
  accessor removable = false;

  private _getVariant(type: string): "default" | "primary" | "accent" {
    switch (type) {
      case "mention":
        return "primary";
      case "clipboard":
        return "accent";
      case "file":
      default:
        return "default";
    }
  }

  private _getIcon(type: string): string {
    switch (type) {
      case "mention":
        return "@";
      case "file":
        return "📎";
      case "clipboard":
        return "📋";
      default:
        return "";
    }
  }

  private _handleRemove(id: string, e?: Event): void {
    e?.stopPropagation();
    this.emit("cf-remove", { id });
  }

  private _handleClick(id: string, attachment: Attachment): void {
    this.emit("cf-click", { id, attachment });
  }

  override render() {
    // TODO(runtime-worker-refactor): This component expects `Attachment[]`,
    // matching jsx.d.ts, BuiltInLLMDialogState response, but is receiving
    // a CellHandle (guessing of type Attachment[]).
    if (isCellHandle(this.pinnedCells)) {
      return html`
        <div class="empty-state">TODO(runtime-worker-refactor)</div>
      `;
    }
    if (!this.pinnedCells || this.pinnedCells.length === 0) {
      return html`
        <div class="empty-state">No pinned cells</div>
      `;
    }

    return html`
      <div class="attachments-list">
        ${this.pinnedCells.map(
          (attachment) =>
            html`
              <cf-chip
                variant="${this._getVariant(attachment.type)}"
                ?removable="${this.removable &&
                  (attachment.removable !== false)}"
                interactive
                @cf-remove="${(e: Event) =>
                  this._handleRemove(attachment.id, e)}"
                @cf-click="${() =>
                  this._handleClick(attachment.id, attachment)}"
              >
                ${attachment.name}
                <span slot="icon">${this._getIcon(attachment.type)}</span>
              </cf-chip>
            `,
        )}
      </div>
    `;
  }
}
