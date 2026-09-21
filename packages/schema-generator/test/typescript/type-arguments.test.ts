import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

// A local replica of `Default`, as the formatters recognize it by name.
const PRELUDE = `
  declare const DEFAULT_MARKER: unique symbol;
  type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
  type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
  interface Box<T> { value: T; }
`;

/** The schema generated for the type alias `Root` declared in `code`. */
async function schemaOfRoot(code: string) {
  const { type, checker, typeNode } = await getTypeFromCode(
    PRELUDE + code,
    "Root",
  );
  return asObjectSchema(
    new SchemaGenerator().generateSchema(type, checker, typeNode),
  );
}

/** The schema of property `c` of the type alias `Root` declared in `code`. */
async function schemaOfC(code: string): Promise<unknown> {
  return (await schemaOfRoot(code)).properties?.c;
}

/** `type` with every `T` in it replaced by `argument`. */
function inPlace(type: string, argument: string): string {
  return type.replace(/\bT\b/g, argument);
}

const boxOfNumber = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
};

describe("type-arguments", () => {
  describe("a property declared in a generic interface", () => {
    // Each property is read for an instantiation of its interface, and its
    // schema is the one the property gets with the argument written in place.

    for (
      const [declared, argument, schema] of [
        [
          `T | string | Default<string, "">`,
          "number",
          { type: ["number", "string"], default: "" },
        ],
        ["T | Default<0>", "number", { type: "number", default: 0 }],
        [
          "Writable<T | Default<0>>",
          "number",
          { type: "number", default: 0, asCell: ["cell"] },
        ],
        ["PerUser<T>", "string", { type: "string", scope: "user" }],
        [
          `PerUser<T | Default<"">>`,
          "string",
          { type: "string", default: "", scope: "user" },
        ],
        [
          "T[] | Default<[]>",
          "number",
          { type: "array", items: { type: "number" }, default: [] },
        ],
        [
          "Writable<T[] | Default<[]>>",
          "Box<number>",
          { type: "array", items: boxOfNumber, default: [], asCell: ["cell"] },
        ],
        [
          "Box<T> | Default<{ value: 0 }>",
          "number",
          { ...boxOfNumber, default: { value: 0 } },
        ],
      ] as const
    ) {
      it(`returns the schema of \`${declared}\` with \`T\` as \`${argument}\` written in place`, async () => {
        const instantiated = await schemaOfC(
          `interface Input<T> { c: ${declared}; } type Root = Input<${argument}>;`,
        );
        const written = await schemaOfC(
          `interface Input { c: ${
            inPlace(declared, argument)
          }; } type Root = Input;`,
        );
        expect({ instantiated, written }).toEqual({
          instantiated: schema,
          written: schema,
        });
      });
    }

    it("matches a member naming a generic declaration to its own instantiation among others of that declaration", async () => {
      // Matched to `Box<string>`, `Box<T>` would not cover the default, and the
      // object default would throw.

      const declared = "Box<T> | Box<string> | Default<{ value: 0 }>";
      const instantiated = await schemaOfC(
        `interface Input<T> { c: ${declared}; } type Root = Input<number>;`,
      );
      const written = await schemaOfC(
        `interface Input { c: ${
          inPlace(declared, "number")
        }; } type Root = Input;`,
      );
      expect({ instantiated, written }).toEqual({
        instantiated: written,
        written: {
          anyOf: [
            boxOfNumber,
            {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          ],
          default: { value: 0 },
        },
      });
    });

    it("throws for an object default the argument does not cover, as the property written in place does", async () => {
      const message = "Default object union member is not assignable";
      await expect(
        schemaOfC(
          "interface Input<T> { c: T | Default<{}>; } type Root = Input<Box<number>>;",
        ),
      ).rejects.toThrow(message);
      await expect(
        schemaOfC(
          "interface Input { c: Box<number> | Default<{}>; } type Root = Input;",
        ),
      ).rejects.toThrow(message);
    });
  });

  describe("the declaration a property is read from", () => {
    const schema = { type: ["number", "string"], default: "" };
    const declared = `T | string | Default<string, "">`;

    it("reads a property of a generic type alias for its instantiation", async () => {
      const root = await schemaOfRoot(
        `type Input<T> = { c: ${declared} }; type Root = { i: Input<number> };`,
      );
      expect(root.properties?.i).toEqual({
        type: "object",
        properties: { c: schema },
        required: ["c"],
      });
    });

    it("reads a property inherited from a generic base for the instantiation of the interface that extends it", async () => {
      const c = await schemaOfC(
        `interface Base<U> { c: ${
          declared.replace("T", "U")
        }; } interface Input<T> extends Base<T> {} type Root = Input<number>;`,
      );
      expect(c).toEqual(schema);
    });

    it("reads a property inherited from a generic base by a non-generic interface", async () => {
      const root = await schemaOfRoot(
        `interface Base<U> { c: ${
          declared.replace("T", "U")
        }; } interface Concrete extends Base<number> {} type Root = { r: Concrete };`,
      );
      expect(root.$defs?.Concrete).toEqual({
        type: "object",
        properties: { c: schema },
        required: ["c"],
      });
    });

    it("reads a property of an instantiation nested in a non-generic object", async () => {
      const root = await schemaOfRoot(
        `interface Input<T> { c: ${declared}; } type Root = { i: Input<number> };`,
      );
      expect(root.properties?.i).toEqual({
        type: "object",
        properties: { c: schema },
        required: ["c"],
      });
    });

    it("reads a property of a mapped type over an instantiation with the declaration's own parameter", async () => {
      // `Readonly` binds its own parameter to `Input<number>`, and nothing binds
      // `Input`'s, so `T` formats as an unbound parameter does.

      const c = await schemaOfC(
        `interface Input<T> { c: ${declared}; } type Root = Readonly<Input<number>>;`,
      );
      expect(c).toEqual({ type: ["string"], default: "" });
    });

    it("reads each instantiation of one declaration with its own argument", async () => {
      // `next` instantiates the declaration that holds it, so its `c` is read
      // with `T` as `boolean` within the reading of a `c` with `T` as
      // `number`. `next` refers to itself as well, so it is emitted as a
      // reference to a definition.

      const root = await schemaOfRoot(
        `interface Input<T> { c: ${declared}; next?: Input<boolean>; }
         type Root = Input<number>;`,
      );
      const { $ref } = root.properties?.next as { $ref: string };
      const next = asObjectSchema(
        root.$defs?.[$ref.replace("#/$defs/", "")] ?? {},
      );
      expect({ c: root.properties?.c, nextC: next.properties?.c }).toEqual({
        c: schema,
        nextC: { type: ["boolean", "string"], default: "" },
      });
    });
  });
});
