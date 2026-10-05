import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  OPENAI_CODEX_MODELS_URL,
  OpenAICodexResponsesClient,
} from "../src/model/openai-codex-responses.ts";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import { createHarnessImageAttachment } from "../src/image-attachments.ts";

const credential: OpenAICodexOAuthCredential = {
  type: "oauth",
  providerId: "openai-codex",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: Date.now() + 60_000,
  accountId: "acct-123",
};

const errorGraphText = (input: unknown): string => {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = input;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
};

const sse = (...events: unknown[]): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

Deno.test("Codex Responses client rejects conflicting credential owner bindings", () => {
  const owner = {
    type: "cf-harness.credential-owner-ref" as const,
    version: 1 as const,
    ownerKey: "loom:user-a",
    tenantKey: "loom-a",
  };

  assertThrows(
    () =>
      new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: {
          ownerKey: owner.ownerKey,
          credentialOwner: owner,
          resolve: () => Promise.resolve(credential),
        },
        credentialOwner: { ...owner, tenantKey: "loom-b" },
      }),
    Error,
    "credential resolver owner does not match the client owner",
  );
  assertThrows(
    () =>
      new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: {
          ownerKey: "loom:user-b",
          credentialOwner: owner,
          resolve: () => Promise.resolve(credential),
        },
      }),
    Error,
    "credential resolver owner does not match the client owner",
  );
});

Deno.test("Codex Responses client sends the pinned owner-authenticated request", async () => {
  let request: { input: URL | RequestInfo; init?: RequestInit } | undefined;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (input, init) => {
      request = { input, init };
      return Promise.resolve(sse({
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
      }));
    },
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [
      { role: "system", content: "system" },
      { role: "user", content: "hi" },
    ],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-123",
  });

  assertEquals(result.assistant.content, "hello");
  assertEquals(
    String(request?.input),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  const headers = new Headers(request?.init?.headers);
  assertEquals(headers.get("authorization"), "Bearer access-secret");
  assertEquals(headers.get("chatgpt-account-id"), "acct-123");
  assertEquals(headers.get("originator"), "cf-harness");
  assertEquals(headers.get("session-id"), "run-123");
  assertEquals(request?.init?.redirect, "error");
  const body = JSON.parse(String(request?.init?.body));
  assertEquals(body.store, false);
  assertEquals(body.stream, true);
  assertEquals(body.instructions, "system");
  assertEquals(body.prompt_cache_key, "run-123");
});

Deno.test("Codex Responses supports stable affinity and reasoning controls", async () => {
  let body: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (_input, init) => {
      body = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          }],
        },
      }));
    },
  });

  await client.complete({
    model: "gpt-5.6-sol",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "ephemeral-run",
    cacheAffinityKey: "stable-session",
    reasoningEffort: "low",
  });

  assertEquals(headers?.get("session-id"), "stable-session");
  assertEquals(body?.prompt_cache_key, "stable-session");
  assertEquals(body?.reasoning, { effort: "low", summary: "auto" });
  assertEquals(body?.prompt_cache_options, undefined);
});

Deno.test("Codex Responses asks for a reasoning summary and carries it beside the message", async () => {
  let body: Record<string, unknown> | undefined;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted-state",
            summary: [
              { type: "summary_text", text: "**Finding the form**" },
              { type: "summary_text", text: "  " },
              { type: "summary_text", text: "The order form is linked." },
            ],
          }, {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "browser",
            arguments: '{"action":"snapshot"}',
          }],
        },
      }));
    },
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "order" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-reasoning",
  });

  assertEquals(body?.reasoning, { summary: "auto" });
  assertEquals(
    result.assistant.reasoning,
    "**Finding the form**\n\nThe order form is linked.",
  );
  assertEquals(result.assistant.content, "");
});

