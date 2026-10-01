import { type CellHandle } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { createFormFieldController } from "../../core/form-field-controller.ts";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  type ComponentSize,
  defaultTheme,
} from "../theme-context.ts";

/**
 * CFSelect – Dropdown/select component that accepts an array of generic JS objects
 *
 * @element cf-select
 *
 * @attr {boolean} disabled     – Whether the select is disabled
 * @attr {boolean} multiple     – Enable multiple selection
 * @attr {boolean} required     – Whether the field is required
 * @attr {string}  size         – Component size variant: "xs" | "sm" | "md" | "lg" | "xl" (default: "md")
 * @attr {number}  visible-rows – Number of visible options (native HTML size attribute)
 * @attr {string}  name         – Name used when participating in a form
 * @attr {string}  placeholder  – Placeholder text rendered as a disabled option
 *
 * @prop {Array<SelectItem | undefined>} items – Data used to generate options
 * @prop {CellHandle<unknown>|CellHandle<unknown[]>|unknown|unknown[]} value – Selected value(s) - supports both Cell and plain values
 *
 * @fires cf-change – detail: { value, oldValue, items }
 * @fires change – detail: { value, oldValue, items }
 * @fires cf-focus
 * @fires cf-blur
 *
 * @example
 * <cf-select id="countrySelect"></cf-select>
 * <script type="module">
 *   const el = document.getElementById("countrySelect");
 *   el.items = [
 *     { label: "USA", value: { code: "US" } },
 *     { label: "Germany", value: { code: "DE" } }
 *   ];
 * </script>
 */

export interface SelectItem {
  /** Text shown to the user */
  label: string;

  /** Arbitrary JS value returned when this option is selected */
  value: unknown;

  /** Disabled state for this option */
  disabled?: boolean;

  /**
   * Optional grouping key. When provided, options with
   * identical `group` values will be wrapped in an <optgroup>.
   */
  group?: string;
}

