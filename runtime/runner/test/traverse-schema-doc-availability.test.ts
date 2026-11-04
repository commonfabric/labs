import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { acquireSchemaRegistryLease } from "../src/schema-registry.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  CompoundCycleTracker,
  createTraversalContext,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  SchemaObjectTraverser,
  type TraversalContext,
} from "../src/traverse.ts";

// These tests pin the schema-document availability gate: a schema entering a
// traversal (the selector, a link) selects nothing unless every document its
// external refs name is loaded and verified in the referrer's space. The
// store is driven directly, below the commit boundary, because the states of
// interest — an absent document, a registry epoch ending between traversals
// — are exactly the ones a compliant writer cannot produce.

const TYPE = "application/json" as const;
const SPACE = "did:null:null";

const internHash = (schema: JSONSchema): string =>
  internSchema(schema, true).taggedHashString;

const addDoc = (
  store: Map<string, Revision<State>>,
  docUri: URI,
  value: FabricValue,
): void => {
  const entity = docUri as Entity;
  store.set(`${entity}/${TYPE}`, {
    the: TYPE,
    of: entity,
    is: { value },
    since: 1,
  });
};

const TEST_SCOPE_IDENTITY = {
  principal: "did:key:test-schema-doc-availability",
  sessionId: "session:test-schema-doc-availability",
} as const;

const topDoc = (
  docUri: URI,
  value: FabricValue,
): IMemorySpaceValueAttestation => ({
  address: { space: SPACE, id: docUri, type: TYPE, path: ["value"] },
  value,
});

const contextWith = (
  onMissingLinkTarget?: TraversalContext["onMissingLinkTarget"],
): TraversalContext =>
  createTraversalContext(
    new CompoundCycleTracker<FabricValue, JSONSchema | undefined>(),
    new MapSetStringToPathSelectors(true),
    TEST_SCOPE_IDENTITY,
    false,
    onMissingLinkTarget,
  );

// The map-backed store answers an absent document with an ok-and-undefined
// read; a real replica answers NotFoundError, which is the signal the
// missing-link-target channel keys on. This transaction restores that
// contract for absent `cid:` documents.
class NotFoundOnAbsentCid extends ExtendedStorageTransaction {
  override read(
    ...args: Parameters<ExtendedStorageTransaction["read"]>
  ): ReturnType<ExtendedStorageTransaction["read"]> {
    const result = super.read(...args);
    if (
      result.error === undefined &&
      (result.ok as { value?: unknown }).value === undefined &&
      String(args[0].id).startsWith("cid:")
    ) {
      return {
        error: { name: "NotFoundError", message: "no such document" },
      } as never;
    }
    return result;
  }
}

const traverserFor = (
  store: Map<string, Revision<State>>,
  schema: JSONSchema,
  context: TraversalContext,
  notFoundReads = false,
): SchemaObjectTraverser<FabricValue> => {
  const manager = new StoreObjectManager(store);
  const managed = new ManagedStorageTransaction(manager);
  const tx = notFoundReads
    ? new NotFoundOnAbsentCid(managed)
    : new ExtendedStorageTransaction(managed);
  return new SchemaObjectTraverser(tx, { path: ["value"], schema }, context);
};

