import type { Context } from "@hono/hono";
import env from "@/env.ts";

// OTLP payloads from the browser are small (a batch of spans). Cap the body so a
// misbehaving/hostile client can't stream an unbounded upload through the proxy.
const MAX_TELEMETRY_BYTES = 1024 * 1024; // 1MB

export type TelemetrySignal = "traces" | "metrics";

/**
 * Forward a browser OTLP payload to toolshed's local collector.
 *
 * Browsers can't reach the internal collector directly, so the same-origin app
 * POSTs here and toolshed relays to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/<signal>`,
 * preserving the incoming Content-Type (the browser exporter sends
 * application/json).
 *
 * This is fail-open by design: telemetry must NEVER break the app, so every
 * error path is caught and still answered with 202 (or 204/413 for the explicit
 * no-op / too-large cases). We never surface a 5xx to the browser exporter.
 */
export async function forwardOtlp(
  c: Context,
  signal: TelemetrySignal,
): Promise<Response> {
  // When telemetry is disabled, accept-and-drop: 204 No Content, no forwarding.
  if (!env.OTEL_ENABLED) {
    return c.body(null, 204);
  }

  // Cheap pre-check on the declared length before buffering anything.
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEMETRY_BYTES) {
    return c.body(null, 413);
  }

  // Stream the body and enforce the cap as bytes arrive, so a chunked upload
  // (no Content-Length) can never buffer more than the limit before being
  // rejected — `arrayBuffer()` would buffer the whole body first.
  let body: Uint8Array<ArrayBuffer>;
  try {
    const stream = c.req.raw.body;
    if (!stream) {
      body = new Uint8Array(new ArrayBuffer(0));
    } else {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_TELEMETRY_BYTES) {
          await reader.cancel();
          return c.body(null, 413);
        }
        chunks.push(value);
      }
      body = new Uint8Array(new ArrayBuffer(total));
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  } catch (error) {
    // Reading the body failed — log and still answer 202 so the exporter's
    // retry/backoff doesn't hammer us and nothing bubbles to the app.
    console.error("[telemetry-proxy] failed to read request body:", error);
    return c.body(null, 202);
  }

  const contentType = c.req.header("content-type") ?? "application/json";
  const endpoint = `${
    env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")
  }/v1/${signal}`;

  // Fire-and-forget: return 202 immediately so collector latency never affects
  // the app. Any forwarding failure is logged, never thrown.
  fetch(endpoint, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  }).catch((error) => {
    console.error(
      `[telemetry-proxy] failed to forward ${signal} to ${endpoint}:`,
      error,
    );
  });

  return c.body(null, 202);
}
