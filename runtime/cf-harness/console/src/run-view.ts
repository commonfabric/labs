/**
 * One run, read whole. The timeline is the default reading — the run step by
 * step, with what went into each call and what came back — and the other panes
 * are the same run seen from a different angle.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import { type ConsoleRunDetail, readRun, readRunFile } from "./api.ts";
import "./steps-view.ts";

/** Which pane of the open run is showing. */
type Pane = "timeline" | "patterns" | "tool-outputs" | "artifacts";

const prettyJson = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // A payload that is not JSON is still worth showing as it stands.
    return text;
  }
};

export class ConsoleRunView extends LitElement {
  static override properties = {
    runId: { attribute: false },
    detail: { attribute: false },
    pane: { attribute: false },
    focusStep: { attribute: false },
    rawName: { attribute: false },
    rawText: { attribute: false },
    error: { attribute: false },
  };

  declare runId: string | undefined;
  declare detail: ConsoleRunDetail | undefined;
  declare pane: Pane;

  /** The step the map asked the timeline to show. */
  declare focusStep: number | undefined;

  declare rawName: string | undefined;
  declare rawText: string | undefined;
  declare error: string | undefined;

  /**
   * Which read of a run is the current one. A running turn re-reads on every
   * tool completion and a click can switch runs mid-read, so two reads are
   * routinely in flight and the network is free to answer them in either order;
   * only the newest one is allowed to say what the pane shows.
   */
  #reads = 0;

