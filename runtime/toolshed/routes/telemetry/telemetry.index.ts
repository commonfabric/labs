import { cors } from "@hono/hono/cors";

import { forwardOtlp } from "./telemetry.handlers.ts";
import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

// The shell app MAY be served from a different origin than the API in dev
// (see runtime/shell/src/lib/env.ts — API_URL can be overridden), so allow
// cross-origin telemetry POSTs. Reflect the request origin and allow the
// headers the browser OTLP exporter + W3C trace propagation send.
router.use(
  "/api/telemetry/*",
  cors({
    origin: (origin) => origin ?? "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "traceparent", "tracestate"],
  }),
);

// OTLP/HTTP signal endpoints. Traces is what the browser sends today; metrics is
// wired for future use and behaves identically.
router.post("/api/telemetry/v1/traces", (c) => forwardOtlp(c, "traces"));
router.post("/api/telemetry/v1/metrics", (c) => forwardOtlp(c, "metrics"));

export default router;
