/**
 * SVG rendering functions for each mark type.
 *
 * Uses d3-shape for path generation and Lit's svg template tag.
 */

import { svg, type TemplateResult } from "lit";
// @ts-types="@types/d3-shape"
import {
  area as d3Area,
  curveLinear,
  curveMonotoneX,
  curveNatural,
  curveStep,
  line as d3Line,
} from "d3-shape";
// @ts-types="@types/d3-scale"
import type { ScaleBand } from "d3-scale";
import type { CurveType, DataPoint, MarkConfig } from "../types.ts";
import type { XScale, YScale } from "./scales.ts";
import type { MarkElement } from "../marks/base-mark.ts";

const CURVE_MAP = {
  linear: curveLinear,
  step: curveStep,
  monotone: curveMonotoneX,
  natural: curveNatural,
} as const;

const DEFAULT_COLOR = "#6366f1"; // Indigo accent

function getCurve(type?: CurveType) {
  return CURVE_MAP[type || "linear"] || curveLinear;
}

function scaleX(xScale: XScale, val: unknown): number {
  if ("bandwidth" in xScale) {
    const band = xScale as ScaleBand<string>;
    return (band(String(val)) ?? 0) + band.bandwidth() / 2;
  }
  return (xScale as (v: unknown) => number)(
    val instanceof Date ? val : Number(val),
  );
}

/**
 * Render a line mark.
 */
export function renderLine(
  points: DataPoint[],
  xScale: XScale,
  yScale: YScale,
  config: {
    color?: string;
    strokeWidth?: number;
    curve?: CurveType;
  } = {},
): TemplateResult {
  if (points.length === 0) return svg``;

  const color = config.color || DEFAULT_COLOR;
  const strokeWidth = config.strokeWidth ?? 2;

  const lineGen = d3Line<DataPoint>()
    .x((d: DataPoint) => scaleX(xScale, d.x))
    .y((d: DataPoint) => yScale(d.y) as number)
    .curve(getCurve(config.curve));

  const path = lineGen(points);
  if (!path) return svg``;

  return svg`<path d="${path}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" />`;
}

/**
 * Render an area mark.
 */
export function renderArea(
  points: DataPoint[],
  xScale: XScale,
  yScale: YScale,
  plotHeight: number,
  config: {
    color?: string;
    opacity?: number;
    curve?: CurveType;
    y2?: number;
  } = {},
): TemplateResult {
  if (points.length === 0) return svg``;

  const color = config.color || DEFAULT_COLOR;
  const opacity = config.opacity ?? 0.2;
  const baseline = config.y2 !== undefined
    ? (yScale(config.y2) as number)
    : plotHeight;

  const areaGen = d3Area<DataPoint>()
    .x((d: DataPoint) => scaleX(xScale, d.x))
    .y0(baseline)
    .y1((d: DataPoint) => yScale(d.y) as number)
    .curve(getCurve(config.curve));

  const path = areaGen(points);
  if (!path) return svg``;

  return svg`<path d="${path}" fill="${color}" fill-opacity="${opacity}" stroke="none" />`;
}

/**
 * Render a bar mark.
 */
export function renderBars(
  points: DataPoint[],
  xScale: XScale,
  yScale: YScale,
  _plotHeight: number,
  config: {
    color?: string;
    opacity?: number;
    barPadding?: number;
  } = {},
): TemplateResult {
  if (points.length === 0) return svg``;

  const color = config.color || DEFAULT_COLOR;
  const opacity = config.opacity ?? 1;

  // Calculate bar width
  let barWidth: number;
  if ("bandwidth" in xScale) {
    barWidth = (xScale as ScaleBand<string>).bandwidth();
  } else {
    const n = points.length;
    const totalWidth = Math.abs(
      scaleX(xScale, points[n - 1].x) - scaleX(xScale, points[0].x),
    );
    const padding = config.barPadding ?? 0.2;
    barWidth = n > 1
      ? (totalWidth / (n - 1)) * (1 - padding)
      : totalWidth * (1 - padding) || 20;
  }

  const rects = points.map((p) => {
    const x = "bandwidth" in xScale
      ? ((xScale as ScaleBand<string>)(String(p.x)) ?? 0)
      : scaleX(xScale, p.x) - barWidth / 2;
    const yTop = yScale(p.y) as number;
    const yBase = yScale(0) as number;
    const h = Math.abs(yBase - yTop);
    const yPos = Math.min(yTop, yBase);
    const w = Math.max(barWidth, 1);
    const height = Math.max(h, 0.5);

    return svg`<rect x="${x}" y="${yPos}" width="${w}" height="${height}" fill="${color}" fill-opacity="${opacity}" rx="1" />`;
  });

  return svg`${rects}`;
}

/**
 * Render a dot/scatter mark.
 */
export function renderDots(
  points: DataPoint[],
  xScale: XScale,
  yScale: YScale,
  config: {
    color?: string;
    radius?: number;
  } = {},
): TemplateResult {
  if (points.length === 0) return svg``;

  const color = config.color || DEFAULT_COLOR;
  const radius = config.radius ?? 3;

  const circles = points.map((p) => {
    const cx = scaleX(xScale, p.x);
    const cy = yScale(p.y) as number;
    return svg`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" />`;
  });

  return svg`${circles}`;
}

/**
 * Render a mark based on its type.
 */
export function renderMark(
  type: string,
  points: DataPoint[],
  xScale: XScale,
  yScale: YScale,
  plotHeight: number,
  config: MarkConfig | MarkElement,
): TemplateResult {
  // deno-lint-ignore no-explicit-any
  const c = config as any;

  switch (type) {
    case "line":
      return renderLine(points, xScale, yScale, {
        color: c.color,
        strokeWidth: c.strokeWidth,
        curve: c.curve,
      });
    case "area":
      return renderArea(points, xScale, yScale, plotHeight, {
        color: c.color,
        opacity: c.opacity,
        curve: c.curve,
        y2: typeof c.y2 === "number" ? c.y2 : undefined,
      });
    case "bar":
      return renderBars(points, xScale, yScale, plotHeight, {
        color: c.color,
        opacity: c.opacity,
        barPadding: c.barPadding,
      });
    case "dot":
      return renderDots(points, xScale, yScale, {
        color: c.color,
        radius: c.radius,
      });
    default:
      return svg``;
  }
}