Deno.test("Codex Responses replays reasoning to the model without its summary", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const outputs = [[{
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "encrypted-state",
    summary: [{ type: "summary_text", text: "PRIVATE SUMMARY" }],
  }, {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "browser",
    arguments: '{"action":"snapshot"}',
  }], [{
    type: "message",
    content: [{ type: "output_text", text: "done" }],
  }]];
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(sse({
        type: "response.completed",
        response: { status: "completed", output: outputs[bodies.length - 1] },
      }));
    },
  });
  const request = {
    model: "gpt-5.4",
    tools: [],
    nativeModelToolIds: [],
    runId: "run-replay",
  };

  const first = await client.complete({
    ...request,
    transcript: [{ role: "user", content: "look" }],
  });
  await client.complete({
    ...request,
    transcript: [
      { role: "user", content: "look" },
      first.assistant,
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "browser",
        content: "{}",
      },
    ],
  });

  assertEquals(first.assistant.reasoning, "PRIVATE SUMMARY");
  const input = JSON.stringify(bodies[1].input);
  assertEquals(input.includes("encrypted-state"), true);
  assertEquals(input.includes("PRIVATE SUMMARY"), false);
});

Deno.test("Codex Responses leaves out reasoning a turn has no summary of", async () => {
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted-state",
            summary: [],
          }, {
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          }],
        },
      })),
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-no-summary",
  });

  assertEquals("reasoning" in result.assistant, false);
});

Deno.test("Codex Responses rejects API prompt cache mode controls", async () => {
  let resolvedCredential = false;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: {
      resolve: () => {
        resolvedCredential = true;
        return Promise.resolve(credential);
      },
    },
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.6-sol",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-123",
        promptCacheMode: "explicit",
      }),
    Error,
    "prompt cache mode controls are not supported by openai-codex",
  );
  assertEquals(resolvedCredential, false);
});

Deno.test("Codex Responses client bounds stable run affinity identifiers", async () => {
  const longRunId = `${"parent-run-".repeat(8)}subagent.123`;
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> =
    [];
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (_input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          }],
        },
      }));
    },
  });
  const complete = () =>
    client.complete({
      model: "gpt-5.4",
      transcript: [{ role: "user" as const, content: "hi" }],
      tools: [],
      nativeModelToolIds: [],
      runId: longRunId,
    });

  await complete();
  await complete();

  const affinityKeys = requests.map((request) =>
    String(request.body.prompt_cache_key)
  );
  assertEquals(affinityKeys[0].length <= 64, true);
  assertEquals(affinityKeys[0], affinityKeys[1]);
  assertEquals(affinityKeys[0].startsWith("parent-run-"), true);
  assertEquals(
    requests.map((request) => request.headers.get("session-id")),
    affinityKeys,
  );
  const requestIds = requests.map((request) =>
    request.headers.get("x-client-request-id")
  );
  assertEquals(
    requestIds.every((requestId) =>
      requestId !== null &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(requestId)
    ),
    true,
  );
  assertEquals(requestIds[0] === requestIds[1], false);
});

Deno.test("Codex Responses client recovers streamed output items when store:false empties the terminal output", async () => {
  // The ChatGPT Codex backend streams each completed item via
  // `response.output_item.done` but, with `store: false`, returns an EMPTY
  // `output` array on `response.completed`. The client must fall back to the
  // streamed items or it silently drops the model's message and tool calls
  // (observed live: agents did nothing, 0 tool calls, empty final text).
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(sse(
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "on it" }],
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "bash",
            arguments: '{"command":"uname -a"}',
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_stream", status: "completed", output: [] },
        },
      )),
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "explore" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-stream",
  });

  assertEquals(result.assistant.content, "on it");
  assertEquals(result.assistant.toolCalls?.[0]?.id, "call_1");
  assertEquals(result.assistant.toolCalls?.[0]?.function.name, "bash");
});

Deno.test("Codex Responses client recovers streamed output items when the terminal output is null", async () => {
  // The same backend has also been observed returning `output: null` (not just
  // an empty array) with valid streamed items. Treat null like empty.
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(sse(
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "bash",
            arguments: '{"command":"whoami"}',
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_null", status: "completed", output: null },
        },
      )),
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "who" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-null",
  });

  assertEquals(result.assistant.toolCalls?.[0]?.function.name, "bash");
});

