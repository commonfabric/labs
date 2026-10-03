/**
 * Exercises writer identity through generic declarations in both schemas of
 * the full, type-checked pattern compiler.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

/** Resolves local references and the non-nullish arm of an optional value. */
function valueSchema(
  schema: JSONSchema | undefined,
  root: JSONSchemaObj,
): JSONSchemaObj {
  expect(schema).toBeDefined();
  expect(typeof schema).toBe("object");
  const object = schema as JSONSchemaObj;
  if (object.$ref) {
    const { $ref, ...rest } = object;
    return {
      ...valueSchema(root.$defs?.[$ref.split("/").pop()!], root),
      ...rest,
    };
  }
  if (object.anyOf) {
    const value = object.anyOf.filter((arm) =>
      typeof arm === "object" && arm.type !== "undefined" && arm.type !== "null"
    );
    expect(value).toHaveLength(1);
    return valueSchema(value[0], root);
  }
  return object;
}

describe("generic writer policy", () => {
  for (const position of ["input", "output"] as const) {
    it(`keeps a named writer policy under Readonly in the ${position} schema`, async () => {
      const output = await transformSource(
        `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
type Protected = WriteAuthorizedBy<{ value: string }, typeof f>;
type Payload = Readonly<Protected>;
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      expect(valueSchema(schema, schema)).toMatchObject({
        type: "object",
        properties: { value: { type: "string" } },
        ifc: { writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["f"] } } },
      });
    });

    it(`matches Partial of a value query and its declared shape in the ${position} schema`, async () => {
      const output = await transformSource(
        `import { pattern } from "commonfabric";
interface Shape { text: string; value: number; child: { n: number }; values: number[] }
declare const x: Shape;
type Payload = { queried: Partial<typeof x>; declared: Partial<Shape> };
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      const root = valueSchema(schema, schema);
      expect(valueSchema(root.properties?.queried, schema)).toEqual(
        valueSchema(root.properties?.declared, schema),
      );
    });

    it(`matches Partial of an ordinary Owned alias and its declared shape in the ${position} schema`, async () => {
      const output = await transformSource(
        `import { pattern } from "commonfabric";
interface Shape { text: string; value: number; child: { n: number }; values: number[] }
declare const x: Shape;
type Owned<T, Binding> = T;
type Payload = { named: Partial<Owned<Shape, typeof x>>; declared: Partial<Shape> };
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      const root = valueSchema(schema, schema);
      expect(valueSchema(root.properties?.named, schema)).toEqual(
        valueSchema(root.properties?.declared, schema),
      );
    });

    it(`keeps nongeneric aliases of different instantiations distinct in the ${position} schema`, async () => {
      const output = await transformSource(
        `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
const g = handler<void, {}>(() => {});
interface Box<T> { value: T }
type F = Box<WriteAuthorizedBy<string, typeof f>>;
type G = Box<WriteAuthorizedBy<string, typeof g>>;
interface Payload { a: F; b: G }
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      const root = valueSchema(schema, schema);
      for (const [field, writer] of [["a", "f"], ["b", "g"]]) {
        const box = valueSchema(root.properties?.[field!], schema);
        expect(
          valueSchema(box.properties?.value, schema).ifc?.writeAuthorizedBy,
        ).toEqual({
          __ctWriterIdentityOf: { file: "/test.tsx", path: [writer] },
        });
      }
    });

    it(`names a recursive generic root at its first reading in the ${position} schema`, async () => {
      const output = await transformSource(
        `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
interface Node<T> { value: T; next?: Node<T> }
type Payload = Node<WriteAuthorizedBy<string, typeof f>>;
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      expect(schema.$ref).toBeDefined();
      const root = valueSchema(schema, schema);
      const next = root.properties?.next as JSONSchemaObj;
      expect(next.anyOf).toContainEqual({ $ref: schema.$ref });
    });

    for (
      const [name, declaration] of [
        [
          "a nested literal",
          "interface Box<T> { inner: { value: T; n: number } }",
        ],
        [
          "a nested union",
          "interface Box<T> { inner: { value: T; n: number } | { other: string } }",
        ],
        ["an intersection", "type Box<T> = { value: T } & { n: number };"],
        [
          "an array element",
          "interface Box<T> { list: Array<{ value: T; n: number }> }",
        ],
        [
          "an optional nested member",
          "interface Box<T> { inner?: { value?: T; n: number } }",
        ],
      ] as const
    ) {
      it(`keeps callable member schemas through ${name} in the ${position} schema`, async () => {
        const diagnostics: TransformationDiagnostic[] = [];
        const output = await transformSource(
          `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
const plainFn = () => 1;
const subPattern = pattern(() => ({}));
${declaration}
interface Guarded<H> { inner: { action: H; value: WriteAuthorizedBy<string, H> } }
type Payload = {
  handler: Box<typeof f>;
  plain: Box<typeof plainFn>;
  subPattern: Box<typeof subPattern>;
  guarded: Guarded<typeof f>;
};
export default ${
            position === "input"
              ? "pattern<Payload>(() => ({}))"
              : "pattern<{}, Payload>(() => ({} as Payload))"
          };`,
          {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          },
        );
        expect(diagnostics.filter((item) => item.severity === "error")).toEqual(
          [],
        );
        const schemas = callSchemas(parseModule(output), "pattern");
        expect(schemas).toHaveLength(2);
        const schema = schemas[position === "input" ? 0 : 1] as JSONSchemaObj;
        const root = valueSchema(schema, schema);
        for (const key of ["handler", "plain", "subPattern"]) {
          let leaf = valueSchema(root.properties?.[key], schema);
          if (name === "an array element") {
            leaf = valueSchema(
              valueSchema(leaf.properties?.list, schema).items,
              schema,
            );
          } else if (name === "a nested union") {
            const union = leaf.properties?.inner as JSONSchemaObj;
            expect(union.anyOf).toHaveLength(2);
            const arms = union.anyOf!.map((arm) => valueSchema(arm, schema));
            expect(arms.filter((arm) => arm.properties?.other)).toEqual([
              {
                type: "object",
                properties: { other: { type: "string" } },
                required: ["other"],
              },
            ]);
            leaf = arms.find((arm) => arm.properties?.n)!;
            expect(leaf).toBeDefined();
          } else if (name !== "an intersection") {
            if (name === "an optional nested member") {
              expect(leaf.required ?? []).not.toContain("inner");
            }
            leaf = valueSchema(leaf.properties?.inner, schema);
          }
          expect(leaf.properties).toEqual(
            key === "handler"
              ? { value: { asCell: ["stream"] }, n: { type: "number" } }
              : { n: { type: "number" } },
          );
          const required =
            key === "handler" && name !== "an optional nested member"
              ? ["value", "n"]
              : ["n"];
          expect(leaf.required).toHaveLength(required.length);
          expect(leaf.required).toEqual(expect.arrayContaining(required));
        }
        const guarded = valueSchema(root.properties?.guarded, schema);
        const inner = valueSchema(guarded.properties?.inner, schema);
        expect(inner.properties?.action).toEqual({ asCell: ["stream"] });
        expect(valueSchema(inner.properties?.value, schema)).toMatchObject({
          type: "string",
          ifc: { writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["f"] } } },
        });
        expect(inner.required).toHaveLength(2);
        expect(inner.required).toEqual(
          expect.arrayContaining(["action", "value"]),
        );
      });
    }

    for (
      const [name, declaration] of [
        ["an interface", "interface Box<T> { value: T; n: number }"],
        ["an object alias", "type Box<T> = { value: T; n: number };"],
      ] as const
    ) {
      it(`keeps callable member schemas through ${name} in the ${position} schema`, async () => {
        const diagnostics: TransformationDiagnostic[] = [];
        const output = await transformSource(
          `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
const plainFn = () => 1;
const subPattern = pattern(() => ({}));
type H = typeof f;
${declaration}
type Guarded<H> = { action: H; value: WriteAuthorizedBy<string, H> };
type Payload = {
  handler: Box<typeof f>;
  aliasedHandler: Box<H>;
  plain: Box<typeof plainFn>;
  subPattern: Box<typeof subPattern>;
  guarded: Guarded<typeof f>;
};
export default ${
            position === "input"
              ? "pattern<Payload>(() => ({}))"
              : "pattern<{}, Payload>(() => ({} as Payload))"
          };`,
          {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          },
        );
        expect(diagnostics.filter((item) => item.severity === "error")).toEqual(
          [],
        );
        const schemas = callSchemas(parseModule(output), "pattern");
        expect(schemas).toHaveLength(2);
        const schema = schemas[position === "input" ? 0 : 1] as JSONSchemaObj;
        const root = valueSchema(schema, schema);
        for (const name of ["handler", "aliasedHandler"]) {
          const member = valueSchema(root.properties?.[name], schema);
          expect(member.properties).toEqual({
            value: { asCell: ["stream"] },
            n: { type: "number" },
          });
          expect(member.required).toHaveLength(2);
          expect(member.required).toEqual(
            expect.arrayContaining(["value", "n"]),
          );
        }
        for (const name of ["plain", "subPattern"]) {
          const member = valueSchema(root.properties?.[name], schema);
          expect(member.properties).toEqual({ n: { type: "number" } });
          expect(member.required).toEqual(["n"]);
        }
        const guarded = valueSchema(root.properties?.guarded, schema);
        expect(guarded.properties?.action).toEqual({ asCell: ["stream"] });
        expect(valueSchema(guarded.properties?.value, schema)).toMatchObject({
          type: "string",
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["f"] } },
          },
        });
        expect(guarded.required).toHaveLength(2);
        expect(guarded.required).toEqual(
          expect.arrayContaining(["action", "value"]),
        );
      });
    }

    it(`keeps collapsed writer alternatives through a generic member in the ${position} schema`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      const output = await transformSource(
        `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
const g: typeof f = handler<void, {}>(() => {});
interface Box<T> { value: T }
type Payload = Box<WriteAuthorizedBy<string, typeof f> | WriteAuthorizedBy<string, typeof g>>;
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      );
      expect(diagnostics.filter((item) => item.severity === "error")).toEqual(
        [],
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      const root = valueSchema(schema, schema);
      const value = root.properties?.value as JSONSchemaObj;
      expect(value.anyOf).toHaveLength(2);
      expect(
        value.anyOf?.map((branch) => {
          const alternative = valueSchema(branch, schema);
          expect(alternative.type).toBe("string");
          return alternative.ifc?.writeAuthorizedBy;
        }),
      ).toEqual([
        { __ctWriterIdentityOf: expect.objectContaining({ path: ["f"] }) },
        { __ctWriterIdentityOf: expect.objectContaining({ path: ["g"] }) },
      ]);
    });

    for (
      const [name, declarations, spelling, field] of [
        ["a direct member", "", "{ value: POLICY }", "value"],
        ["an array", "", "Array<POLICY>", "items"],
        ["a declared tuple", "", "[POLICY]", "items"],
        [
          "a declared index signature",
          "",
          "{ [key: string]: POLICY }",
          "additionalProperties",
        ],
        [
          "an array alias body",
          "type Box<T> = Array<T>;",
          "Box<POLICY>",
          "items",
        ],
        [
          "a readonly array alias body",
          "type Box<T> = ReadonlyArray<T>;",
          "Box<POLICY>",
          "items",
        ],
        [
          "a record alias body",
          "type Box<T> = Record<string, T>;",
          "Box<POLICY>",
          "additionalProperties",
        ],
        ["a tuple alias body", "type Box<T> = [T];", "Box<POLICY>", "items"],
        [
          "a nullable alias body",
          "type Box<T> = T | null;",
          "{ value: Box<POLICY> }",
          "value",
        ],
        [
          "a class",
          "class Box<T> { declare value: T }",
          "Box<POLICY>",
          "value",
        ],
        [
          "an inherited class member",
          "class Base<T> { declare value: T } class Box<T> extends Base<T> {}",
          "Box<POLICY>",
          "value",
        ],
        [
          "a named readonly policy",
          "type Protected<W> = { value: WriteAuthorizedBy<string, W> };",
          "Readonly<Protected<WRITER>>",
          "value",
        ],
        [
          "an interface",
          "interface Box<W> { value: W }",
          "Box<POLICY>",
          "value",
        ],
        [
          "an object alias",
          "type Box<W> = { value: W };",
          "Box<POLICY>",
          "value",
        ],
        ["a record", "", "Record<string, POLICY>", "additionalProperties"],
        [
          "a named policy in a record",
          "type Protected<W> = WriteAuthorizedBy<string, W>;",
          "Record<string, Protected<WRITER>>",
          "additionalProperties",
        ],
        [
          "an index signature",
          "interface Box<W> { [key: string]: W }",
          "Box<POLICY>",
          "additionalProperties",
        ],
        [
          "a forwarded alias",
          "interface Box<W> { value: W } type Forward<W> = Box<W>;",
          "Forward<POLICY>",
          "value",
        ],
        [
          "an inherited member",
          "interface Base<V> { value: V } interface Box<W> extends Base<W> {}",
          "Box<POLICY>",
          "value",
        ],
        [
          "an indexed payload with a readable writer",
          'interface Box<T extends { v: string }, W> { value: WriteAuthorizedBy<T["v"], W> }',
          "Box<{ v: string }, WRITER>",
          "value",
        ],
        [
          "a CFC alias",
          'type Box<W> = Confidential<{ value: W }, readonly ["a"]>;',
          "Box<POLICY>",
          "value",
        ],
        [
          "a recursive interface payload",
          'type Identity<X> = X; interface Node<W> { value: W; next?: Sec<Identity<W>> } type Sec<W> = Confidential<Node<W>, readonly ["a"]>;',
          "Sec<POLICY>",
          "value",
        ],
        [
          "a recursive type-literal payload",
          'type Identity<X> = X; type Sec<W> = Confidential<{ value: W; next?: Sec<Identity<W>> }, readonly ["a"]>;',
          "Sec<POLICY>",
          "value",
        ],
      ] as const
    ) {
      it(`keeps distinct writers through ${name} in the pattern's ${position} schema`, async () => {
        const diagnostics: TransformationDiagnostic[] = [];
        const source =
          `import { Confidential, handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
const g: typeof f = handler<void, {}>(() => {});
${declarations}
type Payload = {
  a: ${
            spelling.replace("POLICY", "WriteAuthorizedBy<string, typeof f>")
              .replace("WRITER", "typeof f")
          };
  b: ${
            spelling.replace("POLICY", "WriteAuthorizedBy<string, typeof g>")
              .replace("WRITER", "typeof g")
          };
};
export default ${
            position === "input"
              ? "pattern<Payload>(() => ({}))"
              : "pattern<{}, Payload>(() => ({} as Payload))"
          };`;
        const output = await transformSource(source, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        });
        expect(diagnostics.filter((item) => item.severity === "error")).toEqual(
          [],
        );
        const schema = patternSchemas(
          parseModule(output),
        )[position] as JSONSchemaObj;
        const root = valueSchema(schema, schema);
        for (const [key, writer] of [["a", "f"], ["b", "g"]] as const) {
          let container = valueSchema(root.properties?.[key], schema);
          const depth = name.startsWith("a recursive") ? 4 : 1;
          for (let level = 0; level < depth; level++) {
            const target = field === "items"
              ? container.items
              : field === "additionalProperties"
              ? container.additionalProperties
              : container.properties?.[field];
            expect(valueSchema(target as JSONSchema, schema)).toMatchObject({
              type: "string",
              ifc: {
                writeAuthorizedBy: { __ctWriterIdentityOf: { path: [writer] } },
              },
            });
            if (level + 1 < depth) {
              container = valueSchema(container.properties?.next, schema);
            }
          }
        }
      });
    }

    it(`forwards and reverses same-typed writers through a plain alias in the ${position} schema`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      const source =
        `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
const g: typeof f = handler<void, {}>(() => {});
type Pair<A, B> = { left: WriteAuthorizedBy<string, A>; right: WriteAuthorizedBy<string, B> };
type Payload = { a: Pair<typeof f, typeof g>; b: Pair<typeof g, typeof f> };
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`;
      const output = await transformSource(source, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      });
      expect(diagnostics.filter((item) => item.severity === "error")).toEqual(
        [],
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      const root = valueSchema(schema, schema);
      for (
        const [key, left, right] of [["a", "f", "g"], ["b", "g", "f"]] as const
      ) {
        const pair = valueSchema(root.properties?.[key], schema);
        for (const [field, writer] of [["left", left], ["right", right]]) {
          expect(valueSchema(pair.properties?.[field!], schema)).toMatchObject({
            ifc: {
              writeAuthorizedBy: { __ctWriterIdentityOf: { path: [writer] } },
            },
          });
        }
      }
    });

    it(`reads writer defaults under preceding parameters in the ${position} schema`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      const output = await transformSource(
        `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
const g: typeof f = handler<void, {}>(() => {});
interface Box<T, W = WriteAuthorizedBy<T, typeof f>> { value: W }
type Payload = { a: Box<string>; b: Box<string, WriteAuthorizedBy<string, typeof g>> };
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      );
      expect(diagnostics.filter((item) => item.severity === "error")).toEqual(
        [],
      );
      const schema = patternSchemas(
        parseModule(output),
      )[position] as JSONSchemaObj;
      const root = valueSchema(schema, schema);
      for (const [key, writer] of [["a", "f"], ["b", "g"]] as const) {
        const box = valueSchema(root.properties?.[key], schema);
        expect(valueSchema(box.properties?.value, schema)).toMatchObject({
          type: "string",
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: { path: [writer] } },
          },
        });
      }
    });

    it(`refuses an unread authored writer through a plain generic in the ${position} schema`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      await transformSource(
        `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
type Indirect = typeof f;
interface Box<W> { value: W }
type Payload = { a: Box<WriteAuthorizedBy<string, Indirect>> };
export default ${
          position === "input"
            ? "pattern<Payload>(() => ({}))"
            : "pattern<{}, Payload>(() => ({} as Payload))"
        };`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      );
      expect(diagnostics).toContainEqual(expect.objectContaining({
        severity: "error",
        type: "cfc-write-authorized-by:unread",
      }));
    });

    for (
      const [name, declaration, argument] of [
        [
          "indexed access",
          'interface Box<W extends { v: unknown }> { value: W["v"] }',
          "{ v: WriteAuthorizedBy<string, typeof f> }",
        ],
        [
          "a conditional",
          "interface Box<W> { value: W extends string ? W : never }",
          "WriteAuthorizedBy<string, typeof f>",
        ],
        [
          "an indexed index-signature value",
          'interface Box<W extends { v: unknown }> { [key: string]: W["v"] }',
          "{ v: WriteAuthorizedBy<string, typeof f> }",
        ],
      ] as const
    ) {
      it(`refuses a writer whose syntax ${name} discards in the ${position} schema, including stored source`, async () => {
        for (const storedSource of [false, true]) {
          const diagnostics: TransformationDiagnostic[] = [];
          await transformSource(
            `import { handler, pattern, WriteAuthorizedBy } from "commonfabric";
const f = handler<void, {}>(() => {});
${declaration}
type Payload = { a: Box<${argument}> };
export default ${
              position === "input"
                ? "pattern<Payload>(() => ({}))"
                : "pattern<{}, Payload>(() => ({} as Payload))"
            };`,
            {
              types: COMMONFABRIC_TYPES,
              typeCheck: true,
              pipelineDiagnostics: diagnostics,
              storedSource,
            },
          );
          expect(diagnostics).toContainEqual(expect.objectContaining({
            severity: "error",
            type: "cfc-write-authorized-by:unread",
            message: expect.stringContaining("operator syntax"),
          }));
        }
      });
    }
  }
});
