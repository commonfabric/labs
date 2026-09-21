import { expect } from "@std/expect";
import { type CellScope, resolveScopeKey } from "@commonfabric/memory/v2";
import { describe, it } from "@std/testing/bdd";

import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  internPathSelector,
  isInternedSchema,
} from "@commonfabric/data-model-schema";
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
  canBranchMatch,
  combineSchemaForLink,
  CompoundCycleTracker,
  createDefaultTraversalContext,
  createSchemaMemo,
  createTraversalContext,
  getAtPath,
  IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  MapSet,
  MapSetStringToPathSelectors,
  mergeAnyOfBranchSchemas,
  mergeAnyOfMatches,
  PointerCycleTracker,
  schemaAcceptsType,
  type SchemaMemo,
  SchemaObjectTraverser,
  schemaTrackerCoversSelector,
  setTraverseDiagnostics,
  type TraversalContext,
} from "../src/traverse.ts";

// The acting identity traversal tracker keys resolve scoped addresses
// against (stage E). These tests traverse space-scoped docs, so any one
// identity partitions alike.
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

// Helper function to get the SchemaObjectTraverser backed by a store map
function getTraverser(
  store: Map<string, Revision<State>>,
  selector: SchemaPathSelector,
  context: TraversalContext = createDefaultTraversalContext(
    TEST_SCOPE_IDENTITY,
  ),
  sharedSchemaMemo?: SchemaMemo,
): SchemaObjectTraverser<FabricValue> {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  return new SchemaObjectTraverser(
    tx,
    selector,
    context,
    undefined,
    sharedSchemaMemo,
  );
}

describe("SchemaObjectTraverser.traverseDAG", () => {
  it("follows sigil cell links when traversing", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const doc1Uri = "of:doc-1" as URI;
    const doc2Uri = "of:doc-2" as URI;
    const doc1Entity = doc1Uri as Entity;
    const doc2Entity = doc2Uri as Entity;

    const doc1Value = { employees: [{ name: "Bob" }] };

    const doc1Revision: Revision<State> = {
      the: type,
      of: doc1Entity,
      is: { value: doc1Value },
      since: 1,
    };
    store.set(
      `${doc1Revision.of}/${doc1Revision.the}`,
      doc1Revision,
    );

    const doc2Value = {
      employeeName: {
        "/": {
          [LINK_V1_TAG]: {
            id: doc1Uri,
            path: ["employees", "0", "name"],
          },
        },
      },
      argument: {
        tools: {
          search_web: {
            pattern: {
              result: {
                "/": {
                  [LINK_V1_TAG]: {
                    path: ["internal", "__#0"],
                  },
                },
              },
            },
          },
        },
      },
      internal: {
        "__#0": {
          name: "Foo",
        },
      },
    };

    const doc2Revision: Revision<State> = {
      the: type,
      of: doc2Entity,
      is: { value: doc2Value },
      since: 2,
    };
    store.set(
      `${doc2Revision.of}/${doc2Revision.the}`,
      doc2Revision,
    );

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: true,
    });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: doc2Uri,
        type,
        path: ["value"],
      },
      value: doc2Value,
    });

    expect(result).toEqual({
      argument: {
        tools: {
          search_web: {
            pattern: {
              result: {
                name: "Foo",
              },
            },
          },
        },
      },
      employeeName: "Bob",
      internal: {
        "__#0": {
          name: "Foo",
        },
      },
    });
  });
});

describe("SchemaObjectTraverser missing value handling", () => {
  // Missing values are handled consistently with other value transforms
  // (toJSON, shallowFabricFromConvertibleJsValue, etc.):
  // - Arrays: null is inserted for missing elements
  // - Objects: undefined is assigned for missing properties

  it("uses null for missing array elements", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: true,
    });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Missing elements become null (consistent with toJSON,
    // shallowFabricFromConvertibleJsValue, etc.)
    expect(result).toEqual(["present", null, "also-present"]);
  });

  it("removes missing object properties from object", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-object" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Object with a link to a non-existent document
    const docValue = {
      present: "here",
      missing: { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      alsoPresent: "also here",
    };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: { type: "object", additionalProperties: { type: "string" } },
    });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Missing properties become undefined
    expect(result).toEqual({
      present: "here",
      alsoPresent: "also here",
    });
    expect("missing" in (result as Record<string, unknown>)).toBe(false);
  });

  it("uses undefined for missing object properties when allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-object" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Object with a link to a non-existent document
    const docValue = {
      present: "here",
      missing: { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      alsoPresent: "also here",
    };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: {
        type: "object",
        additionalProperties: { type: ["string", "undefined"] },
      },
    });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Missing properties become undefined
    expect(result).toEqual({
      present: "here",
      missing: undefined,
      alsoPresent: "also here",
    });
    expect("missing" in (result as Record<string, unknown>)).toBe(true);
  });

  it("uses null for missing array elements with schema when allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const schema = {
      type: "array",
      items: {
        anyOf: [
          { type: "null" },
          { type: "string" },
        ],
      },
    } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Missing elements become null (consistent with toJSON,
    // shallowFabricFromConvertibleJsValue, etc.)
    expect(result).toEqual(["present", null, "also-present"]);
  });

  it("does not use null for missing array elements with schema when not allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const schema = {
      type: "array",
      items: { type: "string" },
    } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Missing elements make the array invalid.
    expect(error).toBeDefined();
  });

  it("uses undefined for missing array elements with schema when allowed", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-with-array" as URI;
    const docEntity = docUri as Entity;
    const missingUri = "of:missing-doc" as URI;

    // Array with a link to a non-existent document
    const docValue = [
      "present",
      { "/": { [LINK_V1_TAG]: { id: missingUri, path: [] } } }, // link to missing doc
      "also-present",
    ];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
    // Note: missingUri is NOT in the store

    const schema = {
      type: "array",
      items: {
        anyOf: [
          { type: "undefined" },
          { type: "string" },
        ],
      },
    } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Missing elements become undefined when allowed
    expect(result).toEqual(["present", undefined, "also-present"]);
  });
});

describe("SchemaObjectTraverser array traversal", () => {
  it("uses prefixItems schemas for indexed items", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-prefix-items" as URI;
    const docEntity = docUri as Entity;

    const docValue = ["alpha", { count: 42 }, 3];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      prefixItems: [
        { type: "string" },
        {
          type: "object",
          properties: {
            count: { type: "number" },
          },
          required: ["count"],
        },
      ],
      items: { type: "number" },
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(result).toEqual(["alpha", { count: 42 }, 3]);
  });

  it("rejects additional items when items is false", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-items-false" as URI;
    const docEntity = docUri as Entity;

    const docValue = ["alpha", 1, true];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      prefixItems: [
        { type: "string" },
        { type: "number" },
      ],
      items: false,
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(error).toBeDefined();
  });

  it("rejects populated array when items is false and no prefixItems", () => {
    // Companion to the test above, with the same `items: false`
    // constraint but without `prefixItems`. The traverser rejects a populated
    // array against it.

    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-items-false-no-prefix" as URI;
    const docEntity = docUri as Entity;

    const docValue = ["alpha", "beta"];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      items: false,
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(error).toBeDefined();
  });

  it("accepts empty array when items is false", () => {
    // `items: false` without `prefixItems` means "this array allows no items at
    // all, only `[]` matches."

    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-items-false-empty" as URI;
    const docEntity = docUri as Entity;

    const docValue: never[] = [];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      items: false,
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(result).toEqual([]);
  });

  describe("SchemaObjectTraverser getAtPath", () => {
    // Some helper functions
    function makeLink(id: URI, path: string[], redirect: boolean) {
      return {
        "/": {
          "link@1": {
            path: path,
            id: id,
            space: "did:null:null",
            ...(redirect && { overwrite: "redirect" }),
          },
        },
      };
    }
    function makeRevision(id: URI, value: FabricValue): Revision<State> {
      return {
        the: "application/json",
        of: id,
        is: { value: value },
        since: 1,
      };
    }

    it("returns proper redirect data", () => {
      // A[foo] => B[foo] -> C[foo] => D[foo]
      // Some helper functions
      function makeLink(id: URI, path: string[], redirect: boolean) {
        return {
          "/": {
            "link@1": {
              path: path,
              id: id,
              space: "did:null:null",
              ...(redirect && { overwrite: "redirect" }),
            },
          },
        };
      }
      function makeRevision(
        id: URI,
        value: FabricValue,
      ): Revision<State> {
        return {
          the: "application/json",
          of: id,
          is: { value: value },
          since: 1,
        };
      }

      const store = new Map<string, Revision<State>>();
      const revD = makeRevision("of:doc-item-d", {
        foo: { text: "hello" },
      });
      const revC = makeRevision("of:doc-item-c", {
        foo: makeLink("of:doc-item-d", ["foo"], true),
      });
      const revB = makeRevision("of:doc-item-b", {
        foo: makeLink("of:doc-item-c", ["foo"], false),
      });
      const revA = makeRevision("of:doc-item-a", {
        foo: makeLink("of:doc-item-b", ["foo"], true),
      });
      for (const docRevision of [revA, revB, revC, revD]) {
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
      }

      const manager = new StoreObjectManager(store);
      const managedTx = new ManagedStorageTransaction(manager);
      const tx = new ExtendedStorageTransaction(managedTx);
      const tracker = new CompoundCycleTracker<
        FabricValue,
        JSONSchema | undefined
      >();
      const schemaTracker = new MapSet<string, SchemaPathSelector>();
      const context = createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
      );
      const docAFoo: IMemorySpaceValueAttestation = {
        address: {
          id: revA.of,
          type: revA.the,
          path: ["value", "foo"],
          space: "did:null:null",
        },
        value: (revA.is as any).value.foo,
      };
      const docASelector = {
        path: ["value", "foo"],
        schemaContext: { schema: true },
      };
      const [curDoc, _selector1] = getAtPath(
        tx,
        docAFoo,
        [],
        context,
        docASelector,
      );
      const [redirDoc, _selector2] = getAtPath(
        tx,
        docAFoo,
        [],
        context,
        docASelector,
        "writeRedirect",
      );
      expect(curDoc.address.id).toBe(revD.of);
      expect(curDoc.address.path).toEqual(["value", "foo"]);
      expect(redirDoc.address.id).toBe(revB.of);
      expect(redirDoc.address.path).toEqual(["value", "foo"]);
    });

    it("returns proper redirect data when redirect is outside of link", () => {
      // A[current] => B[foo]
      // B -> C
      // we return C[foo] here, because there is no B[foo].
      const store = new Map<string, Revision<State>>();
      const revC = makeRevision("of:doc-item-c", {
        foo: { label: "first" },
      });
      const revB = makeRevision(
        "of:doc-item-b",
        makeLink("of:doc-item-c", [], false),
      );
      const revA = makeRevision("of:doc-item-a", {
        current: makeLink("of:doc-item-b", ["foo"], true),
      });
      for (const docRevision of [revA, revB, revC]) {
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
      }

      const manager = new StoreObjectManager(store);
      const managedTx = new ManagedStorageTransaction(manager);
      const tx = new ExtendedStorageTransaction(managedTx);
      const tracker = new CompoundCycleTracker<
        FabricValue,
        JSONSchema | undefined
      >();
      const schemaTracker = new MapSet<string, SchemaPathSelector>();
      const context = createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
      );
      const docACurrent: IMemorySpaceValueAttestation = {
        address: {
          id: revA.of,
          type: revA.the,
          path: ["value", "current"],
          space: "did:null:null",
        },
        value: (revA.is as any).value.current,
      };
      const docASelector = { path: ["value", "current"], schema: true };
      const [curDoc, _selector1] = getAtPath(
        tx,
        docACurrent,
        [],
        context,
        docASelector,
      );
      const [redirDoc, _selector2] = getAtPath(
        tx,
        docACurrent,
        [],
        context,
        docASelector,
        "writeRedirect",
      );
      expect(curDoc.address.id).toBe(revC.of);
      expect(curDoc.address.path).toEqual(["value", "foo"]);
      expect(redirDoc.address.id).toBe(revC.of);
      expect(redirDoc.address.path).toEqual(["value", "foo"]);
    });

    it("returns proper redirect data when redirect is outside of link but then there's another redir", () => {
      // A[current] => B[foo]
      // B -> C
      // C[foo] => D[foo]
      // Redirect should be D[foo]
      const store = new Map<string, Revision<State>>();
      const revD = makeRevision("of:doc-item-d", {
        foo: { label: "first" },
      });
      const revC = makeRevision("of:doc-item-c", {
        foo: makeLink("of:doc-item-d", ["foo"], true),
      });
      const revB = makeRevision(
        "of:doc-item-b",
        makeLink("of:doc-item-c", [], false),
      );
      const revA = makeRevision("of:doc-item-a", {
        current: makeLink("of:doc-item-b", ["foo"], true),
      });
      for (const docRevision of [revA, revB, revC, revD]) {
        store.set(`${docRevision.of}/${docRevision.the}`, docRevision);
      }

      const manager = new StoreObjectManager(store);
      const managedTx = new ManagedStorageTransaction(manager);
      const tx = new ExtendedStorageTransaction(managedTx);
      const tracker = new CompoundCycleTracker<
        FabricValue,
        JSONSchema | undefined
      >();
      const schemaTracker = new MapSet<string, SchemaPathSelector>();
      const context = createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
      );
      const docACurrent: IMemorySpaceValueAttestation = {
        address: {
          id: revA.of,
          type: revA.the,
          path: ["value", "current"],
          space: "did:null:null",
        },
        value: (revA.is as any).value.current,
      };
      const docASelector = {
        path: ["value", "current"],
        schemaContext: { schema: true },
      };
      const [curDoc, _selector1] = getAtPath(
        tx,
        docACurrent,
        [],
        context,
        docASelector,
      );
      const [redirDoc, redirDocSelector] = getAtPath(
        tx,
        docACurrent,
        [],
        context,
        docASelector,
        "writeRedirect",
      );
      // we should also be able to get the value starting at the redir doc
      const [curDoc2, _selector3] = getAtPath(
        tx,
        redirDoc,
        [],
        context,
        redirDocSelector,
      );
      expect(curDoc.address.id).toBe(revD.of);
      expect(curDoc.address.path).toEqual(["value", "foo"]);
      expect(redirDoc.address.id).toBe(revD.of);
      expect(redirDoc.address.path).toEqual(["value", "foo"]);
      expect(curDoc2.address.id).toBe(revD.of);
      expect(curDoc2.address.path).toEqual(["value", "foo"]);
    });
  });
});

