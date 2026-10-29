import { css, html, LitElement, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { PatternSourceInfo } from "@commonfabric/runtime-client";

/** Parsed source location from an action ID */
interface ActionLocation {
  file: string;
  line: number;
  col: number;
}

/** Individual action entry on a source line */
interface ActionEntry {
  nodeId: string;
  col: number;
  type: string; // "effect" | "computation" | "inactive"
  totalTime: number;
  runCount: number;
  deltaTime: number; // time since baseline
  deltaRuns: number; // runs since baseline
}

/** Aggregated info for all actions on a single source line */
interface LineAnnotation {
  entries: ActionEntry[];
  types: Set<string>; // "effect" | "computation"
  totalTime: number; // sum of all actions' totalTime on this line
  runCount: number; // sum of all actions' runCount on this line
  deltaTime: number; // sum of delta times since baseline
  deltaRuns: number; // sum of delta runs since baseline
}

/** Minimal node info passed from parent */
export interface SourceViewNode {
  id: string;
  type: string;
  label: string;
  stats?: { totalTime: number; runCount: number };

  /** Content identity of the pattern this node belongs to. */
  patternIdentity?: string;
}

/**
 * Parse an action ID into a source location.
 * IDs look like "action:HASH/api/patterns/file.tsx:42:15"
 * or "/main.tsx:42:15 [via ...]"
 */
export function parseActionLocation(
  actionId: string,
): ActionLocation | null {
  let clean = actionId.replace(/\s*\[via.*\]$/, "");
  // Strip "action:HASH" prefix — the file path starts at the first "/"
  const slashIdx = clean.indexOf("/");
  if (slashIdx > 0) {
    clean = clean.slice(slashIdx);
  }
  const match = clean.match(/^(.+):(\d+):(\d+)$/);
  if (!match) return null;
  return {
    file: match[1],
    line: parseInt(match[2], 10),
    col: parseInt(match[3], 10),
  };
}

/**
 * Source code browser for the scheduler debugger.
 * Shows pattern source with action lines highlighted as a heat map.
 */
export class XSchedulerSource extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .source-toolbar {
      display: flex;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      align-items: center;
      flex-shrink: 0;
    }

    .source-toolbar select {
      background: #334155;
      border: 1px solid #475569;
      color: #e2e8f0;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-family: monospace;
    }

    .source-toolbar label {
      color: #94a3b8;
      font-size: 0.75rem;
      font-family: monospace;
    }

    .file-tabs {
      display: flex;
      gap: 0;
      overflow-x: auto;
    }

    .file-tab {
      padding: 0.25rem 0.75rem;
      background: #334155;
      border: 1px solid #475569;
      border-bottom: none;
      color: #94a3b8;
      font-size: 0.7rem;
      font-family: monospace;
      cursor: pointer;
      white-space: nowrap;
    }

    .file-tab:first-child {
      border-radius: 0.25rem 0 0 0;
    }

    .file-tab:last-child {
      border-radius: 0 0.25rem 0 0;
    }

    .file-tab:not(:first-child) {
      border-left: none;
    }

    .file-tab:hover {
      background: #475569;
      color: white;
    }

    .file-tab.active {
      background: #1e293b;
      color: #e2e8f0;
      border-bottom-color: #1e293b;
    }

    .source-container {
      flex: 1;
      overflow: auto;
      background: #0f172a;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
      font-size: 12px;
      line-height: 1.5;
    }

    .source-table {
      border-collapse: collapse;
      width: 100%;
    }

    .source-line {
      cursor: default;
      transition: background-color 0.15s;
    }

    .source-line:hover {
      filter: brightness(1.2);
    }

    .source-line.has-action .line-code,
    .source-line.has-action .line-stats,
    .source-line.has-action .line-markers {
      cursor: pointer;
    }

    .source-line.selected {
      outline: 1px solid #60a5fa;
      outline-offset: -1px;
    }

    .line-bp {
      padding: 0;
      width: 20px;
      min-width: 20px;
      text-align: center;
      vertical-align: middle;
      cursor: pointer;
      user-select: none;
    }

    .bp-indicator {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      vertical-align: middle;
      pointer-events: none;
    }

    .source-line:not(.has-action) .bp-indicator {
      visibility: hidden;
    }

    .source-line.has-action .bp-indicator {
      border: 2px solid #94a3b8;
      background: transparent;
    }

    .source-line.has-action:hover .bp-indicator {
      border-color: #ef4444;
      background: rgba(239, 68, 68, 0.3);
    }

    .bp-indicator.active {
      border-color: #ef4444 !important;
      background: #ef4444 !important;
      box-shadow: 0 0 4px rgba(239, 68, 68, 0.6);
    }

    .line-gutter {
      padding: 0 0.5rem 0 0.25rem;
      text-align: right;
      color: #475569;
      user-select: none;
      white-space: nowrap;
      vertical-align: top;
      width: 1px;
      cursor: pointer;
    }

    .line-markers {
      padding: 0 0.25rem;
      width: 1px;
      vertical-align: top;
    }

    .marker-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin: 0 1px;
      vertical-align: middle;
    }

    .marker-dot.effect {
      background: #3b82f6;
    }

    .marker-dot.computation {
      background: #a78bfa;
    }

    .marker-dot.inactive {
      background: #64748b;
    }

    .marker-dot.selected-entry {
      outline: 1px solid white;
    }

    .line-code {
      padding: 0 1rem 0 0.5rem;
      white-space: pre;
      color: #e2e8f0;
    }

    .line-stats {
      padding: 0 0.75rem 0 0.5rem;
      text-align: right;
      color: #94a3b8;
      font-size: 0.65rem;
      white-space: nowrap;
      vertical-align: top;
      width: 1px;
    }

    .delta-time {
      color: #fbbf24;
    }

    .entry-count {
      color: #64748b;
      margin-left: 0.25rem;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #64748b;
      font-family: monospace;
      font-size: 0.85rem;
    }
  `;

  @property({ attribute: false })
  accessor patternSources: PatternSourceInfo[] = [];

  @property({ attribute: false })
  accessor nodes: Map<string, SourceViewNode> = new Map();

  @property({ attribute: false })
  accessor selectedNodeId: string | null = null;

  @property({ attribute: false })
  accessor baselineStats: Map<string, { runCount: number; totalTime: number }> =
    new Map();

  @property({ attribute: false })
  accessor breakpoints: Set<string> = new Set();

  @state()
  private accessor selectedPatternIdx = 0;

  @state()
  private accessor selectedFileIdx = 0;

  /** Index into the current line's entries for cycling through actions */
  @state()
  private accessor selectedEntryIdx = 0;

  /** Build lookup: file -> line -> LineAnnotation */
  #buildAnnotations(): Map<string, Map<number, LineAnnotation>> {
    const result = new Map<string, Map<number, LineAnnotation>>();

    for (const [nodeId, node] of this.nodes) {
      const loc = parseActionLocation(nodeId);
      if (!loc) continue;

      // Only include nodes belonging to the current pattern
      const patternIdx = Math.min(
        this.selectedPatternIdx,
        this.patternSources.length - 1,
      );
      const currentPattern = this.patternSources[patternIdx];
      if (
        currentPattern && node.patternIdentity &&
        node.patternIdentity !== currentPattern.identity
      ) {
        continue;
      }

      let fileMap = result.get(loc.file);
      if (!fileMap) {
        fileMap = new Map();
        result.set(loc.file, fileMap);
      }

      let annotation = fileMap.get(loc.line);
      if (!annotation) {
        annotation = {
          entries: [],
          types: new Set(),
          totalTime: 0,
          runCount: 0,
          deltaTime: 0,
          deltaRuns: 0,
        };
        fileMap.set(loc.line, annotation);
      }

      const totalTime = node.stats?.totalTime ?? 0;
      const runCount = node.stats?.runCount ?? 0;
      const baseline = this.baselineStats.get(nodeId);
      const deltaTime = totalTime - (baseline?.totalTime ?? 0);
      const deltaRuns = runCount - (baseline?.runCount ?? 0);

      annotation.entries.push({
        nodeId,
        col: loc.col,
        type: node.type,
        totalTime,
        runCount,
        deltaTime,
        deltaRuns,
      });
      annotation.types.add(node.type);
      annotation.totalTime += totalTime;
      annotation.runCount += runCount;
      annotation.deltaTime += deltaTime;
      annotation.deltaRuns += deltaRuns;
    }

    // Sort entries within each line by column position
    for (const fileMap of result.values()) {
      for (const ann of fileMap.values()) {
        ann.entries.sort((a, b) => a.col - b.col);
      }
    }

    return result;
  }

  /** Compute heat color based on totalTime relative to max */
  #heatColor(
    totalTime: number,
    maxTime: number,
    types: Set<string>,
  ): string {
    if (maxTime === 0) return "transparent";
    // Use sqrt for better visual distribution
    const intensity = Math.sqrt(totalTime / maxTime);
    const alpha = 0.08 + intensity * 0.35;
    // Blue for effects, violet for computations, blend if both
    if (types.has("effect") && types.has("computation")) {
      return `rgba(99, 140, 255, ${alpha})`;
    } else if (types.has("computation")) {
      return `rgba(167, 139, 250, ${alpha})`;
    }
    return `rgba(59, 130, 246, ${alpha})`;
  }

  #formatTime(ms: number): string {
    if (ms === 0) return "";
    if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  #hasAnyBreakpoint(entries: ActionEntry[]): boolean {
    return entries.some((e) => this.breakpoints.has(e.nodeId));
  }

  #handleBreakpointToggle(entries: ActionEntry[]) {
    // If all are set, disable all; otherwise enable all
    const allSet = entries.every((e) => this.breakpoints.has(e.nodeId));
    const actionIds = entries.map((e) => e.nodeId);
    this.dispatchEvent(
      new CustomEvent("breakpoint-toggle", {
        detail: { actionIds, enabled: !allSet },
        bubbles: true,
        composed: true,
      }),
    );
    // Force local re-render since breakpoints Set is mutated in place upstream
    this.requestUpdate();
  }

  #handleLineClick(entries: ActionEntry[]) {
    // Caller must pass a non-empty entries array.
    if (entries.length === 0) {
      throw new Error("handleLineClick requires a non-empty entries array");
    }

    // If clicking the same line again, cycle to next entry
    const currentId = this.selectedNodeId;
    const currentIdx = entries.findIndex((e) => e.nodeId === currentId);
    const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % entries.length : 0;
    this.selectedEntryIdx = nextIdx;

    this.dispatchEvent(
      new CustomEvent("node-selected", {
        detail: {
          nodeId: entries[nextIdx].nodeId,
          allNodeIds: entries.map((e) => e.nodeId),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Navigate to the correct pattern, file, and line for the selected node */
  #navigateToSelectedNode() {
    if (!this.selectedNodeId || this.patternSources.length === 0) return;

    const loc = parseActionLocation(this.selectedNodeId);
    if (!loc) return;

    // Find the node to get its pattern identity
    const node = this.nodes.get(this.selectedNodeId);
    if (node?.patternIdentity) {
      const patternIdx = this.patternSources.findIndex(
        (p) => p.identity === node.patternIdentity,
      );
      if (patternIdx >= 0 && patternIdx !== this.selectedPatternIdx) {
        this.selectedPatternIdx = patternIdx;
      }
    }

    // Switch to the correct file tab
    const pattern = this.patternSources[this.selectedPatternIdx];
    if (pattern) {
      const fileIdx = pattern.files.findIndex(
        (f) => f.name === loc.file,
      );
      if (fileIdx >= 0 && fileIdx !== this.selectedFileIdx) {
        this.selectedFileIdx = fileIdx;
      }
    }

    // Scroll to the selected line after rendering
    this.updateComplete.then(() => {
      const row = this.shadowRoot?.querySelector(
        `.source-line[data-line="${loc.line}"]`,
      );
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    // Navigate when selectedNodeId changes or when patternSources arrive
    if (
      changedProperties.has("selectedNodeId") ||
      changedProperties.has("patternSources")
    ) {
      this.#navigateToSelectedNode();
    }
  }

  override render(): TemplateResult {
    if (this.patternSources.length === 0) {
      return html`
        <div class="empty-state">
          No pattern sources available. Click Refresh to load.
        </div>
      `;
    }

    // Clamp indices
    const patternIdx = Math.min(
      this.selectedPatternIdx,
      this.patternSources.length - 1,
    );
    const pattern = this.patternSources[patternIdx];
    if (!pattern || pattern.files.length === 0) {
      return html`
        <div class="empty-state">Pattern has no source files.</div>
      `;
    }

    const fileIdx = Math.min(this.selectedFileIdx, pattern.files.length - 1);
    const file = pattern.files[fileIdx];
    const lines = file.contents.split("\n");

    // Build annotations for current file
    const annotations = this.#buildAnnotations();
    const fileAnnotations = annotations.get(file.name) ?? new Map();

    // Use delta time for heat scaling when baseline exists, else total
    const hasBaseline = this.baselineStats.size > 0;
    let maxTime = 0;
    for (const ann of fileAnnotations.values()) {
      const t = hasBaseline ? ann.deltaTime : ann.totalTime;
      if (t > maxTime) maxTime = t;
    }

    // Find which line the selected node is on
    const selectedLoc = this.selectedNodeId
      ? parseActionLocation(this.selectedNodeId)
      : null;

    return html`
      <div class="source-toolbar">
        ${this.patternSources.length > 1
          ? html`
            <label>Pattern:</label>
            <select
              @change="${(e: Event) => {
                this.selectedPatternIdx =
                  (e.target as HTMLSelectElement).selectedIndex;
                this.selectedFileIdx = 0;
              }}"
            >
              ${this.patternSources.map(
                (p, i) =>
                  html`
                    <option ?selected="${i === patternIdx}">
                      ${p.identity.slice(0, 12)}
                    </option>
                  `,
              )}
            </select>
          `
          : html`
            <label>
              ${pattern.identity.slice(0, 12)}
            </label>
          `} ${pattern.files.length > 1
          ? html`
            <div class="file-tabs">
              ${pattern.files.map(
                (f, i) =>
                  html`
                    <button
                      type="button"
                      class="file-tab ${i === fileIdx ? "active" : ""}"
                      @click="${() => (this.selectedFileIdx = i)}"
                    >
                      ${f.name}
                    </button>
                  `,
              )}
            </div>
          `
          : html`
            <label>${file.name}</label>
          `}
      </div>

      <div class="source-container">
        <table class="source-table">
          <tbody>
            ${lines.map((lineText, i) => {
              const lineNum = i + 1;
              const ann = fileAnnotations.get(lineNum);
              const hasAction = !!ann;
              const isSelected = selectedLoc?.file === file.name &&
                selectedLoc?.line === lineNum;
              const heatTime = ann
                ? (hasBaseline ? ann.deltaTime : ann.totalTime)
                : 0;
              const bgColor = ann
                ? this.#heatColor(heatTime, maxTime, ann.types)
                : "transparent";

              const bpToggle = hasAction
                ? () => this.#handleBreakpointToggle(ann!.entries)
                : undefined;
              const nodeSelect = hasAction
                ? () => this.#handleLineClick(ann!.entries)
                : undefined;

              const bpClass = ann && this.#hasAnyBreakpoint(ann.entries)
                ? "active"
                : "";

              // deno-fmt-ignore
              return html`<tr class="source-line ${hasAction ? "has-action" : ""} ${isSelected ? "selected" : ""}" data-line="${lineNum}" style="background-color: ${bgColor}"><td class="line-bp" @click=${bpToggle}><span class="bp-indicator ${bpClass}"></span></td><td class="line-gutter" @click=${bpToggle}>${lineNum}</td><td class="line-markers" @click=${nodeSelect}>${ann ? ann.entries.map((entry: ActionEntry) => html`<span class="marker-dot ${entry.type} ${entry.nodeId === this.selectedNodeId ? "selected-entry" : ""}" title="col ${entry.col}: ${entry.type} ${this.#formatTime(entry.totalTime)}"></span>`) : ""}</td><td class="line-code" @click=${nodeSelect}>${lineText}</td><td class="line-stats" @click=${nodeSelect}>${ann ? this.#renderLineStats(ann, hasBaseline) : ""}</td></tr>`;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  #renderLineStats(
    ann: LineAnnotation,
    hasBaseline: boolean,
  ): TemplateResult {
    if (hasBaseline) {
      // Show delta time prominently
      if (ann.deltaRuns === 0) {
        return html`
          <span style="color:#475569">idle</span>
        `;
      }
      return html`
        <span class="delta-time">+${this.#formatTime(ann.deltaTime)}</span>
        (${ann.deltaRuns}x)${ann.entries.length > 1
          ? html`
            <span class="entry-count">[${ann.entries.length}]</span>
          `
          : ""}
      `;
    }
    // No baseline — show totals
    return html`
      ${this.#formatTime(ann.totalTime)} ${ann.runCount > 0
        ? `(${ann.runCount}x)`
        : ""}${ann.entries.length > 1
        ? html`
          <span class="entry-count">[${ann.entries.length}]</span>
        `
        : ""}
    `;
  }
}

customElements.define("x-scheduler-source", XSchedulerSource);
