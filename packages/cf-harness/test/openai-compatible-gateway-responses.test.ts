import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import {
  OpenAICompatibleGatewayModelClient,
  usesResponsesApi,
} from "../src/model/openai-compatible-gateway.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import {
  WEB_SEARCH_SUBAGENT_MODEL,
  WEB_SEARCH_SUBAGENT_NATIVE_MODEL_TOOL_IDS,
} from "../src/contracts/subagent.ts";
import {
  addFirstUserPromptCacheBreakpoint,
  type ResponsesInputItem,
} from "../src/model/responses-protocol.ts";

const GATEWAY = "https://gateway.test";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const clientWith = (
  captured: Captured[],
  bodies: unknown[],
): OpenAICompatibleGatewayModelClient => {
  let call = 0;
  return new OpenAICompatibleGatewayModelClient(
    new OpenAICompatibleGatewayClient({
      baseUrl: GATEWAY,
      authMode: "none",
      fetchFn: (input, init) => {
        captured.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        const body = bodies[Math.min(call, bodies.length - 1)];
        call += 1;
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      },
    }),
  );
};

const turn = (
  overrides: Partial<HarnessModelTurnRequest> = {},
): HarnessModelTurnRequest => ({
  model: "gpt-5.6-terra",
  transcript: [{ role: "user", content: "Read the notes." }],
  tools: [{
    toolId: "read_file",
    title: "Read file",
    description: "Read a file",
    effectClass: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }],
  nativeModelToolIds: [],
  runId: "run-responses",
  ...overrides,
});

const completedResponse = (output: unknown[]) => ({
  id: "resp_1",
  object: "response",
  status: "completed",
  output,
});

Deno.test("gpt-5.6 turns go to the Responses API with reasoning enabled", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done.", annotations: [] }],
    }]),
  ]);

  const result = await client.complete(turn());

  assertEquals(captured[0].url, `${GATEWAY}/v1/responses`);
  const body = captured[0].body;
  assertEquals(body.model, "gpt-5.6-terra");
  assertEquals(body.store, false);
  // Reasoning must not be disabled the way the Chat Completions workaround did.
  assertEquals(body.reasoning_effort, undefined);
  // A gateway routes models that do not reason too, so without an effort the
  // request names no reasoning at all, summary included.
  assertEquals(body.reasoning, undefined);
  assertEquals(body.include, ["reasoning.encrypted_content"]);
  // Tools use the Responses shape: a flat name, not { function: { name } }.
  assertEquals(body.tools, [{
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    strict: null,
  }]);
  assertEquals(result.assistant.content, "Done.");
});

Deno.test("gpt-5.6 tool calls survive alongside reasoning", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "encrypted-reasoning-blob",
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call-1",
        name: "read_file",
        arguments: JSON.stringify({ path: "notes.txt" }),
      },
    ]),
  ]);

  const result = await client.complete(turn());

  assertEquals(result.assistant.toolCalls, [{
    id: "call-1",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "notes.txt" }),
    },
  }]);
  // The encrypted reasoning item is retained so the next turn can replay it.
  const state = result.assistant.providerContinuation?.state as {
    output: Array<Record<string, unknown>>;
    sourceModel: string;
  };
  assertEquals(
    result.assistant.providerContinuation?.providerId,
    "openai-compatible-gateway",
  );
  assertEquals(state.sourceModel, "gpt-5.6-terra");
  assertEquals(state.output[0].encrypted_content, "encrypted-reasoning-blob");
});

Deno.test("reasoning items are replayed on the following turn", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_2",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "All set.", annotations: [] }],
    }]),
  ]);

  const transcript: HarnessTranscriptMessage[] = [
    { role: "user", content: "Read the notes." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      }],
      providerContinuation: {
        providerId: "openai-compatible-gateway",
        state: {
          version: 1,
          sourceModel: "gpt-5.6-terra",
          output: [{
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted-reasoning-blob",
          }],
          functionCallItemIds: { "call-1": "fc_1" },
        },
      },
    },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: "file contents",
    },
  ];

  await client.complete(turn({ transcript }));

  const input = captured[0].body.input as Array<Record<string, unknown>>;
  assertEquals(input[0].role, "user");
  // The encrypted reasoning item is replayed ahead of the call it produced.
  assertEquals(input[1], {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "encrypted-reasoning-blob",
  });
  // The recorded item id is reattached so the provider can match the call.
  assertEquals(input[2].type, "function_call");
  assertEquals(input[2].id, "fc_1");
  assertEquals(input[3], {
    type: "function_call_output",
    call_id: "call-1",
    output: "file contents",
  });
});

