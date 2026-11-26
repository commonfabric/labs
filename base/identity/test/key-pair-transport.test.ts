// Flat `test()` cases: this package's tests also run in a browser through
// `deno-web-test`, where `describe()` is not available.

import { expect } from "@std/expect";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { test } from "@commonfabric/test-support/test";

import { isNativeEd25519Supported } from "../src/ed25519/utils.ts";
import { Identity } from "../src/identity.ts";
import {
  keyPairFromRealmValue,
  realmValueFromKeyPair,
} from "../src/key-pair-transport.ts";

test("keyPairFromRealmValue() returns a key pair holding material that signs as the encoded one", async () => {
  const identity = await Identity.generate({ implementation: "noble" });

  const decoded = keyPairFromRealmValue(
    realmValueFromKeyPair(identity.keyPair),
    "the key",
  );

  expect(decoded.hasMaterial).toBe(true);
  expect((await Identity.fromKeyPair(decoded)).did()).toBe(identity.did());
});

test("keyPairFromRealmValue() returns a key pair holding the encoded handles", async () => {
  if (!await isNativeEd25519Supported()) return;
  const identity = await Identity.generate({ implementation: "webcrypto" });

  const decoded = keyPairFromRealmValue(
    realmValueFromKeyPair(identity.keyPair),
    "the key",
  );

  expect(decoded.hasMaterial).toBe(false);
  expect((await Identity.fromKeyPair(decoded)).did()).toBe(identity.did());
});

test("keyPairFromRealmValue() throws, naming the carrier, for an encoding of something else", () => {
  expect(() =>
    keyPairFromRealmValue(realmFromFabricValue("not a key"), "The message")
  ).toThrow("The message is not a key pair.");
});
