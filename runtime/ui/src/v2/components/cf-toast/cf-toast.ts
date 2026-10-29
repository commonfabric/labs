import { css, html, nothing, unsafeCSS } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import type { StatusIntent } from "../theme-context.ts";
import { surfaceRecipesCSS } from "../../styles/variables.ts";

/**
 * CFToast - Floating ephemeral notification component
 *
 * @element cf-toast
 *
 * @attr {string} status - Status intent: "info" | "success" | "error" | "warning"
 * @attr {number} duration - Auto-dismiss timeout in ms. 0 = persistent.
 * @attr {boolean} dismissible - Show the dismiss (X) button
 * @attr {boolean} dismissable - Deprecated alias for dismissible
 * @attr {boolean} open - Controls visibility
 *
 * @slot - Default slot for notification message content
 * @slot icon - Optional leading icon (hidden when empty)
 * @slot action - Optional action button area (hidden when empty)
 *
 * @fires cf-toast-dismiss - Fired when toast is closed. Detail: { reason: "timeout" | "user" }
 * @fires cf-dismiss - Fired when toast is closed. Detail: { reason: "timeout" | "user" }
 * @fires cf-toast-action - Fired when the action slot area is activated. Detail: {}
 *
 * @csspart toast - Root container div (the visible pill surface)
 * @csspart icon - Icon wrapper div
 * @csspart message - Message wrapper div
 * @csspart action - Action wrapper div
 * @csspart dismiss - Dismiss button (only present when dismissable)
 */
export class CFToast extends BaseElement {
  // deno-fmt-ignore
  static override styles = css`
    :host {
      ${unsafeCSS(surfaceRecipesCSS)};
      --cf-toast-border-radius: var(
        --cf-surface-transient-border-radius,
        var(--cf-theme-border-radius, 0.5rem)
      );
      --cf-toast-border: var(
        --cf-surface-transient-border,
        1px solid var(--cf-theme-color-border, #e2e8f0)
      );
      --cf-toast-padding: var(
        --cf-surface-transient-padding,
        0.625rem 0.875rem
      );
      --cf-toast-box-shadow: var(
        --cf-surface-transient-box-shadow,
        0 4px 16px rgba(0, 0, 0, 0.08)
      );
      display: block;
    }

    :host(:not([open])) {
      display: none;
    }

    .toast {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 0.5rem;
      padding: var(--cf-toast-padding, 0.625rem 0.875rem);
      border-radius: var(--cf-toast-border-radius);
      max-width: var(
        --cf-toast-max-width,
        var(--cf-layout-width-transient-max, 420px)
      );
      min-width: var(
        --cf-toast-min-width,
        var(--cf-layout-width-transient-min, 240px)
      );
      box-shadow: var(--cf-toast-box-shadow);
      backdrop-filter: blur(var(--cf-toast-backdrop-blur, 8px));
      font-size: var(--cf-font-body-size, 0.875rem);
      font-family: inherit;
      border: var(--cf-toast-border);
      --cf-toast-action-background: color-mix(
        in srgb,
        currentColor 10%,
        transparent
      );
      --cf-toast-action-background-hover: color-mix(
        in srgb,
        currentColor 16%,
        transparent
      );
      --cf-toast-action-border-color: color-mix(
        in srgb,
        currentColor 18%,
        transparent
      );
    }

    /* Info status (default) */
    :host([status="info"]) .toast,
    :host(:not([status])) .toast {
      background: var(
        --cf-toast-background,
        var(--cf-surface-transient-background)
      );
      color: var(--cf-toast-color, var(--cf-theme-color-text, #0f172a));
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-border, #e2e8f0)
      );
    }

    /* Success status */
    :host([status="success"]) .toast {
      background: var(
        --cf-toast-background,
        var(--cf-theme-color-success, #10b981)
      );
      color: var(
        --cf-toast-color,
        var(--cf-theme-color-success-foreground, #f0fdf4)
      );
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-success, #10b981)
      );
    }

    /* Error status */
    :host([status="error"]) .toast {
      background: var(
        --cf-toast-background,
        var(--cf-theme-color-error, #dc2626)
      );
      color: var(
        --cf-toast-color,
        var(--cf-theme-color-error-foreground, #fef2f2)
      );
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-error, #dc2626)
      );
    }

    /* Warning status */
    :host([status="warning"]) .toast {
      background: var(
        --cf-toast-background,
        var(--cf-theme-color-warning, #f59e0b)
      );
      color: var(
        --cf-toast-color,
        var(--cf-theme-color-warning-foreground, #fffbeb)
      );
      border-color: var(
        --cf-toast-border-color,
        var(--cf-theme-color-warning, #f59e0b)
      );
    }

    .icon.empty,
    .action.empty {
      display: none;
    }

    .message {
      flex: 1;
      min-width: 0;
    }

    .action {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
    }

    .action ::slotted(cf-button) {
      color: inherit;
      --cf-button-color-secondary: var(--cf-toast-action-background);
      --cf-button-color-secondary-foreground: currentColor;
      --cf-button-color-surface-hover: var(--cf-toast-action-background-hover);
      --cf-button-color-border: var(--cf-toast-action-border-color);
      --cf-size-sm-height: 1.75rem;
      --cf-size-sm-padding-v: 0;
      --cf-size-sm-padding-h: 0.625rem;
      --cf-size-sm-radius: var(--cf-theme-border-radius, 0.5rem);
      --cf-size-sm-font-size: var(--cf-font-body-size, 0.875rem);
      --cf-size-sm-line-height: var(--cf-font-body-line-height, 1.25rem);
    }

    .dismiss {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      padding: 2px 4px;
      color: inherit;
      opacity: 0.7;
      flex-shrink: 0;
    }

    .dismiss:hover {
      opacity: 1;
    }

    @keyframes toast-in {
      from {
        transform: translateY(100%);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    :host([open]) .toast {
      animation: toast-in var(--cf-transition-duration-base, 200ms)
        var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1)) forwards;
    }

    @media (prefers-reduced-motion: reduce) {
      :host([open]) .toast {
        animation: none;
        transition: none;
      }
    }
  `;

