import { expect } from "@std/expect";
import ts from "typescript";

import {
  extractDocFromSymbolAndDecls,
  getDeclDocs,
  symbolHasDeprecatedTag,
} from "../src/doc-utils.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, createTestProgram, getTypeFromCode } from "./utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The symbol of property `name` of the interface `Root` in `code`. */
async function propertyOf(code: string, name: string) {
  const { type, checker } = await getTypeFromCode(code, "Root");
  return { property: type.getProperty(name)!, checker };
}

describe("doc-utils", () => {
  describe("getDeclDocs()", () => {
    it("keeps the inline tags of a comment in its text", async () => {
      // A comment holding an inline tag such as `{@link}` is a list of
      // parts, not one string; the tag is part of the text.
      const { property } = await propertyOf(
        `
interface Other { x: string }
interface Root {
  /** See {@link Other} for the {@linkcode Other.x}. */
  a: string;
}
`,
        "a",
      );

      expect(getDeclDocs(property.valueDeclaration!)).toEqual([
        "See {@link Other} for the {@linkcode Other.x}.",
      ]);
    });

    it("returns each distinct comment, the nearest first, without tag lines", async () => {
      const { sourceFile } = await createTestProgram(`
/** Far. */
/**
 * Near.
 * @remarks dropped
 */
/** Far. */
declare function value(): string;
`);
      const declaration = sourceFile.statements.find(ts.isFunctionDeclaration)!;

      expect(getDeclDocs(declaration)).toEqual(["Far.", "Near."]);
    });
  });

  describe("extractDocFromSymbolAndDecls()", () => {
    it("reads a doc a property inherits from the member it redeclares", async () => {
      // A redeclared property with no comment of its own carries the doc of
      // the member it overrides, which only the symbol's documentation shows.
      const code = `
interface Base {
  /** The display name. */
  name: string;
}
interface Root extends Base {
  name: "fixed";
  /** Its own doc. */
  other: string;
}
`;
      const { property, checker } = await propertyOf(code, "name");

      expect(extractDocFromSymbolAndDecls(property, checker)).toEqual({
        text: "The display name.",
        all: ["The display name."],
      });
      const { type, checker: rootChecker } = await getTypeFromCode(
        code,
        "Root",
      );
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, rootChecker),
      );
      expect(schema.properties?.name).toEqual({
        type: "string",
        enum: ["fixed"],
        description: "The display name.",
      });
    });

    it("returns no text for a symbol declared only in a declaration file", async () => {
      const { type, checker } = await getTypeFromCode(
        `interface Root { items: string[] }`,
        "Root",
      );
      const push = checker.getPropertyOfType(
        checker.getTypeOfSymbol(type.getProperty("items")!),
        "push",
      )!;

      expect(extractDocFromSymbolAndDecls(push, checker)).toEqual({ all: [] });
      expect(extractDocFromSymbolAndDecls(undefined, checker)).toEqual({
        all: [],
      });
    });
  });

  describe("symbolHasDeprecatedTag()", () => {
    it("reports a @deprecated tag on a property of the program's own source", async () => {
      const code = `
interface Root {
  /** @deprecated use b */
  a: string;
  /** Current. */
  b: string;
}
`;
      const { property: a, checker } = await propertyOf(code, "a");
      const { property: b } = await propertyOf(code, "b");

      expect(symbolHasDeprecatedTag(a, checker)).toBe(true);
      expect(symbolHasDeprecatedTag(b, checker)).toBe(false);
    });
  });

  it("gives a property whose comment holds an inline tag one description and no conflict", async () => {
    // The comment read from the declaration and the one the symbol's
    // documentation renders are the same text, so they do not conflict.
    const { type, checker } = await getTypeFromCode(
      `
interface Other { x: string }
interface Root {
  /** See {@link Other} for details. */
  a: string;
}
`,
      "Root",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.properties?.a).toEqual({
      type: "string",
      description: "See {@link Other} for details.",
    });
  });
});
