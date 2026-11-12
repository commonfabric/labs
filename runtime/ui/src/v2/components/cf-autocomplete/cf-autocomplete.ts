import type { Schema } from "@commonfabric/api/schema";
import {
  AutocompleteItemArraySchema,
  autocompleteValueSchema,
} from "@commonfabric/runner/component-read-contract";
import type { CellHandle } from "@commonfabric/runtime-client";
import { css, html, nothing, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { createRef, ref } from "lit/directives/ref.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { applyThemeToElement, type CFTheme } from "../theme-context.ts";

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

/** An item with the words a query is matched against, lowercased. */
interface IndexedItem {
  item: AutocompleteItem;

  /** The words of the item's label, value, group, and search aliases. */
  words: string[];
}

/**
 * What choosing a dropdown option does: add its item, remove its item (one a
 * multi-select already holds), or add the query as a custom value, which its
 * item holds.
 */
interface AutocompleteOption {
  kind: "add" | "remove" | "custom";
  item: AutocompleteItem;
}

/**
 * Splits text into lowercase words, at spaces, hyphens, underscores, commas,
 * periods, and slashes.
 */
function splitIntoWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_,./]+/)
    .filter((w) => w.length > 0);
}

/** Returns `item` with the words a query is matched against. */
function indexItem(item: AutocompleteItem): IndexedItem {
  const texts = [
    item.label ?? "",
    item.value,
    item.group ?? "",
    ...(item.searchAliases ?? []),
  ];
  return { item, words: [...new Set(texts.flatMap(splitIntoWords))] };
}

/**
 * The options a dropdown lists for `query`, in order: the matching items not
 * yet selected, at most `maxVisible + 4` of them; then the matching items
 * already selected; then, where `allowCustom` is set and the query names no
 * item and no selected value, the query itself as a custom value. An item
 * matches when each word of the query begins one of its words, so an empty
 * query matches every item.
 */
function optionsFor(
  items: readonly IndexedItem[],
  { query, selected, allowCustom, maxVisible }: {
    query: string;
    selected: readonly string[];
    allowCustom: boolean;
    maxVisible: number;
  },
): AutocompleteOption[] {
  const queryWords = splitIntoWords(query);
  const matching = items
    .filter(({ words }) =>
      queryWords.every((queryWord) =>
        words.some((word) => word.startsWith(queryWord))
      )
    )
    .map(({ item }) => item);
  const isSelected = (item: AutocompleteItem) => selected.includes(item.value);
  const options: AutocompleteOption[] = [
    ...matching
      .filter((item) => !isSelected(item))
      .slice(0, maxVisible + 4)
      .map((item): AutocompleteOption => ({ kind: "add", item })),
    ...matching
      .filter(isSelected)
      .map((item): AutocompleteOption => ({ kind: "remove", item })),
  ];
  const custom = query.trim();
  const lower = custom.toLowerCase();
  if (
    allowCustom && custom !== "" && !selected.includes(custom) &&
    !items.some(({ item }) =>
      item.value.toLowerCase() === lower || item.label?.toLowerCase() === lower
    )
  ) {
    options.push({ kind: "custom", item: { value: custom } });
  }
  return options;
}

/**
 * The values a multi-select's cell holds: none where it holds no list, as
 * a cell that holds nothing does.
 */
function selectedOf(
  held: Readonly<string | string[]> | undefined,
): string[] {
  return typeof held === "object" && held !== null ? [...held] : [];
}

