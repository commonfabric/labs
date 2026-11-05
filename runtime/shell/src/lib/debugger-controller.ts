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

/**
 * Controller for managing Shell Debugger state and telemetry events.
 *
 * Handles:
 * - Debugger visibility state with localStorage persistence
 * - Runtime connection and telemetry event collection
 * - Memory management by limiting event history
 */
export class DebuggerController implements ReactiveController {
  #host: ReactiveControllerHost & HTMLElement;
  #runtime?: RuntimeInternals;
  #visible = false;
  #telemetryEnabled = false; // Manual telemetry on/off
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];
  #updateVersion = 0;

  // Scheduler graph tracking with historical edges
  #currentSnapshot?: SchedulerGraphSnapshot;
  #historicalEdges = new Set<string>(); // "from->to" format
  #graphUpdateVersion = 0;
  #isProcessingTelemetry = false; // Guard against re-entrant updates

  // Diagnosis state for non-idempotent detection
  #diagnosisResult: SchedulerDiagnosisResult | null = null;
  #isDiagnosing = false;
  #diagnosisVersion = 0;

  // Logger flags from worker (e.g. "action invalid input" flags)
  #activeFlags: LoggerFlagsData = {};
  #flagsVersion = 0;

  // Baseline stats for scheduler graph delta calculations
  // Persists across tab switches (stored here instead of in SchedulerGraphView component)
  #schedulerBaselineStats = new Map<
    string,
    { runCount: number; totalTime: number }
  >();
  #schedulerBaselineVersion = 0;

  // Pattern source files for source browser
  #patternSources: readonly PatternSourceInfo[] = [];
  #patternSourcesVersion = 0;

  // Debugger breakpoints: action IDs
  #breakpointIds = new Set<string>();
  #breakpointsVersion = 0;

  constructor(host: ReactiveControllerHost & HTMLElement) {
    this.#host = host;
    this.#host.addController(this);
  }

  hostConnected() {
    // Load visibility from localStorage
    const savedVisible = localStorage.getItem(STORAGE_KEY);
    if (savedVisible !== null) {
      this.#visible = savedVisible === "true";
    }

    // Load telemetry enabled state from localStorage (default to false)
    const savedTelemetryEnabled = localStorage.getItem(TELEMETRY_ENABLED_KEY);
    if (savedTelemetryEnabled !== null) {
      this.#telemetryEnabled = savedTelemetryEnabled === "true";
    }

    globalThis.addEventListener("storage", this.#handleStorageChange);
    this.#host.addEventListener("clear-telemetry", this.#handleClearTelemetry);
  }

  hostDisconnected() {
    globalThis.removeEventListener("storage", this.#handleStorageChange);
    this.#host.removeEventListener(
      "clear-telemetry",
      this.#handleClearTelemetry,
    );
  }

  /**
   * Set the runtime and start listening to telemetry events
   */
  setRuntime(runtime: RuntimeInternals) {
    if (this.#runtime) {
      this.#runtime.removeEventListener(
        "telemetryupdate",
        this.#handleTelemetryUpdate,
      );
    }

    this.#runtime = runtime;

    if (this.#runtime) {
      this.#runtime.addEventListener(
        "telemetryupdate",
        this.#handleTelemetryUpdate,
      );

      // Set telemetry enabled state based on saved preference
      const rt = this.#runtime.runtime();
      rt.setTelemetryEnabled(this.#telemetryEnabled).catch((e) => {
        console.error(
          "[DebuggerController] Failed to set telemetry enabled:",
          e,
        );
      });

      // Clear stale pattern sources from previous runtime
      this.#patternSources = [];
      this.#patternSourcesVersion++;

      // Re-sync breakpoints to new runtime
      this.#syncBreakpoints().catch(() => {});

      // Load existing telemetry markers
      this.#telemetryMarkers = this.#runtime.telemetry().slice(
        -MAX_TELEMETRY_EVENTS,
      );
      this.#updateVersion++;
      this.#host.requestUpdate();
    }
  }

  /**
   * Get the current telemetry markers
   */
  getTelemetryMarkers(): RuntimeTelemetryMarkerResult[] {
    return this.#telemetryMarkers;
  }

  /**
   * Get the update version for change detection
   */
  getUpdateVersion(): number {
    return this.#updateVersion;
  }

  /**
   * Check if the debugger is visible
   */
  isVisible(): boolean {
    return this.#visible;
  }

  /**
   * Toggle debugger visibility
   */
  toggleVisibility() {
    this.setVisibility(!this.#visible);
  }

  /**
   * Set debugger visibility
   */
  setVisibility(visible: boolean) {
    if (this.#visible === visible) return;

    this.#visible = visible;
    localStorage.setItem(STORAGE_KEY, String(visible));
    this.#host.requestUpdate();
  }

  /**
   * Clear all telemetry events
   */
  clearTelemetry() {
    this.#telemetryMarkers = [];
    this.#updateVersion++;
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
    localStorage.setItem(TELEMETRY_ENABLED_KEY, String(enabled));

    // Update telemetry collection in the worker
    const rt = this.#runtime?.runtime();
    if (rt) {
      rt.setTelemetryEnabled(enabled).catch((e) => {
        console.error(
          "[DebuggerController] Failed to set telemetry enabled:",
          e,
        );
      });
    }

    this.#host.requestUpdate();
  }

  /**
   * Handle telemetry updates from the runtime
   */
  #handleTelemetryUpdate = () => {
    // Guard against re-entrant updates (telemetry -> UI update -> sink -> telemetry)
    if (this.#isProcessingTelemetry) return;

    if (this.#runtime) {
      this.#isProcessingTelemetry = true;
      try {
        // Get all telemetry markers from runtime
        const allMarkers = this.#runtime.telemetry();

        // Limit to maximum number of events to prevent memory issues
        this.#telemetryMarkers = allMarkers.slice(-MAX_TELEMETRY_EVENTS);
        this.#updateVersion++;

        // Check for graph snapshot events in recent markers
        const latestMarker = allMarkers[allMarkers.length - 1];
        if (latestMarker?.type === "scheduler.graph.snapshot") {
          this.#processGraphSnapshot(
            (latestMarker as { graph: SchedulerGraphSnapshot }).graph,
          );
        }

        // NOTE: Auto-refresh disabled - was causing infinite loop
        // (telemetry -> UI update -> sink -> telemetry)
        // Use manual refresh button instead
        // if (
        //   latestMarker?.type === "scheduler.run" ||
        //   latestMarker?.type === "scheduler.invocation" ||
        //   latestMarker?.type === "scheduler.subscribe" ||
        //   latestMarker?.type === "scheduler.dependencies.update"
        // ) {
        //   const rt = this.runtime.runtime();
        //   if (rt) {
        //     const snapshot = rt.scheduler.getGraphSnapshot();
        //     this.processGraphSnapshot(snapshot);
        //   }
        // }

        // Request update to refresh the UI
        //this.host.requestUpdate();
      } finally {
        this.#isProcessingTelemetry = false;
      }
    }
  };

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

  /**
   * Get statistics about telemetry events
   */
  getStatistics() {
    const eventTypes = new Map<string, number>();

    for (const marker of this.#telemetryMarkers) {
      const type = marker.type.split(".")[0]; // Get the main category
      eventTypes.set(type, (eventTypes.get(type) || 0) + 1);
    }

    return {
      totalEvents: this.#telemetryMarkers.length,
      eventTypes: Object.fromEntries(eventTypes),
      oldestEvent: this.#telemetryMarkers[0]?.timeStamp,
      newestEvent: this.#telemetryMarkers[this.#telemetryMarkers.length - 1]
        ?.timeStamp,
    };
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
    if (!this.#runtime) return;

    const rt = this.#runtime.runtime();
    if (!rt) return;
    const snapshot = await rt.getGraphSnapshot();
    this.#processGraphSnapshot(snapshot);
    this.#host.requestUpdate();

    // Also refresh flags alongside the graph
    this.requestFlags().catch(() => {});
  }

  /**
   * Get the current runtime internals
   */
  getRuntime(): RuntimeInternals | undefined {
    return this.#runtime;
  }

  /**
   * Clear historical edges
   */
  clearHistoricalEdges(): void {
    this.#historicalEdges.clear();
    this.#graphUpdateVersion++;
    this.#host.requestUpdate();
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
    this.#schedulerBaselineVersion++;
    this.#host.requestUpdate();
  }

  /**
   * Clear the scheduler baseline stats
   */
  clearSchedulerBaselineStats(): void {
    this.#schedulerBaselineStats.clear();
    this.#schedulerBaselineVersion++;
    this.#host.requestUpdate();
  }

  /**
   * Get the scheduler baseline version for change detection
   */
  getSchedulerBaselineVersion(): number {
    return this.#schedulerBaselineVersion;
  }

  /**
   * Request pattern source files for the source browser
   */
  async requestPatternSources(): Promise<void> {
    if (!this.#runtime) return;
    const rt = this.#runtime.runtime();
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
   * Toggle a breakpoint for an action ID. Sends updated set to worker.
   */
  async toggleBreakpoint(actionId: string): Promise<void> {
    if (this.#breakpointIds.has(actionId)) {
      this.#breakpointIds.delete(actionId);
    } else {
      this.#breakpointIds.add(actionId);
    }
    this.#breakpointsVersion++;
    this.#host.requestUpdate();
    await this.#syncBreakpoints();
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
    this.#breakpointsVersion++;
    this.#host.requestUpdate();
    await this.#syncBreakpoints();
  }

  /**
   * Send current breakpoints to the worker.
   */
  async #syncBreakpoints(): Promise<void> {
    const rt = this.#runtime?.runtime();
    if (!rt) return;
    try {
      await rt.setBreakpoints(Array.from(this.#breakpointIds));
    } catch (e) {
      console.error(
        "[DebuggerController] Failed to set breakpoints:",
        e,
      );
    }
  }

  /**
   * Check if an action ID has a breakpoint set.
   */
  hasBreakpoint(actionId: string): boolean {
    return this.#breakpointIds.has(actionId);
  }

  /**
   * Get all breakpoint action IDs.
   */
  getBreakpoints(): Set<string> {
    return new Set(this.#breakpointIds);
  }

  /**
   * Get breakpoints version for change detection.
   */
  getBreakpointsVersion(): number {
    return this.#breakpointsVersion;
  }

  /**
   * Get active logger flags from the worker
   */
  getActiveFlags(): LoggerFlagsData {
    return this.#activeFlags;
  }

  /**
   * Get the flags version for change detection
   */
  getFlagsVersion(): number {
    return this.#flagsVersion;
  }

  /**
   * Update active flags directly (e.g. from an existing IPC response)
   */
  updateFlags(flags: LoggerFlagsData): void {
    this.#activeFlags = flags;
    this.#flagsVersion++;
  }

  /**
   * Request fresh flags from the worker via getLoggerCounts
   */
  async requestFlags(): Promise<void> {
    if (!this.#runtime) return;

    const rt = this.#runtime.runtime();
    if (!rt) return;
    try {
      const result = await rt.getLoggerCounts();
      this.#activeFlags = result.flags;
      this.#flagsVersion++;
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
    return this.#activeFlags?.["runner"]?.[flagName]?.[id] ?? null;
  }

  //
  // Diagnosis for non-idempotent detection
  //

  /**
   * Run diagnosis and store the result.
   */
  async runDiagnosis(durationMs = 5000): Promise<void> {
    if (!this.#runtime || this.#isDiagnosing) return;

    const rt = this.#runtime.runtime();
    if (!rt) return;

    this.#isDiagnosing = true;
    this.#host.requestUpdate();

    try {
      const result = await rt.detectNonIdempotent(durationMs);
      this.#diagnosisResult = result;
      this.#diagnosisVersion++;
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

  /**
   * Get the diagnosis version for change detection.
   */
  getDiagnosisVersion(): number {
    return this.#diagnosisVersion;
  }

  /**
   * Export telemetry data as JSON
   */
  exportTelemetry(): string {
    return JSON.stringify(this.#telemetryMarkers, null, 2);
  }

  /**
   * Download telemetry data as a JSON file
   */
  downloadTelemetry() {
    const data = this.exportTelemetry();
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `telemetry-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  #handleClearTelemetry = () => {
    this.clearTelemetry();
  };
}
