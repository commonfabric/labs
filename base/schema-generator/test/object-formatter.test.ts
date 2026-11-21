import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, createTestProgram, getTypeFromCode } from "./utils.ts";

/**
 * The object formatter's callable-property branch keeps a property whose call
 * signature returns a wrapper (`Stream`/`Cell`/`SqliteDb`) as its `asCell`
 * schema instead of skipping it (mapping spec, "Functions / callables /
 * constructables"). That branch returns early, so it must carry the same
 * attribute metadata the ordinary property path attaches — an author's JSDoc
 * on a factory-typed verb property is as real as one on data, and losing it
 * there is the #5637 prose-loss family one branch over.
 */
describe("object-formatter", () => {
  async function schemaFor(code: string) {
    const { type, checker, typeNode } = await getTypeFromCode(
      code,
      "SchemaRoot",
    );
    return asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );
  }

  it("classifies generic callable members from their instantiated arguments", async () => {
    const schema = await schemaFor(`
type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
declare const h: () => Stream<void>;
declare const cellFactory: () => Cell<string>;
declare const sqliteFactory: () => SqliteDb;
declare const plainFn: () => number;
declare const subPattern: () => { value: string };
type H = typeof h;
interface Box<T> { value: T; n: number }
type Guarded<H> = { action: H; value: WriteAuthorizedBy<string, H> };
interface SchemaRoot {
  handler: Box<typeof h>;
  aliasedHandler: Box<H>;
  cell: Box<typeof cellFactory>;
  sqlite: Box<typeof sqliteFactory>;
  plain: Box<typeof plainFn>;
  subPattern: Box<typeof subPattern>;
  guarded: Guarded<typeof h>;
}
`);

    for (
      const [name, kind] of [
        ["handler", "stream"],
        ["aliasedHandler", "stream"],
        ["cell", "cell"],
        ["sqlite", "sqlite"],
      ] as const
    ) {
      const member = asObjectSchema(schema.properties![name]!);
      expect(member.properties).toEqual({
        value: { asCell: [kind] },
        n: { type: "number" },
      });
      expect(member.required).toHaveLength(2);
      expect(member.required).toEqual(expect.arrayContaining(["value", "n"]));
    }
    for (const name of ["plain", "subPattern"]) {
      const member = asObjectSchema(schema.properties![name]!);
      expect(member.properties).toEqual({ n: { type: "number" } });
      expect(member.required).toEqual(["n"]);
    }
    const guarded = asObjectSchema(schema.properties!.guarded!);
    expect(guarded.properties!.action).toEqual({ asCell: ["stream"] });
    expect(asObjectSchema(guarded.properties!.value!).ifc?.writeAuthorizedBy)
      .toEqual({
        __ctWriterIdentityOf: { file: "test.ts", path: ["h"] },
      });
  });

  it("retains collapsed writer alternatives through a generic member", async () => {
    const schema = await schemaFor(`
type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
declare const f: (event: string) => void;
declare const g: typeof f;
interface Box<T> { value: T }
interface SchemaRoot {
  value: Box<WriteAuthorizedBy<string, typeof f> | WriteAuthorizedBy<string, typeof g>>;
}
`);
    const box = asObjectSchema(schema.properties!.value!);
    const value = asObjectSchema(box.properties!.value!);
    expect(value.anyOf).toHaveLength(2);
    expect(value.anyOf!.map((branch) => {
      const alternative = asObjectSchema(branch);
      expect(alternative.type).toBe("string");
      return alternative.ifc?.writeAuthorizedBy;
    })).toEqual([
      { __ctWriterIdentityOf: { file: "test.ts", path: ["f"] } },
      { __ctWriterIdentityOf: { file: "test.ts", path: ["g"] } },
    ]);
  });

  it("keeps all factory wrapper kinds through nested generic members", async () => {
    const schema = await schemaFor(`
declare const h: () => Stream<void>;
declare const cellFactory: () => Cell<string>;
declare const sqliteFactory: () => SqliteDb;
declare const plainFn: () => number;
declare const subPattern: () => { value: string };
interface Box<T> { inner: { value: T; n: number } }
interface SchemaRoot {
  handler: Box<typeof h>;
  cell: Box<typeof cellFactory>;
  sqlite: Box<typeof sqliteFactory>;
  plain: Box<typeof plainFn>;
  subPattern: Box<typeof subPattern>;
}
`);
    for (
      const [name, kind] of [["handler", "stream"], ["cell", "cell"], [
        "sqlite",
        "sqlite",
      ]] as const
    ) {
      const box = asObjectSchema(schema.properties![name]!);
      const inner = asObjectSchema(box.properties!.inner!);
      expect(inner.properties).toEqual({
        value: { asCell: [kind] },
        n: { type: "number" },
      });
      expect(inner.required).toHaveLength(2);
      expect(inner.required).toEqual(expect.arrayContaining(["value", "n"]));
    }
    for (const name of ["plain", "subPattern"]) {
      const box = asObjectSchema(schema.properties![name]!);
      const inner = asObjectSchema(box.properties!.inner!);
      expect(inner.properties).toEqual({ n: { type: "number" } });
      expect(inner.required).toEqual(["n"]);
    }
  });

  it("emits an open object schema for the bare `object` type", async () => {
    // The `object` type says a value is an object and nothing about its
    // properties, so the formatter claims it by name and emits a schema that
    // accepts any properties rather than enumerating the none it has. Which
    // pattern in the corpus writes a bare `object` decides whether this branch
    // runs at all, so it is covered on some CI runs and not others.
    const schema = await schemaFor(`
interface SchemaRoot {
  bag: object;
}
`);
    expect(schema.properties?.bag).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("keeps the JSDoc description on a callable stream property", async () => {
    const schema = await schemaFor(`
interface OpenEvent {
  panel: string;
}

interface SchemaRoot {
  /** Opens the composer panel. */
  openComposer: () => Stream<OpenEvent>;

  /** The board's visible title. */
  title: string;
}
`);

    const properties = asObjectSchema(schema).properties as Record<
      string,
      Record<string, unknown> | undefined
    >;

    // Control: the ordinary property path attaches the doc.
    expect(properties.title?.description).toBe("The board's visible title.");
    // The callable branch keeps the wrapper marker AND the doc.
    expect(properties.openComposer?.asCell).toEqual(["stream"]);
    expect(properties.openComposer?.description).toBe(
      "Opens the composer panel.",
    );
  });

  it("lowers @deprecated on a callable stream property alongside its doc", async () => {
    const schema = await schemaFor(`
interface OpenEvent {
  panel: string;
}

interface SchemaRoot {
  /**
   * Opens the legacy composer.
   * @deprecated use openComposer
   */
  openLegacy: () => Stream<OpenEvent>;
}
`);

    const properties = asObjectSchema(schema).properties as Record<
      string,
      Record<string, unknown> | undefined
    >;

    expect(properties.openLegacy?.asCell).toEqual(["stream"]);
    expect(properties.openLegacy?.deprecated).toBe(true);
    expect(properties.openLegacy?.description).toBe(
      "Opens the legacy composer.",
    );
  });
  it("notes conflicting docs on a property its declarations document differently", async () => {
    // Merged declarations of one interface may each document the same
    // property; the first doc wins and the schema says the docs disagree.
    const schema = await schemaFor(`
interface SchemaRoot {
  /** The first doc. */
  name: string;
  /** Agreed. */
  other: string;
}
interface SchemaRoot {
  /** The second doc. */
  name: string;
  /** Agreed. */
  other: string;
}
`);

    expect(schema.properties?.name).toEqual({
      type: "string",
      description: "The first doc.",
      $comment: "Conflicting docs across declarations; using first",
    });
    expect(schema.properties?.other).toEqual({
      type: "string",
      description: "Agreed.",
    });
  });

  describe("conflicting docs on a schema that carries a `$comment`", () => {
    // The schema of an intersection the generator cannot merge says so in its
    // `$comment`, and a conflict among docs leaves that note in place.
    const UNSUPPORTED = {
      type: "object",
      additionalProperties: true,
      $comment:
        "Unsupported intersection pattern: index signature on constituent",
    };

    it("keeps the `$comment` of a property its declarations document differently", async () => {
      const schema = await schemaFor(`
interface SchemaRoot {
  /** The first doc. */
  odd: { a: string } & string[];
}
interface SchemaRoot {
  /** The second doc. */
  odd: { a: string } & string[];
}
`);

      expect(schema.properties?.odd).toEqual({
        ...UNSUPPORTED,
        description: "The first doc.",
      });
    });

    it("keeps the `$comment` of index signatures documented differently", async () => {
      const schema = await schemaFor(`
interface SchemaRoot {
  /** Doc for string index */
  [key: string]: { a: string } & string[];

  /** Doc for number index */
  [index: number]: { a: string } & string[];
}
`);

      expect(schema.additionalProperties).toEqual({
        ...UNSUPPORTED,
        description: "Doc for string index",
      });
    });
  });

  it("emits only the members a type literal node declares, for a type with more", async () => {
    const { checker, sourceFile } = await createTestProgram(`
interface Wide { a: string; b: number }
type Narrow = { a: string } | { c: boolean };
`);
    const [wide] = sourceFile.statements.filter(ts.isInterfaceDeclaration);
    const [narrow] = sourceFile.statements.filter(ts.isTypeAliasDeclaration);

    expect(
      new SchemaGenerator().generateSchema(
        checker.getTypeAtLocation(wide!.name),
        checker,
        narrow!.type,
      ),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  describe("a member whose name starts with an underscore", () => {
    // TypeScript escapes a name that starts with `__` with a third
    // underscore, and names a member keyed by a symbol `__@` and its name.

    const SCHEMA = {
      type: "object",
      properties: { __hidden: { type: "string" }, shown: { type: "string" } },
      required: ["__hidden", "shown"],
    };

    it("emits a member a mapped type makes, read with and without a type node", async () => {
      const source =
        `type SchemaRoot = { [K in "__hidden" | "shown"]: string };`;
      const { type, checker } = await getTypeFromCode(source, "SchemaRoot");

      expect(await schemaFor(source)).toEqual(SCHEMA);
      expect(new SchemaGenerator().generateSchema(type, checker)).toEqual(
        SCHEMA,
      );
    });

    it("emits a member `Record` makes", async () => {
      expect(
        await schemaFor(
          `type SchemaRoot = Record<"__hidden" | "shown", string>;`,
        ),
      ).toEqual(SCHEMA);
    });

    it("emits a member a type literal declares", async () => {
      expect(
        await schemaFor(
          `type SchemaRoot = { __hidden: string; shown: string };`,
        ),
      ).toEqual(SCHEMA);
    });

    it("emits a member keyed by a string that starts like a symbol's name, and omits one keyed by a symbol", async () => {
      const schema = await schemaFor(`
declare const hidden: unique symbol;
interface SchemaRoot { "__@hidden": string; [hidden]: string; shown: string }
`);

      expect(schema.properties).toEqual({
        "__@hidden": { type: "string" },
        shown: { type: "string" },
      });
    });

    it("emits a member keyed by a string that starts like a private name, and omits a private field", async () => {
      // A private name escapes to `__#`, a string key `"__#x"` to `___#x`.
      const schema = await schemaFor(`
class Secret { #secret = 1; shown = "x" }
interface SchemaRoot { "#hash": string; "__#x": string; secret: Secret }
`);

      expect(schema).toEqual({
        $defs: {
          Secret: {
            type: "object",
            properties: { shown: { type: "string" } },
            required: ["shown"],
          },
        },
        type: "object",
        properties: {
          "#hash": { type: "string" },
          "__#x": { type: "string" },
          secret: { $ref: "#/$defs/Secret" },
        },
        required: ["#hash", "__#x", "secret"],
      });
    });
  });

  it("emits a member keyed by a string named like a cell's brand", async () => {
    expect(
      await schemaFor(
        `interface SchemaRoot { CELL_BRAND: string; CELL_INNER_TYPE: number }`,
      ),
    ).toEqual({
      type: "object",
      properties: {
        CELL_BRAND: { type: "string" },
        CELL_INNER_TYPE: { type: "number" },
      },
      required: ["CELL_BRAND", "CELL_INNER_TYPE"],
    });
  });

  it("emits every member of an object a union node reaches through no literal", async () => {
    // A union node that keeps one member after `never` drops out holds no
    // type literal to restrict the object's members to.
    const schema = await schemaFor(`
type Shape = { a: string; b?: number };
type SchemaRoot = Omit<Shape, never> | never;
`);

    expect(schema.properties).toEqual({
      a: { type: "string" },
      b: { type: "number" },
    });
    expect(schema.required).toEqual(["a"]);
  });
  describe("a member of an object literal read from its type", () => {
    // A callback's inferred result is read so. Its member is read at the
    // annotation of the binding it holds, where every `typeof` that annotation
    // names is a `PolicyOf`'s rules.
    const SOURCE = `
type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
type PolicyOf<Binding> = { readonly __ct_cfc_policy_of__?: Binding };
declare const rules: { name: string };
declare function save(): void;
declare const labelled: Confidential<string, [PolicyOf<typeof rules>]>;
declare const written: WriteAuthorizedBy<string, typeof save>;
const result = { labelled, parenthesized: (labelled), written };
type SchemaRoot = typeof result;
`;

    const memberSchemas = async () => {
      const { type, checker } = await getTypeFromCode(SOURCE, "SchemaRoot");
      return asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      ).properties as Record<string, { ifc?: Record<string, unknown> }>;
    };

    const POLICY = {
      confidentiality: [{
        policyRefKind: "module",
        __ctPolicyIdentityOf: { path: ["rules"] },
      }],
    };

    it("reads the policy a binding's annotation names", async () => {
      expect((await memberSchemas()).labelled?.ifc).toMatchObject(POLICY);
    });

    it("reads the policy of a binding read inside parentheses", async () => {
      expect((await memberSchemas()).parenthesized?.ifc).toMatchObject(POLICY);
    });

    it("reads a binding whose annotation names a writer from its type", async () => {
      expect((await memberSchemas()).written?.ifc?.writeAuthorizedBy)
        .toBeUndefined();
    });
  });

  describe("a member a mapped type maps", () => {
    // A mapped type keeps the declaration of the member it maps, and a
    // template can change the member's type. The member is read as the
    // mapped type has it, never as its declaration writes it.

    /** The schema of `v.w`, with `SchemaRoot` declaring `v: <mapped>`. */
    async function mappedMemberSchema(
      declarations: string,
      mapped: string,
    ): Promise<unknown> {
      const schema = await schemaFor(`
${declarations}
interface SchemaRoot { v: ${mapped} }
`);
      const v = schema.properties?.v as {
        properties?: Record<string, unknown>;
      };
      return v.properties?.w;
    }

    const LOOSE = "type Loose<T> = { [K in keyof T]: T[K] | string };";
    const UNWRAP =
      "type Unwrap<T> = { [K in keyof T]: T[K] extends Cell<infer U> ? U : T[K] };";
    const WIDENED_CELL = {
      anyOf: [{ type: "string" }, { type: "number", asCell: ["cell"] }],
    };

    it("emits both members of a union the template widens a cell member to", async () => {
      expect(await mappedMemberSchema(LOOSE, "Loose<{ w: Cell<number> }>"))
        .toEqual(WIDENED_CELL);
    });

    it("emits the value type the template unwraps a cell member to", async () => {
      expect(await mappedMemberSchema(UNWRAP, "Unwrap<{ w: Cell<number> }>"))
        .toEqual({ type: "number" });
    });

    it("emits the widened union for a cell member a generic declares", async () => {
      expect(
        await mappedMemberSchema(
          `${LOOSE} interface Src<T> { w: Cell<T> }`,
          "Loose<Src<number>>",
        ),
      ).toEqual(WIDENED_CELL);
    });

    it("emits the unwrapped value type for a cell member a generic declares", async () => {
      expect(
        await mappedMemberSchema(
          `${UNWRAP} interface Src<T> { w: Cell<T> }`,
          "Unwrap<Src<number>>",
        ),
      ).toEqual({ type: "number" });
    });

    it("keeps the scope of a member the template leaves as it is", async () => {
      expect(
        await mappedMemberSchema(UNWRAP, "Unwrap<{ w: PerSession<null> }>"),
      )
        .toMatchObject({ scope: "session" });
    });

    it("keeps a member the template leaves as it is optional, with its default, where the default holds `undefined`", async () => {
      // A replica of `Default`, as `brand-payload-defaults.test.ts` declares.
      const schema = await schemaFor(`
declare const DEFAULT_MARKER: unique symbol;
type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
${UNWRAP}
interface SchemaRoot { v: Unwrap<{ w: Default<number | undefined, 42> }> }
`);
      const v = schema.properties?.v as {
        properties?: Record<string, { default?: unknown }>;
        required?: string[];
      };

      expect(v.required ?? []).not.toContain("w");
      expect(v.properties?.w?.default).toBe(42);
    });

    it("keeps the scope of a generic field an identity mapping reads under its type arguments", async () => {
      const ROW = "interface Row<T> { w: PerSession<T> }";

      expect(await mappedMemberSchema(ROW, "Readonly<Row<null>>"))
        .toMatchObject({ scope: "session" });
      expect(await mappedMemberSchema(ROW, 'Pick<Row<null>, "w">'))
        .toMatchObject({ scope: "session" });
    });

    it("keeps a generic field an identity mapping reads under its type arguments optional where its default holds `undefined`", async () => {
      const schema = await schemaFor(`
declare const DEFAULT_MARKER: unique symbol;
type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
interface Fallback<T> { w: Default<T | undefined, T> }
interface SchemaRoot { v: Readonly<Fallback<42>> }
`);
      const v = schema.properties?.v as { required?: string[] };

      expect(v.required ?? []).not.toContain("w");
    });

    it("emits the permissive schema for a member a template maps to `any`", async () => {
      const ANYTHING = "type Anything<T> = { [K in keyof T]: any };";

      expect(await mappedMemberSchema(ANYTHING, "Anything<{ w: number }>"))
        .toBe(true);
      expect(
        await mappedMemberSchema(ANYTHING, "Anything<{ w: Cell<number> }>"),
      )
        .toBe(true);
    });

    it("emits both members of the widened union for a cell member of a mapped type an identity mapping wraps", async () => {
      // `Partial`'s `?` adds `undefined` beside the two members, so only the
      // members are pinned.

      const schema = await mappedMemberSchema(
        LOOSE,
        "Partial<Loose<{ w: Cell<number> }>>",
      ) as { anyOf?: { type?: string | string[]; asCell?: unknown }[] };

      expect(schema.anyOf).toContainEqual({ type: "number", asCell: ["cell"] });
      expect(
        schema.anyOf?.some(({ type }) =>
          type === "string" || (Array.isArray(type) && type.includes("string"))
        ),
      ).toBe(true);
    });

    it("emits the unwrapped value type for a cell member of a mapped type an identity mapping wraps", async () => {
      expect(
        await mappedMemberSchema(
          UNWRAP,
          "Readonly<Unwrap<{ w: Cell<number> }>>",
        ),
      ).toEqual({ type: "number" });
    });

    it("emits the cell a `Pick` leaves as it is", async () => {
      expect(
        await mappedMemberSchema(
          "",
          'Pick<{ w: Cell<number>; x: string }, "w">',
        ),
      )
        .toEqual({ type: "number", asCell: ["cell"] });
    });

    it("emits the cell a `Partial` makes optional", async () => {
      expect(await mappedMemberSchema("", "Partial<{ w: Cell<number> }>"))
        .toEqual({ type: "number", asCell: ["cell"] });
    });
  });
});
