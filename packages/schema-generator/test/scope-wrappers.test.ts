import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchemaObj, SchemaScope } from "@commonfabric/api";
import ts from "typescript";

import type { SchemaGenerationDiagnostic } from "../src/interface.ts";
import { SchemaGenerator } from "../src/schema-generator.ts";
import {
  asObjectSchema,
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

  for (
    const [form, declarations, declared] of [
      ["written out", "", "PerSession<PerUser<Cell<string>>>"],
      [
        "through an alias",
        "type Draft = PerUser<Cell<string>>;",
        "PerSession<Draft>",
      ],
    ] as const
  ) {
    it(`rejects scope wrappers of two scopes around one cell ${form}`, async () => {
      // The cell's own scope caps its handle, which the outer wrapper's would
      // replace.
      const { type, checker, typeNode } = await getTypeFromCode(
        `${declarations}
interface SchemaRoot {
  invalid: ${declared};
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
  }

  describe("two scopes' brands on one value where the schema declares no scope", () => {
    // An inferred result declares no scope, so the brands the checker
    // intersects onto its value are no part of its schema, as any other
    // brand-only member is not.

    it("returns the payload of a value two scope wrappers brand", async () => {
      const { type, checker } = await getTypeFromCode(
        `type SchemaRoot = PerUser<string> & PerSpace<string>;`,
        "SchemaRoot",
      );

      expect(
        new SchemaGenerator().generateSchema(type, checker, undefined, {
          declaresNoScope: true,
        }),
      ).toEqual({ type: "string" });
    });

    it("returns the payload of a property two scope wrappers brand", async () => {
      const { type, checker } = await getTypeFromCode(
        `type SchemaRoot = { value: PerUser<string> & PerSpace<string> };`,
        "SchemaRoot",
      );

      expect(
        new SchemaGenerator().generateSchema(type, checker, undefined, {
          declaresNoScope: true,
        }),
      ).toEqual({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      });
    });

    it("returns the payload of a type parameter two scope wrappers brand", async () => {
      const { type, checker } = await getTypeFromCode(
        `type SchemaRoot<T extends string> = PerUser<T> & PerSpace<T>;`,
        "SchemaRoot",
      );

      expect(
        new SchemaGenerator().generateSchema(type, checker, undefined, {
          declaresNoScope: true,
        }),
      ).toEqual({ type: "string" });
    });
  });

  describe("scope wrappers around a type parameter, intersected", () => {
    // While its payload holds a type parameter, a wrapper's brand is a
    // conditional type the checker defers, and an intersection of wrappers
    // keeps no wrapper's alias, so the brand names the scope.

    it("emits the payload's schema in the scope of two wrappers of one scope", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `type SchemaRoot<T extends string> = PerUser<T> & PerUser<T>;`,
        "SchemaRoot",
      );

      expect(new SchemaGenerator().generateSchema(type, checker, typeNode))
        .toEqual({ type: "string", scope: "user" });
    });

    it("emits the scope of a property two wrappers of one scope type", async () => {
      const { type, checker } = await getTypeFromCode(
        `type SchemaRoot<T extends { a: string }> = {
  value: PerUser<T> & PerUser<T>;
};`,
        "SchemaRoot",
      );

      expect(
        asObjectSchema(new SchemaGenerator().generateSchema(type, checker))
          .properties?.value,
      ).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        scope: "user",
      });
    });

    it("throws for wrappers of two scopes", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `type SchemaRoot<T extends string> = PerUser<T> & PerSession<T>;`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      )
        .toThrow(
          "Nested scope wrappers require a cell boundary between scopes.",
        );
    });
  });

  describe("a mapped type over a scope wrapper around an indexed object", () => {
    // `Readonly<PerSpace<Record<string, A>>>` is one object holding the brand
    // beside the index signature, which is not the brand alone.

    for (
      const [declaration, values] of [
        [
          "Readonly<PerSpace<Record<string, Cell<string>>>>",
          { type: "string", asCell: ["cell"] },
        ],
        ["Partial<PerUser<Record<string, number>>>", {
          type: ["number", "undefined"],
        }],
      ] as const
    ) {
      it(`keeps the values of \`${declaration}\``, async () => {
        const { type, checker } = await getTypeFromCode(
          `interface SchemaRoot { value: ${declaration}; }`,
          "SchemaRoot",
        );

        expect(
          asObjectSchema(
            asObjectSchema(new SchemaGenerator().generateSchema(type, checker))
              .properties?.value,
          ).additionalProperties,
        ).toEqual(values);
      });
    }
  });

  describe("a scope wrapper around `unknown` read from its node alone", () => {
    // A node the checker has no type for, as a synthetic node, is read at the
    // wrapper's place as `unknown`, which the payload's `unknown` is too.

    for (
      const [payload, expected] of [
        ["unknown", { type: "unknown" }],
        ["unknown[]", { type: "array", items: { type: "unknown" } }],
        ["{ a: unknown }", {
          type: "object",
          properties: { a: { type: "unknown" } },
          required: ["a"],
        }],
      ] as const
    ) {
      it(`emits the payload's schema in the scope for \`PerUser<${payload}>\``, async () => {
        const { checker, sourceFile } = await createTestProgram(
          `type SchemaRoot = PerUser<${payload}>;`,
        );
        const root = sourceFile.statements.find(ts.isTypeAliasDeclaration)!;
        const { $schema: _, ...schema } = new SchemaGenerator()
          .generateSchemaFromSyntheticTypeNode(
            root.type,
            checker,
            undefined,
            undefined,
            sourceFile,
          ) as JSONSchemaObj;

        expect(schema).toEqual({ ...expected, scope: "user" });
      });
    }
  });

  describe("a scope wrapper around `unknown` read by its type", () => {
    // The checker drops `unknown` from the wrapper's intersection, leaving
    // the brand alone, which is the wrapper around `unknown`.

    it("emits `unknown` in the scope for the values of a record", async () => {
      const { type, checker } = await getTypeFromCode(
        `type SchemaRoot = Record<string, PerUser<unknown>>;`,
        "SchemaRoot",
      );

      expect(
        asObjectSchema(new SchemaGenerator().generateSchema(type, checker))
          .additionalProperties,
      ).toEqual({ type: "unknown", scope: "user" });
    });

    it("emits `unknown` in the scope for a property an alias of it types", async () => {
      const { type, checker } = await getTypeFromCode(
        `type Anything = PerSession<unknown>;
interface SchemaRoot {
  value: Anything;
}`,
        "SchemaRoot",
      );

      expect(
        asObjectSchema(new SchemaGenerator().generateSchema(type, checker))
          .properties?.value,
      ).toEqual({ type: "unknown", scope: "session" });
    });
  });

  it("caps a cell that two wrappers of one scope hold with that scope", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<PerUser<Cell<string>>>;
}
`,
      "SchemaRoot",
    );

    expect(
      asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode),
      ).properties?.draft,
    ).toEqual({ type: "string", asCell: [{ kind: "cell", scope: "user" }] });
  });

  it("throws for a scope wrapper that is a union member", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string> | number;
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
  draft: PerUser<Cell<string>> | number;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope wrapper over a union that is a union member", async () => {
    // `PerUser<boolean>` distributes into `true` and `false`, each carrying
    // the brand, beside `number`.
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<boolean> | number;
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  it("throws for a scope wrapper around a cell beside anything, `null` and `undefined` included", async () => {
    // Beside anything, the cell is an `anyOf` branch, where its handle's cap
    // would sit apart from the slot's scope. A cell whose value may be `null`
    // holds it inside, and a cell that may be absent is an optional property.
    for (
      const declaration of [
        "PerSpace<Cell<string> | number>",
        "PerSpace<Cell<string> | Cell<number>>",
        "PerSpace<Cell<string>> | PerSpace<Cell<number>>",
        "PerSpace<Writable<string> | null>",
        "PerSpace<Writable<string>> | null",
        "PerSpace<Cell<string> | undefined>",
        "PerSpace<Cell<string>> | undefined",
        "PerUser<Cell<PerSession<Cell<string>> | null>>",
      ]
    ) {
      const { type, checker, typeNode } = await getTypeFromCode(
        `interface SchemaRoot { handle: ${declaration}; }`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow("A scope wrapper around a cell cannot hold anything beside");
    }
  });

  it("throws for a scoped cell written beside `undefined` where its type does not hold it", async () => {
    // `Required` takes the `undefined` out of the member's type, which then
    // holds the cell alone, and leaves the member's node as written.
    const { type, checker, typeNode } = await getTypeFromCode(
      "type SchemaRoot = Required<{ handle?: PerSpace<Cell<string>> | undefined }>;",
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper around a cell cannot hold anything beside");
  });

  it("caps the handle of a scoped cell whose value may be `null`", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `interface SchemaRoot { handle: PerSpace<Writable<string | null>>; }`,
      "SchemaRoot",
    );

    expect(
      asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode),
      ).properties?.handle,
    ).toMatchObject({ asCell: [{ kind: "cell", scope: "space" }] });
  });

  it("caps the handle of an optional property's scoped cell", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      "interface SchemaRoot { handle?: PerSpace<Cell<string>>; }",
      "SchemaRoot",
    );

    expect(
      (new SchemaGenerator().generateSchema(type, checker, typeNode) as {
        properties: unknown;
      }).properties,
    ).toEqual({
      handle: { type: "string", asCell: [{ kind: "cell", scope: "space" }] },
    });
  });

  it("throws for a scope wrapper unioned with a value type", async () => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `
interface SchemaRoot {
  draft: PerUser<string> | { other: string };
}
`,
      "SchemaRoot",
    );

    expect(() => new SchemaGenerator().generateSchema(type, checker, typeNode))
      .toThrow("A scope wrapper cannot be a member of a union.");
  });

  describe("a scope wrapper beside only `null` or `undefined`", () => {
    // `Scoped` keeps `null` and `undefined` outside the brand, so the wrapper
    // beside them is one type with the wrapper around them, and scopes the
    // whole slot as that does.

    /** The schema of `SchemaRoot`'s `draft`, declared as `declaration`. */
    const draftSchema = async (declaration: string) => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `interface SchemaRoot { draft: ${declaration}; }`,
        "SchemaRoot",
      );
      return (new SchemaGenerator().generateSchema(
        type,
        checker,
        typeNode,
      ) as JSONSchemaObj).properties?.draft;
    };

    it("scopes the slot of a value beside `undefined`", async () => {
      expect(await draftSchema("PerUser<string> | undefined")).toEqual({
        type: ["string", "undefined"],
        scope: "user",
      });
    });

    it("scopes the slot of a value beside `null`", async () => {
      expect(await draftSchema("PerUser<string> | null")).toEqual({
        anyOf: [{ type: "string" }, { type: "null" }],
        scope: "user",
      });
    });

    it("reads `PerUser<boolean> | null` as `PerUser<boolean | null>`", async () => {
      expect(await draftSchema("PerUser<boolean> | null")).toEqual(
        await draftSchema("PerUser<boolean | null>"),
      );
    });

    it("keeps a policy only the payload's syntax names, with `null` written outside a generic alias's wrapper", async () => {
      // The binding `typeof rules` names is in the declaration's syntax, and
      // the alias's body is a union, read at the payload written in it, as
      // the payload is read with `null` written inside the wrapper.
      const { type, checker } = await getTypeFromFiles(
        {
          "/cfc-types.ts":
            `export type PolicyOf<Binding> = { readonly __ct_cfc_policy_of__?: Binding };`,
          "/entry.ts": `
            import type { PolicyOf } from "./cfc-types.ts";
            type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
            type Confidential<T, X extends readonly unknown[]> =
              Cfc<T, { confidentiality: X }>;
            declare const rules: unknown;
            interface Dict<U> { [key: string]: U }
            type Outside<T> =
              PerUser<Confidential<T, readonly [PolicyOf<typeof rules>]>> | null;
            type Inside<T> =
              PerUser<Confidential<T, readonly [PolicyOf<typeof rules>]> | null>;
            interface SchemaRoot {
              outside: Outside<string>;
              inside: Inside<string>;
              outsideValues: Dict<Outside<string>>;
              insideValues: Dict<Inside<string>>;
            }
          `,
        },
        "/entry.ts",
        "SchemaRoot",
      );
      const { properties } = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );

      expect(properties?.outside).toEqual({
        anyOf: [{
          type: "string",
          ifc: {
            confidentiality: [{
              type: "https://commonfabric.org/cfc/atom/Policy",
              policyRefKind: "module",
              __ctPolicyIdentityOf: { file: "/entry.ts", path: ["rules"] },
              subject: { __ctOwningSpace: true },
            }],
          },
        }, { type: "null" }],
        scope: "user",
      });
      expect(properties?.outside).toEqual(properties?.inside);
      expect(properties?.outsideValues).toEqual(properties?.insideValues);
      expect(asObjectSchema(properties?.outsideValues).additionalProperties)
        .toEqual(properties?.outside);
    });

    it("keeps a policy only the payload's syntax names, with `null` written outside the wrapper at the end of a chain of generic aliases", async () => {
      // Each alias in the chain is the whole body of the one before, and binds
      // its parameters to the arguments the reference to it writes.
      const { type, checker } = await getTypeFromFiles(
        {
          "/cfc-types.ts":
            `export type PolicyOf<Binding> = { readonly __ct_cfc_policy_of__?: Binding };`,
          "/entry.ts": `
            import type { PolicyOf } from "./cfc-types.ts";
            type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
            type Confidential<T, X extends readonly unknown[]> =
              Cfc<T, { confidentiality: X }>;
            declare const rules: unknown;
            interface Dict<U> { [key: string]: U }
            type Outside<T> =
              PerUser<Confidential<T, readonly [PolicyOf<typeof rules>]>> | null;
            type Middle<T> = Outside<T>;
            type Box<T> = Middle<T>;
            type Inside<T> =
              PerUser<Confidential<T, readonly [PolicyOf<typeof rules>]> | null>;
            interface SchemaRoot {
              outside: Box<string>;
              inside: Inside<string>;
              outsideValues: Dict<Box<string>>;
            }
          `,
        },
        "/entry.ts",
        "SchemaRoot",
      );
      const { properties } = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );

      expect(properties?.outside).toEqual(properties?.inside);
      expect(asObjectSchema(properties?.outsideValues).additionalProperties)
        .toEqual(properties?.inside);
      expect(JSON.stringify(properties?.inside)).toContain(
        '"__ctPolicyIdentityOf":{"file":"/entry.ts","path":["rules"]}',
      );
    });

    it("throws for a handle's cap in a branch that is not the slot's scope", async () => {
      // `PerUser<Cell<string>> | PerSession<Cell<string>>` puts two caps in
      // branches under no scope of the slot's own.
      await expect(
        draftSchema("PerUser<Cell<string>> | PerSession<Cell<string>>"),
      ).rejects.toThrow("A scope wrapper cannot be a member of a union.");
    });
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

    for (
      const [spelling, argument, holder] of [
        ["`undefined` joined to it", "T | undefined", "Node<string>"],
        [
          "`Readonly` over an object argument",
          "Readonly<T>",
          "Node<{ a: string }>",
        ],
      ] as const
    ) {
      it(`keeps the scope on each reference to a generic recursive alias with ${spelling}, which the checker settles`, async () => {
        // The written argument nests without end, but the type the checker
        // instantiates settles, and the recursion is a reference to its
        // definition, carrying the scope as any reference to one does.
        const schemas = await propertySchemas(`
type Node<T> = PerUser<{ label: T; next?: Cell<Node<${argument}>> }>;
interface SchemaRoot { head: ${holder}; }
`);

        const defs = schemas.$defs as Record<string, Record<string, unknown>>;
        const recursive = Object.keys(defs).find((name) =>
          JSON.stringify(defs[name]).includes(`"#/$defs/${name}"`)
        );
        expect(recursive).toBeDefined();
        expect(JSON.stringify(defs[recursive!])).toContain(
          JSON.stringify({
            $ref: `#/$defs/${recursive}`,
            scope: "user",
            asCell: ["cell"],
          }),
        );
        expect(defs[recursive!]!.scope).toBeUndefined();
        expect((schemas.head as Record<string, unknown>).scope).toBe("user");
      });
    }

    for (const argument of ["T", "Readonly<T>"]) {
      it(`reports a generic recursion through a scope around a cell, with \`${argument}\`, keeping each handle's scope in its cell entry`, async () => {
        // Such a scope's cycle is found at the cell's value, which a reading
        // under bindings takes from its syntax, so none is found, and the
        // reading stops at the nesting bound. No reference settles in place of
        // a handle, which would drop the cell the scope caps.
        const { type, checker, typeNode } = await getTypeFromCode(
          `
type Node<T> = PerUser<Cell<{ label: T; next?: Node<${argument}> }>>;
interface SchemaRoot { head: Node<{ a: string }>; }
`,
          "SchemaRoot",
        );
        const diagnostics: SchemaGenerationDiagnostic[] = [];
        const schema = new SchemaGenerator().generateSchema(
          type,
          checker,
          typeNode,
          { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
        ) as JSONSchemaObj;

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          type: "schema-type:unread",
          severity: "warning",
        });
        // The partial schema preserves the handles read before the bound.
        const handle = [{ kind: "cell", scope: "user" }];
        const handles: unknown[] = [];
        JSON.stringify(schema, (key, value) => {
          if (key === "next" && Object.keys(value).length > 0) {
            handles.push(value.asCell);
          }
          return value;
        });
        expect(handles.length).toBeGreaterThan(0);
        for (const found of handles) expect(found).toEqual(handle);
        expect(
          (schema.properties?.head as Record<string, unknown>).asCell,
        ).toEqual(handle);
      });
    }

    it("throws for an alias of a scope wrapper that is a union member", async () => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `
type Draft = PerUser<Cell<string>>;
interface SchemaRoot { draft: Draft | number; }
`,
        "SchemaRoot",
      );

      expect(() =>
        new SchemaGenerator().generateSchema(type, checker, typeNode)
      ).toThrow("A scope wrapper cannot be a member of a union.");
    });
  });

  describe("a scope wrapper around `never`", () => {
    // `never & brand` is `never`, so the checker gives the wrapper the type of
    // its payload. The payload accepts nothing, and its `false` becomes
    // `{ not: true }` beside the scope.

    const WRAPPER_FOR_SCOPE = {
      space: "PerSpace",
      user: "PerUser",
      session: "PerSession",
      any: "PerAny",
    } as const satisfies Record<SchemaScope, string>;

    /** The schema generated for `code`'s `SchemaRoot`. */
    async function schemaOf(code: string): Promise<unknown> {
      const { type, checker, typeNode } = await getTypeFromCode(
        code,
        "SchemaRoot",
      );
      return new SchemaGenerator().generateSchema(type, checker, typeNode);
    }

    for (const [scope, wrapper] of Object.entries(WRAPPER_FOR_SCOPE)) {
      it(`emits \`{ not: true, scope: "${scope}" }\` for a root \`${wrapper}<never>\``, async () => {
        expect(await schemaOf(`type SchemaRoot = ${wrapper}<never>;`))
          .toEqual({ not: true, scope });
      });

      it(`emits \`{ not: true, scope: "${scope}" }\` for a property typed \`${wrapper}<never>\``, async () => {
        expect(
          await schemaOf(`interface SchemaRoot { x: ${wrapper}<never>; }`),
        ).toEqual({
          type: "object",
          properties: { x: { not: true, scope } },
          required: ["x"],
        });
      });

      it(`emits the payload's schema with \`scope: "${scope}"\` for a property typed \`${wrapper}<string>\``, async () => {
        expect(
          await schemaOf(`interface SchemaRoot { x: ${wrapper}<string>; }`),
        ).toEqual({
          type: "object",
          properties: { x: { type: "string", scope } },
          required: ["x"],
        });
      });
    }

    it("emits each property's own scope for two scopes around `never`", async () => {
      expect(
        await schemaOf(
          `interface SchemaRoot { x: PerUser<never>; y: PerSession<never>; }`,
        ),
      ).toEqual({
        type: "object",
        properties: {
          x: { not: true, scope: "user" },
          y: { not: true, scope: "session" },
        },
        required: ["x", "y"],
      });
    });

    it("emits `{ not: true, scope }` for a payload the checker reduces to `never`", async () => {
      expect(
        await schemaOf(`interface SchemaRoot { x: PerUser<string & number>; }`),
      ).toEqual({
        type: "object",
        properties: { x: { not: true, scope: "user" } },
        required: ["x"],
      });
    });

    it("emits `{ not: true, scope }` for an optional property typed `PerUser<never>`", async () => {
      expect(
        await schemaOf(`interface SchemaRoot { x?: PerUser<never>; }`),
      ).toEqual({
        type: "object",
        properties: { x: { not: true, scope: "user" } },
      });
    });

    it("emits the scope beside a string `asCell` entry for a cell around one", async () => {
      expect(
        await schemaOf(`interface SchemaRoot { x: Cell<PerUser<never>>; }`),
      ).toEqual({
        type: "object",
        properties: {
          x: { not: true, scope: "user", asCell: ["cell"] },
        },
        required: ["x"],
      });
    });

    it("emits the scope in the cell entry for one around a cell of `never`", async () => {
      expect(
        await schemaOf(`interface SchemaRoot { x: PerUser<Cell<never>>; }`),
      ).toEqual({
        type: "object",
        properties: {
          x: { asCell: [{ kind: "cell", scope: "user" }], not: true },
        },
        required: ["x"],
      });
    });

    it("throws for one nested in another scope wrapper without a cell boundary", async () => {
      await expect(
        schemaOf(`interface SchemaRoot { x: PerUser<PerSession<never>>; }`),
      ).rejects.toThrow(
        "Nested scope wrappers require a cell boundary between scopes.",
      );
    });

    it("emits `false` for `never` in a later schema from the same generator", async () => {
      // A generator keeps the names it gives definitions for every schema it
      // writes afterward, as the transformer's one generator per program does.
      const { checker, sourceFile } = await createTestProgram(`
type Earlier = PerUser<never>;
interface Later { x: never; }
`);
      const earlier = sourceFile.statements.find(ts.isTypeAliasDeclaration)!;
      const later = sourceFile.statements.find(ts.isInterfaceDeclaration)!;
      const generator = new SchemaGenerator();
      generator.generateSchema(
        checker.getTypeFromTypeNode(earlier.type),
        checker,
        earlier.type,
      );

      expect(
        generator.generateSchema(
          checker.getTypeAtLocation(later.name),
          checker,
        ),
      ).toEqual({
        type: "object",
        properties: { x: false },
        required: ["x"],
      });
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
      interface A { a: string }
      interface B { b: number }
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

    it("emits the resolved payload for an intersection printed as import types", async () => {
      // The checker cannot intersect `A` and `B` again without the brand, so
      // the payload is the wrapper's own type, read in place without the
      // wrapper's node, which would read it as the wrapper once more.
      const importType = (name: string) =>
        ts.factory.createImportTypeNode(
          ts.factory.createLiteralTypeNode(
            ts.factory.createStringLiteral("./types.ts"),
          ),
          undefined,
          ts.factory.createIdentifier(name),
        );
      const schema = await printedSchema(
        "A & B",
        ts.factory.createIntersectionTypeNode([
          importType("A"),
          importType("B"),
        ]),
      );

      expect(schema).toEqual({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a", "b"],
        scope: "user",
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
