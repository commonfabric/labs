import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  formatReleaseTime,
  parseReleaseTime,
} from "../src/pattern-release-time.ts";

describe("pattern-release-time", () => {
  describe("parseReleaseTime()", () => {
    it("returns milliseconds since the epoch for a UTC date-time", () => {
      expect(parseReleaseTime("2026-10-16T14:03:00Z")).toBe(
        Date.UTC(2026, 9, 16, 14, 3, 0),
      );
    });

    it("returns the same instant for a numeric offset", () => {
      expect(parseReleaseTime("2026-10-16T07:03:00-07:00")).toBe(
        Date.UTC(2026, 9, 16, 14, 3, 0),
      );
    });

    it("returns the fraction of a second it is given", () => {
      expect(parseReleaseTime("2026-10-16T14:03:00.250Z")).toBe(
        Date.UTC(2026, 9, 16, 14, 3, 0, 250),
      );
    });

    it("returns `undefined` for text that leaves the instant to the reader", () => {
      for (
        const text of [
          "2026-10-16",
          "2026-10-16T14:03:00",
          "2026-10-16T14:03Z",
          "2026-10-16 14:03:00Z",
          "2026-10-16t14:03:00z",
          "Fri, 16 Oct 2026 14:03:00 GMT",
          "1792159380000",
          "",
        ]
      ) {
        expect([text, parseReleaseTime(text)]).toEqual([text, undefined]);
      }
    });

    it("returns `undefined` for a field outside its calendar range", () => {
      for (
        const text of [
          "2026-02-29T14:03:00Z",
          "2026-04-31T14:03:00Z",
          "2026-13-01T14:03:00Z",
          "2026-10-16T24:00:00Z",
          "2026-10-16T14:60:00Z",
          "2026-10-16T14:03:60Z",
          "2026-10-16T14:03:00+24:00",
        ]
      ) {
        expect([text, parseReleaseTime(text)]).toEqual([text, undefined]);
      }
    });

    it("returns the time for February 29 of a leap year", () => {
      expect(parseReleaseTime("2028-02-29T00:00:00Z")).toBe(
        Date.UTC(2028, 1, 29),
      );
    });

    it("returns `undefined` for an instant before the epoch", () => {
      expect(parseReleaseTime("1969-12-31T23:59:59Z")).toBeUndefined();
      expect(parseReleaseTime("0099-10-16T14:03:00Z")).toBeUndefined();
      expect(parseReleaseTime("1970-01-01T00:00:00Z")).toBe(0);
    });
  });

  describe("formatReleaseTime()", () => {
    it("returns text `parseReleaseTime()` reads back as the same time", () => {
      const time = Date.UTC(2026, 9, 16, 14, 3, 0, 250);
      expect(formatReleaseTime(time)).toBe("2026-10-16T14:03:00.250Z");
      expect(parseReleaseTime(formatReleaseTime(time))).toBe(time);
    });
  });
});
