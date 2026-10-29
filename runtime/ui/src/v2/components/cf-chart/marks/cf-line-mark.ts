/**
 * cf-line-mark - Line mark element for cf-chart.
 *
 * Headless config holder. Renders nothing visible.
 * The parent cf-chart reads properties and renders the line SVG.
 *
 * @element cf-line-mark
 */

import type { CurveType, MarkType } from "../types.ts";
import { MarkElement } from "./base-mark.ts";

export class CFLineMark extends MarkElement {
  readonly markType: MarkType = "line";

  static override properties = {
    ...MarkElement.properties,
    strokeWidth: { type: Number },
    curve: { type: String },
  };

  declare strokeWidth: number;
  declare curve: CurveType;

  constructor() {
    super();
    this.strokeWidth = 2;
    this.curve = "linear";
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-line-mark": CFLineMark;
  }
}