  constructor() {
    super();
    this.pane = "timeline";
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("runId") && this.runId !== changed.get("runId")) {
      this.rawName = undefined;
      this.rawText = undefined;
      this.pane = "timeline";
      void this.refresh();
    }
  }

  /** Re-reads the open run, which a running turn's new steps arrive through. */
  async refresh(): Promise<void> {
    const read = ++this.#reads;
    const runId = this.runId;
    if (runId === undefined) {
      this.detail = undefined;
      return;
    }
    try {
      const detail = await readRun(runId);
      if (read !== this.#reads) {
        return;
      }
      this.detail = detail;
      this.error = undefined;
    } catch (error) {
      if (read !== this.#reads) {
        return;
      }
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Reads one file into the raw pane. What was asked for is remembered whole —
   * the run, the pane, and the name — because a second click while the first
   * file is still being read is what the pane is for, and a file that arrives
   * after the selection moved on is no longer what is showing.
   */
  async #showRaw(
    kind: "artifacts" | "tool-outputs",
    name: string,
  ): Promise<void> {
    const detail = this.detail;
    if (detail === undefined) {
      return;
    }
    const runId = detail.summary.runId;
    const pane = this.pane;
    this.rawName = name;
    this.rawText = undefined;
    const stillShowing = (): boolean =>
      this.rawName === name && this.pane === pane &&
      this.detail?.summary.runId === runId;
    try {
      const text = prettyJson(await readRunFile(runId, kind, name));
      if (stillShowing()) {
        this.rawText = text;
      }
    } catch (error) {
      if (stillShowing()) {
        this.rawText = error instanceof Error ? error.message : String(error);
      }
    }
  }

  #patterns(detail: ConsoleRunDetail): TemplateResult {
    const { patternAttempts, searches, feedback, pieces } = detail.lens;
    if (
      patternAttempts.length === 0 && searches.length === 0 &&
      feedback.length === 0 && pieces.length === 0
    ) {
      return html`<p class="empty">This run did no pattern work.</p>`;
    }
    return html`
      ${searches.map((search) =>
        html`
          <div class="lens-item">
            <div class="label">
              searched <span class="tool">${search.query ?? ""}</span>
            </div>
            ${search.hits.length === 0
              ? html`<div class="body">no matches</div>`
              : html`
                <ul class="hits">
                  ${search.hits.map((hit) =>
                    html`
                      <li>
                        ${hit.description ?? hit.patternId ?? "unnamed"}
                        ${hit.score === undefined
                          ? nothing
                          : html`<span class="score">
                            ${hit.score.toFixed(2)}
                          </span>`}
                      </li>
                    `
                  )}
                </ul>
              `}
          </div>
        `
      )}
      ${patternAttempts.map((attempt, index) =>
        html`
          <div class="lens-item">
            <div class="label">
              attempt ${index + 1}
              <span class=${attempt.status === "ok" ? "ok" : "bad"}>
                ${attempt.status}
              </span>
              ${attempt.patternId === undefined
                ? nothing
                : html`<span class="tool">${attempt.patternId}</span>`}
              ${attempt.inputNames.length === 0
                ? nothing
                : html`<span class="inputs">
                  inputs: ${attempt.inputNames.join(", ")}
                </span>`}
            </div>
            ${attempt.message === undefined
              ? nothing
              : html`<div class="body code bad-body">${attempt.message}</div>`}
            ${attempt.source === undefined
              ? nothing
              : html`<pre class="raw">${attempt.source}</pre>`}
          </div>
        `
      )}
      ${pieces.map((piece) =>
        html`
          <div class="lens-item">
            <div class="label">
              named <span class="tool">${piece.slug ?? ""}</span>
            </div>
            ${piece.url === undefined ? nothing : html`
              <a href=${piece.url} rel="noopener" target="_blank">
                ${piece.url}
              </a>
            `}
          </div>
        `
      )}
      ${feedback.map((record) =>
        html`
          <div class="lens-item">
            <div class="label">
              feedback <span class="tool">${record.verdict ?? ""}</span>
              ${record.patternId ?? ""}
            </div>
            ${record.note === undefined
              ? nothing
              : html`<div class="body">${record.note}</div>`}
          </div>
        `
      )}
    `;
  }

  #files(
    kind: "artifacts" | "tool-outputs",
    names: readonly string[],
  ): TemplateResult {
    if (names.length === 0) {
      return html`<p class="empty">This run wrote none.</p>`;
    }
    return html`
      <div class="file-list">
        ${names.map((name) =>
          html`
            <button
              class="file ${this.rawName === name ? "open" : ""}"
              type="button"
              @click=${() => this.#showRaw(kind, name)}
            >
              ${name}
            </button>
          `
        )}
      </div>
      ${this.rawName === undefined || !names.includes(this.rawName)
        ? nothing
        : html`<pre class="raw">${this.rawText ?? "reading…"}</pre>`}
    `;
  }

  protected override render(): TemplateResult {
    if (this.runId === undefined) {
      return html`
        <p class="empty">Choose a run to read what it did, step by step.</p>
      `;
    }
    if (this.error !== undefined) {
      return html`<p class="empty bad">${this.error}</p>`;
    }
    const detail = this.detail;
    if (detail === undefined) {
      return html`<p class="empty">Reading…</p>`;
    }
    const tab = (pane: Pane, label: string) =>
      html`
        <button
          class="tab ${this.pane === pane ? "on" : ""}"
          type="button"
          @click=${() => {
            this.pane = pane;
            this.rawName = undefined;
            this.rawText = undefined;
          }}
        >
          ${label}
        </button>
      `;
    return html`
      <div class="run-detail">
        <div class="run-detail-head">
          <div class="run-title">
            ${detail.summary.title ?? detail.summary.runId}
          </div>
          <div class="run-meta">
            ${detail.summary.runId}
            ${detail.summary.model === undefined
              ? nothing
              : html`· ${detail.summary.model}`}
            ${detail.summary.terminalReason === undefined
              ? nothing
              : html`· ${detail.summary.terminalReason}`}
          </div>
          ${detail.summary.failure === undefined ? nothing : html`
            <div class="body code bad-body">
              ${detail.summary.failure.kind}: ${detail.summary.failure.detail}
            </div>
          `}
        </div>
        <div class="tabs">
          ${tab("timeline", `Timeline (${detail.steps.length})`)}
          ${tab("patterns", "Patterns")}
          ${tab(
            "tool-outputs",
            `Tool outputs (${detail.toolOutputNames.length})`,
          )}
          ${tab("artifacts", `Artifacts (${detail.artifactNames.length})`)}
        </div>
        ${this.pane === "timeline"
          ? html`
            <console-steps
              .steps=${detail.steps}
              .handles=${detail.handles}
              .selected=${this.focusStep ?? 0}
            ></console-steps>
          `
          : this.pane === "patterns"
          ? this.#patterns(detail)
          : this.pane === "tool-outputs"
          ? this.#files("tool-outputs", detail.toolOutputNames)
          : this.#files("artifacts", detail.artifactNames)}
      </div>
    `;
  }
}

customElements.define("console-run-view", ConsoleRunView);
