import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type {
  HarnessModelLimits,
  HarnessModelTurnRequest,
} from "../src/model/client.ts";
import { limitHarnessModelClient } from "../src/model/limits.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { OpenAICompatibleGatewayModelClient } from "../src/model/openai-compatible-gateway.ts";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";

const request: HarnessModelTurnRequest = {
  model: "gpt-6.1-sol",
  transcript: [{ role: "user", content: "Hello" }],
  tools: [],
  nativeModelToolIds: [],
  runId: "bounded-call",
};
const credential = {
  type: "oauth",
  providerId: "openai-codex",
  accessToken: "fixture-access",
  refreshToken: "fixture-refresh",
  accountId: "fixture-owner",
  expiresAt: Date.now() + 60000,
} as const;
const completed = () =>
  new Response(
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );

describe("model-limits", () => {
  it("keeps inherited host bounds when a child requests a wider limit", async () => {
    const seen: HarnessModelTurnRequest[] = [];
    const limits: HarnessModelLimits = {
      maxInputBytes: 65536,
      maxOutputTokens: 8192,
    };
    const client = limitHarnessModelClient({
      providerId: "fixture",
      complete: (input) => {
        seen.push(input);
        return Promise.resolve({
          assistant: { role: "assistant", content: "OK" },
        });
      },
    }, limits);
    limits.maxOutputTokens = 999999;
    await client.complete({ ...request, maxOutputTokens: 9000 });
    await limitHarnessModelClient(client, { maxOutputTokens: 4096 }).complete(
      request,
    );
    expect(seen.map((row) => [row.maxInputBytes, row.maxOutputTokens])).toEqual(
      [
        [65536, 8192],
        [65536, 4096],
      ],
    );
    expect(() => limitHarnessModelClient(client, { maxOutputTokens: 0 }))
      .toThrow("maxOutputTokens");
  });

  it("bounds the final UTF-8 wire body and sends the output token ceiling", async () => {
    const bodies: string[] = [];
    const client = new OpenAICodexResponsesClient({
      credentialResolver: { resolve: () => Promise.resolve(credential) },
      fetchFn: (_url, init) => {
        bodies.push(String(init?.body));
        return Promise.resolve(completed());
      },
    });
    await client.complete({ ...request, maxOutputTokens: 64 });
    expect(JSON.parse(bodies[0]).max_output_tokens).toBe(64);
    const maximum = new TextEncoder().encode(bodies[0]).byteLength;
    await client.complete({
      ...request,
      maxOutputTokens: 64,
      maxInputBytes: maximum,
    });
    await expect(client.complete({
      ...request,
      maxOutputTokens: 64,
      maxInputBytes: maximum - 1,
    })).rejects.toThrow("maxInputBytes");
    for (
      const transcript of [
        [{ role: "system", content: "é".repeat(1000) }, ...request.transcript],
        [...request.transcript, {
          role: "assistant",
          content: "é".repeat(1000),
        }],
      ] satisfies HarnessModelTurnRequest["transcript"][]
    ) {
      await expect(client.complete({
        ...request,
        transcript,
        maxOutputTokens: 64,
        maxInputBytes: maximum,
      })).rejects.toThrow("maxInputBytes");
    }
    expect(bodies).toHaveLength(2);
  });

  it("makes one bounded provider attempt after an ambiguous failure", async () => {
    let dispatched = 0;
    const client = new OpenAICodexResponsesClient({
      credentialResolver: { resolve: () => Promise.resolve(credential) },
      fetchFn: () => {
        dispatched++;
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      },
    });
    await expect(client.complete({
      ...request,
      maxOutputTokens: 64,
      onAttempt: (attempt) => {
        expect(attempt.maxTransportAttempts).toBe(1);
        expect(attempt.retry).toBeUndefined();
      },
    })).rejects.toThrow();
    expect(dispatched).toBe(1);
  });

  it("refuses unverified gateway bounds before provider dispatch", async () => {
    let dispatched = 0;
    const client = new OpenAICompatibleGatewayModelClient(
      new OpenAICompatibleGatewayClient({
        baseUrl: "https://example.test",
        authMode: "none",
        fetchFn: () => {
          dispatched++;
          throw new Error("unexpected dispatch");
        },
      }),
    );
    await expect(client.complete({ ...request, maxOutputTokens: 64 })).rejects
      .toThrow("limit enforcement is unavailable");
    expect(dispatched).toBe(0);
  });
});
