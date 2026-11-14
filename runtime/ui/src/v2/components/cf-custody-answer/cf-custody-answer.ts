/** Host display of a custody room's answer, which the worker publishes. */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type {
  CellHandle,
  CustodyAnswerState,
  JSONValue,
  RuntimeClient,
} from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";

/**
 * What the seal publishes: a string of at most 1,024 characters, a number, or
 * a boolean.
 */
type CustodyAnswer = string | number | boolean;

const isCustodyAnswer = (value: unknown): value is CustodyAnswer =>
  typeof value === "string" || typeof value === "number" ||
  typeof value === "boolean";

/**
 * Shows a custody room's answer once the seal has published it. A room binds
 * it as `<cf-custody-answer $terms={terms} $policy={policy} $output={choice} />`,
 * where `output` is the room's projected answer.
 *
 * The component reads nothing its bindings hold: under the display ceiling
 * the room's policy cell and its projected answer are refused to every
 * member, and whether the seal can publish turns on the instance's box, which
 * no member may read either. It hands the three references to the worker's
 * custody answer watch (`RuntimeClient.watchCustodyAnswer`), which follows
 * those cells with the worker's authority, asks the seal to publish once
 * every rule of the room's policy requires the seal's witness and releases
 * only to the seal, a rule releases the projected answer to the seal, and
 * every seat has sealed, and sends what the room's instance has published.
 *
 * The component shows, as text, the answer the worker sends, which the
 * worker's host-read gate decided under the display ceiling; an answer the
 * gate refuses shows nothing, as a binding the ceiling withholds does. A
 * failure other than the seal's waiting, and an answer that is not a string,
 * a number or a boolean, are shown as an alert. The answer is the one the seal
 * published into the slot of the instance the bound `terms` digest to, under
 * the policy the bound `policy` cell names, never a value the room holds. The
 * slot is create-only and the seal's alone to write, so the answer published
 * for an instance never changes. Which instance the component shows is not
 * held against a room member's own code: its bindings are pattern data the
 * room space's members can write, so a member's code can point them at
 * another instance's terms, or at terms whose slot is empty. A writer claim on
 * the room's cells does not close that in general, as write authority is
 * keyed by code (normative CFC §8.15.8).
 *
 * @element cf-custody-answer
 * @fires cf-published - An instance's answer is shown, once per instance;
 *   `detail.instance` names the instance when this element's watch published
 *   it.
 */
export class CFCustodyAnswer extends BaseElement {
  /** Runtime supplied by the host's context provider. */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined;

  /** The room's terms document; its space is the room space. */
  @property({ attribute: false })
  accessor terms: CellHandle | undefined;

  /** A cell holding, or whose label declares, the room's custody policy. */
  @property({ attribute: false })
  accessor policy: CellHandle | undefined;

  /** The room's projected answer. */
  @property({ attribute: false })
  accessor output: CellHandle | undefined;

  #unwatch: (() => void) | undefined;
  /** What the standing watch was started with. */
  #watched: readonly unknown[] | undefined;
  #generation = 0;
  #answer: CustodyAnswer | undefined;
  #error = "";
  /** The instance whose answer was last announced with `cf-published`. */
  #announced: string | undefined;

  /** Exercises what the element shows without a DOM. */
  get accessForTestingOnly(): {
    readonly answer: CustodyAnswer | undefined;
    readonly error: string;
  } {
    // deno-lint-ignore no-this-alias
    const component = this;
    return {
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
      this.#watch();
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.#watch();
  }

  override disconnectedCallback(): void {
    this.#stop();
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

  /**
   * Ends the watch standing, forgets what it showed, and drops whatever a
   * watch still starting brings.
   */
  #stop(): void {
    this.#generation++;
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#watched = undefined;
    this.#answer = undefined;
    this.#error = "";
    this.#announced = undefined;
  }

  /**
   * Watches the bound room afresh: other bindings name another room, or
   * another instance's slot, whose answer is that room's own to show.
   */
  #watch(): void {
    const { runtime, terms, policy, output } = this;
    const bound = [runtime, terms, policy, output];
    // Connecting and the first update each ask; one watch serves both.
    if (
      this.isConnected && this.#watched?.every((was, i) => was === bound[i])
    ) return;
    this.#stop();
    this.requestUpdate();
    if (!runtime || !terms || !policy || !output || !this.isConnected) return;
    this.#watched = bound;
    const generation = this.#generation;
    runtime.watchCustodyAnswer({
      terms: terms.ref(),
      policy: policy.ref(),
      output: output.ref(),
    }, (state) => {
      if (generation === this.#generation) this.#show(state);
    }).then((unwatch) => {
      if (generation === this.#generation) this.#unwatch = unwatch;
      else unwatch();
    }, (failed: unknown) => {
      if (generation !== this.#generation) return;
      // No watch stands, so the next connection or update starts one.
      this.#watched = undefined;
      this.#error = describeFailure(failed);
      this.requestUpdate();
    });
  }

  #show(state: CustodyAnswerState): void {
    let answer: CustodyAnswer | undefined;
    let error = "";
    let instance: string | undefined;
    if (state.status === "pending") {
      error = state.error ?? "";
    } else if (!("refused" in state.answer)) {
      // Refused, the answer is withheld as a binding the ceiling withholds
      // is: nothing is shown, and nothing said.
      const value: JSONValue | undefined = state.answer.value as
        | JSONValue
        | undefined;
      if (isCustodyAnswer(value)) {
        answer = value;
        instance = state.instance;
      } else {
        error = "Custody answer refuses an answer that is not a scalar";
      }
    }
    this.#answer = answer;
    this.#error = error;
    this.requestUpdate();
    if (
      instance !== undefined && state.status === "published" &&
      instance !== this.#announced
    ) {
      this.#announced = instance;
      this.emit("cf-published", state.publishedHere ? { instance } : {});
    }
  }
}