describe("getAtPath array index validation", () => {
  it("rejects leading-zero array index like '01'", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-getAtPath" as URI;
    const docEntity = docUri as Entity;

    // Array with three elements
    const docValue = ["zero", "one", "two"];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const tracker: PointerCycleTracker = new CompoundCycleTracker<
      FabricValue,
      JSONSchema | undefined
    >();
    const schemaTracker = new MapSetStringToPathSelectors(true);
    const context = createTraversalContext(
      tracker,
      schemaTracker,
      TEST_SCOPE_IDENTITY,
    );

    const doc: IMemorySpaceValueAttestation = {
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    };

    // Navigate with invalid index "01"
    const [result1] = getAtPath(
      tx,
      doc,
      ["01"],
      context,
    );

    // Navigate with valid index "1"
    const [result2] = getAtPath(
      tx,
      doc,
      ["1"],
      context,
    );

    // "01" is not a valid array index (leading zero), should return undefined
    // BUG: Current code returns "one" because new Number("01").valueOf() === 1
    expect(result1.value).toBeUndefined();
    // "1" is a valid array index, should return "one"
    expect(result2.value).toBe("one");
  });
});

describe("SchemaObjectTraverser boolean type handling", () => {
  it("correctly validates boolean values against boolean schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-boolean" as URI;
    const docEntity = docUri as Entity;

    // Array of booleans (like the hits array in the bug)
    const docValue = [true, false, true, false];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      items: { type: "boolean" },
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Should return the full array with boolean values preserved
    expect(result).toEqual([true, false, true, false]);
  });

  it("rejects boolean values when schema expects different type", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-boolean-reject" as URI;
    const docEntity = docUri as Entity;

    const docValue = true;

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "string",
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // boolean doesn't match string schema
    expect(error).toBeDefined();
  });
});

describe("SchemaObjectTraverser FabricSpecialObject type handling", () => {
  it("materializes a FabricSpecialObject value as an opaque leaf", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-fabric-bytes" as URI;
    const docEntity = docUri as Entity;

    const docValue = new FabricBytes(new Uint8Array([1, 2, 3]));

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    // The structural shape the schema-generator emits for these types: own
    // props can never satisfy it — `length` lives on the prototype. A leaf is
    // not property-walked, so it must not matter.
    const schema = {
      type: "object",
      properties: { length: { type: "number" } },
      required: ["length"],
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // The same frozen instance passes through — not an `Object.entries`
    // decomposition of its (empty) own props.
    expect(result).toBe(docValue);
  });

  it("rejects a FabricSpecialObject value where the schema cannot be an object", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-fabric-bytes-reject" as URI;
    const docEntity = docUri as Entity;

    const docValue = new FabricBytes(new Uint8Array([1, 2, 3]));

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = { type: "string" } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // A special object validates as "object" and nothing else: it is
    // rejected here, not decomposed against the mismatched schema.
    expect(error?.code).toBe("INVALID_TYPE");
  });
});

describe("SchemaObjectTraverser anyOf/oneOf handling", () => {
  it("resolves anyOf schema by matching value type", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-anyof" as URI;
    const docEntity = docUri as Entity;

    const docValue = "hello";

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    // anyOf with string or number alternatives
    const schema = {
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Should return the string value since it matches the string alternative
    expect(result).toBe("hello");
  });

  it("resolves oneOf schema with $ref by matching value type", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-ref" as URI;
    const docEntity = docUri as Entity;

    const docValue = { id: 1, name: "Item1" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    // oneOf with $ref that resolves to object type
    const schema = {
      oneOf: [
        { $ref: "#/$defs/Item" },
        { type: "null" },
      ],
      $defs: {
        Item: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Should return the object since it matches the Item $ref alternative
    expect(result).toEqual({ id: 1, name: "Item1" });
  });

  it("handles nested objects with boolean arrays in anyOf schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-nested-boolean-array" as URI;
    const docEntity = docUri as Entity;

    // This mirrors the battleship bug structure: object with boolean array
    const docValue = {
      id: 1,
      name: "Ship1",
      hits: [false, false, true],
    };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        hits: {
          type: "array",
          items: { type: "boolean" },
        },
      },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Should return the full object with hits array preserved
    expect(result).toEqual({
      id: 1,
      name: "Ship1",
      hits: [false, false, true],
    });
  });
});

describe("SchemaObjectTraverser array element validation fallback priority", () => {
  // These tests exercise the fallback in traverse.ts: when an element
  // fails schema validation, the traverser falls back in priority order:
  //   1. undefined  — if the item schema allows "undefined"
  //   2. null       — else if the item schema allows "null"
  //   3. failure    — otherwise the whole array is returned as undefined
  //
  // All tests use an inline number (42) inside a string array to trigger a
  // type-mismatch error without needing a broken link.

  function makeArrayDoc(
    docValue: FabricValue[],
  ): {
    store: Map<string, Revision<State>>;
    docUri: URI;
    type: "application/json";
  } {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-fallback-array" as URI;
    const docEntity = docUri as Entity;
    store.set(`${docEntity}/${type}`, {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    });
    return { store, docUri, type };
  }

  it("uses undefined when element fails type check and schema allows undefined", () => {
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "undefined" }] },
    } as JSONSchema;

    const { ok: result } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: {
          space: "did:null:null",
          id: docUri,
          type,
          path: ["value"],
        },
        value: docValue,
      });

    expect(result).toEqual(["hello", undefined, "world"]);
  });

  it("uses null when element fails type check and schema allows null (not undefined)", () => {
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "null" }] },
    } as JSONSchema;

    const { ok: result } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: {
          space: "did:null:null",
          id: docUri,
          type,
          path: ["value"],
        },
        value: docValue,
      });

    expect(result).toEqual(["hello", null, "world"]);
  });

  it("prefers undefined over null when both are allowed by the item schema", () => {
    // undefined is checked first, so it wins even when null is also valid.
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: {
        anyOf: [{ type: "string" }, { type: "null" }, {
          type: "undefined",
        }],
      },
    } as JSONSchema;

    const { ok: result } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: {
          space: "did:null:null",
          id: docUri,
          type,
          path: ["value"],
        },
        value: docValue,
      });

    expect(result).toEqual(["hello", undefined, "world"]);
  });

  it("returns undefined for the whole array when element fails and neither fallback is allowed", () => {
    const docValue = ["hello", 42, "world"];
    const { store, docUri, type } = makeArrayDoc(docValue);
    const schema = {
      type: "array",
      items: { type: "string" },
    } as JSONSchema;

    const { error } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: {
          space: "did:null:null",
          id: docUri,
          type,
          path: ["value"],
        },
        value: docValue,
      });

    expect(error).toBeDefined();
  });

  it("does not silently replace a mismatched item with undefined when items schema is a $ref", () => {
    // Before the isValidType $ref fix, isValidType called with a schema of the
    // form { $ref: "...", $defs: {...} } would skip $ref resolution and fall
    // through with all validities undefined, returning TypeValidity.True. This
    // caused the array element fallback (lines 2632-2634 in traverse.ts) to
    // accept `undefined` as a replacement for any item that failed traversal —
    // even when the $ref resolved to a typed schema that excluded undefined.
    //
    // schemaAtPath returns the items schema object directly, so when items is
    // { $ref: "#/$defs/Str", $defs: { Str: { type: "string" } } } the fallback
    // receives that self-contained schema and must resolve the $ref before
    // deciding whether undefined is a valid substitute.
    const docValue = ["hello", true];
    const { store, docUri, type } = makeArrayDoc(docValue);

    const schema = {
      type: "array",
      items: {
        $ref: "#/$defs/Str",
      },
      $defs: { Str: { type: "string" } },
    } as JSONSchema;

    const { error } = getTraverser(store, { path: ["value"], schema })
      .traverse({
        address: {
          space: "did:null:null",
          id: docUri,
          type,
          path: ["value"],
        },
        value: docValue,
      });

    // After fix: $ref is resolved to { type: "string" }, which does not allow
    // undefined, so the boolean item cannot be silently replaced and the array
    // traversal fails instead of returning ["hello", undefined].
    expect(error).toBeDefined();
  });
});

describe("SchemaObjectTraverser oneOf correctness", () => {
  it("rejects values matching multiple oneOf branches", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-multiple" as URI;
    const docEntity = docUri as Entity;
    const docValue = { a: "x", b: "y" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      oneOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { b: { type: "string" } },
          required: ["b"],
        },
      ],
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(error).toBeDefined();
  });

  it("rejects values that only match oneOf by type but not constraints", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-constraints" as URI;
    const docEntity = docUri as Entity;
    const docValue = { name: "not-an-id" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      oneOf: [
        {
          type: "object",
          required: ["id"],
          properties: { id: { type: "number" } },
        },
        { type: "null" },
      ],
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(error).toBeDefined();
  });

  it("oneOf [unknown, non-matching type] with object returns opaque (only unknown matches)", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-unknown-obj" as URI;
    const docEntity = docUri as Entity;

    const linkedUri = "of:doc-oneof-unknown-link" as URI;
    const docValue = {
      ref: { "/": { [LINK_V1_TAG]: { id: linkedUri, path: [] } } },
    };

    store.set(`${docUri}/${type}`, {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    });
    store.set(`${linkedUri}/${type}`, {
      the: type,
      of: linkedUri as Entity,
      is: { value: { label: "should not appear" } },
      since: 2,
    });

    // oneOf: only the unknown branch matches an object (string branch rejects it)
    const schema = {
      oneOf: [{ type: "unknown" }, { type: "string" }],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result, error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(error).toBeUndefined();
    // unknown branch matched — value is opaque, link not followed
    expect(result).toBeUndefined();
  });

  it("oneOf [unknown, matching object schema] returns error (multiple matches)", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-oneof-unknown-multi" as URI;
    const docEntity = docUri as Entity;
    const docValue = { name: "Alice" };

    store.set(`${docUri}/${type}`, {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    });

    // Both branches match: unknown accepts anything, object branch also matches
    const schema = {
      oneOf: [
        { type: "unknown" },
        { type: "object", properties: { name: { type: "string" } } },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Both branches match → multiple matching oneOf error
    expect(error).toBeDefined();
  });
});

describe("SchemaObjectTraverser allOf correctness", () => {
  it("merges all successful allOf branch results", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-allof-merge" as URI;
    const docEntity = docUri as Entity;
    const docValue = { a: "x", b: "y" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      allOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { b: { type: "string" } },
          required: ["b"],
          additionalProperties: false,
        },
      ],
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(result).toEqual({ a: "x", b: "y" });
  });

  it("treats allOf [unknown, concrete] as concrete (unknown & T = T)", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const targetUri = "of:doc-allof-unknown-target" as URI;
    const docUri = "of:doc-allof-unknown-container" as URI;

    store.set(`${targetUri}/${type}`, {
      the: type,
      of: targetUri as Entity,
      is: { value: { city: "Paris" } },
      since: 1,
    });

    const docValue = {
      name: "Alice",
      address: { "/": { [LINK_V1_TAG]: { id: targetUri, path: [] } } },
    };
    store.set(`${docUri}/${type}`, {
      the: type,
      of: docUri as Entity,
      is: { value: docValue },
      since: 1,
    });

    // allOf: unknown & object => object; link should be followed
    const schema = {
      allOf: [
        { type: "unknown" },
        {
          type: "object",
          properties: {
            name: { type: "string" },
            address: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    const obj = result as Record<string, unknown>;
    expect(obj.name).toBe("Alice");
    // Link is followed because the concrete schema wins over unknown in allOf
    expect((obj.address as Record<string, unknown>)?.city).toBe("Paris");
  });
});

describe("SchemaObjectTraverser defaults with $ref", () => {
  it("applies top-level default from resolved $ref schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-default-ref" as URI;

    const schema = {
      $ref: "#/$defs/Name",
      $defs: {
        Name: {
          type: "string",
          default: "from-ref",
        },
      },
    } as const satisfies JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: undefined,
    });

    expect(result).toBe("from-ref");
  });
});

