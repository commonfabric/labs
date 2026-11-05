import { ReactiveController, ReactiveControllerHost } from "lit";

export type InputTimingStrategy =
  | "immediate" // Dispatch immediately
  | "debounce" // Debounce with delay (default)
  | "throttle" // Throttle with interval
  | "blur"; // Only dispatch on blur

export interface InputTimingOptions {
  strategy?: InputTimingStrategy;
  delay?: number; // For debounce/throttle (ms)
  leading?: boolean; // For throttle - fire on leading edge
  trailing?: boolean; // For throttle - fire on trailing edge
}

/**
 * A reactive controller that manages input timing strategies (debounce, throttle, blur-only)
 * for Lit components. This controller can be shared across multiple input components.
 *
 * @example
 * ```typescript
 * class MyInput extends LitElement {
 *   private inputTiming = new InputTimingController(this, {
 *     strategy: 'debounce',
 *     delay: 300
 *   });
 *
 *   private handleInput(event: Event) {
 *     this.inputTiming.schedule(() => {
 *       this.dispatchEvent(new CustomEvent('value-change', {
 *         detail: { value: event.target.value }
 *       }));
 *     });
 *   }
 * }
 * ```
 */
export class InputTimingController implements ReactiveController {
  private host: ReactiveControllerHost;
  private options: Required<InputTimingOptions>;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastCallTime = 0;
  private pendingCallback: (() => void) | null = null;
  private hasFocus = false;

  constructor(
    host: ReactiveControllerHost,
    options: InputTimingOptions = {},
  ) {
    this.host = host;
    this.options = {
      strategy: options.strategy ?? "debounce",
      delay: options.delay ?? 300,
      leading: options.leading ?? true,
      trailing: options.trailing ?? true,
    };
    host.addController(this);
  }

  hostDisconnected(): void {
    this.cancel();
  }

  /**
   * Schedule a callback to be executed based on the configured timing strategy
   */
  schedule(callback: () => void): void {
    switch (this.options.strategy) {
      case "immediate":
        callback();
        break;

      case "debounce":
        this.debounce(callback);
        break;

      case "throttle":
        this.throttle(callback);
        break;

      case "blur":
        this.pendingCallback = callback;
        // Will be executed on blur
        break;
    }
  }

  /**
   * Cancel any pending callbacks
   */
  cancel(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.pendingCallback = null;
  }

  /**
   * Run any pending callback immediately and cancel the scheduled timer.
   * No-op when nothing is pending.
   */
  flush(): void {
    const callback = this.pendingCallback;
    this.cancel();
    callback?.();
  }

  /**
   * Notify the controller that the input has gained focus
   */
  onFocus(): void {
    this.hasFocus = true;
  }

  /**
   * Notify the controller that the input has lost focus
   */
  onBlur(): void {
    this.hasFocus = false;

    // Execute pending callback if using blur strategy
    if (this.options.strategy === "blur" && this.pendingCallback) {
      this.pendingCallback();
      this.pendingCallback = null;
    }

    // For debounce, execute any pending callback immediately on blur
    if (this.options.strategy === "debounce" && this.timeoutId !== null) {
      // Save the callback before cancel() clears it
      const callback = this.pendingCallback;
      this.cancel();
      if (callback) {
        callback();
      }
    }
  }

  /**
   * Update the timing options dynamically
   */
  updateOptions(options: Partial<InputTimingOptions>): void {
    this.cancel();
    this.options = {
      ...this.options,
      ...options,
    };
  }

  private debounce(callback: () => void): void {
    // Clear existing timeout
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
    }

    // Store the callback for potential immediate execution on blur
    this.pendingCallback = callback;

    // Set new timeout
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      this.pendingCallback = null;
      callback();
    }, this.options.delay);
  }

  private throttle(callback: () => void): void {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;

    // Clear any existing timeout
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // Leading edge execution
    if (timeSinceLastCall >= this.options.delay && this.options.leading) {
      this.pendingCallback = null;
      this.lastCallTime = now;
      callback();
    } else if (this.options.trailing) {
      // Schedule trailing edge execution. Mirror the callback into
      // pendingCallback so flush() (and onBlur) can run it immediately.
      const remainingTime = this.options.delay - timeSinceLastCall;
      this.pendingCallback = callback;
      this.timeoutId = setTimeout(() => {
        this.timeoutId = null;
        this.pendingCallback = null;
        this.lastCallTime = Date.now();
        callback();
      }, remainingTime);
    }
  }
}
