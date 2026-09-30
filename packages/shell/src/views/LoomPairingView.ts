import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

import {
  activateModalDialog,
  pairingDialogStyles,
  TAP_THROUGH_GUARD_MS,
} from "./DeviceLinkView.ts";

/**
 * The dialog a `#pair=` link raises: whether to replace the signed-in identity
 * with the one a Loom holds, or why the link did not sign anyone in.
 *
 * The replace question is asked before the code is redeemed, so it names the
 * Loom rather than the incoming DID, which is not known until then. It
 * dispatches `loom-pairing-result` once, with `detail.accepted`; a failure
 * report always answers `false`.
 */
export class XLoomPairingView extends LitElement {
  static override styles = pairingDialogStyles;

  /** DID signed in on this device, which the Loom's identity would replace. */
  @property({ attribute: false })
  accessor currentDid = "";

  /** Origin of the Loom the code is for. */
  @property({ attribute: false })
  accessor loomUrl = "";

  /** Set instead of the fields above to report why pairing failed. */
  @property({ attribute: false })
  accessor failure: string | null = null;

  @state()
  private accessor guarded = true;

  #answered = false;

  // `setTimeout` is typed as Node's `Timeout` under this config, not `number`.
  #guardTimer: ReturnType<typeof setTimeout> | undefined;

  /** The answer step of this dialog, which a test drives directly. */
  get accessForTestingOnly(): { finish(accepted: boolean): void } {
    return { finish: (accepted) => this.#finish(accepted) };
  }

  override firstUpdated() {
    // Before anything that could throw, so the accept button cannot stay
    // disabled for good.
    this.#guardTimer = setTimeout(() => {
      this.guarded = false;
    }, TAP_THROUGH_GUARD_MS);

    activateModalDialog(
      this.renderRoot.querySelector("dialog"),
      () => this.#finish(false),
    );
    (this.renderRoot.querySelector("[data-autofocus]") as HTMLElement | null)
      ?.focus?.();
  }

  override disconnectedCallback() {
    clearTimeout(this.#guardTimer);
    super.disconnectedCallback();
  }

  /** Answers the dialog once, dispatching the result the host listens for. */
  #finish(accepted: boolean) {
    if (this.#answered) return;
    if (accepted && this.guarded) return;
    this.#answered = true;
    this.dispatchEvent(
      new CustomEvent("loom-pairing-result", { detail: { accepted } }),
    );
  }

  override render() {
    if (this.failure !== null) {
      return html`
        <dialog aria-labelledby="loom-pairing-title">
          <h1 id="loom-pairing-title" tabindex="-1" data-autofocus>
            Could not pair with Loom
          </h1>
          <p class="warn">${this.failure}</p>
          <div class="actions">
            <button @click="${() => this.#finish(false)}">Continue</button>
          </div>
        </dialog>
      `;
    }

    return html`
      <dialog aria-labelledby="loom-pairing-title">
        <h1 id="loom-pairing-title" tabindex="-1" data-autofocus>
          Replace current identity?
        </h1>
        <div class="label">Currently signed in as</div>
        <div class="did">${this.currentDid}</div>
        <div class="label">Would become the identity held by</div>
        <div class="did">${this.loomUrl}</div>
        <p class="warn">
          Only continue if you just showed this pairing code on your own Mac that
          runs Loom. The identity currently signed in on this device will be
          replaced.
        </p>
        <div class="actions">
          <button
            @click="${() => this.#finish(true)}"
            ?disabled="${this.guarded}"
          >
            Replace identity
          </button>
          <button @click="${() => this.#finish(false)}">Cancel</button>
        </div>
      </dialog>
    `;
  }
}

globalThis.customElements.define("x-loom-pairing-view", XLoomPairingView);

declare global {
  interface HTMLElementTagNameMap {
    "x-loom-pairing-view": XLoomPairingView;
  }
}
