import { expect } from "@std/expect";
import ts from "typescript";
import type { SchemaGenerationDiagnostic } from "../src/interface.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";
import {
  asObjectSchema,
  createTestProgram,
  getTypeFromCode,
  getTypeFromFiles,
} from "./utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const f = ts.factory;

/** A type literal with the one property `name` of type `type`. */
const memberLiteral = (name: string, type: ts.TypeNode) =>
  f.createTypeLiteralNode([
    f.createPropertySignature(undefined, name, undefined, type),
  ]);

/** The synthetic keyword type node of `kind`. */
const keyword = (kind: ts.KeywordTypeSyntaxKind) =>
  f.createKeywordTypeNode(kind);

/** A CFC alias that labels its payload with the confidentiality `L`. */
const CONFIDENTIAL = `
  type Confidential<T, L> = T & {
    readonly __ct_cfc__?: { readonly meta?: { confidentiality: L }; readonly of?: T };
  };
`;

describe("SchemaGenerator flap coverage", () => {
  // The branches exercised here otherwise run only when a pattern compiles
  // "cold" through the transformer. When the compile cache is warm those code
  // paths are skipped, so the lines are recorded as covered in some CI runs and
  // uncovered in others. These unit tests drive the same branches directly with
  // hand-built type declarations so they are covered on every run.

  it("resolves the element type of an array type alias to the concrete element schema", async () => {
    // type-utils.ts getArrayElementInfo: when a property's TypeNode is a
    // reference to a type alias whose right-hand side is `Element[]`, the
    // element type is read from the alias body. `Element` is a concrete type
    // (not a type parameter), so its resolved type is used and the array's
    // items schema is the element type's schema.
    const code = `
interface Element { id: number; label: string; }
type ElementList = Element[];
interface Root { items: ElementList; }
`;
    const { type, checker, typeNode } = await getTypeFromCode(code, "Root");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(
      generator.generateSchema(type, checker, typeNode),
    );

    const props = schema.properties as Record<string, unknown>;
    const itemsSchema = props.items as Record<string, unknown>;
    expect(itemsSchema.type).toBe("array");
    // The element type resolves to the concrete `Element` object, hoisted into
    // $defs and referenced by the array's items.
    expect(itemsSchema.items).toEqual({ $ref: "#/$defs/Element" });

    const defs = (schema as Record<string, unknown>).$defs as Record<
      string,
      unknown
    >;
    expect(defs.Element).toEqual({
      type: "object",
      properties: {
        id: { type: "number" },
        label: { type: "string" },
      },
      required: ["id", "label"],
    });
  });

  it("uses a type parameter's default type when it has no base constraint", async () => {
    // schema-generator.ts formatType: for a bare type parameter with no base
    // constraint but a declared default, the schema is generated from the
    // default type. Here the parameter `T` defaults to `Preset`, so the alias
    // `type WithDefault<T = Preset> = T` formats to `Preset`'s schema.
    const code = `
interface Preset { name: string; count: number; }
type WithDefault<T = Preset> = T;
`;
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "WithDefault",
    );
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(
      generator.generateSchema(type, checker, typeNode),
    );

    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({
      name: { type: "string" },
      count: { type: "number" },
    });
    expect(schema.required).toEqual(["name", "count"]);
  });

  it("treats a deferred conditional type as an unconstrained schema", async () => {
    // schema-generator.ts formatType: a conditional type whose condition
    // depends on an unresolved type parameter stays deferred (its flags carry
    // ts.TypeFlags.Conditional). The generator cannot know the concrete branch
    // at compile time, so the property's schema is the empty (accept-anything)
    // schema `{}`.
    const code = `
type Narrow<T> = T extends string ? number : boolean;
interface Root<T> { field: Narrow<T>; }
`;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const generator = new SchemaGenerator();
    const schema = asObjectSchema(generator.generateSchema(type, checker));

    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props.field).toEqual({});
    expect(schema.required).toEqual(["field"]);
  });

  it("maps synthetic boolean literal type nodes to boolean const schemas", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: the node-based path maps a
    // `true` literal type node to { type: "boolean", const: true } and a
    // `false` literal type node to { type: "boolean", const: false }.
    const { checker } = await getTypeFromCode("type Dummy = unknown;", "Dummy");
    const generator = new SchemaGenerator();

    const trueNode = ts.factory.createLiteralTypeNode(ts.factory.createTrue());
    const falseNode = ts.factory.createLiteralTypeNode(
      ts.factory.createFalse(),
    );

    expect(
      generator.generateSchemaFromSyntheticTypeNode(trueNode, checker),
    ).toEqual({ type: "boolean", const: true });
    expect(
      generator.generateSchemaFromSyntheticTypeNode(falseNode, checker),
    ).toEqual({ type: "boolean", const: false });
  });

  it("maps a synthetic numeric literal type node to a number const schema", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: the node-based path reads
    // a numeric literal type node's text and emits it as a number rather than
    // as the string the node carries. Which literal kinds the pattern corpus
    // happens to feed through a synthetic node decides whether this arm runs.
    const { checker } = await getTypeFromCode("type Dummy = unknown;", "Dummy");
    const generator = new SchemaGenerator();

    expect(
      generator.generateSchemaFromSyntheticTypeNode(
        ts.factory.createLiteralTypeNode(
          ts.factory.createNumericLiteral("42"),
        ),
        checker,
      ),
    ).toEqual({ type: "number", const: 42 });
  });

  it("maps a synthetic Date type reference to a date-time string schema", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: a type reference the
    // surrounding scope cannot resolve falls back to a name check, and `Date`
    // is the one name that check knows.
    const { checker } = await getTypeFromCode("type Dummy = unknown;", "Dummy");
    const generator = new SchemaGenerator();

    expect(
      generator.generateSchemaFromSyntheticTypeNode(
        ts.factory.createTypeReferenceNode("Date"),
        checker,
      ),
    ).toEqual({ type: "string", format: "date-time" });
  });

  it("accepts any value for a synthetic type reference written as a qualified name", async () => {
    // schema-generator.ts resolveTypeReferenceFromScope: the scope lookup is
    // by a single name, so a reference spelled `Namespace.Member` is left
    // unresolved, and nothing further in the node path claims it.
    const { checker } = await getTypeFromCode("type Dummy = unknown;", "Dummy");
    const generator = new SchemaGenerator();

    expect(
      generator.generateSchemaFromSyntheticTypeNode(
        ts.factory.createTypeReferenceNode(
          ts.factory.createQualifiedName(
            ts.factory.createIdentifier("Namespace"),
            "Member",
          ),
        ),
        checker,
      ),
    ).toBe(true);
  });

  it("collapses a synthetic union type node whose members all reject", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: a `never` member formats
    // to `false`, which rejects every value and is a no-op inside `anyOf`. A
    // union of nothing but those collapses to `false`, and a union left with
    // one member after dropping them is that member alone. A union written
    // with a single member is that member before any of this.
    const { checker } = await getTypeFromCode("type Dummy = unknown;", "Dummy");
    const generator = new SchemaGenerator();
    const never = () =>
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);

    expect(
      generator.generateSchemaFromSyntheticTypeNode(
        ts.factory.createUnionTypeNode([
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        ]),
        checker,
      ),
    ).toEqual({ type: "number" });
    expect(
      generator.generateSchemaFromSyntheticTypeNode(
        ts.factory.createUnionTypeNode([never(), never()]),
        checker,
      ),
    ).toBe(false);
    expect(
      generator.generateSchemaFromSyntheticTypeNode(
        ts.factory.createUnionTypeNode([
          never(),
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ]),
        checker,
      ),
    ).toEqual({ type: "string" });
  });

  it("resolves a non-keyword type node through the checker when node-based analysis is forced", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: for a real TypeNode kind
    // that none of the earlier node branches or the keyword switch handles, the
    // node is resolved to a Type via the checker; when that Type is not `any`
    // it is formatted through formatChildType. A `keyof` type operator node is
    // one such kind. Pairing it with the `any` Type forces the node-based path,
    // mirroring the transformer's lift-revisit which feeds `any` as the paired
    // Type alongside a concrete node.
    const { checker, sourceFile } = await createTestProgram(
      "interface Options { alpha: string; beta: number; } type Keys = keyof Options;",
    );
    let keyofNode: ts.TypeNode | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "Keys") {
        keyofNode = node.type;
      }
    });
    expect(keyofNode).toBeDefined();

    const generator = new SchemaGenerator();
    const anyType = checker.getAnyType();
    const schema = generator.generateSchema(anyType, checker, keyofNode);

    // `keyof Options` resolves to the union of its literal keys.
    expect(schema).toEqual({ enum: ["alpha", "beta"] });
  });

  it("resolves an indexed-access type node through the checker when node-based analysis is forced", async () => {
    // schema-generator.ts analyzeTypeNodeStructure: same non-keyword resolution
    // branch, driven by an indexed-access type node `Options["alpha"]`. The
    // checker resolves it to the concrete property type, which formats to that
    // property's schema.
    const { checker, sourceFile } = await createTestProgram(
      'interface Options { alpha: string; beta: number; } type Picked = Options["alpha"];',
    );
    let indexedNode: ts.TypeNode | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "Picked") {
        indexedNode = node.type;
      }
    });
    expect(indexedNode).toBeDefined();

    const generator = new SchemaGenerator();
    const anyType = checker.getAnyType();
    const schema = generator.generateSchema(anyType, checker, indexedNode);

    expect(schema).toEqual({ type: "string" });
  });

  it("returns the fallback naming the inner constituent for an intersection holding an intersection it could not merge", async () => {
    // The inner `string[] & { a: string }` merges to the unsupported-pattern
    // fallback, which keeps its constituents, so the outer intersection reads
    // the array among them and refuses it too. An inner intersection that
    // merges stands as one object.
    const { checker } = await getTypeFromCode("type Dummy = unknown;", "Dummy");
    const outer = (inner: ts.TypeNode) =>
      new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        f.createIntersectionTypeNode([
          inner,
          memberLiteral("b", keyword(ts.SyntaxKind.NumberKeyword)),
        ]),
        checker,
      );

    expect(
      outer(f.createIntersectionTypeNode([
        f.createArrayTypeNode(keyword(ts.SyntaxKind.StringKeyword)),
        memberLiteral("a", keyword(ts.SyntaxKind.StringKeyword)),
      ])),
    ).toEqual({
      type: "object",
      additionalProperties: true,
      $comment:
        "Unsupported intersection pattern: index signature on constituent",
    });
    expect(
      outer(f.createIntersectionTypeNode([
        memberLiteral("c", keyword(ts.SyntaxKind.BooleanKeyword)),
        memberLiteral("a", keyword(ts.SyntaxKind.StringKeyword)),
      ])),
    ).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
      },
      required: ["c", "a", "b"],
    });
  });

  it("throws for a type no formatter claims, naming it", async () => {
    // `Uppercase<T>` over a type parameter is a string mapping the checker
    // leaves deferred, which is neither a primitive nor an object.
    const { type, checker, typeNode } = await getTypeFromCode(
      "type Shout<T extends string> = Uppercase<T>;",
      "Shout",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("No formatter found for type: Uppercase<T>");
  });

  it("keeps the labels of an argument passed through an imported base interface", async () => {
    // `Child<U>` extends `Base<U>` through an import binding, so `Base` is
    // reached through its alias. The argument's labels are written around
    // `any`, which the checker erases, so only the written argument, bound
    // through both declarations, holds them.
    const { type, checker, typeNode } = await getTypeFromFiles(
      {
        "/base.ts": "export interface Base<T> { value: T; }",
        "/main.ts": `
          import type { Base } from "./base.ts";
          ${CONFIDENTIAL}
          export interface Child<U> extends Base<U> {}
          export interface SchemaRoot {
            c: Child<Confidential<any, readonly ["secret"]>>;
          }
        `,
      },
      "/main.ts",
      "SchemaRoot",
    );

    expect(new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toEqual({
        type: "object",
        properties: {
          c: {
            type: "object",
            properties: { value: { ifc: { confidentiality: ["secret"] } } },
            required: ["value"],
          },
        },
        required: ["c"],
      });
  });

  it("reads a member of a type literal written over a bound parameter at its instantiation", async () => {
    // The conditional over `T` is one the checker must instantiate, so its
    // syntax cannot be read under the binding; its instantiated type,
    // `"s"`, is read instead.
    const { type, checker } = await getTypeFromCode(
      `
        interface Box<T> { inner: { v: T extends string ? "s" : "n"; w: T } }
        interface SchemaRoot { b: Box<string> }
      `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.properties).toEqual({
      b: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              v: { type: "string", enum: ["s"] },
              w: { type: "string" },
            },
            required: ["v", "w"],
          },
        },
        required: ["inner"],
      },
    });
  });

  it("returns the payload in the scope for a synthetic union of a scope wrapper and `null`", async () => {
    const { checker, sourceFile } = await createTestProgram(
      "type SchemaRoot = PerUser<{ a: string }> | null;",
    );
    const root = sourceFile.statements.find(ts.isTypeAliasDeclaration)!;

    expect(
      new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        root.type,
        checker,
        undefined,
        undefined,
        sourceFile,
      ),
    ).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        { type: "null" },
      ],
      scope: "user",
    });
  });

  it("accepts any value for a library alias over a bound parameter its rules cannot apply, and reports it unread", async () => {
    // `Record` over a template literal key set is no record the node-based
    // analyzer can build. Read by type, it would be the checker's
    // uninstantiated declaration, so it is not read at all.
    const { type, checker } = await getTypeFromCode(
      `
        interface Box<T, K extends string> { inner: Record<K, T> }
        interface SchemaRoot { b: Box<number, \`k\${string}\`> }
      `,
      "SchemaRoot",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    expect(schema.properties).toEqual({
      b: {
        type: "object",
        properties: { inner: true },
        required: ["inner"],
      },
    });
    expect(diagnostics.map(({ type }) => type)).toEqual(["schema-type:unread"]);
    expect(diagnostics[0]!.message).toContain("`Record<K, T>`");
  });

  it("attaches no definition for a `$ref` in a default value, which is data", async () => {
    // The root's own reading is stored as a definition too, so a scan that
    // read the default as a schema would attach it.
    const { type, checker } = await getTypeFromCode(
      `
        interface A { x: string }
        interface SchemaRoot {
          a: A;
          d: Default<Record<string, { $ref: string }>, { other: { $ref: "#/$defs/SchemaRoot" } }>;
        }
      `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(Object.keys(schema.$defs ?? {})).toEqual(["A"]);
    expect(asObjectSchema(schema.properties?.d).default).toEqual({
      other: { $ref: "#/$defs/SchemaRoot" },
    });
  });
});
