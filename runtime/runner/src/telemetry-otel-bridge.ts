// OpenTelemetry bridge for the runtime's existing telemetry stream.
//
// This does NOT add a parallel instrumentation layer. It subscribes to the
// SAME `RuntimeTelemetry` event bus that the debug tooling consumes (see
// telemetry.ts / runtime-client) and translates each `RuntimeTelemetryMarker`
// into OpenTelemetry spans and metrics. The debug tooling keeps working
// unchanged; OTel is just a second consumer of one event stream.
//
// It depends ONLY on `@opentelemetry/api` (interface-only, side-effect free), so
// importing it never pulls the OTel SDK into a bundle and never forces
// `--allow-sys`. Each host (toolshed, browser shell) owns its SDK provider
// setup and passes a Tracer + Meter in. When no provider is registered the API
// returns no-op instruments, so the bridge is inert.
//
// Reuse across runtimes: the worker/server side exposes an EventTarget
// (`runtime.telemetry`); the main thread / browser receives the same markers via
// `runtime-client.on("telemetry", ...)`. Both feed `handleMarker()`, so one
// translation table serves all three execution contexts.

import {
  type Attributes,
  type Meter,
  type Span,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import type {
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarkerResult,
} from "./telemetry.ts";

export interface OtelBridgeOptions {
  tracer: Tracer;
  meter: Meter;

  /**
   * Attributes stamped on every emitted span and metric — the dimensions the
   * markers themselves don't carry. Set here once at attach time from the host's
   * session/identity, e.g.:
   *   { "user.did": principal, "space.did": space, "ct.runtime": "server" }
   */
  attributes?: Attributes;

  /**
   * Attributes stamped on METRICS ONLY, merged over `attributes`. Backends
   * don't map OTel resource attributes onto metric datapoint labels, so pass
   * service.name / deployment.environment here to make metrics scopable by
   * service and environment. Kept off spans deliberately: spans already carry
   * these on their resource, and duplicating them as span attributes makes the
   * bare key ambiguous (resource vs attribute context) in SigNoz queries.
   */
  metricAttributes?: Attributes;

  /**
   * Minimum action-run duration that earns a retroactive `scheduler.action.run`
   * span. Measured on the lunch-poll diagnose workload: ~4.4% of runs exceed
   * 10ms (the distribution is bimodal — sub-ms computations vs 10–25ms
   * effects), so the default adds ~5% span volume, not a multiplier. Every run
   * still lands in the `ct.scheduler.action.duration_ms` histogram.
   * @default 10
   */
  actionRunSpanThresholdMs?: number;
}

export interface RuntimeTelemetryOtelBridge {
  /** Translate a single marker into spans/metrics. Safe to call for any type. */
  handleMarker(marker: RuntimeTelemetryMarkerResult): void;

  /** Close any spans still open (e.g. storage ops without a completion). */
  shutdown(): void;
}

/**
 * Attach a bridge directly to a RuntimeTelemetry EventTarget (worker/server
 * side). Returns a detach function that removes the listener and closes any
 * in-flight spans.
 */
export function attachRuntimeTelemetryOtelBridge(
  telemetry: EventTarget,
  options: OtelBridgeOptions,
): () => void {
  const bridge = createRuntimeTelemetryOtelBridge(options);
  const listener = (event: Event) => {
    bridge.handleMarker((event as RuntimeTelemetryEvent).marker);
  };
  telemetry.addEventListener("telemetry", listener);
  return () => {
    telemetry.removeEventListener("telemetry", listener);
    bridge.shutdown();
  };
}

/**
 * Create a bridge whose `handleMarker` can be wired to any marker source —
 * an EventTarget listener (worker/server) or `runtime-client.on("telemetry")`
 * (main thread / browser).
 */
export function createRuntimeTelemetryOtelBridge(
  options: OtelBridgeOptions,
): RuntimeTelemetryOtelBridge {
  const { tracer, meter } = options;
  const actionRunSpanThresholdMs = options.actionRunSpanThresholdMs ?? 10;
  const base = options.attributes ?? {};
  const attrs = (extra?: Attributes): Attributes =>
    extra ? { ...base, ...extra } : base;
  // Metric datapoints get the extra scoping labels; spans keep `base` only.
  const mbase = options.metricAttributes
    ? { ...base, ...options.metricAttributes }
    : base;
  const mattrs = (extra?: Attributes): Attributes =>
    extra ? { ...mbase, ...extra } : mbase;

  // Instruments (created once; no-ops when no MeterProvider is set)
  const runs = meter.createCounter("ct.scheduler.runs", {
    description: "Scheduler action runs",
  });
  const invocations = meter.createCounter("ct.scheduler.invocations", {
    description: "Scheduler handler invocations",
  });
  const cellUpdates = meter.createCounter("ct.cell.updates", {
    description: "Cell/document updates observed by the runtime",
  });
  const commits = meter.createCounter("ct.scheduler.commits", {
    description: "Scheduler event commits",
  });
  const commitRetries = meter.createCounter("ct.scheduler.commit.retries", {
    description: "Commit retries due to transient write conflicts",
  });
  const commitChangedWrites = meter.createHistogram(
    "ct.scheduler.commit.changed_writes",
    { description: "Changed writes per commit" },
  );
  // Per-phase preflight timings — the scheduler's own breakdown of where an
  // event's cost goes. These are the multi-user hot-path signals.
  const preflightPhase = {
    populate: meter.createHistogram("ct.scheduler.preflight.populate_ms", {
      unit: "ms",
    }),
    txToLog: meter.createHistogram("ct.scheduler.preflight.tx_to_log_ms", {
      unit: "ms",
    }),
    depCommit: meter.createHistogram("ct.scheduler.preflight.dep_commit_ms", {
      unit: "ms",
    }),
    collect: meter.createHistogram("ct.scheduler.preflight.collect_ms", {
      unit: "ms",
    }),
    schedule: meter.createHistogram("ct.scheduler.preflight.schedule_ms", {
      unit: "ms",
    }),
    total: meter.createHistogram("ct.scheduler.preflight.total_ms", {
      unit: "ms",
    }),
  };
  const preflightDirtyDeps = meter.createHistogram(
    "ct.scheduler.preflight.dirty_dependency_count",
    { description: "Dirty dependencies collected per event" },
  );
  // Per-run action duration — the signal that names a hot derive directly
  // (group by ct.module). Same measurement ActionStats records.
  const actionDuration = meter.createHistogram(
    "ct.scheduler.action.duration_ms",
    { unit: "ms", description: "Scheduler action run duration" },
  );
  // Settle pass duration/iterations — the user-facing "event → stable graph"
  // numbers, emitted unconditionally per settle pass.
  const settleDuration = meter.createHistogram(
    "ct.scheduler.settle.duration_ms",
    { unit: "ms", description: "Settle loop wall-clock per pass" },
  );
  const settleIterations = meter.createHistogram(
    "ct.scheduler.settle.iterations",
    { description: "Settle iterations that ran work, per pass" },
  );
  // busyRatio is the runner-thrash smoking gun: fraction of a window spent busy.
  const busyRatio = meter.createHistogram("ct.scheduler.busy_ratio", {
    description: "Non-settling window busy ratio (0..1)",
  });
  const nonSettling = meter.createCounter("ct.scheduler.non_settling.events", {
    description: "Non-settling windows detected",
  });
  const storageOps = meter.createCounter("ct.storage.ops", {
    description: "Storage push/pull operations",
  });
  const storageDuration = meter.createHistogram("ct.storage.op.duration_ms", {
    unit: "ms",
    description: "Storage push/pull duration",
  });

  // In-flight storage spans, keyed by the marker `id`
  type OpenOp = { span: Span; startMs: number };
  const openOps = new Map<string, OpenOp>();

  const patternAttrs = (
    info?: { patternName?: string; moduleName?: string },
  ): Attributes => {
    if (!info) return {};
    const out: Attributes = {};
    if (info.patternName) out["ct.pattern"] = info.patternName;
    if (info.moduleName) out["ct.module"] = info.moduleName;
    return out;
  };

  const startStorageOp = (
    id: string,
    kind: "push" | "pull",
    operation: string,
    extra?: Attributes,
  ) => {
    const span = tracer.startSpan(`storage.${kind}`, {
      attributes: attrs({
        "ct.storage.kind": kind,
        "ct.storage.operation": operation,
        ...extra,
      }),
    });
    openOps.set(id, { span, startMs: nowMs() });
  };

  const endStorageOp = (
    id: string,
    kind: "push" | "pull",
    error?: string,
    sessionId?: string,
  ) => {
    const open = openOps.get(id);
    const durationMs = open ? nowMs() - open.startMs : undefined;
    if (open) {
      if (sessionId) open.span.setAttribute("session.id", sessionId);
      if (error) {
        open.span.setStatus({ code: SpanStatusCode.ERROR, message: error });
        open.span.setAttribute("error", true);
      }
      open.span.end();
      openOps.delete(id);
    }
    storageOps.add(
      1,
      mattrs({ "ct.storage.kind": kind, "ct.storage.error": !!error }),
    );
    if (durationMs !== undefined) {
      storageDuration.record(durationMs, mattrs({ "ct.storage.kind": kind }));
    }
  };

  const handleMarker = (marker: RuntimeTelemetryMarkerResult): void => {
    switch (marker.type) {
      case "scheduler.run":
        runs.add(
          1,
          mattrs({
            ...patternAttrs(marker.actionInfo),
            "ct.error": !!marker.error,
          }),
        );
        break;
      case "scheduler.run.complete": {
        actionDuration.record(
          marker.durationMs,
          mattrs({
            ...patternAttrs(marker.actionInfo),
            "ct.error": !!marker.error,
          }),
        );
        if (marker.durationMs >= actionRunSpanThresholdMs) {
          // Retroactive span, same technique as scheduler.preflight: the run
          // already happened; reconstruct its window from the duration.
          const end = Date.now();
          const span = tracer.startSpan("scheduler.action.run", {
            startTime: end - Math.round(marker.durationMs),
            attributes: attrs({
              ...patternAttrs(marker.actionInfo),
              "ct.action_id": marker.actionId,
              "ct.duration_ms": marker.durationMs,
            }),
          });
          if (marker.error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: marker.error,
            });
          }
          span.end(end);
        }
        break;
      }
      case "scheduler.settle":
        settleDuration.record(marker.durationMs, mattrs());
        settleIterations.record(marker.iterations, mattrs());
        break;
      case "scheduler.invocation":
        invocations.add(1, mattrs(patternAttrs(marker.handlerInfo)));
        break;
      case "cell.update":
        cellUpdates.add(1, mattrs());
        break;
      case "scheduler.event.commit": {
        commits.add(
          1,
          mattrs({
            ...patternAttrs(marker.handlerInfo),
            "ct.commit.terminal": marker.terminal ?? "none",
            "ct.error": !!marker.error,
          }),
        );
        commitChangedWrites.record(marker.changedWriteCount, mattrs());
        if (marker.retryAttempt && marker.retryAttempt > 1) {
          commitRetries.add(1, mattrs(patternAttrs(marker.handlerInfo)));
        }
        break;
      }
      case "scheduler.event.preflight": {
        const total = marker.populateMs + marker.txToLogMs +
          marker.depCommitMs +
          marker.collectMs + marker.scheduleMs;
        const a = mattrs(patternAttrs(marker.handlerInfo));
        preflightPhase.populate.record(marker.populateMs, a);
        preflightPhase.txToLog.record(marker.txToLogMs, a);
        preflightPhase.depCommit.record(marker.depCommitMs, a);
        preflightPhase.collect.record(marker.collectMs, a);
        preflightPhase.schedule.record(marker.scheduleMs, a);
        preflightPhase.total.record(total, a);
        preflightDirtyDeps.record(marker.dirtyDependencyCount, a);
        // Retroactive span: the work already happened, so reconstruct its
        // window from the marker's total so it shows on a trace timeline.
        const end = Date.now();
        const span = tracer.startSpan("scheduler.preflight", {
          startTime: end - Math.round(total),
          attributes: attrs({
            ...patternAttrs(marker.handlerInfo),
            "ct.handler_id": marker.handlerId,
            "ct.read_count": marker.readCount,
            "ct.shallow_read_count": marker.shallowReadCount,
            "ct.dirty_dependency_count": marker.dirtyDependencyCount,
            // v2 preflight has no depth-tracked upstream walk (decision 15
            // inverted it); the walk's cost signal is its visit count.
            "ct.preflight.visit_count": marker.stats.visitCount,
            "ct.preflight.work_set_add_count": marker.stats.workSetAddCount,
            "ct.preflight.reverse_dependency_edge_count":
              marker.stats.reverseDependencyEdgeCount,
          }),
        });
        if (marker.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: marker.error });
        }
        span.end(end);
        break;
      }
      case "scheduler.non-settling":
        busyRatio.record(marker.busyRatio, mattrs());
        nonSettling.add(1, mattrs());
        break;
      case "storage.push.start":
        // localSeq/space join to the server's memory.transact span, which
        // stamps the same pair as commit.local_seq / space.did.
        startStorageOp(marker.id, "push", marker.operation, {
          ...(marker.localSeq !== undefined
            ? { "commit.local_seq": marker.localSeq }
            : {}),
          ...(marker.spaceDid ? { "space.did": marker.spaceDid } : {}),
        });
        break;
      case "storage.push.complete":
        endStorageOp(marker.id, "push", undefined, marker.sessionId);
        break;
      case "storage.push.error":
        endStorageOp(marker.id, "push", marker.error, marker.sessionId);
        break;
      case "storage.pull.start":
        startStorageOp(marker.id, "pull", marker.operation);
        break;
      case "storage.pull.complete":
        endStorageOp(marker.id, "pull");
        break;
      case "storage.pull.error":
        endStorageOp(marker.id, "pull", marker.error);
        break;
      case "scheduler.dependencies.update":
        // Dependency-graph churn is high-volume and mainly of interest to the
        // debug graph view; skip from OTel to keep cardinality/volume sane.
        break;
      case "scheduler.graph.snapshot":
      case "scheduler.subscribe":
        // Debug-view only; not exported.
        break;
    }
  };

  const shutdown = () => {
    for (const { span } of openOps.values()) span.end();
    openOps.clear();
  };

  return { handleMarker, shutdown };
}

function nowMs(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}
