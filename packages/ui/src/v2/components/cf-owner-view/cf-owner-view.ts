/** Trusted owner predicate derived from runtime identity and origin attestation. */

import type { CfcLabelView } from "@commonfabric/runner/cfc";
import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";
import { attestedOwnerPrincipal } from "./owner-predicate.ts";

/** Publishes a presentation predicate after checking a runtime-attested owner. */
export class CFOwnerView extends BaseElement {
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined;

  /** Persisted creator identity cell; its CFC label supplies the attestation. */
  @property({ attribute: false })
  accessor originator: CellHandle | undefined;

  /** Per-user presentation state; null means the owner is unverified. */
  @property({ attribute: false })
  accessor result: CellHandle<boolean | null> | undefined;

  #generation = 0;
  /** Whether the current binding's reset has landed, so it may be decided. */
  #reset = false;
  /** The value last written to `result`, or undefined when it is unknown. */
  #published: boolean | null | undefined;
  #followed: CellHandle | undefined;
  #stopFollowing: (() => void) | undefined;
  /** The label the followed origin's subscription last delivered. */
  #label: CfcLabelView | undefined;
  /** Whether the element was disconnected and has not reconnected since. */
  #disconnected = false;

  override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (
      changed.has("runtime") || changed.has("originator") ||
      changed.has("result")
    ) {
      void this.refresh();
    }
  }

  /**
   * Follows the origin again after a reconnect with no property change, as a
   * move to another parent makes, which runs no update. A decision already
   * published stands until the origin's current label decides otherwise.
   */
  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.#disconnected) return;
    this.#disconnected = false;
    if (!this.#reset) {
      void this.refresh();
      return;
    }
    this.#follow(this.originator);
    void this.#decideFrom(++this.#generation, this.#label);
  }

  override disconnectedCallback(): void {
    this.#generation++;
    this.#disconnected = true;
    this.#follow(undefined);
    super.disconnectedCallback();
  }

  /**
   * Rechecks the origin when its binding or runtime changes: closes the
   * presentation, decides from the origin's label, and decides again each
   * time the origin's subscription delivers an update. The label is what the
   * store holds, which can lag the binding, as when the origin's document is
   * not loaded yet, or is rolled back while the piece's start is retried.
   */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    const { result } = this;
    this.#reset = false;
    this.#published = undefined;
    this.#follow(this.isConnected ? this.originator : undefined);
    if (!result) return;
    try {
      await result.setStrict(null);
    } catch {
      // A refused reset cannot establish a fresh owner decision.
      return;
    }
    if (generation !== this.#generation) return;
    this.#reset = true;
    this.#published = null;
    await this.#decideFrom(generation, this.#label);
  }

  #follow(originator: CellHandle | undefined): void {
    if (originator === this.#followed) return;
    this.#stopFollowing?.();
    this.#stopFollowing = undefined;
    this.#followed = originator;
    this.#label = undefined;
    if (typeof originator?.subscribe !== "function") return;
    this.#stopFollowing = originator.subscribe((_value, cfcLabel) => {
      this.#label = cfcLabel;
      if (this.#reset) void this.#decideFrom(++this.#generation, cfcLabel);
    }, { includeCfcLabel: true });
  }

  /**
   * Decides from `label`, the one an update of the origin delivered, or from
   * a read of the origin's label when it delivered none. A subscription can
   * deliver no label even when the cell has one, as when another handle on
   * the same cell subscribed first for its value alone.
   */
  async #decideFrom(
    generation: number,
    label: CfcLabelView | undefined,
  ): Promise<void> {
    if (label === undefined) {
      try {
        label = await this.originator?.getCfcLabel();
      } catch {
        // Missing or unreadable attestation keeps the presentation closed.
      }
    }
    this.#decide(generation, label);
  }

  /**
   * Writes the decision `label` supports, unless it is the one this binding
   * last wrote. A decision is written once until the label or the binding
   * changes it, whatever happens to `result` meanwhile.
   */
  #decide(generation: number, label: CfcLabelView | undefined): void {
    const { runtime, originator, result } = this;
    if (
      !runtime || !originator || !result || !this.isConnected ||
      generation !== this.#generation
    ) return;
    let decision: boolean | null = null;
    try {
      const owner = attestedOwnerPrincipal(label);
      const actor = runtime.actingPrincipalDid();
      if (owner && actor) decision = owner === actor;
    } catch {
      // Missing or unreadable attestation keeps the presentation closed.
    }
    if (decision === this.#published) return;
    this.#published = decision;
    result.setStrict(decision).catch(() => {
      // The next update decides again from whatever the cell holds.
      if (this.#published === decision) this.#published = undefined;
    });
  }

  override render() {
    return html``;
  }
}
