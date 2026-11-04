/**
 * cf-dot-mark - Dot/scatter mark element for cf-chart.
 *
 * Headless config holder. Renders nothing visible.
 * The parent cf-chart reads properties and renders the dot SVG.
 *
 * @element cf-dot-mark
 */

import type { MarkType } from "../types.ts";
import { MarkElement } from "./base-mark.ts";

export class CFDotMark extends MarkElement {
  readonly markType: MarkType = "dot";

  static override properties = {
    ...MarkElement.properties,
    radius: { type: Number },
  };

  declare radius: number;

  constructor() {
    super();
    this.radius = 3;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-dot-mark": CFDotMark;
  }
}
