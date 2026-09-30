// fabric-safety (#4527): the schema traversal's special-object handling must
// distinguish the two special-object classes. A
// `FabricPrimitive` (state in private `#fields`, zero enumerable own-props)
// is a fully-opaque leaf. A `FabricInstance` — which can have model-visible
// outgoing references — must fail loudly rather than be silently leafed
// whole or rebuilt as a plain record (stripping its class and codec
// identity), until it can be descended by its codec contents. Covers the
// value-type dispatch's leaf arm and the plain-schema fast path's
// special-object check.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { internSchema } from "@commonfabric/data-model-schema";
import type { FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  FabricError,
  FabricLink,
} from "@commonfabric/data-model/fabric-instances";
import {
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";
import type { SchemaPathSelector } from "@commonfabric/api";

import { FABRIC_SPECIAL_OBJECT_BRAND } from "../src/fabric-special-object-brand.ts";
import {
  createDefaultTraversalContext,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

const traverserOver = (
  uri: string,
  value: FabricValue,
  selector: SchemaPathSelector,
  // `traverseCells: false` (a value read's setting) enables the plain-schema
  // fast path; the query path's `true` gates it off.
  traverseCells = true,
  linkedValues: Record<string, FabricValue> = {},
) => {
  const store = new Map<string, Revision<State>>();
  const type = "application/json" as const;
  const entity = uri as URI as Entity;
  store.set(`${entity}/${type}`, {
    the: type,
    of: entity,
    is: { value },
    since: 1,
  });
  for (const [linkedUri, value] of Object.entries(linkedValues)) {
    const linkedEntity = linkedUri as URI as Entity;
    store.set(`${linkedEntity}/${type}`, {
      the: type,
      of: linkedEntity,
      is: { value },
      since: 1,
    });
  }
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const storeTx = new ExtendedStorageTransaction(managedTx);
  const traverser = new SchemaObjectTraverser(
    storeTx,
    selector,
    createDefaultTraversalContext(TEST_SCOPE_IDENTITY, traverseCells),
  );
  const doc: IMemorySpaceValueAttestation = {
    address: {
      space: "did:null:null",
      id: uri as URI,
      type,
      path: ["value"],
    },
    value,
  };
  return { traverser, doc };
};

// The acting identity traversal tracker keys resolve scoped addresses
// against (stage E).
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

describe("value-type dispatch: FabricSpecialObject subclasses", () => {
  const objectSelector: SchemaPathSelector = {
    path: ["value"],
    schema: {
      type: "object",
      properties: { field: { type: "object" } },
    },
  };

  it("materializes a FabricPrimitive as an opaque leaf (regression pin)", () => {
    const blob = new FabricBytes(new Uint8Array([1, 2, 3]));
    const { traverser, doc } = traverserOver(
      "of:dispatch-primitive",
      { field: blob },
      objectSelector,
    );

    const { ok: result } = traverser.traverse(doc);
    expect((result as Record<string, unknown>).field).toBeInstanceOf(
      FabricBytes,
    );
  });

  it("matches a FabricPrimitive's anyOf branch by prototype-chain required keys", () => {
    // The branch prefilter's `required` check tests membership with `in`
    // for a FabricSpecialObject — accessors like `length` count, the
    // nominal brand key is satisfied by construction — and an unresolvable
    // $ref branch passes the prefilter to complain in traversal proper.
    const blob = new FabricBytes(new Uint8Array([1, 2, 3]));
    const anyOfSelector: SchemaPathSelector = {
      path: ["value"],
      // Interned and at the schema root: the prepared branch prefilter
      // under test runs only for interned schemas, the identity-stable
      // form a resolved link's schema arrives in.
      schema: internSchema({
        anyOf: [
          { $ref: "#/$defs/absent" },
          { type: "object", required: ["missing"] },
          {
            type: "object",
            required: [FABRIC_SPECIAL_OBJECT_BRAND, "length"],
          },
        ],
      })!,
    };
    const { traverser, doc } = traverserOver(
      "of:dispatch-primitive-anyof",
      blob,
      anyOfSelector,
    );

    const { ok: result } = traverser.traverse(doc);
    expect(result).toBeInstanceOf(FabricBytes);
  });

  it("routes a modern FabricLink through pointer traversal", () => {
    setModernCellRepConfig(true);
    try {
      const link = new FabricLink({
        id: "of:dispatch-link-target",
        space: "did:null:null",
        scope: "space",
        path: [],
      });
      const { traverser, doc } = traverserOver(
        "of:dispatch-link-source",
        link,
        {
          path: ["value"],
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
        true,
        {
          "of:dispatch-link-target": {
            name: "linked",
          },
        },
      );

      const result = traverser.traverse(doc);

      expect(result.error).toBeUndefined();
      expect(result.ok).toEqual({ name: "linked" });
      expect(traverser.traversePointerCalls).toBe(1);
    } finally {
      resetModernCellRepConfig();
    }
  });

  it("follows a modern FabricLink under an unconstrained schema", () => {
    setModernCellRepConfig(true);
    try {
      const link = new FabricLink({
        id: "of:unconstrained-link-target",
        space: "did:null:null",
        scope: "space",
        path: [],
      });
      const { traverser, doc } = traverserOver(
        "of:unconstrained-link-source",
        link,
        { path: ["value"], schema: true },
        true,
        {
          "of:unconstrained-link-target": {
            name: "linked",
          },
        },
      );

      const result = traverser.traverse(doc);

      expect(result.error).toBeUndefined();
      expect(result.ok).toEqual({ name: "linked" });
    } finally {
      resetModernCellRepConfig();
    }
  });

  it("fails loudly on a FabricInstance (not yet handled)", () => {
    // A `FabricInstance` is not a fully-opaque leaf: leafing it whole (as
    // this arm did for any `FabricSpecialObject`) silently hides that its
    // contents were never descended or validated. Fail loudly until
    // codec-contents descent exists.
    const failure = FabricError.fromNativeError(new Error("loud"));
    const { traverser, doc } = traverserOver(
      "of:dispatch-instance",
      { field: failure },
      objectSelector,
    );

    expect(() => traverser.traverse(doc)).toThrow(/Cannot yet handle/);
  });
});

describe("plain-schema fast path: FabricSpecialObject subclasses", () => {
  // An array whose item schema compiles to a plain-schema plan (`type` +
  // `properties` with primitive-typed leaves only) routes each element
  // through `traversePlainSchemaWithReads`.
  const planSelector: SchemaPathSelector = {
    path: ["value"],
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
  };

  it("materializes a FabricPrimitive element as an opaque leaf (regression pin)", () => {
    const blob = new FabricBytes(new Uint8Array([7, 7]));
    const { traverser, doc } = traverserOver(
      "of:plan-primitive",
      [blob],
      planSelector,
      false,
    );

    const { ok: result } = traverser.traverse(doc);
    expect((result as unknown[])[0]).toBeInstanceOf(FabricBytes);
  });

  it("fails loudly on a FabricInstance element (not yet handled)", () => {
    const failure = FabricError.fromNativeError(new Error("loud"));
    const { traverser, doc } = traverserOver(
      "of:plan-instance",
      [failure],
      planSelector,
      false,
    );

    expect(() => traverser.traverse(doc)).toThrow(/Cannot yet handle/);
  });
});
