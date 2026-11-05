import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import type { StatusIntent } from "../theme-context.ts";

/**
 * CFAlert - Alert message display component with variants and dismissible option
 *
 * @element cf-alert
 *
 * @attr {string} status - Status intent: "info" | "error" | "warning" | "success"
 * @attr {boolean} dismissible - Whether the alert can be dismissed with an X button
 *
 * @slot icon - Alert icon
 * @slot title - Alert title
 * @slot description - Alert description
 * @slot - Default slot for alert content
 *
 * @fires cf-dismiss - Fired when alert is dismissed
 * @fires cf-alert-dismiss - Fired when alert is dismissed
 *
 * @example
 * <cf-alert status="error" dismissible>
 *   <span slot="icon">⚠️</span>
 *   <h4 slot="title">Error</h4>
 *   <p slot="description">Something went wrong</p>
 * </cf-alert>
 */

export class CFAlert extends BaseElement {
  static override styles = css`
    :host {
      /* Default color values if not provided */
      --cf-alert-color-background: var(--cf-theme-color-background, #ffffff);
      --cf-alert-color-foreground: var(--cf-theme-color-text, #0f172a);
      --cf-alert-color-muted: var(--cf-theme-color-surface, #f8fafc);
      --cf-alert-color-muted-foreground: var(
        --cf-theme-color-text-muted,
        #64748b
      );
      --cf-alert-color-primary: var(--cf-theme-color-primary, #0f172a);
      --cf-alert-color-primary-foreground: var(
        --cf-theme-color-primary-foreground,
        #f8fafc
      );
      --cf-alert-color-destructive: var(--cf-theme-color-error, #dc2626);
      --cf-alert-color-destructive-foreground: var(
        --cf-theme-color-error-foreground,
        #fef2f2
      );
      --cf-alert-color-warning: var(--cf-theme-color-warning, #f59e0b);
      --cf-alert-color-warning-foreground: var(
        --cf-theme-color-warning-foreground,
        #fffbeb
      );
      --cf-alert-color-warning-text: var(--cf-theme-color-text, #92400e);
      --cf-alert-color-success: var(--cf-theme-color-success, #10b981);
      --cf-alert-color-success-foreground: var(
        --cf-theme-color-success-foreground,
        #f0fdf4
      );
      --cf-alert-color-info: var(--cf-theme-color-primary, #3b82f6);
      --cf-alert-color-info-foreground: var(
        --cf-theme-color-primary-foreground,
        #eff6ff
      );
      --cf-alert-color-border: var(--cf-theme-color-border, #e2e8f0);
      --cf-alert-color-ring: var(--cf-theme-color-primary, #94a3b8);

      display: block;
    }

    .alert {
      position: relative;
      display: flex;
      border-radius: var(--cf-size-md-radius, 8px);
      border: 1px solid;
      padding: var(--cf-size-xl-spacing, 16px);
      gap: 0.75rem;
      font-family: inherit;
      transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* Alert icon */
    .alert-icon {
      flex-shrink: 0;
      width: 1rem;
      height: var(--cf-size-xs-height, 16px);
    }

    .alert-icon:empty {
      display: none;
    }

    /* Alert content */
    .alert-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    /* Alert title */
    .alert-title {
      font-size: var(--cf-font-body-size, 0.875rem);
      font-weight: var(--cf-font-weight-medium, 500);
      line-height: var(--cf-line-height-none, 1);
      letter-spacing: var(--cf-alert-title-letter-spacing, -0.025em);
    }

    .alert-title:empty {
      display: none;
    }

    /* Alert description */
    .alert-description {
      font-size: var(--cf-font-body-size, 0.875rem);
      line-height: var(--cf-line-height-normal, 1.5);
      opacity: 0.9;
    }

    .alert-description:empty {
      display: none;
    }

    /* Dismiss button */
    .dismiss-button {
      all: unset;
      box-sizing: border-box;
      position: absolute;
      right: 0.5rem;
      top: 0.5rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: var(--cf-size-xs-radius, 4px);
      padding: var(--cf-size-sm-spacing, 4px);
      width: var(--cf-size-sm-height, 24px);
      height: var(--cf-size-sm-height, 24px);
    }

    .dismiss-button:hover {
      opacity: 1;
    }

    .dismiss-button:focus-visible {
      outline: 2px solid transparent;
      outline-offset: 2px;
      box-shadow: 0 0 0 2px var(--cf-alert-color-ring, #94a3b8);
    }

    .dismiss-button svg {
      width: 1rem;
      height: var(--cf-size-xs-height, 16px);
    }

    /* Info status (default) */
    .alert.status-info {
      background-color: var(--cf-alert-color-info-foreground, #eff6ff);
      color: var(--cf-alert-color-info, #3b82f6);
      border-color: var(--cf-alert-color-info, #3b82f6);
    }

    .alert.status-info .alert-icon {
      color: var(--cf-alert-color-info, #3b82f6);
    }

    .alert.status-info .alert-title {
      color: var(--cf-alert-color-info, #3b82f6);
    }

    .alert.status-info .alert-description {
      color: var(--cf-alert-color-info, #3b82f6);
      opacity: 0.8;
    }

    /* Error status */
    .alert.status-error {
      background-color: var(--cf-alert-color-destructive-foreground, #fef2f2);
      color: var(--cf-alert-color-destructive, #dc2626);
      border-color: var(--cf-alert-color-destructive, #dc2626);
    }

    .alert.status-error .alert-icon {
      color: var(--cf-alert-color-destructive, #dc2626);
    }

    .alert.status-error .alert-title {
      color: var(--cf-alert-color-destructive, #dc2626);
    }

    .alert.status-error .alert-description {
      color: var(--cf-alert-color-destructive, #dc2626);
      opacity: 0.8;
    }

    /* Warning status */
    .alert.status-warning {
      background-color: var(--cf-alert-color-warning-foreground, #fffbeb);
      color: var(--cf-alert-color-warning-text, #92400e);
      border-color: var(--cf-alert-color-warning, #f59e0b);
    }

    .alert.status-warning .alert-icon {
      color: var(--cf-alert-color-warning, #f59e0b);
    }

    .alert.status-warning .alert-title {
      color: var(--cf-alert-color-warning-text, #92400e);
    }

    .alert.status-warning .alert-description {
      color: var(--cf-alert-color-warning-text, #92400e);
      opacity: 0.8;
    }

    /* Success status */
    .alert.status-success {
      background-color: var(--cf-alert-color-success-foreground, #f0fdf4);
      color: var(--cf-alert-color-success, #10b981);
      border-color: var(--cf-alert-color-success, #10b981);
    }

    .alert.status-success .alert-icon {
      color: var(--cf-alert-color-success, #10b981);
    }

    .alert.status-success .alert-title {
      color: var(--cf-alert-color-success, #10b981);
    }

    .alert.status-success .alert-description {
      color: var(--cf-alert-color-success, #10b981);
      opacity: 0.8;
    }

    /* Slot styles */
    ::slotted(*) {
      margin: 0;
    }

    ::slotted([slot="icon"]) {
      width: 1rem;
      height: var(--cf-size-xs-height, 16px);
    }

    /* Adjust padding when dismissible */
    :host([dismissible]) .alert,
    :host([dismissable]) .alert {
      padding-right: 2.5rem;
    }
  `;

