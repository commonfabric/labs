import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import type { JSONSchema } from "@commonfabric/api";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram } from "./utils.ts";

/** The schema both paths give an intersection they merge but cannot support. */
const UNSUPPORTED_NON_OBJECT: JSONSchema = {
  type: "object",
  additionalProperties: true,
  $comment: "Unsupported intersection pattern: non-object constituent",
};

/**
 * Declarations of the wrappers the intersections below write. CFC aliases are
 * recognized by name and `Default` by its marker's, so these stand for
 * `commonfabric`'s own.
 */
const WRAPPER_PRELUDE = `
  type Cfc<T, Meta> =
    T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
  type Confidential<T, X extends readonly unknown[]> =
    Cfc<T, { confidentiality: X }>;
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
  type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
  interface Named { x: string }
`;

/**
 * The schema of `result`, `M1 & M2` unless given, for `declarations`
 * declaring what it names, by each path: by its type, and as a type node with
 * no checker bindings, whose constituents are read through their names, as
 * for transformer-created type nodes. Each is read when called, so a refusal
 * can be expected of it.
 */
async function schemasOfBothPaths(
  declarations: string,
  result = "M1 & M2",
): Promise<{
  byType: () => JSONSchema;
  byNode: () => JSONSchema;
}> {
  const { checker, program, sourceFile } = await createTestProgram(
    `${WRAPPER_PRELUDE}\n${declarations}\ntype Result = ${result};`,
  );
  expect(program.getSemanticDiagnostics(sourceFile)).toEqual([]);
  const declaration = sourceFile.statements.find((statement) =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === "Result"
  );
  if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error("Missing `Result` declaration");
  }
  const synthetic = ts.createSourceFile(
    "synthetic.ts",
    `type Result = ${result};`,
    ts.ScriptTarget.Latest,
    true,
  ).statements[0];
  if (!synthetic || !ts.isTypeAliasDeclaration(synthetic)) {
    throw new Error("Missing synthetic `Result` declaration");
  }
  return {
    byType: () =>
      new SchemaGenerator().generateSchema(
        checker.getTypeFromTypeNode(declaration.type),
        checker,
      ),
    byNode: () =>
      new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        synthetic.type,
        checker,
        undefined,
        undefined,
        sourceFile,
      ),
  };
}

