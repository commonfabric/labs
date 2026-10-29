import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";

import { decode } from "@commonfabric/utils/encoding";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { NobleEd25519Verifier } from "../src/ed25519/noble.ts";
import { isNativeEd25519Supported } from "../src/ed25519/utils.ts";
import { Identity } from "../src/identity.ts";

Deno.test("Identity generates mnemonics", async () => {
  const [identity, mnemonic] = await Identity.generateMnemonic();
  const did = identity.verifier.did();
  const identity2 = await Identity.fromMnemonic(mnemonic);
  assert(did, identity2.verifier.did());
});

Deno.test("Can generate into/read from PKCS8", async () => {
  const pkcs8 = await Identity.generatePkcs8();
  assert(/^-----BEGIN PRIVATE KEY-----/.test(decode(pkcs8)));
  assert(/-----END PRIVATE KEY-----$/.test(decode(pkcs8)));
  const identity = await Identity.fromPkcs8(pkcs8);
  assert(identity.verifier.did());
  // Change a byte, should be invalid pkcs8
  pkcs8[1] = 0;
  let throws = false;
  try {
    await Identity.fromPkcs8(pkcs8);
  } catch (_) {
    throws = true;
  }
  assert(throws, "Identity.fromPkcs8() throws with invalid pkcs8");
});

Deno.test("BIP39 entropy is the raw seed — no KDF between", async () => {
  // THE contract device pairing rests on: `fromMnemonic` maps a phrase to BIP39
  // entropy and uses those bytes DIRECTLY as the ed25519 seed, so 32 bytes of
  // entropy and the 24 words encoding them name the same identity. A pairing QR
  // carries the entropy precisely because the words do not fit.
  //
  // This test — NOT any alias — is what makes that safe to rely on. If a KDF is
  // ever introduced into fromMnemonic, this fails loudly instead of silently
  // signing paired devices in under a different DID.
  const [identity, mnemonic] = await Identity.generateMnemonic();
  const entropy = mnemonicToEntropy(mnemonic, wordlist);

  assertEquals(entropy.length, 32);
  assertEquals((await Identity.fromRaw(entropy)).did(), identity.did());
});

Deno.test("fromRaw matches the pinned all-zero BIP39 vector", async () => {
  const identity = await Identity.fromRaw(new Uint8Array(32));
  assertEquals(
    identity.did(),
    "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
  );
});

Deno.test("toRaw round-trips an existing key back to its seed", async () => {
  // Closes the loop the pairing flow needs: a key that was NEVER generated from
  // a phrase can still be re-encoded as one, so nobody has to re-key. `toRaw`
  // is the exact inverse of `fromRaw`.
  const pkcs8 = await Identity.generatePkcs8();
  const identity = await Identity.fromPkcs8(pkcs8, { implementation: "noble" });

  const seed = identity.toRaw();
  assertEquals(seed.length, 32);
  assertEquals((await Identity.fromRaw(seed)).did(), identity.did());

  // ...and the seed is valid BIP39 entropy, so the words exist — the pairing
  // flow does this step at its own call site, not in the identity class.
  const mnemonic = entropyToMnemonic(seed, wordlist);
  assertEquals(mnemonic.split(" ").length, 24);
  assertEquals((await Identity.fromMnemonic(mnemonic)).did(), identity.did());
});

Deno.test("toRaw is asymmetric — byte order is preserved", async () => {
  // The all-zero vector is a fixed point of reversal, so a test using only it
  // would pass even if the seed were mangled on the way out.
  const seed = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
  const identity = await Identity.fromRaw(seed, { implementation: "noble" });
  assertEquals(identity.toRaw(), seed);
});

Deno.test("toRaw returns a COPY — mutating it cannot corrupt the identity", async () => {
  // The pair `keyPair` hands out is immutable; `toRaw()` answers with bytes a
  // caller owns, and so has a copy to make where that one does not.
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(7), {
    implementation: "noble",
  });
  const seed = identity.toRaw();
  seed[0] = 0xff;
  assertEquals(identity.toRaw()[0], 7, "the identity's seed must be unchanged");
});

