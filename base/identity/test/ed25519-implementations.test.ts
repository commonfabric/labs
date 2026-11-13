// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.
//
// Which of the two Ed25519 implementations a call reaches depends on the
// platform, so each case here names the implementation it is about, or hands
// in the platform it decides by, rather than relying on which one this
// platform picks.

import { expect } from "@std/expect";

import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";

import {
  canUseNative,
  Ed25519Signer,
  Ed25519Verifier,
} from "../src/ed25519/index.ts";
import { NativeEd25519Signer } from "../src/ed25519/native.ts";
import { NobleEd25519Signer } from "../src/ed25519/noble.ts";
import {
  ED25519_ALG,
  type Ed25519Platform,
  ed25519RawToPkcs8,
  fromPEM,
  hasEd25519Features,
  isNativeEd25519Supported,
  pkcs8ToEd25519Raw,
} from "../src/ed25519/utils.ts";
import { Identity } from "../src/identity.ts";

const SEED = new Uint8Array(32).fill(3);
const PAYLOAD = new Uint8Array([1, 2, 3]);

//
// Feature detection
//

/** A platform with working Ed25519, with `overrides` written over it. */
function platform(overrides: Partial<Ed25519Platform> = {}): Ed25519Platform {
  return {
    generateKey: () =>
      crypto.subtle.generateKey(ED25519_ALG, false, ["sign", "verify"]),
    sign: (key, payload) =>
      crypto.subtle.sign(ED25519_ALG, key, payload as BufferSource),
    clone: (key) => structuredClone(key),
    ...overrides,
  };
}

Deno.test("hasEd25519Features() returns `true` for a platform that generates, signs deterministically, and clones", async () => {
  if (!await isNativeEd25519Supported()) return;

  expect(await hasEd25519Features(platform())).toBe(true);
});

Deno.test("hasEd25519Features() returns `false` for a platform without Ed25519 keys", async () => {
  const unsupported = platform({
    generateKey: () => Promise.reject(new DOMException("", "NotSupported")),
  });

  expect(await hasEd25519Features(unsupported)).toBe(false);
});

Deno.test("hasEd25519Features() returns `false` for a platform whose signatures differ for one payload", async () => {
  if (!await isNativeEd25519Supported()) return;

  // Randomized signatures differing in a byte, and in length.
  for (const lengths of [[64, 64], [64, 65]]) {
    let calls = 0;
    const randomized = platform({
      sign: () => {
        const signature = new Uint8Array(lengths[calls]!);
        signature[0] = calls++;
        return Promise.resolve(signature.buffer);
      },
    });

    expect(await hasEd25519Features(randomized)).toBe(false);
  }
});

Deno.test("hasEd25519Features() returns `false` for a platform that cannot clone its keys", async () => {
  if (!await isNativeEd25519Supported()) return;
  const uncloneable = platform({
    clone: () => {
      throw new DOMException("", "DataCloneError");
    },
  });

  expect(await hasEd25519Features(uncloneable)).toBe(false);
});

Deno.test("canUseNative() follows the requested implementation, and the platform otherwise", async () => {
  const supported = () => Promise.resolve(true);
  const unsupported = () => Promise.resolve(false);

  expect(await canUseNative({ implementation: "webcrypto" }, supported)).toBe(
    true,
  );
  expect(await canUseNative({ implementation: "noble" }, supported)).toBe(
    false,
  );
  expect(await canUseNative({}, supported)).toBe(true);
  expect(await canUseNative({}, unsupported)).toBe(false);
});

Deno.test("canUseNative() throws when WebCrypto is requested on a platform without it", async () => {
  await expect(
    canUseNative({ implementation: "webcrypto" }, () => Promise.resolve(false)),
  ).rejects.toThrow("Required WebCrypto features are not supported");
});

//
// `Ed25519Signer` and `Ed25519Verifier`
//

Deno.test("Ed25519Signer returns the same DID as its verifier, from either implementation", async () => {
  const noble = await Ed25519Signer.fromRaw(SEED, { implementation: "noble" });
  expect(noble.did()).toBe(noble.verifier.did());
  if (!await isNativeEd25519Supported()) return;

  const native = await Ed25519Signer.fromRaw(SEED, {
    implementation: "webcrypto",
  });
  expect(native.did()).toBe(noble.did());
});

Deno.test("Ed25519Signer.toPkcs8() returns the PEM of a noble key's seed, and throws for a native key", async () => {
  const noble = await Ed25519Signer.fromRaw(SEED, { implementation: "noble" });
  expect(pkcs8ToEd25519Raw(fromPEM(noble.toPkcs8()))).toEqual(SEED);
  if (!await isNativeEd25519Supported()) return;

  const native = await Ed25519Signer.generate({ implementation: "webcrypto" });
  expect(() => native.toPkcs8()).toThrow('requires "noble" implementation');
  expect(() => native.toRaw()).toThrow('requires "noble" implementation');
});

