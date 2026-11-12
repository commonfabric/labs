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

// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { CFCalendar } from "./index.ts";
import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";

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
  afterEach(() => document.body.replaceChildren());

  async function createBoundCalendar(initialValue: string) {
    const cell = createMockCellHandle(initialValue);
    const element = await mount(Object.assign(new CFCalendar(), {
      value: cell,
    }));
    return { element, cell };
  }

  /** Clicks the previous- or next-month button of `element`. */
  function navigate(element: CFCalendar, which: "prev" | "next"): void {
    element.shadowRoot!.querySelector<HTMLElement>(
      `[data-cf-calendar-${which}]`,
    )!.click();
  }

  it("syncs the view to the bound value on first update", async () => {
    const { element } = await createBoundCalendar("2026-03-15");
    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(2); // March
  });

  it("shows the month of a plain value from the first render", async () => {
    const element = await mount(Object.assign(new CFCalendar(), {
      value: "2026-03-15",
    }));

    const day = element.shadowRoot!.querySelector(
      '[data-cf-calendar-day="2026-03-31"]',
    );
    expect(day?.classList.contains("day-other-month")).toBe(false);
  });

  it("follows an external cell write into another month", async () => {
    const { element, cell } = await createBoundCalendar("2026-03-15");

    // Backend push: host app selects a date in another month by writing to
    // the same bound cell (no `value` property reassignment).
    pushUpdate(cell, "2026-07-04");

    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(6); // July
  });

  it("follows an external cell write across a year boundary", async () => {
    const { element, cell } = await createBoundCalendar("2026-12-20");
    pushUpdate(cell, "2027-01-05");

    expect(element._viewYear).toBe(2027);
    expect(element._viewMonth).toBe(0); // January
  });

  it("does not clobber manual navigation on a redelivery of the same value", async () => {
    const { element, cell } = await createBoundCalendar("2026-03-15");

    navigate(element, "next");
    expect(element._viewMonth).toBe(3); // April

    // Unrelated redelivery (same content) — e.g. subscription echo — must
    // not yank the view back to the selected date's month.
    pushUpdate(cell, "2026-03-15");

    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(3); // still April
  });

  it("does not clobber manual navigation on an unrelated re-render", async () => {
    const { element } = await createBoundCalendar("2026-03-15");

    navigate(element, "prev");
    expect(element._viewMonth).toBe(1); // February

    // A plain re-render (no value change) must leave the view alone.
    element.requestUpdate();
    await element.updateComplete;
    expect(element._viewMonth).toBe(1); // still February
  });

  it("moves the view back when an external write follows manual navigation", async () => {
    const { element, cell } = await createBoundCalendar("2026-03-15");

    navigate(element, "next"); // April
    pushUpdate(cell, "2026-01-10"); // external write: January

    expect(element._viewMonth).toBe(0); // January wins — value changed
  });

  it("keeps the view steady when the user selects a day in the viewed month", async () => {
    const { element } = await createBoundCalendar("2026-03-15");

    element.shadowRoot!.querySelector<HTMLElement>(
      '[data-cf-calendar-day="2026-03-20"]',
    )!.click();

    expect(element._viewYear).toBe(2026);
    expect(element._viewMonth).toBe(2); // March, no jump
  });

  it("moves the view when the user selects a trailing other-month day", async () => {
    const { element } = await createBoundCalendar("2026-03-15");

    // Trailing cell from April shown in the March grid.
    element.shadowRoot!.querySelector<HTMLElement>(
      '[data-cf-calendar-day="2026-04-02"]',
    )!.click();

    expect(element._viewMonth).toBe(3); // April
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

/** A calendar with `properties` set, mounted in the document. */
function calendar(
  properties: Partial<
    Pick<CFCalendar, "value" | "markedDates" | "min" | "max" | "disabled">
  > = {},
): Promise<CFCalendar> {
  return mount(Object.assign(new CFCalendar(), properties));
}

/** The cell `element` renders for the day `dateStr`. */
function day(element: CFCalendar, dateStr: string): HTMLElement {
  const found = element.shadowRoot!.querySelector<HTMLElement>(
    `[data-cf-calendar-day="${dateStr}"]`,
  );
  if (!found) throw new Error(`cf-calendar rendered no day ${dateStr}`);
  return found;
}

/** The previous- or next-month button `element` renders. */
function navButton(
  element: CFCalendar,
  which: "prev" | "next",
): HTMLButtonElement {
  const found = element.shadowRoot!.querySelector<HTMLButtonElement>(
    `[data-cf-calendar-${which}]`,
  );
  if (!found) throw new Error(`cf-calendar rendered no ${which} button`);
  return found;
}

/** The `cf-change` and `cf-month-change` events emitted while `act()` runs. */
function events(element: CFCalendar, act: () => void): unknown[] {
  const seen: unknown[] = [];
  const listener = (event: Event) =>
    seen.push({ [event.type]: (event as CustomEvent).detail });
  element.addEventListener("cf-change", listener);
  element.addEventListener("cf-month-change", listener);
  try {
    act();
  } finally {
    element.removeEventListener("cf-change", listener);
    element.removeEventListener("cf-month-change", listener);
  }
  return seen;
}

/** A keydown of `key` sent to `element`, reporting whether it was handled. */
function pressKey(element: HTMLElement, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("CFCalendar in a document", () => {
  afterEach(() => document.body.replaceChildren());

  it("presents itself as a grid named Calendar", async () => {
    const element = await calendar();

    expect(element.getAttribute("role")).toBe("grid");
    expect(element.getAttribute("aria-label")).toBe("Calendar");
  });

  it("reflects disabled to aria-disabled", async () => {
    const element = await calendar({ disabled: true });
    expect(element.getAttribute("aria-disabled")).toBe("true");

    element.disabled = false;
    await element.updateComplete;
    expect(element.getAttribute("aria-disabled")).toBe("false");
  });

  describe("days", () => {
    it("marks the selected day, and only that day, as selected", async () => {
      const element = await calendar({ value: "2026-03-15" });

      expect(day(element, "2026-03-15").classList.contains("day-selected"))
        .toBe(true);
      expect(day(element, "2026-03-15").getAttribute("aria-selected"))
        .toBe("true");
      expect(day(element, "2026-03-15").getAttribute("tabindex")).toBe("0");
      expect(day(element, "2026-03-16").getAttribute("aria-selected"))
        .toBe("false");
      expect(day(element, "2026-03-16").getAttribute("tabindex")).toBe("-1");
    });

    it("shows a dot on the marked days, and only those", async () => {
      const element = await calendar({
        value: "2026-03-15",
        markedDates: ["2026-03-02"],
      });

      expect(day(element, "2026-03-02").querySelector(".day-dot")).not
        .toBeNull();
      expect(day(element, "2026-03-03").querySelector(".day-dot")).toBeNull();
    });

    it("shows the dots of marked dates bound after the first render", async () => {
      const element = await calendar({ value: "2026-03-15" });
      element.markedDates = createMockCellHandle(["2026-03-04"]);
      await element.updateComplete;

      expect(day(element, "2026-03-04").querySelector(".day-dot")).not
        .toBeNull();
    });

    it("disables the days outside min and max, and only those", async () => {
      const element = await calendar({
        value: "2026-03-15",
        min: "2026-03-10",
        max: "2026-03-20",
      });

      for (const outside of ["2026-03-09", "2026-03-21"]) {
        expect(day(element, outside).classList.contains("day-disabled"))
          .toBe(true);
        expect(day(element, outside).getAttribute("aria-disabled"))
          .toBe("true");
      }
      for (const inside of ["2026-03-10", "2026-03-20"]) {
        expect(day(element, inside).getAttribute("aria-disabled"))
          .toBe("false");
      }
    });
  });

  describe("clicking a day", () => {
    it("selects it, writing the bound cell and emitting cf-change", async () => {
      const value = createMockCellHandle("2026-03-15");
      const element = await calendar({ value });

      const seen = events(element, () => day(element, "2026-03-18").click());
      await element.updateComplete;

      expect(seen).toEqual([{
        "cf-change": { value: "2026-03-18", oldValue: "2026-03-15" },
      }]);
      expect(writesSent(value).map((write) => write.value)).toEqual([
        "2026-03-18",
      ]);
      expect(day(element, "2026-03-18").classList.contains("day-selected"))
        .toBe(true);
    });

    it("emits nothing for the day already selected", async () => {
      const element = await calendar({ value: "2026-03-15" });

      expect(events(element, () => day(element, "2026-03-15").click()))
        .toEqual([]);
    });

    it("emits nothing for a day outside min and max", async () => {
      const element = await calendar({
        value: "2026-03-15",
        min: "2026-03-10",
      });

      expect(events(element, () => day(element, "2026-03-05").click()))
        .toEqual([]);
    });

    it("emits nothing when the calendar is disabled", async () => {
      const element = await calendar({ value: "2026-03-15", disabled: true });

      expect(events(element, () => day(element, "2026-03-18").click()))
        .toEqual([]);
    });
  });

  describe("month navigation", () => {
    it("moves from December to the next January", async () => {
      const element = await calendar({ value: "2026-12-10" });

      const seen = events(element, () => navButton(element, "next").click());
      await element.updateComplete;

      expect(seen).toEqual([{ "cf-month-change": { year: 2027, month: 0 } }]);
      expect(day(element, "2027-01-31").classList.contains("day-other-month"))
        .toBe(false);
    });

    it("moves from January to the previous December", async () => {
      const element = await calendar({ value: "2026-01-10" });

      const seen = events(element, () => navButton(element, "prev").click());
      await element.updateComplete;

      expect(seen).toEqual([{ "cf-month-change": { year: 2025, month: 11 } }]);
      expect(day(element, "2025-12-31").classList.contains("day-other-month"))
        .toBe(false);
    });

    it("disables both buttons when the calendar is disabled", async () => {
      const element = await calendar({ disabled: true });

      expect(navButton(element, "prev").disabled).toBe(true);
      expect(navButton(element, "next").disabled).toBe(true);
    });
  });

  describe("keyboard", () => {
    for (
      const [key, value] of [
        ["ArrowLeft", "2026-03-14"],
        ["ArrowRight", "2026-03-16"],
        ["ArrowUp", "2026-03-08"],
        ["ArrowDown", "2026-03-22"],
        ["Home", "2026-03-01"],
        ["End", "2026-03-31"],
      ]
    ) {
      it(`selects ${value} from 2026-03-15 on ${key}`, async () => {
        const element = await calendar({ value: "2026-03-15" });

        let handled = false;
        const seen = events(element, () => handled = pressKey(element, key));

        expect(handled).toBe(true);
        expect(seen).toEqual([{
          "cf-change": { value, oldValue: "2026-03-15" },
        }]);
      });
    }

    it("moves the view, emitting cf-month-change, when a key leaves the month", async () => {
      const element = await calendar({
        value: createMockCellHandle("2026-03-31"),
      });

      const seen = events(element, () => pressKey(element, "ArrowRight"));
      await element.updateComplete;

      expect(seen).toEqual([
        { "cf-month-change": { year: 2026, month: 3 } },
        { "cf-change": { value: "2026-04-01", oldValue: "2026-03-31" } },
      ]);
      expect(day(element, "2026-04-01").classList.contains("day-selected"))
        .toBe(true);
    });

    it("selects nothing when a key would leave the range min and max allow", async () => {
      const element = await calendar({
        value: "2026-03-15",
        max: "2026-03-15",
      });

      expect(events(element, () => pressKey(element, "ArrowRight")))
        .toEqual([]);
    });

    it("confirms the selected day on Enter and Space", async () => {
      const element = await calendar({ value: "2026-03-15" });

      const seen = events(element, () => {
        pressKey(element, "Enter");
        pressKey(element, " ");
      });

      expect(seen).toEqual([
        { "cf-change": { value: "2026-03-15", oldValue: "2026-03-15" } },
        { "cf-change": { value: "2026-03-15", oldValue: "2026-03-15" } },
      ]);
    });

    it("leaves other keys alone", async () => {
      const element = await calendar({ value: "2026-03-15" });

      let handled = true;
      const seen = events(element, () => handled = pressKey(element, "a"));

      expect(handled).toBe(false);
      expect(seen).toEqual([]);
    });

    it("selects today on Enter when nothing is selected", async () => {
      using _time = new FakeTime(new Date(2026, 4, 6, 12));
      const element = await calendar();

      let handled = false;
      const seen = events(element, () => handled = pressKey(element, "Enter"));

      expect(handled).toBe(true);
      expect(seen).toEqual([{
        "cf-change": { value: "2026-05-06", oldValue: "" },
      }]);
    });

    it("leaves arrows alone when nothing is selected", async () => {
      const element = await calendar();

      let handled = true;
      const seen = events(
        element,
        () => handled = pressKey(element, "ArrowRight"),
      );

      expect(handled).toBe(false);
      expect(seen).toEqual([]);
    });

    it("leaves every key alone when the calendar is disabled", async () => {
      const element = await calendar({ value: "2026-03-15", disabled: true });

      let handled = true;
      const seen = events(
        element,
        () => handled = pressKey(element, "ArrowRight"),
      );

      expect(handled).toBe(false);
      expect(seen).toEqual([]);
    });

    it("stops listening once the calendar leaves the document", async () => {
      const element = await calendar({ value: "2026-03-15" });
      element.remove();

      expect(events(element, () => pressKey(element, "ArrowRight")))
        .toEqual([]);
    });
  });
});
