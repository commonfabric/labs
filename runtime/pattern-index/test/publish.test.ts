import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { patternDocMetadata } from "../src/publish.ts";

const DOC = `/**
 * Counts things.
 *
 * Second paragraph.
 *
 * @hashtags #counter, tally
 * @keywords count
 */`;

describe("publish", () => {
  describe("patternDocMetadata()", () => {
    it("returns the first paragraph and the tag lines of a leading doc comment", () => {
      expect(patternDocMetadata(`${DOC}\nexport default 1;\n`)).toEqual({
        description: "Counts things.",
        hashtags: ["#counter", "tally"],
        keywords: ["count"],
      });
    });

    it("reads a doc comment after line comments, directives and imports", () => {
      const source = [
        "// PATTERN TIER: product",
        "/// <cts-enable />",
        'import { pattern } from "commonfabric";',
        "import {",
        "  a,",
        '} from "./a.ts";',
        DOC,
        "export default 1;",
      ].join("\n");
      expect(patternDocMetadata(source).description).toBe("Counts things.");
    });

    it("returns no description for a doc comment after code", () => {
      const source = `export const x = 1;\n${DOC}\n`;
      expect(patternDocMetadata(source)).toEqual({
        hashtags: [],
        keywords: [],
      });
    });
  });
});
