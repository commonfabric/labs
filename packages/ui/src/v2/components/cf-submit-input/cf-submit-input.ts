import { css, html, type PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import "../cf-button/cf-button.ts";

/**
 * CFSubmitInput - A text field with a submit button whose click carries the
 * typed text on the event itself.
 *
 * The submit button click is a real (trusted) DOM gesture that bubbles to this
 * host. A pattern wires `onClick` on the host and reads `event.target.value`:
 * the host mirrors the field's text in its `value` property, so the submitted
 * text rides the trusted click — together with the surrounding surface's UI
 * integrity (data-ui-action / data-ui-event-integrity on the host and an
 * ancestor). Because the text travels in the event, the consuming handler needs
 * no durable draft cell, and the field clears itself in the DOM after submit —
 * deferred past the click's handling so the value is read first, and guarded so
 * a back-to-back submit's freshly typed name is never wiped. This
 * keeps a cross-space create handler stable across retries — the event payload
 * is fixed — with nothing to clobber.
 *
 * Pressing Enter in the field submits as well. The field sits inside a `<form>`
 * holding a hidden native submit button, so Enter triggers the browser's
 * implicit form submission: the user agent fires a trusted click on that submit
 * button, which bubbles to the host exactly like the visible button's click and
 * carries the same `event.target.value` and UI integrity. A scripted
 * `button.click()` would be `isTrusted: false` and carry no integrity, so the
 * keyboard path relies on the browser's own gesture rather than synthesizing
 * one. The form's native submission is cancelled so the page does not navigate.
 * Both the visible button click and the Enter-driven submit click pass through a
 * single click handler on the form, where the in-flight guard lives, so Enter
 * and a click cannot fire two creates.
 *
 * Unlike cf-message-input (which emits a `cf-send` CustomEvent — isTrusted is
 * false for those, so they cannot carry UI integrity to a worker handler), the
 * create here flows from the raw, trusted button click.
 *
 * @element cf-submit-input
 *
 * @attr {string} placeholder - Placeholder text for the field
 * @attr {string} button-text - Text for the submit button (default: "Submit")
 * @attr {string} input-id - id forwarded to the inner <input> so callers/tests
 *   can target the field directly
 * @attr {boolean} clear-on-submit - Clear locally after submit (default: true);
 *   set false when a caller controls `value` and clears it after acceptance
 * @attr {boolean} disabled - Whether the field and button are disabled
 * @attr {string} initial-value - Optional one-time seed copied into `value` on
 *   first render; the field is uncontrolled after that
 * @attr {string} value - Live field text; read on the host as
 *   event.target.value when the submit button is clicked
 */
export class CFSubmitInput extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .container {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--cf-submit-input-gap, var(--cf-spacing-2, 0.5rem));
        align-items: stretch;
      }

      input {
        width: 100%;
        box-sizing: border-box;
        font: inherit;
        padding: var(--cf-spacing-2, 0.5rem) var(--cf-spacing-3, 0.75rem);
        border: 1px solid var(--cf-theme-color-border, #e5e5e7);
        border-radius: var(--cf-radius-md, 8px);
        background: var(--cf-theme-color-surface, #fff);
        color: var(--cf-theme-color-text, inherit);
      }

      input:focus {
        outline: 2px solid var(--cf-theme-color-accent, #0a7);
        outline-offset: -1px;
      }

      cf-button {
        white-space: nowrap;
      }
    `,
  ];

  static override properties = {
    placeholder: { type: String },
    buttonText: { type: String, attribute: "button-text" },
    inputId: { type: String, attribute: "input-id" },
    disabled: { type: Boolean, reflect: true },
    initialValue: { type: String, attribute: "initial-value" },
    value: { type: String },
    clearOnSubmit: {
      type: Boolean,
      attribute: "clear-on-submit",
      converter: { fromAttribute: (value: string | null) => value !== "false" },
    },
  };

  declare placeholder: string;
  declare buttonText: string;
  declare inputId: string;
  declare disabled: boolean;

  /** Whether this control clears its own text after a submitted gesture. */
  declare clearOnSubmit: boolean;

  /**
   * Optional one-time seed for the field text, copied into `value` on first
   * render. The field is uncontrolled after that.
   */
  declare initialValue: string;

  /**
   * The field text, mirrored; read on the host as `event.target.value` when
   * the submit button is clicked.
   */
  declare value: string;

  constructor() {
    super();
    this.placeholder = "";
    this.buttonText = "Submit";
    this.inputId = "";
    this.disabled = false;
    this.clearOnSubmit = true;
    this.initialValue = "";
    this.value = "";
  }

  private _seeded = false;

  /**
   * Whether a submit is in flight, until the local deferred clear or a
   * controlled value change. A second submit that arrives in that window — whether a button
   * click or an Enter keypress — is a duplicate (the field still holds the
   * submitted text), so its propagation to the host is stopped to suppress a
   * second create. The flag is reset when the clear runs, including the case
   * where the clear is skipped because the value changed, so a later submit is
   * never blocked.
   */
  private _submitting = false;

  /** The controlled draft held until its value changes. */
  #submittedValue: string | undefined;

  /**
   * Copies `initialValue` into the editable `value` once, the first time it is
   * present. Later `initialValue` changes and the user's own typing are left
   * alone, so the field stays uncontrolled.
   */
  override willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    if (!this.clearOnSubmit && this.value !== this.#submittedValue) {
      this._submitting = false;
      this.#submittedValue = undefined;
    }
    if (!this._seeded && this.initialValue) {
      this._seeded = true;
      this.value = this.initialValue;
    }
  }

  private get _input(): HTMLInputElement | null | undefined {
    return this.shadowRoot?.querySelector("input");
  }

  private _onInput(event: Event) {
    this.value = (event.target as HTMLInputElement).value;
  }

  /**
   * Returns whether a click's composed path runs through a control that means
   * submit — the visible `cf-button`, or the hidden native submit button the
   * browser clicks for implicit form submission on Enter. Clicks on the field
   * (to focus/edit) or the surrounding gap are not submits.
   */
  private _isSubmitGesture(event: Event): boolean {
    return event.composedPath().some((node) => {
      const element = node as Element & { type?: string };
      return element?.tagName === "CF-BUTTON" ||
        (element?.tagName === "BUTTON" && element.type === "submit");
    });
  }

  /**
   * Handles every click on the form. The visible button's click and the
   * Enter-driven implicit-submission click both bubble through here on their
   * way to the host, so it is the one place the create gesture is gated and the
   * in-flight guard is enforced — Enter and a click cannot each fire a create.
   */
  private _onClick(event: Event) {
    // Only a submit gesture should reach the host's onClick (the create). Stop
    // field/gap clicks at the shadow boundary so they fire no spurious create.
    if (!this._isSubmitGesture(event)) {
      event.stopPropagation();
      return;
    }
    // A second submit arriving before the deferred clear runs is a duplicate:
    // the field still holds the submitted text, so the host would fire a second
    // create. Stop it at the shadow boundary so it never reaches the host.
    if (this._submitting) {
      event.stopPropagation();
      return;
    }
    const submitted = this.value;
    if (!submitted.trim()) {
      // Nothing to submit. Stop the click here so an empty submit — including a
      // held Enter key that repeats — never reaches the host to spin up a no-op
      // create.
      event.stopPropagation();
      return;
    }
    this._submitting = true;
    if (!this.clearOnSubmit) {
      this.#submittedValue = submitted;
      return;
    }
    // Clear the field only after the submit click has been handled — the
    // framework's host-level click listener reads `event.target.value` while
    // handling the click. A `setTimeout` runs after that dispatch (a microtask
    // defer proved too early in practice), so the submitted text is captured
    // first. Clear only if the field still holds the submitted text: a
    // back-to-back create may have already typed the next name, which must not
    // be wiped. The value is local component state, so this guard is synchronous
    // and race-free — and no durable cell is written, so there is nothing to
    // clobber across the cross-space commit. The in-flight flag is reset here
    // whether or not the clear runs, so a later submit is never blocked.
    setTimeout(() => {
      this._submitting = false;
      if (this.value !== submitted) return;
      this.value = "";
      const input = this._input;
      if (input) input.value = "";
    }, 0);
  }

  /**
   * Handles the form's submit event, which Enter in the field triggers as
   * implicit form submission. The trusted click on the hidden submit button is
   * what carries the create to the host; the form's own navigation is
   * cancelled so the page does not reload.
   */
  private _onFormSubmit(event: Event) {
    event.preventDefault();
  }

  override render() {
    return html`
      <form @submit="${this._onFormSubmit}" @click="${this._onClick}">
        <div class="container">
          <input
            id="${this.inputId}"
            type="text"
            .value="${this.value}"
            placeholder="${this.placeholder}"
            ?disabled="${this.disabled}"
            @input="${this._onInput}"
            part="input"
          />
          <cf-button
            data-cf-button
            type="button"
            ?disabled="${this.disabled}"
            part="button"
          >
            ${this.buttonText}
          </cf-button>
        </div>
        <button type="submit" ?disabled="${this.disabled}" hidden></button>
      </form>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-submit-input": CFSubmitInput;
  }
}
