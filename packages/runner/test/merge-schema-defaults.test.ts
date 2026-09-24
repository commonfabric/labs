/**
 * Verifies that default insertion preserves retained graphs and measures only
 * the fields needed by a schema, including union selection and sparse arrays.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { toCell } from "../src/back-to-cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  extractDefaultValues,
  mergeSchemaDefaults,
} from "../src/runner-utils.ts";

/** Returns a retained value whose contents must remain unread. */
function unreadValue(): object {
  return new Proxy({}, {
    ownKeys() {
      throw new Error("Default merging enumerated a retained value.");
    },
  });
}

/**
 * Returns a stand-in for a query-result view of the document `id`, whose
 * contents must remain unread.
 */
function viewOf(id: string): object {
  const cell = {
    getAsNormalizedFullLink: () => ({ space: "did:key:merge", id, path: [] }),
  };
  return new Proxy({}, {
    get(_target, key) {
      return key === toCell ? () => cell : undefined;
    },
    ownKeys() {
      throw new Error("Default merging enumerated a view.");
    },
  });
}

/**
 * Returns two different union branches that each add the same default, so
 * that each merges on its own and the candidates they build agree.
 */
function equivalentDefaultBranches(): JSONSchema[] {
  return [
    { type: "object", properties: { count: { type: "number", default: 3 } } },
    {
      type: "object",
      properties: {
        count: { type: "number", default: 3 },
        label: { type: "string" },
      },
    },
  ];
}

