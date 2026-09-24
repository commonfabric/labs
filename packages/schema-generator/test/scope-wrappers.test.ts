import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";
import type { JSONSchemaObj } from "@commonfabric/api";
import { SchemaGenerator } from "../src/schema-generator.ts";
import {
  createTestProgram,
  getTypeFromCode,
  getTypeFromFiles,
} from "./utils.ts";

describe("Scope wrappers", () => {
  it("rejects nested scope wrappers without a cell boundary", async () => {
    const code = `
interface SchemaRoot {
  invalid: PerUser<PerSession<string>>;
}
`;
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("Nested scope wrappers require a cell boundary between scopes.");
  });

  it("throws for a scope wrapper that is a union member", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string> | undefined;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope wrapper around a cell that is a union member", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<Cell<string>> | undefined;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope wrapper unioned with a value type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string> | null;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope inside a cell that is a union member", async () => {
    // `Cell<PerSession<T>>` puts the scope on the sibling key next to a string
    // `asCell` entry, so the branch carries `{asCell: ["cell"], scope: ...}`.
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: Cell<PerSession<string>> | undefined;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("emits a scope beside a string asCell entry outside a union", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: Cell<PerSession<string>>;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    expect((schema as JSONSchemaObj).properties?.draft).toEqual({
      type: "string",
      scope: "session",
      asCell: ["cell"],
    });
  });

  it("emits a top-level scope for an optional scoped property", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft?: PerUser<string>;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    expect((schema as JSONSchemaObj).properties?.draft).toEqual({
      type: "string",
      scope: "user",
    });
  });

  it("emits a top-level scope when the union is inside the wrapper", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string | undefined>;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    expect((schema as JSONSchemaObj).properties?.draft).toEqual({
      type: ["string", "undefined"],
      scope: "user",
    });
  });

  it("emits a scoped property nested in an object that is a union member", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  holder: { draft: PerUser<string> } | undefined;
}
`,
      "SchemaRoot",
    );

    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      typeNode,
    );
    const branches =
      ((schema as JSONSchemaObj).properties?.holder as JSONSchemaObj).anyOf as
        | JSONSchemaObj[]
        | undefined;
    // The scope sits at the top level of `draft`'s own schema, which is where
    // the write path reads it, so nesting under a union branch is fine.
    expect(
      branches?.some((branch) =>
        (branch.properties?.draft as JSONSchemaObj | undefined)?.scope ===
          "user"
      ),
    ).toBe(true);
  });
  describe("a scope wrapper reached through an alias", () => {
    // The checker reports the outermost alias, not the wrapper, as the type's
    // alias symbol, so the scope is found by following the alias.

    async function propertySchemas(
      code: string,
    ): Promise<Record<string, unknown>> {
      const { type, checker, typeNode } = await getTypeFromCode(
        code,
        "SchemaRoot",
      );
      const schema = new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
      ) as JSONSchemaObj;
      return { ...schema.properties, $defs: schema.$defs };
    }

    const INNER_DEF = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };

    it("emits the scope for an alias of a scope wrapper, inline", async () => {
      const schemas = await propertySchemas(`
type Inner = { a: string };
type Rec = PerUser<Inner>;
interface SchemaRoot { run: Cell<Rec>; plain: Rec; }
`);

      expect(schemas.run).toEqual({
        $ref: "#/$defs/Inner",
        scope: "user",
        asCell: ["cell"],
      });
      expect(schemas.plain).toEqual({ $ref: "#/$defs/Inner", scope: "user" });
      // A definition holding the scope would take it off the slot's own top
      // level, where the write path reads it.
      expect(schemas.$defs).toEqual({ Inner: INNER_DEF });
    });

    it("emits the scope for an alias of an alias of a scope wrapper", async () => {
      const schemas = await propertySchemas(`
type Inner = { a: string };
type Rec = PerUser<Inner>;
type Outer = Rec;
interface SchemaRoot { run: Cell<Outer>; }
`);

      expect(schemas.run).toEqual({
        $ref: "#/$defs/Inner",
        scope: "user",
        asCell: ["cell"],
      });
      expect(schemas.$defs).toEqual({ Inner: INNER_DEF });
    });

    it("emits the scope for a generic alias of a scope wrapper", async () => {
      const schemas = await propertySchemas(`
type Inner = { a: string };
type Rec<T> = PerSession<T>;
interface SchemaRoot { run: Cell<Rec<Inner>>; }
`);

      expect(schemas.run).toEqual({
        $ref: "#/$defs/Inner",
        scope: "session",
        asCell: ["cell"],
      });
    });

    it("substitutes a generic alias's argument into the payload", async () => {
      const schemas = await propertySchemas(`
type Rec<T> = PerUser<{ value: T }>;
interface SchemaRoot { run: Rec<string>; }
`);

      expect(schemas.run).toEqual({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        scope: "user",
      });
    });

    it("puts the scope on the cell entry for an alias wrapping a cell", async () => {
      const schemas = await propertySchemas(`
type Draft = PerSession<Cell<string>>;
interface SchemaRoot { draft: Draft; }
`);

      expect(schemas.draft).toEqual({
        type: "string",
        asCell: [{ kind: "cell", scope: "session" }],
      });
    });

    /** The schema of `SchemaRoot.run` in `/main.ts` of `files`. */
    async function runSchema(files: Record<string, string>) {
      const { type, checker, typeNode } = await getTypeFromFiles(
        files,
        "/main.ts",
        "SchemaRoot",
      );
      const schema = new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
      ) as JSONSchemaObj;
      return schema.properties?.run;
    }

    it("follows an alias to a same-named alias in another module", async () => {
      expect(
        await runSchema({
          "/records.ts": "export type Scoped<T> = PerUser<T>;",
          "/main.ts": 'import type { Scoped as Base } from "./records.ts";\n' +
            "export type Scoped<T> = Base<T>;\n" +
            "export interface SchemaRoot { run: Scoped<{ a: string }> }",
        }),
      ).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        scope: "user",
      });
    });

    it("follows an alias to a namespace-qualified scope wrapper", async () => {
      expect(
        await runSchema({
          "/main.ts": 'import type * as cf from "commonfabric";\n' +
            "type Rec = cf.PerSession<{ a: string }>;\n" +
            "export interface SchemaRoot { run: Rec }",
        }),
      ).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        scope: "session",
      });
    });

    it("follows an alias to a same-named alias in a namespace", async () => {
      const schemas = await propertySchemas(`
namespace Records { export type Rec<T> = PerUser<T>; }
type Rec<T> = Records.Rec<T>;
interface SchemaRoot { run: Rec<{ a: string }>; }
`);

      expect(schemas.run).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        scope: "user",
      });
    });

    it("keeps the scope on each reference to a recursive alias", async () => {
      // A recursive type is written once under `$defs`; the scope is each
      // slot's own declaration, so it stays with the reference.

      const schemas = await propertySchemas(`
type Node = PerUser<{ label: string; next?: Cell<Node> }>;
interface SchemaRoot { head: Node; }
`);

      const defs = schemas.$defs as Record<string, unknown>;
      const [name] = Object.keys(defs);
      expect(schemas.head).toEqual({ $ref: `#/$defs/${name}`, scope: "user" });
      expect(defs).toEqual({
        [name!]: {
          type: "object",
          properties: {
            label: { type: "string" },
            next: {
              $ref: `#/$defs/${name}`,
              scope: "user",
              asCell: ["cell"],
            },
          },
          required: ["label"],
        },
      });
    });

    it("keeps the scope in the cell entry of each reference to a recursive cell alias", async () => {
      // A scope around a cell caps the handle, so it belongs in the `asCell`
      // entry of every reference and nowhere in the definition.

      const schemas = await propertySchemas(`
type Node = PerUser<Cell<{ label: string; next?: Node }>>;
interface SchemaRoot { head: Node; }
`);

      const defs = schemas.$defs as Record<string, unknown>;
      const [name] = Object.keys(defs);
      const handle = {
        $ref: `#/$defs/${name}`,
        asCell: [{ kind: "cell", scope: "user" }],
      };
      expect(schemas.head).toEqual(handle);
      expect(defs).toEqual({
        [name!]: {
          type: "object",
          properties: { label: { type: "string" }, next: handle },
          required: ["label"],
        },
      });
    });

    it("throws for an alias of a scope wrapper that is a union member", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
type Draft = PerUser<Cell<string>>;
interface SchemaRoot { draft: Draft | undefined; }
`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow("A scope wrapper cannot be a member of a union.");
    });
  });

  describe("a synthetic node carrying a printed payload", () => {
    // The transformer prints a binding's type into `__cfHelpers.PerUser<...>`
    // when it holds no authored node for the payload. Each case pairs the
    // resolved wrapper with such a node, the way a preserved binding reaches
    // this formatter.

    const PRELUDE = `
      declare const DEFAULT_MARKER: unique symbol;
      type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
      type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
      interface Stored { name?: string }
    `;
    const named = (name: string) => ts.factory.createTypeReferenceNode(name);

    /** The schema for a resolved `PerUser<valueType>` printed as `innerNode`. */
    async function printedSchema(
      valueType: string,
      innerNode: ts.TypeNode,
    ): Promise<unknown> {
      const { checker, sourceFile } = await createTestProgram(
        `${PRELUDE} interface X { authored: PerUser<${valueType}>; }`,
      );
      const symbol = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "X");
      if (!symbol) throw new Error("Interface X not found");
      const authored = checker.getDeclaredTypeOfSymbol(symbol)
        .getProperty("authored");
      if (!authored) throw new Error("Property X.authored not found");

      return new SchemaGenerator().generateSchema(
        checker.getTypeOfSymbolAtLocation(authored, sourceFile),
        checker,
        ts.factory.createTypeReferenceNode(
          ts.factory.createQualifiedName(
            ts.factory.createIdentifier("__cfHelpers"),
            ts.factory.createIdentifier("PerUser"),
          ),
          [innerNode],
        ),
      );
    }

    it("emits the resolved payload for a name printed as an import type", async () => {
      // The printer writes `import("./types.ts").Stored` for a name the
      // emitting module does not import, which no scope lookup resolves. A
      // payload read as `any` would leave the slot accepting anything.
      const schema = await printedSchema(
        "Stored",
        ts.factory.createImportTypeNode(
          ts.factory.createLiteralTypeNode(
            ts.factory.createStringLiteral("./types.ts"),
          ),
          undefined,
          ts.factory.createIdentifier("Stored"),
        ),
      );

      expect(schema).toEqual({
        $ref: "#/$defs/Stored",
        scope: "user",
        $defs: {
          Stored: { type: "object", properties: { name: { type: "string" } } },
        },
      });
    });

    it("emits the resolved payload for a wrapper printed without its default argument", async () => {
      // The printer leaves out an argument equal to the parameter's default,
      // writing `SqliteDb` for `SqliteDb<SqliteDatabase>`, and the printed
      // name resolves to nothing, so the node names no payload for it.
      const printed = await printedSchema(
        "{ db: SqliteDb }",
        ts.factory.createTypeLiteralNode([
          ts.factory.createPropertySignature(
            undefined,
            "db",
            undefined,
            ts.factory.createTypeReferenceNode(
              ts.factory.createQualifiedName(
                ts.factory.createIdentifier("__cfHelpers"),
                ts.factory.createIdentifier("SqliteDb"),
              ),
            ),
          ),
        ]),
      );
      const { type, checker, typeNode } = await getTypeFromCode(
        "type Authored = PerUser<{ db: SqliteDb }>;",
        "Authored",
      );

      expect(printed).toEqual(
        new SchemaGenerator().generateSchema(type, checker, typeNode),
      );
    });

    it("reads a union member printed under a name the module does not import as the type it was printed from", async () => {
      // The transformer prints a type by the name its declaring module gives
      // it and records the type, which is then all that says what it is.
      const { checker, sourceFile } = await createTestProgram(
        `${PRELUDE} interface X { authored: Stored; }`,
      );
      const symbol = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "X");
      if (!symbol) throw new Error("Interface X not found");
      const authored = checker.getDeclaredTypeOfSymbol(symbol)
        .getProperty("authored");
      if (!authored) throw new Error("Property X.authored not found");
      const printed = named("Elsewhere");
      const printedType = checker.getTypeOfSymbolAtLocation(
        authored,
        sourceFile,
      );

      const schema = new SchemaGenerator().generateSchemaFromSyntheticTypeNode(
        ts.factory.createTypeReferenceNode(
          ts.factory.createQualifiedName(
            ts.factory.createIdentifier("__cfHelpers"),
            ts.factory.createIdentifier("PerUser"),
          ),
          [
            ts.factory.createUnionTypeNode([
              printed,
              ts.factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
            ]),
          ],
        ),
        checker,
        undefined,
        undefined,
        sourceFile,
        {
          printedFrom: (node) => node === printed ? printedType : undefined,
        },
      );

      expect(schema).toEqual({
        anyOf: [{ $ref: "#/$defs/Stored" }, { type: "undefined" }],
        scope: "user",
        $defs: {
          Stored: { type: "object", properties: { name: { type: "string" } } },
        },
      });
    });

    it("emits the resolved payload and its default when only the computed brand cannot be read", async () => {
      // The arm carrying the default is the one node analysis cannot read.
      const schema = await printedSchema(
        'Default<string, "x">',
        ts.factory.createUnionTypeNode([
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ts.factory.createIntersectionTypeNode([
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            ts.factory.createTypeLiteralNode([
              ts.factory.createPropertySignature(
                [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                ts.factory.createComputedPropertyName(
                  ts.factory.createIdentifier("DEFAULT_MARKER"),
                ),
                undefined,
                ts.factory.createLiteralTypeNode(
                  ts.factory.createStringLiteral("x"),
                ),
              ),
            ]),
          ]),
        ]),
      );

      expect(schema).toEqual({ type: "string", default: "x", scope: "user" });
    });

    it("reports a payload it could not read when the wrapper type holds none", async () => {
      // A node names the wrapper where the type resolved beside it does not,
      // so nothing supplies the payload. What the node could be read for
      // stands, and the part that could not is passed outward rather than
      // silently standing as the value's whole schema.
      const { checker, sourceFile } = await createTestProgram(
        `${PRELUDE} interface X { authored: Stored; }`,
      );
      const symbol = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "X");
      if (!symbol) throw new Error("Interface X not found");
      const authored = checker.getDeclaredTypeOfSymbol(symbol)
        .getProperty("authored");
      if (!authored) throw new Error("Property X.authored not found");

      const schema = new SchemaGenerator().generateSchema(
        checker.getTypeOfSymbolAtLocation(authored, sourceFile),
        checker,
        ts.factory.createTypeReferenceNode(
          ts.factory.createQualifiedName(
            ts.factory.createIdentifier("__cfHelpers"),
            ts.factory.createIdentifier("PerUser"),
          ),
          [ts.factory.createTypeLiteralNode([
            ts.factory.createPropertySignature(
              [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
              ts.factory.createComputedPropertyName(
                ts.factory.createIdentifier("DEFAULT_MARKER"),
              ),
              undefined,
              named("Stored"),
            ),
          ])],
        ),
      );

      expect(schema).toEqual({
        type: "object",
        properties: {},
        scope: "user",
      });
    });
  });
});
