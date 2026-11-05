/**
 * CF Chart Component Export and Registration
 */

import { CFAreaMark } from "./marks/cf-area-mark.ts";
import { CFBarMark } from "./marks/cf-bar-mark.ts";
import { CFChart } from "./cf-chart.ts";
import { CFDotMark } from "./marks/cf-dot-mark.ts";
import { CFLineMark } from "./marks/cf-line-mark.ts";

import { MarkElement } from "./marks/base-mark.ts";
import type {
  AxisConfig,
  AxisOption,
  ChartClickDetail,
  ChartHoverDetail,
  ChartPadding,
  CurveType,
  MarkConfig,
  MarkType,
  XScaleType,
  YScaleType,
} from "./types.ts";

if (!customElements.get("cf-area-mark")) {
  customElements.define("cf-area-mark", CFAreaMark);
}

if (!customElements.get("cf-bar-mark")) {
  customElements.define("cf-bar-mark", CFBarMark);
}

if (!customElements.get("cf-chart")) {
  customElements.define("cf-chart", CFChart);
}

if (!customElements.get("cf-dot-mark")) {
  customElements.define("cf-dot-mark", CFDotMark);
}

if (!customElements.get("cf-line-mark")) {
  customElements.define("cf-line-mark", CFLineMark);
}

export type { CFAreaMark as CFAreaMarkElement } from "./marks/cf-area-mark.ts";
export type { CFBarMark as CFBarMarkElement } from "./marks/cf-bar-mark.ts";
export type { CFChart as CFChartElement } from "./cf-chart.ts";
export type { CFDotMark as CFDotMarkElement } from "./marks/cf-dot-mark.ts";
export type { CFLineMark as CFLineMarkElement } from "./marks/cf-line-mark.ts";

export { CFAreaMark, CFBarMark, CFChart, CFDotMark, CFLineMark, MarkElement };

export type {
  AxisConfig,
  AxisOption,
  ChartClickDetail,
  ChartHoverDetail,
  ChartPadding,
  CurveType,
  MarkConfig,
  MarkType,
  XScaleType,
  YScaleType,
};
