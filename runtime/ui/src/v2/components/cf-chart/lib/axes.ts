/**
 * Simple axis rendering for cf-chart.
 *
 * Renders tick marks and labels for x and y axes as SVG groups.
 * Accepts AxisConfig for customization (label, tickFormat, grid, tickCount).
 */

import { svg, type TemplateResult } from "lit";
import { type XScale, xPosition, type YScale } from "./scales.ts";
import type { AxisConfig, XScaleType } from "../types.ts";

/** Maximum number of ticks to display */
const MAX_TICKS = 10;

/**
 * Resolve a tick formatter from AxisConfig.
 * Supports: undefined (auto), string (d3-format specifier — future), or function.
 */
function resolveTickFormat(
  config: AxisConfig,
  fallback: (value: unknown) => string,
): (value: unknown) => string {
  if (typeof config.tickFormat === "function") return config.tickFormat;
  // String format specifiers could be supported via d3-format in the future
  return fallback;
}

/**
 * Default format for y-axis tick values: integers as they are, other numbers
 * to one decimal place, and thousands and millions abbreviated.
 */
function defaultFormatYTick(value: unknown): string {
  if (typeof value !== "number") return String(value);
  if (Math.abs(value) >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

/**
 * Default format for x-axis tick values: dates as month and day, anything
 * else as on the y-axis.
 */
function defaultFormatXTick(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getMonth() + 1}/${value.getDate()}`;
  }
  return defaultFormatYTick(value);
}

/**
 * Get tick values from a scale.
 */
function getXTicks(
  scale: XScale,
  tickCount?: number,
): unknown[] {
  const maxTicks = tickCount ?? MAX_TICKS;
  if ("bandwidth" in scale) {
    const domain = scale.domain();
    if (domain.length <= maxTicks) return domain;
    const step = Math.ceil(domain.length / maxTicks);
    return domain.filter((_, i) => i % step === 0);
  }
  return scale.ticks(Math.min(maxTicks, 6));
}

/**
 * Render x-axis at the bottom of the chart.
 */
export function renderXAxis(
  xScale: XScale,
  _xType: XScaleType,
  plotWidth: number,
  plotHeight: number,
  config: AxisConfig = {},
): TemplateResult {
  const format = resolveTickFormat(config, defaultFormatXTick);
  const ticks = getXTicks(xScale, config.tickCount);

  const tickGroups = ticks.map((t) => {
    const x = xPosition(xScale, t);
    const label = format(t);
    return svg`<g transform="translate(${x}, 0)"><line y1="0" y2="5" /><text y="16" text-anchor="middle">${label}</text></g>`;
  });

  const gridLines = config.grid
    ? ticks.map((t) => {
      const x = xPosition(xScale, t);
      return svg`<line class="grid-line" x1="${x}" y1="${-plotHeight}" x2="${x}" y2="0" />`;
    })
    : [];

  const axisLabel = config.label
    ? svg`<text class="axis-label" x="${plotWidth / 2}" y="28" text-anchor="middle">${config.label}</text>`
    : svg``;

  return svg`<g class="axis x-axis" transform="translate(0, ${plotHeight})"><line x1="0" y1="0" x2="${plotWidth}" y2="0" />${gridLines}${tickGroups}${axisLabel}</g>`;
}

/**
 * Render y-axis at the left of the chart.
 */
export function renderYAxis(
  yScale: YScale,
  plotWidth: number,
  plotHeight: number,
  config: AxisConfig = {},
): TemplateResult {
  const format = resolveTickFormat(config, defaultFormatYTick);
  const maxTicks = config.tickCount ?? 5;
  const ticks = yScale.ticks(Math.min(MAX_TICKS, maxTicks));

  const tickGroups = ticks.map((t) => {
    const y = yScale(t);
    const label = format(t);
    return svg`<g transform="translate(0, ${y})"><line x1="-5" x2="0" /><text x="-8" dy="0.35em" text-anchor="end">${label}</text></g>`;
  });

  const gridLines = config.grid
    ? ticks.map((t) => {
      const y = yScale(t);
      return svg`<line class="grid-line" x1="0" y1="${y}" x2="${plotWidth}" y2="${y}" />`;
    })
    : [];

  const axisLabel = config.label
    ? svg`<text class="axis-label" x="${-plotHeight / 2}" y="-36" text-anchor="middle" transform="rotate(-90)">${config.label}</text>`
    : svg``;

  return svg`<g class="axis y-axis"><line x1="0" y1="0" x2="0" y2="${plotHeight}" />${gridLines}${tickGroups}${axisLabel}</g>`;
}
