/** Native host confirmation for sealing a value into a custody room. */

import {
  type CellHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { css, html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";

type SealPreview = Awaited<ReturnType<RuntimeClient["prepareCustodySeal"]>>;
type SealBinding = {
  runtime: RuntimeClient;
  draft: CellHandle;
  terms: CellHandle;
  policy: CellHandle;
  sources: CellHandle;
  generation: number;
};

/** What the room's terms state for the confirmation to show. */
type SealSummary = {
  question: string | undefined;
  answers: string[] | undefined;
  seats: string[];
  leakBits: string | undefined;
};

/** The longest room-authored string the confirmation shows, in characters. */
const MAX_TERMS_TEXT = 280;

/**
 * Room-authored text made safe to place beside host-verified fields: control
 * characters, format characters (the bidirectional marks and overrides, the
 * zero-width characters, and the byte order mark among them), and line and
 * paragraph separators removed, so it cannot reorder the dialog's own text or
 * hide characters in its own, and capped in length.
 */
function roomText(value: string): string {
  const plain = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  return plain.length > MAX_TERMS_TEXT
    ? `${plain.slice(0, MAX_TERMS_TEXT)}…`
    : plain;
}

/**
 * Reads the display fields of the terms the worker sealed. The terms are the
 * exact document the value is sealed under, so the confirmation shows them
 * rather than anything the pattern renders around it. The room's author wrote
 * `question` and `answers`, and nothing checks that the room's policy
 * releases only the listed answers, so the confirmation presents them as what
 * the terms say. For `k` distinct answers, an answer drawn from them carries
 * at most `log₂ k` bits.
 */
export function summarizeCustodyTerms(terms: unknown): SealSummary {
  const record = terms !== null && typeof terms === "object" &&
      !Array.isArray(terms)
    ? terms as Record<string, unknown>
    : {};
  const question = typeof record.question === "string"
    ? roomText(record.question)
    : undefined;
  const seats = Array.isArray(record.seats)
    ? record.seats.filter((seat): seat is string => typeof seat === "string")
    : [];
  if (!Array.isArray(record.answers) || record.answers.length === 0) {
    return { question, answers: undefined, seats, leakBits: undefined };
  }
  // Distinct by their JSON, so the string "1" and the number 1 stay two.
  const distinct = new Map<string, unknown>();
  for (const answer of record.answers) {
    distinct.set(JSON.stringify(answer), answer);
  }
  const answers = [...distinct.values()].map((answer) =>
    roomText(typeof answer === "string" ? answer : JSON.stringify(answer))
  );
  const bits = Math.log2(answers.length);
  return {
    question,
    answers,
    seats,
    leakBits: Number.isInteger(bits) ? `${bits}` : `~${bits.toFixed(1)}`,
  };
}

/**
 * A principal the runtime checked, in an element of its own: bidirectionally
 * isolated, so nothing inside it reorders the dialog's text around it, and
 * apart from the dialog's annotations, so a principal that ends in `(you)`
 * still reads as one string. `*` is shown as `Anyone`.
 */
function principal(value: string) {
  return value === "*"
    ? html`<span class="annotation">Anyone</span>`
    : html`<bdi class="principal" dir="ltr">${value}</bdi>`;
}

/** A host annotation beside a principal, never inside its text. */
function annotation(text: string) {
  return html`
    <span class="annotation">${text}</span>
  `;
}

/**
 * The policy as a person can compare it. The runtime admits the policy only
 * when the actor's trust configuration names its manifest digest, so the
 * digest is the checked fact. A trust statement need not name the symbol or
 * the module, which the room's reference supplies, so those are shown as what
 * the reference names, as room text.
 */
function describePolicy(policy: unknown) {
  const atom = policy as Record<string, unknown> | undefined;
  if (typeof atom?.policyDigest !== "string") return nothing;
  const named = (value: unknown) =>
    roomText(typeof value === "string" ? value : "");
  const symbol = named(atom.symbol);
  const moduleIdentity = named(atom.moduleIdentity);
  return html`
    <bdi class="digest" dir="ltr">${roomText(atom.policyDigest)}</bdi>
    <p class="note">A manifest you trust to decide what the room releases. The
      room's reference names it <bdi class="symbol">${symbol}</bdi> in
      <bdi class="module">${moduleIdentity}</bdi>.</p>
  `;
}

/**
 * A source atom as a person reads it: its name or class, and its kind. The
 * name and class are the actor's own, but they are text, so they are shown
 * with the same stripping as room text.
 */
function describeSource(source: unknown): string {
  const atom = source as Record<string, unknown>;
  if (typeof atom?.name === "string") return `${roomText(atom.name)} (context)`;
  if (typeof atom?.class === "string") {
    return `${roomText(atom.class)} (resource)`;
  }
  return roomText(JSON.stringify(source));
}

/**
 * Seals the actor's draft into a custody room from a native host dialog. The
 * dialog first shows what the worker read and checked: the room space, who
 * can read it now, the seats, the policy that governs release, and which of
 * the actor's sources go in. Below that, set apart, it shows what the room's
 * terms say: the question, the answers they list, and the bound on what one of
 * those answers reveals. The exact values are under details. Only a trusted
 * click on the dialog's own confirmation seals.
 *
 * @element cf-custody-seal
 * @fires cf-sealed - The value is sealed; the event carries nothing
 */
export class CFCustodySeal extends BaseElement {
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
        padding: .7rem 1rem;
        border: 1px solid #53655c;
        border-radius: .5rem;
        background: #fff;
        color: #203b2e;
        cursor: pointer;
      }
      button:disabled {
        opacity: .5;
        cursor: default;
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
        direction: ltr;
        unicode-bidi: isolate;
      }
      h3 {
        font-size: 1.05rem;
        margin: 1.25rem 0 0;
      }
      .note {
        margin: .25rem 0 0;
        font-size: .9rem;
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
      dt {
        font-weight: 600;
        margin-top: .75rem;
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      ul {
        margin: 0;
        padding-left: 1.25rem;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: #f3f5f3;
        padding: 1rem;
        border: 1px solid #ccd5cf;
        font: 14px/1.5 monospace;
      }
      summary {
        cursor: pointer;
        margin: 1rem 0 .5rem;
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
      .principal,
      .digest {
        unicode-bidi: isolate;
        font: 14px/1.5 monospace;
      }
      .annotation {
        display: inline-block;
        padding: 0 .4rem;
        border: 1px solid #53655c;
        border-radius: .75rem;
        font-size: .8rem;
        color: #203b2e;
        background: #f3f5f3;
      }
    `,
  ];

  /** Runtime supplied by the host's context provider. */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined;

  /** The actor's draft, whose exact value is sealed. */
  @property({ attribute: false })
  accessor draft: CellHandle | undefined;

  /** The room's terms document; its space is the room the value enters. */
  @property({ attribute: false })
  accessor terms: CellHandle | undefined;

  /** A cell holding the room's custody policy reference. */
  @property({ attribute: false })
  accessor policy: CellHandle | undefined;

  /** The actor's source policy, in the actor's home space. */
  @property({ attribute: false })
  accessor sources: CellHandle | undefined;

  #preview: SealPreview | undefined;
  #binding: SealBinding | undefined;
  #busy = false;
  #error = "";
  #generation = 0;

  /** Exercises host workflow without manufacturing a trusted DOM event. */
  get accessForTestingOnly(): {
    prepare(): Promise<void>;
    confirm(event: Event): Promise<void>;
    readonly preview: SealPreview | undefined;
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
      ["draft", "terms", "policy", "sources", "runtime"].some((key) =>
        changed.has(key)
      )
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
    const summary = preview ? summarizeCustodyTerms(preview.terms) : undefined;
    return html`
      <button type="button" ?disabled=${this.#busy || !this.#bound() ||
        !this.runtime}
        @click=${this.#prepare}>Seal &amp; consent…</button>
      ${this.#error ? html`<p role="alert">${this.#error}</p>` : nothing}
      <dialog aria-labelledby="seal-title" @cancel=${this.#cancel}>
        <h2 id="seal-title" tabindex="-1" autofocus>Join this room with these terms?</h2>
        <dl class="verified">
          <dt>Room</dt>
          <dd class="room">${preview ? principal(preview.room) : nothing}</dd>
          <dt>Who can read the room now, and so see the answer</dt>
          <dd class="readers"><ul>${(preview?.readers ?? []).map((reader) =>
            html`<li>${principal(reader.principal)}${
              reader.principal === preview?.actor ? annotation("you") : nothing
            }${
              reader.principal !== "*" &&
                !summary?.seats.includes(reader.principal)
                ? annotation("no seat")
                : nothing
            }</li>`
          )}</ul>
            <p class="note">The room's owners can add readers later, and the
              service that hosts the room can read it.</p></dd>
          <dt>Seats</dt>
          <dd class="seats"><ul>${(summary?.seats ?? []).map((seat) =>
            html`<li>${principal(seat)}${
              seat === preview?.actor ? annotation("you") : nothing
            }</li>`
          )}</ul></dd>
          <dt>Policy that decides what comes out</dt>
          <dd class="policy">${describePolicy(preview?.policy)}</dd>
          <dt>What goes in from your sources</dt>
          <dd class="sources">${preview && preview.sources.length > 0
            ? html`<ul>${
              preview.sources.map((source) =>
                html`<li>${describeSource(source)}</li>`
              )
            }</ul>`
            : "Nothing beyond what you entered yourself."}</dd>
        </dl>
        <h3>What the room's terms say</h3>
        <dl class="stated">
          ${summary?.question
            ? html`
              <dt>The room asks</dt>
              <dd class="question">${summary.question}</dd>
            `
            : nothing}
          <dt>Answers the terms list</dt>
          <dd class="answers">${summary?.answers
            ? html`<ul>${
              summary.answers.map((answer) => html`<li>${answer}</li>`)
            }</ul>`
            : "These terms do not list the answers the room can give."}</dd>
        </dl>
        <p class="leak">${summary?.leakBits !== undefined
          ? `If the room releases only these answers, each answer reveals at most ${summary.leakBits} ${
            summary.leakBits === "1" ? "bit" : "bits"
          } about your values.`
          : "These terms state no bound on what an answer reveals."}</p>
        <details>
          <summary>Details</summary>
          <p>Your sealed values:</p>
          <pre class="stance">${preview
            ? JSON.stringify(preview.stance, null, 2)
            : ""}</pre>
          <p>The terms, as sealed:</p>
          <pre class="terms">${preview
            ? JSON.stringify(preview.terms, null, 2)
            : ""}</pre>
        </details>
        <div class="actions">
          <button type="button" ?disabled=${this.#busy} @click=${this
            .#cancel}>Cancel</button>
          <button class="confirm" type="button" ?disabled=${this.#busy ||
            !preview}
            @click=${this.#confirm}>Seal &amp; consent</button>
        </div>
      </dialog>
    `;
  }

  #bound(): boolean {
    return !!(this.draft && this.terms && this.policy && this.sources);
  }

  /** Drops the review whenever its binding is no longer current. */
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
    void runtime.cancelCustodySeal(id).catch(() => {});
  }

  #cancel = (): void => {
    this.#invalidate();
    this.requestUpdate();
  };

  /** Checks captured handles before each asynchronous boundary. */
  #current(binding: SealBinding): boolean {
    return this.isConnected && binding.generation === this.#generation &&
      binding.runtime === this.runtime && binding.draft === this.draft &&
      binding.terms === this.terms && binding.policy === this.policy &&
      binding.sources === this.sources;
  }

  /** Asks the worker for the checked preview and opens the dialog on it. */
  #prepare = async (): Promise<void> => {
    if (this.#busy) return;
    const { runtime, draft, terms, policy, sources } = this;
    if (
      !runtime || !draft || !terms || !policy || !sources || !this.isConnected
    ) {
      return;
    }
    this.#invalidate();
    const binding: SealBinding = {
      runtime,
      draft,
      terms,
      policy,
      sources,
      generation: this.#generation,
    };
    this.#binding = binding;
    this.#busy = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const preview = await runtime.prepareCustodySeal({
        draft: draft.ref(),
        terms: terms.ref(),
        policy: policy.ref(),
        allowedSources: sources.ref(),
      });
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
        : "The seal could not be prepared.";
      this.requestUpdate();
    }
  };

  /** Admits only a real browser gesture on the open host confirmation. */
  #confirm = async (event: Event): Promise<void> => {
    Event.prototype.stopPropagation.call(event);
    await this.#commitReviewed(event);
  };

  /** Seals the reviewed value and announces it. */
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
      await binding.runtime.commitCustodySeal(preview.id);
      // The preview is consumed; nothing is left to cancel.
      this.#preview = undefined;
      if (!this.#current(binding)) return;
      this.#invalidate();
      this.emit("cf-sealed");
    } catch (error) {
      this.#preview = undefined;
      if (!this.#current(binding)) return;
      this.#invalidate();
      this.#error = error instanceof Error
        ? error.message
        : "The value could not be sealed.";
    } finally {
      this.requestUpdate();
    }
  }
}
