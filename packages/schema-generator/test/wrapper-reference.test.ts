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

/**
 * The schema generated for `SchemaRoot`, declared in `/main.ts` of `files`,
 * with each local `$ref` replaced by the definition it names.
 */
async function rootSchema(
  files: Record<string, string>,
): Promise<{ properties: Record<string, unknown> }> {
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
  ) as { properties: Record<string, unknown>; $defs?: Record<string, unknown> };
  const defs = schema.$defs ?? {};
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => {
      const ref = (value as { $ref?: string }).$ref;
      const name = ref?.startsWith("#/$defs/") && Object.keys(value as object)
            .length === 1
        ? ref.slice("#/$defs/".length)
        : undefined;
      return [key, name && defs[name] ? defs[name] : value];
    }),
  );
  return { properties };
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
});
