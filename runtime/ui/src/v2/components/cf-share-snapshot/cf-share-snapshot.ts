/** Native host confirmation for sharing an exact, runtime-verified snapshot. */

import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { css, html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";
import {
  audienceId,
  audienceWords,
  type SnapshotLine,
  snapshotLines,
} from "./snapshot-view.ts";

type SnapshotPreview = Awaited<
  ReturnType<RuntimeClient["prepareSnapshotShare"]>
>;
type ReviewBinding = {
  runtime: RuntimeClient;
  source: CellHandle;
  recipient: CellHandle;
  result?: CellHandle;
  recommended?: CellHandle;
  received?: CellHandle;
  audienceKind: "user" | "space";
  generation: number;
};

/**
 * Reviews an exact JSON snapshot and its runtime-verified audience in host UI.
 * Only a trusted native confirmation click can publish the reviewed snapshot.
 *
 * The opening button carries the ambient theme and the pattern's own label,
 * since it only opens the dialog. The dialog takes nothing from the pattern
 * or the page: its styles name fixed colors and no theme variables, and every word
 * in it comes from the runtime's preview, so a pattern cannot restyle or
 * reword what the person confirms.
 *
 * @element cf-share-snapshot
 * @attr {"user"|"space"} audience-kind - Kind of verified recipient
 * @attr {string} label - Text of the button that opens the review
 * @fires cf-shared - The released cell link has been stored in the result cell
 */
export class CFShareSnapshot extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      button {
        font: inherit;
        cursor: pointer;
      }
      button:disabled {
        opacity: .5;
        cursor: default;
      }
      .open {
        min-height: 2.5rem;
        padding: .5rem 1rem;
        border: 1px solid transparent;
        border-radius: var(--cf-theme-border-radius, .5rem);
        background: var(--cf-theme-color-primary, #244938);
        color: var(--cf-theme-color-primary-foreground, #fff);
        font-family: var(--cf-theme-font-family, inherit);
        font-weight: 600;
      }
      dialog {
        all: initial;
        box-sizing: border-box;
        position: fixed;
        inset: 0;
        margin: auto;
        width: min(42rem, calc(100vw - 2rem));
        max-height: calc(100vh - 2rem);
        overflow: auto;
        padding: 1.5rem;
        border: 2px solid #244938;
        border-radius: .75rem;
        background: #fff;
        color: #18221c;
        font: 16px/1.5 system-ui, sans-serif;
      }
      dialog:not([open]) {
        display: none;
      }
      dialog::backdrop {
        background: #0009;
      }
      h2 {
        font-size: 1.35rem;
        margin: 0 0 1rem;
      }
      .audience {
        overflow-wrap: anywhere;
      }
      .lede {
        margin: 0 0 1rem;
        color: #4a5a50;
      }
      .who {
        margin: 0 0 1rem;
        padding: .75rem 1rem;
        border-radius: .5rem;
        background: #eef3ef;
      }
      .id {
        display: block;
        font: 12px/1.4 monospace;
        color: #4a5a50;
      }
      dl {
        margin: 0 0 1rem;
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: .35rem 1rem;
      }
      dl dl {
        grid-column: 1 / -1;
        margin: 0 0 0 1rem;
      }
      dt {
        color: #4a5a50;
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      details {
        margin: 0 0 1rem;
      }
      summary {
        cursor: pointer;
        color: #4a5a50;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: #f3f5f3;
        padding: 1rem;
        border: 1px solid #ccd5cf;
        font: 14px/1.5 monospace;
      }
      .actions {
        display: flex;
        gap: .75rem;
        justify-content: flex-end;
      }
      .confirm {
        background: #244938;
        color: #fff;
      }
      [role="alert"] {
        color: #932c22;
      }
    `,
  ];

  /** Runtime supplied by the host's context provider. */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined;

  /** Source cell whose exact JSON value is reviewed. */
  @property({ attribute: false })
  accessor source: CellHandle | undefined;

  /** Live profile or space cell whose audience the runtime verifies. */
  @property({ attribute: false })
  accessor recipient: CellHandle | undefined;

  /** Writable destination for the released cell link in single-result mode. */
  @property({ attribute: false })
  accessor result: CellHandle | undefined;

  /** Visitor history appended with reviewed book references. */
  @property({ attribute: false })
  accessor recommended: CellHandle | undefined;

  /** Creator inbox appended with reviewed book references. */
  @property({ attribute: false })
  accessor received: CellHandle | undefined;

  /** Whether the recipient represents a user or a space. */
  @property({ attribute: "audience-kind" })
  accessor audienceKind: "user" | "space" = "user";

  /** Text of the button that opens the review; the dialog never uses it. */
  @property()
  accessor label = "Review and share";

  #preview: SnapshotPreview | undefined;
  #binding: ReviewBinding | undefined;
  #busy = false;
  #error = "";
  #generation = 0;

  /** Exercises host workflow without manufacturing a trusted DOM event. */
  get accessForTestingOnly(): {
    prepare(): Promise<void>;
    confirm(event: Event): Promise<void>;
    readonly preview: SnapshotPreview | undefined;
    readonly error: string;
  } {
    // deno-lint-ignore no-this-alias
    const component = this;
    return {
      prepare: () => this.#prepare(),
      confirm: (event) => this.#confirm(event),
      get preview() {
        return component.#preview;
      },
      get error() {
        return component.#error;
      },
    };
  }

  override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (
      [
        "source",
        "recipient",
        "result",
        "recommended",
        "received",
        "audienceKind",
        "runtime",
      ].some((key) => changed.has(key))
    ) {
      this.#invalidate();
    }
  }

  override disconnectedCallback(): void {
    this.#invalidate();
    super.disconnectedCallback();
  }

  override render() {
    const preview = this.#preview;
    return html`
      <button class="open" type="button" ?disabled=${this.#busy ||
        !this.source || !this.recipient ||
        !(this.result || (this.recommended && this.received)) || !this.runtime}
        @click=${this.#prepare}>${this.label}</button>
      ${this.#error ? html`<p role="alert">${this.#error}</p>` : nothing}
      <dialog aria-labelledby="share-title" @cancel=${this.#cancel}>
        <h2 id="share-title" tabindex="-1" autofocus>Share a copy of this?</h2>
        <p class="lede">They get a copy of what you see here. Later changes
          stay with you until you share again.</p>
        <p class="who audience"><strong>Who sees it</strong><br />
          ${preview ? audienceWords(preview.audience) : ""}
          <span class="id">${preview
            ? audienceId(preview.audience)
            : ""}</span></p>
        ${preview ? renderLines(snapshotLines(preview.value)) : nothing}
        <details>
          <summary>Exact data</summary>
          <pre>${preview ? JSON.stringify(preview.value, null, 2) : ""}</pre>
        </details>
        <div class="actions">
          <button type="button" ?disabled=${this.#busy}
            @click=${this.#cancel}>Cancel</button>
          <button class="confirm" type="button" ?disabled=${this.#busy ||
            !preview}
            @click=${this.#confirm}>Share</button>
        </div>
      </dialog>
    `;
  }

  /** Drops the review token whenever its UI binding is no longer current. */
  #invalidate(): void {
    if (this.#preview && this.#binding) {
      this.#releasePreview(this.#binding.runtime, this.#preview.id);
    }
    this.#generation++;
    this.#preview = undefined;
    this.#binding = undefined;
    this.#busy = false;
    this.shadowRoot?.querySelector("dialog")?.close();
  }

  /** Teardown can outlive its runtime connection, so cancellation is best effort. */
  #releasePreview(runtime: RuntimeClient, id: string): void {
    void runtime.cancelSnapshotShare(id).catch(() => {});
  }

  #cancel = (): void => {
    this.#invalidate();
    this.requestUpdate();
  };

  /** Checks captured handles before each asynchronous publication boundary. */
  #current(binding: ReviewBinding): boolean {
    return this.isConnected && binding.generation === this.#generation &&
      binding.runtime === this.runtime && binding.source === this.source &&
      binding.recipient === this.recipient && binding.result === this.result &&
      binding.recommended === this.recommended &&
      binding.received === this.received &&
      binding.audienceKind === this.audienceKind;
  }

  /** Fetches the authoritative snapshot and displays it without publishing. */
  #prepare = async (): Promise<void> => {
    if (this.#busy) return;
    const {
      runtime,
      source,
      recipient,
      result,
      recommended,
      received,
      audienceKind,
    } = this;
    if (
      !runtime || !source || !recipient ||
      !(result || (recommended && received)) || !this.isConnected
    ) {
      return;
    }
    if (audienceKind !== "user" && audienceKind !== "space") {
      this.#error = "Choose a supported sharing audience.";
      this.requestUpdate();
      return;
    }
    this.#invalidate();
    const binding: ReviewBinding = {
      runtime,
      source,
      recipient,
      result,
      recommended,
      received,
      audienceKind,
      generation: this.#generation,
    };
    this.#binding = binding;
    this.#busy = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const preview = await runtime.prepareSnapshotShare(
        source.ref(),
        audienceKind === "user"
          ? { user: recipient.ref() }
          : { space: recipient.ref() },
        recommended && received
          ? { recommended: recommended.ref(), received: received.ref() }
          : undefined,
      );
      if (!this.#current(binding)) {
        this.#releasePreview(runtime, preview.id);
        return;
      }
      this.#preview = preview;
      this.#busy = false;
      this.requestUpdate();
      await this.updateComplete;
      if (this.#current(binding)) {
        this.shadowRoot?.querySelector("dialog")?.showModal();
      }
    } catch (error) {
      if (!this.#current(binding)) return;
      this.#busy = false;
      this.#error = error instanceof Error
        ? error.message
        : "The snapshot could not be prepared.";
      this.requestUpdate();
    }
  };

  /** Admits only a real browser gesture on the open host confirmation. */
  #confirm = async (event: Event): Promise<void> => {
    Event.prototype.stopPropagation.call(event);
    await this.#commitReviewed(event);
  };

  /** Publishes the reviewed copy and then delivers its link to the bound result. */
  async #commitReviewed(event: Event): Promise<void> {
    if (
      typeof MouseEvent === "undefined" || !(event instanceof MouseEvent) ||
      !event.isTrusted ||
      event.currentTarget !==
        this.shadowRoot?.querySelector("button.confirm") ||
      !this.shadowRoot?.querySelector("dialog")?.open
    ) {
      return;
    }
    const binding = this.#binding;
    const preview = this.#preview;
    if (this.#busy || !binding || !preview || !this.#current(binding)) return;
    this.#busy = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const shared = await binding.runtime.commitSnapshotShare(preview.id);
      if (!this.#current(binding)) return;
      if (binding.result) await binding.result.setStrict(shared);
      if (!this.#current(binding)) return;
      this.#invalidate();
      this.emit("cf-shared");
    } catch (error) {
      if (!this.#current(binding)) return;
      this.#invalidate();
      this.#error = error instanceof Error
        ? error.message
        : "The snapshot could not be shared.";
    } finally {
      this.requestUpdate();
    }
  }
}

/** Reviewed fields as a definition list, nested objects indented. */
function renderLines(lines: SnapshotLine[]): unknown {
  return html`<dl>${
    lines.map((line) =>
      line.children
        ? html`<dt>${line.label}</dt><dd></dd>${renderLines(line.children)}`
        : html`
          <dt>${line.label}</dt>
          <dd>${line.text}</dd>
        `
    )
  }</dl>`;
}
