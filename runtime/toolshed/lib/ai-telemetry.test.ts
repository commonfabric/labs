/**
 * Per-request metadata reaches spans only when it is passed as runtime context
 * and named in `includeRuntimeContext`. Nothing throws when that wiring is
 * wrong: the spans are still exported, just without the attributes. These
 * tests assert the attributes are present.
 */

import { assert, assertEquals } from "@std/assert";
import { registerTelemetry, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { OpenInferenceBatchSpanProcessor } from "@arizeai/openinference-vercel";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  createAiSdkTelemetry,
  metadataAttributeValue,
  runtimeContextFromMetadata,
} from "@/lib/ai-telemetry.ts";

function mockModel() {
  return new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "1" });
          controller.enqueue({ type: "text-delta", id: "1", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    },
  });
}

/**
 * Runs one generation through the real telemetry integration and the
 * OpenInference processor, and returns the exported spans.
 */
async function collectSpans(
  telemetry: Record<string, unknown>,
  runtimeContext?: Record<string, string>,
): Promise<ReadableSpan[]> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new OpenInferenceBatchSpanProcessor({
        exporter,
        spanFilter: () => true,
      }),
    ],
  });

  // registerTelemetry appends to a global list; keep this test's integration
  // out of every other test in the process.
  const previous = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS;
  globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = [];
  try {
    registerTelemetry(createAiSdkTelemetry(provider.getTracer("test")));

    const result = streamText({
      model: mockModel(),
      messages: [{ role: "user", content: "hi" }],
      runtimeContext,
      telemetry,
    });
    for await (const _ of result.textStream) { /* drain */ }

    await provider.forceFlush();
    return exporter.getFinishedSpans();
  } finally {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = previous;
    await provider.shutdown();
  }
}

const metadataOf = (span: ReadableSpan) =>
  Object.fromEntries(
    Object.entries(span.attributes).filter(([key]) =>
      key.startsWith("metadata.")
    ),
  );

Deno.test(
  "runtime context named in includeRuntimeContext reaches OpenInference metadata on every span",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const spans = await collectSpans(
      {
        isEnabled: true,
        includeRuntimeContext: { requestId: true, tenant: true },
      },
      { requestId: "req-abc", tenant: "acme" },
    );

    assert(spans.length > 0, "expected exported spans");

    // The LLM span is the one consumers read as the model call, and it is not
    // covered by the supplemental runtime-context attributes on its own.
    const kinds = spans.map((span) =>
      span.attributes["openinference.span.kind"]
    );
    assert(kinds.includes("LLM"), `expected an LLM span, got ${kinds}`);

    for (const span of spans) {
      assertEquals(
        metadataOf(span),
        { "metadata.requestId": "req-abc", "metadata.tenant": "acme" },
        `missing metadata on ${span.name}`,
      );
    }
  },
);

Deno.test(
  "runtime context is withheld from spans when includeRuntimeContext omits it",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const spans = await collectSpans(
      { isEnabled: true },
      { requestId: "req-abc" },
    );

    assert(spans.length > 0, "expected exported spans");
    for (const span of spans) {
      assertEquals(metadataOf(span), {}, `unexpected metadata on ${span.name}`);
    }
  },
);

Deno.test(
  "nested and non-string runtime context is flattened the same way on every span",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // The model-call span gets its attributes from enrichSpan rather than from
    // the supplemental runtime-context option, so it is the span that can
    // disagree with the rest of the trace about how a value is spelled.

    const spans = await collectSpans(
      {
        isEnabled: true,
        includeRuntimeContext: {
          nested: true,
          count: true,
          tags: true,
          absent: true,
        },
      },
      {
        nested: { inner: "deep" },
        count: 5,
        tags: ["a", "b"],
        absent: null,
      } as unknown as Record<string, string>,
    );

    const byName = Object.fromEntries(
      spans.map((span) => [span.name, metadataOf(span)]),
    );
    const distinct = new Set(
      spans.map((span) => JSON.stringify(metadataOf(span))),
    );
    assertEquals(
      distinct.size,
      1,
      `spans disagree about metadata: ${JSON.stringify(byName, null, 2)}`,
    );
    assertEquals(
      spans.map((s) => s.attributes["openinference.span.kind"]).includes("LLM"),
      true,
    );
    assertEquals(metadataOf(spans[0]), {
      "metadata.nested.inner": "deep",
      "metadata.count": 5,
      "metadata.tags": ["a", "b"],
    });
  },
);

Deno.test("metadataAttributeValue records strings, numbers, and booleans as they are", () => {
  assertEquals(metadataAttributeValue("req-abc"), "req-abc");
  assertEquals(metadataAttributeValue(2), 2);
  assertEquals(metadataAttributeValue(true), true);
});

Deno.test("metadataAttributeValue serializes objects and arrays to JSON", () => {
  assertEquals(metadataAttributeValue({ a: 1 }), '{"a":1}');
  assertEquals(metadataAttributeValue(["a", "b"]), '["a","b"]');
});

Deno.test("metadataAttributeValue drops values that have no attribute form", () => {
  assertEquals(metadataAttributeValue(undefined), undefined);
  assertEquals(metadataAttributeValue(() => {}), undefined);
});

//
// Metadata into runtime context
//
// A request may carry metadata of any type, or none, and every value it can
// carry has to reach the spans, not just the string ones.
//

Deno.test("runtimeContextFromMetadata carries every value that has an attribute form", () => {
  const { runtimeContext, includeRuntimeContext } = runtimeContextFromMetadata({
    requestId: "req-abc",
    attempt: 2,
    cached: false,
    labels: { team: "search" },
    absent: undefined,
  });

  assertEquals(runtimeContext, {
    requestId: "req-abc",
    attempt: 2,
    cached: false,
    labels: '{"team":"search"}',
  });
  assertEquals(includeRuntimeContext, {
    requestId: true,
    attempt: true,
    cached: true,
    labels: true,
  });
});

Deno.test("runtimeContextFromMetadata passes nothing on when there is no metadata", () => {
  assertEquals(runtimeContextFromMetadata(undefined), {
    runtimeContext: undefined,
    includeRuntimeContext: undefined,
  });
});

Deno.test(
  "object metadata reaches every span as the JSON the root span records",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // The reported gap: object metadata reached the root span as JSON but never
    // any AI SDK span. Routed through runtimeContextFromMetadata it now reaches
    // every span, spelled the same way the root span spells it.

    const { runtimeContext, includeRuntimeContext } =
      runtimeContextFromMetadata(
        { labels: { team: "search" }, attempt: 2 },
      );
    const spans = await collectSpans(
      { isEnabled: true, includeRuntimeContext },
      runtimeContext as Record<string, string>,
    );

    assertEquals(
      spans.map((s) => s.attributes["openinference.span.kind"]).includes("LLM"),
      true,
    );
    for (const span of spans) {
      assertEquals(metadataOf(span), {
        "metadata.labels": '{"team":"search"}',
        "metadata.attempt": 2,
      }, `wrong metadata on ${span.name}`);
    }
  },
);
