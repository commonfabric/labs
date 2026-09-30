import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import {
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import type { FabricValue } from "@commonfabric/data-model";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
  type TraversalContext,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import {
  type DecomposedSchema,
  decomposeSchema,
} from "../src/schema-decompose.ts";
import {
  lookupSchemaDocument,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { resolveSchema } from "../src/schema.ts";

const type = "application/json" as const;
const space = "did:null:null";

// The traversal context's scope-key identity (the train's instance keying):
// schema-doc tests run space-scoped, so any fixed identity resolves the
// "space" scope to the space partition.
const TEST_SCOPE_IDENTITY = {
  principal: "did:key:test-schema-docs",
  sessionId: "session:test-schema-docs",
} as const;

const putDoc = (
  store: Map<string, Revision<State>>,
  id: string,
  value: FabricValue,
  since = 1,
): void => {
  const entity = id as Entity;
  store.set(`${id}/${type}`, {
    the: type,
    of: entity,
    is: { value },
    since,
  });
};

const putSchemaDocs = (
  store: Map<string, Revision<State>>,
  decomposed: DecomposedSchema,
): void => {
  for (const [hash, document] of decomposed.documents) {
    putDoc(store, `cid:${hash}`, document as FabricValue);
  }
};

const traverse = (
  store: Map<string, Revision<State>>,
  rootId: string,
  rootValue: FabricValue,
  selectorSchema: JSONSchema,
): { result: FabricValue | undefined; context: TraversalContext } => {
  const manager = new StoreObjectManager(store);
  const tx = new ExtendedStorageTransaction(
    new ManagedStorageTransaction(manager),
  );
  const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
  const traverser = new SchemaObjectTraverser(
    tx,
    { path: ["value"], schema: selectorSchema },
    context,
  );
  const { ok } = traverser.traverse({
    address: { space, id: rootId as URI, type, path: ["value"] },
    value: rootValue,
  });
  return { result: ok, context };
};

const trackedKeys = (context: TraversalContext): string[] =>
  [...context.schemaTracker].map(([key]) => key);

describe("traverse-schema-docs", () => {
  it("loads, tracks, and registers the documents behind a link schema reference", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        stageName: { $ref: "#/$defs/TraversalStageName" },
        stageAge: { type: "number" },
      },
      $defs: { TraversalStageName: { type: "string" } },
    };
    const decomposed = decomposeSchema(schema);

    const store = new Map<string, Revision<State>>();
    putSchemaDocs(store, decomposed);
    putDoc(store, "of:stage-target", { stageName: "Alpha", stageAge: 7 });
    const rootValue = {
      person: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:stage-target",
            path: [],
            schema: { $ref: decomposed.rootRef },
          },
        },
      },
    };
    putDoc(store, "of:stage-root", rootValue, 2);

    const { result, context } = traverse(
      store,
      "of:stage-root",
      rootValue,
      true,
    );

    const person =
      (result as { person: { stageName: string; stageAge: number } })
        .person;
    expect(person.stageName).toBe("Alpha");
    expect(person.stageAge).toBe(7);

    // Every schema document is registered (hash-verified) and tracked, so it
    // rides into query results and watch sets.
    const keys = trackedKeys(context);
    for (const hash of decomposed.documents.keys()) {
      expect(lookupSchemaDocument(hash)).toBeDefined();
      expect(keys).toContain(`${space}/space/cid:${hash}`);
    }
  });

  it("loads the documents behind a selector schema reference", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        selectorMarker: { $ref: "#/$defs/SelectorMarker" },
      },
      $defs: {
        SelectorMarker: {
          type: "object",
          properties: { m: { type: "string" } },
        },
      },
    };
    const decomposed = decomposeSchema(schema);

    const store = new Map<string, Revision<State>>();
    putSchemaDocs(store, decomposed);
    const rootValue = { selectorMarker: { m: "hello" } };
    putDoc(store, "of:selector-root", rootValue);

    const { result, context } = traverse(
      store,
      "of:selector-root",
      rootValue,
      { $ref: decomposed.rootRef },
    );

    expect(
      (result as { selectorMarker: { m: string } }).selectorMarker.m,
    ).toBe("hello");
    const keys = trackedKeys(context);
    for (const hash of decomposed.documents.keys()) {
      expect(keys).toContain(`${space}/space/cid:${hash}`);
    }
  });

  it("follows a fragment reference into a cyclic-group document across nesting", () => {
    const schema: JSONSchemaObj = {
      $ref: "#/$defs/TraversalListNode",
      $defs: {
        TraversalListNode: {
          type: "object",
          properties: {
            label: { type: "string" },
            next: { $ref: "#/$defs/TraversalListNode" },
          },
        },
      },
    };
    const decomposed = decomposeSchema(schema);
    expect(parseExternalSchemaRef(decomposed.rootRef)!.defName).toBe(
      "TraversalListNode",
    );

    const store = new Map<string, Revision<State>>();
    putSchemaDocs(store, decomposed);
    putDoc(store, "of:list-target", {
      label: "a",
      next: { label: "b", next: { label: "c" } },
    });
    const rootValue = {
      list: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:list-target",
            path: [],
            schema: { $ref: decomposed.rootRef },
          },
        },
      },
    };
    putDoc(store, "of:list-root", rootValue, 2);

    const { result } = traverse(store, "of:list-root", rootValue, true);
    const list = (result as {
      list: { label: string; next: { next: { label: string } } };
    }).list;
    expect(list.label).toBe("a");
    expect(list.next.next.label).toBe("c");
  });

  it("does not resolve through a realm-registered document the traversed space does not hold", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { gateMarker: { type: "string" } },
      title: "availability gate fixture",
    };
    const decomposed = decomposeSchema(schema);
    // Fed into the realm registry by "another space" — directly, here.
    for (const [hash, document] of decomposed.documents) {
      registerSchemaDocument(hash, document);
    }

    // The traversed store does NOT hold the schema documents.
    const store = new Map<string, Revision<State>>();
    putDoc(store, "of:gate-target", { gateMarker: "hidden" });
    const rootValue = {
      gated: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:gate-target",
            path: [],
            schema: { $ref: decomposed.rootRef },
          },
        },
      },
    };
    putDoc(store, "of:gate-root", rootValue, 2);

    const { result } = traverse(store, "of:gate-root", rootValue, true);
    // Fail closed inside the traversal, even though the realm registry
    // could have answered...
    expect((result as { gated: unknown }).gated).toBeNull();
    // ...and outside any traversal, realm-shared resolution still works.
    expect(resolveSchema({ $ref: decomposed.rootRef })).not.toBe(false);
  });

  it("does not accept availability collected in another space", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { crossMarker: { type: "string" } },
      title: "cross-space availability fixture",
    };
    const decomposed = decomposeSchema(schema);
    for (const [hash, document] of decomposed.documents) {
      registerSchemaDocument(hash, document);
    }

    // The traversed store lacks the documents; a prior hop "in another
    // space" collected them. Space-qualified availability must not let
    // that satisfy this space's reference.
    const store = new Map<string, Revision<State>>();
    putDoc(store, "of:cross-target", { crossMarker: "hidden" });
    const rootValue = {
      crossed: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:cross-target",
            path: [],
            schema: { $ref: decomposed.rootRef },
          },
        },
      },
    };
    putDoc(store, "of:cross-root", rootValue, 2);

    const manager = new StoreObjectManager(store);
    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(manager),
    );
    const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
    for (const hash of decomposed.documents.keys()) {
      context.schemaDocsAvailable.add(`did:key:elsewhere/${hash}`);
    }
    const traverser = new SchemaObjectTraverser(
      tx,
      { path: ["value"], schema: true },
      context,
    );
    const { ok } = traverser.traverse({
      address: { space, id: "of:cross-root" as URI, type, path: ["value"] },
      value: rootValue,
    });
    expect((ok as { crossed: unknown }).crossed).toBeNull();
  });

  it("reads schema documents at the canonical space scope whatever the referrer's scope", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { scopedMarker: { type: "string" } },
    };
    const decomposed = decomposeSchema(schema);
    const store = new Map<string, Revision<State>>();
    putSchemaDocs(store, decomposed);
    const rootValue = { scopedMarker: "hello" };
    putDoc(store, "of:scoped-root", rootValue);

    const manager = new StoreObjectManager(store);
    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(manager),
    );
    const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
    const traverser = new SchemaObjectTraverser(
      tx,
      { path: ["value"], schema: { $ref: decomposed.rootRef } },
      context,
    );
    traverser.traverse({
      address: {
        space,
        id: "of:scoped-root" as URI,
        type,
        path: ["value"],
        scope: "session",
      },
      value: rootValue,
    });

    const keys = trackedKeys(context);
    for (const hash of decomposed.documents.keys()) {
      expect(keys).toContain(`${space}/space/cid:${hash}`);
      expect(keys).not.toContain(`${space}/session/cid:${hash}`);
    }
  });

  it("neither registers nor resolves through a forged schema document, without failing the traversal", () => {
    const claimed = internSchemaAsTaggedHashString({
      type: "object",
      properties: { forgedTraversalTarget: { type: "string" } },
    });
    const store = new Map<string, Revision<State>>();
    // Stored content does not hash to the claimed id.
    putDoc(store, `cid:${claimed}`, {
      type: "string",
      title: "forged traversal content",
    });
    putDoc(store, "of:forged-target", { anything: 1 });
    const rootValue = {
      x: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:forged-target",
            path: [],
            schema: { $ref: `cid:${claimed}` },
          },
        },
      },
    };
    putDoc(store, "of:forged-root", rootValue, 2);

    const { context } = traverse(store, "of:forged-root", rootValue, true);
    expect(lookupSchemaDocument(claimed)).toBeUndefined();
    // The document is still tracked — its arrival (or correction) at this id
    // re-triggers the reader — but resolution stays closed.
    expect(trackedKeys(context)).toContain(`${space}/space/cid:${claimed}`);
  });
});
