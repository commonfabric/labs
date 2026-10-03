import type { Schema } from "@commonfabric/api/schema";
import {
  AutocompleteItemArraySchema,
  autocompleteValueSchema,
} from "@commonfabric/runner/component-read-contract";
import { type CellHandle } from "@commonfabric/runtime-client";
import { consume } from "@lit/context";
import { css, html, nothing, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import {
  applyThemeToElement,
  type CFTheme,
  cfThemeContext,
  defaultTheme,
} from "../theme-context.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * AutocompleteItem - Item format for cf-autocomplete
 */
export interface AutocompleteItem {
  /** Value returned when selected */
  value: string;

  /** Display text (defaults to value if not provided) */
  label?: string;

  /** Category for grouping/disambiguation */
  group?: string;

  /** Additional search terms that match this item */
  searchAliases?: string[];

  /**
   * Arbitrary data to pass through with cf-select event.
   *
   * NOTE: Cell references passed here will be converted to link representations
   * during event sanitization. The original Cell instance is NOT preserved.
   * Use `Cell.equals()` for comparisons - it handles both Cells and links.
   *
   * @example
   * // In pattern - pass piece reference
   * items={pieces.map(c => ({ value: c[NAME], data: c }))}
   *
   * // In handler - compare with Cell.equals()
   * const { data: piece } = event.detail;
   * const isDuplicate = members.some(m => Cell.equals(m.piece, piece));
   */
  data?: unknown;
}

// Type validation: ensure schema matches interface
type _ValidateAutocompleteItem = Schema<
  typeof AutocompleteItemArraySchema
>[number] extends AutocompleteItem ? true : never;
const _validateAutocompleteItem: _ValidateAutocompleteItem = true;

/**
 * Pre-processed item with search words for fast matching.
 * Words are pre-lowercased and split for O(1) startsWith checks.
 */
interface ProcessedItem {
  item: AutocompleteItem;

  /** All searchable words from label, value, group, and aliases - lowercased */
  words: string[];
}

/**
 * Split text into lowercase words for search indexing.
 * Splits on spaces, hyphens, underscores, and other common separators.
 */
function splitIntoWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_,./]+/)
    .filter((w) => w.length > 0);
}

/**
 * Build search index for an item - extract all searchable words.
 */
function processItem(item: AutocompleteItem): ProcessedItem {
  const words: string[] = [];

  // Add words from label
  if (item.label) {
    for (const word of splitIntoWords(item.label)) words.push(word);
  }

  // Add words from value
  for (const word of splitIntoWords(item.value)) words.push(word);

  // Add words from group
  if (item.group) {
    for (const word of splitIntoWords(item.group)) words.push(word);
  }

  // Add words from all searchAliases
  if (item.searchAliases) {
    for (const alias of item.searchAliases) {
      for (const word of splitIntoWords(alias)) words.push(word);
    }
  }

  // Deduplicate words
  return { item, words: [...new Set(words)] };
}

/**
 * CFAutocomplete - Search input with filterable dropdown and optional value binding
 *
 * Supports both single-select and multi-select modes, with bidirectional Cell binding.
 *
 * @element cf-autocomplete
 *
 * @attr {string} placeholder - Placeholder text for the input
 * @attr {number} maxVisible - Maximum items to show in dropdown (default: 8)
 * @attr {boolean} allowCustom - Allow free-form custom values (default: false)
 * @attr {boolean} multiple - Enable multi-select mode (default: false)
 * @attr {boolean} disabled - Whether the component is disabled
 *
 * @prop {CellHandle<AutocompleteItem[]> | AutocompleteItem[]} items - Items to choose from
 * @prop {CellHandle<string>|CellHandle<string[]>|string|string[]} value - Selected value(s) - supports Cell binding
 *
 * @fires cf-change - Fired when value changes: { value, oldValue }
 * @fires cf-select - Fired when an item is selected: { value, label, group?, isCustom, data? }
 *                   Note: Cell refs in `data` become link representations; use Cell.equals() to compare
 * @fires cf-open - Fired when dropdown opens
 * @fires cf-close - Fired when dropdown closes
 *
 * @example Single-select with $value binding
 * const selected = cell<string | undefined>(undefined);
 * <cf-autocomplete
 *   items={relationshipTypes}
 *   $value={selected}
 *   placeholder="Search..."
 * />
 *
 * @example Multi-select with $value binding
 * const selected = cell<string[]>([]);
 * <cf-autocomplete
 *   items={relationshipTypes}
 *   $value={selected}
 *   multiple={true}
 *   placeholder="Search to add..."
 * />
 *
 * @example Event-only API (no value binding)
 * <cf-autocomplete
 *   items={items}
 *   oncf-select={(e) => console.log('Selected:', e.detail)}
 *   placeholder="Search..."
 * />
 */
