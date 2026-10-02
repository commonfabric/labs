/**
 * Google Cloud access tokens without the gcloud command-line tool. A
 * service-account key's private key signs a JWT assertion that the token
 * endpoint exchanges for a short-lived access token; on GCE and GKE the
 * metadata server hands out the workload's own token instead, and no key is
 * stored anywhere.
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

// A PEM PKCS#8 private key -> a Web Crypto RS256 signing key.
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
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
  const enc = (o: unknown) => toUnpaddedBase64urlFromText(JSON.stringify(o));
  const head = enc({ alg: "RS256", typ: "JWT" });
  const body = enc({
    iss: key.client_email,
    scope,
    aud: key.token_uri,
    iat: nowSec,
    exp: nowSec + 3600,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importPkcs8(key.private_key),
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${toUnpaddedBase64url(new Uint8Array(sig))}`;
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
