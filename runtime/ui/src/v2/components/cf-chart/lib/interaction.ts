/**
 * Interaction handling for cf-chart: hover, click, crosshair, tooltip.
 */

import { svg, type TemplateResult } from "lit";
import {
  type CollectedMarkData,
  xPosition,
  type XScale,
  type YScale,
} from "./scales.ts";
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
): NearestResult | null {
  let best: NearestResult | null = null;
  let bestDist = Infinity;

  for (const mark of allMarks) {
    for (const p of mark.points) {
      const px = xPosition(xScale, p.x);

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
          pixelY: yScale(p.y),
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
  _xType: XScaleType,
): { detail: ChartHoverDetail; nearest: NearestResult | null } {
  // A band scale has no inverse, so its data x is the pixel x.
  const dataX = "invert" in xScale ? xScale.invert(plotX) : plotX;
  const dataY = yScale.invert(plotY);
  const nearest = findNearest(plotX, allMarks, xScale, yScale);

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