describe("CompoundCycleTracker cleanup", () => {
  it("removes empty partial-key entries on dispose", () => {
    const tracker = new CompoundCycleTracker<object, boolean>();
    const key = { id: "k1" };
    const disposable = tracker.include(key, true);
    expect(disposable).not.toBeNull();
    disposable![Symbol.dispose]();
    expect(tracker.accessForTestingOnly.partial.size).toBe(0);
  });

  it("retains partial-key entries while sibling entries are live", () => {
    const tracker = new CompoundCycleTracker<
      object,
      JSONSchema | undefined
    >();
    const key = { id: "k1" };
    const dispA = tracker.include(key, true);
    const dispB = tracker.include(key, false);
    expect(dispA).not.toBeNull();
    expect(dispB).not.toBeNull();
    // Disposing only A must not remove the outer `partial` entry —
    // B's live entry still keys on the same partialKey.
    dispA![Symbol.dispose]();
    expect(tracker.accessForTestingOnly.partial.size).toBe(1);
    expect(tracker.accessForTestingOnly.partial.get(key)!.size).toBe(1);
    // Disposing B then cleans up.
    dispB![Symbol.dispose]();
    expect(tracker.accessForTestingOnly.partial.size).toBe(0);
  });
});

describe("CompoundCycleTracker intern-based keying (Tactic 2B)", () => {
  it("detects cycles on structurally-equal extraKey (not just identity)", () => {
    const tracker = new CompoundCycleTracker<
      object,
      JSONSchema | undefined
    >();
    const key = { id: "k1" };
    // Two distinct object references with structurally-equal content.
    const schemaA: JSONSchema = {
      type: "object",
      title: `cctInternKeyTestAt${Date.now()}-${Math.random()}`,
    };
    const schemaB: JSONSchema = { ...schemaA };
    const first = tracker.include(key, schemaA);
    expect(first).not.toBeNull();
    // Re-including with a structurally-equal-but-non-identical schema
    // must detect the cycle via `internSchema`'s structural dedup.
    const second = tracker.include(key, schemaB);
    expect(second).toBeNull();
  });

  it("treats `undefined` extraKey as `true` (JSON Schema accept-all)", () => {
    const tracker = new CompoundCycleTracker<
      object,
      JSONSchema | undefined
    >();
    const key = { id: "k1" };
    const first = tracker.include(key, undefined);
    expect(first).not.toBeNull();
    // Re-including with `true` must collide with the prior `undefined`
    // call — the class normalizes both to the same interned schema.
    const second = tracker.include(key, true);
    expect(second).toBeNull();
    // And vice-versa.
    const key2 = { id: "k2" };
    tracker.include(key2, true);
    expect(tracker.include(key2, undefined)).toBeNull();
  });

  it("distinguishes boolean `false` from boolean `true` / `undefined`", () => {
    const tracker = new CompoundCycleTracker<
      object,
      JSONSchema | undefined
    >();
    const key = { id: "k1" };
    const a = tracker.include(key, true);
    expect(a).not.toBeNull();
    const b = tracker.include(key, false);
    expect(b).not.toBeNull();
  });

  it("getExisting returns the stored value on re-include", () => {
    const tracker = new CompoundCycleTracker<
      object,
      JSONSchema | undefined,
      string
    >();
    const key = { id: "k1" };
    const schema: JSONSchema = {
      type: "object",
      title: `cctInternKeyTestAt${Date.now()}-${Math.random()}`,
    };
    tracker.include(key, schema, "value-a");
    expect(tracker.getExisting(key, schema)).toBe("value-a");
    expect(tracker.getExisting(key, { ...schema })).toBe("value-a");
    expect(tracker.getExisting(key, true)).toBeUndefined();
  });

  it("returns undefined from getExisting for unknown partialKey", () => {
    const tracker = new CompoundCycleTracker<
      object,
      JSONSchema | undefined,
      string
    >();
    expect(tracker.getExisting({ id: "missing" }, true)).toBeUndefined();
  });
});

const numericTypeCases = [
  {
    name: "number accepts an integer value",
    schema: { type: "number" },
    value: 42,
    expected: true,
  },
  {
    name: "number accepts a fractional value",
    schema: { type: "number" },
    value: 1.5,
    expected: true,
  },
  {
    name: "integer accepts an integer value",
    schema: { type: "integer" },
    value: 42,
    expected: true,
  },
  {
    name: "integer rejects a fractional value",
    schema: { type: "integer" },
    value: 1.5,
    expected: false,
  },
  {
    name: "a union containing integer accepts an integer value",
    schema: { type: ["string", "integer"] },
    value: 42,
    expected: true,
  },
  {
    name: "a union containing integer rejects a fractional value",
    schema: { type: ["string", "integer"] },
    value: 1.5,
    expected: false,
  },
] as const satisfies readonly {
  name: string;
  schema: JSONSchema;
  value: number;
  expected: boolean;
}[];

describe("canBranchMatch", () => {
  it("rejects type mismatch: string value vs number schema", () => {
    expect(canBranchMatch({ type: "number" }, "hello")).toBe(false);
  });

  it("rejects type mismatch: number value vs string schema", () => {
    expect(canBranchMatch({ type: "string" }, 42)).toBe(false);
  });

  it("rejects type mismatch: object value vs array schema", () => {
    expect(canBranchMatch({ type: "array" }, { a: 1 })).toBe(false);
  });

  it("accepts matching type", () => {
    expect(canBranchMatch({ type: "string" }, "hello")).toBe(true);
    expect(canBranchMatch({ type: "number" }, 42)).toBe(true);
    expect(canBranchMatch({ type: "object" }, { a: 1 })).toBe(true);
    expect(canBranchMatch({ type: "array" }, [1, 2])).toBe(true);
    expect(canBranchMatch({ type: "boolean" }, true)).toBe(true);
    expect(canBranchMatch({ type: "null" }, null)).toBe(true);
  });

  for (const testCase of numericTypeCases) {
    it(testCase.name, () => {
      expect(canBranchMatch(testCase.schema, testCase.value)).toBe(
        testCase.expected,
      );
    });
  }

  it("conservatively accepts const schemas (values may contain unresolved links)", () => {
    expect(canBranchMatch({ const: "a" }, "b")).toBe(true);
    expect(canBranchMatch({ const: "a" }, "a")).toBe(true);
  });

  it("conservatively accepts enum schemas (values may contain unresolved links)", () => {
    expect(canBranchMatch({ enum: ["a", "b"] }, "c")).toBe(true);
    expect(canBranchMatch({ enum: ["a", "b"] }, "a")).toBe(true);
  });

  it("rejects missing required properties", () => {
    expect(
      canBranchMatch(
        { type: "object", required: ["name", "age"] },
        { name: "Alice" },
      ),
    ).toBe(false);
  });

  it("accepts when all required properties present", () => {
    expect(
      canBranchMatch(
        { type: "object", required: ["name"] },
        { name: "Alice", extra: true },
      ),
    ).toBe(true);
  });

  it("treats the nominal brand key as present on a `FabricSpecialObject`", () => {
    // The generator's emitted shape for a FabricBytes-typed field: the
    // brand has no runtime existence, so a `FabricSpecialObject` satisfies it
    // by construction; `length` is satisfied by the class accessor.
    const branch = {
      type: "object",
      required: ["length", "@commonfabric/FabricSpecialObject"],
    } as const;
    expect(canBranchMatch(branch, new FabricBytes(new Uint8Array([1]))))
      .toBe(true);
    // No exemption for a plain record, which genuinely lacks the brand.
    expect(canBranchMatch(branch, { length: 1 })).toBe(false);
    // A key the primitive lacks still rejects it.
    expect(
      canBranchMatch(
        { type: "object", required: ["x"] },
        new FabricBytes(new Uint8Array([1])),
      ),
    ).toBe(false);
  });

  it("conservatively accepts property-level const (values may be unresolved links)", () => {
    // Even when the property value doesn't match the const, we can't reject
    // because the value might be a link that resolves to a matching value.
    expect(
      canBranchMatch(
        {
          type: "object",
          properties: { kind: { const: "cat" } },
        },
        { kind: "dog", name: "Rex" },
      ),
    ).toBe(true);
    expect(
      canBranchMatch(
        {
          type: "object",
          properties: { kind: { const: "cat" } },
        },
        { kind: "cat", name: "Whiskers" },
      ),
    ).toBe(true);
  });

  it("conservatively accepts property-level enum (values may be unresolved links)", () => {
    expect(
      canBranchMatch(
        {
          type: "object",
          properties: { status: { enum: ["active", "inactive"] } },
        },
        { status: "deleted" },
      ),
    ).toBe(true);
  });

  it("returns true (conservative) when uncertain — no type specified", () => {
    expect(canBranchMatch({}, "anything")).toBe(true);
    expect(canBranchMatch({}, 123)).toBe(true);
    expect(canBranchMatch({}, { a: 1 })).toBe(true);
  });

  it("never rejects asCell branches", () => {
    expect(canBranchMatch({ asCell: ["cell"], type: "number" }, "hello")).toBe(
      true,
    );
  });

  it("never rejects asCell stream branches", () => {
    expect(
      canBranchMatch({ asCell: ["stream"], type: "number" }, "hello"),
    ).toBe(true);
  });

  it("handles boolean schemas", () => {
    expect(canBranchMatch(true, "anything")).toBe(true);
    expect(canBranchMatch(false, "anything")).toBe(false);
  });

  it("accepts when properties have const/enum (no property-level discrimination)", () => {
    // Property-level const/enum are not checked because values may contain
    // unresolved links. This test confirms no rejection happens.
    expect(
      canBranchMatch(
        {
          type: "object",
          properties: { kind: { const: "cat" } },
        },
        { name: "Whiskers" },
      ),
    ).toBe(true);
  });

  it("handles array type in schema", () => {
    expect(canBranchMatch({ type: ["string", "number"] }, "hello")).toBe(
      true,
    );
    expect(canBranchMatch({ type: ["string", "number"] }, 42)).toBe(true);
    expect(canBranchMatch({ type: ["string", "number"] }, true)).toBe(
      false,
    );
  });

  it("checks required properties when type is an array including 'object'", () => {
    // type: ["object", "null"] should still check required properties
    expect(
      canBranchMatch(
        { type: ["object", "null"], required: ["name"] },
        { name: "Alice" },
      ),
    ).toBe(true);
    expect(
      canBranchMatch(
        { type: ["object", "null"], required: ["name"] },
        { age: 30 },
      ),
    ).toBe(false);
    // type array without "object" should skip required check
    expect(
      canBranchMatch(
        { type: ["string", "number"], required: ["name"] },
        { age: 30 },
      ),
    ).toBe(false); // rejected by type mismatch, not required
  });

  it("conservatively accepts when value is a cell link object", () => {
    const linkValue = {
      "/": { [LINK_V1_TAG]: { id: "of:target", path: [] } },
    };
    // Even if the branch type doesn't match the link's shape, links get
    // resolved during traversal so we must not reject.
    expect(canBranchMatch({ type: "string" }, linkValue)).toBe(true);
    expect(canBranchMatch({ type: "number" }, linkValue)).toBe(true);
    expect(
      canBranchMatch(
        { type: "object", required: ["missing"] },
        linkValue,
      ),
    ).toBe(true);
  });

  it("accepts empty array against items: false (only empty arrays match)", () => {
    // `items: false` on an array schema means "no items allowed"
    // (only the empty array `[]` matches). canBranchMatch checks
    // `type === "array"` but ignores `items: false`, so a populated array still
    // passes this fast-reject check. This case pins the empty-array half, which
    // matches either way; nothing here covers the populated half, so the gap
    // shows up in no failing test.

    expect(canBranchMatch({ type: "array", items: false }, [])).toBe(true);
  });
});

describe("SchemaObjectTraverser number/integer type pruning", () => {
  for (const [index, testCase] of numericTypeCases.entries()) {
    it(testCase.name, () => {
      const store = new Map<string, Revision<State>>();
      const type = "application/json" as const;
      const docUri = `of:number-integer-${index}` as URI;
      const docEntity = docUri as Entity;
      const value = testCase.value;

      store.set(`${docUri}/${type}`, {
        the: type,
        of: docEntity,
        is: { value },
        since: 1,
      });

      const { ok, error } = getTraverser(store, {
        path: ["value"],
        schema: testCase.schema,
      }).traverse({
        address: {
          space: "did:null:null",
          id: docUri,
          type,
          path: ["value"],
        },
        value,
      });

      if (testCase.expected) {
        expect(error).toBeUndefined();
        expect(ok).toBe(value);
      } else {
        expect(error?.code).toBe("INVALID_TYPE");
        expect(ok).toBeUndefined();
      }
    });
  }
});

