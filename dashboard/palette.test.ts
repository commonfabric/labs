/**
 * The palette's job is to keep four statuses apart, including for a viewer who
 * cannot separate red from green. That is a measurable property rather than a
 * matter of taste, so it is measured here: each color is put through a
 * simulation of dichromatic vision and the pairs are compared in a space where
 * distance matches what a person sees.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Status } from "./types.ts";
import {
  LIGHT_STATUS_TEXT,
  rgba,
  STATUS_COLOR,
  STATUS_EDGE,
  STATUS_TEXT,
  STATUS_WASH,
} from "./palette.ts";

type Triple = [number, number, number];

function channels(hex: string): Triple {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    c / 255
  ) as Triple;
}

// sRGB stores a color with a curve applied, so light has to be taken back out
// of that curve before any of it can be added up or mixed.
const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

function contrastRatio(first: string, second: string): number {
  const luminance = (color: string) => {
    const [red, green, blue] = channels(color).map(toLinear);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function apply(m: readonly Triple[], rgb: Triple): Triple {
  const linear = rgb.map(toLinear) as Triple;
  return m.map((row) =>
    row.reduce((sum, weight, i) => sum + weight * linear[i], 0)
  ) as Triple;
}

// Viénot, Brettel and Mollon (1999): what a dichromat sees, as a matrix over
// linear light. Missing the long-wavelength cone is protanopia and missing the
// medium-wavelength one is deuteranopia; between them they cover almost every
// case of red/green color blindness.
const DEUTERANOPIA: readonly Triple[] = [
  [0.29275, 0.70725, 0],
  [0.29275, 0.70725, 0],
  [-0.02234, 0.02234, 1],
];
const PROTANOPIA: readonly Triple[] = [
  [0.11238, 0.88762, 0],
  [0.11238, 0.88762, 0],
  [0.00401, -0.00401, 1],
];
const TRICHROMAT: readonly Triple[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const VISION = {
  "normal color vision": TRICHROMAT,
  deuteranopia: DEUTERANOPIA,
  protanopia: PROTANOPIA,
} as const;

const TO_XYZ: readonly Triple[] = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];
const D65: Triple = [0.95047, 1, 1.08883];

/** CIE Lab, the space distances are measured in below. */
function lab(linear: Triple): Triple {
  const xyz = TO_XYZ.map((row) =>
    row.reduce((sum, weight, i) => sum + weight * linear[i], 0)
  ).map((v, i) => v / D65[i]);
  const f = xyz.map((v) =>
    v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116
  );
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

const rad = (deg: number) => deg * Math.PI / 180;
const deg = (r: number) => r * 180 / Math.PI;

/**
 * CIEDE2000: how different two colors look, on a scale where about 1 is the
 * smallest difference a person can find with the two side by side, and where
 * two colors a glance can tell apart from across a room are far above that.
 */
function difference(first: Triple, second: Triple): number {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  const c1 = Math.hypot(a1, b1), c2 = Math.hypot(a2, b2);
  const cMean = (c1 + c2) / 2;
  const g = 0.5 *
    (1 - Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7))); // 25 ** 7 keeps grays out of it
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
  const hp1 = (deg(Math.atan2(b1, ap1)) + 360) % 360;
  const hp2 = (deg(Math.atan2(b2, ap2)) + 360) % 360;
  const dL = l2 - l1, dC = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) {
    dh = hp2 - hp1;
    if (Math.abs(dh) > 180) dh -= 360 * Math.sign(dh);
  }
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(rad(dh) / 2);
  const lMean = (l1 + l2) / 2, cpMean = (cp1 + cp2) / 2;
  let hMean = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hMean = (hp1 + hp2) / 2;
    else hMean = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  }
  const t = 1 - 0.17 * Math.cos(rad(hMean - 30)) +
    0.24 * Math.cos(rad(2 * hMean)) + 0.32 * Math.cos(rad(3 * hMean + 6)) -
    0.20 * Math.cos(rad(4 * hMean - 63));
  const sL = 1 +
    (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sC = 1 + 0.045 * cpMean;
  const sH = 1 + 0.015 * cpMean * t;
  const rT = -2 * Math.sqrt(cpMean ** 7 / (cpMean ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((hMean - 275) / 25) ** 2))));
  return Math.sqrt(
    (dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 +
      rT * (dC / sC) * (dH / sH),
  );
}

