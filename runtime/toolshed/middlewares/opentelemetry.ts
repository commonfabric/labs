import { MiddlewareHandler } from "@hono/hono";
import {
  context,
  Span,
  SpanStatusCode,
  type TextMapGetter,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { getTracerProvider } from "@/lib/otel.ts";

// Dynamically resolve the tracer so we don't capture the no-op global tracer
const obtainTracer = () => {
  const provider = getTracerProvider();
  return provider
    ? provider.getTracer("toolshed-middleware", "1.0.0")
    : trace.getTracer("toolshed-middleware", "1.0.0");
};

// Extract any inbound W3C `traceparent`/`tracestate` so a request span links to
// the caller's trace (e.g. the browser shell, which stamps traceparent on its
// telemetry/API calls). No global propagator is registered under Deno, so build
// one explicitly. When no traceparent is present, `extract` returns the input
// context unchanged and the span starts as a fresh root — identical to before.
const propagator = new W3CTraceContextPropagator();
const headersGetter: TextMapGetter<Headers> = {
  keys: (carrier) => [...carrier.keys()],
  get: (carrier, key) => carrier.get(key) ?? undefined,
};

/**
 * Creates a middleware that adds OpenTelemetry tracing to all routes
 */
export function otelTracing(): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;

    // Start the request span as a child of any inbound traceparent context.
    const parentCtx = propagator.extract(
      context.active(),
      c.req.raw.headers,
      headersGetter,
    );

    await context.with(
      parentCtx,
      () =>
        obtainTracer().startActiveSpan(`${method} ${path}`, async (span) => {
          span.setAttribute("http.method", method);
          // The concrete request path, in addition to any templated route the
          // span name may carry — without it the target of e.g. a pattern
          // fetch (`/api/patterns/<file>`) is unrecoverable from the span.
          span.setAttribute("url.path", path);
          span.setAttribute("http.host", c.req.header("host") || "unknown");
          span.setAttribute(
            "http.user_agent",
            c.req.header("user-agent") || "unknown",
          );

          // Add request ID if it exists in headers
          const requestId = c.req.header("x-request-id");
          if (requestId) {
            span.setAttribute("http.request_id", requestId);
          }

          try {
            // Execute the downstream handlers while this span is active
            await next();

            // Capture status code from response if available
            if (c.res?.status) {
              span.setAttribute("http.status_code", c.res.status);
            }
          } catch (error) {
            span.setAttribute("error", true);
            span.setAttribute(
              "error.message",
              error instanceof Error ? error.message : String(error),
            );
            span.setAttribute(
              "error.type",
              error instanceof Error ? error.name : "UnknownError",
            );
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });

            if (error instanceof Error && error.stack) {
              span.setAttribute("error.stack", error.stack);
            }

            throw error;
          } finally {
            // `c.req.routePath` only resolves to the matched route *template* (e.g.
            // "/api/foo/:id") after `next()` has run; read before, it is this
            // middleware's own "*", and `path` is the high-cardinality concrete URL.
            // Set the template now so http.route and the span name aggregate
            // per-route in the backend instead of exploding cardinality.
            const route = c.req.routePath || path;
            span.setAttribute("http.route", route);
            span.updateName(`${method} ${route}`);
            // Attribute the request to its space when the route carries a
            // `:spaceDid` param (resolved only after `next()`). Defensive: no-op if
            // absent. `user.did` is set by the auth middleware while this span is
            // active.
            const spaceDid = c.req.param("spaceDid");
            if (spaceDid) {
              span.setAttribute("space.did", spaceDid);
            }
            span.end();
          }
        }),
    );
  };
}

/**
 * Helper function to get the current span from context
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

/**
 * Helper function to create a child span and manage its lifecycle
 */
export async function createSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const parentSpan = getCurrentSpan();
  const span = obtainTracer().startSpan(
    name,
    undefined,
    parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined,
  );

  // Add attributes
  Object.entries(attributes).forEach(([key, value]) => {
    span.setAttribute(key, value);
  });

  try {
    // Set the span as active for the duration of the function
    return await context.with(
      trace.setSpan(context.active(), span),
      async () => {
        const result = await fn(span);
        span.end();
        return result;
      },
    );
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.setAttribute("error", true);
    span.setAttribute(
      "error.message",
      error instanceof Error ? error.message : String(error),
    );
    span.end();
    throw error;
  }
}
