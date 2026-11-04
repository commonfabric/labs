import { assert, assertEquals, assertRejects } from "@std/assert";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import {
  compactThresholdForBudget,
  OpenAICompatibleGatewayModelClient,
} from "../src/model/openai-compatible-gateway.ts";
import {
  continuationOutput,
  toResponsesInput,
} from "../src/model/responses-protocol.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";

const GATEWAY = "https://gateway.test";
const PROVIDER = "openai-compatible-gateway";
const MODEL = "gpt-5.6-terra";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const clientWith = (captured: Captured[], bodies: unknown[]) => {
  let call = 0;
  return new OpenAICompatibleGatewayModelClient(
    new OpenAICompatibleGatewayClient({
      baseUrl: GATEWAY,
      authMode: "none",
      fetchFn: (input, init) => {
        captured.push({
          url: String(input),
          body: init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : {},
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
  model: MODEL,
  transcript: [{ role: "user", content: "Go." }],
  tools: [],
  nativeModelToolIds: [],
  runId: "run-compaction",
  ...overrides,
});

const completed = (output: unknown[]) => ({
  id: "resp_1",
  object: "response",
  status: "completed",
  output,
});

const compactionItem = (id = "cmp_1") => ({
  type: "compaction",
  id,
  encrypted_content: `encrypted-${id}`,
});

const registry = (models: Array<Record<string, unknown>>) => ({
  object: "list",
  data: models,
});

//
// Threshold policy
//

Deno.test("the threshold is 75% of the input budget, not of context window", () => {
  // gpt-5.6 family: 1,050,000 total - 128,000 output = 922,000 input.
  assertEquals(compactThresholdForBudget(1_050_000, 128_000), 691_500);
  // The 400k models are the trap: 75% of contextWindow is 300,000, which is
  // ABOVE the hard 272,000 input ceiling, so the guard would never fire.
  assertEquals(compactThresholdForBudget(400_000, 128_000), 204_000);
  assert(204_000 < 400_000 - 128_000, "threshold must sit under the input cap");
});

Deno.test("an unknown budget yields no threshold rather than a guess", () => {
  assertEquals(compactThresholdForBudget(undefined, 128_000), undefined);
  assertEquals(compactThresholdForBudget(1_050_000, undefined), undefined);
  // Degenerate registry data must not produce a negative or zero threshold.
  assertEquals(compactThresholdForBudget(1_000, 1_000), undefined);
  assertEquals(compactThresholdForBudget(1_000, 2_000), undefined);
});

Deno.test("listModels primes the compaction budget", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    registry([{
      id: MODEL,
      capabilities: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    }]),
    completed([]),
  ]);

  const models = await client.listModels();
  assertEquals(models[0].contextWindow, 1_050_000);
  assertEquals(models[0].maxOutputTokens, 128_000);

  await client.complete(turn());
  assertEquals(captured[1].body.context_management, [{
    type: "compaction",
    compact_threshold: 691_500,
  }]);
});

Deno.test("a per-request threshold overrides, and 0 disables", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    registry([{
      id: MODEL,
      capabilities: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    }]),
    completed([]),
  ]);
  await client.listModels();

  await client.complete(turn({ compactThreshold: 5_000 }));
  assertEquals(captured[1].body.context_management, [{
    type: "compaction",
    compact_threshold: 5_000,
  }]);

  await client.complete(turn({ compactThreshold: 0 }));
  assertEquals(captured[2].body.context_management, undefined);
});

//
// Retention and pruning
//

Deno.test("a compaction item is retained rather than dropped", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    completed([
      compactionItem(),
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ]),
  ]);

  const result = await client.complete(turn());
  const state = result.assistant.providerContinuation?.state as {
    output: Array<Record<string, unknown>>;
  };
  assertEquals(
    state.output.filter((o) => o.type === "compaction").length,
    1,
    "dropping it would mean paying for compaction and discarding the result",
  );
});

const compactedTranscript = (): HarnessTranscriptMessage[] => [
  { role: "system", content: "Be careful." },
  { role: "user", content: "Read both files." },
  // Superseded by the compaction below.
  {
    role: "assistant",
    content: "Reading the first.",
    toolCalls: [{
      id: "call-early",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    }],
  },
  {
    role: "tool",
    toolCallId: "call-early",
    toolName: "read_file",
    content: "early contents",
  },
  // The compaction boundary.
  {
    role: "assistant",
    content: "Reading the second.",
    toolCalls: [{
      id: "call-late",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    }],
    providerContinuation: {
      providerId: PROVIDER,
      state: {
        version: 1,
        sourceModel: MODEL,
        output: [
          compactionItem(),
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "encrypted-rs_1",
          },
        ],
      },
    },
  },
  {
    role: "tool",
    toolCallId: "call-late",
    toolName: "read_file",
    content: "late contents",
  },
];

