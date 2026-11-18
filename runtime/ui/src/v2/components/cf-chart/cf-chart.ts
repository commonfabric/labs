/**
 * cf-chart - SVG charting container component.
 *
 * Discovers child mark elements via slotchange, collects their data,
 * computes scales, and renders all marks as SVG groups.
 *
 * @element cf-chart
 *
 * @attr {number} height - Chart height in px (default: 200). Width is responsive.
 * @attr {MarkConfig[]} marks - Programmatic marks (rendered below child marks)
 * @attr {boolean} xAxis - Show x-axis
 * @attr {boolean} yAxis - Show y-axis
 * @attr {string} xType - Scale type: "linear" | "time" | "band" (auto-detected)
 * @attr {string} yType - Scale type: "linear" | "log" (auto-detected)
 * @attr {[min, max]} xDomain - Override x domain
 * @attr {[min, max]} yDomain - Override y domain
 * @attr {boolean} crosshair - Show crosshair on hover (default: true)
 *
 * @fires cf-hover - Hover with nearest data point
 * @fires cf-click - Click with nearest data point
 * @fires cf-leave - Mouse leaves chart area
 */

import { html, svg, PropertyValues } from "lit";
import type { CellHandle } from "@commonfabric/runtime-client";
import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { chartStyles } from "./styles.ts";
import type {
  AxisConfig,
  AxisOption,
  MarkConfig,
  XScaleType,
  YScaleType,
  ChartPadding,
} from "./types.ts";
import { MarkElement } from "./marks/base-mark.ts";
import {
  collectAllMarkData,
  createScales,
  type CollectedMarkData,
  type XScale,
  type YScale,
} from "./lib/scales.ts";
import { renderMark } from "./lib/render.ts";
import { renderXAxis, renderYAxis } from "./lib/axes.ts";
import {
  computeEventDetail,
  renderCrosshair,
  type NearestResult,
} from "./lib/interaction.ts";

const DEFAULT_HEIGHT = 200;

/** Normalize boolean | AxisConfig → AxisConfig | null */
function resolveAxisConfig(opt: AxisOption | undefined): AxisConfig | null {
  if (!opt) return null;
  if (opt === true) return {};
  return opt;
}

export class CFChart extends BaseElement {
  static override styles = [BaseElement.baseStyles, chartStyles];

  static override properties = {
    height: { type: Number },
    marks: { attribute: false },
    xAxis: { attribute: false },
    yAxis: { attribute: false },
    xType: { type: String },
    yType: { type: String },
    xDomain: { attribute: false },
    yDomain: { attribute: false },
    padding: { attribute: false },
    crosshair: { type: Boolean },
  };

  declare height: number;
  declare marks: CellHandle<MarkConfig[]> | MarkConfig[];
  declare xAxis: AxisOption;
  declare yAxis: AxisOption;
  declare xType: XScaleType | undefined;
  declare yType: YScaleType | undefined;
  declare xDomain: [unknown, unknown] | undefined;
  declare yDomain: [number, number] | undefined;
  declare padding: number | [number, number, number, number] | undefined;
  declare crosshair: boolean;

  #width = 0;
  #childMarks: MarkElement[] = [];
  #resizeObserver: ResizeObserver | null = null;
  #crosshairX: number | null = null;
  #tooltipInfo: NearestResult | null = null;

