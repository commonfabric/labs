/**
 * Habit Tracker Pattern Tests
 *
 * Tests core functionality:
 * - Initial state
 * - Adding habits (with validation)
 * - Toggling habit completion
 * - Deleting habits
 * - Default values
 * - held-reference survival (CT-1715): a log reference stashed in a cell
 *   BEFORE a toggle must still `equals()`-match and still drive a
 *   subsequent equals()-located removal AFTER the toggle. The toggle writes
 *   through the element's cell; replacing the array slot with a fresh
 *   object literal would re-mint the log's entity identity and orphan every
 *   held reference.
 *
 * Run: deno task cf test patterns/apps/habit-tracker/habit-tracker.test.tsx --verbose
 *
 * NOTE: Uses .filter(() => true).length instead of .length directly due to
 * a reactivity tracking bug where direct .length access doesn't register
 * dependencies. See patterns/dev/gideon-tests/array-length-repro.test.tsx
 */
import {
  action,
  assert,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import HabitTracker from "./habit-tracker.tsx";
import type { Habit, HabitLog } from "./schemas.tsx";

// Helper to get array length with proper reactivity tracking
const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

// Test plumbing: remove the log the held reference points at, locating it
// with equals() — proves a reference held across a toggle still drives
// operations (it would silently no-op if the toggle had re-minted the log's
// entity identity).
const removeHeldLog = handler<
  void,
  { logs: Writable<HabitLog[]>; held: Writable<HabitLog> }
>((_event, { logs, held }) => {
  const cur = logs.get();
  const idx = cur.findIndex((l) => equals(held, l));
  if (idx >= 0) {
    logs.set(cur.toSpliced(idx, 1));
  }
});

export default pattern(() => {
  const logsCell = new Writable<HabitLog[]>([]);
  const subject = HabitTracker({ habits: [], logs: logsCell });

  // Simulates an external holder (a stats panel / selection cell) that read
  // a log once and keeps the reference across later mutations. Typed
  // non-null (placeholder initial value) so the cell can be bound directly
  // as handler state.
  const heldLog = new Writable<HabitLog>({
    habitName: "",
    date: "",
    completed: false,
  });

  // === Actions ===

  const action_add_exercise = action(() => {
    subject.addHabit.send({ name: "Exercise", icon: "🏃" });
  });

  const action_add_read = action(() => {
    subject.addHabit.send({ name: "Read", icon: "📚" });
  });

  const action_add_empty_name = action(() => {
    subject.addHabit.send({ name: "   ", icon: "❌" });
  });

  const action_add_with_default_icon = action(() => {
    subject.addHabit.send({ name: "Meditate", icon: "" });
  });

  const action_toggle_exercise = action(() => {
    subject.toggleHabit.send({ habitName: "Exercise" });
  });

  const action_toggle_nonexistent = action(() => {
    subject.toggleHabit.send({ habitName: "NonExistent" });
  });

  const action_delete_read = action(() => {
    subject.deleteHabit.send({
      habit: { name: "Read", icon: "📚", color: "#3b82f6" },
    });
  });

  const action_delete_nonexistent = action(() => {
    subject.deleteHabit.send({
      habit: { name: "NonExistent", icon: "?", color: "#000" },
    });
  });

  // === Held-reference survival actions (CT-1715) ===
  const action_stash_held_log = action(() => {
    const log = logsCell.get()[0];
    if (log) heldLog.set(log);
  });
  const action_remove_via_held = removeHeldLog({
    logs: logsCell,
    held: heldLog,
  });

  // === Assertions ===

  // Initial state
  const assert_initial_no_habits = assert(
    () => len(subject.habits) === 0,
  );

  const assert_initial_no_logs = assert(
    () => len(subject.logs) === 0,
  );

  const assert_today_date_format = assert(() => {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    return dateRegex.test(subject.todayDate);
  });

  // After adding first habit
  const assert_one_habit = assert(
    () => len(subject.habits) === 1,
  );

  const assert_exercise_name = assert(
    () => subject.habits[0]?.name === "Exercise",
  );

  const assert_exercise_icon = assert(
    () => subject.habits[0]?.icon === "🏃",
  );

  const assert_exercise_default_color = assert(
    () => subject.habits[0]?.color === "#3b82f6",
  );

  // Empty name should not add habit
  const assert_still_one_habit_after_empty = assert(
    () => len(subject.habits) === 1,
  );

  // Default icon when empty string provided
  const assert_two_habits = assert(
    () => len(subject.habits) === 2,
  );

  const assert_meditate_default_icon = assert(() => {
    const meditate = subject.habits.find((h: Habit) => h.name === "Meditate");
    return meditate?.icon === "✓";
  });

  // After toggling habit (creates log)
  const assert_one_log = assert(
    () => len(subject.logs) === 1,
  );

  const assert_log_completed = assert(() => {
    const log = subject.logs.find((l: HabitLog) => l.habitName === "Exercise");
    return log?.completed === true;
  });

  const assert_log_habitName = assert(
    () => subject.logs[0]?.habitName === "Exercise",
  );

  const assert_log_date_is_today = assert(
    () => subject.logs[0]?.date === subject.todayDate,
  );

  // Toggling nonexistent habit should not create log
  const assert_still_one_log_after_nonexistent = assert(
    () => len(subject.logs) === 1,
  );

  // After toggling again (uncompletes)
  const assert_log_uncompleted = assert(() => {
    const log = subject.logs.find((l: HabitLog) => l.habitName === "Exercise");
    return log?.completed === false;
  });

  const assert_still_one_log_after_toggle = assert(
    () => len(subject.logs) === 1,
  );

  // After adding second habit
  const assert_three_habits = assert(
    () => len(subject.habits) === 3,
  );

  const assert_read_exists = assert(
    () => subject.habits.some((h: Habit) => h.name === "Read"),
  );

  // After deleting habit
  const assert_two_habits_after_delete = assert(
    () => len(subject.habits) === 2,
  );

  const assert_read_deleted = assert(
    () => !subject.habits.some((h: Habit) => h.name === "Read"),
  );

  const assert_exercise_remains = assert(
    () => subject.habits.some((h: Habit) => h.name === "Exercise"),
  );

  // Deleting nonexistent should not change count
  const assert_still_two_habits = assert(
    () => len(subject.habits) === 2,
  );

  // === Held-reference survival assertions (CT-1715) ===
  const assert_held_log_stashed = assert(() => {
    const h = heldLog.get();
    return h.habitName === "Exercise" && equals(logsCell.get()[0], h);
  });
  const assert_log_completed_again = assert(
    () => logsCell.get()[0]?.completed === true,
  );
  // KEY: the stale-but-once-valid reference still equals()-matches the log
  // AFTER the toggle updated it.
  const assert_held_log_survives_toggle = assert(() => {
    const h = heldLog.get();
    return equals(logsCell.get()[0], h);
  });
  // The held reference also READS the update (it would show the stale,
  // orphaned entity if the toggle had re-minted identity).
  const assert_held_log_reads_toggle = assert(
    () => heldLog.get().completed === true,
  );
  // KEY: the held reference still DRIVES an equals()-located removal.
  const assert_removed_via_held = assert(
    () => len(subject.logs) === 0,
  );

  return {
    [TESTS]: [
      // Initial state
      { assertion: assert_initial_no_habits },
      { assertion: assert_initial_no_logs },
      { assertion: assert_today_date_format },

      // Add first habit
      { action: action_add_exercise },
      { assertion: assert_one_habit },
      { assertion: assert_exercise_name },
      { assertion: assert_exercise_icon },
      { assertion: assert_exercise_default_color },

      // Empty name rejected
      { action: action_add_empty_name },
      { assertion: assert_still_one_habit_after_empty },

      // Default icon applied
      { action: action_add_with_default_icon },
      { assertion: assert_two_habits },
      { assertion: assert_meditate_default_icon },

      // Toggle creates log
      { action: action_toggle_exercise },
      { assertion: assert_one_log },
      { assertion: assert_log_completed },
      { assertion: assert_log_habitName },
      { assertion: assert_log_date_is_today },

      // Toggle nonexistent habit
      { action: action_toggle_nonexistent },
      { assertion: assert_still_one_log_after_nonexistent },

      // Toggle again uncompletes
      { action: action_toggle_exercise },
      { assertion: assert_still_one_log_after_toggle },
      { assertion: assert_log_uncompleted },

      // Add and delete habit
      { action: action_add_read },
      { assertion: assert_three_habits },
      { assertion: assert_read_exists },
      { action: action_delete_read },
      { assertion: assert_two_habits_after_delete },
      { assertion: assert_read_deleted },
      { assertion: assert_exercise_remains },

      // Delete nonexistent habit
      { action: action_delete_nonexistent },
      { assertion: assert_still_two_habits },

      // Held-reference survival: stash → toggle → the old reference still
      // matches, reads the update, and still drives removal.
      // (After the earlier toggles the Exercise log exists, completed=false.)
      { action: action_stash_held_log },
      { assertion: assert_held_log_stashed },
      { action: action_toggle_exercise },
      { assertion: assert_log_completed_again },
      { assertion: assert_held_log_survives_toggle },
      { assertion: assert_held_log_reads_toggle },
      { action: action_remove_via_held },
      { assertion: assert_removed_via_held },
    ],
    subject,
  };
});
