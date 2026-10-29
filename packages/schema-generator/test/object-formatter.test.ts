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

  describe("a property several members of a union declare", () => {
    // A `Pick` or an `Omit` over a union makes one property of every member's,
    // with a declaration from each and none of its own. It is read as all of
    // them, by type and from its node alike, whichever member the checker
    // orders first.

    const DECLARATIONS = `
type CfcStamp<T, Meta> = { readonly meta?: Meta; readonly of?: T };
type CfcTag<T, Meta> = { readonly __ct_cfc__?: CfcStamp<T, Meta> };
type Confidential<T, X extends readonly unknown[]> =
  T & CfcTag<T, { confidentiality: X }>;
type Sec<T> = Confidential<T, readonly ["a"]>;
type SecretAny = Confidential<any, readonly ["s"]>;
type PickScoped<T> = Pick<{ x: T } | { x: PerUser<string> }, "x">;
type OmitScoped<T> = Omit<{ x: T } | { x: PerUser<string> }, never>;
type PickSec<T> = Pick<{ x: T } | { x: Sec<string> }, "x">;
type OmitSecTwo<T> = Omit<
  { x: T; z: 1 } | { x: Confidential<string, readonly ["c"]>; z: 1 },
  "z"
>;
type PickAnySec<T> = Pick<{ x: T } | { x: SecretAny }, "x">;
`;

    /**
     * The schema of `value`'s property `x`, by each path: read by its type,
     * and from its node.
     */
    const propertyX = async (value: string) => {
      const { type, checker, typeNode } = await getTypeFromCode(
        `${DECLARATIONS}\ntype SchemaRoot = ${value};`,
        "SchemaRoot",
      );
      return [undefined, typeNode].map((node) =>
        asObjectSchema(
          new SchemaGenerator().generateSchema(type, checker, node),
        ).properties?.x
      );
    };

    for (const value of ["PickScoped<number>", "OmitScoped<number>"]) {
      it(`refuses \`${value}\`, whose \`x\` is a scope wrapper beside \`number\``, async () => {
        // As `PerUser<string> | number` written out is.

        await expect(propertyX(value)).rejects.toThrow(
          "A scope wrapper cannot be a member of a union.",
        );
      });
    }

    for (
      const [value, expected] of [
        ["PickScoped<any>", true],
        ["PickSec<number>", {
          anyOf: [
            { type: "number" },
            { type: "string", ifc: { confidentiality: ["a"] } },
          ],
        }],
        ['Pick<{ x: Sec<string> } | { x: number }, "x">', {
          anyOf: [
            { type: "number" },
            { type: "string", ifc: { confidentiality: ["a"] } },
          ],
        }],
        [
          'Pick<{ x: SecretAny } | { x: SecretAny; y: 1 }, "x">',
          { ifc: { confidentiality: ["s"] } },
        ],
        ['Pick<{ x: string } & { x: "a" | "b" }, "x">', { enum: ["a", "b"] }],
      ] as const
    ) {
      it(`reads \`x\` of \`${value}\` as every member's`, async () => {
        for (const read of await propertyX(value)) {
          expect(read).toEqual(expected);
        }
      });
    }

    it("reads `x` of `PickAnySec<string>` by type as `SecretAny`, which accepts any value whatever `T` is bound to", async () => {
      // The member written in `T` is read under bindings this reading does
      // not have, and adds no value `SecretAny` does not accept.

      const [byType] = await propertyX("PickAnySec<string>");
      expect(byType).toEqual({ ifc: { confidentiality: ["s"] } });
    });

    it("keeps the label each member puts on `x` of `OmitSecTwo<Sec<string>>`", async () => {
      // The members' labels differ, so the union keeps both arms.

      for (const read of await propertyX("OmitSecTwo<Sec<string>>")) {
        const arms =
          (read as { anyOf: { ifc: { confidentiality: string[] } }[] })
            .anyOf;
        expect(arms.map(({ ifc }) => ifc.confidentiality[0]).sort()).toEqual([
          "a",
          "c",
        ]);
      }
    });
  });
});
