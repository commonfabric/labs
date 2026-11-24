/**
 * cf-bar-mark - Bar mark element for cf-chart.
 *
 * Headless config holder. Renders nothing visible.
 * The parent cf-chart reads properties and renders the bar SVG.
 *
 * @element cf-bar-mark
 */

import type { MarkType } from "../types.ts";
import { MarkElement } from "./base-mark.ts";

export class CFBarMark extends MarkElement {
  readonly markType: MarkType = "bar";

  static override properties = {
    ...MarkElement.properties,
    opacity: { type: Number },
    barPadding: { type: Number },
  };

  declare opacity: number;
  declare barPadding: number;

  constructor() {
    super();
    this.opacity = 1;
    this.barPadding = 0.2;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-bar-mark": CFBarMark;
  }
}
