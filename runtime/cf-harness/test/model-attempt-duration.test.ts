/**
 * The two durations a model attempt records: `durationMs`, which ends when the
 * response headers arrive, and `responseCompleteDurationMs`, which ends when
 * the response body or stream does. Each client is driven with a scripted
 * monotonic clock, so what a case turns on is which reading the client took at
 * which point rather than how long anything really took.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";
import {
  type OpenAIChatCompletionAttemptDiagnostic,
  OpenAICompatibleGatewayClient,
} from "../src/gateway/openai-client.ts";
import type { HarnessModelAttemptDiagnostic } from "../src/model/client.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";

/**
 * Hands out `readings` in order, repeating the last one once they run out, so
 * a client that takes an extra reading cannot read past the end of the script.
 */
const scriptedClock = (readings: readonly number[]): () => number => {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)];
};

const credential: OpenAICodexOAuthCredential = {
  type: "oauth",
  providerId: "openai-codex",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: Date.now() + 60_000,
  accountId: "acct-123",
};

const sse = (...events: unknown[]): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

describe("model-attempt-duration", () => {
  describe("OpenAICompatibleGatewayClient", () => {
    it("ends `responseCompleteDurationMs` at the read body rather than at the headers", async () => {
      const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
      const client = new OpenAICompatibleGatewayClient({
        baseUrl: "https://llm.stage.commontools.dev/",
        apiKey: "test-key",
        monotonicNowMs: scriptedClock([1_000, 1_012, 1_900]),
        fetchFn: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                }],
              }),
              { status: 200 },
            ),
          ),
      });

      await client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }, {
        onChatCompletionAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });

      expect(attempts.length).toBe(1);
      expect(attempts[0].durationMs).toBe(12);
      expect(attempts[0].responseCompleteDurationMs).toBe(900);
    });

    it("ends both durations at the failure for a transport error", async () => {
      const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
      const client = new OpenAICompatibleGatewayClient({
        baseUrl: "https://llm.stage.commontools.dev/",
        apiKey: "test-key",
        transportRetries: 0,
        monotonicNowMs: scriptedClock([1_000, 1_040]),
        fetchFn: () => Promise.reject(new Error("connection reset")),
      });

      await expect(client.createResponseJson({
        model: "gpt-5.6",
        input: [],
      }, {
        onChatCompletionAttempt: (attempt) => {
          attempts.push(attempt);
        },
      })).rejects.toThrow("transport request failed");

      expect(attempts.length).toBe(1);
      expect(attempts[0].outcome).toBe("transport_error");
      expect(attempts[0].durationMs).toBe(40);
      expect(attempts[0].responseCompleteDurationMs).toBe(40);
    });

    it("omits `responseCompleteDurationMs` when the caller reads the body", async () => {
      const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
      const client = new OpenAICompatibleGatewayClient({
        baseUrl: "https://llm.stage.commontools.dev/",
        apiKey: "test-key",
        monotonicNowMs: scriptedClock([1_000, 1_012, 1_900]),
        fetchFn: () => Promise.resolve(new Response("{}", { status: 200 })),
      });

      const response = await client.createChatCompletion({
        model: "gpt-5.4",
        messages: [],
      }, {
        onChatCompletionAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });
      await response.text();

      expect(attempts.length).toBe(1);
      expect(attempts[0].responseCompleteDurationMs).toBeUndefined();
    });

    it("omits `responseCompleteDurationMs` for a body that fails to parse", async () => {
      const attempts: OpenAIChatCompletionAttemptDiagnostic[] = [];
      const client = new OpenAICompatibleGatewayClient({
        baseUrl: "https://llm.stage.commontools.dev/",
        apiKey: "test-key",
        monotonicNowMs: scriptedClock([1_000, 1_012, 1_900]),
        fetchFn: () =>
          Promise.resolve(new Response("not json", { status: 200 })),
      });

      await expect(client.createChatCompletionJson({
        model: "gpt-5.4",
        messages: [],
      }, {
        onChatCompletionAttempt: (attempt) => {
          attempts.push(attempt);
        },
      })).rejects.toThrow();

      expect(attempts.length).toBe(1);
      expect(attempts[0].durationMs).toBe(12);
      expect(attempts[0].responseCompleteDurationMs).toBeUndefined();
    });
  });

  describe("OpenAICodexResponsesClient", () => {
    it("ends `responseCompleteDurationMs` at the terminal stream event", async () => {
      const attempts: HarnessModelAttemptDiagnostic[] = [];
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: { resolve: () => Promise.resolve(credential) },
        monotonicNowMs: scriptedClock([1_000, 1_012, 1_900]),
        fetchFn: () =>
          Promise.resolve(sse({
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [{
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "hello" }],
              }],
            },
          })),
      });

      await client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-123",
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
      });

      expect(attempts.length).toBe(1);
      expect(attempts[0].outcome).toBe("http_response");
      expect(attempts[0].durationMs).toBe(12);
      expect(attempts[0].responseCompleteDurationMs).toBe(900);
    });

    it("records one attempt for a stream that ends without a terminal event", async () => {
      const attempts: HarnessModelAttemptDiagnostic[] = [];
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: { resolve: () => Promise.resolve(credential) },
        monotonicNowMs: scriptedClock([1_000, 1_012, 1_500]),
        fetchFn: () =>
          Promise.resolve(sse({ type: "response.output_text.delta" })),
      });

      await expect(client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-123",
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
      })).rejects.toThrow("without a terminal response event");

      expect(attempts.length).toBe(1);
      expect(attempts[0].responseCompleteDurationMs).toBe(500);
    });

    it("ends both durations at the failure for a transport error", async () => {
      const attempts: HarnessModelAttemptDiagnostic[] = [];
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: { resolve: () => Promise.resolve(credential) },
        monotonicNowMs: scriptedClock([1_000, 1_055]),
        fetchFn: () => Promise.reject(new Error("connection reset")),
      });

      await expect(client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-123",
        onAttempt: (attempt) => {
          attempts.push(attempt);
        },
      })).rejects.toThrow("transport request failed");

      expect(attempts.length).toBe(1);
      expect(attempts[0].outcome).toBe("transport_error");
      expect(attempts[0].durationMs).toBe(55);
      expect(attempts[0].responseCompleteDurationMs).toBe(55);
    });

    it("throws the abort reason for an abort landing while the attempt is emitted", async () => {
      const controller = new AbortController();
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: { resolve: () => Promise.resolve(credential) },
        monotonicNowMs: scriptedClock([1_000, 1_012, 1_900]),
        fetchFn: () =>
          Promise.resolve(sse({
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [{
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: "hello" }],
              }],
            },
          })),
      });

      await expect(client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-123",
        signal: controller.signal,
        onAttempt: () => {
          controller.abort(new Error("caller went away"));
        },
      })).rejects.toThrow("caller went away");
    });
  });
});
