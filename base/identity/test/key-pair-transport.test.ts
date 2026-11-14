// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";

import { isNativeEd25519Supported } from "../src/ed25519/utils.ts";
import { Identity } from "../src/identity.ts";
import {
  keyPairFromRealmValue,
  realmValueFromKeyPair,
} from "../src/key-pair-transport.ts";

Deno.test("keyPairFromRealmValue() returns a key pair holding material that signs as the encoded one", async () => {
  const identity = await Identity.generate({ implementation: "noble" });

  const decoded = keyPairFromRealmValue(
    realmValueFromKeyPair(identity.keyPair),
    "the key",
  );

  expect(decoded.hasMaterial).toBe(true);
  expect((await Identity.fromKeyPair(decoded)).did()).toBe(identity.did());
});

Deno.test("keyPairFromRealmValue() returns a key pair holding the encoded handles", async () => {
  if (!await isNativeEd25519Supported()) return;
  const identity = await Identity.generate({ implementation: "webcrypto" });

  const decoded = keyPairFromRealmValue(
    realmValueFromKeyPair(identity.keyPair),
    "the key",
  );

  expect(decoded.hasMaterial).toBe(false);
  expect((await Identity.fromKeyPair(decoded)).did()).toBe(identity.did());
});

Deno.test("keyPairFromRealmValue() throws, naming the carrier, for an encoding of something else", () => {
  expect(() =>
    keyPairFromRealmValue(realmFromFabricValue("not a key"), "The message")
  ).toThrow("The message is not a key pair.");
});
