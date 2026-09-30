/**
 * What the shell's pairing dialogs share: the device-link confirm and the Loom
 * pairing dialog. Each is rendered into the top layer with
 * `<dialog>.showModal()` rather than stacked by z-index: this shell has fixed
 * elements at z-index 2000 and 9999, and the top layer also brings a focus trap
 * and an inert background, so the login view behind a dialog is not
 * tab-reachable while it is up. Where `showModal()` is unsupported (iOS ≤ 15.3)
 * or throws, `activateModalDialog()` falls back to a visible non-modal dialog.
 */

import { css } from "lit";

/**
 * How long the accept button stays inert after the dialog appears.
 *
 * The dialog appears mid-boot, on a device the person has just used to scan a
 * code or open a link, and the accept button is the primary control — a tap
 * already in flight would land on it. For a screen that guards an identity
 * swap, that is worth a beat.
 */
export const TAP_THROUGH_GUARD_MS = 500;

/** The subset of `<dialog>` these dialogs drive — so tests can fake it. */
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

/** The look of a pairing dialog in the top layer. */
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
