import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";

import type { JSONSchema } from "../src/builder/types.ts";
import { selectorSchemaForLink } from "../src/storage/v2.ts";
import { normalizeSyncSelector } from "../src/storage/v2-watch.ts";

describe("selectorSchemaForLink()", () => {
  // Each case builds its schema anew and gives it a title of its own, so that
  // no case finds a schema another case derived from already interned.
  const handleSchema = (title: string) =>
    ({
      title,
      type: "object",
      properties: {
        name: { type: "string" },
        owner: { type: "object", asCell: ["cell"] },
      },
      asCell: ["cell"],
    }) as JSONSchema;

  it("returns `false` for no schema, and a boolean schema as it is", () => {
    expect(selectorSchemaForLink(undefined)).toBe(false);
    expect(selectorSchemaForLink(false)).toBe(false);
    expect(selectorSchemaForLink(true)).toBe(true);
  });

  it("returns a schema without its outermost handle boundary, keeping inner ones", () => {
    for (
      const schema of [handleSchema("root"), deepFreeze(handleSchema("root"))]
    ) {
      expect(selectorSchemaForLink(schema)).toEqual({
        title: "root",
        type: "object",
        properties: {
          name: { type: "string" },
          owner: { type: "object", asCell: ["cell"] },
        },
      });
    }
  });

  it("returns a schema without the handle boundary at the root of each union branch", () => {
    const union = (key: "anyOf" | "oneOf") =>
      ({
        title: `union ${key}`,
        [key]: [
          { type: "string", asCell: ["cell"] },
          { type: "number", asCell: ["stream", "cell"] },
          { type: "null" },
          true,
        ],
      }) as JSONSchema;
    for (const key of ["anyOf", "oneOf"] as const) {
      for (const schema of [union(key), deepFreeze(union(key))]) {
        expect(selectorSchemaForLink(schema)).toEqual({
          title: `union ${key}`,
          [key]: [
            { type: "string" },
            { type: "number", asCell: ["cell"] },
            { type: "null" },
            true,
          ],
        });
      }
    }
  });

  it("returns a schema that takes no handle with the content it has", () => {
    const plain = () =>
      ({
        title: "no handle",
        type: "object",
        properties: { name: { type: "string" } },
      }) as JSONSchema;
    for (const schema of [plain(), deepFreeze(plain())]) {
      expect(selectorSchemaForLink(schema)).toEqual(plain());
    }
  });

  it("returns one deep-frozen schema for every call with one deep-frozen schema", () => {
    const schema = deepFreeze(handleSchema("one object"));
    const first = selectorSchemaForLink(schema);
    expect(isDeepFrozen(first)).toBe(true);
    expect(selectorSchemaForLink(schema)).toBe(first);
  });

  it("returns one schema for two equal deep-frozen schemas", () => {
    expect(selectorSchemaForLink(deepFreeze(handleSchema("equal")))).toBe(
      selectorSchemaForLink(deepFreeze(handleSchema("equal"))),
    );
  });

  it("hashes nothing to normalize a selector over the schema again", () => {
    // Each sync of a link's target normalizes a selector over this schema,
    // which interns it. A schema built anew for each sync is hashed whole
    // each time.
    const schema = deepFreeze(handleSchema("hashed once"));
    const selectorFor = () =>
      normalizeSyncSelector({
        path: ["value"],
        schema: selectorSchemaForLink(schema),
      });
    const first = selectorFor();
    const hashedBefore = getContainersHashedForTestingOnly();
    for (let sync = 0; sync < 10; sync++) {
      expect(selectorFor()).toBe(first);
    }
    expect(getContainersHashedForTestingOnly()).toBe(hashedBefore);
  });

  it("returns a schema of its own for a schema that is not deep-frozen, leaving it unfrozen", () => {
    const schema = handleSchema("mutable");
    const first = selectorSchemaForLink(schema);
    expect(selectorSchemaForLink(schema)).not.toBe(first);
    expect(first).not.toBe(schema);
    expect(Object.isFrozen(schema)).toBe(false);
    expect(Object.isFrozen(first)).toBe(false);
  });
});
