/**
 * Test Pattern: Weekly Calendar, moving about and the agent's streams
 *
 * Drives the week navigation and the day/week toggle through the header
 * buttons, reading back which columns show and where today's badge sits,
 * then the streams an agent calls. The week shown starts on the Monday of
 * today's week, so the test reads the week back from the view rather than
 * naming its dates.
 *
 * Run: deno task cf test patterns/apps/weekly-calendar/weekly-calendar.navigate.test.tsx
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { fireClick, styleOf } from "../../tools/test-support/vnode-helpers.ts";
import { COLORS } from "./event.tsx";
import {
  headerButton,
  headerOf,
  headers,
  inputValue,
  placement,
  shownColumns,
  slots,
  todayBadges,
} from "./view-walk.ts";
import WeeklyCalendar, {
  addDays,
  formatDateHeader,
} from "./weekly-calendar.tsx";

export default pattern(() => {
  const cal = WeeklyCalendar({ events: [] });

  // The Monday slot puts that Monday's date in the prompt, which the next
  // action keeps so the weeks can be checked against it.
  const thisMonday = new Writable("");
  const action_click_monday = action(() =>
    fireClick(slots(cal[UI], 0)[0], "the 6 AM slot on Monday")
  );
  const action_note_monday = action(() =>
    thisMonday.set(String(inputValue(cal[UI], "New Event", 1)))
  );
  const action_go_today = action(() =>
    fireClick(headerButton(cal[UI], "Today"), "the Today button")
  );

  // The week opens on the Monday of today's week, with today marked once.
  const assert_this_week = assert(() =>
    shownColumns(cal[UI]) === "1111111" &&
    headerOf(cal[UI], 0).startsWith("Mon,") &&
    headerOf(cal[UI], 6).startsWith("Sun,") &&
    todayBadges(cal[UI]).replace(/0/g, "") === "1"
  );
  // Every column, the one carrying today's badge among them, is headed by
  // its own date.
  const assert_monday_noted = assert(() =>
    headers(cal[UI]) ===
      [0, 1, 2, 3, 4, 5, 6]
        .map((i) => formatDateHeader(addDays(thisMonday.get(), i)))
        .join(" / ")
  );
  const assert_next_week = assert(() =>
    headerOf(cal[UI], 0) === formatDateHeader(addDays(thisMonday.get(), 7)) &&
    todayBadges(cal[UI]) === "0000000"
  );
  const assert_back_on_this_week = assert(() =>
    shownColumns(cal[UI]) === "1111111" &&
    headerOf(cal[UI], 0) === formatDateHeader(thisMonday.get()) &&
    todayBadges(cal[UI]).replace(/0/g, "") === "1"
  );
  // A week the user moved to stays put across the view toggle.
  const assert_next_monday_alone = assert(() =>
    shownColumns(cal[UI]) === "1000000" &&
    headerOf(cal[UI], 0) === formatDateHeader(addDays(thisMonday.get(), 7)) &&
    styleOf(headerButton(cal[UI], "Day"), "backgroundColor") === "#3b82f6" &&
    styleOf(headerButton(cal[UI], "Week"), "backgroundColor") === "#fff"
  );
  // Following today, the day view shows today itself and the week view its
  // week.
  const assert_day_view_shows_today = assert(() =>
    shownColumns(cal[UI]) === "1000000" &&
    todayBadges(cal[UI]) === "1000000"
  );

  // An event long before the week shown is kept but not placed, and one
  // created with no title shows as untitled.
  const assert_far_event_hidden_and_untitled = assert(() =>
    cal.eventCount === 1 &&
    cal.events[0]?.color === COLORS[0] &&
    placement(cal[UI], "(untitled)") === "none | 0 | 0 | 0 | 0" &&
    cal.summary === "2000-01-03"
  );
  const assert_renamed = assert(() =>
    cal.title === "Team" && cal[NAME] === "Team (1)" &&
    cal.isCalendar === true && cal.isHidden === false
  );

  return {
    [TESTS]: [
      { assertion: assert_this_week },
      { action: action_click_monday },
      { action: action_note_monday },
      { press: cal[UI], control: "Cancel", within: "Create Another" },
      { assertion: assert_monday_noted },
      { press: cal[UI], control: ">" },
      { assertion: assert_next_week },
      { press: cal[UI], control: "Day" },
      { assertion: assert_next_monday_alone },
      { press: cal[UI], control: "Week" },
      { assertion: assert_next_week },
      { press: cal[UI], control: "<" },
      { assertion: assert_back_on_this_week },
      { press: cal[UI], control: ">" },
      { action: action_go_today },
      { assertion: assert_back_on_this_week },
      { press: cal[UI], control: "Day" },
      { assertion: assert_day_view_shows_today },
      { press: cal[UI], control: "Week" },
      { assertion: assert_back_on_this_week },

      {
        action: cal.createEvent,
        event: {
          title: "",
          date: "2000-01-03",
          startTime: "09:00",
          endTime: "10:00",
        },
      },
      { assertion: assert_far_event_hidden_and_untitled },
      { action: cal.setTitle, event: { newTitle: "Team" } },
      { assertion: assert_renamed },
    ],
    cal,
  };
});
