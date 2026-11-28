import { expect } from "@std/expect";
import { join } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  compileLocalPattern,
  patternDocMetadata,
  publishRequestFor,
} from "../src/publish.ts";

const signer = await Identity.fromPassphrase("pattern-index publish");

const DOUBLING_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "export const tripler = pattern<Input, { tripled: number }>(({ n }) => ({",
  "  tripled: computed(() => n * 3),",
  "}));",
  "",
].join("\n");

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

    it("returns no values for a tag the comment leaves out", () => {
      expect(patternDocMetadata("/** Counts. @hashtags a */").keywords)
        .toEqual([]);
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

    it("returns a program without test roots or data files, with the schemas and lineage given", () => {
      const request = publishRequestFor({
        ...fields,
        program: {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default 1;" }],
          mainExport: "other",
        },
        argumentSchema: { type: "object" },
        resultSchema: { type: "string" },
        priorPatternId: "id-0",
        remixedFrom: "id-r",
      });
      expect(request.program).toEqual({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
        mainExport: "other",
      });
      expect(request).toMatchObject({
        argumentSchema: { type: "object" },
        resultSchema: { type: "string" },
        priorPatternId: "id-0",
        remixedFrom: "id-r",
      });
    });

    it("returns `standalone` only when the caller states it", () => {
      expect(Object.hasOwn(publishRequestFor(fields), "standalone")).toBe(
        false,
      );
      expect(publishRequestFor({ ...fields, standalone: true }).standalone)
        .toBe(true);
      expect(publishRequestFor({ ...fields, standalone: false }).standalone)
        .toBe(false);
    });

    it("returns no dependency a data file's text names", () => {
      expect(publishRequestFor(fields).dependencies).toEqual([]);
    });
  });

  describe("compileLocalPattern()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir();
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: (await Identity.generate()).did(),
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
      await Deno.remove(dir, { recursive: true });
    });

    it("returns the same durable id and schemas for the same source", async () => {
      await Deno.writeTextFile(join(dir, "main.tsx"), DOUBLING_SOURCE);
      const space = pieces.getSpace();
      const first = await compileLocalPattern(runtime, space, {
        main: join(dir, "main.tsx"),
      });
      const again = await compileLocalPattern(runtime, space, {
        main: join(dir, "main.tsx"),
      });

      expect(first.patternId).toBeDefined();
      expect(again.patternId).toBe(first.patternId);
      expect(first.argumentSchema).toMatchObject({
        properties: { n: { type: "number" } },
      });
      expect(first.resultSchema).toMatchObject({
        properties: { doubled: { type: "number" } },
      });
    });

    it("returns the program packaged with its root, test, data file and export", async () => {
      await Deno.mkdir(join(dir, "src"));
      await Deno.mkdir(join(dir, "data"));
      await Deno.writeTextFile(join(dir, "src", "main.tsx"), DOUBLING_SOURCE);
      await Deno.writeTextFile(
        join(dir, "src", "main.test.tsx"),
        "export default 1;\n",
      );
      // A data file is never parsed: an import it names fetches nothing.
      await Deno.writeTextFile(
        join(dir, "data", "notes.txt"),
        'import x from "cf:pattern:not-a-dependency";',
      );

      const { program, resultSchema } = await compileLocalPattern(
        runtime,
        pieces.getSpace(),
        {
          main: join(dir, "src", "main.tsx"),
          root: dir,
          testPaths: [join(dir, "src", "main.test.tsx")],
          dataFilePaths: [join(dir, "data", "notes.txt")],
          mainExport: "tripler",
        },
      );

      expect(program.main).toBe("/src/main.tsx");
      expect(program.mainExport).toBe("tripler");
      expect(program.sourceRoots).toEqual(["/src/main.test.tsx"]);
      expect(program.dataFiles).toEqual(["/data/notes.txt"]);
      expect(resultSchema).toMatchObject({
        properties: { tripled: { type: "number" } },
      });
    });

    it("throws for a source that imports a published pattern, naming the import", async () => {
      await Deno.writeTextFile(
        join(dir, "main.tsx"),
        'import doubler from "cf:pattern:some-id";\nexport default doubler;\n',
      );

      await expect(
        compileLocalPattern(runtime, pieces.getSpace(), {
          main: join(dir, "main.tsx"),
        }),
      ).rejects.toThrow('Could not resolve "cf:pattern:some-id"');
    });
  });
});
