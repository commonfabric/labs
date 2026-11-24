// Note: deno fmt can crash on deeply nested ternaries in html/svg templates - see renderBaselineStats
import { css, html, LitElement, svg as svgTag, TemplateResult } from "lit";
import { property, query, state } from "lit/decorators.js";

import type {
  DebuggerController,
  GraphEdgeWithHistory,
} from "../lib/debugger-controller.ts";
import {
  adjacentNodes,
  centerOn,
  computeParentGroups,
  fitZoom,
  type GraphNodeInfo,
  type LayoutEdge,
  type LayoutNode,
  layoutSchedulerGraph,
  nodeTooltip,
  truncateLabel,
  zoomAroundCenter,
  zoomAtPointer,
} from "../lib/scheduler-graph-layout.ts";
import {
  captureBaseline,
  formatDelta,
  formatDuration,
  graphTotals,
  type RunBaseline,
  type TableGroup,
  tableGroups,
  type TableRow,
  type TableSortColumn,
} from "../lib/scheduler-graph-stats.ts";
import {
  parseActionLocation,
  type SourceViewNode,
} from "../lib/scheduler-source.ts";
// Loading this module defines the `x-scheduler-source` element that this
// view renders.
import "./SchedulerSourceView.ts";

/**
 * Scheduler Graph visualization component.
 * Shows dependency graph with effects and computations.
 */
