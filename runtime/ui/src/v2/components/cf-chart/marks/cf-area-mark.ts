/**
 * cf-area-mark - Area mark element for cf-chart.
 *
 * Headless config holder. Renders nothing visible.
 * The parent cf-chart reads properties and renders the area SVG.
 *
 * @element cf-area-mark
 */

import type { CurveType, MarkType } from "../types.ts";
import { MarkElement } from "./base-mark.ts";

export class CFAreaMark extends MarkElement {
  readonly markType: MarkType = "area";

  static override properties = {
    ...MarkElement.properties,
    strokeWidth: { type: Number },
    curve: { type: String },
    opacity: { type: Number },
    y2: { attribute: false },
  };

  declare strokeWidth: number;
  declare curve: CurveType;
  declare opacity: number;
  declare y2: string | number | undefined;

  constructor() {
    super();
    this.strokeWidth = 2;
    this.curve = "linear";
    this.opacity = 0.2;
    this.y2 = undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-area-mark": CFAreaMark;
  }
}
