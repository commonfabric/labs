import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { provide } from "@lit/context";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { valueForDisplay } from "../../core/value-for-display.ts";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  defaultTheme,
  mergeWithDefaultTheme,
} from "../theme-context.ts";

export function unwrapThemeCellValues(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (isCellHandle(value)) {
    // A theme value the worker will not show is left out, so the default
    // takes its place.
    return valueForDisplay(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => unwrapThemeCellValues(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = unwrapThemeCellValues(child, seen);
  }
  return out;
}

export function subscribeToThemeCellValues(
  value: unknown,
  onChange: () => void,
  seen = new WeakSet<object>(),
): Array<() => void> {
  const unsubs: Array<() => void> = [];

  const visit = (current: unknown) => {
    if (isCellHandle(current)) {
      const cellVal = current as CellHandle<unknown>;
      let didReceiveInitialValue = false;
      const changed = () => {
        if (!didReceiveInitialValue) {
          didReceiveInitialValue = true;
          return;
        }
        onChange();
      };
      const off = cellVal.subscribe(changed, { onRefused: changed });
      unsubs.push(off);
      return;
    }

    if (!current || typeof current !== "object") {
      return;
    }

    if (seen.has(current)) {
      return;
    }
    seen.add(current);

    for (const child of Object.values(current)) {
      visit(child);
    }
  };

  visit(value);
  return unsubs;
}

/**
 * cf-theme — Provides a theme to a subtree and applies CSS vars.
 *
 * Usage:
 * <cf-theme .theme=${partialTheme}><slot/></cf-theme>
 *
 * The component unwraps CellHandle values inside a partial theme, merges the
 * result with defaults, provides it via context, and sets CSS custom properties
 * on the host so descendants pick up tokens.
 *
 * @element cf-theme
 */
export class CFThemeProvider extends BaseElement {
  static override styles = css`
    :host {
      display: contents; /* do not add extra layout */
    }
  `;

  /** Partial or full theme object (pattern-style supported) */
  @property({ attribute: false })
  accessor theme: any = {};

  /** Computed full theme that is provided to children */
  @provide({ context: cfThemeContext })
  @property({ attribute: false })
  accessor _computedTheme: CFTheme = defaultTheme;

  #unsubs: Array<() => void> = [];

  private _mediaQuery?: MediaQueryList;
  private _onMediaChange = () => this._recomputeAndApply();
  private _onThemePreferenceChanged = () => this._recomputeAndApply();

  override connectedCallback(): void {
    super.connectedCallback();
    // Re-resolve when user toggles theme preference (data-theme attribute)
    document.addEventListener(
      "theme-preference-changed",
      this._onThemePreferenceChanged,
    );
  }

  override firstUpdated(changed: Map<string | number | symbol, unknown>) {
    super.firstUpdated(changed);
    this._recomputeAndApply();
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) {
      this._recomputeAndApply();
    }
  }

  private _recomputeAndApply() {
    this._computedTheme = mergeWithDefaultTheme(
      unwrapThemeCellValues(this.theme),
    );
    applyThemeToElement(this, this._computedTheme);
    this.#setupSubscriptions();

    // Manage the matchMedia listener based on the resolved colorScheme
    if (this._computedTheme.colorScheme === "auto") {
      if (
        !this._mediaQuery && typeof globalThis !== "undefined" &&
        globalThis.matchMedia
      ) {
        this._mediaQuery = globalThis.matchMedia(
          "(prefers-color-scheme: dark)",
        );
        this._mediaQuery.addEventListener("change", this._onMediaChange);
      }
    } else {
      if (this._mediaQuery) {
        this._mediaQuery.removeEventListener("change", this._onMediaChange);
        this._mediaQuery = undefined;
      }
    }
  }

  #setupSubscriptions() {
    // Clear previous subscriptions
    for (const off of this.#unsubs) off();
    this.#unsubs = [];

    this.#unsubs = subscribeToThemeCellValues(
      this.theme,
      () => this._recomputeAndApply(),
    );
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    if (this._mediaQuery) {
      this._mediaQuery.removeEventListener("change", this._onMediaChange);
      this._mediaQuery = undefined;
    }
    document.removeEventListener(
      "theme-preference-changed",
      this._onThemePreferenceChanged,
    );
  }

  override render() {
    return html`
      <slot></slot>
    `;
  }
}
