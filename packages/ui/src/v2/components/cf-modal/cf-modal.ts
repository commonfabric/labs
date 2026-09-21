/**
 * cf-modal - Accessible modal dialog with mobile sheet transformation
 *
 * Supports both Cell and plain boolean for the $open property:
 * - Cell binding: Modal writes `false` on dismiss (reactive pattern)
 * - Plain boolean: Parent controls via `oncf-modal-close` event (controlled pattern)
 *
 * @element cf-modal
 *
 * @attr {boolean} open - Whether the modal is visible (reflected)
 * @attr {boolean} dismissible - Allow dismiss via backdrop/Escape/X button
 * @attr {boolean} dismissable - Deprecated alias for dismissible
 * @attr {"sm"|"md"|"lg"|"full"} size - Modal width preset
 * @attr {boolean} prevent-scroll - Prevent body scroll when open
 * @attr {string} label - Accessible aria-label
 *
 * @prop {CellHandle<boolean>|boolean} open - Visibility state (supports both Cell and plain value)
 *
 * @fires cf-modal-open - Modal is opening
 * @fires cf-modal-close - Modal requests close (detail: { reason })
 * @fires cf-dismiss - Modal requests dismiss (detail: { reason })
 * @fires cf-modal-opened - Open animation completed
 * @fires cf-modal-closed - Close animation completed
 *
 * @slot - Main content
 * @slot header - Header content
 * @slot footer - Footer content (buttons)
 * @slot close-button - Custom close button
 *
 * @csspart backdrop - Backdrop overlay
 * @csspart container - Centering container
 * @csspart dialog - Modal dialog
 * @csspart header - Header wrapper
 * @csspart content - Content wrapper
 * @csspart footer - Footer wrapper
 * @csspart close-button - Dismiss button
 *
 * @example
 * ```html
 * <!-- Cell binding (reactive) -->
 * <cf-modal $open={isModalOpen} dismissable>
 *   <span slot="header">Edit Item</span>
 *   <p>Modal content here</p>
 *   <cf-button slot="footer" onClick={save}>Save</cf-button>
 * </cf-modal>
 *
 * <!-- Plain boolean (controlled) -->
 * <cf-modal $open={true} oncf-modal-close={handleClose}>
 *   <span slot="header">Confirm</span>
 *   <p>Are you sure?</p>
 * </cf-modal>
 * ```
 */

import { CellHandle } from "@commonfabric/runtime-client";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { createBooleanCellController } from "../../core/cell-controller.ts";
import { modalStyles } from "./styles.ts";

/** Z-index for an open modal: the `--cf-z-layer-overlay` token's value. */
const MODAL_Z_INDEX = 1000;

/** Finds the focused control through open renderer and component shadow roots. */
function activeControl(): HTMLElement | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : null;
}

export class CFModal extends BaseElement {
  static override styles = [BaseElement.baseStyles, modalStyles];

  /** Visibility state - supports both Cell<boolean> and plain boolean */
  @property({ attribute: false })
  accessor open: CellHandle<boolean> | boolean = false;

  /** Deprecated alias for dismissible. */
  @property({ type: Boolean, reflect: true })
  accessor dismissable = true;

  /** Allow dismiss via backdrop click, Escape key, and X button */
  @property({ type: Boolean, reflect: true })
  accessor dismissible = true;

  /** Modal width preset */
  @property({ type: String, reflect: true })
  accessor size: "sm" | "md" | "lg" | "full" = "md";

  /** Prevent body scroll when modal is open */
  @property({ type: Boolean, attribute: "prevent-scroll" })
  accessor preventScroll = true;

  /** Accessible label for the modal */
  @property({ type: String })
  accessor label: string | undefined = undefined;

  /** Controls layout and animation: centered dialog vs. bottom sheet */
  @property({ type: String, reflect: true })
  accessor presentation: "dialog" | "sheet" = "dialog";

  /** Show the drag-handle indicator (only visible in sheet mode) */
  @property({ type: Boolean, reflect: true })
  accessor grabber = false;

  /** Sheet snap height: content-sized, half-screen, or near-full-screen */
  @property({ type: String, reflect: true })
  accessor detent: "auto" | "half" | "full" = "auto";

  /** Whether header slot has content */
  @state()
  private accessor _headerHasContent = false;

  /** Whether footer slot has content */
  @state()
  private accessor _footerHasContent = false;