Deno.test("Codex Responses client normalizes tool calls and preserves encrypted continuation", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(sse({
        type: "response.completed",
        response: {
          id: "resp_tools",
          status: "completed",
          output: [{
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted-state",
            summary: [],
          }, {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          }],
        },
      }));
    },
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "read" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-tools",
  });

  assertEquals(result.assistant.toolCalls?.[0]?.id, "call_1");
  assertEquals(result.assistant.toolCalls?.[0]?.function.name, "read_file");
  assertEquals(
    result.assistant.providerContinuation?.providerId,
    "openai-codex",
  );
  assertEquals(
    result.assistant.providerContinuation?.state,
    {
      version: 1,
      sourceModel: "gpt-5.4",
      output: [{
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "encrypted-state",
        summary: [],
      }],
      functionCallItemIds: { call_1: "fc_1" },
    },
  );
  assertEquals(
    (result.assistant.providerContinuation?.state as { output: unknown[] })
      .output[0],
    {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "encrypted-state",
      summary: [],
    },
  );
  await client.complete({
    model: "gpt-5.4",
    transcript: [
      { role: "user", content: "read" },
      result.assistant,
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "file contents",
      },
    ],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-tools",
  });
  const replayInput = requestBodies[1].input as Array<Record<string, unknown>>;
  assertEquals(
    replayInput.find((item) => item.type === "function_call")?.id,
    "fc_1",
  );
});

Deno.test("Codex Responses client rejects cross-model continuation before resolving credentials", async () => {
  let credentialResolutions = 0;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: {
      resolve: () => {
        credentialResolutions += 1;
        return Promise.resolve(credential);
      },
    },
    fetchFn: () => Promise.reject(new Error("provider must not be called")),
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.5",
        transcript: [{
          role: "assistant",
          content: "",
          providerContinuation: {
            providerId: "openai-codex",
            state: {
              version: 1,
              sourceModel: "gpt-5.4",
              output: [{
                type: "reasoning",
                id: "rs_model_bound",
                encrypted_content: "encrypted-state",
              }],
            },
          },
        }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-cross-model-continuation",
      }),
    Error,
    "continuation model gpt-5.4 does not match requested model gpt-5.5",
  );
  assertEquals(credentialResolutions, 0);
});

Deno.test("Codex Responses client surfaces refusal-only output", async () => {
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "message",
            content: [{
              type: "refusal",
              refusal: "I cannot help with that request.",
            }],
          }],
        },
      })),
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-refusal",
  });

  assertEquals(result.assistant.content, "I cannot help with that request.");
});

Deno.test("Codex Responses client rejects streams without a terminal event", async () => {
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(
        sse({ type: "response.output_text.delta", delta: "partial" }),
      ),
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-eof",
      }),
    Error,
    "ended without a terminal response event",
  );
});

Deno.test("Codex Responses client rejects malformed SSE JSON", async () => {
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(
        new Response("data: {not-json}\n\n", { status: 200 }),
      ),
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-malformed",
      }),
    Error,
    "malformed JSON",
  );
});

Deno.test("Codex Responses client keeps multiple tool calls and failure outputs ordered", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestCount = 0;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      requestCount += 1;
      return Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: requestCount === 1
            ? [{
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "read_file",
              arguments: '{"path":"one"}',
            }, {
              type: "function_call",
              id: "fc-2",
              call_id: "call-2",
              name: "read_file",
              arguments: '{"path":"two"}',
            }]
            : [{
              type: "message",
              content: [{ type: "output_text", text: "handled" }],
            }],
        },
      }));
    },
  });

  const first = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "read both" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-multiple",
  });
  assertEquals(first.assistant.toolCalls?.map((call) => call.id), [
    "call-1",
    "call-2",
  ]);

  await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "read both" }, first.assistant, {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_file",
      content: '{"error":"not found"}',
    }, {
      role: "tool",
      toolCallId: "call-2",
      toolName: "read_file",
      content: "second contents",
    }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-multiple",
  });

  const replay = requestBodies[1].input as Array<Record<string, unknown>>;
  assertEquals(
    replay.filter((item) => item.type === "function_call_output").map((
      item,
    ) => [item.call_id, item.output]),
    [
      ["call-1", '{"error":"not found"}'],
      ["call-2", "second contents"],
    ],
  );
});

