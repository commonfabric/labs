import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  linkPathSegmentToCellPathSegment,
  parseLinkPrimitive,
  parseScopedIdSegment,
  type PrimitiveCellLink,
} from "../src/link-types.ts";

describe("link-types", () => {
  describe("linkPathSegmentToCellPathSegment()", () => {
    it("returns a number for a canonical index token", () => {
      expect(linkPathSegmentToCellPathSegment("0")).toBe(0);
      expect(linkPathSegmentToCellPathSegment("7")).toBe(7);
      expect(linkPathSegmentToCellPathSegment("4294967294")).toBe(4294967294);
    });

    it("returns the token itself for a leading-zero index", () => {
      expect(linkPathSegmentToCellPathSegment("01")).toBe("01");
      expect(linkPathSegmentToCellPathSegment("007")).toBe("007");
    });

    it("returns the token itself for a numeric form that is not an index", () => {
      expect(linkPathSegmentToCellPathSegment("-1")).toBe("-1");
      expect(linkPathSegmentToCellPathSegment("3.14")).toBe("3.14");
      expect(linkPathSegmentToCellPathSegment("1e3")).toBe("1e3");
      expect(linkPathSegmentToCellPathSegment("0x10")).toBe("0x10");
      expect(linkPathSegmentToCellPathSegment(" 1 ")).toBe(" 1 ");
    });

    it("returns the token itself past the largest array index", () => {
      expect(linkPathSegmentToCellPathSegment("4294967295")).toBe("4294967295");
      expect(linkPathSegmentToCellPathSegment("9007199254740993")).toBe(
        "9007199254740993",
      );
    });

    it("returns the token itself for an ordinary property name", () => {
      expect(linkPathSegmentToCellPathSegment("title")).toBe("title");
      expect(linkPathSegmentToCellPathSegment("")).toBe("");
    });
  });

  describe("parseScopedIdSegment()", () => {
    it("returns the segment unchanged when it carries no suffix", () => {
      expect(parseScopedIdSegment("of:fid1:abc")).toEqual({
        id: "of:fid1:abc",
      });
    });

    it("returns the id and the scope named by the suffix", () => {
      expect(parseScopedIdSegment("of:fid1:abc@session")).toEqual({
        id: "of:fid1:abc",
        scope: "session",
      });
    });

    it("throws when the suffix names something other than a scope", () => {
      expect(() => parseScopedIdSegment("of:fid1:abc@any")).toThrow(
        /Invalid scope suffix/,
      );
    });

    it("throws when no id precedes the suffix", () => {
      expect(() => parseScopedIdSegment("@user")).toThrow(
        /Invalid scope suffix/,
      );
    });
  });

  describe("parseLinkPrimitive()", () => {
    it("throws naming the value, given a value that is not a link", () => {
      const value = { x: 1 } as unknown as PrimitiveCellLink;
      expect(() => parseLinkPrimitive(value)).toThrow(
        "Link is not a primitive: `{x:1}`",
      );
    });
  });
});
