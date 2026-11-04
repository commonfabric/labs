import { assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { otelTracing } from "@/middlewares/opentelemetry.ts";

Deno.test("otelTracing tags spans with the low-cardinality route template", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // The middleware resolves its tracer from the global provider when
  // getTracerProvider() (lib/otel.ts) is undefined, which it is here.
  trace.setGlobalTracerProvider(provider);

  try {
    const app = new Hono();
    app.use("*", otelTracing());
    app.get("/api/foo/:id", (c) => c.text("ok"));

    await app.request("/api/foo/123"); // matched route
    await app.request("/nope"); // unmatched -> 404

    const spans = exporter.getFinishedSpans();
    assertEquals(spans.length, 2);

    // Matched: template, not the concrete "/api/foo/123" (which would explode
    // cardinality) and not the old "/api/foo/123/*" concatenation bug.
    assertEquals(spans[0].name, "GET /api/foo/:id");
    assertEquals(spans[0].attributes["http.route"], "/api/foo/:id");
    assertEquals(spans[0].attributes["http.method"], "GET");

    // Unmatched requests collapse to "/*" rather than leaking the raw path.
    assertEquals(spans[1].name, "GET /*");
    assertEquals(spans[1].attributes["http.route"], "/*");
  } finally {
    trace.disable();
    context.disable();
    await provider.shutdown();
  }
});