/**
 * How far apart two of the dashboard's colors look to the named kind of viewer.
 */
function apart(
  first: string,
  second: string,
  vision: readonly Triple[],
): number {
  return difference(
    apply(vision, channels(first)),
    apply(vision, channels(second)),
  );
}

// Below about this, two colors read as the same one at a glance. Every pair of
// statuses has to clear it under every kind of vision, so a later change to a
// color cannot quietly collapse a distinction the dashboard depends on.
const LEGIBLE = 10;

const STATUSES: readonly Status[] = ["good", "warn", "bad", "unknown"];
const PAIRS = STATUSES.flatMap((first, i) =>
  STATUSES.slice(i + 1).map((second) => [first, second] as const)
);

describe("palette", () => {
  describe("STATUS_COLOR", () => {
    for (const [name, vision] of Object.entries(VISION)) {
      for (const [first, second] of PAIRS) {
        it(`tells ${first} from ${second} under ${name}`, () => {
          expect(
            apart(STATUS_COLOR[first], STATUS_COLOR[second], vision),
          ).toBeGreaterThan(LEGIBLE);
        });
      }
    }
  });

  describe("STATUS_TEXT", () => {
    // The headline is the largest thing a status colors, so its four shades
    // answer to the same rule the dots do.
    for (const [name, vision] of Object.entries(VISION)) {
      for (const [first, second] of PAIRS) {
        it(`tells ${first} from ${second} under ${name}`, () => {
          expect(apart(STATUS_TEXT[first], STATUS_TEXT[second], vision))
            .toBeGreaterThan(LEGIBLE);
        });
      }
    }

    it("is lighter than the color it lifts, for text on a dark tile", () => {
      for (const status of STATUSES) {
        const [text] = lab(apply(TRICHROMAT, channels(STATUS_TEXT[status])));
        const [base] = lab(apply(TRICHROMAT, channels(STATUS_COLOR[status])));
        expect(text).toBeGreaterThan(base);
      }
    });
  });

  describe("LIGHT_STATUS_TEXT", () => {
    for (const [name, vision] of Object.entries(VISION)) {
      for (const [first, second] of PAIRS) {
        it(`tells ${first} from ${second} under ${name}`, () => {
          expect(
            apart(LIGHT_STATUS_TEXT[first], LIGHT_STATUS_TEXT[second], vision),
          )
            .toBeGreaterThan(LEGIBLE);
        });
      }
    }

    it("is darker than the status color it carries on a light tile", () => {
      for (const status of STATUSES) {
        const [text] = lab(
          apply(TRICHROMAT, channels(LIGHT_STATUS_TEXT[status])),
        );
        const [base] = lab(apply(TRICHROMAT, channels(STATUS_COLOR[status])));
        expect(text).toBeLessThan(base);
      }
    });

    it("keeps small text and status indicators legible on a light tile", () => {
      for (const status of STATUSES) {
        expect(contrastRatio(LIGHT_STATUS_TEXT[status], "#ffffff"))
          .toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  describe("STATUS_WASH and STATUS_EDGE", () => {
    it("gets stronger as the status gets more serious", () => {
      expect(STATUS_WASH.good).toBeLessThan(STATUS_WASH.warn);
      expect(STATUS_WASH.warn).toBeLessThan(STATUS_WASH.bad);
      expect(STATUS_EDGE.good).toBeLessThan(STATUS_EDGE.warn);
      expect(STATUS_EDGE.warn).toBeLessThan(STATUS_EDGE.bad);
    });

    it("leaves an unknown tile with no color of its own", () => {
      expect(STATUS_WASH.unknown).toBe(0);
      expect(STATUS_EDGE.unknown).toBe(0);
    });
  });

  describe("rgba()", () => {
    it("writes a hex color as CSS with the alpha applied", () => {
      expect(rgba("#2fc79e", 0.15)).toBe("rgba(47,199,158,0.15)");
      expect(rgba("#000000", 1)).toBe("rgba(0,0,0,1)");
    });
  });
});
