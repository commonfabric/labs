import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode, getTypeFromFiles } from "../utils.ts";

describe("Schema: Default in unions", () => {
  it("applies primitive defaults from T | Default<V>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface X {
        title: string | Default<"">;
        count: number | Default<0>;
        enabled: boolean | Default<false>;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.type).toBe("string");
    expect(title.default).toBe("");

    const count = result.properties?.count as any;
    expect(count.type).toBe("number");
    expect(count.default).toBe(0);

    const enabled = result.properties?.enabled as any;
    expect(enabled.type).toBe("boolean");
    expect(enabled.default).toBe(false);
  });

  it("applies defaults through aliased union types", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type WithDefault = string | Default<"">;
      interface X {
        title: WithDefault;
      }
    `;
    const { type, checker } = await getTypeFromCode(code, "X");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.$ref).toBe("#/$defs/WithDefault");
    expect((result as any).$defs?.WithDefault).toEqual({
      type: "string",
      default: "",
    });
  });

  it("applies defaults through imported aliased union types", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/types.ts": `
        export interface Default<T, V extends T = T> {}
        export type WithDefault = string | Default<"">;
      `,
        "/main.ts": `
        import type { WithDefault } from "./types.ts";
        export interface X {
          title: WithDefault;
        }
      `,
      },
      "/main.ts",
      "X",
    );
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.$ref).toBe("#/$defs/WithDefault");
    expect((result as any).$defs?.WithDefault).toEqual({
      type: "string",
      default: "",
    });
  });

  it("does not treat same-name imported aliases as circular", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/base.ts": `
        export interface Default<T, V extends T = T> {}
        export type WithDefault = string | Default<"">;
      `,
        "/wrapper.ts": `
        import type { WithDefault as ImportedWithDefault } from "./base.ts";
        export type WithDefault = ImportedWithDefault;
      `,
        "/main.ts": `
        import type { WithDefault } from "./wrapper.ts";
        export interface X {
          title: WithDefault;
        }
      `,
      },
      "/main.ts",
      "X",
    );
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const title = result.properties?.title as any;
    expect(title.$ref).toBe("#/$defs/WithDefault");
    expect((result as any).$defs?.WithDefault).toEqual({
      type: "string",
      default: "",
    });
  });

  it("applies null defaults from T | Default<null>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type T = string | Default<null>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    expect(result.anyOf).toEqual(expect.arrayContaining([
      { type: "string" },
      { type: "null" },
    ]));
    expect(result.default).toBe(null);
  });

  it("collapses an EXPANDED Default<[]> array union, preserving comparable items (CT-1639)", async () => {
    // The transformer hands schema-gen a node where Default<[]> has already been
    // EXPANDED by the checker into its raw branded form — there is no `Default<>`
    // alias node left. We model that directly: `[] & DefaultMarker<[]>` plus the
    // bare `[]` empty-array member, unioned with the real comparable array. The
    // degenerate empty members must collapse so the comparable array survives
    // (single array schema, asCell:["comparable"] kept, default: []).
    const code = `
      declare const DEFAULT_MARKER: unique symbol;
      type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
      interface Item { label: string }
      type T = Array<ComparableCell<Item>> | ([] & DefaultMarker<[]>) | [];
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    // Comparable items must be preserved on the (sole) array schema.
    const arraySchema = result.anyOf
      ? (result.anyOf as any[]).find((s) =>
        s?.type === "array" && s?.items?.asCell
      )
      : result;
    expect((arraySchema?.items as any)?.asCell).toEqual(["comparable"]);
    // And the empty-only degenerate branch must not survive as a sibling that
    // dilutes consumers: no `{ type: "array", items: false }` branch.
    if (result.anyOf) {
      const hasEmptyOnly = (result.anyOf as any[]).some((s) =>
        s?.type === "array" && s?.items === false
      );
      expect(hasEmptyOnly).toBe(false);
    }
  });

  it("does NOT fabricate a default for an ordinary array | empty-tuple union (no Default brand) (CT-1639)", async () => {
    // A plain `string[] | []` has a bare empty-tuple member but NO Default brand.
    // The expanded-Default collapse must not fire here — it would invent a
    // `default: []` the author never asked for. (Regression for a cubic review
    // finding on the CT-1639 pt-1 PR.)
    const code = `type T = string[] | [];`;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );
    expect((result as any).default).toBeUndefined();
  });

  it("applies array defaults from T[] | Default<[...]>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type T = string[] | Default<["a", "b"]>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    expect(result.type).toBe("array");
    expect((result.items as any)?.type).toBe("string");
    expect(result.default).toEqual(["a", "b"]);
  });

  it("applies object defaults from T | Default<V>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface Config {
        theme: string;
      }
      type T = Config | Default<{ theme: "dark" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    const config = (result as any).$defs?.Config;
    expect(config.type).toBe("object");
    expect(config.properties?.theme).toEqual({ type: "string" });
    expect(config.required).toEqual(["theme"]);
    expect(result.default).toEqual({ theme: "dark" });
  });

  it("applies object defaults from typeof values in T | Default<V>", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      const DEFAULT_CONFIG = { theme: "dark", retries: 3 } as const;
      interface Config {
        theme: string;
        retries: number;
      }
      type T = Config | Default<typeof DEFAULT_CONFIG>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    expect(result.default).toEqual({ theme: "dark", retries: 3 });
  });

  describe("typeof values imported from another module", () => {
    // A `typeof CONST` payload reads the const's initializer off the AST, so
    // the const must be found through its import when it lives in another
    // module — the shape a pattern that keeps its defaults in a `contract.ts`
    // has. `getSymbolAtLocation` on the import returns the alias symbol, whose
    // valueDeclaration is the ImportSpecifier, not the const; without the alias
    // hop the default silently disappears from the schema (2026-08-28, found
    // through the pattern-iframe wrapper: every deployed guest hydrated to
    // `undefined`).

    const contract = `
      export interface Config {
        theme: string;
        retries: number;
      }
      export const DEFAULT_CONFIG: Config = { theme: "dark", retries: 3 };
      export const DEFAULT_THEME = "light";
    `;

    async function schemaFor(mainSource: string) {
      const { type, checker, typeNode } = await getTypeFromFiles(
        { "/contract.ts": contract, "/main.ts": mainSource },
        "/main.ts",
        "T",
      );
      return asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode),
      );
    }

    it("applies them in Config | Default<typeof IMPORTED>", async () => {
      const result = await schemaFor(`
        import { type Config, DEFAULT_CONFIG } from "./contract.ts";
        interface Default<T, V extends T = T> {}
        export type T = Config | Default<typeof DEFAULT_CONFIG>;
      `);
      expect(result.$ref).toBe("#/$defs/Config");
      expect(result.default).toEqual({ theme: "dark", retries: 3 });
    });

    it("applies them in Config | Default<Config, typeof IMPORTED>", async () => {
      const result = await schemaFor(`
        import { type Config, DEFAULT_CONFIG } from "./contract.ts";
        interface Default<T, V extends T = T> {}
        export type T = Config | Default<Config, typeof DEFAULT_CONFIG>;
      `);
      expect(result.$ref).toBe("#/$defs/Config");
      expect(result.default).toEqual({ theme: "dark", retries: 3 });
    });

    it("applies an imported const used as a shorthand property", async () => {
      const result = await schemaFor(`
        import { type Config, DEFAULT_THEME as theme } from "./contract.ts";
        interface Default<T, V extends T = T> {}
        const LOCAL = { theme, retries: 3 } as const;
        export type T = Config | Default<typeof LOCAL>;
      `);
      expect(result.default).toEqual({ theme: "light", retries: 3 });
    });

    it("applies an imported const named in longhand", async () => {
      const result = await schemaFor(`
        import { type Config, DEFAULT_THEME } from "./contract.ts";
        interface Default<T, V extends T = T> {}
        const LOCAL = { theme: DEFAULT_THEME, retries: 3 } as const;
        export type T = Config | Default<typeof LOCAL>;
      `);
      expect(result.default).toEqual({ theme: "light", retries: 3 });
    });

    it("applies an imported primitive const", async () => {
      const result = await schemaFor(`
        import { DEFAULT_THEME } from "./contract.ts";
        interface Default<T, V extends T = T> {}
        export type T = string | Default<typeof DEFAULT_THEME>;
      `);
      expect(result.default).toBe("light");
    });
  });

  describe("a payload the reader cannot fully evaluate", () => {
    // A default the reader cannot fully evaluate is withheld, never shipped as
    // a fragment: a partial object satisfies every "is there a default?" check
    // while missing a required member, and the runtime's own `Writable(CONST)`
    // holds the whole value, so schema and runtime would disagree.

    async function defaultFor(main: string) {
      const { type, checker, typeNode } = await getTypeFromFiles(
        {
          "/contract.ts": `
            export interface Config { theme: string; retries: number }
            export function computed(): string { return "x"; }
          `,
          "/main.ts": main,
        },
        "/main.ts",
        "T",
      );
      return asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, typeNode),
      ).default;
    }

    it("withholds an object with one non-literal member", async () => {
      expect(
        await defaultFor(`
          import { type Config, computed } from "./contract.ts";
          interface Default<T, V extends T = T> {}
          const PARTIAL = { theme: computed(), retries: 3 };
          export type T = Config | Default<typeof PARTIAL>;
        `),
      ).toBeUndefined();
    });

    it("withholds an object with one non-literal member outside a union", async () => {
      expect(
        await defaultFor(`
          import { type Config, computed } from "./contract.ts";
          interface Default<T, V extends T = T> {}
          const PARTIAL = { theme: computed(), retries: 3 };
          export type T = Default<Config, typeof PARTIAL>;
        `),
      ).toBeUndefined();
    });

    it("withholds an array with one non-literal element", async () => {
      expect(
        await defaultFor(`
          import { computed } from "./contract.ts";
          interface Default<T, V extends T = T> {}
          const ITEMS = ["a", computed()];
          export type T = string[] | Default<typeof ITEMS>;
        `),
      ).toBeUndefined();
    });

    it("withholds a `let` initializer", async () => {
      expect(
        await defaultFor(`
          import { type Config } from "./contract.ts";
          interface Default<T, V extends T = T> {}
          let MUTABLE = { theme: "dark", retries: 3 };
          export type T = Config | Default<typeof MUTABLE>;
        `),
      ).toBeUndefined();
    });

    for (const spelling of ["undefined", "void 0"]) {
      it(`treats a member set to ${spelling} as absent`, async () => {
        expect(
          await defaultFor(`
            interface Default<T, V extends T = T> {}
            const PREFS = { theme: "dark", selectedId: ${spelling} };
            export type T =
              | { theme: string; selectedId?: string }
              | Default<typeof PREFS>;
          `),
        ).toEqual({ theme: "dark" });
      });
    }

    it("withholds a non-computed __proto__ member, which sets no property", async () => {
      expect(
        await defaultFor(`
          interface Default<T, V extends T = T> {}
          const ROWS = { __proto__: { inherited: true }, id: 1 };
          export type T = { id: number } | Default<typeof ROWS>;
        `),
      ).toBeUndefined();
    });

    for (const operand of ["computed()", "1"]) {
      it(`withholds \`void ${operand}\``, async () => {
        expect(
          await defaultFor(`
            import { computed } from "./contract.ts";
            interface Default<T, V extends T = T> {}
            const X = { a: 1, b: void ${operand} };
            export type T = { a: number; b?: number } | Default<typeof X>;
          `),
        ).toBeUndefined();
      });
    }

    it("keeps a computed __proto__ key as an own property", async () => {
      const value = await defaultFor(`
        interface Default<T, V extends T = T> {}
        const ROWS = { ["__proto__"]: "text", id: 1 };
        export type T =
          | { ["__proto__"]: string; id: number }
          | Default<typeof ROWS>;
      `) as Record<string, unknown>;
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.hasOwn(value, "__proto__")).toBe(true);
      expect(value["__proto__"]).toBe("text");
      expect(value.id).toBe(1);
    });

    it("materializes a const two members share, by value", async () => {
      expect(
        await defaultFor(`
          interface Default<T, V extends T = T> {}
          const LEAF = { n: 1 };
          const PAIR = { left: LEAF, right: LEAF };
          export type T =
            | { left: { n: number }; right: { n: number } }
            | Default<typeof PAIR>;
        `),
      ).toEqual({ left: { n: 1 }, right: { n: 1 } });
    });

    it("withholds a const that names itself", async () => {
      expect(
        await defaultFor(`
          interface Default<T, V extends T = T> {}
          const A: { next: unknown } = { next: B };
          const B: { next: unknown } = { next: A };
          export type T = { next: unknown } | Default<typeof A>;
        `),
      ).toBeUndefined();
    });
  });

  it("applies object defaults from typeof values with shorthand properties", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      const theme = "dark" as const;
      const retries = 3 as const;
      const DEFAULT_CONFIG = { theme, retries } as const;
      interface Config {
        theme: string;
        retries: number;
      }
      type T = Config | Default<typeof DEFAULT_CONFIG>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    expect(result.default).toEqual({ theme: "dark", retries: 3 });
  });

  it("rejects object defaults that would widen an existing object member", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface Config {
        theme: string;
        retries: number;
      }
      type T = Config | Default<{ theme: "dark" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default object union member is not assignable",
    );
  });

  it("rejects nested object defaults that would widen an existing object member", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      interface Config {
        profile: {
          name: string;
          email: string;
        };
      }
      type T = Config | Default<{ profile: { name: "Ada" } }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default object union member is not assignable",
    );
  });

  it("applies recursive object defaults from T | DeepDefault<V>", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        theme: string;
        profile: {
          name: string;
          email: string;
        };
      }
      type T = Config | DeepDefault<{
        theme: "dark";
        profile: {
          name: "Ada";
        };
      }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    expect(result.$ref).toBe("#/$defs/Config");
    expect(result.default).toEqual({
      theme: "dark",
      profile: { name: "Ada" },
    });
    expect((result.properties?.theme as any)?.default).toBe("dark");

    const profile = result.properties?.profile as any;
    expect(profile.default).toEqual({ name: "Ada" });
    expect(profile.properties?.name?.default).toBe("Ada");
    expect(profile.properties?.email).toBeUndefined();
  });

  it("applies recursive object defaults to nullable object unions", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        theme: string;
        profile: {
          name: string;
          email: string;
        } | null;
      }
      type T = Config | null | DeepDefault<{
        theme: "dark";
        profile: {
          name: "Ada";
        };
      }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const result = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, typeNode),
    );

    expect(result.anyOf).toEqual(expect.arrayContaining([
      { "$ref": "#/$defs/Config" },
      { type: "null" },
    ]));
    expect(result.default).toEqual({
      theme: "dark",
      profile: { name: "Ada" },
    });
    expect((result.properties?.theme as any)?.default).toBe("dark");

    const profile = result.properties?.profile as any;
    expect(profile.default).toEqual({ name: "Ada" });
    expect(profile.properties?.name?.default).toBe("Ada");
    expect(profile.properties?.email).toBeUndefined();
  });

  it("rejects unknown keys in DeepDefault object defaults", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        theme: string;
      }
      type T = Config | DeepDefault<{ typo: "x" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      'DeepDefault key "typo" does not exist',
    );
  });

  it("rejects unknown nested keys in DeepDefault object defaults", async () => {
    const code = `
      interface DeepDefault<V> {}
      interface Config {
        profile: {
          name: string;
        };
      }
      type T = Config | DeepDefault<{
        profile: {
          typo: "x";
        };
      }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      'DeepDefault key "profile.typo" does not exist',
    );
  });

  it("rejects DeepDefault without an existing object member", async () => {
    const code = `
      interface DeepDefault<V> {}
      type T = string | DeepDefault<{ theme: "dark" }>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "DeepDefault must be unioned with an object type",
    );
  });

  it("rejects one-argument Default with aliased undefined in unions", async () => {
    const code = `
      interface Default<T, V extends T = T> {}
      type U = undefined;
      type T = string | Default<U>;
    `;
    const { type, checker, typeNode } = await getTypeFromCode(code, "T");
    const gen = new SchemaGenerator();

    expect(() => gen.generateSchema(type, checker, typeNode)).toThrow(
      "Default<undefined> is unsupported",
    );
  });
});
