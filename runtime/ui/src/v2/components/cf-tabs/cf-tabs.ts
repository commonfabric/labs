import { css, html } from "lit";
import type { CellHandle } from "@commonfabric/runtime-client";
import { stringSchema } from "@commonfabric/runner/schemas";
import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import type { CFTab } from "../cf-tab/cf-tab.ts";
import type { CFTabList } from "../cf-tab-list/cf-tab-list.ts";
import type { CFTabPanel } from "../cf-tab-panel/cf-tab-panel.ts";

/**
 * CFTabs - Container component that manages tab navigation and content panels
 *
 * @element cf-tabs
 *
 * @attr {string} value - Currently selected tab value (plain string)
 * @prop {CellHandle<string>|string} value - Selected tab value (supports Cell for two-way binding)
 * @attr {string} orientation - Tab orientation: "horizontal" | "vertical" (default: "horizontal")
 *
 * @slot - Default slot for cf-tab-list and cf-tab-panel elements
 *
 * @fires cf-change - Fired ONLY for user-initiated tab changes (click or
 *   keyboard navigation), with detail: { value, oldValue }. It is intentionally
 *   NOT fired for programmatic / cell-driven changes to the bound value — a
 *   bound $value cell updated elsewhere syncs the selection visually without
 *   re-emitting cf-change. This lets a consumer write the bound cell from an
 *   oncf-change handler without forming a feedback loop.
 *
 * @example Plain string value
 * <cf-tabs value="tab1">
 *   <cf-tab-list>
 *     <cf-tab value="tab1">Tab 1</cf-tab>
 *     <cf-tab value="tab2">Tab 2</cf-tab>
 *   </cf-tab-list>
 *   <cf-tab-panel value="tab1">Content 1</cf-tab-panel>
 *   <cf-tab-panel value="tab2">Content 2</cf-tab-panel>
 * </cf-tabs>
 *
 * @example With Cell binding ($value for two-way binding)
 * const activeTab = cell("tab1");
 * <cf-tabs $value={activeTab}>
 *   ...
 * </cf-tabs>
 */
