import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { fromFileUrl } from "@std/path";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  type ConversationFixture,
  type ConversationFixtureAssertions,
  disableMockMode,
  enableMockMode,
  failureHint,
  initialLLMUrl,
  LLMClient,
  LLMStreamError,
  loadConversationFixture,
  loadConversationFixtureFile,
  normalizeLLMResponse,
  parseLLMReply,
  readLLMResponse,
  readLLMStream,
  resetMockMode,
  setLLMUrl,
  setMockResponseGate,
} from "./client.ts";
import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  type LLMGenerateObjectRequest,
  type LLMRequest,
  type LLMResponse,
} from "./types.ts";

const GUARD_MESSAGE =
  "LLMClient: live LLM calls are blocked in test environments.";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function runClientStream(chunks: string[]) {
  return readLLMStream(streamFromChunks(chunks), "trace-1", () => {});
}

describe("LLMClient test-environment guard", () => {
  const client = new LLMClient();

  it("sendRequest throws guard error without mock mode", async () => {
    // Ensure mock mode is off
    disableMockMode();

    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      }),
    ).rejects.toThrow(GUARD_MESSAGE);
  });

  it("generateObject throws guard error without mock mode", async () => {
    disableMockMode();

    await expect(
      client.generateObject({
        messages: [{ role: "user", content: "hello" }],
        schema: { type: "object", properties: { name: { type: "string" } } },
      }),
    ).rejects.toThrow(GUARD_MESSAGE);
  });

  it("sendRequest throws guard error for a client handed the global fetch", async () => {
    disableMockMode();

    await expect(
      new LLMClient(globalThis.fetch).sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      }),
    ).rejects.toThrow(GUARD_MESSAGE);
  });

  it("sendRequest with mock mode bypasses guard", async () => {
    enableMockMode();
    addMockResponse(
      () => true,
      { role: "assistant", content: "mocked!", id: "mock-1" },
    );

    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      stream: false,
    });

    expect(result.content).toBe("mocked!");
    resetMockMode();
  });

  it("normalizes JSON responses without dropping native model tool metadata", () => {
    const nativeModelToolResults = [{
      type: "cf-harness.native-model-tool-result" as const,
      toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      provider: "google",
      providerMetadata: { query: "example" },
      sources: [{ url: "https://example.com" }],
    }];

    const result = normalizeLLMResponse({
      role: "assistant",
      content: "searched",
      nativeModelToolResults,
    }, "trace-json");

    expect(result).toEqual({
      role: "assistant",
      content: "searched",
      id: "trace-json",
      nativeModelToolResults,
    });
  });

  it("generateObject with mock mode bypasses guard", async () => {
    enableMockMode();
    addMockObjectResponse(
      () => true,
      { object: { name: "Alice" } },
    );

    const result = await client.generateObject({
      messages: [{ role: "user", content: "hello" }],
      schema: { type: "object", properties: { name: { type: "string" } } },
    });

    expect(result.object).toEqual({ name: "Alice" });
    resetMockMode();
  });

  it("generateObject rejects a JSON-unsafe schema before anything is sent", async () => {
    // The check runs ahead of the mock path, so a schema carrying a value that
    // could not survive JSON transport is refused even here -- the request is
    // malformed for its purpose regardless of where it would have gone.
    enableMockMode();
    addMockObjectResponse(() => true, { object: { name: "Alice" } });

    await expect(
      client.generateObject({
        messages: [{ role: "user", content: "hello" }],
        schema: {
          type: "object",
          properties: { threshold: { type: "number", default: NaN } },
        },
      }),
    ).rejects.toThrow("/properties/threshold/default");

    resetMockMode();
  });

  it("sendRequest rejects a JSON-unsafe tool input schema, naming the tool", async () => {
    // A tool's input schema rides the same JSON-serialized request, so it faces
    // the same hazard and is checked ahead of the mock path too.
    enableMockMode();
    addMockResponse(() => true, {
      role: "assistant",
      content: "ok",
      id: "mock-tool",
    });

    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
        tools: {
          search: {
            description: "search",
            inputSchema: {
              type: "object",
              properties: { limit: { type: "number", default: Infinity } },
            },
          },
        },
      }),
    ).rejects.toThrow('tool "search"');

    resetMockMode();
  });

  it("mock mode without matching response throws descriptive error", async () => {
    enableMockMode();
    clearMockResponses();

    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      }),
    ).rejects.toThrow("no matching mock response found for sendRequest");

    resetMockMode();
  });

  it("generateObject mock mode without matching response throws descriptive error", async () => {
    enableMockMode();
    clearMockResponses();

    await expect(
      client.generateObject({
        messages: [{ role: "user", content: "hello" }],
        schema: { type: "object" },
      }),
    ).rejects.toThrow(
      "no matching mock response found for generateObject request",
    );

    resetMockMode();
  });

  it("mock responses are consumed (one-time use)", async () => {
    enableMockMode();
    addMockResponse(
      () => true,
      { role: "assistant", content: "first", id: "mock-1" },
    );

    const result1 = await client.sendRequest({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      stream: false,
    });
    expect(result1.content).toBe("first");

    // Second call should fail - mock was consumed
    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
        stream: false,
      }),
    ).rejects.toThrow("no matching mock response found");

    resetMockMode();
  });

  it("conversation fixture queues sequential responses", async () => {
    resetMockMode();

    const fixture: ConversationFixture = {
      description: "test fixture",
      responses: [
        {
          type: "sendRequest",
          response: { role: "assistant", content: "first", id: "fix-1" },
        },
        {
          type: "sendRequest",
          response: { role: "assistant", content: "second", id: "fix-2" },
        },
        {
          type: "generateObject",
          response: { object: { name: "Alice" }, id: "fix-3" },
        },
      ],
    };

    loadConversationFixture(fixture);

    const r1 = await client.sendRequest({
      messages: [{ role: "user", content: "one" }],
      model: "test",
      stream: false,
    });
    expect(r1.content).toBe("first");

    const r2 = await client.sendRequest({
      messages: [{ role: "user", content: "two" }],
      model: "test",
      stream: false,
    });
    expect(r2.content).toBe("second");

    const r3 = await client.generateObject({
      messages: [{ role: "user", content: "three" }],
      schema: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(r3.object).toEqual({ name: "Alice" });

    resetMockMode();
  });

  it("conversation fixture assertions pass on correct request", async () => {
    resetMockMode();

    loadConversationFixture({
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            messageCount: 1,
            messagesContain: ["hello"],
            lastMessageContains: "hello",
          },
          response: { role: "assistant", content: "ok", id: "assert-1" },
        },
      ],
    });

    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hello world" }],
      model: "test",
      stream: false,
    });
    expect(result.content).toBe("ok");

    resetMockMode();
  });

  it("conversation fixture assertions throw on mismatch with description", async () => {
    resetMockMode();

    loadConversationFixture({
      description: "my test conversation",
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            messagesContain: ["expected-keyword"],
          },
          response: { role: "assistant", content: "ok", id: "assert-2" },
        },
      ],
    });

    await expect(
      client.sendRequest({
        messages: [{ role: "user", content: "something else" }],
        model: "test",
        stream: false,
      }),
    ).rejects.toThrow(
      'Fixture "my test conversation" entry 0: expected some message to contain "expected-keyword"',
    );

    resetMockMode();
  });

  it("conversation fixture hasTools assertion works", async () => {
    resetMockMode();

    loadConversationFixture({
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            hasTools: ["search", "calculate"],
          },
          response: { role: "assistant", content: "ok", id: "tools-1" },
        },
      ],
    });

    // Should pass with matching tools
    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hi" }],
      model: "test",
      stream: false,
      tools: {
        search: {
          description: "Search",
          inputSchema: { type: "object" },
        },
        calculate: {
          description: "Calculate",
          inputSchema: { type: "object" },
        },
      },
    });
    expect(result.content).toBe("ok");

    resetMockMode();
  });

  it("conversation fixture systemContains assertion works", async () => {
    resetMockMode();

    loadConversationFixture({
      responses: [
        {
          type: "sendRequest",
          expectRequest: {
            systemContains: "helpful assistant",
          },
          response: { role: "assistant", content: "ok", id: "sys-1" },
        },
      ],
    });

    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hi" }],
      model: "test",
      system: "You are a helpful assistant.",
      stream: false,
    });
    expect(result.content).toBe("ok");

    resetMockMode();
  });

  it("sendRequest takes a stream request without a callback", async () => {
    enableMockMode();
    addMockResponse(
      () => true,
      { role: "assistant", content: "whole", id: "mock-whole" },
    );

    const result = await client.sendRequest({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      stream: true,
    });

    expect(result.content).toBe("whole");
    resetMockMode();
  });

  it("sendRequest rejects a callback on a request that is not a stream", async () => {
    disableMockMode();

    await expect(
      client.sendRequest(
        {
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          stream: false,
        },
        () => {},
      ),
    ).rejects.toThrow("not configured as a stream");
  });

  it("throws LLMStreamError for streamed error events mid-stream", async () => {
    for (
      const chunks of [
        [
          JSON.stringify({ type: "text-delta", textDelta: "hello" }) + "\n",
          JSON.stringify({ type: "error", error: "boom" }) + "\n",
        ],
        [
          JSON.stringify({ type: "text-delta", textDelta: "hello" }) + "\n",
          JSON.stringify({ type: "error", error: "boom" }),
        ],
      ]
    ) {
      try {
        await runClientStream(chunks);
      } catch (error) {
        expect(error).toBeInstanceOf(LLMStreamError);
        expect((error as Error).message).toBe("boom");
        continue;
      }

      throw new Error("Expected LLMStreamError");
    }
  });

  it("preserves native model tool metadata from stream finish events", async () => {
    const nativeModelToolResults = [{
      type: "cf-harness.native-model-tool-result" as const,
      toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      provider: "google",
      providerMetadata: { query: "example" },
      sources: [{ url: "https://example.com" }],
    }];

    const result = await runClientStream([
      JSON.stringify({ type: "text-delta", textDelta: "searched" }) + "\n",
      JSON.stringify({
        type: "finish",
        nativeModelToolResults,
      }) + "\n",
    ]);

    expect(result).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "searched" }],
      id: "trace-1",
      nativeModelToolResults,
    });
  });

  it("reports the text so far to the callback after each text event", async () => {
    const seen: string[] = [];

    await readLLMStream(
      streamFromChunks([
        JSON.stringify({ type: "text-delta", textDelta: "hel" }) + "\n",
        JSON.stringify({ type: "text-delta", textDelta: "lo" }) + "\n",
        JSON.stringify({ type: "finish" }) + "\n",
      ]),
      "trace-1",
      (text) => seen.push(text),
    );

    expect(seen).toEqual(["hel", "hello"]);
  });

  it("logs and ignores garbage lines mid-stream", async () => {
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    try {
      const result = await runClientStream([
        JSON.stringify("hello") + "\n",
        "not json\n",
        "not final json",
      ]);

      expect(result).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        id: "trace-1",
      });
      expect(loggedErrors.length).toBe(2);
      expect(loggedErrors[0][0]).toBe("Failed to parse JSON line:");
      expect(loggedErrors[0][1]).toBe("not json");
      expect(loggedErrors[1][0]).toBe("Failed to parse final JSON line:");
      expect(loggedErrors[1][1]).toBe("not final json");
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("parseLLMReply()", () => {
  const nativeModelToolResults = [{
    type: "cf-harness.native-model-tool-result" as const,
    toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
    provider: "google",
    providerMetadata: { query: "example" },
    sources: [{ url: "https://example.com" }],
  }];
  const transcript = [
    JSON.stringify({ type: "text-delta", textDelta: "hel" }) + "\n",
    JSON.stringify({ type: "text-delta", textDelta: "lo" }) + "\n",
    JSON.stringify({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      args: { topic: "donuts" },
    }) + "\n",
    JSON.stringify({ type: "finish", nativeModelToolResults }) + "\n",
  ];
  const reply = {
    role: "assistant",
    content: [
      { type: "text", text: "hello" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: { topic: "donuts" },
      },
    ],
    id: "trace-1",
    nativeModelToolResults,
  };

  it("returns the reply the events describe", () => {
    expect(parseLLMReply(transcript.join(""), "trace-1")).toEqual(reply);
  });

  it("returns what `readLLMStream()` returns for the same body, however the body is split", async () => {
    const text = transcript.join("");
    const splits = [
      transcript,
      [text.slice(0, 7), text.slice(7, 40), text.slice(40)],
      [text],
    ];
    for (const pieces of splits) {
      expect(await readLLMStream(streamFromChunks(pieces), "trace-1")).toEqual(
        reply,
      );
    }
  });

  it("takes a final text event that ends without a newline", () => {
    const body = JSON.stringify({ type: "text-delta", textDelta: "tail" });

    expect(parseLLMReply(body, "trace-1").content).toEqual([
      { type: "text", text: "tail" },
    ]);
  });

  it("throws `LLMStreamError` for an error event, with or without a trailing newline", () => {
    const event = JSON.stringify({ type: "error", error: "boom" });
    for (const body of [event + "\n", event]) {
      expect(() => parseLLMReply(body, "trace-1")).toThrow(LLMStreamError);
    }
  });
});

describe("readLLMResponse()", () => {
  const transcript = [
    JSON.stringify({ type: "text-delta", textDelta: "hel" }) + "\n",
    JSON.stringify({ type: "text-delta", textDelta: "lo" }) + "\n",
    JSON.stringify({ type: "finish" }) + "\n",
  ];
  const reply = {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    id: "trace-9",
  };

  /**
   * A response that counts reads of its `body` getter, which is what creates
   * the body's `ReadableStream` in WebKit.
   */
  function responseCountingBodyReads(
    body: BodyInit | null,
    contentType: string,
  ): { response: Response; bodyReads: () => number } {
    let bodyReads = 0;
    const response = new (class extends Response {
      override get body(): Response["body"] {
        bodyReads++;
        return super.body;
      }
    })(body, {
      headers: { "content-type": contentType, "x-cf-llm-trace-id": "trace-9" },
    });
    return { response, bodyReads: () => bodyReads };
  }

  it("reads a streamed reply whole, never reading `response.body`, when no callback is given", async () => {
    const { response, bodyReads } = responseCountingBodyReads(
      streamFromChunks(transcript),
      "text/event-stream",
    );

    expect(await readLLMResponse(response)).toEqual(reply);
    expect(bodyReads()).toBe(0);
  });

  it("reads a streamed reply through `response.body`, reporting the text so far, when a callback is given", async () => {
    const { response, bodyReads } = responseCountingBodyReads(
      streamFromChunks(transcript),
      "text/event-stream",
    );
    const seen: string[] = [];

    expect(await readLLMResponse(response, (text) => seen.push(text))).toEqual(
      reply,
    );
    expect(seen).toEqual(["hel", "hello"]);
    expect(bodyReads()).toBeGreaterThan(0);
  });

  it("throws for a successful response with no body, with or without a callback", async () => {
    for (const callback of [undefined, () => {}]) {
      const { response } = responseCountingBodyReads(null, "text/event-stream");

      await expect(readLLMResponse(response, callback)).rejects.toThrow(
        "No response body",
      );
    }
  });

  it("reads a JSON reply whole, with or without a callback", async () => {
    for (const callback of [undefined, () => {}]) {
      const { response, bodyReads } = responseCountingBodyReads(
        JSON.stringify({ role: "assistant", content: "cached", id: "srv-1" }),
        "application/json",
      );

      expect(await readLLMResponse(response, callback)).toEqual({
        role: "assistant",
        content: "cached",
        id: "srv-1",
      });
      expect(bodyReads()).toBe(0);
    }
  });
});

describe("mock response gate", () => {
  it("holds a matched response until the gate resolves", async () => {
    enableMockMode();
    try {
      addMockResponse(
        (req) =>
          req.messages.some((m) =>
            typeof m.content === "string" && m.content.includes("gated")
          ),
        { role: "assistant", content: "answered", id: "gated-1" },
      );

      const { promise, resolve } = Promise.withResolvers<void>();
      setMockResponseGate(() => promise);

      const client = new LLMClient();
      let answered = false;
      const request = client.sendRequest({
        model: "test-model",
        messages: [{ role: "user", content: "gated" }],
      }).then((response) => {
        answered = true;
        return response;
      });

      // Drain a macrotask, which is what an ungated mock needs to answer: it
      // finishes with a zero-delay `setTimeout`. So reaching here with the
      // request still outstanding is the gate holding it, not the assertion
      // running too early.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(answered).toBe(false);

      resolve();
      expect((await request).content).toBe("answered");
    } finally {
      resetMockMode();
    }
  });

  it("holds a matched generateObject response too", async () => {
    // generateObject has its own copy of the gate, on its own mock branch. A
    // test that only gated sendRequest would leave it unexercised.
    enableMockMode();
    try {
      addMockObjectResponse(() => true, { object: { name: "Alice" } });

      const { promise, resolve } = Promise.withResolvers<void>();
      setMockResponseGate(() => promise);

      const client = new LLMClient();
      let answered = false;
      const request = client.generateObject({
        messages: [{ role: "user", content: "gated" }],
        schema: { type: "object", properties: { name: { type: "string" } } },
      }).then((response) => {
        answered = true;
        return response;
      });

      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(answered).toBe(false);

      resolve();
      expect((await request).object).toEqual({ name: "Alice" });
    } finally {
      resetMockMode();
    }
  });

  it("is cleared by clearMockResponses and resetMockMode", async () => {
    enableMockMode();
    try {
      setMockResponseGate(() => Promise.reject(new Error("gate still armed")));
      clearMockResponses();

      addMockResponse(() => true, {
        role: "assistant",
        content: "ungated",
        id: "gated-2",
      });
      const client = new LLMClient();
      const response = await client.sendRequest({
        model: "test-model",
        messages: [{ role: "user", content: "anything" }],
      });
      expect(response.content).toBe("ungated");
    } finally {
      resetMockMode();
    }
  });
});

describe("failureHint", () => {
  const PARAMETERS = "messages, prompt, model, etc.";

  //
  // The failure hint
  //
  // The hint is the first thing a developer reads in the console when a request
  // fails, and for most of a working day the failure is not theirs. Each status
  // class has to send them to the right place.
  //

  it("sends a rate-limited caller away to wait rather than to their arguments", () => {
    for (const status of [429, 503]) {
      const hint = failureHint(status, PARAMETERS);
      expect(hint).toContain("again later");
      expect(hint).not.toContain(PARAMETERS);
    }
  });

  it("tells a caller a server failure was not their doing", () => {
    for (const status of [500, 502, 504]) {
      const hint = failureHint(status, PARAMETERS);
      expect(hint).toContain("was not the problem");
      expect(hint).not.toContain(PARAMETERS);
    }
  });

  it("names the arguments to check when the request was rejected", () => {
    for (const status of [400, 422]) {
      expect(failureHint(status, PARAMETERS)).toContain(PARAMETERS);
    }
  });

  it("claims nothing about a status it does not recognize", () => {
    for (const status of [401, 403, 404, 418]) {
      const hint = failureHint(status, PARAMETERS);
      expect(hint).not.toContain(PARAMETERS);
      expect(hint).not.toContain("again later");
      expect(hint).not.toContain("was not the problem");
    }
  });
});

describe("conversation fixture assertions", () => {
  const client = new LLMClient();

  /** Loads a fixture whose one entry expects `expectRequest` of a request. */
  function expectOne(
    expectRequest: ConversationFixtureAssertions,
    type: "sendRequest" | "generateObject" = "sendRequest",
  ): void {
    resetMockMode();
    loadConversationFixture({
      responses: [
        type === "sendRequest"
          ? {
            type,
            expectRequest,
            response: { role: "assistant", content: "ok", id: "fixture-1" },
          }
          : { type, expectRequest, response: { object: { name: "Alice" } } },
      ],
    });
  }

  const request = (
    content: LLMRequest["messages"][number]["content"],
  ): LLMRequest => ({
    messages: [{ role: "user", content }],
    model: "test",
    system: "You are terse.",
    stream: false,
  });

  it("throws naming the expected and actual message counts", async () => {
    expectOne({ messageCount: 2 });

    await expect(client.sendRequest(request("hi"))).rejects.toThrow(
      "Fixture entry 0: expected 2 messages, got 1",
    );
    resetMockMode();
  });

  it("matches `messagesContain` against the text parts of array content", async () => {
    const parts = [
      { type: "text" as const, text: "first" },
      { type: "image" as const, image: "https://example.com/a.png" },
      { type: "text" as const, text: "second" },
    ];
    expectOne({ messagesContain: ["first second"] });
    expect((await client.sendRequest(request(parts))).content).toBe("ok");

    expectOne({ messagesContain: ["a.png"] });
    await expect(client.sendRequest(request(parts))).rejects.toThrow(
      'expected some message to contain "a.png"',
    );
    resetMockMode();
  });

  it("throws naming the last message's text when it lacks `lastMessageContains`", async () => {
    expectOne({ lastMessageContains: "bye" });

    await expect(client.sendRequest(request("hello"))).rejects.toThrow(
      'expected last message to contain "bye", got "hello"',
    );
    resetMockMode();
  });

  it("throws naming the tools a request carries when one is missing", async () => {
    expectOne({ hasTools: ["search"] });

    await expect(
      client.sendRequest({
        ...request("hi"),
        tools: {
          calculate: { description: "Calculate", inputSchema: {} },
        },
      }),
    ).rejects.toThrow('expected tool "search" in request, got [calculate]');
    resetMockMode();
  });

  it("throws when the system prompt lacks `systemContains`", async () => {
    expectOne({ systemContains: "verbose" });

    await expect(client.sendRequest(request("hi"))).rejects.toThrow(
      'expected system prompt to contain "verbose"',
    );
    resetMockMode();
  });

  it("checks a `generateObject` entry's assertions against its request", async () => {
    const schema = { type: "object" as const };
    expectOne({ lastMessageContains: "name" }, "generateObject");
    expect(
      (await client.generateObject({
        messages: [{ role: "user", content: "a name" }],
        schema,
      })).object,
    ).toEqual({ name: "Alice" });

    expectOne({ lastMessageContains: "name" }, "generateObject");
    await expect(
      client.generateObject({
        messages: [{ role: "user", content: "a number" }],
        schema,
      }),
    ).rejects.toThrow('expected last message to contain "name"');
    resetMockMode();
  });
});

describe("loadConversationFixtureFile()", () => {
  const fixtures = new URL("../test/fixtures/", import.meta.url);

  it("queues the responses the file describes, with their assertions", async () => {
    resetMockMode();
    await loadConversationFixtureFile(
      fromFileUrl(new URL("conversation.json", fixtures)),
    );
    const client = new LLMClient();
    const request = (content: string): LLMRequest => ({
      messages: [{ role: "user", content }],
      model: "test",
      stream: false,
    });

    await expect(client.sendRequest(request("bye"))).rejects.toThrow(
      'Fixture "fixture file" entry 0: expected last message to contain "hello"',
    );
    expect((await client.sendRequest(request("hello"))).content).toBe(
      "from file",
    );
    resetMockMode();
  });

  it("throws naming the file when it holds no `responses` array", async () => {
    resetMockMode();
    const path = fromFileUrl(
      new URL("conversation-without-responses.json", fixtures),
    );

    await expect(loadConversationFixtureFile(path)).rejects.toThrow(
      `Invalid fixture at ${path}: "responses" must be an array`,
    );
  });
});

describe("mock streaming", () => {
  const client = new LLMClient();

  it("reports a mock's text, string or text part, to the callback once", async () => {
    for (
      const content of [
        "whole text",
        [
          { type: "tool-call", toolCallId: "c", toolName: "t", input: {} },
          { type: "text", text: "whole text" },
        ],
      ] satisfies LLMResponse["content"][]
    ) {
      resetMockMode();
      enableMockMode();
      addMockResponse(() => true, { role: "assistant", content, id: "m" });
      const seen: string[] = [];

      await client.sendRequest(
        {
          messages: [{ role: "user", content: "hi" }],
          model: "t",
          stream: true,
        },
        (text) => seen.push(text),
      );

      expect(seen).toEqual(["whole text"]);
    }
    resetMockMode();
  });

  it("does not call the callback for a mock without text", async () => {
    resetMockMode();
    enableMockMode();
    addMockResponse(() => true, {
      role: "assistant",
      content: [{
        type: "tool-call",
        toolCallId: "c",
        toolName: "t",
        input: {},
      }],
      id: "m",
    });
    const seen: string[] = [];

    await client.sendRequest(
      { messages: [{ role: "user", content: "hi" }], model: "t", stream: true },
      (text) => seen.push(text),
    );

    expect(seen).toEqual([]);
    resetMockMode();
  });
});

describe("LLMClient over HTTP", () => {
  // A client given a `fetch` other than the global one sends through it,
  // which the test-environment guard lets through.

  /** A client whose requests `respond` answers, and the requests it sent. */
  function clientAnswering(respond: () => Response) {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const client = new LLMClient((input, init) => {
      sent.push({ url: String(input), init });
      return Promise.resolve(respond());
    });
    return { client, sent };
  }

  const textRequest: LLMRequest = {
    messages: [{ role: "user", content: "hello" }],
    model: "test-model",
    stream: false,
  };
  const objectRequest: LLMGenerateObjectRequest = {
    messages: [{ role: "user", content: "hello" }],
    schema: { type: "object" },
  };

  it("POSTs a text request as JSON to the endpoint `setLLMUrl()` names", async () => {
    disableMockMode();
    setLLMUrl("http://127.0.0.1:9/some/path");
    const { client, sent } = clientAnswering(() =>
      Response.json({ role: "assistant", content: "hi" })
    );

    const reply = await client.sendRequest(textRequest);

    expect(reply.content).toBe("hi");
    expect(sent.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:9/api/ai/llm",
    ]);
    expect(sent[0].init?.method).toBe("POST");
    expect(JSON.parse(String(sent[0].init?.body))).toEqual(textRequest);
  });

  it("sends a `generateObject` request to the endpoint's `/generateObject`", async () => {
    disableMockMode();
    setLLMUrl("http://127.0.0.1:9");
    const { client, sent } = clientAnswering(() =>
      Response.json({ object: { name: "Alice" } })
    );

    expect((await client.generateObject(objectRequest)).object).toEqual({
      name: "Alice",
    });
    expect(sent.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:9/api/ai/llm/generateObject",
    ]);
  });

  it("sends to the endpoint a call names in place of the default", async () => {
    disableMockMode();
    setLLMUrl("http://127.0.0.1:9");
    const { client, sent } = clientAnswering(() =>
      Response.json({ object: {}, role: "assistant", content: "" })
    );
    const endpoint = new URL("http://127.0.0.1:10/api/ai/llm");

    await client.sendRequest(textRequest, undefined, undefined, { endpoint });
    await client.generateObject(objectRequest, undefined, { endpoint });

    expect(sent.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:10/api/ai/llm",
      "http://127.0.0.1:10/api/ai/llm/generateObject",
    ]);
  });

  it("throws the status and body of a failed response, and logs a hint naming the call", async () => {
    disableMockMode();
    const { client } = clientAnswering(() =>
      new Response("too many", { status: 429 })
    );
    using logged = stub(console, "error");

    await expect(client.sendRequest(textRequest)).rejects.toThrow(
      "HTTP error! status: 429, body: too many",
    );
    await expect(client.generateObject(objectRequest)).rejects.toThrow(
      "HTTP error! status: 429, body: too many",
    );
    const lines = logged.calls.map((call) => String(call.args[0]));
    expect(lines[0]).toContain("[generateText Error]");
    expect(lines[1]).toContain("[generateObject Error]");
    for (const line of lines) {
      expect(line).toContain(failureHint(429, ""));
    }
  });
});

describe("initialLLMUrl()", () => {
  it("returns the endpoint on the host that served the page", () => {
    expect(
      initialLLMUrl(
        { protocol: "https:", host: "app.example:8443" },
        "http://api.example",
      ),
    ).toBe("https://app.example:8443/api/ai/llm");
  });

  it("returns the endpoint on the API URL when there is no page", () => {
    expect(initialLLMUrl(undefined, "http://api.example/base/")).toBe(
      "http://api.example/api/ai/llm",
    );
  });

  it("returns a host-relative endpoint without a page or a usable API URL", () => {
    for (const apiUrl of [undefined, "", "not a url"]) {
      expect(initialLLMUrl(undefined, apiUrl)).toBe("//api/ai/llm");
    }
  });
});
