import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Source } from "../interface.ts";
import {
  assertDataFileInsideProgramRoot,
  importEscapesProgramRoot,
  resolveDataFilePath,
  resolveDeclaredDataFile,
  resolveImportSpecifier,
} from "../specifier.ts";

const from = (name: string): Source => ({ name, contents: "" });

describe("specifier", () => {
  describe("importEscapesProgramRoot", () => {
    it("returns true for a parent import from a file at the root", () => {
      expect(
        importEscapesProgramRoot("../shared/mod.ts", from("/main.tsx")),
      ).toBe(true);
    });

    it("returns true when the climb exceeds the importer's depth", () => {
      expect(
        importEscapesProgramRoot(
          "../../cfc/admin/mod.ts",
          from("/lot-watch/main.tsx"),
        ),
      ).toBe(true);
    });

    it("returns false for a parent import that stays inside the root", () => {
      expect(
        importEscapesProgramRoot("../util/helpers.ts", from("/core/main.tsx")),
      ).toBe(false);
    });

    it("returns false for a same-directory import", () => {
      expect(
        importEscapesProgramRoot("./helpers.ts", from("/main.tsx")),
      ).toBe(false);
    });

    it("returns false for an inner traversal that nets inside", () => {
      expect(
        importEscapesProgramRoot("./sub/../helpers.ts", from("/main.tsx")),
      ).toBe(false);
    });

    it("returns false for a bare specifier", () => {
      expect(
        importEscapesProgramRoot("commonfabric", from("/main.tsx")),
      ).toBe(false);
    });

    it("returns false for an ungrounded importer name", () => {
      expect(
        importEscapesProgramRoot("../shared/mod.ts", from("main.tsx")),
      ).toBe(false);
    });

    it("detects the escape under an HTTP-style double-slash name", () => {
      expect(
        importEscapesProgramRoot(
          "../../outside.ts",
          from("//pkg/main.tsx"),
        ),
      ).toBe(true);
      expect(
        importEscapesProgramRoot(
          "../../outside.ts",
          from("///pkg/main.tsx"),
        ),
      ).toBe(true);
    });

    it("keeps an inside import inside under a double-slash name", () => {
      expect(
        importEscapesProgramRoot("./helper.ts", from("//pkg/main.tsx")),
      ).toBe(false);
    });
  });

  describe("resolveImportSpecifier", () => {
    it("joins a relative specifier against the importer's directory", () => {
      expect(
        resolveImportSpecifier("./helpers.ts", from("/core/main.tsx")),
      ).toBe("/core/helpers.ts");
      expect(
        resolveImportSpecifier("../util/mod.ts", from("/core/main.tsx")),
      ).toBe("/util/mod.ts");
    });

    it("returns a bare specifier unchanged", () => {
      expect(
        resolveImportSpecifier("commonfabric", from("/main.tsx")),
      ).toBe("commonfabric");
    });
  });

  describe("resolveDataFilePath", () => {
    it("joins a sibling path against the reader's directory", () => {
      expect(
        resolveDataFilePath("./words.txt", "/scrabble/scrabble.tsx"),
      ).toBe("/scrabble/words.txt");
    });

    it("joins a path in a directory beneath the reader", () => {
      expect(
        resolveDataFilePath("./data/cities.json", "/examples/reader.tsx"),
      ).toBe("/examples/data/cities.json");
    });

    it("climbs out of the reader's directory for a parent path", () => {
      expect(
        resolveDataFilePath("../shared/words.txt", "/scrabble/scrabble.tsx"),
      ).toBe("/shared/words.txt");
    });

    it("resolves a bare path against the reader, as `./` does", () => {
      // `./` contributes nothing to a directory walk, and a data file has no
      // bare-package namespace for the prefix-free spelling to mean instead.
      expect(resolveDataFilePath("data/cities.json", "/examples/reader.tsx"))
        .toBe(
          resolveDataFilePath("./data/cities.json", "/examples/reader.tsx"),
        );
      expect(resolveDataFilePath("words.txt", "/scrabble/scrabble.tsx"))
        .toBe("/scrabble/words.txt");
    });

    it("returns a grounded path unchanged", () => {
      expect(
        resolveDataFilePath("/data/cities.json", "/deep/nested/reader.tsx"),
      ).toBe("/data/cities.json");
    });

    it("gives the same answer for the same reader under any root", () => {
      // The whole point: one source, rooted three ways, naming one file.
      expect(resolveDataFilePath("./words.txt", "/words-game/main.tsx"))
        .toBe("/words-game/words.txt");
      expect(
        resolveDataFilePath("./words.txt", "/patterns/words-game/main.tsx"),
      ).toBe("/patterns/words-game/words.txt");
      expect(resolveDataFilePath("./words.txt", "/main.tsx"))
        .toBe("/words.txt");
    });
  });

  describe("assertDataFileInsideProgramRoot", () => {
    it("refuses a path that climbs above the root", () => {
      expect(() =>
        assertDataFileInsideProgramRoot(
          "../../outside.txt",
          from("/scrabble/scrabble.tsx"),
        )
      ).toThrow('Data file "../../outside.txt" read in');
    });

    it("accepts a climb that stays inside the root", () => {
      assertDataFileInsideProgramRoot(
        "../shared/words.txt",
        from("/scrabble/scrabble.tsx"),
      );
    });

    it("accepts a grounded path, which climbs nowhere", () => {
      assertDataFileInsideProgramRoot("/data/cities.json", from("/main.tsx"));
    });

    it("refuses a bare path that climbs out through its own segments", () => {
      expect(() =>
        assertDataFileInsideProgramRoot(
          "sub/../../../outside.txt",
          from("/scrabble/scrabble.tsx"),
        )
      ).toThrow("escapes the program root");
    });

    it("accepts a bare path, which starts inside the reader's directory", () => {
      assertDataFileInsideProgramRoot(
        "data/cities.json",
        from("/examples/reader.tsx"),
      );
    });
  });

  describe("resolveDeclaredDataFile", () => {
    it("returns the path resolved against the reading module", () => {
      expect(
        resolveDeclaredDataFile("../shared/words.txt", from("/games/main.tsx")),
      ).toBe("/shared/words.txt");
    });

    it("throws for a path that climbs above the root", () => {
      expect(() => resolveDeclaredDataFile("../outside.txt", from("/main.tsx")))
        .toThrow('Data file "../outside.txt" read in "/main.tsx"');
    });
  });
});
