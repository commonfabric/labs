import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { BaseElement } from "../../core/base-element.ts";

/**
 * CFQuestion - Component for asking single questions and collecting answers
 *
 * @element cf-question
 *
 * @attr {string} question - The question text to display
 * @attr {string[]} options - Optional multiple choice options (JSON array)
 * @attr {boolean} allow-custom - Allow custom text input alongside options (default: false)
 *
 * @fires cf-answer - Fired when user submits an answer, detail: { answer: string }
 *
 * @example
 * <cf-question
 *   question="What's your preferred cooking style?"
 *   options='["Quick & easy", "Elaborate meals", "Healthy focus"]'
 * ></cf-question>
 *
 * @example
 * <cf-question
 *   question="What's your preferred cooking style?"
 *   options='["Quick & easy", "Elaborate meals", "Healthy focus"]'
 *   allow-custom
 * ></cf-question>
 */
export class CFQuestion extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
      }

      .question-card {
        background: var(--cf-theme-color-surface, white);
        border: 1px solid var(--cf-theme-color-border, #e5e5e7);
        border-radius: 12px;
        padding: 16px;
      }

      .question-text {
        font-size: 15px;
        font-weight: 500;
        color: var(--cf-theme-color-text, #111827);
        margin: 0 0 12px 0;
      }

      .options {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }

      .option {
        padding: 8px 16px;
        background: var(--cf-theme-color-surface-hover, #f3f4f6);
        border: 2px solid transparent;
        border-radius: 20px;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .option:hover {
        background: var(--cf-theme-color-surface-tertiary, #e5e7eb);
      }

      .option.selected {
        background: var(--cf-colors-blue-50, #eff6ff);
        border-color: var(--cf-theme-color-primary, #3b82f6);
        color: var(--cf-theme-color-primary, #3b82f6);
      }

      .text-input {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--cf-theme-color-border, #e5e5e7);
        border-radius: 8px;
        font-size: 14px;
        margin-bottom: 12px;
        box-sizing: border-box;
      }

      .text-input:focus {
        outline: none;
        border-color: var(--cf-theme-color-primary, #3b82f6);
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
      }

      .submit-btn {
        padding: 8px 20px;
        background: var(--cf-theme-color-primary, #3b82f6);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }

      .submit-btn:hover {
        background: var(--cf-colors-blue-600, #2563eb);
      }

      .submit-btn:disabled {
        background: var(--cf-theme-color-border, #d1d5db);
        cursor: not-allowed;
      }

      .answered {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px;
        background: var(--cf-colors-green-50, #f0fdf4);
        border: 1px solid var(--cf-theme-color-success, #22c55e);
        border-radius: 8px;
      }

      .answered-badge {
        padding: 4px 8px;
        background: var(--cf-theme-color-success, #22c55e);
        color: white;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
      }

      .answered-text {
        font-size: 14px;
        color: var(--cf-theme-color-text, #111827);
      }
    `,
  ];

  @property({ type: String })
  accessor question = "";

  @property({ type: Array })
  accessor options: string[] = [];

  @property({ type: Boolean, attribute: "allow-custom" })
  accessor allowCustom = false;

  @state()
  private accessor _selectedOption: string | null = null;

  @state()
  private accessor _customAnswer = "";

  @state()
  private accessor _isSubmitted = false;

  @state()
  private accessor _answer = "";

  private _handleOptionClick(option: string): void {
    this._selectedOption = option;
    this._customAnswer = "";
  }

  private _handleInputChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this._customAnswer = input.value;
    this._selectedOption = null;
  }

  private _handleSubmit(): void {
    const answer = this._selectedOption || this._customAnswer;
    if (!answer) return;

    this._answer = answer;
    this._isSubmitted = true;
    this.emit("cf-answer", { answer });
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && this._customAnswer) {
      this._handleSubmit();
    }
  }

  override render() {
    if (this._isSubmitted) {
      return html`
        <div class="answered">
          <span class="answered-badge">Answered</span>
          <span class="answered-text">${this._answer}</span>
        </div>
      `;
    }

    const hasAnswer = this._selectedOption || this._customAnswer;
    const showOptions = this.options.length > 0;
    const showTextInput = !showOptions || this.allowCustom;

    return html`
      <div class="question-card">
        <p class="question-text">${this.question}</p>
        ${showOptions ? this._renderOptions() : null} ${showTextInput
          ? this._renderTextInput()
          : null}
        <button
          class="submit-btn"
          ?disabled="${!hasAnswer}"
          @click="${this._handleSubmit}"
        >
          Submit
        </button>
      </div>
    `;
  }

  private _renderOptions() {
    return html`
      <div class="options">
        ${this.options.map(
          (opt) =>
            html`
              <button
                class="option ${this._selectedOption === opt ? "selected" : ""}"
                @click="${() => this._handleOptionClick(opt)}"
              >
                ${opt}
              </button>
            `,
        )}
      </div>
    `;
  }

  private _renderTextInput() {
    const placeholder = this.options.length > 0
      ? "Or type your own answer..."
      : "Type your answer...";

    return html`
      <input
        type="text"
        class="text-input"
        placeholder="${placeholder}"
        .value="${this._customAnswer}"
        @input="${this._handleInputChange}"
        @keydown="${this._handleKeyDown}"
      />
    `;
  }
}
