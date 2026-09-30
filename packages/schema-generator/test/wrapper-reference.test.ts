import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { SchemaGenerator } from "../src/schema-generator.ts";
import { createTestProgramFromFiles } from "./utils.ts";

/** The types the cases build their cells from, declared in `/types.ts`. */
const TYPES = `
  export interface Stored { readonly name?: string }
  export type Empty = Record<PropertyKey, never>;
  export type Default<T, V extends T = T> = T;
`;

/** The schema `Writable<Stored | Default<Empty>>` emits. */
const STORED_CELL = {
  $ref: "#/$defs/Stored",
  default: {},
  asCell: ["cell"],
};

/** The schema of an object `{ value: string }`. */
const VALUE_OBJECT = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
};

/** A generated schema, with the `$defs` it refers to. */
interface RootSchema {
  properties: Record<string, any>;
  $defs: Record<string, any>;
}

/** The schema generated for `SchemaRoot`, declared in `/main.ts` of `files`. */
async function generateRoot(
  files: Record<string, string>,
): Promise<RootSchema> {
  const { checker, sourceFile } = await createTestProgramFromFiles(
    files,
    "/main.ts",
  );
  const root = sourceFile.statements.find((
    statement,
  ): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) &&
    statement.name.text === "SchemaRoot"
  );
  if (!root) throw new Error("No `SchemaRoot` interface");
  const schema = new SchemaGenerator().generateSchema(
    checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(root.name)!),
    checker,
  ) as { properties: Record<string, any>; $defs?: Record<string, any> };
  return { properties: schema.properties, $defs: schema.$defs ?? {} };
}

/**
 * The schema generated for `SchemaRoot`, declared in `/main.ts` of `files`,
 * with each local `$ref` replaced by the definition it names.
 */
async function rootSchema(
  files: Record<string, string>,
): Promise<{ properties: Record<string, unknown> }> {
  const { properties, $defs } = await generateRoot(files);
  return {
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const ref = (value as { $ref?: string }).$ref;
        const name = ref?.startsWith("#/$defs/") &&
            Object.keys(value as object).length === 1
          ? ref.slice("#/$defs/".length)
          : undefined;
        return [key, name && $defs[name] ? $defs[name] : value];
      }),
    ),
  };
}

/** Every local `$ref` in `schema` that names no entry of its `$defs`. */
function danglingReferences(schema: RootSchema): string[] {
  const dangling: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const ref = (value as { $ref?: unknown }).$ref;
    if (
      typeof ref === "string" && ref.startsWith("#/$defs/") &&
      !(ref.slice("#/$defs/".length) in schema.$defs)
    ) {
      dangling.push(ref);
    }
    Object.values(value).forEach(visit);
  };
  visit(schema.properties);
  visit(schema.$defs);
  return dangling;
}

