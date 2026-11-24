/**
 * Test Pattern: Weekly Calendar, editing events
 *
 * Opens a block's edit modal and saves and cancels from it. The week shown
 * starts on the Monday of today's week, so the events are placed on the date
 * the view's Monday slot reports.
 *
 * Run: deno task cf test patterns/apps/weekly-calendar/weekly-calendar.edit.test.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  fireClick,
  fireEvent,
  setBound,
} from "../../tools/test-support/vnode-helpers.ts";
import { COLORS } from "./event.tsx";
import {
  input,
  inputValue,
  isOpen,
  moveSource,
  slots,
  swatch,
  weekdayOf,
} from "./view-walk.ts";
import WeeklyCalendar from "./weekly-calendar.tsx";

export default pattern(() => {
  const cal = WeeklyCalendar({ events: [] });

  // The Monday slot puts that Monday's date in the prompt, which the next
  // action reads to place both events on it.
  const action_click_nine_on_monday = action(() =>
    fireClick(slots(cal[UI], 0)[3], "the 9 AM slot on Monday")
  );
  const action_seed_monday = action(() => {
    const date = String(inputValue(cal[UI], "New Event", 1));
    cal.createEvent.send({
      title: "Standup",
      date,
      startTime: "09:30",
      endTime: "10:30",
    });
    cal.createEvent.send({
      title: "Review",
      date,
      startTime: "13:00",
      endTime: "14:00",
    });
  });

  const action_open_standup = action(() =>
    fireClick(moveSource(cal[UI], "Standup"), "the Standup block")
  );
  // Typing a start carries the end along an hour; clearing it does not.
  const action_edit_standup = action(() => {
    setBound(input(cal[UI], "Edit Event", 0), "$value", "Planning");
    setBound(input(cal[UI], "Edit Event", 2), "$value", "11:00");
    fireEvent(input(cal[UI], "Edit Event", 2), "oncf-change", {
      detail: { value: "11:00" },
    });
    fireEvent(input(cal[UI], "Edit Event", 2), "oncf-change", {
      detail: { value: "" },
    });
    fireClick(swatch(cal[UI], "Edit Event", COLORS[3]), "the pink swatch");
  });
  const action_open_planning = action(() =>
    fireClick(moveSource(cal[UI], "Planning"), "the Planning block")
  );

  const assert_seeded = assert(() =>
    cal.eventCount === 2 &&
    weekdayOf(cal.events[0]?.date) === 1 &&
    cal.events[1]?.date === cal.events[0]?.date &&
    cal.events[0]?.color === COLORS[0]
  );
  const assert_editing_standup = assert(() =>
    isOpen(cal[UI], "Edit Event") &&
    inputValue(cal[UI], "Edit Event", 0) === "Standup" &&
    inputValue(cal[UI], "Edit Event", 1) === cal.events[0]?.date &&
    inputValue(cal[UI], "Edit Event", 2) === "09:30" &&
    inputValue(cal[UI], "Edit Event", 3) === "10:30"
  );
  const assert_saved = assert(() =>
    !isOpen(cal[UI], "Edit Event") &&
    cal.events[0]?.title === "Planning" &&
    cal.events[0]?.startTime === "11:00" &&
    cal.events[0]?.endTime === "12:00" &&
    cal.events[0]?.color === COLORS[3]
  );
  const assert_edit_closed_unchanged = assert(() =>
    !isOpen(cal[UI], "Edit Event") && cal.eventCount === 2 &&
    cal.events[0]?.title === "Planning"
  );

  return {
    [TESTS]: [
      { action: action_click_nine_on_monday },
      { action: action_seed_monday },
      { press: cal[UI], control: "Cancel", within: "Create Another" },
      { assertion: assert_seeded },

      // Editing a block.
      { action: action_open_standup },
      { assertion: assert_editing_standup },
      { action: action_edit_standup },
      { press: cal[UI], control: "Save" },
      { assertion: assert_saved },
      // With no block open, Save and Delete leave every event alone.
      { press: cal[UI], control: "Save" },
      { press: cal[UI], control: "Delete" },
      { assertion: assert_edit_closed_unchanged },
      { action: action_open_planning },
      { press: cal[UI], control: "Cancel", within: "Delete" },
      { assertion: assert_edit_closed_unchanged },
    ],
    cal,
  };
});
