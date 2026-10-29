/**
 * Chooses the dashboard's status colors, and works out every shade derived from
 * them. Everything that paints a status in color reads from here: the tile,
 * the header dot, the headline, a sparkline's fade, a run cell, the drill-down
 * rows, and the favicon. The shape a header dot takes is CSS geometry rather
 * than a color, and lives with the rest of the tile's CSS in render.ts.
 *
 * Green sits at teal and amber at orange rather than at a yellow. The two then
 * differ along the blue-to-yellow axis, which red-green color blindness leaves
 * working, so good and warn stay apart for a viewer who cannot separate them by
 * the red-to-green axis alone. Color is one of four cues the dashboard carries:
 * the header dot also takes a per-status shape, the tile's wash and border get
 * stronger as the status gets more serious, and warn and bad carry a texture.
 */

import type { Status } from "./types.ts";

export const STATUS_COLOR: Record<Status, string> = {
  good: "#2fc79e",
  warn: "#e8913a",
  bad: "#e2504a",
  unknown: "#7c828c",
};

// The headline number, lifted off the status color so it reads as text on the
// dark tile.
export const STATUS_TEXT: Record<Status, string> = {
  good: "#4ed3ae",
  warn: "#f5a34d",
  bad: "#f0726c",
  unknown: "#9aa0ab",
};

// Headline shades for text on a light tile. They retain the status hues while
// carrying enough weight to read against white.
export const LIGHT_STATUS_TEXT: Record<Status, string> = {
  good: "#0f765d",
  warn: "#985000",
  bad: "#a51f45",
  unknown: "#59616e",
};

// How much of its color a tile's background carries, and how much its border
// does. The three rise together with the seriousness of the status, so the
// tiles separate by weight as well as by hue. An unknown tile takes no color
// at all and keeps the neutral border every tile starts from.
export const STATUS_WASH: Record<Status, number> = {
  good: 0.06,
  warn: 0.12,
  bad: 0.15,
  unknown: 0,
};

export const STATUS_EDGE: Record<Status, number> = {
  good: 0.28,
  warn: 0.5,
  bad: 0.58,
  unknown: 0,
};

// The stroke a status texture is drawn in. The line is broad and faint rather
// than fine and dark, which puts enough of it on the tile to be seen at a
// glance without any one line drawing the eye. At this width the zig-zag covers
// a little under half of its tile, and the wave, which runs flatter and so
// leaves more room between its lines, about a third. It is also the bound on
// the stroke: a mitered corner keeps its point inside the pattern tile up to
// this width, and the pattern repeats without a clipped corner.
export const TEXTURE_ALPHA = 0.13;
export const TEXTURE_WIDTH = 8;

// A run that is still going, which is a state rather than a verdict: the same
// blue wherever it appears.
export const RUNNING_COLOR = "#6ea8fe";

/** A `#rrggbb` color as a CSS `rgba()` at the given alpha. */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