export class CFTabs extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: var(--cf-tabs-width, 100%);
        max-width: 100%;
        min-width: 0;
        min-height: 0;
        flex: var(--cf-tabs-flex, 1);
      }

      .tabs {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        flex: 1;
        min-height: 0;
      }

      .tabs[data-orientation="horizontal"] {
        flex-direction: column;
      }

      .tabs[data-orientation="vertical"] {
        flex-direction: row;
      }

      /* Ensure proper layout for slotted content */
      ::slotted(cf-tab-list) {
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
      }

      ::slotted(cf-tab-panel) {
        flex: 1;
      }

      /* Handle vertical orientation */
      .tabs[data-orientation="vertical"] ::slotted(cf-tab-list) {
        flex-direction: column;
        height: 100%;
      }

      /* Ensure panels are properly hidden */
      ::slotted(cf-tab-panel[hidden]) {
        display: none !important;
      }
    `,
  ];

  static override properties = {
    value: { attribute: false }, // Cell or string, not reflected as attribute
    orientation: { type: String },
  };

  declare value: CellHandle<string> | string;
  declare orientation: "horizontal" | "vertical";

  /**
   * The value a user click or a cell delivery last brought, or the bound
   * value. A click under a plain value has no cell to write, so the bound
   * value lags it until the page passes the new value back.
   */
  private _lastKnownValue: string = "";

  /** The bound value as the last update that synced the selection found it. */
  private _boundValue: string = "";

  /** Cell controller for value binding */
  private _cellController = createStringCellController(this, {
    timing: { strategy: "immediate" }, // Tab changes should be immediate
    onChange: (newValue: string, _oldValue: string) => {
      // This callback fires for BOTH user-initiated writes (via setValue from a
      // tab click / keyboard nav) and cell-driven/programmatic changes (the
      // CellHandle subscription firing when the bound cell changes elsewhere).
      //
      // We must NOT emit "cf-change" here. Emitting on every cell change makes
      // cf-change indistinguishable from a user gesture, so any oncf-change
      // handler that writes the bound cell forms an unbreakable feedback loop
      // (cell write -> onChange -> cf-change -> handler -> cell write -> ...),
      // which the scheduler reports as non-settling (CT-1745, CT-1746).
      //
      // "cf-change" is emitted only from handleTabClick, through
      // emitUserChange, which a tab click reaches directly and a navigation
      // key reaches by clicking the next tab's button. Here we just keep the
      // visual selection in sync with the cell.
      //
      // Sync from the DELIVERED value, not a getValue() re-read: with a PLAIN
      // string binding there is no backing store for a user click's setValue
      // to write, so getValue() still returns the stale bound literal here.
      this._lastKnownValue = newValue;
      this.updateTabSelection();
    },
  });

  constructor() {
    super();
    this.value = "";
    this.orientation = "horizontal";
  }

  override connectedCallback() {
    super.connectedCallback();

    // Set ARIA attributes
    this.setAttribute("role", "tablist");

    // Add event listeners
    this.addEventListener("tab-click", this.handleTabClick);
    this.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("tab-click", this.handleTabClick);
    this.removeEventListener("keydown", this.handleKeydown);
  }

  override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ) {
    super.willUpdate(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      this._cellController.bind(this.value, stringSchema);
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    const boundValue = this._cellController.getValue();
    // A new `value` from the page always re-syncs, since the page may have
    // re-created the tabs unselected while passing back the value a click
    // already showed. Any other update re-syncs only when the bound value
    // itself moved, so a click the page has not passed back yet stands.
    if (changedProperties.has("value") || boundValue !== this._boundValue) {
      this._boundValue = boundValue;
      this._lastKnownValue = boundValue;
      this.updateTabSelection();
    }
  }

  override render() {
    return html`
      <div class="tabs" part="tabs" data-orientation="${this.orientation}">
        <slot @slotchange="${this.handleSlotChange}"></slot>
      </div>
    `;
  }

  private getTabs(): NodeListOf<CFTab> {
    return this.querySelectorAll("cf-tab");
  }

  private getTabPanels(): NodeListOf<CFTabPanel> {
    return this.querySelectorAll("cf-tab-panel");
  }

  /**
   * Syncs the tabs and panels to the last known value: the one a user click
   * or a cell delivery last brought, or the bound value.
   */
  private updateTabSelection(): void {
    const tabs = this.getTabs();
    const panels = this.getTabPanels();
    const currentValue = this._lastKnownValue;

    // Decide which value the selection should reflect.
    //
    // An empty / undefined value means the bound cell either hasn't delivered
    // its value yet (the durable `$value` mount transient — getValue() coerces
    // the not-yet-synced value to "") OR was explicitly cleared. In NEITHER
    // case do we snap to the first tab: doing so makes the selection briefly
    // show the FIRST tab and then jump to the real value once the cell resolves
    // — the "flickers between two tabs" on every (re)mount. We leave
    // effectiveValue empty, so the apply loop below matches no tab and thus
    // deselects every tab / hides every panel. On a fresh mount nothing was
    // selected, so that is a no-op and the real value re-syncs a beat later via
    // the controller's onChange; on an explicit clear it correctly drops the
    // (now stale) prior selection rather than leaving it stuck.
    //
    // A NON-empty value that matches no tab is a genuinely stale/invalid
    // selection: fall back to the first enabled tab — but VISUALLY ONLY. We
    // must NOT write the cell from here. cf-tabs is bound through `$value` and
    // may be instantiated inside a render `computed()` that reads the same
    // cell; writing the cell during mount/selection-sync would re-trigger that
    // computed, re-mount cf-tabs, and write again — a non-settling scheduler
    // loop (the CT-1677 settle class). So selection-sync stays a
    // pure read: the cell is committed only on a genuine user gesture, by
    // handleTabClick through emitUserChange (a navigation key clicks the next
    // tab's button, which reaches handleTabClick the same way). This mirrors
    // cf-input, which writes only on input events and never on bind. A consumer
    // that needs the cell to carry a default should initialize it (e.g.
    // `Writable.of("active")`).
    const isEmpty = currentValue === undefined || currentValue === "";
    const tabValues = Array.from(tabs, (tab) => tab.value);
    let effectiveValue = currentValue;
    if (!isEmpty && !tabValues.includes(currentValue) && tabs.length > 0) {
      const firstEnabled = Array.from(tabs).find((tab) => !tab.disabled);
      if (firstEnabled) effectiveValue = firstEnabled.value;
    }

    // Update tabs - use property access instead of getAttribute
    // because JSX sets properties, not attributes
    tabs.forEach((tab) => {
      if (tab.value === effectiveValue) {
        tab.setAttribute("aria-selected", "true");
        tab.setAttribute("data-selected", "true");
        tab.selected = true;
      } else {
        tab.setAttribute("aria-selected", "false");
        tab.removeAttribute("data-selected");
        tab.selected = false;
      }
    });

    // Update panels - use property access instead of getAttribute
    // because JSX sets properties, not attributes
    panels.forEach((panel) => {
      if (panel.value === effectiveValue) {
        panel.removeAttribute("hidden");
        panel.setAttribute("data-selected", "true");
        panel.hidden = false;
      } else {
        panel.setAttribute("hidden", "");
        panel.removeAttribute("data-selected");
        panel.hidden = true;
      }
    });
  }

  private handleSlotChange = () => {
    // Set up listener on cf-tab-list's internal slot when it appears.
    // cf-tab elements are nested inside cf-tab-list (not direct children of cf-tabs),
    // so we need to listen to the inner slot to detect when tabs are added.
    this.setupTabListSlotListener();

    this.updateTabSelection();
  };

  /**
   * The `cf-tab-list` element whose internal slot currently carries our
   * `slotchange` listener. Tracked by _element_ (not a one-shot boolean): a
   * VDOM consumer that re-renders its tab list _re-creates_ the `cf-tab-list`
   * element, and a listener left on the discarded element observes nothing —
   * `cf-tabs` then never hears about the replacement tabs.
   */
  private _tabListWithSlotListener: CFTabList | null = null;

  /**
   * Sets up a slotchange listener on cf-tab-list's internal slot.
   * This is necessary because cf-tab elements are slotted into cf-tab-list,
   * not directly into cf-tabs. Without this listener, we wouldn't know when
   * tabs are actually added to the DOM.
   */
  private setupTabListSlotListener(): void {
    const tabList = this.querySelector("cf-tab-list");
    if (!tabList || tabList === this._tabListWithSlotListener) return;

    // Wait for cf-tab-list to have its shadow DOM ready
    const tabListSlot = tabList.shadowRoot?.querySelector("slot");
    if (!tabListSlot) {
      // cf-tab-list hasn't rendered yet, retry after it updates
      tabList.updateComplete.then(() => {
        this.setupTabListSlotListener();
      });
      return;
    }

    this._tabListWithSlotListener = tabList;

    tabListSlot.addEventListener("slotchange", () => {
      this.updateTabSelection();
    });

    // Check if tabs are already present (slotchange may have already fired)
    if (tabListSlot.assignedElements().length > 0) {
      this.updateTabSelection();
    }
  }

  private handleTabClick = (event: CustomEvent<{ tab: CFTab }>) => {
    const { tab } = event.detail;

    // Use property access instead of getAttribute because JSX sets properties
    if (tab && tab.value && !tab.disabled) {
      const currentValue = this._lastKnownValue;

      if (currentValue !== tab.value) {
        // User-initiated change: write the value through to the bound cell
        // (this propagates to a pattern Writable on the $value binding) and
        // emit cf-change. Emitting here — only on the user-gesture path —
        // rather than from the controller's onChange is what prevents the
        // cell-echo feedback loop (see _cellController.onChange above).
        this.emitUserChange(tab.value, currentValue);
      }
    }
  };

  /**
   * Apply a user-initiated tab selection: write the value to the bound cell
   * and emit exactly one cf-change event. This is the ONLY place cf-change is
   * emitted, so cf-change always corresponds to a genuine user gesture and
   * never to a cell-driven/programmatic update.
   */
  private emitUserChange(newValue: string, oldValue: string): void {
    // Write through to the bound cell/pattern Writable. This is the load-bearing
    // propagation that lets a consumer bind $value alone (no oncf-change) and
    // still have the selection switch on click.
    this._cellController.setValue(newValue);
    this.emit("cf-change", { value: newValue, oldValue });
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    // Only handle keyboard navigation when focus is on a tab
    const tabs = Array.from(this.getTabs());
    const target = tabs.find((tab) => tab === event.target);
    if (!target) return;

    // Use property access instead of getAttribute because JSX sets properties
    const enabledTabs = tabs.filter((tab) => !tab.disabled);

    if (enabledTabs.length === 0) return;

    const currentIndex = enabledTabs.indexOf(target);
    let nextIndex = currentIndex;

    const isHorizontal = this.orientation === "horizontal";
    const nextKey = isHorizontal ? "ArrowRight" : "ArrowDown";
    const prevKey = isHorizontal ? "ArrowLeft" : "ArrowUp";

    switch (event.key) {
      case nextKey:
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? 0
          : (currentIndex + 1) % enabledTabs.length;
        break;
      case prevKey:
        event.preventDefault();
        nextIndex = currentIndex === -1
          ? enabledTabs.length - 1
          : (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
        break;
      case "Home":
        event.preventDefault();
        nextIndex = 0;
        break;
      case "End":
        event.preventDefault();
        nextIndex = enabledTabs.length - 1;
        break;
      default:
        return;
    }

    // Focus the next tab, and click it to select it
    const nextTab = enabledTabs[nextIndex];
    nextTab.focus();
    nextTab.button?.click();
  };

  /**
   * Get the currently selected tab value
   */
  getValue(): string {
    return this._cellController.getValue();
  }

  /**
   * Set the selected tab by value
   */
  setValue(value: string): void {
    this._cellController.setValue(value);
  }

  /**
   * Select the first tab
   */
  selectFirst(): void {
    // Use property access instead of getAttribute because JSX sets properties
    const firstEnabledTab = Array.from(this.getTabs()).find((tab) =>
      !tab.disabled
    );

    if (firstEnabledTab?.value) {
      this._cellController.setValue(firstEnabledTab.value);
    }
  }

  /**
   * Select the last tab
   */
  selectLast(): void {
    // Use property access instead of getAttribute because JSX sets properties
    const enabledTabs = Array.from(this.getTabs()).filter((tab) =>
      !tab.disabled
    );
    const lastTab = enabledTabs[enabledTabs.length - 1];
    if (lastTab?.value) {
      this._cellController.setValue(lastTab.value);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-tabs": CFTabs;
  }
}
