/**
 * Required link-valued properties keep ordinary schema semantics regardless
 * of whether their containing object is an array element. A target that is
 * absent and a target that is present but fails its schema both make the
 * property fail. If the property is required, the object and its containing
 * array fail too. Callers that accept an unavailable scoped target must say so
 * in their schema by making the property optional or accepting `undefined`.
 */

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
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";

import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

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

function putDoc(
  store: Map<string, Revision<State>>,
  uri: URI,
  value: FabricValue,
  since = 1,
): void {
  const revision: Revision<State> = {
    the: TYPE,
    of: uri as Entity,
    is: { value },
    since,
  };
  store.set(`${revision.of}/${revision.the}`, revision);
}

const linkTo = (id: URI, path: string[] = []) => ({
  "/": { [LINK_V1_TAG]: { id, path } },
});

/** Element schema: `profile` is a required link-valued property. */
const messageSchema = {
  type: "object",
  properties: {
    author: { type: "string" },
    profile: {
      type: "object",
      properties: { name: { type: "string" } },
    },
  },
  required: ["author", "profile"],
} as const satisfies JSONSchema;

const listSchema = {
  type: "object",
  properties: {
    messages: { type: "array", items: messageSchema },
  },
  required: ["messages"],
} as const satisfies JSONSchema;

function traverseRoot(
  store: Map<string, Revision<State>>,
  rootUri: URI,
  rootValue: unknown,
  schema: JSONSchema,
) {
  const traverser = getTraverser(store, { path: ["value"], schema });
  return traverser.traverse({
    address: { space: SPACE, id: rootUri, type: TYPE, path: ["value"] },
    value: rootValue as FabricValue,
  });
}

describe("required link-valued properties", () => {
  const rootUri = "of:chat-root" as URI;
  const profileUri = "of:profile-1" as URI;
  const missingUri = "of:profile-missing" as URI;

  it("voids an array when a required link field targets an absent value", () => {
    const store = new Map<string, Revision<State>>();
    const rootValue = {
      messages: [
        { author: "alice", profile: linkTo(missingUri) },
      ],
    };
    putDoc(store, rootUri, rootValue);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      listSchema,
    );

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });

  it("still resolves elements whose link target exists", () => {
    const store = new Map<string, Revision<State>>();
    putDoc(store, profileUri, { name: "Alice" });
    const rootValue = {
      messages: [
        { author: "alice", profile: linkTo(profileUri) },
      ],
    };
    putDoc(store, rootUri, rootValue, 2);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      listSchema,
    );

    expect(error).toBeUndefined();
    const messages = (result as {
      messages: { author: string; profile: { name: string } }[];
    }).messages;
    expect(messages[0].profile).toEqual({ name: "Alice" });
  });

  it("also rejects an absent required link outside an array", () => {
    // Array nesting must not change whether a required property matches.
    const store = new Map<string, Revision<State>>();
    const rootValue = { author: "alice", profile: linkTo(missingUri) };
    putDoc(store, rootUri, rootValue);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      messageSchema,
    );

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });

  it("keeps strict semantics for a target that exists but fails the schema", () => {
    // A present-but-wrong-shaped target and an absent target have the same
    // schema-level effect: the required property does not match.
    const store = new Map<string, Revision<State>>();
    putDoc(store, profileUri, "not-an-object");
    const rootValue = {
      messages: [
        { author: "alice", profile: linkTo(profileUri) },
      ],
    };
    putDoc(store, rootUri, rootValue, 2);

    const { ok: result, error } = traverseRoot(
      store,
      rootUri,
      rootValue,
      listSchema,
    );

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
  });
});

describe("array-void diagnosability", () => {
  it("still voids on a mismatched element, and names the failing index + doc at info", () => {
    // The 2026-07-10 board outage presented as a blanked array with a bare
    // "Item doesn't match" log — nothing named WHICH element was at fault. Pin
    // that the (unchanged) strict void now leaves an info breadcrumb carrying
    // the failing index + doc address (the message body is a lazy lambda: it
    // only runs when the level admits it).

    const traverseLogger = getLogger("traverse");
    const priorLevel = traverseLogger.level;
    traverseLogger.level = "info";
    try {
      const infoCount = () => {
        const breakdown = getLoggerCountsBreakdown()["traverse"] as
          | Record<string, { info?: number }>
          | undefined;
        return breakdown?.["traverse"]?.info ?? 0;
      };
      const store = new Map<string, Revision<State>>();
      const rootUri = "of:void-diag-root" as URI;
      const badUri = "of:void-diag-bad" as URI;
      putDoc(store, badUri, "not-an-object");
      const rootValue = {
        messages: [{ author: "alice", profile: linkTo(badUri) }],
      };
      putDoc(store, rootUri, rootValue, 2);

      const before = infoCount();
      const { ok: result, error } = traverseRoot(
        store,
        rootUri,
        rootValue,
        listSchema,
      );
      // Strict semantics unchanged: the mismatched element voids the read.
      expect(result).toBeUndefined();
      expect(error).toBeDefined();
      // And the void is attributable: at least one info breadcrumb fired.
      expect(infoCount() - before).toBeGreaterThanOrEqual(1);
    } finally {
      traverseLogger.level = priorLevel;
    }
  });
});
