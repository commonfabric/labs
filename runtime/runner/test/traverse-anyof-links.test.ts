/**
 * How `SchemaObjectTraverser` walks an `anyOf` position whose value is a link:
 * the options are narrowed against the value the link resolves to, so the
 * target is traversed under the options that can match it and no others. Each
 * case that states what narrowing leaves alone runs the same walk with
 * narrowing off and compares the two.
 */

import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import type {
  Entity,
  MemorySpace,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import { describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";
import { UI } from "../src/shared.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const SPACE = "did:null:null" as MemorySpace;
const TYPE = "application/json" as const;
const ROOT = "of:root" as URI;

/** A link to the root of document `id`, or to `path` within it. */
const link = (id: string, path: string[] = []): FabricValue => ({
  "/": { [LINK_V1_TAG]: { id, path } },
});

/** A store holding each of `docs` under its id. */
function storeOf(
  docs: Record<string, FabricValue>,
): Map<string, Revision<State>> {
  const store = new Map<string, Revision<State>>();
  for (const [id, value] of Object.entries(docs)) {
    store.set(`${id}/${TYPE}`, {
      the: TYPE,
      of: id as Entity,
      is: { value },
      since: 1,
    });
  }
  return store;
}

/** What one walk of the root document did. */
type Walk = {
  /** The traversal's result, or its failure's code. */
  result: FabricValue;

  /** How many positions the traversal began. */
  traversals: number;

  /** How many `anyOf` options the traversal considered. */
  options: number;

  /** How many of those it rejected without traversing the value under them. */
  rejects: number;

  /** The documents the traversal recorded in its schema tracker, sorted. */
  reached: string[];

  /** The addresses the traversal read, sorted and without repeats. */
  reads: string[];
};

/**
 * Walks the root document of `docs` under `schema`, as a query does with
 * `traverseCells` set and as a cell read does without it.
 */
function walk(
  docs: Record<string, FabricValue>,
  schema: JSONSchema,
  options: { traverseCells?: boolean; narrows?: boolean } = {},
): Walk {
  const { traverseCells = true, narrows = true } = options;
  const tracker = new MapSetStringToPathSelectors(true);
  const tx = new ExtendedStorageTransaction(
    new ManagedStorageTransaction(new StoreObjectManager(storeOf(docs))),
  );
  const reads = new Set<string>();
  const read = tx.read.bind(tx);
  tx.read = (address, readOptions) => {
    reads.add(`${address.id}/${address.path.join("/")}`);
    return read(address, readOptions);
  };
  const traverser = new SchemaObjectTraverser(
    tx,
    { path: ["value"], schema },
    createDefaultTraversalContext(
      { principal: "did:test:alice", sessionId: "session-1" },
      traverseCells,
      tracker,
    ),
  );
  if (!narrows) traverser.accessForTestingOnly.narrowsReachedValues = false;
  const { ok, error } = traverser.traverseWithSchema({
    address: { space: SPACE, id: ROOT, type: TYPE, path: ["value"] },
    value: docs[ROOT],
  }, schema);
  return {
    result: error === undefined ? ok : `failed: ${error.code}`,
    traversals: traverser.traverseWithSchemaCalls,
    options: traverser.anyOfBranches,
    rejects: traverser.anyOfFastRejects,
    reached: [...new Set([...tracker].map(([key]) => key))].sort(),
    reads: [...reads].sort(),
  };
}

/** A VDOM element named `name` holding `children`. */
const element = (name: string, children: FabricValue[] = []): FabricValue => ({
  type: "vnode",
  name,
  props: {},
  children,
});

/**
 * Checks that the walk of `docs` under `schema` returns the same result,
 * reaches the same documents and reads the same addresses with narrowing on
 * as with it off, and returns the narrowed walk.
 */
function expectSameWalk(
  docs: Record<string, FabricValue>,
  schema: JSONSchema,
  traverseCells = true,
): Walk {
  const narrowed = walk(docs, schema, { traverseCells });
  const plain = walk(docs, schema, { traverseCells, narrows: false });
  expect(narrowed.result).toEqual(plain.result);
  expect(narrowed.reached).toEqual(plain.reached);
  expect(narrowed.reads).toEqual(plain.reads);
  return narrowed;
}

describe("traverse-anyof-links", () => {
  describe("a VDOM tree whose children are documents of their own", () => {
    const docs = {
      [ROOT]: element("div", [
        link("of:child-a"),
        link("of:child-b"),
        link("of:text"),
      ]),
      "of:child-a": element("span", [link("of:grandchild")]),
      "of:child-b": element("p"),
      "of:grandchild": element("b"),
      "of:text": "hello",
    };

    it("traverses each linked child under one option", () => {
      const { options, rejects } = walk(docs, rendererVDOMSchema);
      // The root and four linked children are each one position under the
      // eight options of `vdomRenderNode`, and each matches one of them.
      expect(options - rejects).toBe(5);
    });

    it("begins fewer positions than a walk that narrows no linked value", () => {
      const narrowed = walk(docs, rendererVDOMSchema);
      const plain = walk(docs, rendererVDOMSchema, { narrows: false });
      // Without narrowing each linked child is traversed under every one of
      // the eight options, which all declare the handle its array gives it.
      expect(plain.options - plain.rejects).toBe(1 + 4 * 8);
      expect(plain.traversals).toBe(54);
      expect(narrowed.traversals).toBe(26);
    });

    it("returns, reaches and reads what a walk without narrowing does", () => {
      const { reached } = expectSameWalk(docs, rendererVDOMSchema);
      expect(reached.map((key) => key.split("/").at(-1))).toEqual([
        "of:child-a",
        "of:child-b",
        "of:grandchild",
        "of:text",
      ]);
    });
  });

  describe("a linked value of each kind `vdomRenderNode` admits", () => {
    // An array's element is resolved before its `anyOf` is walked, and a
    // property's is not, so the two reach the narrowing by different routes.
    const inProperty = internSchema({
      $defs: rendererVDOMSchema.$defs,
      type: "object",
      properties: { child: { $ref: "#/$defs/vdomRenderNode" } },
      required: ["child"],
    });

    for (
      const [kind, child, matching] of [
        ["an element", element("span"), 1],
        ["a renderable object", { [UI]: element("span"), title: "piece" }, 1],
        ["a string", "text", 1],
        ["a number", 7, 1],
        ["a boolean", true, 1],
        ["`null`", null, 1],
        ["an array", [element("i"), "text"], 1],
      ] as const
    ) {
      it(`matches ${kind} held by an array as a walk without narrowing does`, () => {
        const docs = {
          [ROOT]: element("div", [link("of:child")]),
          "of:child": child as FabricValue,
        };
        const { result, reached } = expectSameWalk(docs, rendererVDOMSchema);
        expect(typeof result).not.toBe("string");
        expect(reached.some((key) => key.endsWith("of:child"))).toBe(true);
      });

      for (const traverseCells of [true, false]) {
        it(`traverses ${kind} held by a property under one option with traverseCells ${traverseCells}`, () => {
          const docs = {
            [ROOT]: { child: link("of:child") },
            "of:child": child as FabricValue,
          };
          const narrowed = expectSameWalk(docs, inProperty, traverseCells);
          const plain = walk(docs, inProperty, {
            traverseCells,
            narrows: false,
          });
          expect(typeof narrowed.result).not.toBe("string");
          // The options of the position itself, apart from those of the
          // `anyOf` positions inside the child.
          const inside = walk({ [ROOT]: child as FabricValue }, {
            $defs: rendererVDOMSchema.$defs,
            $ref: "#/$defs/vdomRenderNode",
          }, { traverseCells });
          expect(
            (narrowed.options - narrowed.rejects) -
              (inside.options - inside.rejects),
          ).toBe(matching - 1);
          expect(plain.options - plain.rejects).toBeGreaterThan(
            narrowed.options - narrowed.rejects,
          );
        });
      }
    }

    it("walks a renderable object's `[UI]` under one option", () => {
      const docs = {
        [ROOT]: element("div", [link("of:child")]),
        "of:child": { [UI]: element("span", [link("of:deep")]) },
        "of:deep": element("b"),
      };
      const narrowed = walk(docs, rendererVDOMSchema);
      const plain = walk(docs, rendererVDOMSchema, { narrows: false });
      // `vdomNode` requires `type` and `name`, which the renderable object
      // lacks, so only `vdomRenderableObject` descends into `[UI]`.
      expect(narrowed.traversals).toBeLessThan(plain.traversals);
      expect(narrowed.reached).toEqual(plain.reached);
    });
  });

  describe("a link that resolves to no value", () => {
    it("fails as a walk without narrowing does where no option admits it", () => {
      const schema: JSONSchema = internSchema<JSONSchema>({
        type: "object",
        properties: {
          child: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["child"],
      });
      const docs = { [ROOT]: { child: link("of:missing") } };
      const { result } = expectSameWalk(docs, schema, false);
      expect(result).toBe("failed: INVALID_OBJECT");
    });

    it("matches the option that admits `undefined`", () => {
      const schema: JSONSchema = internSchema<JSONSchema>({
        type: "object",
        properties: {
          child: { anyOf: [{ type: "string" }, { type: "undefined" }] },
        },
      });
      const docs = { [ROOT]: { child: link("of:missing") } };
      const { result, rejects } = expectSameWalk(docs, schema, false);
      expect(result).toEqual({ child: undefined });
      // Nothing is known of the target, so no option is rejected for it.
      expect(rejects).toBe(0);
    });

    it("matches an absent array element as a walk without narrowing does", () => {
      const docs = { [ROOT]: element("div", [link("of:missing")]) };
      const { result } = expectSameWalk(docs, rendererVDOMSchema);
      expect(typeof result).not.toBe("string");
    });
  });

  describe("a link through another link", () => {
    it("narrows against the value at the end of the chain", () => {
      const docs = {
        [ROOT]: element("div", [link("of:hop")]),
        "of:hop": link("of:child"),
        "of:child": element("span"),
      };
      const { options, rejects, reached, reads } = expectSameWalk(
        docs,
        rendererVDOMSchema,
      );
      expect(options - rejects).toBe(2);
      expect(reached.map((key) => key.split("/").at(-1))).toEqual([
        "of:child",
        "of:hop",
      ]);
      expect(reads).toContain("of:hop/value");
    });

    it("narrows against a value inside the target document", () => {
      const docs = {
        [ROOT]: element("div", [link("of:holder", ["slot"])]),
        "of:holder": { slot: "text" },
      };
      const { options, rejects } = expectSameWalk(docs, rendererVDOMSchema);
      expect(options - rejects).toBe(2);
    });
  });

  describe("a link that carries a schema", () => {
    const schema: JSONSchema = internSchema<JSONSchema>({
      type: "object",
      properties: {
        child: {
          anyOf: [
            { type: "string" },
            { type: "object", properties: { a: { type: "number" } } },
            {},
          ],
        },
      },
    });
    const docs = {
      [ROOT]: {
        child: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:child",
              path: [],
              schema: { type: "object", properties: { b: { type: "number" } } },
            },
          },
        },
      },
      "of:child": { a: 1, b: 2 },
    };

    for (const traverseCells of [true, false]) {
      it(`narrows by each option's schema combined with the link's with traverseCells ${traverseCells}`, () => {
        const { result, rejects } = expectSameWalk(docs, schema, traverseCells);
        // The empty option takes the link's schema, and is not rejected. A
        // read mints a handle for it, which the comparison above covers.
        if (traverseCells) expect(result).toEqual({ child: { a: 1, b: 2 } });
        expect(rejects).toBe(1);
      });
    }
  });

  describe("a linked value more than one option matches", () => {
    const schema: JSONSchema = internSchema<JSONSchema>({
      type: "object",
      properties: {
        child: {
          anyOf: [
            { type: "object", properties: { a: { type: "number" } } },
            { type: "object", properties: { b: { type: "number" } } },
            { type: "string" },
          ],
        },
      },
    });
    const docs = {
      [ROOT]: { child: link("of:child") },
      "of:child": { a: 1, b: 2 },
    };

    for (const traverseCells of [true, false]) {
      it(`merges every match with traverseCells ${traverseCells}`, () => {
        const { result, options, rejects } = expectSameWalk(
          docs,
          schema,
          traverseCells,
        );
        expect(result).toEqual({ child: { a: 1, b: 2 } });
        expect(options - rejects).toBe(2);
      });
    }
  });

  describe("an option the linked value fails only without its defaults", () => {
    it("matches where a required property takes its default", () => {
      const schema: JSONSchema = internSchema<JSONSchema>({
        type: "object",
        properties: {
          child: {
            anyOf: [
              {
                type: "object",
                properties: { count: { type: "number", default: 3 } },
                required: ["count"],
              },
              { type: "string" },
            ],
          },
        },
        required: ["child"],
      });
      const docs = { [ROOT]: { child: link("of:child") }, "of:child": {} };
      const { result } = expectSameWalk(docs, schema, false);
      expect(result).toEqual({ child: { count: 3 } });
    });
  });

  describe("an `anyOf` that is not interned", () => {
    it("narrows a linked value as the interned form does", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          child: {
            anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
          },
        },
      };
      const docs = { [ROOT]: { child: link("of:child") }, "of:child": "text" };
      const { result, options, rejects } = expectSameWalk(docs, schema, false);
      expect(result).toEqual({ child: "text" });
      expect(options - rejects).toBe(1);
    });
  });

  describe("an option that declares a handle", () => {
    const schema: JSONSchema = internSchema<JSONSchema>({
      type: "object",
      properties: {
        child: {
          anyOf: [
            { type: "string" },
            { type: "number", asCell: ["cell"] },
            { type: "object", asCell: ["opaque"] },
          ],
        },
      },
    });
    const docs = { [ROOT]: { child: link("of:child") }, "of:child": "text" };

    it("is narrowed by a walk that traverses through the handle", () => {
      const { options, rejects } = expectSameWalk(docs, schema, true);
      // The `cell` option is walked through and so rejected for its type;
      // the opaque one is never followed, and stays.
      expect(options - rejects).toBe(2);
    });

    it("is kept by a walk that mints the handle without following it", () => {
      const { options, rejects } = expectSameWalk(docs, schema, false);
      expect(rejects).toBe(0);
      expect(options).toBe(3);
    });
  });

  describe("a link no option follows", () => {
    it("reads nothing of a target in another space", () => {
      const schema: JSONSchema = internSchema<JSONSchema>({
        type: "object",
        properties: {
          child: { anyOf: [{ type: "unknown" }, { asCell: ["opaque"] }] },
        },
      });
      const docs = {
        [ROOT]: {
          child: {
            "/": {
              [LINK_V1_TAG]: {
                id: "of:child",
                path: [],
                space: "did:null:other",
              },
            },
          },
        },
        "of:child": "text",
      };
      const { reads } = expectSameWalk(docs, schema, false);
      expect(reads.filter((read) => read.startsWith("of:child"))).toEqual([]);
    });
  });

  describe("oneOf", () => {
    it("traverses a linked value under every option", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          child: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
      };
      const docs = { [ROOT]: { child: link("of:child") }, "of:child": "text" };
      const { result, rejects } = expectSameWalk(docs, schema, false);
      expect(result).toEqual({ child: "text" });
      expect(rejects).toBe(0);
    });
  });
});
