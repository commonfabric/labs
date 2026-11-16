import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { patternDocMetadata, publishRequestFor } from "../src/publish.ts";

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

  describe("publishRequestFor()", () => {
    const fields = {
      patternId: "id",
      description: "d",
      hashtags: [],
      keywords: [],
      program: {
        main: "/main.tsx",
        files: [
          { name: "/main.tsx", contents: "export default 1;" },
          { name: "/main.test.tsx", contents: "export default 2;" },
          {
            name: "/data/notes.txt",
            contents: 'import X from "cf:pattern:not-a-dependency";',
          },
        ],
        sourceRoots: ["/main.test.tsx"],
        dataFiles: ["/data/notes.txt"],
      },
    };

    it("returns the program's test roots and data files with it", () => {
      expect(publishRequestFor(fields).program).toMatchObject({
        sourceRoots: ["/main.test.tsx"],
        dataFiles: ["/data/notes.txt"],
      });
    });

    it("returns no dependency a data file's text names", () => {
      expect(publishRequestFor(fields).dependencies).toEqual([]);
    });
  });
});
