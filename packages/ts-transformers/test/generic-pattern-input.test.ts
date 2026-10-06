import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const IMPORTS =
  `import { computed, pattern, Writable, type Default, type PerUser } from "commonfabric";
interface Box<T> { value: T; }
`;

/** An emitted schema, read as a plain record. */
type Schema = Record<string, unknown>;

/** The schemas emitted for the binding `c`, one per place it is emitted. */
interface BindingSchemas {
  /** Schema of `c` in the pattern's input schema. */
  readonly input: unknown;

  /** Schema of `c` in the pattern's result schema. */
  readonly result: unknown;

  /** Schema of `c` in the input schema of the `computed()` capturing it. */
  readonly capture: unknown;
}

/**
 * The schemas `c` is emitted with by a pattern typed `argument` that returns
 * `c` and reads it in a `computed()`, through `.get()` when `cell` is set.
 */
async function bindingSchemasOf(
  declarations: string,
  argument: string,
  cell: boolean,
): Promise<BindingSchemas> {
  const output = await transformSource(
    `${IMPORTS}${declarations}
export default pattern<${argument}>(({ c }) => ({
  c,
  s: computed(() => JSON.stringify(${cell ? "c.get()" : "c"})),
}));`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const { input, output: result } = patternSchemas(root);
  const [capture] = callSchemas(root, "lift");
  return {
    input: (input.properties as Schema).c,
    result: (result.properties as Schema).c,
    capture: (capture!.properties as Schema).c,
  };
}

const boxOfNumber = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
};

describe("generic pattern input", () => {
  // Each property is declared in terms of a type parameter of the pattern's
  // input, and the pattern's input and result schemas are those of the same
  // property declared with the argument in place. The capture carries what the
  // input does, with its cell narrowed to what the `computed()` does with it.

  for (
    const [declared, argument, cell, schema, captureAsCell] of [
      [
        `T | string | Default<"">`,
        "number",
        false,
        { type: ["number", "string"], default: "" },
        undefined,
      ],
      [
        "Writable<T | Default<0>>",
        "number",
        true,
        { type: "number", default: 0, asCell: ["cell"] },
        ["readonly"],
      ],
      [
        "PerUser<T>",
        "string",
        false,
        { type: "string", scope: "user" },
        undefined,
      ],
      [
        "PerUser<T>",
        "Box<string>",
        false,
        {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          scope: "user",
        },
        undefined,
      ],
      [
        `PerUser<T | Default<"">>`,
        "string",
        false,
        { type: "string", default: "", scope: "user" },
        undefined,
      ],
      [
        "T[] | Default<[]>",
        "number",
        false,
        { type: "array", items: { type: "number" }, default: [] },
        undefined,
      ],
      [
        "Writable<T[] | Default<[]>>",
        "Box<number>",
        true,
        { type: "array", items: boxOfNumber, default: [], asCell: ["cell"] },
        ["readonly"],
      ],
      [
        "T | Default<0>",
        "number",
        false,
        { type: "number", default: 0 },
        undefined,
      ],
      [
        "Box<T> | Default<{ value: T }>",
        "0",
        false,
        {
          type: "object",
          properties: { value: { type: "number", enum: [0] } },
          required: ["value"],
          default: { value: 0 },
        },
        undefined,
      ],
    ] as const
  ) {
    it(`emits \`${declared}\` with \`T\` as \`${argument}\` as the property declared with \`${argument}\` in place`, async () => {
      const generic = await bindingSchemasOf(
        `interface Input<T> { c: ${declared}; }`,
        `Input<${argument}>`,
        cell,
      );
      const inPlace = await bindingSchemasOf(
        `interface Input { c: ${declared.replace(/\bT\b/g, argument)}; }`,
        "Input",
        cell,
      );
      expect(generic).toEqual({
        input: schema,
        result: inPlace.result,
        capture: captureAsCell ? { ...schema, asCell: captureAsCell } : schema,
      });
      expect(inPlace.input).toEqual(schema);
    });
  }

  it("keeps a valid inline object default in the input and capture schemas", async () => {
    // The capture reads the expanded brand union and retains its covered
    // literal-object arm. Both arms accept numbers, so this reading has the
    // same value constraint as the input's authored object reading.

    const generic = await bindingSchemasOf(
      "interface Input<T> { c: { value: T } | Default<{ value: 0 }> }",
      "Input<number>",
      false,
    );
    const inPlace = await bindingSchemasOf(
      "interface Input { c: { value: number } | Default<{ value: 0 }> }",
      "Input",
      false,
    );
    expect(generic.input).toEqual(inPlace.input);
    expect(generic.result).toEqual(inPlace.result);
    expect(generic.input).toEqual({ ...boxOfNumber, default: { value: 0 } });
    expect(generic.capture).toEqual({
      anyOf: [
        {
          ...boxOfNumber,
          properties: { value: { type: "number", enum: [0] } },
        },
        boxOfNumber,
      ],
      default: { value: 0 },
    });
  });

  it("emits a generic declaration's property through a non-generic input", async () => {
    const counter = {
      type: "object",
      properties: { count: { type: "number", default: 0 } },
      required: ["count"],
    };
    const { input, capture } = await bindingSchemasOf(
      "interface Counter<T> { count: T | Default<0>; }",
      "{ c: Counter<number> }",
      false,
    );
    expect({ input, capture }).toEqual({ input: counter, capture: counter });
  });

  it("keeps a valid full object default when a capture observes only an optional field", async () => {
    const output = await transformSource(
      `${IMPORTS}
interface Target { name: string; unused?: number; }
interface Input<T> { c: Writable<T | Default<{ name: "" }>>; }
export default pattern<Input<Target>>(({ c }) => ({
  unused: computed(() => c.get().unused),
}));`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    const { input } = patternSchemas(root);
    const [capture] = callSchemas(root, "lift");
    expect((input.properties as Schema).c).toMatchObject({
      $ref: "#/$defs/Target",
      default: { name: "" },
    });
    expect((input.$defs as Schema).Target).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    expect((capture!.properties as Schema).c).toMatchObject({
      properties: { unused: { type: "number" } },
      default: { name: "" },
      asCell: ["readonly"],
    });
  });
});