describe("wrapper-reference", () => {
  // A wrapper is read from the node its author wrote: through parentheses and
  // through type aliases, imported ones included, and only where its name is
  // `commonfabric`'s.

  it("emits a parenthesized cell as the cell written without parentheses", async () => {
    const { properties } = await rootSchema({
      "/types.ts": TYPES,
      "/main.ts": `
        import type { Default, Empty, Stored } from "./types.ts";
        export interface SchemaRoot {
          bare: Writable<Stored | Default<Empty>>;
          once: (Writable<Stored | Default<Empty>>);
          twice: ((Writable<Stored | Default<Empty>>));
        }
      `,
    });

    expect(properties.bare).toEqual(STORED_CELL);
    expect(properties.once).toEqual(STORED_CELL);
    expect(properties.twice).toEqual(STORED_CELL);
  });

  it("emits a union with a default inside two pairs of parentheses as the union written bare", async () => {
    const { properties } = await rootSchema({
      "/types.ts": TYPES,
      "/main.ts": `
        import type { Default, Empty, Stored } from "./types.ts";
        export interface SchemaRoot {
          bare: Stored | Default<Empty>;
          twice: ((Stored | Default<Empty>));
        }
      `,
    });

    expect(properties.twice).toEqual(properties.bare);
    expect(properties.bare).toHaveProperty("default", {});
  });

  it("emits a cell reached through an imported alias as the cell it names", async () => {
    const { properties } = await rootSchema({
      "/types.ts": `${TYPES}
        export type TheCell = Writable<Stored | Default<Empty>>;`,
      "/main.ts": `
        import type { TheCell } from "./types.ts";
        import type * as types from "./types.ts";
        export interface SchemaRoot {
          imported: TheCell;
          qualified: types.TheCell;
        }
      `,
    });

    expect(properties.imported).toEqual(STORED_CELL);
    expect(properties.qualified).toEqual(STORED_CELL);
  });

  it("emits a type of the author's own named `Writable` as that type", async () => {
    const { properties } = await rootSchema({
      "/types.ts": `
        export type Writable<T> = { value: T };
        export type Box = Writable<string>;
      `,
      "/main.ts": `
        import type { Box } from "./types.ts";
        import type * as types from "./types.ts";
        type Writable<T> = { value: T };
        type LocalBox = Writable<string>;
        export interface SchemaRoot {
          inPlace: Writable<string>;
          local: LocalBox;
          imported: Box;
          qualified: types.Box;
        }
      `,
    });

    expect(properties).toEqual({
      inPlace: VALUE_OBJECT,
      local: VALUE_OBJECT,
      imported: VALUE_OBJECT,
      qualified: VALUE_OBJECT,
    });
  });

  it("emits a `commonfabric` cell wrapper imported under another name as that wrapper", async () => {
    const { properties } = await rootSchema({
      "/types.ts": TYPES,
      "/main.ts": `
        import type { Cell as Box } from "commonfabric";
        import type { Default, Empty, Stored } from "./types.ts";
        export interface SchemaRoot {
          renamed: Box<Stored | Default<Empty>>;
        }
      `,
    });

    expect(properties.renamed).toEqual(STORED_CELL);
  });

  describe("a generic alias", () => {
    // A generic alias is read from the type it instantiates: the node it
    // declares is written in its own type parameters, and its reference's
    // arguments are not the wrapper's. `Default` here carries the brand that
    // `commonfabric`'s does, which is where an instantiated type keeps its
    // default.

    /** Branded `Default` and the generic aliases the cases reach it through. */
    const GENERIC_TYPES = `
      declare const DEFAULT_MARKER: unique symbol;
      type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
      export type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
      export type ArrayFallback<T> = Default<T[], []>;
      export type LiteralFallback<V extends string> = Default<string, V>;
      export type ArrayCell<T> = Writable<Default<T[], []>>;
      export type ConcreteCell = ArrayCell<string>;
      export type ConcreteDefault = ArrayFallback<string>;
      export type PassDefault<T, V extends T = T> = Default<T, V>;
      export type PassPassDefault<T, V extends T = T> = PassDefault<T, V>;
      export type FixedDefault<T> = Default<string, "fixed">;
      export type PassCell<T> = Writable<T>;
      export interface Stored { readonly name?: string }
      export type Empty = Record<PropertyKey, never>;
      export type FixedEmpty<T> = Default<Empty>;
    `;

    /** The same aliases, declared in the module that uses them. */
    const LOCAL_ALIASES = `
      type LocalArrayFallback<T> = Default<T[], []>;
      type LocalLiteralFallback<V extends string> = Default<string, V>;
      type LocalArrayCell<T> = Writable<Default<T[], []>>;
      type LocalConcreteCell = LocalArrayCell<string>;
      type LocalConcreteDefault = LocalArrayFallback<string>;
      type LocalPassDefault<T, V extends T = T> = Default<T, V>;
      type LocalFixedDefault<T> = Default<string, "fixed">;
      type LocalPassCell<T> = Writable<T>;
      type LocalFixedEmpty<T> = Default<Empty>;
    `;

    const IMPORTS = `
      import type {
        ArrayCell,
        ArrayFallback,
        ConcreteCell,
        ConcreteDefault,
        Default,
        Empty,
        FixedDefault,
        FixedEmpty,
        LiteralFallback,
        PassCell,
        PassDefault,
        PassPassDefault,
        Stored,
      } from "./types.ts";
    `;

    const STRING_ARRAY = {
      type: "array",
      items: { type: "string" },
      default: [],
    };

    it("emits a reference whose arguments the alias remaps into `Default` as that `Default` written in place", async () => {
      const { properties } = await rootSchema({
        "/types.ts": GENERIC_TYPES,
        "/main.ts": `${IMPORTS}${LOCAL_ALIASES}
          export interface SchemaRoot {
            arrayInPlace: Default<string[], []>;
            arrayImported: ArrayFallback<string>;
            arrayLocal: LocalArrayFallback<string>;
            literalInPlace: Default<string, "hello">;
            literalImported: LiteralFallback<"hello">;
            literalLocal: LocalLiteralFallback<"hello">;
          }
        `,
      });

      expect(properties.arrayInPlace).toEqual(STRING_ARRAY);
      expect(properties.arrayImported).toEqual(properties.arrayInPlace);
      expect(properties.arrayLocal).toEqual(properties.arrayInPlace);
      expect(properties.literalInPlace).toEqual({
        type: "string",
        default: "hello",
      });
      expect(properties.literalImported).toEqual(properties.literalInPlace);
      expect(properties.literalLocal).toEqual(properties.literalInPlace);
    });

    it("emits a parenthesized reference to a generic cell alias as the cell written in place", async () => {
      const { properties } = await rootSchema({
        "/types.ts": GENERIC_TYPES,
        "/main.ts": `${IMPORTS}${LOCAL_ALIASES}
          export interface SchemaRoot {
            inPlace: Writable<Default<string[], []>>;
            imported: (ArrayCell<string>);
            local: (LocalArrayCell<string>);
          }
        `,
      });

      expect(properties.inPlace).toEqual({ ...STRING_ARRAY, asCell: ["cell"] });
      expect(properties.imported).toEqual(properties.inPlace);
      expect(properties.local).toEqual(properties.inPlace);
    });

    it("emits an alias without type parameters that names a generic one as the wrapper written in place", async () => {
      const { properties } = await rootSchema({
        "/types.ts": GENERIC_TYPES,
        "/main.ts": `${IMPORTS}${LOCAL_ALIASES}
          export interface SchemaRoot {
            cellInPlace: Writable<Default<string[], []>>;
            cellImported: ConcreteCell;
            cellLocal: LocalConcreteCell;
            defaultInPlace: Default<string[], []>;
            defaultImported: ConcreteDefault;
            defaultLocal: LocalConcreteDefault;
          }
        `,
      });

      expect(properties.cellInPlace).toEqual({
        ...STRING_ARRAY,
        asCell: ["cell"],
      });
      expect(properties.cellImported).toEqual(properties.cellInPlace);
      expect(properties.cellLocal).toEqual(properties.cellInPlace);
      expect(properties.defaultInPlace).toEqual(STRING_ARRAY);
      expect(properties.defaultImported).toEqual(properties.defaultInPlace);
      expect(properties.defaultLocal).toEqual(properties.defaultInPlace);
    });

    it("emits a reference to an alias that passes its parameters to `Default` as that `Default` written in place", async () => {
      const { properties } = await rootSchema({
        "/types.ts": GENERIC_TYPES,
        "/main.ts": `${IMPORTS}${LOCAL_ALIASES}
          export interface SchemaRoot {
            inPlace: Default<string, "single">;
            imported: PassDefault<string, "single">;
            chained: PassPassDefault<string, "single">;
            local: LocalPassDefault<string, "single">;
          }
        `,
      });

      expect(properties.inPlace).toEqual({ type: "string", default: "single" });
      expect(properties.imported).toEqual(properties.inPlace);
      expect(properties.chained).toEqual(properties.inPlace);
      expect(properties.local).toEqual(properties.inPlace);
    });

    it("emits a reference to an alias whose `Default` ignores its parameters as that `Default` written in place", async () => {
      const { properties } = await rootSchema({
        "/types.ts": GENERIC_TYPES,
        "/main.ts": `${IMPORTS}${LOCAL_ALIASES}
          export interface SchemaRoot {
            inPlace: Default<string, "fixed">;
            imported: FixedDefault<number>;
            local: LocalFixedDefault<number>;
          }
        `,
      });

      expect(properties.inPlace).toEqual({ type: "string", default: "fixed" });
      expect(properties.imported).toEqual(properties.inPlace);
      expect(properties.local).toEqual(properties.inPlace);
    });

    it("emits a union whose `Default` arm is an alias that ignores its parameters as the union with the arm written in place", async () => {
      const { properties } = await rootSchema({
        "/types.ts": GENERIC_TYPES,
        "/main.ts": `${IMPORTS}${LOCAL_ALIASES}
          export interface SchemaRoot {
            inPlace: Stored | Default<Empty>;
            imported: Stored | FixedEmpty<number>;
            local: Stored | LocalFixedEmpty<number>;
          }
        `,
      });

      expect(properties.inPlace).toHaveProperty("default", {});
      expect(properties.imported).toEqual(properties.inPlace);
      expect(properties.local).toEqual(properties.inPlace);
    });

    it("emits a recursive type through an alias that passes its parameter to a cell as the type written with the cell in place", async () => {
      const schema = await generateRoot({
        "/types.ts": GENERIC_TYPES,
        "/main.ts": `${IMPORTS}${LOCAL_ALIASES}
          interface InPlace { children: Writable<InPlace[]> }
          interface Imported { children: PassCell<Imported[]> }
          interface Local { children: LocalPassCell<Local[]> }
          export interface SchemaRoot {
            inPlace: Writable<InPlace[]>;
            imported: PassCell<Imported[]>;
            local: LocalPassCell<Local[]>;
          }
        `,
      });

      for (const name of ["InPlace", "Imported", "Local"]) {
        const key = name[0]!.toLowerCase() + name.slice(1);
        expect(schema.properties[key]).toEqual({
          $ref: expect.stringMatching(/^#\/\$defs\//),
          asCell: ["cell"],
        });
        expect(schema.$defs[name]).toEqual({
          type: "object",
          properties: { children: schema.properties[key] },
          required: ["children"],
        });
      }
      expect(danglingReferences(schema)).toEqual([]);
    });
  });

  describe("a recursive type through a parenthesized wrapper", () => {
    // A wrapper keeps its own stack entry however it is written, so a type
    // that recurs through it is defined once and referred to, in parentheses
    // as bare.

    it("emits the type written with the wrapper in parentheses as the type written with it bare", async () => {
      const schema = await generateRoot({
        "/types.ts": TYPES,
        "/main.ts": `
          import type { Default } from "./types.ts";
          interface CellBare { children: Writable<CellBare[]> }
          interface CellParen { children: (Writable<CellParen[]>) }
          interface DefaultBare { next: Default<DefaultBare[], []> }
          interface DefaultParen { next: (Default<DefaultParen[], []>) }
          export interface SchemaRoot {
            cellBare: Writable<CellBare[]>;
            cellParen: (Writable<CellParen[]>);
            defaultBare: Default<DefaultBare[], []>;
            defaultParen: (Default<DefaultParen[], []>);
          }
        `,
      });

      expect(danglingReferences(schema)).toEqual([]);
      const cell = { $ref: expect.any(String), asCell: ["cell"] };
      const defaulted = { $ref: expect.any(String), default: [] };
      expect(schema.properties.cellBare).toEqual(cell);
      expect(schema.properties.cellParen).toEqual(cell);
      expect(schema.properties.defaultBare).toEqual(defaulted);
      expect(schema.properties.defaultParen).toEqual(defaulted);
      expect(schema.$defs.CellParen.properties.children).toEqual(
        schema.properties.cellParen,
      );
      expect(schema.$defs.DefaultParen.properties.next).toEqual(
        schema.properties.defaultParen,
      );
    });
  });
});
