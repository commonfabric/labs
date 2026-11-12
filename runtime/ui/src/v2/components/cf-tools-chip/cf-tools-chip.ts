import { ToolsArraySchema } from "@commonfabric/runner/component-read-contract";
import type { CellHandle } from "@commonfabric/runtime-client";
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

/** The members of a tool entry or a JSON schema that the chip reads. */
interface ToolMembers {
  readonly type?: unknown;
  readonly description?: unknown;
  readonly desc?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly parameters?: unknown;
  readonly schema?: unknown;
  readonly inputSchema?: unknown;
  readonly input_schema?: unknown;
  readonly argsSchema?: unknown;
  readonly args_schema?: unknown;
  readonly argumentSchema?: unknown;
  readonly meta?: unknown;
  readonly docs?: unknown;
  readonly doc?: unknown;
  readonly pattern?: unknown;
}

/** The members of `value` the chip reads, or none where it is no object. */
function members(value: unknown): ToolMembers {
  return typeof value === "object" && value !== null ? value : {};
}

/**
 * The description a tool entry, or the pattern a tool entry holds, gives
 * itself or its argument schema, under one of the names tools use for it.
 */
function descriptionIn(entry: ToolMembers): unknown {
  return entry.description ??
    members(entry.meta).description ??
    members(entry.parameters).description ??
    members(entry.schema).description ??
    members(entry.inputSchema).description ??
    members(entry.input_schema).description ??
    members(entry.argumentSchema).description ??
    members(entry.docs).description ??
    members(entry.doc).description ??
    entry.desc;
}

/**
 * The argument schema a tool entry, or the pattern a tool entry holds, keeps
 * under one of the names tools use for it, or the entry itself where it is a
 * schema.
 */
function schemaIn(entry: ToolMembers): unknown {
  return entry.parameters ?? entry.schema ?? entry.inputSchema ??
    entry.input_schema ?? entry.argsSchema ?? entry.args_schema ??
    entry.argumentSchema ??
    (entry.type || entry.properties || entry.required ? entry : undefined);
}

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
    globalThis.addEventListener("resize", this.#onWindowChange, {
      passive: true,
    });
    globalThis.addEventListener("scroll", this.#onWindowChange, true);
    this.#resizeObs = new ResizeObserver(() => this.#positionOverlay());
    this.#resizeObs.observe(this);
    // A chip added again while open shows its panel again.
    if (this.open) this.requestUpdate();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.#onKeyDown);
    globalThis.removeEventListener("click", this.#onGlobalClick, true);
    globalThis.removeEventListener("resize", this.#onWindowChange);
    globalThis.removeEventListener("scroll", this.#onWindowChange, true);
    this.#resizeObs?.disconnect();
    this.#resizeObs = undefined;
    this.#unmountOverlay();
    // A removed chip is out from under the pointer, so a panel the pointer
    // holds open, or is about to close by leaving, closes now; an `open` the
    // page set or a click toggled is kept.
    if (
      this.openOnHover && !this._toggledOpen &&
      (this._hovering || this.#closeTimer)
    ) this.open = false;
    if (this.#closeTimer) globalThis.clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
    this._hovering = this._toggledOpen = false;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    super.willUpdate(changedProperties);
    if (changedProperties.has("tools")) {
      this._cellController.bind(this.tools ?? [], ToolsArraySchema);
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
    this.#positionOverlay();
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

  private _onClick = () => {
    if (!this.toggleOnClick) return;
    this._toggledOpen = !this._toggledOpen;
    this.open = this._toggledOpen || this._hovering;
  };

  private _renderSchema(schema: unknown): unknown {
    // Reads the properties of an OpenAI-style `{ parameters: { properties,
    // required } }` or of a JSON Schema `{ properties, required }`.
    const params = members(members(schema).parameters ?? schema);
    const required: unknown[] = Array.isArray(params.required)
      ? params.required
      : [];
    const entries = Object.entries(members(params.properties));

    if (!entries.length) return nothing;

    const lines = entries.map(([key, def]) => {
      const { type, description } = members(def);
      const req = required.includes(key) ? " (required)" : "";
      const desc = description ? ` — ${description}` : "";
      return `• ${key}: ${type ?? "unknown"}${req}${desc}`;
    });

    return html`
      <div class="schema">${lines.join("\n")}</div>
    `;
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
    return Object.entries(t).map(([name, entry]) => {
      const value = members(entry);
      const pattern = members(value.pattern);
      const description = descriptionIn(value) ?? descriptionIn(pattern);
      return {
        name,
        description: typeof description === "string" ? description : undefined,
        schema: schemaIn(value) ?? schemaIn(pattern),
      };
    });
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    super.updated(changed);
    if (changed.has("theme")) applyThemeToElement(this, this.theme);
    if (!this.open || !this.isConnected) {
      this.#unmountOverlay();
      return;
    }
    // An update while open redraws the panel, since the tools a bound cell
    // holds change without `tools` changing.
    let overlay = this.#overlay;
    if (!overlay) overlay = this.#mountOverlay();
    else if (changed.has("theme")) copyThemeProperties(this, overlay);
    this.#renderOverlay(overlay);
    this.#positionOverlay();
  }

  #mountOverlay(): HTMLDivElement {
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.inset = "0 auto auto 0";
    el.style.zIndex = "1000";
    el.style.pointerEvents = "none"; // enable internal panel to control
    el.dataset.cfToolsChipOverlay = "";
    document.body.appendChild(el);
    this.#overlay = el;
    copyThemeProperties(this, el);
    return el;
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

  #renderOverlay(overlay: HTMLDivElement) {
    const label = this.label || "Tools";
    const items = this._normalizedTools();
    const count = items.length;
    // The overlay's own styles, scoped to the overlay since it sits in the
    // document.
    const tpl = html`
      <style>
      @scope ([data-cf-tools-chip-overlay]) {
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
      }
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
    render(tpl, overlay);
  }

  #positionOverlay() {
    const panel = this.#overlay?.querySelector<HTMLElement>(".panel");
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

  override render() {
    const label = this.label || "Tools";
    const count = this._normalizedTools().length;

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
    `;
  }
}

export type { CFToolsChip as CFToolsChipElement };