Deno.test("Ed25519Signer.generate() returns a noble signer that signs what its verifier accepts", async () => {
  const signer = await Ed25519Signer.generate({ implementation: "noble" });
  const { ok: signature } = await signer.sign(PAYLOAD);

  expect(signer.keyPair.hasMaterial).toBe(true);
  expect(
    (await signer.verifier.verify({ payload: PAYLOAD, signature: signature! }))
      .ok,
  ).toBeDefined();
});

Deno.test("Ed25519Signer.fromKeyPair() reconstitutes either implementation from the pair's state", async () => {
  const noble = await Ed25519Signer.fromRaw(SEED, { implementation: "noble" });
  const fromMaterial = await Ed25519Signer.fromKeyPair(noble.keyPair);
  expect(fromMaterial.did()).toBe(noble.did());
  expect(fromMaterial.toRaw()).toEqual(SEED);
  if (!await isNativeEd25519Supported()) return;

  const native = await Ed25519Signer.fromRaw(SEED, {
    implementation: "webcrypto",
  });
  const fromHandles = await Ed25519Signer.fromKeyPair(native.keyPair);
  expect(fromHandles.did()).toBe(noble.did());
  expect(fromHandles.keyPair.hasMaterial).toBe(false);
});

Deno.test("Ed25519Signer.fromKeyPair() throws for a pair for another algorithm", async () => {
  const other = new FabricKeyPair("X25519", SEED, SEED);

  await expect(Ed25519Signer.fromKeyPair(other)).rejects.toThrow(
    "it is for X25519",
  );
});

Deno.test("Ed25519Verifier.fromRaw() returns a verifier for the key's DID, from either implementation", async () => {
  const signer = await NobleEd25519Signer.fromRaw(SEED);
  const publicKey = signer.keyPair.publicKeyBytes.slice();
  const { ok: signature } = await signer.sign(PAYLOAD);

  for (const implementation of ["noble", "webcrypto"] as const) {
    if (implementation === "webcrypto" && !await isNativeEd25519Supported()) {
      continue;
    }
    const verifier = await Ed25519Verifier.fromRaw(publicKey, {
      implementation,
    });
    expect(verifier.did()).toBe(signer.did());
    expect(
      (await verifier.verify({ payload: PAYLOAD, signature: signature! })).ok,
    ).toBeDefined();
  }
});

//
// Signing failures
//

Deno.test("NativeEd25519Signer.sign() returns the failure as an error rather than throwing", async () => {
  // WebCrypto refuses a payload viewing shared memory, which a page that is
  // not cross-origin isolated cannot make at all.
  if (!await isNativeEd25519Supported()) return;
  if (typeof SharedArrayBuffer === "undefined") return;
  const signer = await NativeEd25519Signer.fromRaw(SEED);

  const result = await signer.sign(new Uint8Array(new SharedArrayBuffer(4)));

  expect(result.ok).toBeUndefined();
  expect(result.error).toBeInstanceOf(TypeError);
  expect((await signer.sign(PAYLOAD)).ok).toBeDefined();
  expect(signer.did()).toBe(signer.verifier.did());
});

Deno.test("NobleEd25519Signer.sign() returns the failure as an error rather than throwing", async () => {
  const { keyPair } = await NobleEd25519Signer.fromRaw(SEED);
  const truncated = new FabricKeyPair(
    ED25519_ALG,
    keyPair.publicKeyBytes.slice(),
    new Uint8Array(31),
  );

  const result = await new NobleEd25519Signer(truncated).sign(PAYLOAD);

  expect(result.ok).toBeUndefined();
  expect(result.error).toBeInstanceOf(Error);
});

Deno.test("Identity.derive() throws the error its signer fails with", async () => {
  const { keyPair } = await NobleEd25519Signer.fromRaw(SEED);
  const identity = await Identity.fromKeyPair(
    new FabricKeyPair(
      ED25519_ALG,
      keyPair.publicKeyBytes.slice(),
      new Uint8Array(31),
    ),
  );

  await expect(identity.derive("child")).rejects.toThrow();
  expect(identity.did()).toBe((await Identity.fromRaw(SEED)).did());
});

Deno.test("Identity.toPkcs8() returns what `Identity.fromPkcs8()` reads back as the same identity", async () => {
  const identity = await Identity.fromRaw(SEED, { implementation: "noble" });

  const restored = await Identity.fromPkcs8(identity.toPkcs8());

  expect(restored.did()).toBe(identity.did());
});

//
// PKCS8
//

Deno.test("pkcs8ToEd25519Raw() returns the seed `ed25519RawToPkcs8()` wrapped", () => {
  expect(pkcs8ToEd25519Raw(ed25519RawToPkcs8(SEED))).toEqual(SEED);
});

Deno.test("pkcs8ToEd25519Raw() throws for bytes of the wrong length or with another prefix", () => {
  const pkcs8 = ed25519RawToPkcs8(SEED);
  const otherPrefix = pkcs8.slice();
  otherPrefix[15] ^= 1;

  expect(() => pkcs8ToEd25519Raw(pkcs8.subarray(1))).toThrow(
    "Invalid key length.",
  );
  expect(() => pkcs8ToEd25519Raw(otherPrefix)).toThrow("Invalid key prefix.");
});
