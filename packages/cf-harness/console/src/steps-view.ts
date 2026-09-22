/**
 * The step scrubber: a run read one step at a time. Selecting a step shows the
 * call that was made, the whole of what went into it and came back as
 * formatted JSON, and the handles in scope by that point — the same reading
 * for a run that finished an hour ago and one that is still going.
 */

import { html, LitElement, nothing, type TemplateResult } from "lit";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  type ConsoleArgumentRef,
  type ConsoleHandle,
  type ConsoleStep,
  consoleStepArguments,
} from "../steps.ts";

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // A payload holding a cycle is not one the run produced, but showing
    // something beats an empty pane.
    return String(value);
  }
};

/** The one way a cell is drawn, wherever this view draws one. */
import "./cell-chip.ts";

/**
 * How long a run of numbers has to be before the page calls it out. Numbers
 * are never sealed, so a long array of them is a channel wide enough to carry
 * arbitrary content — well past what an inert scalar result looks like.
 */
const WIDE_NUMERIC_RUN = 32;

/**
 * The short names of a label's clauses. An atom's `type` is a CFC atom URL
 * whose last segment identifies it — `ExternalIngest` for the atom marking
 * a value that arrived from outside the fabric. A clause is
 * arbitrary CFC JSON, so one that is not a typed atom is reported by its shape
 * rather than dropped: a clause the page cannot name is still one the label
 * carries.
 */
const atomNames = (clauses: readonly unknown[] = []): string[] =>
  clauses.map((clause) => {
    const type = isObjectOrArray(clause)
      ? (clause as { type?: unknown }).type
      : undefined;
    return typeof type === "string"
      ? type.split("/").pop() ?? type
      : JSON.stringify(clause) ?? "clause";
  });

/**
 * Where the scrubber sits when `count` steps are what it is scrubbing. A run
 * shorter than the one that was open cannot hold the step it was scrubbed to,
 * so the selection follows the steps down rather than pointing past their end,
 * where the rail highlights nothing and an arrow key moves from a step that is
 * not there.
 */
export const clampSelection = (selected: number, count: number): number =>
  Math.min(Math.max(selected, 0), Math.max(count - 1, 0));

/** Elides a value's rendering so one long literal cannot fill the pane. */
const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** A step's one-line label in the rail. */
const stepLabel = (step: ConsoleStep): string =>
  step.kind === "tool" ? step.toolName ?? "tool" : step.kind;

/** The expandable omission block's label for one tool result. */
export const withheldSummary = (step: ConsoleStep): string =>
  step.withheld.status === "unrecorded"
    ? "withheld from the model · no record"
    : step.withheld.status === "record-unreadable"
    ? "withheld from the model · record unreadable"
    : step.withheld.status === "record-entry-missing"
    ? "withheld from the model · entry missing"
    : `withheld from the model · ${step.withheld.locations.length}`;

/** What the full tool artifact records beside the model-facing result. */
export const withheldView = (step: ConsoleStep): TemplateResult => {
  if (step.withheld.status === "unrecorded") {
    return html`
      <details class="pane withheld-pane">
        <summary>${withheldSummary(step)}</summary>
        <p class="empty">
          No omission record exists for this tool result. Legacy runs cannot be
          reconstructed honestly from the model-facing transcript alone.
        </p>
      </details>
    `;
  }
  if (step.withheld.status === "record-unreadable") {
    return html`
      <details class="pane withheld-pane">
        <summary>${withheldSummary(step)}</summary>
        <p class="empty">
          The omission record exists but is unreadable or does not match the
          current contract. This result cannot be reconstructed honestly.
        </p>
      </details>
    `;
  }
  if (step.withheld.status === "record-entry-missing") {
    return html`
      <details class="pane withheld-pane">
        <summary>${withheldSummary(step)}</summary>
        <p class="empty">
          The omission record exists but has no entry for this tool result.
          Which omission rules applied cannot be determined.
        </p>
      </details>
    `;
  }
  if (step.withheld.locations.length === 0) {
    return html`
      <details class="pane withheld-pane">
        <summary>${withheldSummary(step)}</summary>
        <p class="empty">No omission rule applied to this result.</p>
      </details>
    `;
  }
  return html`
    <details class="pane withheld-pane">
      <summary>${withheldSummary(step)}</summary>
      ${step.withheld.locations.map((location) =>
        html`
          <div class="withheld-location">
            <div class="withheld-rule">${location.rule}</div>
            <div class="withheld-pointer">
              ${location.artifactPath}${location.jsonPointer}
            </div>
            ${location.available
              ? html`
                <pre class="raw">${location.redaction ??
                  json(location.value)}</pre>
              `
              : html`
                <p class="empty">The recorded artifact position is unavailable.</p>
              `}
          </div>
        `
      )}
    </details>
  `;
};

