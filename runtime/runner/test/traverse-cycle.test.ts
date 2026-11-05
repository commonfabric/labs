import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  CompoundCycleTracker,
  createDefaultTraversalContext,
  IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

// These tests pin down the cycle-detection fallback in the traverser. When a
// value is reachable from itself, the traversal of a property eventually visits
// the same value that an enclosing call is still traversing. `tracker.include`
// returns null for that re-entrant visit, and the traverser returns the
// partially built result already registered for it instead of recursing.
// Without that fallback the traversal would recurse forever and overflow the
// stack, so a passing assertion is itself evidence the branch was taken.

const TYPE = "application/json" as const;
const SPACE = "did:null:null";

// The acting identity traversal tracker keys resolve scoped addresses
// against (stage E).
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

function getTraverser(
  store: Map<string, Revision<State>>,
  selector: SchemaPathSelector,
): SchemaObjectTraverser<FabricValue> {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  return new SchemaObjectTraverser(
    tx,
    selector,
    createDefaultTraversalContext(TEST_SCOPE_IDENTITY),
  );
}

function storeWith(
  docUri: URI,
  value: FabricValue,
): Map<string, Revision<State>> {
  const store = new Map<string, Revision<State>>();
  const entity = docUri as Entity;
  store.set(`${entity}/${TYPE}`, {
    the: TYPE,
    of: entity,
    is: { value },
    since: 1,
  });
  return store;
}

function topDoc(docUri: URI, value: FabricValue): IMemorySpaceValueAttestation {
  return {
    address: { space: SPACE, id: docUri, type: TYPE, path: ["value"] },
    value,
  };
}

describe("SchemaObjectTraverser cycle fallback (traverseDAG, true schema)", () => {
  it("returns the in-progress record for a self-referential object", () => {
    const docUri = "of:cycle-dag-object" as URI;
    // A record reachable from itself: obj.self === obj.
    const obj: Record<string, unknown> = { name: "root" };
    obj.self = obj;
    const value = obj as unknown as FabricValue;

    // Confirm the tracker selects the fallback for this value: a second
    // include of the same value with the same schema returns null.
    const tracker = new CompoundCycleTracker<
      FabricValue,
      JSONSchema | undefined
    >();
    expect(tracker.include(value as FabricValue, true)).not
      .toBeNull();
    expect(tracker.include(value as FabricValue, true)).toBeNull();

    const store = storeWith(docUri, value);
    const traverser = getTraverser(store, { path: ["value"], schema: true });
    const { ok: result } = traverser.traverse(topDoc(docUri, value));

    const record = result as Record<string, unknown>;
    expect(record.name).toBe("root");
    // The self property resolved to the already-tracked partial result rather
    // than recursing, so it points back at the result object.
    expect(record.self).toBe(record);
  });

  it("returns the in-progress array for a self-referential array", () => {
    const docUri = "of:cycle-dag-array" as URI;
    // An array reachable from itself: arr[1] === arr.
    const arr: unknown[] = ["root"];
    arr.push(arr);
    const value = arr as unknown as FabricValue;

    const store = storeWith(docUri, value);
    const traverser = getTraverser(store, { path: ["value"], schema: true });
    const { ok: result } = traverser.traverse(topDoc(docUri, value));

    const out = result as unknown[];
    expect(out[0]).toBe("root");
    expect(out[1]).toBe(out);
  });
});

describe("SchemaObjectTraverser cycle fallback (schema traversal)", () => {
  it("returns the in-progress record for a recursive object schema", () => {
    const docUri = "of:cycle-schema-object" as URI;
    const obj: Record<string, unknown> = { name: "root" };
    obj.self = obj;
    const value = obj as unknown as FabricValue;

    const schema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            name: { type: "string" },
            self: { $ref: "#/$defs/Node" },
          },
        },
      },
    } as JSONSchema;

    const store = storeWith(docUri, value);
    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse(topDoc(docUri, value));

    const record = result as Record<string, unknown>;
    expect(record.name).toBe("root");
    expect(record.self).toBe(record);
  });

  it("returns the in-progress array for a link cycle back to the array", () => {
    // The runtime represents re-entrant structures with links rather than
    // direct object cycles. Here the array's single element is a link back to
    // the array's own value root, so following it re-enters the same array
    // value while its enclosing schema traversal is still in progress.
    const docUri = "of:cycle-schema-array-link" as URI;
    const selfLink = {
      "/": { [LINK_V1_TAG]: { id: docUri, path: [], space: SPACE } },
    };
    const arr: unknown[] = [selfLink];
    const value = arr as unknown as FabricValue;

    const schema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "array",
          items: { $ref: "#/$defs/Node" },
        },
      },
    } as JSONSchema;

    const store = storeWith(docUri, value);
    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse(topDoc(docUri, value));

    const out = result as unknown[];
    // The element followed the link back to the array and resolved to the
    // already-tracked partial array rather than recursing forever.
    expect(out[0]).toBe(out);
  });
});
