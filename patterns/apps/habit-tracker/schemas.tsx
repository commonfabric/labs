import { Default, NAME, Stream, UI, type VNode, Writable } from "commonfabric";

// === Domain Types ===

export interface Habit {
  name: string;
  icon: string | Default<"✓">;
  color: string | Default<"#3b82f6">;
}

export interface HabitLog {
  habitName: string;
  date: string; // YYYY-MM-DD
  completed: boolean;
}

// === Pattern Types ===

export interface HabitTrackerInput {
  habits: Writable<Habit[] | Default<[]>>;
  logs: Writable<HabitLog[] | Default<[]>>;
}

export interface HabitTrackerOutput {
  [NAME]: string;
  [UI]: VNode;
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
  summary: string;
  toggleHabit: Stream<{ habitName: string }>;
  addHabit: Stream<{ name: string; icon: string }>;
  deleteHabit: Stream<{ habit: Habit }>;
}
