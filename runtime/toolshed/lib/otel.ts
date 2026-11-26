import { OpenInferenceBatchSpanProcessor } from "@arizeai/openinference-vercel";
import { context, type ContextManager, diag, trace } from "@opentelemetry/api";
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

/**
 * What the tracer is configured with, read from `environment`, with the
 * fallback each setting takes when its variable is empty.
 */
export function otelSettings(
  environment: Pick<
    typeof env,
    "OTEL_EXPORTER_OTLP_ENDPOINT" | "OTEL_SERVICE_NAME" | "ENV"
  >,
): { tracesUrl: string; serviceName: string; environment: string } {
  return {
    tracesUrl: environment.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${
        environment.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")
      }/v1/traces`
      : "http://localhost:4318/v1/traces",
    serviceName: environment.OTEL_SERVICE_NAME || "toolshed-dev",
    environment: environment.ENV || "development",
  };
}

const settings = otelSettings(env);

export const otlpExporter = new OTLPTraceExporter({ url: settings.tracesUrl });

export const provider = new BasicTracerProvider({
  // The provider uses this resource as given, so merge it over the default one
  // to keep the `telemetry.sdk.*` attributes; the attributes below win on
  // conflict, so `service.name` stays ours rather than the default.
  resource: defaultResource().merge(
    resourceFromAttributes({
      "service.name": settings.serviceName,
      "service.version": "1.0.0",
      "deployment.environment": settings.environment,
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
    provider.getTracer(settings.serviceName),
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

/**
 * Returns the runtime's own context manager, which hooks into its
 * AsyncContext implementation so tracing context survives across every async
 * boundary; or, where `runtime` has none, the async-hooks based manager.
 */
export function chooseContextManager(
  runtime: { telemetry?: { contextManager?: ContextManager } } = Deno,
): ContextManager {
  const builtIn = runtime.telemetry?.contextManager;
  if (builtIn !== undefined) {
    diag.debug("Using Deno's built-in telemetry context manager");
    return builtIn;
  }
  diag.debug("Falling back to AsyncHooksContextManager");
  return new AsyncHooksContextManager();
}

/**
 * Registers the tracer provider globally, with the context manager
 * `contextManager` returns, once per process and only when `enabled`. A
 * failure to register is logged rather than thrown.
 */
export function initOpenTelemetry(
  enabled: boolean = env.OTEL_ENABLED,
  contextManager: () => ContextManager = chooseContextManager,
) {
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
    context.setGlobalContextManager(contextManager().enable());

    // Register provider globally
    trace.setGlobalTracerProvider(provider);
    _provider = provider;
    _providerRegistered = true;

    console.log(
      `OpenTelemetry initialized successfully with endpoint: ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
    );

    diag.debug("OpenTelemetry configuration details:", {
      exporter: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      service: settings.serviceName,
      environment: settings.environment,
    });
  } catch (error) {
    console.error("Failed to initialize OpenTelemetry:", error);
    // Don't crash the app if telemetry fails
  }
}
