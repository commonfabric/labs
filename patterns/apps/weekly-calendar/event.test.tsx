/**
 * Test Pattern: Event
 *
 * Drives one calendar event through its streams and its view: the header line
 * that formats its date, time and duration, the inline title editor, the
 * start-time input that carries the end time along, and the color swatches.
 *
 * Run: deno task cf test patterns/apps/weekly-calendar/event.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  propsOf,
  propValue,
  styleOf,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import Event, { COLORS } from "./event.tsx";

/** The clickable title row, the one element with a click handler and text. */
const titleRow = (ui: unknown) =>
  findNode(
    ui,
    (node) => propsOf(node)?.onClick !== undefined && textContent(node) !== "",
  );

/** The color swatch painted `color`. */
const swatch = (ui: unknown, color: string) =>
  findNode(
    ui,
    (node) =>
      propsOf(node)?.onClick !== undefined &&
      styleOf(node, "backgroundColor") === color,
  );

/** The span that reads "<date> | <start> - <end> (<duration>)". */
const headerLine = (ui: unknown) =>
  textContent(innermostNode(
    ui,
    (node) => propsOf(node) !== undefined && hasText(node, " | "),
  ))
    .replace(/\s+/g, " ").trim();

const titleInput = (ui: unknown) =>
  findNodeByProp(ui, "placeholder", "Event title...");

const startTimeInput = (ui: unknown) =>
  findNode(ui, (node) => propsOf(node)?.["oncf-change"] !== undefined);

export default pattern(() => {
  const event = Event({
    title: "Standup",
    date: "2026-07-22",
    startTime: "09:00",
    endTime: "10:30",
    notes: "",
  });

  const action_click_title = action(() => fireClick(titleRow(event[UI])));
  const action_press_other_key = action(() =>
    fireEvent(titleInput(event[UI]), "oncf-keydown", { key: "a" })
  );
  const action_press_enter = action(() =>
    fireEvent(titleInput(event[UI]), "oncf-keydown", { key: "Enter" })
  );
  const action_blur_title = action(() =>
    fireEvent(titleInput(event[UI]), "oncf-blur", {})
  );
  const action_pick_blue = action(() =>
    fireClick(swatch(event[UI], COLORS[2]))
  );
  const action_clear_start = action(() =>
    fireEvent(startTimeInput(event[UI]), "oncf-change", {
      detail: { value: "" },
    })
  );
  const action_move_start_to_four = action(() =>
    fireEvent(startTimeInput(event[UI]), "oncf-change", {
      detail: { value: "16:00" },
    })
  );

  const assert_names_itself = assert(() => event[NAME] === "Standup");
  const assert_header_formats_hours_and_minutes = assert(() =>
    headerLine(event[UI]) === "Wed, Jul 22 | 9:00 AM - 10:30 AM (1h 30m)"
  );
  const assert_summary_without_notes = assert(() =>
    event.summary === "Standup on Wed, Jul 22 9:00 AM-10:30 AM"
  );
  const assert_title_row_shown = assert(() =>
    styleOf(titleRow(event[UI]), "display") === "flex"
  );
  const assert_backlinks_hidden = assert(() =>
    styleOf(
      findNode(event[UI], (node) =>
        hasText(node, "Linked from:") &&
        propValue(node, "slot") === "footer"),
      "display",
    ) === "none"
  );
  const assert_yellow_selected = assert(() =>
    styleOf(swatch(event[UI], COLORS[0]), "border") === "2px solid #111" &&
    styleOf(swatch(event[UI], COLORS[2]), "border") ===
      "2px solid transparent"
  );

  const assert_editing_title = assert(() =>
    styleOf(titleRow(event[UI]), "display") === "none"
  );
  const assert_done_editing = assert(() =>
    styleOf(titleRow(event[UI]), "display") === "flex"
  );

  const assert_blue_selected = assert(() =>
    event.color === COLORS[2] &&
    styleOf(swatch(event[UI], COLORS[2]), "border") === "2px solid #111"
  );

  const assert_whole_hour = assert(() =>
    headerLine(event[UI]) === "Wed, Jul 22 | 2:00 PM - 3:00 PM (1h)"
  );
  const assert_minutes_only = assert(() =>
    headerLine(event[UI]) === "Wed, Jul 22 | 2:00 PM - 2:30 PM (30m)"
  );
  const assert_empty_start_ignored = assert(() =>
    event.startTime === "14:00" && event.endTime === "14:30"
  );
  // The input carries the end along by the old duration, but never by less
  // than an hour, and it leaves the start itself to the input's binding.
  const assert_end_follows_start = assert(() => event.endTime === "17:00");
  const assert_end_keeps_long_duration = assert(() =>
    event.endTime === "19:30"
  );

  const assert_renamed = assert(() =>
    event[NAME] === "Retro" && event.title === "Retro"
  );
  const assert_summary_with_notes = assert(() =>
    event.date === "2026-08-03" && event.notes === "Bring sticky notes" &&
    event.summary ===
      "Retro on Mon, Aug 3 2:00 PM-5:00 PM: Bring sticky notes"
  );
  const assert_summary_without_date_or_times = assert(() =>
    event.summary === "Retro: Bring sticky notes" &&
    headerLine(event[UI]) === "| - (0m)"
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_header_formats_hours_and_minutes },
      { assertion: assert_summary_without_notes },
      { assertion: assert_title_row_shown },
      { assertion: assert_backlinks_hidden },
      { assertion: assert_yellow_selected },

      // Inline title editing: a click opens the editor, other keys leave it
      // open, and Enter or a blur closes it.
      { action: action_click_title },
      { assertion: assert_editing_title },
      { action: action_press_other_key },
      { assertion: assert_editing_title },
      { action: action_press_enter },
      { assertion: assert_done_editing },
      { action: action_click_title },
      { assertion: assert_editing_title },
      { action: action_blur_title },
      { assertion: assert_done_editing },

      { action: action_pick_blue },
      { assertion: assert_blue_selected },
      { action: event.setColor, event: { newColor: COLORS[0] } },
      { assertion: assert_yellow_selected },

      {
        action: event.setTime,
        event: { newStartTime: "14:00", newEndTime: "15:00" },
      },
      { assertion: assert_whole_hour },
      {
        action: event.setTime,
        event: { newStartTime: "14:00", newEndTime: "14:30" },
      },
      { assertion: assert_minutes_only },
      { action: action_clear_start },
      { assertion: assert_empty_start_ignored },
      { action: action_move_start_to_four },
      { assertion: assert_end_follows_start },
      {
        action: event.setTime,
        event: { newStartTime: "14:00", newEndTime: "17:30" },
      },
      { action: action_move_start_to_four },
      { assertion: assert_end_keeps_long_duration },

      { action: event.setTitle, event: { newTitle: "Retro" } },
      { assertion: assert_renamed },
      { action: event.setDate, event: { newDate: "2026-08-03" } },
      {
        action: event.setTime,
        event: { newStartTime: "14:00", newEndTime: "17:00" },
      },
      { action: event.setNotes, event: { newNotes: "Bring sticky notes" } },
      { assertion: assert_summary_with_notes },
      { action: event.setDate, event: { newDate: "" } },
      { action: event.setTime, event: { newStartTime: "", newEndTime: "" } },
      { assertion: assert_summary_without_date_or_times },
    ],
    event,
  };
});
