import { html, PropertyValues, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { collapsibleStyles } from "./styles.ts";

/**
 * CFCollapsible - Single collapsible section with trigger and content
 *
 * @element cf-collapsible
 *
 * @attr {boolean} open - Whether the collapsible is open
 * @attr {boolean} disabled - Whether the collapsible is disabled
 *
 * @slot trigger - Clickable trigger element
 * @slot - Default slot for collapsible content
 *
 * @fires cf-toggle - Fired on open/close with detail: { open }
 *
 * @example
 * <cf-collapsible>
 *   <button slot="trigger">Click to expand</button>
 *   <div>Hidden content revealed here</div>
 * </cf-collapsible>
 */
export class CFCollapsible extends BaseElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
  };
  static override styles = unsafeCSS(collapsibleStyles);

  declare open: boolean;
  declare disabled: boolean;

  private _contentWrapper: HTMLElement | null = null;
  private _content: HTMLElement | null = null;
  private _triggerSlot: HTMLSlotElement | null = null;
  private _triggerWrapperEl: HTMLElement | null = null;

  constructor() {
    super();
    this.open = false;
    this.disabled = false;
  }

  get contentWrapper(): HTMLElement | null {
    if (!this._contentWrapper) {
      this._contentWrapper = this.shadowRoot?.querySelector(
        ".content-wrapper",
      ) as HTMLElement | null;
    }
    return this._contentWrapper;
  }

  get content(): HTMLElement | null {
    if (!this._content) {
      this._content = this.shadowRoot?.querySelector(".content") as
        | HTMLElement
        | null;
    }
    return this._content;
  }

  get triggerSlot(): HTMLSlotElement | null {
    if (!this._triggerSlot) {
      this._triggerSlot = this.shadowRoot?.querySelector(
        'slot[name="trigger"]',
      ) as HTMLSlotElement | null;
    }
    return this._triggerSlot;
  }

  get triggerWrapperEl(): HTMLElement | null {
    if (!this._triggerWrapperEl) {
      this._triggerWrapperEl = this.shadowRoot?.querySelector(
        ".trigger-wrapper",
      ) as HTMLElement | null;
    }
    return this._triggerWrapperEl;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set up event delegation for trigger clicks
    this.addEventListener("click", this.handleClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this.handleClick);
  }

  override firstUpdated() {
    this.setupTriggerHandlers();
    this.updateContentHeight();
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("open")) {
      this.updateContentHeight();
      this.updateTriggerAttributes();
    }
    if (changedProperties.has("disabled")) {
      this.updateTriggerAttributes();
    }
  }

  override render() {
    const classes = {
      collapsible: true,
      open: this.open,
      disabled: this.disabled,
    };

    return html`
      <div class="${classMap(classes)}" part="base">
        <div class="trigger-wrapper" part="trigger-wrapper">
          <slot name="trigger" @slotchange="${this.handleSlotChange}"></slot>
          <div class="indicator" part="indicator" aria-hidden="true"></div>
        </div>
        <div class="content-wrapper" part="content-wrapper">
          <div class="content" part="content">
            <slot></slot>
          </div>
        </div>
      </div>
    `;
  }

  private handleSlotChange = () => {
    this.setupTriggerHandlers();
  };

  private setupTriggerHandlers(): void {
    for (const element of this.#triggerElements()) {
      element.setAttribute("role", "button");
      element.setAttribute("aria-controls", "collapsible-content");
    }
    this.updateTriggerAttributes();
  }

  private updateTriggerAttributes(): void {
    for (const element of this.#triggerElements()) {
      element.setAttribute("aria-expanded", String(this.open));
      if (this.disabled) {
        element.setAttribute("aria-disabled", "true");
      } else {
        element.removeAttribute("aria-disabled");
      }
      element.style.cursor = this.disabled ? "not-allowed" : "pointer";
    }
  }

  private handleClick = (event: Event): void => {
    if (this.disabled) return;
    // A click on a slotted trigger, or on the wrapper around the trigger slot
    // and the indicator.
    const path = event.composedPath();
    const wrapper = this.triggerWrapperEl;
    const triggers = this.triggerSlot?.assignedElements() ?? [];
    if (
      triggers.some((trigger) => path.includes(trigger)) ||
      (wrapper !== null && path.includes(wrapper))
    ) {
      event.preventDefault();
      this.toggle();
    }
  };

  private updateContentHeight(): void {
    const { contentWrapper, content } = this;
    if (contentWrapper && content) {
      contentWrapper.style.height = this.open
        ? `${content.scrollHeight}px`
        : "0px";
    }
  }

  /**
   * Toggle the open state
   */
  toggle(): void {
    if (this.disabled) return;

    this.open = !this.open;

    // Emit toggle event
    this.emit("cf-toggle", {
      open: this.open,
    });
  }

  /**
   * Open the collapsible
   */
  expand(): void {
    if (!this.open && !this.disabled) {
      this.open = true;
      this.emit("cf-toggle", {
        open: true,
      });
    }
  }

  /**
   * Close the collapsible
   */
  collapse(): void {
    if (this.open && !this.disabled) {
      this.open = false;
      this.emit("cf-toggle", {
        open: false,
      });
    }
  }

  /** The slotted triggers that are HTML elements, which carry a style. */
  #triggerElements(): HTMLElement[] {
    return (this.triggerSlot?.assignedElements() ?? []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
  }
}
