import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { MutableJSONSchema } from "@commonfabric/api";
import type { SchemaGenerationDiagnostic } from "../../src/interface.ts";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

const ALIASES = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
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

describe("recursive binding identity", () => {
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
          let node = asObjectSchema(schema.properties![writer]!);
          const visited = new Set<string>();
          for (;;) {
            const value = asObjectSchema(node.properties!.value!);
            expect(value.ifc?.writeAuthorizedBy).toEqual({
              __ctWriterIdentityOf: { file: "test.ts", path: [writer] },
            });
            const next = asObjectSchema(node.properties!.next!);
            if (typeof next.$ref === "string") {
              if (visited.has(next.$ref)) break;
              visited.add(next.$ref);
              node = asObjectSchema(
                schema.$defs![next.$ref.split("/").pop()!] as MutableJSONSchema,
              );
            } else {
              node = next;
            }
          }
          expect(visited.size).toBeGreaterThan(0);
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
      let node = asObjectSchema(pair.properties![direction]!);
      const visited = new Set<string>();
      for (;;) {
        let value = asObjectSchema(node.properties!.value!);
        if (typeof value.$ref === "string") {
          value = asObjectSchema(
            schema.$defs![value.$ref.split("/").pop()!] as MutableJSONSchema,
          );
        }
        for (const [index, field] of ["left", "right"].entries()) {
          expect(
            asObjectSchema(value.properties![field]!).ifc?.writeAuthorizedBy,
          )
            .toEqual({
              __ctWriterIdentityOf: { file: "test.ts", path: [writers[index]] },
            });
        }
        const next = asObjectSchema(node.properties!.next!);
        if (typeof next.$ref === "string") {
          if (visited.has(next.$ref)) break;
          visited.add(next.$ref);
          node = asObjectSchema(
            schema.$defs![next.$ref.split("/").pop()!] as MutableJSONSchema,
          );
        } else {
          node = next;
        }
      }
      expect(visited.size).toBeGreaterThan(0);
    }
    expect(diagnostics).toEqual([]);
  });
});
