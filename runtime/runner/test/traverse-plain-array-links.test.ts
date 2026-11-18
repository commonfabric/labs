/**
 * How a traversal that does not walk cells follows the ordinary links an
 * array of objects holds after `cell.set()`: a link with no schema and no
 * path, into the array's own space and scope, read in one hop.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import type {
  Entity,
  MemorySpace,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
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
const ROOT = "of:plain-array-root" as URI;

const ITEMS: JSONSchema = {
  type: "array",
  items: { type: "object", properties: { n: { type: "number" } } },
};

const linkTo = (id: string) => ({
  "/": { [LINK_V1_TAG]: { id, path: [] } },
});

/**
 * Traverses `root`, stored under `ROOT`, with `ITEMS` beside the documents
 * `docs` gives as full stored values, and returns the result with the links
 * the traversal reported missing.
 */
function traverseArray(
  root: FabricValue[],
  docs: Record<string, FabricValue> = {},
) {
  const store = new Map<string, Revision<State>>();
  for (const [id, is] of Object.entries({ ...docs, [ROOT]: { value: root } })) {
    store.set(`${id}/${TYPE}`, { the: TYPE, of: id as Entity, is, since: 1 });
  }
  const missing: NormalizedFullLink[] = [];
  const traverser = new SchemaObjectTraverser(
    new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager(store)),
    ),
    { path: ["value"], schema: ITEMS },
    createDefaultTraversalContext(
      { principal: "did:test:alice", sessionId: "session-1" },
      false,
      new MapSetStringToPathSelectors(true),
      (link) => missing.push(link),
    ),
  );
  const result = traverser.traverse({
    address: {
      space: SPACE,
      id: ROOT,
      scope: "space",
      type: TYPE,
      path: ["value"],
    },
    value: root,
  });
  return { ...result, missing };
}

describe("traverse-plain-array-links", () => {
  it("reads each element through its link", () => {
    const { ok, missing } = traverseArray(
      [linkTo("of:item-a"), linkTo("of:item-b")],
      { "of:item-a": { value: { n: 1 } }, "of:item-b": { value: { n: 2 } } },
    );

    expect(ok).toEqual([{ n: 1 }, { n: 2 }]);
    expect(missing).toEqual([]);
  });

  it("reads each link of a sparse array, keeping its holes", () => {
    const sparse: FabricValue[] = [];
    sparse[1] = linkTo("of:item-a");
    sparse[3] = linkTo("of:item-b");
    const { ok } = traverseArray(sparse, {
      "of:item-a": { value: { n: 1 } },
      "of:item-b": { value: { n: 2 } },
    });

    expect(ok).toEqual([undefined, { n: 1 }, undefined, { n: 2 }]);
    expect(0 in (ok as FabricValue[])).toBe(false);
  });

  it("reports a link to a missing document with the element schema", () => {
    const sparse: FabricValue[] = [];
    sparse[1] = linkTo("of:item-missing");
    const { missing } = traverseArray(sparse);

    expect(missing).toEqual([{
      space: SPACE,
      id: "of:item-missing",
      path: [],
      scope: "space",
      schema: ITEMS.items,
    }]);
  });

  it("reports the one missing document among several links, and reads no array", () => {
    const { ok, missing } = traverseArray(
      [linkTo("of:item-a"), linkTo("of:item-gone"), linkTo("of:item-b")],
      { "of:item-a": { value: { n: 1 } }, "of:item-b": { value: { n: 2 } } },
    );

    expect(missing).toEqual([{
      space: SPACE,
      id: "of:item-gone",
      path: [],
      scope: "space",
      schema: ITEMS.items,
    }]);
    expect(ok).toBeUndefined();
  });

  it("reads as no value a link to a document whose stored form is not a record", () => {
    const sparse: FabricValue[] = [];
    sparse[1] = linkTo("of:item-scalar");
    const { ok, missing } = traverseArray(sparse, { "of:item-scalar": "text" });

    expect(ok).toBeUndefined();
    expect(missing).toEqual([]);
  });

  it("reports nothing for a link to a document that holds no value", () => {
    const sparse: FabricValue[] = [];
    sparse[1] = linkTo("of:item-empty");
    const { ok, missing } = traverseArray(sparse, { "of:item-empty": {} });

    expect(ok).toBeUndefined();
    expect(missing).toEqual([]);
  });
});
