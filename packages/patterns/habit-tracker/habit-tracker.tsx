import {
  action,
  computed,
  NAME,
  pattern,
  resultOf,
  UI,
  wish,
  Writable,
} from "commonfabric";
import type {
  Habit,
  HabitTrackerInput,
  HabitTrackerOutput,
} from "./schemas.tsx";

// Re-export for consumers
export type { Habit, HabitLog } from "./schemas.tsx";

// Get today's date as YYYY-MM-DD
const toDateString = (timestamp: number): string => {
  const now = new Date(timestamp);
  return now.toISOString().split("T")[0];
};

// Get date N days ago as YYYY-MM-DD
const getDateDaysAgo = (baseTimestamp: number, daysAgo: number): string => {
  const date = new Date(baseTimestamp);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split("T")[0];
};

export default pattern<HabitTrackerInput, HabitTrackerOutput>(
  ({ habits, logs }) => {
    const nowCell = wish<number>({ query: "#now" });
    const nowCellValue = resultOf(nowCell.result);
    const todayDate = computed(() => toDateString(nowCellValue));
    const newHabitName = new Writable("");
    const newHabitIcon = new Writable("✓");

    const habitCount = computed(() => habits.get().length);
    const summary = computed(() => {
      return habits.get()
        .map((h) => `${h.icon} ${h.name}`)
        .join(", ");
    });
    // Actions close over pattern state directly
    const toggleHabit = action<{ habitName: string }>(({ habitName }) => {
      // Only toggle if habit exists
      const habitExists = habits.get().some((h) => h.name === habitName);
      if (!habitExists) return;

      const today = toDateString(Date.now());
      const currentLogs = logs.get();
      const existingIdx = currentLogs.findIndex(
        (log) => log.habitName === habitName && log.date === today,
      );
      if (existingIdx >= 0) {
        // Write through the element's cell — replacing the array slot with a
        // fresh object literal would re-mint the log's entity identity and
        // orphan previously-held references (see
        // packages/patterns/primitives/editable-list.tsx).
        logs.key(existingIdx).key("completed").set(
          !currentLogs[existingIdx].completed,
        );
      } else {
        logs.push({ habitName, date: today, completed: true });
      }
    });

    const deleteHabit = action<{ habit: Habit }>(({ habit }) => {
      const current = habits.get();
      const idx = current.findIndex((h) => h.name === habit.name);
      if (idx >= 0) {
        habits.set(current.toSpliced(idx, 1));
      }
    });

    const addHabit = action<{ name: string; icon: string }>(
      ({ name, icon }) => {
        const trimmedName = name.trim();
        if (trimmedName) {
          habits.push({
            name: trimmedName,
            icon: icon || "✓",
            color: "#3b82f6",
          });
          newHabitName.set("");
        }
      },
    );

    const habitCards = computed(() => {
      const habitList = habits.get();
      const logList = logs.get();
      const todayTimestamp = nowCellValue;
      if (todayTimestamp == null) return [];
      const today = toDateString(todayTimestamp);

      return habitList.map((habit) => {
        const isCompletedToday = logList.some(
          (log) =>
            log.habitName === habit.name &&
            log.date === today &&
            log.completed,
        );

        let streak = 0;
        for (let i = 0; i < 365; i++) {
          const dateToCheck = getDateDaysAgo(todayTimestamp, i);
          const completed = logList.some(
            (log) =>
              log.habitName === habit.name &&
              log.date === dateToCheck &&
              log.completed,
          );
          if (completed) {
            streak++;
          } else if (i === 0) {
            continue;
          } else {
            break;
          }
        }

        return (
          <cf-card>
            <cf-hstack gap="2" align="center">
              <span style="font-size: 1.5rem;">{habit.icon}</span>
              <cf-vstack gap="0" style="flex: 1;">
                <span style="font-weight: 500;">
                  {habit.name || "(unnamed)"}
                </span>
                <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                  Streak: {streak} days
                </span>
              </cf-vstack>
              <cf-button
                variant={isCompletedToday ? "primary" : "secondary"}
                onClick={() => toggleHabit.send({ habitName: habit.name })}
              >
                {isCompletedToday ? "✓" : "○"}
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={() => deleteHabit.send({ habit })}
              >
                ×
              </cf-button>
            </cf-hstack>

            <cf-hstack gap="1" style="margin-top: 0.5rem;">
              {[6, 5, 4, 3, 2, 1, 0].map((daysAgo) => {
                const date = getDateDaysAgo(todayTimestamp, daysAgo);
                const dayCompleted = logList.some(
                  (log) =>
                    log.habitName === habit.name &&
                    log.date === date &&
                    log.completed,
                );

                return (
                  <div
                    style={{
                      width: "24px",
                      height: "24px",
                      borderRadius: "4px",
                      backgroundColor: dayCompleted
                        ? habit.color
                        : "var(--cf-colors-gray-200)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.625rem",
                      color: dayCompleted
                        ? "white"
                        : "var(--cf-colors-gray-400)",
                    }}
                  >
                    {date.slice(-2)}
                  </div>
                );
              })}
            </cf-hstack>
          </cf-card>
        );
      });
    });

    return {
      [NAME]: "Habit Tracker",
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="2">
            <cf-hstack justify="between" align="center">
              <cf-heading level={4}>Habits ({habitCount})</cf-heading>
              <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                {todayDate}
              </span>
            </cf-hstack>
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="2" style="padding: 1rem;">
              {habitCards}

              {computed(() =>
                habits.get().length === 0
                  ? (
                    <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 2rem;">
                      No habits yet. Add one below!
                    </div>
                  )
                  : null
              )}
            </cf-vstack>
          </cf-vscroll>

          <cf-hstack slot="footer" gap="2" style="padding: 1rem;" align="end">
            <cf-input
              $value={newHabitIcon}
              placeholder="Icon"
              style="width: 60px;"
            />
            <cf-input
              $value={newHabitName}
              placeholder="New habit name..."
              style="flex: 1;"
            />
            <cf-button
              variant="primary"
              onClick={() =>
                addHabit.send({
                  name: newHabitName.get(),
                  icon: newHabitIcon.get(),
                })}
            >
              Add Habit
            </cf-button>
          </cf-hstack>
        </cf-screen>
      ),
      habits,
      logs,
      todayDate,
      summary,
      toggleHabit,
      addHabit,
      deleteHabit,
    };
  },
);