Deno.test("non-OpenAI models and native tools stay on Chat Completions", async () => {
  // The gateway cannot translate the Responses schema for Vertex-backed
  // models, and provider-native tools have no Responses equivalent there.
  assertEquals(usesResponsesApi("gpt-5.6-sol", []), true);
  assertEquals(usesResponsesApi("gpt-5.5", []), true);
  assertEquals(usesResponsesApi("gemini-3.5-flash", []), false);
  assertEquals(usesResponsesApi("claude-opus-5", []), false);
  // gpt-* plus native tools is rejected before routing, so it is covered by
  // the dedicated guard test rather than asserted as a routing outcome here.

  const captured: Captured[] = [];
  const client = clientWith(captured, [{
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Searched." },
    }],
  }]);

  await client.complete(turn({ model: "gemini-3.5-flash" }));

  assertEquals(captured[0].url, `${GATEWAY}/v1/chat/completions`);
});

Deno.test("a chat turn with no content field is handled", async () => {
  // gemini-3.5-flash returns `{role, thinking_blocks, tool_calls}` on a
  // tool-call-only turn — `content` is absent, not null. Treating that as an
  // array threw `Cannot read properties of undefined (reading 'flatMap')` and
  // broke every claude-*/gemini-* run that called a tool.
  const captured: Captured[] = [];
  const client = clientWith(captured, [{
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        thinking_blocks: [{ type: "thinking", thinking: "..." }],
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
    }],
  }]);

  const result = await client.complete(turn({ model: "gemini-3.5-flash" }));

  assertEquals(captured[0].url, `${GATEWAY}/v1/chat/completions`);
  assertEquals(result.assistant.content, "");
  assertEquals(result.assistant.toolCalls?.[0].id, "call-1");
});

Deno.test("resuming with a different model drops the stale continuation", async () => {
  // The CLI pins the provider on resume but not the model, so
  // `--resume-run X --model other` is legal. Encrypted reasoning is bound to
  // the model that produced it, so it is dropped rather than failing the run.
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_6",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "resumed", annotations: [] }],
    }]),
  ]);

  const result = await client.complete(turn({
    model: "gpt-5.6-sol",
    transcript: [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "Working.",
        providerContinuation: {
          providerId: "openai-compatible-gateway",
          state: {
            version: 1,
            sourceModel: "gpt-5.6-terra",
            output: [{
              type: "reasoning",
              id: "rs_1",
              encrypted_content: "bound-to-terra",
            }],
          },
        },
      },
    ],
  }));

  const input = captured[0].body.input as Array<Record<string, unknown>>;
  assertEquals(input.some((item) => item.type === "reasoning"), false);
  assertEquals(result.assistant.content, "resumed");
});

Deno.test("native tools on an OpenAI model fail with a named error", async () => {
  // Chat Completions is the only path that serves native tools, and it rejects
  // function tools while reasoning is on — so this combination must not route
  // silently into a provider 400.
  const client = clientWith([], [completedResponse([])]);
  await assertRejects(
    () =>
      client.complete(turn({
        model: "gpt-5.6-sol",
        nativeModelToolIds: ["google_search"],
      })),
    Error,
    "cannot combine provider-native tools",
  );
});

Deno.test("the web_search profile keeps a non-OpenAI model", () => {
  // The guard above is only unreachable while this stays true.
  assertEquals(WEB_SEARCH_SUBAGENT_MODEL.startsWith("gpt-"), false);
  assertEquals(
    usesResponsesApi(
      WEB_SEARCH_SUBAGENT_MODEL,
      WEB_SEARCH_SUBAGENT_NATIVE_MODEL_TOOL_IDS,
    ),
    false,
  );
});

Deno.test("the Responses turn stays stateless", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_4",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }]),
  ]);

  await client.complete(turn());

  const body = captured[0].body;
  // The harness transcript is the only source of truth: nothing is persisted
  // provider-side and no turn is chained to a stored response. That keeps
  // resume-from-transcript working and keeps CFC-mediated tool output from
  // being bypassed by provider-retained context.
  assertEquals(body.store, false);
  assertEquals(body.previous_response_id, undefined);
  assertEquals(Array.isArray(body.input), true);
});

Deno.test("prompt_cache_key is bounded to the provider limit", async () => {
  // Subagent run ids are `<parent>.subagent.<n>` and grow with nesting depth.
  // The provider rejects prompt_cache_key above 64 characters outright, which
  // would fail every model turn in a deeply delegated run.
  const runId = `loom-run-${"a".repeat(120)}.subagent.1.subagent.2`;
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_5",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }]),
  ]);

  await client.complete(turn({ runId }));

  const key = captured[0].body.prompt_cache_key as string;
  assertEquals(key.length <= 64, true);
  // Stable and run-specific: the same id maps to the same key.
  await client.complete(turn({ runId }));
  assertEquals(captured[1].body.prompt_cache_key, key);
  // Short ids are passed through untouched.
  await client.complete(turn({ runId: "run-short" }));
  assertEquals(captured[2].body.prompt_cache_key, "run-short");
});

