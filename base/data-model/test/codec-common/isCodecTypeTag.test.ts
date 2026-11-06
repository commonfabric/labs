import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC_META_TAGS,
  CODEC_TYPE_TAGS,
  isCodecTypeTag,
} from "@/codec-common";

describe("isCodecTypeTag", () => {
  it("returns `true` for every tag in `CODEC_TYPE_TAGS`", () => {
    // The constants are the definition of the syntax, so a predicate that
    // rejected one of them would be wrong whatever it said about anything
    // else.

    for (const tag of Object.values(CODEC_TYPE_TAGS)) {
      expect(isCodecTypeTag(tag)).toBe(true);
    }
  });

  it("returns `true` for every tag in `CODEC_META_TAGS`", () => {
    // The JSON format reserves these names in tag position for forms of its
    // own, which is that format's business: syntactically each is a tag.

    for (const tag of Object.values(CODEC_META_TAGS)) {
      expect(isCodecTypeTag(tag)).toBe(true);
    }
  });

  it("returns `true` for a tag naming a type nothing here defines", () => {
    // Syntax, not recognition: this is what an `UnknownValue` is made of.

    expect(isCodecTypeTag("FutureType@2")).toBe(true);
    expect(isCodecTypeTag("X@1")).toBe(true);
    expect(isCodecTypeTag("Abc123@1234")).toBe(true);
  });

  it("returns `true` for a tag with namespace prefixes", () => {
    expect(isCodecTypeTag("core.Boop@1")).toBe(true);
    expect(isCodecTypeTag("sys.beep.Boop@1")).toBe(true);
    expect(isCodecTypeTag("aB3.x9.Abc123@1234")).toBe(true);
  });

  it("returns `true` for prefixes and names in any case", () => {
    // An initial capital on a type's name is a convention, and not syntax.

    expect(isCodecTypeTag("bytes@1")).toBe(true);
    expect(isCodecTypeTag("Sys.Boop@1")).toBe(true);
    expect(isCodecTypeTag("sys.boop@1")).toBe(true);
    expect(isCodecTypeTag("sys.Beep.Boop@1")).toBe(true);
    expect(isCodecTypeTag("SYS.BOOP@1")).toBe(true);
  });

  it("returns `true` for a tag with no prefix and no version", () => {
    // The hash algorithm names and the JSON format's special forms are among
    // the tags of this shape.

    expect(isCodecTypeTag("Bytes")).toBe(true);
    expect(isCodecTypeTag("widget")).toBe(true);
    expect(isCodecTypeTag("fid1")).toBe(true);
    expect(isCodecTypeTag("sha256")).toBe(true);
    expect(isCodecTypeTag("X")).toBe(true);
  });

  it("returns `false` for a tag with a prefix and no version", () => {
    // The version is optional on a tag with no prefix only.

    expect(isCodecTypeTag("sys.Boop")).toBe(false);
    expect(isCodecTypeTag("core.Globals")).toBe(false);
    expect(isCodecTypeTag("a.b.c")).toBe(false);
  });

  it("returns `false` for a malformed namespace prefix", () => {
    expect(isCodecTypeTag("sys..Boop@1")).toBe(false);
    expect(isCodecTypeTag(".Boop@1")).toBe(false);
    expect(isCodecTypeTag("sys.Boop.@1")).toBe(false);
    expect(isCodecTypeTag("sys_x.Boop@1")).toBe(false);
    expect(isCodecTypeTag("sys-x.Boop@1")).toBe(false);
    expect(isCodecTypeTag("1sys.Boop@1")).toBe(false);
    expect(isCodecTypeTag("süs.Boop@1")).toBe(false);
  });

  it("returns `false` for a prefixed tag whose version is malformed", () => {
    expect(isCodecTypeTag("sys.Boop@01")).toBe(false);
    expect(isCodecTypeTag("sys.Boop@0")).toBe(false);
    expect(isCodecTypeTag("sys.Boop@")).toBe(false);
  });

  it("returns `false` for the empty string, and for an `@` with nothing after it", () => {
    expect(isCodecTypeTag("")).toBe(false);
    expect(isCodecTypeTag("Bytes@")).toBe(false);
  });

  it("returns `false` for a malformed version", () => {
    expect(isCodecTypeTag("Bytes@0")).toBe(false);
    expect(isCodecTypeTag("Bytes@01")).toBe(false);
    expect(isCodecTypeTag("Bytes@-1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1.0")).toBe(false);
    expect(isCodecTypeTag("Bytes@1@2")).toBe(false);
  });

  it("returns `false` for a malformed name", () => {
    expect(isCodecTypeTag("@1")).toBe(false);
    expect(isCodecTypeTag("1Bytes@1")).toBe(false);
    expect(isCodecTypeTag("1sha")).toBe(false);
    expect(isCodecTypeTag("By tes@1")).toBe(false);
    expect(isCodecTypeTag("By-tes@1")).toBe(false);
    expect(isCodecTypeTag("fid-1")).toBe(false);
    expect(isCodecTypeTag("/Bytes@1")).toBe(false);
  });

  it("returns `false` for a name holding a non-ASCII letter", () => {
    // The alphabet is ASCII, which Section 2.5 of `1-fabric-values.md` states
    // and a Unicode-property spelling of the same syntax would not honor. A
    // tag crosses between systems, so the set of names it can carry cannot
    // depend on which alphabet a decoder reads it with.

    expect(isCodecTypeTag("Éclair@1")).toBe(false);
    expect(isCodecTypeTag("Café@1")).toBe(false);
    expect(isCodecTypeTag("Бytes@1")).toBe(false);
    expect(isCodecTypeTag("café")).toBe(false);
  });

  it("returns `false` for a tag padded with whitespace or a newline", () => {
    // The syntax is anchored at both ends and is not multiline, so padding a
    // tag does not make the string one. The newline pairs are the only cases
    // in this file that catch a stray `m` flag; an unanchored match would let
    // all of them through.

    expect(isCodecTypeTag(" Bytes@1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1 ")).toBe(false);
    expect(isCodecTypeTag("\nBytes@1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1\n")).toBe(false);
    expect(isCodecTypeTag("\nfid1")).toBe(false);
    expect(isCodecTypeTag("fid1\n")).toBe(false);
  });

  it("returns `false` for a value that is not a string", () => {
    expect(isCodecTypeTag(undefined)).toBe(false);
    expect(isCodecTypeTag(null)).toBe(false);
    expect(isCodecTypeTag(42)).toBe(false);
    expect(isCodecTypeTag(Symbol("Bytes@1"))).toBe(false);
    expect(isCodecTypeTag(["Bytes@1"])).toBe(false);
    expect(isCodecTypeTag(new String("Bytes@1"))).toBe(false);
  });
});
