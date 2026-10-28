import { css, html, unsafeCSS } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { surfaceRecipesCSS } from "../../styles/variables.ts";

/**
 * CFCard - Content container with support for header, content, and footer sections
 *
 * @element cf-card
 *
 * @attr {boolean} clickable - Whether the card responds to click interactions
 *
 * @slot header - Card header content
 * @slot content - Main card content
 * @slot footer - Card footer content
 * @slot - Default slot (alternative to using named slots)
 *
 * @example
 * <cf-card>
 *   <h3 slot="header">Card Title</h3>
 *   <p slot="content">Card content goes here</p>
 *   <cf-button slot="footer">Action</cf-button>
 * </cf-card>
 *
 * Uses JS to detect empty slots (CSS :has() can't distinguish assigned vs fallback content).
 */

export class CFCard extends BaseElement {
  static override styles = css`
    :host {
      ${unsafeCSS(surfaceRecipesCSS)};
      --cf-card-border-radius: var(
        --cf-surface-plain-border-radius,
        var(--cf-theme-border-radius, 0.5rem)
      );
      --cf-card-border: var(
        --cf-surface-plain-border,
        1px solid var(--cf-theme-color-border, hsl(0, 0%, 89%))
      );
      --cf-card-padding: var(--cf-surface-plain-padding, 1rem);
      --cf-card-hover-shadow: var(
        --cf-surface-elevated-box-shadow,
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 2px 4px -1px rgba(0, 0, 0, 0.06)
      );
      --cf-card-animation-duration: var(--cf-theme-animation-duration, 150ms);
      --cf-card-spacing-tight: var(--cf-theme-spacing-tight, 0.25rem);
      --cf-card-spacing-loose: var(--cf-card-padding, 1rem);
      --cf-card-color-border: var(--cf-theme-color-border, hsl(0, 0%, 89%));
      --cf-card-color-surface: var(
        --cf-surface-plain-background,
        var(--cf-theme-color-surface, hsl(0, 0%, 100%))
      );
      --cf-card-color-text: var(--cf-theme-color-text, hsl(0, 0%, 9%));
      --cf-card-color-hover-surface: var(
        --cf-theme-color-surface-hover,
        hsl(0, 0%, 96%)
      );
      --cf-card-color-focus-ring: var(
        --cf-theme-color-primary,
        hsl(212, 100%, 47%)
      );
      --cf-card-color-muted-text: var(
        --cf-theme-color-text-muted,
        hsl(0, 0%, 45%)
      );
      --cf-card-surface-background: var(--cf-card-color-surface);
      --cf-card-background: var(--cf-card-surface-background);
      --cf-card-backdrop-blur: 0px;

      display: block;
      box-sizing: border-box;
    }

    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }

    .card {
      border-radius: var(--cf-card-border-radius, 0.5rem);
      border: var(--cf-card-border);
      background: var(--cf-card-background);
      backdrop-filter: blur(var(--cf-card-backdrop-blur));
      -webkit-backdrop-filter: blur(var(--cf-card-backdrop-blur));
      color: var(--cf-card-color-text, hsl(0, 0%, 9%));
      overflow: hidden;
      transition: all var(--cf-card-animation-duration, 150ms)
        cubic-bezier(0.4, 0, 0.2, 1);
    }

    .card[tabindex="0"] {
      cursor: pointer;
    }

    .card[tabindex="0"]:hover {
      background: var(--cf-card-color-hover-surface, hsl(0, 0%, 96%));
      transform: translateY(-1px);
      box-shadow: var(--cf-card-hover-shadow);
    }

    .card[tabindex="0"]:focus-visible {
      outline: 2px solid var(--cf-card-color-focus-ring, hsl(212, 100%, 47%));
      outline-offset: 2px;
    }

    .card[tabindex="0"]:active {
      transform: translateY(0);
    }

    /* Header section */
    .card-header {
      padding: var(--cf-card-spacing-loose, 1rem);
      padding-bottom: 0;
    }

    /* When header is the only section, add bottom padding */
    .card-header:not(.empty):has(+ .card-content.empty) {
      padding-bottom: var(--cf-card-spacing-loose, 1rem);
    }

    /* Hide header if empty (controlled by JS via .empty class) */
    .card-header.empty {
      display: none;
      padding: 0;
    }

    /* Title wrapper for title and action slots */
    .card-title-wrapper {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--cf-card-spacing-loose, 1rem);
    }

    /* Hide title wrapper if empty (controlled by JS via .empty class) */
    .card-title-wrapper.empty {
      display: none;
    }

    /* Title slot styling */
    ::slotted([slot="title"]) {
      font-size: var(--cf-font-heading-lg-size, 1.5rem);
      font-weight: var(--cf-font-heading-lg-weight, 600);
      line-height: var(--cf-font-heading-lg-line-height, 2rem);
      letter-spacing: var(--cf-font-heading-lg-letter-spacing, -0.025em);
      margin: 0;
    }

    /* Description slot styling */
    ::slotted([slot="description"]) {
      font-size: var(--cf-font-body-size, 0.875rem);
      line-height: var(--cf-font-body-line-height, 1.25rem);
      color: var(--cf-card-color-muted-text, hsl(0, 0%, 45%));
      margin-top: var(--cf-card-spacing-tight, 0.25rem);
    }

    /* Content section */
    .card-content {
      padding: var(--cf-card-spacing-loose, 1rem);
    }

    /* Hide content if empty (controlled by JS via .empty class) */
    .card-content.empty {
      display: none;
      padding: 0;
    }

    /* Footer section */
    .card-footer {
      padding: var(--cf-card-spacing-loose, 1rem);
      padding-top: 0;
    }

    /* Hide footer if empty (controlled by JS via .empty class) */
    .card-footer.empty {
      display: none;
      padding: 0;
    }

    /* Adjust spacing when sections are used together */
    .card-header:not(:empty) + .card-content:not(:empty) {
      padding-top: var(--cf-card-spacing-loose, 1rem);
    }

    .card-content:not(:empty) + .card-footer:not(:empty) {
      padding-top: var(--cf-card-spacing-loose, 1rem);
    }
  `;

