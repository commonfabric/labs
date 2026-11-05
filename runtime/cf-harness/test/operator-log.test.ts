import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { escapeForOperatorLog } from "../src/operator-log.ts";

/** The `\uXXXX` escape of a code point of the Basic Multilingual Plane. */
const escapeOf = (codePoint: number): string =>
  `\\u${codePoint.toString(16).padStart(4, "0")}`;

/** The code points from `first` to `last`, both included. */
const codePointsFrom = (first: number, last: number): number[] =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

/** Every code point the function escapes, by the group it belongs to. */
const ESCAPED: ReadonlyArray<[group: string, codePoints: number[]]> = [
  ["a C0 control character", codePointsFrom(0x00, 0x1f)],
  ["DEL", [0x7f]],
  ["a C1 control character", codePointsFrom(0x80, 0x9f)],
  ["a line or paragraph separator", [0x2028, 0x2029]],
  ["a directional embedding or override", codePointsFrom(0x202a, 0x202e)],
  ["a directional isolate", codePointsFrom(0x2066, 0x2069)],
  ["a directional mark", [0x061c, 0x200e, 0x200f]],
];

describe("escapeForOperatorLog()", () => {
  for (const [group, codePoints] of ESCAPED) {
    it(`returns the escape in place of ${group}`, () => {
      for (const codePoint of codePoints) {
        const character = String.fromCharCode(codePoint);

        expect(escapeForOperatorLog(`a${character}b${character}`)).toBe(
          `a${escapeOf(codePoint)}b${escapeOf(codePoint)}`,
        );
      }
    });
  }

  it("returns text holding none of them as it is", () => {
    // The neighbors of each escaped range, and text of other scripts and
    // planes, a backslash and a quote among it.
    const kept = [
      " ~",
      String.fromCharCode(0x7e, 0xa0, 0x061b, 0x061d, 0x200d, 0x2010),
      String.fromCharCode(0x2027, 0x202f, 0x2065, 0x206a),
      'caf\u00e9 \\u001b "quoted" `ticked`',
      String.fromCodePoint(0x1f600, 0x10ffff),
    ].join("");

    expect(escapeForOperatorLog(kept)).toBe(kept);
    expect(escapeForOperatorLog("")).toBe("");
  });

  it("returns one line for text of several lines", () => {
    const lines = ["first", "second", "third", "fourth", "fifth", "sixth"];
    const breaks = ["\n", "\r\n", "\r", "\u0085", "\u2028", "\u2029", "\v\f"];

    for (const lineBreak of breaks) {
      const escaped = escapeForOperatorLog(lines.join(lineBreak));

      expect(escaped.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)).toEqual([
        escaped,
      ]);
      expect(escaped.startsWith("first\\u")).toBe(true);
      expect(escaped.endsWith("sixth")).toBe(true);
    }
  });
});