export class XSchedulerGraph extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .toolbar {
      display: flex;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      align-items: center;
      flex-shrink: 0;
    }

    .toggle-group {
      display: flex;
      gap: 0;
    }

    .toggle-button {
      padding: 0.375rem 0.75rem;
      background: #334155;
      border: 1px solid #475569;
      color: #94a3b8;
      font-size: 0.75rem;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.2s;
    }

    .toggle-button:first-child {
      border-radius: 0.375rem 0 0 0.375rem;
    }

    .toggle-button:not(:first-child) {
      border-left: none;
    }

    .toggle-button:last-child {
      border-radius: 0 0.375rem 0.375rem 0;
    }

    .toggle-button:hover {
      background: #475569;
      color: white;
    }

    .toggle-button.active {
      background: #3b82f6;
      border-color: #3b82f6;
      color: white;
    }

    .action-button {
      padding: 0.375rem 0.75rem;
      background: #334155;
      border: 1px solid #475569;
      border-radius: 0.375rem;
      color: #94a3b8;
      font-size: 0.75rem;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.2s;
    }

    .action-button:hover {
      background: #475569;
      color: white;
    }

    .zoom-controls {
      display: flex;
      gap: 0;
    }

    .zoom-button {
      width: 28px;
      height: 28px;
      padding: 0;
      background: #334155;
      border: 1px solid #475569;
      color: #94a3b8;
      font-size: 1rem;
      font-family: monospace;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .zoom-button:first-child {
      border-radius: 0.375rem 0 0 0.375rem;
    }

    .zoom-button:last-child {
      border-radius: 0 0.375rem 0.375rem 0;
      border-left: none;
    }

    .zoom-button:hover {
      background: #475569;
      color: white;
    }

    .zoom-level {
      padding: 0.375rem 0.5rem;
      background: #1e293b;
      border: 1px solid #475569;
      border-left: none;
      color: #cbd5e1;
      font-size: 0.6875rem;
      font-family: monospace;
      cursor: pointer;
      min-width: 48px;
      text-align: center;
    }

    .zoom-level:hover {
      background: #334155;
    }

    .stats {
      margin-left: auto;
      display: flex;
      gap: 1rem;
      color: #94a3b8;
      font-size: 0.6875rem;
      font-family: monospace;
    }

    .stat-value {
      color: #cbd5e1;
    }

    .graph-wrapper {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }

    .graph-container {
      flex: 1;
      overflow: auto;
      position: relative;
      background: #0f172a;
    }

    .graph-svg {
      display: block;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #64748b;
      font-size: 0.875rem;
      gap: 1rem;
    }

    /* Node styles */
    .node-group {
      cursor: pointer;
    }

    .node-rect {
      stroke: #475569;
      stroke-width: 1;
      rx: 4;
      transition: filter 0.3s ease-out;
    }

    .node-effect .node-rect {
      fill: #1e40af; /* blue-800 */
    }

    .node-computation .node-rect {
      fill: #5b21b6; /* violet-800 */
    }

    .node-input .node-rect {
      fill: #065f46; /* emerald-800 */
    }

    .node-inactive .node-rect {
      fill: #374151; /* gray-700 */
      opacity: 0.7;
    }

    .node-inactive .node-label {
      fill: #9ca3af; /* gray-400 */
      font-style: italic;
    }

    .node-dirty .node-rect {
      fill: #78350f; /* amber-900 */
    }

    .node-pending .node-rect {
      stroke: #fbbf24;
      stroke-width: 2;
    }

    .node-label {
      fill: white;
      font-size: 10px;
      font-family: monospace;
      pointer-events: none;
    }

    .node-type-badge {
      fill: rgba(255, 255, 255, 0.3);
      font-size: 8px;
      font-family: monospace;
      pointer-events: none;
    }

    .node-stats {
      fill: rgba(255, 255, 255, 0.6);
      font-size: 8px;
      font-family: monospace;
      pointer-events: none;
    }

    .node-collapse-toggle {
      fill: rgba(255, 255, 255, 0.5);
      font-size: 12px;
      font-family: monospace;
      cursor: pointer;
      transition: fill 0.2s;
    }

    .node-collapse-toggle:hover {
      fill: white;
    }

    .node-child-count {
      fill: #f59e0b;
      font-size: 8px;
      font-family: monospace;
      pointer-events: none;
    }

    /* Parent group container styles */
    .parent-group-rect {
      fill: rgba(255, 255, 255, 0.03);
      stroke: rgba(255, 255, 255, 0.1);
      stroke-width: 1;
      stroke-dasharray: 4 2;
      rx: 8;
    }

    .parent-group-label {
      fill: rgba(255, 255, 255, 0.3);
      font-size: 9px;
      font-family: monospace;
      pointer-events: none;
    }

    /* Edge styles */
    .edge-current {
      stroke: #64748b;
      stroke-width: 1.5;
      fill: none;
    }

    .edge-historical {
      stroke: #475569;
      stroke-width: 1;
      stroke-dasharray: 4 2;
      fill: none;
    }

    .edge-path {
      cursor: pointer;
      transition: stroke 0.2s;
    }

    .edge-path:hover {
      stroke: #f59e0b;
      stroke-width: 2;
    }

    .arrow-marker {
      fill: #64748b;
    }

    .edge-parent {
      stroke-dasharray: 4 3;
      stroke: #94a3b8;
    }

    .edge-parent:hover {
      stroke: #cbd5e1;
    }

    /* Legend */
    .legend {
      position: absolute;
      bottom: 0.5rem;
      left: 0.5rem;
      background: rgba(30, 41, 59, 0.9);
      border: 1px solid #475569;
      border-radius: 0.375rem;
      padding: 0.5rem 0.75rem;
      font-size: 0.6875rem;
      color: #cbd5e1;
      font-family: monospace;
      display: flex;
      gap: 1rem;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .legend-swatch {
      width: 12px;
      height: 12px;
      border-radius: 2px;
    }

    .legend-swatch.input {
      background: #065f46;
    }
    .legend-swatch.computation {
      background: #5b21b6;
    }
    .legend-swatch.effect {
      background: #1e40af;
    }

    .legend-line {
      width: 20px;
      height: 2px;
      background: #64748b;
    }

    .legend-line.parent {
      background: repeating-linear-gradient(
        90deg,
        #94a3b8 0px,
        #94a3b8 4px,
        transparent 4px,
        transparent 7px
      );
    }

    /* Tooltip */
    .tooltip {
      position: absolute;
      background: #1e293b;
      border: 1px solid #475569;
      border-radius: 0.375rem;
      padding: 0.5rem;
      font-size: 0.6875rem;
      color: #cbd5e1;
      max-width: 300px;
      z-index: 100;
      pointer-events: none;
      font-family: monospace;
    }

    .tooltip-title {
      font-weight: 600;
      margin-bottom: 0.25rem;
      color: #e2e8f0;
    }

    .tooltip-cells {
      color: #94a3b8;
    }

    .tooltip-cell {
      padding: 0.125rem 0;
      word-break: break-all;
    }

    .node-selected .node-rect {
      stroke: #f59e0b;
      stroke-width: 3;
    }

    /* Table view styles */
    .table-container {
      flex: 1;
      overflow: auto;
      background: #0f172a;
    }

    .stats-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.75rem;
      font-family: monospace;
    }

    .stats-table th {
      background: #1e293b;
      color: #94a3b8;
      font-weight: 500;
      text-align: left;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #334155;
      position: sticky;
      top: 0;
      cursor: pointer;
      user-select: none;
    }

    .stats-table th:hover {
      background: #334155;
      color: #e2e8f0;
    }

    .stats-table th.sorted {
      color: #3b82f6;
    }

    .stats-table th .sort-indicator {
      margin-left: 0.25rem;
      opacity: 0.5;
    }

    .stats-table th.sorted .sort-indicator {
      opacity: 1;
    }

    .stats-table td {
      padding: 0.375rem 0.75rem;
      border-bottom: 1px solid #1e293b;
      color: #cbd5e1;
    }

    .stats-table tr:hover td {
      background: #1e293b;
    }

    .stats-table .col-name {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stats-table .col-type {
      width: 80px;
    }

    .stats-table .col-number {
      width: 100px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .type-badge {
      display: inline-block;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-size: 0.625rem;
      font-weight: 500;
    }

    .type-badge.effect {
      background: #1e40af;
      color: #93c5fd;
    }

    .type-badge.computation {
      background: #5b21b6;
      color: #c4b5fd;
    }

    .type-badge.input {
      background: #065f46;
      color: #6ee7b7;
    }

    .type-badge.inactive {
      background: #374151;
      color: #9ca3af;
      font-style: italic;
    }

    /* Timing control badges */
    .timing-badge {
      display: inline-block;
      padding: 0.0625rem 0.25rem;
      border-radius: 0.1875rem;
      font-size: 0.5625rem;
      font-weight: 500;
      margin-left: 0.375rem;
      vertical-align: middle;
    }

    .timing-badge.debounce {
      background: #7c3aed;
      color: #ddd6fe;
    }

    .timing-badge.throttle {
      background: #0891b2;
      color: #cffafe;
    }

    /* Table wrapper for detail pane layout */
    .table-wrapper {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .table-wrapper .table-container {
      flex: 1;
      overflow: auto;
    }

    .table-wrapper .detail-pane {
      width: 350px;
      flex-shrink: 0;
      border-left: 1px solid #334155;
    }

    /* Expand/collapse toggle button */
    .expand-toggle {
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      padding: 0;
      width: 1.25rem;
      font-size: 0.625rem;
      text-align: center;
      transition: color 0.15s;
    }

    .expand-toggle:hover {
      color: #94a3b8;
    }

    /* Parent row styling */
    .stats-table tr.parent-row {
      background: #1a2744;
    }

    .stats-table tr.parent-row td {
      border-bottom-color: #334155;
    }

    /* Selected row styling */
    .stats-table tr.selected td {
      background: #1e3a5f;
    }

    .stats-table tr.selected:hover td {
      background: #234768;
    }

    /* Child row styling */
    .stats-table tr.child-row {
      background: #0c1322;
    }

    .stats-table tr.child-row td {
      border-bottom-color: #1e293b;
    }

    .child-indent {
      color: #475569;
      margin-right: 0.25rem;
    }

    /* Aggregated stats styling */
    .aggregated {
      color: #94a3b8;
      font-style: italic;
    }

    .child-count {
      color: #64748b;
      font-size: 0.625rem;
      margin-left: 0.25rem;
    }

    .view-toggle {
      display: flex;
      gap: 0;
      margin-left: 0.5rem;
    }

    .detail-pane {
      width: 320px;
      flex-shrink: 0;
      background: #1e293b;
      border-left: 1px solid #475569;
      padding: 0.75rem;
      overflow-y: auto;
      font-size: 0.75rem;
    }

    .detail-pane-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #475569;
    }

    .detail-pane-title {
      font-weight: 600;
      color: #f1f5f9;
      font-size: 0.875rem;
    }

    .detail-pane-close {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 1rem;
      padding: 0.25rem;
    }

    .detail-pane-close:hover {
      color: #f1f5f9;
    }

    .detail-section {
      margin-bottom: 0.75rem;
    }

    .detail-section-title {
      font-weight: 600;
      color: #94a3b8;
      font-size: 0.6875rem;
      text-transform: uppercase;
      margin-bottom: 0.25rem;
    }

    .detail-section-content {
      color: #cbd5e1;
      font-family: monospace;
      font-size: 0.6875rem;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .detail-stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.5rem;
    }

    .detail-stat {
      background: #0f172a;
      padding: 0.5rem;
      border-radius: 0.25rem;
    }

    .detail-stat-label {
      color: #64748b;
      font-size: 0.625rem;
      text-transform: uppercase;
    }

    .detail-stat-value {
      color: #f1f5f9;
      font-size: 0.875rem;
      font-weight: 600;
    }

    .detail-preview {
      background: #0f172a;
      padding: 0.5rem;
      border-radius: 0.25rem;
      font-family: monospace;
      font-size: 0.625rem;
      color: #94a3b8;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 150px;
      overflow-y: auto;
    }

    .source-jump-button {
      margin-top: 0.375rem;
      padding: 0.25rem 0.5rem;
      background: #334155;
      border: 1px solid #475569;
      color: #93c5fd;
      font-size: 0.7rem;
      font-family: monospace;
      border-radius: 0.25rem;
      cursor: pointer;
      transition: all 0.15s;
    }

    .source-jump-button:hover {
      background: #475569;
      color: #bfdbfe;
    }

    .detail-cell-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .detail-cell {
      background: #0f172a;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-family: monospace;
      font-size: 0.625rem;
      color: #94a3b8;
      word-break: break-all;
    }

    .adjacent-nodes {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .adjacent-node {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.5rem;
      background: #0f172a;
      border-radius: 0.25rem;
      cursor: pointer;
      transition: background 0.2s;
    }

    .adjacent-node:hover {
      background: #1e3a5f;
    }

    .adjacent-node .type-badge {
      flex-shrink: 0;
    }

    .adjacent-node-label {
      font-family: monospace;
      font-size: 0.6875rem;
      color: #e2e8f0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Delta styles for baseline comparison */
    .delta {
      font-size: 0.625rem;
      margin-left: 0.25rem;
    }

    .delta.positive {
      color: #f59e0b;
    }

    .delta.zero {
      color: #64748b;
    }

    .stat-with-delta {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }

    .stat-with-delta .stat-main {
      font-variant-numeric: tabular-nums;
    }

    .stat-with-delta .stat-delta {
      font-size: 0.625rem;
      color: #64748b;
    }

    .stat-with-delta .stat-delta.positive {
      color: #f59e0b;
    }

    .detail-stat-delta {
      font-size: 0.625rem;
      color: #64748b;
      margin-top: 0.125rem;
    }

    .detail-stat-delta.positive {
      color: #f59e0b;
    }

    .baseline-stats {
      border-left: 1px solid #475569;
      padding-left: 1rem;
      margin-left: 0.5rem;
    }

    .baseline-stats .stat-value {
      margin-left: 0.5rem;
    }

    .delta-sort-toggle {
      display: inline-flex;
      gap: 0;
      margin-left: 0.5rem;
      vertical-align: middle;
    }

    .delta-sort-toggle button {
      background: #334155;
      border: 1px solid #475569;
      color: #94a3b8;
      font-size: 0.5625rem;
      font-weight: 500;
      padding: 0.125rem 0.375rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .delta-sort-toggle button:first-child {
      border-radius: 0.25rem 0 0 0.25rem;
    }

    .delta-sort-toggle button:last-child {
      border-radius: 0 0.25rem 0.25rem 0;
      border-left: none;
    }

    .delta-sort-toggle button:hover {
      background: #475569;
      color: white;
    }

    .delta-sort-toggle button.active {
      background: #3b82f6;
      border-color: #3b82f6;
      color: white;
    }

    /* Flags view styles */
    .flags-container {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .flags-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
    }

    .flags-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #64748b;
      font-family: monospace;
      font-size: 0.8125rem;
    }

    .flags-section-title {
      color: #94a3b8;
      font-size: 0.6875rem;
      font-family: monospace;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.5rem 0.5rem 0.25rem;
      border-bottom: 1px solid #1e293b;
    }

    .flag-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem;
      border-radius: 0.25rem;
      cursor: pointer;
      font-family: monospace;
      font-size: 0.75rem;
      color: #cbd5e1;
      transition: background 0.15s;
    }

    .flag-item:hover {
      background: #1e293b;
    }

    .flag-item.selected {
      background: #1e3a5f;
      border-left: 2px solid #3b82f6;
    }

    .flag-warning {
      color: #f59e0b;
      font-size: 0.875rem;
    }

    .flag-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .flag-tag {
      padding: 0.125rem 0.375rem;
      background: #7f1d1d;
      color: #fca5a5;
      border-radius: 0.25rem;
      font-size: 0.625rem;
      white-space: nowrap;
    }

    .flag-unmatched {
      color: #64748b;
      font-size: 0.625rem;
      font-style: italic;
    }

    /* Flag metadata styles in detail pane */
    .flag-meta-title {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      color: #f59e0b;
    }

    .flag-meta-field {
      margin-bottom: 0.5rem;
    }

    .flag-meta-label {
      color: #94a3b8;
      font-size: 0.625rem;
      font-family: monospace;
      text-transform: uppercase;
      margin-bottom: 0.125rem;
    }

    .flag-meta-value {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 0.25rem;
      padding: 0.375rem;
      color: #e2e8f0;
      font-family: monospace;
      font-size: 0.625rem;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 12rem;
      overflow-y: auto;
      margin: 0;
    }
  `;

  @property({ attribute: false })
  accessor debuggerController: DebuggerController | undefined = undefined;

  /** Bumped when pattern sources arrive; forces re-render of source view */
  @property({ type: Number })
  accessor patternSourcesVersion = 0;

  /** Every node of the graph, whether the layout draws it or not. */
  @state()
  private accessor graphNodes = new Map<string, GraphNodeInfo>();

  /** Every edge of the graph, whether the layout draws it or not. */
  @state()
  private accessor graphEdges: readonly GraphEdgeWithHistory[] = [];

  @state()
  private accessor layoutNodes = new Map<string, LayoutNode>();

  @state()
  private accessor layoutEdges: LayoutEdge[] = [];

  @state()
  private accessor svgWidth = 800;

  @state()
  private accessor svgHeight = 400;

  @state()
  private accessor selectedEdge: LayoutEdge | null = null;

  @state()
  private accessor selectedNode: GraphNodeInfo | null = null;

  @state()
  private accessor tooltipPosition = { x: 0, y: 0 };

  @state()
  private accessor zoomLevel = 1.0;

  @state()
  private accessor expandedParents: ReadonlySet<string> = new Set<string>();

  @state()
  private accessor viewMode: "graph" | "table" | "flags" | "source" = "table";

  @state()
  private accessor tableSortColumn: TableSortColumn = "totalTime";

  @state()
  private accessor tableSortAscending = false;

  @state()
  private accessor tableExpandedParents = new Set<string>();

  /** Whether to sort the table by delta values instead of lifetime totals. */
  @state()
  private accessor sortByDelta = false;

  @query(".graph-container")
  private accessor graphContainer: HTMLElement | null = null;

  #lastGraphVersion = -1;
  #lastPatternSourcesVersion = -1;
  #hasInitialZoom = false;

  /** The laid-out nodes, whose positions a test reads. */
  get accessForTestingOnly(): {
    readonly layoutNodes: Map<string, LayoutNode>;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get layoutNodes() {
        return outerThis.layoutNodes;
      },
    };
  }

  /**
   * Get baseline stats from the controller (persists across tab switches)
   */
  get #baselineStats(): RunBaseline {
    return this.debuggerController?.getSchedulerBaselineStats() ?? new Map();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.#updateLayout();
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // Check if we need to update the graph
    if (this.debuggerController) {
      const currentVersion = this.debuggerController.getGraphUpdateVersion();
      if (currentVersion !== this.#lastGraphVersion) {
        this.#lastGraphVersion = currentVersion;
        this.#updateLayout();

        // Zoom to fit on first load
        if (!this.#hasInitialZoom && this.layoutNodes.size > 0) {
          this.#hasInitialZoom = true;
          requestAnimationFrame(() => this.#zoomToFit());
        }
      }

      // Re-render when pattern sources arrive (for source view)
      const sourcesVersion = this.debuggerController.getPatternSourcesVersion();
      if (sourcesVersion !== this.#lastPatternSourcesVersion) {
        this.#lastPatternSourcesVersion = sourcesVersion;
        this.requestUpdate();
      }
    }
  }

  #updateLayout(): void {
    if (!this.debuggerController) return;

    const graphData = this.debuggerController.getGraphWithHistory();
    if (!graphData) {
      this.graphNodes = new Map();
      this.graphEdges = [];
      this.layoutNodes = new Map();
      this.layoutEdges = [];
      return;
    }

    const layout = layoutSchedulerGraph(graphData, this.expandedParents);
    this.svgWidth = layout.width;
    this.svgHeight = layout.height;
    this.graphNodes = layout.allNodes;
    this.graphEdges = graphData.edges;
    this.layoutNodes = layout.nodes;
    this.layoutEdges = layout.edges;
  }

  async #handleSnapshot(): Promise<void> {
    await this.debuggerController?.requestGraphSnapshot();
    this.requestUpdate();
  }

  #handleResetBaseline(): void {
    // Store in controller so it persists across tab switches
    this.debuggerController?.setSchedulerBaselineStats(
      captureBaseline(this.graphNodes.values()),
    );
  }

  #handleEdgeClick(e: MouseEvent, edge: LayoutEdge): void {
    e.stopPropagation();

    this.selectedNode = null; // Clear node selection
    if (this.selectedEdge?.id === edge.id) {
      this.selectedEdge = null;
    } else {
      this.selectedEdge = edge;
      this.tooltipPosition = { x: e.clientX, y: e.clientY };
    }
  }

  #handleNodeClick(e: MouseEvent, node: LayoutNode): void {
    e.stopPropagation();

    this.selectedEdge = null; // Clear edge selection
    if (this.selectedNode?.id === node.id) {
      this.selectedNode = null;
    } else {
      this.selectedNode = node;
    }
  }

  #handleContainerClick(): void {
    this.selectedEdge = null;
    this.selectedNode = null;
  }

  #selectNode(node: GraphNodeInfo): void {
    this.selectedEdge = null;
    this.selectedNode = node;
  }

  #handleZoomIn(): void {
    this.#zoomAroundCenter(this.zoomLevel * 1.25);
  }

  #handleZoomOut(): void {
    this.#zoomAroundCenter(this.zoomLevel / 1.25);
  }

  #handleZoomReset(): void {
    this.#zoomToFit();
  }

  #centerOnNode(nodeId: string): void {
    const node = this.layoutNodes.get(nodeId);
    if (node) {
      this.zoomLevel = centerOn(
        this.graphContainer,
        node.x,
        node.y,
        this.zoomLevel,
        requestAnimationFrame,
      );
    }
  }

  #switchToGraphView(): void {
    const selectedId = this.selectedNode?.id;

    this.viewMode = "graph";

    // If there was a selection, center on it once the graph has rendered and
    // been laid out.
    if (selectedId) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => this.#centerOnNode(selectedId))
      );
    }
  }

  async #switchToSourceView(): Promise<void> {
    this.viewMode = "source";
    await this.debuggerController?.requestPatternSources();
    this.requestUpdate();
  }

  #handleWheel(e: WheelEvent): void {
    // Only zoom if ctrl/cmd is held, otherwise allow normal scroll
    if (!e.ctrlKey && !e.metaKey) return;

    e.preventDefault();
    this.zoomLevel = zoomAtPointer(
      this.graphContainer,
      this.zoomLevel,
      e,
      requestAnimationFrame,
    );
  }

  #zoomAroundCenter(newZoom: number): void {
    zoomAroundCenter(
      this.graphContainer,
      this.zoomLevel,
      newZoom,
      requestAnimationFrame,
    );
    this.zoomLevel = newZoom;
  }

  #zoomToFit(): void {
    this.zoomLevel = fitZoom(
      this.graphContainer,
      this.svgWidth,
      this.svgHeight,
      this.zoomLevel,
    );
  }

  #handleToggleCollapse(nodeId: string, e: Event): void {
    e.stopPropagation();
    const expanded = new Set(this.expandedParents);
    if (!expanded.delete(nodeId)) expanded.add(nodeId);
    this.expandedParents = expanded;
    this.#updateLayout();
  }

  #renderToolbar(): TemplateResult {
    const nodeCount = this.layoutNodes.size;
    const edgeCount = this.layoutEdges.filter((e) => !e.isHistorical).length;
    const historicalCount = this.layoutEdges.filter((e) => e.isHistorical)
      .length;
    const totals = graphTotals(this.graphNodes.values(), this.#baselineStats);

    return html`
      <div class="toolbar">
        <div class="view-toggle">
          <button
            type="button"
            class="toggle-button ${this.viewMode === "graph" ? "active" : ""}"
            @click="${() => this.#switchToGraphView()}"
            title="Graph view"
          >
            Graph
          </button>
          <button
            type="button"
            class="toggle-button ${this.viewMode === "table" ? "active" : ""}"
            @click="${() => (this.viewMode = "table")}"
            title="Table view sorted by performance"
          >
            Table
          </button>
          <button
            type="button"
            class="toggle-button ${this.viewMode === "flags" ? "active" : ""}"
            @click="${() => {
              this.viewMode = "flags";
              this.debuggerController?.requestFlags();
            }}"
            title="Actions with invalid/pending inputs"
          >
            Data pending
          </button>
          <button
            type="button"
            class="toggle-button ${this.viewMode === "source" ? "active" : ""}"
            @click="${() => this.#switchToSourceView()}"
            title="View pattern source code with action heat map"
          >
            Source
          </button>
        </div>

        <button
          type="button"
          class="action-button"
          @click="${this.#handleResetBaseline}"
          title="Reset baseline to current stats (for delta tracking)"
        >
          Reset Baseline
        </button>

        <button
          type="button"
          class="action-button"
          @click="${this.#handleSnapshot}"
          title="Capture current scheduler state"
        >
          Snapshot
        </button>

        ${this.viewMode === "graph"
          ? html`
            <div class="zoom-controls">
              <button
                type="button"
                class="zoom-button"
                @click="${this.#handleZoomOut}"
                title="Zoom out"
              >
                -
              </button>
              <button
                type="button"
                class="zoom-level"
                @click="${this.#handleZoomReset}"
                title="Reset zoom"
              >
                ${Math.round(this.zoomLevel * 100)}%
              </button>
              <button
                type="button"
                class="zoom-button"
                @click="${this.#handleZoomIn}"
                title="Zoom in"
              >
                +
              </button>
            </div>
          `
          : ""}

        <div class="stats">
          <span>Nodes: <span class="stat-value">${nodeCount}</span></span>
          <span>Edges: <span class="stat-value">${edgeCount}</span></span>
          ${historicalCount > 0
            ? html`
              <span>Historical: <span class="stat-value">${historicalCount}</span></span>
            `
            : ""}
          <span>Total: <span class="stat-value">${totals.runCount} runs</span>
            <span class="stat-value">${formatDuration(
              totals.totalTime,
            )}</span></span>
          ${this.#baselineStats.size > 0
            ? this.#renderBaselineStats(totals.runDelta, totals.timeDelta)
            : ""}
        </div>
      </div>
    `;
  }

  /**
   * Render baseline stats separately to avoid deno fmt crash.
   * The crash occurs with deeply nested ternaries in class attributes
   * combined with multiline function calls in adjacent template expressions.
   */
  #renderBaselineStats(runsDelta: number, timeDelta: number): TemplateResult {
    const runsClass = runsDelta > 0
      ? "stat-value delta positive"
      : "stat-value delta";
    const timeClass = timeDelta > 0
      ? "stat-value delta positive"
      : "stat-value delta";

    return html`
      <span class="baseline-stats">
        Δ:
        <span class="${runsClass}">${formatDelta(runsDelta) || 0} runs</span>
        <span class="${timeClass}">${formatDelta(timeDelta, true) || "-"}</span>
      </span>
    `;
  }

  #renderNode(node: LayoutNode): TemplateResult {
    const isSelected = this.selectedNode?.id === node.id;

    const nodeClass = [
      "node-group",
      `node-${node.type}`,
      node.isDirty ? "node-dirty" : "",
      node.isPending ? "node-pending" : "",
      isSelected ? "node-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;

    return svgTag`
      <g
        class="${nodeClass}"
        transform="translate(${x}, ${y})"
        @click="${(e: MouseEvent) => this.#handleNodeClick(e, node)}"
        style="cursor: pointer;"
      >
        <title>${nodeTooltip(node)}</title>
        <rect
          class="node-rect"
          width="${node.width}"
          height="${node.height}"
        />
        <text
          class="node-type-badge"
          x="4"
          y="10"
        >
          ${node.type === "effect" ? "E" : node.type === "input" ? "I" : "C"}
        </text>
        <text
          class="node-label"
          x="${node.width / 2}"
          y="${node.height / 2 + 3}"
          text-anchor="middle"
        >
          ${node.label}
        </text>
        ${
      node.stats
        ? svgTag`
          <text
            class="node-stats"
            x="${node.width - 4}"
            y="${node.height - 4}"
            text-anchor="end"
          >
            ${node.stats.runCount}× ${node.stats.averageTime.toFixed(0)}ms
          </text>
        `
        : ""
    }
        ${this.#renderCollapseToggle(node)}
        ${this.#renderChildCountBadge(node)}
      </g>
    `;
  }

  #renderCollapseToggle(node: LayoutNode): TemplateResult | null {
    // Only show toggle if node has children
    if (!node.childCount) return null;

    const isCollapsed = !this.expandedParents.has(node.id);
    const symbol = isCollapsed ? "+" : "-";

    return svgTag`
      <text
        class="node-collapse-toggle"
        x="${node.width - 8}"
        y="12"
        text-anchor="middle"
        @click="${(e: Event) => this.#handleToggleCollapse(node.id, e)}"
      >
        ${symbol}
      </text>
    `;
  }

  #renderChildCountBadge(node: LayoutNode): TemplateResult | null {
    // Only show badge if this node has collapsed children
    if (!node.collapsedChildCount) return null;

    return svgTag`
      <text
        class="node-child-count"
        x="${node.width / 2}"
        y="${node.height + 12}"
        text-anchor="middle"
      >
        (${node.collapsedChildCount} hidden)
      </text>
    `;
  }

  #renderParentGroups(): TemplateResult[] {
    return [...computeParentGroups(this.layoutNodes).values()].map(
      ({ bounds, parent }) =>
        svgTag`
        <g class="parent-group">
          <rect
            class="parent-group-rect"
            x="${bounds.x}"
            y="${bounds.y}"
            width="${bounds.width}"
            height="${bounds.height}"
          />
          <text
            class="parent-group-label"
            x="${bounds.x + 6}"
            y="${bounds.y + 12}"
          >
            ${truncateLabel(parent.fullId, 12)}
          </text>
        </g>
      `,
    );
  }

  #renderEdge(edge: LayoutEdge): TemplateResult | null {
    const source = this.layoutNodes.get(edge.from);
    const target = this.layoutNodes.get(edge.to);
    if (!source || !target) return null;

    // A straight line from the bottom of the source to the top of the target.
    const path = `M ${source.x} ${source.y + source.height / 2} L ${target.x} ${
      target.y - target.height / 2
    }`;

    const edgeClasses = [
      "edge-path",
      edge.isHistorical ? "edge-historical" : "edge-current",
      edge.edgeType === "parent" ? "edge-parent" : "",
    ].filter(Boolean).join(" ");

    return svgTag`
      <path
        class="${edgeClasses}"
        d="${path}"
        marker-end="url(#arrowhead)"
        @click="${(e: MouseEvent) => this.#handleEdgeClick(e, edge)}"
      />
    `;
  }

  #renderGraph(): TemplateResult {
    if (this.layoutNodes.size === 0) {
      return html`
        <div class="empty-state">
          <div>No graph data available</div>
          <button
            type="button"
            class="action-button"
            @click="${this.#handleSnapshot}"
          >
            Load Graph
          </button>
        </div>
      `;
    }

    const scaledWidth = this.svgWidth * this.zoomLevel;
    const scaledHeight = this.svgHeight * this.zoomLevel;

    return html`
      <svg
        class="graph-svg"
        width="${scaledWidth}"
        height="${scaledHeight}"
        viewBox="0 0 ${this.svgWidth} ${this.svgHeight}"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon class="arrow-marker" points="0 0, 10 3.5, 0 7" />
          </marker>
        </defs>

        <g class="parent-groups">
          ${this.#renderParentGroups()}
        </g>

        <g class="edges">
          ${this.layoutEdges.map((edge) => this.#renderEdge(edge))}
        </g>

        <g class="nodes">
          ${[...this.layoutNodes.values()].map((node) =>
            this.#renderNode(node)
          )}
        </g>
      </svg>
    `;
  }

  #renderTooltip(): TemplateResult | null {
    if (!this.selectedEdge) return null;

    const fromNode = this.layoutNodes.get(this.selectedEdge.from);
    const toNode = this.layoutNodes.get(this.selectedEdge.to);

    return html`
      <div
        class="tooltip"
        style="left: ${this.tooltipPosition.x +
          10}px; top: ${this.tooltipPosition.y + 10}px;"
      >
        <div class="tooltip-title">
          ${fromNode?.label ?? this.selectedEdge.from} → ${toNode?.label ??
            this.selectedEdge.to}
        </div>
        <div class="tooltip-cells">
          ${this.selectedEdge.cells.length > 0
            ? this.selectedEdge.cells.map(
              (cell) =>
                html`
                  <div class="tooltip-cell">${cell}</div>
                `,
            )
            : html`
              <div class="tooltip-cell">(no cells tracked)</div>
            `}
        </div>
        ${this.selectedEdge.isHistorical
          ? html`
            <div style="color: #f59e0b; margin-top: 0.25rem;">
              Historical (no longer active)
            </div>
          `
          : ""}
      </div>
    `;
  }

  #renderDetailPane(): TemplateResult | null {
    if (this.selectedNode) return this.#renderNodeDetail(this.selectedNode);
    if (this.selectedEdge) return this.#renderEdgeDetail(this.selectedEdge);
    return null;
  }

  #renderNodeDetail(node: GraphNodeInfo): TemplateResult {
    const baseline = this.#baselineStats.get(node.id);
    const hasBaseline = this.#baselineStats.size > 0;

    const renderStatWithDelta = (
      label: string,
      value: number,
      baselineValue: number | undefined,
      isTime: boolean = false,
    ) => {
      const delta = value - (baselineValue ?? 0);
      const deltaStr = formatDelta(delta, isTime);
      return html`
        <div class="detail-stat">
          <div class="detail-stat-label">${label}</div>
          <div class="detail-stat-value">
            ${isTime ? formatDuration(value) : value}
          </div>
          ${hasBaseline && deltaStr
            ? html`
              <div class="detail-stat-delta ${delta > 0 ? "positive" : ""}">
                ${deltaStr}
              </div>
            `
            : ""}
        </div>
      `;
    };

    const renderAdjacent = (title: string, nodes: GraphNodeInfo[]) =>
      nodes.length > 0
        ? html`
          <div class="detail-section">
            <div class="detail-section-title">
              ${title} (${nodes.length})
            </div>
            <div class="adjacent-nodes">
              ${nodes.map(
                (n) =>
                  html`
                    <div
                      class="adjacent-node"
                      @click="${() => this.#selectNode(n)}"
                      title="${n.fullId}"
                    >
                      <span class="type-badge ${n.type}">${n.type}</span>
                      <span class="adjacent-node-label">${n.label}</span>
                    </div>
                  `,
              )}
            </div>
          </div>
        `
        : "";

    const renderCellList = (title: string, cells: string[] | undefined) =>
      cells && cells.length > 0
        ? html`
          <div class="detail-section">
            <div class="detail-section-title">
              ${title} (${cells.length})
            </div>
            <div class="detail-cell-list">
              ${cells.map(
                (cell) =>
                  html`
                    <div class="detail-cell">${cell}</div>
                  `,
              )}
            </div>
          </div>
        `
        : "";

    const hasSourceLocation = parseActionLocation(node.id) !== null;
    const flagMeta = this.debuggerController?.getFlagMetadata(
      "action invalid input",
      node.id,
    );

    return html`
      <div class="detail-pane">
        <div class="detail-pane-header">
          <span class="detail-pane-title">
            <span class="type-badge ${node.type}">${node.type}</span>
            ${node.label}
          </span>
          <button
            class="detail-pane-close"
            @click="${() => (this.selectedNode = null)}"
          >
            ×
          </button>
        </div>

        <div class="detail-section">
          <div class="detail-section-title">ID</div>
          <div class="detail-section-content">${node.fullId}</div>
        </div>

        ${node.stats
          ? html`
            <div class="detail-section">
              <div class="detail-section-title">Stats</div>
              <div class="detail-stats">
                ${renderStatWithDelta(
                  "Runs",
                  node.stats.runCount,
                  baseline?.runCount,
                )} ${renderStatWithDelta(
                  "Total",
                  node.stats.totalTime,
                  baseline?.totalTime,
                  true,
                )}
                <div class="detail-stat">
                  <div class="detail-stat-label">Average</div>
                  <div class="detail-stat-value">
                    ${formatDuration(node.stats.averageTime)}
                  </div>
                </div>
                <div class="detail-stat">
                  <div class="detail-stat-label">Last</div>
                  <div class="detail-stat-value">
                    ${formatDuration(node.stats.lastRunTime)}
                  </div>
                </div>
              </div>
            </div>
          `
          : ""} ${node.preview || hasSourceLocation
          ? html`
            <div class="detail-section">
              ${node.preview
                ? html`
                  <div class="detail-section-title">Code Preview</div>
                  <div class="detail-preview">${node.preview}</div>
                `
                : ""} ${hasSourceLocation
                ? html`
                  <button
                    type="button"
                    class="source-jump-button"
                    @click="${() => this.#switchToSourceView()}"
                    title="View in source with context"
                  >
                    View in Source
                  </button>
                `
                : ""}
            </div>
          `
          : ""} ${renderCellList("Reads", node.reads)} ${renderCellList(
            "Writes",
            node.writes,
          )} ${renderAdjacent(
            "Dependents",
            adjacentNodes(
              this.graphNodes,
              this.graphEdges,
              node.id,
              "inbound",
            ),
          )} ${renderAdjacent(
            "Dependencies",
            adjacentNodes(
              this.graphNodes,
              this.graphEdges,
              node.id,
              "outbound",
            ),
          )}
        ${flagMeta
          ? html`
            <div class="detail-section">
              <div class="detail-section-title flag-meta-title">
                <span class="flag-warning">&#x26a0;</span> Invalid Input Diagnostics
              </div>
              ${flagMeta.schema !== undefined
                ? html`
                  <div class="flag-meta-field">
                    <div class="flag-meta-label">Schema</div>
                    <pre class="flag-meta-value">${JSON.stringify(
                      flagMeta.schema,
                      null,
                      2,
                    )}</pre>
                  </div>
                `
                : ""} ${flagMeta.raw !== undefined
                ? html`
                  <div class="flag-meta-field">
                    <div class="flag-meta-label">Raw Value</div>
                    <pre class="flag-meta-value">${JSON.stringify(
                      flagMeta.raw,
                      null,
                      2,
                    )}</pre>
                  </div>
                `
                : ""}
            </div>
          `
          : ""}
      </div>
    `;
  }

  #renderEdgeDetail(edge: LayoutEdge): TemplateResult {
    const fromNode = this.layoutNodes.get(edge.from);
    const toNode = this.layoutNodes.get(edge.to);

    return html`
      <div class="detail-pane">
        <div class="detail-pane-header">
          <span class="detail-pane-title">Edge</span>
          <button
            class="detail-pane-close"
            @click="${() => (this.selectedEdge = null)}"
          >
            ×
          </button>
        </div>

        <div class="detail-section">
          <div class="detail-section-title">From</div>
          <div class="detail-section-content">
            ${fromNode?.label ?? edge.from}
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-title">To</div>
          <div class="detail-section-content">
            ${toNode?.label ?? edge.to}
          </div>
        </div>

        <div class="detail-section">
          <div class="detail-section-title">
            Cells (${edge.cells.length})
          </div>
          <div class="detail-cell-list">
            ${edge.cells.length > 0
              ? edge.cells.map(
                (c) =>
                  html`
                    <div class="detail-cell">${c}</div>
                  `,
              )
              : html`
                <div class="detail-cell">(no cells tracked)</div>
              `}
          </div>
        </div>

        ${edge.isHistorical
          ? html`
            <div
              class="detail-section"
              style="color: #f59e0b; font-style: italic;"
            >
              This edge is historical (no longer active)
            </div>
          `
          : ""}
      </div>
    `;
  }

  #renderLegend(): TemplateResult {
    return html`
      <div class="legend">
        <div class="legend-item">
          <div class="legend-swatch input"></div>
          <span>Input</span>
        </div>
        <div class="legend-item">
          <div class="legend-swatch computation"></div>
          <span>Computation</span>
        </div>
        <div class="legend-item">
          <div class="legend-swatch effect"></div>
          <span>Effect</span>
        </div>
        <div class="legend-item">
          <div class="legend-line"></div>
          <span>Data</span>
        </div>
        <div class="legend-item">
          <div class="legend-line parent"></div>
          <span>Parent</span>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      ${this.#renderToolbar()} ${this.viewMode === "graph"
        ? html`
          <div class="graph-wrapper">
            <div
              class="graph-container"
              @click="${this.#handleContainerClick}"
              @wheel="${this.#handleWheel}"
            >
              ${this.#renderGraph()} ${this.#renderTooltip()} ${this
                .#renderLegend()}
            </div>
            ${this.#renderDetailPane()}
          </div>
        `
        : this.viewMode === "flags"
        ? this.#renderFlagsView()
        : this.viewMode === "source"
        ? this.#renderSourceView()
        : this.#renderTable()}
    `;
  }

  #renderSourceView(): TemplateResult {
    const sources = this.debuggerController?.getPatternSources() ?? [];
    const sourceNodes = new Map<string, SourceViewNode>();
    for (const [id, node] of this.graphNodes) {
      sourceNodes.set(id, {
        id,
        type: node.type,
        label: node.label,
        stats: node.stats
          ? {
            totalTime: node.stats.totalTime,
            runCount: node.stats.runCount,
          }
          : undefined,
        patternIdentity: node.patternIdentity,
      });
    }

    return html`
      <div class="table-wrapper">
        <x-scheduler-source
          .patternSources="${sources}"
          .nodes="${sourceNodes}"
          .selectedNodeId="${this.selectedNode?.id ?? null}"
          .baselineStats="${this.#baselineStats}"
          .breakpoints="${this.debuggerController?.getBreakpoints() ??
            new Set()}"
          @node-selected="${(e: CustomEvent) => {
            const node = this.graphNodes.get(e.detail.nodeId);
            if (node) this.#selectNode(node);
          }}"
          @breakpoint-toggle="${async (e: CustomEvent) => {
            const { actionIds, enabled } = e.detail;
            await this.debuggerController?.setBreakpointsForActions(
              actionIds,
              enabled,
            );
            this.requestUpdate();
          }}"
        ></x-scheduler-source>
        ${this.#renderDetailPane()}
      </div>
    `;
  }

  #renderFlagsView(): TemplateResult {
    const flags = this.debuggerController?.getActiveFlags() ?? {};
    const invalidInputIds = Object.keys(
      flags["runner"]?.["action invalid input"] ?? {},
    );

    if (invalidInputIds.length === 0) {
      return html`
        <div class="flags-container">
          <div class="flags-list">
            <div class="flags-empty">
              No actions with invalid inputs detected.
            </div>
          </div>
        </div>
      `;
    }

    const matched = invalidInputIds.flatMap((id) =>
      this.graphNodes.get(id) ?? []
    );
    const unmatched = invalidInputIds.filter((id) => !this.graphNodes.has(id));

    return html`
      <div class="flags-container">
        <div class="flags-list">
          <div class="flags-section-title">
            Actions with invalid inputs (${invalidInputIds.length})
          </div>
          ${matched.map((node) => {
            const isSelected = this.selectedNode?.id === node.id;
            return html`
              <div
                class="flag-item ${isSelected ? "selected" : ""}"
                @click="${() => this.#selectNode(node)}"
                title="${node.fullId}"
              >
                <span class="flag-warning">&#x26a0;</span>
                <span class="type-badge ${node.type}">${node.type}</span>
                <span class="flag-label">${node.label}</span>
                <span class="flag-tag">invalid input</span>
              </div>
            `;
          })} ${unmatched.length > 0
            ? html`
              <div class="flags-section-title">
                Not in graph (${unmatched.length})
              </div>
              ${unmatched.map((id) =>
                html`
                  <div
                    class="flag-item"
                    title="${id}"
                  >
                    <span class="flag-warning">&#x26a0;</span>
                    <span class="flag-label">${id}</span>
                    <span class="flag-unmatched">not in graph</span>
                    <span class="flag-tag">invalid input</span>
                  </div>
                `
              )}
            `
            : ""}
        </div>
        ${this.#renderDetailPane()}
      </div>
    `;
  }

  #renderTable(): TemplateResult {
    const hasBaseline = this.#baselineStats.size > 0;
    const groups = tableGroups(this.graphNodes.values(), this.#baselineStats, {
      column: this.tableSortColumn,
      ascending: this.tableSortAscending,
      byDelta: this.sortByDelta,
    });

    const sortIndicator = (col: TableSortColumn) => {
      const isSorted = this.tableSortColumn === col;
      const arrow = this.tableSortAscending ? "▲" : "▼";
      return html`
        <span class="sort-indicator">${isSorted ? arrow : ""}</span>
      `;
    };

    const handleSort = (col: TableSortColumn) => {
      if (this.tableSortColumn === col) {
        this.tableSortAscending = !this.tableSortAscending;
      } else {
        this.tableSortColumn = col;
        this.tableSortAscending = false;
      }
    };

    const renderStatWithDelta = (
      value: number,
      delta: number,
      isTime: boolean = false,
    ) => {
      const formatted = isTime ? formatDuration(value) : String(value);
      if (!hasBaseline) {
        return formatted;
      }
      const deltaStr = formatDelta(delta, isTime);
      return html`
        <div class="stat-with-delta">
          <span class="stat-main">${formatted}</span>
          ${deltaStr
            ? html`
              <span class="stat-delta ${delta > 0 ? "positive" : ""}">
                ${deltaStr}
              </span>
            `
            : ""}
        </div>
      `;
    };

    const toggleExpand = (id: string, e: Event) => {
      e.stopPropagation();
      if (this.tableExpandedParents.has(id)) {
        this.tableExpandedParents.delete(id);
      } else {
        this.tableExpandedParents.add(id);
      }
      this.requestUpdate();
    };

    const renderTimingBadges = (n: GraphNodeInfo) =>
      html`
        ${n.debounceMs
          ? html`
            <span
              class="timing-badge debounce"
              title="Debounced: waits ${n.debounceMs}ms before running"
            >D:${n.debounceMs}ms</span>
          `
          : ""} ${n.throttleMs
          ? html`
            <span
              class="timing-badge throttle"
              title="Throttled: runs at most once every ${n.throttleMs}ms"
            >T:${n.throttleMs}ms</span>
          `
          : ""}
      `;

    const renderRow = (row: TableRow) => {
      const n = row.node;
      const isSelected = this.selectedNode?.id === n.id;
      return html`
        <tr
          class="child-row ${isSelected ? "selected" : ""}"
          title="${n.fullId}${n.preview ? `\n\n${n.preview}` : ""}"
          @click="${() => this.#selectNode(n)}"
        >
          <td class="col-type">
            <span class="type-badge ${n.type}">${n.type}</span>
          </td>
          <td class="col-name">
            <span class="child-indent">└─</span>
            ${n.label} ${renderTimingBadges(n)}
          </td>
          <td class="col-number">
            ${renderStatWithDelta(row.runCount, row.runDelta)}
          </td>
          <td class="col-number">
            ${renderStatWithDelta(row.totalTime, row.timeDelta, true)}
          </td>
          <td class="col-number">${formatDuration(row.avgTime)}</td>
          <td class="col-number">${formatDuration(row.lastTime)}</td>
        </tr>
      `;
    };

    const renderGroupedRow = (group: TableGroup) => {
      const n = group.node;
      const isParent = group.children.length > 0;
      const isExpanded = this.tableExpandedParents.has(n.id);
      const isSelected = this.selectedNode?.id === n.id;
      // A collapsed row shows its descendants' figures summed in.
      const figures = isParent && !isExpanded ? group.aggregate : group;
      const renderFigure = (figure: TemplateResult | string) =>
        figures === group ? figure : html`
          <span class="aggregated">${figure}</span>
        `;

      return html`
        <tr
          class="parent-row ${isSelected ? "selected" : ""}"
          title="${n.fullId}${n.preview ? `\n\n${n.preview}` : ""}"
          @click="${() => this.#selectNode(n)}"
        >
          <td class="col-type">
            <span class="type-badge ${n.type}">${n.type}</span>
          </td>
          <td class="col-name">
            ${isParent
              ? html`
                <button
                  class="expand-toggle"
                  @click="${(e: Event) => toggleExpand(n.id, e)}"
                >
                  ${isExpanded ? "▼" : "▶"}
                </button>
              `
              : ""} ${n.label} ${isParent
              ? html`
                <span class="child-count">(${group.children.length})</span>
              `
              : ""} ${renderTimingBadges(n)}
          </td>
          <td class="col-number">
            ${renderFigure(
              renderStatWithDelta(figures.runCount, figures.runDelta),
            )}
          </td>
          <td class="col-number">
            ${renderFigure(
              renderStatWithDelta(figures.totalTime, figures.timeDelta, true),
            )}
          </td>
          <td class="col-number">${formatDuration(group.avgTime)}</td>
          <td class="col-number">${formatDuration(group.lastTime)}</td>
        </tr>
        ${isExpanded ? group.children.map(renderRow) : ""}
      `;
    };

    return html`
      <div class="table-wrapper">
        <div class="table-container">
          <table class="stats-table">
            <thead>
              <tr>
                <th class="col-type">Type</th>
                <th class="col-name">Action</th>
                <th
                  class="col-number ${this.tableSortColumn === "runCount"
                    ? "sorted"
                    : ""}"
                  @click="${() => handleSort("runCount")}"
                >
                  Runs ${sortIndicator("runCount")}
                </th>
                <th
                  class="col-number ${this.tableSortColumn === "totalTime"
                    ? "sorted"
                    : ""}"
                  @click="${() => handleSort("totalTime")}"
                >
                  Total ${sortIndicator("totalTime")} ${hasBaseline
                    ? html`
                      <span class="delta-sort-toggle">
                        <button
                          type="button"
                          class="${!this.sortByDelta ? "active" : ""}"
                          @click="${(e: Event) => {
                            e.stopPropagation();
                            this.sortByDelta = false;
                          }}"
                          title="Sort by lifetime totals"
                        >
                          All
                        </button>
                        <button
                          type="button"
                          class="${this.sortByDelta ? "active" : ""}"
                          @click="${(e: Event) => {
                            e.stopPropagation();
                            this.sortByDelta = true;
                          }}"
                          title="Sort by delta since baseline"
                        >
                          Δ
                        </button>
                      </span>
                    `
                    : ""}
                </th>
                <th
                  class="col-number ${this.tableSortColumn === "avgTime"
                    ? "sorted"
                    : ""}"
                  @click="${() => handleSort("avgTime")}"
                >
                  Avg ${sortIndicator("avgTime")}
                </th>
                <th
                  class="col-number ${this.tableSortColumn === "lastTime"
                    ? "sorted"
                    : ""}"
                  @click="${() => handleSort("lastTime")}"
                >
                  Last ${sortIndicator("lastTime")}
                </th>
              </tr>
            </thead>
            <tbody>
              ${groups.map(renderGroupedRow)}
            </tbody>
          </table>
        </div>
        ${this.#renderDetailPane()}
      </div>
    `;
  }
}

globalThis.customElements.define("x-scheduler-graph", XSchedulerGraph);