Deno.test("pruning drops superseded turns but keeps tool pairs intact", async () => {
  const { instructions, input } = await toResponsesInput(
    compactedTranscript(),
    MODEL,
    PROVIDER,
    "gateway Responses",
    undefined,
    "drop",
  );

  // The system prompt must survive pruning — it is sent every turn.
  assertEquals(instructions, "Be careful.");

  const types = input.map((i) => i.type ?? `role:${i.role}`);
  assertEquals(types[0], "compaction");
  // Everything before the boundary is gone: no early user turn, and crucially
  // no orphaned function_call_output whose function_call was pruned away.
  const callIds = input.flatMap((i) =>
    typeof i.call_id === "string" ? [i.call_id] : []
  );
  assertEquals(callIds.includes("call-early"), false);
  assert(!JSON.stringify(input).includes("early contents"));

  // Every function_call_output still has its matching function_call.
  const calls = new Set(
    input.filter((i) => i.type === "function_call").map((i) => i.call_id),
  );
  for (const item of input.filter((i) => i.type === "function_call_output")) {
    assert(
      calls.has(item.call_id),
      `orphaned tool result for ${String(item.call_id)}`,
    );
  }
  assert(JSON.stringify(input).includes("late contents"));
});

Deno.test("the boundary's compaction item is emitted exactly once", async () => {
  const { input } = await toResponsesInput(
    compactedTranscript(),
    MODEL,
    PROVIDER,
    "gateway Responses",
    undefined,
    "drop",
  );
  assertEquals(input.filter((i) => i.type === "compaction").length, 1);
  // Its reasoning sibling still replays — only the compaction is deduplicated.
  assertEquals(input.filter((i) => i.type === "reasoning").length, 1);
});

Deno.test("a transcript with no compaction is unchanged", async () => {
  const plain: HarnessTranscriptMessage[] = [
    { role: "system", content: "Be careful." },
    { role: "user", content: "Go." },
    { role: "assistant", content: "Working." },
  ];
  const { input } = await toResponsesInput(
    plain,
    MODEL,
    PROVIDER,
    "gateway Responses",
    undefined,
    "drop",
  );
  assertEquals(input.filter((i) => i.type === "compaction").length, 0);
  assertEquals(input.length, 2);
});

Deno.test("a compaction from another model is not replayed", async () => {
  const foreign = compactedTranscript();
  const boundary = foreign[4] as {
    providerContinuation: { state: { sourceModel: string } };
  };
  boundary.providerContinuation.state.sourceModel = "gpt-5.6-sol";

  const { input } = await toResponsesInput(
    foreign,
    MODEL,
    PROVIDER,
    "gateway Responses",
    undefined,
    "drop",
  );
  // Encrypted state is bound to the model that produced it, so a mismatched
  // compaction must neither replay nor prune the transcript behind it.
  assertEquals(input.filter((i) => i.type === "compaction").length, 0);
  assert(JSON.stringify(input).includes("early contents"));
});

//
// The default must work on the normal run path, with no primed catalog.
//

const toolHeavyTranscript = (): HarnessTranscriptMessage[] => [
  { role: "user", content: "Go." },
  {
    role: "assistant",
    content: "",
    toolCalls: [{
      id: "call-large",
      type: "function",
      function: {
        name: "write_file",
        arguments: JSON.stringify({ content: "x".repeat(210_000) }),
      },
    }],
  },
  {
    role: "tool",
    toolCallId: "call-large",
    toolName: "write_file",
    content: "done",
  },
];

Deno.test("the default accounts for the rendered Responses input", async () => {
  const captured: Captured[] = [];
  // Nothing primes the catalog here: this is what a normal run does. Budget
  // discovery cannot be gated on transcript text because the rendered input
  // also contains tools, images, and encrypted continuation items.
  const client = clientWith(captured, [
    registry([{
      id: MODEL,
      capabilities: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    }]),
    completed([]),
  ]);

  await client.complete(turn({ transcript: toolHeavyTranscript() }));

  assertEquals(captured[0].url, `${GATEWAY}/v1/models`);
  assertEquals(captured[1].body.context_management, [{
    type: "compaction",
    compact_threshold: 691_500,
  }]);
});

Deno.test("multibyte input uses the UTF-8 byte discovery floor", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    registry([{
      id: MODEL,
      capabilities: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    }]),
    completed([]),
  ]);

  // This is far below 200,000 JavaScript characters but above 200,000 UTF-8
  // bytes. Token-dense scripts need discovery before a character floor would
  // fire or the smallest model's 204,000-token guard could already be late.
  await client.complete(turn({
    transcript: [{ role: "user", content: "界".repeat(70_000) }],
  }));

  assertEquals(captured[0].url, `${GATEWAY}/v1/models`);
  assertEquals(captured[1].body.context_management, [{
    type: "compaction",
    compact_threshold: 691_500,
  }]);
});

Deno.test("successful discovery is attempted once, then reused", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    registry([{
      id: MODEL,
      capabilities: { contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    }]),
    completed([]),
  ]);

  await client.complete(turn({ transcript: toolHeavyTranscript() }));
  await client.complete(turn());

  const listCalls = captured.filter((c) => c.url.endsWith("/v1/models")).length;
  assertEquals(listCalls, 1, "discovery must not repeat per turn");
});

