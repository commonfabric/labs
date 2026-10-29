import { consume } from "@lit/context";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";

import "../cf-message-input/index.ts";

import type { RuntimeClient } from "@commonfabric/runtime-client";

import { runtimeContext } from "../../runtime-context.ts";

/**
 * CFSpaceCreate - A labeled input that creates a new space.
 *
 * Submitting creates a space owned by the signed-in identity, which the
 * runtime records in that identity's Home space list under the typed label.
 * The label is what the entry is called; the space itself is identified by
 * the random DID it is created with.
 *
 * @element cf-space-create
 *
 * @attr {string} placeholder - Placeholder text for the label input
 *
 * @fires cf-space-created - After the space is created. detail: { did, label }
 *
 * @example
 * <cf-space-create placeholder="Space label..."></cf-space-create>
 */
export class CFSpaceCreate extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .error {
        color: var(--cf-color-error, #b42318);
        font-size: 12px;
      }
    `,
  ];

  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined;

  @property({ type: String })
  accessor placeholder = "Space label...";

  @state()
  accessor pending = false;

  @state()
  accessor error: string | undefined = undefined;

  /** Creates a space labeled `label`, unless one is being created already. */
  async create(label: string): Promise<void> {
    const runtime = this.runtime;
    const trimmed = label.trim();
    if (!runtime || !trimmed || this.pending) return;
    this.pending = true;
    this.error = undefined;
    try {
      const did = await runtime.createSpace(trimmed);
      this.emit("cf-space-created", { did, label: trimmed });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.pending = false;
    }
  }

  override render() {
    return html`
      <cf-message-input
        placeholder="${this.placeholder}"
        button-text="Create"
        ?disabled="${this.pending || !this.runtime}"
        @cf-send="${this.#handleSend}"
      ></cf-message-input>
      ${this.error
        ? html`
          <div class="error" role="alert">${this.error}</div>
        `
        : nothing}
    `;
  }

  /**
   * Creates a space from the label input's `cf-send`, which ends here: the
   * event is this component's own input, and an ancestor listening for
   * `cf-send` would otherwise take the label for a message sent to it.
   */
  #handleSend(event: CustomEvent<{ message: string }>): void {
    event.stopPropagation();
    void this.create(event.detail.message);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-space-create": CFSpaceCreate;
  }
}