  /** Previous body overflow value for restoration */
  private _previousBodyOverflow = "";

  /** Previously focused element for restoration */
  private _previousActiveElement: HTMLElement | null = null;

  /** Boolean cell controller for open state */
  private _openCellController = createBooleanCellController(this, {
    timing: { strategy: "immediate" },
  });

  /** Track if modal was open in previous render */
  private _wasOpen = false;

  constructor() {
    super();
    this.open = false;
    this.dismissable = true;
    this.dismissible = true;
    this.size = "md";
    this.preventScroll = true;
    this.presentation = "dialog";
    this.grabber = false;
    this.detent = "auto";
  }

  /**
   * Get the current open state (unwrap Cell if needed)
   */
  private _getOpenValue(): boolean {
    return this._openCellController.getValue();
  }

  /**
   * Set the open state (write to Cell if bound)
   */
  private _setOpenValue(value: boolean): void {
    if (this._openCellController.hasCell()) {
      this._openCellController.setValue(value);
    }
    // For plain boolean, we just emit the event - parent handles state
  }

  override connectedCallback() {
    super.connectedCallback();
    // Bind initial open value to the controller
    this._openCellController.bind(this.open);
  }

  override disconnectedCallback() {
    this._cleanup();
    super.disconnectedCallback();
  }

  override willUpdate(changedProperties: PropertyValues) {
    // Handle open property changes (including Cell rebinding)
    if (changedProperties.has("open")) {
      this._openCellController.bind(this.open);
    }
  }

  override updated(changedProperties: PropertyValues) {
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

    const isOpen = this._getOpenValue();

    // Update open attribute for CSS styling
    if (isOpen) {
      this.setAttribute("open", "");
    } else {
      this.removeAttribute("open");
    }

    // Handle open state transitions
    if (isOpen !== this._wasOpen) {
      if (isOpen) {
        this._onOpen();
      } else {
        this._onClose();
      }
      this._wasOpen = isOpen;
    }
  }

