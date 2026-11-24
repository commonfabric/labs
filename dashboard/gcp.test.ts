/**
 * Tests for the GCP REST helpers: the service-account JWT is signed correctly
 * (verified with the matching public key), and jobs.query responses parse. No
 * network — signing and parsing are exercised directly.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { bqRows, METADATA_TOKEN_URL, saAssertion } from "./gcp.ts";

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

// Export a generated private key as PEM PKCS#8, the shape a service-account key uses.
const toPem = (der: ArrayBuffer): string =>
  `-----BEGIN PRIVATE KEY-----\n${encodeBase64(der)}\n-----END PRIVATE KEY-----`;

Deno.test("saAssertion: signs a verifiable RS256 JWT with the expected claims", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const now = 1_700_000_000;
  const jwt = await saAssertion(
    { client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" },
    now,
  );

  const [head, body, sig] = jwt.split(".");
  // The signature covers `header.body` and verifies against the public key.
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    pair.publicKey,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${head}.${body}`),
  );
  assertEquals(ok, true);

  assertEquals(b64urlToJson(head), { alg: "RS256", typ: "JWT" });
  const claims = b64urlToJson(body);
  assertEquals(claims.iss, "svc@proj.iam.gserviceaccount.com");
  assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
  assertEquals(claims.scope, "https://www.googleapis.com/auth/cloud-platform.read-only");
  assertEquals(claims.iat, now);
  assertEquals(claims.exp, now + 3600);
});

Deno.test("bqRows: flattens a jobs.query grid, empty cells become ''", () => {
  const json = { jobComplete: true, rows: [{ f: [{ v: "123.45" }, { v: "svc" }] }, { f: [{ v: null }] }] };
  assertEquals(bqRows(json), [["123.45", "svc"], [""]]);
});

Deno.test("bqRows: a response with no rows yields an empty grid", () => {
  assertEquals(bqRows({ jobComplete: true }), []);
});

Deno.test("bqRows: an incomplete job is an error, not silently empty", () => {
  assertThrows(() => bqRows({ jobComplete: false }), Error, "did not complete");
});

Deno.test("metadata token URL matches the documented key", () => {
  // Workload Identity is the only auth the deployed dashboard has, and this path is
  // the whole of it. Spelled "service-account" it returns a 404, the cloud spend tile
  // reads that as a dead source and grays out, and nothing says why. Nothing in a
  // local run or a test would catch it, so the documented path is pinned here.
  assertEquals(
    METADATA_TOKEN_URL,
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
  );
});
