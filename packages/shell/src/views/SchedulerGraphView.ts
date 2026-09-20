import { ENTITY_URI_SCHEMES } from "@commonfabric/runner/entity-kind";
import type { SchedulerGraphNode } from "@commonfabric/runtime-client";
import dagre from "dagre";
// Note: deno fmt can crash on deeply nested ternaries in html/svg templates - see renderBaselineStats
import { css, html, LitElement, svg as svgTag, TemplateResult } from "lit";
import { property, query, state } from "lit/decorators.js";

import type { DebuggerController } from "../lib/debugger-controller.ts";

import { entityUriFromActionId } from "../lib/scheduler-graph-identity.ts";
// Loading this module defines the `x-scheduler-source` element that this
// view renders.
import {
  parseActionLocation,
  type SourceViewNode,
} from "./SchedulerSourceView.ts";

interface LayoutNode {
  id: string;
  label: string;
  fullId: string; // Full ID for tooltip
  type: "effect" | "computation" | "input";
  x: number;
  y: number;
  width: number;
  height: number;
  stats?: SchedulerGraphNode["stats"];
  isDirty: boolean;
  isPending: boolean;
  parentId?: string;
  childCount?: number;
  collapsedChildCount?: number; // Number of hidden children when collapsed
  preview?: string; // Function body preview for hover tooltip
  reads?: string[]; // Diagnostic: cell paths this action reads
  writes?: string[]; // Diagnostic: cell paths this action writes
  debounceMs?: number; // Current debounce delay in ms
  throttleMs?: number; // Current throttle period in ms
  patternIdentity?: string; // Content identity of the pattern this action belongs to
}

interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  cells: string[];
  isHistorical: boolean;
  edgeType?: "data" | "parent";
}

const NODE_WIDTH = 140;
const NODE_HEIGHT = 36;

