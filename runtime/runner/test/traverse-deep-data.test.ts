/**
 * How `SchemaObjectTraverser` reads data deeper than the JavaScript stack
 * would hold if each level of the data took frames of its own: a chain of
 * documents each linking to the next, one document nested thousands of
 * levels deep under a recursive union, and a chain of links each naming the
 * next link.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import type {
  Entity,
  MemorySpace,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  getAtPath,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const SPACE = "did:null:null" as MemorySpace;

const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

/**
 * How many documents a chain holds, and how many levels a nested document
 * holds: far more than a traversal taking stack frames for each would reach.
 */
const CHAIN_LENGTH = 10_000;
const NESTING_DEPTH = 3_000;

const linkTo = (id: string, path: string[] = []) => ({
  "/": { [LINK_V1_TAG]: { id, path } },
});

/** A store holding `values` by document id. */
const storeOf = (values: Map<string, FabricValue>) => {
  const store = new Map<string, Revision<State>>();
  for (const [id, value] of values) {
    store.set(`${id}/application/json`, {
      the: "application/json",
      of: id as Entity,
      is: { value },
      since: 1,
    });
  }
  return store;
};

/** A traversal context, transaction and traverser reading `store`. */
const readerOf = (store: Map<string, Revision<State>>, schema: JSONSchema) => {
  const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
  const tx = new ExtendedStorageTransaction(
    new ManagedStorageTransaction(new StoreObjectManager(store)),
  );
  const traverser = new SchemaObjectTraverser(
    tx,
    { path: ["value"], schema },
    context,
  );
  return { context, traverser, tx };
};

/** Document `id` of `values`, as a traversal starts from it. */
const attestationOf = (
  values: Map<string, FabricValue>,
  id: string,
): IMemorySpaceValueAttestation => ({
  address: {
    space: SPACE,
    id: id as URI,
    type: "application/json",
    path: ["value"],
  },
  value: values.get(id),
});

/** Reads document `id` of `values` under `schema`. */
const read = (
  values: Map<string, FabricValue>,
  id: string,
  schema: JSONSchema,
) =>
  readerOf(storeOf(values), schema).traverser.traverse(
    attestationOf(values, id),
  );

/** A node of a chain: a label and the node after it, recursively. */
const chainNode: JSONSchema = {
  $defs: {
    Node: {
      type: "object",
      properties: {
        label: { type: "number" },
        next: { $ref: "#/$defs/Node" },
      },
      required: ["label"],
    },
  },
  $ref: "#/$defs/Node",
};

/**
 * `length` documents `of:chain-0` onward, each labeled with its index and
 * linking to the next; `last` says what the final one's `next` holds.
 */
const chainOf = (length: number, last?: FabricValue) => {
  const values = new Map<string, FabricValue>();
  for (let i = 0; i < length; i++) {
    const next = i + 1 < length ? linkTo(`of:chain-${i + 1}`) : last;
    values.set(
      `of:chain-${i}`,
      next === undefined ? { label: i } : { label: i, next },
    );
  }
  return values;
};

/** The labels of `value`, following `next` until it ends. */
const labelsOf = (value: FabricValue): number[] => {
  const labels: number[] = [];
  const seen = new Set<unknown>();
  let node = value as { label?: number; next?: FabricValue } | undefined;
  while (node !== undefined && !seen.has(node)) {
    seen.add(node);
    labels.push(node.label!);
    node = node.next as typeof node;
  }
  return labels;
};

/**
 * A tree whose every level is an object of one of two shapes, both reaching
 * the next level through `child`.
 */
const unionTree: JSONSchema = {
  $defs: {
    Tree: {
      anyOf: [
        {
          type: "object",
          properties: {
            a: { type: "string" },
            child: { $ref: "#/$defs/Tree" },
          },
          required: ["a"],
        },
        {
          type: "object",
          properties: {
            b: { type: "string" },
            child: { $ref: "#/$defs/Tree" },
          },
          required: ["b"],
        },
      ],
    },
  },
  $ref: "#/$defs/Tree",
};

/**
 * A value nested `depth` levels through `child`, alternating between the
 * union's two shapes, whose deepest level is `leaf`.
 */
