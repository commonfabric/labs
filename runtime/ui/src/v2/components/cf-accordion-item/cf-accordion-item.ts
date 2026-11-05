import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFAccordionItem - Individual accordion panel
 *
 * @element cf-accordion-item
 *
 * @attr {string} value - Unique identifier (required)
 * @attr {boolean} disabled - Whether the item is disabled
 * @attr {boolean} expanded - Whether the item is expanded
 *
 * @slot trigger - Clickable header
 * @slot - Default slot for content
 *
 * @fires cf-accordion-toggle - Fired when toggled with detail: { value, expanded }
 *
 * @example
 * <cf-accordion-item value="item1">
 *   <div slot="trigger">Section Title</div>
 *   <div>Section content goes here</div>
 * </cf-accordion-item>
 */
export class CFAccordionItem extends BaseElement {
  static override properties = {
    value: { type: String },
    disabled: { type: Boolean },
    expanded: { type: Boolean },
  };

  declare value: string;
  declare disabled: boolean;
  declare expanded: boolean;
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      border-bottom: 1px solid hsl(var(--border));
    }

    .accordion-item {
      position: relative;
    }

    .trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: var(--cf-size-xl-spacing, 16px) 0;
      font-size: 0.875rem;
      font-weight: 500;
      text-align: left;
      background: transparent;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
      color: inherit;
      font-family: inherit;
      line-height: 1.5;
    }

    .trigger:hover:not(:disabled) {
      text-decoration: underline;
    }

    .trigger:focus-visible {
      outline: 2px solid hsl(var(--ring));
      outline-offset: 2px;
    }

    .trigger:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    /* Chevron icon using CSS */
    .chevron {
      display: inline-block;
      width: 1rem;
      height: 1rem;
      position: relative;
      transition: transform 0.2s ease;
      flex-shrink: 0;
      margin-left: 0.5rem;
    }

    .chevron::before {
      content: "";
      position: absolute;
      width: 0.625rem;
      height: 0.625rem;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      top: 25%;
      left: 50%;
      transform: translateX(-50%) rotate(45deg);
      transition: transform 0.2s ease;
    }

    .accordion-item.expanded .chevron {
      transform: rotate(180deg);
    }

    /* Content wrapper for animation */
    .content-wrapper {
      overflow: hidden;
      transition: height 0.2s ease-out;
      height: 0;
    }

    .content {
      padding: 0 0 var(--cf-size-xl-spacing, 16px) 0;
      font-size: 0.875rem;
      line-height: 1.5;
    }

    /* Custom properties for theming */
    :host {
      --border: 214.3 31.8% 91.4%;
      --ring: 222.2 84% 4.9%;
    }

    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      :host {
        --border: 217.2 32.6% 17.5%;
        --ring: 212.7 26.8% 83.9%;
      }
    }

    /* Allow external customization */
    :host([data-theme="dark"]) {
      --border: 217.2 32.6% 17.5%;
      --ring: 212.7 26.8% 83.9%;
    }
  `;

  private _contentWrapper: HTMLElement | null = null;
  private _content: HTMLElement | null = null;

  constructor() {
    super();
    this.value = "";
    this.disabled = false;
    this.expanded = false;
  }

  get contentWrapper(): HTMLElement | null {
    if (!this._contentWrapper) {
      this._contentWrapper =
        this.shadowRoot?.querySelector(".content-wrapper") as HTMLElement ||
        null;
    }
    return this._contentWrapper;
  }

  get content(): HTMLElement | null {
    if (!this._content) {
      this._content =
        this.shadowRoot?.querySelector(".content") as HTMLElement || null;
    }
    return this._content;
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("expanded")) {
      this.updateContentHeight();
    }
  }

  override firstUpdated() {
    // Cache references
    this._contentWrapper =
      this.shadowRoot?.querySelector(".content-wrapper") as HTMLElement || null;
    this._content = this.shadowRoot?.querySelector(".content") as HTMLElement ||
      null;
    // Set initial content height
    this.updateContentHeight();
  }

  override render() {
    const classes = {
      "accordion-item": true,
      "expanded": this.expanded,
      "disabled": this.disabled,
    };

    return html`
      <div class="${classMap(classes)}" part="base">
        <button
          class="trigger"
          part="trigger"
          type="button"
          aria-expanded="${this.expanded}"
          ?disabled="${this.disabled}"
          @click="${this.handleClick}"
        >
          <slot name="trigger"></slot>
          <span class="chevron" part="chevron"></span>
        </button>
        <div class="content-wrapper" part="content-wrapper">
          <div class="content" part="content">
            <slot></slot>
          </div>
        </div>
      </div>
    `;
  }

  private handleClick = (event: Event): void => {
    event.preventDefault();
    if (!this.disabled) {
      this.toggle();
    }
  };

  private updateContentHeight(): void {
    const wrapper = this.contentWrapper;
    const content = this.content;

    if (!wrapper || !content) return;

    if (this.expanded) {
      // Get the actual height of the content
      const height = content.scrollHeight;
      wrapper.style.height = `${height}px`;
    } else {
      wrapper.style.height = "0px";
    }
  }

  /**
   * Toggle the expanded state
   */
  toggle(): void {
    if (this.disabled) return;

    const newExpanded = !this.expanded;

    // Emit toggle event for parent accordion to handle
    this.emit("cf-accordion-toggle", {
      value: this.value,
      expanded: newExpanded,
    });
  }

  /**
   * Expand the accordion item
   */
  expand(): void {
    if (!this.expanded && !this.disabled) {
      this.expanded = true;
      this.emit("cf-accordion-toggle", {
        value: this.value,
        expanded: true,
      });
    }
  }

  /**
   * Collapse the accordion item
   */
  collapse(): void {
    if (this.expanded && !this.disabled) {
      this.expanded = false;
      this.emit("cf-accordion-toggle", {
        value: this.value,
        expanded: false,
      });
    }
  }
}
