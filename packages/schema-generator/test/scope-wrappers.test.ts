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

/**
 * The scope a slot declares where the write path reads it: the outermost
 * `asCell` entry, otherwise the top-level `scope`.
 */
const declaredScope = (schema: JSONSchemaObj | undefined): unknown => {
  const entry = schema?.asCell?.[0];
  return typeof entry === "object" && entry.scope !== undefined
    ? entry.scope
    : schema?.scope;
};

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

  describe("reached through a type alias", () => {
    // What each wrapper is applied to. Every row is emitted twice, once behind
    // an alias and once written at the property, and the two must agree.
    const WRAPPED = {
      plain: "string",
      flag: "boolean",
      literals: '"a" | "b"',
      optionalInner: "string | undefined",
      list: "string[]",
      object: "{ nickname: string }",
      named: "Named",
      cell: "Cell<string>",
    };
    const SCOPES = {
      PerSpace: "space",
      PerUser: "user",
      PerSession: "session",
      PerAny: "any",
    };

    const propertiesOf = async (code: string) => {
      const { type, checker, typeNode } = await getTypeFromCode(
        code,
        "SchemaRoot",
      );
      const schema = new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
      ) as JSONSchemaObj;
      return {
        properties: (schema.properties ?? {}) as Record<string, JSONSchemaObj>,
        defs: Object.keys(schema.$defs ?? {}),
      };
    };

    for (const [wrapper, scope] of Object.entries(SCOPES)) {
      it(`emits the inline schema for an aliased ${wrapper}`, async () => {
        const names = Object.keys(WRAPPED);
        const { properties, defs } = await propertiesOf(`
interface Named { nickname: string }
${
          Object.entries(WRAPPED).map(([name, inner]) =>
            `type Alias_${name} = ${wrapper}<${inner}>;`
          ).join("\n")
        }
interface SchemaRoot {
${
          Object.entries(WRAPPED).map(([name, inner]) =>
            `  ${name}Alias: Alias_${name};\n  ${name}Inline: ${wrapper}<${inner}>;`
          ).join("\n")
        }
}
`);

        for (const name of names) {
          expect(declaredScope(properties[`${name}Inline`])).toBe(scope);
          expect(properties[`${name}Alias`]).toEqual(
            properties[`${name}Inline`],
          );
        }
        // The scope belongs to the slot, which a definition shared by every
        // use of the alias is not.
        expect(defs).toEqual(["Named"]);
      });
    }

    it("emits the inline schema for an alias of an alias", async () => {
      const { properties } = await propertiesOf(`
type Scoped = PerUser<string>;
type Renamed = Scoped;
interface SchemaRoot {
  alias: Renamed;
  inline: PerUser<string>;
}
`);

      expect(properties.alias).toEqual({ type: "string", scope: "user" });
      expect(properties.alias).toEqual(properties.inline);
    });

    it("emits the inline schema for an alias imported from another file", async () => {
      const { type, checker, typeNode } = await getTypeFromFiles(
        {
          "/types.ts": `
export interface Named { nickname: string }
export type ScopedText = PerUser<string>;
export type ScopedNamed = PerSession<Named>;
export type ScopedCell = PerUser<Cell<number>>;
`,
          "/main.ts": `
import type { Named, ScopedCell, ScopedNamed, ScopedText } from "./types.ts";
interface SchemaRoot {
  textAlias: ScopedText;
  textInline: PerUser<string>;
  namedAlias: ScopedNamed;
  namedInline: PerSession<Named>;
  cellAlias: ScopedCell;
  cellInline: PerUser<Cell<number>>;
}
`,
        },
        "/main.ts",
        "SchemaRoot",
      );
      const properties = (new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
      ) as JSONSchemaObj).properties as Record<string, JSONSchemaObj>;

      expect(declaredScope(properties.textAlias)).toBe("user");
      expect(declaredScope(properties.namedAlias)).toBe("session");
      expect(declaredScope(properties.cellAlias)).toBe("user");
      for (const name of ["text", "named", "cell"]) {
        expect(properties[`${name}Alias`]).toEqual(
          properties[`${name}Inline`],
        );
      }
    });

    it("emits the inline schema for a generic alias", async () => {
      const { properties } = await propertiesOf(`
interface Named { nickname: string }
type Mine<T> = PerUser<T>;
type MineList<T> = PerSession<T[]>;
interface SchemaRoot {
  plainAlias: Mine<string>;
  plainInline: PerUser<string>;
  flagAlias: Mine<boolean>;
  flagInline: PerUser<boolean>;
  namedAlias: Mine<Named>;
  namedInline: PerUser<Named>;
  cellAlias: Mine<Cell<string>>;
  cellInline: PerUser<Cell<string>>;
  listAlias: MineList<string>;
  listInline: PerSession<string[]>;
}
`);

      for (const name of ["plain", "flag", "named", "cell", "list"]) {
        expect(declaredScope(properties[`${name}Inline`])).toBeDefined();
        expect(properties[`${name}Alias`]).toEqual(
          properties[`${name}Inline`],
        );
      }
    });

    it("emits the scope of a brand declared under another name", async () => {
      // The wrapper names are a spelling; the brand is what the type carries.
      const { properties } = await propertiesOf(`
type Tagged<T, S extends string> = T & { readonly [SCOPE_BRAND]?: S };
interface SchemaRoot {
  draft: Tagged<string, "session">;
  handle: Tagged<Cell<string>, "user">;
}
`);

      expect(properties.draft).toEqual({ type: "string", scope: "session" });
      expect(properties.handle).toEqual({
        type: "string",
        asCell: [{ kind: "cell", scope: "user" }],
      });
    });

    it("emits the scope beside the metadata of a CFC alias", async () => {
      // A CFC alias intersects its own marker onto the type it wraps, so one
      // around a scope wrapper carries the scope brand too.
      const { properties, defs } = await propertiesOf(`
type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
type Confidential<T, X extends readonly unknown[]> =
  Cfc<T, { confidentiality: X }>;
type Secret = Confidential<PerUser<string>, readonly ["reader-a"]>;
type ScopedSecret = PerUser<Confidential<string, readonly ["reader-a"]>>;
interface SchemaRoot {
  outsideInline: Confidential<PerUser<string>, readonly ["reader-a"]>;
  outsideAlias: Secret;
  insideInline: PerUser<Confidential<string, readonly ["reader-a"]>>;
  insideAlias: ScopedSecret;
  cell: Confidential<PerUser<Cell<string>>, readonly ["reader-a"]>;
}
`);
      const scoped = {
        type: "string",
        scope: "user",
        ifc: { confidentiality: ["reader-a"] },
      };

      expect(properties.outsideInline).toEqual(scoped);
      expect(properties.outsideAlias).toEqual(scoped);
      expect(properties.insideInline).toEqual(scoped);
      expect(properties.insideAlias).toEqual(scoped);
      expect(properties.cell).toEqual({
        type: "string",
        asCell: [{ kind: "cell", scope: "user" }],
        ifc: { confidentiality: ["reader-a"] },
      });
      expect(defs).toEqual([]);
    });

    it("emits the scope beside the default of a Default around a wrapper", async () => {
      // `Default<T, V>` is a union over `T`, so one around a scope wrapper
      // carries the scope brand on every member.
      const { properties, defs } = await propertiesOf(`
declare const DEFAULT_MARKER: unique symbol;
type Default<T, V = T> = T | (T & { readonly [DEFAULT_MARKER]: V });
type Greeting = Default<PerUser<string>, "hello">;
interface SchemaRoot {
  inline: Default<PerUser<string>, "hello">;
  alias: Greeting;
}
`);

      expect(properties.inline).toEqual({
        type: "string",
        scope: "user",
        default: "hello",
      });
      expect(properties.alias).toEqual(properties.inline);
      expect(defs).toEqual([]);
    });

    it("emits the scope of an aliased wrapper inside a container", async () => {
      const { properties, defs } = await propertiesOf(`
type Nickname = PerUser<string>;
interface Holder { nickname: Nickname }
interface SchemaRoot {
  list: Nickname[];
  record: Record<string, Nickname>;
  cell: Cell<Nickname>;
  nested: { inner?: Nickname };
  indexed: Holder["nickname"];
}
`);
      const scoped = { type: "string", scope: "user" };

      expect(properties.list?.items).toEqual(scoped);
      expect(properties.record?.additionalProperties).toEqual(scoped);
      expect(properties.cell).toEqual({ ...scoped, asCell: ["cell"] });
      expect(properties.nested?.properties?.inner).toEqual(scoped);
      expect(properties.indexed).toEqual(scoped);
      expect(defs).toEqual([]);
    });

    it("throws for nested scope wrappers behind an alias", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
type Twice = PerUser<PerSession<string>>;
interface SchemaRoot {
  invalid: Twice;
}
`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow(
        "Nested scope wrappers require a cell boundary between scopes.",
      );
    });

    it("throws for an aliased scope wrapper that is a union member", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
type Scoped = PerUser<string>;
interface SchemaRoot {
  draft: Scoped | undefined;
}
`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow("A scope wrapper cannot be a member of a union.");
    });

    it("throws for an aliased scoped cell that is a union member", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
type ScopedCell = PerUser<Cell<string>>;
interface SchemaRoot {
  draft: ScopedCell | undefined;
}
`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow("A scope wrapper cannot be a member of a union.");
    });

    it("emits the scope beside the value schema of a type that kept the brand", async () => {
      // A mapped type copies the brand in beside the data properties, and a
      // wider intersection leaves it among several constituents. Neither has a
      // single wrapped type to format.
      const { properties, defs } = await propertiesOf(`
interface Named { nickname: string }
interface Branded { readonly [SCOPE_BRAND]?: "session"; label: string }
interface SchemaRoot {
  frozen: Readonly<PerUser<{ a: string }>>;
  partial: Partial<PerUser<{ a: string }>>;
  omitted: Omit<PerUser<{ a: string; b: number }>, "b">;
  wider: PerUser<Named> & { extra: number };
  branded: Branded;
}
`);
      const a = { type: "string" };

      expect(properties.frozen).toEqual({
        type: "object",
        properties: { a },
        required: ["a"],
        scope: "user",
      });
      expect(properties.partial).toEqual({
        type: "object",
        properties: { a },
        scope: "user",
      });
      expect(properties.omitted).toEqual(properties.frozen);
      expect(properties.wider).toEqual({
        type: "object",
        properties: { nickname: { type: "string" }, extra: { type: "number" } },
        required: ["nickname", "extra"],
        scope: "user",
      });
      expect(properties.branded).toEqual({
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        scope: "session",
      });
      expect(defs).toEqual([]);
    });

    it("emits the inline schema for an alias with a parenthesized body", async () => {
      const { properties } = await propertiesOf(`
type Wrapped = (PerSession<string | undefined>);
interface SchemaRoot {
  alias: Wrapped;
  inline: PerSession<string | undefined>;
}
`);

      expect(properties.inline).toEqual({
        type: ["string", "undefined"],
        scope: "session",
      });
      expect(properties.alias).toEqual(properties.inline);
    });

    for (
      const [what, brand] of [
        ["two scopes", '"user" | "session"'],
        ["a value that is not a scope", '"galaxy"'],
      ]
    ) {
      it(`throws for a brand naming ${what}`, async () => {
        const { type, checker, typeNode } = await getTypeFromCode(
          `
type Tagged<T, S extends string> = T & { readonly [SCOPE_BRAND]?: S };
interface SchemaRoot {
  draft: Tagged<string, ${brand}>;
}
`,
          "SchemaRoot",
        );

        expect(() =>
          new SchemaGenerator().generateSchema(type, checker, typeNode)
        ).toThrow("cannot be separated from the type it wraps");
      });
    }

    it("throws for an intersection of two different scopes", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
interface SchemaRoot {
  draft: PerUser<{ a: string }> & PerSession<{ b: number }>;
}
`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow("cannot be separated from the type it wraps");
    });

    it("throws for a scoped type it cannot separate from its brand", async () => {
      // A generic alias leaves no authored argument to read, and the checker
      // has already distributed the brand over the union, where each member
      // would come back with a scope of its own.
      const { type, checker, typeNode } = await getTypeFromCode(
        `
type Either<T> = PerUser<T | number>;
interface SchemaRoot {
  draft: Either<string>;
}
`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow("cannot be separated from the type it wraps");
    });
  });
});
