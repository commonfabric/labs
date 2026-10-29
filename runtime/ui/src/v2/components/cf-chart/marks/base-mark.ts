/**
 * MarkElement base class - headless config holder for chart marks.
 *
 * Mark elements render nothing visible (display: none). They act as
 * declarative config holders (like <source>, <option>, <track>).
 * The parent cf-chart reads their properties and renders all SVG.
 */

import { css, LitElement, PropertyValues } from "lit";
import { type CellHandle } from "@commonfabric/runtime-client";
import { CellController } from "../../../core/cell-controller.ts";
import type { MarkType } from "../types.ts";

export abstract class MarkElement extends LitElement {
  static override styles = css`
    :host {
      display: none !important;
    }
  `;

  /** Mark type identifier - set by each subclass */
  abstract readonly markType: MarkType;

  static override properties = {
    data: { attribute: false },
    x: { type: String },
    y: { type: String },
    color: { type: String },
    label: { type: String },
  };

  declare data:
    | CellHandle<number[] | Record<string, unknown>[]>
    | number[]
    | Record<string, unknown>[];
  declare x: string | undefined;
  declare y: string | undefined;
  declare color: string | undefined;
  declare label: string | undefined;

  private _dataController = new CellController<
    number[] | Record<string, unknown>[]
  >(this, {
    timing: { strategy: "immediate" },
    onChange: () => {
      this._notifyChart();
    },
  });

  constructor() {
    super();
    this.x = undefined;
    this.y = undefined;
    this.color = undefined;
    this.label = undefined;
  }

  /** Get resolved data array (handles both Cell and plain values) */
  getData(): readonly (number | Record<string, unknown>)[] {
    return this._dataController.getValue() || [];
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    if (this.data !== undefined) {
      this._dataController.bind(this.data);
    }
  }

  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (changedProperties.has("data") && this.data !== undefined) {
      this._dataController.bind(this.data);
    }
    this._notifyChart();
  }

  /** Dispatch event to notify parent cf-chart of config changes */
  protected _notifyChart(): void {
    this.dispatchEvent(
      new CustomEvent("mark-update", {
        bubbles: true,
        composed: true,
      }),
    );
  }
}
