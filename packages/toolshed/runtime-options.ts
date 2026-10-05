import {
  type EnvReader,
  experimentalOptionsFromEnv,
  Runtime,
  type RuntimeOptions,
  runtimePresets,
} from "@commonfabric/runner";
import { publishCfcPosture } from "@/lib/cfc-posture.ts";
import { publishExperimentalPosture } from "@/lib/experimental-posture.ts";
import type { env as ToolshedEnv } from "@/env.ts";

/**
 * Assemble this toolshed's `RuntimeOptions` (CT-1814), extracted pure from
 * the server startup path so the wiring decisions are unit-testable:
 * `apiUrl` is the storage/memory base (MEMORY_URL), while patterns fetch
 * against the public API base (API_URL) — the builder/env.ts fallback is a
 * hardcoded `localhost:<ports.toolshed>`, wrong for any non-default port.
 * EXPERIMENTAL_* flags come from the injected env reader via the canonical
 * mapping.
 */
export function toolshedRuntimeOptions(
  config: Pick<ToolshedEnv, "MEMORY_URL" | "API_URL">,
  storageManager: RuntimeOptions["storageManager"],
  envGet: EnvReader = Deno.env.get,
): RuntimeOptions {
  return runtimePresets.productionServer({
    apiUrl: new URL(config.MEMORY_URL),
    patternApiUrl: new URL(config.API_URL),
    storageManager,
    experimental: experimentalOptionsFromEnv(envGet),
  });
}

type OtelEnv = Pick<ToolshedEnv, "OTEL_ENABLED" | "OTEL_SERVICE_NAME" | "ENV">;

/**
 * Construct this toolshed's Runtime and, when OTel is enabled, bridge its
 * telemetry bus to OpenTelemetry as a second consumer of the same marker
 * stream the debug tooling uses. Toolshed's Runtime only executes patterns
 * for webhook deliveries (interactive patterns run in browser runtimes), so
 * the bridge is low-volume — but without it those runs emit markers into the
 * void.
 *
 * The attach is fire-and-forget off the startup path (dynamic imports defer
 * OTel module load); the promise is returned so tests can await it. Failures
 * are logged, never fatal.
 */
export function createToolshedRuntime(
  config: Pick<ToolshedEnv, "MEMORY_URL" | "API_URL"> & OtelEnv,
  storageManager: RuntimeOptions["storageManager"],
  envGet: EnvReader = Deno.env.get,
): Runtime {
  const runtime = new Runtime(
    toolshedRuntimeOptions(config, storageManager, envGet),
  );
  // What `/api/meta` reports, taken from the Runtime that resolved it rather
  // than re-read from the environment, so a client adopting this deployment's
  // posture gets the flags actually in effect here.
  publishExperimentalPosture(runtime.experimental);
  publishCfcPosture(runtime);
  // Fire-and-forget; the attach itself is exported and unit-tested.
  void attachRuntimeOtelBridge(runtime, config);
  return runtime;
}

// The one live bridge detach (toolshed runs a single Runtime); invoked from
// shutdownOpenTelemetry so in-flight storage spans are ended before the final
// flush instead of being dropped with the process.
let activeOtelBridgeDetach: (() => void) | undefined;

/** Idempotent; returns whether a bridge was attached. */
export function detachRuntimeOtelBridgeIfAttached(): boolean {
  const detach = activeOtelBridgeDetach;
  activeOtelBridgeDetach = undefined;
  detach?.();
  return detach !== undefined;
}

/**
 * Exported for tests; production reaches it through createToolshedRuntime.
 * Structural param so failure paths can be exercised with a stub.
 *
 * Metrics caveat: toolshed's own OTel setup (lib/otel.ts) registers a tracer
 * provider only, so with OTEL_ENABLED alone the bridge's ct.* instruments are
 * API no-ops. On the VMs the process also runs under Deno native OTel
 * (OTEL_DENO + --unstable-otel), whose global MeterProvider makes them real —
 * spans work either way. Deliberate: a second SDK MeterProvider here would
 * duplicate what Deno native already exports.
 */
export async function attachRuntimeOtelBridge(
  runtime: Pick<Runtime, "telemetry" | "scheduler">,
  config: OtelEnv,
): Promise<boolean> {
  if (!config.OTEL_ENABLED) return false;
  let detach: (() => void) | undefined;
  try {
    const [{ attachRuntimeTelemetryOtelBridge }, { metrics, trace }] =
      await Promise.all([
        // The OpenTelemetry bridge loads only for a run that reports.
        // deno-lint-ignore cf-imports/no-inline-module-import
        import("@commonfabric/runner/telemetry-otel-bridge"),
        // deno-lint-ignore cf-imports/no-inline-module-import
        import("@opentelemetry/api"),
      ]);
    detach = attachRuntimeTelemetryOtelBridge(runtime.telemetry, {
      tracer: trace.getTracer("ct-runner-bridge"),
      meter: metrics.getMeter("ct-runner-bridge"),
      attributes: { "ct.runtime": "server" },
      metricAttributes: {
        "service.name": config.OTEL_SERVICE_NAME,
        "deployment.environment": config.ENV,
      },
    });
    // Preflight markers are gated; without the flip the event-admission
    // spans/histograms never fire.
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);
    // Registered only after full success so a failed attach never leaves a
    // half-wired bridge behind for shutdown to detach.
    activeOtelBridgeDetach = detach;
    return true;
  } catch (error) {
    detach?.();
    console.warn("Runtime OTel bridge attach failed:", error);
    return false;
  }
}
