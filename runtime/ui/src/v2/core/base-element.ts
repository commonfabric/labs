/**
 * Minimal base class for web components using Lit
 * Provides the emit() helper for consistent custom events
 */

import {
  css,
  CSSResult,
  type CSSResultGroup,
  type CSSResultOrNative,
  LitElement,
} from "lit";
import { variablesCSS } from "../styles/variables.ts";
import { DebugController } from "./debug-controller.ts";

// Set to `true` to render outlines everytime a
// LitElement renders.
const DEBUG_RENDERER = false;

/**
 * Hides a host carrying the `hidden` attribute. A component's own
 * `:host { display: ... }` rule otherwise outranks the browser's `[hidden]`
 * rule, which would leave `hidden` with no effect on it. An inline `display`
 * on the host still outranks this, as it does the browser's rule.
 * `hidden="until-found"` is left to the browser, which keeps such an element
 * laid out so that find-in-page and fragment navigation can reveal it.
 */
const hiddenHostStyles = css`
  :host([hidden]:not([hidden="until-found"])) {
    display: none;
  }
`;

export abstract class BaseElement extends LitElement {
  #_debugController = DEBUG_RENDERER ? new DebugController(this) : null;

  /**
   * Get base styles including CSS variables
   */
  static get baseStyles(): CSSResult {
    // Create CSS with variables for the host element
    const hostStyles = `:host { ${variablesCSS} }`;
    return css([hostStyles] as any);
  }

  /**
   * Dispatch a custom event with common defaults
   */
  protected emit<T = any>(
    eventName: string,
    detail?: T,
    options?: EventInit,
  ): boolean {
    const event = new CustomEvent(eventName, {
      detail,
      bubbles: true,
      composed: true,
      ...options,
    });
    return this.dispatchEvent(event);
  }

  /**
   * Adds `hiddenHostStyles` to a component's own styles. A component with no
   * styles of its own gives its host no display, so the browser's `[hidden]`
   * rule already applies to it, and it is left with none.
   */
  protected static override finalizeStyles(
    styles?: CSSResultGroup,
  ): Array<CSSResultOrNative> {
    const own = super.finalizeStyles(styles);
    return own.length === 0 ? own : [...own, hiddenHostStyles];
  }
}
