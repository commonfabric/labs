import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import createApp from "@/lib/create-app.ts";

/**
 * Runs `body` with a global tracer provider that records every finished span,
 * and returns those spans. The tracing middleware resolves its tracer from the
 * global provider, since no test here initializes `lib/otel.ts`.
 */
async function recordingSpans(
  body: () => Promise<void>,
): Promise<ReadableSpan[]> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncHooksContextManager().enable());
  try {
    await body();
    return exporter.getFinishedSpans();
  } finally {
    trace.disable();
    context.disable();
    await provider.shutdown();
  }
}

describe("create-app", () => {
  describe("createApp()", () => {
    it("traces each request when OTEL_ENABLED is set", async () => {
      const spans = await recordingSpans(async () => {
        const app = createApp({ OTEL_ENABLED: true });
        app.get("/donuts/:id", (c) => c.text("glazed"));

        const response = await app.request("/donuts/7");
        expect(await response.text()).toBe("glazed");
      });

      expect(spans.map((span) => span.name)).toEqual(["GET /donuts/:id"]);
    });

    it("traces nothing when OTEL_ENABLED is unset", async () => {
      const spans = await recordingSpans(async () => {
        const app = createApp({ OTEL_ENABLED: false });
        app.get("/donuts/:id", (c) => c.text("glazed"));

        const response = await app.request("/donuts/7");
        expect(await response.text()).toBe("glazed");
      });

      expect(spans).toEqual([]);
    });

    it("returns a JSON 404 for a path no route matches", async () => {
      const response = await createApp({ OTEL_ENABLED: false }).request(
        "/nowhere",
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        message: "Not Found - /nowhere",
      });
    });
  });
});
