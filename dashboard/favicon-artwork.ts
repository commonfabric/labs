/**
 * Draws each favicon face as an SVG. This is the source artwork the served
 * PNGs are rendered from, and the artwork the parity tests check those PNGs
 * against; what the dashboard serves is the generated raster, never this.
 */

import type { FaviconFace } from "./favicon-types.ts";
import { STATUS_COLOR } from "./palette.ts";

const FAVICON_COLORS: Record<FaviconFace, string> = {
  good: STATUS_COLOR.good,
  warn: STATUS_COLOR.warn,
  bad: STATUS_COLOR.bad,
  "bad-crying": STATUS_COLOR.bad,
};

const OCTAGON = `<path d="M10 2h12l8 8v12l-8 8H10l-8-8V10Z"/>`;
const FAVICON_SHAPES: Record<FaviconFace, string> = {
  good: `<rect x="2" y="2" width="28" height="28" rx="9"/>`,
  warn: `<path d="M16 2 30 29H2Z"/>`,
  bad: OCTAGON,
  "bad-crying": OCTAGON,
};

const FAVICON_EYES: Record<FaviconFace, readonly [number, number]> = {
  good: [12, 20],
  warn: [13, 19],
  bad: [12, 20],
  "bad-crying": [12, 20],
};

// Downward shift of the eyes, mouth, and any extra features, in canvas units.
// The warning face drops by ten percent of the 32-unit canvas height, which
// puts its features in the wide part of the triangle rather than near the apex.
const FAVICON_FACE_DROPS: Record<FaviconFace, number> = {
  good: 0,
  warn: 3.2,
  bad: 0,
  "bad-crying": 0,
};

const SMILE = "M11 19c2.8 2.6 7.2 2.6 10 0";
const FAVICON_MOUTHS: Record<FaviconFace, string> = {
  good: SMILE,
  warn: "M11 20h10",
  bad: "M11 21c2.8-2.6 7.2-2.6 10 0",
  "bad-crying": "M10.5 22c3-4 8-4 11 0",
};

const FAVICON_DETAILS: Record<FaviconFace, string> = {
  good: "",
  warn: "",
  bad: "",
  "bad-crying": `
    <path d="M9.5 11.2l3.5 1M22.5 11.2l-3.5 1" fill="none" stroke="#16181d" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M12 16.5c-1 1.3-1.4 2.2-1.4 3a1.4 1.4 0 0 0 2.8 0c0-.8-.4-1.7-1.4-3Z" fill="#9edcff"/>`,
};

export function faviconSvg(status: FaviconFace): string {
  const color = FAVICON_COLORS[status];
  const shape = FAVICON_SHAPES[status];
  const [leftEye, rightEye] = FAVICON_EYES[status];
  const mouth = FAVICON_MOUTHS[status];
  const details = FAVICON_DETAILS[status];
  const drop = FAVICON_FACE_DROPS[status];
  const shift = drop === 0 ? "" : ` transform="translate(0 ${drop})"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <g fill="${color}" stroke="#16181d" stroke-width="2" stroke-linejoin="round">
      ${shape}
    </g>
    <g${shift}>
      <circle cx="${leftEye}" cy="14" r="2" fill="#16181d"/>
      <circle cx="${rightEye}" cy="14" r="2" fill="#16181d"/>
      ${details}
      <path d="${mouth}" fill="none" stroke="#16181d" stroke-width="2.2" stroke-linecap="round"/>
    </g>
  </svg>`;
}
