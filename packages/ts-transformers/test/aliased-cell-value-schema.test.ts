/**
 * Pins the value schema emitted for a cell that a builder reaches through a
 * type alias. A non-generic alias is read through to the node it names, so the
 * cell emits what the same wrapper emits written in place, in every position a
 * cell is declared. A generic alias names a node written in its own type
 * parameters, which leaves no authored node for the cell's value; the value
 * type is printed instead, and those cases pin what schema generation reads
 * from the print.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CELL_DECLARATION_POSITIONS } from "./cell-declaration-positions.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

const TYPES = `
  type Profile = { name: string; accentColor: string };
  interface Stored { readonly profile?: Profile }
  type Other = { other: number };
  type Empty = Record<PropertyKey, never>;
`;

/** Transforms `body` after `TYPES`, with the builders it may call imported. */
function transformBody(body: string): Promise<string> {
  return transformSource(
    `import { computed, handler, lift, pattern, Writable, type Default } from "commonfabric";
     ${TYPES}
     ${body}`,
    { types: COMMONFABRIC_TYPES },
  );
}

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
      $ref: "#/$defs/Stored",
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
      "Stored | Default<Empty>",
      "number[] | Default<[]>",
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
      items: { $ref: "#/$defs/Stored", default: {} },
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
        $ref: "#/$defs/Stored",
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

  describe("in every position a cell is declared", () => {
    for (
      const [position, { source, schemaOf }] of Object.entries(
        CELL_DECLARATION_POSITIONS,
      )
    ) {
      for (
        const value of [
          "Stored | Default<Empty>",
          "number[] | Default<[]>",
          'string | Default<"">',
        ]
      ) {
        it(`emits for an alias of \`Writable<${value}>\` in ${position} what the wrapper written there emits`, async () => {
          const aliased = schemaOf(
            await transformBody(
              `type TheCell = Writable<${value}>;
               ${source("TheCell")}`,
            ),
          );
          const inline = schemaOf(
            await transformBody(source(`Writable<${value}>`)),
          );

          expect(aliased).toEqual(inline);
          expect(aliased).toHaveProperty("default");
          expect(aliased).toHaveProperty("asCell");
        });
      }
    }
  });

  describe("in a `handler()` event", () => {
    // An event is served in the structure its author wrote, with only its cell
    // positions rewritten, so an alias is read through where a cell inside it
    // is rewritten and kept as written where none is.

    /** The schema of the event's `x`, with `x` declared as `eventType`. */
    async function eventX(
      declarations: string,
      eventType: string,
    ): Promise<unknown> {
      const output = await transformBody(
        `${declarations}
         const h = handler<{ x: ${eventType} }, Record<string, never>>((e) => {
           console.log(JSON.stringify(e.x?.get()));
         });`,
      );
      const event = callSchemas(parseModule(output), "handler")[0];
      return (event?.properties as Record<string, unknown> | undefined)?.x;
    }

    it("emits for an alias of a nullable cell what the union written in place emits", async () => {
      const aliased = await eventX(
        "type MaybeCell = Writable<Stored> | undefined;",
        "MaybeCell",
      );

      expect(aliased).toEqual(
        await eventX("", "Writable<Stored> | undefined"),
      );
      expect(aliased).toEqual({
        anyOf: [
          { $ref: "#/$defs/Stored", asCell: ["readonly"] },
          { type: "undefined" },
        ],
      });
    });

    it("emits a recursive event type through a reference to itself", async () => {
      const output = await transformBody(
        `type EventNode = { value: string; child?: EventNode };
         const h = handler<EventNode, Record<string, never>>((event) => {
           console.log(event.value);
         });`,
      );

      expect(callSchemas(parseModule(output), "handler")[0]).toEqual({
        $ref: "#/$defs/EventNode",
        $defs: {
          EventNode: {
            type: "object",
            properties: {
              value: { type: "string" },
              child: { $ref: "#/$defs/EventNode" },
            },
            required: ["value"],
          },
        },
      });
    });

    it("rewrites the cells of a recursive event type and emits its recursion as a reference", async () => {
      const output = await transformBody(
        `type EventNode = { value: Writable<string>; child?: EventNode };
         const h = handler<EventNode, Record<string, never>>((event) => {
           console.log(event.value.get());
         });`,
      );
      const properties = callSchemas(parseModule(output), "handler")[0]
        ?.properties as Record<string, unknown>;

      expect(properties.value).toEqual({
        type: "string",
        asCell: ["readonly"],
      });
      expect(properties.child).toEqual({ $ref: "#/$defs/EventNode" });
    });

    it("emits a reference to an alias whose type holds no cell", async () => {
      const output = await transformBody(
        `const h = handler<{ x: Profile }, Record<string, never>>((e) => {
           console.log(e.x.name);
         });`,
      );
      const event = callSchemas(parseModule(output), "handler")[0];

      expect((event?.properties as Record<string, unknown>).x).toEqual({
        $ref: "#/$defs/Profile",
      });
    });
  });

  describe("a `commonfabric` cell wrapper imported under another name", () => {
    // The wrapper is recognized by the declaration its name resolves to, not
    // by the name it is imported as.

    for (
      const [imported, spelling] of [
        ["Cell as Writable", "Writable"],
        ["ReadonlyCell as Cell", "Cell"],
        ["Writable as MyCell", "MyCell"],
      ]
    ) {
      for (
        const position of [
          "a `lift()` property",
          "a `handler()` event property",
          "a `handler()` state",
        ]
      ) {
        it(`emits for \`${imported}\` in ${position} what \`Writable\` emits`, async () => {
          const { source, schemaOf } = CELL_DECLARATION_POSITIONS[position]!;
          const transformWith = (specifier: string, cellType: string) =>
            transformSource(
              `import { computed, handler, lift, pattern, ${specifier} } from "commonfabric";
               ${source(cellType)}`,
              { types: COMMONFABRIC_TYPES },
            );

          const renamed = schemaOf(
            await transformWith(imported!, `${spelling}<string>`),
          );

          expect(renamed).toEqual(
            schemaOf(await transformWith("Writable", "Writable<string>")),
          );
          expect(renamed).toHaveProperty("asCell");
        });
      }
    }
  });

  describe("a type of the author's own named like a wrapper", () => {
    // A wrapper's name counts only where it resolves to `commonfabric`'s
    // declaration, written in place and through an alias alike.

    /** The input schema of a `lift()` taking `box` as `parameterType`. */
    async function argumentSchema(
      declarations: string,
      parameterType: string,
    ): Promise<unknown> {
      const output = await transformSource(
        `import { lift } from "commonfabric";
         type Writable<T> = { value: T };
         ${declarations}
         const f = lift((box: ${parameterType}) => box.value);`,
        { types: COMMONFABRIC_TYPES },
      );
      return callSchemas(parseModule(output), "lift")[0];
    }

    const OBJECT = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    };

    it("emits the object type it names, written in place", async () => {
      expect(await argumentSchema("", "Writable<string>")).toEqual(OBJECT);
    });

    it("emits the object type it names, reached through an alias", async () => {
      expect(
        await argumentSchema("type Box = Writable<string>;", "Box"),
      ).toEqual(OBJECT);
    });
  });

  it("rejects a default its value type does not admit, as the wrapper written in place does", async () => {
    const { source } = CELL_DECLARATION_POSITIONS["a `lift()` property"]!;
    const message = "Default object union member is not assignable";

    await expect(
      transformBody(source("Writable<Stored | Default<Other>>")),
    ).rejects.toThrow(message);
    await expect(
      transformBody(
        `type TheCell = Writable<Stored | Default<Other>>;
         ${source("TheCell")}`,
      ),
    ).rejects.toThrow(message);
  });
});
