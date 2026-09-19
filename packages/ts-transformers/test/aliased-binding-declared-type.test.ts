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

/** An emitted schema, read as a plain record. */
type Schema = Record<string, unknown>;

/** The schemas of the last emitted call to `callee`, for `source`. */
async function schemasOf(
  source: string,
  callee: string,
): Promise<Record<string, unknown>[]> {
  const output = await transformSource(IMPORTS + source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
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
  describe("a binding declared by a generic input", () => {
    for (
      const [title, valueType, valueSchema] of [
        ["a number", "number", { type: ["number", "string"], default: "" }],
        ["an object", "{ count: number }", {
          anyOf: [
            {
              type: "object",
              properties: { count: { type: "number" } },
              required: ["count"],
            },
            { type: "string" },
          ],
          default: "",
        }],
      ] as const
    ) {
      for (const cell of [false, true]) {
        for (const action of [false, true]) {
          it(`retains ${title} and its default in ${action ? "an action" : "a computed"} ${cell ? "cell" : "value"} capture`, async () => {
            const output = await transformSource(
              `${IMPORTS}
type Blank = string | Default<"">;
interface Input<T> { c: ${cell ? "Writable<T | Blank>" : "T | Blank"}; }
export default pattern<Input<${valueType}>>(({ c }) => ({
  s: ${action ? "action" : "computed"}(() => JSON.stringify(${
                cell ? "c.get()" : "c"
              })),
}));`,
              { types: COMMONFABRIC_TYPES, typeCheck: true },
            );
            const schemas = callSchemas(
              parseModule(output),
              action ? "handler" : "lift",
            );
            const capture = schemas[action ? 1 : 0]!;
            expect((capture.properties as Record<string, unknown>).c).toEqual({
              ...valueSchema,
              ...(cell ? { asCell: ["readonly"] } : {}),
            });
          });
        }
      }
    }

    it("retains the concrete type and default in a result with a scoped binding", async () => {
      const output = await transformSource(
        `${IMPORTS}
type Blank = string | Default<"">;
interface Input<T> { c: T | Blank; nickname: PerUser<string>; }
export default pattern<Input<number>>(({ c, nickname }) => ({ c, nickname }));`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const result = patternSchemas(parseModule(output)).output;
      expect((result.properties as Record<string, unknown>).c).toEqual({
        type: ["number", "string"],
        default: "",
      });
      expect((result.properties as Record<string, unknown>).nickname).toEqual({
        type: "string",
        scope: "user",
      });
    });

    it("instantiates an inherited, nested, renamed binding from an imported input", async () => {
      const output = await transformFiles({
        "/types.ts": `import type { Default } from "commonfabric";
type Blank = string | Default<"">;
interface Fields<T> { nested: { c: T | Blank }; }
export interface Input<T> extends Fields<T> {}`,
        "/main.tsx": `import { computed, pattern } from "commonfabric";
import type { Input } from "./types.ts";
export default pattern<Input<number>>((({ nested: { c: renamed } }) => ({
  s: computed(() => JSON.stringify(renamed)),
})));`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });
      const [capture] = callSchemas(parseModule(output["/main.tsx"]!), "lift");
      expect((capture!.properties as Record<string, unknown>).renamed).toEqual({
        type: ["number", "string"],
        default: "",
      });
    });

    it("instantiates a property declared in a generic input alias", async () => {
      const [capture] = await schemasOf(
        `
type Blank = string | Default<"">;
type Input<T> = { c: Writable<T | Blank> };
export default pattern<Input<number>>(({ c }) => ({
  s: computed(() => JSON.stringify(c.get())),
}));`,
        "lift",
      );
      expect((capture!.properties as Record<string, unknown>).c).toEqual({
        type: ["number", "string"],
        default: "",
        asCell: ["readonly"],
      });
    });

    it("retains the concrete fields of an alias supplied as the type argument", async () => {
      const [capture] = await schemasOf(
        `
type Blank = string | Default<"">;
type Box<T> = { value: T };
interface Input<T> { c: Writable<T | Blank>; }
export default pattern<Input<Box<number>>>(({ c }) => ({
  s: computed(() => JSON.stringify(c.get())),
}));`,
        "lift",
      );
      expect((capture!.properties as Record<string, unknown>).c).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
          { type: "string" },
        ],
        default: "",
        asCell: ["readonly"],
      });
    });

    it("emits the instantiated declared type for an argument that names a generic type", async () => {
      // A node naming `Box<number>` would be read from `Box`'s generic
      // declaration, with `value` unresolved.

      const [capture] = await schemasOf(
        `
type Blank = string | Default<"">;
interface Box<T> { value: T; }
interface Input<T> { c: T | Blank; }
export default pattern<Input<Box<number>>>(({ c }) => ({
  s: computed(() => JSON.stringify(c)),
}));`,
        "lift",
      );
      expect((capture!.properties as Record<string, unknown>).c).toEqual({
        anyOf: [
          { type: "string" },
          {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        ],
        default: "",
      });
    });

    it("emits a type argument that names a type in scope, with the default", async () => {
      const [capture] = await schemasOf(
        `
interface Input<T> { c: Writable<T | Default<{}>>; }
export default pattern<Input<Stored>>(({ c }) => ({
  s: computed(() => JSON.stringify(c.get())),
}));`,
        "lift",
      );
      expect((capture!.properties as Record<string, unknown>).c).toEqual({
        $ref: "#/$defs/Stored",
        default: {},
        asCell: ["readonly"],
      });
    });

    it("keeps the value type of a cell whose default is an empty object", async () => {
      // With `Default<{}>` stripped, `Box<number> | {}` reduces to `{}`, so the
      // pattern body's view of this cell holds no `value`.

      const [capture] = await schemasOf(
        `
interface Box<T> { value: T; }
interface Input<T> { c: Writable<T | Default<{}>>; }
export default pattern<Input<Box<number>>>(({ c }) => ({
  s: computed(() => JSON.stringify(c.get())),
}));`,
        "lift",
      );
      expect((capture!.properties as Record<string, unknown>).c).toEqual({
        anyOf: [
          { type: "object", properties: {} },
          {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        ],
        default: {},
        asCell: ["readonly"],
      });
    });

    it("keeps the value type of an argument named outside the capturing module", async () => {
      // `Shape` is not imported where the binding is captured, so a node
      // naming it would read as nothing there.

      const output = await transformFiles({
        "/types.ts": `import type { Default } from "commonfabric";
export interface Shape { side: number }
interface Generic<T> { v: T | Default<{}>; }
export type Input = Generic<Shape>;`,
        "/main.tsx": `import { computed, pattern } from "commonfabric";
import type { Input } from "./types.ts";
export default pattern<Input>(({ v }) => ({
  s: computed(() => JSON.stringify(v)),
}));`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });
      const [capture] = callSchemas(parseModule(output["/main.tsx"]!), "lift");
      expect(capture).toEqual({
        type: "object",
        properties: {
          v: {
            anyOf: [
              { type: "object", properties: {} },
              { $ref: "#/$defs/Shape" },
            ],
            default: {},
          },
        },
        required: ["v"],
        $defs: {
          Shape: {
            type: "object",
            properties: { side: { type: "number" } },
            required: ["side"],
          },
        },
      });
    });

    for (
      const [title, input, argument, capture] of [
        [
          "a scope wrapper",
          `interface Input<T> { c: PerUser<T | Default<"">>; }`,
          "Input<string>",
          { type: "string", default: "", scope: "user" },
        ],
        [
          "a `Default`",
          `interface Input<T, V extends T> { c: Default<T, V>; }`,
          `Input<string, "x">`,
          { type: "string", default: "x" },
        ],
      ] as const
    ) {
      it(`instantiates a type parameter written inside ${title}`, async () => {
        const [lift] = await schemasOf(
          `
${input}
export default pattern<${argument}>(({ c }) => ({
  s: computed(() => JSON.stringify(c)),
}));`,
          "lift",
        );
        expect((lift!.properties as Record<string, unknown>).c)
          .toEqual(capture);
      });
    }

    for (
      const [shape, concrete] of [
        ['T["value"]', { type: ["number", "string"], default: "" }],
        ["Writable<T>", {
          default: "",
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
              asCell: ["cell"],
            },
          ],
        }],
        ["T[]", {
          default: "",
          anyOf: [
            { type: "string" },
            {
              type: "array",
              items: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
              },
            },
          ],
        }],
        ["Box<T>", {
          default: "",
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                nested: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
              required: ["nested"],
            },
          ],
        }],
      ] as const
    ) {
      it(`emits the instantiated declared type for a property containing ${shape}`, async () => {
        const [capture] = await schemasOf(
          `
type Blank = string | Default<"">;
type Box<T> = { nested: T };
interface Input<T extends { value: number }> { c: ${shape} | Blank; }
export default pattern<Input<{ value: number }>>(({ c }) => ({
  s: computed(() => JSON.stringify(c)),
}));`,
          "lift",
        );
        expect((capture!.properties as Record<string, unknown>).c).toEqual(
          concrete,
        );
      });
    }
  });

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
    it("emits the default of an aliased `PerUser` in a `computed()`", async () => {
      // Whether the value's schema sits in place or under its alias's name is
      // schema generation's choice, so the default is read from wherever it
      // put the schema.

      const [aliased] = await schemasOf(
        `type Nickname = PerUser<string | Default<"">>;
export default pattern<{ c: Nickname }>(({ c }) => ({
  s: computed(() => c.trim()),
}));`,
        "lift",
      );
      const c = (aliased!.properties as Record<string, Schema>).c!;
      const value = typeof c.$ref === "string"
        ? (aliased!.$defs as Record<string, Schema>)[
          c.$ref.replace("#/$defs/", "")
        ]!
        : c;

      expect(value.type).toBe("string");
      expect(value.default).toBe("");
    });

    it("emits the author's own type that shares a wrapper's name as that type", async () => {
      const output = await transformSource(
        `import { computed, pattern } from "commonfabric";
type Default<T, V = T> = { mine: T; tag?: V };
type Mine = Default<string, "x">;
export default pattern<{ c: Mine }>(({ c }) => ({
  s: computed(() => JSON.stringify(c)),
}));`,
        { types: COMMONFABRIC_TYPES },
      );
      const [capture] = callSchemas(parseModule(output), "lift");

      expect((capture!.$defs as Record<string, Schema>).Mine!.properties)
        .toHaveProperty("mine", { type: "string" });
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