/**
 * What CFC decided about one call, and any event it raised. A withheld
 * release carries the retrospective's count of the positions it held back,
 * which is what says the call itself succeeded.
 */
export const stepPolicyView = (
  step: ConsoleStep,
): TemplateResult | typeof nothing => {
  // Taint and the prompt slot's influence are separate views of the same
  // inputs; both are listed, one row per entry, each on its own axis.
  const labelEntries = [
    ...step.invocation?.cfcInputLabels?.entries ?? [],
    ...step.invocation?.promptSlotInfluenceLabels?.entries ?? [],
  ];
  if (
    step.policy === undefined && step.policyEvents.length === 0 &&
    labelEntries.length === 0
  ) {
    return nothing;
  }
  return html`
    <div class="pane">
      <div class="pane-head">cfc</div>
      ${step.policy === undefined ? nothing : html`
        <div class="cfc-line">
          <span
            class="badge ${step.policy.decision === "denied"
              ? "denied"
              : step.policy.decision === "invalid" ||
                  step.policy.decision === "withheld"
              ? "warn"
              : "ok"}"
          >${step.policy.decision}</span>
          ${step.policy.effectClass === undefined ? nothing : html`
            <span class="cfc-effect">${step.policy.effectClass}</span>
          `}
          <span class="cfc-reasons">
            ${step.policy.reasonCodes.join(", ")}
          </span>
          ${step.policy.decision === "withheld"
            ? html`
              <span class="cfc-withheld">${withheldSummary(step)}</span>
            `
            : nothing}
        </div>
      `} ${step.policyEvents.map((event) =>
        html`
          <div class="cfc-line">
            <span
              class="badge ${event.severity === "denied" ? "denied" : "warn"}"
            >${event.severity}</span>
            <span class="cfc-reasons">${event.detail ?? ""}</span>
          </div>
        `
      )} ${labelEntries.length === 0 ? nothing : html`
        <table class="labels">
          <tbody>
            ${labelEntries.map((entry) =>
              html`
                <tr>
                  <td class="label-path">
                    ${entry.path.length === 0
                      ? "(whole input)"
                      : entry.path.join(".")}
                  </td>
                  <td class="label-atoms">
                    ${atomNames(entry.label?.confidentiality).length === 0 &&
                        atomNames(entry.label?.integrity).length === 0
                      ? html`
                        <span class="muted">no confidentiality atom</span>
                      `
                      : atomNames(entry.label?.confidentiality).map((name) =>
                        html`
                          <span class="atom conf">${name}</span>
                        `
                      )} ${atomNames(entry.label?.integrity).map((name) =>
                        html`
                          <span class="atom integ">${name}</span>
                        `
                      )}
                  </td>
                </tr>
              `
            )}
          </tbody>
        </table>
      `}
    </div>
  `;
};

export class ConsoleSteps extends LitElement {
  static override properties = {
    steps: { attribute: false },
    handles: { attribute: false },
    selected: { attribute: false },
  };

  declare steps: readonly ConsoleStep[];
  declare handles: readonly ConsoleHandle[];
  declare selected: number;

