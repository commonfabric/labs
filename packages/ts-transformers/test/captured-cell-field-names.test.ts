import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("captured cell value fields", () => {
  for (const builder of ["computed", "assert"]) {
    for (const field of ["count", "sum", "min", "max", "map", "get"]) {
      it(`preserves the numeric ${field} field and cell capability in ${builder}`, async () => {
        const output = await transformSource(
          `import { pattern, Writable, ${builder} } from "commonfabric";
          export default pattern(() => {
            const value = Writable.of({ ${field}: 1, unused: "omit" });
            return ${builder}(() => value.get().${field} === 1);
          });`,
          { types: COMMONFABRIC_TYPES, typeCheck: true },
        );
        expect(emittedSchemas(parseModule(output))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                value: expect.objectContaining({
                  asCell: ["readonly"],
                  properties: { [field]: { type: "number" } },
                }),
              }),
            }),
          ]),
        );
      });
    }
  }
  it("retains fields used through a helper alongside a direct member read", async () => {
    const output = await transformSource(
      `import { pattern, computed, Writable } from "commonfabric";
      function readLabel(value: { count: number; label: string }) {
        return value.label.toLowerCase();
      }
      export default pattern(() => {
        const value = Writable.of({ count: 1, label: "Ready" });
        return computed(() => {
          const snapshot = value.get();
          return readLabel(snapshot) + value.get().count;
        });
      });`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    expect(emittedSchemas(parseModule(output))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            value: expect.objectContaining({
              asCell: ["readonly"],
              properties: {
                count: { type: "number" },
                label: { type: "string" },
              },
            }),
          }),
        }),
      ]),
    );
  });

  it("preserves a nullable Stream capture and its event payload", async () => {
    const output = await transformSource(
      `import { pattern, action, Stream } from "commonfabric";
      export default pattern<{
        value: Stream<{ count: number }> | null | undefined;
      }>(({ value }) => action(() => value?.send({ count: 1 })));`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const valueSchemas = emittedSchemas(parseModule(output)).flatMap(
      (schema) => {
        const properties = schema.properties;
        return isObjectOrArray(properties) &&
            "value" in properties
          ? [properties.value]
          : [];
      },
    );
    expect(valueSchemas).toHaveLength(2);
    for (const schema of valueSchemas) {
      expect(schema).toEqual({
        anyOf: [
          { type: "undefined" },
          { type: "null" },
          {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
            asCell: ["stream"],
          },
        ],
      });
    }
  });

  for (
    const { declaration, read } of [
      { declaration: "value?: Writable<Data>", read: "value!.get().count" },
      { declaration: "value?: Writable<Data>", read: "value?.get().count" },
      {
        declaration: "value: Writable<Data> | null | undefined",
        read: "value?.get().count",
      },
      {
        declaration: "value: Writable<Data | undefined>",
        read: "value.get()?.count",
      },
    ]
  ) {
    it(`narrows count while preserving nullishness in ${declaration} read as ${read}`, async () => {
      const output = await transformSource(
        `import { pattern, computed, Writable } from "commonfabric";
        export default pattern<{ ${
          declaration.replaceAll("Data", "{ count: number; unused: string }")
        } }>(({value}) =>
          computed(() => ${read})
        );`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      expect(emittedSchemas(parseModule(output))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              value: expect.objectContaining({
                asCell: ["readonly"],
                anyOf: expect.arrayContaining([
                  expect.objectContaining({
                    type: "object",
                    properties: { count: { type: "number" } },
                    required: ["count"],
                  }),
                  // The nullish members of a union of primitives merge.
                  declaration.includes(" | null")
                    ? { type: ["null", "undefined"] }
                    : { type: "undefined" },
                ]),
              }),
            }),
          }),
        ]),
      );
    });
  }
});
