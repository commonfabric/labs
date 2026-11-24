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
   * radio. Space is " "; the "Spacebar" old browsers report counts as it.
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
   * (a radio in a radio group) leaves its `tabIndex` to the composite,
   * which must set it. Defaults to always.
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
  // Made up front, so a page can turn it on before the first drop.
  readonly #logger;

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    options: HostActivationOptions,
  ) {
    this.#host = host;
    this.#options = options;
    this.#logger = getLogger(host.localName, {
      enabled: false,
      level: "debug",
    });
    host.addController(this);
    // Listeners on the host itself live as long as it does, and added here
    // they run before any listener a page adds.
    host.addEventListener("click", this.#dropWhileDisabled, { capture: true });
    host.addEventListener("click", this.#onClick);
    host.addEventListener("keydown", this.#onKeydown);
  }

  hostConnected(): void {
    if (!this.#host.hasAttribute("role")) {
      this.#host.setAttribute("role", this.#options.role);
    }
    this.#sync();
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
    this.#logger.debug("dropped", () => [
      `${this.#host.localName} dropped a click while disabled (${
        JSON.stringify(this.#host.textContent?.trim() ?? "")
      })`,
    ]);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  #onClick = (event: MouseEvent): void => {
    if (this.#host.isConnected) this.#options.activate(event);
  };

  #onKeydown = (event: KeyboardEvent): void => {
    if (!this.#host.isConnected || this.#options.isDisabled()) return;
    const key = event.key === "Spacebar" ? " " : event.key;
    if (!this.#options.keys.includes(key)) return;
    event.preventDefault();
    this.#host.click();
  };
}
