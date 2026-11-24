import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Hono } from "@hono/hono";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { createSpan, otelTracing } from "@/middlewares/opentelemetry.ts";

/**
 * Runs `body` with a global tracer provider that records every finished span,
 * and a context manager to carry the active span, and returns those spans.
 * The middleware resolves its tracer from the global provider when
 * getTracerProvider() (lib/otel.ts) is undefined, which it is here.
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

describe("opentelemetry", () => {
  describe("otelTracing()", () => {
    it("tags spans with the low-cardinality route template", async () => {
      const spans = await recordingSpans(async () => {
        const app = new Hono();
        app.use("*", otelTracing());
        app.get("/api/foo/:id", (c) => c.text("ok"));

        await app.request("/api/foo/123"); // matched route
        await app.request("/nope"); // unmatched -> 404
      });

      expect(spans).toHaveLength(2);

      // Matched: the template, not the concrete "/api/foo/123" (which would
      // explode cardinality) nor "/api/foo/123/*".
      expect(spans[0].name).toBe("GET /api/foo/:id");
      expect(spans[0].attributes["http.route"]).toBe("/api/foo/:id");
      expect(spans[0].attributes["http.method"]).toBe("GET");
      expect(spans[0].attributes["http.status_code"]).toBe(200);

      // Unmatched requests collapse to "/*" rather than leaking the raw path.
      expect(spans[1].name).toBe("GET /*");
      expect(spans[1].attributes["http.route"]).toBe("/*");
    });

    it("parents the request span on an inbound traceparent", async () => {
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentId = "00f067aa0ba902b7";
      const spans = await recordingSpans(async () => {
        const app = new Hono();
        app.use("*", otelTracing());
        app.get("/", (c) => c.text("ok"));

        await app.request("/", {
          headers: { traceparent: `00-${traceId}-${parentId}-01` },
        });
        await app.request("/");
      });

      expect(spans[0].spanContext().traceId).toBe(traceId);
      expect(spans[0].parentSpanContext?.spanId).toBe(parentId);
      // Without the header the span is a root of a trace of its own.
      expect(spans[1].parentSpanContext).toBeUndefined();
      expect(spans[1].spanContext().traceId).not.toBe(traceId);
    });

    it("records the request id and the space a route names, and only when present", async () => {
      const spaceDid = "did:key:z6MkDonutShop";
      const spans = await recordingSpans(async () => {
        const app = new Hono();
        app.use("*", otelTracing());
        app.get("/api/spaces/:spaceDid/cells", (c) => c.text("ok"));

        await app.request(`/api/spaces/${spaceDid}/cells`, {
          headers: { "x-request-id": "request-7" },
        });
        await app.request("/elsewhere");
      });

      expect(spans[0].attributes["http.request_id"]).toBe("request-7");
      expect(spans[0].attributes["space.did"]).toBe(spaceDid);
      expect("http.request_id" in spans[1].attributes).toBe(false);
      expect("space.did" in spans[1].attributes).toBe(false);
    });

    it("marks the span failed with the error's details, and rethrows it", async () => {
      const failure = new TypeError("the fryer is out of oil");
      let rethrown: unknown;
      const spans = await recordingSpans(async () => {
        const app = new Hono();
        app.use("*", otelTracing());
        // An error handler that rethrows hands the error back up the chain.
        app.onError((error) => {
          throw error;
        });
        app.get("/fry", () => {
          throw failure;
        });

        rethrown = await Promise.resolve(app.request("/fry")).catch(
          (error: unknown) => error,
        );
      });

      expect(rethrown).toBe(failure);
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toEqual({
        code: SpanStatusCode.ERROR,
        message: "the fryer is out of oil",
      });
      expect(spans[0].attributes["error"]).toBe(true);
      expect(spans[0].attributes["error.message"]).toBe(
        "the fryer is out of oil",
      );
      expect(spans[0].attributes["error.type"]).toBe("TypeError");
      expect(spans[0].attributes["error.stack"]).toBe(failure.stack);
      expect(spans[0].attributes["http.route"]).toBe("/fry");
    });

    it("names a thrown non-error an unknown error, with no stack", async () => {
      let rethrown: unknown;
      const spans = await recordingSpans(async () => {
        const app = new Hono();
        app.use("*", otelTracing());
        app.get("/fry", () => {
          throw "no oil";
        });

        rethrown = await Promise.resolve(app.request("/fry")).catch(
          (error: unknown) => error,
        );
      });

      expect(rethrown).toBe("no oil");
      expect(spans[0].attributes["error.type"]).toBe("UnknownError");
      expect("error.stack" in spans[0].attributes).toBe(false);
    });
  });

  describe("createSpan()", () => {
    it("sets the attributes it is given on the span", async () => {
      const spans = await recordingSpans(async () => {
        const result = await createSpan("fry", () => "done", {
          "donut.kind": "glazed",
          "donut.count": 12,
        });
        expect(result).toBe("done");
      });

      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("fry");
      expect(spans[0].attributes).toEqual({
        "donut.kind": "glazed",
        "donut.count": 12,
      });
    });

    it("ends the span failed with the error's message, and rethrows it", async () => {
      const failure = new Error("out of sprinkles");
      let rethrown: unknown;
      const spans = await recordingSpans(async () => {
        rethrown = await createSpan("decorate", () => {
          throw failure;
        }).catch((error) => error);
      });

      expect(rethrown).toBe(failure);
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toEqual({
        code: SpanStatusCode.ERROR,
        message: "out of sprinkles",
      });
      expect(spans[0].attributes).toEqual({
        error: true,
        "error.message": "out of sprinkles",
      });
    });
  });
});
