/** Host publication and display of a custody room's answer, once per instance. */

import {
  type CellHandle,
  type JSONValue,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";

/**
 * The seal's refusals while an answer is not, or is already, published: the
 * slot says which. Anything else, such as a lost worker connection or a slot
 * the seal did not write, is said to the room's readers.
 */
const EXPECTED_REFUSALS = [
  "Custody answer requires every seat to have sealed",
  "Custody answer requires a value the room's policy releases to its readers",
  "Custody answer is already published for this instance",
  "Custody answer's room changed while publishing",
];

const isExpectedRefusal = (error: unknown): boolean =>
  error instanceof Error &&
  EXPECTED_REFUSALS.some((refusal) => error.message.includes(refusal));

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Publishes a custody room's answer once and shows it. A room binds it as
 * `<cf-custody-answer $terms={terms} $policy={policy} $output={choice} />`,
 * where `output` is the room's projected answer. Each time the projected
 * answer changes, the component asks the worker to publish it; the seal
 * publishes it once, only when every rule of the room's policy requires the
 * seal's witness, a rule releases it to the room's readers, and every seat has
 * sealed, and refuses every later request. Before the room has terms it asks
 * nothing. A failure other than those refusals is shown as an alert, and the
 * next change asks again. The component shows what the seal
 * published, read by the worker from the slot the seal derives from the
 * room's terms and policy and verified to be the seal's own write, never a
 * value the room holds, so what it shows cannot move once the answer is
 * published.
 *
 * @element cf-custody-answer
 * @fires cf-published - The answer is published or found published;
 *   `detail.instance` names the instance when this component published it.
 */
export class CFCustodyAnswer extends BaseElement {
  /** Runtime supplied by the host's context provider. */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined;

  /** The room's terms document; its space is the room space. */
  @property({ attribute: false })
  accessor terms: CellHandle | undefined;

  /** A cell holding the room's custody policy reference. */
  @property({ attribute: false })
  accessor policy: CellHandle | undefined;

  /** The room's projected answer. */
  @property({ attribute: false })
  accessor output: CellHandle | undefined;

  #unsubscribe: (() => void) | undefined;
  #published = false;
  #answer: JSONValue | undefined;
  #inFlight: Promise<void> | undefined;
  #again = false;
  #generation = 0;
  #error = "";

  /** Exercises the publication without a subscription. */
  get accessForTestingOnly(): {
    publish(): Promise<void>;
    readonly published: boolean;
    readonly answer: JSONValue | undefined;
    readonly error: string;
  } {
    // deno-lint-ignore no-this-alias
    const component = this;
    return {
      publish: () => this.#publish(),
      get published() {
        return component.#published;
      },
      get answer() {
        return component.#answer;
      },
      get error() {
        return component.#error;
      },
    };
  }

  override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (
      ["terms", "policy", "output", "runtime"].some((key) => changed.has(key))
    ) {
      this.#generation++;
      this.#published = false;
      this.#answer = undefined;
      this.#error = "";
      this.#subscribe();
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#subscribe();
  }

  override disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    super.disconnectedCallback();
  }

  override render() {
    return html`${
      this.#answer === undefined
        ? nothing
        : html`<span part="answer">${String(this.#answer)}</span>`
    }${
      this.#error
        ? html`<p role="alert" part="error">${this.#error}</p>`
        : nothing
    }`;
  }

  #subscribe(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const { output, terms } = this;
    if (!output || !terms || !this.isConnected) return;
    // New terms are a new instance, with an answer of its own to publish and
    // show.
    const cancelTerms = terms.subscribe(() => {
      this.#generation++;
      this.#published = false;
      this.#answer = undefined;
      this.#error = "";
      this.requestUpdate();
      void this.#publish();
    });
    const cancelOutput = output.subscribe(() => {
      void this.#publish();
    });
    this.#unsubscribe = () => {
      cancelTerms();
      cancelOutput();
    };
  }

  /** Asks the worker to publish; a request made while one runs runs after. */
  async #publish(): Promise<void> {
    if (this.#inFlight) {
      this.#again = true;
      return await this.#inFlight;
    }
    this.#inFlight = this.#request();
    try {
      await this.#inFlight;
    } finally {
      this.#inFlight = undefined;
    }
    if (this.#again && !this.#published) {
      this.#again = false;
      await this.#publish();
    }
  }

  async #request(): Promise<void> {
    const { runtime, terms, policy, output } = this;
    if (this.#published || !runtime || !terms || !policy || !output) return;
    // A room that has not proposed yet has no terms, and so no instance to
    // publish for: nothing to ask, and nothing to say. The terms
    // subscription asks once they are written.
    const proposed = terms.get();
    if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) {
      if (this.#error) {
        this.#error = "";
        this.requestUpdate();
      }
      return;
    }
    const generation = this.#generation;
    let instance: string | undefined;
    let error = "";
    try {
      instance = (await runtime.publishCustodyAnswer({
        terms: terms.ref(),
        policy: policy.ref(),
        output: output.ref(),
      })).instance;
    } catch (refused) {
      // Not yet released, not every seat has sealed, or already published:
      // the slot says which. Anything else is said.
      if (!isExpectedRefusal(refused)) error = messageOf(refused);
    }
    // Shown from the slot itself, whoever published it.
    let answer: JSONValue | undefined;
    try {
      answer = await runtime.readCustodyAnswer({
        terms: terms.ref(),
        policy: policy.ref(),
      });
      // Published, by this request or another member's: whatever this
      // request met on the way no longer matters.
      if (answer !== undefined) error = "";
    } catch (failed) {
      error = messageOf(failed);
    }
    if (generation !== this.#generation) return;
    if (error !== this.#error) {
      this.#error = error;
      this.requestUpdate();
    }
    if (answer === undefined) return;
    this.#published = true;
    this.#answer = answer;
    this.requestUpdate();
    this.emit("cf-published", instance === undefined ? {} : { instance });
  }
}
