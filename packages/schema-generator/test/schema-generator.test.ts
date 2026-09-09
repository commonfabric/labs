import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram, getTypeFromCode } from "./utils.ts";

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
    const generate = async (node: ts.TypeNode) => {
      const { checker, sourceFile } = await createTestProgram(
        "type Dummy = unknown;",
      );
      const { $schema: _schema, ...schema } = new SchemaGenerator()
        .generateSchemaFromSyntheticTypeNode(
          node,
          checker,
          undefined,
          undefined,
          sourceFile,
        ) as Record<string, unknown>;
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
