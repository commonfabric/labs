/**
 * Test Pattern: Weekly Calendar, creating events
 *
 * Drives the calendar the way its page does: the new-event modal opened from
 * a time slot and from "+ Add", and the blocks the new events occupy on the
 * grid. The week shown starts on the Monday of today's week, so the test
 * reads dates back from the view rather than naming them.
 *
 * Run: deno task cf test patterns/apps/weekly-calendar/weekly-calendar.create.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  fireClick,
  fireEvent,
  hasText,
  setBound,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import { COLORS } from "./event.tsx";
import {
  backlinksFooter,
  block,
  emptyFooter,
  headerOf,
  input,
  inputValue,
  isOpen,
  placement,
  shownColumns,
  slots,
  swatch,
  todayBadges,
  weekdayOf,
} from "./view-walk.ts";
import WeeklyCalendar, { addDays } from "./weekly-calendar.tsx";

export default pattern(() => {
  const cal = WeeklyCalendar({ events: [] });

  const action_click_nine_on_monday = action(() =>
    fireClick(slots(cal[UI], 0)[3], "the 9 AM slot on Monday")
  );
  // Typing a start carries the end along an hour; clearing it does not.
  const action_fill_standup = action(() => {
    setBound(input(cal[UI], "New Event", 0), "$value", "Standup");
    setBound(input(cal[UI], "New Event", 2), "$value", "09:30");
    fireEvent(input(cal[UI], "New Event", 2), "oncf-change", {
      detail: { value: "09:30" },
    });
    fireEvent(input(cal[UI], "New Event", 2), "oncf-change", {
      detail: { value: "" },
    });
    fireClick(swatch(cal[UI], "New Event", COLORS[2]), "the blue swatch");
  });
  // A quarter-hour event: the start carries the end to 2 PM, and the end is
  // then typed back to 1:15.
  const action_start_at_one = action(() => {
    setBound(input(cal[UI], "New Event", 2), "$value", "13:00");
    fireEvent(input(cal[UI], "New Event", 2), "oncf-change", {
      detail: { value: "13:00" },
    });
  });
  const action_end_at_quarter_past = action(() =>
    setBound(input(cal[UI], "New Event", 3), "$value", "13:15")
  );

  // The week opens on the Monday of today's week, with today marked once.
  const assert_opens_on_this_week = assert(() =>
    cal.eventCount === 0 && cal[NAME] === "Weekly Calendar (0)" &&
    hasText(emptyFooter(cal[UI]), "No events yet.") &&
    styleOf(backlinksFooter(cal[UI]), "display") === "none" &&
    shownColumns(cal[UI]) === "1111111" &&
    headerOf(cal[UI], 0).startsWith("Mon,") &&
    headerOf(cal[UI], 6).startsWith("Sun,") &&
    todayBadges(cal[UI]).replace(/0/g, "") === "1"
  );
  const assert_prompt_filled = assert(() =>
    isOpen(cal[UI], "New Event") &&
    weekdayOf(inputValue(cal[UI], "New Event", 1)) === 1 &&
    inputValue(cal[UI], "New Event", 3) === "10:30" &&
    styleOf(swatch(cal[UI], "New Event", COLORS[2]), "border") ===
      "2px solid #111" &&
    styleOf(swatch(cal[UI], "New Event", COLORS[0]), "border") ===
      "2px solid transparent"
  );
  const assert_created_and_still_open = assert(() =>
    cal.eventCount === 1 &&
    cal.events[0]?.title === "Standup" &&
    cal.events[0]?.startTime === "09:30" &&
    cal.events[0]?.endTime === "10:30" &&
    cal.events[0]?.color === COLORS[2] &&
    weekdayOf(cal.events[0]?.date) === 1 &&
    isOpen(cal[UI], "New Event") &&
    inputValue(cal[UI], "New Event", 0) === ""
  );
  // An untitled event is named for what it is, and Create closes the modal.
  const assert_untitled_created_and_closed = assert(() =>
    cal.eventCount === 2 &&
    cal.events[1]?.title === "New Event" &&
    cal.events[1]?.startTime === "13:00" &&
    cal.events[1]?.endTime === "13:15" &&
    !isOpen(cal[UI], "New Event")
  );
  // A date picked in the prompt replaces the one the slot gave it.
  const action_pick_wednesday = action(() =>
    fireEvent(input(cal[UI], "New Event", 1), "oncf-change", {
      detail: {
        value: addDays(String(inputValue(cal[UI], "New Event", 1)), 2),
      },
    })
  );
  const assert_prompt_open = assert(() =>
    isOpen(cal[UI], "New Event") &&
    weekdayOf(inputValue(cal[UI], "New Event", 1)) === 3
  );
  const assert_prompt_closed = assert(() =>
    !isOpen(cal[UI], "New Event") && cal.eventCount === 2
  );
  // 9:30 is three and a half hours below the 6 AM top of the grid, under the
  // 50px header, and an hour is 60px tall. A block is never shorter than half
  // an hour, so the quarter-hour event is 30px tall.
  const assert_blocks_placed = assert(() =>
    placement(cal[UI], "Standup") ===
      "block | 260px | 60px | calc(50px + (100% - 50px) * 0 / 7 + 2px) | calc((100% - 50px) / 7 - 4px)" &&
    styleOf(block(cal[UI], "Standup"), "backgroundColor") === COLORS[2] &&
    styleOf(block(cal[UI], "New Event"), "height") === "30px" &&
    !hasText(emptyFooter(cal[UI]), "No events yet.") &&
    cal.summary ===
      `${cal.events[0]?.date} Standup, ${cal.events[1]?.date} New Event` &&
    cal[NAME] === "Weekly Calendar (2)"
  );

  return {
    [TESTS]: [
      { assertion: assert_opens_on_this_week },

      // A slot opens the prompt for its day and hour.
      { action: action_click_nine_on_monday },
      { action: action_fill_standup },
      { assertion: assert_prompt_filled },
      { press: cal[UI], control: "Create Another" },
      { assertion: assert_created_and_still_open },
      { action: action_start_at_one },
      { action: action_end_at_quarter_past },
      { press: cal[UI], control: "Create" },
      { assertion: assert_untitled_created_and_closed },
      { press: cal[UI], control: "+ Add" },
      { action: action_pick_wednesday },
      { assertion: assert_prompt_open },
      { press: cal[UI], control: "Cancel", within: "Create Another" },
      { assertion: assert_prompt_closed },
      { assertion: assert_blocks_placed },
    ],
    cal,
  };
});
