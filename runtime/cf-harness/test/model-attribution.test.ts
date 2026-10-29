import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createHarnessRunReport } from "../src/contracts/run-report.ts";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { OpenAICompatibleGatewayModelClient } from "../src/model/openai-compatible-gateway.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";

const turn = (model: string): HarnessModelTurnRequest => ({
  model,
  transcript: [{ role: "user", content: "Reply briefly." }],
  tools: [],
  nativeModelToolIds: [],
  runId: "model-attribution",
});

const terminal = (model: unknown) => ({
  id: "response-attribution",
  status: "completed",
  ...(model !== undefined ? { model } : {}),
  output: [{
    type: "message",
    id: "message-attribution",
    role: "assistant",
    content: [{ type: "output_text", text: "Done." }],
  }],
});

describe("model-attribution", () => {
  for (
    const observed of ["served-model-2026-10-07", undefined, "", "   ", 42]
  ) {
    const expected = typeof observed === "string" && observed.trim()
      ? observed
      : undefined;
    it(`returns the Codex response model ${JSON.stringify(observed)} independently of the request`, async () => {
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: {
          resolve: () =>
            Promise.resolve({
              type: "oauth",
              providerId: "openai-codex",
              accessToken: "fictional-access",
              refreshToken: "fictional-refresh",
              expiresAt: Date.now() + 60_000,
              accountId: "fictional-account",
            }),
        },
        fetchFn: () =>
          Promise.resolve(
            new Response(
              `data: ${
                JSON.stringify({
                  type: "response.completed",
                  response: terminal(observed),
                })
              }\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
          ),
      });
      const result = await client.complete(turn("gpt-requested-alias"));
      expect(result.assistant.content).toBe("Done.");
      expect(result.observedModel).toBe(expected);
    });

    for (const requested of ["gpt-5.6-terra", "fixture-chat-alias"]) {
      it(`returns the gateway response model ${JSON.stringify(observed)} for ${requested}`, async () => {
        const response = requested === "gpt-5.6-terra" ? terminal(observed) : {
          model: observed,
          choices: [{
            index: 0,
            message: { role: "assistant", content: "Done." },
          }],
        };
        const client = new OpenAICompatibleGatewayModelClient(
          new OpenAICompatibleGatewayClient({
            baseUrl: "https://gateway.test",
            authMode: "none",
            fetchFn: () =>
              Promise.resolve(new Response(JSON.stringify(response))),
          }),
        );
        const result = await client.complete(turn(requested));
        expect(result.assistant.content).toBe("Done.");
        expect(result.observedModel).toBe(expected);
      });
    }
  }

  for (
    const scenario of [
      {
        name: "all returned model IDs",
        modelTurns: 3,
        modelResponses: [
          { modelTurn: 1, model: "served-b" },
          { modelTurn: 2, model: "served-a" },
          { modelTurn: 3, model: "served-b" },
        ],
        actualModels: ["served-a", "served-b"],
        complete: true,
      },
      {
        name: "an unattributed response",
        modelTurns: 2,
        modelResponses: [
          { modelTurn: 1, model: "served-a" },
          { modelTurn: 2, model: null },
        ],
        actualModels: ["served-a"],
        complete: false,
      },
      {
        name: "a failed turn without a response",
        modelTurns: 2,
        modelResponses: [{ modelTurn: 1, model: "served-a" }],
        actualModels: ["served-a"],
        complete: false,
      },
      {
        name: "legacy callers without response metadata",
        modelTurns: 1,
        modelResponses: [],
        actualModels: [],
        complete: false,
      },
      {
        name: "duplicate turn metadata",
        modelTurns: 2,
        modelResponses: [
          { modelTurn: 1, model: "served-a" },
          { modelTurn: 1, model: "served-a" },
        ],
        actualModels: ["served-a"],
        complete: false,
      },
      {
        name: "blank model metadata",
        modelTurns: 1,
        modelResponses: [{ modelTurn: 1, model: " " }],
        actualModels: [],
        complete: false,
      },
    ]
  ) {
    it(`reports explicit attribution coverage for ${scenario.name}`, () => {
      const report = createHarnessRunReport({
        runState: {
          runId: "model-attribution",
          status: "completed",
          updatedAt: "2026-10-07T00:00:00.000Z",
          cfcEnforcementMode: "disabled",
          policyEvents: [],
          policyDecisions: [],
          toolOutputs: [],
        },
        model: "requested-alias",
        modelTurns: scenario.modelTurns,
        modelResponses: scenario.modelResponses,
        toolActivity: [],
      });
      expect(report.model).toBe("requested-alias");
      expect(report.actualModels).toEqual(scenario.actualModels);
      expect(report.modelAttributionComplete).toBe(scenario.complete);
      expect(report.modelResponses).toEqual(scenario.modelResponses);
    });
  }
});
