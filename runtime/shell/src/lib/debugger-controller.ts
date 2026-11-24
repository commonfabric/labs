import type {
  LoggerFlagsData,
  PatternSourceInfo,
  RuntimeTelemetryMarkerResult,
  SchedulerDiagnosisResult,
  SchedulerGraphEdge,
  SchedulerGraphSnapshot,
} from "@commonfabric/runtime-client";
import { ReactiveController, ReactiveControllerHost } from "lit";

import type { RuntimeInternals } from "./runtime.ts";

const STORAGE_KEY = "showDebuggerView";
const TELEMETRY_ENABLED_KEY = "telemetryEnabled";
const MAX_TELEMETRY_EVENTS = 1000; // Limit memory usage

/**
 * Extended graph edge with historical tracking
 */
export interface GraphEdgeWithHistory extends SchedulerGraphEdge {
  isHistorical: boolean; // true = edge existed before but not in current snapshot
}

/**
 * Graph snapshot with historical edge tracking
 */
export interface GraphWithHistory {
  nodes: SchedulerGraphSnapshot["nodes"];
  edges: GraphEdgeWithHistory[];
  timestamp: number;
}

/** The parts of the page a `DebuggerController` reads and listens to. */
export interface DebuggerControllerEnvironment {
  /** Where the debugger's visibility and telemetry preferences persist. */
  readonly storage: Pick<Storage, "getItem" | "setItem">;

  /** Where the `storage` events another tab's writes raise arrive. */
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
}

/**
 * Controller for managing Shell Debugger state and telemetry events.
 *
 * Handles:
 * - Debugger visibility state with localStorage persistence
 * - Runtime connection and telemetry event collection
 * - Memory management by limiting event history
 */
export class DebuggerController implements ReactiveController {
  #host: ReactiveControllerHost & EventTarget;
  #environment?: DebuggerControllerEnvironment;
  #runtime?: RuntimeInternals;
  #visible = false;
  #telemetryEnabled = false; // Manual telemetry on/off
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  // Scheduler graph tracking with historical edges
  #currentSnapshot?: SchedulerGraphSnapshot;
  #historicalEdges = new Set<string>(); // "from->to" format
  #graphUpdateVersion = 0;
  #isProcessingTelemetry = false; // Guard against re-entrant updates

  // Diagnosis state for non-idempotent detection
  #diagnosisResult: SchedulerDiagnosisResult | null = null;
  #isDiagnosing = false;

  // Logger flags from worker (e.g. "action invalid input" flags)
  #activeFlags: LoggerFlagsData = {};

  // Baseline stats for scheduler graph delta calculations
  // Persists across tab switches (stored here instead of in SchedulerGraphView component)
  #schedulerBaselineStats = new Map<
    string,
    { runCount: number; totalTime: number }
  >();

  // Pattern source files for source browser
  #patternSources: readonly PatternSourceInfo[] = [];
  #patternSourcesVersion = 0;

  // Debugger breakpoints: action IDs
  #breakpointIds = new Set<string>();

  /**
   * Constructs an instance which registers itself with `host`, keeping its
   * preferences in `environment`, or in the page's `localStorage` when none
   * is given.
   */
  constructor(
    host: ReactiveControllerHost & EventTarget,
    environment?: DebuggerControllerEnvironment,
  ) {
    this.#host = host;
    this.#environment = environment;
    this.#host.addController(this);
  }

  hostConnected() {
    // Load visibility from localStorage
    const { storage, window } = this.#page;
    const savedVisible = storage.getItem(STORAGE_KEY);
    if (savedVisible !== null) {
      this.#visible = savedVisible === "true";
    }

    // Load telemetry enabled state from localStorage (default to false)
    const savedTelemetryEnabled = storage.getItem(TELEMETRY_ENABLED_KEY);
    if (savedTelemetryEnabled !== null) {
      this.#telemetryEnabled = savedTelemetryEnabled === "true";
    }

    window.addEventListener("storage", this.#handleStorageChange);
    this.#host.addEventListener("clear-telemetry", this.#handleClearTelemetry);
  }

  hostDisconnected() {
    this.#page.window.removeEventListener("storage", this.#handleStorageChange);
    this.#host.removeEventListener(
      "clear-telemetry",
      this.#handleClearTelemetry,
    );
  }

  /**
   * Set the runtime and start listening to telemetry events
   */
  setRuntime(runtime: RuntimeInternals) {
    this.#runtime?.removeEventListener(
      "telemetryupdate",
      this.#handleTelemetryUpdate,
    );
    this.#runtime = runtime;
    runtime.addEventListener("telemetryupdate", this.#handleTelemetryUpdate);

    // Set telemetry enabled state based on saved preference
    this.#sendTelemetryEnabled();

    // Clear stale pattern sources from previous runtime
    this.#patternSources = [];
    this.#patternSourcesVersion++;

    // Re-sync breakpoints to new runtime
    this.#syncBreakpoints();

    // Load existing telemetry markers
    this.#telemetryMarkers = runtime.telemetry().slice(-MAX_TELEMETRY_EVENTS);
    this.#host.requestUpdate();
  }

