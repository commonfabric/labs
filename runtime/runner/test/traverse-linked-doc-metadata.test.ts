/**
 * What a traversal loads beside a document it reaches through a link. The
 * cases drive that from two ends: a `Cell` read over an emulated replica,
 * where the transaction's read log is the evidence, and a bare
 * `SchemaObjectTraverser` over a map-backed store, where the schema tracker
 * is.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
  schemaTrackerKey,
} from "../src/traverse.ts";

const signer = await Identity.fromPassphrase("traverse-linked-doc-metadata");
const space = signer.did();

const TEST_SCOPE_IDENTITY = {
  principal: "did:key:test-linked-doc-metadata",
  sessionId: "session:test-linked-doc-metadata",
} as const;

/** The shape both cases read `source` under: through `ref` into `target`. */
const sourceSchema: JSONSchema = {
  type: "object",
  properties: {
    ref: {
      type: "object",
      properties: { title: { type: "string" } },
    },
  },
};

describe("traverse-linked-doc-metadata", () => {
  // Every case stores a `source` whose value links to a `target` carrying
  // one metadata member. Reading `source` under a schema that reaches into
  // `target` crosses that link, and what the crossing loads beside `target`
  // is what the case observes.

  describe("a `Cell` read with `traverseCells: true`", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.storageManager.synced();
      await runtime.dispose();
      await storageManager.close();
    });

    it("reads the linked document and not the target of its `argument` metadata", async () => {
      const absent = runtime.getCell(space, "absent-argument");
      const target = runtime.getCell<{ title: string }>(space, "target");
      const source = runtime.getCell<{ ref: { title: string } }>(
        space,
        "source",
      );

      const seed = runtime.edit();
      target.withTx(seed).set({ title: "held" });
      target.withTx(seed).setMetaRaw(
        "argument",
        absent.getAsWriteRedirectLink({ base: target }),
        rawMetaWriteAuthorization,
      );
      source.withTx(seed).set({ ref: target });
      expect((await seed.commit().settled).ok).toBeDefined();

      const tx = runtime.edit();
      const value = source.withTx(tx).asSchema(sourceSchema).get({
        traverseCells: true,
      });
      const readIds = [...tx.getReadActivities!()].map((read) => read.id);
      tx.abort();

      expect(value).toEqual({ ref: { title: "held" } });
      expect(readIds).toContain(target.getAsNormalizedFullLink().id);
      expect(readIds).not.toContain(absent.getAsNormalizedFullLink().id);
    });
  });

  describe("a `SchemaObjectTraverser` over the default context", () => {
    const type = "application/json" as const;
    const storeSpace = "did:null:null";

    // Any non-empty string stands in for a schema hash: the envelope's
    // `schemaHash` is turned into a `cid:` link without being resolved.
    const schemaHash = "traversetestschemahash";

    const link = (id: string) => ({ "/": { [LINK_V1_TAG]: { id, path: [] } } });

    const putDoc = (
      store: Map<string, Revision<State>>,
      id: string,
      is: Record<string, FabricValue>,
    ): void => {
      store.set(`${id}/${type}`, { the: type, of: id as Entity, is, since: 1 });
    };

    /** Stores `source` linking to a `target` carrying `targetMeta`. */
    const storeWith = (
      targetMeta: Record<string, FabricValue>,
    ): Map<string, Revision<State>> => {
      const store = new Map<string, Revision<State>>();
      putDoc(store, "of:target", { value: { title: "held" }, ...targetMeta });
      putDoc(store, "of:source", { value: { ref: link("of:target") } });
      return store;
    };

    /** Reads `of:source` under `sourceSchema`, crossing into `of:target`. */
    const traverse = (store: Map<string, Revision<State>>) => {
      const tx = new ExtendedStorageTransaction(
        new ManagedStorageTransaction(new StoreObjectManager(store)),
      );
      const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY, true);
      const traverser = new SchemaObjectTraverser(
        tx,
        { path: ["value"], schema: sourceSchema },
        context,
      );
      const { ok } = traverser.traverse({
        address: {
          space: storeSpace,
          id: "of:source" as URI,
          type,
          path: ["value"],
        },
        value: { ref: link("of:target") },
      });
      const tracked = [...context.schemaTracker].map(([key]) => key);
      return { ok, tracked };
    };

    const keyOf = (id: string) =>
      schemaTrackerKey(storeSpace, id, undefined, TEST_SCOPE_IDENTITY);

    it("tracks the schema document the linked document's `cfc` envelope names", () => {
      const store = storeWith({ cfc: { schemaHash } });
      putDoc(store, `cid:${schemaHash}`, { value: { type: "object" } });

      expect(traverse(store).tracked).toContain(keyOf(`cid:${schemaHash}`));
    });

    it("tracks the linked document and not the target of its `argument` metadata", () => {
      const { ok, tracked } = traverse(
        storeWith({ argument: link("of:absent-argument") }),
      );

      expect(ok).toEqual({ ref: { title: "held" } });
      expect(tracked).toContain(keyOf("of:target"));
      expect(tracked).not.toContain(keyOf("of:absent-argument"));
    });
  });
});
