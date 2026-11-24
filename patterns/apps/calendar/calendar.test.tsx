/**
 * Test Pattern: Calendar
 *
 * Comprehensive tests for the calendar pattern:
 * - Initial state (empty event list)
 * - Adding events via action
 * - Verifying event fields (title, date, time)
 * - Adding multiple events, verify count
 * - Empty/whitespace title rejection
 * - Update notes via piece action
 * - Removing events
 * - The rendered list: date headers, the today badge, times, notes, and the
 *   remove and Add controls
 * - The new event's date: today until the user picks another, which then
 *   stays
 *
 * Run: deno task cf test patterns/apps/calendar/calendar.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  childNodes,
  findNodeByProp,
  fireEvent,
  hasExactText,
  innermostNode,
  propsOf,
  propValue,
  styleOf,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import Calendar, { formatDate } from "./calendar.tsx";

const isElementWithText = (text: string) => (node: unknown): boolean =>
  propsOf(node) !== undefined && hasExactText(node, text);

/** How many innermost elements under `node` show exactly `text`. */
const countText = (node: unknown, text: string): number => {
  const inner = childNodes(node).reduce<number>(
    (sum, child) => sum + countText(child, text),
    0,
  );
  return inner > 0 ? inner : isElementWithText(text)(node) ? 1 : 0;
};

/** The date the new-event date input shows. */
const shownDate = (ui: unknown): unknown =>
  propValue(findNodeByProp(ui, "type", "date"), "value");

/** The color of the innermost element showing exactly `text`. */
const colorOf = (root: unknown, text: string): unknown =>
  styleOf(innermostNode(root, isElementWithText(text)), "color");

const DAY_MS = 24 * 60 * 60 * 1000;

/** The YYYY-MM-DD date `days` after `date`. */
const shiftDate = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString()
    .slice(0, 10);

/** Each event's title, date, time and notes, in stored order. */
const fieldsOf = (
  events: readonly {
    title: string;
    date: string;
    time: string;
    notes: string;
  }[],
): string =>
  events.map((e) => [e.title, e.date, e.time, e.notes].join("|")).join(", ");

