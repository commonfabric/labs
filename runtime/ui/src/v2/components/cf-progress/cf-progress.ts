/**
 * @component cf-progress
 * @description Progress indicator component that displays completion percentage or indeterminate loading state
 *
 * @tag cf-progress
 *
 * @attribute {number} value - Current progress value (0-100). Defaults to 0.
 * @attribute {number} max - Maximum value for the progress bar. Defaults to 100.
 * @attribute {boolean} indeterminate - Whether the progress bar is in indeterminate state (loading animation).
 *
 * @csspart base - The progress bar container element
 * @csspart indicator - The progress indicator element that shows the fill
 *
 * @example
 * ```html
 * <!-- Determinate progress -->
 * <cf-progress value="60"></cf-progress>
 *
 * <!-- Indeterminate progress -->
 * <cf-progress indeterminate></cf-progress>
 *
 * <!-- Custom max value -->
 * <cf-progress value="50" max="200"></cf-progress>
 * ```
 *
 * @accessibility
 * - Uses role="progressbar" with proper ARIA attributes
 * - Provides aria-valuenow, aria-valuemin, aria-valuemax
 * - Updates aria-valuetext with percentage or "Loading" for indeterminate state
 */

import { html, PropertyValues, unsafeCSS } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { progressStyles } from "./styles.ts";

export class CFProgress extends BaseElement {
  static override properties = {
    value: { type: Number },
    max: { type: Number },
    indeterminate: { type: Boolean, reflect: true },
  };
  static override styles = unsafeCSS(progressStyles);

  declare value: number;
  declare max: number;
  declare indeterminate: boolean;

  private _indicatorElement: HTMLElement | null = null;

  constructor() {
    super();
    this.value = 0;
    this.max = 100;
    this.indeterminate = false;
  }

  get indicatorElement(): HTMLElement | null {
    if (!this._indicatorElement) {
      this._indicatorElement = this.shadowRoot?.querySelector(".indicator") as
        | HTMLElement
        | null;
    }
    return this._indicatorElement;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set up ARIA attributes
    this.setAttribute("role", "progressbar");
    this.setAttribute("aria-valuemin", "0");
  }

  override willUpdate(changedProperties: PropertyValues) {
    // Clamp value within bounds
    if (changedProperties.has("value") || changedProperties.has("max")) {
      const clampedValue = Math.max(
        0,
        Math.min(this.value ?? 0, this.max ?? 100),
      );
      if (this.value !== clampedValue) {
        this.value = clampedValue;
      }
    }
  }

  override updated(changedProperties: PropertyValues) {
    if (
      changedProperties.has("value") || changedProperties.has("max") ||
      changedProperties.has("indeterminate")
    ) {
      this.updateProgress();
      this.updateAriaAttributes();
    }
  }

  override render() {
    const classes = {
      progress: true,
      indeterminate: this.indeterminate,
    };

    const indicatorStyles = this.getIndicatorStyles();

    return html`
      <div class="${classMap(classes)}" part="base">
        <div
          class="indicator"
          part="indicator"
          role="presentation"
          style="${styleMap(indicatorStyles)}"
        ></div>
      </div>
    `;
  }

  private getIndicatorStyles() {
    if (this.indeterminate) {
      return {};
    }
    const percentage = this.getPercentage();
    return {
      width: `${percentage}%`,
    };
  }

  private updateAriaAttributes(): void {
    this.setAttribute("aria-valuemax", this.max?.toString() ?? "100");

    if (!this.indeterminate) {
      this.setAttribute("aria-valuenow", this.value?.toString() ?? "0");
      const percentage = this.getPercentage();
      this.setAttribute("aria-valuetext", `${Math.round(percentage)}%`);
    } else {
      this.removeAttribute("aria-valuenow");
      this.setAttribute("aria-valuetext", "Loading");
    }
  }

  private getPercentage(): number {
    if (this.max === 0 || !Number.isFinite(this.max)) return 0;
    return ((this.value ?? 0) / this.max) * 100;
  }

  private updateProgress(): void {
    // Progress visual update is now handled by render method
    // This method is kept for compatibility with public API
  }

  /**
   * Set the progress value programmatically
   */
  setValue(value: number): void {
    this.value = value;
  }

  /**
   * Get the current progress percentage
   */
  getPercentageValue(): number {
    return this.getPercentage();
  }

  /**
   * Set indeterminate state
   */
  setIndeterminate(indeterminate: boolean): void {
    this.indeterminate = indeterminate;
  }

  /**
   * Check if progress is complete
   */
  isComplete(): boolean {
    return !this.indeterminate && (this.value ?? 0) >= (this.max ?? 100);
  }

  /**
   * Reset progress to 0
   */
  reset(): void {
    this.value = 0;
    this.indeterminate = false;
  }
}