export class CFAutocomplete extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline-block;
        position: relative;
        width: 100%;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .autocomplete-container {
        position: relative;
        width: 100%;
      }

      /* Input styling - matches cf-input */
      input {
        display: block;
        width: 100%;
        padding: 0.5rem 0.75rem;
        font-size: 0.875rem;
        line-height: 1.25rem;
        color: var(--cf-theme-color-text, #111827);
        background-color: var(--cf-theme-color-background, #ffffff);
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        transition: all var(--cf-theme-animation-duration, 150ms)
          var(--cf-transition-timing-ease);
        font-family: var(--cf-theme-font-family, inherit);
      }

      input::placeholder {
        color: var(--cf-theme-color-text-muted, #6b7280);
      }

      input:hover:not(:disabled):not(:focus) {
        border-color: var(--cf-theme-color-border, #d1d5db);
      }

      input:focus {
        outline: none;
        border-color: var(--cf-theme-color-primary, #3b82f6);
        box-shadow: 0 0 0 3px
          var(--cf-theme-color-primary, rgba(59, 130, 246, 0.15));
      }

      input:disabled {
        cursor: not-allowed;
        opacity: 0.5;
        background-color: var(--cf-theme-color-surface, #f1f5f9);
      }

      /* Dropdown styling - uses fixed positioning to escape overflow:hidden containers */
      .dropdown {
        position: fixed;
        background: var(--cf-theme-color-background, #ffffff);
        border: 1px solid var(--cf-theme-color-border, #e5e7eb);
        border-radius: var(
          --cf-theme-border-radius,
          var(--cf-border-radius-md, 0.375rem)
        );
        box-shadow:
          0 4px 6px -1px rgba(0, 0, 0, 0.1),
          0 2px 4px -1px rgba(0, 0, 0, 0.06);
        max-height: calc(var(--max-visible, 8) * 2.5rem);
        overflow-y: auto;
        z-index: 9999;
      }

      .dropdown.hidden {
        display: none;
      }

      /* Option styling */
      .option {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem 0.75rem;
        cursor: pointer;
        transition: background-color 100ms ease;
      }

      .option:hover {
        background-color: var(--cf-theme-color-surface, #f1f5f9);
      }

      .option.highlighted {
        background-color: var(--cf-theme-color-primary, #3b82f6);
        color: white;
      }

      .option.highlighted .option-group {
        color: rgba(255, 255, 255, 0.7);
      }

      .option-label {
        font-size: 0.875rem;
      }

      .option-group {
        font-size: 0.75rem;
        color: var(--cf-theme-color-text-muted, #6b7280);
        margin-left: 0.5rem;
      }

      /* Custom value option */
      .option.custom {
        border-top: 1px solid var(--cf-theme-color-border, #e5e7eb);
        font-style: italic;
      }

      /* Already selected items (shown at bottom in multi-select) */
      .option.already-selected {
        cursor: pointer;
        opacity: 0.7;
        background-color: var(--cf-theme-color-surface, #f1f5f9);
      }

      .option.already-selected:hover {
        background-color: #fef2f2;
      }

      .option.already-selected.highlighted {
        background-color: #fecaca;
        color: #991b1b;
      }

      .option.already-selected .status-label {
        font-size: 0.75rem;
        font-style: italic;
        color: var(--cf-theme-color-text-muted, #6b7280);
        margin-left: 0.5rem;
      }

      /* Show "Already added" by default, "Remove" when hovered/highlighted */
      .option.already-selected .already-added-text {
        display: inline;
      }
      .option.already-selected .remove-text {
        display: none;
      }

      .option.already-selected:hover .already-added-text,
      .option.already-selected.highlighted .already-added-text {
        display: none;
      }
      .option.already-selected:hover .remove-text,
      .option.already-selected.highlighted .remove-text {
        display: inline;
        color: #dc2626;
      }
      .option.already-selected.highlighted .remove-text {
        color: #991b1b;
      }

      .selected-separator {
        border-top: 1px solid var(--cf-theme-color-border, #e5e7eb);
        margin-top: 0.25rem;
        padding-top: 0.25rem;
      }

      /* Empty state */
      .empty-state {
        padding: 0.75rem;
        text-align: center;
        color: var(--cf-theme-color-text-muted, #6b7280);
        font-size: 0.875rem;
      }
    `,
  ];

  static override properties = {
    items: { attribute: false },
    value: { attribute: false },
    placeholder: { type: String },
    maxVisible: { type: Number },
    allowCustom: { type: Boolean },
    multiple: { type: Boolean },
    disabled: { type: Boolean },
  };

  // Public properties
  declare items: AutocompleteItem[] | CellHandle<AutocompleteItem[]>;
  declare value:
    | CellHandle<string>
    | CellHandle<string[]>
    | string
    | string[]
    | undefined;
  declare placeholder: string;
  declare maxVisible: number;
  declare allowCustom: boolean;
  declare multiple: boolean;
  declare disabled: boolean;

  /**
   * Cell controller for value binding. `requestUpdate()` is not called in
   * `onChange`, since the cell controller already does it.
   */
  private _cellController = createCellController<string | string[]>(this, {
    timing: { strategy: "debounce", delay: 50 },
    onChange: (newValue, oldValue) => {
      this.emit("cf-change", { value: newValue, oldValue });
    },
  });

  /**
   * Cell controller for items binding, which allows reactive items from
   * `lift()`.
   */
  private _itemsCellController = createCellController<AutocompleteItem[]>(
    this,
    {
      timing: { strategy: "immediate" },
    },
  );

  // Internal state
  @state()
  private accessor _isOpen = false;
  @state()
  private accessor _query = "";
  @state()
  private accessor _highlightedIndex = 0;
  @state()
  private accessor _dropdownStyle = "";

  // Cached/memoized filter results - updated in willUpdate, not on every render
  private _cachedFilteredItems: AutocompleteItem[] = [];
  private _cachedAlreadySelectedItems: AutocompleteItem[] = [];
  private _cachedShowCustomOption = false;
  private _lastQuery = "";
  private _lastSelectedValues: Set<string> = new Set();

  // Element references
  private _input: HTMLInputElement | null = null;
  private _dropdown: HTMLElement | null = null;

  /** Pre-processed search index for fast filtering. */
  private _processedItems: ProcessedItem[] = [];

  /** Throttle flag for scroll/resize position updates. */
  private _positionUpdateScheduled = false;

  /**
   * Debounce timer. `setTimeout(0)` defers to the next task, letting the input
   * render first.
   */
  private _debounceTimer: number | null = null;

  constructor() {
    super();
    this.items = [];
    this.value = undefined;
    this.placeholder = "";
    this.maxVisible = 8;
    this.allowCustom = false;
    this.multiple = false;
    this.disabled = false;
  }

  /** The theme, consumed from the provider. */
  @consume({ context: cfThemeContext, subscribe: true })
  @property({ attribute: false })
  accessor theme: CFTheme = defaultTheme;

  override connectedCallback() {
    super.connectedCallback();
    // Listen for clicks outside to close dropdown
    document.addEventListener("click", this._handleOutsideClick);
    // Close dropdown on scroll/resize to avoid mispositioned dropdown
    // Use passive listeners for better scroll performance
    globalThis.addEventListener("scroll", this._handleScrollOrResize, {
      capture: true,
      passive: true,
    });
    globalThis.addEventListener("resize", this._handleScrollOrResize, {
      passive: true,
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._handleOutsideClick);
    globalThis.removeEventListener(
      "scroll",
      this._handleScrollOrResize,
      true,
    );
    globalThis.removeEventListener("resize", this._handleScrollOrResize);

    // Clean up debounce timer
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  /**
   * Handler which throttles scroll/resize updates to `requestAnimationFrame`,
   * to prevent layout thrashing.
   */
  private _handleScrollOrResize = () => {
    if (this._isOpen && !this._positionUpdateScheduled) {
      this._positionUpdateScheduled = true;
      requestAnimationFrame(() => {
        this._updateDropdownPosition();
        this._positionUpdateScheduled = false;
      });
    }
  };

  override firstUpdated() {
    this._input = this.shadowRoot?.querySelector("input") || null;
    this._dropdown = this.shadowRoot?.querySelector(".dropdown") || null;

    // Initialize cell controller bindings with appropriate schemas
    const valueSchema = autocompleteValueSchema(this.multiple);
    this._cellController.bind(
      this.value as CellHandle<string | string[]> | string | string[],
      valueSchema,
    );
    this._itemsCellController.bind(
      this.items as CellHandle<AutocompleteItem[]> | AutocompleteItem[],
      AutocompleteItemArraySchema,
    );

    applyThemeToElement(this, this.theme ?? defaultTheme);
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      const valueSchema = autocompleteValueSchema(this.multiple);
      this._cellController.bind(
        this.value as CellHandle<string | string[]> | string | string[],
        valueSchema,
      );
    }

    // If the items property changed (e.g., switched to a different cell or array)
    if (changedProperties.has("items")) {
      this._itemsCellController.bind(
        this.items as CellHandle<AutocompleteItem[]> | AutocompleteItem[],
        AutocompleteItemArraySchema,
      );
    }

    // Rebuild search index when items change (using resolved value from cell controller)
    // Always rebuild since the cell controller may have received an update
    const resolvedItems = this._itemsCellController.getValue() || [];
    this._processedItems = resolvedItems.map(processItem);

    // Recompute filtered items only when dependencies change
    this._updateFilteredItemsCache();
  }

  /**
   * Recomputes the memoized filter results, only when the inputs actually
   * change or the cache is empty.
   */
  private _updateFilteredItemsCache() {
    const currentSelectedValues = this._getSelectedValuesSet();
    const queryChanged = this._query !== this._lastQuery;
    const selectionChanged = !this._setsEqual(
      currentSelectedValues,
      this._lastSelectedValues,
    );

    if (
      !queryChanged && !selectionChanged &&
      this._cachedFilteredItems.length > 0
    ) {
      return; // No change, use cached values
    }

    this._lastQuery = this._query;
    this._lastSelectedValues = currentSelectedValues;

    // Compute filtered items
    const selectableProcessed = this.multiple
      ? this._processedItems.filter(
        (p) => !currentSelectedValues.has(p.item.value),
      )
      : this._processedItems;

    if (!this._query.trim()) {
      this._cachedFilteredItems = selectableProcessed.map((p) => p.item);
    } else {
      const queryWords = splitIntoWords(this._query);
      if (queryWords.length === 0) {
        this._cachedFilteredItems = selectableProcessed.map((p) => p.item);
      } else {
        this._cachedFilteredItems = selectableProcessed
          .filter((p) => this._processedItemMatchesQuery(p, queryWords))
          .map((p) => p.item);
      }
    }

    // Compute already-selected items
    if (!this.multiple) {
      this._cachedAlreadySelectedItems = [];
    } else {
      const selectedItems = this._processedItems
        .filter((p) => currentSelectedValues.has(p.item.value))
        .map((p) => p.item);

      if (!this._query.trim()) {
        this._cachedAlreadySelectedItems = selectedItems;
      } else {
        const queryWords = splitIntoWords(this._query);
        this._cachedAlreadySelectedItems = selectedItems.filter((item) => {
          const processed = this._processedItems.find(
            (p) => p.item === item,
          );
          return (
            processed &&
            this._processedItemMatchesQuery(processed, queryWords)
          );
        });
      }
    }

    // Compute show custom option
    this._cachedShowCustomOption = this._computeShowCustomOption();
  }

  private _getSelectedValuesSet(): Set<string> {
    if (!this.multiple) return new Set();
    const selected = (this._getCurrentValue() as string[] | undefined) || [];
    return new Set(selected);
  }

  private _setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  private _computeShowCustomOption(): boolean {
    if (!this.allowCustom || !this._query.trim()) {
      return false;
    }

    const queryLower = this._query.toLowerCase();
    const queryTrimmed = this._query.trim();

    const matchesExistingItem = this._resolvedItems.some(
      (item: AutocompleteItem) =>
        item.value.toLowerCase() === queryLower ||
        (item.label || "").toLowerCase() === queryLower,
    );

    if (matchesExistingItem) {
      return false;
    }

    if (this.multiple) {
      const selected = (this._getCurrentValue() as string[] | undefined) ||
        [];
      if (selected.includes(queryTrimmed)) {
        return false;
      }
    }

    return true;
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme ?? defaultTheme);
    }

    // Update dropdown position when opening
    if (changedProperties.has("_isOpen") && this._isOpen) {
      this._updateDropdownPosition();
    }
  }

  /** Returns the current value from the cell controller. */
  private _getCurrentValue(): string | readonly string[] | undefined {
    return this._cellController.getValue();
  }

  /** The resolved items, either from the cell or the direct array. */
  private get _resolvedItems(): readonly AutocompleteItem[] {
    return this._itemsCellController.getValue() || [];
  }

  /** Returns the display label for `value`. */
  private _getLabelForValue(value: string): string {
    const item = this._resolvedItems.find((i) => i.value === value);
    return item?.label || value;
  }

  /** The display value for the input in single-select mode. */
  private get _displayValue(): string {
    // If in multi-select mode, always show the query (user is always searching)
    if (this.multiple) {
      return this._query;
    }

    // In single-select mode:
    // - If user is typing (has query), show the query
    // - Otherwise, show the selected value's label
    if (this._query) {
      return this._query;
    }

    const currentValue = this._getCurrentValue() as string | undefined;
    if (currentValue) {
      return this._getLabelForValue(currentValue);
    }

    return "";
  }

  /**
   * Returns whether a processed item matches the search query. Uses
   * pre-indexed words with `startsWith()` for O(words) instead of
   * O(chars*aliases).
   */
  private _processedItemMatchesQuery(
    processed: ProcessedItem,
    queryWords: string[],
  ): boolean {
    // All query words must match at least one item word (startsWith)
    return queryWords.every((queryWord) =>
      processed.words.some((itemWord) => itemWord.startsWith(queryWord))
    );
  }

  // Memoized getters - return cached values computed in willUpdate
  private get _filteredItems(): AutocompleteItem[] {
    return this._cachedFilteredItems;
  }

  private get _alreadySelectedItems(): AutocompleteItem[] {
    return this._cachedAlreadySelectedItems;
  }

  private get _showCustomOption(): boolean {
    return this._cachedShowCustomOption;
  }

  /** Total selectable items, limited to what is actually rendered. */
  private get _totalSelectableItems(): number {
    const maxRender = this.maxVisible + 4;
    const filteredCount = Math.min(this._filteredItems.length, maxRender);
    return filteredCount +
      (this._showCustomOption ? 1 : 0) +
      this._alreadySelectedItems.length;
  }

  override render() {
    const dropdownClasses = {
      dropdown: true,
      hidden: !this._isOpen,
    };

    return html`
      <div class="autocomplete-container">
        <input
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="${this._isOpen}"
          aria-controls="dropdown"
          aria-activedescendant="${this._isOpen
            ? `option-${this._highlightedIndex}`
            : ""}"
          .value="${this._displayValue}"
          placeholder="${this.placeholder}"
          ?disabled="${this.disabled}"
          @input="${this._handleInput}"
          @focus="${this._handleFocus}"
          @keydown="${this._handleKeyDown}"
          part="input"
        />

        <div
          id="dropdown"
          class="${classMap(dropdownClasses)}"
          role="listbox"
          style="${this._dropdownStyle}; --max-visible: ${this.maxVisible}"
        >
          ${this._renderDropdownContent()}
        </div>
      </div>
    `;
  }

  private _renderDropdownContent() {
    const filtered = this._filteredItems;
    const alreadySelected = this._alreadySelectedItems;

    // Show empty state only if no selectable items, no custom option, AND no already-selected items
    if (
      filtered.length === 0 && !this._showCustomOption &&
      alreadySelected.length === 0
    ) {
      return html`
        <div class="empty-state">No matching options</div>
      `;
    }

    // Limit rendered items to maxVisible + small buffer for performance
    // This avoids rendering 600 DOM nodes when only 8 are visible
    const maxRender = this.maxVisible + 4;
    const filteredToRender = filtered.slice(0, maxRender);

    const options = filteredToRender.map((item, index) => {
      const optionClasses = {
        option: true,
        highlighted: index === this._highlightedIndex,
      };

      return html`
        <div
          id="option-${index}"
          class="${classMap(optionClasses)}"
          role="option"
          aria-selected="${index === this._highlightedIndex}"
          @click="${() => this._selectItem(item)}"
          @mouseenter="${() => this._setHighlight(index)}"
        >
          <span class="option-label">${item.label || item.value}</span>
          ${item.group
            ? html`
              <span class="option-group">${item.group}</span>
            `
            : nothing}
        </div>
      `;
    });

    // Add already-selected items after filtered items (multi-select only)
    // Order: filtered items → already-selected items → custom option
    const alreadySelectedStartIndex = filtered.length;
    if (alreadySelected.length > 0) {
      // Add separator if there are selectable items above
      const needsSeparator = filtered.length > 0;

      alreadySelected.forEach((item, index) => {
        const globalIndex = alreadySelectedStartIndex + index;
        const optionClasses = {
          option: true,
          "already-selected": true,
          "selected-separator": needsSeparator && index === 0,
          highlighted: globalIndex === this._highlightedIndex,
        };

        options.push(html`
          <div
            id="option-${globalIndex}"
            class="${classMap(optionClasses)}"
            role="option"
            aria-selected="${globalIndex === this._highlightedIndex}"
            @click="${() => this._removeItem(item)}"
            @mouseenter="${() => this._setHighlight(globalIndex)}"
          >
            <span class="option-label">${item.label || item.value}</span>
            <span class="status-label">
              <span class="already-added-text">Already added</span>
              <span class="remove-text">Remove</span>
            </span>
          </div>
        `);
      });
    }

    // Add custom value option at the very end
    if (this._showCustomOption) {
      const customIndex = filtered.length + alreadySelected.length;
      const customClasses = {
        option: true,
        custom: true,
        highlighted: customIndex === this._highlightedIndex,
      };

      options.push(html`
        <div
          id="option-${customIndex}"
          class="${classMap(customClasses)}"
          role="option"
          aria-selected="${customIndex === this._highlightedIndex}"
          @click="${this._selectCustomValue}"
          @mouseenter="${() => this._setHighlight(customIndex)}"
        >
          <span class="option-label">Add "${this._query}"</span>
        </div>
      `);
    }

    return options;
  }

  // Event handlers
  //
  // PERFORMANCE NOTE (Dec 2025):
  //
  // We use setTimeout(0) here instead of synchronous state updates. This was extensively
  // investigated and verified:
  //
  // 1. VERIFIED: Typing does NOT trigger pattern/cell recomputation - filtering is purely
  //    internal Lit state (_query). Console instrumentation confirmed no framework overhead.
  //
  // 2. WHY setTimeout(0) FEELS FASTER than synchronous updates:
  //    - Synchronous: Lit queues microtasks → blocks rendering → user sees lag
  //    - setTimeout(0): Returns immediately → browser paints keystroke → dropdown updates next frame
  //    The browser event loop order is: Task → Microtasks → Render → Next Task
  //    By deferring to the next task, we let the browser paint the input first.
  //
  // 3. clearTimeout prevents "flashing" when typing quickly by canceling stale updates.
  //
  // See commit history for detailed performance investigation with Oracle agents.
  //
  private _handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const newValue = input.value;

    // Clear pending update to prevent stale renders (no flashing)
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }

    // Defer state updates to next task, allowing input to render immediately
    this._debounceTimer = setTimeout(() => {
      if (!this._isOpen && newValue) {
        this._isOpen = true;
        this.emit("cf-open", {});
      }
      this._query = newValue;
      this._highlightedIndex = 0;
      this._debounceTimer = null;
    }, 0) as unknown as number;
  }

  private _handleFocus() {
    // In single-select mode with a selected value, select all text so user can easily replace
    if (!this.multiple && this._displayValue && this._input) {
      // Copy the selected label to query so user can modify it
      this._query = this._displayValue;
      // Select all text after render
      requestAnimationFrame(() => {
        this._input?.select();
      });
    }

    if (!this._isOpen) {
      this._open();
    }
  }

  private _handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!this._isOpen) {
          this._open();
        } else {
          this._moveHighlight(1);
        }
        break;

      case "ArrowUp":
        e.preventDefault();
        if (this._isOpen) {
          this._moveHighlight(-1);
        }
        break;

      case "Enter":
        if (this._isOpen) {
          e.preventDefault();
          this._selectHighlighted();
        }
        // If dropdown is closed, don't prevent default - allow form submission
        break;

      case "Escape":
        e.preventDefault();
        this._close();
        break;

      case "Backspace":
        // In single-select mode, if input is empty (showing selected label),
        // clear the selection
        if (!this.multiple && !this._query) {
          const currentValue = this._getCurrentValue();
          if (currentValue) {
            e.preventDefault();
            this._cellController.setValue("");
            this._query = "";
          }
        }
        break;

      case "Tab":
        this._close();
        break;
    }
  }

  private _handleOutsideClick = (e: MouseEvent) => {
    if (!this._isOpen) return;

    const path = e.composedPath();
    if (!path.includes(this)) {
      this._close();
    }
  };

  //
  // Selection methods
  //

  private _selectItem(item: AutocompleteItem) {
    // Always emit cf-select for side effects
    // Include data field if present (allows passing arbitrary objects through selection)
    this.emit("cf-select", {
      value: item.value,
      label: item.label || item.value,
      group: item.group,
      isCustom: false,
      ...(item.data !== undefined && { data: item.data }),
    });

    // Update value through cell controller
    if (this.multiple) {
      // Add to array
      const current =
        (this._getCurrentValue() as readonly string[] | undefined) || [];
      if (!current.includes(item.value)) {
        // Computed from what the cell holds, so made from the worker's
        // answer where the cell has read nothing yet.
        void this._cellController.updateValue((held) => [
          ...(typeof held === "string" ? [] : held),
          item.value,
        ]);
      }
    } else {
      // Replace single value
      this._cellController.setValue(item.value);
    }

    // Clear query for multi, keep empty for single (user can see there's no selection displayed)
    this._query = "";
    this._close();
  }

  private _selectCustomValue() {
    if (!this._query.trim()) return;

    const customValue = this._query.trim();

    // Always emit cf-select for side effects
    this.emit("cf-select", {
      value: customValue,
      label: customValue,
      isCustom: true,
    });

    // Update value through cell controller
    if (this.multiple) {
      // Add to array
      const current =
        (this._getCurrentValue() as readonly string[] | undefined) || [];
      if (!current.includes(customValue)) {
        // Computed from what the cell holds, so made from the worker's
        // answer where the cell has read nothing yet.
        void this._cellController.updateValue((held) => [
          ...(typeof held === "string" ? [] : held),
          customValue,
        ]);
      }
    } else {
      // Replace single value
      this._cellController.setValue(customValue);
    }

    this._query = "";
    this._close();
  }

  private _selectHighlighted() {
    const filtered = this._filteredItems;
    const alreadySelected = this._alreadySelectedItems;
    // Limit to rendered items
    const maxRender = this.maxVisible + 4;
    const renderedFilteredCount = Math.min(filtered.length, maxRender);
    // Order: filtered items → already-selected items → custom option
    const alreadySelectedStartIndex = renderedFilteredCount;
    const customOptionIndex = renderedFilteredCount + alreadySelected.length;

    if (this._highlightedIndex < renderedFilteredCount) {
      // Regular selectable item
      this._selectItem(filtered[this._highlightedIndex]);
    } else if (
      this._highlightedIndex >= alreadySelectedStartIndex &&
      this._highlightedIndex < customOptionIndex
    ) {
      // Already-selected item - remove it
      const alreadySelectedIndex = this._highlightedIndex -
        alreadySelectedStartIndex;
      this._removeItem(alreadySelected[alreadySelectedIndex]);
    } else if (
      this._showCustomOption && this._highlightedIndex === customOptionIndex
    ) {
      // Custom value option (at the end)
      this._selectCustomValue();
    }
  }

  /** Removes an item from the selected values (multi-select only). */
  private _removeItem(item: AutocompleteItem) {
    if (!this.multiple) return;

    const current =
      (this._getCurrentValue() as readonly string[] | undefined) || [];
    const newValue = current.filter((v) => v !== item.value);
    this._cellController.setValue(newValue);

    // Don't close - user might want to remove more or add new ones
    this._query = "";
  }

  // Highlight navigation
  private _setHighlight(index: number) {
    this._highlightedIndex = index;
  }

  private _moveHighlight(delta: number) {
    const total = this._totalSelectableItems;
    if (total === 0) return;

    this._highlightedIndex = (this._highlightedIndex + delta + total) % total;

    // Scroll the highlighted option into view
    this._scrollHighlightedIntoView();
  }

  private _scrollHighlightedIntoView() {
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      const option = this.shadowRoot?.querySelector(
        `#option-${this._highlightedIndex}`,
      );
      if (option) {
        option.scrollIntoView({ block: "nearest", behavior: "auto" });
      }
    });
  }

  // Open/close methods
  private _open() {
    if (this.disabled) return;

    this._isOpen = true;
    this._highlightedIndex = 0;
    this.emit("cf-open", {});
  }

  private _close() {
    this._isOpen = false;
    // Clear query so display reverts to selected value (in single mode)
    // or empty (in multi mode)
    this._query = "";
    this.emit("cf-close", {});
  }

  /** Updates the dropdown's position. */
  private _updateDropdownPosition() {
    if (!this._input) return;

    const inputRect = this._input.getBoundingClientRect();
    const viewportHeight = globalThis.innerHeight;
    const dropdownHeight = Math.min(
      this._totalSelectableItems * 40,
      this.maxVisible * 40,
    );

    const spaceBelow = viewportHeight - inputRect.bottom;
    const spaceAbove = inputRect.top;

    // Calculate fixed position coordinates
    const left = inputRect.left;
    const width = inputRect.width;

    // Position above if not enough space below but enough above
    let top: number;
    if (spaceBelow < dropdownHeight && spaceAbove > dropdownHeight) {
      // Position above the input
      top = inputRect.top - dropdownHeight - 4;
    } else {
      // Position below the input
      top = inputRect.bottom + 4;
    }

    this._dropdownStyle = `top: ${top}px; left: ${left}px; width: ${width}px`;
  }

  //
  // Public API
  //

  override focus(): void {
    this._input?.focus();
  }

  override blur(): void {
    this._input?.blur();
    this._close();
  }

  /** Clear the current query */
  clear(): void {
    this._query = "";
    this._close();
  }
}
