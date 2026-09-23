import type { Status } from "./types.ts";
import { CHART_HIGHLIGHT } from "./theme.ts";

// good/warn/bad/unknown -> the dot color class the renderer uses.
export const STATUS_DOT: Record<Status, string> = {
  good: "green",
  warn: "amber",
  bad: "red",
  unknown: "gray",
};

// good/warn/bad/unknown, worst last: the order a tile combines them in.
export const STATUS_RANK: Record<Status, number> = {
  good: 0,
  unknown: 1,
  warn: 2,
  bad: 3,
};

/** The worst of several statuses, or `good` when there are none. */
export function worstStatus(statuses: readonly Status[]): Status {
  return statuses.reduce<Status>(
    (worst, status) =>
      STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst,
    "good",
  );
}

export const escapeHtml = (s: string) =>
  s.replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!,
  );

/** An integer with its thousands separated, the same in every locale. */
export function groupDigits(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+$)/g, ",");
}

// How a sparkline caption spells a day span, consistently across tiles.
export function daysLabel(days: number): string {
  if (days < 1) return "<1 day";
  return `${days} day${days === 1 ? "" : "s"}`;
}

// A time span for sparkline captions: days, then hours, then minutes.
export function humanSpan(ms: number): string {
  if (ms >= 86_400_000) return daysLabel(Math.round(ms / 86_400_000));
  if (ms >= 3_600_000) {
    const hr = Math.round(ms / 3_600_000);
    return `${hr} hour${hr === 1 ? "" : "s"}`;
  }
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/**
 * A span in the least room it can be read in: minutes, then hours, then
 * days. For a caption sharing its line with other text, where the units
 * `humanSpan` spells out would not fit.
 */
export function compactSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * How long something ran, to the precision a reader compares two of them at:
 * seconds under a minute, then minutes and seconds, then hours and minutes.
 */
export function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const DURATION_LABEL_HEIGHT = 9;
// All sparkline variants and their duration labels occupy this rendered height.
export const SPARKLINE_HEIGHT = 28;

// The span sits in the bottom-left corner of its positioned chart container.
export function durationTag(ms: number): string {
  return `<span style="position:absolute;left:1px;bottom:0;font-size:${DURATION_LABEL_HEIGHT}px;line-height:1;color:${CHART_HIGHLIGHT};pointer-events:none">${
    escapeHtml(humanSpan(ms))
  }</span>`;
}
