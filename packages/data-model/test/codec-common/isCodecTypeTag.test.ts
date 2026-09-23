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

  it("returns `false` for every tag in `CODEC_META_TAGS`", () => {
    // A meta-tag is a structural marker its format handles itself, and is
    // outside this syntax by design.

    for (const tag of Object.values(CODEC_META_TAGS)) {
      expect(isCodecTypeTag(tag)).toBe(false);
    }
  });

  it("returns `true` for a tag naming a type nothing here defines", () => {
    // Syntax, not recognition: this is what an `UnknownValue` is made of.

    expect(isCodecTypeTag("FutureType@2")).toBe(true);
    expect(isCodecTypeTag("X@1")).toBe(true);
    expect(isCodecTypeTag("Abc123@1234")).toBe(true);
  });

  it("returns `false` for a string with no version", () => {
    expect(isCodecTypeTag("")).toBe(false);
    expect(isCodecTypeTag("Bytes")).toBe(false);
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
    expect(isCodecTypeTag("By tes@1")).toBe(false);
    expect(isCodecTypeTag("By-tes@1")).toBe(false);
    expect(isCodecTypeTag("/Bytes@1")).toBe(false);
  });

  it("returns `false` for a name that does not start uppercase", () => {
    // `UpperCamelCase` is the convention Section 2 of `3-json-encoding.md`
    // states, and this is what holds every format to it. The case decides
    // whether an unclaimed tag round-trips as an `UnknownValue` or is refused
    // as a malformation, so a reader cannot be left to infer it.

    expect(isCodecTypeTag("bytes@1")).toBe(false);
    expect(isCodecTypeTag("lowerCamel@1")).toBe(false);
    expect(isCodecTypeTag("link@1")).toBe(false);
  });

  it("returns `false` for a name holding a non-ASCII letter", () => {
    // The alphabet is ASCII, which Section 2 of `3-json-encoding.md` states
    // and a Unicode-property spelling of the same syntax would not honor. A
    // tag crosses between systems, so the set of names it can carry cannot
    // depend on which alphabet a decoder reads it with.

    expect(isCodecTypeTag("\u00c9clair@1")).toBe(false);
    expect(isCodecTypeTag("Caf\u00e9@1")).toBe(false);
    expect(isCodecTypeTag("\u0411ytes@1")).toBe(false);
  });

  it("returns `false` for a tag padded with whitespace or a newline", () => {
    // The syntax is anchored at both ends and is not multiline, so padding a
    // tag does not make the string one. The newline pair is the only case in
    // this file that catches a stray `m` flag; an unanchored match would let
    // all four through.

    expect(isCodecTypeTag(" Bytes@1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1 ")).toBe(false);
    expect(isCodecTypeTag("\nBytes@1")).toBe(false);
    expect(isCodecTypeTag("Bytes@1\n")).toBe(false);
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
