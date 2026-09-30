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

  it("refuses an unavailable link inside a union item where the reader touches it, not at the item", async () => {
    // The item is an object, so its type alone selects the object branch — the
    // `null` branch cannot match it — and the view is built over that branch
    // rather than evaluating the union whole. The dead-end below it is then
    // met where the reader touches it, as under any view; the item itself
    // reads as a view, never as the `null` substitute.
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
            anyOf: [
              {
                type: "object",
                properties: { n: { type: "number" } },
                required: ["n"],
              },
              { type: "null" },
            ],
          },
        },
        tx,
      ).get();
      // Compared as a boolean: handing the view to `expect` would coerce it
      // into the failure message, and a view refuses that coercion.
      const item = value[0];
      expect(item === null).toBe(false);
      expect(() => (item as { n: number }).n).toThrow(UnresolvedInputError);
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
      expect(() => value.box.n).toThrow(UnresolvedInputError);
      expect(tx.takeSchemaRefusal()).toBeInstanceOf(UnresolvedInputError);
    } finally {
      await tx.commit();
    }
  });

  describe("a union evaluated whole that succeeds by substituting for an unserved item", () => {
    // Two array branches accept the value, so the union is evaluated whole. The
    // item is a link to a document the replica cannot serve; the traverser
    // substitutes `null` for it and reports the array as matched. That success
    // publishes nothing about the item, so the hop refuses as unresolved input,
    // and the property boundary decides what that means: an optional property
    // with no default is omitted, a required one refuses.

    const nullableNumbers = {
      type: "array",
      items: { type: ["number", "null"] },
    } as const;
    const union = {
      anyOf: [
        nullableNumbers,
        { ...nullableNumbers, description: "a second branch that matches" },
      ],
    } as JSONSchema;

    const seededMissingItem = async (cause: string) => {
      const write = runtime.edit();
      const missing = runtime.getCell(
        space,
        `${cause}-missing`,
        undefined,
        write,
      );
      runtime.getCell(space, cause, undefined, write).setRaw({
        box: [missing.getAsLink()],
      });
      await write.commit();
    };

    it("omits an optional property and retains no refusal", async () => {
      await seededMissingItem("substitute-optional");
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell<{ box?: unknown }>(
          space,
          "substitute-optional",
          { type: "object", properties: { box: union } },
          tx,
        ).get();
        expect(value.box).toBeUndefined();
        expect("box" in value).toBe(false);
        expect(tx.takeSchemaRefusal()).toBeUndefined();
      } finally {
        await tx.commit();
      }
    });

    it("refuses a required property, and records the refusal", async () => {
      await seededMissingItem("substitute-required");
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell<{ box: unknown }>(
          space,
          "substitute-required",
          { type: "object", properties: { box: union }, required: ["box"] },
          tx,
        ).get();
        expect(() => value.box).toThrow(UnresolvedInputError);
        expect(tx.takeSchemaRefusal()).toBeInstanceOf(UnresolvedInputError);
      } finally {
        await tx.commit();
      }
    });
  });

  describe("a handle minted from a branch of a union", () => {
    // A handle outlives the read that minted it and is read later, by code
    // that never knew which mode minted it, so its schema is the reader's
    // declaration, not the mode's. Under a union whose typed branch declares
    // `asCell`, both modes mint a handle carrying the compound with the
    // branches' markers removed, and a read through it projects every branch;
    // under a union whose only handle branch is bare, both keep the schema
    // the handle adopted from its link.

    const stored = { id: 1, name: "one", hidden: true };
    const shaped: JSONSchema = {
      type: "object",
      properties: {
        h: {
          anyOf: [
            {
              type: "object",
              properties: { id: { type: "number" } },
              asCell: ["cell"],
            },
            { asCell: ["cell"] },
            {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          ],
        },
      },
    };
    const bare: JSONSchema = {
      type: "object",
      properties: {
        h: {
          anyOf: [
            { asCell: ["cell"] },
            {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          ],
        },
      },
    };

    const idBranch: JSONSchema = {
      type: "object",
      properties: { id: { type: "number" } },
    };
    const nameBranch: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };

    /** Reads `h` through `schema` in each mode, asserting each mode's handle
     * reads `expected` and carries `expectedSchema`. */
    const handleReadsInBothModes = async (
      cause: string,
      schema: JSONSchema,
      expected: unknown,
      expectedSchema: JSONSchema,
      h: FabricValue = stored,
    ) => {
      const write = runtime.edit();
      runtime.getCell(space, cause, undefined, write).setRaw({ h });
      await write.commit();
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        try {
          const handle = runtime.getCell<{ h: Cell<unknown> }>(
            space,
            cause,
            schema,
            tx,
          ).get().h;
          expect(isCell(handle)).toBe(true);
          expect(handle.get()).toEqual(expected);
          expect(handle.schema).toEqual(expectedSchema);
        } finally {
          await tx.commit();
        }
      }
    };

    it("carries the compound, and projects every branch, where a typed branch minted it", async () => {
      await handleReadsInBothModes("typed-handle-branch", shaped, stored, {
        anyOf: [idBranch, {}, nameBranch],
      });
    });

    it("is minted from the one matching arm of an optional handle in both modes", async () => {
      // `Cell<T> | undefined` generates as a union whose one arm admits the
      // value; an eager read mints from that arm and merges nothing, and the
      // handle carries the arm's own schema in both modes.
      const optional: JSONSchema = {
        type: "object",
        properties: {
          h: {
            anyOf: [
              {
                type: "object",
                properties: { id: { type: "number" } },
                asCell: ["cell"],
              },
              { type: "undefined" },
            ],
          },
        },
      };
      await handleReadsInBothModes(
        "optional-handle-arm",
        optional,
        { id: 1 },
        idBranch,
        { id: 1 },
      );
    });

    it("is minted from the one matching branch of a `oneOf` in both modes", async () => {
      // A `oneOf` admits one branch, so an eager read mints from it and merges
      // nothing; a view does the same, and the handle reads the value rather
      // than another handle.
      const oneOf: JSONSchema = {
        type: "object",
        properties: {
          h: {
            oneOf: [
              {
                type: "object",
                properties: { id: { type: "number" } },
                asCell: ["cell"],
              },
              { type: "undefined" },
            ],
          },
        },
      };
      await handleReadsInBothModes(
        "oneof-handle-branch",
        oneOf,
        { id: 1 },
        idBranch,
        { id: 1 },
      );
    });

    it("is minted from the branch where one `anyOf` arm carries a `oneOf` beside it", async () => {
      // Traversal dispatches the `anyOf` first, and its one arm — `true`, with
      // the `oneOf` riding inside it — is the one match its merge sees, so an
      // eager read mints from the branch and merges nothing; so does a view.
      const mixed: JSONSchema = {
        type: "object",
        properties: {
          h: {
            anyOf: [true],
            oneOf: [
              {
                type: "object",
                properties: { id: { type: "number" } },
                asCell: ["cell"],
              },
              { type: "undefined" },
            ],
          },
        },
      };
      await handleReadsInBothModes(
        "mixed-handle-branch",
        mixed,
        { id: 1 },
        idBranch,
        { id: 1 },
      );
    });

    it("projects a branch traversal keeps after dropping an invalid optional property, in both modes", async () => {
      // Which arms match is decided by traversing them: an invalid optional
      // `name` drops out of the second branch, which still succeeds and
      // contributes `x`. No reading of the schema alone says so, so the
      // handle is minted through the merge in both modes.
      const filtering: JSONSchema = {
        type: "object",
        properties: {
          h: {
            anyOf: [
              {
                type: "object",
                properties: { id: { type: "number" } },
                asCell: ["cell"],
              },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  x: { type: "boolean" },
                },
              },
            ],
          },
        },
      };
      await handleReadsInBothModes(
        "filtered-handle-branch",
        filtering,
        { id: 1, x: true },
        {
          anyOf: [idBranch, {
            type: "object",
            properties: { name: { type: "string" }, x: { type: "boolean" } },
          }],
        },
        { id: 1, name: 123, x: true },
      );
    });

    it("is minted from the branch where traversal rejects the sibling for an absent required key, in both modes", async () => {
      // The sibling's `required` is met by traversing it, not by reading the
      // schema: with `name` absent the sibling is rejected, one arm matches,
      // and the handle carries that arm's own schema in both modes.
      const requiring: JSONSchema = {
        type: "object",
        properties: {
          h: {
            anyOf: [
              {
                type: "object",
                properties: { id: { type: "number" } },
                asCell: ["cell"],
              },
              {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            ],
          },
        },
      };
      await handleReadsInBothModes(
        "required-sibling-branch",
        requiring,
        { id: 1 },
        idBranch,
        { id: 1 },
      );
    });

    it("carries the compound where a sibling arm is told apart by a `const`, in both modes", async () => {
      // Traversal admits a branch without reading its `const` and `enum`, so
      // both arms of a tagged union match a value tagged for the first, and
      // the handle carries the compound: a read through it projects the second
      // arm's `label` too.
      const tagged: JSONSchema = {
        type: "object",
        properties: {
          h: {
            anyOf: [
              {
                type: "object",
                properties: { kind: { const: "a" }, id: { type: "number" } },
                asCell: ["cell"],
              },
              {
                type: "object",
                properties: { kind: { const: "b" }, label: { type: "string" } },
              },
            ],
          },
        },
      };
      await handleReadsInBothModes(
        "tagged-handle-branch",
        tagged,
        { kind: "a", id: 1, label: "L" },
        {
          anyOf: [{
            type: "object",
            properties: { kind: { const: "a" }, id: { type: "number" } },
          }, {
            type: "object",
            properties: { kind: { const: "b" }, label: { type: "string" } },
          }],
        },
        { kind: "a", id: 1, label: "L" },
      );
    });

    it("carries the compound where only a bare branch could have minted it and the value is inline", async () => {
      await handleReadsInBothModes("bare-handle-inline", bare, stored, {
        anyOf: [{}, nameBranch],
      });
    });

    it("keeps the link's schema where only a bare branch could have minted it over a link that carries one", async () => {
      const write = runtime.edit();
      const target = runtime.getCell<{ x: number; y: number }>(
        space,
        "bare-handle-target",
        {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
        write,
      );
      target.set({ x: 1, y: 2 });
      await write.commit();
      await handleReadsInBothModes(
        "bare-handle-linked",
        bare,
        { x: 1, y: 2 },
        {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
        target.getAsLink({ includeSchema: true }),
      );
    });
  });

  describe("a schema that omits `type`", () => {
    // Such a schema admits every type, and which of its keywords apply is
    // settled by the value: a read holding an object narrows a key through
    // the object reading, one holding an array narrows an element through
    // `items`. Both modes settle it the same way.

    it("reads a key of an object it names nothing about as an additional property in both modes", async () => {
      const write = runtime.edit();
      runtime.getCell(space, "typeless-open", undefined, write).setRaw({
        extra: "kept",
      });
      await write.commit();
      const schema: JSONSchema = {
        items: { type: "object", properties: { title: { type: "string" } } },
      };
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        try {
          const value = runtime.getCell<{ extra?: string }>(
            space,
            "typeless-open",
            schema,
            tx,
          ).get();
          expect(value.extra).toBe("kept");
          expect(tx.takeSchemaRefusal()).toBeUndefined();
        } finally {
          await tx.commit();
        }
      }
    });

    it("narrows an element of an array through `items` in both modes", async () => {
      const write = runtime.edit();
      runtime.getCell(space, "typeless-list", undefined, write).setRaw({
        list: [{ n: 1 }],
      });
      await write.commit();
      const schema: JSONSchema = {
        type: "object",
        properties: {
          list: {
            items: {
              type: "object",
              properties: { n: { type: "number" } },
              asCell: ["cell"],
            },
          },
        },
      };
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        try {
          const value = runtime.getCell<{ list: unknown[] }>(
            space,
            "typeless-list",
            schema,
            tx,
          ).get();
          const element = value.list[0];
          expect(isCell(element)).toBe(true);
          expect((element as Cell<{ n: number }>).get().n).toBe(1);
          expect(tx.takeSchemaRefusal()).toBeUndefined();
        } finally {
          await tx.commit();
        }
      }
    });
  });

  describe("a union evaluated whole that admits an unserved hop as `undefined`", () => {
    it("reads `undefined` with no refusal, and the document's read registered", async () => {
      // Two object branches: the union is evaluated whole, and the link below
      // it dead-ends at a document the replica cannot serve. The position
      // admits `undefined`, so nothing stands in for the unknown: the read
      // stands as an eager read does, and the registered read runs the reader
      // again when the document arrives.
      const write = runtime.edit();
      const missing = runtime.getCell(
        space,
        "admitted-missing",
        undefined,
        write,
      );
      runtime.getCell(space, "admitted-union", undefined, write).setRaw({
        p: { n: missing.getAsLink() },
      });
      await write.commit();
      const branch = (extra: Record<string, JSONSchema>): JSONSchema => ({
        type: "object",
        properties: { n: { type: ["number", "undefined"] }, ...extra },
      });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          p: {
            anyOf: [
              branch({ a: { type: "string" } }),
              branch({ b: { type: "string" } }),
            ],
          },
        },
        required: ["p"],
      };
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        try {
          const value = runtime.getCell<{ p: { n?: number } }>(
            space,
            "admitted-union",
            schema,
            tx,
          ).get();
          expect(value.p.n).toBeUndefined();
          expect(tx.takeSchemaRefusal()).toBeUndefined();
          const reads = [...(getTransactionReadActivities(tx) ?? [])];
          expect(
            reads.some((activity) =>
              activity.id === missing.getAsNormalizedFullLink().id
            ),
          ).toBe(true);
        } finally {
          await tx.commit();
        }
      }
    });
  });

  describe("a default filling an absent value beside a missing document of the same id in another scope", () => {
    it("applies the default with no refusal, since the id names a different document in each scope", async () => {
      // The same cause names a document in each scope. The user-scoped one is
      // never written, so the link to it dead-ends; the space-scoped one is
      // written without `q`, so the link to its `q` reads an absent value
      // that a default fills. The default covers nothing unserved: the
      // missing document is the other scope's.
      const write = runtime.edit();
      const missingUser = runtime.getCell(
        space,
        "same-id-two-scopes",
        undefined,
        write,
        "user",
      );
      const served = runtime.getCell(
        space,
        "same-id-two-scopes",
        undefined,
        write,
      );
      served.setRaw({ present: 1 });
      runtime.getCell(space, "scoped-holder", undefined, write).setRaw({
        p: { a: missingUser.getAsLink(), b: served.key("q").getAsLink() },
      });
      await write.commit();
      const branch = (extra: Record<string, JSONSchema>): JSONSchema => ({
        type: "object",
        properties: {
          a: { type: ["number", "undefined"] },
          b: { type: "number", default: 3 },
          ...extra,
        },
      });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          p: {
            anyOf: [
              branch({ x: { type: "string" } }),
              branch({ y: { type: "string" } }),
            ],
          },
        },
        required: ["p"],
      };
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        try {
          const value = runtime.getCell<{ p: { a?: number; b: number } }>(
            space,
            "scoped-holder",
            schema,
            tx,
          ).get();
          expect(value.p.a).toBeUndefined();
          expect(value.p.b).toBe(3);
          expect(tx.takeSchemaRefusal()).toBeUndefined();
        } finally {
          await tx.commit();
        }
      }
    });
  });

  describe("an unavailable link under an optional property that declares no default", () => {
    // The two cases above pin the dead-end where something would otherwise be
    // published in its place — a default, a substitute. An optional property
    // with no default has nothing to publish: it reads as absent, as an eager
    // read reads it, and the dead-end's read is registered so the reader runs
    // again when the document arrives.

    const readsAbsentAndRegisters = async (
      cause: string,
      missingId: string,
      schema: JSONSchema,
    ) => {
      for (const lazy of [false, true]) {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        try {
          const value = runtime.getCell<{ p?: unknown; other?: number }>(
            space,
            cause,
            schema,
            tx,
          ).get();
          expect(value.p).toBeUndefined();
          expect(tx.takeSchemaRefusal()).toBeUndefined();
          const reads = [...(getTransactionReadActivities(tx) ?? [])];
          expect(reads.some((activity) => activity.id === missingId)).toBe(
            true,
          );
        } finally {
          await tx.commit();
        }
      }
    };

    it("reads as absent, with the document's read registered, where the property's own target is unserved", async () => {
      const write = runtime.edit();
      const missing = runtime.getCell(
        space,
        "missing-target",
        undefined,
        write,
      );
      runtime.getCell(space, "optional-link", undefined, write).setRaw({
        p: missing.getAsLink(),
        other: 1,
      });
      await write.commit();
      await readsAbsentAndRegisters(
        "optional-link",
        missing.getAsNormalizedFullLink().id,
        {
          type: "object",
          properties: {
            other: { type: "number" },
            p: { type: "object", properties: { n: { type: "number" } } },
          },
        },
      );
    });

    it("reads as absent, with the document's read registered, where a union evaluated whole dead-ends below it", async () => {
      // Two object branches: the value's type settles nothing, so the union is
      // evaluated whole and the dead-end is met inside the traverser.
      const write = runtime.edit();
      const missing = runtime.getCell(
        space,
        "missing-in-union",
        undefined,
        write,
      );
      runtime.getCell(space, "optional-union", undefined, write).setRaw({
        p: { n: missing.getAsLink() },
      });
      await write.commit();
      const branch = (extra: Record<string, JSONSchema>): JSONSchema => ({
        type: "object",
        properties: { n: { type: "number" }, ...extra },
        required: ["n"],
      });
      await readsAbsentAndRegisters(
        "optional-union",
        missing.getAsNormalizedFullLink().id,
        {
          type: "object",
          properties: {
            p: {
              anyOf: [
                branch({ a: { type: "string" } }),
                branch({ b: { type: "string" } }),
              ],
            },
          },
        },
      );
    });
  });

  describe("where a view deliberately diverges from an eager read", () => {
    // Each case here is a decision, not a gap: an eager read decides a
    // fallback by evaluating the whole subtree, and a view decides it by what
    // it can see at the container, because registering every read below a
    // present value is the cost a view exists to avoid. What fails deeper
    // refuses where the reader touches it.

    /** Reads `name` under `schema` in each mode, handing back each read's value
     * and transaction. */
    const readBothWays = (name: string, schema: JSONSchema) => {
      const eager = runtime.edit();
      const lazy = runtime.edit();
      lazy.markLazyMaterialize(true);
      return {
        eager: {
          tx: eager,
          value: runtime.getCell(space, name, schema, eager).get(),
        },
        lazy: {
          tx: lazy,
          value: runtime.getCell(space, name, schema, lazy).get(),
        },
        commit: async () => {
          await eager.commit();
          await lazy.commit();
        },
      };
    };

    it("takes a property default for a nested mismatch eagerly, and refuses it where touched lazily", async () => {
      const write = runtime.edit();
      runtime.getCell(space, "nested-default", undefined, write).setRaw({
        box: { n: "bad" },
      });
      await write.commit();
      const read = readBothWays("nested-default", {
        type: "object",
        properties: {
          box: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
            default: { n: 7 },
          },
        },
        required: ["box"],
      });
      try {
        expect(snapshotQueryResult(read.eager.value)).toEqual({
          box: { n: 7 },
        });
        const lazy = read.lazy.value as { box: { n: number } };
        expect(() => lazy.box.n).toThrow();
        expect(isSchemaMismatchError(read.lazy.tx.takeSchemaRefusal())).toBe(
          true,
        );
      } finally {
        await read.commit();
      }
    });

    it("substitutes `null` for an item with a nested mismatch eagerly, and refuses it where touched lazily", async () => {
      const write = runtime.edit();
      runtime.getCell(space, "nested-substitute", undefined, write).setRaw([
        { n: "bad" },
        { n: 2 },
      ]);
      await write.commit();
      const read = readBothWays("nested-substitute", {
        type: "array",
        items: {
          type: ["object", "null"],
          properties: { n: { type: "number" } },
          required: ["n"],
        },
      });
      try {
        expect(snapshotQueryResult(read.eager.value)).toEqual([null, {
          n: 2,
        }]);
        const lazy = read.lazy.value as ({ n: number } | null)[];
        expect(lazy[1]).toEqual({ n: 2 });
        expect(() => lazy[0]!.n).toThrow();
        expect(isSchemaMismatchError(read.lazy.tx.takeSchemaRefusal())).toBe(
          true,
        );
      } finally {
        await read.commit();
      }
    });

    it("voids an array no element can satisfy eagerly, and refuses it where touched lazily", async () => {
      // `items: false` is what the schema generator emits for a `never[]`, the
      // type a bare `[]` literal infers. An eager read voids the whole array and
      // drops the property; a view validates at the container what the
      // container read shows and refuses at whichever element the reader
      // touches — an `items` schema is not evaluated ahead of the elements,
      // however little there is to evaluate. An empty array satisfies it in
      // both modes.
      const write = runtime.edit();
      runtime.getCell(space, "never-items", undefined, write).setRaw({
        tags: [1],
        none: [],
      });
      await write.commit();
      const read = readBothWays("never-items", {
        type: "object",
        properties: {
          tags: { type: "array", items: false },
          none: { type: "array", items: false },
        },
      });
      try {
        expect(snapshotQueryResult(read.eager.value)).toEqual({ none: [] });
        const lazy = read.lazy.value as { tags: unknown[]; none: unknown[] };
        expect(lazy.tags.length).toBe(1);
        expect(() => lazy.tags[0]).toThrow();
        expect(isSchemaMismatchError(read.lazy.tx.takeSchemaRefusal())).toBe(
          true,
        );
        expect(snapshotQueryResult(lazy.none)).toEqual([]);
      } finally {
        await read.commit();
      }
    });

    it("runs a reader over an untouched mismatch lazily, and not eagerly", async () => {
      const write = runtime.edit();
      runtime.getCell(space, "untouched", undefined, write).setRaw({
        count: 1,
        box: { n: "bad" },
      });
      await write.commit();
      const read = readBothWays("untouched", {
        type: "object",
        properties: {
          count: { type: "number" },
          box: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
        required: ["count", "box"],
      });
      try {
        expect(read.eager.value).toBeUndefined();
        expect((read.lazy.value as { count: number }).count).toBe(1);
        expect(read.lazy.tx.takeSchemaRefusal()).toBeUndefined();
      } finally {
        await read.commit();
      }
    });
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
  describe("a union the reader declares over a link that carries its own schema", () => {
    // The link's schema lands on the selector; the reader's union survives
    // only in the schema the view is given. Each row names the keys the read
    // yields, or `undefined` where the union rejects the value, and asserts the
    // eager read yields them and the lazy read agrees, whether or not the link
    // carries a schema. The link's own schema names every key, so the reader's
    // union decides alone: a closed record admits its named key and drops the
    // rest; a branch whose required child is invalid fails; two matching
    // `oneOf` branches reject; an `allOf` part's failure fails the whole.

    const target = {
      type: "object",
      properties: {
        id: { type: "string" },
        driver: { type: "string" },
        n: { type: "number" },
      },
    } as JSONSchema;
    const record = (
      properties: Record<string, JSONSchema>,
      required?: readonly string[],
      rest?: Record<string, unknown>,
    ): JSONSchema =>
      ({
        type: "object",
        properties,
        ...(required === undefined ? {} : { required }),
        ...(rest ?? {}),
      }) as JSONSchema;
    const rows: Array<[string, JSONSchema, readonly string[] | undefined]> = [
      [
        "an `anyOf` of a closed record and `null`",
        {
          anyOf: [
            record({ id: { type: "string" } }, undefined, {
              additionalProperties: false,
            }),
            { type: "null" },
          ],
        },
        ["id"],
      ],
      [
        "an `anyOf` whose branches each match only part of the value",
        {
          anyOf: [
            record({ id: { type: "string" }, n: { type: "string" } }, [
              "id",
              "n",
            ]),
            record({ driver: { type: "string" }, id: { type: "number" } }, [
              "driver",
              "id",
            ]),
          ],
        },
        undefined,
      ],
      [
        "an overlapping `oneOf`",
        {
          oneOf: [
            record({ id: { type: "string" } }, ["id"]),
            record({ driver: { type: "string" } }, ["driver"]),
          ],
        },
        undefined,
      ],
      [
        "a closed record beside an `allOf` naming a key",
        {
          type: "object",
          additionalProperties: false,
          allOf: [record({ id: { type: "string" } })],
        },
        ["id"],
      ],
      [
        "an `allOf` with a part whose required child is invalid",
        {
          allOf: [
            record({ id: { type: "string" } }),
            record({ n: { type: "string" } }, ["n"]),
          ],
        },
        undefined,
      ],
    ];

    const keysOrValue = (value: unknown): unknown =>
      value !== null && typeof value === "object"
        ? Object.keys(value as object)
        : value;

    for (const [index, [shape, union, expectedKeys]] of rows.entries()) {
      for (const carries of [false, true]) {
        it(`agrees with an eager read under ${shape}, the link ${carries ? "carrying" : "without"} a schema`, async () => {
          const write = runtime.edit();
          const linked = runtime.getCell<Record<string, unknown>>(
            space,
            `union-target-${index}-${carries}`,
            target,
            write,
          );
          linked.set({ id: "a", driver: "x", n: 1 });
          runtime.getCell<Record<string, unknown>>(
            space,
            `union-holder-${index}-${carries}`,
            undefined,
            write,
          ).setRaw({
            p: carries
              ? linked.getAsLink({ includeSchema: true })
              : linked.getAsLink(),
          });
          await write.commit();
          const reader = {
            type: "object",
            properties: { p: union },
          } as JSONSchema;
          const read = (lazy: boolean) => {
            const tx = runtime.edit();
            if (lazy) tx.markLazyMaterialize(true);
            const value = runtime.getCell<{ p?: unknown }>(
              space,
              `union-holder-${index}-${carries}`,
              reader,
              tx,
            ).get();
            return { tx, p: keysOrValue(value?.p) };
          };
          const eager = read(false);
          const lazy = read(true);
          try {
            expect(eager.p).toEqual(expectedKeys);
            expect(lazy.p).toEqual(eager.p);
          } finally {
            await eager.tx.commit();
            await lazy.tx.commit();
          }
        });
      }
    }
  });

  describe("a union the value's type settles, with keywords beside it", () => {
    it("keeps the selected branch's shape under a `description` and a `default` beside the union", async () => {
      // The keywords beside the union ride under the selected branch the way
      // traversal merges them, shallowly. A `description` there is not an
      // internal keyword, so a strict intersection would take the outer side
      // for a shaped reader and drop the branch — and the view would then
      // select none of the branch's properties.
      const write = runtime.edit();
      runtime.getCell<Record<string, unknown>>(
        space,
        "described-union",
        undefined,
        write,
      ).set({ p: { kind: "agent", name: "Sol" } });
      await write.commit();
      const reader = {
        type: "object",
        properties: {
          p: {
            anyOf: [{ $ref: "#/$defs/Author" }, { type: "undefined" }],
            description: "Who filed it.",
            default: { kind: "person", name: "" },
          },
        },
        $defs: {
          Author: {
            type: "object",
            properties: { kind: { type: "string" }, name: { type: "string" } },
            required: ["kind", "name"],
          },
        },
      } as JSONSchema;
      const read = (lazy: boolean) => {
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const value = runtime.getCell<{ p?: { kind?: string; name?: string } }>(
          space,
          "described-union",
          reader,
          tx,
        ).get();
        return { tx, kind: value.p?.kind, name: value.p?.name };
      };
      const eager = read(false);
      const lazy = read(true);
      try {
        expect(eager.kind).toBe("agent");
        expect(lazy.kind).toBe("agent");
        expect(lazy.name).toBe(eager.name);
      } finally {
        await eager.tx.commit();
        await lazy.tx.commit();
      }
    });
  });

  describe("a union around a list", () => {
    // `Row[] | null` over an array: the type alone selects the array branch,
    // so the view stays lazy and `rows.length` reads the container and nothing
    // below it — the same reads as `Row[]`.

    const row = {
      type: "object",
      properties: { id: { type: "string" }, n: { type: "number" } },
    } as JSONSchema;
    const rowCount = 300;

    const readsOf = async (rows: JSONSchema): Promise<string[]> => {
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell<{ rows: { id: string }[] }>(
          space,
          "list-holder",
          { type: "object", properties: { rows } } as JSONSchema,
          tx,
        ).get();
        expect(value.rows.length).toBe(rowCount);
        return [...(getTransactionReadActivities(tx) ?? [])].map((activity) =>
          `${activity.id}/${activity.path.join("/")}`
        );
      } finally {
        await tx.commit();
      }
    };

    it("reads `rows.length` under `Row[] | null` with the reads of `Row[]`", async () => {
      const write = runtime.edit();
      const links: FabricValue[] = [];
      for (let i = 0; i < rowCount; i++) {
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          `list-row-${i}`,
          row,
          write,
        );
        cell.set({ id: `r${i}`, n: i });
        links.push(cell.getAsLink({ includeSchema: true }));
      }
      runtime.getCell<Record<string, unknown>>(
        space,
        "list-holder",
        undefined,
        write,
      ).setRaw({ rows: links });
      await write.commit();

      const plain = await readsOf({ type: "array", items: row } as JSONSchema);
      const nullable = await readsOf(
        {
          anyOf: [{ type: "array", items: row }, { type: "null" }],
        } as JSONSchema,
      );
      expect(nullable).toEqual(plain);
      expect(plain.length).toBeLessThan(rowCount);
    });
  });
});
