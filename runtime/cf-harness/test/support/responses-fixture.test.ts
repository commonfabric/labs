import { assertEquals } from "@std/assert";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./responses-fixture.ts";
import { OpenAICompatibleGatewayClient } from "../../src/gateway/openai-client.ts";
import { OpenAICompatibleGatewayModelClient } from "../../src/model/openai-compatible-gateway.ts";
import type { HarnessModelTurnRequest } from "../../src/model/client.ts";

/**
 * These suites lean on `responses-fixture.ts` to keep 139 chat-shaped
 * fixtures usable after cf-harness moved to the Responses API. That makes the
 * adapter load-bearing for the rest of the tests, so it is tested here in its
 * own right — a silent bug in it could otherwise mask a production defect or
 * manufacture a failure that has nothing to do with the code under test.
 */

const GATEWAY = "https://gateway.test";

const clientReturning = (body: unknown) => {
  const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = new OpenAICompatibleGatewayModelClient(
    new OpenAICompatibleGatewayClient({
      baseUrl: GATEWAY,
      authMode: "none",
      fetchFn: (input, init) => {
        captured.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      },
    }),
  );
  return { client, captured };
};

const turn = (
  model: string,
  overrides: Partial<HarnessModelTurnRequest> = {},
): HarnessModelTurnRequest => ({
  model,
  transcript: [{ role: "user", content: "Read the notes." }],
  tools: [{
    toolId: "read_file",
    title: "Read file",
    description: "Read a file",
    effectClass: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }],
  nativeModelToolIds: [],
  runId: "run-fixture",
  ...overrides,
});

// The property that matters: converting a fixture must not change the
// assistant message the harness derives from it. Both production paths are
// driven with the same fixture — Chat Completions reads it directly, the
// Responses path reads the converted form — and the results must agree.

const assertPathsAgree = async (chatFixture: Record<string, unknown>) => {
  // gemini-* stays on Chat Completions and consumes the fixture as written.
  const chat = clientReturning(chatFixture);
  const viaChat = await chat.client.complete(turn("gemini-3.5-flash"));
  assertEquals(chat.captured[0].url, `${GATEWAY}/v1/chat/completions`);

  // gpt-* uses the Responses API and consumes the converted fixture.
  const responses = clientReturning(responsesBodyFromChatFixture(chatFixture));
  const viaResponses = await responses.client.complete(turn("gpt-5.6-terra"));
  assertEquals(responses.captured[0].url, `${GATEWAY}/v1/responses`);

  assertEquals(viaResponses.assistant, viaChat.assistant);
};

Deno.test("converted fixtures yield the same assistant text as the chat path", async () => {
  await assertPathsAgree({
    choices: [{
      index: 0,
      message: { role: "assistant", content: "No tool call needed." },
    }],
  });
});

Deno.test("converted fixtures yield the same tool calls as the chat path", async () => {
  await assertPathsAgree({
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "notes/todo.txt" }),
          },
        }],
      },
    }],
  });
});

Deno.test("converted fixtures preserve text alongside multiple tool calls", async () => {
  await assertPathsAgree({
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "Reading both files.",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"b.txt"}' },
          },
        ],
      },
    }],
  });
});

//
// Conversion details and pass-through rules.
//

Deno.test("responsesBodyFromChatFixture leaves non-chat bodies untouched", () => {
  // Model listings and error payloads flow through the same stub boundary.
  const listing = { object: "list", data: [{ id: "gpt-5.6-sol" }] };
  assertEquals(responsesBodyFromChatFixture(listing), listing);

  const error = { error: { message: "boom", type: "invalid_request_error" } };
  assertEquals(responsesBodyFromChatFixture(error), error);

  assertEquals(responsesBodyFromChatFixture(null), null);
  assertEquals(responsesBodyFromChatFixture("plain text"), "plain text");
  assertEquals(responsesBodyFromChatFixture([1, 2]), [1, 2]);
});

Deno.test("responsesBodyFromChatFixture keeps the chat shape for chat requests", () => {
  // One stub serves both APIs across turns (the web_search profile switches to
  // a Gemini model mid-run), so the request decides which shape to return.
  const fixture = {
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Searched." },
    }],
  };
  const chatRequest = JSON.stringify({
    model: "gemini-3.5-flash",
    messages: [],
  });
  assertEquals(responsesBodyFromChatFixture(fixture, chatRequest), fixture);

  const responsesRequest = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [],
  });
  const converted = responsesBodyFromChatFixture(
    fixture,
    responsesRequest,
  ) as Record<string, unknown>;
  assertEquals(converted.status, "completed");

  // An unparseable request body must not throw; it converts.
  const fallback = responsesBodyFromChatFixture(
    fixture,
    "<<not json>>",
  ) as Record<string, unknown>;
  assertEquals(fallback.status, "completed");
});

