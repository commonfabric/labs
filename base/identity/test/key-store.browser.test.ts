import { assert } from "@std/assert";

import { isNativeEd25519Supported } from "../src/ed25519/utils.ts";
import { Identity } from "../src/identity.ts";
import { KeyStore } from "../src/key-store.ts";

Deno.test("KeyStore can store and recover keys", async () => {
  const store = await KeyStore.open("test-key-store-concurrent");
  await store.clear();

  const key = await Identity.generate();
  const did = key.verifier.did();
  await store.set("key", key);
  const recovered = await store.get("key");

  assert(recovered && did === recovered.verifier.did());
});

Deno.test("KeyStore.open() with no name opens `common-key-store`", async () => {
  // The database name is persisted browser state, so it is pinned to its
  // literal here rather than to the constant: reading the constant on both
  // sides of the comparison would agree with itself no matter what the name
  // became, and a silent change to it would orphan every key a user has already
  // stored.

  assert(KeyStore.DEFAULT_DB_NAME === "common-key-store");

  const defaulted = await KeyStore.open();
  await defaulted.clear();

  const key = await Identity.generate();
  await defaulted.set("key", key);

  const named = await KeyStore.open("common-key-store");
  const recovered = await named.get("key");
  assert(recovered && key.did() === recovered.did());

  await named.clear();
});

//
// The two arms are stored differently -- bytes for one, `CryptoKey` handles
// for the other -- and each names its own implementation, so a recovered key
// that arrived through the wrong arm would sign as a different implementation
// than it was stored as.
//

Deno.test("KeyStore recovers a key pair holding material as one", async () => {
  const store = await KeyStore.open("test-key-store-material");
  await store.clear();

  const key = await Identity.generate({ implementation: "noble" });
  assert(key.keyPair.hasMaterial, "the arm this test names");
  await store.set("key", key);
  const recovered = await store.get("key");

  assert(recovered && key.did() === recovered.did());
  assert(
    recovered.keyPair.hasMaterial,
    "recovered as the arm it was stored as",
  );
});

Deno.test("KeyStore recovers a key pair holding handles as one", async () => {
  if (!await isNativeEd25519Supported()) return;

  const store = await KeyStore.open("test-key-store-handles");
  await store.clear();

  const key = await Identity.generate({ implementation: "webcrypto" });
  assert(!key.keyPair.hasMaterial, "the arm this test names");
  await store.set("key", key);
  const recovered = await store.get("key");

  assert(recovered && key.did() === recovered.did());
  assert(
    !recovered.keyPair.hasMaterial,
    "recovered as the arm it was stored as",
  );
});
