import type {
  BuiltInLLMToolCallPart,
  BuiltInLLMToolResultPart,
} from "@commonfabric/api";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { applyThemeToElement, type CFTheme } from "../theme-context.ts";

/**
 * The AI SDK's tool output types whose `{ type, value }` wrapper holds the
 * result in `value`. The runner wraps a result as `json`, and a failure as
 * `error-text`.
 */
const OUTPUT_TYPES = new Set([
  "text",
  "json",
  "error-text",
  "error-json",
  "content",
]);

/**
 * CFToolCall - Expandable tool call display component
 *
 * @element cf-tool-call
 *
 * @prop {BuiltInLLMToolCallPart} call - The tool call
 * @prop {BuiltInLLMToolResultPart} result - The tool's result, once it has one
 * @attr {boolean} expanded - Whether the tool call details are expanded
 *
 * @example
 * <cf-tool-call
 *   .call=${toolCall}
 *   .result=${toolResult}
 *   expanded
 * ></cf-tool-call>
 */
export class CFToolCall extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .tool-call-container {
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius, 0.25rem)
        );
        background-color: var(--cf-theme-color-surface, #f9fafb);
        overflow: hidden;
        transition: all var(--cf-theme-animation-duration, 0.2s) ease;
      }

      .tool-call-header {
        display: flex;
        align-items: center;
        gap: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem));
        padding: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem))
          var(--cf-theme-spacing-loose, var(--cf-spacing-3, 0.75rem));
        cursor: pointer;
        user-select: none;
        font-size: var(--cf-font-body-size, 0.875rem);
        font-family: var(
          --cf-theme-mono-font-family,
          var(
            --cf-font-mono,
            ui-monospace,
            "Cascadia Code",
            "Source Code Pro",
            Menlo,
            Consolas,
            "DejaVu Sans Mono",
            monospace
          )
        );
        color: var(--cf-theme-color-text, #374151);
        background: transparent;
        border: none;
        width: 100%;
        text-align: left;
      }

      .tool-call-header:hover {
        background-color: var(
          --cf-theme-color-surface-hover,
          #f3f4f6
        );
      }

      .tool-call-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }

      .tool-call-name {
        font-weight: var(--cf-font-body-weight, 400);
        flex-grow: 1;
      }

      .tool-call-status {
        display: flex;
        align-items: center;
        gap: var(--cf-theme-spacing-tight, var(--cf-spacing-1, 0.25rem));
        font-size: var(--cf-font-caption-size, 0.75rem);
        font-family: var(
          --cf-theme-mono-font-family,
          var(
            --cf-font-mono,
            ui-monospace,
            "Cascadia Code",
            "Source Code Pro",
            Menlo,
            Consolas,
            "DejaVu Sans Mono",
            monospace
          )
        );
      }

      .chevron {
        width: 16px;
        height: 16px;
        transition: transform var(--cf-theme-animation-duration, 0.2s) ease;
        color: var(--cf-theme-color-text-muted, #9ca3af);
      }

      .chevron.expanded {
        transform: rotate(90deg);
      }

      .tool-call-content {
        border-top: 1px solid var(--cf-theme-color-border, #e5e7eb);
        background-color: var(
          --cf-theme-color-background,
          var(--cf-colors-white, #ffffff)
        );
      }

      .tool-section {
        padding: var(--cf-theme-spacing-loose, var(--cf-spacing-3, 0.75rem));
      }

      .tool-section:not(:last-child) {
        border-bottom: 1px solid var(--cf-theme-color-border-muted, #f3f4f6);
      }

      .tool-section-title {
        font-weight: var(--cf-font-weight-semibold, 600);
        font-size: var(--cf-font-caption-size, 0.75rem);
        text-transform: uppercase;
        letter-spacing: var(--cf-tool-section-title-letter-spacing, 0.025em);
        color: var(--cf-theme-color-text-muted, #4b5563);
        margin-bottom: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem));
      }

      .tool-section-content {
        font-family: var(
          --cf-theme-mono-font-family,
          var(
            --cf-font-mono,
            ui-monospace,
            "Cascadia Code",
            "Source Code Pro",
            Menlo,
            Consolas,
            "DejaVu Sans Mono",
            monospace
          )
        );
        font-size: var(--cf-font-caption-size, 0.75rem);
        background-color: var(--cf-theme-color-surface, #f9fafb);
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-sm, 0.125rem)
        );
        padding: var(--cf-theme-spacing-normal, var(--cf-spacing-2, 0.5rem));
        white-space: pre-wrap;
        word-break: break-word;
        overflow-x: auto;
        max-height: 200px;
        overflow-y: auto;
      }

      /* Status styling */
      .status-pending {
        color: var(--cf-theme-color-primary, var(--cf-colors-blue-600, #2563eb));
      }

      .status-success {
        color: var(--cf-theme-color-success, var(--cf-colors-green-600, #16a34a));
      }
    `,
  ];

  @property({ type: Object })
  accessor call!: BuiltInLLMToolCallPart;

  @property({ type: Object })
  accessor result: BuiltInLLMToolResultPart | undefined = undefined;

  @property({ type: Boolean, reflect: true })
  accessor expanded = false;

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  override updated(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.updated(changedProperties);
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
    }
  }

  private _toggleExpanded() {
    this.expanded = !this.expanded;
  }

  /**
   * The text of a tool's output: the value inside a `{ type, value }` wrapper
   * of one of the AI SDK's output types, or else the output itself, as is when
   * it is a string and as indented JSON otherwise.
   */
  private _formatOutput(output: unknown): string {
    const value = typeof output === "object" && output !== null &&
        "type" in output && "value" in output &&
        typeof output.type === "string" && OUTPUT_TYPES.has(output.type)
      ? output.value
      : output;
    return typeof value === "string" ? value : this._formatJSON(value);
  }

  /**
   * Indented JSON of `data`, writing a `bigint` as a string such as "2n", or
   * `data`'s string form when JSON cannot represent it (a cycle, for one).
   */
  private _formatJSON(data: unknown): string {
    try {
      return JSON.stringify(
        data,
        (_key, value) => typeof value === "bigint" ? `${value}n` : value,
        2,
      );
    } catch {
      return String(data);
    }
  }

  private _renderContent() {
    if (!this.expanded) {
      return null;
    }

    return html`
      <div class="tool-call-content">
        <div class="tool-section">
          <div class="tool-section-title">Input</div>
          <pre class="tool-section-content">${this._formatJSON(
            this.call.input,
          )}</pre>
        </div>
        ${this.result
          ? html`
            <div class="tool-section">
              <div class="tool-section-title">Output</div>
              <pre class="tool-section-content">${this._formatOutput(
                this.result.output,
              )}</pre>
            </div>
          `
          : null}
      </div>
    `;
  }

  override render() {
    const done = Boolean(this.result);

    return html`
      <div class="tool-call-container">
        <button class="tool-call-header" @click="${this._toggleExpanded}">
          <span class="tool-call-icon">${done ? "✅" : "🔧"}</span>
          <span class="tool-call-name">${this.call?.toolName}</span>
          <span class="tool-call-status status-${done ? "success" : "pending"}">
            ${done ? "Complete" : "Running"}
          </span>
          <svg
            class="chevron ${this.expanded ? "expanded" : ""}"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
        ${this._renderContent()}
      </div>
    `;
  }
}
