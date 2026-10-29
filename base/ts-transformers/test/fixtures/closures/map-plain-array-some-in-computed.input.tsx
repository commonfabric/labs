import { Writable, computed, pattern, UI } from "commonfabric";

interface Habit {
  name: string;
}

interface HabitLog {
  habitName: string;
  date: string;
  completed: boolean;
}

interface Input {
  habits: Habit[];
  logs: Writable<HabitLog[]>;
  todayDate: string;
}

// FIXTURE: map-plain-array-some-in-computed
// Verifies: plain-array callbacks nested inside computed() remain plain even inside a reactive outer map callback
//   habits.map(fn) -> habits.mapWithPattern(...)
//   computed(() => logs.get().some(fn)) -> lift(...)(...) whose inner some(fn) stays plain JS
// Context: The outer callback is pattern-owned, but the inner some() callback runs on the unwrapped logs array inside computed()
export default pattern<Input>(({ habits, logs, todayDate }) => {
  return {
    [UI]: <div>{habits.map((habit) => {
      const doneToday = computed(() =>
        logs.get().some(
          (log) =>
            log.habitName === habit.name &&
            log.date === todayDate &&
            log.completed,
        )
      );
      return <span>{doneToday ? "yes" : "no"}</span>;
    })}</div>,
  };
});
