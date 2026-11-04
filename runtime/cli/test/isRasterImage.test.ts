import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isRasterImage } from "../lib/profile.ts";

/** `parts` as bytes: numbers are bytes, strings their characters' codes. */
function bytesOf(...parts: (number | string)[]): Uint8Array {
  return new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "number"
        ? [part]
        : [...part].map((char) => char.charCodeAt(0))
    ),
  );
}

/** `value` as four little-endian bytes. */
const le32 = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  value >>> 24,
];

/** `value` as four big-endian bytes. */
const be32 = (value: number) => le32(value).reverse();

/** A BMP's first 18 bytes, with `dibSize` as its DIB header's size. */
const bmp = (dibSize: number) =>
  bytesOf("BM", ...le32(70), 0, 0, 0, 0, ...le32(54), ...le32(dibSize));

/** An `ftyp` box of `size` bytes naming `major` and then `compatible`. */
const ftyp = (size: number, major: string, ...compatible: string[]) =>
  bytesOf(...be32(size), "ftyp", major, 0, 0, 0, 0, ...compatible);

describe("isRasterImage()", () => {
  it("returns `true` for each format's signature", () => {
    const images = [
      bytesOf(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13),
      bytesOf(0xff, 0xd8, 0xff, 0xe0),
      bytesOf("GIF87a", 1, 0),
      bytesOf("GIF89a", 1, 0),
      bytesOf("RIFF", ...le32(30), "WEBPVP8 "),
      bmp(12),
      bmp(40),
      bmp(52),
      bmp(56),
      bmp(64),
      bmp(108),
      bmp(124),
      ftyp(16, "avif"),
      ftyp(16, "avis"),
      ftyp(24, "mif1", "miaf", "avif"),
    ];

    expect(images.map(isRasterImage)).toEqual(images.map(() => true));
  });

  it("returns `false` for a prefix of a signature, or a near miss", () => {
    const others = [
      bytesOf(),
      bytesOf(0x89, "PNG<svg>"),
      bytesOf(0xff, 0xd8),
      bytesOf("GIF8<svg>"),
      bytesOf("GIF88a"),
      bytesOf("RIFF", ...le32(30), "WAVEfmt "),
      bmp(41),
      bytesOf("BM"),
      ftyp(24, "mp42", "isom", "mp41"),
      // The brand lies past the box's end.
      bytesOf(...ftyp(16, "mif1"), "avif"),
      ftyp(8, "avif"),
    ];

    expect(others.map(isRasterImage)).toEqual(others.map(() => false));
  });

  it("returns `false` for SVG, and for SVG behind a format's first bytes", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

    expect(isRasterImage(bytesOf(svg))).toBe(false);
    expect(isRasterImage(bytesOf("BM", svg))).toBe(false);
    expect(isRasterImage(bytesOf("GIF8", svg))).toBe(false);
    expect(isRasterImage(bytesOf(0x89, "PNG", svg))).toBe(false);
  });
});
