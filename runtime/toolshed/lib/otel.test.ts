import { assert, assertEquals } from "@std/assert";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { OpenInferenceBatchSpanProcessor } from "@arizeai/openinference-vercel";
import {
  getTracerProvider,
  initOpenTelemetry,
  provider,
  shutdownOpenTelemetry,
} from "@/lib/otel.ts";

Deno.test("spans carry both the service attributes and the SDK defaults", () => {
  // The provider takes the configured resource as given, so the service
  // attributes and the SDK's own defaults have to be merged before it is handed
  // over. Both halves are read off a span the real provider produced, since a
  // span carries the resource the exporter will stamp on it. The span is left
  // unended so nothing is queued for export.

  const span = provider.getTracer("otel-test").startSpan(
    "resource-probe",
  ) as unknown as ReadableSpan;
  const attributes = span.resource.attributes;

  assertEquals(attributes["service.name"], "toolshed");
  assertEquals(attributes["service.version"], "1.0.0");

  // Dropping these still exports spans, just anonymous ones, so nothing else
  // here would notice their absence.
  assertEquals(attributes["telemetry.sdk.language"], "nodejs");
  assertEquals(attributes["telemetry.sdk.name"], "opentelemetry");
  assert(
    typeof attributes["telemetry.sdk.version"] === "string",
    "telemetry.sdk.version should be set by the SDK's default resource",
  );
});

//
// Which copy of the tracer SDK is in use
//
// `OpenInferenceBatchSpanProcessor` subclasses `BatchSpanProcessor`, but
// @arizeai/openinference-vercel imports @opentelemetry/sdk-trace-base without
// declaring it as a dependency, and the range it names in its development
// dependencies stops below the major this workspace resolves. Which copy it
// subclasses is therefore decided by the workspace import map rather than by
// anything the package states, and the span export in this section depends on
// the answer.
//

Deno.test("the OpenInference processor extends the tracer SDK in use", () => {
  assert(
    OpenInferenceBatchSpanProcessor.prototype instanceof BatchSpanProcessor,
    "OpenInferenceBatchSpanProcessor resolved a different copy of " +
      "@opentelemetry/sdk-trace-base than the one the providers use",
  );
});

Deno.test("spans pass through the OpenInference processor to the exporter", async () => {
  const exporter = new InMemorySpanExporter();
  const spanProcessor = new OpenInferenceBatchSpanProcessor({
    exporter,
    spanFilter: () => true,
  });
  const testProvider = new BasicTracerProvider({
    spanProcessors: [spanProcessor],
  });
  try {
    testProvider.getTracer("otel-test").startSpan("passthrough").end();
    await testProvider.forceFlush();

    const spans = exporter.getFinishedSpans();
    assertEquals(spans.length, 1);
    assertEquals(spans[0].name, "passthrough");
  } finally {
    await testProvider.shutdown();
  }
});

//
// The module's telemetry lifecycle
//
// The module registers an AI SDK telemetry integration on import, and
// `shutdownOpenTelemetry()` behaves differently before `initOpenTelemetry()`
// has run and after.
//

Deno.test("importing the module registers an AI SDK telemetry integration", () => {
  // The `ai` package collects no spans until a telemetry integration is
  // registered, and it reports nothing when none is: the LLM spans simply stop
  // being produced. Importing this module is what registers ours.

  assert(
    (globalThis.AI_SDK_TELEMETRY_INTEGRATIONS?.length ?? 0) > 0,
    "no AI SDK telemetry integration registered; LLM spans would not be collected",
  );
});

Deno.test("shutdownOpenTelemetry is a no-op before init", async () => {
  assertEquals(getTracerProvider(), undefined);
  await shutdownOpenTelemetry();
  assertEquals(getTracerProvider(), undefined);
});

Deno.test(
  "registers a provider when enabled, then flushes and tears it down on shutdown",
  // The batch processor keeps a flush timer until shutdown; we tear it down
  // below via shutdownOpenTelemetry(), so disable the leak sanitizer here.
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    initOpenTelemetry(true);
    assert(getTracerProvider() !== undefined, "provider should be registered");

    // No span was emitted, so forceFlush makes no network call to the collector.
    await shutdownOpenTelemetry();
    assertEquals(getTracerProvider(), undefined);
  },
);