export class CFSelect extends BaseElement {
  /** Styles */
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        --cf-select-color-text: var(--cf-theme-color-text, #111827);
        --cf-select-color-background: var(--cf-theme-color-background, #ffffff);
        --cf-select-color-border: var(--cf-theme-color-border, #e5e7eb);
        --cf-select-color-border-hover: var(--cf-theme-color-border-muted, #d1d5db);
        --cf-select-color-primary: var(--cf-theme-color-primary, #3b82f6);
        --cf-select-color-ring: rgba(59, 130, 246, 0.15);
        --cf-select-color-surface: var(--cf-theme-color-surface, #f1f5f9);
        --cf-select-border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        --cf-select-animation-duration: var(--cf-theme-animation-duration, 150ms);
        --cf-select-font-family: var(--cf-theme-font-family, inherit);

        /* Sizing scale defaults (size="md") */
        --select-height: var(--cf-size-md-height, 32px);
        --select-padding-x: var(--cf-size-md-padding-h, 8px);
        --select-padding-y: var(--cf-size-md-padding-v, 8px);
        --select-font-size: var(--cf-size-md-font-size, 12px);
        --select-border-radius: var(--cf-size-md-radius, 8px);

        display: inline-block;
        width: 100%;
        box-sizing: border-box;
      }

      :host([size="xs"]) {
        --select-height: var(--cf-size-xs-height, 16px);
        --select-padding-x: var(--cf-size-xs-padding-h, 4px);
        --select-padding-y: var(--cf-size-xs-padding-v, 2px);
        --select-font-size: var(--cf-size-xs-font-size, 9px);
        --select-border-radius: var(--cf-size-xs-radius, 4px);
      }

      :host([size="sm"]) {
        --select-height: var(--cf-size-sm-height, 24px);
        --select-padding-x: var(--cf-size-sm-padding-h, 6px);
        --select-padding-y: var(--cf-size-sm-padding-v, 4px);
        --select-font-size: var(--cf-size-sm-font-size, 11px);
        --select-border-radius: var(--cf-size-sm-radius, 5px);
      }

      :host([size="lg"]) {
        --select-height: var(--cf-size-lg-height, 40px);
        --select-padding-x: var(--cf-size-lg-padding-h, 12px);
        --select-padding-y: var(--cf-size-lg-padding-v, 8px);
        --select-font-size: var(--cf-size-lg-font-size, 16px);
        --select-border-radius: var(--cf-size-lg-radius, 9px);
      }

      :host([size="xl"]) {
        --select-height: var(--cf-size-xl-height, 48px);
        --select-padding-x: var(--cf-size-xl-padding-h, 16px);
        --select-padding-y: var(--cf-size-xl-padding-v, 12px);
        --select-font-size: var(--cf-size-xl-font-size, 18px);
        --select-border-radius: var(--cf-size-xl-radius, 10px);
      }

      select {
        display: block;
        width: 100%;
        padding: var(--select-padding-y) var(--select-padding-x);
        /* Ensure right padding is wide enough to avoid text overlapping the dropdown arrow */
        padding-right: max(var(--select-padding-x), 24px);
        font-size: var(--select-font-size);
        line-height: normal;
        color: var(--cf-select-color-text, #111827);
        background-color: var(--cf-select-color-background, #ffffff);
        border: 1px solid var(--cf-select-color-border, #e5e7eb);
        border-radius: var(--select-border-radius);
        transition: all var(--cf-select-animation-duration, 150ms)
          var(--cf-transition-timing-ease);
        font-family: var(--cf-select-font-family, inherit);
        appearance: none;
        -moz-appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' xmlns='http://www.w3.org/2000/svg' fill='%23666666'%3E%3Cpath d='M6 8 0 0h12L6 8Z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 0.75rem center;
        background-size: 12px 8px;
      }

      /* Only constrain height for single-select without a size attribute;
        multi-select with visible-rows needs to expand freely */
      select:not([multiple]):not([size]) {
        height: var(--select-height);
      }

      /* Disabled */
      select:disabled {
        cursor: not-allowed;
        opacity: 0.5;
        background-color: var(--cf-select-color-surface, #f1f5f9);
      }

      /* Focus */
      select:focus {
        outline: none;
        border-color: var(--cf-select-color-primary, #3b82f6);
        box-shadow: 0 0 0 3px var(--cf-select-color-ring, rgba(59, 130, 246, 0.15));
      }

      /* Hover */
      select:hover:not(:disabled):not(:focus) {
        border-color: var(--cf-select-color-border-hover, #d1d5db);
      }

      /* Arrow removed on multi */
      :host([multiple]) select {
        background-image: none;
      }
    `,
  ];

  private _select!: HTMLSelectElement;

  /** Mapping from stringified option key -> SelectItem */
  private _keyMap = new Map<string, SelectItem>();

  /** Cell controller for value binding */
  private _cellController = createCellController<unknown | unknown[]>(this, {
    timing: { strategy: "immediate" }, // Select changes should be immediate
    onChange: (newValue, oldValue) => {
      // Sync cell value changes to DOM
      this.applyValueToDom();

      // Emit change events
      this.emit("cf-change", {
        value: newValue,
        oldValue,
        items: this.items,
      });

      this.emit("change", {
        value: newValue,
        oldValue,
        items: this.items,
      });
    },
  });

  /** Form field controller for buffering */
  private _formField = createFormFieldController<unknown | unknown[]>(this, {
    cellController: this._cellController,
    validate: () => ({
      valid: this.checkValidity(),
      message: this._select?.validationMessage,
    }),
  });

  //
  // Reactive properties
  //

  static override properties = {
    disabled: { type: Boolean, reflect: true },
    multiple: { type: Boolean, reflect: true },
    required: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
    visibleRows: { type: Number, attribute: "visible-rows" },
    name: { type: String },
    placeholder: { type: String },

    // Non-attribute properties
    items: { attribute: false },
    value: { attribute: false },
  };

  declare disabled: boolean;
  declare multiple: boolean;
  declare required: boolean;
  declare size: ComponentSize;
  declare visibleRows: number;
  declare name: string;
  declare placeholder: string;
  declare items: Array<SelectItem | undefined> | undefined;
  declare value:
    | CellHandle<unknown>
    | CellHandle<unknown[]>
    | unknown
    | unknown[];

  constructor() {
    super();
    this.disabled = false;
    this.multiple = false;
    this.required = false;
    this.size = "md";
    this.visibleRows = 0;
    this.name = "";
    this.placeholder = "";
    this.items = [];
    this.value = this.multiple ? [] : undefined;
    this.addEventListener("focus", this._forwardFocusToSelect);
  }

  //
  // Lifecycle
  //

  override connectedCallback() {
    super.connectedCallback();
    this._updateAccessibilityAttributes();
  }

  override firstUpdated() {
    this._select = this.shadowRoot!.querySelector(
      "select",
    ) as HTMLSelectElement;

    // Initialize cell controller binding
    this._cellController.bind(this.value);
    this.applyValueToDom();
    // Apply theme on first render
    applyThemeToElement(this, this.theme ?? defaultTheme);

    // Register with form after binding is complete
    this._formField.register(this.name);
    this._updateAccessibilityAttributes();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // Controllers handle cleanup automatically via ReactiveController
  }

  override willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      // Bind the new cell first so getValue() returns the new value
      this._cellController.bind(this.value);
      // Then clear buffer - this captures the new cell's value as baseline for reset/dirty
      this._formField.clearBuffer();
    }
  }

  override updated(changed: Map<string | number | symbol, unknown>) {
    if (changed.has("items")) {
      // Rebuild key map each time items array changes
      this._buildKeyMap();
    }

    if (changed.has("value") || changed.has("items")) {
      this.applyValueToDom();
    }
    if (changed.has("theme")) {
      applyThemeToElement(this, this.theme ?? defaultTheme);
    }
    if (
      changed.has("disabled") || changed.has("required") ||
      changed.has("multiple")
    ) {
      this._updateAccessibilityAttributes();
    }
  }

  /** The theme, consumed from the provider. */
  @consume({ context: cfThemeContext, subscribe: true })
  @property({ attribute: false })
  accessor theme: CFTheme = defaultTheme;

  //
  // Render
  //

  override render() {
    return html`
      <!-- The host owns role and tabindex; focus is forwarded to this native
        select instead of using delegatesFocus so keyboard tab order follows the
        host's ARIA surface. -->
      <select
        ?disabled="${this.disabled}"
        ?multiple="${this.multiple}"
        ?required="${this.required}"
        size="${ifDefined(
          this.multiple && this.visibleRows ? this.visibleRows : undefined,
        )}"
        name="${ifDefined(this.name || undefined)}"
        @change="${this._onChange}"
        @focus="${() => this.emit("cf-focus")}"
        @blur="${() => this.emit("cf-blur")}"
        part="select"
        tabindex="-1"
      >
        ${this._renderPlaceholder()} ${this._renderOptions()}
      </select>
    `;
  }

  private _renderPlaceholder() {
    const currentValue = this.getCurrentValue();
    const hasSelection =
      (this.multiple ? (currentValue as unknown[])?.length : currentValue) ??
        false;

    // Use placeholder if provided, otherwise use "-" (no selection)
    const placeholderText = this.placeholder || "-";

    return html`
      <option
        value=""
        disabled
        ?selected="${!hasSelection}"
        hidden="${this.multiple ? false : true}"
      >
        ${placeholderText}
      </option>
    `;
  }

  private _renderOptions() {
    if (!this.items?.length) return nothing;

    // Group items by `group` key
    const groups = new Map<string | undefined, SelectItem[]>();
    this.items.forEach((item) => {
      if (!item) return;
      const key = item.group;
      const arr = groups.get(key) ?? [];
      arr.push(item);
      groups.set(key, arr);
    });

    const renderItem = (item: SelectItem, index: number) => {
      const optionKey = this._makeKey(item, index);
      return html`
        <option
          value="${optionKey}"
          ?disabled="${item.disabled ?? false}"
          data-index="${index}"
        >
          ${item.label}
        </option>
      `;
    };

    const templates: unknown[] = [];
    let runningIndex = 0;

    groups.forEach((items, group) => {
      if (group) {
        templates.push(html`
          <optgroup label="${group}">
            ${items.map((i) => renderItem(i, runningIndex++))}
          </optgroup>
        `);
      } else {
        for (const item of items) {
          templates.push(renderItem(item, runningIndex++));
        }
      }
    });

    // Build key map once per render
    this._buildKeyMap();

    return templates;
  }

  //
  // Events
  //

  private _onChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const _oldValue = this.getCurrentValue();
    let newValue: unknown | unknown[];

    if (this.multiple) {
      const selectedKeys = Array.from(select.selectedOptions).map(
        (o) => o.value,
      );
      newValue = selectedKeys.map((k) => this._keyMap.get(k)!.value);
    } else {
      const optKey = select.value;
      newValue = this._keyMap.get(optKey)?.value;
    }

    // Use form field controller (handles buffering vs direct write)
    this._formField.setValue(newValue);
  }

  //
  // Public API
  //

  override focus(options?: FocusOptions) {
    if (this.disabled) return;
    this._select?.focus(options);
  }

  override blur() {
    this._select?.blur();
  }

  checkValidity() {
    return this._select?.checkValidity() ?? true;
  }

  reportValidity() {
    return this._select?.reportValidity() ?? true;
  }

  private _lastGeneratedRole: string | null = null;

  private _forwardFocusToSelect = () => {
    if (this.disabled) return;
    this._select?.focus();
  };

  //
  // Accessibility
  //

  private _updateAccessibilityAttributes() {
    // A single select is a combobox; a multi-select is a listbox (ARIA spec).
    const role = this.multiple ? "listbox" : "combobox";
    if (
      !this.hasAttribute("role") ||
      this.getAttribute("role") === this._lastGeneratedRole
    ) {
      this.setAttribute("role", role);
      this._lastGeneratedRole = role;
    }
    if (!this.hasAttribute("exportparts")) {
      this.setAttribute("exportparts", "select");
    }
    this.tabIndex = this.disabled ? -1 : 0;
    this.setAttribute("aria-disabled", String(this.disabled));
    this.setAttribute("aria-required", String(this.required));
  }

  //
  // Internal helpers
  //

  private _makeKey(_item: SelectItem, index: number) {
    // Unique deterministic key for each option
    return `${index}`;
  }

  private _buildKeyMap() {
    this._keyMap.clear();
    this.items?.forEach((item, index) => {
      if (!item) return;
      this._keyMap.set(this._makeKey(item, index), item);
    });
  }

  /**
   * Get the current value from the form field controller
   */
  private getCurrentValue(): unknown | unknown[] {
    return this._formField.getValue();
  }

  /**
   * After any update, ensure DOM option selection state
   * matches the current value.
   */
  private applyValueToDom() {
    if (!this._select) return;

    const currentValue = this.getCurrentValue();

    if (this.multiple) {
      const values = (currentValue as unknown[] | undefined) ?? [];
      Array.from(this._select.options).forEach((opt) => {
        const item = this._keyMap.get(opt.value);
        opt.selected = !!item && values.some((v) => Object.is(item.value, v));
      });
    } else {
      const val = currentValue;
      const matchKey = [...this._keyMap.entries()].find(
        ([, item]) => Object.is(item.value, val),
      )?.[0];

      this._select.value = matchKey ?? "";
    }
  }
}