describe("mergeSchemaDefaults", () => {
  it("preserves an unchanged object without reading retained descendants", () => {
    const value = { seed: "hello", retained: unreadValue() };
    expect(mergeSchemaDefaults(value, undefined, {
      type: "object",
      properties: { seed: { type: "string" } },
    })).toBe(value);
  });

  it("inserts a nested default while retaining unrelated descendants", () => {
    const value = { options: {}, retained: unreadValue() };
    const schema: JSONSchema = {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { count: { type: "number", default: 3 } },
        },
      },
    };
    const result = mergeSchemaDefaults(
      value,
      extractDefaultValues(schema),
      schema,
    );

    expect(result.options).toEqual({ count: 3 });
    expect(result.retained).toBe(value.retained);
    expect(value.options).toEqual({});
  });

  it("preserves equivalent materializations outside the Fabric value model", () => {
    const prototype = { materialized: true };
    const value = {
      get retained() {
        return Object.assign(Object.create(prototype), { count: 3 });
      },
    };

    expect(mergeSchemaDefaults(value, undefined, { type: "object" }))
      .toBe(value);
    expect(value.retained.count).toBe(3);
  });

  it("returns the value itself where a member reads as a new callback each time", () => {
    const value = {
      get retained() {
        return () => 3;
      },
    };

    expect(mergeSchemaDefaults(value, undefined, { type: "object" }))
      .toBe(value);
  });

  it("returns the value itself without reading the contents of a member it adds nothing to", () => {
    const prototype = { materialized: true };
    let contentReads = 0;
    const value = {
      get retained() {
        return Object.create(prototype, {
          count: {
            enumerable: true,
            get() {
              contentReads++;
              throw new Error("Opaque contents unavailable.");
            },
          },
        });
      },
    };

    expect(mergeSchemaDefaults(value, undefined, { type: "object" }))
      .toBe(value);
    expect(contentReads).toBe(0);
  });

  it("retains array elements, sparse holes, and explicit undefined", () => {
    const value = [unreadValue(), , undefined];
    const result = mergeSchemaDefaults(value, undefined, {
      type: ["array", "undefined"],
      items: true,
    });

    expect(result).toBe(value);
    expect(Object.hasOwn(result, 1)).toBe(false);
    expect(Object.hasOwn(result, 2)).toBe(true);
  });

  it("inserts defaults into array elements without expanding retained graphs", () => {
    const value = [{ retained: unreadValue() }, , undefined];
    const result = mergeSchemaDefaults(value, undefined, {
      type: "array",
      items: {
        type: ["object", "undefined"],
        properties: { count: { type: "number", default: 3 } },
      },
    });

    expect(result?.[0]?.retained).toBe(value[0]!.retained);
    expect(result?.[0]).toHaveProperty("count", 3);
    expect(Object.hasOwn(result, 1)).toBe(false);
    expect(Object.hasOwn(result, 2)).toBe(true);
    expect(result[2]).toBeUndefined();
    expect(value[0]).not.toHaveProperty("count");
  });

  it("selects equivalent union defaults without expanding retained graphs", () => {
    const value = { retained: unreadValue() };
    const branch: JSONSchema = {
      type: "object",
      properties: { count: { type: "number", default: 3 } },
    };
    const result = mergeSchemaDefaults(value, undefined, {
      anyOf: [branch, { ...branch }],
    });

    expect(result.retained).toBe(value.retained);
    expect(result).toHaveProperty("count", 3);
  });

  it("selects equivalent union defaults where the candidates hold two views of one document", () => {
    // Each read of `retained` builds a new view, and the two branches merge
    // separately, so the two candidates hold different views at that key.
    const value = {
      get retained() {
        return viewOf("of:retained");
      },
    };
    const result = mergeSchemaDefaults(value, undefined, {
      anyOf: equivalentDefaultBranches(),
    });

    expect(result).toHaveProperty("count", 3);
  });

  it("leaves union defaults unapplied where the candidates hold views of different documents", () => {
    let views = 0;
    const value = {
      get retained() {
        return viewOf(`of:retained-${views++}`);
      },
    };

    expect(mergeSchemaDefaults(value, undefined, {
      anyOf: equivalentDefaultBranches(),
    })).toBe(value);
  });

  it("leaves union defaults unapplied where the candidates hold members that cannot be read", () => {
    const value = {
      get retained() {
        return Object.create({ materialized: true }, {
          count: {
            enumerable: true,
            get() {
              throw new Error("Opaque contents unavailable.");
            },
          },
        });
      },
    };

    expect(mergeSchemaDefaults(value, undefined, {
      anyOf: equivalentDefaultBranches(),
    })).toBe(value);
  });

  it("leaves ambiguous union defaults unapplied", () => {
    const value = { retained: unreadValue() };
    const schema: JSONSchema = {
      anyOf: [1, 2].map((count) => ({
        type: "object",
        properties: { count: { type: "number", default: count } },
      })),
    };

    expect(mergeSchemaDefaults(value, undefined, schema)).toBe(value);
  });

  it("distinguishes special values in ambiguous union defaults", () => {
    const first = new FabricBytes(new Uint8Array([1]));
    const second = new FabricBytes(new Uint8Array([2]));
    const value = { retained: unreadValue() };
    const schema: JSONSchema = {
      anyOf: [first, second].map((bytes) => ({
        type: "object",
        // Stored schemas carry Fabric defaults; JSONSchema's default type
        // still describes only JSON values.
        properties: {
          bytes: { default: bytes } as unknown as JSONSchema,
        },
      })),
    };

    expect(mergeSchemaDefaults(value, undefined, schema)).toBe(value);
  });

  it("retains an unmodeled cycle while inserting defaults", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const value = { retained: cycle };
    const schema: JSONSchema = {
      type: "object",
      properties: { count: { type: "number", default: 3 } },
    };
    const result = mergeSchemaDefaults(
      value,
      extractDefaultValues(schema),
      schema,
    );

    expect(result.retained).toBe(cycle);
    expect(result).toHaveProperty("count", 3);
  });

  it("reuses a shared value merged under the same recursive schema", () => {
    let reads = 0;
    let value: Record<string, unknown> = {};
    for (let depth = 0; depth < 12; depth++) {
      const target: Record<string, unknown> = { left: value, right: value };
      value = new Proxy(target, {
        get(target, key, receiver) {
          if (key === "left" || key === "right") {
            if (++reads > 2_000) {
              throw new Error("Default merging expanded a shared graph.");
            }
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }
    const schema: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            left: { $ref: "#/$defs/Node" },
            right: { $ref: "#/$defs/Node" },
            count: { type: "number", default: 3 },
          },
        },
      },
    };
    const result = mergeSchemaDefaults(
      value,
      extractDefaultValues(schema),
      schema,
    );

    expect(result.left).toBe(result.right);
    expect(result).toHaveProperty("count", 3);
    expect(reads).toBeLessThanOrEqual(200);
  });

  it("keeps different supplied defaults separate for the same shared value", () => {
    const child = {};
    const childSchema: JSONSchema = {
      type: "object",
      properties: { count: { type: "number" } },
    };
    const value = { left: child, right: child };
    const result = mergeSchemaDefaults(
      value,
      { left: { count: 1 }, right: { count: 2 } },
      { type: "object", properties: { left: childSchema, right: childSchema } },
    );

    expect(result).toEqual({ left: { count: 1 }, right: { count: 2 } });
    expect(child).toEqual({});
  });

  it("resolves the same reference text on both sides against the document root", () => {
    const child = {};
    const ref: JSONSchema = { $ref: "#/$defs/Entry" };
    const branch: JSONSchema = {
      type: "object",
      properties: { child: ref },
    };
    const schema: JSONSchema = {
      type: "object",
      properties: { left: branch, right: branch },
      $defs: {
        Entry: {
          type: "object",
          properties: { count: { $ref: "#/$defs/Count" } },
        },
        Count: { type: "string" },
      },
    };
    const result = mergeSchemaDefaults(
      { left: { child }, right: { child } },
      { left: { child: { count: "one" } }, right: { child: { count: 2 } } },
      schema,
    );

    expect(result).toEqual({
      left: { child: { count: "one" } },
      right: { child: {} },
    });
  });

  it("does not reuse results across calls after a value changes", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { count: { type: "number", default: 3 } },
    };
    const value: { count?: number } = {};
    expect(mergeSchemaDefaults(value, extractDefaultValues(schema), schema))
      .toEqual({ count: 3 });
    value.count = 7;
    expect(mergeSchemaDefaults(value, extractDefaultValues(schema), schema))
      .toBe(value);
  });
});
