import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";

import type { SchemaGenerationDiagnostic } from "../../src/interface.ts";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

const ALIASES = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
  type Confidential<T, L extends readonly unknown[]> =
    Cfc<T, { confidentiality: L }>;
  type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
  type Identity<X> = X;
  type Fn = () => void;
  declare const f: Fn;
  declare const g: Fn;
`;

/** Generates the schema and diagnostics of the fixture's root interface. */
async function generate(code: string) {
  const { type, checker } = await getTypeFromCode(ALIASES + code, "Holder");
  const diagnostics: SchemaGenerationDiagnostic[] = [];
  const schema = asObjectSchema(
    new SchemaGenerator().generateSchema(type, checker, undefined, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      writerIdentityForSourceFile: (file) => ({ file }),
    }),
  );
  return { schema, diagnostics };
}

/** Each recursive value, through references, requiring the chain to settle. */
function* recursiveValues(
  schema: ReturnType<typeof asObjectSchema>,
  root: JSONSchema,
) {
  const resolve = (value: JSONSchema) => {
    const node = asObjectSchema(value);
    return typeof node.$ref === "string"
      ? asObjectSchema(schema.$defs![node.$ref.split("/").pop()!]!)
      : node;
  };
  let node = resolve(root);
  const visited = new Set<string>();

  for (;;) {
    yield resolve(node.properties!.value!);
    const next = asObjectSchema(node.properties!.next!);
    if (typeof next.$ref === "string") {
      if (visited.has(next.$ref)) break;
      visited.add(next.$ref);
    }
    node = resolve(next);
  }
  expect(visited.size).toBeGreaterThan(0);
}

describe("recursive binding identity", () => {
  it("keeps inherited, forwarded, and defaulted writers distinct through plain generics", async () => {
    const { schema, diagnostics } = await generate(`
      interface Base<A, B> {
        left: WriteAuthorizedBy<string, A>;
        right: WriteAuthorizedBy<string, B>;
      }
      interface Derived<A, B = A> extends Base<A, B> {}
      type Forward<X, Y = X> = Derived<X, Y>;
      interface Holder {
        original: Forward<typeof f, typeof g>;
        reversed: Forward<typeof g, typeof f>;
        defaulted: Forward<typeof f>;
      }
    `);

    for (
      const [field, left, right] of [
        ["original", "f", "g"],
        ["reversed", "g", "f"],
        ["defaulted", "f", "f"],
      ] as const
    ) {
      const members = asObjectSchema(schema.properties![field]!).properties!;
      for (
        const [member, writer] of [["left", left], ["right", right]] as const
      ) {
        expect(asObjectSchema(members[member]!).ifc?.writeAuthorizedBy)
          .toEqual({
            __ctWriterIdentityOf: { file: "test.ts", path: [writer] },
          });
      }
    }
    expect(diagnostics).toEqual([]);
  });

  it("keeps each named policy through Record and recursive interface payloads", async () => {
    const { schema, diagnostics } = await generate(`
      type F = WriteAuthorizedBy<string, typeof f>;
      type G = WriteAuthorizedBy<string, typeof g>;
      interface Node<W> { value: W; next?: Sec<Identity<W>> }
      type Sec<W> = Confidential<Node<W>, readonly ["a"]>;
      interface Holder {
        f: Sec<F>;
        g: Sec<G>;
        records: Record<string, F>;
      }
    `);

    for (const writer of ["f", "g"]) {
      for (
        const value of recursiveValues(schema, schema.properties![writer]!)
      ) {
        expect(value.ifc?.writeAuthorizedBy).toEqual({
          __ctWriterIdentityOf: { file: "test.ts", path: [writer] },
        });
      }
    }
    const record = asObjectSchema(schema.properties!.records!);
    const value = asObjectSchema(record.additionalProperties!);
    const resolved = typeof value.$ref === "string"
      ? asObjectSchema(schema.$defs![value.$ref.split("/").pop()!]!)
      : value;
    expect(resolved.ifc?.writeAuthorizedBy).toEqual({
      __ctWriterIdentityOf: { file: "test.ts", path: ["f"] },
    });
    expect(diagnostics).toEqual([]);
  });

  for (const member of ["[W][0]", "W extends unknown ? W : never"]) {
    it(`reports an unread writer when a generic member uses ${member}`, async () => {
      const { diagnostics } = await generate(`
        interface Box<W> { value: ${member} }
        interface Holder { a: Box<WriteAuthorizedBy<string, typeof f>> }
      `);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        type: "cfc-write-authorized-by:unread",
        severity: "error",
      });
      expect(diagnostics[0]!.message).toContain("operator syntax");
      expect(diagnostics[0]!.message).toContain("pass the policy unchanged");
    });
  }

  for (const order of [["x", "y"], ["y", "x"]]) {
    it(`rejects indirect writer bindings in recursive policies, reading ${order.join(" then ")}`, async () => {
      const { diagnostics } = await generate(`
        type Indirect = typeof f;
        type Pair<A, B> = Confidential<{
          left: WriteAuthorizedBy<string, A>;
          right: WriteAuthorizedBy<string, B>;
        }, readonly ["pair"]>;
        type Sec<W> = Confidential<{
          value: W;
          next?: Sec<Identity<W>>;
        }, readonly ["a"]>;
        interface Holder {
          ${
        order.map((field) =>
          `${field}: Sec<Pair<${
            field === "x" ? "typeof f, Indirect" : "Indirect, typeof f"
          }>>;`
        ).join("\n")
      }
        }
      `);

      expect(diagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of diagnostics) {
        expect(diagnostic).toMatchObject({
          type: "cfc-write-authorized-by:unread",
          severity: "error",
        });
      }
    });
  }

  for (const order of [["f", "g"], ["g", "f"]]) {
    for (
      const [spelling, declarations, argument] of [
        [
          "a written policy",
          "",
          (writer: string) => `WriteAuthorizedBy<string, typeof ${writer}>`,
        ],
        [
          "an alias with a writer argument",
          "type Owned<W> = WriteAuthorizedBy<string, W>;",
          (writer: string) => `Owned<typeof ${writer}>`,
        ],
        [
          "an alias whose writer defaults to its preceding argument",
          "type Owned<V, W = V> = WriteAuthorizedBy<string, W>;",
          (writer: string) => `Owned<typeof ${writer}>`,
        ],
        [
          "an alias with a fixed writer",
          `type F<T> = WriteAuthorizedBy<T, typeof f>;
           type G<T> = WriteAuthorizedBy<T, typeof g>;`,
          (writer: string) => `${writer.toUpperCase()}<string>`,
        ],
      ] as const
    ) {
      it(`keeps each recursive value's writer through ${spelling}, reading ${order.join(" then ")}`, async () => {
        const { schema, diagnostics } = await generate(`
          ${declarations}
          type Sec<W> = Confidential<{
            value: W;
            next?: Sec<Identity<W>>;
          }, readonly ["a"]>;
          interface Holder {
            ${
          order.map((writer) => `${writer}: Sec<${argument(writer)}>;`).join(
            "\n",
          )
        }
          }
        `);

        for (const writer of order) {
          for (
            const value of recursiveValues(schema, schema.properties![writer]!)
          ) {
            expect(value.ifc?.writeAuthorizedBy).toEqual({
              __ctWriterIdentityOf: { file: "test.ts", path: [writer] },
            });
          }
        }
        expect(diagnostics).toEqual([]);
      });
    }
  }

  for (const operator of ["|", "&"]) {
    it(`keeps a recursive policy finite when ${operator} repeats the same writer`, async () => {
      const { schema, diagnostics } = await generate(`
        type Sec<W> = Confidential<{
          value: W;
          next?: Sec<W ${operator} WriteAuthorizedBy<string, typeof f>>;
        }, readonly ["a"]>;
        interface Holder { f: Sec<WriteAuthorizedBy<string, typeof f>> }
      `);
      expect(diagnostics).toEqual([]);
      expect(Object.keys(schema.$defs ?? {}).length).toBeGreaterThan(0);
      for (const definition of Object.values(schema.$defs!)) {
        const next = asObjectSchema(
          asObjectSchema(definition).properties!.next!,
        );
        expect(next.$ref).toMatch(/^#\/\$defs\//);
      }
    });
  }

  for (
    const argument of [
      "If<true, W, WriteAuthorizedBy<string, typeof g>>",
      "First<[W, WriteAuthorizedBy<string, typeof g>]>",
      "Unbox<Box<W>>",
      "NonNullable<W>",
      "W[]",
    ]
  ) {
    it(`rejects a policy chain that reaches the nesting limit through ${argument}`, async () => {
      const { diagnostics } = await generate(`
        type If<C, A, B> = C extends true ? A : B;
        type First<T extends readonly unknown[]> = T[0];
        type Box<T> = { boxed: T };
        type Unbox<T> = T extends Box<infer U> ? U : T;
        type Sec<W> = Confidential<{
          value: W;
          next?: Sec<${argument}>;
        }, readonly ["a"]>;
        interface Holder { f: Sec<WriteAuthorizedBy<string, typeof f>> }
      `);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        severity: "error",
        type: "cfc-schema:recursion-limit",
      });
    });
  }

  it("shares a recursive definition when two queries name the same writer", async () => {
    const { schema, diagnostics } = await generate(`
      type Sec<W> = Confidential<{
        value: W;
        next?: Sec<Identity<W>>;
      }, readonly ["a"]>;
      interface Holder {
        a: Sec<WriteAuthorizedBy<string, typeof f>>;
        b: Sec<WriteAuthorizedBy<string, typeof f>>;
      }
    `);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(schema.$defs ?? {})).toHaveLength(1);
    expect(schema.properties!.a).toEqual(schema.properties!.b);
  });

  for (const operator of ["|", "&"]) {
    for (const useDefault of [false, true]) {
      it(`emits recursive references when an alias repeats a writer with \`${operator}\`${useDefault ? " through a default argument" : ""}`, async () => {
        const { schema, diagnostics } = await generate(`
          type Repeat<W> = W ${operator} typeof f;
          type WithDefault<W, V = W> = Repeat<V>;
          type Sec<W> = Confidential<{
            value: WriteAuthorizedBy<string, typeof f>;
            next?: Sec<${useDefault ? "WithDefault<W>" : "Repeat<W>"}>;
          }, readonly ["a"]>;
          interface Holder { f: Sec<typeof f> }
        `);
        expect(diagnostics).toEqual([]);
        expect(Object.keys(schema.$defs ?? {}).length).toBeGreaterThan(0);
        for (const definition of Object.values(schema.$defs!)) {
          const properties = asObjectSchema(definition).properties!;
          expect(asObjectSchema(properties.value!).ifc?.writeAuthorizedBy)
            .toEqual({
              __ctWriterIdentityOf: { file: "test.ts", path: ["f"] },
            });
          expect(asObjectSchema(properties.next!).$ref).toMatch(/^#\/\$defs\//);
        }
      });
    }
  }

  it("keeps writer positions distinct when two recursive payloads use the same bindings in opposite order", async () => {
    const { schema, diagnostics } = await generate(`
      type Pair<A, B> = Confidential<{
        left: WriteAuthorizedBy<string, A>;
        right: WriteAuthorizedBy<string, B>;
      }, readonly ["pair"]>;
      type Sec<W> = Confidential<{
        value: W;
        next?: Sec<Identity<W>>;
      }, readonly ["a"]>;
      type Both<A, B> = Confidential<{
        forward: Sec<Pair<A, B>>;
        reverse: Sec<Pair<B, A>>;
      }, readonly ["b"]>;
      interface Holder { pair: Both<typeof f, typeof g> }
    `);
    const pair = asObjectSchema(schema.properties!.pair!);
    for (
      const [direction, writers] of [
        ["forward", ["f", "g"]],
        ["reverse", ["g", "f"]],
      ] as const
    ) {
      for (
        const value of recursiveValues(schema, pair.properties![direction]!)
      ) {
        for (const [index, field] of ["left", "right"].entries()) {
          expect(
            asObjectSchema(value.properties![field]!).ifc?.writeAuthorizedBy,
          )
            .toEqual({
              __ctWriterIdentityOf: { file: "test.ts", path: [writers[index]] },
            });
        }
      }
    }
    expect(diagnostics).toEqual([]);
  });
});
