import type { IframePresentation } from "@commonfabric/iframe-sandbox";
import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";
import { ContextConsumer, provide } from "@lit/context";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { valueForDisplay } from "../../core/value-for-display.ts";
import { iframePresentationContext } from "../cf-iframe/cf-iframe.ts";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  defaultTheme,
  mergeWithDefaultTheme,
  resolveColorScheme,
  tokenAround,
} from "../theme-context.ts";
import {
  computedThemeValues,
  guestPresentation,
  sameGuestPresentation,
} from "./guest-presentation.ts";

export function unwrapThemeCellValues(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (isCellHandle(value)) {
    // A theme value the worker will not show, or has not answered, reads as
    // `undefined`, which the object branch below leaves out, so the default
    // takes its place, as it does for a cell inside its own value.
    if (seen.has(value)) return undefined;
    seen.add(value);
    const unwrapped = unwrapThemeCellValues(valueForDisplay(value), seen);
    seen.delete(value);
    return unwrapped;
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
    const unwrapped = unwrapThemeCellValues(child, seen);
    // Left out rather than set to `undefined`, which a merge would take
    // over the default.
    if (unwrapped !== undefined) out[key] = unwrapped;
  }
  return out;
}

/**
 * The `CellHandle`s `value` reaches, each once: those it holds, through
 * arrays, objects, and cycles, and those the values of those cells hold in
 * turn.
 */
export function themeCellHandles(value: unknown): Set<CellHandle<unknown>> {
  const cells = new Set<CellHandle<unknown>>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown) => {
    if (isCellHandle(current)) {
      if (cells.has(current)) return;
      cells.add(current);
      visit(valueForDisplay(current));
      return;
    }
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
  return cells;
}

/**
 * cf-theme — Provides a theme to a subtree and applies CSS vars.
 *
 * Usage:
 * <cf-theme .theme=${partialTheme}><slot/></cf-theme>
 *
 * The component unwraps CellHandle values inside a partial theme, merges the
 * result over the enclosing `cf-theme`'s theme, or over the defaults when there
 * is none, provides it via context, and sets CSS custom properties on the host
 * so descendants pick up tokens. A nested instance sets only the properties
 * its partial changes, and the rest inherit from the enclosing one. An
 * outermost instance sets them all, unless a host already has `--cf-theme-*`
 * tokens in effect by CSS: then it sets only what its partial changes from
 * the defaults.
 *
 * It also provides `iframePresentationContext`, so every `cf-iframe` beneath
 * it that has no `presentation` of its own themes its guest: the
 * `--cf-theme-*` values computed on this element, which include a host's CSS
 * overrides of them, followed by the guest base sheet, with the resolved
 * color scheme as the guest root's `data-color-scheme`. It reads them again
 * whenever it recomputes, including on `theme-preference-changed`, the event
 * a host dispatches on `document` after changing the tokens by CSS, since a
 * custom property changes without one; an unchanged reading provides nothing
 * new.
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

  /**
   * The presentation provided to `cf-iframe` guests beneath, `null` until the
   * first computation; a guest receives the latest one when it loads.
   */
  @provide({ context: iframePresentationContext })
  @property({ attribute: false })
  accessor _guestPresentation: IframePresentation | null = null;

  /**
   * The cells the theme reaches ({@link themeCellHandles}) while connected,
   * each with the cancel of its subscription.
   */
  readonly #followed = new Map<CellHandle<unknown>, () => void>();

  /** The enclosing `cf-theme`'s theme, or `undefined` for an outermost one. */
  #enclosing: CFTheme | undefined;

  private _mediaQuery?: MediaQueryList;
  private _onMediaChange = () => this._recomputeAndApply();
  private _onThemePreferenceChanged = () => this._recomputeAndApply();

  constructor() {
    super();
    // A provider ignores requests from its own host, so this one is answered
    // by the enclosing `cf-theme`, if there is one.
    new ContextConsumer(this, {
      context: cfThemeContext,
      subscribe: true,
      callback: (theme) => {
        this.#enclosing = theme;
        if (this.hasUpdated) this._recomputeAndApply();
      },
    });
  }

  override connectedCallback(): void {
    // Reconnected elsewhere, it is outermost unless a provider answers again.
    this.#enclosing = undefined;
    super.connectedCallback();
    this.#follow();
    if (this.hasUpdated) this._recomputeAndApply();
    // Re-resolve when user toggles theme preference (data-theme attribute)
    document.addEventListener(
      "theme-preference-changed",
      this._onThemePreferenceChanged,
    );
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) {
      this.#follow();
      this._recomputeAndApply();
    }
  }

  private _recomputeAndApply() {
    // Under a host's tokens an outermost instance is a tint: it writes what
    // its partial changes from the defaults, and the host's values stand
    // wherever the partial is silent.
    const around = this.#enclosing ??
      (tokenAround(this, "--cf-theme-color-text") ? defaultTheme : undefined);
    const computed = mergeWithDefaultTheme(
      unwrapThemeCellValues(this.theme),
      this.#enclosing,
    );
    // Styles first: a consumer told of the new theme reads them at once.
    applyThemeToElement(this, computed, around);
    this._computedTheme = computed;
    this.#provideGuestPresentation();

    // Follow the system scheme for an `auto` theme while connected.
    if (this.isConnected && this._computedTheme.colorScheme === "auto") {
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

  /** Provides the guest presentation read now, unless it reads as before. */
  #provideGuestPresentation() {
    const next = guestPresentation(
      computedThemeValues(this),
      resolveColorScheme(this._computedTheme.colorScheme),
    );
    const held = this._guestPresentation;
    if (held && sameGuestPresentation(held, next)) return;
    this._guestPresentation = next;
  }

  /**
   * Subscribes to the cells the theme reaches while the element is connected,
   * and to nothing otherwise: to each it does not yet follow, cancelling the
   * subscription to each it no longer reaches. A cell's change recomputes the
   * theme and follows again, since its new value can reach other cells. A
   * subscription hears nothing of the value it starts with, which the theme
   * was computed from.
   */
  #follow(): void {
    const cells = this.isConnected
      ? themeCellHandles(this.theme)
      : new Set<CellHandle<unknown>>();
    for (const [cell, cancel] of this.#followed) {
      if (cells.has(cell)) continue;
      cancel();
      this.#followed.delete(cell);
    }
    for (const cell of cells) {
      if (this.#followed.has(cell)) continue;
      let started = false;
      const changed = () => {
        if (!started) {
          started = true;
          return;
        }
        this._recomputeAndApply();
        this.#follow();
      };
      this.#followed.set(cell, cell.subscribe(changed, { onRefused: changed }));
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#follow();
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
