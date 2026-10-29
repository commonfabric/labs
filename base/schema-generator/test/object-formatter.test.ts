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

  /**
   * Declarations the cases below read: CFC aliases written as the API writes
   * them, and generic and mapped types over them.
   */
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
type Integrity<T, X extends readonly unknown[]> =
  T & CfcTag<T, { integrity: X }>;
type IntAny = Integrity<any, readonly ["j"]>;
type PickAnySecNum<T> = Pick<{ x: T } | { x: SecretAny } | { x: number }, "x">;
type PickAnySecPart<T> = Pick<{ x: T } & { x: SecretAny; y: 1 }, "x">;
type Boxed<T> = { [P in keyof T]: { v: T[P] } };
type BoxedPick<T, K extends keyof T> = { [P in K]: { v: T[P] } };
type SameKeysOf<T, U extends T> = { [P in keyof T]: U[P] };
type XEverywhere<T extends { x: unknown }> = { [P in keyof T]: T["x"] };
type KEverywhere<T, K extends keyof T> = { [P in keyof T]: T[K] };
type OnlyX<T> = { [P in keyof T as P extends "x" ? P : never]: T[P] };
type Swapped<T> = { [P in keyof T as P extends "a" ? "b" : "a"]: T[P] };
`;

  /**
   * The schema of `value`'s property `name`, by each path: read by its
   * type, and from its node.
   */
  const propertyOf = async (value: string, name = "x") => {
    const { type, checker, typeNode } = await getTypeFromCode(
      `${DECLARATIONS}\ntype SchemaRoot = ${value};`,
      "SchemaRoot",
    );
    return [undefined, typeNode].map((node) =>
      asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, node),
      ).properties?.[name]
    );
  };

  describe("a property several members of a union declare", () => {
    // A `Pick` or an `Omit` over a union makes one property of every member's,
    // with a declaration from each and none of its own. It is read as all of
    // them, by type and from its node alike, whichever member the checker
    // orders first.

    for (const value of ["PickScoped<number>", "OmitScoped<number>"]) {
      it(`refuses \`${value}\`, whose \`x\` is a scope wrapper beside \`number\``, async () => {
        // As `PerUser<string> | number` written out is.

        await expect(propertyOf(value)).rejects.toThrow(
          "A scope wrapper cannot be a member of a union.",
        );
      });
    }

    for (
      const [value, expected] of [
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
        for (const read of await propertyOf(value)) {
          expect(read).toEqual(expected);
        }
      });
    }

    it("reads `x` of `PickAnySec<string>` by type as `SecretAny`, beside a member written in `T` that reads as `string`, which holds no label", async () => {
      // The member written in `T` is read under bindings this reading does
      // not have, and adds no value `SecretAny` does not accept.

      const [byType] = await propertyOf("PickAnySec<string>");
      expect(byType).toEqual({ ifc: { confidentiality: ["s"] } });
    });

    for (
      const value of ["PickAnySec<Sec<string>>", "PickAnySecNum<Sec<string>>"]
    ) {
      it(`refuses \`x\` of \`${value}\` by type, whose member written in \`T\` reads as a labeled type beside \`SecretAny\``, async () => {
        // The checker reads `x` as `any`, which holds none of `T`'s labels,
        // and the annotation `T` is read only under its member's bindings.

        await expect(propertyOf(value)).rejects.toThrow(
          "is declared by several members of a union or an intersection",
        );
      });
    }

    it("refuses `x` of `PickScoped<any>` by type, whose member written in `T` reads as `any`, which may be a wrapper's", async () => {
      // The checker reads a wrapper written around `any` as `any`, so the
      // argument cannot be told from one.

      await expect(propertyOf("PickScoped<any>")).rejects.toThrow(
        "reads as `any` here",
      );
    });

    it("reads `x` of `PickAnySecNum<string>` by type as `SecretAny | number` written out", async () => {
      // `string` holds no label, so the members written without `T` are all
      // there is to read.

      const [byType] = await propertyOf("PickAnySecNum<string>");
      expect(byType).toEqual({
        anyOf: [{ ifc: { confidentiality: ["s"] } }, { type: "number" }],
      });
    });

    it("keeps the label each member puts on `x` of `OmitSecTwo<Sec<string>>`", async () => {
      // The members' labels differ, so the union keeps both arms.

      for (const read of await propertyOf("OmitSecTwo<Sec<string>>")) {
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

  describe("a property several parts of an intersection declare", () => {
    // A `Pick` or an `Omit` over an intersection makes one property of every
    // part's that declares it, with a declaration from each and none of its
    // own. It is read as all of them at once, by type and from its node alike.

    for (
      const [value, expected] of [
        [
          'Pick<{ x: SecretAny } & { x: SecretAny; y: 1 }, "x">',
          { ifc: { confidentiality: ["s"] } },
        ],
        [
          'Omit<{ x: SecretAny } & { x: SecretAny; y: 1 }, "y">',
          { ifc: { confidentiality: ["s"] } },
        ],
        [
          'Pick<{ x: IntAny } & { x: SecretAny; y: 1 }, "x">',
          { ifc: { integrity: ["j"], confidentiality: ["s"] } },
        ],
        [
          'Readonly<Pick<{ x: SecretAny } & { x: string; y: 1 }, "x">>',
          { ifc: { confidentiality: ["s"] } },
        ],
        [
          'Pick<({ x: IntAny } & { x: "a" }) | { x: IntAny }, "x">',
          { ifc: { integrity: ["j"] } },
        ],
        [
          'Pick<{ x: SecretAny } & { y: 1 } & { x: IntAny }, "x">',
          { ifc: { integrity: ["j"], confidentiality: ["s"] } },
        ],
        ["PickAnySecPart<number>", { ifc: { confidentiality: ["s"] } }],
        ["PickAnySecPart<string | number>", {
          ifc: { confidentiality: ["s"] },
        }],
      ] as const
    ) {
      it(`reads \`x\` of \`${value}\` as every declaration of it`, async () => {
        for (const read of await propertyOf(value)) {
          expect(read).toEqual(expected);
        }
      });
    }

    it("refuses `x` of `PickAnySecPart<Sec<string>>` by type, whose part written in `T` reads as a labeled type beside `SecretAny`", async () => {
      await expect(propertyOf("PickAnySecPart<Sec<string>>")).rejects
        .toThrow(
          "is declared by several members of a union or an intersection",
        );
    });
  });

  describe("a property a mapped type gives a value of its own", () => {
    // The property keeps the declaration of the one it maps, which says what
    // that one is, not what the mapping makes of it. It is read by its type,
    // which does not hold a wrapper written around `any`.

    it("reads `x` of `Boxed<{ x: Sec<string> }>` as the object the mapping makes", async () => {
      for (const read of await propertyOf("Boxed<{ x: Sec<string> }>")) {
        expect(read).toEqual({
          type: "object",
          properties: {
            v: { type: "string", ifc: { confidentiality: ["a"] } },
          },
          required: ["v"],
        });
      }
    });

    it("reads `x` of `Boxed<{ x: any }>`, declared as `any` with no wrapper, by type", async () => {
      for (const read of await propertyOf("Boxed<{ x: any }>")) {
        expect(read).toEqual({
          type: "object",
          properties: { v: true },
          required: ["v"],
        });
      }
    });

    for (
      const [value, name] of [
        ["Boxed<{ x: SecretAny }>", "x"],
        ['BoxedPick<{ x: SecretAny } | { x: SecretAny; y: 1 }, "x">', "x"],
        ["SameKeysOf<{ x: SecretAny }, { x: string }>", "x"],
        ["XEverywhere<{ x: string; y: SecretAny }>", "y"],
        ['KEverywhere<{ x: string; y: SecretAny }, "x">', "y"],
        [
          'Pick<Boxed<{ x: SecretAny }> | Boxed<{ x: SecretAny; y: 1 }>, "x">',
          "x",
        ],
      ] as const
    ) {
      it(`refuses \`${name}\` of \`${value}\`, declared as \`SecretAny\`, which the value the mapping gives it does not keep`, async () => {
        await expect(propertyOf(value, name)).rejects.toThrow(
          `A mapped type gives \`${name}\` a value of its own`,
        );
      });
    }

    it("reads `b` of `Swapped<{ a: any; b: string }>`, whose `as` clause gives it `a`'s value, as `any`", async () => {
      // The renamed key keeps no declaration, and `b`'s in `T` is not its.

      for (
        const read of await propertyOf("Swapped<{ a: any; b: string }>", "b")
      ) {
        expect(read).toEqual(true);
      }
    });

    it("reads `x` of `OnlyX<{ x: SecretAny; y: 1 }>`, whose `as` clause keeps `x`'s name, as `SecretAny`", async () => {
      for (const read of await propertyOf("OnlyX<{ x: SecretAny; y: 1 }>")) {
        expect(read).toEqual({ ifc: { confidentiality: ["s"] } });
      }
    });
  });
});