  /**
   * Get the current telemetry markers
   */
  getTelemetryMarkers(): RuntimeTelemetryMarkerResult[] {
    return this.#telemetryMarkers;
  }

  /**
   * Check if the debugger is visible
   */
  isVisible(): boolean {
    return this.#visible;
  }

  /**
   * Set debugger visibility
   */
  setVisibility(visible: boolean) {
    if (this.#visible === visible) return;

    this.#visible = visible;
    this.#page.storage.setItem(STORAGE_KEY, String(visible));
    this.#host.requestUpdate();
  }

  /**
   * Check if telemetry is enabled
   */
  isTelemetryEnabled(): boolean {
    return this.#telemetryEnabled;
  }

  /**
   * Toggle telemetry collection on/off
   */
  toggleTelemetry() {
    this.setTelemetryEnabled(!this.#telemetryEnabled);
  }

  /**
   * Set telemetry enabled state
   */
  setTelemetryEnabled(enabled: boolean) {
    if (this.#telemetryEnabled === enabled) return;

    this.#telemetryEnabled = enabled;
    this.#page.storage.setItem(TELEMETRY_ENABLED_KEY, String(enabled));

    // Update telemetry collection in the worker
    this.#sendTelemetryEnabled();
    this.#host.requestUpdate();
  }

  /**
   * Get the current graph snapshot with historical edge tracking
   */
  getGraphWithHistory(): GraphWithHistory | undefined {
    if (!this.#currentSnapshot) return undefined;

    // Build set of current edge keys
    const currentEdgeSet = new Set(
      this.#currentSnapshot.edges.map((e) => `${e.from}->${e.to}`),
    );

    // Combine current edges with historical flag
    const edges: GraphEdgeWithHistory[] = this.#currentSnapshot.edges.map(
      (e) => ({
        ...e,
        isHistorical: false,
      }),
    );

    // Add historical edges that are not in current snapshot
    for (const edgeKey of this.#historicalEdges) {
      if (!currentEdgeSet.has(edgeKey)) {
        const [from, to] = edgeKey.split("->");
        edges.push({
          from,
          to,
          cells: [],
          isHistorical: true,
        });
      }
    }

    return {
      nodes: this.#currentSnapshot.nodes,
      edges,
      timestamp: this.#currentSnapshot.timestamp,
    };
  }

  /**
   * Get the graph update version for change detection
   */
  getGraphUpdateVersion(): number {
    return this.#graphUpdateVersion;
  }

  /**
   * Request a fresh graph snapshot from the scheduler
   */
  async requestGraphSnapshot(): Promise<void> {
    const rt = this.#runtime?.runtime();
    if (!rt) return;
    const snapshot = await rt.getGraphSnapshot();
    this.#processGraphSnapshot(snapshot);
    this.#host.requestUpdate();

    // Also refresh flags alongside the graph
    this.requestFlags();
  }

  /**
   * Get the current runtime internals
   */
  getRuntime(): RuntimeInternals | undefined {
    return this.#runtime;
  }

  /**
   * Get the scheduler baseline stats for delta calculations
   */
  getSchedulerBaselineStats(): Map<
    string,
    { runCount: number; totalTime: number }
  > {
    return this.#schedulerBaselineStats;
  }

  /**
   * Set new scheduler baseline stats
   */
  setSchedulerBaselineStats(
    stats: Map<string, { runCount: number; totalTime: number }>,
  ): void {
    this.#schedulerBaselineStats = stats;
    this.#host.requestUpdate();
  }

  /**
   * Request pattern source files for the source browser
   */
  async requestPatternSources(): Promise<void> {
    const rt = this.#runtime?.runtime();
    if (!rt) return;
    try {
      const response = await rt.getPatternSources();
      this.#patternSources = response.patterns;
      this.#patternSourcesVersion++;
      this.#host.requestUpdate();
    } catch (e) {
      console.error(
        "[DebuggerController] Failed to request pattern sources:",
        e,
      );
    }
  }

  /**
   * Get cached pattern sources
   */
  getPatternSources(): readonly PatternSourceInfo[] {
    return this.#patternSources;
  }

  /**
   * Get pattern sources version for change detection
   */
  getPatternSourcesVersion(): number {
    return this.#patternSourcesVersion;
  }

  /**
   * Set breakpoints for multiple action IDs at once.
   */
  async setBreakpointsForActions(
    actionIds: string[],
    enabled: boolean,
  ): Promise<void> {
    for (const id of actionIds) {
      if (enabled) {
        this.#breakpointIds.add(id);
      } else {
        this.#breakpointIds.delete(id);
      }
    }
    this.#host.requestUpdate();
    await this.#syncBreakpoints();
  }

  /**
   * Get all breakpoint action IDs.
   */
  getBreakpoints(): Set<string> {
    return new Set(this.#breakpointIds);
  }

  /**
   * Get active logger flags from the worker
   */
  getActiveFlags(): LoggerFlagsData {
    return this.#activeFlags;
  }

  /**
   * Update active flags directly (e.g. from an existing IPC response)
   */
  updateFlags(flags: LoggerFlagsData): void {
    this.#activeFlags = flags;
  }

  /**
   * Request fresh flags from the worker via getLoggerCounts
   */
  async requestFlags(): Promise<void> {
    const rt = this.#runtime?.runtime();
    if (!rt) return;
    try {
      const result = await rt.getLoggerCounts();
      this.#activeFlags = result.flags;
      this.#host.requestUpdate();
    } catch (e) {
      console.error("[DebuggerController] Failed to request flags:", e);
    }
  }

  /**
   * Get metadata for a specific flag ID.
   * Returns the metadata object if present, or null.
   */
  getFlagMetadata(
    flagName: string,
    id: string,
  ): Record<string, unknown> | null {
    return this.#activeFlags["runner"]?.[flagName]?.[id] ?? null;
  }

  //
  // Diagnosis for non-idempotent detection
  //

  /**
   * Run diagnosis and store the result.
   */
  async runDiagnosis(durationMs = 5000): Promise<void> {
    const rt = this.#runtime?.runtime();
    if (!rt || this.#isDiagnosing) return;

    this.#isDiagnosing = true;
    this.#host.requestUpdate();

    try {
      this.#diagnosisResult = await rt.detectNonIdempotent(durationMs);
    } catch (e) {
      console.error("[DebuggerController] Diagnosis failed:", e);
      this.#diagnosisResult = null;
    } finally {
      this.#isDiagnosing = false;
      this.#host.requestUpdate();
    }
  }

  /**
   * Get the current diagnosis result.
   */
  getDiagnosisResult(): SchedulerDiagnosisResult | null {
    return this.#diagnosisResult;
  }

  /**
   * Check if diagnosis is currently running.
   */
  getIsDiagnosing(): boolean {
    return this.#isDiagnosing;
  }

  //
  // Internals
  //

  /** The storage and window the constructor was handed, or the page's own. */
  get #page(): DebuggerControllerEnvironment {
    return this.#environment ?? { storage: localStorage, window: globalThis };
  }

  /**
   * Helper for `setRuntime()` and `setTelemetryEnabled()`, which tells the
   * worker whether to collect telemetry, logging a refusal.
   */
  #sendTelemetryEnabled(): void {
    this.#runtime?.runtime().setTelemetryEnabled(this.#telemetryEnabled)
      .catch((e) => {
        console.error(
          "[DebuggerController] Failed to set telemetry enabled:",
          e,
        );
      });
  }

  /**
   * Process a new graph snapshot and track historical edges
   */
  #processGraphSnapshot(newSnapshot: SchedulerGraphSnapshot): void {
    if (this.#currentSnapshot) {
      // Build set of current edges in the new snapshot
      const newEdgeSet = new Set(
        newSnapshot.edges.map((e) => `${e.from}->${e.to}`),
      );

      // Any edges in the old snapshot but not in the new one become historical
      for (const edge of this.#currentSnapshot.edges) {
        const edgeKey = `${edge.from}->${edge.to}`;
        if (!newEdgeSet.has(edgeKey)) {
          this.#historicalEdges.add(edgeKey);
        }
      }
    }

    this.#currentSnapshot = newSnapshot;
    this.#graphUpdateVersion++;
  }

  /**
   * Send current breakpoints to the worker.
   */
  async #syncBreakpoints(): Promise<void> {
    try {
      await this.#runtime?.runtime().setBreakpoints([...this.#breakpointIds]);
    } catch (e) {
      console.error(
        "[DebuggerController] Failed to set breakpoints:",
        e,
      );
    }
  }

  /**
   * Handle telemetry updates from the runtime
   */
  #handleTelemetryUpdate = () => {
    // Guard against re-entrant updates (telemetry -> UI update -> sink -> telemetry)
    const runtime = this.#runtime;
    if (this.#isProcessingTelemetry || !runtime) return;

    this.#isProcessingTelemetry = true;
    try {
      // Get all telemetry markers from runtime
      const allMarkers = runtime.telemetry();

      // Limit to maximum number of events to prevent memory issues
      this.#telemetryMarkers = allMarkers.slice(-MAX_TELEMETRY_EVENTS);

      // Check for graph snapshot events in recent markers. No host update is
      // requested here, since that would loop (telemetry -> UI update ->
      // sink -> telemetry); the views refresh on their own requests.
      const latestMarker = allMarkers[allMarkers.length - 1];
      if (latestMarker?.type === "scheduler.graph.snapshot") {
        this.#processGraphSnapshot(latestMarker.graph);
      }
    } finally {
      this.#isProcessingTelemetry = false;
    }
  };

  /**
   * Handle storage change events for cross-tab synchronization
   */
  #handleStorageChange = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue !== null) {
      const newVisible = event.newValue === "true";
      if (this.#visible !== newVisible) {
        this.#visible = newVisible;
        this.#host.requestUpdate();
      }
    }
  };

  #handleClearTelemetry = () => {
    this.#telemetryMarkers = [];
    this.#host.requestUpdate();
  };
}