  /** Cell controller for the `$marks` prop. */
  #marksController = createCellController<MarkConfig[]>(this, {
    timing: { strategy: "immediate" },
  });

  constructor() {
    super();
    this.height = DEFAULT_HEIGHT;
    this.xAxis = false;
    this.yAxis = false;
    this.crosshair = true;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("mark-update", this.#onMarkUpdate);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("mark-update", this.#onMarkUpdate);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  protected override willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    if (changedProperties.has("marks") && this.marks !== undefined) {
      this.#marksController.bind(this.marks);
    }
  }

  protected override firstUpdated(changedProperties: PropertyValues): void {
    super.firstUpdated(changedProperties);

    // The observer reports the container's size when it starts observing,
    // and again whenever that size changes.
    const container = this.shadowRoot?.querySelector(".chart-container");
    if (container) {
      this.#resizeObserver = new ResizeObserver(([entry]) => {
        this.#width = entry.contentRect.width;
        this.requestUpdate();
      });
      this.#resizeObserver.observe(container);
    }

    this.#discoverChildMarks();
  }

  override render() {
    const chartPadding = this.#computePadding();
    const plotWidth = Math.max(0, this.#width - chartPadding.left - chartPadding.right);
    const plotHeight = Math.max(0, this.height - chartPadding.top - chartPadding.bottom);

    // Collect mark data
    const configMarks = this.#getConfigMarks();
    const allMarks = collectAllMarkData(configMarks, this.#childMarks);

    // Compute scales (skip if no data or no width)
    let xScale: XScale | null = null;
    let yScale: YScale | null = null;
    let xType: XScaleType = "linear";

    if (allMarks.some((m) => m.points.length > 0) && plotWidth > 0 && plotHeight > 0) {
      const scales = createScales(allMarks, this.#width, this.height, chartPadding, {
        xType: this.xType,
        yType: this.yType,
        xDomain: this.xDomain,
        yDomain: this.yDomain,
      });
      xScale = scales.xScale;
      yScale = scales.yScale;
      xType = scales.xType;
    }

    const svgContent = xScale && yScale
      ? this.#renderChartContent(
        allMarks,
        xScale,
        yScale,
        xType,
        plotWidth,
        plotHeight,
        chartPadding,
        configMarks,
      )
      : svg``;

    const tooltip = this.#tooltipInfo
      ? this.#renderTooltip(this.#tooltipInfo, chartPadding)
      : html``;

    const w = this.#width || "100%";
    const vw = this.#width || 1;

    return html`
      <div class="chart-container" style="height: ${this.height}px;">
        <svg width="${w}" height="${this.height}" viewBox="0 0 ${vw} ${this.height}">
          ${svgContent}
        </svg>
        ${tooltip}
        <slot @slotchange=${this.#onSlotChange}></slot>
      </div>
    `;
  }

  //
  // Chart content rendering
  //

  #renderChartContent(
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    xType: XScaleType,
    plotWidth: number,
    plotHeight: number,
    padding: ChartPadding,
    configMarks: readonly MarkConfig[],
  ) {
    const marks = this.#renderAllMarks(
      allMarks, xScale, yScale, plotHeight, configMarks,
    );
    const xAxisConfig = resolveAxisConfig(this.xAxis);
    const yAxisConfig = resolveAxisConfig(this.yAxis);
    const xAxisSvg = xAxisConfig
      ? renderXAxis(xScale, xType, plotWidth, plotHeight, xAxisConfig)
      : svg``;
    const yAxisSvg = yAxisConfig
      ? renderYAxis(yScale, plotWidth, plotHeight, yAxisConfig)
      : svg``;
    const crosshairSvg = this.crosshair && this.#crosshairX !== null
      ? renderCrosshair(this.#crosshairX, plotHeight)
      : svg``;

    const onMove = (e: MouseEvent) =>
      this.#handleMouseMove(e, allMarks, xScale, yScale, xType);
    const onClick = (e: MouseEvent) =>
      this.#handleClick(e, allMarks, xScale, yScale, xType);
    const tx = padding.left;
    const ty = padding.top;

    return svg`<g transform="translate(${tx}, ${ty})">${marks}${xAxisSvg}${yAxisSvg}${crosshairSvg}<rect class="interaction-overlay" width="${plotWidth}" height="${plotHeight}" @mousemove=${onMove} @click=${onClick} @mouseleave=${this.#handleMouseLeave} /></g>`;
  }

  //
  // Mark rendering
  //

  #renderAllMarks(
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    plotHeight: number,
    configMarks: readonly MarkConfig[],
  ) {
    const configCount = configMarks.length;

    const groups = allMarks.map((markData, i) => {
      const config = i < configCount
        ? configMarks[i]
        : this.#childMarks[i - configCount];

      const rendered = renderMark(
        markData.type,
        markData.points,
        xScale,
        yScale,
        plotHeight,
        config,
      );

      return svg`<g class="mark-group" data-mark-index="${i}">${rendered}</g>`;
    });

    return svg`${groups}`;
  }

  //
  // Tooltip rendering
  //

  #renderTooltip(info: NearestResult, padding: ChartPadding) {
    const { pixelX, pixelY, point, label } = info;
    const x = pixelX + padding.left;
    const y = pixelY + padding.top;
    const yVal = Number.isInteger(point.y) ? point.y : point.y.toFixed(2);

    return html`
      <div class="tooltip" style="left: ${x}px; top: ${y}px;">
        ${label ? html`<span class="tooltip-label">${label}:</span>` : html``}
        <span>${yVal}</span>
      </div>
    `;
  }

  //
  // Event handlers
  //

  #handleMouseMove(
    e: MouseEvent,
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    xType: XScaleType,
  ): void {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    // rect already includes the SVG <g> translate, so coordinates are in plot space
    const plotX = e.clientX - rect.left;
    const plotY = e.clientY - rect.top;

    const { detail, nearest } = computeEventDetail(
      plotX, plotY, allMarks, xScale, yScale, xType,
    );

    if (this.crosshair && nearest) {
      this.#crosshairX = nearest.pixelX;
      this.#tooltipInfo = nearest;
      this.requestUpdate();
    }

    this.emit("cf-hover", detail);
  }

  #handleClick(
    e: MouseEvent,
    allMarks: CollectedMarkData[],
    xScale: XScale,
    yScale: YScale,
    xType: XScaleType,
  ): void {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const plotX = e.clientX - rect.left;
    const plotY = e.clientY - rect.top;

    const { detail } = computeEventDetail(
      plotX, plotY, allMarks, xScale, yScale, xType,
    );

    this.emit("cf-click", detail);
  }

  #handleMouseLeave = (): void => {
    this.#crosshairX = null;
    this.#tooltipInfo = null;
    this.requestUpdate();
    this.emit("cf-leave", {});
  };

  //
  // Slot management
  //

  #onSlotChange = (): void => {
    this.#discoverChildMarks();
    this.requestUpdate();
  };

  #onMarkUpdate = (): void => {
    this.requestUpdate();
  };

  #discoverChildMarks(): void {
    const slot = this.shadowRoot?.querySelector("slot");
    this.#childMarks = (slot?.assignedElements({ flatten: true }) ?? []).filter(
      (n): n is MarkElement => n instanceof MarkElement,
    );
  }

  //
  // Config marks
  //

  #getConfigMarks(): readonly MarkConfig[] {
    return this.#marksController.getValue() || [];
  }

  //
  // Padding computation
  //

  #computePadding(): ChartPadding {
    if (this.padding !== undefined) {
      if (typeof this.padding === "number") {
        return {
          top: this.padding,
          right: this.padding,
          bottom: this.padding,
          left: this.padding,
        };
      }
      const [t, r, b, l] = this.padding;
      return { top: t, right: r, bottom: b, left: l };
    }

    // Auto-calculate based on axes
    const xConfig = resolveAxisConfig(this.xAxis);
    const yConfig = resolveAxisConfig(this.yAxis);
    return {
      top: 8,
      right: 8,
      bottom: xConfig ? (xConfig.label ? 40 : 28) : 8,
      left: yConfig ? (yConfig.label ? 56 : 48) : 8,
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-chart": CFChart;
  }
}
