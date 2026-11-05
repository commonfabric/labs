import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  type CollectionKeyIdentity,
  compareCollectionKeys,
  resolveCollectionKey,
} from "../src/builtins/collection-index-key.ts";
import { scopedCell } from "../src/builtins/scope-policy.ts";
import { Runtime } from "../src/runtime.ts";
import { UnresolvedInputError } from "../src/schema-view.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("collection-index-key");
const space = signer.did();

describe("collection index keys", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    if (tx.status().status === "ready") tx.abort();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  it("separates primitive domains and normalizes negative zero", () => {
    const keys = ["1", 1, true, false, -0, 0].map((key) =>
      resolveCollectionKey(runtime, tx, key)!
    );
    expect(keys[0]!.identity).not.toEqual(keys[1]!.identity);
    expect(keys[1]!.identity).not.toEqual(keys[2]!.identity);
    expect(keys[4]).toEqual(keys[5]);
    expect(Object.is(keys[4]!.key, -0)).toBe(false);
    expect(
      keys.sort((a, b) => compareCollectionKeys(a.identity, b.identity)).map(
        ({ key }) => key,
      ),
    ).toEqual([false, true, 0, 0, 1, "1"]);
    expect(resolveCollectionKey(runtime, tx, null)).toBeUndefined();
    expect(resolveCollectionKey(runtime, tx, undefined)).toBeUndefined();
  });

  it("orders strings by UTF-8 and keeps different Cell paths distinct", async () => {
    const strings = ["\u{10000}", "\ue000"].map((value) =>
      resolveCollectionKey(runtime, tx, value)!
    );
    expect(
      strings.sort((a, b) => compareCollectionKeys(a.identity, b.identity))
        .map(({ key }) => key),
    ).toEqual(["\ue000", "\u{10000}"]);
    const parent = runtime.getCell<{ left: number; right: number }>(
      space,
      "paths",
      undefined,
      tx,
    );
    parent.set({ left: 1, right: 1 });
    await tx.commit().settled;
    tx = runtime.edit();
    const left = resolveCollectionKey(runtime, tx, parent.key("left"))!;
    const right = resolveCollectionKey(runtime, tx, parent.key("right"))!;
    expect(left.identity).not.toEqual(right.identity);
    expect(compareCollectionKeys(left.identity, left.identity)).toBe(0);
    expect(compareCollectionKeys(left.identity, right.identity)).toBe(
      -compareCollectionKeys(right.identity, left.identity),
    );
  });

  it("rejects unsupported keys instead of coercing them into a bucket", () => {
    for (
      const key of [
        NaN,
        Infinity,
        -Infinity,
        {},
        [],
        Symbol("key"),
        1n,
        () => 1,
      ]
    ) {
      expect(() => resolveCollectionKey(runtime, tx, key)).toThrow(
        "Collection keys",
      );
    }
  });

  it("uses resolved Cell identity independently of schema and stored contents", async () => {
    const first = runtime.getCell(space, "first", undefined, tx);
    const second = runtime.getCell(space, "second", undefined, tx);
    const alias = runtime.getCell(space, "alias", undefined, tx);
    first.set({ name: "same" });
    second.set({ name: "same" });
    alias.set(first);
    await tx.commit().settled;
    tx = runtime.edit();
    const a = resolveCollectionKey(runtime, tx, first)!;
    const b = resolveCollectionKey(runtime, tx, second)!;
    expect(a.identity).not.toEqual(b.identity);
    expect(resolveCollectionKey(runtime, tx, alias)!.identity).toEqual(
      a.identity,
    );
    expect(resolveCollectionKey(runtime, tx, first.asSchema(true))!.identity)
      .toEqual(a.identity);
    alias.withTx(tx).set(second);
    await tx.commit().settled;
    tx = runtime.edit();
    expect(resolveCollectionKey(runtime, tx, alias)!.identity).toEqual(
      b.identity,
    );
    first.withTx(tx).set({ name: "changed" });
    expect(resolveCollectionKey(runtime, tx, first)!.identity).toEqual(
      a.identity,
    );
  });
  it("distinguishes cross-space and scoped Cells", async () => {
    const otherSpace =
      (await Identity.fromPassphrase("collection-index-other-space")).did();
    const local = runtime.getCell(space, "scoped", undefined, tx);
    local.set({ name: "same" });
    await tx.commit().settled;
    tx = runtime.edit();
    const remote = runtime.getCell(otherSpace, "scoped", undefined, tx);
    remote.set({ name: "same" });
    await tx.commit().settled;
    tx = runtime.edit();
    const user = scopedCell(runtime, tx, local, "user");
    user.set({ name: "same" });
    await tx.commit().settled;
    tx = runtime.edit();
    const localKey = resolveCollectionKey(runtime, tx, local)!;
    const remoteKey = resolveCollectionKey(runtime, tx, remote)!;
    const userKey = resolveCollectionKey(runtime, tx, user)!;
    expect(localKey.identity).not.toEqual(remoteKey.identity);
    expect(localKey.identity).not.toEqual(userKey.identity);
    expect(userKey.identity).not.toEqual(remoteKey.identity);
  });

  it("refuses an unresolved alias target until its document arrives", async () => {
    const missing = runtime.getCell(space, "unarrived", undefined, tx);
    const alias = runtime.getCell(space, "unarrived-alias", undefined, tx);
    alias.set(missing);
    await tx.commit().settled;
    tx = runtime.edit();
    expect(() => resolveCollectionKey(runtime, tx, alias)).toThrow(
      UnresolvedInputError,
    );
    tx.abort();
    tx = runtime.edit();
    missing.withTx(tx).set({ name: "arrived" });
    await tx.commit().settled;
    tx = runtime.edit();
    expect(resolveCollectionKey(runtime, tx, alias)!.identity).toEqual(
      resolveCollectionKey(runtime, tx, missing)!.identity,
    );
  });

  it("reacts to alias retargeting without reacting to target field edits", async () => {
    const first = runtime.getCell<{ name: string }>(
      space,
      "reactive-first",
      undefined,
      tx,
    );
    const second = runtime.getCell<{ name: string }>(
      space,
      "reactive-second",
      undefined,
      tx,
    );
    const alias = runtime.getCell(space, "reactive-alias", undefined, tx);
    first.set({ name: "first" });
    second.set({ name: "second" });
    alias.set(first);
    await tx.commit().settled;
    tx = runtime.edit();
    const keys: CollectionKeyIdentity[] = [];
    const observe = (read: IExtendedStorageTransaction) => {
      keys.push(resolveCollectionKey(runtime, read, alias)!.identity);
    };
    runtime.scheduler.subscribe(observe, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    runtime.scheduler.queueExecution();
    try {
      await runtime.settled(Infinity);
      expect(keys).toHaveLength(1);
      first.withTx(tx).key("name").set("updated");
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.settled(Infinity);
      expect(keys).toHaveLength(1);
      alias.withTx(tx).set(second);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.settled(Infinity);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toEqual(
        resolveCollectionKey(runtime, tx, second)!.identity,
      );
      expect(keys[1]).not.toEqual(keys[0]);
    } finally {
      runtime.scheduler.unsubscribe(observe);
    }
  });
});
