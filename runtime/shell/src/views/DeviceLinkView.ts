import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

import {
  activateModalDialog,
  pairingDialogStyles,
  TAP_THROUGH_GUARD_MS,
} from "./pairing-dialog.ts";

// The confirm gate for device-link login (`#k=` — see ../lib/device-link.ts).
//
// WHY A CONFIRM AT ALL: the payload donates a private key. An attacker who
// gets someone to open `…/home#k=<attacker-entropy>` — a crafted link, a QR
// sticker over a real one — would otherwise silently sign the victim in AS the
// attacker, so everything they then write lands in the attacker's space and
// their own session is gone. Scanning steals nothing directly (there is no
// exfiltration channel; the payload gives away the attacker's own key), which
// makes this screen the entire defense. Hence the DID shown prominently for
// cross-checking against the Pair screen, and copy naming where the code was
// supposed to have come from.
//
// The dialog machinery it shares with the Loom pairing dialog lives in
// `pairing-dialog.ts`, which outlives this file.
//
// INTERIM: delete this along with the rest of the device-link flow when key
// delegation lands.

export class XDeviceLinkView extends LitElement {
  static override styles = pairingDialogStyles;

  /** DID the scanned code would sign as. */
  @property({ attribute: false })
  accessor incomingDid = "";

  /** DID already signed in on this device, or null on a fresh one. */
  @property({ attribute: false })
  accessor currentDid: string | null = null;

  /** Set instead of the DIDs to report a scan that could not be read at all. */
  @property({ attribute: false })
  accessor failure: "unreadable" | "failed" | null = null;

  @state()
  private accessor guarded = true;

  #answered = false;

  /** Timer which releases the tap-through guard on the accept button. */
  // `setTimeout` is typed as Node's `Timeout` under this config, not `number`.
  #guardTimer: ReturnType<typeof setTimeout> | undefined;

  /** The answer step of this dialog, which a test drives directly. */
  get accessForTestingOnly(): { finish(accepted: boolean): void } {
    return { finish: (accepted) => this.#finish(accepted) };
  }

  override firstUpdated() {
    // Schedule the guard release FIRST — before anything below that could throw
    // — so a failure activating the dialog can never leave the accept button
    // disabled forever (which, with a hung promise, would brick boot).
    this.#guardTimer = setTimeout(() => {
      this.guarded = false;
    }, TAP_THROUGH_GUARD_MS);

    const dialog = this.renderRoot.querySelector("dialog");
    activateModalDialog(dialog, () => this.#finish(false));

    // Focus the heading, NOT a button. WebKit scrolls a modal to its focused
    // element; with the accept button disabled during the guard, focus would
    // otherwise fall to Cancel at the bottom, scrolling the heading and the
    // security warning off-screen on a small phone.
    const heading = this.renderRoot.querySelector(
      "[data-autofocus]",
    ) as HTMLElement | null;
    heading?.focus?.();
  }

  override disconnectedCallback() {
    clearTimeout(this.#guardTimer);
    super.disconnectedCallback();
  }

  /** Answers the dialog once, dispatching the result the host listens for. */
  #finish(accepted: boolean) {
    // Exactly one answer, ever: a double-tap must not dispatch twice.
    if (this.#answered) return;
    // Accept is inert during the tap-through guard; Cancel is always allowed.
    if (accepted && this.guarded) return;
    this.#answered = true;
    this.dispatchEvent(
      new CustomEvent("device-link-result", { detail: { accepted } }),
    );
  }

  override render() {
    if (this.failure) {
      return html`
        <dialog aria-labelledby="device-link-title">
          <h1 id="device-link-title" tabindex="-1" data-autofocus>
            Pairing code could not be read
          </h1>
          <p class="warn">
            The code in this link is incomplete or damaged. Reloading this page will not
            help — the code is removed from the address bar as soon as it is read.
            Reveal the code again on the Pair screen and rescan it.
          </p>
          <div class="actions">
            <button @click="${() => this.#finish(false)}">Continue</button>
          </div>
        </dialog>
      `;
    }

    const replacing = this.currentDid !== null &&
      this.currentDid !== this.incomingDid;
    const alreadySignedIn = this.currentDid === this.incomingDid;

    if (alreadySignedIn) {
      return html`
        <dialog aria-labelledby="device-link-title">
          <h1 id="device-link-title" tabindex="-1" data-autofocus>
            Already signed in
          </h1>
          <div class="label">Identity</div>
          <div class="did">${this.incomingDid}</div>
          <div class="actions">
            <button
              @click="${() => this.#finish(true)}"
              ?disabled="${this.guarded}"
            >
              Continue
            </button>
          </div>
        </dialog>
      `;
    }

    return html`
      <dialog aria-labelledby="device-link-title">
        <h1 id="device-link-title" tabindex="-1" data-autofocus>
          ${replacing ? "Replace current identity?" : "Use this identity?"}
        </h1>
        ${replacing
          ? html`
            <div class="label">Currently signed in as</div>
            <div class="did">${this.currentDid}</div>
          `
          : ""}
        <div class="label">${replacing ? "Would become" : "Sign in as"}</div>
        <div class="did">${this.incomingDid}</div>
        <p class="warn">
          Only continue if this code was just revealed on the Pair screen of a device
          that belongs here, and the identity above matches the one shown
          there.${replacing
            ? " The identity currently signed in on this device will be replaced."
            : ""}
        </p>
        <div class="actions">
          <button
            @click="${() => this.#finish(true)}"
            ?disabled="${this.guarded}"
          >
            ${replacing ? "Replace identity" : "Continue"}
          </button>
          <button @click="${() => this.#finish(false)}">Cancel</button>
        </div>
      </dialog>
    `;
  }
}

globalThis.customElements.define("x-device-link-view", XDeviceLinkView);

declare global {
  interface HTMLElementTagNameMap {
    "x-device-link-view": XDeviceLinkView;
  }
}