  static override properties = {
    clickable: { type: Boolean },
  };

  declare clickable: boolean;

  constructor() {
    super();
    this.clickable = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.clickable) {
      this.addEventListener("click", this._handleClick);
      this.addEventListener("keydown", this._handleKeydown);
    }
  }

  override firstUpdated() {
    // Set up slot change listeners to detect empty slots
    this.shadowRoot?.querySelectorAll("slot").forEach((slot) => {
      slot.addEventListener("slotchange", () => this._updateEmptyStates());
    });

    // Initial check for empty states
    this._updateEmptyStates();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this._handleClick);
    this.removeEventListener("keydown", this._handleKeydown);
  }

  override updated(changedProperties: Map<string, any>) {
    if (changedProperties.has("clickable")) {
      if (this.clickable) {
        this.addEventListener("click", this._handleClick);
        this.addEventListener("keydown", this._handleKeydown);
      } else {
        this.removeEventListener("click", this._handleClick);
        this.removeEventListener("keydown", this._handleKeydown);
      }
    }
  }

  override render() {
    return html`
      <div
        class="card"
        part="card"
        tabindex="${this.clickable ? "0" : null}"
        role="${this.clickable ? "button" : null}"
      >
        <div class="card-header" part="header">
          <slot name="header">
            <div class="card-title-wrapper">
              <slot name="title"></slot>
              <slot name="action"></slot>
            </div>
            <slot name="description"></slot>
          </slot>
        </div>
        <div class="card-content" part="content">
          <slot name="content">
            <slot></slot>
          </slot>
        </div>
        <div class="card-footer" part="footer">
          <slot name="footer"></slot>
        </div>
      </div>
    `;
  }

  /** Check if slot has real content (not just whitespace) */
  private _slotHasContent(slot: HTMLSlotElement | null): boolean {
    if (!slot) return false;
    return slot.assignedNodes().some((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent?.trim() !== "";
      }
      return true;
    });
  }

  /** Update empty state classes based on slot content */
  private _updateEmptyStates(): void {
    const getSlot = (name: string) =>
      this.shadowRoot?.querySelector(`slot[name="${name}"]`) as
        | HTMLSlotElement
        | null;

    const headerSlot = getSlot("header");
    const contentSlot = getSlot("content");
    const defaultSlot = contentSlot?.querySelector("slot:not([name])") as
      | HTMLSlotElement
      | null;
    const footerSlot = getSlot("footer");
    const titleSlot = getSlot("title");
    const actionSlot = getSlot("action");
    const descriptionSlot = getSlot("description");

    const hasHeader = this._slotHasContent(headerSlot);
    const hasContent = this._slotHasContent(contentSlot) ||
      this._slotHasContent(defaultSlot);
    const hasFooter = this._slotHasContent(footerSlot);
    const hasTitle = this._slotHasContent(titleSlot);
    const hasAction = this._slotHasContent(actionSlot);
    const hasDescription = this._slotHasContent(descriptionSlot);

    const showHeader = hasHeader || hasTitle || hasAction || hasDescription;
    const showTitleWrapper = hasTitle || hasAction;

    this.shadowRoot?.querySelector(".card-header")?.classList.toggle(
      "empty",
      !showHeader,
    );
    this.shadowRoot?.querySelector(".card-content")?.classList.toggle(
      "empty",
      !hasContent,
    );
    this.shadowRoot?.querySelector(".card-footer")?.classList.toggle(
      "empty",
      !hasFooter,
    );
    this.shadowRoot?.querySelector(".card-title-wrapper")?.classList.toggle(
      "empty",
      !showTitleWrapper,
    );
  }

  private _handleClick = (_event: Event): void => {
    if (!this.clickable) return;

    // Emit a custom click event
    this.emit("cf-card-click", {
      clickable: this.clickable,
    });
  };

  private _handleKeydown = (event: KeyboardEvent): void => {
    if (!this.clickable) return;

    // Handle Enter and Space keys for accessibility
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this._handleClick(event);
    }
  };

  /**
   * Focus the card programmatically (only works when clickable)
   */
  override focus(): void {
    if (this.clickable) {
      const card = this.shadowRoot?.querySelector(".card") as HTMLElement;
      card?.focus();
    }
  }

  /**
   * Blur the card programmatically
   */
  override blur(): void {
    const card = this.shadowRoot?.querySelector(".card") as HTMLElement;
    card?.blur();
  }
}