  static override properties = {
    status: { type: String, reflect: true },
    duration: { type: Number },
    dismissable: { type: Boolean, reflect: true },
    dismissible: { type: Boolean, reflect: true },
    open: { type: Boolean, reflect: true },
    _hasIcon: { type: Boolean, state: true },
    _hasAction: { type: Boolean, state: true },
  };

  declare status: StatusIntent;
  declare duration: number;
  declare dismissable: boolean;
  declare dismissible: boolean;
  declare open: boolean;

  declare private _hasIcon: boolean;
  declare private _hasAction: boolean;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _prevOpen = false;

  constructor() {
    super();
    this.status = "info";
    this.duration = 5000;
    this.dismissable = false;
    this.dismissible = false;
    this.open = false;
    this._hasIcon = false;
    this._hasAction = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._updateAria();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._clearTimer();
  }

  override updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);

    if (changedProperties.has("status")) {
      this._updateAria();
    }

    if (changedProperties.has("open")) {
      if (this.open && !this._prevOpen) {
        this._startTimer();
      } else if (!this.open && this._prevOpen) {
        this._clearTimer();
      }
      this._prevOpen = this.open;
    }

    if (changedProperties.has("duration") && this.open) {
      this._startTimer();
    }

    if (
      changedProperties.has("dismissible") &&
      this.dismissable !== this.dismissible
    ) {
      this.dismissable = this.dismissible;
    } else if (
      changedProperties.has("dismissable") &&
      this.dismissible !== this.dismissable
    ) {
      this.dismissible = this.dismissable;
    }
  }

  private _updateAria(): void {
    if (this.status === "error") {
      this.setAttribute("role", "alert");
      this.setAttribute("aria-live", "assertive");
    } else {
      this.setAttribute("role", "status");
      this.setAttribute("aria-live", "polite");
    }
    this.setAttribute("aria-atomic", "true");
  }

  private _startTimer(): void {
    this._clearTimer();
    if (this.duration > 0) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this.open = false;
        this._emitDismiss("timeout");
      }, this.duration);
    }
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _handleDismiss = (): void => {
    this.open = false;
    this._clearTimer();
    this._emitDismiss("user");
  };

  private _emitDismiss(reason: "timeout" | "user"): void {
    const detail = { reason };
    this.emit("cf-toast-dismiss", detail);
    this.emit("cf-dismiss", detail);
  }

  private _handleActionClick = (): void => {
    this.emit("cf-toast-action", {});
  };

  private _handleIconSlotChange = (e: Event): void => {
    const slot = e.target as HTMLSlotElement;
    this._hasIcon = slot.assignedNodes({ flatten: true }).length > 0;
  };

  private _handleActionSlotChange = (e: Event): void => {
    const slot = e.target as HTMLSlotElement;
    this._hasAction = slot.assignedNodes({ flatten: true }).length > 0;
  };

  override render() {
    return html`
      <div class="toast" part="toast">
        <div class="${this._hasIcon ? "icon" : "icon empty"}" part="icon">
          <slot
            name="icon"
            @slotchange="${this._handleIconSlotChange}"
          ></slot>
        </div>
        <div class="message" part="message">
          <slot></slot>
        </div>
        <div
          class="${this._hasAction ? "action" : "action empty"}"
          part="action"
          @click="${this._handleActionClick}"
        >
          <slot
            name="action"
            @slotchange="${this._handleActionSlotChange}"
          ></slot>
        </div>
        ${this.dismissible || this.dismissable
          ? html`
            <button
              class="dismiss"
              part="dismiss"
              @click="${this._handleDismiss}"
              aria-label="Dismiss"
              type="button"
            >
              &#x2715;
            </button>
          `
          : nothing}
      </div>
    `;
  }
}
