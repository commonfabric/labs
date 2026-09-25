import { OpenInferenceBatchSpanProcessor } from "@arizeai/openinference-vercel";
import { context, diag, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";

import env from "@/env.ts";
import { createAiSdkTelemetry } from "@/lib/ai-telemetry.ts";
import { samplerFromEnv } from "@/lib/otel-sampler.ts";
import { detachRuntimeOtelBridgeIfAttached } from "@/runtime-options.ts";

// Ensure we only register once even during hot-reload
let _providerRegistered = false;
let _provider: BasicTracerProvider | undefined;

export const otlpExporter = new OTLPTraceExporter({
  url: env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
    : "http://localhost:4318/v1/traces",
});

export const provider = new BasicTracerProvider({
  // The provider uses this resource as given, so merge it over the default one
  // to keep the `telemetry.sdk.*` attributes; the attributes below win on
  // conflict, so `service.name` stays ours rather than the default.
  resource: defaultResource().merge(
    resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME || "toolshed-dev",
      "service.version": "1.0.0",
      "deployment.environment": env.ENV || "development",
    }),
  ),
  // The sampler is built from OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG
  // here; passing one takes precedence over the SDK's own reading of those
  // variables. Defaults (always_on / 1.0) keep 100% sampling.
  // NOTE: head sampling here applies to LLM/OpenInference spans too, so a ratio
  // below 1.0 also thins the spans the collector forwards to SigNoz.
  sampler: samplerFromEnv(env.OTEL_TRACES_SAMPLER, env.OTEL_TRACES_SAMPLER_ARG),
  // Export ALL spans (HTTP request spans from the otel middleware AND LLM spans) to
  // the OTLP collector, which forwards everything to SigNoz. We keep the
  // OpenInferenceBatchSpanProcessor (rather than a plain BatchSpanProcessor) so LLM
  // spans get OpenInference / GenAI semantic-convention enrichment, which SigNoz
  // consumes; a pass-through spanFilter lets non-LLM spans through as well. (The
  // processor tags passed-through spans with an `openinference.span.kind`
  // attribute, so they are not strictly byte-for-byte unchanged.)
  spanProcessors: [
    new OpenInferenceBatchSpanProcessor({
      exporter: otlpExporter,
      spanFilter: () => true,
    }),
  ],
});

// Register the AI SDK telemetry against the same provider the OpenInference
// processor runs on, so LLM spans reach the same exporter as everything else.
// Registration happens at module scope because a generation call anywhere in
// the process picks up whatever is registered at the time it runs.
registerTelemetry(
  createAiSdkTelemetry(
    provider.getTracer(env.OTEL_SERVICE_NAME || "toolshed-dev"),
  ),
);

export function getTracerProvider() {
  return _provider;
}

/**
 * Flush and shut down the tracer provider so buffered spans aren't dropped when
 * the process exits: toolshed keeps its last span batch across a deploy or
 * restart. No-op if telemetry was never initialized.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  // End any in-flight runtime-bridge spans (e.g. an open storage.push) so
  // they make the final flush instead of dying with the process.
  detachRuntimeOtelBridgeIfAttached();
  if (!_provider) return;
  const p = _provider;
  _provider = undefined;
  try {
    await p.forceFlush();
    await p.shutdown();
  } finally {
    // Reset the global API state so getTracer() falls back to the API no-op
    // after shutdown. We deliberately do NOT reset _providerRegistered: the
    // `provider` above is a module-level const that init can't rebuild, so a
    // re-init must stay a guarded no-op rather than re-register a torn-down
    // instance. Shutdown here is process-exit-only.
    trace.disable();
    context.disable();
  }
}

// Prefer Deno's built-in context manager when running on Deno ≥2.2.
// It properly hooks into the runtime's AsyncContext implementation so
// tracing context survives across *all* async boundaries.
// Falls back to the Node/async-hooks based manager when not available
// (eg. unit tests executed under Node).
const getContextManager = () => {
  try {
    // deno-lint-ignore no-explicit-any
    const cm = (globalThis as any)?.Deno?.telemetry?.contextManager;
    if (cm && typeof cm.enable === "function") {
      diag.debug("Using Deno's built-in telemetry context manager");
      return cm;
    }
  } catch (_) {
    // ignored – not running on Deno with telemetry support
  }
  diag.debug("Falling back to AsyncHooksContextManager");
  return new AsyncHooksContextManager();
};

export function initOpenTelemetry(enabled: boolean = env.OTEL_ENABLED) {
  if (_providerRegistered || !enabled) {
    if (!enabled) {
      console.log("OpenTelemetry is disabled via OTEL_ENABLED env var");
    } else {
      console.log("OpenTelemetry already initialized, skipping");
    }
    return;
  }

  try {
    // Set up context manager
    const contextManager = getContextManager();
    context.setGlobalContextManager(contextManager.enable());

    // Register provider globally
    trace.setGlobalTracerProvider(provider);
    _provider = provider;
    _providerRegistered = true;

    console.log(
      `OpenTelemetry initialized successfully with endpoint: ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
    );

    diag.debug("OpenTelemetry configuration details:", {
      exporter: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      service: env.OTEL_SERVICE_NAME || "toolshed-dev",
      environment: env.ENV || "development",
    });
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error);
    // Don't crash the app if telemetry fails
  }
}
