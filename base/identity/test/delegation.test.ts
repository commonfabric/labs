// Flat `Deno.test` cases: this package's tests also run in a browser through
// `deno-web-test`, which does not support `@std/testing/bdd`.

import { expect } from "@std/expect";

import { type DagCborValue, encodeDagCbor } from "../src/dag-cbor.ts";
import {
  decodeDelegation,
  DELEGATION_TAG,
  delegationCid,
  delegationCovers,
  DelegationError,
  ED25519_DAG_CBOR_VARSIG,
  issueDelegation,
  verifyDelegation,
} from "../src/delegation.ts";
import { Identity } from "../src/identity.ts";

const profile = await Identity.fromString(
  "MCl6B1cu1ZOP0I3BBovjAqo57VImrMVyfLiSmNKoddXs=",
);
const core = await Identity.fromString(
  "MU+bzp2GaFQHso587iSFWPSeCzbSfn/CbNHEz7ilKRZ0=",
);

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));

const nonce = fromHex("d67014047b63920401cc607e");

/**
 * The delegation `profile` issues to `core` over its own space with `nonce`,
 * as this codec encodes it: the envelope bytes and their CID, pinned so that
 * a change to the encoding is a change to this test. Ed25519 signatures are
 * deterministic, so the same key and payload give the same bytes.
 */
const VECTOR = {
  cid: "zdpuAowsnPvQPmKgKF5h7aK4LGwGgUpbx2bfWqwJHiSPH1CT2",
  bytes: fromHex(
    "8258400ab842d2bee73f38cf88594ee301c4a0ed0a9696bfa5cf32916cf9fdf148abe9f7" +
      "53d07aa15cdbab8cea6c9e42fc3e74117519e656ce98e26450046d9da7160ea2616848" +
      "3401ed01ed0113716e7563616e2f646c6740312e302e30a76361756478386469643a6b" +
      "65793a7a364d6b6b38396243334a7256714b6965373159456363354d31534d56787543" +
      "674e78367a4c5a3853594a7378414c6963636d64672f6d656d6f727963657870f66369" +
      "737378386469643a6b65793a7a364d6b725a3172355842465a6a42553334717944386675" +
      "654d624d526b4b773137425a61713269764b466a6e7a327a63706f6c80637375627838" +
      "6469643a6b65793a7a364d6b725a3172355842465a6a42553334717944386675654d62" +
      "4d526b4b773137425a61713269764b466a6e7a327a656e6f6e63654cd67014047b6392" +
      "0401cc607e",
  ),
};

const issue = () =>
  issueDelegation(profile, {
    aud: core.did(),
    sub: profile.did(),
    cmd: "/memory",
    pol: [],
    nonce,
  });

/** An envelope around `fields`, with the vector's signature, for decoding. */
const envelope = (
  fields: DagCborValue,
  header: Uint8Array = ED25519_DAG_CBOR_VARSIG,
  tag: string = DELEGATION_TAG,
): Uint8Array =>
  encodeDagCbor([VECTOR.bytes.slice(3, 67), { h: header, [tag]: fields }]);

const fields = (
  extra: { [key: string]: DagCborValue } = {},
): DagCborValue => ({
  iss: profile.did(),
  aud: core.did(),
  sub: profile.did(),
  cmd: "/memory",
  pol: [],
  nonce,
  exp: null,
  ...extra,
});

Deno.test("issueDelegation() returns the pinned bytes and CID for the pinned key and nonce", async () => {
  const delegation = await issue();
  expect(delegation.bytes).toEqual(VECTOR.bytes);
  expect(delegation.cid).toBe(VECTOR.cid);
  expect(delegation.payload.iss).toBe(profile.did());
});

Deno.test("issueDelegation() returns a CID in the form UCAN requires, which begins `zdpu`", async () => {
  const delegation = await issue();
  expect(delegation.cid.startsWith("zdpu")).toBe(true);
  expect(await delegationCid(delegation.bytes)).toBe(delegation.cid);
});

Deno.test("issueDelegation() returns different bytes for two delegations that differ only in nonce", async () => {
  const first = await issueDelegation(profile, {
    aud: core.did(),
    sub: profile.did(),
    cmd: "/memory",
    pol: [],
  });
  const second = await issueDelegation(profile, {
    aud: core.did(),
    sub: profile.did(),
    cmd: "/memory",
    pol: [],
  });
  expect(first.cid).not.toBe(second.cid);
});

Deno.test("issueDelegation() throws for a command that is not a path", async () => {
  await expect(
    issueDelegation(profile, {
      aud: core.did(),
      sub: profile.did(),
      cmd: "memory",
      pol: [],
    }),
  ).rejects.toThrow(DelegationError);
});

