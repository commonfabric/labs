import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

import type { LoomPairingQuestion } from "../lib/loom-pairing-login.ts";
import {
  activateModalDialog,
  pairingDialogStyles,
  TAP_THROUGH_GUARD_MS,
} from "./pairing-dialog.ts";

/**
 * The dialog a `#pair=` link raises: whether to sign in as the identity a Loom
 * holds, or why the link did not sign anyone in.
 *
 * For a Loom on this computer the question is asked before the code is
 * redeemed, so it names the Loom but not the incoming DID, which is not known
 * until then. For a Loom elsewhere it is asked after, and names both. It
 * dispatches `loom-pairing-result` once, with `detail.accepted`; a failure
 * report always answers `false`.
 */
export class XLoomPairingView extends LitElement {
  static override styles = pairingDialogStyles;

  /** What to ask the person. */
  @property({ attribute: false })
  accessor question: LoomPairingQuestion | null = null;

  /** Set instead of `question` to report why pairing failed. */
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

    if (this.question === null) return html``;
    const { loomUrl, currentDid, incomingDid } = this.question;
    const replacing = currentDid !== null;
    return html`
      <dialog aria-labelledby="loom-pairing-title">
        <h1 id="loom-pairing-title" tabindex="-1" data-autofocus>
          ${replacing
            ? "Replace current identity?"
            : "Sign in as this identity?"}
        </h1>
        ${replacing
          ? html`
            <div class="label">Currently signed in as</div>
            <div class="did">${currentDid}</div>
          `
          : ""}
        <div class="label">Identity held by the Loom at</div>
        <div class="did">${loomUrl}</div>
        ${incomingDid !== null
          ? html`
            <div class="label">${replacing
              ? "Would become"
              : "Sign in as"}</div>
            <div class="did">${incomingDid}</div>
          `
          : ""}
        <p class="warn">
          ${incomingDid !== null
            ? "This link names a Loom that is not on this computer. Only " +
              "continue if that Loom is your own, you just showed this " +
              "pairing code on it, and the identity above is yours."
            : "Only continue if you just showed this pairing code on the Mac " +
              "that runs Loom."}${replacing
            ? " The identity currently signed in on this device will be replaced."
            : ""}
        </p>
        <div class="actions">
          <button
            @click="${() => this.#finish(true)}"
            ?disabled="${this.guarded}"
          >
            ${replacing ? "Replace identity" : "Sign in"}
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