Deno.test("cache affinity, explicit breakpoint, and reasoning are configurable", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_cache",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }]),
  ]);

  await client.complete(turn({
    runId: "ephemeral-run-id",
    cacheAffinityKey: "stable-chat-session",
    promptCacheMode: "explicit",
    reasoningEffort: "low",
  }));

  const body = captured[0].body;
  assertEquals(body.prompt_cache_key, "stable-chat-session");
  assertEquals(body.prompt_cache_options, {
    mode: "explicit",
    ttl: "30m",
  });
  assertEquals(body.reasoning, { effort: "low", summary: "auto" });
  const input = body.input as Array<Record<string, unknown>>;
  const content = input[0].content as Array<Record<string, unknown>>;
  assertEquals(content[content.length - 1].prompt_cache_breakpoint, {
    mode: "explicit",
  });
});

Deno.test("explicit cache breakpoint selects the last cacheable user block", () => {
  const original: ResponsesInputItem[] = [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "earlier" }],
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
        { type: "input_file", file_id: "file_123" },
        { type: "unsupported_test_block" },
      ],
    },
  ];

  const withBreakpoint = addFirstUserPromptCacheBreakpoint(
    original,
    "test provider",
  );
  const content = withBreakpoint[1].content as ResponsesInputItem[];
  assertEquals(content[1].prompt_cache_breakpoint, { mode: "explicit" });
  assertEquals(content[2].prompt_cache_breakpoint, undefined);
  assertEquals(original, [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "earlier" }],
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
        { type: "input_file", file_id: "file_123" },
        { type: "unsupported_test_block" },
      ],
    },
  ]);

  const imageOnly = addFirstUserPromptCacheBreakpoint(
    [{
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: "data:image/png;base64,AA==",
      }],
    }],
    "test provider",
  );
  const imageContent = imageOnly[0].content as ResponsesInputItem[];
  assertEquals(imageContent[0].prompt_cache_breakpoint, { mode: "explicit" });
});

Deno.test("explicit cache breakpoint requires cacheable user content", () => {
  assertThrows(
    () =>
      addFirstUserPromptCacheBreakpoint([{
        type: "message",
        role: "user",
        content: [{ type: "unsupported_test_block" }],
      }], "test provider"),
    Error,
    "test provider explicit prompt caching requires a cacheable user content block",
  );
});

Deno.test("GPT-5.6 cache controls fail before sending an older model", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [completedResponse([])]);

  await assertRejects(
    () =>
      client.complete(turn({
        model: "gpt-5.4",
        promptCacheMode: "explicit",
      })),
    Error,
    "prompt cache mode explicit requires a GPT-5.6 model",
  );
  assertEquals(captured.length, 0);
});

Deno.test("unsupported GPT-5.6 reasoning effort fails before sending", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [completedResponse([])]);

  await assertRejects(
    () => client.complete(turn({ reasoningEffort: "ultra" })),
    Error,
    "reasoning effort ultra is not supported by gpt-5.6-terra",
  );
  assertEquals(captured.length, 0);
});

Deno.test("Responses usage includes cache details and an estimated cost", async () => {
  const captured: Captured[] = [];
  const response = completedResponse([{
    type: "message",
    id: "msg_usage",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  }]) as Record<string, unknown>;
  response.usage = {
    input_tokens: 2_000,
    input_tokens_details: {
      cached_tokens: 1_200,
      cache_write_tokens: 600,
    },
    output_tokens: 300,
    output_tokens_details: { reasoning_tokens: 200 },
    total_tokens: 2_300,
  };
  const client = clientWith(captured, [response]);

  const result = await client.complete(turn());

  assertEquals(result.usage, {
    inputTokens: 2_000,
    cachedInputTokens: 1_200,
    cacheWriteTokens: 600,
    outputTokens: 300,
    reasoningTokens: 200,
    totalTokens: 2_300,
    estimatedCostUsd: 0.007175,
  });
});

Deno.test("a turn without a system message sends no instructions", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completedResponse([{
      type: "message",
      id: "msg_3",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }]),
  ]);

  await client.complete(turn());
  assertEquals(captured[0].body.instructions, undefined);

  await client.complete(turn({
    transcript: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi." },
    ],
  }));
  assertEquals(captured[1].body.instructions, "Be brief.");
});
