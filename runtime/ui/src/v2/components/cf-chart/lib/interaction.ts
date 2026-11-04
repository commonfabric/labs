/**
 * Interaction handling for cf-chart: hover, click, crosshair, tooltip.
 */

import { svg, type TemplateResult } from "lit";
// @ts-types="@types/d3-scale"
import type { ScaleBand } from "d3-scale";
import type { CollectedMarkData, XScale, YScale } from "./scales.ts";
import type { ChartHoverDetail, DataPoint, XScaleType } from "../types.ts";

export interface NearestResult {
  datum: unknown;
  index: number;
  label?: string;
  point: DataPoint;
  markIndex: number;
  pixelX: number;
  pixelY: number;
}

/**
 * Find the nearest data point to pixel coordinates.
 */
export function findNearest(
  pixelX: number,
  allMarks: CollectedMarkData[],
  xScale: XScale,
  yScale: YScale,
  _xType: XScaleType,
): NearestResult | null {
  let best: NearestResult | null = null;
  let bestDist = Infinity;

  for (const mark of allMarks) {
    for (const p of mark.points) {
      let px: number;
      if ("bandwidth" in xScale) {
        const band = xScale as ScaleBand<string>;
        px = (band(String(p.x)) ?? 0) + band.bandwidth() / 2;
      } else {
        px = (xScale as (v: unknown) => number)(
          p.x instanceof Date ? p.x : Number(p.x),
        );
      }

      const dist = Math.abs(px - pixelX);
      if (dist < bestDist) {
        bestDist = dist;
        best = {
          datum: p.datum,
          index: p.index,
          label: mark.label,
          point: p,
          markIndex: mark.markIndex,
          pixelX: px,
          pixelY: yScale(p.y) as number,
        };
      }
    }
  }

  return best;
}

/**
 * Compute event detail from a mouse event.
 */
export function computeEventDetail(
  plotX: number,
  plotY: number,
  allMarks: CollectedMarkData[],
  xScale: XScale,
  yScale: YScale,
  xType: XScaleType,
): { detail: ChartHoverDetail; nearest: NearestResult | null } {
  // Invert pixel to data coordinates
  let dataX: unknown;
  if ("bandwidth" in xScale) {
    dataX = plotX; // Can't invert band scale meaningfully
  } else if ("invert" in xScale) {
    dataX = (xScale as { invert: (v: number) => unknown }).invert(plotX);
  } else {
    dataX = plotX;
  }

  let dataY: number;
  if ("invert" in yScale) {
    dataY = (yScale as { invert: (v: number) => number }).invert(plotY);
  } else {
    dataY = plotY;
  }

  const nearest = findNearest(plotX, allMarks, xScale, yScale, xType);

  return {
    detail: {
      x: plotX,
      y: plotY,
      dataX,
      dataY,
      nearest: nearest
        ? {
          datum: nearest.datum,
          index: nearest.index,
          label: nearest.label,
        }
        : null,
    },
    nearest,
  };
}

/**
 * Render the crosshair line.
 */
export function renderCrosshair(
  x: number,
  plotHeight: number,
): TemplateResult {
  return svg`
    <g class="crosshair">
      <line x1="${x}" y1="0" x2="${x}" y2="${plotHeight}" />
    </g>
  `;
}