Deno.test("decodeDelegation() returns the signed fields of the pinned bytes", async () => {
  const delegation = await decodeDelegation(VECTOR.bytes);
  expect(delegation.payload).toEqual({
    iss: profile.did(),
    aud: core.did(),
    sub: profile.did(),
    cmd: "/memory",
    pol: [],
    nonce,
    exp: null,
  });
  expect(delegation.cid).toBe(VECTOR.cid);
  expect(delegation.signature).toEqual(VECTOR.bytes.slice(3, 67));
});

Deno.test("decodeDelegation() returns the fields of a delegation with an expiry and a start", async () => {
  const issued = await issueDelegation(core, {
    aud: profile.did(),
    sub: profile.did(),
    cmd: "/memory/session.open",
    pol: [],
    exp: 2_000_000,
    nbf: 1_000_000,
  });
  const decoded = await decodeDelegation(issued.bytes);
  expect(decoded.payload.exp).toBe(2_000_000);
  expect(decoded.payload.nbf).toBe(1_000_000);
});

Deno.test("decodeDelegation() throws for bytes that are not DAG-CBOR", async () => {
  await expect(decodeDelegation(new Uint8Array([0xff]))).rejects.toThrow(
    DelegationError,
  );
});

Deno.test("decodeDelegation() throws for a non-empty policy", async () => {
  await expect(decodeDelegation(envelope(fields({ pol: [["==", ".x", 1]] }))))
    .rejects.toThrow(DelegationError);
});

Deno.test("decodeDelegation() throws for a field the shape does not have", async () => {
  await expect(decodeDelegation(envelope(fields({ meta: {} }))))
    .rejects.toThrow(DelegationError);
});

Deno.test("decodeDelegation() returns a `null` subject, which UCAN allows", async () => {
  const decoded = await decodeDelegation(envelope(fields({ sub: null })));
  expect(decoded.payload.sub).toBeNull();
});

Deno.test("decodeDelegation() throws for an envelope with another tag or another varsig header", async () => {
  await expect(
    decodeDelegation(envelope(fields(), undefined, "ucan/inv@1.0.0")),
  ).rejects.toThrow(DelegationError);
  await expect(
    decodeDelegation(envelope(fields(), new Uint8Array([0x34, 0x01]))),
  ).rejects.toThrow(DelegationError);
});

Deno.test("verifyDelegation() resolves for a delegation its issuer signed", async () => {
  await expect(verifyDelegation(await decodeDelegation(VECTOR.bytes)))
    .resolves.toBeUndefined();
});

Deno.test("verifyDelegation() throws for a delegation whose payload was changed after signing", async () => {
  const forged = await decodeDelegation(envelope(fields({ cmd: "/" })));
  await expect(verifyDelegation(forged)).rejects.toThrow(DelegationError);
});

Deno.test("verifyDelegation() throws for a delegation signed by a key other than its issuer", async () => {
  const issued = await issueDelegation(core, {
    aud: core.did(),
    sub: profile.did(),
    cmd: "/memory",
    pol: [],
    nonce,
  });
  const claimed = await decodeDelegation(
    envelope(fields({ iss: core.did(), aud: core.did() })),
  );
  // Same fields as `issued` less the signer: the vector's signature is the
  // profile's, and the issuer named is the core.
  expect(claimed.payload).toEqual(issued.payload);
  await expect(verifyDelegation(claimed)).rejects.toThrow(DelegationError);
});

Deno.test("delegationCovers() returns `true` for an equal command or one under the delegated path", () => {
  expect(delegationCovers("/memory", "/memory")).toBe(true);
  expect(delegationCovers("/memory", "/memory/session.open")).toBe(true);
  expect(delegationCovers("/", "/memory/session.open")).toBe(true);
});

Deno.test("decodeDelegation() keeps a leading U+FEFF in a text field, so a changed command is refused rather than read as the original", async () => {
  // The vector's signature covers `/memory`. The same envelope with the
  // command re-encoded as `\ufeff/memory` carries a different text, which
  // is not a command path, so decoding refuses it; a decoder that dropped
  // the character would read the altered bytes as the signed delegation.
  await expect(decodeDelegation(envelope(fields({ cmd: "\ufeff/memory" }))))
    .rejects.toThrow("cmd is not a command path");
});

Deno.test("issueDelegation() throws a `DelegationError` for a negative expiry or start", async () => {
  await expect(
    issueDelegation(profile, {
      aud: core.did(),
      sub: profile.did(),
      cmd: "/memory",
      pol: [],
      exp: -1,
    }),
  ).rejects.toThrow(DelegationError);
  await expect(
    issueDelegation(profile, {
      aud: core.did(),
      sub: profile.did(),
      cmd: "/memory",
      pol: [],
      nbf: -1,
    }),
  ).rejects.toThrow(DelegationError);
});

Deno.test("delegationCovers() returns `false` for a command beside or above the delegated path", () => {
  expect(delegationCovers("/memory/session.open", "/memory")).toBe(false);
  expect(delegationCovers("/memory", "/memorydb")).toBe(false);
  expect(delegationCovers("/memory", "/")).toBe(false);
});
