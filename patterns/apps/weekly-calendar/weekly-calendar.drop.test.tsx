/**
 * Test Pattern: Weekly Calendar, dropping blocks onto day columns
 *
 * Moves and resizes a block by dropping it onto a day column, checks that
 * the click a drop leaves behind is swallowed, and deletes a block from its
 * edit modal. The week shown starts on the Monday of today's week, so the
 * events are placed on the date the view's Monday slot reports.
 *
 * A drop here is an event sent straight to the column's handler, which
 * checks what the handler does with it and says nothing about whether a
 * browser delivers one.
 *
 * Run: deno task cf test patterns/apps/weekly-calendar/weekly-calendar.drop.test.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  fireClick,
  fireEvent,
  propsOf,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import { COLORS } from "./event.tsx";
import {
  block,
  dropZone,
  inputValue,
  isOpen,
  moveSource,
  slots,
  weekdayOf,
} from "./view-walk.ts";
import WeeklyCalendar, { addDays } from "./weekly-calendar.tsx";

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

  const action_open_review = action(() =>
    fireClick(moveSource(cal[UI], "Review"), "the Review block")
  );

  // A drop onto Tuesday at 8 AM moves the block there and keeps its length.
  // One with the resize type moves only its end, to the half hour nearest
  // the pointer, and one with no pointer position does nothing.
  const action_drop_standup_on_tuesday = action(() =>
    fireEvent(dropZone(cal[UI], 1), "oncf-drop", {
      detail: {
        sourceCell: propsOf(moveSource(cal[UI], "Standup"))?.$cell,
        pointerY: 125,
        dropZoneRect: { top: 0 },
        type: "event",
      },
    })
  );
  const action_drop_without_pointer = action(() =>
    fireEvent(dropZone(cal[UI], 2), "oncf-drop", {
      detail: {
        sourceCell: propsOf(moveSource(cal[UI], "Standup"))?.$cell,
        dropZoneRect: { top: 0 },
        type: "event",
      },
    })
  );
  const action_resize_standup = action(() =>
    fireEvent(dropZone(cal[UI], 1), "oncf-drop", {
      detail: {
        sourceCell: propsOf(moveSource(cal[UI], "Standup"))?.$cell,
        pointerY: 255,
        dropZoneRect: { top: 0 },
        type: "event-resize",
      },
    })
  );
  const action_click_six_on_tuesday = action(() =>
    fireClick(slots(cal[UI], 1)[0], "the 6 AM slot on Tuesday")
  );

  const assert_seeded = assert(() =>
    cal.eventCount === 2 &&
    weekdayOf(cal.events[0]?.date) === 1 &&
    cal.events[1]?.date === cal.events[0]?.date &&
    cal.events[0]?.color === COLORS[0]
  );
  const assert_moved_to_tuesday = assert(() =>
    cal.events[0]?.date === addDays(cal.events[1]?.date ?? "", 1) &&
    cal.events[0]?.startTime === "08:00" &&
    cal.events[0]?.endTime === "09:00" &&
    styleOf(block(cal[UI], "Standup"), "left") ===
      "calc(50px + (100% - 50px) * 1 / 7 + 2px)"
  );
  // The click a drop's pointer-up makes is swallowed, and the one after it
  // is not.
  const assert_click_after_drop_swallowed = assert(() =>
    !isOpen(cal[UI], "New Event")
  );
  const assert_next_click_opens_prompt = assert(() =>
    isOpen(cal[UI], "New Event") &&
    inputValue(cal[UI], "New Event", 1) === cal.events[0]?.date &&
    inputValue(cal[UI], "New Event", 2) === "06:00" &&
    inputValue(cal[UI], "New Event", 3) === "07:00"
  );
  const assert_resized = assert(() =>
    cal.events[0]?.date === addDays(cal.events[1]?.date ?? "", 1) &&
    cal.events[0]?.startTime === "08:00" &&
    cal.events[0]?.endTime === "10:30"
  );
  const assert_edit_closed = assert(() =>
    !isOpen(cal[UI], "Edit Event") && cal.eventCount === 2
  );
  const assert_deleted = assert(() =>
    cal.eventCount === 1 && cal.events[0]?.title === "Standup" &&
    !isOpen(cal[UI], "Edit Event")
  );

  return {
    [TESTS]: [
      { action: action_click_nine_on_monday },
      { action: action_seed_monday },
      { press: cal[UI], control: "Cancel", within: "Create Another" },
      { assertion: assert_seeded },

      // Drops onto a day column.
      { action: action_drop_standup_on_tuesday },
      { assertion: assert_moved_to_tuesday },
      { action: action_click_six_on_tuesday },
      { assertion: assert_click_after_drop_swallowed },
      { action: action_click_six_on_tuesday },
      { assertion: assert_next_click_opens_prompt },
      { press: cal[UI], control: "Cancel", within: "Create Another" },
      { action: action_drop_without_pointer },
      { assertion: assert_moved_to_tuesday },
      { action: action_resize_standup },
      { assertion: assert_resized },
      // The resize was a drop too, so the click on a block that follows it
      // is swallowed as well.
      { action: action_open_review },
      { assertion: assert_edit_closed },
      { action: action_open_review },
      { press: cal[UI], control: "Delete" },
      { assertion: assert_deleted },
    ],
    cal,
  };
});
