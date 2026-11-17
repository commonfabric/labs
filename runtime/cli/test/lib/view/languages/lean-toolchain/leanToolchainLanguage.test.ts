import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { languageForFile } from "../../../../../lib/view/languages/language.ts";
import { leanToolchainLanguage } from "../../../../../lib/view/languages/lean-toolchain/language.ts";

/** Each colored span of `source`, as its text and class. */
function spans(source: string): [string, string][] {
  return leanToolchainLanguage.highlightLines(source).flatMap((line) =>
    line.spans.map((span): [string, string] => [span.text, span.cls])
  );
}

describe("leanToolchainLanguage", () => {
  it("selects a project's `lean-toolchain` file by its name", () => {
    expect(languageForFile("cfc/formal/lean-toolchain").id).toBe(
      "lean-toolchain",
    );
    expect(languageForFile("lean-toolchain.bak").id).toBe("plain-text");
  });

  it("colors the publishing repository and the channel", () => {
    expect(spans("leanprover/lean4:v4.33.0-rc1\n")).toEqual([
      ["leanprover/lean4", "typeName"],
      [":", "punctuation"],
      ["v4.33.0-rc1", "string"],
    ]);
  });

  it("colors a channel named without a repository", () => {
    expect(spans("  stable")).toEqual([["  ", "whitespace"], [
      "stable",
      "string",
    ]]);
  });

  it("colors a repository whose channel is still being written", () => {
    expect(spans("leanprover/lean4:")).toEqual([
      ["leanprover/lean4", "typeName"],
      [":", "punctuation"],
    ]);
  });

  it("leaves text after the toolchain name plain", () => {
    expect(spans("stable extra\n")).toEqual([
      ["stable", "string"],
      [" ", "whitespace"],
      ["extra", "plain"],
    ]);
    expect(leanToolchainLanguage.parseDocument("").structure).toEqual([]);
  });
});
