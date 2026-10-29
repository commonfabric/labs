import { assert, assertThrows } from "@std/assert";

import * as ed25519 from "@noble/ed25519";

import {
  NativeEd25519Signer,
  NativeEd25519Verifier,
} from "../src/ed25519/native.ts";
import {
  NobleEd25519Signer,
  NobleEd25519Verifier,
} from "../src/ed25519/noble.ts";
import { didToBytes, isNativeEd25519Supported } from "../src/ed25519/utils.ts";
import { DIDKey } from "../src/interface.ts";
import { bytesEqual } from "./utils.ts";

type SignerImpl<ID extends DIDKey> =
  | NativeEd25519Signer<ID>
  | NobleEd25519Signer<ID>;
type VerifierImpl<ID extends DIDKey> =
  | NativeEd25519Verifier<ID>
  | NobleEd25519Verifier<ID>;
interface SignerClass {
  fromRaw<ID extends DIDKey>(
    rawPrivateKey: Uint8Array,
  ): Promise<SignerImpl<ID>>;
}
interface VerifierClass {
  fromDid<ID extends DIDKey>(did: ID): Promise<VerifierImpl<ID>>;
  fromRaw<ID extends DIDKey>(
    rawPrivateKey: Uint8Array,
  ): Promise<VerifierImpl<ID>>;
}

const TEST_PRIVATE_KEY = new Uint8Array([
  164,
  139,
  54,
  62,
  212,
  90,
  86,
  224,
  244,
  100,
  52,
  236,
  147,
  140,
  201,
  29,
  151,
  157,
  118,
  38,
  122,
  147,
  3,
  110,
  96,
  21,
  167,
  187,
  206,
  106,
  94,
  228,
]);
const TEST_DID = "did:key:z6MkjosLwWEobyT9T6RqLTdaEhFrXAZUNkRZJuUae2ukgfEa";

Deno.test("ed25519 is supported in this environment", async () => {
  assert(await isNativeEd25519Supported());
});

Deno.test("rejects did:key values with unsupported multicodec tags", () => {
  const unsupportedDid =
    "did:key:z6DtMrg4Kv51UMAM8vJcCLcRywJfEB4dpHVxPCR6qm6hSV3N" as DIDKey;

  assertThrows(
    () => didToBytes(unsupportedDid),
    RangeError,
    "Unsupported key algorithm expected 0xed, instead of 0xe7",
  );
});

Deno.test("has same results in both impls when generating from noble", async () => {
  // Use @noble/ed25519 directly, otherwise the private key isn't accessible.
  const privateKey = ed25519.utils.randomSecretKey();
  const noble = await NobleEd25519Signer.fromRaw(privateKey);
  const native = await NativeEd25519Signer.fromRaw(privateKey);
  const buffer = new Uint8Array(32).fill(10);
  const nobleSig = await noble.sign(buffer);
  const nativeSig = await native.sign(buffer);
  const nobleVerifier = noble.verifier;
  const nativeVerifier = native.verifier;
  assert(nobleSig.ok);
  assert(nativeSig.ok);
  assert(bytesEqual(nobleSig.ok, nativeSig.ok));
  // Impls verify other impl's sig
  assert(
    (await nobleVerifier.verify({ signature: nativeSig.ok, payload: buffer }))
      .ok,
  );
  assert(
    (await nativeVerifier.verify({ signature: nobleSig.ok, payload: buffer }))
      .ok,
  );
  // Base case that should fail
  assert(
    (await nobleVerifier.verify({
      signature: nobleSig.ok,
      payload: new Uint8Array(32).fill(1),
    })).error,
  );
  assert(
    (await nativeVerifier.verify({
      signature: nativeSig.ok,
      payload: new Uint8Array(32).fill(1),
    })).error,
  );
});

// These tests are run with both Native and Noble implementations.
// Code at the start and end of the `describe` function sets this up.
testBothImpls(
  "derives DID key",
  async (Signer: SignerClass, _Verifier: VerifierClass) => {
    const signer = await Signer.fromRaw(TEST_PRIVATE_KEY);
    const { verifier } = signer;
    const did = verifier.did();
    assert(did === TEST_DID);
  },
);

testBothImpls(
  "derives bytes from DID key and back",
  async (
    _Signer: SignerClass,
    Verifier: VerifierClass,
  ) => {
    // @see https://w3c-ccg.github.io/did-method-key/#test-vectors
    const fixtures: DIDKey[] = [
      "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
      "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG",
      "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf",
    ];

    for (const fixture of fixtures) {
      const verifier = await Verifier.fromDid(fixture);
      assert(verifier.did() === fixture);
    }
  },
);

Deno.test("each implementation refuses the key pair state it cannot sign with", async () => {
  const material = (await NobleEd25519Signer.fromRaw(TEST_PRIVATE_KEY)).keyPair;
  assertThrows(
    () => new NativeEd25519Signer(material, TEST_DID),
    Error,
    "holds material",
  );

  if (!await isNativeEd25519Supported()) return;

  const handles = (await NativeEd25519Signer.fromRaw(TEST_PRIVATE_KEY)).keyPair;
  assertThrows(
    () => new NobleEd25519Signer(handles),
    Error,
    "holds handles",
  );
});

// Run tests with both implentations
function testBothImpls(
  name: string,
  fn: (signer: SignerClass, verifier: VerifierClass) => void | Promise<void>,
) {
  Deno.test(`(native) ${name}`, async () => {
    return await fn(NativeEd25519Signer, NativeEd25519Verifier);
  });
  Deno.test(`(noble) ${name}`, async () => {
    return await fn(NobleEd25519Signer, NobleEd25519Verifier);
  });
}