Deno.test("Codex Responses client maps bounded image attachments", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const imagePath = `${directory}/tiny.png`;
    await Deno.writeFile(
      imagePath,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const attachment = await createHarnessImageAttachment({
      workspaceHostPath: directory,
      cwd: directory,
      path: imagePath,
    });
    let requestBody: Record<string, unknown> | undefined;
    const client = new OpenAICodexResponsesClient({
      transportRetries: 0,
      credentialResolver: { resolve: () => Promise.resolve(credential) },
      fetchFn: (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Promise.resolve(sse({
          type: "response.completed",
          response: { status: "completed", output: [] },
        }));
      },
    });

    await client.complete({
      model: "gpt-5.4",
      transcript: [{
        role: "user",
        content: "inspect",
        imageAttachments: [attachment],
      }],
      tools: [],
      nativeModelToolIds: [],
      runId: "run-image",
    });

    const input = requestBody?.input as Array<Record<string, unknown>>;
    const content = input[0].content as Array<Record<string, unknown>>;
    assertStringIncludes(
      String(content[1].image_url),
      "data:image/png;base64,",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Codex Responses client rejects incomplete tool calls", async () => {
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "function_call",
            call_id: "call-1",
            name: "read_file",
          }],
        },
      })),
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-incomplete-call",
      }),
    HarnessControlError,
    "invalid terminal response",
  );
});

Deno.test("Codex Responses client parses CRLF SSE split across byte boundaries", async () => {
  const payload = JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_split",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "split works" }],
      }],
    },
  });
  const chunks = [`data: ${payload}\r`, "\n\r", "\n"];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
  });
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () => Promise.resolve(new Response(body, { status: 200 })),
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-split",
  });

  assertEquals(result.assistant.content, "split works");
  assertEquals(result.usage, {
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
    estimateWithheldReason: "provider-pricing-unavailable",
  });
});

Deno.test("Codex Responses client rejects conflicting duplicate tool-call ids", async () => {
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(sse({
        type: "response.completed",
        response: {
          status: "completed",
          output: [{
            type: "function_call",
            call_id: "call-1",
            name: "read_file",
            arguments: "{}",
          }, {
            type: "function_call",
            call_id: "call-1",
            name: "write_file",
            arguments: "{}",
          }],
        },
      })),
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-duplicate",
      }),
    HarnessControlError,
    "invalid terminal response",
  );
});

Deno.test("Codex model discovery is live, owner-authenticated, and ordered", async () => {
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  let requestedRedirect: RequestRedirect | undefined;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      requestedRedirect = init?.redirect;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [{
              slug: "model-b",
              display_name: "Model B",
              description: "first",
              input_modalities: ["text", "image"],
              supported_reasoning_levels: [{ effort: "high" }],
              supports_parallel_tool_calls: true,
            }, {
              slug: "model-a",
              display_name: "Model A",
              input_modalities: ["text"],
              supported_reasoning_levels: [],
              supports_parallel_tool_calls: false,
            }],
          }),
          { status: 200 },
        ),
      );
    },
  });

  const models = await client.listModels();

  assertEquals(
    new URL(requestedUrl).origin + new URL(requestedUrl).pathname,
    OPENAI_CODEX_MODELS_URL,
  );
  assertEquals(
    new URL(requestedUrl).searchParams.get("client_version"),
    "0.0.0",
  );
  assertEquals(requestedHeaders.get("authorization"), "Bearer access-secret");
  assertEquals(requestedHeaders.get("chatgpt-account-id"), "acct-123");
  assertEquals(requestedRedirect, "error");
  assertEquals(models.map((model) => model.id), ["model-b", "model-a"]);
  assertEquals(models[0].inputModalities, ["text", "image"]);
  assertEquals(models[0].supportedReasoningEfforts, ["high"]);
});

