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
type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
declare const h: () => Stream<void>;
declare const plainFn: () => number;
declare const subPattern: () => { value: string };
type H = typeof h;
interface Box<T> { value: T; n: number }
type Guarded<H> = { action: H; value: WriteAuthorizedBy<string, H> };
interface SchemaRoot {
  handler: Box<typeof h>;
  aliasedHandler: Box<H>;
  plain: Box<typeof plainFn>;
  subPattern: Box<typeof subPattern>;
  guarded: Guarded<typeof h>;
}
`);

    for (const name of ["handler", "aliasedHandler"]) {
      const member = asObjectSchema(schema.properties![name]!);
      expect(member.properties).toEqual({
        value: { asCell: ["stream"] },
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
