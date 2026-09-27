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
 * Publishes a custody room's answer once and shows it. A room binds it as
 * `<cf-custody-answer $terms={terms} $policy={policy} $output={choice} />`,
 * where `output` is the room's projected answer. Each time the projected
 * answer changes, the component asks the worker to publish it; the seal
 * publishes it once, only when a rule of the room's policy that requires the
 * seal's witness releases it to the room's readers and every seat has sealed,
 * and refuses every later request. The component shows what the seal
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

  /** Exercises the publication without a subscription. */
  get accessForTestingOnly(): {
    publish(): Promise<void>;
    readonly published: boolean;
    readonly answer: JSONValue | undefined;
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
    return this.#answer === undefined
      ? nothing
      : html`<span part="answer">${String(this.#answer)}</span>`;
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
    const generation = this.#generation;
    let instance: string | undefined;
    try {
      instance = (await runtime.publishCustodyAnswer({
        terms: terms.ref(),
        policy: policy.ref(),
        output: output.ref(),
      })).instance;
    } catch {
      // Refused: not yet released, not every seat has sealed, or already
      // published. The slot says which.
    }
    // Shown from the slot itself, whoever published it.
    let answer: JSONValue | undefined;
    try {
      answer = await runtime.readCustodyAnswer({
        terms: terms.ref(),
        policy: policy.ref(),
      });
    } catch {
      return;
    }
    if (generation !== this.#generation || answer === undefined) return;
    this.#published = true;
    this.#answer = answer;
    this.requestUpdate();
    this.emit("cf-published", instance === undefined ? {} : { instance });
  }
}
