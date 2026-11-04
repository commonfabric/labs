/**
 * Runs a catalog bootstrap and generation requests in one isolated process.
 * Every provider HTTP request is handled in memory before the registry loads.
 */

import { expect } from "@std/expect";

/** Gateway model IDs and the model each successful generation must reach. */
interface CatalogFixture {
  /** Language models in the gateway's discovery order. */
  models: string[];

  /** Chosen model ID, or null when no language model is available. */
  expected: string | null;
}

const fixture: CatalogFixture = JSON.parse(Deno.args[0]);
const generationModels: string[] = [];
let discoveries = 0;

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url === "https://gateway.invalid/v1/models") {
    discoveries++;
    return Response.json({
      object: "list",
      data: [
        {
          id: "image-only",
          object: "model",
          owned_by: "fixture",
          capabilities: { type: "image-generation" },
        },
        ...fixture.models.map((id) => ({
          id,
          object: "model",
          owned_by: "fixture",
          capabilities: { streaming: true, systemPrompt: true },
        })),
      ],
    });
  }
  expect(request.url).toBe("https://gateway.invalid/v1/chat/completions");
  const body = await request.json();
  expect(body.model).toBe(fixture.expected);
  generationModels.push(body.model);
  const completion = {
    id: "fixture-completion",
    created: 0,
    model: body.model,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  if (body.stream) {
    const chunk = {
      ...completion,
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "stub response" },
        finish_reason: "stop",
      }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return Response.json({
    ...completion,
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: '{"value":"stub response"}' },
      finish_reason: "stop",
    }],
  });
};

// Gateway discovery runs at module load, after the HTTP stub is installed.
// deno-lint-ignore cf-imports/no-inline-module-import
const { default: router } = await import("@/routes/ai/llm/llm.index.ts");

for (const object of [true, false]) {
  const path = object ? "/api/ai/llm/generateObject" : "/api/ai/llm";
  const payload = {
    messages: [{ role: "user", content: "Return the fixture value." }],
    cache: false,
    ...(object
      ? {
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }
      : {}),
  };
  const response = await router.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, model: "default" }),
  });
  const value = await response.json();
  expect({ status: response.status, value }).toMatchObject(
    fixture.expected === null
      ? { status: 400, value: { error: expect.stringContaining("default") } }
      : {
        status: 200,
        value: object ? { object: { value: "stub response" } } : {
          role: "assistant",
          content: "stub response",
        },
      },
  );

  const unknown = await router.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, model: "gateway:missing-model" }),
  });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toContain("missing-model");
}
expect(discoveries).toBe(1);
expect(generationModels).toEqual(
  fixture.expected === null ? [] : [fixture.expected, fixture.expected],
);