export default pattern(() => {
  const cal = Calendar({});

  // ==========================================================================
  // Actions - Adding Events
  // ==========================================================================

  const action_add_event = action(() => {
    cal.addEvent.send({
      title: "Team Meeting",
      date: "2025-03-15",
      time: "10:00",
    });
  });

  const action_add_second = action(() => {
    cal.addEvent.send({
      title: "Lunch",
      date: "2025-03-15",
      time: "12:00",
    });
  });

  const action_add_earlier_date = action(() => {
    cal.addEvent.send({
      title: "Kickoff",
      date: "2025-03-10",
      time: "09:00",
    });
  });

  // Empty title should be rejected
  const action_add_empty = action(() => {
    cal.addEvent.send({ title: "", date: "2025-03-15", time: "" });
  });

  const action_add_whitespace = action(() => {
    cal.addEvent.send({ title: "   ", date: "2025-03-15", time: "" });
  });

  // ==========================================================================
  // Actions - Modifying Event via Piece Action
  // ==========================================================================

  const action_update_notes = action(() => {
    const evts = cal.events;
    if (evts && evts[0]) {
      evts[0].setNotes.send({ notes: "Discuss Q2 roadmap" });
    }
  });

  // ==========================================================================
  // Actions - Removing Events
  // ==========================================================================

  const action_remove_first = action(() => {
    const evts = cal.events;
    if (evts && evts[0]) {
      cal.removeEvent.send({ event: evts[0] });
    }
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_empty = assert(() => cal.events.length === 0);

  // ==========================================================================
  // Assertions - After Adding
  // ==========================================================================

  const assert_has_one = assert(() => cal.events.length === 1);
  const assert_first_title = assert(
    () => cal.events[0]?.title === "Team Meeting",
  );
  const assert_first_date = assert(
    () => cal.events[0]?.date === "2025-03-15",
  );
  const assert_first_time = assert(
    () => cal.events[0]?.time === "10:00",
  );

  const assert_has_two = assert(() => cal.events.length === 2);
  const assert_has_three = assert(() => cal.events.length === 3);

  // Still three after empty/whitespace attempts
  const assert_still_three = assert(() => cal.events.length === 3);

  // ==========================================================================
  // Assertions - Sorting
  // ==========================================================================

  // Events added: Team Meeting (03-15 10:00), Lunch (03-15 12:00), Kickoff (03-10 09:00)
  // Sorted order should be: Kickoff (03-10), Team Meeting (03-15 10:00), Lunch (03-15 12:00)
  const assert_sorted_first_is_kickoff = assert(
    () => cal.sortedEvents[0]?.title === "Kickoff",
  );
  const assert_sorted_second_is_meeting = assert(
    () => cal.sortedEvents[1]?.title === "Team Meeting",
  );
  const assert_sorted_third_is_lunch = assert(
    () => cal.sortedEvents[2]?.title === "Lunch",
  );

  // ==========================================================================
  // Assertions - After Notes Update
  // ==========================================================================

  const assert_notes_updated = assert(
    () => cal.events[0]?.notes === "Discuss Q2 roadmap",
  );

  // ==========================================================================
  // Assertions - After Removing
  // ==========================================================================

  // Removing the first event leaves the others whole.
  const assert_has_two_after_remove = assert(() =>
    fieldsOf(cal.events) ===
      "Lunch|2025-03-15|12:00|, Kickoff|2025-03-10|09:00|"
  );
  const assert_has_one_after_remove = assert(() => cal.events.length === 1);
  const assert_back_to_empty = assert(() => cal.events.length === 0);

  // ==========================================================================
  // The Rendered List
  // ==========================================================================

  // The dates are eight days either side of the pattern's own today, read
  // once by the seeding action and kept, so the headers stay distinct and the
  // assertions compare against what was stored.
  const seeded = new Writable({ past: "", today: "", future: "" });
  const action_add_dated_events = action(() => {
    const today = cal.todayDate;
    const past = shiftDate(today, -8);
    const future = shiftDate(today, 8);
    seeded.set({ past, today, future });
    cal.addEvent.send({ title: "Archive review", date: past, time: "" });
    cal.addEvent.send({ title: "Backup", date: past, time: "10:00" });
    cal.addEvent.send({ title: "Standup", date: today, time: "09:30" });
    cal.addEvent.send({ title: "Launch", date: future, time: "08:00" });
  });
  const action_note_launch = action(() => {
    cal.events.find((e) => e.title === "Launch")?.setNotes.send({
      notes: "Liftoff checklist",
    });
  });
  const action_type_title = action(() =>
    typeInto(cal[UI], "Event title...", "Dentist")
  );
  const action_pick_future_date = action(() =>
    fireEvent(findNodeByProp(cal[UI], "type", "date"), "oncf-change", {
      detail: { value: seeded.get().future },
    })
  );

  const assert_today_is_a_date = assert(() =>
    /^\d{4}-\d{2}-\d{2}$/.test(cal.todayDate) &&
    countText(cal[UI], cal.todayDate) === 1 &&
    shownDate(cal[UI]) === cal.todayDate
  );
  const assert_empty_message = assert(() =>
    countText(cal[UI], "No events yet. Add one below!") === 1
  );
  const assert_seeded = assert(() =>
    seeded.get().today === cal.todayDate &&
    seeded.get().past === shiftDate(cal.todayDate, -8) &&
    seeded.get().future === shiftDate(cal.todayDate, 8)
  );
  const assert_summary_lists_sorted_events = assert(() =>
    cal.summary ===
      `${seeded.get().past} Archive review, ${seeded.get().past} 10:00 Backup, ${seeded.get().today} 09:30 Standup, ${seeded.get().future} 08:00 Launch`
  );
  // One header per date, however many events share it.
  const assert_one_header_per_date = assert(() =>
    countText(cal[UI], formatDate(seeded.get().past)) === 1 &&
    countText(cal[UI], formatDate(seeded.get().today)) === 1 &&
    countText(cal[UI], formatDate(seeded.get().future)) === 1
  );
  const assert_headers_shade_by_day = assert(() =>
    colorOf(cal[UI], formatDate(seeded.get().past)) ===
      "var(--cf-colors-gray-400)" &&
    colorOf(cal[UI], formatDate(seeded.get().today)) ===
      "var(--cf-colors-primary-500)" &&
    colorOf(cal[UI], formatDate(seeded.get().future)) ===
      "var(--cf-colors-gray-700)"
  );
  const assert_today_badge = assert(() => countText(cal[UI], "Today") === 1);
  const assert_cards_show_time_and_notes = assert(() =>
    countText(cal[UI], "09:30") === 1 &&
    countText(cal[UI], "Liftoff checklist") === 1 &&
    countText(cal[UI], "Archive review") === 1
  );
  // Removing an event from the middle leaves the ones after it whole.
  const assert_backup_removed = assert(() =>
    fieldsOf(cal.events) ===
      `Archive review|${seeded.get().past}||, Standup|${seeded.get().today}|09:30|, Launch|${seeded.get().future}|08:00|Liftoff checklist`
  );
  const assert_future_date_picked = assert(() =>
    shownDate(cal[UI]) === seeded.get().future
  );
  // The picked date stays through a removal and an add, and the add uses it.
  const assert_dentist_added_on_picked_date = assert(() =>
    cal.events.length === 4 &&
    cal.events[3]?.title === "Dentist" &&
    cal.events[3]?.date === seeded.get().future &&
    cal.events[3]?.time === "" &&
    shownDate(cal[UI]) === seeded.get().future
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Initial state ===
      { assertion: assert_initial_empty },

      // === Add events ===
      { action: action_add_event },
      { assertion: assert_has_one },
      { assertion: assert_first_title },
      { assertion: assert_first_date },
      { assertion: assert_first_time },

      { action: action_add_second },
      { assertion: assert_has_two },

      { action: action_add_earlier_date },
      { assertion: assert_has_three },

      // === Sorting: earliest date first, then by time ===
      { assertion: assert_sorted_first_is_kickoff },
      { assertion: assert_sorted_second_is_meeting },
      { assertion: assert_sorted_third_is_lunch },

      // === Empty/whitespace rejected ===
      { action: action_add_empty },
      { assertion: assert_still_three },
      { action: action_add_whitespace },
      { assertion: assert_still_three },

      // === Sub-piece property mutation and removal ===
      { action: action_update_notes },
      { assertion: assert_notes_updated },
      { action: action_remove_first },
      { assertion: assert_has_two_after_remove },
      { action: action_remove_first },
      { assertion: assert_has_one_after_remove },
      { action: action_remove_first },
      { assertion: assert_back_to_empty },

      // === The rendered list ===
      { assertion: assert_today_is_a_date },
      { assertion: assert_empty_message },
      { action: action_add_dated_events },
      { assertion: assert_seeded },
      { action: action_note_launch },
      { assertion: assert_summary_lists_sorted_events },
      { assertion: assert_one_header_per_date },
      { assertion: assert_headers_shade_by_day },
      { assertion: assert_today_badge },
      { assertion: assert_cards_show_time_and_notes },
      { action: action_pick_future_date },
      { assertion: assert_future_date_picked },
      { press: cal[UI], control: "×", within: "Backup" },
      { assertion: assert_backup_removed },
      // With no title typed, Add does nothing.
      { press: cal[UI], control: "Add" },
      { assertion: assert_backup_removed },
      { action: action_type_title },
      { press: cal[UI], control: "Add" },
      { assertion: assert_dentist_added_on_picked_date },
    ],
    cal,
  };
});