describe("traverse", () => {
  describe("schema-document availability gate", () => {
    it("reports an absent schema document through the missing-link-target channel", () => {
      const absentHash = internHash({
        type: "string",
        title: "availability-absent-leaf",
      });
      const store = new Map<string, Revision<State>>();
      addDoc(store, "of:availability-target" as URI, { t: 1 } as FabricValue);
      const carrier = {
        x: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:availability-target",
              path: [],
              schema: { $ref: `cid:${absentHash}` },
            },
          },
        },
      } as unknown as FabricValue;
      addDoc(store, "of:availability-carrier" as URI, carrier);

      const missing: string[] = [];
      const context = contextWith((link) => missing.push(String(link.id)));
      const traverser = traverserFor(
        store,
        {
          type: "object",
          properties: {
            x: { type: "object", properties: { t: { type: "number" } } },
          },
        },
        context,
        true,
      );
      const { error } = traverser.traverse(
        topDoc("of:availability-carrier" as URI, carrier),
      );
      // The link selects nothing, the traversal itself completes, and the
      // absent document is reported for a fetch.
      expect(error).toBeUndefined();
      expect(missing).toContain(`cid:${absentHash}`);
    });

    it("meets a shared dependency once in the availability verdict", () => {
      const shared: JSONSchema = {
        type: "string",
        title: "verdict-diamond-shared",
      };
      const sharedHash = internHash(shared);
      const left: JSONSchema = {
        type: "object",
        properties: { s: { $ref: `cid:${sharedHash}` } },
        title: "verdict-diamond-left",
      };
      const leftHash = internHash(left);
      const right: JSONSchema = {
        type: "object",
        properties: { s: { $ref: `cid:${sharedHash}` } },
        title: "verdict-diamond-right",
      };
      const rightHash = internHash(right);

      const store = new Map<string, Revision<State>>();
      addDoc(store, `cid:${sharedHash}` as URI, shared as FabricValue);
      addDoc(store, `cid:${leftHash}` as URI, left as FabricValue);
      addDoc(store, `cid:${rightHash}` as URI, right as FabricValue);
      addDoc(
        store,
        "of:diamond-target" as URI,
        { a: {}, b: {} } as FabricValue,
      );
      const carrier = {
        link: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:diamond-target",
              path: [],
              schema: {
                type: "object",
                properties: {
                  a: { $ref: `cid:${leftHash}` },
                  b: { $ref: `cid:${rightHash}` },
                },
              },
            },
          },
        },
      } as unknown as FabricValue;
      addDoc(store, "of:diamond-carrier" as URI, carrier);

      const context = contextWith();
      const traverser = traverserFor(
        store,
        {
          type: "object",
          properties: {
            link: {
              type: "object",
              properties: { a: { type: "object" }, b: { type: "object" } },
            },
          },
        },
        context,
      );
      const { error } = traverser.traverse(
        topDoc("of:diamond-carrier" as URI, carrier),
      );
      expect(error).toBeUndefined();
      expect(context.schemaDocsAvailable.has(`${SPACE}/${sharedHash}`)).toBe(
        true,
      );
    });

    it("fails closed when the registry lease epoch ends between traversals", () => {
      const leaf: JSONSchema = { type: "number", title: "epoch-end-leaf" };
      const leafHash = internHash(leaf);
      const selectorSchema = internSchema({
        type: "object",
        properties: { n: { $ref: `cid:${leafHash}` } },
      });
      const store = new Map<string, Revision<State>>();
      addDoc(store, `cid:${leafHash}` as URI, leaf as FabricValue);
      const value = { n: 1 } as unknown as FabricValue;
      addDoc(store, "of:epoch-carrier" as URI, value);

      const context = contextWith();
      const traverser = traverserFor(store, selectorSchema, context);
      const first = traverser.traverse(
        topDoc("of:epoch-carrier" as URI, value),
      );
      expect(first.error).toBeUndefined();

      // The last lease out clears the registry. The context still remembers
      // loading the document, so the verdict — availability without a
      // registered document — must fail closed rather than resolve against
      // a registration from the ended epoch.
      const release = acquireSchemaRegistryLease();
      release();

      const second = traverser.traverse(
        topDoc("of:epoch-carrier" as URI, value),
      );
      expect(second.error).toBeDefined();
    });
  });

  describe("MapSet structural copies", () => {
    it("clones a non-hashing selector map at container-copy cost", () => {
      const map = new MapSetStringToPathSelectors(false);
      const selector = { path: [], schema: true } as const;
      map.add("doc-key", selector);
      const cloned = map.clone();
      expect([...cloned.values("doc-key")]).toEqual([selector]);
    });

    it("refuses a structural copy across hashing modes", () => {
      class Probe extends MapSetStringToPathSelectors {
        copyFrom(other: MapSetStringToPathSelectors): void {
          this.copyStateFrom(other as never);
        }
      }
      const hashing = new Probe(true);
      expect(() => hashing.copyFrom(new MapSetStringToPathSelectors(false)))
        .toThrow("MapSet structural copy requires matching hashing modes");
    });
  });
});
