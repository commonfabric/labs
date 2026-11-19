import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  CompoundCycleTracker,
  createTraversalContext,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const IDENTITY = { principal: "did:test:alice", sessionId: "session-1" };
const TYPE = "application/json" as const;
const SPACE = "did:null:null";
const ID = "of:doc-schema-forms" as URI;

/** A read-path traverser (`traverseCells` off) over one document. */
const readTraverser = (
  value: FabricValue,
): SchemaObjectTraverser<FabricValue> => {
  const store = new Map<string, Revision<State>>();
  store.set(`${ID}/${TYPE}`, {
    the: TYPE,
    of: ID as Entity,
    is: { value },
    since: 1,
  });
  const tx = new ExtendedStorageTransaction(
    new ManagedStorageTransaction(new StoreObjectManager(store)),
  );
  return new SchemaObjectTraverser(
    tx,
    { path: ["value"], schema: true },
    createTraversalContext(
      new CompoundCycleTracker<FabricValue, JSONSchema | undefined>(),
      new MapSetStringToPathSelectors(true),
      IDENTITY,
      false,
    ),
  );
};

const docAt = (value: FabricValue): IMemorySpaceValueAttestation => ({
  address: { space: SPACE, id: ID, type: TYPE, path: ["value"] },
  value,
});

describe("traverse", () => {
  describe("SchemaObjectTraverser", () => {
    describe("traverseWithSchema()", () => {
      describe("given a schema object that is its own `items`", () => {
        // The schema is a plain `{ type, items }` pair, the shape the read
        // path compiles into a plan, and its `items` loops back to itself.

        const selfItems = (): JSONSchema => {
          const schema: { type: "array"; items?: JSONSchema } = {
            type: "array",
          };
          schema.items = schema;
          return schema;
        };

        it("returns nested arrays of any depth", () => {
          const value = [[[]], []] as FabricValue;

          expect(
            readTraverser(value).traverseWithSchema(
              docAt(value),
              selfItems(),
            ),
          ).toEqual({ ok: [[[]], []] });
        });

        it("fails an array holding a string", () => {
          const value = [["x"]] as FabricValue;

          const result = readTraverser(value).traverseWithSchema(
            docAt(value),
            selfItems(),
          );

          expect(result.ok).toBeUndefined();
          expect(result.error?.code).toBe("INVALID_ARRAY");
        });
      });
    });
  });
});
