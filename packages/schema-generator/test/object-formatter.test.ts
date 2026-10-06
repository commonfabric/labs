import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

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
});
