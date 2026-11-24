/**
 * Test Pattern: Event Detail
 *
 * Tests for the event-detail pattern as a flat piece:
 * - Initial state with provided values
 * - Edit title/date/time/notes via stream actions, verify updates
 *
 * Run: deno task cf test patterns/apps/calendar/event-detail.test.tsx --verbose
 */
import { action, assert, NAME, pattern, TESTS } from "commonfabric";
import EventDetail from "./event-detail.tsx";

export default pattern(() => {
  const item = EventDetail({
    title: "Team Meeting",
    date: "2025-03-15",
    time: "10:00",
    notes: "Weekly sync",
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_change_title = action(() => {
    item.setTitle.send({ title: "Renamed Meeting" });
  });

  const action_change_date = action(() => {
    item.setDate.send({ date: "2025-04-01" });
  });

  const action_change_time = action(() => {
    item.setTime.send({ time: "14:30" });
  });

  const action_change_notes = action(() => {
    item.setNotes.send({ notes: "Updated agenda items" });
  });

  const action_clear_notes = action(() => {
    item.setNotes.send({ notes: "" });
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_name = assert(
    () => item[NAME] === "Event: Team Meeting",
  );
  const assert_initial_title = assert(
    () => item.title === "Team Meeting",
  );
  const assert_initial_date = assert(
    () => item.date === "2025-03-15",
  );
  const assert_initial_time = assert(() => item.time === "10:00");
  const assert_initial_notes = assert(
    () => item.notes === "Weekly sync",
  );

  // ==========================================================================
  // Assertions - After Edits
  // ==========================================================================

  const assert_name_after_rename = assert(
    () => item[NAME] === "Event: Renamed Meeting",
  );
  const assert_title_changed = assert(
    () => item.title === "Renamed Meeting",
  );
  const assert_date_changed = assert(
    () => item.date === "2025-04-01",
  );
  const assert_time_changed = assert(() => item.time === "14:30");
  const assert_notes_changed = assert(
    () => item.notes === "Updated agenda items",
  );
  const assert_notes_cleared = assert(() => item.notes === "");

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      // === Initial state ===
      { assertion: assert_name },
      { assertion: assert_initial_title },
      { assertion: assert_initial_date },
      { assertion: assert_initial_time },
      { assertion: assert_initial_notes },

      // === Edit fields ===
      { action: action_change_title },
      { assertion: assert_title_changed },
      { assertion: assert_name_after_rename },

      { action: action_change_date },
      { assertion: assert_date_changed },

      { action: action_change_time },
      { assertion: assert_time_changed },

      { action: action_change_notes },
      { assertion: assert_notes_changed },

      { action: action_clear_notes },
      { assertion: assert_notes_cleared },
    ],
    item,
  };
});
