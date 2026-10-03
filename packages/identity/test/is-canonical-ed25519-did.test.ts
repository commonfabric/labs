import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";

import * as ed25519 from "@noble/ed25519";

import { bytesToDid, isCanonicalEd25519DID } from "../src/ed25519/utils.ts";

Deno.test("isCanonicalEd25519DID reuses canonicality checks within a bounded cache and revalidates evicted keys", () => {
  const did = bytesToDid(ed25519.Point.BASE.multiply(100_000n).toBytes());
  const decode = spy(ed25519.Point, "fromBytes");
  try {
    expect(isCanonicalEd25519DID(did)).toBe(true);
    const initial = decode.calls.length;
    for (let index = 0; index < 100; index++) {
      expect(isCanonicalEd25519DID(did)).toBe(true);
    }
    expect(decode.calls.length).toBe(initial);
    // Twice the capacity covers keys retained by earlier browser test cases.
    for (let index = 1n; index <= 8192n; index++) {
      expect(isCanonicalEd25519DID(
        bytesToDid(ed25519.Point.BASE.multiply(index).toBytes()),
      )).toBe(true);
    }
    const filled = decode.calls.length;
    expect(isCanonicalEd25519DID(did)).toBe(true);
    expect(decode.calls.length).toBe(filled + 1);
  } finally {
    decode.restore();
  }
});

Deno.test("isCanonicalEd25519DID rejects malformed and small-order encodings on repeated checks", () => {
  const valid = bytesToDid(ed25519.Point.BASE.toBytes());
  expect(isCanonicalEd25519DID(valid)).toBe(true);
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const noncanonicalIdentity = identity.slice();
  noncanonicalIdentity[31] = 128;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (
      const candidate of [
        undefined,
        null,
        {},
        [valid],
        Object(valid),
        valid + "#key-1",
        valid + "x",
        valid.toUpperCase(),
        "did:key:z" + "1".repeat(1000),
        "did:key:z6Mk-test",
        bytesToDid(new Uint8Array(32)),
        bytesToDid(identity),
        bytesToDid(noncanonicalIdentity),
      ]
    ) expect(isCanonicalEd25519DID(candidate)).toBe(false);
  }
});
