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
import { shownValue } from "../../core/shown-value.ts";
import { runtimeContext } from "../../runtime-context.ts";

/**
 * The seal's refusals while an answer is not, or is already, published: the
 * slot says which. Anything else, such as a lost worker connection or a slot
 * the seal did not write, is said to the room's readers.
 */
const EXPECTED_REFUSALS = [
  "Custody answer requires every seat to have sealed",
  "Custody answer requires a value the room's policy releases to the seal",
  "Custody answer is already published for this instance",
  "Custody answer's room changed while publishing",
];

const isExpectedRefusal = (error: unknown): boolean =>
  error instanceof Error &&
  EXPECTED_REFUSALS.some((refusal) => error.message.includes(refusal));

/**
 * What the seal publishes: a string of at most 1,024 characters, a number, or
 * a boolean.
 */
type CustodyAnswer = string | number | boolean;

const isCustodyAnswer = (value: JSONValue): value is CustodyAnswer =>
  typeof value === "string" || typeof value === "number" ||
  typeof value === "boolean";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Publishes a custody room's answer once and shows it. A room binds it as
 * `<cf-custody-answer $terms={terms} $policy={policy} $output={choice} />`,
 * where `output` is the room's projected answer. Each time the projected answer
 * changes, the component asks the worker to publish it; the seal publishes it
 * once, only when every rule of the room's policy requires the seal's witness
 * and releases only to the seal, a rule releases it to the seal, and every seat
 * has sealed, and refuses every later request. Before the room has terms it
 * asks nothing. A failure other than those refusals is shown as an alert, and
 * the next change asks again. The component shows, as text, what the seal
 * published, which is a string, a number or a boolean; any other value is shown
 * as an alert, not as the answer. It is read by the worker from the slot the
 * seal derives from the room's terms and policy and verified to be the seal's
 * own write, never a value the room holds. That is the slot of the instance the
 * bound `terms` digest to, under the policy the bound `policy` cell names. The
 * slot is create-only and the seal's alone to write, so the answer published
 * for an instance never changes. Which instance the component shows is not held
 * against a room member's own code: its bindings are pattern data the room
 * space's members can write, so a member's code can point them at another
 * instance's terms, or at terms whose slot is empty. A writer claim on the
 * room's cells does not close that in general, as write authority is keyed by
 * code (normative CFC §8.15.8).
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
  #answer: CustodyAnswer | undefined;
  #inFlight: Promise<void> | undefined;
  #again = false;
  #generation = 0;
  #error = "";

  /** Exercises the publication without a subscription. */
  get accessForTestingOnly(): {
    publish(): Promise<void>;
    readonly published: boolean;
    readonly answer: CustodyAnswer | undefined;
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
    // A request still out when the element leaves belongs to it no more:
    // what it returns is dropped, and a request queued behind it never runs.
    this.#generation++;
    this.#again = false;
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
    const { output, terms, policy } = this;
    if (!output || !terms || !policy || !this.isConnected) return;
    // New terms are a new instance, and a new policy names another instance's
    // slot: either has an answer of its own to publish and show. Subscribing
    // delivers each cell's current value at once, which is where this binding
    // starts, so it starts over once for all of them.
    const startOver = () => {
      this.#generation++;
      this.#published = false;
      this.#answer = undefined;
      this.#error = "";
      this.requestUpdate();
    };
    startOver();
    let subscribing = true;
    const onBinding = () => {
      if (!subscribing) startOver();
      void this.#publish();
    };
    // Terms or a policy the worker will not show name no instance this
    // element may publish for: what it showed goes, and nothing is asked.
    const onRefusedBinding = () => {
      if (!subscribing) startOver();
    };
    const cancelTerms = terms.subscribe(onBinding, {
      onRefused: onRefusedBinding,
    });
    const cancelPolicy = policy.subscribe(onBinding, {
      onRefused: onRefusedBinding,
    });
    const cancelOutput = output.subscribe(() => {
      void this.#publish();
    }, {
      // The output is not read here: it is the worker's to release, so its
      // refusal changes nothing this element asks.
      onRefused: () => {},
    });
    subscribing = false;
    this.#unsubscribe = () => {
      cancelTerms();
      cancelPolicy();
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
    // A request queued behind this one runs only if this one did not
    // publish; either way the queue is empty now.
    const queued = this.#again;
    this.#again = false;
    if (queued && !this.#published) await this.#publish();
  }

  async #request(): Promise<void> {
    const { runtime, terms, policy, output } = this;
    if (this.#published || !runtime || !terms || !policy || !output) return;
    // A room that has not proposed yet has no terms, and so no instance to
    // publish for: nothing to ask, and nothing to say. The terms
    // subscription asks once they are written.
    // Terms the worker will not show read as none proposed.
    const proposed = shownValue(terms);
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
    // Rebound or detached meanwhile: this request's instance is not the one
    // shown any more.
    if (generation !== this.#generation) return;
    // Shown from the slot itself, whoever published it.
    let answer: CustodyAnswer | undefined;
    try {
      const read = await runtime.readCustodyAnswer({
        terms: terms.ref(),
        policy: policy.ref(),
      });
      if (read !== undefined && !isCustodyAnswer(read)) {
        throw new Error(
          "Custody answer refuses an answer that is not a scalar",
        );
      }
      answer = read;
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
