import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC_META_TAGS,
  CODEC_TYPE_TAGS,
  isInterchangeTag,
} from "@/codec-common";

describe("isInterchangeTag", () => {
  it("returns `true` for every tag in `CODEC_TYPE_TAGS`", () => {
    // Every type tag is an interchange tag.

    for (const tag of Object.values(CODEC_TYPE_TAGS)) {
      expect(isInterchangeTag(tag)).toBe(true);
    }
  });

  it("returns `true` for every tag in `CODEC_META_TAGS`", () => {
    for (const tag of Object.values(CODEC_META_TAGS)) {
      expect(isInterchangeTag(tag)).toBe(true);
    }
  });

  it("returns `true` for a tag with prefixes and a version, in any case", () => {
    expect(isInterchangeTag("sys.beep.Boop@1")).toBe(true);
    expect(isInterchangeTag("Sys.Boop@1")).toBe(true);
    expect(isInterchangeTag("bytes@1")).toBe(true);
    expect(isInterchangeTag("sys.sha@2")).toBe(true);
  });

  it("returns `true` for a tag with no prefix and no version", () => {
    // The hash algorithm names are tags of this shape.

    expect(isInterchangeTag("fid1")).toBe(true);
    expect(isInterchangeTag("sha256")).toBe(true);
    expect(isInterchangeTag("SHA256")).toBe(true);
    expect(isInterchangeTag("Bytes")).toBe(true);
    expect(isInterchangeTag("X")).toBe(true);
  });

  it("returns `false` for a tag with a prefix and no version", () => {
    // The version is optional on a tag with no prefix only.

    expect(isInterchangeTag("sys.Boop")).toBe(false);
    expect(isInterchangeTag("core.Globals")).toBe(false);
    expect(isInterchangeTag("sys.sha256")).toBe(false);
  });

  it("returns `false` for a malformed prefix, name, or version", () => {
    expect(isInterchangeTag("")).toBe(false);
    expect(isInterchangeTag("fid-1")).toBe(false);
    expect(isInterchangeTag("1sha")).toBe(false);
    expect(isInterchangeTag("sys..Boop@1")).toBe(false);
    expect(isInterchangeTag(".Boop@1")).toBe(false);
    expect(isInterchangeTag("Bytes@")).toBe(false);
    expect(isInterchangeTag("Bytes@0")).toBe(false);
    expect(isInterchangeTag("Bytes@01")).toBe(false);
    expect(isInterchangeTag("caf\u00e9")).toBe(false);
  });

  it("returns `false` for a tag padded with whitespace or a newline", () => {
    // The syntax is anchored at both ends and is not multiline.

    expect(isInterchangeTag(" fid1")).toBe(false);
    expect(isInterchangeTag("fid1 ")).toBe(false);
    expect(isInterchangeTag("\nfid1")).toBe(false);
    expect(isInterchangeTag("fid1\n")).toBe(false);
  });

  it("returns `false` for a value that is not a string", () => {
    expect(isInterchangeTag(undefined)).toBe(false);
    expect(isInterchangeTag(null)).toBe(false);
    expect(isInterchangeTag(42)).toBe(false);
    expect(isInterchangeTag(new String("fid1"))).toBe(false);
  });
});
