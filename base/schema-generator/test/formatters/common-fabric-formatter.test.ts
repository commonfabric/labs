import { expect } from "@std/expect";
import ts from "typescript";
import type { SchemaGenerationDiagnostic } from "../../src/interface.ts";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import {
  asObjectSchema,
  createTestProgram,
  getTypeFromCode,
} from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** `Cfc` and the label aliases the cases lower, declared as an author would. */
const CFC_ALIASES = `
  type Cfc<T, Meta> = T & {
    readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T };
  };
  type Confidential<T, X extends readonly unknown[]> = Cfc<
    T,
    { confidentiality: X }
  >;
  type Integrity<T, X extends readonly unknown[]> = Cfc<T, { integrity: X }>;
  type ExactCopy<T, P> = Cfc<T, { exactCopyOf: P }>;
  type ProjectionPath<T, From extends string, Path> = Cfc<
    T,
    { projection: { from: From; path: Path } }
  >;
  type ProjectionOf<Root, Path> = ProjectionPath<Root, "/", Path>;
`;

/** `commonfabric`'s `Default`, in the shape the library declares it. */
const DEFAULT_ALIAS = `
  declare module "commonfabric" {
    const DEFAULT_MARKER: unique symbol;
    type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
    export type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
  }
  import type { Default } from "commonfabric";
`;

/**
 * The schema `generateSchema()` emits for the type `X` that `code` declares,
 * read at its node where it is an alias, with the diagnostics it reports.
 */
async function generate(code: string): Promise<{
  schema: ReturnType<SchemaGenerator["generateSchema"]>;
  diagnostics: SchemaGenerationDiagnostic[];
}> {
  const { type, checker, typeNode } = await getTypeFromCode(code, "X");
  const diagnostics: SchemaGenerationDiagnostic[] = [];
  const schema = new SchemaGenerator().generateSchema(
    type,
    checker,
    typeNode,
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );
  return { schema, diagnostics };
}

/** The schema of the property `name` of the object schema `code` emits. */
async function propertySchema(code: string, name: string): Promise<unknown> {
  return asObjectSchema((await generate(code)).schema).properties?.[name];
}

/** The program `code` builds, with its interface `X` and `X`'s members. */
async function interfaceX(code: string) {
  const { checker, sourceFile } = await createTestProgram(code);
  const declaration = sourceFile.statements.find((
    statement,
  ): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "X"
  );
  if (!declaration) throw new Error("Interface X not found");
  const type = checker.getTypeAtLocation(declaration.name);
  const member = (name: string) => {
    const property = type.getProperty(name);
    const node = declaration.members.find((candidate) =>
      candidate.name && ts.isIdentifier(candidate.name) &&
      candidate.name.text === name
    );
    if (!property || !node || !ts.isPropertySignature(node) || !node.type) {
      throw new Error(`Property X.${name} not found`);
    }
    return { type: checker.getTypeOfSymbol(property), node: node.type };
  };
  return { checker, sourceFile, member };
}

/** A reference to `name` qualified as the transformer prints a helper. */
const helperReference = (name: string, typeArguments?: ts.TypeNode[]) =>
  ts.factory.createTypeReferenceNode(
    ts.factory.createQualifiedName(
      ts.factory.createIdentifier("__cfHelpers"),
      ts.factory.createIdentifier(name),
    ),
    typeArguments,
  );

/**
 * `import("./types.ts").name`, as the printer writes a name the emitting
 * module does not import, which no lookup from a synthetic position resolves.
 */
const importTypeNode = (name: string) =>
  ts.factory.createImportTypeNode(
    ts.factory.createLiteralTypeNode(
      ts.factory.createStringLiteral("./types.ts"),
    ),
    undefined,
    ts.factory.createIdentifier(name),
  );

