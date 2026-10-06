/**
 * Google Cloud access tokens without the gcloud command-line tool. A
 * service-account key's private key signs a JWT assertion that the token
 * endpoint exchanges for a short-lived access token; on GCE and GKE the
 * metadata server hands out the workload's own token instead, and no key is
 * stored anywhere. The RS256 signing underneath is exported for other services
 * that authenticate with a JWT signed by an RSA key, GitHub Apps among them.
 */

import {
  toUnpaddedBase64url,
  toUnpaddedBase64urlFromText,
} from "@commonfabric/utils/base64url";

export interface ServiceAccountKey {
  client_email: string;

  /** PEM, PKCS#8. */
  private_key: string;

  token_uri: string;
}

const METADATA = "http://metadata.google.internal/computeMetadata/v1";

/**
 * Imports `pem`, an RSA private key in PKCS#8 or in the PKCS#1 form GitHub
 * issues for its apps, as a Web Crypto key that signs RS256. Web Crypto reads
 * PKCS#8 alone, so a PKCS#1 key is first wrapped in the PKCS#8 structure that
 * names it as an RSA key.
 *
 * @throws when `pem` is not a PEM RSA private key.
 */
export async function importRsaSigningKey(pem: string): Promise<CryptoKey> {
  const label = /-----BEGIN ([A-Z ]+)-----/.exec(pem)?.[1];
  if (label !== "RSA PRIVATE KEY" && label !== "PRIVATE KEY") {
    throw new Error("expected a PEM RSA private key");
  }
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  return await crypto.subtle.importKey(
    "pkcs8",
    label === "PRIVATE KEY" ? der : pkcs8FromPkcs1(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// The DER encoding of the PKCS#8 fields ahead of the key: version 0, then the
// algorithm identifier for `rsaEncryption` with its null parameters.
// deno-fmt-ignore
const PKCS8_RSA_PREFIX = [
  0x02, 0x01, 0x00,
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

/** Helper for `importRsaSigningKey()`, which wraps a PKCS#1 key as PKCS#8. */
function pkcs8FromPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const octets = [0x04, ...derLength(pkcs1.length)];
  const content = PKCS8_RSA_PREFIX.length + octets.length + pkcs1.length;
  const header = [0x30, ...derLength(content)];
  const out = new Uint8Array(header.length + content);
  out.set(header);
  out.set(PKCS8_RSA_PREFIX, header.length);
  out.set(octets, header.length + PKCS8_RSA_PREFIX.length);
  out.set(pkcs1, header.length + PKCS8_RSA_PREFIX.length + octets.length);
  return out;
}

/**
 * Helper for `pkcs8FromPkcs1()`, which encodes `length` in the long form DER
 * uses for every length an RSA key's structures have.
 */
function derLength(length: number): number[] {
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Returns a JWT carrying `claims`, signed RS256 with `key`. */
export async function rs256Jwt(
  key: CryptoKey,
  claims: Readonly<Record<string, string | number>>,
): Promise<string> {
  const enc = (o: unknown) => toUnpaddedBase64urlFromText(JSON.stringify(o));
  const signed = `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${toUnpaddedBase64url(new Uint8Array(sig))}`;
}

/**
 * The signed service-account assertion: a JWT claiming the given scope,
 * signed with the key's private key. `nowSec` is the current time in whole
 * seconds. Its signature can be verified with the public key, which is what
 * the tests do.
 */
export async function saAssertion(
  key: ServiceAccountKey,
  nowSec: number,
  scope: string,
): Promise<string> {
  return await rs256Jwt(await importRsaSigningKey(key.private_key), {
    iss: key.client_email,
    scope,
    aud: key.token_uri,
    iat: nowSec,
    exp: nowSec + 3600,
  });
}

/**
 * Exchanges a service-account assertion for an access token at the key's
 * token endpoint. One request, no retries.
 */
export async function tokenFromKey(
  key: ServiceAccountKey,
  scope: string,
): Promise<string> {
  const assertion = await saAssertion(
    key,
    Math.floor(Date.now() / 1000),
    scope,
  );
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const json = await res.json() as { access_token?: unknown };
  if (
    typeof json.access_token !== "string" || json.access_token.length === 0
  ) {
    throw new Error("token exchange returned no access_token string");
  }
  return json.access_token;
}

/**
 * The metadata server's key for the workload's own access token. Pinned as
 * a constant because the segment is "service-accounts", plural, a singular
 * path 404s, and this is the only auth route in-cluster — so a typo here is
 * invisible everywhere except the one environment that depends on it.
 */
export const METADATA_TOKEN_URL =
  `${METADATA}/instance/service-accounts/default/token`;

/** Asks the metadata server for the workload's own access token. */
export async function tokenFromMetadata(): Promise<string> {
  const res = await fetch(METADATA_TOKEN_URL, {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`metadata token failed: HTTP ${res.status}`);
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) {
    throw new Error("metadata server returned no access_token");
  }
  return json.access_token;
}
