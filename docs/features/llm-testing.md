# LLM Testing

## Overview

LLM-powered patterns have test coverage at three layers:

1. **Client guard** — `LLMClient` blocks live LLM calls in test environments
2. **Server-side tests** — toolshed route logic (model resolution, JSON mode,
   tool conversion)
3. **Runner smoke tests** — full pattern-to-mock-response path

## Test-environment guard

`packages/llm/src/client.ts` includes a test-environment check (evaluated once
at module load) which detects:

- `CI=true` (CI runners)
- `ENV=test` (set by `deno task test` in llm, runner, and toolshed packages)

The guard throws before any `fetch` call when running in a test environment
without mock mode enabled:

```
LLMClient: live LLM calls are blocked in test environments.
Use enableMockMode() and addMockResponse() to set up mocks.
```

When mock mode is enabled via `enableMockMode()`, the mock interception runs
first and the guard is never reached.

## Writing tests that use LLM

```ts
// Shown at module scope.
import {
  enableMockMode,
  addMockResponse,
  addMockObjectResponse,
  clearMockResponses,
  resetMockMode,
} from "@commonfabric/llm/client";

// Enable once at module level
enableMockMode();

// In beforeEach, clear previous mocks
beforeEach(() => clearMockResponses());

// Register mock responses with matchers
addMockResponse(
  (req) => req.messages.some(m =>
    typeof m.content === "string" && m.content.includes("hello")
  ),
  { role: "assistant", content: "Hi!", id: "mock-1" },
);

// For generateObject (no tools path). `req.schema` is a `JSONSchema`, which
// includes the boolean schemas `true` and `false`, so narrow before reading a
// keyword off it.
addMockObjectResponse(
  (req) => typeof req.schema === "object" && req.schema.type === "object",
  { object: { name: "Alice" }, id: "mock-2" },
);
```

Mock responses are **one-time use** — they're consumed when matched.

## Testing the toolshed route against a mock model

The mock mode above intercepts the client's `fetch`, so it never reaches the
route handler. To exercise the route's own handling of a response — an empty
answer, a provider that turns the request down, a stream that stops early —
drive `generateText` with a stand-in language model instead.

`findModel` reads the exported `MODELS` registry in
`packages/toolshed/routes/ai/llm/models.ts`, and that registry is a plain
mutable object. A test registers a model under a name of its own, runs the
generation, and takes the entry back out afterwards:

```ts
// Shown for illustration only.
MODELS["mock:test-model"] = {
  model: new MockLanguageModelV4({ doStream: { stream } }),
  name: "mock:test-model",
  capabilities: { /* the fields the route reads */ },
  aliases: [],
};
try {
  await generateText({ model: "mock:test-model", messages });
} finally {
  delete MODELS["mock:test-model"];
}
```

Two properties of the AI SDK shape what these tests can assert.

A request that fails **after it has started** does not reject. The SDK reports
it as an `{ type: "error", error }` part carried inside the response stream and
passes it to the `onError` callback. Reading only `textStream` therefore yields
an empty response and no sign of the failure, so a test that wants to see the
provider's complaint has to look at what the route does with `onError`, not at
whether `streamText` threw.

The SDK retries a failure it considers retryable — a 408, 409, 429, or any 5xx
— sleeping between attempts, and reports the exhausted attempts wrapped in a
`RetryError` that carries no status of its own. Both routes ask for a single
attempt with `maxRetries: 0`, so a mock can fail with any status and the
failure comes straight back. A test that sets its own `maxRetries` gets the
sleeps and the wrapper too.

## Conversation Fixtures

For multi-turn or complex LLM interactions, use **conversation fixtures** —
declarative JSON files that queue responses sequentially instead of writing
inline `addMockResponse()` calls.

### Fixture format

```jsonc
// packages/runner/test/fixtures/my-conversation.json
{
  "description": "Two-turn chat with tool call",
  "responses": [
    {
      "type": "sendRequest",
      "expectRequest": {
        "messagesContain": ["hi"],
        "messageCount": 1
      },
      "response": {
        "role": "assistant",
        "content": "Hello!",
        "id": "turn-1"
      }
    },
    {
      "type": "sendRequest",
      "response": {
        "role": "assistant",
        "content": [
          {
            "type": "tool-call",
            "toolCallId": "call_1",
            "toolName": "lookup",
            "input": { "query": "weather" }
          }
        ],
        "id": "turn-2-tool"
      },
      "expectRequest": {
        "hasTools": ["lookup"]
      }
    },
    {
      "type": "sendRequest",
      "response": {
        "role": "assistant",
        "content": "It's sunny!",
        "id": "turn-2-final"
      }
    }
  ]
}
```

Supported entry types: `"sendRequest"` and `"generateObject"`.

### Optional assertions

Each entry can include an `expectRequest` object to validate the request:

| Field | Description |
|-------|-------------|
| `messageCount` | Request has exactly this many messages |
| `messagesContain` | Each string appears in at least one message (strings may match different messages) |
| `lastMessageContains` | Last message content contains this string |
| `hasTools` | Request includes these tool names |
| `systemContains` | System prompt contains this string |

### Loading fixtures in tests

```ts
import {
  clearMockResponses,
  loadConversationFixture,
  loadConversationFixtureFile,
} from "@commonfabric/llm/client";

// From a file
await loadConversationFixtureFile("test/fixtures/my-conversation.json");

// Or inline
loadConversationFixture({
  responses: [
    {
      type: "sendRequest",
      response: { role: "assistant", content: "Hi!", id: "1" },
    },
  ],
});
```

Both functions enable mock mode automatically. Call `clearMockResponses()`
in `beforeEach` to reset between tests.

## Test files

| File | What it tests |
|------|--------------|
| `packages/llm/src/client.test.ts` | Guard behavior, mock mode API, fixture loading |
| `packages/toolshed/routes/ai/llm/generateText.test.ts` | JSON mode config, response cleaning, failure reporting against a mock model |
| `packages/toolshed/routes/ai/llm/generateObject.test.ts` | Model resolution, error paths |
| `packages/toolshed/routes/ai/llm/llm.status.test.ts` | The HTTP status a failed generation answers with, through the real router |
| `packages/toolshed/routes/ai/llm/errors.test.ts` | Sorting a failure into a status, including shapes the routes cannot produce |
| `packages/runner/test/llm-pattern-smoke.test.ts` | generateText, generateObject, and tool-calling through runtime |
| `packages/runner/test/llm-conversation-fixture.test.ts` | Multi-turn conversations and tool chains via fixtures |

## Running tests

```bash
# LLM client tests (guard + mock + fixtures)
cd packages/llm && deno task test

# Toolshed server tests
cd packages/toolshed && deno task test

# Runner tests (includes smoke tests + fixture tests)
cd packages/runner && deno task test
```

## Related documentation

- [TESTING.md](../development/TESTING.md) — running the suites and the general unit and
  integration test structure.
- [COVERAGE.md](../development/COVERAGE.md) — how the runtime coverage these tests produce feeds
  the coverage trend. Of `packages/llm`, `packages/toolshed` and
  `packages/runner`, only `packages/llm` carries a measured set, so only its
  tests feed the measured-set gate.