/** `held`'s values with `value` among them, once. */
function withSelected(
  held: Readonly<string | string[]> | undefined,
  value: string,
): string[] {
  const selected = selectedOf(held);
  return selected.includes(value) ? selected : [...selected, value];
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
  #cellController = createCellController<string | string[]>(this, {
    timing: { strategy: "debounce", delay: 50 },
    onChange: (newValue, oldValue) => {
      this.emit("cf-change", { value: newValue, oldValue });
    },
  });

  /**
   * Cell controller for items binding, which allows reactive items from
   * `lift()`.
   */
  #itemsCellController = createCellController<AutocompleteItem[]>(this, {
    timing: { strategy: "immediate" },
  });

  @state()
  accessor #isOpen = false;
  @state()
  accessor #query = "";
  @state()
  accessor #highlightedIndex = 0;
  @state()
  accessor #dropdownStyle = "";

  /**
   * The options the dropdown lists, in order, computed afresh on each update
   * from the query, the items, and the selected values.
   */
  #options: readonly AutocompleteOption[] = [];

  #input = createRef<HTMLInputElement>();

  /** Whether a position update is waiting on the next animation frame. */
  #positionUpdateScheduled = false;

  /** The timer of the state update an input waits on, if any. */
  #inputTimer: ReturnType<typeof setTimeout> | undefined;

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

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("click", this.#handleOutsideClick);
    // Scrolling or resizing moves the input, so the dropdown follows it.
    globalThis.addEventListener("scroll", this.#handleScrollOrResize, {
      capture: true,
      passive: true,
    });
    globalThis.addEventListener("resize", this.#handleScrollOrResize, {
      passive: true,
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this.#handleOutsideClick);
    globalThis.removeEventListener(
      "scroll",
      this.#handleScrollOrResize,
      true,
    );
    globalThis.removeEventListener("resize", this.#handleScrollOrResize);
    clearTimeout(this.#inputTimer);
    this.#inputTimer = undefined;
  }

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);

    if (changedProperties.has("value")) {
      this.#cellController.bind(
        this.value as CellHandle<string | string[]> | string | string[],
        autocompleteValueSchema(this.multiple),
      );
    }
    if (changedProperties.has("items")) {
      this.#itemsCellController.bind(this.items, AutocompleteItemArraySchema);
    }

    this.#options = optionsFor(this.#items.map(indexItem), {
      query: this.#query,
      selected: this.multiple
        ? selectedOf(this.#cellController.getValue())
        : [],
      allowCustom: this.allowCustom,
      maxVisible: this.maxVisible,
    });
    // Options can go away without the query changing, as when a bound cell's
    // items change; the highlight then stays on the last one left.
    this.#highlightedIndex = Math.max(
      0,
      Math.min(this.#highlightedIndex, this.#options.length - 1),
    );
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
    }
    if (changedProperties.has("#isOpen") && this.#isOpen) {
      this.#updateDropdownPosition();
    }
  }

  override render() {
    return html`
      <div class="autocomplete-container">
        <input
          ${ref(this.#input)}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="${this.#isOpen}"
          aria-controls="dropdown"
          aria-activedescendant="${this.#isOpen && this.#options.length > 0
            ? `option-${this.#highlightedIndex}`
            : nothing}"
          .value="${this.#displayValue}"
          placeholder="${this.placeholder}"
          ?disabled="${this.disabled}"
          @input="${this.#handleInput}"
          @focus="${this.#handleFocus}"
          @keydown="${this.#handleKeyDown}"
          part="input"
        />

        <div
          id="dropdown"
          class="${classMap({ dropdown: true, hidden: !this.#isOpen })}"
          role="listbox"
          style="${this.#dropdownStyle}; --max-visible: ${this.maxVisible}"
        >
          ${this.#options.length === 0
            ? html`
              <div class="empty-state">No matching options</div>
            `
            : this.#options.map((option, index) =>
              this.#renderOption(option, index)
            )}
        </div>
      </div>
    `;
  }

  override focus(): void {
    this.#input.value?.focus();
  }

  override blur(): void {
    this.#input.value?.blur();
    this.#close();
  }

  /** Clear the current query */
  clear(): void {
    this.#query = "";
    this.#close();
  }

  /** The resolved items, either from the cell or the direct array. */
  get #items(): readonly AutocompleteItem[] {
    return this.#itemsCellController.getValue() || [];
  }

  /**
   * What the input shows: the query, or in a single-select with no query,
   * the selected value's label.
   */
  get #displayValue(): string {
    if (this.multiple || this.#query) return this.#query;
    const value = this.#cellController.getValue();
    if (typeof value !== "string") return "";
    return this.#items.find((item) => item.value === value)?.label || value;
  }

  #renderOption(option: AutocompleteOption, index: number) {
    const { kind, item } = option;
    const highlighted = index === this.#highlightedIndex;
    const classes = {
      option: true,
      "already-selected": kind === "remove",
      "selected-separator": kind === "remove" &&
        this.#options[index - 1]?.kind === "add",
      custom: kind === "custom",
      highlighted,
    };
    return html`
      <div
        id="option-${index}"
        class="${classMap(classes)}"
        role="option"
        aria-selected="${highlighted}"
        @click="${() => this.#choose(option)}"
        @mouseenter="${() => this.#highlightedIndex = index}"
      >
        <span class="option-label">${kind === "custom"
          ? `Add "${item.value}"`
          : item.label || item.value}</span>
        ${kind === "add" && item.group
          ? html`
            <span class="option-group">${item.group}</span>
          `
          : nothing}
        ${kind === "remove"
          ? html`
            <span class="status-label">
              <span class="already-added-text">Already added</span>
              <span class="remove-text">Remove</span>
            </span>
          `
          : nothing}
      </div>
    `;
  }

  /**
   * Takes the input's text as the query. The state update waits on a
   * `setTimeout(0)`, so the browser paints the keystroke before the dropdown
   * renders, and a keystroke cancels the update of the one before it.
   */
  #handleInput() {
    const query = this.#input.value?.value ?? "";
    clearTimeout(this.#inputTimer);
    this.#inputTimer = setTimeout(() => {
      this.#inputTimer = undefined;
      if (!this.#isOpen && query) this.#open();
      this.#query = query;
      this.#highlightedIndex = 0;
    }, 0);
  }

  #handleFocus() {
    // A single-select's selected label becomes the query, selected in full
    // once it has rendered, so typing replaces it.
    if (!this.multiple && this.#displayValue) {
      this.#query = this.#displayValue;
      requestAnimationFrame(() => this.#input.value?.select());
    }
    if (!this.#isOpen) this.#open();
  }

  #handleKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (this.#isOpen) this.#moveHighlight(1);
        else this.#open();
        break;

      case "ArrowUp":
        event.preventDefault();
        if (this.#isOpen) this.#moveHighlight(-1);
        break;

      case "Enter": {
        // A closed dropdown leaves Enter to submit the form.
        if (!this.#isOpen) break;
        event.preventDefault();
        const option = this.#options[this.#highlightedIndex];
        if (option) this.#choose(option);
        break;
      }

      case "Escape":
        // A closed dropdown leaves Escape to whatever encloses it.
        if (!this.#isOpen) break;
        event.preventDefault();
        this.#close();
        break;

      case "Backspace":
        // In a single-select with no query, the input shows the selected
        // label, and Backspace clears the selection.
        if (
          !this.multiple && !this.#query && this.#cellController.getValue()
        ) {
          event.preventDefault();
          this.#cellController.setValue("");
        }
        break;

      case "Tab":
        this.#close();
        break;
    }
  }

  #handleOutsideClick = (event: MouseEvent) => {
    if (this.#isOpen && !event.composedPath().includes(this)) this.#close();
  };

  /** Repositions the dropdown at most once an animation frame. */
  #handleScrollOrResize = () => {
    if (this.#isOpen && !this.#positionUpdateScheduled) {
      this.#positionUpdateScheduled = true;
      requestAnimationFrame(() => {
        this.#updateDropdownPosition();
        this.#positionUpdateScheduled = false;
      });
    }
  };

  #choose({ kind, item }: AutocompleteOption) {
    if (kind === "remove") {
      void this.#cellController.updateValue((held) =>
        selectedOf(held).filter((value) => value !== item.value)
      );
      // The dropdown stays open, for removing or adding more.
      this.#query = "";
      return;
    }

    // Cell references in `data` reach listeners as links; see
    // `AutocompleteItem.data`.
    this.emit(
      "cf-select",
      kind === "custom"
        ? { value: item.value, label: item.value, isCustom: true }
        : {
          value: item.value,
          label: item.label || item.value,
          group: item.group,
          isCustom: false,
          ...(item.data !== undefined && { data: item.data }),
        },
    );

    if (this.multiple) {
      // Add to array: computed from what the cell holds, so made from the
      // worker's answer where the cell has read nothing yet, which may
      // already hold it, in which case nothing is written.
      void this.#cellController.updateValue((held) =>
        withSelected(held, item.value)
      );
    } else {
      this.#cellController.setValue(item.value);
    }
    this.#close();
  }

  #moveHighlight(delta: number) {
    const total = this.#options.length;
    if (total === 0) return;
    this.#highlightedIndex = (this.#highlightedIndex + delta + total) % total;

    // Scrolled into view once the highlight has rendered.
    requestAnimationFrame(() => {
      this.shadowRoot?.querySelector(`#option-${this.#highlightedIndex}`)
        ?.scrollIntoView({ block: "nearest", behavior: "auto" });
    });
  }

  #open() {
    if (this.disabled) return;
    this.#isOpen = true;
    this.#highlightedIndex = 0;
    this.emit("cf-open", {});
  }

  /**
   * Closes the dropdown, and clears the query, so that the input shows the
   * selected label in a single-select and nothing in a multi-select.
   */
  #close() {
    // Text typed just before closing must not reopen the dropdown.
    clearTimeout(this.#inputTimer);
    this.#inputTimer = undefined;
    this.#isOpen = false;
    this.#query = "";
    this.emit("cf-close", {});
  }

  /**
   * Places the dropdown under the input, or above it where there is room
   * above and not below.
   */
  #updateDropdownPosition() {
    const rect = this.#input.value?.getBoundingClientRect();
    if (rect === undefined) return;
    const height = Math.min(this.#options.length, this.maxVisible) * 40;
    const above = globalThis.innerHeight - rect.bottom < height &&
      rect.top > height;
    const top = above ? rect.top - height - 4 : rect.bottom + 4;
    this.#dropdownStyle =
      `top: ${top}px; left: ${rect.left}px; width: ${rect.width}px`;
  }
}