Deno.test("responsesBodyFromChatFixture emits no message item for empty content", () => {
  const converted = responsesBodyFromChatFixture({
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
    }],
  }) as { output: Array<Record<string, unknown>> };
  assertEquals(converted.output.map((item) => item.type), ["function_call"]);
  // No item id, so the client records no provider continuation for fixtures
  // that never described one.
  assertEquals(converted.output[0].id, undefined);
});

Deno.test("responsesBodyFromChatFixture carries id and usage through", () => {
  const converted = responsesBodyFromChatFixture({
    id: "chatcmpl-1",
    usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
  }) as Record<string, unknown>;
  assertEquals(converted.id, "chatcmpl-1");
  assertEquals(converted.usage, {
    input_tokens: 5,
    output_tokens: 7,
    total_tokens: 12,
  });
});

//
// Request projection.
//

Deno.test("chatViewOfRequest projects a Responses request to the chat view", () => {
  const view = chatViewOfRequest({
    model: "gpt-5.6-terra",
    instructions: "Be brief.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "Do the task." }] },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Working.", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call-1",
        name: "read_file",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "file contents",
      },
    ],
    tools: [{ type: "function", name: "read_file" }],
  });

  assertEquals(view.messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    // function_call is skipped: the chat shape carried it on the assistant
    // message, not as a standalone turn.
    "tool",
  ]);
  assertEquals(view.messages[0].content, "Be brief.");
  assertEquals(view.messages[1].content, "Do the task.");
  assertEquals(view.messages[2].content, "Working.");
  assertEquals(view.messages[3], {
    role: "tool",
    tool_call_id: "call-1",
    content: "file contents",
  });
  assertEquals(view.tools, ["read_file"]);
});

Deno.test("chatViewOfRequest reads user turns in either legal item shape", () => {
  // `{role, content}` and the fully-qualified `{type:"message", role, content}`
  // are both legal Responses input items. Keying on `type` projected the
  // qualified form as an empty string, which would have silently emptied the
  // ~50 content assertions that run through this helper.
  for (
    const item of [
      { role: "user", content: [{ type: "input_text", text: "Do the task." }] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Do the task." }],
      },
    ]
  ) {
    const view = chatViewOfRequest({ input: [item] });
    assertEquals(view.messages[0].role, "user");
    assertEquals(view.messages[0].content, "Do the task.");
  }
});

Deno.test("chatViewOfRequest joins multi-part assistant text", () => {
  const view = chatViewOfRequest({
    input: [{
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "Part one. " },
        { type: "output_text", text: "Part two." },
      ],
    }],
  });
  assertEquals(view.messages[0].content, "Part one. Part two.");
});

Deno.test("chatViewOfRequest omits the system turn when there are no instructions", () => {
  const view = chatViewOfRequest({
    input: [
      { role: "user", content: [{ type: "input_text", text: "Hi." }] },
    ],
  });
  assertEquals(view.messages.map((message) => message.role), ["user"]);
  assertEquals(view.tools, []);
});

Deno.test("chatViewOfRequest keeps multimodal turns as content parts", () => {
  const view = chatViewOfRequest({
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Describe the image." },
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/png;base64,iVBOR",
        },
      ],
    }],
  });
  const content = view.messages[0].content as unknown as Array<
    Record<string, unknown>
  >;
  assertEquals(content[0], { type: "text", text: "Describe the image." });
  assertEquals(content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBOR" },
  });
});

Deno.test("chatViewOfRequest passes chat requests through unchanged", () => {
  // Turns that stay on Chat Completions are already in this shape.
  const messages = [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Search." },
  ];
  const view = chatViewOfRequest({
    model: "gemini-3.5-flash",
    messages,
    tools: [
      { type: "function", function: { name: "read_file" } },
      { type: "google_search" },
    ],
  });
  assertEquals(view.messages, messages);
  // Native tools have no function name and are dropped from the name list.
  assertEquals(view.tools, ["read_file"]);
});

Deno.test("chatViewOfRequest tolerates malformed bodies", () => {
  assertEquals(chatViewOfRequest(null), { messages: [], tools: [] });
  assertEquals(chatViewOfRequest("nonsense"), { messages: [], tools: [] });
  assertEquals(chatViewOfRequest({}), { messages: [], tools: [] });
  assertEquals(
    chatViewOfRequest({ input: [null, 42, { role: "user", content: "raw" }] }),
    { messages: [], tools: [] },
  );
});
