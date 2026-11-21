// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import { verifyEd25519SignatureSync } from "@commonfabric/identity/verify-sync";
import { Identity } from "../src/identity.ts";

const signer = await Identity.fromRaw(new Uint8Array(32).fill(5));
const payload = new Uint8Array([1, 2, 3]);
const { ok: signature } = await signer.sign(payload);
if (!signature) throw new Error("The fixture failed to sign.");

Deno.test("verifyEd25519SignatureSync() returns `true` for the signer's signature over the payload", () => {
  expect(verifyEd25519SignatureSync(signer.did(), payload, signature)).toBe(
    true,
  );
});

Deno.test("verifyEd25519SignatureSync() returns `false` for another payload, another signer, or a changed signature", async () => {
  const other = await Identity.fromRaw(new Uint8Array(32).fill(6));
  const changed = signature.slice();
  changed[0] ^= 1;

  expect(
    verifyEd25519SignatureSync(signer.did(), new Uint8Array([1]), signature),
  )
    .toBe(false);
  expect(verifyEd25519SignatureSync(other.did(), payload, signature)).toBe(
    false,
  );
  expect(verifyEd25519SignatureSync(signer.did(), payload, changed)).toBe(
    false,
  );
});

Deno.test("verifyEd25519SignatureSync() returns `false` rather than throwing for a malformed signer or signature", () => {
  expect(verifyEd25519SignatureSync("did:key:nope", payload, signature)).toBe(
    false,
  );
  expect(
    verifyEd25519SignatureSync(signer.did(), payload, signature.subarray(1)),
  ).toBe(false);
  expect(
    verifyEd25519SignatureSync(
      signer.did(),
      payload,
      new Uint8Array(64).fill(0xff),
    ),
  ).toBe(false);
});
