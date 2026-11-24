import { getLogger } from "@commonfabric/logger";
import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * How a host element that is itself the control is focused and activated.
 */
export interface HostActivationOptions {
  /** The role the host takes unless the page gives it another. */
  role: string;
  /**
   * The keys that activate the control, as `KeyboardEvent.key` values:
   * Enter and Space for a button or switch, Space alone for a checkbox or
   * radio. Old browsers report Space as "Spacebar".
   */
  keys: readonly string[];
  /** Whether the control is disabled. */
  isDisabled(): boolean;
  /**
   * What a click does, whether from a pointer, an activation key, or
   * `click()`. A click while disabled, or while the host is out of the
   * document, never arrives here.
   */
  activate(event: MouseEvent): void;
  /**
   * Whether the host is its own Tab stop. A control in a composite widget
   * (a radio in a radio group) leaves its `tabIndex` to the composite.
   * Defaults to always.
   */
  ownsTabStop?(): boolean;
}

/**
 * Focus and keyboard for a control whose host element is the control.
 *
 * Why the host: the host carries the role and ARIA state, so it must be
 * what takes focus. `delegatesFocus` would send focus to an inner element,
 * which a control's shadow DOM hides from the accessibility tree, and
 * browsers refuse focus to an `aria-hidden` element.
 *
 * The controller gives the host its role, `aria-disabled`, and a
 * `tabIndex` of 0 (or -1 while disabled). An activation key calls the
 * host's `click()`, as a native control's does, so a page's click handler
 * sees keyboard activation too. A click while disabled is stopped in the
 * capture phase, before any handler on the host, a page's included, runs,
 * and counted under the host's tag name in the logger counts. A host out
 * of the document answers no click or key.
 */
export class HostActivationController implements ReactiveController {
  readonly #host: ReactiveControllerHost & HTMLElement;
  readonly #options: HostActivationOptions;

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    options: HostActivationOptions,
  ) {
    this.#host = host;
    this.#options = options;
    host.addController(this);
    // Dropping a disabled click is right whether or not the host is in the
    // document, so it listens for the host's whole life, from before any
    // listener a page adds.
    host.addEventListener("click", this.#dropWhileDisabled, { capture: true });
  }

  hostConnected(): void {
    if (!this.#host.hasAttribute("role")) {
      this.#host.setAttribute("role", this.#options.role);
    }
    this.#host.addEventListener("click", this.#onClick);
    this.#host.addEventListener("keydown", this.#onKeydown);
    this.#sync();
  }

  hostDisconnected(): void {
    this.#host.removeEventListener("click", this.#onClick);
    this.#host.removeEventListener("keydown", this.#onKeydown);
  }

  hostUpdated(): void {
    this.#sync();
  }

  #sync(): void {
    const disabled = this.#options.isDisabled();
    this.#host.setAttribute("aria-disabled", String(disabled));
    if (this.#options.ownsTabStop?.() ?? true) {
      this.#host.tabIndex = disabled ? -1 : 0;
    }
  }

  #dropWhileDisabled = (event: MouseEvent): void => {
    if (!this.#options.isDisabled()) return;
    getLogger(this.#host.localName, { enabled: false, level: "debug" }).debug(
      "dropped",
      () => [
        `${this.#host.localName} dropped a click while disabled (${
          JSON.stringify(this.#host.textContent?.trim() ?? "")
        })`,
      ],
    );
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  #onClick = (event: MouseEvent): void => {
    this.#options.activate(event);
  };

  #onKeydown = (event: KeyboardEvent): void => {
    if (this.#options.isDisabled()) return;
    if (!this.#options.keys.includes(event.key)) return;
    event.preventDefault();
    this.#host.click();
  };
}