// Entity-scheme parsers derived from the canonical scheme set, so a new
// entity kind cannot leave a stale `of|computed` alternation here.
const ENTITY_SCHEME_ALT = ENTITY_URI_SCHEMES.join("|");
const ENTITY_SCHEME_PART_RE = new RegExp(`^(?:${ENTITY_SCHEME_ALT}):(.*)$`);

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

    /* Glow animation */
    @keyframes node-glow {
      0% {
        filter: drop-shadow(0 0 8px currentColor);
      }
      100% {
        filter: drop-shadow(0 0 0 transparent);
      }
    }

    .node-triggered .node-rect {
      animation: node-glow 2s ease-out;
    }

    .node-effect.node-triggered {
      color: #3b82f6;
    }

    .node-computation.node-triggered {
      color: #8b5cf6;
    }

    .node-selected .node-rect {
      stroke: #f59e0b;
      stroke-width: 3;
    }

    /* Size boost animation for triggered nodes when zoomed out */
    @keyframes node-size-boost {
      0%,
      100% {
        transform: scale(1);
      }
      15% {
        transform: scale(2.5);
      }
      85% {
        transform: scale(2.5);
      }
    }

    .node-boosted {
      transform-origin: center center;
      animation: node-size-boost 2s ease-out;
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
  private accessor selectedNode: LayoutNode | null = null;

  @state()
  private accessor tooltipPosition = { x: 0, y: 0 };

  @state()
  private accessor triggeredNodes = new Map<string, number>(); // id -> timestamp

  @state()
  private accessor zoomLevel = 1.0;

  @state()
  private accessor collapsedParents = new Set<string>();

  @state()
  private accessor viewMode: "graph" | "table" | "flags" | "source" = "table";

  @state()
  private accessor tableSortColumn:
    | "totalTime"
    | "runCount"
    | "avgTime"
    | "lastTime" = "totalTime";

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

  /**
   * Get baseline stats from the controller (persists across tab switches)
   */
  get #baselineStats(): Map<
    string,
    { runCount: number; totalTime: number }
  > {
    return (
      this.debuggerController?.getSchedulerBaselineStats() ??
        new Map<string, { runCount: number; totalTime: number }>()
    );
  }

  /** Minimum effective node size before we boost triggered nodes. */
  static readonly #READABLE_THRESHOLD = 50;

  /** The two action-id label helpers, which a test drives directly. */
  static get accessForTestingOnly(): {
    extractEntityId(actionId: string): string | undefined;
    truncateLabel(label: string, maxLen?: number): string;
  } {
    return {
      extractEntityId: (actionId) => XSchedulerGraph.#extractEntityId(actionId),
      truncateLabel: (label, maxLen) =>
        XSchedulerGraph.#truncateLabel(label, maxLen),
    };
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
      this.layoutNodes = new Map();
      this.layoutEdges = [];
      return;
    }

    // Build a map of all nodes and identify which are hidden due to collapsed parents
    const nodeMap = new Map(graphData.nodes.map((n) => [n.id, n]));

    // Infer parent relationships for sinks without parents by matching entity IDs
    // This handles the case where sinks are created outside of action execution
    // but logically belong to a pattern/module action
    const inferredParents = this.#inferParentsByEntity(graphData.nodes);

    // Create a combined view with both explicit and inferred parents
    const effectiveParentId = (node: SchedulerGraphNode): string | undefined =>
      node.parentId || inferredParents.get(node.id);

    // Count children (explicit + inferred)
    const effectiveChildCounts = new Map<string, number>();
    for (const node of graphData.nodes) {
      const parent = effectiveParentId(node);
      if (parent) {
        effectiveChildCounts.set(
          parent,
          (effectiveChildCounts.get(parent) ?? 0) + 1,
        );
      }
    }

    // Auto-collapse all parents with children (always add new ones)
    const newCollapsed = new Set(this.collapsedParents);
    let hasNewCollapsed = false;
    for (const node of graphData.nodes) {
      const childCount = effectiveChildCounts.get(node.id) ?? 0;
      if (childCount > 0 && !newCollapsed.has(node.id)) {
        newCollapsed.add(node.id);
        hasNewCollapsed = true;
      }
    }
    if (hasNewCollapsed) {
      this.collapsedParents = newCollapsed;
    }

    const hiddenNodes = new Set<string>();
    const collapsedChildCounts = new Map<string, number>();

    // Find all nodes that should be hidden (their parent is collapsed)
    for (const node of graphData.nodes) {
      const parent = effectiveParentId(node);
      if (parent && this.collapsedParents.has(parent)) {
        hiddenNodes.add(node.id);
        // Count hidden children for the collapsed parent
        collapsedChildCounts.set(
          parent,
          (collapsedChildCounts.get(parent) ?? 0) + 1,
        );
      }
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: "TB",
      nodesep: 50,
      ranksep: 70,
      marginx: 20,
      marginy: 20,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes (excluding hidden ones)
    for (const node of graphData.nodes) {
      if (hiddenNodes.has(node.id)) continue;

      g.setNode(node.id, {
        label: XSchedulerGraph.#truncateLabel(node.id),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        type: node.type,
        stats: node.stats,
        isDirty: node.isDirty,
        isPending: node.isPending,
        parentId: effectiveParentId(node),
        childCount: effectiveChildCounts.get(node.id) ?? 0,
      });
    }

    // Add edges (excluding edges to/from hidden nodes)
    for (const edge of graphData.edges) {
      if (hiddenNodes.has(edge.from) || hiddenNodes.has(edge.to)) continue;
      g.setEdge(edge.from, edge.to, { cells: edge.cells });
    }

    // Run layout
    dagre.layout(g);

    // Extract positioned nodes
    const nodes = new Map<string, LayoutNode>();
    for (const nodeId of g.nodes()) {
      const node = g.node(nodeId);
      if (node) {
        const originalNode = nodeMap.get(nodeId);
        const effParent = originalNode
          ? effectiveParentId(originalNode)
          : undefined;
        const effChildCount = effectiveChildCounts.get(nodeId) ?? 0;
        nodes.set(nodeId, {
          id: nodeId,
          label: node.label,
          fullId: nodeId, // Store full ID for tooltip
          type: node.type as "effect" | "computation",
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          stats: originalNode?.stats,
          isDirty: originalNode?.isDirty ?? false,
          isPending: originalNode?.isPending ?? false,
          parentId: effParent,
          childCount: effChildCount > 0 ? effChildCount : undefined,
          collapsedChildCount: collapsedChildCounts.get(nodeId),
          preview: originalNode?.preview,
          reads: originalNode?.reads,
          writes: originalNode?.writes,
          debounceMs: originalNode?.debounceMs,
          throttleMs: originalNode?.throttleMs,
          patternIdentity: originalNode?.patternIdentity?.identity,
        });
      }
    }

    // Extract positioned edges
    const edges: LayoutEdge[] = [];
    for (const e of g.edges()) {
      const edgeData = g.edge(e);
      const originalEdge = graphData.edges.find(
        (edge) => edge.from === e.v && edge.to === e.w,
      );
      edges.push({
        id: `${e.v}->${e.w}`,
        from: e.v,
        to: e.w,
        cells: edgeData?.cells ?? [],
        isHistorical: originalEdge?.isHistorical ?? false,
        edgeType: originalEdge?.edgeType,
      });
    }

    // Calculate SVG dimensions
    const graphInfo = g.graph();
    this.svgWidth = Math.max(800, (graphInfo.width ?? 0) + 40);
    this.svgHeight = Math.max(400, (graphInfo.height ?? 0) + 40);

    this.layoutNodes = nodes;
    this.layoutEdges = edges;
  }

  /**
   * Creates a short, readable label from an action ID. A label no longer than
   * `maxLen` is returned unchanged.
   * Format: `prefix:...last4/path`
   *
   * The prefix and the `...last4` of the entity are never cut, and the path
   * takes the whole cut: it is cut to the room those two leave and ends in
   * `...`, and is left out when that room holds less than `/...`. The result
   * is therefore longer than `maxLen` when the prefix and the `...last4` alone
   * are, and only then. A label with no entity and path to tell apart is cut
   * from its end instead, to `maxLen` including the `...`. `maxLen` is at
   * least 3, the length of that `...`.
   *
   * Examples:
   * - `sink:did:key:z6Mkk/of:fid1:abcdwxyz/value` → `sink:...wxyz/value`
   * - the same label when `maxLen === 12` → `sink:...wxyz`
   * - `computation:did:key:z6Mkk/of:fid1:abcdwxyz/value` →
   *   `computation:...wxyz`
   * - `parentAction` → `parentAction`
   */
  static #truncateLabel(label: string, maxLen = 20): string {
    // Simple case - short enough already
    if (label.length <= maxLen) return label;

    // Try to parse structured IDs like "sink:did:key:.../of:fid1:abc.../path"
    // or "action:space/entity/path"

    // Check for sink: or other prefix
    const prefixMatch = label.match(
      /^(sink|action|handler|effect|computation):/i,
    );
    const prefix = prefixMatch ? prefixMatch[1] + ":" : "";
    const rest = prefix ? label.slice(prefix.length) : label;

    // Look for entity ID pattern (of:xxx / computed:xxx or just the entity
    // part after space/). Common patterns:
    // - did:key:z6Mkk.../of:fid1:abc123/path
    // - did:key:z6Mkk.../computed:fid1:abc123/path
    // - space/entityid/path

    // Try to find the last path segment(s) which are most meaningful
    const parts = rest.split("/");

    if (parts.length >= 2) {
      // Get the entity ID (usually the second-to-last non-empty part before path)
      // and the path (last parts)
      let entityPart = "";
      let pathParts: string[] = [];

      // Find entity ID - look for an entity URI scheme or use second part
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const schemeMatch = part.match(ENTITY_SCHEME_PART_RE);
        if (schemeMatch) {
          entityPart = schemeMatch[1]; // Remove the URI scheme
          pathParts = parts.slice(i + 1).filter((p) => p.length > 0);
          break;
        }
      }

      // If no entity scheme found, try to identify entity from structure
      if (!entityPart && parts.length >= 2) {
        // Assume last non-empty parts are the path, entity is before that
        const nonEmpty = parts.filter((p) => p.length > 0);
        if (nonEmpty.length >= 2) {
          // Take last 4 chars of entity-like part
          const potentialEntity = nonEmpty.find((p) => p.length > 20) ||
            nonEmpty[0];
          entityPart = potentialEntity;
          const entityIdx = nonEmpty.indexOf(potentialEntity);
          pathParts = nonEmpty.slice(entityIdx + 1);
        }
      }

      // Build short label: prefix + ...last4 + /path
      if (entityPart) {
        const shortEntity = entityPart.length > 4
          ? "..." + entityPart.slice(-4)
          : entityPart;
        const path = pathParts.length > 0 ? "/" + pathParts.join("/") : "";
        const head = prefix + shortEntity;
        if (head.length + path.length <= maxLen) return head + path;

        // The path takes the whole cut. What is left of it keeps at least its
        // `/` in front of the `...`, so that the `...` cannot be read as
        // belonging to the entity.
        const room = maxLen - head.length;
        return room >= 4 ? head + path.slice(0, room - 3) + "..." : head;
      }
    }

    // Fallback: simple truncation from end
    return label.slice(0, maxLen - 3) + "...";
  }

  /**
   * Extract the entity ID from an action name.
   * Handles formats like:
   * - sink:did:key:.../of:entityId/path
   * - action:pattern:did:key:.../computed:entityId/path
   */
  static #extractEntityId(actionId: string): string | undefined {
    const entityUri = entityUriFromActionId(actionId);
    if (entityUri) return entityUri;

    // Fallback: look for entity ID pattern after space identifier
    // Pattern: did:key:.../entityId/...
    const parts = actionId.split("/");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Entity IDs are typically long base32/base58 strings
      if (part.length > 40 && !part.includes(":")) {
        return part;
      }
    }

    return undefined;
  }

  /**
   * Infer parent relationships for sinks that don't have explicit parents.
   * Groups sinks with non-sink actions that share the same entity ID.
   */
  #inferParentsByEntity(
    nodes: SchedulerGraphNode[],
  ): Map<string, string> {
    const inferredParents = new Map<string, string>();

    // Group nodes by entity ID
    const nodesByEntity = new Map<string, SchedulerGraphNode[]>();
    for (const node of nodes) {
      const entityId = XSchedulerGraph.#extractEntityId(node.id);
      if (entityId) {
        if (!nodesByEntity.has(entityId)) {
          nodesByEntity.set(entityId, []);
        }
        nodesByEntity.get(entityId)!.push(node);
      }
    }

    // For each entity group, find sinks without parents and assign them
    // to a non-sink action in the same group
    for (const [_entityId, groupNodes] of nodesByEntity) {
      // Find sink nodes without parents
      const orphanSinks = groupNodes.filter(
        (n) => n.id.startsWith("sink:") && !n.parentId,
      );

      // Find the first non-sink action to use as parent
      // Prefer computations over effects as they're usually the "producer"
      const potentialParent = groupNodes.find(
        (n) => !n.id.startsWith("sink:") && n.type === "computation",
      ) || groupNodes.find((n) => !n.id.startsWith("sink:"));

      if (potentialParent && orphanSinks.length > 0) {
        for (const sink of orphanSinks) {
          inferredParents.set(sink.id, potentialParent.id);
        }
      }
    }

    return inferredParents;
  }

  async #handleSnapshot(): Promise<void> {
    await this.debuggerController?.requestGraphSnapshot();
    this.requestUpdate();
  }

  #handleResetBaseline(): void {
    // Capture current stats as the baseline
    const newBaseline = new Map<
      string,
      { runCount: number; totalTime: number }
    >();
    for (const node of this.layoutNodes.values()) {
      if (node.stats) {
        newBaseline.set(node.id, {
          runCount: node.stats.runCount,
          totalTime: node.stats.totalTime,
        });
      }
    }
    // Store in controller so it persists across tab switches
    this.debuggerController?.setSchedulerBaselineStats(newBaseline);
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

  #selectNodeById(nodeId: string): void {
    const node = this.layoutNodes.get(nodeId);
    if (node) {
      this.selectedEdge = null;
      this.selectedNode = node;
    }
  }

  #getInboundNodes(nodeId: string): LayoutNode[] {
    // Find edges where this node is the target (other nodes depend on this)
    const inboundEdges = this.layoutEdges.filter(
      (e) => e.to === nodeId && e.edgeType !== "parent",
    );
    const nodeIds = [...new Set(inboundEdges.map((e) => e.from))];
    return nodeIds
      .map((id) => this.layoutNodes.get(id))
      .filter((n): n is LayoutNode => n !== undefined);
  }

  #getOutboundNodes(nodeId: string): LayoutNode[] {
    // Find edges where this node is the source (this node depends on others)
    const outboundEdges = this.layoutEdges.filter(
      (e) => e.from === nodeId && e.edgeType !== "parent",
    );
    const nodeIds = [...new Set(outboundEdges.map((e) => e.to))];
    return nodeIds
      .map((id) => this.layoutNodes.get(id))
      .filter((n): n is LayoutNode => n !== undefined);
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
    if (!node) return;

    const container = this.graphContainer;
    if (!container) return;

    // Set zoom to 50%
    const targetZoom = 0.5;
    this.zoomLevel = targetZoom;

    // After render, center on the node
    requestAnimationFrame(() => {
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      // Calculate scroll position to center the node
      const nodeCenterX = node.x + node.width / 2;
      const nodeCenterY = node.y + node.height / 2;

      const scrollLeft = nodeCenterX * targetZoom - containerWidth / 2;
      const scrollTop = nodeCenterY * targetZoom - containerHeight / 2;

      container.scrollLeft = Math.max(0, scrollLeft);
      container.scrollTop = Math.max(0, scrollTop);
    });
  }

  #switchToGraphView(): void {
    const hadSelection = this.selectedNode !== null;
    const selectedId = this.selectedNode?.id;

    this.viewMode = "graph";

    // If there was a selection, center on it after the graph renders
    if (hadSelection && selectedId) {
      // Wait for layout to complete before centering
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.#centerOnNode(selectedId);
        });
      });
    }
  }

  #handleWheel(e: WheelEvent): void {
    // Only zoom if ctrl/cmd is held, otherwise allow normal scroll
    if (!e.ctrlKey && !e.metaKey) return;

    e.preventDefault();

    const container = this.graphContainer;
    if (!container) return;

    // Calculate zoom factor based on wheel delta
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(5.0, this.zoomLevel * zoomFactor));

    // Zoom around mouse position
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left + container.scrollLeft;
    const mouseY = e.clientY - rect.top + container.scrollTop;

    this.#zoomAroundPoint(newZoom, mouseX, mouseY);
  }

  #zoomAroundPoint(
    newZoom: number,
    pointX: number,
    pointY: number,
  ): void {
    const container = this.graphContainer;
    if (!container) {
      this.zoomLevel = newZoom;
      return;
    }

    const oldZoom = this.zoomLevel;
    if (oldZoom === newZoom) return;

    // Convert point to content coordinates
    const contentX = pointX / oldZoom;
    const contentY = pointY / oldZoom;

    // Update zoom
    this.zoomLevel = newZoom;

    // After render, adjust scroll to keep point under cursor
    requestAnimationFrame(() => {
      const newScrollLeft = contentX * newZoom -
        (pointX - container.scrollLeft);
      const newScrollTop = contentY * newZoom - (pointY - container.scrollTop);
      container.scrollLeft = Math.max(0, newScrollLeft);
      container.scrollTop = Math.max(0, newScrollTop);
    });
  }

  #zoomAroundCenter(newZoom: number): void {
    const container = this.graphContainer;
    if (!container) {
      this.zoomLevel = newZoom;
      return;
    }

    const oldZoom = this.zoomLevel;
    if (oldZoom === newZoom) return;

    // Get current scroll position and container dimensions
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    // Calculate the center point in content coordinates (at old zoom)
    const centerX = (scrollLeft + containerWidth / 2) / oldZoom;
    const centerY = (scrollTop + containerHeight / 2) / oldZoom;

    // Update zoom
    this.zoomLevel = newZoom;

    // After render, adjust scroll to keep center point centered
    requestAnimationFrame(() => {
      const newScrollLeft = centerX * newZoom - containerWidth / 2;
      const newScrollTop = centerY * newZoom - containerHeight / 2;
      container.scrollLeft = Math.max(0, newScrollLeft);
      container.scrollTop = Math.max(0, newScrollTop);
    });
  }

  #zoomToFit(): void {
    const container = this.graphContainer;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    // Calculate zoom to fit with some padding
    const padding = 40;
    const zoomX = (containerWidth - padding) / this.svgWidth;
    const zoomY = (containerHeight - padding) / this.svgHeight;
    const fitZoom = Math.min(zoomX, zoomY, 1.0); // Don't zoom in beyond 100%

    this.zoomLevel = Math.max(0.1, fitZoom);
  }

  get #effectiveNodeWidth(): number {
    return NODE_WIDTH * this.zoomLevel;
  }

  get #shouldBoostTriggeredNodes(): boolean {
    return this.#effectiveNodeWidth < XSchedulerGraph.#READABLE_THRESHOLD;
  }

  #handleToggleCollapse(nodeId: string, e: Event): void {
    e.stopPropagation();
    const newCollapsed = new Set(this.collapsedParents);
    if (newCollapsed.has(nodeId)) {
      newCollapsed.delete(nodeId);
    } else {
      newCollapsed.add(nodeId);
    }
    this.collapsedParents = newCollapsed;
    this.#updateLayout();
  }

  #renderToolbar(): TemplateResult {
    const nodeCount = this.layoutNodes.size;
    const edgeCount = this.layoutEdges.filter((e) => !e.isHistorical).length;
    const historicalCount = this.layoutEdges.filter((e) => e.isHistorical)
      .length;

    // Calculate lifetime totals (all runs since app start)
    let totalRuns = 0;
    let totalTime = 0;
    for (const node of this.layoutNodes.values()) {
      if (node.stats) {
        totalRuns += node.stats.runCount;
        totalTime += node.stats.totalTime;
      }
    }

    // Calculate delta since baseline (if baseline exists)
    const hasBaseline = this.#baselineStats.size > 0;
    let totalRunsSinceBaseline = 0;
    let totalTimeSinceBaseline = 0;

    if (hasBaseline) {
      for (const node of this.layoutNodes.values()) {
        if (node.stats) {
          const baseline = this.#baselineStats.get(node.id);
          totalRunsSinceBaseline += node.stats.runCount -
            (baseline?.runCount ?? 0);
          totalTimeSinceBaseline += node.stats.totalTime -
            (baseline?.totalTime ?? 0);
        }
      }
    }

    const formatTime = (ms: number) => {
      if (ms === 0) return "-";
      if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
      if (ms < 1000) return `${ms.toFixed(1)}ms`;
      return `${(ms / 1000).toFixed(2)}s`;
    };

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
            @click="${async () => {
              this.viewMode = "source";
              await this.debuggerController?.requestPatternSources();
              this.requestUpdate();
            }}"
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
          <span>Total: <span class="stat-value">${totalRuns} runs</span>
            <span class="stat-value">${formatTime(totalTime)}</span></span>
          ${hasBaseline
            ? this.#renderBaselineStats(
              totalRunsSinceBaseline,
              totalTimeSinceBaseline,
              formatTime,
            )
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
  #renderBaselineStats(
    runsDelta: number,
    timeDelta: number,
    formatTime: (ms: number) => string,
  ): TemplateResult {
    const runsClass = runsDelta > 0
      ? "stat-value delta positive"
      : "stat-value delta";
    const timeClass = timeDelta > 0
      ? "stat-value delta positive"
      : "stat-value delta";
    const runsPrefix = runsDelta > 0 ? "+" : "";
    const timePrefix = timeDelta > 0 ? "+" : "";

    return html`
      <span class="baseline-stats">
        Δ:
        <span class="${runsClass}">${runsPrefix}${runsDelta} runs</span>
        <span class="${timeClass}">${timePrefix}${formatTime(timeDelta)}</span>
      </span>
    `;
  }

  #renderNode(node: LayoutNode): TemplateResult {
    const isTriggered = this.triggeredNodes.has(node.id) &&
      Date.now() - (this.triggeredNodes.get(node.id) ?? 0) < 2000;

    // Boost triggered nodes when zoomed out below readable threshold
    const shouldBoost = isTriggered && this.#shouldBoostTriggeredNodes;

    const isSelected = this.selectedNode?.id === node.id;

    const nodeClass = [
      "node-group",
      `node-${node.type}`,
      node.isDirty ? "node-dirty" : "",
      node.isPending ? "node-pending" : "",
      isTriggered ? "node-triggered" : "",
      shouldBoost ? "node-boosted" : "",
      isSelected ? "node-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;

    // Build tooltip with preview and reads/writes diagnostic info
    let tooltip: string;
    if (node.type === "input") {
      tooltip = `${node.fullId}\n(Source cell - no writer)`;
    } else {
      const previewInfo = node.preview ? `\n\n${node.preview}` : "";
      const readsInfo = node.reads?.length
        ? `\nReads (${node.reads.length}): ${
          node.reads.slice(0, 5).join(", ")
        }${node.reads.length > 5 ? "..." : ""}`
        : "\nReads: none";
      const writesInfo = node.writes?.length
        ? `\nWrites (${node.writes.length}): ${
          node.writes.slice(0, 5).join(", ")
        }${node.writes.length > 5 ? "..." : ""}`
        : "\nWrites: none";
      tooltip = `${node.fullId}${previewInfo}${readsInfo}${writesInfo}`;
    }

    return svgTag`
      <g
        class="${nodeClass}"
        transform="translate(${x}, ${y})"
        @click="${(e: MouseEvent) => this.#handleNodeClick(e, node)}"
        style="cursor: pointer;"
      >
        <title>${tooltip}</title>
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
    if (!node.childCount || node.childCount === 0) return null;

    const isCollapsed = this.collapsedParents.has(node.id);
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
    if (!node.collapsedChildCount || node.collapsedChildCount === 0) {
      return null;
    }

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

  #computeParentGroups(): Map<
    string,
    { parent: LayoutNode; children: LayoutNode[]; bounds: DOMRect }
  > {
    const groups = new Map<
      string,
      { parent: LayoutNode; children: LayoutNode[]; bounds: DOMRect }
    >();

    // Find all parents that have visible children
    for (const node of this.layoutNodes.values()) {
      if (node.parentId) {
        const parent = this.layoutNodes.get(node.parentId);
        if (parent) {
          if (!groups.has(node.parentId)) {
            groups.set(node.parentId, {
              parent,
              children: [],
              bounds: new DOMRect(0, 0, 0, 0),
            });
          }
          groups.get(node.parentId)!.children.push(node);
        }
      }
    }

    // Calculate bounding boxes for each group
    const padding = 15;
    for (const group of groups.values()) {
      const allNodes = [group.parent, ...group.children];

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const node of allNodes) {
        const left = node.x - node.width / 2;
        const top = node.y - node.height / 2;
        const right = node.x + node.width / 2;
        const bottom = node.y + node.height / 2;

        minX = Math.min(minX, left);
        minY = Math.min(minY, top);
        maxX = Math.max(maxX, right);
        maxY = Math.max(maxY, bottom);
      }

      group.bounds = new DOMRect(
        minX - padding,
        minY - padding,
        maxX - minX + padding * 2,
        maxY - minY + padding * 2,
      );
    }

    return groups;
  }

  #renderParentGroups(): TemplateResult[] {
    const groups = this.#computeParentGroups();
    const results: TemplateResult[] = [];

    for (const group of groups.values()) {
      // Only render groups with at least one visible child
      if (group.children.length === 0) continue;

      const { bounds, parent } = group;
      const label = XSchedulerGraph.#truncateLabel(parent.label, 12);

      results.push(svgTag`
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
            ${label}
          </text>
        </g>
      `);
    }

    return results;
  }

  #renderEdge(edge: LayoutEdge): TemplateResult | null {
    const source = this.layoutNodes.get(edge.from);
    const target = this.layoutNodes.get(edge.to);
    if (!source || !target) return null;

    // Calculate edge path (from bottom of source to top of target)
    const x1 = source.x;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y - target.height / 2;

    // Simple straight line (could add bezier curves later)
    const path = `M ${x1} ${y1} L ${x2} ${y2}`;

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
    if (!this.selectedNode && !this.selectedEdge) return null;

    const formatTime = (ms: number) => {
      if (ms === 0) return "-";
      if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
      if (ms < 1000) return `${ms.toFixed(1)}ms`;
      return `${(ms / 1000).toFixed(2)}s`;
    };

    const formatDelta = (delta: number, isTime: boolean = false): string => {
      if (delta === 0) return "";
      const sign = delta > 0 ? "+" : "";
      if (isTime) {
        if (Math.abs(delta) < 1) return `${sign}${(delta * 1000).toFixed(0)}µs`;
        if (Math.abs(delta) < 1000) return `${sign}${delta.toFixed(1)}ms`;
        return `${sign}${(delta / 1000).toFixed(2)}s`;
      }
      return `${sign}${delta}`;
    };

    if (this.selectedNode) {
      const node = this.selectedNode;
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
              ${isTime ? formatTime(value) : value}
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
                      ${formatTime(node.stats.averageTime)}
                    </div>
                  </div>
                  <div class="detail-stat">
                    <div class="detail-stat-label">Last</div>
                    <div class="detail-stat-value">
                      ${formatTime(node.stats.lastRunTime)}
                    </div>
                  </div>
                </div>
              </div>
            `
            : ""} ${node.preview || this.#hasSourceLocation(node.id)
            ? html`
              <div class="detail-section">
                ${node.preview
                  ? html`
                    <div class="detail-section-title">Code Preview</div>
                    <div class="detail-preview">${node.preview}</div>
                  `
                  : ""} ${this.#hasSourceLocation(node.id)
                  ? html`
                    <button
                      type="button"
                      class="source-jump-button"
                      @click="${async () => {
                        this.viewMode = "source";
                        await this.debuggerController
                          ?.requestPatternSources();
                        this.requestUpdate();
                      }}"
                      title="View in source with context"
                    >
                      View in Source
                    </button>
                  `
                  : ""}
              </div>
            `
            : ""} ${node.reads && node.reads.length > 0
            ? html`
              <div class="detail-section">
                <div class="detail-section-title">
                  Reads (${node.reads.length})
                </div>
                <div class="detail-cell-list">
                  ${node.reads.map(
                    (r) =>
                      html`
                        <div class="detail-cell">${r}</div>
                      `,
                  )}
                </div>
              </div>
            `
            : ""} ${node.writes && node.writes.length > 0
            ? html`
              <div class="detail-section">
                <div class="detail-section-title">
                  Writes (${node.writes.length})
                </div>
                <div class="detail-cell-list">
                  ${node.writes.map(
                    (w) =>
                      html`
                        <div class="detail-cell">${w}</div>
                      `,
                  )}
                </div>
              </div>
            `
            : ""} ${(() => {
              const inbound = this.#getInboundNodes(node.id);
              return inbound.length > 0
                ? html`
                  <div class="detail-section">
                    <div class="detail-section-title">
                      Dependents (${inbound.length})
                    </div>
                    <div class="adjacent-nodes">
                      ${inbound.map(
                        (n) =>
                          html`
                            <div
                              class="adjacent-node"
                              @click="${() => this.#selectNodeById(n.id)}"
                              title="${n.fullId}"
                            >
                              <span class="type-badge ${n.type}">${n
                                .type}</span>
                              <span class="adjacent-node-label">${n
                                .label}</span>
                            </div>
                          `,
                      )}
                    </div>
                  </div>
                `
                : "";
            })()} ${(() => {
              const outbound = this.#getOutboundNodes(node.id);
              return outbound.length > 0
                ? html`
                  <div class="detail-section">
                    <div class="detail-section-title">
                      Dependencies (${outbound.length})
                    </div>
                    <div class="adjacent-nodes">
                      ${outbound.map(
                        (n) =>
                          html`
                            <div
                              class="adjacent-node"
                              @click="${() => this.#selectNodeById(n.id)}"
                              title="${n.fullId}"
                            >
                              <span class="type-badge ${n.type}">${n
                                .type}</span>
                              <span class="adjacent-node-label">${n
                                .label}</span>
                            </div>
                          `,
                      )}
                    </div>
                  </div>
                `
                : "";
            })()}
          ${(() => {
            const flagMeta = this.debuggerController?.getFlagMetadata(
              "action invalid input",
              node.id,
            );
            return flagMeta
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
              : "";
          })()}
        </div>
      `;
    }

    if (this.selectedEdge) {
      const fromNode = this.layoutNodes.get(this.selectedEdge.from);
      const toNode = this.layoutNodes.get(this.selectedEdge.to);

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
              ${fromNode?.label ?? this.selectedEdge.from}
            </div>
          </div>

          <div class="detail-section">
            <div class="detail-section-title">To</div>
            <div class="detail-section-content">
              ${toNode?.label ?? this.selectedEdge.to}
            </div>
          </div>

          <div class="detail-section">
            <div class="detail-section-title">
              Cells (${this.selectedEdge.cells.length})
            </div>
            <div class="detail-cell-list">
              ${this.selectedEdge.cells.length > 0
                ? this.selectedEdge.cells.map(
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

          ${this.selectedEdge.isHistorical
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

    return null;
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

  #hasSourceLocation(nodeId: string): boolean {
    return parseActionLocation(nodeId) !== null;
  }

  #renderSourceView(): TemplateResult {
    const sources = this.debuggerController?.getPatternSources() ?? [];
    // Build SourceViewNode map from layoutNodes
    const sourceNodes = new Map<string, SourceViewNode>();
    for (const [id, node] of this.layoutNodes) {
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
            const node = this.layoutNodes.get(e.detail.nodeId);
            if (node) {
              this.selectedNode = node;
              this.selectedEdge = null;
            }
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
    const invalidInputMap = flags["runner"]?.["action invalid input"] ?? {};
    const invalidInputIds = Object.keys(invalidInputMap);

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

    // Split into matched (in graph) and unmatched IDs
    const matched: {
      id: string;
      node: LayoutNode;
      metadata: Record<string, unknown> | null;
    }[] = [];
    const unmatched: {
      id: string;
      metadata: Record<string, unknown> | null;
    }[] = [];

    for (const id of invalidInputIds) {
      const node = this.layoutNodes.get(id);
      const metadata = invalidInputMap[id] ?? null;
      if (node) {
        matched.push({ id, node, metadata });
      } else {
        unmatched.push({ id, metadata });
      }
    }

    return html`
      <div class="flags-container">
        <div class="flags-list">
          <div class="flags-section-title">
            Actions with invalid inputs (${invalidInputIds.length})
          </div>
          ${matched.map(({ id, node }) => {
            const isSelected = this.selectedNode?.id === id;
            return html`
              <div
                class="flag-item ${isSelected ? "selected" : ""}"
                @click="${() => {
                  this.selectedNode = node;
                  this.selectedEdge = null;
                }}"
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
              ${unmatched.map(({ id }) =>
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
    // Get all nodes with stats
    const allNodesWithStats = Array.from(this.layoutNodes.values())
      .filter((n) => n.type !== "input" && n.stats)
      .map((n) => ({
        id: n.id,
        fullId: n.fullId,
        label: n.label,
        type: n.type,
        preview: n.preview,
        parentId: n.parentId,
        runCount: n.stats?.runCount ?? 0,
        totalTime: n.stats?.totalTime ?? 0,
        avgTime: n.stats?.averageTime ?? 0,
        lastTime: n.stats?.lastRunTime ?? 0,
        lastTimestamp: n.stats?.lastRunTimestamp ?? 0,
        reads: n.reads,
        writes: n.writes,
        debounceMs: n.debounceMs,
        throttleMs: n.throttleMs,
      }));

    // Build parent-child hierarchy with aggregated stats
    type NodeWithStats = (typeof allNodesWithStats)[0];
    interface GroupedNode extends NodeWithStats {
      children: NodeWithStats[];
      aggregatedTotalTime: number;
      aggregatedRunCount: number;
      // Delta values (since baseline)
      deltaRunCount: number;
      deltaTotalTime: number;
      aggregatedDeltaRunCount: number;
      aggregatedDeltaTotalTime: number;
      isParent: boolean;
    }

    const nodeById = new Map(allNodesWithStats.map((n) => [n.id, n]));
    const childrenByParent = new Map<string, NodeWithStats[]>();

    // Helper to get delta for a node
    const getNodeDelta = (id: string, runCount: number, totalTime: number) => {
      const baseline = this.#baselineStats.get(id);
      return {
        deltaRunCount: runCount - (baseline?.runCount ?? 0),
        deltaTotalTime: totalTime - (baseline?.totalTime ?? 0),
      };
    };

    // Group children by parent
    for (const node of allNodesWithStats) {
      if (node.parentId && nodeById.has(node.parentId)) {
        if (!childrenByParent.has(node.parentId)) {
          childrenByParent.set(node.parentId, []);
        }
        childrenByParent.get(node.parentId)!.push(node);
      }
    }

    // Create grouped nodes (top-level = no parent or parent not in our list)
    const groupedNodes: GroupedNode[] = [];
    const processedChildren = new Set<string>();

    for (const node of allNodesWithStats) {
      // Skip if this is a child of a visible parent
      if (node.parentId && nodeById.has(node.parentId)) {
        processedChildren.add(node.id);
        continue;
      }

      const children = childrenByParent.get(node.id) ?? [];
      const aggregatedTotalTime = node.totalTime +
        children.reduce((sum, c) => sum + c.totalTime, 0);
      const aggregatedRunCount = node.runCount +
        children.reduce((sum, c) => sum + c.runCount, 0);

      // Calculate deltas
      const nodeDelta = getNodeDelta(node.id, node.runCount, node.totalTime);
      const childrenDeltaRunCount = children.reduce((sum, c) => {
        const d = getNodeDelta(c.id, c.runCount, c.totalTime);
        return sum + d.deltaRunCount;
      }, 0);
      const childrenDeltaTotalTime = children.reduce((sum, c) => {
        const d = getNodeDelta(c.id, c.runCount, c.totalTime);
        return sum + d.deltaTotalTime;
      }, 0);

      groupedNodes.push({
        ...node,
        children,
        aggregatedTotalTime,
        aggregatedRunCount,
        deltaRunCount: nodeDelta.deltaRunCount,
        deltaTotalTime: nodeDelta.deltaTotalTime,
        aggregatedDeltaRunCount: nodeDelta.deltaRunCount +
          childrenDeltaRunCount,
        aggregatedDeltaTotalTime: nodeDelta.deltaTotalTime +
          childrenDeltaTotalTime,
        isParent: children.length > 0,
      });
    }

    // Sort based on current column (and whether we're sorting by delta)
    const useDelta = this.sortByDelta && this.#baselineStats.size > 0;
    const sortNodes = (nodes: GroupedNode[]) => {
      nodes.sort((a, b) => {
        let cmp = 0;
        switch (this.tableSortColumn) {
          case "totalTime":
            cmp = useDelta
              ? b.aggregatedDeltaTotalTime - a.aggregatedDeltaTotalTime
              : b.aggregatedTotalTime - a.aggregatedTotalTime;
            break;
          case "runCount":
            cmp = useDelta
              ? b.aggregatedDeltaRunCount - a.aggregatedDeltaRunCount
              : b.aggregatedRunCount - a.aggregatedRunCount;
            break;
          case "avgTime":
            cmp = b.avgTime - a.avgTime;
            break;
          case "lastTime":
            cmp = b.lastTime - a.lastTime;
            break;
        }
        return this.tableSortAscending ? -cmp : cmp;
      });
    };
    sortNodes(groupedNodes);

    const sortIndicator = (col: typeof this.tableSortColumn) => {
      const isSorted = this.tableSortColumn === col;
      const arrow = this.tableSortAscending ? "▲" : "▼";
      return html`
        <span class="sort-indicator">${isSorted ? arrow : ""}</span>
      `;
    };

    const handleSort = (col: typeof this.tableSortColumn) => {
      if (this.tableSortColumn === col) {
        this.tableSortAscending = !this.tableSortAscending;
      } else {
        this.tableSortColumn = col;
        this.tableSortAscending = false;
      }
    };

    const formatTime = (ms: number) => {
      if (ms === 0) return "-";
      if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
      if (ms < 1000) return `${ms.toFixed(1)}ms`;
      return `${(ms / 1000).toFixed(2)}s`;
    };

    const hasBaseline = this.#baselineStats.size > 0;

    const getBaseline = (id: string) => this.#baselineStats.get(id);

    const getDelta = (
      current: number,
      baseline: number | undefined,
    ): number => {
      return current - (baseline ?? 0);
    };

    const formatDelta = (delta: number, isTime: boolean = false): string => {
      if (delta === 0) return "";
      const sign = delta > 0 ? "+" : "";
      if (isTime) {
        if (Math.abs(delta) < 1) return `${sign}${(delta * 1000).toFixed(0)}µs`;
        if (Math.abs(delta) < 1000) return `${sign}${delta.toFixed(1)}ms`;
        return `${sign}${(delta / 1000).toFixed(2)}s`;
      }
      return `${sign}${delta}`;
    };

    const renderStatWithDelta = (
      value: number,
      baselineValue: number | undefined,
      isTime: boolean = false,
    ) => {
      const delta = getDelta(value, baselineValue);
      const formatted = isTime ? formatTime(value) : String(value);
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

    const handleRowClick = (node: NodeWithStats) => {
      // Find the layout node and select it
      const layoutNode = this.layoutNodes.get(node.id);
      if (layoutNode) {
        this.selectedNode = layoutNode;
        this.selectedEdge = null;
      }
    };

    const renderRow = (
      n: NodeWithStats,
      isChild: boolean = false,
      _parentNode?: GroupedNode,
    ) => {
      const isSelected = this.selectedNode?.id === n.id;
      const baseline = getBaseline(n.id);
      return html`
        <tr
          class="${isChild ? "child-row" : ""} ${isSelected ? "selected" : ""}"
          title="${n.fullId}${n.preview ? `\n\n${n.preview}` : ""}"
          @click="${() => handleRowClick(n)}"
        >
          <td class="col-type">
            <span class="type-badge ${n.type}">${n.type}</span>
          </td>
          <td class="col-name">
            ${isChild
              ? html`
                <span class="child-indent">└─</span>
              `
              : ""} ${n.label} ${n.debounceMs
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
          </td>
          <td class="col-number">
            ${renderStatWithDelta(n.runCount, baseline?.runCount)}
          </td>
          <td class="col-number">
            ${renderStatWithDelta(n.totalTime, baseline?.totalTime, true)}
          </td>
          <td class="col-number">${formatTime(n.avgTime)}</td>
          <td class="col-number">${formatTime(n.lastTime)}</td>
        </tr>
      `;
    };

    const renderGroupedRow = (n: GroupedNode) => {
      const isExpanded = this.tableExpandedParents.has(n.id);
      const isSelected = this.selectedNode?.id === n.id;
      const rows: TemplateResult[] = [];

      // Get baseline for this node and calculate aggregated baseline
      const baseline = getBaseline(n.id);
      const aggregatedBaselineRunCount = (baseline?.runCount ?? 0) +
        n.children.reduce(
          (sum, c) => sum + (getBaseline(c.id)?.runCount ?? 0),
          0,
        );
      const aggregatedBaselineTotalTime = (baseline?.totalTime ?? 0) +
        n.children.reduce(
          (sum, c) => sum + (getBaseline(c.id)?.totalTime ?? 0),
          0,
        );

      // Parent row with aggregated stats
      rows.push(html`
        <tr
          class="parent-row ${isSelected ? "selected" : ""}"
          title="${n.fullId}${n.preview ? `\n\n${n.preview}` : ""}"
          @click="${() => handleRowClick(n)}"
        >
          <td class="col-type">
            <span class="type-badge ${n.type}">${n.type}</span>
          </td>
          <td class="col-name">
            ${n.isParent
              ? html`
                <button
                  class="expand-toggle"
                  @click="${(e: Event) => toggleExpand(n.id, e)}"
                >
                  ${isExpanded ? "▼" : "▶"}
                </button>
              `
              : ""} ${n.label} ${n.isParent
              ? html`
                <span class="child-count">(${n.children.length})</span>
              `
              : ""} ${n.debounceMs
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
          </td>
          <td class="col-number">
            ${n.isParent && !isExpanded
              ? html`
                <span class="aggregated">
                  ${renderStatWithDelta(
                    n.aggregatedRunCount,
                    hasBaseline ? aggregatedBaselineRunCount : undefined,
                  )}
                </span>
              `
              : renderStatWithDelta(n.runCount, baseline?.runCount)}
          </td>
          <td class="col-number">
            ${n.isParent && !isExpanded
              ? html`
                <span class="aggregated">
                  ${renderStatWithDelta(
                    n.aggregatedTotalTime,
                    hasBaseline ? aggregatedBaselineTotalTime : undefined,
                    true,
                  )}
                </span>
              `
              : renderStatWithDelta(n.totalTime, baseline?.totalTime, true)}
          </td>
          <td class="col-number">${formatTime(n.avgTime)}</td>
          <td class="col-number">${formatTime(n.lastTime)}</td>
        </tr>
      `);

      // Child rows (if expanded)
      if (isExpanded && n.children.length > 0) {
        // Sort children too (using delta if enabled)
        const sortedChildren = [...n.children].sort((a, b) => {
          let cmp = 0;
          const aDelta = getNodeDelta(a.id, a.runCount, a.totalTime);
          const bDelta = getNodeDelta(b.id, b.runCount, b.totalTime);
          switch (this.tableSortColumn) {
            case "totalTime":
              cmp = useDelta
                ? bDelta.deltaTotalTime - aDelta.deltaTotalTime
                : b.totalTime - a.totalTime;
              break;
            case "runCount":
              cmp = useDelta
                ? bDelta.deltaRunCount - aDelta.deltaRunCount
                : b.runCount - a.runCount;
              break;
            case "avgTime":
              cmp = b.avgTime - a.avgTime;
              break;
            case "lastTime":
              cmp = b.lastTime - a.lastTime;
              break;
          }
          return this.tableSortAscending ? -cmp : cmp;
        });
        for (const child of sortedChildren) {
          rows.push(renderRow(child, true, n));
        }
      }

      return rows;
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
              ${groupedNodes.map((n) => renderGroupedRow(n))}
            </tbody>
          </table>
        </div>
        ${this.#renderDetailPane()}
      </div>
    `;
  }
}

globalThis.customElements.define("x-scheduler-graph", XSchedulerGraph);
