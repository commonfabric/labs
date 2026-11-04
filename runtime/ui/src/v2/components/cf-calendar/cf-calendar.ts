import { type CellHandle } from "@commonfabric/runtime-client";
import { css, html, PropertyValues } from "lit";

import { BaseElement } from "../../core/base-element.ts";
import {
  createArrayCellController,
  createCellController,
} from "../../core/cell-controller.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * CFCalendar - Month-grid mini calendar component
 *
 * Displays a monthly calendar grid with navigation, day selection,
 * and optional dot indicators for marked dates.
 *
 * @element cf-calendar
 *
 * @attr {boolean} disabled - Whether the calendar is disabled
 * @attr {string} min - YYYY-MM-DD minimum selectable date
 * @attr {string} max - YYYY-MM-DD maximum selectable date
 * @attr {string} week-start - First day of the week: "sunday" (default) or
 *   "monday"
 *
 * @prop {CellHandle<string> | string} value - Selected date in YYYY-MM-DD format
 * @prop {CellHandle<string[]> | string[]} markedDates - Dates with dot indicators
 *
 * @fires cf-change - Fired when a day is clicked: { value, oldValue }
 * @fires cf-month-change - Fired when navigating months: { year, month }
 *
 * @example
 * const selectedDate = Cell.of("2024-03-15");
 * html`<cf-calendar .value=${selectedDate}></cf-calendar>`
 */
