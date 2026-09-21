import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";
import {
  createTestProgram,
  createTestProgramFromFiles,
  getTypeFromCode,
} from "./utils.ts";

/**
 * A mirror of the `FabricValuePlus` family and the `FabricExecPlainObject`
 * alias as `@commonfabric/api` declares them, for a program that resolves no
 * package specifier. The generator identifies the base by name, so the name
 * is what has to match.
 */
const EXEC_PLAIN_OBJECT_MIRROR = `
  type FabricValue = string | number | boolean | null;
  type FabricExecFunction = (...args: any[]) => any;
  type FabricValuePlus<P> =
    | FabricValue
    | P
    | FabricArrayPlus<P>
    | FabricPlainObjectPlus<P>;
  interface FabricArrayPlus<P> extends ReadonlyArray<FabricValuePlus<P>> {}
  interface FabricPlainObjectPlus<P>
    extends Readonly<Record<string, FabricValuePlus<P>>> {}
  type FabricExecPlainObject = FabricPlainObjectPlus<FabricExecFunction>;
`;

describe("SchemaGenerator", () => {
  describe("formatter chain", () => {
    it("should route primitive types to PrimitiveFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker } = await getTypeFromCode(
        "type MyString = string;",
        "MyString",
      );

      const schema = generator.generateSchema(type, checker);
      expect(typeof schema).toBe("object");
      expect((schema as any).type).toBe("string");
    });

    it("should route object types to ObjectFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker } = await getTypeFromCode(
        "interface MyObject { name: string; age: number; }",
        "MyObject",
      );

      const schema = generator.generateSchema(type, checker);
      expect(typeof schema).toBe("object");
      expect((schema as any).type).toBe("object");
      expect((schema as any).properties).toBeDefined();
      expect((schema as any).properties?.name).toEqual({ type: "string" });
      expect((schema as any).properties?.age).toEqual({ type: "number" });
    });

    it("should route array types to ArrayFormatter", async () => {
      const generator = new SchemaGenerator();
      const { type, checker, typeNode } = await getTypeFromCode(
        "type MyArray = string[];",
        "MyArray",
      );

      const schema = generator.generateSchema(type, checker, typeNode);
      expect(typeof schema).toBe("object");
      expect((schema as any).type).toBe("array");
      expect((schema as any).items).toBeDefined();
    });
  });

  describe("jsdoc integration", () => {
    it("prefers the comment closest to the type declaration", async () => {
      const generator = new SchemaGenerator();
      const code = `/*** Tool ***/

/**
 * Calculate the result of a mathematical expression.
 * Supports +, -, *, /, and parentheses.
 */
type CalculatorRequest = {
  /** The mathematical expression to evaluate. */
  expression: string;
};`;

      const { type, checker, typeNode } = await getTypeFromCode(
        code,
        "CalculatorRequest",
      );

      const schema = generator.generateSchema(type, checker, typeNode);
      const typedSchema = schema as Record<string, unknown>;
      const properties = typedSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(typedSchema.description).toBe(
        "Calculate the result of a mathematical expression.\n" +
          "Supports +, -, *, /, and parentheses.",
      );
      expect(properties?.expression?.description).toBe(
        "The mathematical expression to evaluate.",
      );
    });
  });

  describe("error handling", () => {
    it("should handle unknown types gracefully", async () => {
      const generator = new SchemaGenerator();
      // TypeScript 'unknown' type is handled by PrimitiveFormatter
      const { type, checker, typeNode } = await getTypeFromCode(
        "type T = unknown;",
        "T",
      );
      const schema = generator.generateSchema(type, checker, typeNode);
      // unknown returns { type: "unknown" } to distinguish from any (true)
      expect(schema).toEqual({ type: "unknown" });
    });
  });

  describe("synthetic readonly arrays", () => {
    // The checker prints a ReadonlyArray as the `readonly T[]` type-operator
    // form, and a synthetic result type built from a cell read is exactly
    // that: `cell.get()` on a `Cell<T[]>` reads back `readonly T[]`. The
    // node-based analyzer used to have no branch for the operator node and
    // fell through to the accept-anything fallback, so a read of `unknown[]`
    // — the reference-only declaration — came out as `true`.
    const readonlyArrayOf = (element: ts.TypeNode) =>
      ts.factory.createTypeOperatorNode(
        ts.SyntaxKind.ReadonlyKeyword,
        ts.factory.createArrayTypeNode(element),
      );

    it("keeps the element shape of a synthetic `readonly unknown[]`", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      const schema = generator.generateSchemaFromSyntheticTypeNode(
        readonlyArrayOf(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("array");
      expect(schema.items).toEqual({ type: "unknown" });
    });

    it("keeps the element shape of a synthetic `readonly string[]`", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      const schema = generator.generateSchemaFromSyntheticTypeNode(
        readonlyArrayOf(
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ),
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("array");
      expect(schema.items).toEqual({ type: "string" });
    });

    it("analyzes through `readonly` to a synthetic object element", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      const schema = generator.generateSchemaFromSyntheticTypeNode(
        readonlyArrayOf(
          ts.factory.createTypeLiteralNode([
            ts.factory.createPropertySignature(
              undefined,
              ts.factory.createIdentifier("id"),
              undefined,
              ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            ),
          ]),
        ),
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("array");
      expect(schema.items).toEqual({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      });
    });
  });

  describe("synthetic nodes a cell read prints its type through", () => {
    // The type printer hands the node-based analyzer these forms for a
    // pattern-scope cell read whose type contains `unknown`: `Readonly<{…}>`
    // (an alias reference), a tuple, an intersection, a parenthesized type.
    // Each used to fall to the accept-anything fallback or, for a library
    // alias, to the alias's UNINSTANTIATED declared type — an empty object.
    // The alias rules apply only to the default library's aliases, resolved
    // in the source file's scope, so the tests carry a source file.
    const f = ts.factory;
    const unknownNode = () =>
      f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    const stringNode = () =>
      f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    const literal = (members: [string, ts.TypeNode, boolean?][]) =>
      f.createTypeLiteralNode(
        members.map(([name, type, optional]) =>
          f.createPropertySignature(
            undefined,
            f.createIdentifier(name),
            optional ? f.createToken(ts.SyntaxKind.QuestionToken) : undefined,
            type,
          )
        ),
      );
    const alias = (name: string, ...args: ts.TypeNode[]) =>
      f.createTypeReferenceNode(f.createIdentifier(name), args);
    // A boolean schema comes back as it is: `false` and `true` must stay
    // apart for an assertion that nothing is accepted to mean it.
    const generate = async (node: ts.TypeNode) => {
      const { checker, sourceFile } = await createTestProgram(
        "type Dummy = unknown;",
      );
      const result = new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        node,
        checker,
        undefined,
        undefined,
        sourceFile,
      );
      if (typeof result === "boolean") return result;
      const { $schema: _schema, ...schema } = result as Record<string, unknown>;
      return schema;
    };

    it("applies `Readonly<{…}>` to the object it wraps", async () => {
      expect(
        await generate(
          alias(
            "Readonly",
            literal([["topic", unknownNode()], ["title", stringNode()]]),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: { topic: { type: "unknown" }, title: { type: "string" } },
        required: ["topic", "title"],
      });
    });

    it("applies `Partial`, `Required`, `Pick` and `Omit` structurally", async () => {
      const shape = () =>
        literal([["a", unknownNode()], ["b", stringNode(), true]]);
      expect(await generate(alias("Partial", shape()))).toEqual({
        type: "object",
        properties: { a: { type: "unknown" }, b: { type: "string" } },
      });
      expect(await generate(alias("Required", shape()))).toEqual({
        type: "object",
        properties: { a: { type: "unknown" }, b: { type: "string" } },
        required: ["a", "b"],
      });
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      expect(await generate(alias("Pick", shape(), key("a")))).toEqual({
        type: "object",
        properties: { a: { type: "unknown" } },
        required: ["a"],
      });
      expect(await generate(alias("Omit", shape(), key("a")))).toEqual({
        type: "object",
        properties: { b: { type: "string" } },
      });
    });

    it("applies `Record` and `Array` to their arguments", async () => {
      expect(await generate(alias("Record", stringNode(), unknownNode())))
        .toEqual({
          type: "object",
          properties: {},
          additionalProperties: { type: "unknown" },
        });
      expect(await generate(alias("ReadonlyArray", unknownNode()))).toEqual({
        type: "array",
        items: { type: "unknown" },
      });
    });

    it("applies `Readonly<…>` over a union, arm by arm", async () => {
      // The shape a cell typed `Record<string, unknown> | Default<{}>` reads
      // back as: the empty-object default arm does not collapse into the
      // record, so the alias wraps a union. Built here as nodes, since `{}`
      // as source is banned by lint.
      expect(
        await generate(
          alias(
            "Readonly",
            f.createUnionTypeNode([
              f.createTypeLiteralNode([]),
              alias("Record", stringNode(), unknownNode()),
            ]),
          ),
        ),
      ).toEqual({
        anyOf: [
          { type: "object", properties: {} },
          {
            type: "object",
            properties: {},
            additionalProperties: { type: "unknown" },
          },
        ],
      });
    });

    it("lowers a tuple to an array of its element union, deduplicated", async () => {
      expect(
        await generate(f.createTupleTypeNode([unknownNode(), stringNode()])),
      )
        .toEqual({
          type: "array",
          items: { anyOf: [{ type: "unknown" }, { type: "string" }] },
        });
      expect(
        await generate(f.createTupleTypeNode([unknownNode(), unknownNode()])),
      )
        .toEqual({ type: "array", items: { type: "unknown" } });
    });

    it("merges an intersection of object types and unwraps parentheses", async () => {
      expect(
        await generate(
          f.createIntersectionTypeNode([
            literal([["a", unknownNode()]]),
            literal([["b", stringNode()]]),
          ]),
        ),
      ).toEqual({
        type: "object",
        properties: { a: { type: "unknown" }, b: { type: "string" } },
        required: ["a", "b"],
      });
      expect(
        await generate(
          f.createParenthesizedType(f.createArrayTypeNode(unknownNode())),
        ),
      ).toEqual({ type: "array", items: { type: "unknown" } });
    });

    it("applies `NonNullable` by dropping the null and undefined arms", async () => {
      const object = () => literal([["a", unknownNode()]]);
      const nullNode = () => f.createLiteralTypeNode(f.createNull());
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      // One arm left: that arm, unwrapped.
      expect(
        await generate(
          alias(
            "NonNullable",
            f.createUnionTypeNode([object(), nullNode(), undefinedNode()]),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: { a: { type: "unknown" } },
        required: ["a"],
      });
      // Several arms left: the union of them.
      expect(
        await generate(
          alias(
            "NonNullable",
            f.createUnionTypeNode([object(), stringNode(), nullNode()]),
          ),
        ),
      ).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "unknown" } },
            required: ["a"],
          },
          { type: "string" },
        ],
      });
      // Nothing left: nothing accepted.
      expect(
        await generate(
          alias(
            "NonNullable",
            f.createUnionTypeNode([nullNode(), undefinedNode()]),
          ),
        ),
      ).toBe(false);
      // Not a union: unchanged.
      expect(await generate(alias("NonNullable", stringNode()))).toEqual({
        type: "string",
      });
    });

    it("applies `Array` and `Record` with literal keys", async () => {
      expect(await generate(alias("Array", unknownNode()))).toEqual({
        type: "array",
        items: { type: "unknown" },
      });
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      expect(
        await generate(
          alias(
            "Record",
            f.createUnionTypeNode([key("a"), key("b")]),
            unknownNode(),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: { a: { type: "unknown" }, b: { type: "unknown" } },
        required: ["a", "b"],
      });
      expect(
        await generate(
          alias(
            "Omit",
            literal([["a", unknownNode()], ["b", stringNode()], [
              "c",
              stringNode(),
            ]]),
            f.createUnionTypeNode([key("a"), key("b")]),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: { c: { type: "string" } },
        required: ["c"],
      });
    });

    it("leaves a non-object argument to Partial, Required and Pick unchanged", async () => {
      const key = f.createLiteralTypeNode(f.createStringLiteral("length"));
      expect(await generate(alias("Partial", stringNode()))).toEqual({
        type: "string",
      });
      expect(await generate(alias("Required", stringNode()))).toEqual({
        type: "string",
      });
      expect(await generate(alias("Pick", stringNode(), key))).toEqual({
        type: "string",
      });
    });

    it("leaves a reference the rules cannot express to the general path", async () => {
      // The general path resolves the library alias by name to its
      // uninstantiated declared type, which reads as an empty object; that
      // is what these fall back to, rather than a wrong application.
      const shape = () => literal([["a", unknownNode()], ["b", stringNode()]]);
      const generalObject = { type: "object", properties: {} };
      // A key set the rules cannot enumerate.
      expect(
        await generate(
          alias(
            "Pick",
            shape(),
            f.createTypeOperatorNode(ts.SyntaxKind.KeyOfKeyword, shape()),
          ),
        ),
      ).toEqual(generalObject);
      // Too few arguments.
      expect(await generate(alias("Pick", shape()))).toEqual(generalObject);
      expect(await generate(alias("Record", stringNode()))).toEqual(
        generalObject,
      );
      // A key type that is not a string, number, or literal list.
      expect(
        await generate(
          alias(
            "Record",
            f.createKeywordTypeNode(ts.SyntaxKind.SymbolKeyword),
            unknownNode(),
          ),
        ),
      ).toEqual(generalObject);
      // No arguments at all.
      expect(await generate(alias("Array"))).toEqual({
        type: "array",
        items: {},
      });
    });

    it("cannot apply a library alias without a scope to resolve the name in", async () => {
      // No source file, so the name cannot be resolved to a library
      // declaration; the reference falls through to the accept-anything
      // fallback, as it did before the alias rules.
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      expect(
        new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
          alias("Readonly", literal([["a", unknownNode()]])),
          checker,
        ),
      ).toBe(true);
    });

    it("leaves an imported shadow of a library name to the general path", async () => {
      // The name is resolved lexically, so an import alias shadows the
      // library's declaration the way it does for the checker.
      const { checker, sourceFile } = await createTestProgramFromFiles(
        {
          "/other.ts": "export type Readonly<T> = { shadow: true };",
          "/main.ts": "import type { Readonly } from './other.ts';\n" +
            "export type Keep = Readonly<{ a: 1 }>;",
        },
        "/main.ts",
      );
      const { $schema: _schema, ...schema } = new SchemaGenerator()
        .generateSchemaFromSyntheticTypeNode(
          alias("Readonly", literal([["a", unknownNode()]])),
          checker,
          undefined,
          undefined,
          sourceFile,
        ) as Record<string, unknown>;
      // What is pinned is the routing: the library's rule is not applied, so
      // the argument's member does not reach the schema. What the general
      // path makes of the shadow's own surface is that path's matter.
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties as Record<string, unknown>)).not
        .toContain("a");
    });

    // Named authored types analyze to a reference into the definitions, so
    // the rules must read the shape behind the reference — and must not alter
    // that shared definition while deriving a view of it.
    const NAMED = [
      "export {};",
      "type Foo = { x: unknown; y: string };",
      "type Bar = { z: number };",
      "type Maybe = { x?: unknown; y?: string };",
      "type Nullable = string | null | undefined;",
      "type Both = string | number | null;",
      'type Lit = "a" | "b" | null;',
      'type A = { payload: unknown; kind: "a"; left: string };',
      'type B = { payload: unknown; kind: "b"; right: number };',
      "type Either = A | B;",
      'type Nested = Either | { payload: unknown; kind: "c" };',
      'type Correlated = { first: "a"; second: 1 } | { first: "b"; second: 2 };',
      "type Loose = { x?: unknown; y: string } | { x: unknown; y?: string };",
      "type Rec = Record<string, string>;",
      "type RecU = Record<string, unknown>;",
      "type RecO = Record<string, { topic: unknown }>;",
      "type XOpt = { x?: unknown; y: string };",
      "type Mixed = { x: unknown; y: string; [k: string]: unknown };",
      "type Pair = [string, number];",
      "type OptPair = [string, number?];",
      "type ExplicitU = [string | undefined];",
      "type RO = readonly [string, number?];",
      "type Gen<T> = [T?];",
      "type Never = Record<string, never>;",
      "type Tail = [string | undefined];",
      "type TU = [Foo, string | undefined] | [number];",
      "type Loop = [string] | Loop;",
      "type MaybeTuple = [Foo, string | undefined] | null | undefined;",
      "type Nil = null;",
      'type AB = "a" | "b";',
      "type SNN = string | number | null;",
      "type SNU = string | number | undefined;",
    ].join("\n");
    const generateNamed = async (node: ts.TypeNode) => {
      const { checker, sourceFile } = await createTestProgram(NAMED);
      const result = new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        node,
        checker,
        undefined,
        undefined,
        sourceFile,
      );
      if (typeof result !== "object" || result === null) return result;
      const { $schema: _schema, $defs, ...schema } = result as Record<
        string,
        unknown
      >;
      return { schema, $defs };
    };
    const foo = {
      type: "object",
      properties: { x: { type: "unknown" }, y: { type: "string" } },
      required: ["x", "y"],
    };

    it("applies a mapped alias to the definition a named type refers to", async () => {
      // The view is inline; a definition nothing references is not emitted.
      expect(
        ((await generateNamed(alias("Partial", alias("Foo")))) as {
          schema: unknown;
        }).schema,
      ).toEqual({
        type: "object",
        properties: { x: { type: "unknown" }, y: { type: "string" } },
      });
      expect(
        ((await generateNamed(alias("Required", alias("Maybe")))) as {
          schema: unknown;
        }).schema,
      ).toEqual({
        type: "object",
        properties: { x: { type: "unknown" }, y: { type: "string" } },
        required: ["x", "y"],
      });
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      expect(
        ((await generateNamed(alias("Pick", alias("Foo"), key("x")))) as {
          schema: unknown;
        }).schema,
      ).toEqual({
        type: "object",
        properties: { x: { type: "unknown" } },
        required: ["x"],
      });
      expect(
        ((await generateNamed(alias("Omit", alias("Foo"), key("y")))) as {
          schema: unknown;
        }).schema,
      ).toEqual({
        type: "object",
        properties: { x: { type: "unknown" } },
        required: ["x"],
      });
    });

    it("applies a mapped alias to each arm of a union", async () => {
      expect(
        await generate(
          alias(
            "Partial",
            f.createUnionTypeNode([
              literal([["x", unknownNode()]]),
              literal([["y", unknownNode()]]),
            ]),
          ),
        ),
      ).toEqual({
        anyOf: [
          { type: "object", properties: { x: { type: "unknown" } } },
          { type: "object", properties: { y: { type: "unknown" } } },
        ],
      });
    });

    it("derives a mapped view without altering the shared definition", async () => {
      const result = (await generateNamed(
        literal([["a", alias("Partial", alias("Foo"))], ["b", alias("Foo")]]),
      )) as { schema: Record<string, unknown>; $defs: Record<string, unknown> };
      expect(result.schema).toEqual({
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: { x: { type: "unknown" }, y: { type: "string" } },
          },
          b: { $ref: "#/$defs/Foo" },
        },
        required: ["a", "b"],
      });
      expect(result.$defs).toEqual({ Foo: foo });
    });

    it("applies `Pick` and `Omit` to the surface a union's arms share", async () => {
      // `keyof (A | B)` is the keys both arms have, so the view is one object
      // over them — not a view per arm, which would keep `left` or `right`
      // and require one of them.
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      const payloadOnly = {
        type: "object",
        properties: { payload: { type: "unknown" } },
        required: ["payload"],
      };
      expect(
        ((await generateNamed(
          alias(
            "Omit",
            f.createUnionTypeNode([alias("A"), alias("B")]),
            key("kind"),
          ),
        )) as { schema: unknown }).schema,
      ).toEqual(payloadOnly);
      expect(
        ((await generateNamed(alias("Omit", alias("Either"), key("kind")))) as {
          schema: unknown;
        }).schema,
      ).toEqual(payloadOnly);
      // A union nested through references is flattened to its arms.
      expect(
        ((await generateNamed(alias("Omit", alias("Nested"), key("kind")))) as {
          schema: unknown;
        }).schema,
      ).toEqual(payloadOnly);
      // A shared property accepts what any arm's does, so values two arms
      // pair may mix, as `Pick<Correlated, …>` lets them.
      expect(
        ((await generateNamed(
          alias(
            "Pick",
            alias("Correlated"),
            f.createUnionTypeNode([key("first"), key("second")]),
          ),
        )) as { schema: unknown }).schema,
      ).toEqual({
        type: "object",
        properties: {
          first: {
            anyOf: [
              { type: "string", enum: ["a"] },
              { type: "string", enum: ["b"] },
            ],
          },
          second: {
            anyOf: [
              { type: "number", enum: [1] },
              { type: "number", enum: [2] },
            ],
          },
        },
        required: ["first", "second"],
      });
      // Required only where every arm requires it.
      expect(
        ((await generateNamed(
          alias(
            "Pick",
            alias("Loose"),
            f.createUnionTypeNode([key("x"), key("y")]),
          ),
        )) as { schema: unknown }).schema,
      ).toEqual({
        type: "object",
        properties: { x: { type: "unknown" }, y: { type: "string" } },
      });
      // The definitions the view read stay as they were.
      const result = (await generateNamed(
        literal([["a", alias("Omit", alias("Either"), key("kind"))], [
          "b",
          alias("Either"),
        ]]),
      )) as { schema: unknown; $defs: Record<string, unknown> };
      expect(result.schema).toEqual({
        type: "object",
        properties: { a: payloadOnly, b: { $ref: "#/$defs/Either" } },
        required: ["a", "b"],
      });
      expect(result.$defs).toEqual({
        Either: { anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }] },
        A: {
          type: "object",
          properties: {
            payload: { type: "unknown" },
            kind: { type: "string", enum: ["a"] },
            left: { type: "string" },
          },
          required: ["payload", "kind", "left"],
        },
        B: {
          type: "object",
          properties: {
            payload: { type: "unknown" },
            kind: { type: "string", enum: ["b"] },
            right: { type: "number" },
          },
          required: ["payload", "kind", "right"],
        },
      });
    });

    it("leaves a union view the rules cannot express to the general path", async () => {
      // A `Pick` of a key one arm lacks is a program the checker rejects; a
      // union with an arm that is no object has no shared surface to view.
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      const generalObject = { type: "object", properties: {} };
      expect(
        ((await generateNamed(alias("Pick", alias("Either"), key("left")))) as {
          schema: unknown;
        }).schema,
      ).toEqual(generalObject);
      expect(
        ((await generateNamed(
          alias(
            "Omit",
            f.createUnionTypeNode([alias("A"), stringNode()]),
            key("kind"),
          ),
        )) as { schema: unknown }).schema,
      ).toEqual(generalObject);
    });

    it("keeps an index signature through `Pick` and `Omit`", async () => {
      // An index signature covers every key: a `Pick` of a key it covers
      // takes its schema, an `Omit` from a surface it covers keeps only the
      // signature — the named members fall inside it, as in `keyof T`.
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      expect(await schemaOf(alias("Omit", alias("Rec"), key("x")))).toEqual({
        type: "object",
        properties: {},
        additionalProperties: { type: "string" },
      });
      expect(await schemaOf(alias("Pick", alias("RecU"), key("x")))).toEqual({
        type: "object",
        properties: { x: { type: "unknown" } },
        required: ["x"],
      });
      expect(await schemaOf(alias("Omit", alias("RecO"), key("x")))).toEqual({
        type: "object",
        properties: {},
        additionalProperties: {
          type: "object",
          properties: { topic: { type: "unknown" } },
          required: ["topic"],
        },
      });
      expect(await schemaOf(alias("Omit", alias("Mixed"), key("z")))).toEqual({
        type: "object",
        properties: {},
        additionalProperties: { type: "unknown" },
      });
      expect(await schemaOf(alias("Pick", alias("Mixed"), key("x")))).toEqual({
        type: "object",
        properties: { x: { type: "unknown" } },
        required: ["x"],
      });
    });

    it("reads a union's shared surface through an indexed arm", async () => {
      // A key an arm covers only by its signature takes the signature's
      // schema there and casts no vote on being required; the arms that
      // name it decide that. `unknown` stays beside the other arm's schema,
      // as it does in every union this path builds.
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const stringOrUnknown = {
        anyOf: [{ type: "string" }, { type: "unknown" }],
      };
      expect(
        await schemaOf(
          alias(
            "Omit",
            f.createUnionTypeNode([alias("Foo"), alias("RecU")]),
            key("z"),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: { x: { type: "unknown" }, y: stringOrUnknown },
        required: ["x", "y"],
      });
      expect(
        await schemaOf(
          alias(
            "Pick",
            f.createUnionTypeNode([alias("Rec"), alias("Foo")]),
            key("x"),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: { x: stringOrUnknown },
        required: ["x"],
      });
      expect(
        await schemaOf(
          alias(
            "Omit",
            f.createUnionTypeNode([alias("XOpt"), alias("RecU")]),
            key("z"),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: { x: { type: "unknown" }, y: stringOrUnknown },
        required: ["y"],
      });
      expect(
        await schemaOf(
          alias(
            "Omit",
            f.createUnionTypeNode([alias("Rec"), alias("RecU")]),
            key("x"),
          ),
        ),
      ).toEqual({
        type: "object",
        properties: {},
        additionalProperties: stringOrUnknown,
      });
    });

    it("opens a rest element's tuple through its reference", async () => {
      // A named tuple is opened to its declaration and spread element by
      // element, an optional element's `undefined` included, rather than
      // contributed as the reference it analyzes to. A rest element's own
      // union of elements lies flat in the items.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      expect(
        await schemaOf(
          f.createTupleTypeNode([
            alias("Foo"),
            f.createRestTypeNode(alias("Pair")),
          ]),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "number" },
          ],
        },
      });
      expect(
        await schemaOf(
          f.createTupleTypeNode([
            alias("Foo"),
            f.createRestTypeNode(alias("OptPair")),
          ]),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "number" },
            { type: "undefined" },
          ],
        },
      });
      expect(
        await schemaOf(
          f.createTupleTypeNode([
            alias("Foo"),
            f.createRestTypeNode(
              f.createArrayTypeNode(
                f.createParenthesizedType(
                  f.createUnionTypeNode([
                    stringNode(),
                    f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
                  ]),
                ),
              ),
            ),
          ]),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "number" },
          ],
        },
      });
    });

    it("applies `Partial` and `Required` to an array's elements", async () => {
      // An array's elements count as optional: `Partial` admits `undefined`
      // into them, `Required` removes it — and only it.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      const fooOrUndefined = {
        type: "array",
        items: { anyOf: [{ $ref: "#/$defs/Foo" }, { type: "undefined" }] },
      };
      expect(
        await schemaOf(alias("Partial", f.createArrayTypeNode(alias("Foo")))),
      ).toEqual(fooOrUndefined);
      expect(
        await schemaOf(
          alias(
            "Partial",
            f.createTypeOperatorNode(
              ts.SyntaxKind.ReadonlyKeyword,
              f.createArrayTypeNode(alias("Foo")),
            ),
          ),
        ),
      ).toEqual(fooOrUndefined);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createArrayTypeNode(
              f.createParenthesizedType(
                f.createUnionTypeNode([alias("Foo"), undefinedNode()]),
              ),
            ),
          ),
        ),
      ).toEqual({ type: "array", items: { $ref: "#/$defs/Foo" } });
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createArrayTypeNode(
              f.createParenthesizedType(
                f.createUnionTypeNode([
                  alias("Foo"),
                  f.createLiteralTypeNode(f.createNull()),
                  undefinedNode(),
                ]),
              ),
            ),
          ),
        ),
      ).toEqual({
        type: "array",
        items: { anyOf: [{ $ref: "#/$defs/Foo" }, { type: "null" }] },
      });
      // Nothing to remove, an interface rather than an alias to open.
      expect(
        await schemaOf(alias("Required", alias("Array", stringNode()))),
      ).toEqual({ type: "array", items: { type: "string" } });
      // Distributes, an arm of each kind.
      expect(
        await schemaOf(
          alias(
            "Partial",
            f.createUnionTypeNode([
              f.createArrayTypeNode(alias("Foo")),
              alias("Foo"),
            ]),
          ),
        ),
      ).toEqual({
        anyOf: [
          fooOrUndefined,
          {
            type: "object",
            properties: { x: { type: "unknown" }, y: { type: "string" } },
          },
        ],
      });
    });

    it("lowers a tuple under `Required` from its node", async () => {
      // Only the node still tells an optional element's `undefined` from an
      // authored one: the optional element loses both, the plain element
      // keeps what it authored, a rest element's items lose `undefined`. The
      // node is reached through parentheses, `readonly`, and a reference to
      // a non-generic alias declared as a tuple.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      const numberNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([f.createOptionalTypeNode(alias("Foo"))]),
          ),
        ),
      ).toEqual({ type: "array", items: { $ref: "#/$defs/Foo" } });
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createOptionalTypeNode(
                f.createParenthesizedType(
                  f.createUnionTypeNode([stringNode(), undefinedNode()]),
                ),
              ),
            ]),
          ),
        ),
      ).toEqual({ type: "array", items: { type: "string" } });
      expect(await schemaOf(alias("Required", alias("ExplicitU")))).toEqual({
        type: "array",
        items: { type: ["string", "undefined"] },
      });
      const stringOrNumber = {
        type: "array",
        items: { anyOf: [{ type: "string" }, { type: "number" }] },
      };
      expect(await schemaOf(alias("Required", alias("OptPair")))).toEqual(
        stringOrNumber,
      );
      expect(await schemaOf(alias("Required", alias("RO")))).toEqual(
        stringOrNumber,
      );
      expect(
        await schemaOf(
          alias("Required", f.createParenthesizedType(alias("OptPair"))),
        ),
      ).toEqual(stringOrNumber);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              stringNode(),
              f.createOptionalTypeNode(numberNode()),
              f.createRestTypeNode(
                f.createArrayTypeNode(
                  f.createParenthesizedType(
                    f.createUnionTypeNode([
                      f.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
                      undefinedNode(),
                    ]),
                  ),
                ),
              ),
            ]),
          ),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        },
      });
      // `Partial` needs no node: every element admits `undefined`.
      expect(await schemaOf(alias("Partial", alias("Pair")))).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: ["number", "string"] }, { type: "undefined" }],
        },
      });
      // A generic alias is not opened; the general path reads its
      // uninstantiated declaration, as it does for any generic reference.
      expect(
        await schemaOf(alias("Required", alias("Gen", stringNode()))),
      ).toEqual({ type: "array", items: {} });
    });

    it("keeps a never-valued signature's key surface", async () => {
      // `additionalProperties: false` is a `never`-valued index signature —
      // this generator writes nothing for a closed object — and its keys
      // are still keys: picked, they hold nothing; omitted from, the
      // signature stays; beside a named arm, the name and its requirement
      // survive.
      const key = (text: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(text));
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const topicOnly = {
        type: "object",
        properties: { topic: { type: "unknown" } },
        required: ["topic"],
      };
      expect(
        await schemaOf(
          alias(
            "Pick",
            f.createUnionTypeNode([
              alias("Never"),
              literal([["topic", unknownNode()]]),
            ]),
            key("topic"),
          ),
        ),
      ).toEqual(topicOnly);
      expect(
        await schemaOf(
          alias(
            "Omit",
            f.createUnionTypeNode([
              alias("Never"),
              literal([["topic", unknownNode()]]),
            ]),
            key("unused"),
          ),
        ),
      ).toEqual(topicOnly);
      expect(await schemaOf(alias("Pick", alias("Never"), key("x")))).toEqual({
        type: "object",
        properties: { x: false },
        required: ["x"],
      });
      expect(await schemaOf(alias("Omit", alias("Never"), key("x")))).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      // `keyof (Foo | Never)` is Foo's keys; omitting them all leaves `{}`.
      expect(
        await schemaOf(
          alias(
            "Omit",
            f.createUnionTypeNode([alias("Foo"), alias("Never")]),
            f.createUnionTypeNode([key("x"), key("y")]),
          ),
        ),
      ).toEqual({ type: "object", properties: {} });
    });

    it("keeps an authored `undefined` through a spread and a union under `Required`", async () => {
      // A spread tuple expands into its own elements, each with its own
      // optionality; a union is viewed member by member. Neither turns a
      // plain element's authored `undefined` into optionality to remove.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      const numberNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      const fooThenTail = {
        type: "array",
        items: {
          anyOf: [{ $ref: "#/$defs/Foo" }, { type: ["string", "undefined"] }],
        },
      };
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              alias("Foo"),
              f.createRestTypeNode(alias("Tail")),
            ]),
          ),
        ),
      ).toEqual(fooThenTail);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              alias("Foo"),
              f.createRestTypeNode(
                f.createTupleTypeNode([
                  f.createUnionTypeNode([stringNode(), undefinedNode()]),
                ]),
              ),
            ]),
          ),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "undefined" },
          ],
        },
      });
      const fooThenTailOrNumber = {
        anyOf: [fooThenTail, { type: "array", items: { type: "number" } }],
      };
      expect(await schemaOf(alias("Required", alias("TU")))).toEqual(
        fooThenTailOrNumber,
      );
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createUnionTypeNode([
              f.createTupleTypeNode([
                alias("Foo"),
                f.createUnionTypeNode([stringNode(), undefinedNode()]),
              ]),
              f.createTupleTypeNode([numberNode()]),
            ]),
          ),
        ),
      ).toEqual({
        anyOf: [
          {
            type: "array",
            items: {
              anyOf: [
                { $ref: "#/$defs/Foo" },
                { type: "string" },
                { type: "undefined" },
              ],
            },
          },
          { type: "array", items: { type: "number" } },
        ],
      });
      // Optionality, spread or in a union, still goes.
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              alias("Foo"),
              f.createRestTypeNode(alias("OptPair")),
            ]),
          ),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "number" },
          ],
        },
      });
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createUnionTypeNode([
              f.createTupleTypeNode([f.createOptionalTypeNode(alias("Foo"))]),
              f.createTupleTypeNode([f.createOptionalTypeNode(numberNode())]),
            ]),
          ),
        ),
      ).toEqual({
        anyOf: [
          { type: "array", items: { $ref: "#/$defs/Foo" } },
          { type: "array", items: { type: "number" } },
        ],
      });
      // A circular alias — an error the checker reports — is opened once;
      // met again it is the reference it is, which the checker types as
      // anything.
      expect(await generateNamed(alias("Required", alias("Loop")))).toBe(true);
    });

    it("normalizes tuple optionality after expanding spreads, before `Required`", async () => {
      // The checker makes an optional slot that a required slot follows
      // required, `undefined` in what it holds; `Required` then keeps that
      // `undefined`. A slot followed only by optional or rest slots stays
      // optional and loses it.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const numberNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      const fooUndefinedNumber = {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "undefined" },
            { type: "number" },
          ],
        },
      };
      const fooNumber = {
        type: "array",
        items: { anyOf: [{ $ref: "#/$defs/Foo" }, { type: "number" }] },
      };
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createOptionalTypeNode(alias("Foo")),
              f.createRestTypeNode(f.createTupleTypeNode([numberNode()])),
            ]),
          ),
        ),
      ).toEqual(fooUndefinedNumber);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createRestTypeNode(
                f.createTupleTypeNode([f.createOptionalTypeNode(alias("Foo"))]),
              ),
              numberNode(),
            ]),
          ),
        ),
      ).toEqual(fooUndefinedNumber);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createOptionalTypeNode(alias("Foo")),
              f.createRestTypeNode(f.createArrayTypeNode(numberNode())),
            ]),
          ),
        ),
      ).toEqual(fooNumber);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createOptionalTypeNode(alias("Foo")),
              f.createRestTypeNode(
                f.createTupleTypeNode([f.createOptionalTypeNode(numberNode())]),
              ),
            ]),
          ),
        ),
      ).toEqual(fooNumber);
      const fooUndefinedTail = {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "undefined" },
            { type: ["string", "undefined"] },
          ],
        },
      };
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createOptionalTypeNode(alias("Foo")),
              f.createRestTypeNode(alias("Tail")),
            ]),
          ),
        ),
      ).toEqual(fooUndefinedTail);
      // One alternative keeps the slot optional, the other makes it
      // required; the items form holds both.
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createOptionalTypeNode(alias("Foo")),
              f.createRestTypeNode(
                f.createParenthesizedType(
                  f.createUnionTypeNode([
                    alias("Tail"),
                    f.createTupleTypeNode([]),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ).toEqual(fooUndefinedTail);
      // As authored, the normalized slot reads the same as an optional one.
      expect(
        await schemaOf(
          f.createTupleTypeNode([
            f.createOptionalTypeNode(alias("Foo")),
            numberNode(),
          ]),
        ),
      ).toEqual(fooUndefinedNumber);
    });

    it("keeps a tuple's slots through the library's wrappers under `Required`", async () => {
      // `Readonly`, `NonNullable`, `Required`, and `Partial` are opened onto
      // the slots they wrap — the last two applied there — so the outer
      // `Required` still sees which `undefined` is authored.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      const numberNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      const fooStringOrUndefined = () =>
        f.createTupleTypeNode([
          alias("Foo"),
          f.createUnionTypeNode([stringNode(), undefinedNode()]),
        ]);
      const keptUndefined = {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "undefined" },
          ],
        },
      };
      for (const wrapper of ["Readonly", "Required", "NonNullable"]) {
        expect(
          await schemaOf(
            alias("Required", alias(wrapper, fooStringOrUndefined())),
          ),
        ).toEqual(keptUndefined);
      }
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              alias("Foo"),
              f.createRestTypeNode(
                alias(
                  "Readonly",
                  f.createTupleTypeNode([
                    f.createUnionTypeNode([stringNode(), undefinedNode()]),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ).toEqual(keptUndefined);
      // `Partial` makes every slot optional, so `Required` strips them all.
      expect(
        await schemaOf(
          alias("Required", alias("Partial", fooStringOrUndefined())),
        ),
      ).toEqual({
        type: "array",
        items: { anyOf: [{ $ref: "#/$defs/Foo" }, { type: "string" }] },
      });
      const fooUndefinedNumber = {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "undefined" },
            { type: "number" },
          ],
        },
      };
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "Readonly",
              f.createTupleTypeNode([
                f.createOptionalTypeNode(alias("Foo")),
                numberNode(),
              ]),
            ),
          ),
        ),
      ).toEqual(fooUndefinedNumber);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createRestTypeNode(
                alias("Partial", f.createTupleTypeNode([alias("Foo")])),
              ),
              numberNode(),
            ]),
          ),
        ),
      ).toEqual(fooUndefinedNumber);
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createRestTypeNode(
                alias(
                  "Partial",
                  f.createTupleTypeNode([
                    alias("Foo"),
                    f.createRestTypeNode(f.createArrayTypeNode(numberNode())),
                  ]),
                ),
              ),
              stringNode(),
            ]),
          ),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "undefined" },
            { type: "number" },
            { type: "string" },
          ],
        },
      });
    });

    it("spreads what a rest element names when it is no array", async () => {
      // A rest element over a non-array type is a program the checker
      // rejects; this path contributes what it names rather than nothing.
      expect(
        ((await generateNamed(
          f.createTupleTypeNode([
            alias("Foo"),
            f.createRestTypeNode(stringNode()),
          ]),
        )) as { schema: unknown }).schema,
      ).toEqual({
        type: "array",
        items: { anyOf: [{ $ref: "#/$defs/Foo" }, { type: "string" }] },
      });
    });

    it("distributes the library's wrappers over a union under `Required`", async () => {
      // The wrappers distribute over a union, `NonNullable` dropping its
      // `null` and `undefined` members, so each member is viewed wrapped as
      // the whole was: a tuple beside `null`, or beside an object, keeps
      // its slots, and only `NonNullable` removes the `null`.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      const nullNode = () => f.createLiteralTypeNode(f.createNull());
      const fooStringOrUndefined = () =>
        f.createTupleTypeNode([
          alias("Foo"),
          f.createUnionTypeNode([stringNode(), undefinedNode()]),
        ]);
      const keptUndefined = {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "undefined" },
          ],
        },
      };
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "NonNullable",
              f.createUnionTypeNode([fooStringOrUndefined(), nullNode()]),
            ),
          ),
        ),
      ).toEqual(keptUndefined);
      expect(
        await schemaOf(
          alias("Required", alias("NonNullable", alias("MaybeTuple"))),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [{ $ref: "#/$defs/Foo" }, { type: ["string", "undefined"] }],
        },
      });
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "Readonly",
              alias(
                "NonNullable",
                f.createUnionTypeNode([
                  fooStringOrUndefined(),
                  undefinedNode(),
                ]),
              ),
            ),
          ),
        ),
      ).toEqual(keptUndefined);
      // Optionality still goes.
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "NonNullable",
              f.createUnionTypeNode([
                f.createTupleTypeNode([f.createOptionalTypeNode(alias("Foo"))]),
                nullNode(),
              ]),
            ),
          ),
        ),
      ).toEqual({ type: "array", items: { $ref: "#/$defs/Foo" } });
      // A tuple beside an object: each viewed on its own.
      const fooRequired = {
        type: "object",
        properties: { x: { type: "unknown" }, y: { type: "string" } },
        required: ["x", "y"],
      };
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "NonNullable",
              f.createUnionTypeNode([fooStringOrUndefined(), alias("Foo")]),
            ),
          ),
        ),
      ).toEqual({ anyOf: [keptUndefined, fooRequired] });
      // Nested wrappers, `Partial` applied to the tuple's slots, and a
      // `null` that only `NonNullable` would remove.
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "Readonly",
              f.createUnionTypeNode([
                alias(
                  "Partial",
                  f.createUnionTypeNode([fooStringOrUndefined(), alias("Foo")]),
                ),
                nullNode(),
              ]),
            ),
          ),
        ),
      ).toEqual({
        anyOf: [
          {
            type: "array",
            items: { anyOf: [{ $ref: "#/$defs/Foo" }, { type: "string" }] },
          },
          fooRequired,
          { type: "null" },
        ],
      });
      // Two objects: distributed, each made required.
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "Readonly",
              f.createUnionTypeNode([
                alias("Foo"),
                literal([["a", stringNode(), true]]),
              ]),
            ),
          ),
        ),
      ).toEqual({
        anyOf: [
          fooRequired,
          {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
        ],
      });
    });

    it("keeps a tuple's slots beside an array in a spread union", async () => {
      // A spread over a union is one alternative per member: the tuple
      // member keeps its slots, the array member is held in a rest slot. So
      // `Required` keeps the tuple's authored `undefined`, and an optional
      // prefix is normalized against each alternative on its own.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      const numberNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      const stringOrUndefinedTuple = () =>
        f.createTupleTypeNode([
          f.createUnionTypeNode([stringNode(), undefinedNode()]),
        ]);
      const spreadOf = (...members: ts.TypeNode[]) =>
        f.createRestTypeNode(
          f.createParenthesizedType(f.createUnionTypeNode(members)),
        );
      const fooStringUndefinedNumber = {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "undefined" },
            { type: "number" },
          ],
        },
      };
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              alias("Foo"),
              spreadOf(
                stringOrUndefinedTuple(),
                f.createArrayTypeNode(numberNode()),
              ),
            ]),
          ),
        ),
      ).toEqual(fooStringUndefinedNumber);
      // The optional prefix is required, `undefined` and all, where a
      // required slot follows it, and stays optional beside the array.
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              f.createOptionalTypeNode(alias("Foo")),
              spreadOf(
                f.createTupleTypeNode([numberNode()]),
                f.createArrayTypeNode(stringNode()),
              ),
            ]),
          ),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "undefined" },
            { type: "number" },
            { type: "string" },
          ],
        },
      });
      // Through a wrapper, the array member's elements still count as
      // optional and lose `undefined`; the tuple member's do not.
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              alias("Foo"),
              f.createRestTypeNode(
                alias(
                  "Readonly",
                  f.createUnionTypeNode([
                    stringOrUndefinedTuple(),
                    f.createArrayTypeNode(
                      f.createParenthesizedType(
                        f.createUnionTypeNode([numberNode(), undefinedNode()]),
                      ),
                    ),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ).toEqual(fooStringUndefinedNumber);
      // As authored, the same items.
      expect(
        await schemaOf(
          f.createTupleTypeNode([
            alias("Foo"),
            spreadOf(
              stringOrUndefinedTuple(),
              f.createArrayTypeNode(numberNode()),
            ),
          ]),
        ),
      ).toEqual(fooStringUndefinedNumber);
    });

    it("drops a nullish member under `NonNullable` however it is spelled", async () => {
      // `Nil` and `(null)` are `null` as much as the bare keyword is; the
      // member is classified by what it opens to, and dropped it is no
      // alternative at all — not a failed read that sends the whole spread
      // to the array reading.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      const undefinedNode = () =>
        f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      const nullNode = () => f.createLiteralTypeNode(f.createNull());
      const stringOrUndefined = () =>
        f.createUnionTypeNode([stringNode(), undefinedNode()]);
      const keptUndefined = {
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: "string" },
            { type: "undefined" },
          ],
        },
      };
      for (
        const nullish of [
          () => alias("Nil"),
          () => f.createParenthesizedType(nullNode()),
          nullNode,
        ]
      ) {
        expect(
          await schemaOf(
            alias(
              "Required",
              f.createTupleTypeNode([
                alias("Foo"),
                f.createRestTypeNode(
                  alias(
                    "NonNullable",
                    f.createUnionTypeNode([
                      f.createTupleTypeNode([stringOrUndefined()]),
                      nullish(),
                    ]),
                  ),
                ),
              ]),
            ),
          ),
        ).toEqual(keptUndefined);
      }
      // The same spelling outside a spread.
      expect(
        await schemaOf(
          alias(
            "Required",
            alias(
              "NonNullable",
              f.createUnionTypeNode([
                f.createTupleTypeNode([alias("Foo"), stringOrUndefined()]),
                alias("Nil"),
              ]),
            ),
          ),
        ),
      ).toEqual(keptUndefined);
      // An array member beside the dropped one: its elements lose
      // `undefined` under `Required`.
      expect(
        await schemaOf(
          alias(
            "Required",
            f.createTupleTypeNode([
              alias("Foo"),
              f.createRestTypeNode(
                alias(
                  "NonNullable",
                  f.createUnionTypeNode([
                    f.createArrayTypeNode(
                      f.createParenthesizedType(
                        f.createUnionTypeNode([
                          f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
                          undefinedNode(),
                        ]),
                      ),
                    ),
                    alias("Nil"),
                  ]),
                ),
              ),
            ]),
          ),
        ),
      ).toEqual({
        type: "array",
        items: { anyOf: [{ $ref: "#/$defs/Foo" }, { type: "number" }] },
      });
    });

    it("opens a rest element over a union of tuples", async () => {
      // `[Foo, ...(Tail | [number])]` is a union of tuples to the checker;
      // in the positionless items form, each tuple's elements lie flat.
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      expect(
        await schemaOf(
          f.createTupleTypeNode([
            alias("Foo"),
            f.createRestTypeNode(
              f.createParenthesizedType(
                f.createUnionTypeNode([
                  alias("Tail"),
                  f.createTupleTypeNode([
                    f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
                  ]),
                ]),
              ),
            ),
          ]),
        ),
      ).toEqual({
        type: "array",
        items: {
          anyOf: [
            { $ref: "#/$defs/Foo" },
            { type: ["string", "undefined"] },
            { type: "number" },
          ],
        },
      });
    });

    it("folds equal arms by value, whatever their key order", async () => {
      // Two elements that are the same object type spelled with their
      // members in a different order are one arm, as every union this
      // package builds folds them. (Optional members, so no `required`
      // list: that is an array, and an array's order is part of its value.)
      const schemaOf = async (node: ts.TypeNode) =>
        ((await generateNamed(node)) as { schema: unknown }).schema;
      expect(
        await schemaOf(
          f.createTupleTypeNode([
            literal([["a", unknownNode(), true], ["b", stringNode(), true]]),
            literal([["b", stringNode(), true], ["a", unknownNode(), true]]),
          ]),
        ),
      ).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: { a: { type: "unknown" }, b: { type: "string" } },
        },
      });
    });

    it("merges an intersection as the type-based path merges one", async () => {
      // The constituents the type-based merge refuses get its own fallback,
      // `never` leaves nothing, `unknown` is the identity, and a union
      // constituent distributes as the checker distributes it.
      const schemaOf = async (node: ts.TypeNode) => {
        const result = await generateNamed(node);
        return typeof result === "boolean"
          ? result
          : (result as { schema: unknown }).schema;
      };
      const keyword = (kind: ts.KeywordTypeSyntaxKind) =>
        f.createKeywordTypeNode(kind);
      const unsupported = (reason: string) => ({
        type: "object",
        additionalProperties: true,
        $comment: `Unsupported intersection pattern: ${reason}`,
      });
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([
            alias("Foo"),
            keyword(ts.SyntaxKind.NeverKeyword),
          ]),
        ),
      ).toBe(false);
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([alias("Foo"), stringNode()]),
        ),
      ).toEqual(unsupported("non-object constituent"));
      // A branded primitive is a non-object constituent too.
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([
            stringNode(),
            literal([[
              "__brand",
              f.createLiteralTypeNode(f.createStringLiteral("x")),
            ]]),
          ]),
        ),
      ).toEqual(unsupported("non-object constituent"));
      // An array has an index signature, as a record does.
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([
            alias("Foo"),
            f.createArrayTypeNode(stringNode()),
          ]),
        ),
      ).toEqual(unsupported("index signature on constituent"));
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([alias("Foo"), alias("Rec")]),
        ),
      ).toEqual(unsupported("index signature on constituent"));
      // `unknown` is the identity: what is left stands as it is.
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([
            stringNode(),
            keyword(ts.SyntaxKind.UnknownKeyword),
          ]),
        ),
      ).toEqual({ type: "string" });
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([
            keyword(ts.SyntaxKind.UnknownKeyword),
            keyword(ts.SyntaxKind.UnknownKeyword),
          ]),
        ),
      ).toEqual({ type: "unknown" });
      // A union constituent distributes; an arm that is `null` beside an
      // object leaves nothing and drops out.
      const fooAndBar = {
        type: "object",
        properties: {
          x: { type: "unknown" },
          y: { type: "string" },
          z: { type: "number" },
        },
        required: ["x", "y", "z"],
      };
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([
            alias("Foo"),
            f.createParenthesizedType(
              f.createUnionTypeNode([
                alias("Bar"),
                literal([["w", keyword(ts.SyntaxKind.BooleanKeyword)]]),
              ]),
            ),
          ]),
        ),
      ).toEqual({
        anyOf: [
          fooAndBar,
          {
            type: "object",
            properties: {
              x: { type: "unknown" },
              y: { type: "string" },
              w: { type: "boolean" },
            },
            required: ["x", "y", "w"],
          },
        ],
      });
      expect(
        await schemaOf(
          f.createIntersectionTypeNode([
            alias("Foo"),
            f.createParenthesizedType(
              f.createUnionTypeNode([
                alias("Bar"),
                f.createLiteralTypeNode(f.createNull()),
              ]),
            ),
          ]),
        ),
      ).toEqual(fooAndBar);
    });

    it("reduces an intersection as the checker reduces one", async () => {
      // Before anything is merged or refused: `never` wins, even over `any`;
      // an empty object part drops out and takes `null` and `undefined` with
      // it (`T & {}`); primitives are narrowed or found disjoint.
      const schemaOf = async (node: ts.TypeNode) => {
        const result = await generateNamed(node);
        return typeof result === "boolean"
          ? result
          : (result as { schema: unknown }).schema;
      };
      const keyword = (kind: ts.KeywordTypeSyntaxKind) =>
        f.createKeywordTypeNode(kind);
      const unknownKeyword = () => keyword(ts.SyntaxKind.UnknownKeyword);
      const numberNode = () => keyword(ts.SyntaxKind.NumberKeyword);
      const text = (value: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(value));
      const anyOfTexts = (...values: string[]) =>
        f.createParenthesizedType(f.createUnionTypeNode(values.map(text)));
      const emptyObject = () => f.createTypeLiteralNode([]);
      const nullNode = () => f.createLiteralTypeNode(f.createNull());
      const both = (...members: ts.TypeNode[]) =>
        f.createIntersectionTypeNode(members);

      // `any` makes the whole accept anything...
      expect(
        await schemaOf(both(alias("Foo"), keyword(ts.SyntaxKind.AnyKeyword))),
      ).toBe(true);
      // ...unless `never` is there: it dominates `any`, in either order.
      expect(
        await schemaOf(
          both(
            unknownKeyword(),
            keyword(ts.SyntaxKind.AnyKeyword),
            keyword(ts.SyntaxKind.NeverKeyword),
          ),
        ),
      ).toBe(false);
      expect(
        await schemaOf(
          both(
            keyword(ts.SyntaxKind.NeverKeyword),
            keyword(ts.SyntaxKind.AnyKeyword),
          ),
        ),
      ).toBe(false);

      // ...and so does whatever reduces to nothing beside the `any`:
      // disjoint primitives, disjoint literals, a nullish part beside an
      // object or an empty object.
      const anyKeyword = () => keyword(ts.SyntaxKind.AnyKeyword);
      for (
        const impossible of [
          [anyKeyword(), stringNode(), numberNode(), unknownKeyword()],
          [anyKeyword(), text("a"), text("b"), unknownKeyword()],
          [anyKeyword(), nullNode(), literal([["topic", unknownNode()]])],
          [
            anyKeyword(),
            keyword(ts.SyntaxKind.UndefinedKeyword),
            literal([["topic", unknownNode()]]),
          ],
          [anyKeyword(), nullNode(), emptyObject(), unknownKeyword()],
        ]
      ) {
        expect(await schemaOf(both(...impossible))).toBe(false);
      }
      // What is still possible beside it leaves `any` to win, a part the
      // merge would refuse included.
      expect(
        await schemaOf(
          both(anyKeyword(), text("a"), stringNode(), unknownKeyword()),
        ),
      ).toBe(true);
      expect(
        await schemaOf(both(anyKeyword(), alias("Foo"), stringNode())),
      ).toBe(true);
      expect(await schemaOf(both(anyKeyword(), unknownKeyword()))).toBe(true);

      // `T & {}`: the empty object drops out, the one part left stands.
      expect(
        await schemaOf(
          both(
            f.createArrayTypeNode(literal([["topic", unknownNode()]])),
            emptyObject(),
          ),
        ),
      ).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: { topic: { type: "unknown" } },
          required: ["topic"],
        },
      });
      expect(
        await schemaOf(both(unknownKeyword(), stringNode(), emptyObject())),
      ).toEqual({ type: "string" });
      // ...and takes `null` and `undefined` with it.
      expect(
        await schemaOf(
          both(
            f.createParenthesizedType(
              f.createUnionTypeNode([stringNode(), nullNode()]),
            ),
            emptyObject(),
          ),
        ),
      ).toEqual({ type: "string" });
      expect(await schemaOf(both(alias("SNN"), emptyObject()))).toEqual({
        type: ["number", "string"],
      });
      expect(await schemaOf(both(nullNode(), emptyObject()))).toBe(false);
      // Alone, it is what it is.
      expect(await schemaOf(both(emptyObject(), emptyObject()))).toEqual({
        type: "object",
        properties: {},
      });

      // A literal beside its base type is the literal; inline literals keep
      // the node path's spelling, a named union its own.
      expect(
        await schemaOf(
          both(anyOfTexts("a", "b"), stringNode(), unknownKeyword()),
        ),
      ).toEqual({
        anyOf: [
          { type: "string", const: "a" },
          { type: "string", const: "b" },
        ],
      });
      expect(await schemaOf(both(alias("AB"), stringNode()))).toEqual({
        enum: ["a", "b"],
      });
      expect(
        await schemaOf(
          both(
            f.createLiteralTypeNode(f.createTrue()),
            keyword(ts.SyntaxKind.BooleanKeyword),
          ),
        ),
      ).toEqual({ type: "boolean", const: true });
      // Two finite sets meet in what both hold.
      expect(
        await schemaOf(
          both(anyOfTexts("a", "b", "c"), anyOfTexts("b", "c", "d")),
        ),
      ).toEqual({
        anyOf: [
          { type: "string", const: "b" },
          { type: "string", const: "c" },
        ],
      });
      expect(await schemaOf(both(alias("AB"), anyOfTexts("b", "c")))).toEqual({
        type: "string",
        const: "b",
      });
      // Type lists meet in the types both admit.
      expect(await schemaOf(both(alias("SNN"), alias("SNU")))).toEqual({
        type: ["number", "string"],
      });
      // Disjoint primitives leave nothing.
      expect(
        await schemaOf(both(stringNode(), numberNode(), unknownKeyword())),
      ).toBe(false);
      expect(await schemaOf(both(text("a"), text("b")))).toBe(false);
      expect(await schemaOf(both(alias("AB"), numberNode()))).toBe(false);
    });

    it("settles `any`, `void`, and mixed parts in an intersection as the checker does", async () => {
      const schemaOf = async (node: ts.TypeNode) => {
        const result = await generateNamed(node);
        return typeof result === "boolean"
          ? result
          : (result as { schema: unknown }).schema;
      };
      const keyword = (kind: ts.KeywordTypeSyntaxKind) =>
        f.createKeywordTypeNode(kind);
      const anyKeyword = () => keyword(ts.SyntaxKind.AnyKeyword);
      const unknownKeyword = () => keyword(ts.SyntaxKind.UnknownKeyword);
      const voidKeyword = () => keyword(ts.SyntaxKind.VoidKeyword);
      const undefinedKeyword = () => keyword(ts.SyntaxKind.UndefinedKeyword);
      const numberNode = () => keyword(ts.SyntaxKind.NumberKeyword);
      const booleanNode = () => keyword(ts.SyntaxKind.BooleanKeyword);
      const nullNode = () => f.createLiteralTypeNode(f.createNull());
      const text = (value: string) =>
        f.createLiteralTypeNode(f.createStringLiteral(value));
      const either = (...members: ts.TypeNode[]) =>
        f.createParenthesizedType(f.createUnionTypeNode(members));
      const both = (...members: ts.TypeNode[]) =>
        f.createIntersectionTypeNode(members);
      const unsupported = (reason: string) => ({
        type: "object",
        additionalProperties: true,
        $comment: `Unsupported intersection pattern: ${reason}`,
      });

      // Primitives contradict each other with an object or an array beside
      // them too, and that beats `any`.
      for (
        const impossible of [
          [stringNode(), numberNode(), alias("Foo")],
          [anyKeyword(), stringNode(), numberNode(), alias("Foo")],
          [
            anyKeyword(),
            stringNode(),
            numberNode(),
            f.createArrayTypeNode(unknownKeyword()),
          ],
          [anyKeyword(), text("a"), text("b"), alias("Foo")],
          [anyKeyword(), booleanNode(), stringNode()],
          [anyKeyword(), nullNode(), f.createLiteralTypeNode(f.createTrue())],
        ]
      ) {
        expect(await schemaOf(both(...impossible))).toBe(false);
      }
      // Compatible primitives beside an object stay the pattern the merge
      // refuses; the narrower one stands where it stood, which decides the
      // part the merge meets first.
      expect(
        await schemaOf(both(text("a"), stringNode(), alias("Foo"))),
      ).toEqual(unsupported("non-object constituent"));
      expect(
        await schemaOf(
          both(
            stringNode(),
            f.createArrayTypeNode(unknownKeyword()),
            text("a"),
          ),
        ),
      ).toEqual(unsupported("index signature on constituent"));

      // Beside `any` the checker looks no further than the parts that are no
      // union: it never distributes one, and `null` beside the bare `boolean`
      // is no contradiction to it there.
      for (
        const stillAny of [
          [anyKeyword(), nullNode(), either(stringNode(), numberNode())],
          [anyKeyword(), nullNode(), alias("AB")],
          [anyKeyword(), numberNode(), alias("AB")],
          [anyKeyword(), nullNode(), booleanNode()],
          [
            anyKeyword(),
            undefinedKeyword(),
            either(alias("Foo"), alias("Bar")),
          ],
        ]
      ) {
        expect(await schemaOf(both(...stillAny))).toBe(true);
      }

      // `void` reduces as `undefined` does beside another primitive, and is
      // no nullish part beside an object.
      expect(
        await schemaOf(
          both(
            anyKeyword(),
            undefinedKeyword(),
            voidKeyword(),
            unknownKeyword(),
          ),
        ),
      ).toBe(true);
      expect(
        await schemaOf(
          both(
            anyKeyword(),
            either(nullNode(), undefinedKeyword()),
            voidKeyword(),
            unknownKeyword(),
          ),
        ),
      ).toBe(true);
      expect(
        await schemaOf(
          both(anyKeyword(), nullNode(), voidKeyword(), unknownKeyword()),
        ),
      ).toBe(false);
      expect(await schemaOf(both(undefinedKeyword(), voidKeyword()))).toEqual({
        type: "undefined",
      });
      expect(await schemaOf(both(voidKeyword(), undefinedKeyword()))).toEqual({
        type: "undefined",
      });
      expect(await schemaOf(both(stringNode(), voidKeyword()))).toBe(false);
      expect(
        await schemaOf(both(voidKeyword(), f.createTypeLiteralNode([]))),
      ).toEqual({ asCell: ["opaque"] });
      expect(await schemaOf(both(voidKeyword(), alias("Foo")))).toEqual(
        unsupported("non-object constituent"),
      );

      // Identical constituents fold before a union distributes, so a union
      // met with itself is itself, with no merged arm between its members.
      expect(
        await schemaOf(
          both(
            either(alias("Foo"), alias("Bar")),
            either(alias("Foo"), alias("Bar")),
          ),
        ),
      ).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { x: { type: "unknown" }, y: { type: "string" } },
            required: ["x", "y"],
          },
          {
            type: "object",
            properties: { z: { type: "number" } },
            required: ["z"],
          },
        ],
      });
    });

    it("merges named constituents of an intersection through their references", async () => {
      expect(
        ((await generateNamed(
          f.createIntersectionTypeNode([
            alias("Foo"),
            literal([["extra", unknownNode()]]),
          ]),
        )) as { schema: unknown }).schema,
      ).toEqual({
        type: "object",
        properties: {
          x: { type: "unknown" },
          y: { type: "string" },
          extra: { type: "unknown" },
        },
        required: ["x", "y", "extra"],
      });
      expect(
        ((await generateNamed(
          f.createIntersectionTypeNode([alias("Foo"), alias("Bar")]),
        )) as { schema: unknown }).schema,
      ).toEqual({
        type: "object",
        properties: {
          x: { type: "unknown" },
          y: { type: "string" },
          z: { type: "number" },
        },
        required: ["x", "y", "z"],
      });
    });

    it("applies `NonNullable` to direct, array-typed, and referenced nullish forms", async () => {
      const { checker, sourceFile } = await createTestProgram(NAMED);
      const direct = (node: ts.TypeNode) =>
        new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
          alias("NonNullable", node),
          checker,
          undefined,
          undefined,
          sourceFile,
        );
      expect(direct(f.createLiteralTypeNode(f.createNull()))).toBe(false);
      expect(direct(f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)))
        .toBe(false);
      // `string | null | undefined` as a named type is one definition with an
      // array-valued `type`; the nullish entries go, the string stays.
      expect(
        ((await generateNamed(alias("NonNullable", alias("Nullable")))) as {
          schema: unknown;
        }).schema,
      ).toEqual({ type: "string" });
      // Two survivors keep the array form.
      expect(
        ((await generateNamed(alias("NonNullable", alias("Both")))) as {
          schema: unknown;
        }).schema,
      ).toEqual({ type: ["number", "string"] });
    });

    it("applies `NonNullable` to an enum, leaving the definition as it was", async () => {
      // A named union of literals and `null` is one definition with an
      // `enum`; the view loses the `null`, the definition read beside it
      // keeps it.
      const result = (await generateNamed(
        literal([["a", alias("NonNullable", alias("Lit"))], [
          "b",
          alias("Lit"),
        ]]),
      )) as { schema: unknown; $defs: Record<string, unknown> };
      expect(result.schema).toEqual({
        type: "object",
        properties: { a: { enum: ["a", "b"] }, b: { $ref: "#/$defs/Lit" } },
        required: ["a", "b"],
      });
      expect(result.$defs).toEqual({ Lit: { enum: ["a", "b", null] } });
      // A definition with nothing to remove is still read by reference.
      expect(
        await generateNamed(alias("NonNullable", alias("Foo"))),
      ).toEqual({ schema: { $ref: "#/$defs/Foo" }, $defs: { Foo: foo } });
    });

    it("leaves a schema that accepts no nullish value as it came", async () => {
      // Nothing to remove: the input comes back as it was — accept-anything,
      // a union with no nullish arm, a schema with no `type` to filter.
      expect(
        await generate(
          alias(
            "NonNullable",
            f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
          ),
        ),
      ).toBe(true);
      expect(
        await generate(
          alias(
            "NonNullable",
            f.createUnionTypeNode([
              literal([["a", unknownNode()]]),
              stringNode(),
            ]),
          ),
        ),
      ).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "unknown" } },
            required: ["a"],
          },
          { type: "string" },
        ],
      });
      expect(
        await generate(
          alias(
            "NonNullable",
            f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
          ),
        ),
      ).toEqual({ asCell: ["opaque"] });
    });

    it("admits `undefined` for an optional tuple element, in either spelling", async () => {
      const expected = {
        type: "array",
        items: {
          anyOf: [{ type: "string" }, { type: "number" }, {
            type: "undefined",
          }],
        },
      };
      expect(
        await generate(
          f.createTupleTypeNode([
            stringNode(),
            f.createOptionalTypeNode(
              f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            ),
          ]),
        ),
      ).toEqual(expected);
      expect(
        await generate(
          f.createTupleTypeNode([
            f.createNamedTupleMember(
              undefined,
              f.createIdentifier("a"),
              undefined,
              stringNode(),
            ),
            f.createNamedTupleMember(
              undefined,
              f.createIdentifier("b"),
              f.createToken(ts.SyntaxKind.QuestionToken),
              f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            ),
          ]),
        ),
      ).toEqual(expected);
    });

    it("believes a supplied program answer over the file name", async () => {
      // The transformer hands down `program.isSourceFileDefaultLibrary`; a
      // program that says the library file is NOT a library sends the alias
      // to the general path, which resolves the name to the alias's
      // uninstantiated declared type: an empty object, the member gone.
      const { checker, sourceFile } = await createTestProgram(
        "type Dummy = unknown;",
      );
      const { $schema: _schema, ...schema } = new SchemaGenerator()
        .generateSchemaFromSyntheticTypeNode(
          alias("Readonly", literal([["topic", unknownNode()]])),
          checker,
          undefined,
          undefined,
          sourceFile,
          { isDefaultLibrarySourceFile: () => false },
        ) as Record<string, unknown>;
      expect(schema).toEqual({ type: "object", properties: {} });
    });

    it("leaves an authored alias of a library name to the general path", async () => {
      // A module, so the authored alias shadows the library's rather than
      // colliding with it as a script-level redeclaration would.
      const { checker, sourceFile } = await createTestProgram(
        "export {};\ntype Record<K extends string, V> = { authored: true };",
      );
      const { $schema: _schema, ...schema } = new SchemaGenerator()
        .generateSchemaFromSyntheticTypeNode(
          alias("Record", stringNode(), unknownNode()),
          checker,
          undefined,
          undefined,
          sourceFile,
        ) as Record<string, unknown>;
      // The authored alias resolves from scope to its own declared type.
      expect(schema).toEqual({
        type: "object",
        properties: { authored: { type: "boolean", enum: [true] } },
        required: ["authored"],
      });
    });
  });

  describe("synthetic references to a name the module holds", () => {
    // A synthetic reference carries no binding, so its name is resolved from
    // the scope of the module the schema is generated for.

    const reference = (name: string) =>
      ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(name));
    const CONTACT = { $ref: "#/$defs/Contact" };
    const CONTACT_DEFS = {
      Contact: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    };

    async function generate(
      files: Record<string, string>,
      node: ts.TypeNode,
    ): Promise<unknown> {
      const { checker, sourceFile } = await createTestProgramFromFiles(
        files,
        "/main.ts",
      );
      const result = new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        node,
        checker,
        undefined,
        undefined,
        sourceFile,
      );
      if (typeof result === "boolean") return result;
      const { $schema: _schema, ...schema } = result as Record<string, unknown>;
      return schema;
    }

    it("reads a name the module declares", async () => {
      const schema = await generate(
        { "/main.ts": "interface Contact { name: string }\nexport {};" },
        reference("Contact"),
      );

      expect(schema).toEqual({ ...CONTACT, $defs: CONTACT_DEFS });
    });

    it("reads a name the module declares with `export`", async () => {
      const schema = await generate(
        { "/main.ts": "export interface Contact { name: string }" },
        reference("Contact"),
      );

      expect(schema).toEqual({ ...CONTACT, $defs: CONTACT_DEFS });
    });

    it("reads a name the module imports", async () => {
      const schema = await generate(
        {
          "/types.ts": "export interface Contact { name: string }",
          "/main.ts": "import type { Contact } from './types.ts';\n" +
            "export type Keep = Contact;",
        },
        reference("Contact"),
      );

      expect(schema).toEqual({ ...CONTACT, $defs: CONTACT_DEFS });
    });

    it("reads a name the module imports under another name", async () => {
      const schema = await generate(
        {
          "/types.ts": "export interface Contact { name: string }",
          "/main.ts": "import type { Contact as Person } from './types.ts';\n" +
            "export type Keep = Person;",
        },
        reference("Person"),
      );

      expect(schema).toEqual({ ...CONTACT, $defs: CONTACT_DEFS });
    });

    it("keeps every member of a union holding an exported name", async () => {
      const schema = await generate(
        {
          "/main.ts": "export interface Contact { name: string }\n" +
            "interface Other { other: number }",
        },
        ts.factory.createUnionTypeNode([
          reference("Contact"),
          reference("Other"),
        ]),
      );

      expect(schema).toEqual({
        anyOf: [CONTACT, { $ref: "#/$defs/Other" }],
        $defs: {
          ...CONTACT_DEFS,
          Other: {
            type: "object",
            properties: { other: { type: "number" } },
            required: ["other"],
          },
        },
      });
    });

    it("returns `true` for a name the module neither declares nor imports", async () => {
      const schema = await generate(
        {
          "/types.ts": "export interface Contact { name: string }",
          "/main.ts": "export {};",
        },
        reference("Contact"),
      );

      expect(schema).toBe(true);
    });

    describe("a generic whose parameter declares a default", () => {
      // The declaration is read with its parameters unbound, and an unbound
      // parameter without a constraint reads as its default.

      const BOX = "export interface Box<T = number> { value: T }";
      const box = (argument: ts.TypeNode) =>
        ts.factory.createTypeReferenceNode(
          ts.factory.createIdentifier("Box"),
          [argument],
        );
      const keyword = (kind: ts.KeywordTypeSyntaxKind) =>
        ts.factory.createKeywordTypeNode(kind);
      const readAsDefault = {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      };

      it("returns `true` for an argument that replaces the default", async () => {
        const schema = await generate(
          { "/main.ts": BOX },
          box(keyword(ts.SyntaxKind.StringKeyword)),
        );

        expect(schema).toBe(true);
      });

      it("returns `true` for an argument that replaces an imported default", async () => {
        const schema = await generate(
          {
            "/types.ts": BOX,
            "/main.ts": "import type { Box } from './types.ts';\n" +
              "export type Keep = Box;",
          },
          box(keyword(ts.SyntaxKind.StringKeyword)),
        );

        expect(schema).toBe(true);
      });

      it("returns `true` for an `any` argument", async () => {
        // `any` is assignable to the default, and still admits values the
        // default refuses.
        const schema = await generate(
          { "/main.ts": BOX },
          box(keyword(ts.SyntaxKind.AnyKeyword)),
        );

        expect(schema).toBe(true);
      });

      it("reads the declaration for an argument equal to the default", async () => {
        const schema = await generate(
          { "/main.ts": BOX },
          box(keyword(ts.SyntaxKind.NumberKeyword)),
        );

        expect(schema).toEqual(readAsDefault);
      });

      it("reads the declaration for a reference with no arguments", async () => {
        const schema = await generate(
          { "/main.ts": BOX },
          reference("Box"),
        );

        expect(schema).toEqual(readAsDefault);
      });

      it("reads the declaration for a named argument equal to a named default", async () => {
        const schema = await generate(
          {
            "/main.ts": "export interface Profile { handle: string }\n" +
              "export interface Card<T = Profile> { value: T }",
          },
          ts.factory.createTypeReferenceNode(
            ts.factory.createIdentifier("Card"),
            [reference("Profile")],
          ),
        );

        expect(schema).toMatchObject({
          type: "object",
          properties: { value: { $ref: "#/$defs/Profile" } },
        });
      });
    });
  });

  describe("synthetic type literals", () => {
    it("preserves numeric literal property names", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      const typeNode = ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          ts.factory.createNumericLiteral("0"),
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        ),
      ]);

      const schema = generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({
        "0": { type: "number" },
      });
      expect(schema.required).toEqual(["0"]);
    });

    it("preserves explicit double-underscore property names", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      const typeNode = ts.factory.createTypeLiteralNode([
        ts.factory.createPropertySignature(
          undefined,
          ts.factory.createIdentifier("__cf_reserved"),
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        ),
      ]);

      const schema = generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({
        __cf_reserved: { type: "number" },
      });
      expect(schema.required).toEqual(["__cf_reserved"]);
    });

    it("preserves anyOf for synthetic union containing unknown", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      // Synthetic union: unknown | { foo: string }
      // unknown should NOT absorb the object branch — the runtime can
      // try the object branch when the value matches.
      const unionNode = ts.factory.createUnionTypeNode([
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ts.factory.createTypeLiteralNode([
          ts.factory.createPropertySignature(
            undefined,
            ts.factory.createIdentifier("foo"),
            undefined,
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ),
        ]),
      ]);

      const schema = generator.generateSchemaFromSyntheticTypeNode(
        unionNode,
        checker,
      ) as Record<string, unknown>;
      expect(schema.anyOf).toEqual([
        { type: "unknown" },
        {
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
        },
      ]);
    });

    it("preserves wrapper semantics for synthetic union members", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      const unionNode = ts.factory.createUnionTypeNode([
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
        ts.factory.createTypeReferenceNode(
          ts.factory.createQualifiedName(
            ts.factory.createIdentifier("__cfHelpers"),
            ts.factory.createIdentifier("OpaqueCell"),
          ),
          [
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ],
        ),
      ]);

      const schema = generator.generateSchemaFromSyntheticTypeNode(
        unionNode,
        checker,
      ) as Record<string, unknown>;

      expect(schema.anyOf).toEqual([
        { type: "undefined" },
        { type: "unknown", asCell: ["opaque"] },
      ]);
    });

    it("preserves computed Common Fabric UI keys in synthetic type literals", async () => {
      const generator = new SchemaGenerator();
      const code = `
declare const UI: unique symbol;
type VNode = {
  type: "vnode";
};
type Output = { [UI]: VNode };
`;
      const { checker, typeNode } = await getTypeFromCode(code, "Output");
      if (!typeNode) {
        throw new Error("Expected Output type node.");
      }
      const schema = generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({
        $UI: {
          $ref: "https://commonfabric.org/schemas/vnode.json",
        },
      });
      expect(schema.required).toEqual(["$UI"]);
    });

    it("preserves local const string computed keys in synthetic type literals", async () => {
      const generator = new SchemaGenerator();
      const code = `
const UI = "title" as const;
type Output = { [UI]: string; metadata: number };
`;
      const { checker, typeNode } = await getTypeFromCode(code, "Output");
      if (!typeNode) {
        throw new Error("Expected Output type node.");
      }
      const schema = generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({
        title: { type: "string" },
        metadata: { type: "number" },
      });
      expect(schema.required).toEqual(["title", "metadata"]);
    });

    it("resolves local Date type references before applying native Date fallback", async () => {
      const generator = new SchemaGenerator();
      const code = `
namespace Local {
  export interface Date {
    year: number;
  }
  export type Output = { createdAt: Date };
}
`;
      const { checker, sourceFile } = await createTestProgram(code);
      let outputNode: ts.TypeNode | undefined;
      const visit = (node: ts.Node): void => {
        if (
          ts.isTypeAliasDeclaration(node) &&
          node.name.text === "Output"
        ) {
          outputNode = node.type;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (!outputNode) {
        throw new Error("Expected Local.Output type node.");
      }

      const schema = generator.generateSchemaFromSyntheticTypeNode(
        outputNode,
        checker,
        undefined,
        undefined,
        sourceFile,
      ) as Record<string, unknown>;

      expect(schema).toEqual({
        type: "object",
        properties: {
          createdAt: {
            type: "object",
            properties: {
              year: { type: "number" },
            },
            required: ["year"],
          },
        },
        required: ["createdAt"],
      });
    });

    //
    // The synthetic index-signature branch
    //
    // CT-1615 Berni review §4.2: lock in the new IndexSignatureDeclaration
    // branch added to `analyzeTypeNodeStructure`'s TypeLiteral handler. Without
    // it, synthetic `{ [k: string]: V }` / `Record<K, V>` shapes routed through
    // node-based analysis silently drop their index signature (e.g. via the
    // SchemaInjection lift-revisit that feeds `any` as the paired Type — see
    // ts-transformers/src/transformers/schema-injection.ts).
    //

    it("emits additionalProperties for synthetic { [k: string]: V } index signature", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      // { [k: string]: number }
      const indexSignature = ts.factory.createIndexSignature(
        undefined,
        [ts.factory.createParameterDeclaration(
          undefined,
          undefined,
          ts.factory.createIdentifier("k"),
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        )],
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      );
      const typeNode = ts.factory.createTypeLiteralNode([indexSignature]);

      const schema = generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({});
      expect(schema.additionalProperties).toEqual({ type: "number" });
    });

    it("emits additionalProperties for synthetic Record<string, V> shape via node-based analysis", async () => {
      const generator = new SchemaGenerator();
      const { checker } = await getTypeFromCode(
        "type Dummy = unknown;",
        "Dummy",
      );
      // { name: string; [k: string]: number } — a mixed shape with a
      // named property AND an index signature, to confirm both branches
      // contribute correctly.
      const namedProp = ts.factory.createPropertySignature(
        undefined,
        ts.factory.createIdentifier("name"),
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      );
      const indexSignature = ts.factory.createIndexSignature(
        undefined,
        [ts.factory.createParameterDeclaration(
          undefined,
          undefined,
          ts.factory.createIdentifier("k"),
          undefined,
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        )],
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      );
      const typeNode = ts.factory.createTypeLiteralNode([
        namedProp,
        indexSignature,
      ]);

      const schema = generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
      ) as Record<string, unknown>;

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({ name: { type: "string" } });
      expect(schema.required).toEqual(["name"]);
      expect(schema.additionalProperties).toEqual({ type: "number" });
    });
  });

  describe("interfaces extending `FabricExecPlainObject`", () => {
    it("emits no additionalProperties for an interface extending `FabricExecPlainObject`", async () => {
      // The base is a type alias, so what the interface extends resolves to
      // the aliased type; the generator has to identify it through the alias
      // symbol that type carries.
      const { type, checker } = await getTypeFromCode(
        `${EXEC_PLAIN_OBJECT_MIRROR}
        interface Pattern extends FabricExecPlainObject { foo: number }`,
        "Pattern",
      );
      const schema = new SchemaGenerator().generateSchema(
        type,
        checker,
      ) as Record<string, unknown>;

      expect(schema.additionalProperties).toBeUndefined();
      expect(Object.keys(schema.properties as object)).toEqual(["foo"]);
    });

    it("emits additionalProperties for an interface extending an index-signature base of another name", async () => {
      // The control for the case above: the same shape under a different
      // alias name keeps its index signature.
      const { type, checker } = await getTypeFromCode(
        `${EXEC_PLAIN_OBJECT_MIRROR}
        type OtherPlainObject = FabricPlainObjectPlus<FabricExecFunction>;
        interface Pattern extends OtherPlainObject { foo: number }`,
        "Pattern",
      );
      const schema = new SchemaGenerator().generateSchema(
        type,
        checker,
      ) as Record<string, unknown>;

      expect(schema.additionalProperties).toBeDefined();
    });
  });

  describe("union members", () => {
    it("uses source union member nodes when semantic order is canonicalized", async () => {
      const generator = new SchemaGenerator();
      const code = `
type Event =
  | { a: string }
  | { b: number }
  | undefined;
`;
      const { type, checker, typeNode } = await getTypeFromCode(code, "Event");

      const schema = generator.generateSchema(
        type,
        checker,
        typeNode,
      ) as Record<string, unknown>;

      expect(schema.anyOf).toEqual([
        { type: "undefined" },
        {
          type: "object",
          properties: {
            a: { type: "string" },
          },
          required: ["a"],
        },
        {
          type: "object",
          properties: {
            b: { type: "number" },
          },
          required: ["b"],
        },
      ]);
    });
  });

  describe("anonymous recursion", () => {
    it("hoists anonymous recursive types with synthetic definitions", async () => {
      const generator = new SchemaGenerator();
      const code = `
type Wrapper = {
  node: {
    value: string;
    next?: Wrapper["node"];
  };
};`;
      const { type, checker } = await getTypeFromCode(code, "Wrapper");

      const schema = generator.generateSchema(type, checker);
      const root = schema as Record<string, unknown>;
      const properties = root.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const $defs = root.$defs as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(properties?.node).toEqual({
        $ref: "#/$defs/AnonymousType_1",
      });
      expect($defs).toBeDefined();
      expect(Object.keys($defs ?? {})).toContain("AnonymousType_1");
      expect(JSON.stringify(schema)).not.toContain(
        "Anonymous recursive type",
      );
    });
  });

  describe("built-in mappings", () => {
    it("formats Date as an object without hoisting", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasDate {
  createdAt: Date;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasDate");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(objectSchema.$defs).toBeUndefined();
      // A `Date` is stored as a `FabricEpochNsec`, an object at the fabric
      // boundary. Read through `{ type: "string" }` it projects to `undefined`.
      expect(props?.createdAt).toEqual({ type: "object" });
    });

    it("formats URL as string with uri format without hoisting", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasUrl {
  homepage: URL;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasUrl");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(objectSchema.$defs).toBeUndefined();
      expect(props?.homepage).toEqual({
        type: "string",
        format: "uri",
      });
    });

    it("formats URL from @types/node as string with uri format", () => {
      const generator = new SchemaGenerator();
      const sourceFiles = new Map([
        [
          "/test.ts",
          ts.createSourceFile(
            "/test.ts",
            `
interface HasNodeUrl {
  homepage: URL;
}`,
            ts.ScriptTarget.ES2023,
            true,
          ),
        ],
        [
          "/node_modules/@types/node/url.d.ts",
          ts.createSourceFile(
            "/node_modules/@types/node/url.d.ts",
            `
declare interface URL {
  href: string;
}`,
            ts.ScriptTarget.ES2023,
            true,
          ),
        ],
      ]);
      const compilerHost: ts.CompilerHost = {
        getSourceFile: (fileName) => sourceFiles.get(fileName),
        writeFile: () => {},
        getCurrentDirectory: () => "/",
        getDirectories: () => [],
        fileExists: (fileName) => sourceFiles.has(fileName),
        readFile: (fileName) => sourceFiles.get(fileName)?.text,
        getCanonicalFileName: (fileName) => fileName,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        getDefaultLibFileName: () => "lib.d.ts",
      };
      const program = ts.createProgram(
        [...sourceFiles.keys()],
        {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          noLib: true,
          strict: true,
        },
        compilerHost,
      );
      const checker = program.getTypeChecker();
      const sourceFile = program.getSourceFile("/test.ts");
      if (!sourceFile) throw new Error("Expected test source file");
      let foundType: ts.Type | undefined;
      ts.forEachChild(sourceFile, (node) => {
        if (
          ts.isInterfaceDeclaration(node) && node.name.text === "HasNodeUrl"
        ) {
          const symbol = checker.getSymbolAtLocation(node.name);
          if (symbol) foundType = checker.getDeclaredTypeOfSymbol(symbol);
        }
      });
      if (!foundType) throw new Error("Expected HasNodeUrl type");

      const schema = generator.generateSchema(foundType, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(props?.homepage).toEqual({
        type: "string",
        format: "uri",
      });
    });

    it("formats Uint8Array as an object", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface BinaryHolder {
  data: Uint8Array;
}`;
      const { type, checker } = await getTypeFromCode(code, "BinaryHolder");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, unknown>
        | undefined;

      expect(objectSchema.$defs).toBeUndefined();
      // Stored as a `FabricBytes`, so an object -- not "anything goes".
      expect(props?.data).toEqual({ type: "object" });
    });

    it("formats ArrayBuffer as permissive true schema", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface BufferHolder {
  buffer: ArrayBuffer;
}`;
      const { type, checker } = await getTypeFromCode(code, "BufferHolder");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, unknown>
        | undefined;

      expect(objectSchema.$defs).toBeUndefined();
      expect(props?.buffer).toBe(true);
    });

    it("collapses unions of native binary types", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasImage {
  image: string | Uint8Array | ArrayBuffer | URL;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasImage");

      const schema = generator.generateSchema(type, checker);
      const objectSchema = schema as Record<string, unknown>;
      const props = objectSchema.properties as
        | Record<string, Record<string, unknown> | boolean>
        | undefined;

      expect(objectSchema.$defs).toBeUndefined();
      // Should collapse to a single permissive schema instead of a union,
      // since at least one option was just true
      expect(props?.image).toEqual(true);
    });
  });

  describe("non-serializable type rejection", () => {
    it("throws error for Map type", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasMap {
  data: Map<string, number>;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasMap");

      expect(() => generator.generateSchema(type, checker)).toThrow(
        /Map cannot be used in pattern inputs\/outputs because it is not JSON-serializable/,
      );
    });

    it("throws error for Set type", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasSet {
  items: Set<string>;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasSet");

      expect(() => generator.generateSchema(type, checker)).toThrow(
        /Set cannot be used in pattern inputs\/outputs because it is not JSON-serializable/,
      );
    });

    it("throws error for WeakMap type", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasWeakMap {
  cache: WeakMap<object, string>;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasWeakMap");

      expect(() => generator.generateSchema(type, checker)).toThrow(
        /WeakMap cannot be used in pattern inputs\/outputs because it is not JSON-serializable/,
      );
    });

    it("throws error for WeakSet type", async () => {
      const generator = new SchemaGenerator();
      const code = `
interface HasWeakSet {
  seen: WeakSet<object>;
}`;
      const { type, checker } = await getTypeFromCode(code, "HasWeakSet");

      expect(() => generator.generateSchema(type, checker)).toThrow(
        /WeakSet cannot be used in pattern inputs\/outputs because it is not JSON-serializable/,
      );
    });
  });
});