describe("common-fabric-formatter", () => {
  describe("scope wrappers", () => {
    it("throws for a type named by a scope wrapper's name with no type argument", async () => {
      // Scope wrappers are recognized by name, so an author's own `PerUser`
      // holding no payload is one with its payload missing. Read without a
      // node, the type's alias is all that names it.
      const { type, checker } = await getTypeFromCode(
        "type PerUser = { a: string }; type X = PerUser;",
        "X",
      );

      expect(() => new SchemaGenerator().generateSchema(type, checker))
        .toThrow("PerUser<T> requires type argument");
    });

    it("throws for a reference to a scope wrapper's name with no type argument", async () => {
      await expect(
        generate("type PerUser = { a: string }; interface X { p: PerUser }"),
      ).rejects.toThrow("Scoped wrapper requires type argument");
    });

    it("throws for a chain of aliases ending at a scope wrapper's name with no type argument", async () => {
      await expect(
        generate(`
          type PerUser = { a: string };
          type Outer<T> = PerUser;
          interface X { o: Outer<string> }
        `),
      ).rejects.toThrow("PerUser<T> requires type argument");
    });

    it("throws for a chain of aliases ending at a CFC alias's name with no type argument", async () => {
      await expect(
        generate(`
          type Confidential = { a: string };
          type Outer<T> = Confidential;
          interface X { o: Outer<string> }
        `),
      ).rejects.toThrow("Confidential<T> requires type argument");
    });

    it("emits the scope for two equal wrappers written as a union beside nothing", async () => {
      // The checker folds the two members into one, which is the wrapper
      // alone, and nothing beside it is read from the union written for it.
      expect(
        await propertySchema(
          "type X = Required<{ a?: PerUser<string> | PerUser<string> }>;",
          "a",
        ),
      ).toEqual({ type: "string", scope: "user" });
    });

    it("emits the payload of an alias of a wrapper beside `null` read from its type alone", async () => {
      // A mapped type's member has no node, so the union is found as the
      // body of the alias its type carries.
      expect(
        await propertySchema(
          `type Maybe = PerUser<string> | null;
          type X = { [K in "a"]: Maybe };`,
          "a",
        ),
      ).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
        scope: "user",
      });
    });

    it("emits the scope for two equal wrappers written beside `undefined` where the type holds the wrapper alone", async () => {
      // `Required` takes the `undefined` out of the type, which leaves the
      // union written with two wrappers of one type beside `undefined`, read
      // as the one wrapper the checker folds them into.
      const schemaOf = (union: string) =>
        propertySchema(`type X = Required<{ a?: ${union} }>;`, "a");

      expect(
        await schemaOf("PerUser<string> | PerUser<string> | undefined"),
      ).toEqual({ type: "string", scope: "user" });
      expect(
        await schemaOf("PerUser<string> | PerUser<string> | undefined"),
      ).toEqual(await schemaOf("PerUser<string> | undefined"));
    });

    it("emits the scope for wrappers a generic alias writes beside `undefined` that its bindings fold into one", async () => {
      // Each member is read under the alias's bindings, where it is the one
      // wrapper the checker folds the members into.
      const schemaOf = (alias: string, box: string) =>
        propertySchema(`${alias} type X = Required<{ a?: ${box} }>;`, "a");

      for (
        const [alias, box] of [
          [
            "type Box<T, U> = PerUser<T> | PerUser<U> | undefined;",
            "Box<string, string>",
          ],
          [
            "type Box<T> = PerUser<string> | PerUser<T> | undefined;",
            "Box<string>",
          ],
          [
            "type Box<T> = PerUser<T> | PerUser<string> | undefined;",
            "Box<string>",
          ],
        ] as const
      ) {
        expect(await schemaOf(alias, box)).toEqual({
          type: "string",
          scope: "user",
        });
      }
    });

    describe("throws for wrappers written beside `undefined` that read as different types where the type holds one", () => {
      // `PerUser<never>` and `PerSpace<never>` are `never`, which the checker
      // drops from the union, so the type is the other wrapper alone.

      const error =
        "A scope wrapper beside `null` or `undefined` is read from the union written around it";

      it("throws for wrappers of one scope holding different payloads", async () => {
        await expect(
          generate(`
            type Box<T, U> = PerUser<T> | PerUser<U> | undefined;
            type X = Required<{ a?: Box<string, never> }>;
          `),
        ).rejects.toThrow(error);
        await expect(
          generate(
            "type X = Required<{ a?: PerUser<string> | PerUser<never> | undefined }>;",
          ),
        ).rejects.toThrow(error);
      });

      it("throws for wrappers of different scopes", async () => {
        for (
          const union of [
            "PerSpace<never> | PerUser<string> | undefined",
            "PerUser<string> | PerSpace<never> | undefined",
          ]
        ) {
          await expect(
            generate(`type X = Required<{ a?: ${union} }>;`),
          ).rejects.toThrow(error);
        }
      });
    });

    it("emits the payload of a generic alias whose body indexes into a type", async () => {
      // The alias's body is no union to read the wrapper's members from, so
      // the wrapper is read from its type.
      const code = `
        type Box<T> = { v: PerUser<T> | null }["v"];
        interface X { boxed: Box<string>; written: PerUser<string | null> }
      `;

      expect(await propertySchema(code, "boxed")).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
        scope: "user",
      });
      expect(await propertySchema(code, "written")).toEqual(
        await propertySchema(code, "boxed"),
      );
    });

    it("caps the handle of a labelled alias of a labelled cell with the labels of both", async () => {
      // The payload references `Outer`, which references the cell `Handle`
      // is; each definition on the way carries labels of its own.
      expect(
        await propertySchema(
          `${CFC_ALIASES}
          type Handle = Confidential<Writable<string>, ["owner"]>;
          type Outer = Confidential<Handle, ["other"]>;
          interface X { h: PerSpace<Outer> }`,
          "h",
        ),
      ).toEqual({
        type: "string",
        asCell: [{ kind: "cell", scope: "space" }],
        ifc: { confidentiality: ["owner", "other"] },
      });
    });

    it("emits the payload a scope brand holds for a printed payload node it cannot read", async () => {
      // `Mine` names the wrapper's type, so no alias of a scope wrapper
      // supplies the payload, and the brand on the type does.
      const { checker, member } = await interfaceX(`
        interface Stored { name?: string }
        type Mine = PerUser<Stored>;
        interface X { authored: Mine }
      `);

      expect(
        new SchemaGenerator().generateSchema(
          member("authored").type,
          checker,
          helperReference("PerUser", [importTypeNode("Stored")]),
        ),
      ).toEqual({
        $ref: "#/$defs/Stored",
        scope: "user",
        $defs: {
          Stored: { type: "object", properties: { name: { type: "string" } } },
        },
      });
    });
  });

  describe("cell wrappers", () => {
    it("throws for a reference to a cell wrapper with no type argument", async () => {
      await expect(generate("interface X { a: Cell }")).rejects.toThrow(
        "Cell<T> requires type argument",
      );
    });

    it("emits the payload a wrapper's node names where its type's payload is a type parameter", async () => {
      // A type parameter in the type is no payload to read, and the node
      // beside it names one.
      const { checker, member } = await interfaceX(
        "interface X<T> { open: Cell<T>; named: Cell<string> }",
      );
      const generator = new SchemaGenerator();

      expect(
        generator.generateSchema(
          member("open").type,
          checker,
          member("named").node,
        ),
      ).toEqual({ type: "string", asCell: ["cell"] });
      expect(
        generator.generateSchema(member("open").type, checker),
      ).toEqual({ asCell: ["cell"] });
    });

    it("throws for a wrapper's node paired with a union holding a value beside the wrapper", async () => {
      // The node names a cell, and the type holds a number beside it, which
      // no reading of the cell accounts for.
      const { checker, member } = await interfaceX(
        "interface X { mixed: Cell<string> | number; cell: Cell<string> }",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(
          member("mixed").type,
          checker,
          member("cell").node,
        )
      ).toThrow("Unexpected Common Fabric type: `number | Cell<string>`");
    });

    describe("from a synthetic node beside its resolved type", () => {
      // The transformer prints a wrapper's node when it holds no authored
      // one, and the type the wrapper resolves to is formatted beside it.

      /** The schema of `X.a`'s type, which `code` declares, at `node`. */
      async function printedSchema(
        code: string,
        node: ts.TypeNode,
      ): Promise<unknown> {
        const { checker, member } = await interfaceX(
          `interface Stored { name?: string } ${code}`,
        );
        return new SchemaGenerator().generateSchema(
          member("a").type,
          checker,
          node,
        );
      }

      const keyword = (kind: ts.KeywordTypeSyntaxKind) =>
        ts.factory.createKeywordTypeNode(kind);

      it("emits the payload the node names where the resolved payload is `any`", async () => {
        expect(
          await printedSchema(
            "interface X { a: Cell<any> }",
            helperReference("Cell", [keyword(ts.SyntaxKind.StringKeyword)]),
          ),
        ).toEqual({ type: "string", asCell: ["cell"] });
      });

      it("emits the elements the node names where the resolved elements are `any`", async () => {
        expect(
          await printedSchema(
            "interface X { a: Cell<any[]> }",
            helperReference("Cell", [
              ts.factory.createArrayTypeNode(
                keyword(ts.SyntaxKind.StringKeyword),
              ),
            ]),
          ),
        ).toEqual({
          type: "array",
          items: { type: "string" },
          asCell: ["cell"],
        });
      });

      it("emits the resolved elements where they are usable", async () => {
        // The printed node names strings, which the resolved numbers
        // override.
        expect(
          await printedSchema(
            "interface X { a: Cell<number[]> }",
            helperReference("Cell", [
              ts.factory.createArrayTypeNode(
                keyword(ts.SyntaxKind.StringKeyword),
              ),
            ]),
          ),
        ).toEqual({
          type: "array",
          items: { type: "number" },
          asCell: ["cell"],
        });
      });

      it("emits the resolved payload where a narrowed node's payload names nothing the checker resolves", async () => {
        // The node narrows the resolved `Cell` to `ReadonlyCell`, and its
        // payload's name resolves to nothing from a synthetic position.
        expect(
          await printedSchema(
            "interface X { a: Cell<Stored> }",
            helperReference("ReadonlyCell", [
              ts.factory.createTypeReferenceNode("Stored"),
            ]),
          ),
        ).toEqual({
          $ref: "#/$defs/Stored",
          asCell: ["readonly"],
          $defs: {
            Stored: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        });
      });
    });

    describe("from a synthetic node", () => {
      // A synthetic node names nothing the checker resolves, so the type
      // beside it is `any` and the node is read alone.

      async function synthesize(
        node: ts.TypeNode,
      ): Promise<{
        schema: ReturnType<SchemaGenerator["generateSchema"]>;
        diagnostics: SchemaGenerationDiagnostic[];
      }> {
        const { checker, sourceFile } = await createTestProgram("");
        const diagnostics: SchemaGenerationDiagnostic[] = [];
        const schema = new SchemaGenerator()
          .generateSchemaFromSyntheticTypeNode(
            node,
            checker,
            undefined,
            undefined,
            sourceFile,
            { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
          );
        return { schema, diagnostics };
      }

      it("emits a stream of anything for a stream of `any`", async () => {
        expect(
          (await synthesize(
            helperReference("Stream", [
              ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
            ]),
          )).schema,
        ).toEqual({ asCell: ["stream"] });
      });

      it("throws for a cell of a stream", async () => {
        await expect(synthesize(
          helperReference("Cell", [
            helperReference("Stream", [
              ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            ]),
          ]),
        )).rejects.toThrow("Cell<Stream<T>> is unsupported");
      });

      it("reports a payload it cannot read where no type supplies one", async () => {
        const { schema, diagnostics } = await synthesize(
          helperReference("Cell", [importTypeNode("Stored")]),
        );

        expect(schema).toEqual({ asCell: ["cell"] });
        expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
          "schema-type:unread",
        ]);
      });
    });
  });

  describe("wrapper unions", () => {
    it("emits one schema for two cells whose schemas are equal", async () => {
      // `readonly` makes the payloads two types, and no schema tells them
      // apart.
      expect(
        await propertySchema(
          "interface X { a: Cell<{ a: string }> | Cell<{ readonly a: string }> }",
          "a",
        ),
      ).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        asCell: ["cell"],
      });
    });
  });

  describe("Default", () => {
    for (
      const [form, declaration, reference] of [
        ["no type argument", "type Default = string;", "Default"],
        [
          "three type arguments",
          "type Default<A, B, C> = A;",
          `Default<string, "x", 1>`,
        ],
      ] as const
    ) {
      it(`throws for a reference to \`Default\` with ${form}`, async () => {
        // `Default` is recognized by name.

        await expect(
          generate(`${declaration} interface X { a: ${reference} }`),
        ).rejects.toThrow("Default<T,V> requires 1 or 2 type arguments");
      });
    }

    describe("read from its type alone", () => {
      // A mapped type's member has no node of its own, so `Default` is read
      // from the alias its type carries.

      it("emits the default the second type argument spells", async () => {
        expect(
          await propertySchema(
            `${DEFAULT_ALIAS} type X = { [K in "a"]: Default<string, "hi"> };`,
            "a",
          ),
        ).toEqual({ type: "string", default: "hi" });
      });

      it("emits the value type as the default where only it is given", async () => {
        const { schema, diagnostics } = await generate(
          `${DEFAULT_ALIAS} type X = { [K in "a"]: Default<"z"> };`,
        );

        expect(asObjectSchema(schema).properties?.a).toEqual({
          type: "string",
          enum: ["z"],
          default: "z",
        });
        expect(diagnostics).toEqual([]);
      });

      it("emits a tuple default", async () => {
        const { schema, diagnostics } = await generate(
          `${DEFAULT_ALIAS} type X = { [K in "a"]: Default<string[], ["x"]> };`,
        );

        expect(asObjectSchema(schema).properties?.a).toEqual({
          type: "array",
          items: { type: "string" },
          default: ["x"],
        });
        expect(diagnostics).toEqual([]);
      });

      it("emits an object default", async () => {
        const { schema, diagnostics } = await generate(
          `${DEFAULT_ALIAS} type X = { [K in "a"]: Default<{ b: string }, { b: "x" }> };`,
        );

        expect(asObjectSchema(schema).properties?.a).toEqual({
          type: "object",
          properties: { b: { type: "string" } },
          required: ["b"],
          default: { b: "x" },
        });
        expect(diagnostics).toEqual([]);
      });

      it("reports a tuple default with an element no literal spells", async () => {
        const { schema, diagnostics } = await generate(
          `${DEFAULT_ALIAS} type X = { [K in "a"]: Default<string[], ["x", string]> };`,
        );

        expect(asObjectSchema(schema).properties?.a).toEqual({
          type: "array",
          items: { type: "string" },
        });
        expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
          "schema-default:unresolved",
        ]);
      });

      it("reports a default no literal spells", async () => {
        const { schema, diagnostics } = await generate(
          `${DEFAULT_ALIAS} type X = { [K in "a"]: Default<string, string> };`,
        );

        expect(asObjectSchema(schema).properties?.a).toEqual({
          type: "string",
        });
        expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
          "schema-default:unresolved",
        ]);
      });
    });

    describe("read from an alias of its default", () => {
      for (
        const [literal, valueType, expected] of [
          [`"x"`, "string", "x"],
          ["5", "number", 5],
          ["true", "boolean", true],
          ["null", "string | null", null],
        ] as const
      ) {
        it(`emits the default \`${literal}\` an alias names`, async () => {
          const schema = await propertySchema(
            `${DEFAULT_ALIAS}
            type V = ${literal};
            interface X { a: Default<${valueType}, V> }`,
            "a",
          );

          expect((schema as { default?: unknown }).default).toBe(expected);
        });
      }

      it("reports `undefined` an alias names as no default", async () => {
        const { schema, diagnostics } = await generate(`${DEFAULT_ALIAS}
          type V = undefined;
          interface X { a: Default<string | undefined, V> }`);

        expect(asObjectSchema(schema).properties?.a).toEqual({
          type: ["string", "undefined"],
        });
        expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
          "schema-default:unresolved",
        ]);
      });
    });

    describe("read from the type a reference names", () => {
      // The default is a reference, so it is read from its type, by the
      // common-fabric formatter alone and by the union formatter beside
      // `null`, each reading it the same way.

      /** The default and the diagnostics of `a: Default<valueType, V>`. */
      const read = async (declarations: string, valueType: string) => {
        const { schema, diagnostics } = await generate(
          `${DEFAULT_ALIAS} ${declarations} interface X { a: ${valueType} }`,
        );
        const a = asObjectSchema(schema).properties?.a;
        return {
          value: typeof a === "object" ? a.default : undefined,
          diagnostics: diagnostics.map((diagnostic) => diagnostic.type),
        };
      };

      for (
        const [declarations, value, expected] of [
          ['interface V { b: "x" }', "{ b: string }", { b: "x" }],
          ['type V = ["x", 1];', "(string | number)[]", ["x", 1]],
          ["interface V {}", "{ b?: string }", {}],
          ["type V = {} & {};", "{ b?: string }", {}],
        ] as const
      ) {
        it(`emits the default \`${declarations}\` spells, with and without \`| null\``, async () => {
          expect(await read(declarations, `Default<${value}, V>`)).toEqual({
            value: expected,
            diagnostics: [],
          });
          expect(await read(declarations, `Default<${value}, V> | null`))
            .toEqual({ value: expected, diagnostics: [] });
        });
      }

      it("reports an object with a member no literal spells, with and without `| null`", async () => {
        const unresolved = {
          value: undefined,
          diagnostics: ["schema-default:unresolved"],
        };

        expect(
          await read("interface V { b: string }", "Default<{ b: string }, V>"),
        ).toEqual(unresolved);
        expect(
          await read(
            "interface V { b: string }",
            "Default<{ b: string }, V> | null",
          ),
        ).toEqual(unresolved);
      });

      it("emits an empty object default a mapped type's member reads from its type", async () => {
        // The member has no node, and `{}` is the checker's one empty type
        // literal, whose symbol has no declaration.
        expect(
          await propertySchema(
            `${DEFAULT_ALIAS} type X = { [K in "a"]: Default<{ b?: string }, {}> };`,
            "a",
          ),
        ).toEqual({
          type: "object",
          properties: { b: { type: "string" } },
          default: {},
        });
      });
    });

    it("reports a default object with a member whose name has no text", async () => {
      const { diagnostics } = await generate(`${DEFAULT_ALIAS}
        declare const key: unique symbol;
        interface X { a: Default<{ [key]: string }, { [key]: "x" }> }`);

      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "schema-default:unresolved",
      ]);
    });

    it("reports a default that queries a name nothing declares", async () => {
      const { schema, diagnostics } = await generate(`${DEFAULT_ALIAS}
        interface X { a: Default<string, typeof missing> }`);

      expect(asObjectSchema(schema).properties?.a).toEqual({ type: "string" });
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "schema-default:unresolved",
      ]);
    });
  });

  describe("labels", () => {
    describe("projection paths", () => {
      it("emits a path written as a string as it is", async () => {
        expect(
          await propertySchema(
            `${CFC_ALIASES} interface X {
              a: ProjectionPath<{ t: string }, "/source", "/raw/path">;
            }`,
            "a",
          ),
        ).toMatchObject({
          ifc: { projection: { from: "/source", path: "/raw/path" } },
        });
      });

      it("emits the root for an empty path", async () => {
        expect(
          await propertySchema(
            `${CFC_ALIASES} interface X { a: ProjectionOf<{ t: string }, readonly []> }`,
            "a",
          ),
        ).toMatchObject({ ifc: { projection: { from: "/", path: "/" } } });
      });

      it("emits no projection and reports the path for a path holding a number", async () => {
        const { schema, diagnostics } = await generate(
          `${CFC_ALIASES} interface X { a: ProjectionOf<{ t: string }, readonly [1]> }`,
        );

        expect(asObjectSchema(schema).properties?.a).toEqual({
          type: "object",
          properties: { t: { type: "string" } },
          required: ["t"],
        });
        expect(
          diagnostics.map(({ severity, type, message }) => ({
            severity,
            type,
            message,
          })),
        ).toEqual([{
          severity: "warning",
          type: "cfc-label:unread",
          message: "The projection path of `ProjectionOf` could not be read: " +
            "`readonly [1]`. A path is a JSON Pointer string or a tuple of " +
            "string literals; the schema carries no projection for it.",
        }]);
      });

      it("reports nothing for a path that reads", async () => {
        const { diagnostics } = await generate(
          `${CFC_ALIASES} interface X { a: ProjectionOf<{ t: string }, readonly ["t"]> }`,
        );

        expect(diagnostics).toEqual([]);
      });
    });

    describe("values spread into a tuple", () => {
      // An element spread from a tuple is read from its syntax alone.

      it("emits `null` for a spread `null`", async () => {
        expect(
          await propertySchema(
            `${CFC_ALIASES} interface X { a: ExactCopy<string, readonly [...[null]]> }`,
            "a",
          ),
        ).toEqual({ type: "string", ifc: { exactCopyOf: [null] } });
      });

      it("emits a negative number the tuple's type spells", async () => {
        // A negative number is no literal syntax, so the tuple is left to
        // its type.
        expect(
          await propertySchema(
            `${CFC_ALIASES} interface X { a: ExactCopy<string, readonly [...[-1]]> }`,
            "a",
          ),
        ).toEqual({ type: "string", ifc: { exactCopyOf: [-1] } });
      });
    });

    it("emits the value an interface a label names spells", async () => {
      expect(
        await propertySchema(
          `${CFC_ALIASES}
          interface Literal { a: "x" }
          interface X { a: ExactCopy<string, Literal> }`,
          "a",
        ),
      ).toEqual({ type: "string", ifc: { exactCopyOf: { a: "x" } } });
    });

    it("reports a label tuple with an optional element as unread", async () => {
      const read = async (labels: string) => {
        const { diagnostics } = await generate(
          `${CFC_ALIASES} interface X { a: Confidential<string, ${labels}> }`,
        );
        return diagnostics.map((diagnostic) => diagnostic.type);
      };

      expect(await read(`readonly ["a", "b"?]`)).toEqual(["cfc-label:unread"]);
      expect(await read(`readonly ["a", "b"]`)).toEqual([]);
    });

    describe("read from its type alone", () => {
      for (
        const [literal, expected] of [
          ["5", 5],
          ["true", true],
          ["null", null],
        ] as const
      ) {
        it(`emits the value \`${literal}\``, async () => {
          expect(
            await propertySchema(
              `${CFC_ALIASES} type X = { [K in "a"]: ExactCopy<number, ${literal}> };`,
              "a",
            ),
          ).toEqual({ type: "number", ifc: { exactCopyOf: expected } });
        });
      }

      it("emits no value for `undefined`", async () => {
        expect(
          await propertySchema(
            `${CFC_ALIASES} type X = { [K in "a"]: ExactCopy<number, undefined> };`,
            "a",
          ),
        ).toEqual({ type: "number", ifc: {} });
      });
    });

    it("emits the evidence of a value intersected with a mapped copy of itself", async () => {
      // `Partial<L>` copies `L`'s carrier from `L`, which the intersection
      // holds as well, so nothing writes over the members the evidence is
      // about.
      expect(
        await propertySchema(
          `${CFC_ALIASES}
          type L = Integrity<{ a: string }, readonly ["s"]>;
          interface X { v: Partial<L> & L }`,
          "v",
        ),
      ).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        ifc: { integrity: ["s"] },
      });
    });
  });
});
