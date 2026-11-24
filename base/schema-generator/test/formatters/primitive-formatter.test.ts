import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type ts from "typescript";

import { PrimitiveFormatter } from "../../src/formatters/primitive-formatter.ts";
import type { GenerationContext } from "../../src/interface.ts";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

/** A context with nothing beyond what every generation starts with. */
function contextFor(checker: ts.TypeChecker): GenerationContext {
  return {
    typeChecker: checker,
    definitions: {},
    emittedRefs: new Set(),
    mergedIntersectionNames: new Map(),
    nameAnonymousDefinition: () => "AnonymousType_1",
    anyValuesBesideUnwritten: [],
    definitionStack: new Set(),
    expandingPath: [],
    expansionBudget: { readingsInside: 0 },
    inProgressNames: new Set(),
  };
}

/** The types of the properties of the interface `Root` in `code`. */
async function propertyTypes(code: string) {
  const { type, checker } = await getTypeFromCode(code, "Root");
  const typeOf = (name: string) =>
    checker.getTypeOfSymbol(type.getProperty(name)!);
  return { typeOf, checker };
}

describe("primitive-formatter", () => {
  describe("PrimitiveFormatter", () => {
    describe("instance members", () => {
      describe("formatType()", () => {
        it("returns an integer schema listing a bigint literal's value", async () => {
          const code = `interface Root { big: 10n; any: bigint }`;
          const { type, checker } = await getTypeFromCode(code, "Root");

          const schema = asObjectSchema(
            new SchemaGenerator().generateSchema(type, checker),
          );
          expect(schema.properties).toEqual({
            big: { type: "integer", enum: [10] },
            any: { type: "integer" },
          });
        });

        it("returns a bare integer schema for a bigint literal with literals widened", async () => {
          const code = `interface Root { big: 10n }`;
          const { type, checker } = await getTypeFromCode(code, "Root");

          const schema = asObjectSchema(
            new SchemaGenerator().generateSchema(type, checker, undefined, {
              widenLiterals: true,
            }),
          );
          expect(schema.properties).toEqual({ big: { type: "integer" } });
        });

        it("returns a boolean schema for `boolean` itself", async () => {
          // `boolean` is the union of its two literals; the formatter takes it
          // whole, beside the literals it takes one at a time.
          const { typeOf, checker } = await propertyTypes(
            `interface Root { flag: boolean; yes: true; no: false }`,
          );
          const formatter = new PrimitiveFormatter();
          const context = contextFor(checker);

          expect(formatter.supportsType(typeOf("flag"), context)).toBe(true);
          expect(formatter.formatType(typeOf("flag"), context)).toEqual({
            type: "boolean",
          });
          expect(formatter.formatType(typeOf("yes"), context)).toEqual({
            type: "boolean",
            enum: [true],
          });
          expect(formatter.formatType(typeOf("no"), context)).toEqual({
            type: "boolean",
            enum: [false],
          });
        });
      });
    });

    describe("static members", () => {
      describe("getSchemaType()", () => {
        it("returns the unknown-string schema for a type no primitive describes", async () => {
          const { typeOf, checker } = await propertyTypes(
            `interface Root { shape: { a: string }; text: string }`,
          );
          const context = contextFor(checker);

          expect(
            new PrimitiveFormatter().supportsType(typeOf("shape"), context),
          )
            .toBe(false);
          expect(PrimitiveFormatter.getSchemaType(typeOf("shape"), context))
            .toEqual({ type: "string", enum: ["unknown"] });
          expect(PrimitiveFormatter.getSchemaType(typeOf("text"), context))
            .toEqual({ type: "string" });
        });
      });
    });
  });
});
