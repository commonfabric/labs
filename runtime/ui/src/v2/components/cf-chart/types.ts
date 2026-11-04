/**
 * Shared types for cf-chart components
 */

/** Supported scale types for x-axis */
export type XScaleType = "linear" | "time" | "band";

/** Supported scale types for y-axis */
export type YScaleType = "linear" | "log";

/**
 * Axis configuration. Pass `true` for defaults, or an object to customize.
 *
 * All fields are optional — omitted fields use sensible defaults.
 * This type is designed for forward-compatible extensibility:
 * new fields can be added without breaking existing usage.
 */
export interface AxisConfig {
  /** Axis label text */
  label?: string;

  /** Tick format: d3-format string (e.g. "$,.0f") or function */
  tickFormat?: string | ((value: unknown) => string);

  /** Show grid lines across the plot area */
  grid?: boolean;

  /** Number of ticks to display (approximate) */
  tickCount?: number;
}

/** Resolved axis config: normalizes boolean | AxisConfig to a concrete object */
export type AxisOption = boolean | AxisConfig;

/** Curve interpolation types */
export type CurveType = "linear" | "step" | "monotone" | "natural";

/** Mark types */
export type MarkType = "line" | "area" | "bar" | "dot";

/** A single mark configuration (for programmatic $marks prop) */
export interface MarkConfig {
  type: MarkType;
  data: number[] | Record<string, unknown>[];
  x?: string;
  y?: string;
  color?: string;
  label?: string;
  // Line/area specific
  strokeWidth?: number;
  curve?: CurveType;
  // Area specific
  opacity?: number;
  y2?: number;
  // Bar specific
  barPadding?: number;
  // Dot specific
  radius?: number;
}

/** Resolved data point after accessor extraction */
export interface DataPoint {
  x: unknown;
  y: number;
  datum: unknown;
  index: number;
}

/** Computed scale domains */
export interface Domains {
  x: [unknown, unknown] | unknown[];
  y: [number, number];
  xType: XScaleType;
}

/** Chart padding/margins */
export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Event detail for cf-hover */
export interface ChartHoverDetail {
  x: number;
  y: number;
  dataX: unknown;
  dataY: number;
  nearest: {
    datum: unknown;
    index: number;
    label?: string;
  } | null;
}

/** Event detail for cf-click */
export interface ChartClickDetail {
  x: number;
  y: number;
  dataX: unknown;
  dataY: number;
  nearest: {
    datum: unknown;
    index: number;
    label?: string;
  } | null;
}
