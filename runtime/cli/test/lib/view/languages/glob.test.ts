import { expect } from "@std/expect";

import { colorGlob } from "../../../../lib/view/languages/glob.ts";
import type { TokenClass } from "../../../../lib/view/model.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The runs of one class that `colorGlob` gives `pattern`. */
function runs(
  pattern: string,
  syntax: "git" | "go" = "git",
): [string, TokenClass | undefined][] {
  const classes = new Array<TokenClass | undefined>(pattern.length);
  colorGlob(pattern, classes, 0, pattern.length, syntax);
  const result: [string, TokenClass | undefined][] = [];
  for (let at = 0; at < pattern.length; at++) {
    const last = result.at(-1);
    if (last !== undefined && last[1] === classes[at]) {
      last[0] += pattern[at];
    } else {
      result.push([pattern[at], classes[at]]);
    }
  }
  return result;
}

describe("glob", () => {
  describe("colorGlob()", () => {
    it("colors wildcards, separators, escapes, and literal characters", () => {
      expect(runs("src/**/*.c?")).toEqual([
        ["src", "string"],
        ["/", "punctuation"],
        ["**", "regex"],
        ["/", "punctuation"],
        ["*", "regex"],
        [".c", "string"],
        ["?", "regex"],
      ]);
      // A backslash with nothing after it ends no escape: Git matches nothing
      // with such a pattern, and Go rejects it.
      expect(runs("a\\*b\\")).toEqual([
        ["a", "string"],
        ["\\", "punctuation"],
        ["*b\\", "string"],
      ]);
    });

    it("colors only the pattern between `start` and `end`", () => {
      const classes = new Array<TokenClass | undefined>(8);
      colorGlob("xx[a]*yy", classes, 2, 6, "git");
      expect(classes).toEqual([
        undefined,
        undefined,
        "regex",
        "regex",
        "regex",
        "regex",
        undefined,
        undefined,
      ]);
    });

    it("colors each form of Git bracket expression whole", () => {
      expect(runs("[!a]1[^b]2[]x]3[a-\\]]4[\\]]5")).toEqual([
        ["[!a]", "regex"],
        ["1", "string"],
        ["[^b]", "regex"],
        ["2", "string"],
        ["[]x]", "regex"],
        ["3", "string"],
        ["[a-\\]]", "regex"],
        ["4", "string"],
        ["[\\]]", "regex"],
        ["5", "string"],
      ]);
    });

    it("reads a character class, and a `[:` that opens none, as members", () => {
      expect(runs("[[:alpha:]]x[[:a]y]")).toEqual([
        ["[[:alpha:]]", "regex"],
        ["x", "string"],
        ["[[:a]", "regex"],
        ["y]", "string"],
      ]);
      expect(runs("[[:a[:b]")).toEqual([["[[:a[:b]", "regex"]]);
    });

    it("makes an expression invalid with a class name the syntax does not know", () => {
      expect(runs("*[[:foo:]]x")).toEqual([["*", "regex"], [
        "[[:foo:]]x",
        "string",
      ]]);
      expect(runs("[[::]]")).toEqual([["[[::]]", "string"]]);
      expect(runs("[[:word:]]")).toEqual([["[[:word:]]", "string"]]);
      expect(runs("[[:word:]]", "go")).toEqual([["[[:word:]]", "regex"]]);
    });

    it("reads a `^` that negates a class name in the Go syntax only", () => {
      expect(runs("[[:^alpha:]]", "go")).toEqual([["[[:^alpha:]]", "regex"]]);
      expect(runs("[[:^alpha:]]")).toEqual([["[[:^alpha:]]", "string"]]);
      expect(runs("[[:^foo:]]", "go")).toEqual([["[[:^foo:]]", "string"]]);
    });

    it("opens no class with a `[` that ends a range", () => {
      expect(runs("[a-[:x:]]]")).toEqual([
        ["[a-[:x:]", "regex"],
        ["]]", "string"],
      ]);
    });

    it("colors a long run of brackets that hold `[:` in time proportional to its length", () => {
      // Searching past each expression's `]` for the `:]` that ends a Go class
      // name would take time proportional to the square of the length.
      const pattern = "[[:a]".repeat(200_000);
      const classes = new Array<TokenClass | undefined>(pattern.length);
      colorGlob(pattern, classes, 0, pattern.length, "go");

      expect(new Set(classes)).toEqual(new Set(["regex"]));
    });

    it("colors every `[` from one that nothing closes as literal", () => {
      expect(runs("a[b*[c")).toEqual([
        ["a[b", "string"],
        ["*", "regex"],
        ["[c", "string"],
      ]);
      expect(runs("[[:ab")).toEqual([["[[:ab", "string"]]);
      for (const pattern of ["[\\", "[a-\\"]) {
        expect(runs(pattern)).toEqual([[pattern, "string"]]);
        expect(runs(pattern, "go")).toEqual([[pattern, "string"]]);
      }
    });

    it("reads bracket expressions as Go does for the Go syntax", () => {
      expect(runs("[!a]", "go")).toEqual([["[!a]", "regex"]]);
      expect(runs("[^a-c]", "go")).toEqual([["[^a-c]", "regex"]]);
      for (const pattern of ["[]a]", "[-a]", "[a-]"]) {
        expect(runs(pattern, "go")).toEqual([[pattern, "string"]]);
      }
      expect(runs("[]a]")).toEqual([["[]a]", "regex"]]);
    });

    it("ends a Go class name at the first `:]`, and accepts a `-` after a class", () => {
      expect(runs("[[:a]b:]]", "go")).toEqual([["[[:a]b:]]", "string"]]);
      expect(runs("[[:digit:]-z]", "go")).toEqual([["[[:digit:]-z]", "regex"]]);
      expect(runs("[[:x]", "go")).toEqual([["[[:x]", "regex"]]);
      expect(runs("[[:]", "go")).toEqual([["[[:]", "regex"]]);
      expect(runs("[[:alpha:]a-]", "go")).toEqual([["[[:alpha:]a-]", "regex"]]);
      // Git ends the name at the first `]`.
      expect(runs("[[:a]b:]]")).toEqual([["[[:a]", "regex"], [
        "b:]]",
        "string",
      ]]);
    });

    it("rejects a Go range that ends in an unescaped `-` or runs backwards", () => {
      for (const pattern of ["[a--]", "[z-a]", "[a-[]", "[a-😀-b]"]) {
        expect(runs(pattern, "go")).toEqual([[pattern, "string"]]);
      }
      for (const pattern of ["[!-\\-]", "[a-z]", "[a-😀]", "[😀-😀]"]) {
        expect(runs(pattern, "go")).toEqual([[pattern, "regex"]]);
      }
      // Git accepts each of those.
      for (const pattern of ["[a--]", "[z-a]", "[a-😀-b]"]) {
        expect(runs(pattern)).toEqual([[pattern, "regex"]]);
      }
      // Git ends a range at the first byte of a UTF-8 sequence, and its last
      // byte can start another range, so the `[` after it opens no class.
      expect(runs("[a-é-[:alpha:]]")).toEqual([
        ["[a-é-[:alpha:]", "regex"],
        ["]", "string"],
      ]);
      expect(runs("[a-b-[:alpha:]]")).toEqual([["[a-b-[:alpha:]]", "regex"]]);
    });
  });
});
