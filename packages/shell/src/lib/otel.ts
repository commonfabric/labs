// deno-lint-ignore-file cf-imports/no-inline-module-import -- the OpenTelemetry
// web SDK enters the shell's bundle only along this path, which runs when the
// operator has switched telemetry on.

/**
 * Browser-side OpenTelemetry setup for the shell (Phase 3).
 *
 * This is GATED and LAZY: nothing OpenTelemetry-related is imported at module
 * load. `initBrowserOtel` only pulls in the web SDK via dynamic `import(...)`
 * when `localStorage["telemetryEnabled"] === "true"`. With telemetry disabled
 * the default bundle is untouched and there is zero added network/CPU.
 *
 * Only type-only imports appear at the top; they are erased at build time and
 * never pull the OTel packages into the default bundle.
 */

import type { RuntimeTelemetryMarkerResult } from "@commonfabric/runtime-client";

// localStorage key that gates telemetry — the same flag the debugger controller
// toggles (packages/shell/src/lib/debugger-controller.ts).
const TELEMETRY_ENABLED_KEY = "telemetryEnabled";
const SERVICE_NAME = "toolshed-ui";
const SERVICE_VERSION = "1.0.0";

export interface InitBrowserOtelOptions {
  /** Same-origin (by default) toolshed API base; the OTLP proxy lives under it. */
  apiUrl: URL | string;

  userDid: string;
  spaceDid: string;
  environment: string;
}

/**
 * A minimal telemetry sink handed to the runtime. It wraps the reused
 * `createRuntimeTelemetryOtelBridge` from `@commonfabric/runner`, so the runtime
 * package never imports any OTel code itself.
 */
export interface BrowserTelemetry {
  /** Feed one RuntimeTelemetry marker into the OTel bridge. */
  handleMarker(marker: RuntimeTelemetryMarkerResult): void;

  /**
   * Update the space.did stamped on subsequent spans. The runtime (and this
   * sink) lives across space navigations, so the host must keep this current.
   */
  setSpace(spaceDid: string | undefined): void;

  /** Close open spans and flush + shut down the tracer provider. */
  shutdown(): Promise<void>;
}

/**
 * Initialize browser OpenTelemetry (traces only) and return a telemetry sink, or
 * `null` when telemetry is disabled or setup fails (fail-open — telemetry must
 * never break the app).
 */
export async function initBrowserOtel(
  options: InitBrowserOtelOptions,
): Promise<BrowserTelemetry | null> {
  // Gate: only initialize when the operator has opted in.
  try {
    if (localStorage.getItem(TELEMETRY_ENABLED_KEY) !== "true") {
      return null;
    }
  } catch {
    // localStorage can throw in locked-down contexts — treat as disabled.
    return null;
  }

  try {
    // Lazy web-SDK imports: pulled into the bundle only on this path.
    const { WebTracerProvider, BatchSpanProcessor } = await import(
      "@opentelemetry/sdk-trace-web"
    );
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    const { defaultResource, resourceFromAttributes } = await import(
      "@opentelemetry/resources"
    );
    const { metrics } = await import("@opentelemetry/api");
    // Reuse the shared marker->OTel translator (interface-only; @opentelemetry/api).
    const { createRuntimeTelemetryOtelBridge } = await import(
      "@commonfabric/runner/telemetry-otel-bridge"
    );

    const base = String(options.apiUrl).replace(/\/$/, "");
    const exporter = new OTLPTraceExporter({
      // Browsers can't reach the internal collector; POST to toolshed's proxy
      // (routes/telemetry), which forwards to its local collector.
      url: `${base}/api/telemetry/v1/traces`,
    });

    // Resource attributes are fixed for the provider's lifetime, so only
    // session-stable values belong here; space.did changes on navigation and
    // is stamped per-span by the bridge below instead.
    const provider = new WebTracerProvider({
      // The provider uses this resource as given, so merge it over the default
      // one to keep the `telemetry.sdk.*` attributes; the attributes below win
      // on conflict, so `service.name` stays ours rather than the default.
      resource: defaultResource().merge(
        resourceFromAttributes({
          "service.name": SERVICE_NAME,
          "service.version": SERVICE_VERSION,
          "deployment.environment": options.environment,
          "user.did": options.userDid,
        }),
      ),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    // Register globally so W3C traceparent is available for propagation. The
    // bridge still receives the tracer explicitly below, so exporting does not
    // depend on this registration.
    provider.register();

    const tracer = provider.getTracer(SERVICE_NAME, SERVICE_VERSION);
    // No MeterProvider is registered — browser is traces-only for now, so this
    // is the API no-op meter. The bridge's metric instruments become no-ops.
    const meter = metrics.getMeter(SERVICE_NAME);

    // The bridge holds this object by reference and reads it per marker, so
    // mutating it (see setSpace below) updates attribution for later spans.
    const attributes: Record<string, string> = {
      "ct.runtime": "browser",
      "user.did": options.userDid,
      "space.did": options.spaceDid,
    };
    const bridge = createRuntimeTelemetryOtelBridge({
      tracer,
      meter,
      attributes,
    });

    return {
      handleMarker: (marker) => bridge.handleMarker(marker),
      setSpace: (spaceDid) => {
        if (spaceDid === undefined) {
          delete attributes["space.did"];
        } else {
          attributes["space.did"] = spaceDid;
        }
      },
      shutdown: async () => {
        // Close any spans the bridge left open, then flush + tear down the SDK.
        try {
          bridge.shutdown();
        } catch (error) {
          console.error("[otel] bridge shutdown failed:", error);
        }
        try {
          await provider.shutdown();
        } catch (error) {
          console.error("[otel] provider shutdown failed:", error);
        }
      },
    };
  } catch (error) {
    // Fail open: a setup error must not block the app.
    console.error("[otel] browser OpenTelemetry init failed:", error);
    return null;
  }
}
