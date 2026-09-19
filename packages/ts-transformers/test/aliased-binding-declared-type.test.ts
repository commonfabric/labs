import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

const IMPORTS =
  `import { action, computed, pattern, Writable, type Default, type PerUser } from "commonfabric";
interface Stored { readonly name?: string }
type Empty = Record<PropertyKey, never>;
`;

/** The schemas of the last emitted call to `callee`, for `source`. */
async function schemasOf(
  source: string,
  callee: string,
): Promise<Record<string, unknown>[]> {
  const output = await transformSource(IMPORTS + source, {
    types: COMMONFABRIC_TYPES,
  });
  return callSchemas(parseModule(output), callee);
}

/** A pattern whose `computed()` reads the input cell `c`, of type `type`. */
function computedReading(type: string): string {
  return `export default pattern<{ c: ${type} }>(({ c }) => ({
  s: computed(() => JSON.stringify(c.get())),
}));`;
}

// Each value type a cell may hold, with the schema its `computed()` capture
// emits. Every one declares a default, which the pattern body's view of the
// cell does not carry.
const CELL_VALUES: [title: string, type: string, capture: unknown][] = [
  [
    "a string with a default",
    `string | Default<"">`,
    { type: "string", default: "", asCell: ["readonly"] },
  ],
  [
    "a boolean with a default",
    `Default<boolean, true>`,
    { type: "boolean", default: true, asCell: ["readonly"] },
  ],
  [
    "an array with an empty default",
    `number[] | Default<[]>`,
    {
      type: "array",
      items: { type: "number" },
      default: [],
      asCell: ["readonly"],
    },
  ],
  [
    "an object with an empty-object default",
    `Default<Stored, {}>`,
    { $ref: "#/$defs/Stored", default: {}, asCell: ["readonly"] },
  ],
  [
    "an object in a union with an empty-record default",
    `Stored | Default<Empty>`,
    { $ref: "#/$defs/Stored", default: {}, asCell: ["readonly"] },
  ],
];

describe("aliased binding declared type", () => {
  describe("a `computed()` capture of a cell declared through an alias", () => {
    for (const [title, type, capture] of CELL_VALUES) {
      it(`emits the schema of a cell written in place, for ${title}`, async () => {
        const [inline] = await schemasOf(
          computedReading(`Writable<${type}>`),
          "lift",
        );
        const [aliased] = await schemasOf(
          `type TheCell = Writable<${type}>;\n${computedReading("TheCell")}`,
          "lift",
        );

        expect((inline!.properties as Record<string, unknown>).c)
          .toEqual(capture);
        expect(aliased).toEqual(inline);
      });
    }

    it("emits the default of a value type named by an alias", async () => {
      // The value type is hoisted under its alias's name, as it is in the
      // pattern's own input schema, and the default goes with it.

      const [aliased] = await schemasOf(
        `type Blank = string | Default<"">;\n${
          computedReading("Writable<Blank>")
        }`,
        "lift",
      );

      expect(aliased).toEqual({
        type: "object",
        properties: { c: { $ref: "#/$defs/Blank", asCell: ["readonly"] } },
        required: ["c"],
        $defs: { Blank: { type: "string", default: "" } },
      });
    });

    it("emits the value schema and default of an alias imported from another module", async () => {
      // `Stored` and `Empty` are out of scope in the module that captures the
      // cell, so the emitted type cannot lean on their names.

      const output = await transformFiles({
        "/types.ts": `import { Writable, type Default } from "commonfabric";
export interface Stored { readonly name?: string }
export type Empty = Record<PropertyKey, never>;
export type StoredCell = Writable<Stored | Default<Empty>>;
`,
        "/main.tsx": `import { computed, pattern } from "commonfabric";
import type { StoredCell } from "./types.ts";
${computedReading("StoredCell")}`,
      }, { types: COMMONFABRIC_TYPES });
      const [aliased] = callSchemas(parseModule(output["/main.tsx"]!), "lift");

      expect(aliased).toEqual({
        type: "object",
        properties: {
          c: { $ref: "#/$defs/Stored", default: {}, asCell: ["readonly"] },
        },
        required: ["c"],
        $defs: {
          Stored: { type: "object", properties: { name: { type: "string" } } },
        },
      });
    });
  });

  describe("a capture of a value declared through an alias", () => {
    it("emits the scope and default of an aliased `PerUser` in a `computed()`", async () => {
      const [aliased] = await schemasOf(
        `type Nickname = PerUser<string | Default<"">>;
export default pattern<{ c: Nickname }>(({ c }) => ({
  s: computed(() => c.trim()),
}));`,
        "lift",
      );

      expect(aliased).toEqual({
        type: "object",
        properties: { c: { $ref: "#/$defs/Nickname" } },
        required: ["c"],
        $defs: { Nickname: { type: "string", default: "", scope: "user" } },
      });
    });

    it("emits the default of an aliased cell in an `action()`", async () => {
      const [, state] = await schemasOf(
        `type Draft = Writable<string | Default<"">>;
export default pattern<{ c: Draft }>(({ c }) => ({
  log: action(() => { console.log(c.get()); }),
}));`,
        "handler",
      );

      expect((state!.properties as Record<string, unknown>).c)
        .toEqual({ type: "string", default: "", asCell: ["readonly"] });
    });
  });

  describe("a pattern result that returns an input binding", () => {
    it("emits the scope and default of an aliased `PerUser`", async () => {
      const output = await transformSource(
        `${IMPORTS}type Nickname = PerUser<string | Default<"">>;
export default pattern<{ c: Nickname }>(({ c }) => ({ c }));`,
        { types: COMMONFABRIC_TYPES },
      );
      const result = patternSchemas(parseModule(output)).output;

      expect((result.properties as Record<string, unknown>).c)
        .toEqual({ type: "string", default: "", scope: "user" });
    });
  });
});