describe("mergeAnyOfMatches", () => {
  // When an anyOf produces multiple successful matches, object matches merge
  // by property union (different anyOf branches contributing disjoint
  // property sets), and array matches keep their array-ness. Arrays satisfy
  // `isObjectOrArray` (typeof [] === "object" && [] !== null), so a merge that
  // did not tell them apart would run them through the object branch and
  // return `{ "0": …, "1": … }` instead of `[…, …]`.

  it("returns undefined when matches is empty", () => {
    expect(mergeAnyOfMatches([])).toBe(undefined);
  });

  it("returns the sole match when matches has length 1", () => {
    expect(mergeAnyOfMatches([42])).toBe(42);
    expect(mergeAnyOfMatches([{ name: "Alice" }])).toEqual({ name: "Alice" });
    expect(mergeAnyOfMatches([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it("merges multiple object matches by property union (existing behavior)", () => {
    const a = { name: "Alice" };
    const b = { age: 30 };
    expect(mergeAnyOfMatches([a, b])).toEqual({ name: "Alice", age: 30 });
  });

  it("preserves array-ness when all matches are arrays", () => {
    // Both branches of an anyOf produce arrays. The merge must return an
    // array, not an Object.assign'd plain object.
    const result = mergeAnyOfMatches([[1, 2], [3, 4]]);
    expect(Array.isArray(result)).toBe(true);
  });

  it("preserves array-ness when one branch is empty and one is populated", () => {
    // The `Default<[]>` anyOf shape: one branch (`{items: false}`) returns []
    // and the other returns the populated array. Both are arrays; merged as
    // objects they would produce `{"0": …, "1": …}`, which has no `.map`.
    const result = mergeAnyOfMatches([[], [{ name: "alpha" }, {
      name: "beta",
    }]]);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns matches[0] for mixed-type matches (existing behavior)", () => {
    // When matches aren't all the same shape (e.g. one is null, one is an
    // object), the merge can't combine them and falls through to matches[0].
    const obj = { name: "Alice" };
    expect(mergeAnyOfMatches([obj, null])).toEqual(obj);
  });
});

describe("mergeAnyOfBranchSchemas", () => {
  it("returns null for fewer than 2 branches", () => {
    expect(
      mergeAnyOfBranchSchemas([{ type: "object" }], {}),
    ).toBe(null);
  });

  it("returns null when a branch is not an object type", () => {
    expect(
      mergeAnyOfBranchSchemas(
        [{ type: "string" }, { type: "object" }],
        {},
      ),
    ).toBe(null);
  });

  it("merges disjoint properties from two branches", () => {
    const result = mergeAnyOfBranchSchemas(
      [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
      {},
    );
    expect(result).not.toBe(null);
    const r = result as Record<string, unknown>;
    expect(r.type).toBe("object");
    const props = r.properties as Record<string, unknown>;
    expect(props.a).toEqual({ type: "string" });
    expect(props.b).toEqual({ type: "number" });
  });

  it("wraps overlapping properties with different schemas in anyOf", () => {
    const result = mergeAnyOfBranchSchemas(
      [
        { type: "object", properties: { x: { type: "string" } } },
        { type: "object", properties: { x: { type: "number" } } },
      ],
      {},
    );
    expect(result).not.toBe(null);
    const props = (result as Record<string, unknown>)
      .properties as Record<string, unknown>;
    const xSchema = props.x as Record<string, unknown>;
    expect(xSchema.anyOf).toBeDefined();
    expect((xSchema.anyOf as unknown[]).length).toBe(2);
  });

  it("uses single schema when overlapping properties are identical", () => {
    const result = mergeAnyOfBranchSchemas(
      [
        { type: "object", properties: { x: { type: "string" } } },
        { type: "object", properties: { x: { type: "string" } } },
      ],
      {},
    );
    expect(result).not.toBe(null);
    const props = (result as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(props.x).toEqual({ type: "string" });
  });

  it("computes required as intersection", () => {
    const result = mergeAnyOfBranchSchemas(
      [
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a", "b"],
        },
        {
          type: "object",
          properties: { a: { type: "string" }, c: { type: "number" } },
          required: ["a"],
        },
      ],
      {},
    );
    expect(result).not.toBe(null);
    const r = result as Record<string, unknown>;
    // Only "a" is required by both branches
    expect(r.required).toEqual(["a"]);
  });

  it("merges $defs from all branches", () => {
    const result = mergeAnyOfBranchSchemas(
      [
        {
          type: "object",
          properties: { a: { type: "string" } },
          $defs: { Foo: { type: "string" } },
        },
        {
          type: "object",
          properties: { b: { type: "number" } },
          $defs: { Bar: { type: "number" } },
        },
      ],
      {},
    );
    expect(result).not.toBe(null);
    const r = result as Record<string, unknown>;
    const defs = r.$defs as Record<string, unknown>;
    expect(defs.Foo).toEqual({ type: "string" });
    expect(defs.Bar).toEqual({ type: "number" });
  });

  it("returns null when branches have no properties", () => {
    expect(
      mergeAnyOfBranchSchemas(
        [{ type: "object" }, { type: "object" }],
        {},
      ),
    ).toBe(null);
  });

  it("returns null for boolean branch schemas", () => {
    expect(
      mergeAnyOfBranchSchemas([true, { type: "object" }], {}),
    ).toBe(null);
  });
});

describe("anyOf optimization integration", () => {
  it("preserves integer subtype matching in the prepared type prefilter", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-anyof-integer-subtype" as URI;
    const docEntity = docUri as Entity;
    const value = 42;

    store.set(`${docUri}/${type}`, {
      the: type,
      of: docEntity,
      is: { value },
      since: 1,
    });

    const selector = internPathSelector({
      path: ["value"],
      schema: {
        anyOf: [{ type: "number" }, { type: "string" }],
      },
    });
    expect(isInternedSchema(selector.schema!)).toBe(true);

    const traverser = getTraverser(store, selector);
    const { ok, error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value,
    });

    expect(error).toBeUndefined();
    expect(ok).toBe(value);
    expect(traverser.anyOfFastRejects).toBe(1);
  });

  it("fast-rejects incompatible branches and still produces correct result", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-discriminated" as URI;
    const docEntity = docUri as Entity;

    const docValue = { kind: "circle", radius: 5 };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    // Discriminated union by "kind" const
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { const: "square" },
            side: { type: "number" },
          },
          required: ["kind"],
        },
        {
          type: "object",
          properties: {
            kind: { const: "circle" },
            radius: { type: "number" },
          },
          required: ["kind"],
        },
        {
          type: "object",
          properties: {
            kind: { const: "triangle" },
            base: { type: "number" },
            height: { type: "number" },
          },
          required: ["kind"],
        },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(result).toEqual({ kind: "circle", radius: 5 });
  });

  it("property-merges disjoint object branches into a single traversal", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-disjoint" as URI;
    const docEntity = docUri as Entity;

    const docValue = { name: "Alice", age: 30 };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      anyOf: [
        {
          type: "object",
          properties: { name: { type: "string" } },
        },
        {
          type: "object",
          properties: { age: { type: "number" } },
        },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Both properties should be discovered via branch-by-branch + mergeAnyOfMatches
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("preserves link discovery across all branches", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-links" as URI;
    const docEntity = docUri as Entity;
    const linkedUri = "of:linked-doc" as URI;
    const linkedEntity = linkedUri as Entity;

    const linkedRevision: Revision<State> = {
      the: type,
      of: linkedEntity,
      is: { value: "linked-value" },
      since: 1,
    };
    store.set(`${linkedRevision.of}/${linkedRevision.the}`, linkedRevision);

    const docValue = {
      title: "test",
      ref: {
        "/": {
          [LINK_V1_TAG]: {
            id: linkedUri,
            path: [],
          },
        },
      },
    };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            title: { type: "string" },
            ref: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            title: { type: "string" },
          },
        },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    // Both branches survive (both are object types). Branch 1 includes ref,
    // branch 2 does not. mergeAnyOfMatches combines them via Object.assign.
    // The link value is preserved as-is (not resolved in this unit test context).
    expect((result as Record<string, unknown>).title).toBe("test");
    expect((result as Record<string, unknown>).ref).toEqual(docValue.ref);
  });

  it("falls back correctly for primitive values", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-primitive-anyof" as URI;
    const docEntity = docUri as Entity;

    const docValue = 42;

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(result).toBe(42);
    // String and boolean branches should be fast-rejected
    expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);
  });

  it("handles mixed object and primitive anyOf branches", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-mixed-anyof" as URI;
    const docEntity = docUri as Entity;

    const docValue = { name: "test" };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      anyOf: [
        { type: "string" },
        { type: "null" },
        { type: "object", properties: { name: { type: "string" } } },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: docValue,
    });

    expect(result).toEqual({ name: "test" });
    // string and null branches should be fast-rejected
    expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);
  });
});

