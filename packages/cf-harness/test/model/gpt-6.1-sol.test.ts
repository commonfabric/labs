import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { OpenAICompatibleGatewayClient } from "../../src/gateway/openai-client.ts";
import type { HarnessModelTurnRequest } from "../../src/model/client.ts";
import { OpenAICodexResponsesClient } from "../../src/model/openai-codex-responses.ts";
import { OpenAICompatibleGatewayModelClient } from "../../src/model/openai-compatible-gateway.ts";
import { withEstimatedOpenAIModelUsageCost } from "../../src/model/usage.ts";

const MODEL = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

describe("GPT-6.1 Sol", () => {
  it("advertises reasoning efforts and primes the input compaction budget", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = new OpenAICompatibleGatewayModelClient(
      new OpenAICompatibleGatewayClient({
        baseUrl: "https://gateway.test",
        authMode: "none",
        fetchFn: (_input, init) => {
          if (init?.body) requests.push(JSON.parse(String(init.body)));
          return Promise.resolve(
            Response.json(
              init?.body ? { status: "completed", output: [] } : {
                data: [{
                  id: MODEL,
                  capabilities: {
                    images: true,
                    contextWindow: 1_050_000,
                    maxOutputTokens: 128_000,
                  },
                }],
              },
            ),
          );
        },
      }),
    );
    const models = await client.listModels();
    expect(models[0]).toMatchObject({
      id: MODEL,
      inputModalities: ["text", "image"],
      supportedReasoningEfforts: EFFORTS,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
    });
    await client.complete(turn());
    expect(requests[0].context_management).toEqual([{
      type: "compaction",
      compact_threshold: 691_500,
    }]);
  });

  for (const mode of ["implicit", "explicit"] as const) {
    for (const effort of EFFORTS) {
      it(`sends tools with \`${mode}\` caching and \`${effort}\` reasoning`, async () => {
        const requests: Array<Record<string, unknown>> = [];
        const urls: string[] = [];
        const client = new OpenAICompatibleGatewayModelClient(
          new OpenAICompatibleGatewayClient({
            baseUrl: "https://gateway.test",
            authMode: "none",
            fetchFn: (input, init) => {
              urls.push(String(input));
              requests.push(JSON.parse(String(init?.body)));
              return Promise.resolve(Response.json({
                status: "completed",
                output: [{
                  type: "function_call",
                  id: "fc_probe",
                  call_id: "call_probe",
                  name: "read_file",
                  arguments: '{"path":"notes.txt"}',
                }],
              }));
            },
          }),
        );
        const result = await client.complete(turn({
          promptCacheMode: mode,
          reasoningEffort: effort,
        }));
        expect(urls).toEqual(["https://gateway.test/v1/responses"]);
        expect(requests[0]).toMatchObject({
          model: MODEL,
          store: false,
          include: ["reasoning.encrypted_content"],
          reasoning: { effort },
          prompt_cache_options: { mode, ttl: "30m" },
          tools: [{ type: "function", name: "read_file" }],
        });
        expect(
          JSON.stringify(requests[0].input).includes("prompt_cache_breakpoint"),
        )
          .toBe(mode === "explicit");
        expect(result.assistant.toolCalls?.[0].function).toEqual({
          name: "read_file",
          arguments: '{"path":"notes.txt"}',
        });
      });
    }
  }

  for (const effort of ["none", "minimal", "ultra"]) {
    it(`throws before dispatch given unsupported effort \`${effort}\``, async () => {
      let dispatched = false;
      const client = new OpenAICompatibleGatewayModelClient(
        new OpenAICompatibleGatewayClient({
          baseUrl: "https://gateway.test",
          authMode: "none",
          fetchFn: () => {
            dispatched = true;
            return Promise.resolve(
              Response.json({ status: "completed", output: [] }),
            );
          },
        }),
      );
      await expect(client.complete(turn({ reasoningEffort: effort })))
        .rejects.toThrow(
          new RegExp(
            `reasoning effort .*${effort}.* is not supported by .*gpt-6\\.1-sol`,
          ),
        );
      expect(dispatched).toBe(false);
    });

    it(`rejects Codex effort \`${effort}\` before credentials or dispatch`, async () => {
      let resolvedCredentials = false;
      let dispatched = false;
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: {
          resolve: () => {
            resolvedCredentials = true;
            return Promise.resolve({
              type: "oauth",
              providerId: "openai-codex",
              accessToken: "synthetic-access",
              refreshToken: "synthetic-refresh",
              expiresAt: 4_000_000_000_000,
              accountId: "synthetic-account",
            });
          },
        },
        fetchFn: () => {
          dispatched = true;
          return Promise.resolve(completedCodexResponse());
        },
      });
      await expect(client.complete(turn({ reasoningEffort: effort })))
        .rejects.toThrow(
          new RegExp(
            `reasoning effort .*${effort}.* is not supported by .*gpt-6\\.1-sol`,
          ),
        );
      expect(resolvedCredentials).toBe(false);
      expect(dispatched).toBe(false);
    });
  }

  for (const effort of [...EFFORTS, undefined]) {
    it(`sends Codex effort \`${effort ?? "provider default"}\` without cache controls`, async () => {
      const requests: Array<Record<string, unknown>> = [];
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: {
          resolve: () =>
            Promise.resolve({
              type: "oauth",
              providerId: "openai-codex",
              accessToken: "synthetic-access",
              refreshToken: "synthetic-refresh",
              expiresAt: 4_000_000_000_000,
              accountId: "synthetic-account",
            }),
        },
        fetchFn: (_input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return Promise.resolve(completedCodexResponse());
        },
      });
      await client.complete(turn({ reasoningEffort: effort }));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: MODEL,
        stream: true,
        store: false,
      });
      if (effort === undefined) {
        expect(requests[0].reasoning).toEqual({ summary: "auto" });
      } else {
        expect(requests[0].reasoning).toEqual({ effort, summary: "auto" });
      }
      expect(requests[0]).not.toHaveProperty("prompt_cache_options");
    });
  }

  it("prices cache reads, cache writes, and output at the Sol rates", () => {
    expect(withEstimatedOpenAIModelUsageCost(MODEL, {
      inputTokens: 2_000,
      cachedInputTokens: 1_200,
      cacheWriteTokens: 600,
      outputTokens: 300,
      reasoningTokens: 200,
      totalTokens: 2_300,
    })).toMatchObject({ estimatedCostUsd: 0.00502 });
  });

  for (const inputTokens of [272_000, 272_001]) {
    it(`prices the full request at the tier for \`${inputTokens}\` input tokens`, () => {
      const long = inputTokens > 272_000;
      expect(
        withEstimatedOpenAIModelUsageCost(MODEL, {
          inputTokens,
          cachedInputTokens: 1_000,
          cacheWriteTokens: 2_000,
          outputTokens: 100,
        })?.estimatedCostUsd,
      ).toBe(
        (((inputTokens - 3_000) * 2 + 1_000 * 0.1 + 2_000 * 2.5) *
            (long ? 2 : 1) +
          100 * 10 * (long ? 1.5 : 1)) / 1_000_000,
      );
    });
  }

  it("withholds an estimate when cache detail is absent", () => {
    expect(withEstimatedOpenAIModelUsageCost(MODEL, {
      inputTokens: 100,
      outputTokens: 10,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      estimateWithheldReason: "missing-cache-detail",
    });
  });
});

/** Constructs a terminal Codex event for the synthetic transport. */
function completedCodexResponse(): Response {
  return new Response(
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp-sol", status: "completed", output: [] },
      })
    }\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Constructs a synthetic tool-calling turn without external I/O. */
function turn(
  overrides: Partial<HarnessModelTurnRequest> = {},
): HarnessModelTurnRequest {
  return {
    model: MODEL,
    transcript: [{ role: "user", content: "Read the notes." }],
    tools: [{
      toolId: "read_file",
      title: "Read file",
      description: "Read a file",
      effectClass: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }],
    nativeModelToolIds: [],
    runId: "run-sol-probe",
    ...overrides,
  };
}
