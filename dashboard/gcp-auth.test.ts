/**
 * Tests for the two GCP auth routes and the BigQuery call that uses them, with
 * fetch stubbed. Nothing here reaches the network: every request the code makes
 * is captured and inspected, and the responses are canned.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { bigQuery, METADATA_TOKEN_URL } from "./gcp.ts";

// One request as the code issued it, normalized through Request so headers and
// body read the same way whichever path built it.
interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

// Run `fn` with fetch answered by `reply`, and hand back what was requested.
// The original fetch is restored even when the body throws, so a failing test
// leaves nothing behind for the other test files in this process.
async function withFetch<T>(
  reply: (call: Call, index: number) => Response,
  fn: () => Promise<T>,
): Promise<{ calls: Call[]; result: T }> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    const call: Call = { url: req.url, method: req.method, headers: req.headers, body: await req.text() };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  try {
    return { calls, result: await fn() };
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const TOKEN_URI = "https://oauth2.googleapis.com/token";

// Generating an RSA key is slow, so the tests that need a service-account key share one.
let pair: CryptoKeyPair | undefined;
async function saKeyJson(): Promise<string> {
  pair ??= await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${encodeBase64(der)}\n-----END PRIVATE KEY-----`;
  return JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem, token_uri: TOKEN_URI });
}

const envWith = (vars: Record<string, string>) => (k: string) => vars[k];
const noEnv = () => undefined;

const QUERY_OK = { jobComplete: true, rows: [{ f: [{ v: "12.5" }, { v: "bigquery" }] }] };

Deno.test("GCP_SA_KEY set: a signed assertion is exchanged for a token at the key's own token_uri", async () => {
  const key = await saKeyJson();
  const { calls, result } = await withFetch(
    (_c, i) => (i === 0 ? json({ access_token: "sa-token" }) : json(QUERY_OK)),
    () => bigQuery("my-proj", "SELECT 1", envWith({ GCP_SA_KEY: key })),
  );

  assertEquals(calls.length, 2);
  const exchange = calls[0];
  assertEquals(exchange.url, TOKEN_URI);
  assertEquals(exchange.method, "POST");
  const form = new URLSearchParams(exchange.body);
  assertEquals(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");

  // The assertion is the JWT this key signed, not a passed-through secret: it
  // verifies against the matching public key.
  const [head, body, sig] = (form.get("assertion") ?? "").split(".");
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    pair!.publicKey,
    b64urlToBytes(sig),
    new TextEncoder().encode(`${head}.${body}`),
  );
  assertEquals(verified, true);
  assertEquals(
    JSON.parse(new TextDecoder().decode(b64urlToBytes(body))).iss,
    "svc@proj.iam.gserviceaccount.com",
  );

  // The token that came back is what the query is authorized with.
  assertEquals(calls[1].headers.get("authorization"), "Bearer sa-token");
  assertEquals(result, [["12.5", "bigquery"]]);
});

Deno.test("no GCP_SA_KEY: the token comes from the metadata server, flavor header and all", async () => {
  const { calls, result } = await withFetch(
    (_c, i) => (i === 0 ? json({ access_token: "metadata-token" }) : json(QUERY_OK)),
    () => bigQuery("my-proj", "SELECT 1", noEnv),
  );

  assertEquals(calls.length, 2);
  const token = calls[0];
  assertEquals(token.url, METADATA_TOKEN_URL);
  assertEquals(token.method, "GET"); // the metadata token is a read, not an exchange
  // Without this header the metadata server refuses the request outright.
  assertEquals(token.headers.get("metadata-flavor"), "Google");
  assertEquals(calls[1].headers.get("authorization"), "Bearer metadata-token");
  assertEquals(result, [["12.5", "bigquery"]]);
});

Deno.test("bigQuery: the query is standard SQL and the response grid is flattened", async () => {
  const { calls, result } = await withFetch(
    (_c, i) => (i === 0 ? json({ access_token: "t" }) : json({
      jobComplete: true,
      rows: [{ f: [{ v: "1" }, { v: null }] }, { f: [{ v: "2" }, { v: "b" }] }],
    })),
    () => bigQuery("proj with space/slash", "SELECT cost FROM t", noEnv),
  );

  const query = calls[1];
  // The project id is a path segment, so it is escaped rather than splicing a
  // second segment into the URL.
  assertEquals(query.url, "https://bigquery.googleapis.com/bigquery/v2/projects/proj%20with%20space%2Fslash/queries");
  assertEquals(query.method, "POST");
  assertEquals(query.headers.get("content-type"), "application/json");
  // Legacy SQL parses the same text differently; the queries are written as standard SQL.
  assertEquals(JSON.parse(query.body), { query: "SELECT cost FROM t", useLegacySql: false, timeoutMs: 25_000 });
  assertEquals(result, [["1", ""], ["2", "b"]]);
});

Deno.test("token exchange rejected: the status is reported, not swallowed into a token", async () => {
  const key = await saKeyJson();
  const err = await assertRejects(
    () =>
      withFetch(
        () => json({ error: "invalid_grant" }, 401),
        () => bigQuery("p", "SELECT 1", envWith({ GCP_SA_KEY: key })),
      ),
    Error,
  );
  assertEquals(err.message, "token exchange failed: HTTP 401");
});

Deno.test("token exchange 200 with no access_token is an error, not an empty bearer", async () => {
  const key = await saKeyJson();
  const err = await assertRejects(
    () =>
      withFetch(
        () => json({ expires_in: 3600 }),
        () => bigQuery("p", "SELECT 1", envWith({ GCP_SA_KEY: key })),
      ),
    Error,
  );
  assertEquals(err.message, "token exchange returned no access_token string");
});

Deno.test("metadata server rejects: the status is reported (a 404 here means the wrong path)", async () => {
  const err = await assertRejects(
    () => withFetch(() => json({}, 404), () => bigQuery("p", "SELECT 1", noEnv)),
    Error,
  );
  assertEquals(err.message, "metadata token failed: HTTP 404");
});

Deno.test("metadata server 200 with no access_token is an error, not an empty bearer", async () => {
  const err = await assertRejects(
    () => withFetch(() => json({ expires_in: 3600 }), () => bigQuery("p", "SELECT 1", noEnv)),
    Error,
  );
  assertEquals(err.message, "metadata server returned no access_token");
});

Deno.test("bigQuery: a rejected query surfaces its status rather than reading as no rows", async () => {
  const err = await assertRejects(
    () =>
      withFetch(
        (_c, i) => (i === 0 ? json({ access_token: "t" }) : json({ error: "denied" }, 403)),
        () => bigQuery("p", "SELECT 1", noEnv),
      ),
    Error,
  );
  // An empty grid would read as zero spend; the caller needs to see the failure.
  assertEquals(err.message, "bigquery query failed: HTTP 403");
});
