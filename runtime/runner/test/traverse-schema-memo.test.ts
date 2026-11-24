import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import type {
  MemorySpace,
  Revision,
  State,
} from "@commonfabric/memory/interface";
import {
  createDefaultTraversalContext,
  createSchemaMemo,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

// The acting identity traversal tracker keys resolve scoped addresses
// against (stage E).
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

describe("SchemaObjectTraverser shared schema memo", () => {
  it("does not alias the same document id across address scopes", () => {
    const manager = new StoreObjectManager(
      new Map<string, Revision<State>>(),
    );
    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(manager),
    );
    const selector = {
      path: ["value"],
      schema: { type: "string" },
    } as const satisfies SchemaPathSelector;
    const traverser = new SchemaObjectTraverser<FabricValue>(
      tx,
      selector,
      createDefaultTraversalContext(TEST_SCOPE_IDENTITY),
      undefined,
      createSchemaMemo(),
    );
    const document = (
      space: MemorySpace,
      scope: "space" | "session",
      value: string,
    ): IMemorySpaceValueAttestation => ({
      address: {
        space,
        scope,
        id: "of:same-id",
        type: "application/json",
        path: ["value"],
      },
      value,
    });

    expect(
      traverser.traverseWithSchema(
        document("did:key:one", "space", "first"),
        selector.schema,
      ).ok,
    ).toBe("first");
    expect(
      traverser.traverseWithSchema(
        document("did:key:one", "session", "second"),
        selector.schema,
      ).ok,
    ).toBe("second");
    expect(
      traverser.traverseWithSchema(
        document("did:key:two", "space", "third"),
        selector.schema,
      ).ok,
    ).toBe("third");
    expect(traverser.schemaMemoHits).toBe(0);
  });
});
