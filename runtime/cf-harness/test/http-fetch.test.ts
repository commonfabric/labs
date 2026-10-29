/**
 * Importing through the package barrel keeps `defaultHarnessFetch` reachable
 * from the public entry point that consumers use, alongside the gateway client
 * that falls back to it. What that default forwards to the global fetch is
 * pinned here too.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  defaultHarnessFetch,
  OpenAICompatibleGatewayClient,
} from "../src/index.ts";

Deno.test("barrel re-exports the harness fetch default", () => {
  assertEquals(typeof defaultHarnessFetch, "function");
  assertEquals(typeof OpenAICompatibleGatewayClient, "function");
});

Deno.test("defaultHarnessFetch forwards input and init to the global fetch", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const stubResponse = new Response("ok", { status: 200 });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(stubResponse);
  }) as typeof globalThis.fetch;

  try {
    const init: RequestInit = { method: "POST", body: "payload" };
    const response = await defaultHarnessFetch("https://example.test/", init);
    assertStrictEquals(response, stubResponse);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].input, "https://example.test/");
    assertStrictEquals(calls[0].init, init);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("the gateway client falls back to the global fetch when given none", async () => {
  const original = globalThis.fetch;
  const seen: Array<RequestInfo | URL> = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    seen.push(input);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof globalThis.fetch;

  try {
    const client = new OpenAICompatibleGatewayClient({
      baseUrl: "https://llm.example.test/",
      apiKey: "test-key",
    });
    await client.listModels();
    assertEquals(seen.length, 1);
    assertEquals(
      (seen[0] as URL).toString(),
      "https://llm.example.test/v1/models",
    );
  } finally {
    globalThis.fetch = original;
  }
});
