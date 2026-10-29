import type { CellHandle } from "@commonfabric/runtime-client";
import { css } from "lit";
import { property } from "lit/decorators.js";

import { RetiredElement } from "../../core/retired-element.ts";

/**
 * CFUpdater — RETIRED, kept as an inert passthrough.
 *
 * This used to be a button that registered its piece with the background
 * piece service, which polled registered pieces on the server. That service
 * no longer exists, so there is nothing to register with. The element is kept
 * because durable pattern source may still emit it.
 *
 * The props are retained so that source keeps binding cleanly; nothing reads
 * them. The host layout is the retired component's.
 *
 * @element cf-updater
 * @deprecated Retired along with the background piece service. Renders
 * children and nothing else. Stop emitting it from new patterns.
 */
export class CFUpdater extends RetiredElement {
  static override styles = [
    ...RetiredElement.styles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  protected override retiredTag = "cf-updater";

  /** Retained so `$state` keeps its cell binding; otherwise unused. */
  @property({ attribute: false })
  accessor state: CellHandle<unknown> | undefined = undefined;

  /** Retained for source compatibility; unused. */
  @property({ type: String })
  accessor integration: string | undefined = undefined;
}
