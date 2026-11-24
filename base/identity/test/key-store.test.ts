// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.
//
// These cases run against `FakeIndexedDB`; `key-store.browser.test.ts` runs
// the same store against a browser's own IndexedDB.

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { isNativeEd25519Supported } from "../src/ed25519/utils.ts";
import { Identity } from "../src/identity.ts";
import { KeyStore } from "../src/key-store.ts";
import { FakeIndexedDB } from "./fake-indexed-db.ts";

/** Writes `value` under `key` in the store `name` of `factory`, directly. */
async function putRaw(
  factory: FakeIndexedDB,
  name: string,
  key: string,
  value: unknown,
): Promise<void> {
  const request = factory.database(name).transaction("key-store", "readwrite")
    .objectStore("key-store").put(value, key);
  await new Promise((resolve) => request.addEventListener("success", resolve));
}

Deno.test("KeyStore recovers a stored key pair holding material as one, with its DID", async () => {
  const store = await KeyStore.open("material", new FakeIndexedDB());
  const key = await Identity.generate({ implementation: "noble" });

  await store.set("key", key);
  const recovered = await store.get("key");

  expect(recovered?.did()).toBe(key.did());
  expect(recovered?.keyPair.hasMaterial).toBe(true);
});

Deno.test("KeyStore recovers a stored key pair holding handles as one, with its DID", async () => {
  if (!await isNativeEd25519Supported()) return;
  const store = await KeyStore.open("handles", new FakeIndexedDB());
  const key = await Identity.generate({ implementation: "webcrypto" });

  await store.set("key", key);
  const recovered = await store.get("key");

  expect(recovered?.did()).toBe(key.did());
  expect(recovered?.keyPair.hasMaterial).toBe(false);
});

Deno.test("KeyStore returns `undefined` for a name it holds nothing under, and after `clear()`", async () => {
  const store = await KeyStore.open("absent", new FakeIndexedDB());
  expect(await store.get("key")).toBeUndefined();

  await store.set("key", await Identity.generate({ implementation: "noble" }));
  await store.clear();

  expect(await store.get("key")).toBeUndefined();
});

Deno.test("KeyStore.open() reaches what an earlier open of the same name stored, and creates its object store once", async () => {
  const factory = new FakeIndexedDB();
  const key = await Identity.generate({ implementation: "noble" });
  await (await KeyStore.open("shared", factory)).set("key", key);

  const reopened = await KeyStore.open("shared", factory);

  expect((await reopened.get("key"))?.did()).toBe(key.did());
  expect(factory.database("shared").storeNames).toEqual(["key-store"]);
  expect(await (await KeyStore.open("other", factory)).get("key"))
    .toBeUndefined();
});

Deno.test("KeyStore.open() with no name opens `common-key-store`", async () => {
  // Pinned to the literal: the name is persisted browser state, and a change
  // to it would orphan every key a user has already stored.

  const factory = new FakeIndexedDB();
  await KeyStore.open(undefined, factory);

  expect(KeyStore.DEFAULT_DB_NAME).toBe("common-key-store");
  expect(factory.has("common-key-store")).toBe(true);
});

Deno.test("KeyStore throws for a stored value that is neither a pair of bytes nor a pair of keys", async () => {
  const factory = new FakeIndexedDB();
  const store = await KeyStore.open("corrupt", factory);

  for (
    const value of [
      "key",
      [new Uint8Array(32), new Uint8Array(32)],
      { publicKey: new Uint8Array(32), privateKey: "secret" },
    ]
  ) {
    await putRaw(factory, "corrupt", "key", value);
    await expect(store.get("key")).rejects.toThrow(
      "common-identity: Could not read stored key.",
    );
  }
});

Deno.test("KeyStore rejects with the error a failed request reports", async () => {
  const factory = new FakeIndexedDB();
  const store = await KeyStore.open("failing", factory);
  const failure = new DOMException("disk full", "QuotaExceededError");
  factory.database("failing").failWith(failure);

  await expect(store.get("key")).rejects.toBe(failure);
  await expect(
    store.set("key", await Identity.generate({ implementation: "noble" })),
  ).rejects.toBe(failure);
  await expect(store.clear()).rejects.toBe(failure);
});

Deno.test("KeyStore logs an open that is blocked and a later version change", async () => {
  using log = stub(console, "log");
  const factory = new FakeIndexedDB();

  factory.blockNext();
  await KeyStore.open("logged", factory);
  expect(log.calls.map((call) => call.args)).toEqual([["KeyStore: Blocked"]]);

  factory.database("logged").dispatchEvent(
    Object.assign(new Event("versionchange"), { oldVersion: 1, newVersion: 2 }),
  );
  expect(log.calls.map((call) => call.args)).toEqual([
    ["KeyStore: Blocked"],
    ["KeyStore: VersionChange", 1, 2],
  ]);
});
