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

  override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (
      changed.has("runtime") || changed.has("originator") ||
      changed.has("result")
    ) {
      void this.refresh();
    }
  }

  override disconnectedCallback(): void {
    this.#generation++;
    super.disconnectedCallback();
  }

  /** Rechecks the immutable origin when its binding or runtime changes. */
  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    const { runtime, originator, result } = this;
    if (!result) return;
    try {
      await result.setStrict(null);
    } catch {
      // A refused reset cannot establish a fresh owner decision.
      return;
    }
    if (!runtime || !originator || !this.isConnected) return;
    try {
      const label = await readCfcLabelView(originator);
      if (
        generation !== this.#generation || !this.isConnected ||
        runtime !== this.runtime || originator !== this.originator ||
        result !== this.result
      ) return;
      const owner = attestedOwnerPrincipal(label);
      const actor = runtime.actingPrincipalDid();
      if (owner && actor) await result.setStrict(owner === actor);
    } catch {
      // Missing or unreadable attestation keeps the presentation closed.
    }
  }

  override render() {
    return html``;
  }
}
