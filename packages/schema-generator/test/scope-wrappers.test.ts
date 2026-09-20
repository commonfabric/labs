import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";
import type { JSONSchemaObj } from "@commonfabric/api";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgram, getTypeFromCode } from "./utils.ts";

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
});