  /**
   * Handle modal opening
   */
  private _onOpen() {
    // Store currently focused element for restoration
    this._previousActiveElement = activeControl();

    this._applyZIndex(MODAL_Z_INDEX);

    // Prevent body scroll
    if (this.preventScroll) {
      this._previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    this.emit("cf-modal-open");

    // Focus first focusable element after animation
    requestAnimationFrame(() => {
      const focusables = this._getFocusableElements();
      if (focusables.length > 0) {
        focusables[0].focus();
      }

      // Fire opened event after transition
      const dialog = this.shadowRoot?.querySelector(".dialog") as HTMLElement;
      if (dialog) {
        const handler = () => {
          this.emit("cf-modal-opened");
          dialog.removeEventListener("transitionend", handler);
        };
        dialog.addEventListener("transitionend", handler);
      }
    });
  }

  /**
   * Handle modal closing
   */
  private _onClose() {
    // Restore body scroll
    if (this.preventScroll) {
      document.body.style.overflow = this._previousBodyOverflow;
    }

    // Restore focus to previously focused element
    if (this._previousActiveElement?.isConnected) {
      this._previousActiveElement.focus();
    }

    // Fire closed event after transition
    const dialog = this.shadowRoot?.querySelector(".dialog") as HTMLElement;
    if (dialog) {
      const handler = () => {
        this.emit("cf-modal-closed");
        dialog.removeEventListener("transitionend", handler);
      };
      dialog.addEventListener("transitionend", handler);
    }
  }

  /**
   * Clean up on disconnect or close
   */
  private _cleanup() {
    if (this.preventScroll && document.body.style.overflow === "hidden") {
      document.body.style.overflow = this._previousBodyOverflow;
    }
  }

  /**
   * Apply z-index to backdrop and container
   */
  private _applyZIndex(zIndex: number) {
    const backdrop = this.shadowRoot?.querySelector(".backdrop") as HTMLElement;
    const container = this.shadowRoot?.querySelector(
      ".container",
    ) as HTMLElement;
    if (backdrop) backdrop.style.zIndex = String(zIndex);
    if (container) container.style.zIndex = String(zIndex + 1);
  }

  /**
   * Handle container click - dismiss if click is on container itself (not dialog)
   */
  private _handleContainerClick = (e: MouseEvent) => {
    // Only dismiss if clicking directly on container (the backdrop area), not the dialog
    if (e.target === e.currentTarget && this._isDismissible()) {
      this._requestClose("backdrop");
    }
  };

  /**
   * Handle close button click
   */
  private _handleCloseClick = () => {
    this._requestClose("button");
  };

  /**
   * Request modal close with reason
   */
  private _requestClose(reason: "backdrop" | "escape" | "button" | "api") {
    // Write false to Cell if bound (controller handles the check internally)
    this._setOpenValue(false);

    // Always emit event so parent can run cleanup logic
    this.emit("cf-modal-close", { reason });
    this.emit("cf-dismiss", { reason });
  }

  /**
   * Handle keyboard events (Tab for focus trap, Escape for close)
   */
  private _handleKeydown = (e: KeyboardEvent) => {
    if (!this._getOpenValue()) return;

    // Handle focus trap with Tab
    if (e.key === "Tab") {
      this._handleTabKey(e);
    }

    // Handle Escape
    if (e.key === "Escape" && this._isDismissible()) {
      e.preventDefault();
      this._requestClose("escape");
    }
  };

  /**
   * Handle Tab key for focus trapping
   */
  private _handleTabKey(e: KeyboardEvent) {
    const focusables = this._getFocusableElements();
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    // A single-control host can forward focus into a native shadow control
    // with tabindex=-1. Its place in the tab order belongs to the host.
    const active = e.composedPath().find((target) =>
      target instanceof HTMLElement && focusables.includes(target)
    );

    if (e.shiftKey) {
      // Shift+Tab: wrap from first to last
      if (active === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab: wrap from last to first
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  private _isDismissible(): boolean {
    return this.dismissible && this.dismissable;
  }

  /**
   * Get all focusable elements within the dialog
   */
  private _getFocusableElements(): HTMLElement[] {
    const dialog = this.shadowRoot?.querySelector(".dialog");
    if (!dialog) return [];

    const selector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusables: HTMLElement[] = [];
    const visit = (element: Element): void => {
      if (element instanceof HTMLElement) {
        const style = getComputedStyle(element);
        if (
          element.hidden || element.inert || element.hasAttribute("disabled") ||
          style.display === "none"
        ) return;
        if (
          element.matches(selector) && element.tabIndex >= 0 &&
          !element.matches(":disabled") && style.visibility === "visible" &&
          element.getClientRects().length > 0
        ) focusables.push(element);
      }
      // Walk the flattened tree in rendered order, replacing slots with assigned
      // content and hosts with their shadow children rather than counting both.
      const assigned = element instanceof HTMLSlotElement
        ? element.assignedElements({ flatten: true })
        : [];
      const children = assigned.length > 0
        ? assigned
        : (element.shadowRoot ?? element).children;
      for (const child of children) visit(child);
    };
    visit(dialog);
    return focusables;
  }

  /**
   * Handle header slot change to detect content
   */
  private _handleHeaderSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._headerHasContent = slot.assignedNodes().length > 0;
  };

  /**
   * Handle footer slot change to detect content
   */
  private _handleFooterSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    this._footerHasContent = slot.assignedNodes().length > 0;
  };

  /**
   * Programmatically close the modal
   */
  close() {
    this._requestClose("api");
  }

  override render() {
    return html`
      <div
        class="backdrop"
        part="backdrop"
      ></div>

      <div
        class="container"
        part="container"
        @click="${this._handleContainerClick}"
        @keydown="${this._handleKeydown}"
      >
        <div
          class="dialog"
          part="dialog"
          role="dialog"
          aria-modal="true"
          aria-label="${this.label || nothing}"
        >
          <div class="grabber" part="grabber" aria-hidden="true"></div>
          <div
            class="header ${this._headerHasContent ? "" : "empty"}"
            part="header"
          >
            <div class="header-content">
              <slot
                name="header"
                @slotchange="${this._handleHeaderSlotChange}"
              ></slot>
            </div>
            <slot name="close-button">
              <button
                class="close-button"
                part="close-button"
                @click="${this._handleCloseClick}"
                aria-label="Close"
                type="button"
              >
                &#x2715;
              </button>
            </slot>
          </div>

          <div class="content" part="content">
            <slot></slot>
          </div>

          <div
            class="footer ${this._footerHasContent ? "" : "empty"}"
            part="footer"
          >
            <slot
              name="footer"
              @slotchange="${this._handleFooterSlotChange}"
            ></slot>
          </div>
        </div>
      </div>
    `;
  }
}
