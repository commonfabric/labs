// fabric-safety (#4527): a `FabricPrimitive` (state in private `#fields`,
// zero enumerable own-props) must traverse as a fully-opaque leaf, while a
// `FabricInstance` — which can have model-visible outgoing references — must
// fail loudly rather than be silently rebuilt as a plain record (stripping
// its class and codec identity) or leafed whole, until it can be descended
// by its codec contents. Covers `traverseDAG`'s record branch and the
// schema-`default` processing; the dispatch-path primitive cases double as
// regression coverage for the value-type dispatch's leaf arm.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import type { SchemaPathSelector } from "@commonfabric/api";

import { Runtime } from "../src/runtime.ts";
import { processDefaultValue } from "../src/schema.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("fabric-safety traverse leaf");
const space = signer.did();

// The acting identity traversal tracker keys resolve scoped addresses
// against (stage E).
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

describe("FabricPrimitive leaf routing in schema traversal", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("returns a stored FabricPrimitive intact through a typed-object schema read", async () => {
    const schema = {
      type: "object",
      properties: { blob: { type: "object" } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-read",
      schema,
      tx,
    );
    // A native Uint8Array interns to FabricBytes on the write path.
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
    expect(
      Array.from((got.blob as FabricBytes).slice()),
    ).toEqual([1, 2, 3]);
  });

  it("keeps rejecting a FabricPrimitive where the schema type already rejected it", async () => {
    // Under `{ type: "string" }` the pre-fix record branch failed the type
    // gate for a FabricBytes; the leaf arm must preserve that verdict (the
    // fix changes decomposition, not accept/reject outcomes).
    const schema = {
      type: "object",
      properties: { blob: { type: "string" } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-reject",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    // Pre-fix observed behavior for a type-gate failure on a property read:
    // the property is absent from the result. The leaf arm keeps it absent.
    expect(got).not.toHaveProperty("blob");
  });

  it("rejects a FabricPrimitive under an object schema requiring a property it lacks", async () => {
    // Decided semantics (reversing the earlier provisional surfacing): an
    // object-typed schema's `required` keys must exist on the leaf, checked
    // with `in` exactly as the anyOf prefilters already did. A FabricBytes
    // has no `x`.
    const schema = {
      type: "object",
      properties: { blob: { type: "object", required: ["x"] } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-required",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got).not.toHaveProperty("blob");
  });

  it("surfaces a FabricPrimitive under an object schema requiring a property it has", async () => {
    // Required keys are satisfied by class accessors (`in`, prototype chain
    // included): a FabricBytes has `length`, matching the TypeScript
    // structural intuition that a FabricBytes is assignable to
    // `{length: number}`.
    const schema = {
      type: "object",
      properties: { blob: { type: "object", required: ["length"] } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-required-length",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
  });

  it("surfaces a FabricPrimitive under the generator's brand-requiring object schema", async () => {
    // The schema-generator emits this exact shape for a FabricBytes-typed
    // field: the nominal brand key is required, but it has no runtime
    // existence — a `FabricSpecialObject` satisfies it by construction.
    // Regression guard for CT-1836's fetchBinary materialization.
    const schema = {
      type: "object",
      properties: {
        blob: {
          type: "object",
          required: ["length", "@commonfabric/FabricSpecialObject"],
        },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-required-brand",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
  });

  it("surfaces a FabricPrimitive under an object schema with empty `required`", async () => {
    // An empty list demands nothing, so the primitive passes as a plain
    // `{type: "object"}` leaf.
    const schema = {
      type: "object",
      properties: { blob: { type: "object", required: [] } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-required-empty",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
  });

  it("returns a `FabricPrimitive` intact under its specific type", async () => {
    const schema = {
      type: "object",
      properties: { blob: { type: "FabricBytes" } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-fabric-read",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
    expect(
      Array.from((got.blob as FabricBytes).slice()),
    ).toEqual([1, 2, 3]);
  });

  it("rejects a `FabricPrimitive` under a different `FabricPrimitive` type", async () => {
    // A FabricBytes is not a FabricHash: the specific types don't cross-match
    // even though both validate under "object".
    const schema = {
      type: "object",
      properties: { blob: { type: "FabricHash" } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-fabric-cross-reject",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([1, 2, 3]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    // Same surfacing as other property type-gate failures: absent.
    expect(got).not.toHaveProperty("blob");
  });

  it("rejects a plain record under a `FabricPrimitive` type", async () => {
    // The subtype relation is one-way: "object" accepts a FabricBytes, but
    // "FabricBytes" does not accept a plain record.
    const schema = {
      type: "object",
      properties: { blob: { type: "FabricBytes" } },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: { x: number } }>(
      space,
      "typed-fabric-record-reject",
      schema,
      tx,
    );
    c.set({ blob: { x: 1 } });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got).not.toHaveProperty("blob");
  });

  it("matches the `FabricPrimitive` branch of an anyOf", async () => {
    const schema = {
      type: "object",
      properties: {
        blob: { anyOf: [{ type: "FabricBytes" }, { type: "string" }] },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array | string }>(
      space,
      "typed-fabric-anyof",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([4, 5]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);

    // The string branch of the same anyOf still accepts a string.
    c.withTx(tx).set({ blob: "hello" });
    await tx.commit().settled;
    tx = runtime.edit();
    const got2 = c.withTx(tx).get() as Record<string, unknown>;
    expect(got2.blob).toBe("hello");
  });

  it("matches a FabricPrimitive via a sibling anyOf branch when the object branch demands `required`", async () => {
    // The `{type: "object", required: [...]}` branch cannot match an opaque
    // leaf; the fabric-typed sibling can, so the value still comes through.
    const schema = {
      type: "object",
      properties: {
        blob: {
          anyOf: [
            { type: "object", required: ["x"] },
            { type: "FabricBytes" },
          ],
        },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-fabric-anyof-required-sibling",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([6]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
  });

  it("matches the generator's brand-requiring branch of an anyOf", async () => {
    // The anyOf prefilters must apply the same brand exemption as the leaf
    // arm: a branch requiring ["length", brand] is satisfiable by a
    // FabricBytes, so pre-pruning must not reject it.
    const schema = {
      type: "object",
      properties: {
        blob: {
          anyOf: [
            {
              type: "object",
              required: ["length", "@commonfabric/FabricSpecialObject"],
            },
            { type: "string" },
          ],
        },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-fabric-anyof-brand",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([8]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
  });

  it("rejects a FabricPrimitive when every anyOf branch demands `required`", async () => {
    const schema = {
      type: "object",
      properties: {
        blob: { anyOf: [{ type: "object", required: ["x"] }] },
      },
    } as const satisfies JSONSchema;
    const c = runtime.getCell<{ blob: Uint8Array }>(
      space,
      "typed-fabric-anyof-required-only",
      schema,
      tx,
    );
    c.set({ blob: new Uint8Array([7]) });
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got).not.toHaveProperty("blob");
  });

  it("returns a FabricPrimitive schema-default intact (typed-object property)", async () => {
    // Runtime reality (see #4529's cfc red): interned schemas can carry
    // FabricPrimitive defaults (a native Uint8Array default interns to
    // FabricBytes). The static JSONSchema `default` type is JSON-shaped, so
    // the instance is placed via a cast here.
    const blobDefault = new FabricBytes(new Uint8Array([7, 8]));
    const schema = {
      type: "object",
      properties: {
        blob: {
          type: "object",
          default: blobDefault,
        },
      },
    } as unknown as JSONSchema;
    const c = runtime.getCell<{ blob?: Uint8Array }>(
      space,
      "default-read",
      schema,
      tx,
    );
    c.set({});
    await tx.commit().settled;
    tx = runtime.edit();

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
    expect(
      Array.from((got.blob as FabricBytes).slice()),
    ).toEqual([7, 8]);
  });

  it("returns a FabricPrimitive inside a parent default under a `true` property schema intact", () => {
    // The property schema is `true`, so the per-property default processing
    // takes the non-record-schema path (annotateWithBackToCellSymbols), which
    // must also treat a primitive as an atomic leaf.
    const blobDefault = new FabricBytes(new Uint8Array([9, 9, 1]));
    const schema = {
      type: "object",
      properties: { blob: true },
      default: { blob: blobDefault },
    } as unknown as JSONSchema;
    // The cell is never written: reading a valueless cell applies the whole
    // schema-level default, which is then processed per-property (blob's
    // schema is `true`, so its default slice takes the non-record-schema
    // path).
    const c = runtime.getCell<{ blob?: Uint8Array }>(
      space,
      "default-true-read",
      schema,
      tx,
    );

    const got = c.withTx(tx).get() as Record<string, unknown>;
    expect(got.blob).toBeInstanceOf(FabricBytes);
    expect(
      Array.from((got.blob as FabricBytes).slice()),
    ).toEqual([9, 9, 1]);
  });

  it("traverseDAG returns a FabricPrimitive intact under a true schema (store-level)", () => {
    // Mirrors traverse.test.ts's store-backed harness: this exercises the
    // querySchema traverser (StandardObjectCreator), whose `traverseDAG`
    // record branch rebuilds via Object.entries.
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const uri = "of:fabric-dag" as URI;
    const entity = uri as Entity;
    const value = {
      blob: new FabricBytes(
        new Uint8Array([4, 5, 6]),
      ),
    };
    store.set(`${entity}/${type}`, {
      the: type,
      of: entity,
      is: { value },
      since: 1,
    });
    const selector: SchemaPathSelector = { path: ["value"], schema: true };
    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const storeTx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(
      storeTx,
      selector,
      createDefaultTraversalContext(TEST_SCOPE_IDENTITY),
    );

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: uri,
        type,
        path: ["value"],
      },
      value,
    });

    expect((result as Record<string, unknown>).blob).toBeInstanceOf(
      FabricBytes,
    );
  });

  it("traverseDAG leafs a FabricInstance whole (deliberate back-off from fail-loud)", () => {
    // A `FabricInstance` is not a fully-opaque leaf and correct traversal
    // descends it by codec contents (not yet built). This path carries live
    // instance traffic today -- the fetch builtins store a `FabricError`
    // result value that the query path reads back through `traverseDAG` --
    // so failing loudly here breaks fetch reactivity (uncaught rejection in
    // the tracked-query refresh). Until codec-contents descent exists, the
    // instance leafs through whole; this pins that deliberate back-off.
    const store = new Map<string, Revision<State>>();
    const type = "application/json" as const;
    const uri = "of:fabric-dag-instance" as URI;
    const entity = uri as Entity;
    const failure = FabricError.fromNativeError(new Error("leaf me"));
    const value = { failure: failure };
    store.set(`${entity}/${type}`, {
      the: type,
      of: entity,
      is: { value },
      since: 1,
    });
    const selector: SchemaPathSelector = { path: ["value"], schema: true };
    const manager = new StoreObjectManager(store);
    const managedTx = new ManagedStorageTransaction(manager);
    const storeTx = new ExtendedStorageTransaction(managedTx);
    const traverser = new SchemaObjectTraverser(
      storeTx,
      selector,
      createDefaultTraversalContext(TEST_SCOPE_IDENTITY),
    );

    const { ok: result } = traverser.traverse({
      address: {
        space: "did:null:null",
        id: uri,
        type,
        path: ["value"],
      },
      value,
    });

    expect((result as Record<string, unknown>).failure).toBe(failure);
  });

  it("fails loudly on a FabricInstance schema-default (not yet handled)", () => {
    // Driven at the `processDefaultValue` layer directly: an interned schema
    // cannot currently deliver a `FabricInstance` default to this layer
    // end-to-end -- the intern-time canonicalization walk
    // (`canonicalizeSchemaKeyOrder`) rebuilds one as a plain record first,
    // stripping its class (recorded as a finding on #4527). A default
    // reaching this layer intact must fail loudly rather than be rebuilt or
    // silently leafed.
    const failureDefault = FabricError.fromNativeError(new Error("nope"));
    expect(() =>
      processDefaultValue(runtime, tx, {
        space,
        id: "of:default-instance-unit" as URI,
        scope: "space",
        path: [],
        schema: { type: "object" } as JSONSchema,
      }, failureDefault)
    ).toThrow(/Cannot yet handle/);
  });

  it("fails loudly on a FabricInstance default under a non-record schema (annotate path, not yet handled)", () => {
    // A `true` schema routes `processDefaultValue` down its non-record-schema
    // path (annotateWithBackToCellSymbols). Skipping annotation is right for
    // a fully-opaque primitive but not obviously right for a
    // `FabricInstance`, so that path fails loudly too.
    const failureDefault = FabricError.fromNativeError(new Error("nope"));
    expect(() =>
      processDefaultValue(runtime, tx, {
        space,
        id: "of:default-instance-annotate-unit" as URI,
        scope: "space",
        path: [],
        schema: true,
      }, failureDefault)
    ).toThrow(/Cannot yet handle/);
  });
});