describe("link schema path narrowing", () => {
  const SPACE = "did:null:null";
  const TYPE = "application/json" as const;

  function putDoc(
    store: Map<string, Revision<State>>,
    id: URI,
    value: unknown,
  ) {
    const entity = id as Entity;
    store.set(`${entity}/${TYPE}`, {
      the: TYPE,
      of: entity,
      is: { value },
      since: 1,
    } as Revision<State>);
  }

  function makeLink(
    targetId: URI,
    path: string[],
    schema: JSONSchema,
  ) {
    return {
      "/": {
        [LINK_V1_TAG]: { id: targetId, path, schema },
      },
    };
  }

  function makeRecursiveFriendsGraph(
    prefix: string,
    linkFriendsRequired: boolean,
  ) {
    const store = new Map<string, Revision<State>>();
    const rootUri = `of:${prefix}-friends-root` as URI;
    const directFriendsUri = `of:${prefix}-direct-friends` as URI;
    const directFriendUri = `of:${prefix}-direct-friend` as URI;
    const nestedFriendsUri = `of:${prefix}-nested-friends` as URI;
    const secondDegreeFriendUri = `of:${prefix}-second-degree-friend` as URI;

    const fullUserSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        friends: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
      required: linkFriendsRequired ? ["id", "friends"] : ["id"],
    } as const satisfies JSONSchema;
    const fullFriendsSchema = {
      type: "array",
      items: fullUserSchema,
    } as const satisfies JSONSchema;

    const rootValue = {
      id: "root",
      friends: makeLink(directFriendsUri, [], fullFriendsSchema),
    };
    const directFriendsValue = [
      makeLink(directFriendUri, [], fullUserSchema),
    ];
    const directFriendValue = {
      id: "direct",
      friends: makeLink(nestedFriendsUri, [], fullFriendsSchema),
    };
    const nestedFriendsValue = [
      makeLink(secondDegreeFriendUri, [], fullUserSchema),
    ];

    putDoc(store, rootUri, rootValue);
    putDoc(store, directFriendsUri, directFriendsValue);
    putDoc(store, directFriendUri, directFriendValue);
    putDoc(store, nestedFriendsUri, nestedFriendsValue);
    putDoc(store, secondDegreeFriendUri, {
      id: "second-degree",
      friends: [],
    });

    return {
      store,
      rootUri,
      directFriendsUri,
      directFriendUri,
      nestedFriendsUri,
      secondDegreeFriendUri,
      fullUserSchema,
      fullFriendsSchema,
      rootValue,
      directFriendValue,
      trackerKey: (id: URI) => `${SPACE}/space/${id}`,
    };
  }

  const cases: Array<{
    name: string;
    targetPath: string[];
    targetValue: unknown;
    selectorPath: string[];
    selectorSchema: JSONSchema;
    linkSchema: JSONSchema;
    expected: unknown;
  }> = [
    {
      name: "narrows an object link schema to the selected property",
      targetPath: [],
      targetValue: { label: "Numbers", values: [1, 2, 3] },
      selectorPath: ["label"],
      selectorSchema: { type: "string" },
      linkSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          values: { type: "array", items: { type: "number" } },
        },
        required: ["label", "values"],
      },
      expected: "Numbers",
    },
    {
      name: "narrows an array link schema to the selected element",
      targetPath: [],
      targetValue: [7, 8],
      selectorPath: ["0"],
      selectorSchema: { type: "number" },
      linkSchema: { type: "array", items: { type: "number" } },
      expected: 7,
    },
    {
      name: "does not apply the link destination path to its schema",
      targetPath: ["payload"],
      targetValue: { payload: { label: "Nested" } },
      selectorPath: ["label"],
      selectorSchema: { type: "string" },
      linkSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
      },
      expected: "Nested",
    },
    {
      name: "drops an array link schema for its synthetic length property",
      targetPath: [],
      targetValue: [7, 8],
      selectorPath: ["length"],
      selectorSchema: { type: "number" },
      linkSchema: { type: "array", items: { type: "number" } },
      expected: 2,
    },
    {
      name: "ignores a false link schema when the reader has its own schema",
      targetPath: [],
      targetValue: "Rejected",
      selectorPath: [],
      selectorSchema: { type: "string" },
      linkSchema: false,
      expected: "Rejected",
    },
    {
      // The permissive traversal's placeholder for a link it will not
      // descend into is null, so the false link schema withholds the target
      // value without voiding the read.
      name: "adopts a false link schema for a permissive reader",
      targetPath: [],
      targetValue: "Rejected",
      selectorPath: [],
      selectorSchema: true,
      linkSchema: false,
      expected: null,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const store = new Map<string, Revision<State>>();
      const rootUri = `of:link-schema-root-${testCase.name}` as URI;
      const targetUri = `of:link-schema-target-${testCase.name}` as URI;
      const rootValue = makeLink(
        targetUri,
        testCase.targetPath,
        testCase.linkSchema,
      );
      putDoc(store, rootUri, rootValue);
      putDoc(store, targetUri, testCase.targetValue);

      const traverser = getTraverser(store, {
        path: ["value", ...testCase.selectorPath],
        schema: testCase.selectorSchema,
      });
      const { ok: result } = traverser.traverse({
        address: {
          space: SPACE,
          id: rootUri,
          type: TYPE,
          path: ["value"],
        },
        value: rootValue,
      });

      expect(result).toEqual(testCase.expected);
    });
  }

  it("returns a linked object missing a field required only by the link schema", () => {
    // The link describes more of its target than the reader asked for. The
    // reader's schema takes precedence at the hop (`combineSchemaForLink`), so
    // the link's extra `required` entry must not void the reader's narrower
    // view of a target that satisfies everything the reader itself demanded.

    const store = new Map<string, Revision<State>>();
    const rootUri = "of:link-schema-required-union-root" as URI;
    const targetUri = "of:link-schema-required-union-target" as URI;
    const linkSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["b"],
    } as const satisfies JSONSchema;
    const rootValue = {
      item: makeLink(targetUri, [], linkSchema),
    };
    putDoc(store, rootUri, rootValue);
    putDoc(store, targetUri, { a: "present" });

    const readerSchema = {
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
      required: ["item"],
    } as const satisfies JSONSchema;
    const traverser = getTraverser(store, {
      path: ["value"],
      schema: readerSchema,
    });
    const { ok, error } = traverser.traverse({
      address: {
        space: SPACE,
        id: rootUri,
        type: TYPE,
        path: ["value"],
      },
      value: rootValue,
    });

    expect(error).toBeUndefined();
    expect(ok).toEqual({ item: { a: "present" } });
  });

  it("does not traverse a link-schema property the reader did not select", () => {
    // The reader's schema keeps the unselected key out of the combined
    // schema's `properties`, so the traversal treats it like any other key the
    // reader did not ask for: the query system carries the raw value through
    // without descending, and the link under it is neither followed nor
    // tracked for the subscription.

    const store = new Map<string, Revision<State>>();
    const rootUri = "of:link-schema-projection-root" as URI;
    const targetUri = "of:link-schema-projection-target" as URI;
    const unselectedUri = "of:link-schema-projection-unselected" as URI;
    const linkSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a", "b"],
    } as const satisfies JSONSchema;
    const rootValue = {
      item: makeLink(targetUri, [], linkSchema),
    };
    const targetValue = {
      a: "present",
      b: makeLink(unselectedUri, [], { type: "string" }),
    };
    putDoc(store, rootUri, rootValue);
    putDoc(store, targetUri, targetValue);
    putDoc(store, unselectedUri, "unselected");

    const readerSchema = {
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      },
      required: ["item"],
    } as const satisfies JSONSchema;
    const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
    const traverser = getTraverser(store, {
      path: ["value"],
      schema: readerSchema,
    }, context);
    const { ok, error } = traverser.traverse({
      address: {
        space: SPACE,
        id: rootUri,
        type: TYPE,
        path: ["value"],
      },
      value: rootValue,
    });

    expect(error).toBeUndefined();
    expect(ok).toEqual({ item: { a: "present", b: targetValue.b } });
    expect(context.schemaTracker.has(`${SPACE}/space/${unselectedUri}`)).toBe(
      false,
    );
  });

  it("limits a recursive friends query to one hop with an opaque boundary", () => {
    // A graph can contain records of one recursive type: for example, every
    // User has a friends Cell whose elements are links to other Users. Each
    // link legitimately carries the full User schema, including its required
    // friends property. A query for "me and my direct friends" must therefore
    // override that nested friends edge with an opaque boundary; otherwise the
    // schema carried by each friend link makes traversal continue to friends of
    // friends (and then onward through the recursive graph).
    //
    // The boundary should retain the direct friend's raw friends pointer in the
    // query result, but must not load or subscribe to the pointer's target. The
    // non-opaque control at the end proves that the deeper documents are
    // reachable and are excluded specifically because of the boundary.

    const {
      store,
      rootUri,
      directFriendsUri,
      directFriendUri,
      nestedFriendsUri,
      secondDegreeFriendUri,
      fullUserSchema,
      fullFriendsSchema,
      rootValue,
      directFriendValue,
      trackerKey,
    } = makeRecursiveFriendsGraph("opaque", true);

    const directFriendSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        friends: {
          type: "array",
          items: fullUserSchema,
          asCell: ["opaque"],
        },
      },
      required: ["id", "friends"],
    } as const satisfies JSONSchema;
    const querySchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        friends: {
          type: "array",
          items: directFriendSchema,
        },
      },
      required: ["id", "friends"],
    } as const satisfies JSONSchema;
    const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
    const traverser = getTraverser(
      store,
      { path: ["value"], schema: querySchema },
      context,
    );

    const { ok: result, error } = traverser.traverse({
      address: {
        space: SPACE,
        id: rootUri,
        type: TYPE,
        path: ["value"],
      },
      value: rootValue,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      id: "root",
      friends: [{ id: "direct", friends: directFriendValue.friends }],
    });

    expect(context.schemaTracker.has(trackerKey(rootUri))).toBe(true);
    expect(context.schemaTracker.has(trackerKey(directFriendsUri))).toBe(true);
    expect(context.schemaTracker.has(trackerKey(directFriendUri))).toBe(true);
    expect(context.schemaTracker.has(trackerKey(nestedFriendsUri))).toBe(false);
    expect(context.schemaTracker.has(trackerKey(secondDegreeFriendUri))).toBe(
      false,
    );

    // Without the explicit boundary, the same schema-bearing graph expands
    // through the direct friend's friends list to the second-degree friend.
    const nonOpaqueDirectFriendSchema = {
      ...directFriendSchema,
      properties: {
        ...directFriendSchema.properties,
        friends: fullFriendsSchema,
      },
    } as const satisfies JSONSchema;
    const nonOpaqueQuerySchema = {
      ...querySchema,
      properties: {
        ...querySchema.properties,
        friends: {
          type: "array",
          items: nonOpaqueDirectFriendSchema,
        },
      },
    } as const satisfies JSONSchema;
    const nonOpaqueContext = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
    const nonOpaqueTraverser = getTraverser(
      store,
      { path: ["value"], schema: nonOpaqueQuerySchema },
      nonOpaqueContext,
    );
    nonOpaqueTraverser.traverse({
      address: {
        space: SPACE,
        id: rootUri,
        type: TYPE,
        path: ["value"],
      },
      value: rootValue,
    });

    expect(nonOpaqueContext.schemaTracker.has(trackerKey(nestedFriendsUri)))
      .toBe(true);
    expect(
      nonOpaqueContext.schemaTracker.has(trackerKey(secondDegreeFriendUri)),
    ).toBe(true);
  });

  it("omits an optional nested friends property narrowed to false", () => {
    // This parent schema corresponds to the projected type
    // `{ id: string; friends?: never }`. The stored link still carries a full
    // User schema with an optional friends list. Combining the two for the
    // link hop should keep `friends: false` without making it required.
    // Traversal can then omit that property while retaining the direct friend
    // record itself.

    const {
      store,
      rootUri,
      directFriendsUri,
      directFriendUri,
      nestedFriendsUri,
      secondDegreeFriendUri,
      fullUserSchema,
      rootValue,
      trackerKey,
    } = makeRecursiveFriendsGraph("false-schema", false);
    const directFriendSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        friends: false,
      },
      required: ["id"],
    } as const satisfies JSONSchema;

    expect(combineSchemaForLink(directFriendSchema, fullUserSchema)).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        friends: false,
      },
      required: ["id"],
    });

    const querySchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        friends: {
          type: "array",
          items: directFriendSchema,
        },
      },
      required: ["id", "friends"],
    } as const satisfies JSONSchema;
    const context = createDefaultTraversalContext(TEST_SCOPE_IDENTITY);
    const traverser = getTraverser(
      store,
      { path: ["value"], schema: querySchema },
      context,
    );

    const { ok: result, error } = traverser.traverse({
      address: {
        space: SPACE,
        id: rootUri,
        type: TYPE,
        path: ["value"],
      },
      value: rootValue,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      id: "root",
      friends: [{ id: "direct" }],
    });
    const directFriend = (result as { friends: Record<string, unknown>[] })
      .friends[0];
    expect(Object.hasOwn(directFriend, "friends")).toBe(false);

    expect(context.schemaTracker.has(trackerKey(rootUri))).toBe(true);
    expect(context.schemaTracker.has(trackerKey(directFriendsUri))).toBe(true);
    expect(context.schemaTracker.has(trackerKey(directFriendUri))).toBe(true);
    expect(context.schemaTracker.has(trackerKey(nestedFriendsUri))).toBe(false);
    expect(context.schemaTracker.has(trackerKey(secondDegreeFriendUri))).toBe(
      false,
    );
  });
});

