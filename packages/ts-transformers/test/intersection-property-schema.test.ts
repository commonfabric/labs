import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

/** The schemas the transformed module of `source` emits, its input type-checked. */
const schemasOf = async (
  source: string,
): Promise<Record<string, unknown>[]> =>
  emittedSchemas(
    parseModule(
      (await transformFiles({ "/main.tsx": source }, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      }))["/main.tsx"]!,
    ),
  );

/** The schema `schema` gives its property `a`. */
const propertyA = (schema: Record<string, unknown> | undefined): unknown =>
  (schema?.properties as Record<string, unknown> | undefined)?.a;

/** `anyOf` arms in one order, so two spellings of one union compare equal. */
const sortedArms = (schema: unknown): unknown[] =>
  [...((schema as { anyOf?: unknown[] }).anyOf ?? [])].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );

const SAVE = `
const save = handler<{ name: string }, { name: Writable<string> }>(
  (event, { name }) => { name.set(event.name); },
);
type Labeled = Confidential<
  WriteAuthorizedBy<{ x: string }, typeof save>,
  readonly ["secret"]
>;`;

describe("intersection-property-schema", () => {
  for (
    const [holder, labeled, other, valueOf] of [
      [
        "the values of a record",
        "Record<string, Labeled>",
        "Record<string, { x: string; y: number }>",
        (a: Record<string, unknown>) => a.additionalProperties,
      ],
      [
        "the elements of an array",
        "Labeled[]",
        "{ x: string; y: number }[]",
        (a: Record<string, unknown>) => a.items,
      ],
    ] as const
  ) {
    it(`keeps a writer and the confidentiality beside it on ${holder} several members declare`, async () => {
      // The type the checker gives the property names no writer, so the
      // property is settled from the schemas its declarations give it.

      // The handler's own schemas come first.
      const schema = (await schemasOf(`
        import { handler, toSchema, Writable } from "commonfabric";
        import type { Confidential, WriteAuthorizedBy } from "commonfabric";
        ${SAVE}
        export const schema = toSchema<
          { a: ${labeled} } & { a: ${other} }
        >();
      `)).find((emitted) => propertyA(emitted) !== undefined);

      const value = valueOf(propertyA(schema) as Record<string, unknown>) as {
        properties: Record<string, { ifc?: Record<string, unknown> }>;
      };
      expect(value.properties.x!.ifc?.confidentiality).toEqual(["secret"]);
      expect(value.properties.x!.ifc?.writeAuthorizedBy).toBeDefined();
      expect(value.properties.y).toEqual({ type: "number" });
    });
  }

  it("keeps both arms of a union of records on different keys beside a record, in either order", async () => {
    // `Record<string, string>` and `Record<number, string>` emit equal
    // schemas, so the union folds; the fold is recorded, and the intersection
    // reads each arm.

    const [stringFirst, numberFirst] = await schemasOf(`
      import { toSchema } from "commonfabric";
      import type { Integrity } from "commonfabric";
      export const stringFirst = toSchema<
        & { a: Record<string, unknown> }
        & {
          a: Integrity<
            Record<string, string> | Record<number, string>,
            readonly ["verified"]
          >;
        }
      >();
      export const numberFirst = toSchema<
        & { a: Record<string, unknown> }
        & {
          a: Integrity<
            Record<number, string> | Record<string, string>,
            readonly ["verified"]
          >;
        }
      >();
    `);

    const arms = [
      {
        type: "object",
        additionalProperties: true,
        $comment:
          "Unsupported intersection pattern: index signatures on different keys",
      },
      {
        type: "object",
        properties: {},
        additionalProperties: { type: "string" },
        ifc: { integrity: ["verified"] },
      },
    ];
    expect(sortedArms(propertyA(stringFirst))).toEqual(sortedArms({
      anyOf: arms,
    }));
    expect(sortedArms(propertyA(numberFirst))).toEqual(sortedArms({
      anyOf: arms,
    }));
  });

  for (
    const [beside, other] of [
      ["`undefined`", "undefined"],
      ["another record", "Record<string, number>"],
    ] as const
  ) {
    it(`keeps the labeled arm of a folded union nested beside ${beside}, as its alias does`, async () => {
      // The folded union is an arm of another union, whose arms are read
      // through to the ones the fold recorded.

      const type = `
        & { a: Record<string, unknown> }
        & {
          a:
            | Integrity<
              Record<string, string> | Record<number, string>,
              readonly ["v"]
            >
            | ${other};
        }`;
      const [direct, alias] = await schemasOf(`
        import { toSchema } from "commonfabric";
        import type { Integrity } from "commonfabric";
        export const direct = toSchema<${type}>();
        type Result = ${type};
        export const alias = toSchema<Result>();
      `);

      expect(sortedArms(propertyA(direct))).toEqual(
        sortedArms(propertyA(alias)),
      );
      expect(sortedArms(propertyA(direct))).toContainEqual({
        type: "object",
        properties: {},
        additionalProperties: { type: "string" },
        ifc: { integrity: ["v"] },
      });
    });
  }

  it("returns the fallback for a scoped record on numeric keys beside one on every key", async () => {
    const [schema] = await schemasOf(`
      import { toSchema, type PerUser } from "commonfabric";
      export const schema = toSchema<
        & { a: Record<string, unknown> }
        & { a: PerUser<Record<number, string>> }
      >();
    `);

    expect(propertyA(schema)).toEqual({
      type: "object",
      additionalProperties: true,
      $comment:
        "Unsupported intersection pattern: index signatures on different keys",
      scope: "user",
    });
  });

  it("keeps a member's labels on the fallback for constituents that cannot be merged", async () => {
    const [schema] = await schemasOf(`
      import { toSchema } from "commonfabric";
      import type { Confidential } from "commonfabric";
      export const schema = toSchema<{
        a: { x: Confidential<string, ["secret"]> } & string[];
      }>();
    `);

    expect(propertyA(schema)).toEqual({
      type: "object",
      additionalProperties: true,
      $comment:
        "Unsupported intersection pattern: index signature on constituent",
      ifc: { confidentiality: ["secret"] },
    });
  });

  it("keeps the label beside a reference to a recursive fallback an alias names", async () => {
    const [schema] = await schemasOf(`
      import { toSchema } from "commonfabric";
      import type { Confidential } from "commonfabric";
      type Child = Node & string[];
      interface Node {
        secret: Confidential<string, ["s"]>;
        child?: Confidential<Child, ["s"]>;
      }
      export const schema = toSchema<{ a: Node }>();
    `);
    const definitions = schema?.$defs as Record<
      string,
      { properties?: Record<string, unknown> }
    >;

    expect(definitions.Node?.properties?.child).toEqual({
      $ref: "#/$defs/Child",
      ifc: { confidentiality: ["s"] },
    });
    expect(definitions.Child).toEqual({
      type: "object",
      additionalProperties: true,
      $comment:
        "Unsupported intersection pattern: index signature on constituent",
    });
  });
});
