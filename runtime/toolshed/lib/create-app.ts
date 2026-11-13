import { OpenAPIHono } from "@hono/zod-openapi";
import { notFound, serveEmojiFavicon } from "stoker/middlewares";
import { defaultHook } from "stoker/openapi";
import { pinoLogger } from "@/middlewares/pino-logger.ts";
import { otelTracing } from "@/middlewares/opentelemetry.ts";
import env from "@/env.ts";
import type { AppBindings, AppOpenAPI } from "@/lib/types.ts";
import { initOpenTelemetry } from "@/lib/otel.ts";

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

/**
 * The app every router is mounted on: request tracing when
 * `environment.OTEL_ENABLED` is set, the favicon, the request logger, and the
 * JSON 404.
 */
export default function createApp(
  environment: Pick<typeof env, "OTEL_ENABLED"> = env,
) {
  // Initialize OpenTelemetry before creating the app
  initOpenTelemetry();

  const app = createRouter();

  // Add OpenTelemetry tracing if enabled.
  // Note: service.name / service.version are OTel *resource* attributes, already
  // set on the provider in lib/otel.ts. We intentionally don't re-inject them as
  // per-span attributes here — doing so duplicated the keys on every span (with a
  // conflicting default: span-level "toolshed" vs resource-level "toolshed-dev").
  if (environment.OTEL_ENABLED) {
    app.use("*", otelTracing());
  }

  app.use(serveEmojiFavicon("🪓"));
  app.use(pinoLogger());

  app.notFound(notFound);
  return app;
}

export function createTestApp<R extends AppOpenAPI>(router: R) {
  return createApp().route("/", router);
}
