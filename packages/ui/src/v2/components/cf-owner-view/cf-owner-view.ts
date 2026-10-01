/** Trusted owner predicate derived from runtime identity and origin attestation. */

import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { readCfcLabelView } from "../../core/cfc-label.ts";
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
    void this.#decide(++this.#generation);
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
   * time the origin updates. The label is read from what the store holds,
   * which can lag the binding, as when the origin's document is not loaded
   * yet, or is rolled back while the piece's start is retried.
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
    await this.#decide(generation);
  }

  #follow(originator: CellHandle | undefined): void {
    if (originator === this.#followed) return;
    this.#stopFollowing?.();
    this.#stopFollowing = undefined;
    this.#followed = originator;
    if (typeof originator?.subscribe !== "function") return;
    this.#stopFollowing = originator.subscribe(() => {
      if (this.#reset) void this.#decide(++this.#generation);
    }, { includeCfcLabel: true });
  }

  /** Publishes the decision the origin's current label supports. */
  async #decide(generation: number): Promise<void> {
    const { runtime, originator, result } = this;
    if (!runtime || !originator || !result || !this.isConnected) return;
    let decision: boolean | null = null;
    try {
      const owner = attestedOwnerPrincipal(await readCfcLabelView(originator));
      const actor = runtime.actingPrincipalDid();
      if (owner && actor) decision = owner === actor;
    } catch {
      // Missing or unreadable attestation keeps the presentation closed.
    }
    if (
      generation !== this.#generation || !this.isConnected ||
      runtime !== this.runtime || originator !== this.originator ||
      result !== this.result || decision === this.#published
    ) return;
    this.#published = decision;
    try {
      await result.setStrict(decision);
    } catch {
      // The next update decides again from whatever the cell holds.
      this.#published = undefined;
    }
  }

  override render() {
    return html``;
  }
}
