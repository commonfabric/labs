import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFListItem - Generic list row inspired by SwiftUI List
 *
 * Supports simple label rows, command items with icons/shortcuts,
 * and complex expandable rows with detail content.
 *
 * @element cf-list-item
 *
 * @attr {string} label - Primary text content
 * @attr {string} description - Secondary text below the label
 * @attr {boolean} expandable - Whether the row can expand to show detail
 * @attr {boolean} expanded - Current expand state (only when expandable)
 * @attr {boolean} disabled - Prevents interaction
 *
 * @slot icon - Leading icon
 * @slot - Primary content (overrides label attribute)
 * @slot description - Secondary text (overrides description attribute)
 * @slot action - Trailing action (button, badge, keyboard shortcut)
 * @slot detail - Expandable detail area (shown when expanded)
 *
 * @fires cf-click - Fired when the item is clicked
 * @fires cf-expand - Fired when expanded state changes, detail: { expanded }
 *
 * @example Simple row
 * <cf-list-item label="Settings"></cf-list-item>
 *
 * @example Command item with icon and shortcut
 * <cf-list-item label="New Project" description="Create a new project">
 *   <span slot="icon">📁</span>
 *   <cf-kbd slot="action">⌘N</cf-kbd>
 * </cf-list-item>
 *
 * @example Expandable row
 * <cf-list-item label="Project Name" expandable>
 *   <cf-badge slot="action">3 tasks</cf-badge>
 *   <div slot="detail">Detail content shown when expanded</div>
 * </cf-list-item>
 */
export class CFListItem extends BaseElement {
  static override properties = {
    label: { type: String, reflect: true },
    description: { type: String },
    expandable: { type: Boolean, reflect: true },
    expanded: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    _hasIcon: { state: true },
    _hasDescription: { state: true },
    _hasAction: { state: true },
    _hasDetail: { state: true },
  };

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .row {
        display: flex;
        align-items: center;
      }

      .item {
        display: flex;
        align-items: center;
        gap: var(--cf-list-item-gap, 0.75rem);
        flex: 1;
        min-width: 0;
        padding: var(--cf-list-item-padding, 0.5rem);
        border: none;
        border-radius: var(
          --cf-list-item-radius,
          var(--cf-theme-border-radius, 0.75rem)
        );
        background: transparent;
        color: var(--cf-list-item-color, var(--cf-theme-color-text, #34373c));
        font-family: inherit;
        font-size: var(
          --cf-list-item-font-size,
          var(--cf-font-body-compact-size, 0.8125rem)
        );
        font-weight: var(
          --cf-list-item-font-weight,
          var(--cf-font-body-compact-weight, 500)
        );
        line-height: var(
          --cf-list-item-line-height,
          var(--cf-font-body-compact-line-height, 1.25rem)
        );
        text-align: left;
        cursor: pointer;
        transition: background-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
      }

      .item:hover:not(:disabled) {
        background: var(
          --cf-list-item-hover-bg,
          var(--cf-theme-color-surface-hover, rgba(0, 0, 0, 0.03))
        );
      }

      .item:focus-visible {
        outline: 2px solid
          var(--cf-theme-color-primary, var(--cf-colors-primary-500));
        outline-offset: 2px;
      }

      .item:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Icon */
      .icon {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: var(--cf-list-item-icon-size, 1.5rem);
        height: var(--cf-list-item-icon-size, 1.5rem);
      }

      .icon.empty {
        display: none;
      }

      /* Content */
      .content {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }

      .label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .description {
        font-weight: var(--cf-font-body-weight, 400);
        font-size: var(
          --cf-list-item-description-size,
          var(--cf-font-caption-size, 0.75rem)
        );
        color: var(
          --cf-list-item-description-color,
          var(--cf-theme-color-text-muted, #71747a)
        );
        line-height: var(--cf-font-caption-line-height, 1rem);
      }

      .description.empty {
        display: none;
      }

      /* Action */
      .action {
        display: flex;
        align-items: center;
        flex-shrink: 0;
      }

      .action.empty {
        display: none;
      }

      /* Expand chevron */
      .chevron {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        color: var(--cf-theme-color-text-muted, #71747a);
        transition: transform var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
      }

      :host([expanded]) .chevron {
        transform: rotate(90deg);
      }

      /* Detail */
      .detail {
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        transition:
          max-height var(--cf-transition-duration-base, 200ms)
          var(--cf-transition-timing-ease, ease),
          opacity var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
      }

      :host([expanded]) .detail {
        max-height: 500px;
        opacity: 1;
      }

      .detail.empty {
        display: none;
      }

      @media (prefers-reduced-motion: reduce) {
        .item,
        .chevron,
        .detail {
          transition: none;
        }
      }
    `,
  ];

  declare label: string;
  declare description: string;
  declare expandable: boolean;
  declare expanded: boolean;
  declare disabled: boolean;
  declare _hasIcon: boolean;
  declare _hasDescription: boolean;
  declare _hasAction: boolean;
  declare _hasDetail: boolean;

  constructor() {
    super();
    this.label = "";
    this.description = "";
    this.expandable = false;
    this.expanded = false;
    this.disabled = false;
    this._hasIcon = false;
    this._hasDescription = false;
    this._hasAction = false;
    this._hasDetail = false;
  }

  override render() {
    return html`
      <div class="row" part="row">
        <button
          type="button"
          class="${classMap({ item: true })}"
          ?disabled="${this.disabled}"
          part="item"
          @click="${this._handleClick}"
        >
          <div class="icon ${this._hasIcon ? "" : "empty"}" part="icon">
            <slot
              name="icon"
              @slotchange="${this._handleIconSlotChange}"
            ></slot>
          </div>
          <div class="content" part="content">
            <div class="label" part="label">
              <slot>${this.label}</slot>
            </div>
            <div
              class="description ${this.description ||
                  this._hasDescription
                ? ""
                : "empty"}"
              part="description"
            >
              <slot
                name="description"
                @slotchange="${this._handleDescriptionSlotChange}"
              >${this.description}</slot>
            </div>
          </div>
          ${this.expandable
            ? html`
              <span class="chevron" part="chevron" aria-hidden="true">›</span>
            `
            : ""}
        </button>
        <div class="action ${this._hasAction ? "" : "empty"}" part="action">
          <slot
            name="action"
            @slotchange="${this._handleActionSlotChange}"
          ></slot>
        </div>
      </div>
      ${this.expandable
        ? html`
          <div
            class="detail ${this._hasDetail ? "" : "empty"}"
            part="detail"
          >
            <slot
              name="detail"
              @slotchange="${this._handleDetailSlotChange}"
            ></slot>
          </div>
        `
        : ""}
    `;
  }

  private _handleClick = () => {
    if (this.disabled) return;

    if (this.expandable) {
      this.expanded = !this.expanded;
      this.emit("cf-expand", { expanded: this.expanded });
    }

    this.emit("cf-click", { label: this.label });
  };

  private _handleIconSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._hasIcon = slot.assignedElements().length > 0;
  };

  private _handleDescriptionSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._hasDescription = slot.assignedElements().length > 0;
  };

  private _handleActionSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._hasAction = slot.assignedElements().length > 0;
  };

  private _handleDetailSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._hasDetail = slot.assignedElements().length > 0;
  };
}