Deno.test("Codex model discovery classifies provider failures", async () => {
  for (
    const [fetchFn, expectedCode] of [
      [
        () => Promise.resolve(new Response("unauthorized", { status: 401 })),
        "provider-auth-required",
      ],
      [
        () => Promise.resolve(new Response("unavailable", { status: 503 })),
        "provider-unavailable",
      ],
      [
        () => Promise.reject(new Error("network detail")),
        "provider-unavailable",
      ],
    ] as const
  ) {
    const client = new OpenAICodexResponsesClient({
      transportRetries: 0,
      credentialResolver: { resolve: () => Promise.resolve(credential) },
      fetchFn,
    });

    const error = await assertRejects(() => client.listModels());
    assertEquals(error instanceof HarnessControlError, true);
    assertEquals((error as HarnessControlError).code, expectedCode);
  }
});

Deno.test("Codex Responses quota errors are concise and do not retain response bodies", async () => {
  const attempts: unknown[] = [];
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { message: "access-secret account acct-123" },
          }),
          {
            status: 429,
            headers: { "retry-after": "retry-secret-sentinel" },
          },
        ),
      ),
  });

  const error = await assertRejects(() =>
    client.complete({
      model: "gpt-5.4",
      transcript: [{ role: "user", content: "hi" }],
      tools: [],
      nativeModelToolIds: [],
      runId: "run-quota",
      onAttempt: (attempt) => {
        attempts.push(attempt);
      },
    })
  );

  assertEquals((error as Error).message, "OpenAI Codex usage limit reached");
  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  const serialized = JSON.stringify(attempts);
  assertEquals(serialized.includes("access-secret"), false);
  assertEquals(serialized.includes("acct-123"), false);
  assertEquals(serialized.includes("retry-secret-sentinel"), false);
  assertStringIncludes(serialized, '"httpStatus":429');
});

Deno.test("Codex Responses classifies provider HTTP failures", async () => {
  for (
    const [status, expectedCode] of [
      [401, "provider-auth-required"],
      [503, "provider-unavailable"],
    ] as const
  ) {
    const client = new OpenAICodexResponsesClient({
      transportRetries: 0,
      credentialResolver: { resolve: () => Promise.resolve(credential) },
      fetchFn: () => Promise.resolve(new Response("unavailable", { status })),
    });

    const error = await assertRejects(() =>
      client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-provider-unavailable",
      })
    );
    assertEquals(error instanceof HarnessControlError, true);
    assertEquals((error as HarnessControlError).code, expectedCode);
  }
});

Deno.test("Codex transport errors redact credential and account values", async () => {
  const attempts: unknown[] = [];
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.reject(
        new Error(
          "failed with access-secret refresh-secret for acct-123",
        ),
      ),
  });

  const error = await assertRejects(() =>
    client.complete({
      model: "gpt-5.4",
      transcript: [{ role: "user", content: "hi" }],
      tools: [],
      nativeModelToolIds: [],
      runId: "run-redaction",
      onAttempt: (attempt) => {
        attempts.push(attempt);
      },
    })
  );

  const serialized = `${errorGraphText(error)}${JSON.stringify(attempts)}`;
  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  assertEquals(serialized.includes("access-secret"), false);
  assertEquals(serialized.includes("refresh-secret"), false);
  assertEquals(serialized.includes("acct-123"), false);
  assertStringIncludes(serialized, "[redacted]");
});

Deno.test("Codex Responses bounds failures while reading provider error bodies", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("provider-body-secret-sentinel"));
    },
  });
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () => Promise.resolve(new Response(body, { status: 503 })),
  });

  const error = await assertRejects(() =>
    client.complete({
      model: "gpt-5.4",
      transcript: [{ role: "user", content: "hi" }],
      tools: [],
      nativeModelToolIds: [],
      runId: "run-error-body",
    })
  );
  assertEquals(error instanceof HarnessControlError, true);
  assertEquals((error as HarnessControlError).code, "provider-unavailable");
  assertEquals(errorGraphText(error).includes("secret-sentinel"), false);
});

Deno.test("Codex Responses preserves abort during provider error diagnostics", async () => {
  const controller = new AbortController();
  const reason = new Error("abort during provider diagnostics");
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(new Response("unavailable", { status: 503 })),
  });

  const error = await assertRejects(() =>
    client.complete({
      model: "gpt-5.4",
      transcript: [{ role: "user", content: "hi" }],
      tools: [],
      nativeModelToolIds: [],
      runId: "run-abort-error-diagnostics",
      signal: controller.signal,
      onAttempt: () => {
        controller.abort(reason);
      },
    })
  );
  assertStrictEquals(error, reason);
});

