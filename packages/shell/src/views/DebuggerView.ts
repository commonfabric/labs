import {
  type DebugValueOptions,
  toCompactDebugString,
  toIndentedDebugString,
} from "@commonfabric/data-model";
import type {
  LoggerMetadata,
  RuntimeTelemetryMarkerResult,
  TimingStats,
} from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { css, html, LitElement, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import type { DebuggerController } from "../lib/debugger-controller.ts";
import { ResizableDrawerController } from "../lib/resizable-drawer-controller.ts";

import "./SchedulerGraphView.ts";

import type { Logger, LoggerBreakdown } from "@commonfabric/utils/logger";

/**
 * Rendering options for a value shown in the debugger: a bounded glimpse on
 * every axis, since a marker can hold anything a cell can and the search
 * renders every marker on each keystroke. The replacer keeps an action's
 * metadata, which it carries as enumerable properties on the function.
 */
const DEBUGGER_VALUE_OPTIONS: DebugValueOptions = {
  maxDepth: 3,
  maxArrayLength: 5,
  maxProperties: 20,
  maxStringLength: 200,
  replacer: (value) => {
    if (typeof value === "function") {
      return { name: value.name || "[anonymous]", ...value };
    }
    return value;
  },
};

/**
 * Rendering options for the runs of a non-idempotent report. The panel is an
 * inspector, so every run and every cell a run read or wrote is shown, deep
 * enough to reach the values; a long string, or a value nested past the
 * depth, is still cut.
 */
const RUN_DETAIL_OPTIONS: DebugValueOptions = {
  ...DEBUGGER_VALUE_OPTIONS,
  maxDepth: 6,
  maxArrayLength: Infinity,
  maxProperties: Infinity,
};

/**
 * Hierarchical topic definitions for filtering telemetry events.
 * Topics can have subtopics for more granular filtering.
 */
export const TOPIC_HIERARCHY = {
  scheduler: {
    label: "Scheduler",
    icon: "⚙️",
    color: "#3b82f6", // blue
    subtopics: {
      run: { label: "Run", pattern: "scheduler.run" },
      invocation: { label: "Invocation", pattern: "scheduler.invocation" },
    },
  },
  storage: {
    label: "Storage",
    icon: "💾",
    color: "#10b981", // green
    subtopics: {
      push: { label: "Push", pattern: "storage.push" },
      pull: { label: "Pull", pattern: "storage.pull" },
    },
  },
  cells: {
    label: "Cells",
    icon: "📝",
    color: "#8b5cf6", // violet
    subtopics: {
      update: { label: "Update", pattern: "cell.update" },
    },
  },
} as const;

export type TopicKey = keyof typeof TOPIC_HIERARCHY;
export type SubtopicKey<T extends TopicKey> =
  keyof typeof TOPIC_HIERARCHY[T]["subtopics"];

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

    .delta {
      font-size: 0.625rem;
      margin-left: 0.25rem;
    }

    .delta.positive {
      color: #10b981;
    }

    .delta.negative {
      color: #3b82f6;
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
  private accessor loggerBaseline:
    | Record<string, LoggerBreakdown | number>
    | null = null;

  @state()
  private accessor loggerSample:
    | Record<string, LoggerBreakdown | number>
    | null = null;

  @state()
  private accessor workerLoggerMetadata: LoggerMetadata | null = null;

  @state()
  private accessor loggerTimingSample:
    | Record<string, Record<string, TimingStats>>
    | null = null;

  @state()
  private accessor workerLoggerTiming:
    | Record<string, Record<string, TimingStats>>
    | null = null;

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
   * The worker-logger metadata, the diagnosis panel's render step, and the
   * three worker-logger handlers, which a test drives directly.
   */
  get accessForTestingOnly(): {
    workerLoggerMetadata: LoggerMetadata | null;
    renderDiagnosis(): TemplateResult;
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
    this.#initializeAllSubtopics();
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

  #handleKeyDown = (e: KeyboardEvent) => {
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

  #initializeAllSubtopics() {
    const allSubtopics = new Set<string>();
    for (const [topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const subtopicKey of Object.keys(topic.subtopics)) {
        allSubtopics.add(`${topicKey}.${subtopicKey}`);
      }
    }
    this.activeSubtopics = allSubtopics;
  }

  #handleDocumentClick = (e: Event) => {
    // Close dropdowns when clicking outside
    const target = e.target as HTMLElement;
    if (!target.closest(".topic-button-group")) {
      this.openDropdowns = new Set();
    }
  };

  #toggleDropdown(topicKey: TopicKey, e: Event) {
    e.stopPropagation();
    const newDropdowns = new Set(this.openDropdowns);
    if (newDropdowns.has(topicKey)) {
      newDropdowns.delete(topicKey);
    } else {
      // Close other dropdowns
      newDropdowns.clear();
      newDropdowns.add(topicKey);
    }
    this.openDropdowns = newDropdowns;
  }

  #toggleTopic(topicKey: TopicKey) {
    const topic = TOPIC_HIERARCHY[topicKey];
    const subtopicKeys = Object.keys(topic.subtopics);
    const fullKeys = subtopicKeys.map((sk) => `${topicKey}.${sk}`);

    // Check current state
    const activeCount =
      fullKeys.filter((k) => this.activeSubtopics.has(k)).length;
    const newSubtopics = new Set(this.activeSubtopics);

    if (activeCount === 0) {
      // None active -> activate all
      fullKeys.forEach((k) => newSubtopics.add(k));
    } else {
      // Some or all active -> deactivate all
      fullKeys.forEach((k) => newSubtopics.delete(k));
    }

    this.activeSubtopics = newSubtopics;
  }

  #toggleSubtopic(topicKey: TopicKey, subtopicKey: string) {
    const fullKey = `${topicKey}.${subtopicKey}`;
    const newSubtopics = new Set(this.activeSubtopics);

    if (newSubtopics.has(fullKey)) {
      newSubtopics.delete(fullKey);
    } else {
      newSubtopics.add(fullKey);
    }

    this.activeSubtopics = newSubtopics;
  }

  #getTopicState(topicKey: TopicKey): "active" | "partial" | "inactive" {
    const topic = TOPIC_HIERARCHY[topicKey];
    const subtopicKeys = Object.keys(topic.subtopics);
    const fullKeys = subtopicKeys.map((sk) => `${topicKey}.${sk}`);
    const activeCount =
      fullKeys.filter((k) => this.activeSubtopics.has(k)).length;

    if (activeCount === 0) return "inactive";
    if (activeCount === subtopicKeys.length) return "active";
    return "partial";
  }

  #toggleAllTopics() {
    if (this.activeSubtopics.size > 0) {
      // Some selected, deselect all
      this.activeSubtopics = new Set();
    } else {
      // None selected, select all
      this.#initializeAllSubtopics();
    }
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

  #toggleEventExpand(index: number) {
    const newSet = new Set(this.expandedEvents);
    if (newSet.has(index)) {
      newSet.delete(index);
      // Also remove from full height when collapsing
      const fullHeightSet = new Set(this.fullHeightEvents);
      fullHeightSet.delete(index);
      this.fullHeightEvents = fullHeightSet;
    } else {
      newSet.add(index);
    }
    this.expandedEvents = newSet;
  }

  #toggleJsonFullHeight(index: number) {
    const newSet = new Set(this.fullHeightEvents);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    this.fullHeightEvents = newSet;
  }

  async #copyJson(data: RuntimeTelemetryMarkerResult) {
    try {
      const jsonString = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(jsonString);
    } catch (err) {
      console.error("Failed to copy JSON:", err);
    }
  }

  #formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.toLocaleTimeString()}.${
      date.getMilliseconds().toString().padStart(3, "0")
    }`;
  }

  #getEventIcon(marker: RuntimeTelemetryMarkerResult): string {
    const type = marker.type;

    // Try to find a matching topic
    for (const [_topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const [_subtopicKey, subtopic] of Object.entries(topic.subtopics)) {
        if (type.startsWith(subtopic.pattern)) {
          return topic.icon;
        }
      }
    }

    // Default icon
    return "📊";
  }

  #getEventColor(marker: RuntimeTelemetryMarkerResult): string {
    const type = marker.type;

    // Try to find a matching topic
    for (const [_topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const [_subtopicKey, subtopic] of Object.entries(topic.subtopics)) {
        if (type.startsWith(subtopic.pattern)) {
          return topic.color;
        }
      }
    }

    // Default color
    return "#64748b";
  }

  #matchesActiveTopics(marker: RuntimeTelemetryMarkerResult): boolean {
    if (this.activeSubtopics.size === 0) return false;

    const type = marker.type;

    // Check if the event matches any active subtopic
    for (const [topicKey, topic] of Object.entries(TOPIC_HIERARCHY)) {
      for (const [subtopicKey, subtopic] of Object.entries(topic.subtopics)) {
        const fullKey = `${topicKey}.${subtopicKey}`;
        if (
          this.activeSubtopics.has(fullKey) && type.startsWith(subtopic.pattern)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  #matchesSearch(marker: RuntimeTelemetryMarkerResult): boolean {
    if (!this.searchText) return true;

    const searchLower = this.searchText.toLowerCase();
    // A bounded rendering, so that a search does not render a huge marker
    // whole each keystroke.
    const markerStr = toCompactDebugString(marker, {
      ...DEBUGGER_VALUE_OPTIONS,
      maxLength: 5000,
    }).toLowerCase();
    return markerStr.includes(searchLower);
  }

  #getFilteredEvents(): RuntimeTelemetryMarkerResult[] {
    const markers = this.isPaused ? this.pausedMarkers : this.telemetryMarkers;

    return markers.filter((marker) =>
      this.#matchesActiveTopics(marker) && this.#matchesSearch(marker)
    );
  }

  #renderEventDetails(
    marker: RuntimeTelemetryMarkerResult,
  ): TemplateResult[] {
    const details = [];

    // Extract key-value pairs from the marker (excluding type and timeStamp)
    const { type, timeStamp: _, ...rest } = marker;

    // Special handling for different event types
    if (type === "scheduler.run" || type === "scheduler.invocation") {
      const eventData = rest as Record<string, unknown>;
      const actionId = typeof eventData.actionId === "string"
        ? eventData.actionId
        : undefined;
      const handlerId = typeof eventData.handlerId === "string"
        ? eventData.handlerId
        : undefined;
      const info = isObjectOrArray(eventData.actionInfo)
        ? eventData.actionInfo
        : isObjectOrArray(eventData.handlerInfo)
        ? eventData.handlerInfo
        : undefined;

      const idLabel = actionId ? "action" : "handler";
      const idValue = actionId ?? handlerId;

      if (idValue) {
        details.push(html`
          <div class="event-detail">
            <span class="event-detail-label">${idLabel}:</span>
            <span class="event-detail-value">${idValue}</span>
          </div>
        `);
      }

      if (info) {
        if (typeof info.patternName === "string") {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">pattern:</span>
              <span class="event-detail-value">${info.patternName}</span>
            </div>
          `);
        }
        if (typeof info.moduleName === "string") {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">module:</span>
              <span class="event-detail-value">${info.moduleName}</span>
            </div>
          `);
        }
        if (Array.isArray(info.reads) && info.reads.length > 0) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">reads:</span>
              <span class="event-detail-value">${info.reads
                .length} dependencies</span>
            </div>
          `);
        }
        if (Array.isArray(info.writes) && info.writes.length > 0) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">writes:</span>
              <span class="event-detail-value">${info.writes
                .length} outputs</span>
            </div>
          `);
        }
      }

      if (eventData.error) {
        details.push(html`
          <div class="event-detail">
            <span class="event-detail-label">error:</span>
            <span class="event-detail-value" style="color: #ef4444;">${eventData
              .error}</span>
          </div>
        `);
      }
    } else if (type === "cell.update") {
      const change = (rest as Record<string, unknown>).change;
      if (isObjectOrArray(change)) {
        if (isObjectOrArray(change.address)) {
          if (change.address?.id) {
            details.push(html`
              <div class="event-detail">
                <span class="event-detail-label">cell:</span>
                <span class="event-detail-value">${change.address.id}</span>
              </div>
            `);
          }
          if (change.address?.path) {
            details.push(html`
              <div class="event-detail">
                <span class="event-detail-label">path:</span>
                <span class="event-detail-value">${(change.address
                  .path as string[]).join(
                    "/",
                  )}</span>
              </div>
            `);
          }
          if (change.address?.type) {
            details.push(html`
              <div class="event-detail">
                <span class="event-detail-label">type:</span>
                <span class="event-detail-value">${change.address.type}</span>
              </div>
            `);
          }
        }
        // Show a summary of the change
        const hasBeforeAfter = change.before !== undefined ||
          change.after !== undefined;
        if (hasBeforeAfter) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">change:</span>
              <span class="event-detail-value">
                ${change.before === undefined
                  ? "created"
                  : change.after === undefined
                  ? "deleted"
                  : "updated"}
              </span>
            </div>
          `);
        }
      }
    } else {
      // Default rendering for other event types
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined && value !== null) {
          details.push(html`
            <div class="event-detail">
              <span class="event-detail-label">${key}:</span>
              <span class="event-detail-value">${typeof value === "string"
                ? value
                : typeof value === "boolean"
                ? value.toString()
                : typeof value === "number"
                ? value.toString()
                : toCompactDebugString(value, {
                  ...DEBUGGER_VALUE_OPTIONS,
                  maxLength: 100,
                })}</span>
            </div>
          `);
        }
      }
    }

    return details;
  }

  #getLoggerRegistry(): Record<string, Logger> {
    const global = globalThis as unknown as {
      commonfabric?: { logger?: Record<string, Logger> };
    };
    return global.commonfabric?.logger ?? {};
  }

  #getLoggerBreakdown(): Record<string, LoggerBreakdown | number> {
    const global = globalThis as unknown as {
      commonfabric?: {
        getLoggerCountsBreakdown?: () => Record<
          string,
          LoggerBreakdown | number
        >;
      };
    };
    return global.commonfabric?.getLoggerCountsBreakdown?.() ?? { total: 0 };
  }

  #getBreakdownTotal(
    breakdown: Record<string, LoggerBreakdown | number> | null,
  ): number {
    if (!breakdown) return 0;
    const total = breakdown.total;
    return typeof total === "number" ? total : 0;
  }

  async #getWorkerLoggerBreakdown(): Promise<{
    counts: Record<string, LoggerBreakdown | number> | null;
    timing: Record<string, Record<string, TimingStats>> | null;
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

  #mergeLoggerBreakdowns(
    main: Record<string, LoggerBreakdown | number>,
    worker: Record<string, LoggerBreakdown | number> | null,
  ): Record<string, LoggerBreakdown | number> {
    if (!worker) return main;

    const merged: Record<string, LoggerBreakdown | number> = {};
    const allKeys = new Set([
      ...Object.keys(main).filter((k) => k !== "total"),
      ...Object.keys(worker).filter((k) => k !== "total"),
    ]);

    for (const key of allKeys) {
      const mainVal = main[key];
      const workerVal = worker[key];

      if (typeof mainVal === "number" || typeof workerVal === "number") {
        // Handle simple number values
        merged[key] = (typeof mainVal === "number" ? mainVal : 0) +
          (typeof workerVal === "number" ? workerVal : 0);
      } else if (mainVal && workerVal) {
        // Both have LoggerBreakdown - merge them
        merged[key] = this.#mergeBreakdown(mainVal, workerVal);
      } else {
        // Only one has data
        merged[key] = mainVal ?? workerVal;
      }
    }

    // Merge totals
    const mainTotal = typeof main.total === "number" ? main.total : 0;
    const workerTotal = typeof worker.total === "number" ? worker.total : 0;
    merged.total = mainTotal + workerTotal;

    return merged;
  }

  #mergeBreakdown(
    a: LoggerBreakdown,
    b: LoggerBreakdown,
  ): LoggerBreakdown {
    const merged = { total: a.total + b.total } as LoggerBreakdown;
    const allKeys = new Set([
      ...Object.keys(a).filter((k) => k !== "total"),
      ...Object.keys(b).filter((k) => k !== "total"),
    ]);

    for (const key of allKeys) {
      const aVal = a[key];
      const bVal = b[key];
      if (aVal && bVal) {
        merged[key] = {
          debug: aVal.debug + bVal.debug,
          info: aVal.info + bVal.info,
          warn: aVal.warn + bVal.warn,
          error: aVal.error + bVal.error,
          total: aVal.total + bVal.total,
        };
      } else {
        merged[key] = aVal ?? bVal;
      }
    }

    return merged;
  }

  #getLoggerTiming(): Record<string, Record<string, TimingStats>> {
    const global = globalThis as unknown as {
      commonfabric?: {
        getTimingStatsBreakdown?: () => Record<
          string,
          Record<string, TimingStats>
        >;
      };
    };
    return global.commonfabric?.getTimingStatsBreakdown?.() ?? {};
  }

  #mergeLoggerTiming(
    main: Record<string, Record<string, TimingStats>>,
    worker: Record<string, Record<string, TimingStats>> | null,
  ): Record<string, Record<string, TimingStats>> {
    if (!worker) return main;

    const merged: Record<string, Record<string, TimingStats>> = { ...main };

    for (const [loggerName, workerKeys] of Object.entries(worker)) {
      if (!merged[loggerName]) {
        merged[loggerName] = workerKeys;
      } else {
        // Merge keys within the same logger
        merged[loggerName] = { ...merged[loggerName], ...workerKeys };
      }
    }

    return merged;
  }

  async #sampleLoggerCounts(): Promise<void> {
    const mainCounts = this.#getLoggerBreakdown();
    const workerResult = await this.#getWorkerLoggerBreakdown();
    this.loggerSample = this.#mergeLoggerBreakdowns(
      mainCounts,
      workerResult.counts,
    );

    // Merge timing data
    const mainTiming = this.#getLoggerTiming();
    this.loggerTimingSample = this.#mergeLoggerTiming(
      mainTiming,
      workerResult.timing,
    );

    // Debug logging
    console.log("[sampleLoggerCounts] Timing data:", {
      mainTiming,
      workerTiming: workerResult.timing,
      merged: this.loggerTimingSample,
    });
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
      // Clear local baseline tracking
      this.loggerBaseline = null;
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
    if (this.expandedLoggers.has(name)) {
      this.expandedLoggers.delete(name);
    } else {
      this.expandedLoggers.add(name);
    }
    this.requestUpdate();
  }

  #getDelta(current: number, baseline: number | undefined): number {
    return current - (baseline ?? 0);
  }

  #formatDelta(delta: number): string {
    if (delta === 0) return "0";
    return delta > 0 ? `+${delta}` : `${delta}`;
  }

  #renderTimingHistogram(
    _loggerName: string,
    timingData: Record<string, TimingStats>,
  ): TemplateResult {
    const keys = Object.keys(timingData).sort((a, b) =>
      timingData[b].count - timingData[a].count
    );

    if (keys.length === 0) {
      return html`
      `;
    }

    return html`
      <div class="timing-histogram">
        ${keys.map((key) => {
          const stats = timingData[key];
          if (!stats.cdf || stats.cdf.length === 0) {
            return html`
            `;
          }

          return this.#renderCDFForKey(key, stats);
        })}
      </div>
    `;
  }

  #handleChartMouseMove(
    e: MouseEvent,
    cumulativePointsBlue: Array<{
      latency: number;
      cumulativeTime: number;
      eventIndex: number;
      normalizedPosition: number;
    }>,
    cumulativePointsGreen:
      | Array<{
        latency: number;
        cumulativeTime: number;
        eventIndex: number;
        normalizedPosition: number;
      }>
      | null,
    xScale: (normalizedPosition: number) => number,
    yScaleBlue: (cumulativeTime: number) => number,
    yScaleGreen: (cumulativeTime: number) => number,
    formatTime: (ms: number) => string,
    margin: { top: number; right: number; bottom: number; left: number },
    _plotWidth: number,
    _plotHeight: number,
  ): void {
    const svg = e.currentTarget as SVGElement;
    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Check if mouse is inside plot area
    if (
      mouseX < margin.left ||
      mouseX > rect.width - margin.right ||
      mouseY < margin.top ||
      mouseY > rect.height - margin.bottom
    ) {
      this.tooltipData = null;
      return;
    }

    // Find closest point on blue curve
    let closestPointBlue = cumulativePointsBlue[0];
    let minDistanceBlue = Infinity;

    for (const point of cumulativePointsBlue) {
      const px = xScale(point.normalizedPosition);
      const py = yScaleBlue(point.cumulativeTime);
      const distance = Math.sqrt((mouseX - px) ** 2 + (mouseY - py) ** 2);
      if (distance < minDistanceBlue) {
        minDistanceBlue = distance;
        closestPointBlue = point;
      }
    }

    // Find closest point on green curve if it exists
    let closestPointGreen: typeof closestPointBlue | null = null;
    let minDistanceGreen = Infinity;

    if (cumulativePointsGreen) {
      for (const point of cumulativePointsGreen) {
        const px = xScale(point.normalizedPosition);
        const py = yScaleGreen(point.cumulativeTime);
        const distance = Math.sqrt((mouseX - px) ** 2 + (mouseY - py) ** 2);
        if (distance < minDistanceGreen) {
          minDistanceGreen = distance;
          closestPointGreen = point;
        }
      }
    }

    // Show tooltip if close enough to either curve (within 30px)
    const isCloseToBlue = minDistanceBlue < 30;
    const isCloseToGreen = minDistanceGreen < 30;

    if (isCloseToBlue || isCloseToGreen) {
      const lines: string[] = [];

      if (isCloseToBlue) {
        lines.push(
          `All time: ${formatTime(closestPointBlue.latency)}`,
          `  Cumulative: ${formatTime(closestPointBlue.cumulativeTime)}`,
          `  Event #${closestPointBlue.eventIndex}`,
        );
      }

      if (isCloseToGreen && closestPointGreen) {
        if (lines.length > 0) lines.push(""); // Add blank line between sections
        lines.push(
          `Since baseline: ${formatTime(closestPointGreen.latency)}`,
          `  Cumulative: ${formatTime(closestPointGreen.cumulativeTime)}`,
          `  Event #${closestPointGreen.eventIndex}`,
        );
      }

      this.tooltipData = {
        x: e.clientX + 10,
        y: e.clientY - 10,
        content: lines.join("\n"),
        visible: true,
      };
    } else {
      this.tooltipData = null;
    }
  }

  #handleChartMouseLeave(): void {
    this.tooltipData = null;
  }

  #renderCDFForKey(
    key: string,
    stats: TimingStats,
  ): TemplateResult {
    const cdf = stats.cdf;
    const cdfDelta = stats.cdfSinceBaseline;

    if (cdf.length === 0) {
      return html`
      `;
    }

    // Format time for display
    const formatTime = (ms: number) => {
      if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
      if (ms < 1000) return `${ms.toFixed(1)}ms`;
      return `${(ms / 1000).toFixed(2)}s`;
    };

    // Create unique ID for this chart
    const chartId = `cdf-${key.replace(/\//g, "-")}`;

    // SVG dimensions
    const width = 600;
    const height = 200;
    const margin = { top: 25, right: 50, bottom: 40, left: 60 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    // Sort samples and compute cumulative time
    const sortedSamples = [...cdf].sort((a, b) => a.x - b.x);
    const cumulativePoints: Array<
      {
        latency: number;
        cumulativeTime: number;
        eventIndex: number;
        normalizedPosition: number;
      }
    > = [];
    let cumTime = 0;
    const totalCount = sortedSamples.length;
    sortedSamples.forEach((sample, i) => {
      cumTime += sample.x;
      cumulativePoints.push({
        latency: sample.x,
        cumulativeTime: cumTime,
        eventIndex: i + 1,
        normalizedPosition: totalCount > 0 ? (i + 1) / totalCount : 0,
      });
    });

    // Do the same for delta if it exists
    let cumulativePointsDelta:
      | Array<
        {
          latency: number;
          cumulativeTime: number;
          eventIndex: number;
          normalizedPosition: number;
        }
      >
      | null = null;
    if (cdfDelta) {
      const sortedDelta = [...cdfDelta].sort((a, b) => a.x - b.x);
      cumulativePointsDelta = [];
      let cumTimeDelta = 0;
      const deltaCount = sortedDelta.length;
      sortedDelta.forEach((sample, i) => {
        cumTimeDelta += sample.x;
        cumulativePointsDelta!.push({
          latency: sample.x,
          cumulativeTime: cumTimeDelta,
          eventIndex: i + 1,
          normalizedPosition: deltaCount > 0 ? (i + 1) / deltaCount : 0,
        });
      });
    }

    // X-axis: normalized position (0 to 1)
    // This allows both curves to use the full chart width
    const xScale = (normalizedPosition: number) => {
      return margin.left + normalizedPosition * plotWidth;
    };

    // Y-axis: cumulative time (0 to max cumulative from reservoir samples)
    // Use separate scales for each curve so both fill the vertical space
    const maxCumulativeTimeBlue =
      cumulativePoints[cumulativePoints.length - 1]?.cumulativeTime ?? 0.001;
    const maxCumulativeTimeGreen = cumulativePointsDelta?.[
      cumulativePointsDelta.length - 1
    ]?.cumulativeTime ?? maxCumulativeTimeBlue;

    const yScaleBlue = (cumulativeTime: number) => {
      return margin.top + plotHeight -
        (cumulativeTime / maxCumulativeTimeBlue) * plotHeight;
    };

    const yScaleGreen = (cumulativeTime: number) => {
      return margin.top + plotHeight -
        (cumulativeTime / maxCumulativeTimeGreen) * plotHeight;
    };

    // For y-axis labels, use the maximum of both
    const maxCumulativeTime = Math.max(
      maxCumulativeTimeBlue,
      maxCumulativeTimeGreen,
    );
    const yScale = yScaleBlue; // For grid lines/labels

    // Generate SVG path from cumulative points
    const pathFromCumulative = (
      points: Array<{
        latency: number;
        cumulativeTime: number;
        eventIndex: number;
        normalizedPosition: number;
      }>,
      yScaleFn: (cumulativeTime: number) => number,
    ) => {
      if (points.length === 0) return "";
      const pathParts = points.map((p, i) =>
        `${i === 0 ? "M" : "L"} ${xScale(p.normalizedPosition)} ${
          yScaleFn(p.cumulativeTime)
        }`
      );
      const path = pathParts.join(" ");
      return path;
    };

    // Generate x-axis tick marks (percentages: 0%, 20%, 40%, 60%, 80%, 100%)
    const xTicks: number[] = [];
    const xTickCount = 5;
    for (let i = 0; i <= xTickCount; i++) {
      xTicks.push(i / xTickCount); // 0, 0.2, 0.4, 0.6, 0.8, 1.0
    }

    // Generate y-axis tick marks (cumulative time)
    const yTicks: number[] = [];
    const yTickCount = 5;
    for (let i = 0; i <= yTickCount; i++) {
      yTicks.push((i / yTickCount) * maxCumulativeTime);
    }

    // Percentile positions (normalized 0-1)
    const p50Position = 0.5; // Always at 50% by definition
    const p95Position = 0.95; // Always at 95% by definition

    // Find position closest to average latency in the blue curve
    let avgPosition = 0.5; // default to middle
    let minDiff = Infinity;
    for (let i = 0; i < cumulativePoints.length; i++) {
      const diff = Math.abs(cumulativePoints[i].latency - stats.average);
      if (diff < minDiff) {
        minDiff = diff;
        avgPosition = cumulativePoints[i].normalizedPosition;
      }
    }

    // Pre-render SVG path data
    const greenPathData = cumulativePointsDelta
      ? pathFromCumulative(cumulativePointsDelta, yScaleGreen)
      : null;

    const showGreenLegend = cdfDelta && cumulativePointsDelta &&
      cumulativePointsDelta.length > 0;

    return html`
      <div style="margin-bottom: 1rem;">
        <div class="timing-key-header">
          <span class="timing-key-name">${key}</span>
          <div class="timing-stats-summary">
            <span>n=${stats.count}</span>
            <span>p50=${formatTime(stats.p50)}</span>
            <span>p95=${formatTime(stats.p95)}</span>
            <span>avg=${formatTime(stats.average)}</span>
          </div>
        </div>

        <svg
          id="${chartId}"
          width="${width}"
          height="${height}"
          style="background-color: #0f172a; border-radius: 0.25rem; cursor: crosshair;"
          @mousemove="${(e: MouseEvent) =>
            this.#handleChartMouseMove(
              e,
              cumulativePoints,
              cumulativePointsDelta,
              xScale,
              yScaleBlue,
              yScaleGreen,
              formatTime,
              margin,
              plotWidth,
              plotHeight,
            )}"
          @mouseleave="${() => this.#handleChartMouseLeave()}"
        >
          <!-- Y-axis grid lines and labels -->
          ${yTicks.map((y) => {
            const yPos = yScale(y);
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
                ${formatTime(y)}
              </text>
            `;
          })}

          <!-- X-axis grid lines and labels -->
          ${xTicks.map((x) => {
            const xPos = xScale(x);
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
          ${xTicks.map((x) => {
            const xPos = xScale(x);
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
          ${yTicks.map((y) => {
            const yPos = yScale(y);
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
            d="${pathFromCumulative(cumulativePoints, yScaleBlue)}"
            fill="none"
            stroke="#3b82f6"
            stroke-width="2"
            opacity="0.8"
            style="pointer-events: stroke;"
          >
            <title>Total: ${stats.count} samples, ${formatTime(
              stats.totalTime,
            )} cumulative</title>
          </path>

          <!-- Cumulative time delta curve (since baseline) - green -->
          <path
            d="${greenPathData || ""}"
            fill="none"
            stroke="#10b981"
            stroke-width="2"
            opacity="0.8"
            style="pointer-events: stroke; ${greenPathData
              ? ""
              : "display: none;"}"
          >
            <title>Since baseline</title>
          </path>

          <!-- Percentile reference lines (p50, p95) - render AFTER curves -->
          <g style="pointer-events: stroke;">
            <line
              x1="${xScale(p50Position)}"
              y1="${margin.top}"
              x2="${xScale(p50Position)}"
              y2="${height - margin.bottom}"
              stroke="#f59e0b"
              stroke-width="1.5"
              stroke-dasharray="4,2"
              opacity="0.7"
            >
              <title>p50 (median): ${formatTime(stats.p50)}</title>
            </line>
            <text
              x="${xScale(p50Position)}"
              y="${margin.top - 4}"
              text-anchor="middle"
              fill="#f59e0b"
              font-size="8"
              font-weight="600"
              style="pointer-events: none;"
            >
              <tspan x="${xScale(p50Position)}" dy="0">p50</tspan>
              <tspan x="${xScale(p50Position)}" dy="10">${formatTime(
                stats.p50,
              )}</tspan>
            </text>
          </g>

          <g style="pointer-events: stroke;">
            <line
              x1="${xScale(p95Position)}"
              y1="${margin.top}"
              x2="${xScale(p95Position)}"
              y2="${height - margin.bottom}"
              stroke="#ef4444"
              stroke-width="1.5"
              stroke-dasharray="4,2"
              opacity="0.7"
            >
              <title>p95: ${formatTime(stats.p95)}</title>
            </line>
            <text
              x="${xScale(p95Position)}"
              y="${margin.top - 4}"
              text-anchor="middle"
              fill="#ef4444"
              font-size="8"
              font-weight="600"
              style="pointer-events: none;"
            >
              <tspan x="${xScale(p95Position)}" dy="0">p95</tspan>
              <tspan x="${xScale(p95Position)}" dy="10">${formatTime(
                stats.p95,
              )}</tspan>
            </text>
          </g>

          <!-- Average reference line -->
          <g style="pointer-events: stroke;">
            <line
              x1="${xScale(avgPosition)}"
              y1="${margin.top}"
              x2="${xScale(avgPosition)}"
              y2="${height - margin.bottom}"
              stroke="#8b5cf6"
              stroke-width="1.5"
              stroke-dasharray="4,2"
              opacity="0.5"
            >
              <title>avg (mean): ${formatTime(stats.average)}</title>
            </line>
            <text
              x="${xScale(avgPosition)}"
              y="${margin.top - 4}"
              text-anchor="middle"
              fill="#8b5cf6"
              font-size="8"
              font-weight="600"
              style="pointer-events: none;"
            >
              <tspan x="${xScale(avgPosition)}" dy="0">avg</tspan>
              <tspan x="${xScale(avgPosition)}" dy="10">${formatTime(
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
              All time (${(maxCumulativeTimeBlue / 1000).toFixed(
                2,
              )}s in ${cumulativePoints.length} samples)
            </text>
            <line
              x1="0"
              y1="15"
              x2="20"
              y2="15"
              stroke="#10b981"
              stroke-width="2"
              style="${showGreenLegend ? "" : "display: none;"}"
            />
            <text
              x="25"
              y="15"
              dominant-baseline="middle"
              fill="#cbd5e1"
              font-size="10"
              style="${showGreenLegend ? "" : "display: none;"}"
            >
              Since baseline (${showGreenLegend
                ? `${
                  (maxCumulativeTimeGreen / 1000).toFixed(
                    2,
                  )
                }s in ${cumulativePointsDelta!.length} samples`
                : ""})
            </text>
          </g>
        </svg>
      </div>
    `;
  }

  #renderLoggers(): TemplateResult {
    const sample = this.loggerSample ?? this.#getLoggerBreakdown();
    const baseline = this.loggerBaseline;
    const registry = this.#getLoggerRegistry();
    const loggerNames = Object.keys(sample).filter((k) => k !== "total");

    if (loggerNames.length === 0) {
      return html`
        <div class="loggers-empty">
          No loggers registered yet.
        </div>
      `;
    }

    const sampleTotal = this.#getBreakdownTotal(sample);
    const baselineTotal = this.#getBreakdownTotal(baseline);
    const totalDelta = this.#getDelta(sampleTotal, baselineTotal);

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
          Total: ${sampleTotal} ${baseline
            ? html`
              <span class="delta ${totalDelta > 0
                ? "positive"
                : totalDelta < 0
                ? "negative"
                : ""}">(${this.#formatDelta(totalDelta)})</span>
            `
            : ""}
        </span>
      </div>
      <div class="loggers-list">
        ${loggerNames.map((name) => {
          const loggerData = sample[name] as LoggerBreakdown;
          const baselineData = baseline?.[name] as LoggerBreakdown | undefined;
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
          const delta = this.#getDelta(loggerData.total, baselineData?.total);

          return html`
            <div class="logger-item ${isDisabled ? "disabled" : ""}">
              <div class="logger-header" @click="${() =>
                this.#toggleExpandLogger(name)}">
                <span class="logger-expand">${isExpanded ? "▼" : "▶"}</span>
                <span class="logger-name">${name}</span>
                <span class="logger-count">
                  ${loggerData.total} ${baseline
                    ? html`
                      <span class="delta ${delta > 0
                        ? "positive"
                        : delta < 0
                        ? "negative"
                        : ""}">(${this.#formatDelta(delta)})</span>
                    `
                    : ""}
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
                    ${Object.entries(loggerData)
                      .filter(([k]) => k !== "total")
                      .sort((a, b) =>
                        (b[1] as { total: number }).total -
                        (a[1] as { total: number }).total
                      )
                      .map(([key, counts]) => {
                        const c = counts as {
                          debug: number;
                          info: number;
                          warn: number;
                          error: number;
                          total: number;
                        };
                        const baselineCounts = baselineData?.[key] as
                          | typeof c
                          | undefined;
                        const keyDelta = this.#getDelta(
                          c.total,
                          baselineCounts?.total,
                        );
                        return html`
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
                                = ${c.total} ${baseline
                                  ? html`
                                    <span class="delta ${keyDelta > 0
                                      ? "positive"
                                      : keyDelta < 0
                                      ? "negative"
                                      : ""}">(${this.#formatDelta(
                                        keyDelta,
                                      )})</span>
                                  `
                                  : ""}
                              </span>
                            </span>
                          </div>
                        `;
                      })}
                  </div>

                  ${/* Show timing histogram if available */
                  this.loggerTimingSample?.[name]
                    ? this.#renderTimingHistogram(
                      name,
                      this.loggerTimingSample[name],
                    )
                    : ""}
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
            // Sample current counts when tab is opened
            this.#sampleLoggerCounts();
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
    const events = this.#getFilteredEvents();

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
          const color = this.#getEventColor(marker);

          return html`
            <div
              class="event-item ${isExpanded ? "expanded" : ""}"
              @click="${() => this.#toggleEventExpand(actualIndex)}"
            >
              <div class="event-header">
                <div class="event-main">
                  <span class="event-icon" style="color: ${color}">
                    ${this.#getEventIcon(marker)}
                  </span>
                  <div class="event-content">
                    <div class="event-type">${marker.type}</div>
                    <div class="event-details">
                      ${this.#renderEventDetails(marker)}
                    </div>
                  </div>
                </div>
                <div class="event-time">
                  ${this.#formatTime(marker.timeStamp)}
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
                          this.#toggleJsonFullHeight(actualIndex);
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
    const filteredCount = this.visible ? this.#getFilteredEvents().length : 0;

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
                      const state = this.#getTopicState(topicKey);
                      const subtopicKeys = Object.keys(topic.subtopics);
                      const hasDropdown = subtopicKeys.length > 0; // Show dropdown even for single subtopic
                      const isDropdownOpen = this.openDropdowns.has(topicKey);

                      return html`
                        <div class="topic-button-group">
                          <button
                            type="button"
                            class="topic-toggle ${state}"
                            style="--topic-color: ${topic.color}"
                            @click="${() => this.#toggleTopic(topicKey)}"
                            title="${topic.label}"
                          >
                            <span class="topic-icon">${topic.icon}</span>
                            ${topic.label} ${state === "partial"
                              ? html`
                                <span style="font-size: 0.5rem; opacity: 0.7; margin-left: 0.25rem;">
                                  ${Object.keys(topic.subtopics).filter((sk) =>
                                    this.activeSubtopics.has(
                                      `${topicKey}.${sk}`,
                                    )
                                  ).length}/${subtopicKeys.length}
                                </span>
                              `
                              : ""}
                          </button>
                          ${hasDropdown
                            ? html`
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
                                                this.#toggleSubtopic(
                                                  topicKey,
                                                  subKey,
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
                      @click="${this.#toggleAllTopics}"
                      title="Toggle all topics"
                    >
                      ${this.activeSubtopics.size > 0 ? "☐" : "☑"}
                    </button>

                    <button
                      type="button"
                      class="action-button"
                      @click="${this.#togglePause}"
                      title="${this.isPaused ? "Resume" : "Pause"} (Space)"
                    >
                      ${this.isPaused ? "▶" : "⏸"}
                    </button>

                    <button
                      type="button"
                      class="action-button"
                      @click="${this.#clearEvents}"
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