export class CFCalendar extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        font-family: inherit;
        user-select: none;
      }

      :host([disabled]) {
        opacity: 0.5;
        cursor: not-allowed;
        pointer-events: none;
      }

      .calendar {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }

      .calendar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.25rem 0;
      }

      .calendar-title {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--cf-theme-color-text, #111827);
        text-align: center;
        flex: 1;
      }

      .nav-button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border: none;
        border-radius: var(--cf-theme-border-radius, 0.375rem);
        background: transparent;
        color: var(--cf-theme-color-text, #111827);
        cursor: pointer;
        transition: background-color 150ms ease, color 150ms ease;
        flex-shrink: 0;
      }

      .nav-button:hover {
        background: var(--cf-theme-color-border, #e5e7eb);
      }

      .nav-button:focus {
        outline: 2px solid var(--cf-theme-color-primary, #3b82f6);
        outline-offset: 2px;
      }

      .nav-button svg {
        width: 1rem;
        height: 1rem;
      }

      .weekday-row {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 0.125rem;
      }

      .weekday-label {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6875rem;
        font-weight: 500;
        color: var(--cf-theme-color-text-secondary, #6b7280);
        height: 1.75rem;
      }

      .days-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 0.125rem;
      }

      .day-cell {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 100%;
        aspect-ratio: 1;
        min-width: 2rem;
        min-height: 2rem;
        border-radius: var(--cf-theme-border-radius, 0.375rem);
        font-size: 0.8125rem;
        cursor: pointer;
        position: relative;
        transition:
          background-color 150ms ease,
          color 150ms ease,
          opacity 150ms ease;
        border: 1.5px solid transparent;
        color: var(--cf-theme-color-text, #111827);
        background: transparent;
      }

      .day-cell:hover:not(.day-disabled) {
        background: var(--cf-theme-color-border, #e5e7eb);
      }

      .day-cell:focus {
        outline: 2px solid var(--cf-theme-color-primary, #3b82f6);
        outline-offset: 2px;
      }

      .day-cell.day-other-month {
        opacity: 0.3;
      }

      .day-cell.day-disabled {
        opacity: 0.3;
        pointer-events: none;
        cursor: default;
      }

      .day-cell.day-today {
        background: var(--cf-theme-color-primary, #3b82f6);
        color: #ffffff;
      }

      .day-cell.day-today:hover {
        background: var(--cf-theme-color-primary, #3b82f6);
        filter: brightness(0.9);
      }

      .day-cell.day-selected:not(.day-today) {
        border-color: var(--cf-theme-color-primary, #3b82f6);
        color: var(--cf-theme-color-primary, #3b82f6);
      }

      .day-cell.day-today.day-selected {
        box-shadow:
          0 0 0 2px var(--cf-theme-color-primary, #3b82f6),
          0 0 0 4px rgba(59, 130, 246, 0.2);
      }

      .day-number {
        line-height: 1;
      }

      .day-dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--cf-theme-color-primary, #3b82f6);
        margin-top: 2px;
        flex-shrink: 0;
      }

      .day-cell.day-today .day-dot {
        background: #ffffff;
      }
    `,
  ];

  static override properties = {
    value: { attribute: false },
    markedDates: { attribute: false },
    min: { type: String },
    max: { type: String },
    disabled: { type: Boolean, reflect: true },
    weekStart: { type: String, attribute: "week-start" },
  };

  declare value: CellHandle<string> | string;
  declare markedDates: CellHandle<string[]> | string[];
  declare min: string;
  declare max: string;
  declare disabled: boolean;
  declare weekStart: "sunday" | "monday";

  _viewYear: number;
  _viewMonth: number;

  /**
   * Last value content the view month was synced against. Lets cell-change
   * notifications distinguish "the bound value actually changed" (resync the
   * view month) from a mere redelivery/re-render (leave the view alone, so a
   * user who navigated to another month isn't yanked back).
   */
  private _lastSyncedValue: string | undefined;

  private _valueCellController = createCellController<string>(this, {
    timing: { strategy: "immediate" },
    onChange: (_newValue) => {
      // Follow the bound value's month when its CONTENT changes — e.g. the
      // host app writes a date in another month to the same cell. Without
      // this, only reassigning the `value` property resynced the view.
      this._resyncViewIfValueChanged();
      this.requestUpdate();
    },
  });

  private _markedDatesCellController = createArrayCellController<string>(
    this,
    {
      timing: { strategy: "immediate" },
    },
  );

  constructor() {
    super();
    const now = new Date();
    this._viewYear = now.getFullYear();
    this._viewMonth = now.getMonth();
    this.disabled = false;
    this.min = "";
    this.max = "";
    this.weekStart = "sunday";
  }

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "grid");
    this.setAttribute("aria-label", "Calendar");
    this.addEventListener("keydown", this._handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this._handleKeyDown);
  }

  override firstUpdated() {
    this._valueCellController.bind(this.value);
    this._markedDatesCellController.bind(this.markedDates as any);
    this._syncViewToValue();
  }

  override updated(changed: PropertyValues) {
    if (changed.has("value")) {
      this._valueCellController.bind(this.value);
      this._syncViewToValue();
    }
    if (changed.has("markedDates")) {
      this._markedDatesCellController.bind(this.markedDates as any);
    }
    if (changed.has("disabled")) {
      this.setAttribute("aria-disabled", String(this.disabled));
    }
  }

  private _syncViewToValue(): void {
    const val = this._getValue();
    this._lastSyncedValue = val;
    if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const [y, m] = val.split("-").map(Number);
      this._viewYear = y;
      this._viewMonth = m - 1;
    }
  }

  /**
   * Resync the view month only if the bound value's content changed since we
   * last synced. Redeliveries of an unchanged value (or unrelated re-renders)
   * must not move the view: the user may have navigated elsewhere with the
   * prev/next buttons.
   */
  private _resyncViewIfValueChanged(): void {
    if (this._getValue() === this._lastSyncedValue) return;
    this._syncViewToValue();
  }

  private _getValue(): string {
    return this._valueCellController.getValue() ?? "";
  }

  private _getMarkedDates(): readonly string[] {
    return this._markedDatesCellController.getValue() ?? [];
  }

  _buildGrid(
    year: number,
    month: number,
  ): Array<{ dateStr: string; day: number; isCurrentMonth: boolean }> {
    const cells: Array<{
      dateStr: string;
      day: number;
      isCurrentMonth: boolean;
    }> = [];

    const firstDay = new Date(year, month, 1);
    // Rotate the raw day-of-week (0=Sun) so column 0 is the configured week
    // start: number of leading previous-month cells before the 1st.
    const startDow = (firstDay.getDay() - this._weekStartOffset() + 7) % 7;

    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Leading days from previous month
    if (startDow > 0) {
      const prevMonthDate = new Date(year, month, 0);
      const daysInPrev = prevMonthDate.getDate();
      for (let i = startDow - 1; i >= 0; i--) {
        const day = daysInPrev - i;
        const d = new Date(year, month - 1, day);
        cells.push({
          dateStr: this._toDateStr(d),
          day,
          isCurrentMonth: false,
        });
      }
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(year, month, day);
      cells.push({
        dateStr: this._toDateStr(d),
        day,
        isCurrentMonth: true,
      });
    }

    // Trailing days from next month to fill 6 rows (42 cells)
    const remaining = 42 - cells.length;
    for (let day = 1; day <= remaining; day++) {
      const d = new Date(year, month + 1, day);
      cells.push({
        dateStr: this._toDateStr(d),
        day,
        isCurrentMonth: false,
      });
    }

    return cells;
  }

  /** Offset from Sunday of the configured first day of the week. */
  private _weekStartOffset(): number {
    return this.weekStart === "monday" ? 1 : 0;
  }

  /** Weekday header labels, rotated to start at the configured week start. */
  _weekdayLabels(): string[] {
    const labels = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
    const offset = this._weekStartOffset();
    return offset === 0
      ? labels
      : [...labels.slice(offset), ...labels.slice(0, offset)];
  }

  private _toDateStr(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private _getTodayStr(): string {
    return this._toDateStr(new Date());
  }

  private _isDisabledDate(dateStr: string): boolean {
    if (this.min && dateStr < this.min) return true;
    if (this.max && dateStr > this.max) return true;
    return false;
  }

  private _navigatePrev = (): void => {
    if (this._viewMonth === 0) {
      this._viewMonth = 11;
      this._viewYear -= 1;
    } else {
      this._viewMonth -= 1;
    }
    this.emit("cf-month-change", {
      year: this._viewYear,
      month: this._viewMonth,
    });
    this.requestUpdate();
  };

  private _navigateNext = (): void => {
    if (this._viewMonth === 11) {
      this._viewMonth = 0;
      this._viewYear += 1;
    } else {
      this._viewMonth += 1;
    }
    this.emit("cf-month-change", {
      year: this._viewYear,
      month: this._viewMonth,
    });
    this.requestUpdate();
  };

  private _selectDate(dateStr: string): void {
    if (this.disabled || this._isDisabledDate(dateStr)) return;
    const oldValue = this._getValue();
    if (dateStr === oldValue) return;
    this._valueCellController.setValue(dateStr);
    this.emit("cf-change", { value: dateStr, oldValue });
  }

  private _handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled) return;

    const current = this._getValue();
    if (!current) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this._selectDate(this._getTodayStr());
      }
      return;
    }

    const [y, m, d] = current.split("-").map(Number);
    let date = new Date(y, m - 1, d);

    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        date.setDate(date.getDate() - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        date.setDate(date.getDate() + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        date.setDate(date.getDate() - 7);
        break;
      case "ArrowDown":
        event.preventDefault();
        date.setDate(date.getDate() + 7);
        break;
      case "Home":
        event.preventDefault();
        date = new Date(date.getFullYear(), date.getMonth(), 1);
        break;
      case "End":
        event.preventDefault();
        date = new Date(date.getFullYear(), date.getMonth() + 1, 0);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.emit("cf-change", { value: current, oldValue: current });
        return;
      default:
        return;
    }

    const newDateStr = this._toDateStr(date);
    if (!this._isDisabledDate(newDateStr)) {
      if (
        date.getFullYear() !== this._viewYear ||
        date.getMonth() !== this._viewMonth
      ) {
        this._viewYear = date.getFullYear();
        this._viewMonth = date.getMonth();
        this.emit("cf-month-change", {
          year: this._viewYear,
          month: this._viewMonth,
        });
      }
      this._valueCellController.setValue(newDateStr);
      this.emit("cf-change", { value: newDateStr, oldValue: current });
      this.requestUpdate();
    }
  };

  private _monthName(month: number, year: number): string {
    return new Date(year, month, 1).toLocaleString("default", {
      month: "long",
      year: "numeric",
    });
  }

  override render() {
    const todayStr = this._getTodayStr();
    const selectedValue = this._getValue();
    const markedDatesSet = new Set(this._getMarkedDates());
    const grid = this._buildGrid(this._viewYear, this._viewMonth);
    const weekdays = this._weekdayLabels();

    return html`
      <div class="calendar" data-cf-calendar>
        <div class="calendar-header">
          <button
            class="nav-button"
            @click="${this._navigatePrev}"
            ?disabled="${this.disabled}"
            aria-label="Previous month"
            tabindex="-1"
            data-cf-calendar-prev
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
          <span class="calendar-title">
            ${this._monthName(this._viewMonth, this._viewYear)}
          </span>
          <button
            class="nav-button"
            @click="${this._navigateNext}"
            ?disabled="${this.disabled}"
            aria-label="Next month"
            tabindex="-1"
            data-cf-calendar-next
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        </div>

        <div class="weekday-row" role="row">
          ${weekdays.map(
            (day) =>
              html`
                <div
                  class="weekday-label"
                  role="columnheader"
                  aria-label="${day}"
                >
                  ${day}
                </div>
              `,
          )}
        </div>

        <div class="days-grid" role="rowgroup">
          ${grid.map(({ dateStr, day, isCurrentMonth }) => {
            const isToday = dateStr === todayStr;
            const isSelected = dateStr === selectedValue;
            const hasMarker = markedDatesSet.has(dateStr);
            const isDisabled = this.disabled || this._isDisabledDate(dateStr);
            const classes = [
              "day-cell",
              !isCurrentMonth ? "day-other-month" : "",
              isToday ? "day-today" : "",
              isSelected ? "day-selected" : "",
              isDisabled ? "day-disabled" : "",
            ]
              .filter(Boolean)
              .join(" ");

            return html`
              <div
                class="${classes}"
                role="gridcell"
                aria-label="${dateStr}"
                aria-selected="${isSelected}"
                aria-disabled="${isDisabled}"
                tabindex="${isSelected ? "0" : "-1"}"
                @click="${() => this._selectDate(dateStr)}"
                data-cf-calendar-day="${dateStr}"
              >
                <span class="day-number">${day}</span>
                ${hasMarker
                  ? html`
                    <span class="day-dot"></span>
                  `
                  : ""}
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-calendar": CFCalendar;
  }
}
