/**
 * Tests for CFCalendar component
 *
 * Focus areas:
 * - View-month resync when the BOUND CELL's content changes (not just when
 *   the `value` property is reassigned), without clobbering manual month
 *   navigation on unrelated redeliveries/re-renders.
 * - Configurable week start (`week-start` attribute): grid leading-day math
 *   and weekday header labels, Sunday-first by default.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFCalendar } from "./index.ts";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";

/** Access to internals that are private in the component's public API. */
type CalendarInternals = {
  _navigatePrev(): void;
  _navigateNext(): void;
  _selectDate(dateStr: string): void;
};

function internals(el: CFCalendar): CalendarInternals {
  return el as unknown as CalendarInternals;
}

describe("CFCalendar", () => {
  it("should be defined", () => {
    expect(CFCalendar).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("cf-calendar")).toBe(CFCalendar);
  });

  it("should create element instance", () => {
    const element = new CFCalendar();
    expect(element).toBeInstanceOf(CFCalendar);
  });

  it("should default weekStart to sunday", () => {
    const element = new CFCalendar();
    expect(element.weekStart).toBe("sunday");
  });

  it("should map weekStart to the week-start attribute", () => {
    const props = (CFCalendar as unknown as {
      properties: Record<string, { attribute?: string }>;
    }).properties;
    expect(props.weekStart.attribute).toBe("week-start");
  });
});

describe("CFCalendar view-month resync on cell writes", () => {
  function createBoundCalendar(initialValue: string) {
    const element = new CFCalendar();
    const cell = createMockCellHandle(initialValue);
    element.value = cell;
    // Simulate Lit's first update: binds the cell controller and syncs the
    // view to the bound value.
    element.firstUpdated();
    return { element, cell };
  }

  it("syncs the view to the bound value on first update", () => {
    const { element } = createBoundCalendar("2026-03-15");
    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(2); // March
  });

  it("follows an external cell write into another month", () => {
    const { element, cell } = createBoundCalendar("2026-03-15");

    // Backend push: host app selects a date in another month by writing to
    // the same bound cell (no `value` property reassignment).
    pushUpdate(cell, "2026-07-04");

    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(6); // July
  });

  it("follows an external cell write across a year boundary", () => {
    const { element, cell } = createBoundCalendar("2026-12-20");
    pushUpdate(cell, "2027-01-05");

    expect(element._viewYear).toBe(2027);
    expect(element._viewMonth).toBe(0); // January
  });

  it("does not clobber manual navigation on a redelivery of the same value", () => {
    const { element, cell } = createBoundCalendar("2026-03-15");

    internals(element)._navigateNext();
    expect(element._viewMonth).toBe(3); // April

    // Unrelated redelivery (same content) — e.g. subscription echo — must
    // not yank the view back to the selected date's month.
    pushUpdate(cell, "2026-03-15");

    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(3); // still April
  });

  it("does not clobber manual navigation on an unrelated re-render", () => {
    const { element } = createBoundCalendar("2026-03-15");

    internals(element)._navigatePrev();
    expect(element._viewMonth).toBe(1); // February

    // A plain re-render (no value change) must leave the view alone.
    element.render();
    expect(element._viewMonth).toBe(1); // still February
  });

  it("moves the view back when an external write follows manual navigation", () => {
    const { element, cell } = createBoundCalendar("2026-03-15");

    internals(element)._navigateNext(); // April
    pushUpdate(cell, "2026-01-10"); // external write: January

    expect(element._viewMonth).toBe(0); // January wins — value changed
  });

  it("keeps the view steady when the user selects a day in the viewed month", () => {
    const { element } = createBoundCalendar("2026-03-15");

    internals(element)._selectDate("2026-03-20");

    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(2); // March, no jump
  });

  it("moves the view when the user selects a leading other-month day", () => {
    const { element } = createBoundCalendar("2026-03-15");

    // Leading cell from February shown in the March grid.
    internals(element)._selectDate("2026-02-28");

    expect(element._viewMonth).toBe(1); // February
  });
});

describe("CFCalendar week start", () => {
  // March 2026: the 1st falls on a Sunday.
  // June 2026: the 1st falls on a Monday.

  it("builds a Sunday-first grid by default", () => {
    const element = new CFCalendar();
    const grid = element._buildGrid(2026, 2); // March 2026

    expect(grid.length).toBe(42);
    expect(grid[0].dateStr).toBe("2026-03-01"); // Sunday, no leading days
    expect(grid[0].isCurrentMonth).toBe(true);
  });

  it("adds one leading day for a Monday 1st when Sunday-first", () => {
    const element = new CFCalendar();
    const grid = element._buildGrid(2026, 5); // June 2026

    expect(grid[0].dateStr).toBe("2026-05-31"); // Sunday before Mon June 1
    expect(grid[0].isCurrentMonth).toBe(false);
    expect(grid[1].dateStr).toBe("2026-06-01");
    expect(grid[1].isCurrentMonth).toBe(true);
  });

  it("rotates leading days when weekStart is monday", () => {
    const element = new CFCalendar();
    element.weekStart = "monday";

    // March 2026 starts on a Sunday → six leading days from February.
    const march = element._buildGrid(2026, 2);
    expect(march.length).toBe(42);
    expect(march[0].dateStr).toBe("2026-02-23"); // Monday
    expect(march[0].isCurrentMonth).toBe(false);
    expect(march[6].dateStr).toBe("2026-03-01");
    expect(march[6].isCurrentMonth).toBe(true);

    // June 2026 starts on a Monday → no leading days.
    const june = element._buildGrid(2026, 5);
    expect(june[0].dateStr).toBe("2026-06-01");
    expect(june[0].isCurrentMonth).toBe(true);
  });

  it("orders weekday header labels Sunday-first by default", () => {
    const element = new CFCalendar();
    expect(element._weekdayLabels()).toEqual([
      "Su",
      "Mo",
      "Tu",
      "We",
      "Th",
      "Fr",
      "Sa",
    ]);
  });

  it("orders weekday header labels Monday-first when weekStart is monday", () => {
    const element = new CFCalendar();
    element.weekStart = "monday";
    expect(element._weekdayLabels()).toEqual([
      "Mo",
      "Tu",
      "We",
      "Th",
      "Fr",
      "Sa",
      "Su",
    ]);
  });
});
