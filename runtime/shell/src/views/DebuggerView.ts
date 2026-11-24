import { toIndentedDebugString } from "@commonfabric/data-model";
import type {
  LoggerMetadata,
  RuntimeTelemetryMarkerResult,
  TimingStats,
} from "@commonfabric/runtime-client";
import { css, html, LitElement, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import type { DebuggerController } from "../lib/debugger-controller.ts";
import {
  activeSubtopicCount,
  allSubtopics,
  CDF_CHART_FRAME,
  type CdfChart,
  cdfChart,
  cdfChartTooltip,
  chartedOperations,
  countsTotal,
  DEBUGGER_VALUE_OPTIONS,
  eventColor,
  eventDetails,
  eventIcon,
  filterEvents,
  formatDuration,
  formatTimestamp,
  type LoggerCounts,
  type LoggerTiming,
  mergeLoggerCounts,
  mergeLoggerTiming,
  messageCountsByTotal,
  RUN_DETAIL_OPTIONS,
  toggleAllTopics,
  toggleMember,
  toggleTopic,
  TOPIC_HIERARCHY,
  type TopicKey,
  topicState,
} from "../lib/debugger-view-model.ts";
import { ResizableDrawerController } from "../lib/resizable-drawer-controller.ts";

import "./SchedulerGraphView.ts";

import type { Logger, LoggerBreakdown } from "@commonfabric/logger";

/**
 * Shell Debugger view for monitoring RuntimeTelemetry events in real-time.
 *
 * Provides a developer tool interface showing:
 * - All telemetry events with timestamps and details
 * - Topic-based filtering for focused debugging
 * - Search functionality for event content
 * - Event expansion for detailed inspection
 * - Performance metrics and statistics
 *
 * Presented as a resizable drawer.
 */
export class XDebuggerView extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 50;
    }

    .debugger-container {
      background-color: #0f172a; /* slate-900 */
      color: white;
      box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.5);
      border-top: 1px solid #334155; /* slate-700 */
      font-size: 0.75rem;
      display: flex;
      flex-direction: column;
      transition: transform 0.3s ease-in-out;
    }

    .debugger-container[hidden] {
      transform: translateY(100%);
    }

    .resize-handle {
      height: 1.5rem;
      width: 100%;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      border-bottom: 1px solid #334155; /* slate-700 */
      flex-shrink: 0;
    }

    .resize-grip {
      width: 4rem;
      height: 0.25rem;
      background-color: #475569; /* slate-600 */
      border-radius: 9999px;
    }

    .header-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid #334155; /* slate-700 */
      background-color: #1e293b; /* slate-800 */
    }

    .title {
      font-weight: 600;
      font-size: 0.875rem;
      color: #cbd5e1; /* slate-300 */
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .title-icon {
      font-size: 1rem;
    }

    .stats {
      display: flex;
      gap: 1rem;
      font-size: 0.6875rem;
      color: #94a3b8; /* slate-400 */
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .stat-label {
      opacity: 0.7;
    }

    .stat-value {
      font-family: monospace;
      color: #cbd5e1; /* slate-300 */
    }

    .toolbar-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 1rem;
      border-bottom: 1px solid #334155; /* slate-700 */
      gap: 1rem;
    }

    .topics-filter {
      display: flex;
      gap: 0.25rem;
      flex-wrap: wrap;
    }

    .topic-button-group {
      position: relative;
      display: inline-flex;
    }

    .topic-toggle {
      padding: 0.25rem 0.5rem;
      background-color: #1e293b; /* slate-800 */
      border: 1px solid #334155; /* slate-700 */
      border-radius: 0.375rem 0 0 0.375rem;
      font-size: 0.6875rem;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 0.25rem;
      color: #64748b; /* slate-500 */
    }

    .topic-toggle:hover {
      background-color: #334155; /* slate-700 */
    }

    .topic-toggle.active {
      background-color: var(--topic-color);
      border-color: var(--topic-color);
      color: white;
      opacity: 0.9;
    }

    .topic-toggle.partial {
      background-color: var(--topic-color);
      background-image: repeating-linear-gradient(
        45deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.15) 2px,
        rgba(0, 0, 0, 0.15) 4px
      );
      border-color: var(--topic-color);
      color: white;
      opacity: 0.9;
    }

    .dropdown-trigger {
      padding: 0.25rem 0.375rem;
      background-color: #334155; /* Default gray background */
      border: 1px solid #334155; /* slate-700 */
      border-left: none;
      border-radius: 0 0.375rem 0.375rem 0;
      font-size: 0.5rem;
      cursor: pointer;
      transition: all 0.2s;
      color: #94a3b8; /* slate-400 */
    }

    .dropdown-trigger:hover {
      background-color: #475569; /* slate-600 on hover */
    }

    .topic-toggle.active + .dropdown-trigger,
    .topic-toggle.partial + .dropdown-trigger {
      border-color: var(--topic-color);
      background-color: var(--topic-color);
      filter: brightness(0.8); /* Slightly darker than main button */
      color: white;
    }

    .subtopic-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 0.25rem;
      background-color: #1e293b; /* slate-800 */
      border: 1px solid #334155; /* slate-700 */
      border-radius: 0.375rem;
      padding: 0.5rem;
      min-width: 10rem;
      z-index: 100;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    }

    .subtopic-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem;
      font-size: 0.6875rem;
      color: #cbd5e1; /* slate-300 */
      cursor: pointer;
      border-radius: 0.25rem;
    }

    .subtopic-item:hover {
      background-color: #334155; /* slate-700 */
    }

    .subtopic-checkbox {
      width: 0.875rem;
      height: 0.875rem;
      accent-color: var(--topic-color);
    }

    .topic-icon {
      font-size: 0.75rem;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .search-container {
      position: relative;
    }

    .search-input {
      width: 12rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.6875rem;
      background-color: #1e293b; /* slate-800 */
      border: 1px solid #334155; /* slate-700 */
      border-radius: 0.375rem;
      color: white;
      outline: none;
    }

    .search-input:focus {
      border-color: #3b82f6; /* blue-500 */
    }

    .search-input.has-value {
      border-color: #3b82f6; /* blue-500 */
    }

    .clear-search {
      position: absolute;
      right: 0.25rem;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: #94a3b8; /* slate-400 */
      cursor: pointer;
      padding: 0.125rem;
      line-height: 1;
    }

    .clear-search:hover {
      color: white;
    }

    .action-button {
      background-color: #334155; /* slate-700 */
      color: #94a3b8; /* slate-400 */
      border: none;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.6875rem;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .action-button:hover {
      background-color: #475569; /* slate-600 */
      color: white;
    }

    .content-area {
      flex: 1;
      overflow: auto;
      padding: 0.5rem;
      font-family: monospace;
    }

    .content-area.resizing {
      pointer-events: none;
    }

    .empty-state {
      color: #64748b; /* slate-500 */
      font-style: italic;
      text-align: center;
      padding: 2rem;
      font-size: 0.875rem;
    }

    .events-list {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .event-item {
      padding: 0.375rem 0.5rem;
      background-color: #1e293b; /* slate-800 */
      border-radius: 0.375rem;
      border: 1px solid #334155; /* slate-700 */
      transition: all 0.2s;
      cursor: pointer;
    }

    .event-item:hover {
      background-color: #334155; /* slate-700 */
      border-color: #475569; /* slate-600 */
    }

    .event-item.expanded {
      background-color: #334155; /* slate-700 */
    }

    .event-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .event-main {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      flex: 1;
    }

    .event-icon {
      font-size: 0.875rem;
      margin-top: 0.125rem;
    }

    .event-content {
      flex: 1;
      min-width: 0;
    }

    .event-type {
      font-weight: 600;
      font-size: 0.75rem;
      color: #e2e8f0; /* slate-200 */
      margin-bottom: 0.125rem;
    }

    .event-details {
      font-size: 0.6875rem;
      color: #94a3b8; /* slate-400 */
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .event-detail {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .event-detail-label {
      opacity: 0.7;
    }

    .event-detail-value {
      color: #cbd5e1; /* slate-300 */
      font-family: monospace;
    }

    .event-time {
      font-size: 0.6875rem;
      color: #64748b; /* slate-500 */
      white-space: nowrap;
    }

    .event-expanded {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background-color: #0f172a; /* slate-900 */
      border-radius: 0.25rem;
      position: relative;
    }

    .event-expanded pre {
      margin: 0;
      font-size: 0.6875rem;
      color: #cbd5e1; /* slate-300 */
      overflow: auto;
      max-height: 12rem;
    }

    .event-expanded.full-height pre {
      max-height: none;
    }

    .json-controls {
      position: absolute;
      top: 0.25rem;
      right: 0.25rem;
      display: flex;
      gap: 0.25rem;
    }

    .json-control-btn {
      background-color: #334155; /* slate-700 */
      color: white;
      border: none;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-size: 0.625rem;
      cursor: pointer;
      opacity: 0.8;
      transition: opacity 0.2s;
    }

    .json-control-btn:hover {
      opacity: 1;
      background-color: #475569; /* slate-600 */
    }

    .paused-indicator {
      background-color: #dc2626; /* red-600 */
      color: white;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.6875rem;
      font-weight: 600;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }

    .tabs-container {
      display: flex;
      gap: 0;
      border-bottom: 1px solid #334155; /* slate-700 */
      background-color: #1e293b; /* slate-800 */
      padding: 0 1rem;
    }

    .tab-button {
      padding: 0.5rem 1rem;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      font-family: monospace;
      font-size: 0.75rem;
      color: #94a3b8; /* slate-400 */
      cursor: pointer;
      transition: all 0.2s;
    }

    .tab-button:hover {
      color: #cbd5e1; /* slate-300 */
      background-color: rgba(255, 255, 255, 0.05);
    }

    .tab-button.active {
      color: #e2e8f0; /* slate-200 */
      border-bottom-color: #3b82f6; /* blue-500 */
    }

    /* Loggers pane styles */
    .loggers-toolbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem;
      border-bottom: 1px solid #334155;
      background-color: #1e293b;
    }

    .loggers-total {
      margin-left: auto;
      color: #94a3b8;
      font-family: monospace;
      font-size: 0.75rem;
    }

    .loggers-empty {
      color: #64748b;
      font-style: italic;
      text-align: center;
      padding: 2rem;
      font-size: 0.75rem;
    }

    .loggers-list {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      padding: 0.5rem;
      overflow-y: auto;
    }

    .logger-item {
      background-color: #1e293b;
      border-radius: 0.375rem;
      border: 1px solid #334155;
      overflow: hidden;
    }

    .logger-item.disabled {
      opacity: 0.5;
    }

    .logger-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.5rem;
      cursor: pointer;
      font-size: 0.75rem;
    }

    .logger-header:hover {
      background-color: #334155;
    }

    .logger-expand {
      color: #64748b;
      font-size: 0.625rem;
      width: 1rem;
      text-align: center;
    }

    .logger-name {
      color: #e2e8f0;
      font-family: monospace;
      flex: 1;
    }

    .logger-count {
      color: #94a3b8;
      font-family: monospace;
    }

    .logger-toggle {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 0.875rem;
      padding: 0 0.25rem;
    }

    .logger-toggle.on {
      color: #10b981;
    }

    .logger-toggle.off {
      color: #64748b;
    }

    .logger-controls {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      margin-left: auto;
    }

    .logger-level {
      background-color: #1e293b;
      color: #94a3b8;
      border: 1px solid #334155;
      border-radius: 3px;
      font-size: 0.625rem;
      padding: 0.125rem 0.25rem;
      cursor: pointer;
    }

    .logger-level:hover {
      border-color: #475569;
    }

    .logger-keys {
      padding: 0.25rem 0.5rem 0.5rem 1.5rem;
      border-top: 1px solid #334155;
      background-color: #0f172a;
    }

    .logger-key {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.125rem 0;
      font-size: 0.6875rem;
      font-family: monospace;
    }

    .key-name {
      color: #cbd5e1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .key-counts {
      display: flex;
      gap: 0.5rem;
      color: #64748b;
    }

    .count-debug {
      color: #6b7280;
    }

    .count-info {
      color: #10b981;
    }

    .count-warn {
      color: #eab308;
    }

    .count-error {
      color: #ef4444;
    }

    .count-total {
      color: #94a3b8;
      font-weight: 500;
    }

    /* Timing histogram styles - Tufte-inspired minimal design */
    .timing-histogram {
      margin-top: 0.5rem;
      padding: 0.5rem;
      background-color: #0f172a;
      border-radius: 0.25rem;
    }

    .timing-key-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
      font-size: 0.625rem;
      color: #94a3b8;
    }

    .timing-key-name {
      font-family: monospace;
      color: #cbd5e1;
      font-weight: 600;
    }

    .timing-stats-summary {
      display: flex;
      gap: 0.75rem;
      font-size: 0.625rem;
      color: #64748b;
    }

    .timing-tooltip {
      position: fixed;
      background-color: #1e293b;
      color: #e2e8f0;
      padding: 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      pointer-events: none;
      z-index: 1000;
      box-shadow:
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 2px 4px -1px rgba(0, 0, 0, 0.06);
      white-space: pre-line;
      max-width: 250px;
    }
  `;

  @property({ type: Boolean })
  accessor visible = false;

  @property({ attribute: false })
  accessor telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  @property({ attribute: false })
  accessor debuggerController: DebuggerController | undefined = undefined;

  @state()
  private accessor activeTab:
    | "events"
    | "scheduler"
    | "loggers"
    | "diagnosis" = "events";

  @state()
  private accessor activeSubtopics = new Set<string>();

  @state()
  private accessor loggerSample: LoggerCounts | null = null;

  @state()
  private accessor workerLoggerMetadata: LoggerMetadata | null = null;

  @state()
  private accessor loggerTimingSample: LoggerTiming | null = null;

  @state()
  private accessor expandedLoggers = new Set<string>();

  @state()
  private accessor openDropdowns = new Set<TopicKey>();

  @state()
  private accessor searchText = "";

  @state()
  private accessor expandedEvents = new Set<number>();

  @state()
  private accessor fullHeightEvents = new Set<number>();

  @state()
  private accessor isPaused = false;

  @state()
  private accessor pausedMarkers: RuntimeTelemetryMarkerResult[] = [];

  @state()
  private accessor tooltipData: {
    x: number;
    y: number;
    content: string;
    visible: boolean;
  } | null = null;

  @state()
  private accessor diagnosisDurationMs = 5000;

  #resizeController = new ResizableDrawerController(this, {
    initialHeight: 300,
    minHeight: 150,
    maxHeightFactor: 0.8,
    resizeDirection: "up",
    storageKey: "debuggerDrawerHeight",
  });

  /**
   * The worker-logger metadata, the diagnosis panel's render step, the three
   * worker-logger handlers, and the two document listeners, which a test
   * drives directly.
   */
  get accessForTestingOnly(): {
    workerLoggerMetadata: LoggerMetadata | null;
    renderDiagnosis(): TemplateResult;
    handleKeyDown(
      e: Pick<KeyboardEvent, "key" | "target" | "preventDefault">,
    ): void;
    handleDocumentClick(e: Pick<Event, "target">): void;
    resetBaseline(): Promise<void>;
    toggleLogger(name: string): Promise<void>;
    setLoggerLevel(
      name: string,
      level: "debug" | "info" | "warn" | "error",
    ): Promise<void>;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get workerLoggerMetadata() {
        return outerThis.workerLoggerMetadata;
      },
      set workerLoggerMetadata(value) {
        outerThis.workerLoggerMetadata = value;
      },
      renderDiagnosis: () => this.#renderDiagnosis(),
      handleKeyDown: this.#handleKeyDown,
      handleDocumentClick: this.#handleDocumentClick,
      resetBaseline: () => this.#resetBaseline(),
      toggleLogger: (name) => this.#toggleLogger(name),
      setLoggerLevel: (name, level) => this.#setLoggerLevel(name, level),
    };
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.#handleKeyDown);
    document.addEventListener("click", this.#handleDocumentClick);
    // Initialize with all subtopics active
    this.activeSubtopics = allSubtopics();
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.#handleKeyDown);
    document.removeEventListener("click", this.#handleDocumentClick);
    super.disconnectedCallback();
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // When new markers come in and we're not paused, update the paused markers
    if (changedProperties.has("telemetryMarkers") && !this.isPaused) {
      this.pausedMarkers = [...this.telemetryMarkers];
    }
  }

  #handleKeyDown = (
    e: Pick<KeyboardEvent, "key" | "target" | "preventDefault">,
  ) => {
    // Clear search on Escape
    if (e.key === "Escape" && this.searchText) {
      e.preventDefault();
      this.searchText = "";
    }
    // Toggle pause on Space when debugger is visible
    if (e.key === " " && this.visible && e.target === document.body) {
      e.preventDefault();
      this.#togglePause();
    }
  };

  #handleDocumentClick = (e: Pick<Event, "target">) => {
    // Close dropdowns when clicking outside
    const target = e.target as HTMLElement;
    if (!target.closest(".topic-button-group")) {
      this.openDropdowns = new Set();
    }
  };

  /**
   * Opens a topic's subtopic menu, closing any other, or closes it when it is
   * the one open.
   */
  #toggleDropdown(topicKey: TopicKey, e: Event) {
    e.stopPropagation();
    this.openDropdowns = this.openDropdowns.has(topicKey)
      ? new Set()
      : new Set([topicKey]);
  }

  #clearEvents() {
    // Dispatch event to clear telemetry in runtime
    this.dispatchEvent(
      new CustomEvent("clear-telemetry", {
        bubbles: true,
        composed: true,
      }),
    );
    // Clear local state
    this.pausedMarkers = [];
    this.expandedEvents.clear();
    this.fullHeightEvents.clear();
  }

  #togglePause() {
    this.isPaused = !this.isPaused;
    if (!this.isPaused) {
      // When unpausing, update to latest markers
      this.pausedMarkers = [...this.telemetryMarkers];
    }
  }

  /** Expands or collapses an event; collapsing also drops its full height. */
  #toggleEventExpand(index: number) {
    if (this.expandedEvents.has(index)) {
      const fullHeight = new Set(this.fullHeightEvents);
      fullHeight.delete(index);
      this.fullHeightEvents = fullHeight;
    }
    this.expandedEvents = toggleMember(this.expandedEvents, index);
  }

  async #copyJson(data: RuntimeTelemetryMarkerResult) {
    try {
      const jsonString = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(jsonString);
    } catch (err) {
      console.error("Failed to copy JSON:", err);
    }
  }

  /** The events the filters keep, from the frozen list while paused. */
  #filteredEvents(): RuntimeTelemetryMarkerResult[] {
    return filterEvents(
      this.isPaused ? this.pausedMarkers : this.telemetryMarkers,
      this.activeSubtopics,
      this.searchText,
    );
  }

  #getLoggerRegistry(): Record<string, Logger> {
    const global = globalThis as unknown as {
      commonfabric?: { logger?: Record<string, Logger> };
    };
    return global.commonfabric?.logger ?? {};
  }

  #getLoggerBreakdown(): LoggerCounts {
    const global = globalThis as unknown as {
      commonfabric?: { getLoggerCountsBreakdown?: () => LoggerCounts };
    };
    return global.commonfabric?.getLoggerCountsBreakdown?.() ?? { total: 0 };
  }

  async #getWorkerLoggerBreakdown(): Promise<{
    counts: LoggerCounts | null;
    timing: LoggerTiming | null;
  }> {
    const runtime = this.debuggerController?.getRuntime();
    if (!runtime) return { counts: null, timing: null };
    const rt = runtime.runtime();
    if (!rt) return { counts: null, timing: null };
    try {
      const result = await rt.getLoggerCounts();
      this.workerLoggerMetadata = result.metadata;
      // Also push flags to the debugger controller (piggyback on existing IPC call)
      if (result.flags && this.debuggerController) {
        this.debuggerController.updateFlags(result.flags);
      }
      return { counts: result.counts, timing: result.timing };
    } catch {
      return { counts: null, timing: null };
    }
  }

  #getLoggerTiming(): LoggerTiming {
    const global = globalThis as unknown as {
      commonfabric?: { getTimingStatsBreakdown?: () => LoggerTiming };
    };
    return global.commonfabric?.getTimingStatsBreakdown?.() ?? {};
  }

  async #sampleLoggerCounts(): Promise<void> {
    const mainCounts = this.#getLoggerBreakdown();
    const workerResult = await this.#getWorkerLoggerBreakdown();
    this.loggerSample = mergeLoggerCounts(mainCounts, workerResult.counts);

    // Merge timing data
    const mainTiming = this.#getLoggerTiming();
    this.loggerTimingSample = mergeLoggerTiming(
      mainTiming,
      workerResult.timing,
    );
  }

  async #resetBaseline(): Promise<void> {
    // Reset counts baseline
    const global = globalThis as unknown as {
      commonfabric?: {
        resetAllCountBaselines?: () => void;
        resetAllTimingBaselines?: () => void;
      };
    };
    global.commonfabric?.resetAllCountBaselines?.();
    global.commonfabric?.resetAllTimingBaselines?.();

    // Reset in worker via IPC
    const runtime = this.debuggerController?.getRuntime();
    const rt = runtime?.runtime();
    try {
      if (rt) {
        await rt.resetLoggerBaselines();
      }
      // Sample to get fresh data
      await this.#sampleLoggerCounts();
    } catch (error) {
      // A disposal race (logout, runtime swap) cancels the op; that is
      // cancellation, not a failure — and this runs fire-and-forget, so an
      // un-caught rejection would surface as an unhandled rejection.
      if (rt?.signal.aborted) return;
      console.error("[DebuggerView] Failed to reset logger baselines:", error);
    }
  }

  async #toggleLogger(name: string): Promise<void> {
    const registry = this.#getLoggerRegistry();
    const logger = registry[name];
    if (logger) {
      // Local logger - toggle directly
      logger.disabled = !logger.disabled;
      this.requestUpdate();
    } else if (this.workerLoggerMetadata?.[name]) {
      // Worker logger - use IPC
      const currentEnabled = this.workerLoggerMetadata[name].enabled;
      const runtime = this.debuggerController?.getRuntime();
      const rt = runtime?.runtime();
      if (rt) {
        try {
          await rt.setLoggerEnabled(!currentEnabled, name);
          // Refresh metadata
          await this.#sampleLoggerCounts();
        } catch (error) {
          // A disposal race cancels the op (fire-and-forget — an un-caught
          // rejection would surface as an unhandled rejection).
          if (rt.signal.aborted) return;
          console.error(
            "[DebuggerView] Failed to toggle worker logger:",
            error,
          );
        }
      }
    }
  }

  async #setLoggerLevel(
    name: string,
    level: "debug" | "info" | "warn" | "error",
  ): Promise<void> {
    const registry = this.#getLoggerRegistry();
    const logger = registry[name];
    if (logger) {
      // Local logger - set directly
      logger.level = level;
      this.requestUpdate();
    } else if (this.workerLoggerMetadata?.[name]) {
      // Worker logger - use IPC
      const runtime = this.debuggerController?.getRuntime();
      const rt = runtime?.runtime();
      if (rt) {
        try {
          await rt.setLoggerLevel(level, name);
          // Refresh metadata
          await this.#sampleLoggerCounts();
        } catch (error) {
          // A disposal race cancels the op (fire-and-forget — an un-caught
          // rejection would surface as an unhandled rejection).
          if (rt.signal.aborted) return;
          console.error(
            "[DebuggerView] Failed to set worker logger level:",
            error,
          );
        }
      }
    }
  }

  #toggleExpandLogger(name: string): void {
    this.expandedLoggers = toggleMember(this.expandedLoggers, name);
  }

  #renderTimingHistogram(
    timingData: Record<string, TimingStats>,
  ): TemplateResult {
    if (Object.keys(timingData).length === 0) {
      return html`
      `;
    }

    return html`
      <div class="timing-histogram">
        ${chartedOperations(timingData).map(([key, stats]) =>
          this.#renderCDFForKey(key, stats)
        )}
      </div>
    `;
  }

  /** Shows the tooltip for the chart point under the pointer, if any. */
  #handleChartMouseMove(e: MouseEvent, chart: CdfChart): void {
    const svg = e.currentTarget as SVGElement;
    const rect = svg.getBoundingClientRect();
    const content = cdfChartTooltip(
      chart,
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
    );
    this.tooltipData = content === null ? null : {
      x: e.clientX + 10,
      y: e.clientY - 10,
      content,
      visible: true,
    };
  }

  #renderCDFForKey(
    key: string,
    stats: TimingStats,
  ): TemplateResult {
    const chart = cdfChart(stats);
    const { width, height, margin } = CDF_CHART_FRAME;
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const chartId = `cdf-${key.replace(/\//g, "-")}`;
    const showBaselineLegend = (chart.baselinePoints?.length ?? 0) > 0;

    // Percentile positions (normalized 0-1)
    const p50Position = 0.5; // Always at 50% by definition
    const p95Position = 0.95; // Always at 95% by definition

    return html`
      <div style="margin-bottom: 1rem;">
        <div class="timing-key-header">
          <span class="timing-key-name">${key}</span>
          <div class="timing-stats-summary">
            <span>n=${stats.count}</span>
            <span>p50=${formatDuration(stats.p50)}</span>
            <span>p95=${formatDuration(stats.p95)}</span>
            <span>avg=${formatDuration(stats.average)}</span>
          </div>
        </div>

        <svg
          id="${chartId}"
          width="${width}"
          height="${height}"
          style="background-color: #0f172a; border-radius: 0.25rem; cursor: crosshair;"
          @mousemove="${(e: MouseEvent) =>
            this.#handleChartMouseMove(e, chart)}"
          @mouseleave="${() => this.tooltipData = null}"
        >
          <!-- Y-axis grid lines and labels -->
          ${chart.yTicks.map((y) => {
            const yPos = chart.y(y);
            return html`
              <line
                x1="${margin.left}"
                y1="${yPos}"
                x2="${width - margin.right}"
                y2="${yPos}"
                stroke="#334155"
                stroke-width="1"
                opacity="0.3"
              />
              <text
                x="${margin.left - 8}"
                y="${yPos + 1}"
                text-anchor="end"
                dominant-baseline="middle"
                fill="#e2e8f0"
                font-size="10"
                font-family="monospace"
              >
                ${formatDuration(y)}
              </text>
            `;
          })}

          <!-- X-axis grid lines and labels -->
          ${chart.xTicks.map((x) => {
            const xPos = chart.x(x);
            return html`
              <line
                x1="${xPos}"
                y1="${margin.top}"
                x2="${xPos}"
                y2="${height - margin.bottom}"
                stroke="#334155"
                stroke-width="1"
                opacity="0.3"
              />
              <text
                x="${xPos}"
                y="${height - margin.bottom + 18}"
                text-anchor="middle"
                fill="#e2e8f0"
                font-size="10"
                font-family="monospace"
              >
                ${Math.round(x * 100)}%
              </text>
            `;
          })}

          <!-- Axes with tick marks -->
          <line
            x1="${margin.left}"
            y1="${height - margin.bottom}"
            x2="${width - margin.right}"
            y2="${height - margin.bottom}"
            stroke="#cbd5e1"
            stroke-width="2"
          />
          <line
            x1="${margin.left}"
            y1="${margin.top}"
            x2="${margin.left}"
            y2="${height - margin.bottom}"
            stroke="#cbd5e1"
            stroke-width="2"
          />

          <!-- X-axis ticks -->
          ${chart.xTicks.map((x) => {
            const xPos = chart.x(x);
            return html`
              <line
                x1="${xPos}"
                y1="${height - margin.bottom}"
                x2="${xPos}"
                y2="${height - margin.bottom + 6}"
                stroke="#e2e8f0"
                stroke-width="2"
              />
            `;
          })}

          <!-- Y-axis ticks -->
          ${chart.yTicks.map((y) => {
            const yPos = chart.y(y);
            return html`
              <line
                x1="${margin.left - 6}"
                y1="${yPos}"
                x2="${margin.left}"
                y2="${yPos}"
                stroke="#e2e8f0"
                stroke-width="2"
              />
            `;
          })}

          <!-- Cumulative time curve (all samples since start) - blue -->
          <path
            d="${chart.path}"
            fill="none"
            stroke="#3b82f6"
            stroke-width="2"
            opacity="0.8"
            style="pointer-events: stroke;"
          >
            <title>Total: ${stats.count} samples, ${formatDuration(
              stats.totalTime,
            )} cumulative</title>
          </path>

          <!-- Cumulative time delta curve (since baseline) - green -->
          <path
            d="${chart.baselinePath || ""}"
            fill="none"
            stroke="#10b981"
            stroke-width="2"
            opacity="0.8"
            style="pointer-events: stroke; ${chart.baselinePath
              ? ""
              : "display: none;"}"
          >
            <title>Since baseline</title>
          </path>

          <!-- Percentile reference lines (p50, p95) - render AFTER curves -->
          <g style="pointer-events: stroke;">
            <line
              x1="${chart.x(p50Position)}"
              y1="${margin.top}"
              x2="${chart.x(p50Position)}"
              y2="${height - margin.bottom}"
              stroke="#f59e0b"
              stroke-width="1.5"
              stroke-dasharray="4,2"
              opacity="0.7"
            >
              <title>p50 (median): ${formatDuration(stats.p50)}</title>
            </line>
            <text
              x="${chart.x(p50Position)}"
              y="${margin.top - 4}"
              text-anchor="middle"
              fill="#f59e0b"
              font-size="8"
              font-weight="600"
              style="pointer-events: none;"
            >
              <tspan x="${chart.x(p50Position)}" dy="0">p50</tspan>
              <tspan x="${chart.x(p50Position)}" dy="10">${formatDuration(
                stats.p50,
              )}</tspan>
            </text>
          </g>

          <g style="pointer-events: stroke;">
            <line
              x1="${chart.x(p95Position)}"
              y1="${margin.top}"
              x2="${chart.x(p95Position)}"
              y2="${height - margin.bottom}"
              stroke="#ef4444"
              stroke-width="1.5"
              stroke-dasharray="4,2"
              opacity="0.7"
            >
              <title>p95: ${formatDuration(stats.p95)}</title>
            </line>
            <text
              x="${chart.x(p95Position)}"
              y="${margin.top - 4}"
              text-anchor="middle"
              fill="#ef4444"
              font-size="8"
              font-weight="600"
              style="pointer-events: none;"
            >
              <tspan x="${chart.x(p95Position)}" dy="0">p95</tspan>
              <tspan x="${chart.x(p95Position)}" dy="10">${formatDuration(
                stats.p95,
              )}</tspan>
            </text>
          </g>

          <!-- Average reference line -->
          <g style="pointer-events: stroke;">
            <line
              x1="${chart.x(chart.averagePosition)}"
              y1="${margin.top}"
              x2="${chart.x(chart.averagePosition)}"
              y2="${height - margin.bottom}"
              stroke="#8b5cf6"
              stroke-width="1.5"
              stroke-dasharray="4,2"
              opacity="0.5"
            >
              <title>avg (mean): ${formatDuration(stats.average)}</title>
            </line>
            <text
              x="${chart.x(chart.averagePosition)}"
              y="${margin.top - 4}"
              text-anchor="middle"
              fill="#8b5cf6"
              font-size="8"
              font-weight="600"
              style="pointer-events: none;"
            >
              <tspan x="${chart.x(chart.averagePosition)}" dy="0">avg</tspan>
              <tspan x="${chart.x(
                chart.averagePosition,
              )}" dy="10">${formatDuration(
                stats.average,
              )}</tspan>
            </text>
          </g>

          <!-- Axis labels -->
          <text
            x="${margin.left + plotWidth / 2}"
            y="${height - 5}"
            text-anchor="middle"
            fill="#e2e8f0"
            font-size="12"
            font-weight="600"
          >
            Events
          </text>
          <text
            x="${margin.left - 40}"
            y="${margin.top + plotHeight / 2}"
            text-anchor="middle"
            fill="#e2e8f0"
            font-size="12"
            font-weight="600"
            transform="rotate(-90 ${margin.left - 40} ${margin.top +
              plotHeight / 2})"
          >
            Cumulative Time
          </text>

          <!-- Legend -->
          <g transform="translate(${margin.left + 10}, ${margin.top + 10})">
            <line x1="0" y1="0" x2="20" y2="0" stroke="#3b82f6" stroke-width="2" />
            <text
              x="25"
              y="0"
              dominant-baseline="middle"
              fill="#cbd5e1"
              font-size="10"
            >
              All time (${(chart.maxTime / 1000).toFixed(
                2,
              )}s in ${chart.points.length} samples)
            </text>
            <line
              x1="0"
              y1="15"
              x2="20"
              y2="15"
              stroke="#10b981"
              stroke-width="2"
              style="${showBaselineLegend ? "" : "display: none;"}"
            />
            <text
              x="25"
              y="15"
              dominant-baseline="middle"
              fill="#cbd5e1"
              font-size="10"
              style="${showBaselineLegend ? "" : "display: none;"}"
            >
              Since baseline (${showBaselineLegend
                ? `${
                  (chart.maxBaselineTime / 1000).toFixed(2)
                }s in ${chart.baselinePoints?.length} samples`
                : ""})
            </text>
          </g>
        </svg>
      </div>
    `;
  }

  #renderLoggers(): TemplateResult {
    const sample = this.loggerSample ?? this.#getLoggerBreakdown();
    const registry = this.#getLoggerRegistry();
    const loggerNames = Object.keys(sample).filter((k) => k !== "total");

    if (loggerNames.length === 0) {
      return html`
        <div class="loggers-empty">
          No loggers registered yet.
        </div>
      `;
    }

    return html`
      <div class="loggers-toolbar">
        <button
          type="button"
          class="action-button"
          @click="${() => this.#resetBaseline()}"
          title="Reset baseline to current counts"
        >
          Reset Baseline
        </button>
        <button
          type="button"
          class="action-button"
          @click="${() => this.#sampleLoggerCounts()}"
          title="Sample current counts"
        >
          Sample
        </button>
        <span class="loggers-total">
          Total: ${countsTotal(sample)}
        </span>
      </div>
      <div class="loggers-list">
        ${loggerNames.map((name) => {
          const loggerData = sample[name] as LoggerBreakdown;
          const logger = registry[name];
          const workerMeta = this.workerLoggerMetadata?.[name];
          const isExpanded = this.expandedLoggers.has(name);
          // Use local registry first, fall back to worker metadata
          const isDisabled = logger
            ? logger.disabled
            : workerMeta
            ? !workerMeta.enabled
            : false;
          const currentLevel = logger?.level ?? workerMeta?.level ?? "info";
          const timing = this.loggerTimingSample?.[name];

          return html`
            <div class="logger-item ${isDisabled ? "disabled" : ""}">
              <div class="logger-header" @click="${() =>
                this.#toggleExpandLogger(name)}">
                <span class="logger-expand">${isExpanded ? "▼" : "▶"}</span>
                <span class="logger-name">${name}</span>
                <span class="logger-count">
                  ${loggerData.total}
                </span>
                <span class="logger-controls" @click="${(e: Event) =>
                  e.stopPropagation()}">
                  <select
                    class="logger-level"
                    .value="${currentLevel}"
                    @change="${(e: Event) => {
                      const select = e.target as HTMLSelectElement;
                      this.#setLoggerLevel(
                        name,
                        select.value as "debug" | "info" | "warn" | "error",
                      );
                    }}"
                    title="Minimum log level for console output"
                  >
                    <option value="debug" ?selected="${currentLevel ===
                      "debug"}">debug</option>
                    <option value="info" ?selected="${currentLevel ===
                      "info"}">info</option>
                    <option value="warn" ?selected="${currentLevel ===
                      "warn"}">warn</option>
                    <option value="error" ?selected="${currentLevel ===
                      "error"}">error</option>
                  </select>
                  <button
                    type="button"
                    class="logger-toggle ${isDisabled ? "off" : "on"}"
                    @click="${() => this.#toggleLogger(name)}"
                    title="${isDisabled
                      ? "Logger disabled - click to enable"
                      : "Logger enabled - click to disable"}"
                  >
                    ${isDisabled ? "○" : "●"}
                  </button>
                </span>
              </div>
              ${isExpanded
                ? html`
                  <div class="logger-keys">
                    ${messageCountsByTotal(loggerData).map(([key, c]) =>
                      html`
                        <div class="logger-key">
                          <span class="key-name">${key}</span>
                          <span class="key-counts">
                            <span class="count-debug" title="debug">${c
                              .debug}</span>
                            <span class="count-info" title="info">${c
                              .info}</span>
                            <span class="count-warn" title="warn">${c
                              .warn}</span>
                            <span class="count-error" title="error">${c
                              .error}</span>
                            <span class="count-total">
                              = ${c.total}
                            </span>
                          </span>
                        </div>
                      `
                    )}
                  </div>

                  ${timing ? this.#renderTimingHistogram(timing) : ""}
                `
                : ""}
            </div>
          `;
        })}
      </div>
    `;
  }

  #renderTabs() {
    return html`
      <div class="tabs-container">
        <button
          type="button"
          class="tab-button ${this.activeTab === "events" ? "active" : ""}"
          @click="${() => this.activeTab = "events"}"
        >
          Events
        </button>
        <button
          type="button"
          class="tab-button ${this.activeTab === "scheduler" ? "active" : ""}"
          @click="${() => {
            this.activeTab = "scheduler";
            // Request a fresh snapshot when tab is opened
            this.debuggerController?.requestGraphSnapshot();
          }}"
        >
          Scheduler
        </button>
        <button
          type="button"
          class="tab-button ${this.activeTab === "loggers" ? "active" : ""}"
          @click="${() => {
            this.activeTab = "loggers";
            // Sample current counts when tab is opened. The sample is
            // returned, as the toolbar's buttons return theirs, so that a
            // caller can wait for the counts to arrive.
            return this.#sampleLoggerCounts();
          }}"
        >
          Loggers
        </button>
        <button
          type="button"
          class="tab-button ${this.activeTab === "diagnosis" ? "active" : ""}"
          @click="${() => this.activeTab = "diagnosis"}"
        >
          Diagnosis
        </button>
      </div>
    `;
  }

  #renderDiagnosis(): TemplateResult {
    const isDiagnosing = this.debuggerController?.getIsDiagnosing() ?? false;
    const result = this.debuggerController?.getDiagnosisResult() ?? null;

    return html`
      <div style="padding: 0.5rem;">
        <!-- Controls -->
        <div
          style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;"
        >
          <label
            style="display: flex; align-items: center; gap: 0.375rem; color: #94a3b8; font-size: 0.75rem;"
          >
            <span>Duration</span>
            <select
              style="background-color: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 0.25rem; padding: 0.25rem 0.375rem;"
              .value="${String(this.diagnosisDurationMs)}"
              @change="${(event: Event) => {
                const value = Number(
                  (event.target as HTMLSelectElement).value,
                );
                this.diagnosisDurationMs = Number.isFinite(value) && value > 0
                  ? value
                  : 5000;
              }}"
              ?disabled="${isDiagnosing}"
            >
              <option value="3000">3s</option>
              <option value="5000">5s</option>
              <option value="10000">10s</option>
            </select>
          </label>
          <button
            type="button"
            class="action-button"
            style="${isDiagnosing
              ? "background-color: #dc2626; color: white;"
              : "background-color: #3b82f6; color: white;"}"
            @click="${() => {
              if (!isDiagnosing) {
                this.debuggerController?.runDiagnosis(this.diagnosisDurationMs);
              }
            }}"
            ?disabled="${isDiagnosing}"
          >
            ${isDiagnosing ? "Diagnosing..." : "Run Diagnosis"}
          </button>
          ${isDiagnosing
            ? html`
              <span style="color: #eab308; font-size: 0.75rem;">Capturing data...</span>
            `
            : ""}
        </div>

        ${result
          ? html`
            <!-- Summary -->
            <div style="margin-bottom: 1rem; font-size: 0.75rem; color: #94a3b8;">
              Duration: ${(result.duration / 1000).toFixed(
                1,
              )}s | Non-idempotent: ${result.nonIdempotent
                .length} | Cycles: ${result.cycles.length}
            </div>

            <!-- Non-Idempotent Actions -->
            ${result.nonIdempotent.length > 0
              ? html`
                <div style="margin-bottom: 1rem;">
                  <div
                    style="font-weight: 600; color: #ef4444; margin-bottom: 0.5rem; font-size: 0.8125rem;"
                  >
                    Non-Idempotent Actions
                  </div>
                  ${result.nonIdempotent.map(
                    (report) =>
                      html`
                        <div
                          style="background-color: #1e293b; border: 1px solid #7f1d1d; border-radius: 0.375rem; padding: 0.5rem; margin-bottom: 0.375rem;"
                        >
                          <div
                            style="font-family: monospace; color: #fca5a5; font-size: 0.75rem; margin-bottom: 0.25rem;"
                          >
                            ${report.actionId}
                          </div>
                          ${report.actionInfo?.patternName
                            ? html`
                              <div style="color: #94a3b8; font-size: 0.6875rem; margin-bottom: 0.25rem;">
                                Pattern: ${report.actionInfo.patternName}
                              </div>
                            `
                            : ""}
                          <div style="color: #fbbf24; font-size: 0.6875rem;">
                            Differing writes: ${report.differingWriteKeys.join(
                              ", ",
                            )}
                          </div>
                          <details style="margin-top: 0.375rem;">
                            <summary style="cursor: pointer; color: #64748b; font-size: 0.625rem;">
                              Show run details
                            </summary>
                            <pre
                              style="margin: 0.25rem 0 0; font-size: 0.625rem; color: #cbd5e1; overflow: auto; max-height: 8rem;"
                            >${toIndentedDebugString(
                              report.runs,
                              RUN_DETAIL_OPTIONS,
                            )}</pre>
                          </details>
                        </div>
                      `,
                  )}
                </div>
              `
              : html`
                <div style="color: #10b981; margin-bottom: 1rem; font-size: 0.75rem;">
                  No non-idempotent actions detected.
                </div>
              `}

            <!-- Cycles -->
            ${result.cycles.length > 0
              ? html`
                <div>
                  <div
                    style="font-weight: 600; color: #eab308; margin-bottom: 0.5rem; font-size: 0.8125rem;"
                  >
                    Causal Cycles
                  </div>
                  ${result.cycles.map(
                    (cycle) =>
                      html`
                        <div
                          style="background-color: #1e293b; border: 1px solid #854d0e; border-radius: 0.375rem; padding: 0.5rem; margin-bottom: 0.375rem;"
                        >
                          <div style="font-family: monospace; font-size: 0.6875rem; color: #fde68a;">
                            ${cycle.cycle
                              .map((step) =>
                                `${step.actionId} --[${step.writesCell}]-->`
                              )
                              .join(" ")} ${cycle.cycle[0]?.actionId ?? ""}
                          </div>
                        </div>
                      `,
                  )}
                </div>
              `
              : html`
                <div style="color: #10b981; font-size: 0.75rem;">
                  No causal cycles detected.
                </div>
              `}
          `
          : html`
            <div class="empty-state">
              Run a diagnosis to detect non-idempotent computations and causal cycles.
              <br><br>
              The diagnosis captures read/write values for each action and tracks causal
              chains between actions. Actions that produce different outputs for the same
              inputs are flagged as non-idempotent.
              <br><br>
              You can also run from the console:
              <code style="display: block; margin-top: 0.5rem; color: #3b82f6;">
                await commonfabric.detectNonIdempotent(5000)
              </code>
            </div>
          `}
      </div>
    `;
  }

  #renderEvents() {
    const events = this.#filteredEvents();

    if (events.length === 0) {
      return html`
        <div class="empty-state">
          ${this.searchText || this.activeSubtopics.size === 0
            ? "No events matching filters"
            : "No telemetry events yet"}
        </div>
      `;
    }

    // Show newest first
    const reversedEvents = [...events].reverse();

    return html`
      <div class="events-list">
        ${reversedEvents.map((marker, index) => {
          const actualIndex = events.length - 1 - index;
          const isExpanded = this.expandedEvents.has(actualIndex);
          const color = eventColor(marker.type);

          return html`
            <div
              class="event-item ${isExpanded ? "expanded" : ""}"
              @click="${() => this.#toggleEventExpand(actualIndex)}"
            >
              <div class="event-header">
                <div class="event-main">
                  <span class="event-icon" style="color: ${color}">
                    ${eventIcon(marker.type)}
                  </span>
                  <div class="event-content">
                    <div class="event-type">${marker.type}</div>
                    <div class="event-details">
                      ${eventDetails(marker).map(({ label, value, isError }) =>
                        html`
                          <div class="event-detail">
                            <span class="event-detail-label">${label}:</span>
                            <span class="event-detail-value" style="${isError
                              ? "color: #ef4444;"
                              : ""}">${value}</span>
                          </div>
                        `
                      )}
                    </div>
                  </div>
                </div>
                <div class="event-time">
                  ${formatTimestamp(marker.timeStamp)}
                </div>
              </div>

              ${isExpanded
                ? html`
                  <div class="event-expanded ${this.fullHeightEvents.has(
                      actualIndex,
                    )
                    ? "full-height"
                    : ""}">
                    <div class="json-controls">
                      <button
                        type="button"
                        class="json-control-btn"
                        @click="${(e: Event) => {
                          e.stopPropagation();
                          this.fullHeightEvents = toggleMember(
                            this.fullHeightEvents,
                            actualIndex,
                          );
                        }}"
                      >
                        ${this.fullHeightEvents.has(actualIndex)
                          ? "Collapse"
                          : "Expand"}
                      </button>
                      <button
                        type="button"
                        class="json-control-btn"
                        title="Copy full untruncated JSON to clipboard"
                        @click="${(e: Event) => {
                          e.stopPropagation();
                          this.#copyJson(marker);
                        }}"
                      >
                        Copy Full
                      </button>
                    </div>
                    <pre>${toIndentedDebugString(
                      marker,
                      DEBUGGER_VALUE_OPTIONS,
                    )}</pre>
                  </div>
                `
                : ""}
            </div>
          `;
        })}
      </div>
    `;
  }

  override render() {
    const containerStyle = `height: ${this.#resizeController.drawerHeight}px`;
    const allEvents = this.isPaused
      ? this.pausedMarkers
      : this.telemetryMarkers;
    const filteredCount = this.visible ? this.#filteredEvents().length : 0;

    return html`
      ${this.visible
        ? html`
          <div class="debugger-container" style="${containerStyle}">
            <div
              class="resize-handle"
              @mousedown="${this.#resizeController.handleResizeStart}"
              @touchstart="${this.#resizeController.handleTouchResizeStart}"
            >
              <div class="resize-grip"></div>
            </div>

            <div class="header-container">
              <div class="title">
                <span class="title-icon">🐛</span>
                Shell Debugger ${this.isPaused
                  ? html`
                    <span class="paused-indicator">PAUSED</span>
                  `
                  : ""}
              </div>
              <div class="stats">
                <div class="stat">
                  <span class="stat-label">Events:</span>
                  <span class="stat-value">${filteredCount} / ${allEvents
                    .length}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Filters:</span>
                  <span class="stat-value">${this.activeSubtopics.size}</span>
                </div>
              </div>
            </div>

            ${this.#renderTabs()} ${this.activeTab === "scheduler"
              ? html`
                <x-scheduler-graph
                  .debuggerController="${this.debuggerController}"
                  .patternSourcesVersion="${this.debuggerController
                    ?.getPatternSourcesVersion() ?? 0}"
                  style="flex: 1; min-height: 0;"
                ></x-scheduler-graph>
              `
              : this.activeTab === "loggers"
              ? html`
                <div class="content-area ${this.#resizeController.isResizing
                  ? "resizing"
                  : ""}">
                  ${this.#renderLoggers()}
                </div>
              `
              : this.activeTab === "diagnosis"
              ? html`
                <div class="content-area ${this.#resizeController.isResizing
                  ? "resizing"
                  : ""}">
                  ${this.#renderDiagnosis()}
                </div>
              `
              : html`
                <div class="toolbar-container">
                  <div class="topics-filter">
                    ${Object.entries(TOPIC_HIERARCHY).map(([key, topic]) => {
                      const topicKey = key as TopicKey;
                      const state = topicState(this.activeSubtopics, topicKey);
                      const isDropdownOpen = this.openDropdowns.has(topicKey);

                      return html`
                        <div class="topic-button-group">
                          <button
                            type="button"
                            class="topic-toggle ${state}"
                            style="--topic-color: ${topic.color}"
                            @click="${() =>
                              this.activeSubtopics = toggleTopic(
                                this.activeSubtopics,
                                topicKey,
                              )}"
                            title="${topic.label}"
                          >
                            <span class="topic-icon">${topic.icon}</span>
                            ${topic.label} ${state === "partial"
                              ? html`
                                <span style="font-size: 0.5rem; opacity: 0.7; margin-left: 0.25rem;">
                                  ${activeSubtopicCount(
                                    this.activeSubtopics,
                                    topicKey,
                                  )}/${Object.keys(topic.subtopics).length}
                                </span>
                              `
                              : ""}
                          </button>
                          <button
                            type="button"
                            class="dropdown-trigger"
                            style="--topic-color: ${topic.color}"
                            @click="${(e: Event) =>
                              this.#toggleDropdown(topicKey, e)}"
                            title="Filter subtopics"
                          >
                            ${isDropdownOpen ? "▲" : "▼"}
                          </button>
                          ${isDropdownOpen
                            ? html`
                              <div class="subtopic-dropdown" style="--topic-color: ${topic
                                .color}">
                                ${Object.entries(topic.subtopics).map(
                                  ([subKey, subtopic]) => {
                                    const fullKey = `${topicKey}.${subKey}`;
                                    const isChecked = this.activeSubtopics
                                      .has(
                                        fullKey,
                                      );
                                    return html`
                                      <label class="subtopic-item">
                                        <input
                                          type="checkbox"
                                          class="subtopic-checkbox"
                                          .checked="${isChecked}"
                                          @change="${(e: Event) => {
                                            e.stopPropagation();
                                            this.activeSubtopics = toggleMember(
                                              this.activeSubtopics,
                                              fullKey,
                                            );
                                          }}"
                                          @click="${(e: Event) =>
                                            e.stopPropagation()}"
                                        />
                                        ${subtopic.label}
                                      </label>
                                    `;
                                  },
                                )}
                              </div>
                            `
                            : ""}
                        </div>
                      `;
                    })}
                    <button
                      type="button"
                      class="action-button ${this.debuggerController
                          ?.isTelemetryEnabled()
                        ? "on"
                        : "off"}"
                      @click="${() =>
                        this.debuggerController?.toggleTelemetry()}"
                      title="${this.debuggerController?.isTelemetryEnabled()
                        ? "Telemetry ON - click to disable"
                        : "Telemetry OFF - click to enable"}"
                      style="margin-left: 0.5rem;"
                    >
                      ${this.debuggerController?.isTelemetryEnabled()
                        ? "●"
                        : "○"} Telemetry
                    </button>
                  </div>

                  <div class="controls">
                    <div class="search-container">
                      <input
                        type="text"
                        placeholder="Search events..."
                        class="search-input ${this.searchText
                          ? "has-value"
                          : ""}"
                        .value="${this.searchText}"
                        @input="${(e: Event) =>
                          this.searchText =
                            (e.target as HTMLInputElement).value}"
                      />
                      ${this.searchText
                        ? html`
                          <button
                            type="button"
                            class="clear-search"
                            @click="${() => this.searchText = ""}"
                          >
                            ×
                          </button>
                        `
                        : ""}
                    </div>

                    <button
                      type="button"
                      class="action-button"
                      @click="${() => this.activeSubtopics = toggleAllTopics(
                        this.activeSubtopics,
                      )}"
                      title="Toggle all topics"
                    >
                      ${this.activeSubtopics.size > 0 ? "☐" : "☑"}
                    </button>

                    <button
                      type="button"
                      class="action-button"
                      @click="${() => this.#togglePause()}"
                      title="${this.isPaused ? "Resume" : "Pause"} (Space)"
                    >
                      ${this.isPaused ? "▶" : "⏸"}
                    </button>

                    <button
                      type="button"
                      class="action-button"
                      @click="${() => this.#clearEvents()}"
                      title="Clear events"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div class="content-area ${this.#resizeController.isResizing
                  ? "resizing"
                  : ""}">
                  ${this.#renderEvents()}
                </div>
              `}
          </div>

          <!-- Tooltip -->
          ${this.tooltipData
            ? html`
              <div
                class="timing-tooltip"
                style="left: ${this.tooltipData.x}px; top: ${this.tooltipData
                  .y}px;"
              >
                ${this.tooltipData.content}
              </div>
            `
            : ""}
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-debugger-view", XDebuggerView);