const nestedOf = (depth: number, leaf: FabricValue) => {
  let value: FabricValue = leaf;
  for (let i = depth - 1; i >= 0; i--) {
    value = i % 2 === 0
      ? { a: `${i}`, child: value }
      : { b: `${i}`, child: value };
  }
  return value;
};

/** How many levels of `child` `value` holds below it. */
const depthOf = (value: FabricValue): number => {
  let depth = 0;
  let node = value as { child?: FabricValue };
  while (node.child !== undefined) {
    depth++;
    node = node.child as typeof node;
  }
  return depth;
};

describe("traverse", () => {
  describe("data deeper than the stack", () => {
    it("returns every document of a long chain of links", () => {
      const { ok, error } = read(
        chainOf(CHAIN_LENGTH),
        "of:chain-0",
        chainNode,
      );

      expect(error).toBeUndefined();
      const labels = labelsOf(ok!);
      expect(labels.length).toBe(CHAIN_LENGTH);
      expect(labels.at(-1)).toBe(CHAIN_LENGTH - 1);
    });

    it("drops the link to a document deep in a chain that the schema rejects", () => {
      const values = chainOf(CHAIN_LENGTH);
      values.set(`of:chain-${CHAIN_LENGTH / 2}`, { label: "not a number" });

      const { ok, error } = read(values, "of:chain-0", chainNode);

      expect(error).toBeUndefined();
      expect(labelsOf(ok!).length).toBe(CHAIN_LENGTH / 2);
    });

    it("returns a chain whose last document links back to the first as a cycle", () => {
      const { ok, error } = read(
        chainOf(CHAIN_LENGTH, linkTo("of:chain-0")),
        "of:chain-0",
        chainNode,
      );

      expect(error).toBeUndefined();
      expect(labelsOf(ok!).length).toBe(CHAIN_LENGTH);
      let node = ok as { next?: FabricValue };
      for (let i = 0; i < CHAIN_LENGTH; i++) node = node.next as typeof node;
      expect(node).toBe(ok);
    });

    it("returns every document of a long chain through array elements", () => {
      const values = new Map<string, FabricValue>();
      for (let i = 0; i < CHAIN_LENGTH; i++) {
        values.set(
          `of:chain-${i}`,
          i + 1 < CHAIN_LENGTH
            ? { label: i, rest: [linkTo(`of:chain-${i + 1}`)] }
            : { label: i, rest: [] },
        );
      }
      const listNode: JSONSchema = {
        $defs: {
          Node: {
            type: "object",
            properties: {
              label: { type: "number" },
              rest: { type: "array", items: { $ref: "#/$defs/Node" } },
            },
          },
        },
        $ref: "#/$defs/Node",
      };

      const { ok, error } = read(values, "of:chain-0", listNode);

      expect(error).toBeUndefined();
      let node = ok as { label: number; rest: FabricValue[] };
      let count = 1;
      while (node.rest.length > 0) {
        node = node.rest[0] as typeof node;
        count++;
      }
      expect(count).toBe(CHAIN_LENGTH);
      expect(node.label).toBe(CHAIN_LENGTH - 1);
    });

    it("throws an error raised at the end of a long chain, and traverses again afterwards", () => {
      const values = chainOf(CHAIN_LENGTH);
      // Schema traversal refuses a `FabricInstance` by throwing.
      values.set(`of:chain-${CHAIN_LENGTH - 1}`, {
        label: CHAIN_LENGTH - 1,
        failure: FabricError.fromNativeError(new Error("deep")),
      });
      values.set("of:other", { label: 7, next: linkTo("of:chain-0") });
      values.set("of:healthy", { label: 8 });
      const { context, traverser } = readerOf(storeOf(values), {
        $defs: {
          Node: {
            type: "object",
            properties: {
              next: { $ref: "#/$defs/Node" },
              failure: { type: "object" },
            },
          },
        },
        $ref: "#/$defs/Node",
      });

      expect(() =>
        traverser.traverse({
          address: {
            space: SPACE,
            id: "of:chain-0" as URI,
            type: "application/json",
            path: ["value"],
          },
          value: values.get("of:chain-0"),
        })
      ).toThrow("in schema traversal");
      expect(context.tracker.accessForTestingOnly.partial.size).toBe(0);

      // A second document reaching the same chain meets the same error, and a
      // document clear of it is traversed whole.
      const traverseFrom = (id: string) =>
        traverser.traverse({
          address: {
            space: SPACE,
            id: id as URI,
            type: "application/json",
            path: ["value"],
          },
          value: values.get(id),
        });
      expect(() => traverseFrom("of:other")).toThrow("in schema traversal");
      expect(context.tracker.accessForTestingOnly.partial.size).toBe(0);
      expect(traverseFrom("of:healthy")).toEqual({ ok: { label: 8 } });
    });

    it("returns every level of a document nested under a recursive union", () => {
      const values = new Map<string, FabricValue>([
        ["of:tree", nestedOf(NESTING_DEPTH, { a: "leaf" })],
      ]);

      const { ok, error } = read(values, "of:tree", unionTree);

      expect(error).toBeUndefined();
      expect(depthOf(ok!)).toBe(NESTING_DEPTH);
    });

    it("returns every level of a document nested under a recursive record schema", () => {
      const values = new Map<string, FabricValue>([
        ["of:tree", nestedOf(NESTING_DEPTH, { a: "leaf" })],
      ]);
      const tree: JSONSchema = {
        $defs: {
          Tree: {
            type: "object",
            properties: { child: { $ref: "#/$defs/Tree" } },
          },
        },
        $ref: "#/$defs/Tree",
      };

      const { ok, error } = read(values, "of:tree", tree);

      expect(error).toBeUndefined();
      expect(depthOf(ok!)).toBe(NESTING_DEPTH);
    });

    it("selects at every level of a deep document what a union whose branch comes back to it selects", () => {
      // `R` is `A` or `R` together with `B`. At each level the branch that
      // comes back to `R` matches only once `R` has, and then adds `b`, so
      // every level holds both `a` and `b`.
      const depth = 300;
      let value: FabricValue = { a: depth, b: depth };
      for (let i = depth - 1; i >= 0; i--) {
        value = { a: i, b: i, child: value };
      }
      const values = new Map<string, FabricValue>([["of:tree", value]]);
      const schema: JSONSchema = {
        $defs: {
          R: {
            anyOf: [{ $ref: "#/$defs/A" }, {
              allOf: [{ $ref: "#/$defs/R" }, {
                type: "object",
                properties: { b: { type: "number" } },
              }],
            }],
          },
          A: {
            type: "object",
            properties: {
              a: { type: "number" },
              child: { $ref: "#/$defs/R" },
            },
          },
        },
        $ref: "#/$defs/R",
      };

      const { ok, error } = read(values, "of:tree", schema);

      expect(error).toBeUndefined();
      let node = ok as { a?: number; b?: number; child?: FabricValue };
      for (let i = 0; i < depth; i++) {
        expect([node.a, node.b]).toEqual([i, i]);
        node = node.child as typeof node;
      }
      expect([node.a, node.b, node.child]).toEqual([depth, depth, undefined]);
    });

    it("rejects a deeply nested document whose deepest level matches no branch", () => {
      const values = new Map<string, FabricValue>([
        ["of:tree", nestedOf(NESTING_DEPTH, { c: "leaf" })],
      ]);

      const { ok, error } = read(values, "of:tree", unionTree);

      // The deepest level is dropped from the level above it, which still
      // matches, so the result is one level shorter.
      expect(error).toBeUndefined();
      expect(depthOf(ok!)).toBe(NESTING_DEPTH - 1);
    });

    it("returns every document of a long chain of cells to a cell read", async () => {
      // The read goes through the runtime's own read path, whose object
      // creator materializes each level as a cell read does.
      const signer = await Identity.fromPassphrase("traverse deep data");
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const tx = runtime.edit();
        let next: Cell<unknown> | undefined;
        for (let i = CHAIN_LENGTH - 1; i >= 0; i--) {
          const cell = runtime.getCell<unknown>(
            signer.did(),
            `deep-chain-${i}`,
            undefined,
            tx,
          );
          cell.set(next === undefined ? { label: i } : { label: i, next });
          next = cell;
        }
        await tx.commit().settled;

        const value = runtime.getCell(
          signer.did(),
          "deep-chain-0",
          chainNode,
        ).get();

        const labels = labelsOf(value as FabricValue);
        expect(labels.length).toBe(CHAIN_LENGTH);
        expect(labels.at(-1)).toBe(CHAIN_LENGTH - 1);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("resolves a long chain of links each naming the next link", () => {
      const values = new Map<string, FabricValue>();
      for (let i = 0; i < CHAIN_LENGTH; i++) {
        values.set(`of:alias-${i}`, linkTo(`of:alias-${i + 1}`));
      }
      values.set(`of:alias-${CHAIN_LENGTH}`, { label: "end" });
      const { context, tx } = readerOf(storeOf(values), true);

      const [doc] = getAtPath(
        tx,
        {
          address: {
            space: SPACE,
            id: "of:alias-0" as URI,
            type: "application/json",
            path: ["value"],
          },
          value: values.get("of:alias-0"),
        },
        ["label"],
        context,
      );

      expect(doc.address.id).toBe(`of:alias-${CHAIN_LENGTH}`);
      expect(doc.value).toBe("end");
    });

    it("resolves a long chain of links that ends back at its start to nothing", () => {
      const values = new Map<string, FabricValue>();
      for (let i = 0; i < CHAIN_LENGTH; i++) {
        values.set(
          `of:alias-${i}`,
          linkTo(`of:alias-${(i + 1) % CHAIN_LENGTH}`),
        );
      }
      const { context, tx } = readerOf(storeOf(values), true);

      const [doc] = getAtPath(
        tx,
        {
          address: {
            space: SPACE,
            id: "of:alias-0" as URI,
            type: "application/json",
            path: ["value"],
          },
          value: values.get("of:alias-0"),
        },
        ["label"],
        context,
      );

      expect(doc.value).toBeUndefined();
    });
  });

  describe("counting positions handed to the traversal's own stack", () => {
    /** A recursive record whose every level reaches the next through `child`. */
    const recordTree: JSONSchema = {
      $defs: {
        Tree: {
          type: "object",
          properties: { child: { $ref: "#/$defs/Tree" } },
        },
      },
      $ref: "#/$defs/Tree",
    };

    /**
     * A traverser that has read a document nested `depth` levels under
     * `schema`.
     */
    const traverserAfter = (depth: number, schema: JSONSchema) => {
      const values = new Map<string, FabricValue>([
        ["of:tree", nestedOf(depth, { a: "leaf" })],
      ]);
      const { traverser } = readerOf(storeOf(values), schema);
      const { ok } = traverser.traverse(attestationOf(values, "of:tree"));
      expect(depthOf(ok!)).toBe(depth);
      return traverser;
    };

    it("counts none for a document a few levels deep", () => {
      for (const schema of [unionTree, recordTree, true]) {
        expect(traverserAfter(5, schema).nativeDepthHandoffs).toBe(0);
      }
    });

    it("counts more for a document nested more levels past the native depth", () => {
      for (const schema of [unionTree, recordTree, true]) {
        const deep = traverserAfter(200, schema).nativeDepthHandoffs;
        const deeper = traverserAfter(400, schema).nativeDepthHandoffs;

        expect(deep).toBeGreaterThan(0);
        expect(deeper).toBeGreaterThan(deep);
      }
    });

    it("counts afresh for each traversal", () => {
      const values = new Map<string, FabricValue>([
        ["of:deep", nestedOf(200, { a: "leaf" })],
        ["of:shallow", nestedOf(5, { a: "leaf" })],
      ]);
      const { traverser } = readerOf(storeOf(values), unionTree);

      traverser.traverse(attestationOf(values, "of:deep"));
      expect(traverser.nativeDepthHandoffs).toBeGreaterThan(0);
      traverser.traverse(attestationOf(values, "of:shallow"));
      expect(traverser.nativeDepthHandoffs).toBe(0);
    });

    it("reports the count in the slow-traverse warning", () => {
      const values = new Map<string, FabricValue>([
        ["of:tree", nestedOf(200, { a: "leaf" })],
      ]);
      const { traverser } = readerOf(storeOf(values), unionTree);
      const doc = attestationOf(values, "of:tree");
      traverser.traverse(doc);
      const warnings: string[] = [];
      const savedWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        traverser.maybeReportSlowTraverse(Number.MAX_SAFE_INTEGER, doc);
      } finally {
        console.warn = savedWarn;
      }

      expect(traverser.nativeDepthHandoffs).toBeGreaterThan(0);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(
        `nativeDepthHandoffs=${traverser.nativeDepthHandoffs}`,
      );
    });
  });
});