  constructor() {
    super();
    this.steps = [];
    this.handles = [];
    this.selected = 0;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("steps")) {
      this.selected = clampSelection(this.selected, this.steps.length);
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();
    globalThis.addEventListener("keydown", this.#onKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    globalThis.removeEventListener("keydown", this.#onKey);
  }

  /**
   * Arrow keys scrub. A key pressed while the task box has focus is that box's
   * to handle, so the shortcut yields to any editable element.
   */
  readonly #onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (
      target !== null &&
      (target.isContentEditable || target.tagName === "TEXTAREA" ||
        target.tagName === "INPUT")
    ) {
      return;
    }
    if (event.key === "ArrowLeft") {
      this.#select(this.selected - 1);
    } else if (event.key === "ArrowRight") {
      this.#select(this.selected + 1);
    }
  };

  #select(index: number): void {
    if (this.steps.length === 0) {
      return;
    }
    this.selected = clampSelection(index, this.steps.length);
    // The flow aside marks where the reader is, so it is told rather than
    // left to guess from a property it does not own.
    this.dispatchEvent(
      new CustomEvent("step-selected", {
        detail: this.selected,
        bubbles: true,
      }),
    );
  }

  /** The handles in scope at a step, the ones it introduced first. */
  #scopeAt(step: ConsoleStep): readonly ConsoleHandle[] {
    const introduced = new Set(step.handlesIntroduced);
    return this.handles
      .filter((handle) => step.handlesInScope.includes(handle.token))
      .sort((left, right) =>
        (introduced.has(right.token) ? 1 : 0) -
        (introduced.has(left.token) ? 1 : 0)
      );
  }

  #rail(): TemplateResult {
    return html`
      <div class="step-rail">
        ${this.steps.map((step) =>
          html`
            <button
              class="step ${step.index === this.selected ? "open" : ""}"
              type="button"
              @click="${() => this.#select(step.index)}"
            >
              <span class="step-index">${step.index}</span>
              <span class="step-dot ${step.status}"></span>
              <span class="step-name">${stepLabel(step)}</span>
              ${step.handlesIntroduced.length === 0 ? nothing : html`
                <span class="step-mint">
                  +${step.handlesIntroduced.length}
                </span>
              `} ${step.disclosure === undefined ||
                  step.disclosure.longestNumericRun < WIDE_NUMERIC_RUN
                ? nothing
                : html`
                  <span
                    class="step-warn"
                    title="a long run of numbers crossed as value"
                  >!</span>
                `}
            </button>
          `
        )}
      </div>
    `;
  }

  #handles(step: ConsoleStep): TemplateResult {
    const scope = this.#scopeAt(step);
    if (scope.length === 0) {
      return html`
        <div class="pane">
          <div class="pane-head">handles in scope</div>
          <p class="empty">None yet.</p>
        </div>
      `;
    }
    return html`
      <div class="pane">
        <div class="pane-head">handles in scope (${scope.length})</div>
        <table class="handles">
          <tbody>
            ${scope.map((handle) =>
              html`
                <tr
                  class="${step.handlesIntroduced.includes(handle.token)
                    ? "fresh"
                    : ""}"
                >
                  <td>
                    <console-cell .cell="${handle}"></console-cell>
                  </td>
                  <td class="handle-ref">${handle.ref ?? "—"}</td>
                  <td class="handle-at">
                    ${step.handlesIntroduced.includes(handle.token)
                      ? "new here"
                      : `step ${handle.introducedAtStep}`}
                  </td>
                </tr>
              `
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * What this call was given, argument by argument. A reference is a chip
   * rather than a string: it carries the name the cell has, the handle behind
   * it, the shape it declared and the labels riding on it, and it leads back
   * to the step that produced it — which is the whole of tracing a value
   * through a run.
   */
  #arguments(step: ConsoleStep): TemplateResult | typeof nothing {
    const args = consoleStepArguments(step, this.handles);
    if (args.length === 0) {
      return nothing;
    }
    const references = args.filter((argument) => argument.isReference);
    return html`
      <div class="pane">
        <div class="pane-head">
          arguments
          <span class="badge ${references.length === 0 ? "none" : "ok"}">
            ${references.length} ${references.length === 1
              ? "reference"
              : "references"}
          </span>
        </div>
        <div class="args">
          ${args.map((argument) =>
            argument.isReference ? this.#reference(argument) : html`
              <div class="arg literal">
                <span class="arg-key">${argument.key}</span>
                <span class="arg-value">
                  ${truncate(json(argument.value), 120)}
                </span>
                <span class="arg-note">value</span>
                ${argument.confidentiality.map((name) =>
                  html`
                    <span class="atom conf">${name}</span>
                  `
                )} ${argument.integrity.map((name) =>
                  html`
                    <span class="atom integ">${name}</span>
                  `
                )}
              </div>
            `
          )}
        </div>
      </div>
    `;
  }

  #reference(argument: ConsoleArgumentRef): TemplateResult {
    const origin = argument.producedByStep;
    return html`
      <div class="arg reference">
        <span class="arg-key">${argument.key}</span>
        <console-cell .cell="${argument}"></console-cell>
        ${origin === undefined
          ? html`
            <span class="arg-note">from an earlier turn</span>
          `
          : html`
            <button
              class="arg-origin"
              type="button"
              title="go to the step that produced this"
              @click="${() => this.#select(origin)}"
            >
              ← step ${origin}
            </button>
          `}
      </div>
    `;
  }

  /**
   * What the result let across as a value. The harness seals a string the
   * schema does not pin to an enum or a const, but never a number — so an
   * array of them is a channel as wide as its author cared to make it, and
   * the size of one is stated here rather than left to be counted out of the
   * JSON below.
   */
  #disclosure(step: ConsoleStep): TemplateResult | typeof nothing {
    const disclosure = step.disclosure;
    if (disclosure === undefined) {
      return nothing;
    }
    const wide = disclosure.longestNumericRun >= WIDE_NUMERIC_RUN;
    return html`
      <div class="pane">
        <div class="pane-head">disclosure</div>
        <div class="cfc-line">
          <span class="badge ${wide ? "warn" : "ok"}">
            ${disclosure.valueBytes} B as value
          </span>
          <span class="cfc-reasons">
            ${disclosure
              .sealedPositions} sealed behind a reference${disclosure
                .longestNumericRun === 0
              ? ""
              : ` · longest numeric run ${disclosure.longestNumericRun}`}
          </span>
        </div>
        ${wide
          ? html`
            <div class="body code bad-body">
              A run of ${disclosure
                .longestNumericRun} numbers crossed as value. Numbers are never sealed, so an
              array of them carries whatever its author chose to encode.
            </div>
          `
          : nothing}
      </div>
    `;
  }

  #detail(step: ConsoleStep): TemplateResult {
    if (step.kind !== "tool") {
      return html`
        <div class="pane">
          <div class="pane-head">${step.kind}</div>
          <div class="body">${step.text ?? ""}</div>
        </div>
        ${this.#handles(step)}
      `;
    }
    return html`
      <div class="pane">
        <div class="pane-head">
          <span class="tool">${step.toolName}</span>
          <span class="badge ${step.status}">${step.status}</span>
        </div>
      </div>
      ${this.#handles(step)} ${this.#arguments(step)} ${stepPolicyView(
        step,
      )} ${this.#disclosure(step)}
      <div class="pane">
        <div class="pane-head">
          <span class="tool">${step.toolName}</span> input
        </div>
        <pre class="raw">${step.input !== undefined
          ? json(step.input)
          : step.inputText ?? "—"}</pre>
        ${step.sourceReplacedByLaterAttempt !== true ? nothing : html`
          <p class="pane-note">
            Source replaced by a later attempt; see the run-pattern-source sidecar named
            by the marker.
          </p>
        `}
      </div>
      <div class="result-pair">
        <div class="pane">
          <div class="pane-head">
            <span class="tool">${step
              .toolName}</span> output ${step.resultRef?.outputId === undefined
              ? nothing
              : html`
                <span class="pane-note">${step.resultRef.outputId}</span>
              `}
          </div>
          <pre class="raw">${step.output !== undefined
            ? json(step.output)
            : step.outputText ?? "—"}</pre>
          ${step.childRunId === undefined ? nothing : html`
            <button
              class="secondary"
              type="button"
              @click="${() =>
                this.dispatchEvent(
                  new CustomEvent("open-run", {
                    detail: step.childRunId,
                    bubbles: true,
                  }),
                )}"
            >
              Open subagent run
            </button>
          `}
        </div>
        ${withheldView(step)}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (this.steps.length === 0) {
      return html`
        <p class="empty">This run recorded no transcript.</p>
      `;
    }
    const step = this.steps[clampSelection(this.selected, this.steps.length)];
    return html`
      <div class="scrubber">
        <button
          class="secondary"
          type="button"
          ?disabled="${this.selected === 0}"
          @click="${() => this.#select(this.selected - 1)}"
        >
          ‹
        </button>
        <input
          type="range"
          min="0"
          max="${this.steps.length - 1}"
          .value="${String(this.selected)}"
          @input="${(event: Event) =>
            this.#select(Number((event.target as HTMLInputElement).value))}"
        />
        <button
          class="secondary"
          type="button"
          ?disabled="${this.selected >= this.steps.length - 1}"
          @click="${() => this.#select(this.selected + 1)}"
        >
          ›
        </button>
        <span class="scrubber-count">
          step ${step.index} of ${this.steps.length - 1}
        </span>
      </div>
      ${this.#rail()} ${this.#detail(step)}
    `;
  }
}

customElements.define("console-steps", ConsoleSteps);