describe("anyOf fast-reject reactivity invariants (traverseCells)", () => {
  // These tests verify that the fast-reject optimization does NOT break
  // reactivity. When traverseCells=true (the default), the schemaTracker
  // must record every document whose value can affect the result, so that
  // subscriptions fire when any contributing document changes.
  //
  // Key invariants:
  //   1. The root document is ALWAYS tracked.
  //   2. Linked documents reachable through surviving branches are tracked.
  //   3. If the root document later changes (e.g. discriminator flips), the
  //      subscription fires and a fresh traversal discovers the new branch's
  //      links. Therefore, links exclusive to fast-rejected branches do NOT
  //      need to be tracked preemptively — the root doc subscription covers
  //      that scenario.

  const SPACE = "did:null:null";
  const TYPE = "application/json" as const;

  /** Build a tracker key matching the internal getTrackerKey() format. */
  function trackerKey(id: string, scope: CellScope = "space"): string {
    // Instance keys (stage E): the scope segment is the shared scope_key
    // resolved against the traversal's identity, not the scope name.
    return `${SPACE}/${resolveScopeKey(scope, TEST_SCOPE_IDENTITY)}/${id}`;
  }

  /** Shortcut: store a document in the map-based store. */
  function putDoc(
    store: Map<string, Revision<State>>,
    id: string,
    value: unknown,
  ) {
    const entity = id as Entity;
    store.set(`${entity}/${TYPE}`, {
      the: TYPE,
      of: entity,
      is: { value },
      since: 1,
    } as Revision<State>);
  }

  /** Create a link value (sigil v1 format). */
  function makeLink(
    targetId: string,
    path: string[] = [],
    scope?: "space" | "user" | "session",
  ) {
    return {
      "/": {
        [LINK_V1_TAG]: { id: targetId, path, ...(scope && { scope }) },
      },
    };
  }

  /** Access the protected schemaTracker from the traverser. */
  function getSchemaTracker(
    traverser: SchemaObjectTraverser<FabricValue>,
  ): MapSet<string, SchemaPathSelector> {
    return (traverser as any).schemaTracker;
  }

  it("repeat unscoped links keep their values (stage-E neutrality guard)", () => {
    // Two links to one unscoped target inside one traversal. The coverage
    // memo must NOT fire for unscoped links (isLinkedDocumentCovered's
    // neutrality guard): pre-stage-E the coverage key never matched for
    // them, and the covered-skip path replaces a repeat link's value with
    // `null` in traverseCells mode — which value consumers (the html
    // reconciler's cell reads) would render. Both occurrences must carry
    // the value.
    const store = new Map<string, Revision<State>>();
    const rootUri = "of:repeat-link-root" as URI;
    const targetUri = "of:repeat-link-target" as URI;

    const rootValue = {
      a: makeLink(targetUri),
      b: makeLink(targetUri),
    };
    putDoc(store, rootUri, rootValue);
    putDoc(store, targetUri, { label: "hello" });

    const linkedSchema = {
      type: "object",
      properties: { label: { type: "string" } },
    } as const;
    const schema = {
      type: "object",
      properties: { a: linkedSchema, b: linkedSchema },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: rootValue,
    });

    expect(result).toEqual({
      a: { label: "hello" },
      b: { label: "hello" },
    });
  });

  it("tracks same-id linked docs in different scopes separately", () => {
    const store = new Map<string, Revision<State>>();
    const rootUri = "of:scoped-coverage-root" as URI;
    const sharedUri = "of:scoped-coverage-shared" as URI;

    putDoc(store, rootUri, {
      user: makeLink(sharedUri, [], "user"),
      session: makeLink(sharedUri, [], "session"),
    });
    putDoc(store, sharedUri, { label: "same causal id" });

    const linkedSchema = {
      type: "object",
      properties: { label: { type: "string" } },
    } as const;
    const schema = {
      type: "object",
      properties: {
        user: linkedSchema,
        session: linkedSchema,
      },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    traverser.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: {
        user: makeLink(sharedUri, [], "user"),
        session: makeLink(sharedUri, [], "session"),
      },
    });

    const tracker = getSchemaTracker(traverser);
    expect(tracker.has(trackerKey(sharedUri, "user"))).toBe(true);
    expect(tracker.has(trackerKey(sharedUri, "session"))).toBe(true);
  });

  it("tracks the root document even when all anyOf branches are fast-rejected", () => {
    const store = new Map<string, Revision<State>>();
    const docUri = "of:doc-no-match" as URI;

    // Value is a number, but all branches expect string or boolean
    putDoc(store, docUri, 42);

    const schema = {
      anyOf: [
        { type: "string" },
        { type: "boolean" },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    traverser.traverse({
      address: { space: SPACE, id: docUri, type: TYPE, path: ["value"] },
      value: 42,
    });

    const tracker = getSchemaTracker(traverser);
    // Root doc must ALWAYS be tracked — if its value changes, we re-traverse
    expect(tracker.has(trackerKey(docUri))).toBe(true);
  });

  it("tracks linked docs reached through the matching branch (type-based rejection)", () => {
    const store = new Map<string, Revision<State>>();
    const rootUri = "of:doc-disc-root" as URI;
    const circleDataUri = "of:circle-data" as URI;

    putDoc(store, circleDataUri, "radius-info");

    const rootValue = {
      kind: "circle",
      data: makeLink(circleDataUri),
    };
    putDoc(store, rootUri, rootValue);

    // Object branch has a link property; string branch is type-rejected
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            data: { type: "string" },
          },
        },
        { type: "string" },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: rootValue,
    });

    // Correct result — link resolved through object branch
    expect((result as any).kind).toBe("circle");
    expect((result as any).data).toBe("radius-info");

    // "string" branch should be fast-rejected (type mismatch)
    expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(1);

    // Reactivity: both root and linked doc must be tracked
    const tracker = getSchemaTracker(traverser);
    expect(tracker.has(trackerKey(rootUri))).toBe(true);
    expect(tracker.has(trackerKey(circleDataUri))).toBe(true);
  });

  it("tracks linked docs in shared properties even when some branches are fast-rejected", () => {
    const store = new Map<string, Revision<State>>();
    const rootUri = "of:doc-shared-link" as URI;
    const sharedUri = "of:shared-target" as URI;

    putDoc(store, sharedUri, "shared-value");

    // Both branches reference the same property "ref" which has a link.
    // "string" branch is fast-rejected (value is an object), but the
    // surviving "object" branch still traverses "ref".
    const rootValue = {
      name: "test",
      ref: makeLink(sharedUri),
    };
    putDoc(store, rootUri, rootValue);

    const schema = {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            name: { type: "string" },
            ref: { type: "string" },
          },
        },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: rootValue,
    });

    expect((result as any).ref).toBe("shared-value");
    expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(1);

    const tracker = getSchemaTracker(traverser);
    expect(tracker.has(trackerKey(rootUri))).toBe(true);
    expect(tracker.has(trackerKey(sharedUri))).toBe(true);
  });

  it("tracks all linked docs when multiple links survive fast-reject", () => {
    const store = new Map<string, Revision<State>>();
    const rootUri = "of:doc-multi-link" as URI;
    const linkAUri = "of:link-a" as URI;
    const linkBUri = "of:link-b" as URI;

    putDoc(store, linkAUri, "value-a");
    putDoc(store, linkBUri, "value-b");

    const rootValue = {
      kind: "circle",
      linkA: makeLink(linkAUri),
      linkB: makeLink(linkBUri),
    };
    putDoc(store, rootUri, rootValue);

    // Object branch has two links; null and string branches are type-rejected
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            linkA: { type: "string" },
            linkB: { type: "string" },
          },
        },
        { type: "null" },
        { type: "string" },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: rootValue,
    });

    expect((result as any).linkA).toBe("value-a");
    expect((result as any).linkB).toBe("value-b");

    // "null" and "string" branches should be fast-rejected (type mismatch)
    expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);

    // ALL three docs (root + 2 links) must be tracked for reactivity
    const tracker = getSchemaTracker(traverser);
    expect(tracker.has(trackerKey(rootUri))).toBe(true);
    expect(tracker.has(trackerKey(linkAUri))).toBe(true);
    expect(tracker.has(trackerKey(linkBUri))).toBe(true);
  });

  it("root doc subscription ensures rejected-branch links become discoverable on change", () => {
    // Scenario: branch A matches now and has linkA tracked.
    // Branch B is fast-rejected (missing required property); its exclusive
    // linkB is NOT tracked. This is safe because: if the root doc changes
    // to include branch B's required property, the root-doc subscription
    // fires and a fresh traversal will now match branch B and discover linkB.
    //
    // We verify this by doing TWO traversals with different root values.
    // Uses required-property discrimination (const/enum checks removed per
    // review — values may contain unresolved links).
    const store = new Map<string, Revision<State>>();
    const rootUri = "of:doc-flip" as URI;
    const circleLinkUri = "of:circle-link" as URI;
    const squareLinkUri = "of:square-link" as URI;

    putDoc(store, circleLinkUri, "circle-data");
    putDoc(store, squareLinkUri, "square-data");

    // First traversal: has circleOnly → branch A matches, branch B rejected
    const circleValue = {
      circleOnly: true,
      circleLink: makeLink(circleLinkUri),
      squareLink: makeLink(squareLinkUri),
    };
    putDoc(store, rootUri, circleValue);

    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            circleLink: { type: "string" },
          },
          required: ["circleOnly"],
        },
        {
          type: "object",
          properties: {
            squareLink: { type: "string" },
          },
          required: ["squareOnly"],
        },
      ],
    } as JSONSchema;

    const traverser1 = getTraverser(store, { path: ["value"], schema });
    const { ok: result1 } = traverser1.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: circleValue,
    });

    expect((result1 as any).circleLink).toBe("circle-data");
    expect(traverser1.anyOfFastRejects).toBeGreaterThanOrEqual(1);
    const tracker1 = getSchemaTracker(traverser1);
    expect(tracker1.has(trackerKey(rootUri))).toBe(true);
    expect(tracker1.has(trackerKey(circleLinkUri))).toBe(true);

    // Second traversal: root doc changes to have squareOnly
    // (simulates a reactive re-run after the root subscription fires)
    const squareValue = {
      squareOnly: true,
      circleLink: makeLink(circleLinkUri),
      squareLink: makeLink(squareLinkUri),
    };
    putDoc(store, rootUri, squareValue);

    const traverser2 = getTraverser(store, { path: ["value"], schema });
    const { ok: result2 } = traverser2.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: squareValue,
    });

    expect((result2 as any).squareLink).toBe("square-data");
    expect(traverser2.anyOfFastRejects).toBeGreaterThanOrEqual(1);
    const tracker2 = getSchemaTracker(traverser2);
    expect(tracker2.has(trackerKey(rootUri))).toBe(true);
    expect(tracker2.has(trackerKey(squareLinkUri))).toBe(true);
  });

  it("tracks nested linked docs through surviving anyOf branches", () => {
    // Chain: root → midDoc → leafDoc, all through an anyOf-guarded schema
    const store = new Map<string, Revision<State>>();
    const rootUri = "of:doc-nested-root" as URI;
    const midUri = "of:doc-mid" as URI;
    const leafUri = "of:doc-leaf" as URI;

    putDoc(store, leafUri, "leaf-value");
    putDoc(store, midUri, { inner: makeLink(leafUri) });

    const rootValue = {
      kind: "deep",
      ref: makeLink(midUri),
    };
    putDoc(store, rootUri, rootValue);

    // Object branch has nested link chain; string and null branches type-rejected
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string" },
            ref: {
              type: "object",
              properties: {
                inner: { type: "string" },
              },
            },
          },
        },
        { type: "string" },
        { type: "null" },
      ],
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
      value: rootValue,
    });

    expect((result as any).kind).toBe("deep");
    expect((result as any).ref).toEqual({ inner: "leaf-value" });

    // "string" and "null" branches fast-rejected (type mismatch)
    expect(traverser.anyOfFastRejects).toBeGreaterThanOrEqual(2);

    // All three docs in the chain must be tracked
    const tracker = getSchemaTracker(traverser);
    expect(tracker.has(trackerKey(rootUri))).toBe(true);
    expect(tracker.has(trackerKey(midUri))).toBe(true);
    expect(tracker.has(trackerKey(leafUri))).toBe(true);
  });
});
describe("sparse array preservation in traverseDAG", () => {
  it("should preserve sparse array holes through traversal", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:sparse-test" as URI;
    const docEntity = docUri as Entity;

    // Create a sparse array: [10, <hole>, 30]
    // deno-lint-ignore no-explicit-any
    const sparseArray: any[] = new Array(3);
    sparseArray[0] = 10;
    sparseArray[2] = 30;

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: sparseArray },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: true,
    });
    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: sparseArray,
    });
    // Result should be an array with the same sparseness
    expect(Array.isArray(result)).toBe(true);
    const arr = result as unknown[];
    expect(arr.length).toBe(3);
    expect(arr[0]).toBe(10);
    expect(1 in arr).toBe(false); // hole preserved
    expect(arr[2]).toBe(30);
  });

  it("should not change dense array behavior with null elements", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:dense-test" as URI;
    const docEntity = docUri as Entity;

    const denseArray = [1, null, 3];

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: denseArray },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: true,
    });
    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: denseArray,
    });
    const arr = result as unknown[];
    expect(arr.length).toBe(3);
    expect(arr[0]).toBe(1);
    expect(1 in arr).toBe(true); // null is present, not a hole
    expect(arr[1]).toBe(null);
    expect(arr[2]).toBe(3);
  });
});

describe("sparse array preservation in traverseArrayWithSchema", () => {
  it("should preserve sparse array holes through schema-driven traversal", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:sparse-schema-test" as URI;
    const docEntity = docUri as Entity;

    // Create a sparse array: [10, <hole>, 30]
    // deno-lint-ignore no-explicit-any
    const sparseArray: any[] = new Array(3);
    sparseArray[0] = 10;
    sparseArray[2] = 30;

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: sparseArray },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = {
      type: "array",
      items: { type: "number" },
    } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: docUri,
        type,
        path: ["value"],
      },
      value: sparseArray,
    });
    // Result should be an array with the same sparseness
    expect(Array.isArray(result)).toBe(true);
    const arr = result as unknown[];
    expect(arr.length).toBe(3);
    expect(arr[0]).toBe(10);
    expect(1 in arr).toBe(false); // hole preserved
    expect(arr[2]).toBe(30);
  });
});

describe("MapSetStringToPathSelectors assumes pre-interned inputs", () => {
  // MSP's hash fn neither interns nor freezes its input. Callers must
  // hand in an already-interned selector (via `internPathSelector`)
  // for the `hashOfModernInternal` WeakMap cache to retain the hash.
  // These tests verify correctness of dedup under pre-interned inputs,
  // plus the no-op behavior when `hashValues` is false.

  // Content-unique title guarantees no prior interning has seen the
  // exact schema in this test file or in imported modules.
  const uniqueSchema = (): JSONSchema => ({
    type: "object",
    title: `mapSetPathSelectorTestAt${Date.now()}-${Math.random()}`,
  });

  it("deduplicates structurally-equal pre-interned selectors", () => {
    const mapSet = new MapSetStringToPathSelectors(true);
    const schema = uniqueSchema();
    const a = internPathSelector({ path: ["x"], schema });
    const b = internPathSelector({ path: ["x"], schema });
    mapSet.add("k", a);
    mapSet.add("k", b);
    const values = mapSet.get("k");
    expect(values).toBeDefined();
    expect(values!.size).toBe(1);
  });

  it("accepts selectors with `schema: undefined`", () => {
    const mapSet = new MapSetStringToPathSelectors(true);
    const selector = internPathSelector({ path: ["p"] });
    // Must not throw.
    mapSet.add("k", selector);
    expect(mapSet.get("k")!.size).toBe(1);
  });

  it("accepts selectors with boolean schemas", () => {
    const mapSet = new MapSetStringToPathSelectors(true);
    const sTrue = internPathSelector({ path: ["t"], schema: true });
    const sFalse = internPathSelector({ path: ["f"], schema: false });
    mapSet.add("k", sTrue);
    mapSet.add("k", sFalse);
    expect(mapSet.get("k")!.size).toBe(2);
  });

  it("does nothing to inputs when `hashValues` is false", () => {
    const mapSet = new MapSetStringToPathSelectors(false);
    const schema = uniqueSchema();
    const selector: SchemaPathSelector = { path: ["x"], schema };
    mapSet.add("k", selector);
    // Without a hash function, the add path goes through `setMap`
    // which uses reference equality and doesn't freeze anything.
    expect(Object.isFrozen(selector)).toBe(false);
    expect(isInternedSchema(schema)).toBe(false);
  });

  it("is idempotent on repeat add of the same pre-interned selector", () => {
    const mapSet = new MapSetStringToPathSelectors(true);
    const selector = internPathSelector({
      path: ["x"],
      schema: uniqueSchema(),
    });
    mapSet.add("k", selector);
    mapSet.add("k", selector);
    expect(mapSet.get("k")!.size).toBe(1);
  });
});

describe("schemaTrackerCoversSelector", () => {
  // Content-unique title guarantees no prior interning has seen this schema.
  const uniqueSchema = (): JSONSchema => ({
    type: "object",
    title: `coversSelectorTestAt${Date.now()}-${Math.random()}`,
  });

  it("canonicalizes a frozen-but-non-interned selector before lookup", () => {
    // A frozen selector whose schema is frozen yet NOT the canonical interned
    // instance. A fast path keyed off `Object.isFrozen()` would treat this as
    // already-interned and skip canonicalization entirely. The lookup must
    // operate on an interned selector, which means the schema gets interned
    // as a side effect.
    const schema = Object.freeze(uniqueSchema()) as JSONSchema;
    const selector = Object.freeze({
      path: Object.freeze(["value", "x"]),
      schema,
    }) as SchemaPathSelector;
    const tracker = new MapSetStringToPathSelectors(true);

    expect(isInternedSchema(schema)).toBe(false);
    schemaTrackerCoversSelector(tracker, "k", selector);
    expect(isInternedSchema(schema)).toBe(true);
  });
});

