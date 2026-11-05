/**
 * The conversation map: what was asked, what the agent did about it, what it
 * delegated, where it failed, and what CFC said — read top to bottom.
 *
 * Vertical because a conversation is: turns follow turns, a delegation nests
 * under the call that made it, and a reader scans down rather than sideways.
 * Every node leads to its step, so this is also how you jump around a run.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import type { ConsoleCellLabelsSummary } from "../cell-labels.ts";
import type { ConsoleFlow, ConsoleFlowNode } from "./api.ts";
import "./cell-chip.ts";

/** How long a numeric run has to be before it reads as a channel. */
const WIDE_NUMERIC_RUN = 32;

/**
 * What the run's per-cell labels amount to, in one line.
 *
 * A cell drawn with no atoms says one thing under a run whose space was read
 * and another under a run where nobody asked, and the chip cannot tell those
 * apart on its own. The header carries the difference, so an empty chip is
 * read against a stated regime rather than as an absence of secrets.
 *
 * "So many of so many carry one" is a count over a reading that covered every
 * cell it names. Where a cell of the run was read only in part, the count is
 * a floor — another label may sit at a path nothing was read at — so the line
 * leads with the reading being partial rather than with a total.
 */
export const labelRegime = (labels: ConsoleCellLabelsSummary): string => {
  if (labels.status === "absent") {
    return "cell labels not read";
  }
  if (labels.status === "unavailable") {
    return `cell labels unavailable${
      labels.detail === undefined ? "" : ` · ${labels.detail}`
    }`;
  }
  const carry = `${labels.cellsLabelled} of ${labels.cellsRead} carry one`;
  return labels.cellsPartial === 0
    ? `cell labels read · ${carry}`
    : `cell labels read in part · ${carry}, ${labels.cellsPartial} only partly read`;
};

export class ConsoleFlowView extends LitElement {
  static override properties = {
    flow: { attribute: false },
    focusStep: { attribute: false },
    focusRunId: { attribute: false },
  };

  declare flow: ConsoleFlow | undefined;

  /** The step the timeline is on, marked here so the two stay in step. */
  declare focusStep: number | undefined;

  /** The run that step belongs to, since a child's steps number from zero. */
  declare focusRunId: string | undefined;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  #node(node: ConsoleFlowNode): TemplateResult {
    const here = node.step === this.focusStep &&
      (this.focusRunId === undefined || node.runId === this.focusRunId);
    const wide = (node.longestNumericRun ?? 0) >= WIDE_NUMERIC_RUN;
    return html`
      <li class="flow-node ${node.status} ${here ? "here" : ""}">
        <button
          class="flow-row"
          type="button"
          @click=${() =>
            this.dispatchEvent(
              new CustomEvent("flow-selected", {
                detail: { runId: node.runId, step: node.step },
                bubbles: true,
              }),
            )}
        >
          <span class="flow-mark ${node.status}"></span>
          <span class="flow-label">${node.label}</span>
          ${node.policyDenied
            ? html`<span class="badge denied" title=${node.policyDetail ?? ""}>
              cfc denied
            </span>`
            : node.policyDecision === undefined
            ? nothing
            : html`<span class="flow-cfc">cfc ${node.policyDecision}</span>`}
          ${wide
            ? html`
              <span
                class="step-warn"
                title="a long run of numbers crossed as value"
              >!</span>
            `
            : nothing}
          <span class="flow-step">${node.step}</span>
        </button>
        ${node.reads.length === 0 && node.produces.length === 0 &&
            node.entersScope.length === 0
          ? nothing
          : html`
            <div class="flow-cells">
              ${node.reads.map((cell) =>
                html`
                  <span class="flow-cell-line">
                    <span class="flow-arrow reads">reads</span>
                    ${cell.as === undefined
                      ? nothing
                      : html`<span class="flow-as">${cell.as}</span>`}
                    <console-cell .cell=${cell}></console-cell>
                  </span>
                `
              )}
              ${node.produces.map((cell) =>
                html`
                  <span class="flow-cell-line">
                    <span class="flow-arrow produces">makes</span>
                    <console-cell .cell=${cell}></console-cell>
                  </span>
                `
              )}
              ${node.entersScope.map((cell) =>
                html`
                  <span class="flow-cell-line">
                    <span class="flow-arrow enters">in scope</span>
                    <console-cell .cell=${cell}></console-cell>
                  </span>
                `
              )}
            </div>
          `}
        ${node.text === undefined
          ? nothing
          : html`<div class="flow-text">${node.text}</div>`}
        ${node.children.length === 0 ? nothing : html`
          <ul class="flow-children">
            ${node.children.map((child) => this.#node(child))}
          </ul>
        `}
      </li>
    `;
  }

  protected override render(): TemplateResult {
    const flow = this.flow;
    if (flow === undefined) {
      return html`<p class="empty">Reading…</p>`;
    }
    if (flow.turns.length === 0) {
      return html`<p class="empty">This run did nothing to map.</p>`;
    }
    return html`
      <div class="flow">
        <div class="flow-summary">
          ${flow.cfc === undefined ? nothing : html`
            <span class="flow-posture" title="the CFC regime this run ran under">
              ${flow.cfc.posture ?? "first-party"} ·
              labels ${flow.cfc.flowLabels} · ${flow.cfc.enforcementMode}
            </span>
          `}
          ${flow.cellLabels === undefined ? nothing : html`
            <span
              class="flow-labels"
              title="what the space said about the cells this run touched"
            >${labelRegime(flow.cellLabels)}</span>
          `}
          ${flow.failures === 0
            ? nothing
            : html`<span class="badge error">${flow.failures} failed</span>`}
          ${flow.denials === 0
            ? nothing
            : html`<span class="badge denied">${flow.denials} denied</span>`}
          ${flow.unwiredPatterns === 0
            ? nothing
            : html`<span class="badge warn">
              ${flow.unwiredPatterns} unwired
            </span>`}
        </div>
        ${flow.turns.map((turn) =>
          html`
            <section class="flow-turn">
              <button
                class="flow-turn-head"
                type="button"
                @click=${() =>
                  this.dispatchEvent(
                    new CustomEvent("flow-selected", {
                      detail: { step: turn.step },
                      bubbles: true,
                    }),
                  )}
              >
                <span class="flow-turn-mark">asked</span>
                <span class="flow-turn-text">${turn.text ?? "(no text)"}</span>
              </button>
              <ul class="flow-nodes">
                ${turn.nodes.map((node) => this.#node(node))}
              </ul>
            </section>
          `
        )}
      </div>
    `;
  }
}

customElements.define("console-flow-view", ConsoleFlowView);
