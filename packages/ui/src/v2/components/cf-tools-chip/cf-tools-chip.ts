import { ToolsArraySchema } from "@commonfabric/runner/component-read-contract";
import { type CellHandle } from "@commonfabric/runtime-client";
import { css, html, nothing, render } from "lit";
import { property, state } from "lit/decorators.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import {
  AmbientThemeWatch,
  applyThemeToElement,
  type CFTheme,
  copyThemeProperties,
} from "../theme-context.ts";

/**
 * CFToolsChip - Rounded pill that reveals a read-only tool list on hover/tap.
 *
 * @element cf-tools-chip
 *
 * @attr {string} label - Chip label to display, defaults to "Tools".
 * @attr {boolean} show-count - Show the number of tools beside the label.
 * @attr {boolean} open-on-hover - Open the panel on hover/focus (default).
 * @attr {boolean} toggle-on-click - Toggle the panel on click/tap (default).
 *
 * @prop {CellHandle<ToolsChipTool[]|ToolsRecord>|ToolsChipTool[]|ToolsRecord} tools -
 *   Array or record of tools to display in the panel. Supports CellHandle for
 *   reactive updates when tools change.
 *
 * @slot - Optional slot to override the chip label content.
 *
 * @example
 * // With plain array
 * <cf-tools-chip tools=${tools} label="Workspace" />
 *
 * @example
 * // With CellHandle for reactive updates
 * <cf-tools-chip $tools=${toolsCell} label="Workspace" />
 */
export type ToolsChipTool = {
  name: string;
  description?: string;
  // JSON Schema (or compatible) describing arguments/parameters
  schema?: unknown;
};

// Native format support: { [toolName]: { handler: def } | { pattern: def } }
export type ToolsRecord = Record<
  string,
  | { handler?: unknown; pattern?: unknown; [k: string]: unknown }
  | Record<string, unknown>
>;

// Union type for tools input
type ToolsInput = ToolsChipTool[] | ToolsRecord;

