import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { collect, emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const types = {
  ...COMMONFABRIC_TYPES,
  "commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"] + `
    export interface PairHandle<T> extends BrandedCell<T, "readonly"> {
      lookup(key: unknown): Reactive<number>;
    }
    export type KeyedHandle<K, V> = PairHandle<{ key: K; value: V }>;
  `,
};

describe("generic cell aliases", () => {
  it("preserves alias arguments and Cell payloads in input and capture schemas", async () => {
    const output = await transformSource(
      `import { pattern, type KeyedHandle, type Cell } from "commonfabric";
      export default pattern<{
        index: KeyedHandle<Cell<{ id: string }>, { name: string }>;
        key: Cell<{ id: string }>;
      }>(({ index, key }) => index.lookup(key));`,
      { types, typeCheck: true },
    );
    const indexSchemas = emittedSchemas(parseModule(output)).flatMap(
      (schema) => {
        const properties = schema.properties;
        return isObjectOrArray(properties) &&
            "index" in properties
          ? [properties.index]
          : [];
      },
    );
    expect(indexSchemas).toHaveLength(2);
    for (const schema of indexSchemas) {
      expect(schema).toEqual(expect.objectContaining({
        asCell: ["readonly"],
        properties: {
          key: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            asCell: ["cell"],
          },
          value: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      }));
    }
    const aliases = collect(parseModule(output), ts.isTypeReferenceNode).filter(
      (node) =>
        (ts.isQualifiedName(node.typeName)
          ? node.typeName.right.text
          : node.typeName.text) === "KeyedHandle",
    );
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(alias.typeArguments).toHaveLength(2);
      const key = alias.typeArguments![0]!;
      expect(ts.isTypeReferenceNode(key)).toBe(true);
      if (!ts.isTypeReferenceNode(key)) throw new Error("Expected key wrapper");
      const name = ts.isQualifiedName(key.typeName)
        ? key.typeName.right.text
        : key.typeName.text;
      expect(name).toBe("Cell");
      expect(key.typeArguments).toHaveLength(1);
      expect(ts.isTypeLiteralNode(key.typeArguments![0]!)).toBe(true);
      expect(ts.isTypeLiteralNode(alias.typeArguments![1]!)).toBe(true);
    }
  });
  it("preserves a direct generic Cell alias when narrowing a captured read", async () => {
    const output = await transformSource(
      `import { pattern, computed, type Cell } from "commonfabric";
      type Pair<K, V> = Cell<{ key: K; value: V }>;
      export default pattern<{ pair: Pair<string, { name: string }> }>(
        ({ pair }) => computed(() => pair.get()),
      );`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const pairSchemas = emittedSchemas(parseModule(output)).flatMap(
      (schema) => {
        const properties = schema.properties;
        return isObjectOrArray(properties) &&
            "pair" in properties
          ? [properties.pair]
          : [];
      },
    );
    expect(pairSchemas).toHaveLength(2);
    for (const schema of pairSchemas) {
      expect(schema).toEqual(expect.objectContaining({
        properties: {
          key: { type: "string" },
          value: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      }));
    }
  });
});
