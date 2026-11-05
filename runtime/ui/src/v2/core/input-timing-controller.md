A reusable lit controller for adding debouncing behavior to components.

```ts
/**
 * Example showing how to use InputTimingController in other Lit components
 */

import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  InputTimingController,
  type InputTimingOptions,
} from "./input-timing-controller.ts";

@customElement("example-search-input")
export class ExampleSearchInput extends LitElement {
  static override styles = css`
    input {
      width: 100%;
      padding: 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
  `;

  @property({ type: String })
  value = "";
  @property({ type: String })
  placeholder = "Search...";

  // Use the timing controller with debouncing for search
  private inputTiming = new InputTimingController(this, {
    strategy: "debounce",
    delay: 500, // Wait 500ms after user stops typing
  });

  override render() {
    return html`
      <input
        .value="${this.value}"
        placeholder="${this.placeholder}"
        @input="${this.handleInput}"
        @focus="${this.handleFocus}"
        @blur="${this.handleBlur}"
      />
    `;
  }

  private handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.value = input.value;

    // Schedule the search event with debouncing
    this.inputTiming.schedule(() => {
      this.dispatchEvent(
        new CustomEvent("search", {
          detail: { query: this.value },
          bubbles: true,
        }),
      );
    });
  }

  private handleFocus() {
    this.inputTiming.onFocus();
  }

  private handleBlur() {
    this.inputTiming.onBlur();
  }
}

@customElement("example-throttled-slider")
export class ExampleThrottledSlider extends LitElement {
  static override styles = css`
    input[type="range"] {
      width: 100%;
    }
  `;

  @property({ type: Number })
  value = 50;
  @property({ type: Number })
  min = 0;
  @property({ type: Number })
  max = 100;

  // Use throttling for slider updates
  private inputTiming = new InputTimingController(this, {
    strategy: "throttle",
    delay: 100, // Update at most every 100ms
  });

  override render() {
    return html`
      <input
        type="range"
        .value="${this.value.toString()}"
        .min="${this.min.toString()}"
        .max="${this.max.toString()}"
        @input="${this.handleInput}"
      />
    `;
  }

  private handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.value = parseInt(input.value);

    // Schedule the value change event with throttling
    this.inputTiming.schedule(() => {
      this.dispatchEvent(
        new CustomEvent("value-change", {
          detail: { value: this.value },
          bubbles: true,
        }),
      );
    });
  }
}

@customElement("example-form-field")
export class ExampleFormField extends LitElement {
  @property({ type: String })
  value = "";
  @property({ type: String })
  placeholder = "";

  // Use blur strategy for form validation
  private inputTiming = new InputTimingController(this, {
    strategy: "blur", // Only validate when user leaves the field
  });

  override render() {
    return html`
      <input
        .value="${this.value}"
        placeholder="${this.placeholder}"
        @input="${this.handleInput}"
        @focus="${this.handleFocus}"
        @blur="${this.handleBlur}"
      />
    `;
  }

  private handleInput(event: Event) {
    const input = event.target as HTMLInputElement;
    this.value = input.value;

    // Schedule validation to run on blur
    this.inputTiming.schedule(() => {
      this.validateAndDispatch();
    });
  }

  private handleFocus() {
    this.inputTiming.onFocus();
  }

  private handleBlur() {
    this.inputTiming.onBlur();
  }

  private validateAndDispatch() {
    const isValid = this.value.length > 0; // Simple validation
    this.dispatchEvent(
      new CustomEvent("validation", {
        detail: { value: this.value, isValid },
        bubbles: true,
      }),
    );
  }
}

// Usage examples:
/*
<example-search-input
  @search=${(e) => console.log('Search:', e.detail.query)}
></example-search-input>

<example-throttled-slider
  @value-change=${(e) => console.log('Value:', e.detail.value)}
></example-throttled-slider>

<example-form-field
  @validation=${(e) => console.log('Valid:', e.detail.isValid)}
></example-form-field>
*/
```