Deno.test("Codex Responses abort cancels an active stream without retry", async () => {
  let canceled = false;
  let requests = 0;
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: {
      resolve: (signal) => {
        assertEquals(signal, controller.signal);
        return Promise.resolve(credential);
      },
    },
    fetchFn: () => {
      requests += 1;
      markRequested();
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  });
  const controller = new AbortController();
  const completion = client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-abort",
    signal: controller.signal,
  });
  await requested;
  controller.abort(new DOMException("cancel test", "AbortError"));

  await assertRejects(() => completion, DOMException, "cancel test");
  assertEquals(canceled, true);
  assertEquals(requests, 1);
});

Deno.test("Codex Responses preserves non-DOM abort reasons when stream cancellation rejects", async () => {
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      return Promise.reject(new Error("stream cancel failed"));
    },
  });
  const controller = new AbortController();
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () => {
      markRequested();
      return Promise.resolve(new Response(body, { status: 200 }));
    },
  });
  const completion = client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-rejecting-cancel",
    signal: controller.signal,
  });
  await requested;
  const reason = new Error("custom stream abort");
  controller.abort(reason);

  const error = await assertRejects(() => completion);
  assertStrictEquals(error, reason);
});

Deno.test("Codex Responses preserves abort after credential resolution", async () => {
  const controller = new AbortController();
  let releaseCredential!: () => void;
  const heldCredential = new Promise<void>((resolve) => {
    releaseCredential = resolve;
  });
  let markResolving!: () => void;
  const resolving = new Promise<void>((resolve) => {
    markResolving = resolve;
  });
  let requests = 0;
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: {
      resolve: async () => {
        markResolving();
        await heldCredential;
        return credential;
      },
    },
    fetchFn: () => {
      requests += 1;
      return Promise.reject(new Error("must not fetch"));
    },
  });
  const completion = client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-abort-after-credential",
    signal: controller.signal,
  });
  await resolving;
  const reason = new Error("abort after credential resolution");
  controller.abort(reason);
  releaseCredential();

  const error = await assertRejects(() => completion);
  assertStrictEquals(error, reason);
  assertEquals(requests, 0);
});

Deno.test("Codex Responses returns on the first terminal event and cancels a keep-alive stream", async () => {
  let canceled = false;
  const payload = JSON.stringify({
    type: "response.completed",
    response: {
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "done before EOF" }],
      }],
    },
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
    },
    cancel() {
      canceled = true;
    },
  });
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () => Promise.resolve(new Response(body, { status: 200 })),
  });

  const result = await client.complete({
    model: "gpt-5.4",
    transcript: [{ role: "user", content: "hi" }],
    tools: [],
    nativeModelToolIds: [],
    runId: "run-terminal-keep-alive",
  });

  assertEquals(result.assistant.content, "done before EOF");
  assertEquals(canceled, true);
});

Deno.test("Codex Responses recognizes response.failed as terminal", async () => {
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () =>
      Promise.resolve(sse({
        type: "response.failed",
        response: { status: "failed", output: [] },
      })),
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-response-failed",
      }),
    HarnessControlError,
    "Codex Responses ended with status failed",
  );
});

Deno.test("Codex Responses cancels the stream after malformed SSE", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {not-json}\n\n"));
    },
    cancel() {
      canceled = true;
    },
  });
  const client = new OpenAICodexResponsesClient({
    transportRetries: 0,
    credentialResolver: { resolve: () => Promise.resolve(credential) },
    fetchFn: () => Promise.resolve(new Response(body, { status: 200 })),
  });

  await assertRejects(
    () =>
      client.complete({
        model: "gpt-5.4",
        transcript: [{ role: "user", content: "hi" }],
        tools: [],
        nativeModelToolIds: [],
        runId: "run-malformed-sse",
      }),
    Error,
    "malformed JSON",
  );
  assertEquals(canceled, true);
});
