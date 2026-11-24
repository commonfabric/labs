/**
 * The tokenizer boundaries behind `#hashtag` extraction, which is program
 * output rather than a convenience: `schema-generator`'s doc-comment handling
 * and the runner's wish builtin both read what this function returns, so a
 * hashtag written as an aside in a doc comment becomes data downstream.
 *
 * Each case fixes a decision the name does not carry -- a token takes in an
 * underscore but ends at a hyphen, letters outside Latin and their diacritics
 * count, and results come back lowercased and deduplicated in
 * first-appearance order.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { extractHashtags } from "../src/hashtags.ts";

describe("extractHashtags()", () => {
  it("extracts tags lowercased without the leading #", () => {
    expect(extractHashtags("A #Note about #capture")).toEqual([
      "note",
      "capture",
    ]);
  });

  it("deduplicates while preserving first-appearance order", () => {
    expect(extractHashtags("#b then #a then #B again")).toEqual(["b", "a"]);
  });

  it("includes underscores in a token", () => {
    expect(extractHashtags("#todo_list")).toEqual(["todo_list"]);
  });

  it("ends a token at a hyphen", () => {
    expect(extractHashtags("#quick-capture")).toEqual(["quick"]);
  });

  it("accepts letters from non-Latin scripts and diacritics", () => {
    expect(extractHashtags("#café #日本語 #привет #مرحبا")).toEqual([
      "café",
      "日本語",
      "привет",
      "مرحبا",
    ]);
  });

  it("ends a token at whitespace and punctuation", () => {
    expect(extractHashtags("#todo, and #done!")).toEqual(["todo", "done"]);
  });

  it("returns empty for text without hashtags", () => {
    expect(extractHashtags("no tags here")).toEqual([]);
  });
});
