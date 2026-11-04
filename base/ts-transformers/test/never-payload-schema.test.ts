import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { SchemaScope } from "@commonfabric/api";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("never-payload-schema", () => {
  // A scope wrapper or a CFC policy around `never` is `never & brand` or
  // `never & carrier`, which the checker reduces to `never`, the type of the
  // payload too. Each module is compiled against the production
  // `commonfabric` types, by one generator per program.

  const WRAPPER_FOR_SCOPE = {
    space: "PerSpace",
    user: "PerUser",
    session: "PerSession",
    any: "PerAny",
  } as const satisfies Record<SchemaScope, string>;

  /** The schemas `toSchema<T>()` emits for each of `types`, in order. */
  async function toSchemas(types: readonly string[]): Promise<unknown[]> {
    const source = [
      `import { toSchema, type Cell, type Confidential, type Integrity, type PerAny, type PerSession, type PerSpace, type PerUser } from "commonfabric";`,
      `type Sec<T> = Confidential<T, ["a"]>;`,
      ...types.map((type, index) =>
        `export const schema${index} = toSchema<${type}>();`
      ),
    ].join("\n");
    const output = await transformSource(source, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
    });
    return emittedSchemas(parseModule(output));
  }

  for (const [scope, wrapper] of Object.entries(WRAPPER_FOR_SCOPE)) {
    it(`emits \`{ not: true, scope: "${scope}" }\` for \`${wrapper}<never>\` at the root and as a property`, async () => {
      expect(
        await toSchemas([
          `${wrapper}<never>`,
          `{ x: ${wrapper}<never> }`,
          `{ x: ${wrapper}<string> }`,
        ]),
      ).toEqual([
        { not: true, scope },
        {
          type: "object",
          properties: { x: { not: true, scope } },
          required: ["x"],
        },
        {
          type: "object",
          properties: { x: { type: "string", scope } },
          required: ["x"],
        },
      ]);
    });
  }

  it("emits each property's own scope for two scopes around `never`", async () => {
    expect(
      await toSchemas([`{ x: PerSpace<never>; y: PerSession<never> }`]),
    ).toEqual([{
      type: "object",
      properties: {
        x: { not: true, scope: "space" },
        y: { not: true, scope: "session" },
      },
      required: ["x", "y"],
    }]);
  });

  it("emits `{ not: true, ifc }` for a policy around `never`, written directly or through an alias", async () => {
    const confidential = { not: true, ifc: { confidentiality: ["a"] } };
    expect(
      await toSchemas([
        `{ x: Confidential<never, ["a"]> }`,
        `{ x: Confidential<string & number, ["a"]> }`,
        `{ x: Integrity<never, ["a"]> }`,
        `{ x: Sec<never> }`,
      ]),
    ).toEqual([
      { type: "object", properties: { x: confidential }, required: ["x"] },
      { type: "object", properties: { x: confidential }, required: ["x"] },
      {
        type: "object",
        properties: { x: { not: true, ifc: { integrity: ["a"] } } },
        required: ["x"],
      },
      { type: "object", properties: { x: confidential }, required: ["x"] },
    ]);
  });

  it("emits the scope and the labels for a scope wrapper and a policy around `never`, nested either way", async () => {
    const both = {
      not: true,
      scope: "user",
      ifc: { confidentiality: ["a"] },
    };
    expect(
      await toSchemas([
        `{ x: PerUser<Confidential<never, ["a"]>> }`,
        `{ x: Confidential<PerUser<never>, ["a"]> }`,
      ]),
    ).toEqual([
      { type: "object", properties: { x: both }, required: ["x"] },
      { type: "object", properties: { x: both }, required: ["x"] },
    ]);
  });

  it("emits `false` for `never` in a schema after one holding `PerUser<never>`", async () => {
    // A definition named for the wrapper's recursion would be kept for every
    // later `never` in the program, and referred to from schemas that do not
    // hold it.
    expect(
      await toSchemas([
        `PerUser<never>`,
        `{ x: never; c: Cell<never> }`,
      ]),
    ).toEqual([
      { not: true, scope: "user" },
      {
        type: "object",
        properties: { x: false, c: { asCell: ["cell"], not: true } },
        required: ["x", "c"],
      },
    ]);
  });
});
