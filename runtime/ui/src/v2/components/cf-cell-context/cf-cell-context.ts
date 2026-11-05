import type { CellHandle } from "@commonfabric/runtime-client";
import { css } from "lit";
import { property } from "lit/decorators.js";

import { RetiredElement } from "../../core/retired-element.ts";

/**
 * CFCellContext — RETIRED (#5132), kept as an inert passthrough.
 *
 * The Alt-hold cell-region overlay this used to draw is gone; live-state
 * inspection lives in cf-piece-menu's Data and Actions panels now. What is
 * kept is the element itself, because durable pattern source still emits it:
 * home's Favorites section, among others, wraps each row in
 * `<cf-cell-context $cell={item.cell}>`, and those pieces keep running the
 * source they were stored with.
 *
 * The props are retained so that source keeps binding cleanly; nothing reads
 * them. (An earlier revision claimed `$cell` had to stay typed as a cell to
 * preserve the schema derived for the surrounding row. That was wrong, and
 * review refuted it: neither the Lit property nor a JSX contextual type
 * affects that schema.)
 *
 * The host layout is the retired component's, verbatim. An inert element is
 * not a layout-neutral one: stored source was authored against this box, so
 * collapsing it would reflow the very pages the stub exists to keep working.
 *
 * @element cf-cell-context
 * @deprecated Retired in #5132. Renders children and nothing else; use
 * cf-piece-menu for cell inspection. Stop emitting it from new patterns.
 */
export class CFCellContext extends RetiredElement {
  static override styles = [
    ...RetiredElement.styles,
    css`
      :host {
        display: block;
        position: relative;
        flex: 1;
        min-height: 0;
      }

      :host([inline]) {
        display: inline-block;
        flex: none;
      }
    `,
  ];

  protected override retiredTag = "cf-cell-context";
  protected override retiredReplacement = "cf-piece-menu";

  /** Retained so `$cell` keeps its cell binding; otherwise unused. */
  @property({ attribute: false })
  accessor cell: CellHandle<unknown> | undefined = undefined;

  /** Retained for source compatibility; unused. */
  @property({ type: String })
  accessor label: string | undefined = undefined;

  /** Retained for source compatibility; unused. */
  @property({ type: Boolean })
  accessor inline = false;
}