describe("SchemaObjectTraverser unknown type handling", () => {
  it("returns undefined for object value matched by type: unknown schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-unknown-object" as URI;
    const docEntity = docUri as Entity;

    const docValue = { key: "value", nested: { count: 42 } };

    const docRevision: Revision<State> = {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    };
    store.set(`${docRevision.of}/${docRevision.the}`, docRevision);

    const schema = { type: "unknown" } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result, error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // type: "unknown" marks the value as opaque — traversal short-circuits
    // without descending, so any links within are not followed
    expect(error).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("returns undefined for array value matched by type: unknown schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-unknown-array" as URI;
    const docEntity = docUri as Entity;

    const linkedUri = "of:doc-unknown-array-target" as URI;
    const docValue = [
      "a",
      { "/": { [LINK_V1_TAG]: { id: linkedUri, path: [] } } },
      "c",
    ];

    store.set(`${docEntity}/${type}`, {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    });
    store.set(`${linkedUri}/${type}`, {
      the: type,
      of: linkedUri as Entity,
      is: { value: { label: "should not appear" } },
      since: 1,
    });

    const schema = { type: "unknown" } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result, error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    // type: "unknown" on an array means the whole array is treated as opaque —
    // traversal short-circuits without following the embedded link
    expect(error).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("does not resolve linked content for object property with type: unknown schema", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const doc1Uri = "of:doc-unknown-prop-target" as URI;
    const doc2Uri = "of:doc-unknown-prop-container" as URI;

    // doc1 is the link target — its content should not appear in the result
    store.set(`${doc1Uri}/${type}`, {
      the: type,
      of: doc1Uri as Entity,
      is: { value: { name: "Alice", secret: "hidden" } },
      since: 1,
    });

    const doc2Value = {
      id: 1,
      data: { "/": { [LINK_V1_TAG]: { id: doc1Uri, path: [] } } },
    };
    store.set(`${doc2Uri}/${type}`, {
      the: type,
      of: doc2Uri as Entity,
      is: { value: doc2Value },
      since: 2,
    });

    const schema = {
      type: "object",
      properties: {
        id: { type: "number" },
        // type: "unknown" prevents the link target from being traversed
        data: { type: "unknown" },
      },
    } as JSONSchema;

    const traverser = getTraverser(store, { path: ["value"], schema });
    const { ok: result } = traverser.traverse({
      address: { space: "did:null:null", id: doc2Uri, type, path: ["value"] },
      value: doc2Value,
    });

    // "id" is traversed normally; "data" link target is not resolved into content
    const obj = result as Record<string, unknown>;
    expect(obj?.id).toBe(1);
    expect(obj?.data).toBeUndefined();
  });

  it("does not resolve linked properties when property schema is type: unknown", () => {
    // Chain: outer => inner => redir => first -> second -> data
    //
    // Redirects locate the reference slot; its ordinary target remains unread.

    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const redirectTestDataUri = "of:doc-redirect-test-data" as URI;
    const redirectTestSecondUri = "of:doc-redirect-test-second" as URI;
    const redirectTestFirstUri = "of:doc-redirect-test-first" as URI;
    const redirectTestRedirUri = "of:doc-redirect-test-redir" as URI;
    const redirectTestInnerUri = "of:doc-redirect-test-inner" as URI;
    const redirectTestOuterUri = "of:doc-redirect-test-outer" as URI;

    // redirect-test-data: holds the actual value
    store.set(`${redirectTestDataUri}/${type}`, {
      the: type,
      of: redirectTestDataUri as Entity,
      is: { value: { label: "should not appear" } },
      since: 1,
    });

    // redirect-test-second: points the actual value
    const secondValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestDataUri, path: [] } },
    };
    store.set(`${redirectTestSecondUri}/${type}`, {
      the: type,
      of: redirectTestSecondUri as Entity,
      is: { value: secondValue },
      since: 2,
    });

    // redirect-test-first: points the actual value
    const firstValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestSecondUri, path: [] } },
    };
    store.set(`${redirectTestFirstUri}/${type}`, {
      the: type,
      of: redirectTestFirstUri as Entity,
      is: { value: firstValue },
      since: 3,
    });

    // redirect-test-redir: holds the actual value
    const redirValue = {
      "/": {
        [LINK_V1_TAG]: { id: redirectTestFirstUri, path: [] },
        overwrite: "redirect",
      },
    };
    store.set(`${redirectTestRedirUri}/${type}`, {
      the: type,
      of: redirectTestRedirUri as Entity,
      is: { value: redirValue },
      since: 4,
    });

    const innerValue = {
      "/": {
        [LINK_V1_TAG]: { id: redirectTestRedirUri, path: [] },
        overwrite: "redirect",
      },
    };
    store.set(`${redirectTestInnerUri}/${type}`, {
      the: type,
      of: redirectTestInnerUri as Entity,
      is: { value: innerValue },
      since: 5,
    });

    const outerValue = {
      inner: {
        "/": {
          [LINK_V1_TAG]: { id: redirectTestInnerUri, path: [] },
          overwrite: "redirect",
        },
      },
    };
    store.set(`${redirectTestOuterUri}/${type}`, {
      the: type,
      of: redirectTestOuterUri as Entity,
      is: { value: outerValue },
      since: 6,
    });

    const schema = {
      type: "object",
      properties: {
        inner: { type: "unknown" },
      },
      required: ["inner"],
      additionalProperties: false,
    } as JSONSchema;

    // Create these without the helper, so we can check the manager to see
    // which objects we include.
    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(tx, {
      path: ["value"],
      schema,
    }, createDefaultTraversalContext(TEST_SCOPE_IDENTITY));

    const { ok: result, error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: redirectTestOuterUri,
        type,
        path: ["value"],
      },
      value: outerValue,
    });

    expect(error).toBeUndefined();
    // linked object is not resolved into content
    expect(result).toEqual({ inner: undefined });
    // We should have read all the way through to the data object
    // While we can change this in the future, this does ensure that we can
    // create a cell on the client for the queried object. For example,
    // we could exclude doc-redirect-test-data here in the future. However,
    // currently, we include all docs we examined, and we did examine this.
    expect(
      [...manager.getReadDocs()].some((att) =>
        att.address.id === redirectTestDataUri
      ),
    ).toBe(true);
  });

  it("does not resolve linked properties when property schema is type: unknown and asCell is true", () => {
    // Chain: outer => inner => redir => first -> second -> data
    //
    // Behavior: All redirect links are followed, toCell() stops at first non-redirect
    // The data is fully resolved to { test: "foo" } but the cell reference stops at `first`

    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const redirectTestDataUri = "of:doc-redirect-test-data" as URI;
    const redirectTestSecondUri = "of:doc-redirect-test-second" as URI;
    const redirectTestFirstUri = "of:doc-redirect-test-first" as URI;
    const redirectTestRedirUri = "of:doc-redirect-test-redir" as URI;
    const redirectTestInnerUri = "of:doc-redirect-test-inner" as URI;
    const redirectTestOuterUri = "of:doc-redirect-test-outer" as URI;

    // redirect-test-data: holds the actual value
    store.set(`${redirectTestDataUri}/${type}`, {
      the: type,
      of: redirectTestDataUri as Entity,
      is: { value: { label: "should not appear" } },
      since: 1,
    });

    // redirect-test-second: points the actual value
    const secondValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestDataUri, path: [] } },
    };
    store.set(`${redirectTestSecondUri}/${type}`, {
      the: type,
      of: redirectTestSecondUri as Entity,
      is: { value: secondValue },
      since: 2,
    });

    // redirect-test-first: points the actual value
    const firstValue = {
      "/": { [LINK_V1_TAG]: { id: redirectTestSecondUri, path: [] } },
    };
    store.set(`${redirectTestFirstUri}/${type}`, {
      the: type,
      of: redirectTestFirstUri as Entity,
      is: { value: firstValue },
      since: 3,
    });

    // redirect-test-redir: holds the actual value
    const redirValue = {
      "/": {
        [LINK_V1_TAG]: {
          id: redirectTestFirstUri,
          path: [],
          overwrite: "redirect",
        },
      },
    };
    store.set(`${redirectTestRedirUri}/${type}`, {
      the: type,
      of: redirectTestRedirUri as Entity,
      is: { value: redirValue },
      since: 4,
    });

    const innerValue = {
      "/": {
        [LINK_V1_TAG]: {
          id: redirectTestRedirUri,
          path: [],
          overwrite: "redirect",
        },
      },
    };
    store.set(`${redirectTestInnerUri}/${type}`, {
      the: type,
      of: redirectTestInnerUri as Entity,
      is: { value: innerValue },
      since: 5,
    });

    const outerValue = {
      inner: {
        "/": {
          [LINK_V1_TAG]: {
            id: redirectTestInnerUri,
            path: [],
            overwrite: "redirect",
          },
        },
      },
    };
    store.set(`${redirectTestOuterUri}/${type}`, {
      the: type,
      of: redirectTestOuterUri as Entity,
      is: { value: outerValue },
      since: 6,
    });

    const schema = {
      type: "object",
      properties: {
        inner: { type: "unknown", asCell: ["cell"] },
      },
      required: ["inner"],
      additionalProperties: false,
    } as JSONSchema;

    // Create these without the helper, so we can check the manager to see
    // which objects we include.
    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(tx, {
      path: ["value"],
      schema,
    }, createDefaultTraversalContext(TEST_SCOPE_IDENTITY));

    const { ok: result, error } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: redirectTestOuterUri,
        type,
        path: ["value"],
      },
      value: outerValue,
    });

    expect(error).toBeUndefined();
    // linked object is not resolved into content
    expect(result).toEqual({ inner: undefined });
    const readIds = [...manager.getReadDocs()].map((att) => att.address.id);
    expect(readIds).toContain(redirectTestInnerUri);
    expect(readIds).toContain(redirectTestRedirUri);
    expect(readIds).toContain(redirectTestFirstUri);
    expect(readIds).not.toContain(redirectTestSecondUri);
    expect(readIds).not.toContain(redirectTestDataUri);
  });

  it("treats inline asCell object properties as opaque when traverseCells=false", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const targetUri = "of:doc-ascell-inline-target" as URI;
    const outerUri = "of:doc-ascell-inline-outer" as URI;

    store.set(`${targetUri}/${type}`, {
      the: type,
      of: targetUri as Entity,
      is: { value: { shouldNotLoad: true } },
      since: 1,
    });

    const outerValue = {
      inner: {
        ref: { "/": { [LINK_V1_TAG]: { id: targetUri, path: [] } } },
        local: 123,
      },
    };
    store.set(`${outerUri}/${type}`, {
      the: type,
      of: outerUri as Entity,
      is: { value: outerValue },
      since: 2,
    });

    const schema = {
      type: "object",
      properties: {
        inner: { type: "object", asCell: ["cell"] },
      },
      required: ["inner"],
      additionalProperties: false,
    } as JSONSchema;

    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const tx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(
      tx,
      { path: ["value"], schema },
      createDefaultTraversalContext(TEST_SCOPE_IDENTITY, false),
    );

    const { ok: result, error } = traverser.traverse({
      address: { space: "did:null:null", id: outerUri, type, path: ["value"] },
      value: outerValue,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ inner: undefined });
    expect(
      [...manager.getReadDocs()].some((att) => att.address.id === targetUri),
    )
      .toBe(false);
  });

  it("type union [unknown, string] treats object value as opaque", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const linkedUri = "of:doc-union-unknown-link" as URI;
    const docUri = "of:doc-union-unknown-obj" as URI;

    store.set(`${linkedUri}/${type}`, {
      the: type,
      of: linkedUri as Entity,
      is: { value: { label: "should not appear" } },
      since: 1,
    });

    const docValue = {
      ref: { "/": { [LINK_V1_TAG]: { id: linkedUri, path: [] } } },
    };
    store.set(`${docUri}/${type}`, {
      the: type,
      of: docUri as Entity,
      is: { value: docValue },
      since: 2,
    });

    // "unknown" in a type array makes any object value opaque
    const schema = { type: ["unknown", "string"] } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result, error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(error).toBeUndefined();
    // Object is treated as opaque — link not followed
    expect(result).toBeUndefined();
  });

  it("type union [unknown, string] passes string values through", () => {
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const docUri = "of:doc-union-unknown-str" as URI;
    const docEntity = docUri as Entity;
    const docValue = "hello";

    store.set(`${docUri}/${type}`, {
      the: type,
      of: docEntity,
      is: { value: docValue },
      since: 1,
    });

    // Primitives are not opaque even when type union includes "unknown"
    const schema = { type: ["unknown", "string"] } as JSONSchema;
    const traverser = getTraverser(store, { path: ["value"], schema });

    const { ok: result, error } = traverser.traverse({
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    });

    expect(error).toBeUndefined();
    expect(result).toBe("hello");
  });
});

describe("canBranchMatch NaN and Infinity type handling", () => {
  // NaN and the infinities are first-class stored numbers, so getJsonType
  // types them as "number": a "number" branch accepts them and a
  // non-number branch rejects them, exactly like any other number.

  it("does not reject NaN against a {type: 'number'} branch", () => {
    expect(canBranchMatch({ type: "number" }, NaN)).toBe(true);
  });

  it("does not reject Infinity against a {type: 'number'} branch", () => {
    expect(canBranchMatch({ type: "number" }, Infinity)).toBe(true);
  });

  it("does not reject -Infinity against a {type: 'number'} branch", () => {
    expect(canBranchMatch({ type: "number" }, -Infinity)).toBe(true);
  });

  it("rejects a string against a {type: 'number'} branch", () => {
    expect(canBranchMatch({ type: "number" }, "hello")).toBe(false);
  });

  it("accepts a finite number against a {type: 'number'} branch", () => {
    expect(canBranchMatch({ type: "number" }, 42)).toBe(true);
  });

  it("rejects NaN against a {type: 'string'} branch", () => {
    // NaN is a number, so a string-only branch definitively excludes it.
    expect(canBranchMatch({ type: "string" }, NaN)).toBe(false);
  });

  it("rejects a finite number against a {type: 'string'} branch", () => {
    expect(canBranchMatch({ type: "string" }, 42)).toBe(false);
  });
});