  static override properties = {
    status: { type: String },
    dismissible: { type: Boolean, reflect: true },
    dismissable: { type: Boolean, reflect: true },
  };

  declare status: StatusIntent;
  declare dismissible: boolean;
  declare dismissable: boolean;

  constructor() {
    super();
    this.status = "info";
    this.dismissible = false;
    this.dismissable = false;
  }

  override updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);
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

  override render() {
    const classes = {
      alert: true,
      [`status-${this.status}`]: true,
    };

    return html`
      <div
        class="${classMap(classes)}"
        part="alert"
        role="alert"
      >
        <div class="alert-icon" part="icon">
          <slot name="icon"></slot>
        </div>
        <div class="alert-content">
          <div class="alert-title" part="title">
            <slot name="title"></slot>
          </div>
          <div class="alert-description" part="description">
            <slot name="description"></slot>
          </div>
          <slot></slot>
        </div>
        ${this.dismissible || this.dismissable
          ? html`
            <button
              type="button"
              class="dismiss-button"
              part="dismiss-button"
              aria-label="Dismiss alert"
              @click="${this._handleDismiss}"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          `
          : null}
      </div>
    `;
  }

  private _handleDismiss = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();

    const detail = {
      status: this.status,
      reason: "user",
    } as const;
    this.emit("cf-dismiss", detail);
    this.emit("cf-alert-dismiss", detail);
  };
}