Deno.test("a native signer's key pair cannot be used to reach it", async () => {
  // The native arm holds `CryptoKey`s, which are opaque and carry no reachable
  // material. What remains to check is the pair around them: one instance
  // serves every call, so a holder able to reassign a key in it would reach
  // the signer.
  if (!await isNativeEd25519Supported()) return;

  const identity = await Identity.fromRaw(new Uint8Array(32).fill(7), {
    implementation: "webcrypto",
  });
  const keyPair = identity.keyPair;

  assert(Object.isFrozen(keyPair), "the pair must not be reassignable");
  assertThrows(
    () => {
      (keyPair as { publicCryptoKey: CryptoKey }).publicCryptoKey =
        keyPair.privateCryptoKey;
    },
    TypeError,
  );

  // The `CryptoKeyPair` record is minted per call, so a caller that reassigns
  // a member of one alters nothing anyone else reads.
  const record = keyPair.cryptoKeyPair;
  record.privateKey = record.publicKey;
  assertEquals(keyPair.cryptoKeyPair.privateKey, keyPair.privateCryptoKey);
});

Deno.test("fromKeyPair refuses a pair for another algorithm", async () => {
  // A pair holding material says which algorithm it is for and is otherwise
  // indistinguishable from an ed25519 one, both keys being 32 bytes.
  const seed = new Uint8Array(32).fill(7);
  const identity = await Identity.fromRaw(seed, { implementation: "noble" });
  const wrong = new FabricKeyPair(
    "X25519",
    identity.keyPair.publicKeyBytes,
    identity.keyPair.privateKeyBytes,
  );

  await assertRejects(
    () => Identity.fromKeyPair(wrong),
    Error,
    "X25519",
  );
});

Deno.test("a signer copies the key material it is constructed from", async () => {
  const seed = new Uint8Array(32).fill(7);
  const identity = await Identity.fromRaw(seed, { implementation: "noble" });
  seed[0] = 0xff;
  assertEquals(identity.toRaw()[0], 7, "the signing secret must be unchanged");
});

Deno.test("a verifier built from raw bytes copies them", async () => {
  // `fromRaw()` is where a mutable array enters; the constructor itself takes
  // immutable bytes and so has nothing to defend against.
  //
  // The observable is `verify()`, not `did()`: the DID is derived once at
  // construction and cached, so it cannot drift whatever happens. An aliased
  // key would instead leave this verifying against mutated material while
  // still reporting the original DID.
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(7), {
    implementation: "noble",
  });
  const publicKey = identity.keyPair.publicKeyBytes.slice();
  const verifier = await NobleEd25519Verifier.fromRaw(publicKey);
  const payload = new Uint8Array(32).fill(9);
  const signature = await identity.sign(payload);
  assert(signature.ok);

  publicKey[0] ^= 0xff;

  const result = await verifier.verify({ signature: signature.ok, payload });
  assert(result.ok, "verification must be unaffected by the caller's mutation");
});

Deno.test("two toRaw() callers cannot interfere with each other", async () => {
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(7), {
    implementation: "noble",
  });
  const first = identity.toRaw();
  const second = identity.toRaw();
  assert(first !== second, "each call must yield its own array");
  first[0] = 0xff;
  assertEquals(second[0], 7, "one caller must not reach another's seed");
});

Deno.test("toRaw throws cleanly for a non-noble implementation", async () => {
  // On Firefox ≥136 the DEFAULT (native/WebCrypto) implementation is used, and
  // it cannot export private material. The failure must be an honest error, not
  // a PKCS8-flavored red herring, and pairing callers pass NOBLE explicitly to
  // avoid it entirely.
  const identity = await Identity.generate(); // default implementation
  let message = "";
  try {
    identity.toRaw();
    throw new Error("expected toRaw to throw for the default implementation");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  // Only meaningful when the platform actually used native; noble-only
  // environments (Deno/Chromium in CI) won't throw, and that's fine.
  if (message) {
    assert(
      /raw key material/i.test(message),
      `error should name raw key material, got: ${message}`,
    );
  }
});
