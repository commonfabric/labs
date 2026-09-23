import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  formatError,
  parseOnly,
  patternsToCheck,
  selectionFor,
  USAGE,
} from "./cfcheck-lib.ts";

/** Four patterns, spread across the trees the collector walks. */
const CORPUS = [
  "packages/connectors/agents/debug-view/logic.ts",
  "packages/patterns/counter/counter.tsx",
  "packages/patterns/form-demo.tsx",
  "packages/patterns/system/home.tsx",
];

describe("cfcheck-lib", () => {
  describe("parseOnly()", () => {
    it("returns nothing for a command line carrying no term", () => {
      expect(parseOnly([])).toEqual([]);
    });

    it("returns a term given as a separate word", () => {
      expect(parseOnly(["--only", "home.tsx"])).toEqual(["home.tsx"]);
    });

    it("returns a term given after an equals sign", () => {
      expect(parseOnly(["--only=home.tsx"])).toEqual(["home.tsx"]);
    });

    it("returns every term of a repeated flag, in the order given", () => {
      expect(parseOnly(["--only", "b.tsx", "--only=a.tsx"]))
        .toEqual(["b.tsx", "a.tsx"]);
    });

    it("throws for a `--only` at the end of the command line", () => {
      // The whole reason this throws rather than dropping the term: a run
      // with no terms checks everything, so a dropped one turns a request
      // for one pattern into a request for the corpus.
      expect(() => parseOnly(["--only"])).toThrow("--only needs a value");
    });

    it("throws for a term given as the empty string", () => {
      expect(() => parseOnly(["--only="])).toThrow("--only needs a value");
      expect(() => parseOnly(["--only", ""])).toThrow("--only needs a value");
    });

    it("throws for a term that is the caller's next flag", () => {
      // `--only --only x` reads the second flag as the first one's value.
      // It matches no pattern, so the run would check nothing.
      expect(() => parseOnly(["--only", "--only", "a.tsx"]))
        .toThrow('--only needs a value, and was given "--only"');
    });

    it("throws for an argument that is not a term at all", () => {
      expect(() => parseOnly(["--update"])).toThrow(
        "Unknown argument: --update",
      );
      expect(() => parseOnly(["home.tsx"])).toThrow(
        "Unknown argument: home.tsx",
      );
    });
  });

  describe("patternsToCheck()", () => {
    it("takes the whole corpus where no term was given", () => {
      expect(patternsToCheck(CORPUS, [])).toEqual(CORPUS);
    });

    it("takes the one pattern a whole path names", () => {
      // What a lane passes: a unit is a whole path, and the lane is
      // charged for the units it asked for and no others.
      expect(patternsToCheck(CORPUS, ["packages/patterns/form-demo.tsx"]))
        .toEqual(["packages/patterns/form-demo.tsx"]);
    });

    it("takes every pattern a term matches", () => {
      expect(patternsToCheck(CORPUS, ["packages/patterns/"])).toEqual([
        "packages/patterns/counter/counter.tsx",
        "packages/patterns/form-demo.tsx",
        "packages/patterns/system/home.tsx",
      ]);
    });

    it("takes a pattern under either of two terms", () => {
      expect(patternsToCheck(CORPUS, ["form-demo", "home.tsx"])).toEqual([
        "packages/patterns/form-demo.tsx",
        "packages/patterns/system/home.tsx",
      ]);
    });

    it("takes nothing for a term no pattern matches", () => {
      expect(patternsToCheck(CORPUS, ["no-such-pattern"])).toEqual([]);
    });
  });

  describe("selectionFor()", () => {
    it("takes the patterns the command line names", () => {
      expect(selectionFor(CORPUS, ["--only", "home.tsx"]))
        .toEqual(["packages/patterns/system/home.tsx"]);
    });

    it("takes the whole corpus given no term", () => {
      expect(selectionFor(CORPUS, [])).toEqual(CORPUS);
    });

    it("throws rather than widening, for a command line it cannot read", () => {
      expect(() => selectionFor(CORPUS, ["--only"])).toThrow();
    });
  });

  describe("formatError()", () => {
    it("returns the message of an error", () => {
      expect(formatError(new Error("no such pattern"))).toBe("no such pattern");
    });

    it("returns the text of anything else thrown", () => {
      expect(formatError("bare string")).toBe("bare string");
    });
  });

  describe("USAGE", () => {
    it("names the flag", () => {
      expect(USAGE).toContain("--only");
    });
  });
});
