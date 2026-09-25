/**
 * Tests for the Anthropic Admin API credential routes, with fetch stubbed.
 * Nothing here reaches the network.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  ANTHROPIC_TOKEN_URL,
  anthropicAdminConfigured,
  anthropicAdminHeaders,
  METADATA_IDENTITY_URL,
} from "./anthropic-auth.ts";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

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

const envWith = (vars: Record<string, string>) => (k: string) => vars[k];
const FED = {
  ANTHROPIC_FEDERATION_RULE_ID: "fdrl_rule",
  ANTHROPIC_ORGANIZATION_ID: "00000000-0000-0000-0000-000000000000",
  ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_acct",
};
const tokenOk = () => new Response(JSON.stringify({ access_token: "sk-ant-oat01-t", expires_in: 600 }));

Deno.test("the identity token is requested for the Anthropic audience with the email claim", () => {
  const url = new URL(METADATA_IDENTITY_URL);
  assertEquals(url.hostname, "metadata.google.internal");
  assertEquals(url.pathname, "/computeMetadata/v1/instance/service-accounts/default/identity");
  assertEquals(url.searchParams.get("audience"), "https://api.anthropic.com");
  assertEquals(url.searchParams.get("format"), "full");
});

Deno.test("federation: a metadata identity token is exchanged with the rule, org, and account", async () => {
  const { calls, result } = await withFetch(
    (_c, i) => (i === 0 ? new Response("header.payload.sig\n") : tokenOk()),
    () => anthropicAdminHeaders(envWith(FED)),
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url, METADATA_IDENTITY_URL);
  assertEquals(calls[0].headers.get("metadata-flavor"), "Google");
  assertEquals(calls[1].url, ANTHROPIC_TOKEN_URL);
  assertEquals(calls[1].method, "POST");
  assertEquals(JSON.parse(calls[1].body), {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: "header.payload.sig",
    federation_rule_id: "fdrl_rule",
    organization_id: "00000000-0000-0000-0000-000000000000",
    service_account_id: "svac_acct",
  });
  assertEquals(result, { authorization: "Bearer sk-ant-oat01-t", "anthropic-version": "2023-06-01" });
});

Deno.test("federation: the workspace is sent only when it is set", async () => {
  const { calls } = await withFetch(
    (_c, i) => (i === 0 ? new Response("jwt") : tokenOk()),
    () => anthropicAdminHeaders(envWith({ ...FED, ANTHROPIC_WORKSPACE_ID: "wrkspc_w" })),
  );
  assertEquals(JSON.parse(calls[1].body).workspace_id, "wrkspc_w");
});

Deno.test("federation: each call mints a fresh identity token, since Anthropic rejects a reused one", async () => {
  const { calls } = await withFetch(
    (c) => (c.url === METADATA_IDENTITY_URL ? new Response("jwt") : tokenOk()),
    async () => {
      await anthropicAdminHeaders(envWith(FED));
      await anthropicAdminHeaders(envWith(FED));
    },
  );
  assertEquals(calls.filter((c) => c.url === METADATA_IDENTITY_URL).length, 2);
});

Deno.test("federation wins over a leftover Admin key", async () => {
  const { result } = await withFetch(
    (_c, i) => (i === 0 ? new Response("jwt") : tokenOk()),
    () => anthropicAdminHeaders(envWith({ ...FED, ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-old" })),
  );
  assertEquals(result["x-api-key"], undefined);
  assertEquals(result.authorization, "Bearer sk-ant-oat01-t");
});

Deno.test("federation failures reject rather than fall back to the key", async () => {
  const env = envWith({ ...FED, ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-old" });
  await withFetch(() => new Response("nope", { status: 404 }), () =>
    assertRejects(() => anthropicAdminHeaders(env), Error, "metadata identity token failed: HTTP 404"));
  await withFetch(() => new Response(""), () =>
    assertRejects(() => anthropicAdminHeaders(env), Error, "empty identity token"));
  await withFetch((_c, i) => (i === 0 ? new Response("jwt") : new Response("{}", { status: 401 })), () =>
    assertRejects(() => anthropicAdminHeaders(env), Error, "Anthropic token exchange HTTP 401"));
  await withFetch((_c, i) => (i === 0 ? new Response("jwt") : new Response("{}")), () =>
    assertRejects(() => anthropicAdminHeaders(env), Error, "no access_token string"));
});

Deno.test("without federation, the Admin key is sent as x-api-key", async () => {
  const { calls, result } = await withFetch(
    () => new Response("unexpected", { status: 500 }),
    () => anthropicAdminHeaders(envWith({ ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-k" })),
  );
  assertEquals(calls.length, 0);
  assertEquals(result, { "x-api-key": "sk-ant-admin01-k", "anthropic-version": "2023-06-01" });
});

Deno.test("a partial federation setting counts as unconfigured", () => {
  const { ANTHROPIC_SERVICE_ACCOUNT_ID: _dropped, ...partial } = FED;
  assertEquals(anthropicAdminConfigured(envWith(partial)), false);
  assertEquals(anthropicAdminConfigured(envWith(FED)), true);
  assertEquals(anthropicAdminConfigured(envWith({ ANTHROPIC_ADMIN_KEY: "k" })), true);
  assertEquals(anthropicAdminConfigured(envWith({})), false);
});
