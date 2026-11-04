/**
 * Scale computation for cf-chart.
 *
 * Collects data domains across all marks and creates d3 scales.
 */

// @ts-types="@types/d3-scale"
import {
  type ScaleBand,
  scaleBand,
  type ScaleLinear,
  scaleLinear,
  scaleLog,
  type ScaleLogarithmic,
  type ScaleTime,
  scaleTime,
} from "d3-scale";
// @ts-types="@types/d3-array"
import { extent } from "d3-array";
import type {
  ChartPadding,
  DataPoint,
  MarkConfig,
  XScaleType,
  YScaleType,
} from "../types.ts";
import type { MarkElement } from "../marks/base-mark.ts";

export type XScale =
  | ScaleLinear<number, number>
  | ScaleTime<number, number>
  | ScaleBand<string>;

export type YScale =
  | ScaleLinear<number, number>
  | ScaleLogarithmic<number, number>;

/**
 * Extract data points from a mark config or element.
 * Handles both number[] (auto-indexed) and object[] (keyed) data.
 */
export function extractDataPoints(
  data: readonly (number | Record<string, unknown>)[],
  xKey?: string,
  yKey?: string,
): DataPoint[] {
  if (!data || !Array.isArray(data) || data.length === 0) return [];

  // number[] - auto-indexed
  if (typeof data[0] === "number") {
    return (data as readonly number[]).map((v, i) => ({
      x: i,
      y: v,
      datum: v,
      index: i,
    }));
  }

  // object[] - keyed access
  const records = data as readonly Record<string, unknown>[];
  return records.map((d, i) => {
    const xVal = xKey ? d[xKey] : i;
    const yVal = yKey ? d[yKey] : (d.value ?? d.y ?? 0);
    return {
      x: parseXValue(xVal),
      y: typeof yVal === "number" ? yVal : Number(yVal) || 0,
      datum: d,
      index: i,
    };
  });
}

/** Matches ISO 8601 date strings: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss... */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T\s]|$)/;

/**
 * Parse an x value, detecting dates.
 */
function parseXValue(val: unknown): unknown {
  if (val instanceof Date) return val;
  if (typeof val === "string") {
    // Only parse strings that look like ISO dates to avoid false positives
    if (ISO_DATE_RE.test(val)) {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }
    return val; // string category
  }
  return val;
}

/**
 * Detect the appropriate x scale type from data points.
 */
export function detectXScaleType(
  points: DataPoint[],
  forceType?: XScaleType,
): XScaleType {
  if (forceType) return forceType;
  if (points.length === 0) return "linear";

  const first = points[0].x;
  if (first instanceof Date) return "time";
  if (typeof first === "string") return "band";
  return "linear";
}

export interface CollectedMarkData {
  points: DataPoint[];
  markIndex: number;
  type: string;
  color?: string;
  label?: string;
}

/**
 * Collect all mark data from config marks and child mark elements.
 */
export function collectAllMarkData(
  configMarks: readonly MarkConfig[],
  childMarks: readonly MarkElement[],
): CollectedMarkData[] {
  const result: CollectedMarkData[] = [];
  let idx = 0;

  // Config marks first (rendered below children)
  for (const m of configMarks) {
    const points = extractDataPoints(m.data, m.x, m.y);
    result.push({
      points,
      markIndex: idx++,
      type: m.type,
      color: m.color,
      label: m.label,
    });
  }

  // Child mark elements
  for (const el of childMarks) {
    const data = el.getData();
    const points = extractDataPoints(data, el.x, el.y);
    result.push({
      points,
      markIndex: idx++,
      type: el.markType,
      color: el.color,
      label: el.label,
    });
  }

  return result;
}

/**
 * Compute scales from collected mark data.
 */
export function createScales(
  allMarks: CollectedMarkData[],
  width: number,
  height: number,
  padding: ChartPadding,
  options: {
    xType?: XScaleType;
    yType?: YScaleType;
    xDomain?: [unknown, unknown];
    yDomain?: [number, number];
  } = {},
): { xScale: XScale; yScale: YScale; xType: XScaleType } {
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  // Collect all data points
  const allPoints = allMarks.flatMap((m) => m.points);

  // Detect x scale type
  const xType = detectXScaleType(allPoints, options.xType);

  // Compute x scale
  const xScale = createXScale(xType, allMarks, plotWidth, options.xDomain);

  // Compute y scale
  const yScale = createYScale(
    options.yType || "linear",
    allPoints,
    plotHeight,
    options.yDomain,
  );

  return { xScale, yScale, xType };
}

function createXScale(
  type: XScaleType,
  allMarks: CollectedMarkData[],
  width: number,
  domainOverride?: [unknown, unknown],
): XScale {
  const allPoints = allMarks.flatMap((m) => m.points);

  if (type === "time") {
    const dates = allPoints.map((p) =>
      p.x instanceof Date ? p.x : new Date(p.x as string)
    );
    const [min, max] = domainOverride
      ? [
        new Date(domainOverride[0] as string),
        new Date(domainOverride[1] as string),
      ]
      : extent(dates) as [Date, Date];
    return scaleTime()
      .domain([min || new Date(), max || new Date()])
      .range([0, width]);
  }

  if (type === "band") {
    const categories = [...new Set(allPoints.map((p) => String(p.x)))];
    let domain: string[];
    if (domainOverride) {
      // If override values are in the data, use the range between them
      const startIdx = categories.indexOf(String(domainOverride[0]));
      const endIdx = categories.indexOf(String(domainOverride[1]));
      if (startIdx !== -1 && endIdx !== -1) {
        domain = categories.slice(
          Math.min(startIdx, endIdx),
          Math.max(startIdx, endIdx) + 1,
        );
      } else {
        // Fallback: use override as explicit domain list
        domain = Array.isArray(domainOverride)
          ? domainOverride.map(String)
          : categories;
      }
    } else {
      domain = categories;
    }
    return scaleBand<string>()
      .domain(domain)
      .range([0, width])
      .padding(0.2);
  }

  // linear
  const nums = allPoints.map((p) => Number(p.x));
  const [min, max] = domainOverride
    ? [Number(domainOverride[0]), Number(domainOverride[1])]
    : (extent(nums) as [number, number]);
  return scaleLinear()
    .domain([min ?? 0, max ?? 1])
    .range([0, width])
    .nice();
}

function createYScale(
  type: YScaleType,
  allPoints: DataPoint[],
  height: number,
  domainOverride?: [number, number],
): YScale {
  const yValues = allPoints.map((p) => p.y);
  const [rawMin, rawMax] = domainOverride ||
    (extent(yValues) as [number, number]);
  const min = rawMin ?? 0;
  const max = rawMax ?? 1;

  // Add 5% padding to y domain
  const padding = (max - min) * 0.05 || 1;

  if (type === "log") {
    return scaleLog()
      .domain([Math.max(min, 0.001), max + padding])
      .range([height, 0])
      .nice();
  }

  return scaleLinear()
    .domain([Math.min(min, 0), max + padding])
    .range([height, 0])
    .nice();
}
