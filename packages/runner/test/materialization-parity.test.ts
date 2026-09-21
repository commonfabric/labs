/**
 * Cross-checks schema projection through eager traversal and lazy reads. Expected
 * values pin traversal's contract, including distinctions JSON loses.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { type JSONSchema } from "@commonfabric/api";
import { type FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { toCell } from "../src/back-to-cell.ts";
import { type Cell, isCell } from "../src/cell.ts";
import { snapshotQueryResult } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import {
  isSchemaMismatchError,
  UnresolvedInputError,
} from "../src/schema-view.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("materialization-parity");
const space = signer.did();

/** One projection with an explicit expected value shared by both read modes. */
type ProjectionCase = {
  /** Behavior the projection must preserve. */
  name: string;

  /** Stored input, seeded without splitting array elements into documents. */
  value: FabricValue;

  /** Schema applied to the read. */
  schema: JSONSchema;

  /** Fully consumed projection. */
  expected: unknown;
};

const cases: ProjectionCase[] = [
  {
    name: "returns `undefined` for overlapping `oneOf` branches",
    value: 1,
    schema: { oneOf: [{ type: "number" }, { type: "integer" }] },
    expected: undefined,
  },
  {
    name: "returns the sole matching `oneOf` branch",
    value: "glaze",
    schema: { oneOf: [{ type: "number" }, { type: "string" }] },
    expected: "glaze",
  },
  {
    name: "returns `undefined` for an invalid scalar under `allOf`",
    value: "bad",
    schema: { allOf: [{ type: "number" }] },
    expected: undefined,
  },
  {
    name: "returns `undefined` for a missing required property under `allOf`",
    value: {},
    schema: {
      allOf: [{
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      }],
    },
    expected: undefined,
  },
  {
    name:
      "returns `undefined` for a value matching only parts of different `anyOf` branches",
    value: { a: 1, b: "bad" },
    schema: {
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a", "b"],
        },
      ],
    },
    expected: undefined,
  },
  {
    name: "merges successful `allOf` projections",
    value: { a: 1, b: "glaze", hidden: true },
    schema: {
      allOf: [
        { type: "object", properties: { a: { type: "number" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    },
    expected: { a: 1, b: "glaze" },
  },
  ...[false, true].map((required): ProjectionCase => ({
    name: `defaults an invalid ${required ? "required" : "optional"} property`,
    value: { n: "bad" },
    schema: {
      type: "object",
      properties: { n: { type: "number", default: 7 } },
      ...(required ? { required: ["n"] } : {}),
    },
    expected: { n: 7 },
  })),
  ...(["null", "undefined"] as const).map((fallback): ProjectionCase => ({
    name: "substitutes `" + fallback + "` for an invalid array item",
    value: ["bad", 2],
    schema: {
      type: "array",
      items: { type: ["number", fallback] },
    },
    expected: [fallback === "null" ? null : undefined, 2],
  })),
  {
    name: "omits an absent property with a `null` default",
    value: {},
    schema: {
      type: "object",
      properties: { n: { type: ["number", "null"], default: null } },
    },
    expected: {},
  },
  {
    name: "applies a top-level `null` default",
    value: undefined,
    schema: { type: ["number", "null"], default: null },
    expected: null,
  },
  {
    name: "defaults an invalid property through a schema reference",
    value: { n: "bad" },
    schema: {
      type: "object",
      properties: { n: { $ref: "#/$defs/count" } },
      $defs: { count: { type: "number", default: 7 } },
      required: ["n"],
    },
    expected: { n: 7 },
  },
  {
    name: "omits a rejected property whose only default sits in a branch",
    value: { n: true },
    schema: {
      type: "object",
      properties: {
        n: { anyOf: [{ type: "number", default: 7 }, { type: "string" }] },
      },
    },
    expected: {},
  },
  {
    name: "omits an optional property with multiple matching `oneOf` branches",
    value: { n: 1 },
    schema: {
      type: "object",
      properties: { n: { oneOf: [{ type: "number" }, { type: "integer" }] } },
    },
    expected: {},
  },
  {
    name:
      "merges successful `anyOf` projections without invalid branch properties",
    value: { a: 1, b: "bad", c: 3 },
    schema: {
      anyOf: [
        { type: "object", properties: { a: { type: "number" } } },
        { type: "object", properties: { c: { type: "number" } } },
        {
          type: "object",
          properties: { b: { type: "number" } },
          required: ["b"],
        },
      ],
    },
    expected: { a: 1, c: 3 },
  },
  {
    name: "defaults a property whose nested required value is invalid",
    value: { box: { n: "bad" } },
    schema: {
      type: "object",
      properties: {
        box: {
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
          default: { n: 7 },
        },
      },
    },
    expected: { box: { n: 7 } },
  },
  {
    name: "substitutes `null` for an array item with an invalid required child",
    value: [{ n: "bad" }, { n: 2 }],
    schema: {
      type: "array",
      items: {
        type: ["object", "null"],
        properties: { n: { type: "number" } },
        required: ["n"],
      },
    },
    expected: [null, { n: 2 }],
  },
];

describe("materialization-parity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const write = runtime.edit();
      runtime.getCell(space, testCase.name, undefined, write).setRaw(
        testCase.value,
      );
      await write.commit();
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        tx.markLazyMaterialize(lazy);
        try {
          const value = runtime.getCell(
            space,
            testCase.name,
            testCase.schema,
            tx,
          ).get();
          expect(snapshotQueryResult(value)).toEqual(testCase.expected);
          expect(tx.takeSchemaRefusal()).toBeUndefined();
        } finally {
          await tx.commit();
        }
      }
    });
  }

  it("defers an untouched combinator sibling and keeps its original snapshot", async () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
        choice: {
          anyOf: [{ type: "number" }, { type: "string" }],
        },
      },
    };
    const write = runtime.edit();
    runtime.getCell(space, "deferred", undefined, write).setRaw({
      count: 1,
      choice: "glaze",
    });
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    try {
      const cell = runtime.getCell<{ count: number; choice: string }>(
        space,
        "deferred",
        schema,
        tx,
      );
      const value = cell.get();
      expect(value.count).toBe(1);
      expect(
        [...getTransactionReadActivities(tx) ?? []].some((read) =>
          read.path.includes("choice")
        ),
      ).toBe(false);
      cell.key("choice").set("sprinkles");
      expect(value.choice).toBe("glaze");
      expect(cell.get().choice).toBe("sprinkles");
    } finally {
      await tx.commit();
    }
  });

  it("records a required combinator refusal without confusing a valid undefined result", async () => {
    const write = runtime.edit();
    runtime.getCell(space, "refusal", undefined, write).setRaw({
      n: 1,
      absent: undefined,
    });
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    try {
      const value = runtime.getCell<{ n: number; absent: undefined }>(
        space,
        "refusal",
        {
          type: "object",
          properties: {
            n: { oneOf: [{ type: "number" }, { type: "integer" }] },
            absent: { oneOf: [{ type: "undefined" }, { type: "string" }] },
          },
          required: ["n", "absent"],
        },
        tx,
      ).get();
      expect(value.absent).toBeUndefined();
      expect(tx.takeSchemaRefusal()).toBeUndefined();
      expect(() => value.n).toThrow();
      expect(isSchemaMismatchError(tx.takeSchemaRefusal())).toBe(true);
    } finally {
      await tx.commit();
    }
  });

  it("keeps an unrelated refusal when a default or array substitute handles its own failure", async () => {
    const write = runtime.edit();
    runtime.getCell(space, "handled", undefined, write).setRaw({
      n: "bad",
      xs: ["bad"],
    });
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    try {
      const refusal = new Error("unrelated refusal");
      tx.noteSchemaRefusal(refusal);
      const value = runtime.getCell<{ n: number; xs: (number | null)[] }>(
        space,
        "handled",
        {
          type: "object",
          properties: {
            n: { type: "number", default: 7 },
            xs: { type: "array", items: { type: ["number", "null"] } },
          },
        },
        tx,
      ).get();
      expect(value.n).toBe(7);
      expect(value.xs[0]).toBeNull();
      expect(tx.takeSchemaRefusal()).toBe(refusal);
    } finally {
      await tx.commit();
    }
  });

  it("refuses an unavailable array link target even when a null substitute is allowed", async () => {
    const write = runtime.edit();
    const missing = runtime.getCell(space, "missing-item", undefined, write);
    runtime.getCell(space, "missing-array", undefined, write).setRaw([
      missing.getAsLink(),
    ]);
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    try {
      const value = runtime.getCell<(number | null)[]>(space, "missing-array", {
        type: "array",
        items: { type: ["number", "null"] },
      }, tx).get();
      expect(() => value[0]).toThrow(UnresolvedInputError);
      expect(tx.takeSchemaRefusal()).toBeInstanceOf(UnresolvedInputError);
    } finally {
      await tx.commit();
    }
  });

  it("mints a handle for the selected branch of an optional handle union", async () => {
    const handle: JSONSchema = {
      anyOf: [{ type: "number", asCell: ["cell"] }, { type: "undefined" }],
    };
    const write = runtime.edit();
    runtime.getCell(space, "root-handle", undefined, write).setRaw(1);
    runtime.getCell(space, "nested-handle", undefined, write).setRaw({
      h: 1,
    });
    await write.commit();
    for (const lazy of [false, true]) {
      const tx = runtime.edit();
      tx.markLazyMaterialize(lazy);
      try {
        const root = runtime.getCell<Cell<number>>(
          space,
          "root-handle",
          handle,
          tx,
        ).get();
        expect(isCell(root)).toBe(true);
        expect(root.get()).toBe(1);
        const nested = runtime.getCell<{ h: Cell<number> }>(
          space,
          "nested-handle",
          { type: "object", properties: { h: handle } },
          tx,
        ).get();
        expect(isCell(nested.h)).toBe(true);
        expect(nested.h.get()).toBe(1);
      } finally {
        await tx.commit();
      }
    }
  });

  it("refuses an unavailable link inside an array item even when a null substitute is allowed", async () => {
    const write = runtime.edit();
    const missing = runtime.getCell(space, "missing-child", undefined, write);
    runtime.getCell(space, "missing-in-item", undefined, write).setRaw([
      { n: missing.getAsLink() },
    ]);
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    try {
      const value = runtime.getCell<({ n: number } | null)[]>(
        space,
        "missing-in-item",
        {
          type: "array",
          items: {
            type: ["object", "null"],
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
        tx,
      ).get();
      expect(() => value[0]).toThrow(UnresolvedInputError);
      expect(tx.takeSchemaRefusal()).toBeInstanceOf(UnresolvedInputError);
    } finally {
      await tx.commit();
    }
  });

  it("refuses an unavailable link inside a property that declares a default", async () => {
    const write = runtime.edit();
    const missing = runtime.getCell(space, "missing-boxed", undefined, write);
    runtime.getCell(space, "missing-in-box", undefined, write).setRaw({
      box: { n: missing.getAsLink() },
    });
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    try {
      const value = runtime.getCell<{ box: { n: number } }>(
        space,
        "missing-in-box",
        {
          type: "object",
          properties: {
            box: {
              type: "object",
              properties: { n: { type: "number" } },
              required: ["n"],
              default: { n: 7 },
            },
          },
        },
        tx,
      ).get();
      expect(() => value.box).toThrow(UnresolvedInputError);
      expect(tx.takeSchemaRefusal()).toBeInstanceOf(UnresolvedInputError);
    } finally {
      await tx.commit();
    }
  });

  it("gives an inline nested array the same stable identity in both modes", async () => {
    const write = runtime.edit();
    runtime.getCell(space, "nested-array", undefined, write).setRaw([[1, 2]]);
    await write.commit();
    const links = [];
    for (const lazy of [false, true]) {
      const tx = runtime.edit();
      tx.markLazyMaterialize(lazy);
      try {
        const value = runtime.getCell<Array<{ [toCell]: () => Cell<unknown> }>>(
          space,
          "nested-array",
          {
            type: "array",
            items: { type: "array", items: { type: "number" } },
          },
          tx,
        ).get();
        const link = value[0][toCell]().getAsNormalizedFullLink();
        links.push({ id: link.id, path: link.path });
        expect(link.id.startsWith("data:")).toBe(true);
      } finally {
        await tx.commit();
      }
    }
    expect(links[1]).toEqual(links[0]);
  });
});