Deno.test("successful discovery is cached for an unlisted model", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [
    registry([{
      id: "gpt-another-model",
      capabilities: { contextWindow: 400_000, maxOutputTokens: 128_000 },
    }]),
    completed([]),
    completed([]),
  ]);

  await client.complete(turn({ transcript: toolHeavyTranscript() }));
  await client.complete(turn({ transcript: toolHeavyTranscript() }));

  const listCalls = captured.filter((c) => c.url.endsWith("/v1/models")).length;
  assertEquals(listCalls, 1, "successful discovery must stay cached");
  assertEquals(captured[1].body.context_management, undefined);
  assertEquals(captured[2].body.context_management, undefined);
});

Deno.test("small turns pay no discovery round trip", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [completed([])]);

  await client.complete(turn());

  assertEquals(captured.length, 1);
  assertEquals(captured[0].url, `${GATEWAY}/v1/responses`);
  assertEquals(captured[0].body.context_management, undefined);
});

Deno.test("an explicit threshold avoids registry discovery", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [completed([])]);

  await client.complete(turn({ compactThreshold: 12_000 }));

  assertEquals(captured.length, 1);
  assertEquals(captured[0].url, `${GATEWAY}/v1/responses`);
  assertEquals(captured[0].body.context_management, [{
    type: "compaction",
    compact_threshold: 12_000,
  }]);
});

Deno.test("a later turn retries after an unreachable registry", async () => {
  const captured: Captured[] = [];
  let registryCalls = 0;
  const client = new OpenAICompatibleGatewayModelClient(
    new OpenAICompatibleGatewayClient({
      baseUrl: GATEWAY,
      authMode: "none",
      fetchFn: (input, init) => {
        captured.push({
          url: String(input),
          body: init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : {},
        });
        if (String(input).endsWith("/v1/models")) {
          registryCalls += 1;
          // The current turn degrades gracefully. The next turn must retry
          // rather than treating this transient failure as a populated cache.
          return Promise.resolve(
            registryCalls === 1
              ? new Response("nope", { status: 503 })
              : new Response(
                JSON.stringify(registry([{
                  id: MODEL,
                  capabilities: {
                    contextWindow: 1_050_000,
                    maxOutputTokens: 128_000,
                  },
                }])),
                { status: 200 },
              ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify(completed([])), { status: 200 }),
        );
      },
    }),
  );

  const first = await client.complete(turn({
    transcript: toolHeavyTranscript(),
  }));
  assertEquals(first.assistant.content, "");
  // Compaction is a guard, so losing it is not worth failing a run over.
  assertEquals(captured[1].body.context_management, undefined);

  const second = await client.complete(turn({
    transcript: toolHeavyTranscript(),
  }));
  assertEquals(second.assistant.content, "");
  assertEquals(registryCalls, 2);
  assertEquals(captured.map((call) => call.url), [
    `${GATEWAY}/v1/models`,
    `${GATEWAY}/v1/responses`,
    `${GATEWAY}/v1/models`,
    `${GATEWAY}/v1/responses`,
  ]);
  assertEquals(captured[3].body.context_management, [{
    type: "compaction",
    compact_threshold: 691_500,
  }]);
});

//
// Unsupported paths must fail loudly rather than ignore the option.
//

Deno.test("a positive threshold on a chat-routed model is rejected", async () => {
  const client = clientWith([], [completed([])]);
  await assertRejects(
    () =>
      client.complete(turn({
        model: "gemini-3.5-flash",
        compactThreshold: 5_000,
      })),
    Error,
    "requires a model routed through the Responses API",
  );
});

Deno.test("a positive threshold with native tools is rejected", async () => {
  const client = clientWith([], [completed([])]);
  await assertRejects(
    () =>
      client.complete(turn({
        nativeModelToolIds: ["google_search"],
        compactThreshold: 5_000,
      })),
    Error,
    "cannot combine provider-native tools",
  );
});

Deno.test("0 stays harmless on unsupported paths", async () => {
  const captured: Captured[] = [];
  const client = clientWith(captured, [{
    choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
  }]);
  // Its requested behavior is already "do not compact", so it need not throw.
  const result = await client.complete(turn({
    model: "gemini-3.5-flash",
    compactThreshold: 0,
  }));
  assertEquals(result.assistant.content, "ok");
  assertEquals(captured[0].url, `${GATEWAY}/v1/chat/completions`);
});

Deno.test("continuationOutput replays nothing from a continuation of an unknown version or with no source model", () => {
  for (
    const state of [
      { version: 3, sourceModel: "gpt-test", output: [] },
      { version: 2, output: [] },
    ]
  ) {
    assertEquals(
      continuationOutput({ providerId: "openai", state }, "gpt-test", "openai"),
      [],
    );
  }
});
