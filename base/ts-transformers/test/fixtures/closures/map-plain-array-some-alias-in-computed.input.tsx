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

// FIXTURE: map-plain-array-some-alias-in-computed
// Verifies: aliasing the result of .get() inside computed() still keeps nested plain-array callbacks plain
//   const logList = logs.get()
//   logList.some(fn) -> plain JS some(fn), not callback-lowered
// Context: Outer habits.map(...) is pattern-owned, but the inner some() runs on the aliased unwrapped array inside computed()
export default pattern<Input>(({ habits, logs, todayDate }) => {
  return {
    [UI]: <div>{habits.map((habit) => {
      const doneToday = computed(() => {
        const logList = logs.get();
        return logList.some(
          (log) =>
            log.habitName === habit.name &&
            log.date === todayDate &&
            log.completed,
        );
      });
      return <span>{doneToday ? "yes" : "no"}</span>;
    })}</div>,
  };
});
