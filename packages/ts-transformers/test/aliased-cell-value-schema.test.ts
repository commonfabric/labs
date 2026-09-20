/**
 * Pins the value schema emitted for a cell that a builder reaches through a
 * type alias. The alias leaves the transformer no authored node for the cell's
 * value, so the value type is printed, and each case here is a print that
 * schema generation can read only from the type behind it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

const TYPES = `
  type Profile = { name: string; accentColor: string };
  interface Stored { readonly profile?: Profile }
  type Other = { other: number };
  type Empty = Record<PropertyKey, never>;
`;

/** The input schema of the last `lift()` in `body`, compiled after `TYPES`. */
async function liftInput(body: string): Promise<Record<string, unknown>> {
  const output = await transformSource(
    `import { lift, Writable, type Default } from "commonfabric";
     ${TYPES}
     ${body}`,
    { types: COMMONFABRIC_TYPES },
  );
  return callSchemas(parseModule(output), "lift")[0]!;
}

/** The schema of `c` where a `lift()` reads it whole as a `cellType`. */
async function readCellSchema(
  declarations: string,
  cellType: string,
): Promise<unknown> {
  const input = await liftInput(
    `${declarations}
     const f = lift(({ c }: { c: ${cellType} }) => JSON.stringify(c.get()));`,
  );
  return (input.properties as Record<string, unknown>).c;
}

describe("aliased-cell-value-schema", () => {
  it("emits the stored shape and its default for a read of a union cell", async () => {
    const schema = await readCellSchema(
      "type UnionCell = Writable<Stored | Default<Empty>>;",
      "UnionCell",
    );

    expect(schema).toEqual({
      anyOf: [{ $ref: "#/$defs/Stored" }, { $ref: "#/$defs/Empty" }],
      default: {},
      asCell: ["readonly"],
    });
  });

  for (
    const value of [
      "Stored",
      "Stored | Other",
      'string | Default<"">',
      'Default<string, "x">',
      "Default<boolean, true>",
      "Default<Stored, {}>",
    ]
  ) {
    it(`emits the schema of \`Writable<${value}>\` for an alias of it`, async () => {
      const aliased = await readCellSchema(
        `type TheCell = Writable<${value}>;`,
        "TheCell",
      );

      expect(aliased).toEqual(await readCellSchema("", `Writable<${value}>`));
      expect(Object.keys(aliased as object)).not.toEqual(["asCell"]);
    });
  }

  it("emits the value schema under a write-only capability", async () => {
    const input = await liftInput(
      `type TheCell = Writable<string | Default<"">>;
       const f = lift(({ c }: { c: TheCell }) => { c.set("x"); return 1; });`,
    );

    expect((input.properties as Record<string, unknown>).c).toEqual({
      type: "string",
      default: "",
      asCell: ["writeonly"],
    });
  });

  it("emits the value schema for a union one level inside the cell", async () => {
    const schema = await readCellSchema(
      "type TheCell = Writable<(Stored | Default<Empty>)[]>;",
      "TheCell",
    );

    expect(schema).toEqual({
      type: "array",
      items: {
        anyOf: [{ $ref: "#/$defs/Stored" }, { $ref: "#/$defs/Empty" }],
        default: {},
      },
      asCell: ["readonly"],
    });
  });

  it("emits the value schema for a generic alias", async () => {
    const schema = await readCellSchema(
      "type MyCell<T> = Writable<T | Default<Empty>>;",
      "MyCell<Stored>",
    );

    expect(schema).toMatchObject({ default: {}, asCell: ["readonly"] });
    expect((schema as { anyOf: unknown[] }).anyOf).toEqual(
      expect.arrayContaining([
        { $ref: "#/$defs/Stored" },
        { $ref: "#/$defs/Empty" },
      ]),
    );
  });

  it("emits the value schema where the cell is the whole argument", async () => {
    const input = await liftInput(
      `type TheCell = Writable<string | Default<"">>;
       const f = lift((c: TheCell) => JSON.stringify(c.get()));`,
    );

    expect(input).toEqual({
      type: "string",
      default: "",
      asCell: ["readonly"],
    });
  });

  describe("an alias imported from another module", () => {
    // The consuming module imports the alias and none of the names inside it,
    // so the printed value type names them as `import("./types.ts").Stored`.

    async function importedCellSchema(
      alias: string,
      body: (alias: string) => string,
    ): Promise<Record<string, unknown>> {
      const output = await transformFiles({
        "/types.ts": `import { Writable, type Default } from "commonfabric";
          export type Profile = { name: string; accentColor: string };
          export interface Stored { readonly profile?: Profile }
          export type Empty = Record<PropertyKey, never>;
          export type PlainCell = Writable<Stored>;
          export type UnionCell = Writable<Stored | Default<Empty>>;`,
        "/test.tsx": `import { lift } from "commonfabric";
          import type { ${alias} } from "./types.ts";
          ${body(alias)}`,
      }, { types: COMMONFABRIC_TYPES });
      return callSchemas(parseModule(output["/test.tsx"]!), "lift")[0]!;
    }

    const asProperty = (alias: string) =>
      `const f = lift(({ c }: { c: ${alias} }) => JSON.stringify(c.get()));`;

    it("emits the stored shape for a plain cell", async () => {
      const input = await importedCellSchema("PlainCell", asProperty);

      expect((input.properties as Record<string, unknown>).c).toEqual({
        $ref: "#/$defs/Stored",
        asCell: ["readonly"],
      });
    });

    it("emits the stored shape and its default for a union cell", async () => {
      const input = await importedCellSchema("UnionCell", asProperty);

      expect((input.properties as Record<string, unknown>).c).toEqual({
        anyOf: [{ $ref: "#/$defs/Stored" }, { $ref: "#/$defs/Empty" }],
        default: {},
        asCell: ["readonly"],
      });
    });

    it("emits the stored shape where the cell is the whole argument", async () => {
      const input = await importedCellSchema(
        "PlainCell",
        (alias) => `const f = lift((c: ${alias}) => JSON.stringify(c.get()));`,
      );

      expect(input).toMatchObject({
        $ref: "#/$defs/Stored",
        asCell: ["readonly"],
      });
    });
  });
});
