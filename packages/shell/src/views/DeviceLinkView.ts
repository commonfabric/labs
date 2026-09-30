import { css, html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

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
// Rendered into the TOP LAYER via <dialog>.showModal() rather than a z-index
// gamble: this shell has fixed elements at z-index 2000 and 9999, and the top
// layer also brings a focus trap and an inert background for free — the login
// view behind this must not be tab-reachable while it is up. Where showModal is
// unsupported (iOS ≤ 15.3) or throws, `activateModalDialog` falls back to a
// visible non-modal dialog rather than leaving the user staring at nothing.
//
// INTERIM: delete this along with the rest of the device-link flow when key
// delegation lands.

/**
 * How long the accept button stays inert after the dialog appears.
 *
 * The overlay materializes mid-boot on a phone the user has just pointed at a
 * QR code, and the accept button is the primary control — a tap already in
 * flight would land on it. For the screen that is the only defense against a
 * donated-identity link, that is worth a beat.
 */
export const TAP_THROUGH_GUARD_MS = 500;

/** The subset of `<dialog>` this component drives — so tests can fake it. */
export interface ModalDialog {
  showModal?: () => void;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
}

/**
 * Make a `<dialog>` visible and wire its cancel signal — crash-safe.
 *
 * Pure and injectable so the order-of-operations and the fallback can be
 * tested without a browser (the component's `firstUpdated` runs only against a
 * real DOM). The rules it encodes, each load-bearing:
 *   - Prefer the top layer (`showModal`), but a dialog with no `open` is
 *     `display:none`; if `showModal` is missing or throws, force the `open`
 *     attribute so the user still SEES the dialog instead of a hang.
 *   - `cancel` (Escape, or a programmatic close) must resolve to "no", never a
 *     silent accept.
 */
export function activateModalDialog(
  dialog: ModalDialog | null,
  onCancel: () => void,
): void {
  if (!dialog) return;
  try {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  } catch {
    // showModal threw (unsupported, or already open) — degrade to visible
    // non-modal rather than an invisible, un-dismissable hang.
    try {
      dialog.setAttribute("open", "");
    } catch {
      // Nothing more we can safely do; the buttons still work if painted.
    }
  }
  dialog.addEventListener("cancel", (event) => {
    (event as Event & { preventDefault?: () => void }).preventDefault?.();
    onCancel();
  });
}

/**
 * The look of a pairing dialog in the top layer, which the device-link and
 * Loom pairing dialogs share.
 */
export const pairingDialogStyles = css`
  :host {
    display: contents;
  }
  dialog {
    border: 1px solid var(--border-color, #000);
    border-radius: 0.5rem;
    background: var(--shell-surface, #fff);
    color: var(--font-color, #000);
    font-family: var(--font-primary, system-ui, sans-serif);
    font-size: 1rem;
    line-height: 1.5;
    padding: 1.5rem;
    /* Respect the notch/home-indicator in landscape; portrait is unaffected. */
    padding-top: max(1.5rem, env(safe-area-inset-top));
    padding-bottom: max(1.5rem, env(safe-area-inset-bottom));
    max-width: 30rem;
    width: calc(100vw - 2rem);
    box-sizing: border-box;
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.6);
  }
  h1 {
    font-size: 1.25rem;
    margin: 0 0 0.75rem;
  }
  h1:focus {
    outline: none;
  }
  .did {
    font-family: var(--font-primary, ui-monospace, monospace);
    font-size: 0.95rem;
    word-break: break-all;
    background: var(--bg-secondary, rgba(127, 127, 127, 0.12));
    border-radius: 0.375rem;
    padding: 0.6rem 0.75rem;
    margin: 0.5rem 0 1rem;
  }
  .label {
    font-size: 0.8rem;
    opacity: 0.7;
    margin-bottom: 0.15rem;
  }
  .warn {
    font-size: 0.9rem;
    opacity: 0.85;
    margin: 0 0 1.25rem;
  }
  .actions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    font-family: inherit;
    padding: 0.55rem 1.1rem;
    border-radius: 0.375rem;
    border: 1px solid var(--border-color, currentColor);
    background: var(--bg-primary, transparent);
    color: inherit;
    cursor: pointer;
  }
  button[disabled] {
    opacity: 0.5;
    cursor: default;
  }
`;

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
