import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFEmptyState - Centered, muted placeholder for empty lists and regions
 *
 * Replaces the ad-hoc "no items yet" divs duplicated across patterns with
 * a single themed component: centered text in a muted tone with comfortable
 * padding, plus optional icon and action slots.
 *
 * @element cf-empty-state
 *
 * @attr {string} message - Placeholder text (convenience for the simple case;
 *   the default slot overrides it when provided)
 *
 * @slot - Message content (overrides the message attribute)
 * @slot icon - Optional icon or illustration shown above the message
 * @slot action - Optional call to action shown below the message
 *
 * @csspart empty-state - The outer container
 * @csspart icon - The icon container
 * @csspart message - The message container
 * @csspart action - The action container
 *
 * @example Simple
 * <cf-empty-state message="No items yet. Add one below!"></cf-empty-state>
 *
 * @example With icon and action
 * <cf-empty-state>
 *   <span slot="icon">📋</span>
 *   Your shopping list is empty.
 *   <cf-button slot="action">Add first item</cf-button>
 * </cf-empty-state>
 */
export class CFEmptyState extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-empty-state-color: var(
          --cf-theme-color-text-muted,
          var(--cf-colors-gray-500, #94979e)
        );
        --cf-empty-state-padding: var(--cf-spacing-8, 2rem);
        --cf-empty-state-gap: var(--cf-spacing-3, 0.75rem);
        --cf-empty-state-font-size: var(--cf-font-body-size, 0.875rem);
        --cf-empty-state-icon-size: var(--cf-font-size-2xl, 1.5rem);

        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--cf-empty-state-gap);
        padding: var(--cf-empty-state-padding);
        text-align: center;
        color: var(--cf-empty-state-color);
        font-size: var(--cf-empty-state-font-size);
        line-height: var(--cf-font-body-line-height, 1.25rem);
      }

      .icon {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--cf-empty-state-icon-size);
        line-height: 1;
      }

      .icon.empty {
        display: none;
      }

      .action {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .action.empty {
        display: none;
      }
    `,
  ];

  static override properties = {
    message: { type: String },
    _hasIcon: { state: true },
    _hasAction: { state: true },
  };

  declare message: string;
  declare _hasIcon: boolean;
  declare _hasAction: boolean;

  constructor() {
    super();
    this.message = "";
    this._hasIcon = false;
    this._hasAction = false;
  }

  override render() {
    return html`
      <div class="empty-state" part="empty-state">
        <div
          class="icon ${this._hasIcon ? "" : "empty"}"
          part="icon"
          aria-hidden="true"
        >
          <slot
            name="icon"
            @slotchange="${this._handleIconSlotChange}"
          ></slot>
        </div>
        <div class="message" part="message">
          <slot>${this.message}</slot>
        </div>
        <div class="action ${this._hasAction ? "" : "empty"}" part="action">
          <slot
            name="action"
            @slotchange="${this._handleActionSlotChange}"
          ></slot>
        </div>
      </div>
    `;
  }

  private _handleIconSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._hasIcon = slot.assignedElements().length > 0;
  };

  private _handleActionSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._hasAction = slot.assignedElements().length > 0;
  };
}