describe("SchemaGenerator", () => {
  describe("intersection source types", () => {
    const cases: [string, string, JSONSchema][] = [
      [
        "returns `true` for an opaque cell beside `any` and `string`",
        "any & OpaqueCell<any> & string & unknown",
        true,
      ],
      [
        "returns `false` for an opaque cell beside `any` and `undefined`",
        "any & OpaqueCell<any> & undefined & unknown",
        false,
      ],
      [
        "returns `false` for `void` beside `any` and `string`",
        "any & void & string & unknown",
        false,
      ],
      [
        "returns `true` for `void` beside `any` and `undefined`",
        "any & void & undefined & unknown",
        true,
      ],
      [
        "returns `false` for a named `void` beside `any` and `string`",
        "any & VoidAlias & string & unknown",
        false,
      ],
      [
        "returns `false` when opaque and void parts precede `undefined`",
        "any & OpaqueCell<any> & void & undefined & unknown",
        false,
      ],
      [
        "returns `false` when void and opaque parts precede `undefined`",
        "any & void & OpaqueCell<any> & undefined & unknown",
        false,
      ],
      [
        "returns `true` with an opaque-or-void union beside `any`",
        "any & (OpaqueCell<any> | void) & string & unknown",
        true,
      ],
      [
        "returns `true` with a void-or-opaque union beside `any`",
        "any & (void | OpaqueCell<any>) & string & unknown",
        true,
      ],
      [
        "returns `false` for contradictory flat branded primitives",
        "any & string & { topic: unknown } & number",
        false,
      ],
      [
        "returns `false` for contradictory nested branded primitives",
        "any & (string & { topic: unknown }) & number",
        false,
      ],
      [
        "returns `false` for contradictory named branded primitives",
        "any & Brand & number & unknown",
        false,
      ],
      [
        "returns `false` for a nested contradiction without `any`",
        "(string & { topic: unknown }) & number",
        false,
      ],
      [
        "returns `true` for compatible nested branded primitives beside `any`",
        "any & (string & { topic: unknown }) & string",
        true,
      ],
      [
        "returns `true` after an inner intersection reduces to `any`",
        "(any & null) & string & unknown",
        true,
      ],
      [
        "returns `false` for contradictory branded primitives within a union",
        "(Brand | number) & boolean & unknown",
        false,
      ],
      [
        "returns `true` with a branded primitive union beside `any`",
        "any & (Brand | number) & boolean & unknown",
        true,
      ],
      // Two branded primitives emit one fallback, so their union folds to it;
      // an intersection meeting the survivor still reads both arms.
      [
        "returns `true` when `any` meets a union whose arms fold to one fallback",
        "any & Folded & number",
        true,
      ],
      [
        "keeps the arm a union folded away when the other arm is refused",
        "Folded & number",
        UNSUPPORTED_NON_OBJECT,
      ],
      [
        "returns `true` when `any` meets a union the node path folded",
        "any & (((string & A) | (number & B)) & unknown) & number",
        true,
      ],
      [
        "keeps the arm the node path folded away when the other arm is refused",
        "(((string & A) | (number & B)) & unknown) & number",
        UNSUPPORTED_NON_OBJECT,
      ],
      [
        "returns `false` for disjoint folded unions with string literals first",
        '((("a" & A) | ("b" & B)) & unknown) & (((1 & C) | (2 & D)) & unknown)',
        false,
      ],
      [
        "returns `false` for disjoint folded unions with numeric literals first",
        '(((1 & C) | (2 & D)) & unknown) & ((("a" & A) | ("b" & B)) & unknown)',
        false,
      ],
    ];

    for (const [description, expression, expected] of cases) {
      it(description, async () => {
        const code = `
          type Brand = string & { topic: unknown };
          type Folded = (string & { a: 1 }) | (number & { b: 2 });
          type A = { a: 1 };
          type B = { b: 2 };
          type C = { c: 3 };
          type D = { d: 4 };
          type VoidAlias = void;
          type Result = ${expression};
        `;
        const { checker, program, sourceFile } = await createTestProgram(code);
        expect(program.getSemanticDiagnostics(sourceFile)).toEqual([]);
        const declaration = sourceFile.statements.find((statement) =>
          ts.isTypeAliasDeclaration(statement) &&
          statement.name.text === "Result"
        );
        if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
          throw new Error("Missing `Result` declaration");
        }
        const type = checker.getTypeFromTypeNode(declaration.type);
        expect(new SchemaGenerator().generateSchema(type, checker)).toEqual(
          expected,
        );

        // The separate syntax tree has no checker bindings; names resolve in
        // the authored file, as they do for transformer-created type nodes.
        const syntheticFile = ts.createSourceFile(
          "synthetic.ts",
          `type Result = ${expression};`,
          ts.ScriptTarget.Latest,
          true,
        );
        const synthetic = syntheticFile.statements[0];
        if (!synthetic || !ts.isTypeAliasDeclaration(synthetic)) {
          throw new Error("Missing synthetic `Result` declaration");
        }
        expect(new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
          synthetic.type,
          checker,
          undefined,
          undefined,
          sourceFile,
        )).toEqual(expected);
      });
    }
  });

  describe("properties several intersection constituents declare", () => {
    // Each case declares `M1` and `M2`, whose intersection both paths read
    // (`schemasOfBothPaths()`).

    const conflictComment =
      "Conflicting docs across intersection constituents; using first";
    const cases: [string, string, JSONSchema][] = [
      [
        "returns the narrower schema for `unknown` beside `string`",
        `type M1 = { a: unknown }; type M2 = { a: string };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "returns the narrower schema for `string` beside `unknown`",
        `type M1 = { a: string }; type M2 = { a: unknown };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "returns the union member the other declaration narrows to",
        `type M1 = { a: string | number }; type M2 = { a: string };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "returns `false` for disjoint declarations",
        `type M1 = { a: string }; type M2 = { a: number };`,
        { type: "object", properties: { a: false }, required: ["a"] },
      ],
      [
        "returns the merged members of object-typed declarations",
        `type M1 = { a: { x: unknown } }; type M2 = { a: { x: string; y: number } };`,
        {
          type: "object",
          properties: {
            a: {
              type: "object",
              properties: { x: { type: "string" }, y: { type: "number" } },
              required: ["x", "y"],
            },
          },
          required: ["a"],
        },
      ],
      [
        "lists the property in `required` when one declaration requires it",
        `type M1 = { a?: string }; type M2 = { a: string };`,
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      ],
      [
        "keeps the first declaration's description beside a narrower declaration",
        `
          interface M1 {
            /** First doc */
            a: unknown;
          }
          interface M2 {
            /** Second doc */
            a: string;
          }
        `,
        {
          type: "object",
          properties: {
            a: {
              type: "string",
              description: "First doc",
              $comment: conflictComment,
            },
          },
          required: ["a"],
        },
      ],
      [
        "keeps the first of two descriptions on declarations of one type",
        `
          interface M1 {
            /** First doc */
            a: string;
          }
          interface M2 {
            /** Second doc */
            a: string;
          }
        `,
        {
          type: "object",
          properties: {
            a: {
              type: "string",
              description: "First doc",
              $comment: conflictComment,
            },
          },
          required: ["a"],
        },
      ],
      // A documented branded primitive emits the unsupported-pattern
      // fallback, whose constituents are recorded; read without its
      // description, it still meets `number` as `string` would.
      [
        "returns `false` for a documented branded declaration beside a disjoint one",
        `
          interface M1 {
            /** Branded doc */
            a: string & { topic: unknown };
          }
          interface M2 {
            a: number;
          }
        `,
        { type: "object", properties: { a: false }, required: ["a"] },
      ],
    ];

    for (const [description, declarations, expected] of cases) {
      it(description, async () => {
        const { byType, byNode } = await schemasOfBothPaths(declarations);
        expect(byType()).toEqual(expected);
        expect(byNode()).toEqual(expected);
      });
    }

    it("returns a union with `undefined` for an optional declaration beside `string | undefined`", async () => {
      // An optional declaration admits `undefined` as its `?` does, so the
      // property that declaration and `string | undefined` share admits it
      // too. The node path spells the union it settles as `anyOf`.

      const { byNode } = await schemasOfBothPaths(`
        type M1 = { a: string | undefined };
        type M2 = { a?: string };
      `);

      expect(byNode()).toEqual({
        type: "object",
        properties: {
          a: { anyOf: [{ type: "string" }, { type: "undefined" }] },
        },
        required: ["a"],
      });
    });
  });

  describe("labels, scopes and cells of intersection constituents", () => {
    // What a constituent states besides which values it holds is kept
    // whichever constituent states it, by both paths. Each case declares
    // `M1` and `M2` (`schemasOfBothPaths()`).

    const labelS = { confidentiality: ["s"] };
    const objectX = {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    } as const;
    const propertyA = (a: JSONSchema): JSONSchema => ({
      type: "object",
      properties: { a },
      required: ["a"],
    });
    const cases: [string, string, JSONSchema][] = [
      [
        "keeps the scope a later declaration of a property states",
        `type M1 = { a: { x: string } }; type M2 = { a: PerUser<{ x: string }> };`,
        propertyA({ ...objectX, scope: "user" }),
      ],
      [
        "keeps the scope beside a declaration that declares more members",
        `
          type M1 = { a: PerUser<{ x: string }> };
          type M2 = { a: { x: string; y: number } };
        `,
        propertyA({
          type: "object",
          properties: { x: { type: "string" }, y: { type: "number" } },
          required: ["x", "y"],
          scope: "user",
        }),
      ],
      [
        "keeps the label a later declaration of a property states",
        `
          type M1 = { a: string };
          type M2 = { a: Confidential<string, readonly ["s"]> };
        `,
        propertyA({ type: "string", ifc: labelS }),
      ],
      [
        "labels the members a labeled declaration declares beside one that declares more",
        `
          type M1 = { a: Confidential<{ x: string }, readonly ["s"]> };
          type M2 = { a: { x: string; y: number } };
        `,
        propertyA({
          type: "object",
          properties: {
            x: { type: "string", ifc: labelS },
            y: { type: "number" },
          },
          required: ["x", "y"],
        }),
      ],
      [
        "joins the confidentiality labels two declarations of a property state",
        `
          type M1 = { a: Confidential<{ x: string }, readonly ["a"]> };
          type M2 = { a: Confidential<{ x: string }, readonly ["b"]> };
        `,
        propertyA({ ...objectX, ifc: { confidentiality: ["a", "b"] } }),
      ],
      [
        "keeps the default a later declaration of a property states",
        `type M1 = { a: string }; type M2 = { a: Default<string, "x"> };`,
        propertyA({ type: "string", default: "x" }),
      ],
      [
        "caps a cell with the scope a later declaration of it states",
        `
          type M1 = { a: Cell<{ x: string }> };
          type M2 = { a: PerUser<Cell<{ x: string }>> };
        `,
        propertyA({ ...objectX, asCell: [{ kind: "cell", scope: "user" }] }),
      ],
      [
        "returns the array of the elements two declarations of a property admit",
        `type M1 = { a: unknown[] }; type M2 = { a: string[] };`,
        propertyA({ type: "array", items: { type: "string" } }),
      ],
      [
        "keeps the scope of a scoped constituent beside an object",
        `type M1 = PerUser<{ x: string }>; type M2 = { y: number };`,
        {
          type: "object",
          properties: { x: { type: "string" }, y: { type: "number" } },
          required: ["x", "y"],
          scope: "user",
        },
      ],
      [
        "labels the members of a labeled constituent beside an object",
        `
          type M1 = Confidential<{ x: string }, readonly ["s"]>;
          type M2 = { y: number };
        `,
        {
          type: "object",
          properties: {
            x: { type: "string", ifc: labelS },
            y: { type: "number" },
          },
          required: ["x", "y"],
        },
      ],
      [
        "labels the members of a labeled named constituent beside an object",
        `type M1 = Confidential<Named, readonly ["s"]>; type M2 = { y: number };`,
        {
          type: "object",
          properties: {
            x: { type: "string", ifc: labelS },
            y: { type: "number" },
          },
          required: ["x", "y"],
        },
      ],
      [
        "labels the members a labeled union's arms declare beside a declaration of other members",
        `
          type M1 = { a: { y: number } };
          type M2 = {
            a: Confidential<{ x: string } | { z: number }, readonly ["s"]>;
          };
        `,
        propertyA({
          anyOf: [
            {
              type: "object",
              properties: {
                y: { type: "number" },
                x: { type: "string", ifc: labelS },
              },
              required: ["y", "x"],
            },
            {
              type: "object",
              properties: {
                y: { type: "number" },
                z: { type: "number", ifc: labelS },
              },
              required: ["y", "z"],
            },
          ],
        }),
      ],
      [
        "labels a labeled union's branded arm beside the primitive it brands",
        `
          type M1 = Confidential<
            (string & { topic: unknown }) | number,
            readonly ["s"]
          >;
          type M2 = string;
        `,
        { ...UNSUPPORTED_NON_OBJECT as object, ifc: labelS },
      ],
      [
        "keeps the scope of a declaration beside one typed as `any`",
        `type M1 = { a: any }; type M2 = { a: PerUser<string> };`,
        propertyA({ scope: "user" }),
      ],
      [
        "keeps the labels of a declaration beside one typed as `any`",
        `
          type M1 = { a: Confidential<string, readonly ["s"]> };
          type M2 = { a: any };
        `,
        propertyA({ ifc: labelS }),
      ],
      [
        "keeps a member's labels on the whole value beside `any`",
        `
          type M1 = { a: Confidential<{ x: string }, readonly ["s"]> };
          type M2 = { a: any };
        `,
        propertyA({ ifc: labelS }),
      ],
      [
        "keeps the labels a named definition holds beside `any`",
        `
          interface Secret { x: Confidential<string, readonly ["s"]> }
          type M1 = { a: Secret };
          type M2 = { a: any };
        `,
        propertyA({ ifc: labelS }),
      ],
      [
        "keeps an integrity floor beside `any`",
        `
          type M1 = { a: Cfc<string, { requiredIntegrity: readonly ["r"] }> };
          type M2 = { a: any };
        `,
        propertyA({ ifc: { requiredIntegrity: ["r"] } }),
      ],
      [
        "drops the integrity a declaration beside `any` claims",
        `
          type M1 = {
            a: Cfc<string, {
              confidentiality: readonly ["s"];
              integrity: readonly ["i"];
            }>;
          };
          type M2 = { a: any };
        `,
        propertyA({ ifc: labelS }),
      ],
      [
        "keeps the integrity a declaration typed as `any` claims",
        `
          type M1 = { a: Cfc<any, { integrity: readonly ["i"] }> };
          type M2 = { a: string };
        `,
        propertyA({ ifc: { integrity: ["i"] } }),
      ],
      [
        "keeps the labels and scope of a declaration of `any` beside a primitive",
        `
          type M1 = { a: string };
          type M2 = { a: PerUser<Confidential<any, readonly ["s"]>> };
        `,
        propertyA({ ifc: labelS, scope: "user" }),
      ],
      [
        "keeps the default declarations beside `any` agree on",
        `type M1 = { a: Default<string, "x"> }; type M2 = { a: any };`,
        propertyA({ default: "x" }),
      ],
      [
        "keeps evidence off a value whose members a constituent of none does not hold",
        `
          type M1 = { a: { x: string } };
          type M2 = { a: Cfc<unknown, { integrity: readonly ["v"] }> };
        `,
        propertyA(objectX),
      ],
      [
        "keeps added integrity off a value whose members a constituent of none does not hold",
        `
          type M1 = { a: { x: string } };
          type M2 = { a: Cfc<unknown, { addIntegrity: readonly ["v"] }> };
        `,
        propertyA(objectX),
      ],
      [
        "keeps a restriction on the whole value where it keeps evidence off it",
        `
          type M1 = { a: { x: string } };
          type M2 = {
            a: Cfc<unknown, {
              confidentiality: readonly ["s"];
              integrity: readonly ["v"];
            }>;
          };
        `,
        propertyA({ ...objectX, ifc: labelS }),
      ],
      [
        "keeps evidence on the members a constituent declares",
        `
          type M1 = { a: { x: string; y: number } };
          type M2 = { a: Cfc<{ x: string }, { integrity: readonly ["v"] }> };
        `,
        propertyA({
          type: "object",
          properties: {
            x: { type: "string", ifc: { integrity: ["v"] } },
            y: { type: "number" },
          },
          required: ["x", "y"],
        }),
      ],
      [
        "keeps evidence on a value with no members of its own",
        `
          type M1 = { a: string };
          type M2 = { a: Cfc<unknown, { integrity: readonly ["v"] }> };
        `,
        propertyA({ type: "string", ifc: { integrity: ["v"] } }),
      ],
      [
        "keeps evidence off an array a constituent of no members does not hold",
        `
          type M1 = { a: string[] };
          type M2 = { a: Cfc<unknown, { integrity: readonly ["v"] }> };
        `,
        propertyA({ type: "array", items: { type: "string" } }),
      ],
      [
        "keeps evidence on an array a constituent holds whole",
        `
          type M1 = { a: unknown[] };
          type M2 = { a: Cfc<string[], { integrity: readonly ["v"] }> };
        `,
        propertyA({
          type: "array",
          items: { type: "string" },
          ifc: { integrity: ["v"] },
        }),
      ],
      [
        "keeps evidence off a fallback whose members a constituent does not hold",
        `
          type M1 = { a: string & { b: 1 } };
          type M2 = { a: Cfc<unknown, { integrity: readonly ["v"] }> };
        `,
        propertyA(UNSUPPORTED_NON_OBJECT),
      ],
      [
        "keeps evidence on the members a constituent declares beside an index signature",
        `
          type M1 = { a: { [key: string]: string } };
          type M2 = { a: Cfc<{ x: string }, { integrity: readonly ["v"] }> };
        `,
        propertyA({
          type: "object",
          properties: { x: { type: "string", ifc: { integrity: ["v"] } } },
          required: ["x"],
          additionalProperties: { type: "string" },
        }),
      ],
      [
        "keeps added integrity on the members a constituent declares beside a record",
        `
          type M1 = { a: Record<string, unknown> };
          type M2 = {
            a: Cfc<{ x: string }, { addIntegrity: readonly ["v"] }>;
          };
        `,
        propertyA({
          type: "object",
          properties: { x: { type: "string", ifc: { addIntegrity: ["v"] } } },
          required: ["x"],
          additionalProperties: { type: "unknown" },
        }),
      ],
      [
        "keeps evidence on a record whose index signature the constituent declares",
        `
          type M1 = { a: Record<string, string> };
          type M2 = {
            a: Cfc<Record<string, string>, { integrity: readonly ["v"] }>;
          };
        `,
        propertyA({
          type: "object",
          properties: {},
          additionalProperties: { type: "string" },
          ifc: { integrity: ["v"] },
        }),
      ],
      [
        "keeps evidence off a record a constituent of no members does not hold",
        `
          type M1 = { a: { [key: string]: number } };
          type M2 = { a: Cfc<unknown, { integrity: readonly ["v"] }> };
        `,
        propertyA({
          type: "object",
          properties: {},
          additionalProperties: { type: "number" },
        }),
      ],
      [
        "keeps a restriction on the whole of a record beside the members it labels",
        `
          type M1 = { a: Record<string, unknown> };
          type M2 = { a: Confidential<{ x: string }, readonly ["s"]> };
        `,
        propertyA({
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: { type: "unknown" },
          ifc: labelS,
        }),
      ],
      [
        "keeps evidence on the whole of a record closed by a never-valued index signature",
        `
          type M1 = { a: Record<string, never> };
          type M2 = { a: Cfc<{ x: string }, { integrity: readonly ["v"] }> };
        `,
        propertyA({
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
          ifc: { integrity: ["v"] },
        }),
      ],
      [
        "keeps evidence off the fallback of an array beside the members it labels",
        `
          type M1 = { a: string[] };
          type M2 = { a: Cfc<{ x: string }, { integrity: readonly ["v"] }> };
        `,
        propertyA({
          type: "object",
          additionalProperties: true,
          $comment:
            "Unsupported intersection pattern: index signature on constituent",
        }),
      ],
      [
        "keeps a union's evidence on the members of the arm the value is",
        `
          type M1 = { a: { z: number } };
          type M2 = {
            a: Cfc<{ x: string } | { z: number }, {
              integrity: readonly ["v"];
            }>;
          };
        `,
        propertyA({
          anyOf: [
            {
              type: "object",
              properties: {
                z: { type: "number" },
                x: { type: "string", ifc: { integrity: ["v"] } },
              },
              required: ["z", "x"],
            },
            {
              type: "object",
              properties: { z: { type: "number" } },
              required: ["z"],
              ifc: { integrity: ["v"] },
            },
          ],
        }),
      ],
      [
        "keeps the cap of a cell beside `any` as the value's scope",
        `type M1 = { a: PerUser<Cell<string>> }; type M2 = { a: any };`,
        propertyA({ scope: "user" }),
      ],
      [
        "returns the labeled `never` a declaration states beside a primitive",
        `
          type M1 = { a: string };
          type M2 = { a: Confidential<never, readonly ["s"]> };
        `,
        propertyA({ not: true, ifc: labelS }),
      ],
      [
        "returns `false` for a property a named `never` type declares",
        `
          type Nothing = never;
          interface M1 { a: Nothing }
          type M2 = { a: string };
        `,
        propertyA(false),
      ],
      [
        "keeps the first declaration's documentation on the stream another declaration widens",
        `
          interface M1 {
            /**
             * Opens the panel. #tagged
             * @deprecated
             */
            a: () => Stream<string>;
          }
          interface M2 {
            a: { x: string };
          }
        `,
        propertyA({
          asCell: ["stream"],
          description: "Opens the panel. #tagged",
          tags: ["tagged"],
          deprecated: true,
        }),
      ],
      [
        "caps the cell a scoped constituent meets",
        `type M1 = PerUser<{ x: string }>; type M2 = Cell<{ x: string }>;`,
        { ...objectX, asCell: [{ kind: "cell", scope: "user" }] },
      ],
      [
        "joins the labels a labeled definition and the reference to it state",
        `
          type Secret = Confidential<{ x: string }, readonly ["inner"]>;
          type M1 = { a: Confidential<Secret, readonly ["outer"]> };
          type M2 = { a: { y: number } };
        `,
        propertyA({
          type: "object",
          properties: {
            x: {
              type: "string",
              ifc: { confidentiality: ["inner", "outer"] },
            },
            y: { type: "number" },
          },
          required: ["x", "y"],
        }),
      ],
      [
        "writes the merge of two recursive definitions as a definition its recursion refers to",
        `
          interface A { next?: A; x: string }
          interface B { next?: B; y: number }
          type M1 = A;
          type M2 = B;
        `,
        {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/AnonymousType_1" },
            x: { type: "string" },
            y: { type: "number" },
          },
          required: ["x", "y"],
          $defs: {
            AnonymousType_1: {
              type: "object",
              properties: {
                next: { $ref: "#/$defs/AnonymousType_1" },
                x: { type: "string" },
                y: { type: "number" },
              },
              required: ["x", "y"],
            },
          },
        },
      ],
      [
        "labels the arms a labeled folded union keeps beside another constituent",
        `
          type Folded = void | OpaqueCell<any>;
          type M1 = Confidential<Folded, readonly ["s"]>;
          type M2 = string;
        `,
        { asCell: ["opaque"], ifc: labelS },
      ],
      [
        "labels the branded arms a labeled folded union keeps beside a primitive",
        `
          type Branded = (string & { a: 1 }) | (number & { b: 2 });
          type M1 = Confidential<Branded, readonly ["s"]>;
          type M2 = string;
        `,
        { ...UNSUPPORTED_NON_OBJECT as object, ifc: labelS },
      ],
      [
        "returns the cell a cell constituent declares beside an object",
        `type M1 = Cell<unknown>; type M2 = { y: number };`,
        { type: "unknown", asCell: ["cell"] },
      ],
      [
        "returns the opaque cell beside a primitive",
        `type M1 = OpaqueCell<any>; type M2 = string;`,
        { asCell: ["opaque"] },
      ],
      [
        "returns `false` for a cell beside `null`",
        `type M1 = Cell<{ x: string }>; type M2 = null;`,
        false,
      ],
    ];

    for (const [description, declarations, expected] of cases) {
      it(description, async () => {
        const { byType, byNode } = await schemasOfBothPaths(declarations);
        expect(byType()).toEqual(expected);
        expect(byNode()).toEqual(expected);
      });
    }

    it("keeps apart recursive merges of equal schemas from different types", async () => {
      // `A`'s and `C`'s schemas are equal, as both branded primitives fall
      // back to one schema, so the merge of `C` with `B` met inside the merge
      // of `A` with `B` is a merge of its own, in which `v` is nothing. The
      // node path writes each merge where it starts, which the type path
      // writes as a reference.

      const { byNode } = await schemasOfBothPaths(`
        type A = { v: string & { a: 1 }; next?: A; other?: C };
        type C = { v: number & { b: 2 }; next?: A; other?: C };
        type B = { v: string; next?: B; other?: B };
        type M1 = A;
        type M2 = B;
      `);
      const mergedWithC: JSONSchema = {
        type: "object",
        properties: {
          v: false,
          next: { $ref: "#/$defs/AnonymousType_1" },
          other: { $ref: "#/$defs/AnonymousType_2" },
        },
        required: ["v"],
      };
      const mergedWithA: JSONSchema = {
        type: "object",
        properties: {
          v: UNSUPPORTED_NON_OBJECT,
          next: { $ref: "#/$defs/AnonymousType_1" },
          other: mergedWithC,
        },
        required: ["v"],
      };

      expect(byNode()).toEqual({
        ...mergedWithA as object,
        $defs: { AnonymousType_1: mergedWithA, AnonymousType_2: mergedWithC },
      });
    });

    it("throws for a property two declarations put in different scopes", async () => {
      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = { a: PerUser<string> };
        type M2 = { a: PerSpace<string> };
      `);
      const message =
        "The property `a` is declared in scope `user` by one member of an " +
        "intersection and in scope `space` by another.";

      expect(byType).toThrow(message);
      expect(byNode).toThrow(message);
    });

    it("throws for a property two declarations of a named type put in different scopes", async () => {
      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = { a: PerUser<Named> };
        type M2 = { a: PerSpace<Named> };
      `);
      const message =
        "The property `a` is declared in scope `user` by one member of an " +
        "intersection and in scope `space` by another.";

      expect(byType).toThrow(message);
      expect(byNode).toThrow(message);
    });

    it("throws for a property a declaration of `any` puts in another scope", async () => {
      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = { a: PerUser<any> };
        type M2 = { a: PerSpace<string> };
      `);
      const message =
        "The property `a` is declared in scope `user` by one member of an " +
        "intersection and in scope `space` by another.";

      expect(byType).toThrow(message);
      expect(byNode).toThrow(message);
    });

    it("keeps the labels of a whole intersection with `any` by the node path alone", async () => {
      // The checker gives the type path `any` itself, which holds nothing of
      // the constituent beside it; the node path reads both.

      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = Confidential<string, readonly ["s"]>;
        type M2 = any;
      `);

      expect(byType()).toEqual(true);
      expect(byNode()).toEqual({ ifc: labelS });
    });

    it("throws for a whole intersection with `any` in two scopes by the node path alone", async () => {
      // The type path is given `any` itself, which holds neither scope. The
      // constituents are written in place, as a name declared `any` reads as
      // `any` alone.

      const { byType, byNode } = await schemasOfBothPaths(
        "",
        "PerUser<any> & PerSpace<string>",
      );

      expect(byType()).toEqual(true);
      expect(byNode).toThrow(
        "Nested scope wrappers require a cell boundary between scopes.",
      );
    });

    it("throws where `any` meets a definition whose labels it cannot read yet", async () => {
      // `Node` is still being generated where its own member meets `any`,
      // so the labels it states are read once generation is done.

      const { byType, byNode } = await schemasOfBothPaths(
        `
          interface Node {
            secret: Confidential<string, readonly ["s"]>;
            child?: { c: Node } & { c: any };
          }
        `,
        "Node",
      );
      const message = "it meets `Node` inside the definition of `Node`";

      expect(byType).toThrow(message);
      expect(byNode).toThrow(message);
    });

    it("keeps a value where `any` meets a definition before it is written with its labels", async () => {
      const { byType, byNode } = await schemasOfBothPaths(
        `
          interface Node {
            secret: Confidential<string, readonly ["s"]>;
            child?: { c: Node } & { c: Confidential<any, readonly ["s"]> };
          }
        `,
        "Node",
      );
      const expected: JSONSchema = {
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              secret: { type: "string", ifc: labelS },
              child: {
                type: "object",
                properties: { c: { ifc: labelS } },
                required: ["c"],
              },
            },
            required: ["secret"],
          },
        },
      };

      expect(byType()).toEqual(expected);
      expect(byNode()).toEqual(expected);
    });

    it("throws for a property two declarations cap in different scopes", async () => {
      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = { a: PerUser<Cell<string>> };
        type M2 = { a: PerSpace<Cell<string>> };
      `);
      const message = "The property `a` is declared in scope `user`";

      expect(byType).toThrow(message);
      expect(byNode).toThrow(message);
    });

    it("throws for a property whose declarations reach two scopes through a union", async () => {
      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = { a: PerUser<string> | PerSpace<number> };
        type M2 = { a: PerSpace<string> };
      `);
      const message =
        "Nested scope wrappers require a cell boundary between scopes.";

      expect(byType).toThrow(message);
      expect(byNode).toThrow(message);
    });

    it("throws for constituents in different scopes", async () => {
      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = PerUser<{ x: string }>;
        type M2 = PerSpace<{ y: string }>;
      `);
      const message =
        "Nested scope wrappers require a cell boundary between scopes.";

      expect(byType).toThrow(message);
      expect(byNode).toThrow(message);
    });

    it("labels every arm of a labeled union beside another declaration", async () => {
      // The union's label is on whatever data its payload may hold, so it
      // labels each arm whole, `x` included in the arm that declares `z`. The
      // type path keeps the reference to `Named` that the node path reads
      // through.

      const { byType, byNode } = await schemasOfBothPaths(`
        type M1 = { a: Named };
        type M2 = { a: Confidential<Named | { z: number }, readonly ["s"]> };
      `);
      const withZ: JSONSchema = {
        type: "object",
        properties: { x: { type: "string" }, z: { type: "number" } },
        required: ["x", "z"],
        ifc: labelS,
      };

      expect(byNode()).toEqual(
        propertyA({ anyOf: [{ ...objectX, ifc: labelS }, withZ] }),
      );
      expect(byType()).toEqual({
        ...propertyA({
          anyOf: [{ $ref: "#/$defs/Named", ifc: labelS }, withZ],
        }) as object,
        $defs: { Named: objectX },
      });
    });
  });
});