describe("MapSet size and totalValues", () => {
  // Both getters exist only to fill in the slow-traverse report, so nothing
  // else in the runtime reads them. Covering them here gives them a test that
  // does not depend on machine speed.

  it("counts keys and values in the reference-equality mode", () => {
    const mapSet = new MapSet<string, string>();
    expect(mapSet.size).toBe(0);
    expect(mapSet.totalValues).toBe(0);

    mapSet.add("a", "one");
    mapSet.add("a", "two");
    mapSet.add("b", "three");
    // "two" is already present under "a" by reference, so it does not add.
    mapSet.add("a", "two");

    expect(mapSet.size).toBe(2);
    expect(mapSet.totalValues).toBe(3);
    expect(mapSet.get("a")).toEqual(new Set(["one", "two"]));
    expect(mapSet.get("absent")).toBeUndefined();

    // Emptying a key drops the key, so both counts fall.
    mapSet.deleteValue("b", "three");
    expect(mapSet.size).toBe(1);
    expect(mapSet.totalValues).toBe(2);
  });

  it("counts keys and values in the hash-dedup mode", () => {
    const mapSet = new MapSet<string, { n: number }>((value) => `${value.n}`);
    expect(mapSet.size).toBe(0);
    expect(mapSet.totalValues).toBe(0);

    mapSet.add("a", { n: 1 });
    mapSet.add("a", { n: 2 });
    mapSet.add("b", { n: 3 });
    // A distinct object that hashes the same is a duplicate here, unlike in
    // the reference-equality mode above.
    mapSet.add("a", { n: 2 });

    expect(mapSet.size).toBe(2);
    expect(mapSet.totalValues).toBe(3);

    // Dropping a key takes the values it held with it.
    mapSet.delete("a");
    expect(mapSet.size).toBe(1);
    expect(mapSet.totalValues).toBe(1);
  });
});

describe("SchemaObjectTraverser slow-traverse reporting", () => {
  const type = "application/json" as const;

  // A store that advances the traversal's clock the first time it is read.
  // `traverse()` is synchronous, so a test cannot step the clock from outside
  // while a traversal is in flight; loading a linked doc is the hook that runs
  // during one. If the traversal never reads the store, `advanceMs` never
  // lands and the assertions fail rather than passing vacuously — which is
  // what `readStore` is asserted on.
  class ClockAdvancingStore extends Map<string, Revision<State>> {
    advanced = false;
    readonly #onFirstRead: () => void;

    constructor(onFirstRead: () => void) {
      super();
      this.#onFirstRead = onFirstRead;
    }
    override get(key: string): Revision<State> | undefined {
      if (!this.advanced) {
        this.advanced = true;
        this.#onFirstRead();
      }
      return super.get(key);
    }
  }

  // Runs one real traversal with `elapsed` pinned to `advanceMs`, and returns
  // whatever the logger wrote. `performance.now` is what `logger.timeStart` /
  // `timeEnd` read, so overriding it is what decides the elapsed time the gate
  // sees — no sleeping, and no dependence on how fast this machine is. The
  // package's fake clock has already replaced `performance.now` with its own
  // stub, so the property is saved and put back rather than assumed native.
  function traverseWithElapsed(
    advanceMs: number,
  ): { warnings: string[]; readStore: boolean } {
    const targetUri = "of:slow-traverse-target" as URI;
    const docUri = "of:slow-traverse-doc" as URI;
    // The container links into the target, so resolving it makes the traversal
    // load the target out of the store — the moment the clock advances.
    const docValue = {
      employeeName: {
        "/": {
          [LINK_V1_TAG]: { id: targetUri, path: ["employees", "0", "name"] },
        },
      },
    };

    let now = 1000;
    const store = new ClockAdvancingStore(() => {
      now += advanceMs;
    });
    store.set(`${targetUri}/${type}`, {
      the: type,
      of: targetUri as Entity,
      is: { value: { employees: [{ name: "Bob" }] } },
      since: 1,
    });
    store.set(`${docUri}/${type}`, {
      the: type,
      of: docUri as Entity,
      is: { value: docValue },
      since: 2,
    });

    const traverser = getTraverser(store, { path: ["value"], schema: true });
    const doc: IMemorySpaceValueAttestation = {
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    };

    const warnings: string[] = [];
    const savedWarn = console.warn;
    const savedNow = performance.now;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    Reflect.set(performance, "now", () => now);
    try {
      traverser.traverse(doc);
    } finally {
      Reflect.set(performance, "now", savedNow);
      console.warn = savedWarn;
    }
    return { warnings, readStore: store.advanced };
  }

  it("reports a traversal that crosses the threshold", () => {
    const { warnings, readStore } = traverseWithElapsed(150);

    expect(readStore).toBe(true);
    expect(warnings.length).toBe(1);
    const report = warnings[0];
    expect(report).toContain("slow-traverse");
    expect(report).toContain("150ms");
    expect(report).toContain("doc=of:slow-traverse-doc/application/json");
    // The container and the doc it links into were both tracked, so the report
    // is reading live traversal state rather than a zeroed-out traverser.
    expect(report).toContain("trackerKeys=2");
    expect(report).toContain("trackerVals=2");
    expect(report).toContain("traverseSchema=1");
    expect(report).toContain("maxDepth=1");
    // docVisits is populated only under CF_TRAVERSE_DIAGNOSTICS=1.
    expect(report).toContain("topDocs=n/a (set CF_TRAVERSE_DIAGNOSTICS=1)");
  });

  it("stays quiet for a traversal well under the threshold", () => {
    const { warnings, readStore } = traverseWithElapsed(5);

    expect(readStore).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("stays quiet at the threshold exactly, and reports one ms past it", () => {
    // The gate is `elapsed > SLOW_TRAVERSE_MS`, so 100 is silent and 101 is
    // not. Pinning both sides keeps a later edit from turning it into `>=`
    // without a test noticing.
    expect(traverseWithElapsed(100).warnings).toEqual([]);
    expect(traverseWithElapsed(101).warnings.length).toBe(1);
  });

  // Runs a slow traversal over a container that links into `targetCount`
  // separate docs, linking target `i` exactly `i + 1` times, so every target
  // ends with a different visit count. Ids are long enough to be truncated in
  // the report.
  function traverseLinkingIntoManyDocs(targetCount: number): string[] {
    const docUri = "of:slow-traverse-many-container" as URI;
    const targetUri = (i: number) =>
      `of:slow-traverse-linked-document-${i}` as URI;
    const properties: Record<string, JSONSchema> = {};
    const docValue: Record<string, FabricValue> = {};
    for (let i = 0; i < targetCount; i++) {
      for (let link = 0; link <= i; link++) {
        docValue[`p${i}_${link}`] = {
          "/": { [LINK_V1_TAG]: { id: targetUri(i), path: ["name"] } },
        };
        properties[`p${i}_${link}`] = { type: "string" };
      }
    }

    let now = 1000;
    const store = new ClockAdvancingStore(() => {
      now += 150;
    });
    for (let i = 0; i < targetCount; i++) {
      const of = targetUri(i) as Entity;
      store.set(`${of}/${type}`, {
        the: type,
        of,
        is: { value: { name: `name-${i}` } },
        since: 1,
      });
    }
    store.set(`${docUri}/${type}`, {
      the: type,
      of: docUri as Entity,
      is: { value: docValue },
      since: 2,
    });

    const traverser = getTraverser(store, {
      path: ["value"],
      schema: { type: "object", properties },
    });
    const doc: IMemorySpaceValueAttestation = {
      address: { space: "did:null:null", id: docUri, type, path: ["value"] },
      value: docValue,
    };

    const warnings: string[] = [];
    const savedWarn = console.warn;
    const savedNow = performance.now;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    Reflect.set(performance, "now", () => now);
    setTraverseDiagnostics(true);
    try {
      traverser.traverse(doc);
    } finally {
      setTraverseDiagnostics(undefined);
      Reflect.set(performance, "now", savedNow);
      console.warn = savedWarn;
    }
    return warnings;
  }

  it("names the five most-visited docs when diagnostics are on", () => {
    const warnings = traverseLinkingIntoManyDocs(6);

    expect(warnings.length).toBe(1);
    // Six targets plus the container were visited, and all seven are counted.
    expect(warnings[0]).toContain("uniqueDocs=7");

    const listed = /topDocs=(.*)$/.exec(warnings[0])![1].trim().split(" ");
    // Seven docs were visited and five are named: the field is capped.
    expect(listed.length).toBe(5);
    // Each entry is an id cut to its first 20 characters, then its count.
    for (const entry of listed) {
      expect(entry).toMatch(/^.{20}\.\.=\d+$/);
    }
    // Most-visited first. Target `i` was linked `i + 1` times, so the two
    // least-visited targets are the ones the cap dropped. (These links
    // are unscoped, so the coverage memo deliberately does not skip
    // their re-walks — the neutrality guard in isLinkedDocumentCovered
    // keeps unscoped links being re-walked, and this assertion pins that
    // behavior.)
    const counts = listed.map((entry) => Number(entry.split("=")[1]));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(counts).not.toContain(1);
    expect(counts).not.toContain(2);
  });

  it("collects nothing when diagnostics are off", () => {
    // The default, and what every job that measures coverage runs under.
    expect(traverseWithElapsed(150).warnings[0]).toContain("uniqueDocs=0");
  });
});

describe("SchemaObjectTraverser schema memo keys", () => {
  const SPACE = "did:null:null";
  const TYPE = "application/json" as const;

  // An inline document: one whose id is a data URI carrying the document's
  // whole content, which is what a pattern's UI produces for a component
  // holding a list of labelled entries — the emoji list an autocomplete
  // offers, say. The traversal walks every node under that one id, so the id
  // is the same on thousands of visits while only the path differs.
  function inlineDocument(groupCount: number): {
    id: URI;
    value: FabricValue;
    schema: JSONSchema;
  } {
    const entries = (group: number) =>
      Object.fromEntries(
        Array.from(
          { length: groupCount },
          (_, i) => [`entry${i}`, `label for entry ${i} of group ${group}`],
        ),
      );
    const value = {
      items: Object.fromEntries(
        Array.from(
          { length: groupCount },
          (_, group) => [`group${group}`, entries(group)],
        ),
      ),
    };
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    } as JSONSchema;
    return { id: dataUriFromValue(value) as URI, value, schema };
  }

  // Traverses one inline document and hands back the memo it filled.
  function traverseInlineDocument(groupCount: number): {
    memo: SchemaMemo;
    idLength: number;
  } {
    const { id, value, schema } = inlineDocument(groupCount);
    const memo = createSchemaMemo();
    const traverser = getTraverser(
      new Map<string, Revision<State>>(),
      { path: ["value"], schema },
      createDefaultTraversalContext(TEST_SCOPE_IDENTITY),
      memo,
    );
    traverser.traverse({
      address: { space: SPACE, id, type: TYPE, path: ["value"] },
      value,
    });
    return { memo, idLength: id.length };
  }

  it("holds one bounded key per visit, whatever the id costs", () => {
    const { memo, idLength } = traverseInlineDocument(20);

    // The traversal reached every entry, so the memo speaks for hundreds of
    // visits rather than for a single node.
    expect(memo.size).toBeGreaterThan(400);
    // The id runs to tens of thousands of characters, so a key that carried
    // it would cost a copy and a hash of that much on every one of those
    // visits.
    expect(idLength).toBeGreaterThan(10_000);

    const longestKey = Math.max(...[...memo.keys()].map((key) => key.length));
    expect(longestKey).toBeLessThan(1000);
  });

  it("grows its key material with the visit count, not the id length", () => {
    // Doubling the fan-out quadruples the visit count, and quadruples the
    // length of the id along with it. Key material that carried the id would
    // grow with the product of the two; carrying a fixed-size stand-in
    // instead, it grows with the visit count alone, so the share per visit
    // holds steady.
    const small = traverseInlineDocument(10);
    const large = traverseInlineDocument(20);

    const perVisit = ({ memo }: { memo: SchemaMemo }) =>
      [...memo.keys()].reduce((total, key) => total + key.length, 0) /
      memo.size;

    expect(large.idLength).toBeGreaterThan(small.idLength * 3);
    expect(perVisit(large)).toBeLessThan(perVisit(small) * 1.1);
  });
});

describe("schemaAcceptsType()", () => {
  it("returns `true` when a union arm's `$ref` names a definition only the union declares", () => {
    expect(schemaAcceptsType({
      $defs: { Name: { type: "string" } },
      anyOf: [{ $ref: "#/$defs/Name" }],
    }, "string")).toBe(true);
  });

  it("returns `false` when a union arm's own `$defs` define its `$ref` as the type but the union's define it otherwise", () => {
    // `#/$defs/Name` names the union's definition: the arm sits in the
    // union's document, and its own `$defs` is inert there.
    expect(schemaAcceptsType({
      $defs: { Name: { type: "number" } },
      anyOf: [{ $ref: "#/$defs/Name", $defs: { Name: { type: "string" } } }],
    }, "string")).toBe(false);
  });

  it("returns `true` when the union declares no `$defs` and the arm resolves as the document it is", () => {
    expect(schemaAcceptsType({
      anyOf: [{ $ref: "#/$defs/Name", $defs: { Name: { type: "string" } } }],
    }, "string")).toBe(true);
  });
});
