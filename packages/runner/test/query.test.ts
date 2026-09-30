import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import type {
  MIME,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { JSONObject, type JSONSchema } from "../src/index.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  CompoundCycleTracker,
  createTraversalContext,
  ManagedStorageTransaction,
  MapSet,
  MapSetStringToPathSelectors,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// The acting identity traversal tracker keys resolve scoped addresses
// against (stage E); these fixtures use space-scoped docs.
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

describe("Query", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  const store: Map<string, Revision<State>> = new Map<
    string,
    Revision<State>
  >();
  let emulatedStorageTx: IExtendedStorageTransaction;
  let tracker: CompoundCycleTracker<FabricValue, JSONSchema | undefined>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    const manager = new StoreObjectManager(store);
    const managerTx = new ManagedStorageTransaction(manager);
    emulatedStorageTx = new ExtendedStorageTransaction(managerTx);
    tracker = new CompoundCycleTracker<
      FabricValue,
      JSONSchema | undefined
    >();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    //store.clear();
  });

  it("should track schemas used for each doc traversed with pointer", () => {
    const docValue1 = {
      employees: [{ fulllName: { first: "Bob", last: "Hope" } }],
    };
    const testCell1 = runtime.getCell<
      { employees: { fulllName: { first: string } }[] }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.set(docValue1);
    const entityId1 = entityRefToString(testCell1.entityId);
    const assert1: Revision<State> = {
      the: "application/json",
      of: `of:${entityId1}`,
      is: { value: testCell1.get() },
      since: 1,
    };
    const docValue2 = {
      name: {
        "/": {
          [LINK_V1_TAG]: {
            id: `of:${entityId1}`,
            path: ["employees", "0", "fullName"],
          },
        },
      },
    };
    const testCell2 = runtime.getCell<
      { name: { ["/"]: Record<string, unknown> } }
    >(
      space,
      `query test cell 2`,
      undefined,
      tx,
    );
    testCell2.setRaw(docValue2);
    const entityId2 = entityRefToString(testCell2.entityId);
    const assert2: Revision<State> = {
      the: "application/json",
      of: `of:${entityId2}`,
      is: { value: docValue2 },
      since: 2,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);
    const schema = {
      "type": "object",
      "properties": {
        "name": {
          "type": "object",
          "properties": { "first": { "type": "string" } },
          "additionalProperties": false,
        },
      },
      "additionalProperties": false,
    } as const satisfies JSONSchema;
    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      emulatedStorageTx,
      { path: ["value"], schema },
      createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
        true,
      ),
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse({
      address: {
        space: "did:null:null",
        id: assert2.of,
        type: assert2.the,
        path: ["value"],
      },
      value: (assert2.is as JSONObject).value,
    });
    const selectorSet1 = schemaTracker.get(
      `did:null:null/space/of:${entityId1}`,
    );
    const selectorSet2 = schemaTracker.get(
      `did:null:null/space/of:${entityId2}`,
    );
    expect(selectorSet1?.size).toBe(1);
    expect(selectorSet2?.size).toBe(1);
    const [selector1] = selectorSet1!.values();
    const [selector2] = selectorSet2!.values();
    expect(selector2).toEqual({ path: ["value"], schema });
    expect(selector1).toEqual({
      path: ["value", "employees", "0", "fullName"],
      schema: schema.properties.name,
    });
  });

  it("should handle true schema", () => {
    const testCell1 = runtime.getCell<
      { employees: { name: { first: string } }[] }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.set({ employees: [{ name: { first: "Bob" } }] });
    const entityId1 = entityRefToString(testCell1.entityId);
    const assert1: Revision<State> = {
      the: "application/json",
      of: `of:${entityId1}`,
      is: { value: testCell1.get() },
      since: 1,
    };
    const testCell2 = runtime.getCell<
      { name: { ["/"]: Record<string, unknown> } }
    >(
      space,
      `query test cell 2`,
      undefined,
      tx,
    );
    const docValue2 = {
      name: {
        "/": {
          [LINK_V1_TAG]: {
            id: `of:${entityId1}`,
            path: ["employees", "0", "name"],
          },
        },
      },
    };
    testCell2.setRaw(docValue2);
    const entityId2 = entityRefToString(testCell2.entityId);
    const assert2: Revision<State> = {
      the: "application/json",
      of: `of:${entityId2}`,
      is: { value: docValue2 },
      since: 2,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);
    const schema = {
      "type": "object",
      "additionalProperties": true,
    } as const satisfies JSONSchema;
    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      emulatedStorageTx,
      { path: ["value"], schema },
      createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
        true,
      ),
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse({
      address: {
        space: "did:null:null",
        id: assert2.of,
        type: assert2.the,
        path: ["value"],
      },
      value: (assert2.is as JSONObject).value,
    });
    const selectorSet1 = schemaTracker.get(
      `did:null:null/space/of:${entityId1}`,
    );
    const selectorSet2 = schemaTracker.get(
      `did:null:null/space/of:${entityId2}`,
    );
    expect(selectorSet1?.size).toBe(1);
    expect(selectorSet2?.size).toBe(1);
    const [selector1] = selectorSet1!.values();
    const [selector2] = selectorSet2!.values();
    expect(selector2).toEqual({ path: ["value"], schema });
    expect(selector1).toEqual({
      path: ["value", "employees", "0", "name"],
      schema: true,
    });
  });

  it("should handle pointer loops", () => {
    // schema that enables loops
    const schema = {
      "$ref": "#/$defs/Root",
      "$defs": {
        "Root": {
          "type": "object",
          "properties": {
            "name": { "$ref": "#/$defs/Root" },
            "firstName": { "type": "string" },
          },
        },
      },
    } as const satisfies JSONSchema;
    // Now we make the doc with the cycle
    const testCell1 = runtime.getCell<
      { name: { ["/"]: Record<string, unknown> } }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.setRaw({
      name: {
        "/": {
          [LINK_V1_TAG]: {
            id: "of:<placeholder>",
            path: ["name"],
          },
        },
      },
    });
    const entityId1 = entityRefToString(testCell1.entityId);
    const assert1 = {
      the: "application/json" as MIME,
      of: `of:${entityId1}` as URI,
      is: {
        value: {
          name: {
            "/": {
              [LINK_V1_TAG]: {
                id: `of:${entityId1}`,
                path: ["name"],
              },
            },
          },
        },
      },
      since: 1,
    };
    store.set(`${assert1.of}/${assert1.the}`, assert1);
    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      emulatedStorageTx,
      { path: ["value"], schema },
      createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
        true,
      ),
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse({
      address: {
        space: "did:null:null",
        id: assert1.of,
        type: assert1.the,
        path: ["value"],
      },
      value: assert1.is.value,
    });
    const selectorSet1 = schemaTracker.get(
      `did:null:null/space/of:${entityId1}`,
    );
    expect(selectorSet1?.size).toBe(2);
    expect(selectorSet1).toContainEqual({ path: ["value"], schema });
    expect(selectorSet1).toContainEqual({
      path: ["value", "name"],
      schema,
    });
  });

  it("detects pointer cycles when schema initially differ", () => {
    const testCell1 = runtime.getCell<
      { name: { ["/"]: Record<string, unknown> } }
    >(
      space,
      "query cycle schema test cell1",
      undefined,
      tx,
    );

    const testCell2 = runtime.getCell<
      { name: { ["/"]: Record<string, unknown> } }
    >(
      space,
      "query cycle schema test cell2",
      undefined,
      tx,
    );

    // testCell1 self property points to itself
    const assert1: Revision<State> = {
      the: "application/json",
      of: testCell1.sourceURI,
      is: {
        value: {
          self: {
            "/": {
              [LINK_V1_TAG]: {
                id: testCell1.sourceURI,
                path: [],
              },
            },
          },
          other: {
            "/": {
              [LINK_V1_TAG]: {
                id: testCell2.sourceURI,
                path: [],
              },
            },
          },
        },
      },
      since: 1,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);

    const assert2: Revision<State> = {
      the: "application/json",
      of: testCell2.sourceURI,
      is: {
        value: {
          self: {
            "/": {
              [LINK_V1_TAG]: {
                id: testCell2.sourceURI,
                path: [],
              },
            },
          },
        },
      },
      since: 2,
    };

    store.set(`${assert2.of}/${assert2.the}`, assert2);

    // Top level cell matches, but our other link does not, since
    // additionalProperties is not provided.
    // After walking down the self property of the top level cell, our other
    // link does match, since it's a property of that schema.
    const schema = {
      "$ref": "#/$defs/Node",
      "$defs": {
        "Node": {
          "type": "object",
          "required": ["self"],
          "properties": {
            "self": {
              "type": "object",
              "properties": {
                "self": { "$ref": "#/$defs/Node" },
                "other": { "$ref": "#/$defs/Node" },
              },
            },
          },
        },
      },
    } as const satisfies JSONSchema;

    const schemaTracker = new MapSetStringToPathSelectors(true);
    const traverser = new SchemaObjectTraverser(
      emulatedStorageTx,
      { path: ["value"], schema },
      createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
        true,
      ),
    );

    const result = traverser.traverse({
      address: {
        space: "did:null:null",
        id: testCell1.sourceURI,
        type: "application/json",
        path: ["value"],
      },
      value: (assert1.is as JSONObject).value,
    });

    expect(result).toBeDefined();

    // Our matching selectors for both entries should each have one entry for
    // the top level schema, and one entry for the schema at `self`.
    const selectors1 = schemaTracker.get(
      `did:null:null/space/${testCell1.sourceURI}`,
    );
    expect(selectors1).not.toBeUndefined();
    expect(selectors1?.size).toBe(2);
    expect(selectors1).toContainEqual({ path: ["value"], schema });

    const selectors2 = schemaTracker.get(
      `did:null:null/space/${testCell2.sourceURI}`,
    );
    expect(selectors2).not.toBeUndefined();
    expect(selectors2?.size).toBe(2);
    expect(selectors2).toContainEqual({ path: ["value"], schema });
  });

  it("should handle paths in schema and cell links", () => {
    const docValue1 = { home: { street: "1 Infinite Loop" } };
    const testCell1 = runtime.getCell<
      { home: { street: string } }
    >(
      space,
      `query test cell 1`,
      undefined,
      tx,
    );
    testCell1.set(docValue1);
    const entityId1 = entityRefToString(testCell1.entityId);
    const assert1: Revision<State> = {
      the: "application/json",
      of: `of:${entityId1}`,
      is: { value: testCell1.get() },
      since: 1,
    };

    const docValue2 = {
      employees: [{
        address: testCell1.key("home").getAsLink({ baseSpace: space }),
      }],
    };
    const testCell2 = runtime.getCell<any>(
      space,
      `query test cell 2`,
      undefined,
      tx,
    );
    testCell2.setRaw(docValue2);

    const schema = { "type": "string" } as const satisfies JSONSchema;
    const selector = {
      path: ["value", "employees", "0", "address", "street"],
      schema,
    };

    const entityId2 = entityRefToString(testCell2.entityId);
    const assert2: Revision<State> = {
      the: "application/json",
      of: `of:${entityId2}`,
      is: { value: testCell2.getRaw() },
      since: 2,
    };

    store.set(`${assert1.of}/${assert1.the}`, assert1);
    store.set(`${assert2.of}/${assert2.the}`, assert2);

    const schemaTracker = new MapSet<string, SchemaPathSelector>();
    const traverser = new SchemaObjectTraverser(
      emulatedStorageTx,
      selector,
      createTraversalContext(
        tracker,
        schemaTracker,
        TEST_SCOPE_IDENTITY,
        true,
      ),
    );
    // We've provided a schema context for this, so traverse it
    traverser.traverse({
      address: {
        space: "did:null:null",
        id: assert2.of,
        type: assert2.the,
        path: ["value"],
      },
      value: (assert2.is as JSONObject).value,
    });
    const selectorSet1 = schemaTracker.get(
      `did:null:null/space/of:${entityId1}`,
    );
    const selectorSet2 = schemaTracker.get(
      `did:null:null/space/of:${entityId2}`,
    );
    expect(selectorSet1?.size).toBe(1);
    expect(selectorSet2?.size).toBe(1);
    const [selector1] = selectorSet1!.values();
    const [selector2] = selectorSet2!.values();
    expect(selector1).toEqual({
      path: ["value", "home", "street"],
      schema: schema, // {"type": "string"}
    });
    expect(selector2).toEqual({
      path: selector.path, // ["employees", "0", "address", "street"]
      schema: selector.schema,
    });
  });
});
