/** Pins independent writes that accompany mergeable operations on one document. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import type { NativeStorageCommit } from "../src/storage/interface.ts";
import { mergeableOpRead } from "../src/storage/reactivity-log.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-mergeable-siblings");
const space = signer.did();
const id = "of:mergeable-siblings" as URI;
const address = {
  space,
  id,
  type: "application/json" as const,
  scope: "space" as const,
};

describe("memory-v2-mergeable-siblings", () => {
  let storage: EmulatedStorageManager;
  let drafts: NativeStorageCommit[];
  let server: ReturnType<typeof newSharedServer>;

  beforeEach(() => {
    server = newSharedServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    drafts = [];
    const replica = storage.open(space).replica;
    const commit = replica.commitNative!.bind(replica);
    replica.commitNative = (draft, source) => {
      drafts.push(draft);
      return commit(draft, source);
    };
  });

  afterEach(async () => {
    await server.flushSessions([space]);
    await storage.close();
    await server.close();
  });

  const write = (
    tx: ReturnType<typeof storage.edit>,
    path: readonly string[],
    value: FabricValue,
  ) => {
    expect(tx.write({ ...address, path }, value).error).toBeUndefined();
  };

  const append = (tx: ReturnType<typeof storage.edit>) => {
    tx.recordMergeableOp?.({ ...address, path: ["value", "rows"] }, {
      op: "append",
      count: 1,
    });
  };

  const read = async (targetId = id) => {
    const reader = EmulatedStorageManager.connectTo(server, { as: signer });
    try {
      expect((await reader.open(space).sync(targetId)).error).toBeUndefined();
      const tx = reader.edit();
      const result = tx.read({ ...address, id: targetId, path: [] });
      tx.abort();
      expect(result.error).toBeUndefined();
      return result.ok?.value;
    } finally {
      await reader.close();
    }
  };

  it("persists sibling fields with an append that creates the document", async () => {
    const tx = storage.edit();
    write(tx, ["value", "rows"], ["local"]);
    append(tx);
    write(tx, ["audit"], { author: "local" });
    expect((await tx.commit()).error).toBeUndefined();
    expect(await read()).toEqual({
      value: { rows: ["local"] },
      audit: { author: "local" },
    });
  });

  it("persists root-write sibling changes and deletions beside an append", async () => {
    const seed = storage.edit();
    write(seed, [], {
      value: { rows: ["old"], title: "before", removed: true },
    });
    expect((await seed.commit()).error).toBeUndefined();

    const tx = storage.edit();
    write(tx, [], {
      value: { rows: ["old", "local"], title: "after" },
      audit: { author: "local" },
    });
    append(tx);
    expect((await tx.commit()).error).toBeUndefined();
    expect(await read()).toEqual({
      value: { rows: ["old", "local"], title: "after" },
      audit: { author: "local" },
    });
  });

  it("preserves a peer's fields and append when the local base was absent", async () => {
    const local = storage.edit();
    write(local, ["value", "rows"], ["local"]);
    append(local);
    write(local, ["audit"], { author: "local" });

    const peer = storage.edit();
    write(peer, [], { value: { rows: ["peer"], untouched: "peer" } });
    expect((await peer.commit()).error).toBeUndefined();

    expect((await local.commit()).error).toBeUndefined();
    expect(await read()).toEqual({
      value: { rows: ["peer", "local"], untouched: "peer" },
      audit: { author: "local" },
    });
  });

  it("persists CFC reference metadata with the first append into an absent parent", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    try {
      const source = runtime.getCell(space, "source");
      const seed = runtime.edit();
      source.withTx(seed).set("target");
      expect((await seed.commit()).error).toBeUndefined();
      const parent = runtime.getCell(space, "fresh-parent");
      const tx = runtime.edit();
      parent.withTx(tx).key("profiles").push(source);
      expect((await tx.commit()).error).toBeUndefined();

      const parentId = parent.getAsNormalizedFullLink().id;
      const operations = drafts.at(-1)?.operations.filter((op) =>
        op.id === parentId
      );
      expect(operations).toHaveLength(1);

      const durable = await read(parentId);
      expect(durable).toHaveProperty("cfc.version", 3);
      expect(durable).toHaveProperty("value.profiles.length", 1);
      const inspect = runtime.edit();
      const metadata = readStoredCfcMetadata(
        inspect,
        parent.getAsNormalizedFullLink(),
      );
      expect(metadata?.version).toBe(3);
      expect(
        metadata?.labelMap.entries.some((entry) =>
          entry.path.join("/") === "profiles/0" &&
          entry.origin === "link" && entry.observes === "followRef" &&
          entry.referenceAcquisition === "complete"
        ),
      ).toBe(true);
      const acquired = parent.withTx(inspect).key("profiles").key(0)
        .resolveAsCell();
      expect(getCfcReferenceProvenance(acquired)).toBeDefined();
      expect(acquired.get()).toBe("target");
      inspect.abort();
    } finally {
      await server.flushSessions([space]);
      await runtime.dispose({ closeStorage: false });
    }
  });

  it("retains a concurrent nested append while changing its enclosing object", async () => {
    const seed = storage.edit();
    write(seed, [], {
      value: { groups: [{ rows: ["old"], title: "before" }] },
    });
    expect((await seed.commit()).error).toBeUndefined();
    const local = storage.edit();
    write(local, [], {
      value: { groups: [{ rows: ["old", "local"], title: "after" }] },
    });
    const rows = { ...address, path: ["value", "groups", "0", "rows"] };
    local.recordMergeableOp?.(rows, { op: "append", count: 1 });

    const peer = storage.edit();
    write(peer, rows.path, ["old", "peer"]);
    peer.recordMergeableOp?.(rows, { op: "append", count: 1 });
    expect((await peer.commit()).error).toBeUndefined();
    expect((await local.commit()).error).toBeUndefined();
    expect(await read()).toEqual({
      value: { groups: [{ rows: ["old", "peer", "local"], title: "after" }] },
    });
  });

  it("sends a generated sibling array tail once when root and leaf writes overlap", async () => {
    const seed = storage.edit();
    write(seed, [], { value: { rows: [], other: [] } });
    expect((await seed.commit()).error).toBeUndefined();
    const tx = storage.edit();
    write(tx, [], { value: { rows: ["local"], other: ["x"] } });
    append(tx);
    write(tx, ["value", "other", "1"], "y");
    expect((await tx.commit()).error).toBeUndefined();
    expect(await read()).toEqual({
      value: { rows: ["local"], other: ["x", "y"] },
    });
  });

  it("carries a nested increment once inside a generated array tail", async () => {
    const seed = storage.edit();
    write(seed, [], { value: { rows: [], groups: [] } });
    expect((await seed.commit()).error).toBeUndefined();
    const tx = storage.edit();
    write(tx, [], { value: { rows: ["local"], groups: [{ count: 2 }] } });
    append(tx);
    tx.recordMergeableOp?.({
      ...address,
      path: ["value", "groups", "0", "count"],
    }, { op: "increment", by: 2 });
    expect((await tx.commit()).error).toBeUndefined();
    expect(await read()).toEqual({
      value: { rows: ["local"], groups: [{ count: 2 }] },
    });
    const operation = drafts.at(-1)?.operations.find((op) => op.id === id);
    expect(operation?.op).toBe("patch");
    if (operation?.op !== "patch") throw new Error("missing mixed patch");
    expect(operation.patches.some((op) => op.op === "increment")).toBe(false);
  });

  it("keeps the wire append compact while including changed sibling metadata", async () => {
    const sizes: number[] = [];
    for (const length of [16, 4096]) {
      const rows = Array.from({ length }, () => "existing");
      const seed = storage.edit();
      write(seed, [], { value: { rows }, audit: "before" });
      expect((await seed.commit()).error).toBeUndefined();
      const tx = storage.edit();
      write(tx, [], { value: { rows: [...rows, "local"] }, audit: "after" });
      append(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const operation = drafts.at(-1)?.operations.find((op) => op.id === id);
      expect(operation?.op).toBe("patch");
      if (operation?.op !== "patch") throw new Error("missing compact patch");
      expect(operation.patches).toEqual([
        { op: "append", path: "/value/rows", values: ["local"] },
        { op: "replace", path: "/audit", value: "after" },
      ]);
      sizes.push(JSON.stringify(operation.patches).length);
    }
    expect(sizes[0]).toBe(sizes[1]);
  });

  it("retains edits to the existing prefix beside an append in a root write", async () => {
    const seed = storage.edit();
    write(seed, [], { value: { rows: ["old"] } });
    expect((await seed.commit()).error).toBeUndefined();
    const tx = storage.edit();
    write(tx, [], { value: { rows: ["changed", "local"] } });
    append(tx);
    expect((await tx.commit()).error).toBeUndefined();
    expect(await read()).toEqual({ value: { rows: ["changed", "local"] } });
  });

  for (const change of ["add", "remove"] as const) {
    it(`covers a numeric object key ${change} while retaining an unrelated peer append`, async () => {
      const beforeCounter = change === "add"
        ? { count: 0 }
        : { count: 0, "0": "old" };
      const afterCounter = change === "add"
        ? { count: 1, "0": "new" }
        : { count: 1 };
      const seed = storage.edit();
      write(seed, [], { value: { rows: [], counter: beforeCounter } });
      expect((await seed.commit()).error).toBeUndefined();
      const local = storage.edit();
      const counter = { ...address, path: ["value", "counter", "count"] };
      write(local, [], { value: { rows: ["local"], counter: afterCounter } });
      append(local);
      local.recordMergeableOp?.(counter, { op: "increment", by: 1 });

      const peer = storage.edit();
      write(peer, ["value", "rows"], ["peer"]);
      append(peer);
      write(peer, ["value", "untouched"], "peer");
      expect((await peer.commit()).error).toBeUndefined();
      expect((await local.commit()).error).toBeUndefined();
      expect(await read()).toEqual({
        value: {
          rows: ["peer", "local"],
          counter: afterCounter,
          untouched: "peer",
        },
      });
      const operation = drafts.at(-1)?.operations.find((op) => op.id === id);
      expect(operation?.op).toBe("patch");
      if (operation?.op !== "patch") throw new Error("missing branch patch");
      expect(operation.patches).toEqual([
        { op: "append", path: "/value/rows", values: ["local"] },
        { op: "replace", path: "/value/counter", value: afterCounter },
      ]);
    });
  }

  it("covers decimal object keys beyond the array index range", async () => {
    const seed = storage.edit();
    write(seed, [], { value: { count: 0 } });
    expect((await seed.commit()).error).toBeUndefined();
    const tx = storage.edit();
    const value = { value: { count: 1, "4294967295": "new" } };
    write(tx, [], value);
    tx.recordMergeableOp?.({ ...address, path: ["value", "count"] }, {
      op: "increment",
      by: 1,
    });
    expect((await tx.commit()).error).toBeUndefined();
    expect(await read()).toEqual(value);
  });

  it("retains the absent-base read when a covering object write abandons an increment", async () => {
    const heldServer = newSharedServer({
      subscriptionRefreshDelayMs: "manual",
    });
    const localStorage = EmulatedStorageManager.connectTo(heldServer, {
      as: signer,
    });
    const peerStorage = EmulatedStorageManager.connectTo(heldServer, {
      as: signer,
    });
    try {
      const local = localStorage.edit();
      const counter = { ...address, path: ["value", "counter", "count"] };
      expect(local.read(counter, { meta: mergeableOpRead }).ok?.value)
        .toBeUndefined();
      write(local, [], {
        value: { rows: ["local"], counter: { count: 1, "0": "new" } },
      });
      append(local);
      local.recordMergeableOp?.(counter, { op: "increment", by: 1 });

      const peerValue = {
        value: { rows: ["peer"], counter: { count: 10 }, untouched: "peer" },
      };
      const peer = peerStorage.edit();
      write(peer, [], peerValue);
      expect((await peer.commit({ resolveAt: "verdict" })).error)
        .toBeUndefined();
      const transact = heldServer.transact.bind(heldServer);
      const verdict = Promise.withResolvers<
        Awaited<ReturnType<typeof transact>>
      >();
      heldServer.transact = async (...args: Parameters<typeof transact>) => {
        const result = await transact(...args);
        verdict.resolve(result);
        return result;
      };
      const commit = local.commit({ resolveAt: "verdict" });
      expect((await verdict.promise).error?.name).toBe("ConflictError");
      // Manual fanout publishes the repair only after the server has rejected
      // the stale absent-base dependency.
      await heldServer.flushSessions([space]);
      expect((await commit).error?.name).toBe("ConflictError");
      const reader = EmulatedStorageManager.connectTo(heldServer, {
        as: signer,
      });
      try {
        expect((await reader.open(space).sync(id)).error).toBeUndefined();
        const inspect = reader.edit();
        expect(inspect.read({ ...address, path: [] }).ok?.value).toEqual(
          peerValue,
        );
        inspect.abort();
      } finally {
        await reader.close();
      }
    } finally {
      await heldServer.flushSessions([space]);
      await localStorage.close();
      await peerStorage.close();
      await heldServer.close();
    }
  });
});
