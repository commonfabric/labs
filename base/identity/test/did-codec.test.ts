import { assertThrows } from "@std/assert";
import { base58btc } from "multiformats/bases/base58";
import { varint } from "multiformats";
import { didToBytes } from "../src/ed25519/utils.ts";
import { DIDKey } from "../src/interface.ts";

const ED25519_CODE = 0xed;
const ED25519_PUB_KEY_RAW_SIZE = 32;

// Build a `did:key:z...` from a multicodec prefix and key bytes, using the
// same multibase/varint helpers `didToBytes` decodes with.
function makeTaggedDid(code: number, keyBytes: Uint8Array): DIDKey {
  const tagSize = varint.encodingLength(code);
  const bytes = new Uint8Array(tagSize + keyBytes.length);
  varint.encodeTo(code, bytes);
  bytes.set(keyBytes, tagSize);
  return `did:key:${base58btc.encode(bytes)}`;
}

Deno.test("didToBytes rejects an ed25519 key of the wrong length", () => {
  // The unsupported-multicodec branch is covered in ed25519.test.ts and
  // memory/test/util.test.ts. This covers the adjacent length-check branch,
  // which those tests skip because their non-ed25519 DID throws first: a
  // correct ed25519 tag with one byte too few reaches the length check.
  const did = makeTaggedDid(
    ED25519_CODE,
    new Uint8Array(ED25519_PUB_KEY_RAW_SIZE - 1),
  );
  assertThrows(
    () => didToBytes(did),
    RangeError,
    "byteLength",
  );
});