export class CFToolsChip extends BaseElement {
  /** Cell controller for tools binding */
  private _cellController = createCellController<ToolsInput>(this, {
    timing: { strategy: "immediate" },
    onChange: () => {
      this.requestUpdate();
    },
  });

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        position: relative;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.25rem 0.625rem;
        background: var(
          --cf-theme-color-surface,
          var(--cf-colors-gray-100, #f2f3f6)
        );
        color: var(
          --cf-theme-color-text,
          var(--cf-colors-gray-900, #16181d)
        );
        border: 1px solid
          var(--cf-theme-color-border, var(--cf-colors-gray-300, #d5d7dd));
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        font-size: 0.8125rem;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        transition:
          background-color var(--cf-theme-animation-duration, 200ms) ease,
          border-color var(--cf-theme-animation-duration, 200ms) ease,
          transform var(--cf-theme-animation-duration, 200ms) ease;
      }

      .chip:hover {
        background: var(
          --cf-theme-color-surface-hover,
          var(--cf-colors-gray-200, #eceef1)
        );
      }

      .dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(
          --cf-theme-color-accent,
          var(--cf-colors-primary-500, #4979fa)
        );
      }

      .count {
        color: var(--cf-theme-color-text-muted, #6b7280);
        font-variant-numeric: tabular-nums;
      }

      .panel {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        min-width: 260px;
        max-width: 420px;
        max-height: 60vh;
        overflow: auto;
        background: var(
          --cf-theme-color-surface,
          var(--cf-colors-gray-50, #ffffff)
        );
        color: var(
          --cf-theme-color-text,
          var(--cf-colors-gray-900, #16181d)
        );
        border: 1px solid
          var(--cf-theme-color-border, var(--cf-colors-gray-300, #d5d7dd));
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-lg, 0.5rem)
        );
        box-shadow: var(
          --cf-shadow-md,
          0 4px 6px -1px rgba(0, 0, 0, 0.1),
          0 2px 4px -1px rgba(0, 0, 0, 0.06)
        );
        padding: var(--cf-size-md-spacing, 8px);
        z-index: 50;
        opacity: 0;
        transform: translateY(-4px);
        pointer-events: none;
        transition:
          opacity var(--cf-theme-animation-duration, 200ms) ease,
          transform var(--cf-theme-animation-duration, 200ms) ease;
      }

      :host([open]) .panel,
      .panel[data-open="true"] {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--cf-size-md-spacing, 8px);
        padding: 0.25rem 0.25rem var(--cf-size-md-spacing, 8px) 0.25rem;
        border-bottom: 1px solid
          var(--cf-theme-color-border, var(--cf-colors-gray-300, #d5d7dd));
        margin-bottom: var(--cf-size-md-spacing, 8px);
      }

      .panel-title {
        font-size: 0.875rem;
        font-weight: 600;
      }

      .tool-list {
        display: grid;
        gap: var(--cf-size-md-spacing, 8px);
      }

      .tool-item {
        display: grid;
        gap: var(--cf-size-sm-spacing, 4px);
        padding: var(--cf-size-sm-padding-v, 4px) var(--cf-size-md-padding-h, 8px);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        background: transparent;
      }

      .tool-name {
        font-size: 0.8125rem;
        font-weight: 600;
      }

      .tool-desc {
        font-size: var(--cf-size-md-font-size, 12px);
        color: var(--cf-theme-color-text-muted, #6b7280);
      }

      .schema {
        font-family: var(--cf-theme-mono-font-family, monospace);
        font-size: 0.72rem;
        color: var(--cf-theme-color-text-muted, #6b7280);
        border-left: 2px solid
          var(--cf-theme-color-border-muted, var(--cf-colors-gray-300));
        padding-left: 0.5rem;
        white-space: pre-wrap;
      }
    `,
  ];

  static override properties = {
    label: { type: String },
    showCount: { type: Boolean, attribute: "show-count", reflect: true },
    openOnHover: { type: Boolean, attribute: "open-on-hover" },
    toggleOnClick: { type: Boolean, attribute: "toggle-on-click" },
    open: { type: Boolean, reflect: true },
    tools: { attribute: false },
    closeDelay: { type: Number, attribute: "close-delay" },
  } as const;

  /** Chip label shown in the pill. */
  declare label: string;

  /** Show the number of tools next to the label. */
  declare showCount: boolean;

  /** If true, hovering/focus opens the panel. */
  declare openOnHover: boolean;

  /** If true, clicking toggles the panel. */
  declare toggleOnClick: boolean;

  /** Current open state. Reflected to attribute. */
  declare open: boolean;

  /** Tools array shown in the panel. Accepts array, record, or CellHandle. */
  @property({ attribute: false })
  accessor tools:
    | CellHandle<ToolsInput>
    | ToolsChipTool[]
    | ToolsRecord
    | undefined = undefined;

  /** Delay in ms before closing on hover-out. */
  declare closeDelay: number;

  /** Whether the pointer is in, tracked so hover open/close works reliably. */
  @state()
  private accessor _hovering = false;

  /**
   * Whether the user toggled the panel open, which keeps it open until clicked
   * again.
   */
  @state()
  private accessor _toggledOpen = false;

  #closeTimer?: ReturnType<typeof setTimeout>;

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  // Overlay/popover state
  #overlay: HTMLDivElement | null = null;
  #resizeObs?: ResizeObserver;
  #raf?: number;

  constructor() {
    super();
    new AmbientThemeWatch(this, () => {
      if (this.#overlay) copyThemeProperties(this, this.#overlay);
    });
    this.label = "Tools";
    this.showCount = true;
    this.openOnHover = true;
    this.toggleOnClick = true;
    this.open = false;
    this.tools = [];
    this.closeDelay = 200;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("keydown", this.#onKeyDown);
    globalThis.addEventListener("click", this.#onGlobalClick, true);
    this.#resizeObs = new ResizeObserver(() => this.#repositionActive());
    this.#resizeObs.observe(this);
    globalThis.addEventListener("resize", this.#onWindowChange, {
      passive: true,
    });
    globalThis.addEventListener("scroll", this.#onWindowChange, true);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.#onKeyDown);
    globalThis.removeEventListener("click", this.#onGlobalClick, true);
    this.#resizeObs?.disconnect();
    this.#resizeObs = undefined;
    globalThis.removeEventListener("resize", this.#onWindowChange);
    globalThis.removeEventListener("scroll", this.#onWindowChange, true);
    this.#unmountOverlay();
    if (this.#closeTimer) globalThis.clearTimeout(this.#closeTimer);
  }

  override firstUpdated(changedProperties: Map<string, unknown>): void {
    super.firstUpdated(changedProperties);
    // Initialize cell controller binding
    if (this.tools !== undefined) {
      this._cellController.bind(this.tools, ToolsArraySchema);
    }
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    super.willUpdate(changedProperties);
    // If the tools property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("tools") && this.tools !== undefined) {
      this._cellController.bind(this.tools, ToolsArraySchema);
    }
  }

  #onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.open) {
      this._toggledOpen = false;
      this.open = false;
      e.stopPropagation();
      e.preventDefault();
    }
    if ((e.key === "Enter" || e.key === " ") && this.toggleOnClick) {
      this._toggledOpen = !this._toggledOpen;
      this.open = this._toggledOpen || this._hovering;
      e.preventDefault();
    }
  };

  #onGlobalClick = (e: Event) => {
    if (!this.open) return;
    const path = e.composedPath();
    const clickedChip = path.includes(this);
    const clickedOverlay = this.#overlay ? path.includes(this.#overlay) : false;
    if (!clickedChip && !clickedOverlay) {
      if (this._toggledOpen) return; // stay open until user toggles
      this.open = false;
    }
  };

  #onWindowChange = () => {
    if (!this.open) return;
    this.#repositionActive();
  };

  private _onMouseEnter = () => {
    this._hovering = true;
    if (this.#closeTimer) {
      globalThis.clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    if (this.openOnHover) this.open = true;
  };

  private _onMouseLeave = () => {
    this._hovering = false;
    if (!this.openOnHover) return;
    if (this._toggledOpen) return; // toggled stays open
    if (this.#closeTimer) globalThis.clearTimeout(this.#closeTimer);
    this.#closeTimer = globalThis.setTimeout(() => {
      if (!this._hovering && !this._toggledOpen) {
        this.open = false;
      }
      this.#closeTimer = undefined;
    }, this.closeDelay);
  };

  private _onClick = (e: MouseEvent) => {
    if (!this.toggleOnClick) return;
    // Avoid toggling when clicking inside the panel content area.
    const target = e.composedPath()[0] as HTMLElement;
    if (target && target.closest && target.closest(".panel")) return;
    this._toggledOpen = !this._toggledOpen;
    this.open = this._toggledOpen || this._hovering;
  };

  private _renderSchema(schema: unknown): unknown {
    try {
      // Try to extract properties from common shapes:
      // 1) OpenAI-style: { parameters: { properties, required } }
      // 2) Direct JSON Schema: { properties, required }
      const s = schema as any;
      const params = s?.parameters ?? s;
      const props = params?.properties ?? {};
      const required: string[] = Array.isArray(params?.required)
        ? params.required
        : [];
      const entries = Object.entries(props) as Array<[
        string,
        Record<string, unknown>,
      ]>;

      if (!entries.length) return nothing;

      const lines = entries.map(([key, def]) => {
        const t = (def as any)?.type ?? "unknown";
        const desc = (def as any)?.description ?? "";
        const req = required.includes(key) ? " (required)" : "";
        return `• ${key}: ${t}${req}${desc ? ` — ${desc}` : ""}`;
      });

      return html`
        <div class="schema">${lines.join("\n")}</div>
      `;
    } catch (_) {
      return nothing;
    }
  }

  /** The resolved tools value, from either a `CellHandle` or a plain value. */
  private get _toolsValue(): Readonly<ToolsInput> | undefined {
    return this._cellController.getValue() ?? undefined;
  }

  /**
   * Normalizes the incoming tools (an array or a native record) to
   * display-friendly objects with name, description, and schema.
   */
  private _normalizedTools(): ToolsChipTool[] {
    const t = this._toolsValue;
    if (!t) return [];
    if (Array.isArray(t)) return t;
    const rec = t as ToolsRecord;
    const out: ToolsChipTool[] = [];
    for (const name of Object.keys(rec)) {
      const value = rec[name] as any;

      // Read from top-level tool object first
      const topDescription = value?.description ??
        value?.meta?.description ??
        value?.parameters?.description ?? value?.schema?.description ??
        value?.inputSchema?.description ??
        value?.input_schema?.description ??
        value?.docs?.description ?? value?.doc?.description ??
        value?.desc ??
        (value && (value.type || value.properties)
          ? value.description
          : undefined);

      let topSchema = value?.parameters ?? value?.schema ??
        value?.inputSchema ??
        value?.input_schema ?? value?.argsSchema ?? value?.args_schema;
      if (
        !topSchema && value &&
        (value.type || value.properties || value.required)
      ) {
        topSchema = value;
      }

      // Also support nested pattern.* containers (e.g., pattern.argumentSchema)
      const p = value?.pattern ?? {};
      const patternDescription = p?.description ?? p?.meta?.description ??
        p?.parameters?.description ?? p?.schema?.description ??
        p?.inputSchema?.description ?? p?.input_schema?.description ??
        p?.argumentSchema?.description ?? p?.docs?.description ??
        p?.doc?.description;

      let patternSchema = p?.parameters ?? p?.schema ?? p?.inputSchema ??
        p?.input_schema ?? p?.argsSchema ?? p?.args_schema ??
        p?.argumentSchema;
      if (!patternSchema && (p?.type || p?.properties || p?.required)) {
        patternSchema = p;
      }

      const description = topDescription ?? patternDescription;
      const schema = topSchema ?? patternSchema;

      out.push({ name, description, schema });
    }
    return out;
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) applyThemeToElement(this, this.theme);
    if (changed.has("open") || changed.has("tools")) {
      if (this.open) {
        this.#mountOverlay();
        this.#renderOverlay();
        this.#positionOverlay();
      } else {
        this.#unmountOverlay();
      }
    } else if (this.#overlay && changed.has("theme")) {
      copyThemeProperties(this, this.#overlay);
    }
  }

  #mountOverlay() {
    if (this.#overlay) return;
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.inset = "0 auto auto 0";
    el.style.zIndex = "1000";
    el.style.pointerEvents = "none"; // enable internal panel to control
    el.dataset.cfToolsChipOverlay = "";
    document.body.appendChild(el);
    this.#overlay = el;
    copyThemeProperties(this, el);
  }

  #unmountOverlay() {
    if (this.#overlay) {
      render(nothing, this.#overlay);
      this.#overlay.remove();
      this.#overlay = null;
    }
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = undefined;
  }

  #renderOverlay() {
    if (!this.#overlay) return;
    const label = this.label || "Tools";
    const items = this._normalizedTools();
    const count = items.length;
    // Inline style block so overlay has its own styling.
    const tpl = html`
      <style>
      .panel {
        position: absolute;
        min-width: 260px;
        max-width: 420px;
        max-height: 60vh;
        overflow: auto;
        background: var(--cf-theme-color-surface, #fff);
        color: var(--cf-theme-color-text, #0f172a);
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(--cf-theme-border-radius, 0.5rem);
        box-shadow: var(--cf-shadow-md, 0 4px 6px -1px rgba(0,0,0,.1),
          0 2px 4px -1px rgba(0,0,0,.06));
        padding: var(--cf-size-md-spacing, 8px);
        pointer-events: auto;
      }
      .panel:focus {
        outline: none;
      }
      .panel-header { display: flex; align-items: center;
        justify-content: space-between; gap: var(--cf-size-md-spacing, 8px); padding: .25rem .25rem
        var(--cf-size-md-spacing, 8px) .25rem; border-bottom: 1px solid var(--cf-theme-color-border,
        #e5e7eb); margin-bottom: var(--cf-size-md-spacing, 8px); }
      .panel-title { font-size: .875rem; font-weight: 600; }
      .count { color: var(--cf-theme-color-text-muted, #6b7280);
        font-variant-numeric: tabular-nums; }
      .tool-list { display: grid; gap: var(--cf-size-md-spacing, 8px); }
      .tool-item { display: grid; gap: var(--cf-size-sm-spacing, 4px); padding: var(--cf-size-sm-padding-v, 4px) var(--cf-size-md-padding-h, 8px);
        border-radius: var(--cf-theme-border-radius, .375rem); }
      .tool-name { font-size: .8125rem; font-weight: 600; }
      .tool-desc { font-size: var(--cf-size-md-font-size, 12px);
        color: var(--cf-theme-color-text-muted, #6b7280); }
      .schema { font-family: var(--cf-theme-mono-font-family, monospace);
        font-size: .72rem; color: var(--cf-theme-color-text-muted, #6b7280);
        border-left: 2px solid var(--cf-theme-color-border-muted,#e5e7eb);
        padding-left: .5rem; white-space: pre-wrap; }
      </style>
      <div
        class="panel"
        role="listbox"
        tabindex="-1"
        @mouseenter="${this._onMouseEnter}"
        @mouseleave="${this._onMouseLeave}"
      >
        <div class="panel-header">
          <div class="panel-title">${label}</div>
          ${this.showCount && count > 0
            ? html`
              <div class="count">${count} tool${count === 1 ? "" : "s"}</div>
            `
            : nothing}
        </div>
        <div class="tool-list">
          ${items.map((tool) =>
            html`
              <div class="tool-item" role="option">
                <div class="tool-name">${tool.name}</div>
                ${tool.description
                  ? html`
                    <div class="tool-desc">${tool.description}</div>
                  `
                  : nothing} ${tool.schema
                  ? this._renderSchema(tool.schema)
                  : nothing}
              </div>
            `
          )} ${items.length === 0
            ? html`
              <div class="tool-item">
                <div class="tool-desc">No tools available.</div>
              </div>
            `
            : nothing}
        </div>
      </div>
    `;
    render(tpl, this.#overlay);
  }

  #positionOverlay() {
    if (!this.#overlay) return;
    const panel = this.#overlay.querySelector(
      ".panel",
    ) as HTMLElement | null;
    if (!panel) return;

    const rect = this.getBoundingClientRect();
    // Start below-left.
    let top = rect.bottom + 6;
    let left = rect.left;

    // Temporarily set position for measurement.
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";

    // Next frame, measure and adjust to viewport.
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = requestAnimationFrame(() => {
      const vw = globalThis.innerWidth;
      const vh = globalThis.innerHeight;
      const pr = panel.getBoundingClientRect();

      // Horizontal clamping
      if (pr.right > vw - 8) {
        left = Math.max(8, vw - pr.width - 8);
      }
      if (left < 8) left = 8;

      // Vertical flip if overflow bottom
      if (pr.bottom > vh - 8) {
        const above = rect.top - pr.height - 6;
        if (above >= 8) top = above; // place above if space
        else top = Math.max(8, vh - pr.height - 8); // clamp
      }

      panel.style.top = `${Math.round(top)}px`;
      panel.style.left = `${Math.round(left)}px`;
    });
  }

  #repositionActive() {
    this.#positionOverlay();
  }

  override render() {
    const label = this.label || "Tools";
    const tools = this._toolsValue;
    const count = Array.isArray(tools)
      ? (tools?.length ?? 0)
      : (tools ? Object.keys(tools as object).length : 0);

    return html`
      <div
        class="chip"
        role="button"
        tabindex="0"
        aria-haspopup="listbox"
        aria-expanded="${String(this.open)}"
        @mouseenter="${this._onMouseEnter}"
        @mouseleave="${this._onMouseLeave}"
        @click="${this._onClick}"
      >
        <span class="dot" aria-hidden="true"></span>
        <slot>${label}</slot>
        ${this.showCount && count > 0
          ? html`
            <span class="count">${count}</span>
          `
          : nothing}
      </div>

      ${nothing}
    `;
  }
}

export type { CFToolsChip as CFToolsChipElement };
