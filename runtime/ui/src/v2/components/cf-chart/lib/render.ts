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
import type { CurveType, DataPoint } from "../types.ts";
import { type XScale, xPosition, type YScale } from "./scales.ts";

/**
 * The styling a mark carries, read from either a `MarkConfig` or a mark
 * element. A `y2` that is not a number is ignored.
 */
export interface MarkStyle {
  color?: string;
  strokeWidth?: number;
  curve?: CurveType;
  opacity?: number;
  y2?: unknown;
  barPadding?: number;
  radius?: number;
}

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

/**
 * Render a line mark.
 */
export function renderLine(
  points: DataPoint[],
  xScale: XScale,
  yScale: YScale,
  config: MarkStyle = {},
): TemplateResult {
  const color = config.color || DEFAULT_COLOR;
  const strokeWidth = config.strokeWidth ?? 2;

  const lineGen = d3Line<DataPoint>()
    .x((d: DataPoint) => xPosition(xScale, d.x))
    .y((d: DataPoint) => yScale(d.y))
    .curve(getCurve(config.curve));

  // The generator returns `null` when there are no points.
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
  config: MarkStyle = {},
): TemplateResult {
  const color = config.color || DEFAULT_COLOR;
  const opacity = config.opacity ?? 0.2;
  const baseline = typeof config.y2 === "number"
    ? yScale(config.y2)
    : plotHeight;

  const areaGen = d3Area<DataPoint>()
    .x((d: DataPoint) => xPosition(xScale, d.x))
    .y0(baseline)
    .y1((d: DataPoint) => yScale(d.y))
    .curve(getCurve(config.curve));

  // The generator returns `null` when there are no points.
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
  config: MarkStyle = {},
): TemplateResult {
  if (points.length === 0) return svg``;

  const color = config.color || DEFAULT_COLOR;
  const opacity = config.opacity ?? 1;

  // Calculate bar width
  let barWidth: number;
  if ("bandwidth" in xScale) {
    barWidth = xScale.bandwidth();
  } else {
    const n = points.length;
    const totalWidth = Math.abs(
      xPosition(xScale, points[n - 1].x) - xPosition(xScale, points[0].x),
    );
    const padding = config.barPadding ?? 0.2;
    barWidth = n > 1
      ? (totalWidth / (n - 1)) * (1 - padding)
      : totalWidth * (1 - padding) || 20;
  }

  const rects = points.map((p) => {
    const x = "bandwidth" in xScale
      ? (xScale(String(p.x)) ?? 0)
      : xPosition(xScale, p.x) - barWidth / 2;
    const yTop = yScale(p.y);
    const yBase = yScale(0);
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
  config: MarkStyle = {},
): TemplateResult {
  if (points.length === 0) return svg``;

  const color = config.color || DEFAULT_COLOR;
  const radius = config.radius ?? 3;

  const circles = points.map((p) => {
    const cx = xPosition(xScale, p.x);
    const cy = yScale(p.y);
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
  style: MarkStyle,
): TemplateResult {
  switch (type) {
    case "line":
      return renderLine(points, xScale, yScale, style);
    case "area":
      return renderArea(points, xScale, yScale, plotHeight, style);
    case "bar":
      return renderBars(points, xScale, yScale, style);
    case "dot":
      return renderDots(points, xScale, yScale, style);
    default:
      return svg``;
  }
}
