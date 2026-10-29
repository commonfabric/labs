import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type DayName =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

interface WorkoutExerciseSeed {
  name?: string;
  muscleGroup?: string;
  defaultSets?: number;
  defaultReps?: number;
}

interface WorkoutExercise {
  name: string;
  muscleGroup: string;
  defaultSets: number;
  defaultReps: number;
}

interface WorkoutPlanSeed {
  day?: string;
  exercise?: string;
  sets?: number;
  reps?: number;
}

interface WorkoutPlanEntry {
  day: string;
  exercise: string;
  muscleGroup: string;
  sets: number;
  reps: number;
}

interface MuscleVolumeEntry {
  muscleGroup: string;
  sessionCount: number;
  totalSets: number;
  totalReps: number;
  totalVolume: number;
}

interface WorkoutRoutinePlannerArgs {
  days: Default<string[], typeof defaultDays>;
  catalog: Default<WorkoutExerciseSeed[], typeof defaultCatalog>;
  plan: Default<WorkoutPlanEntry[], []>;
}

interface ScheduleEvent {
  day?: string;
  exercise?: string;
  sets?: number;
  reps?: number;
}

interface RemovalEvent {
  day?: string;
  exercise?: string;
}

const defaultDays: DayName[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const defaultCatalog: WorkoutExerciseSeed[] = [
  {
    name: "Back Squat",
    muscleGroup: "Legs",
    defaultSets: 4,
    defaultReps: 6,
  },
  {
    name: "Bench Press",
    muscleGroup: "Chest",
    defaultSets: 3,
    defaultReps: 8,
  },
  {
    name: "Deadlift",
    muscleGroup: "Back",
    defaultSets: 3,
    defaultReps: 5,
  },
  {
    name: "Overhead Press",
    muscleGroup: "Shoulders",
    defaultSets: 3,
    defaultReps: 8,
  },
  {
    name: "Pull Up",
    muscleGroup: "Back",
    defaultSets: 3,
    defaultReps: 10,
  },
];

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const titleCase = (value: string): string => {
  return value
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const sanitizeDays = (
  value: readonly string[] | undefined,
): string[] => {
  if (!Array.isArray(value)) return [...defaultDays];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = sanitizeText(entry);
    if (!text) continue;
    const normalized = titleCase(text);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : [...defaultDays];
};

const sanitizeMuscleGroup = (value: unknown): string => {
  const text = sanitizeText(value);
  if (!text) return "General";
  return titleCase(text);
};

const sanitizePositiveInt = (
  value: unknown,
  fallback: number,
  minimum = 1,
): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return Math.max(minimum, fallback);
  const rounded = Math.floor(numeric);
  return Math.max(minimum, rounded);
};

const sanitizeCatalog = (
  value: readonly WorkoutExerciseSeed[] | undefined,
): WorkoutExercise[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return defaultCatalog.map((entry) => ({
      name: entry.name!,
      muscleGroup: entry.muscleGroup!,
      defaultSets: entry.defaultSets!,
      defaultReps: entry.defaultReps!,
    }));
  }
  const seen = new Set<string>();
  const catalog: WorkoutExercise[] = [];
  for (const seed of value) {
    const rawName = sanitizeText(seed?.name);
    if (!rawName) continue;
    const name = titleCase(rawName);
    if (seen.has(name)) continue;
    const muscleGroup = sanitizeMuscleGroup(seed?.muscleGroup);
    const defaultSets = sanitizePositiveInt(seed?.defaultSets, 3);
    const defaultReps = sanitizePositiveInt(seed?.defaultReps, 5);
    seen.add(name);
    catalog.push({
      name,
      muscleGroup,
      defaultSets,
      defaultReps,
    });
  }
  return catalog.length > 0 ? catalog : defaultCatalog.map((entry) => ({
    name: entry.name!,
    muscleGroup: entry.muscleGroup!,
    defaultSets: entry.defaultSets!,
    defaultReps: entry.defaultReps!,
  }));
};

const lookupExercise = (
  name: unknown,
  catalog: readonly WorkoutExercise[],
): WorkoutExercise | null => {
  const text = sanitizeText(name);
  if (!text) return null;
  const normalized = text.toLowerCase();
  for (const entry of catalog) {
    if (entry.name.toLowerCase() === normalized) {
      return entry;
    }
  }
  return null;
};

const pickDay = (
  value: unknown,
  days: readonly string[],
): string | null => {
  if (days.length === 0) return null;
  const text = sanitizeText(value);
  if (!text) {
    return days[0] ?? null;
  }
  const normalized = text.toLowerCase();
  for (const day of days) {
    if (day.toLowerCase() === normalized) return day;
  }
  return null;
};

const keyForPlanEntry = (entry: WorkoutPlanEntry): string => {
  return `${entry.day}__${entry.exercise}`;
};

const sanitizePlan = (
  value:
    | readonly WorkoutPlanSeed[]
    | readonly WorkoutPlanEntry[]
    | undefined,
  days: readonly string[],
  catalog: readonly WorkoutExercise[],
): WorkoutPlanEntry[] => {
  if (!Array.isArray(value)) return [];
  const dayOrder = new Map<string, number>();
  days.forEach((day, index) => dayOrder.set(day, index));
  const dedup = new Map<string, WorkoutPlanEntry>();
  for (const seed of value) {
    const day = pickDay(seed?.day, days);
    if (!day) continue;
    const exercise = lookupExercise(seed?.exercise, catalog);
    if (!exercise) continue;
    const sets = sanitizePositiveInt(seed?.sets, exercise.defaultSets);
    const reps = sanitizePositiveInt(seed?.reps, exercise.defaultReps);
    const entry: WorkoutPlanEntry = {
      day,
      exercise: exercise.name,
      muscleGroup: exercise.muscleGroup,
      sets,
      reps,
    };
    dedup.set(keyForPlanEntry(entry), entry);
  }
  const entries = Array.from(dedup.values());
  entries.sort((a, b) => {
    const dayA = dayOrder.get(a.day) ?? 0;
    const dayB = dayOrder.get(b.day) ?? 0;
    if (dayA === dayB) {
      return a.exercise.localeCompare(b.exercise);
    }
    return dayA - dayB;
  });
  return entries;
};

const buildScheduleByDay = (
  days: readonly string[],
  plan: readonly WorkoutPlanEntry[],
): Record<string, WorkoutPlanEntry[]> => {
  const schedule: Record<string, WorkoutPlanEntry[]> = {};
  for (const day of days) {
    schedule[day] = [];
  }
  for (const entry of plan) {
    if (!schedule[entry.day]) {
      schedule[entry.day] = [];
    }
    schedule[entry.day].push(entry);
  }
  for (const day of days) {
    schedule[day].sort((a, b) => a.exercise.localeCompare(b.exercise));
  }
  return schedule;
};

const computeVolumeByGroup = (
  plan: readonly WorkoutPlanEntry[],
): MuscleVolumeEntry[] => {
  const buckets = new Map<string, MuscleVolumeEntry>();
  for (const entry of plan) {
    const bucket = buckets.get(entry.muscleGroup) ?? {
      muscleGroup: entry.muscleGroup,
      sessionCount: 0,
      totalSets: 0,
      totalReps: 0,
      totalVolume: 0,
    };
    bucket.sessionCount += 1;
    bucket.totalSets += entry.sets;
    bucket.totalReps += entry.reps;
    bucket.totalVolume += entry.sets * entry.reps;
    buckets.set(entry.muscleGroup, bucket);
  }
  return Array.from(buckets.values()).sort((a, b) =>
    a.muscleGroup.localeCompare(b.muscleGroup)
  );
};

const describeSchedule = (
  entry: WorkoutPlanEntry,
): string => {
  return `${entry.exercise} for ${entry.day} (${entry.sets}x${entry.reps})`;
};

const scheduleWorkout = handler(
  (
    event: ScheduleEvent | undefined,
    context: {
      plan: Cell<WorkoutPlanEntry[]>;
      daysView: Cell<string[]>;
      catalogView: Cell<WorkoutExercise[]>;
      lastAction: Cell<string>;
    },
  ) => {
    const days = context.daysView.get();
    const catalog = context.catalogView.get();
    if (days.length === 0 || catalog.length === 0) return;

    const exercise = lookupExercise(event?.exercise, catalog);
    if (!exercise) return;
    const day = pickDay(event?.day, days);
    if (!day) return;

    const sets = sanitizePositiveInt(event?.sets, exercise.defaultSets);
    const reps = sanitizePositiveInt(event?.reps, exercise.defaultReps);

    const current = sanitizePlan(context.plan.get(), days, catalog);
    const nextEntry: WorkoutPlanEntry = {
      day,
      exercise: exercise.name,
      muscleGroup: exercise.muscleGroup,
      sets,
      reps,
    };
    const keyed = new Map<string, WorkoutPlanEntry>();
    for (const entry of current) {
      keyed.set(keyForPlanEntry(entry), entry);
    }
    keyed.set(keyForPlanEntry(nextEntry), nextEntry);
    const sorted = sanitizePlan(Array.from(keyed.values()), days, catalog);
    context.plan.set(sorted);
    context.lastAction.set(`Scheduled ${describeSchedule(nextEntry)}`);
  },
);

// Module-scope lift definitions
const liftSanitizeDays = lift(sanitizeDays);
const liftSanitizeCatalog = lift(sanitizeCatalog);

const liftPlanView = lift((inputs: {
  plan: WorkoutPlanSeed[] | undefined;
  days: string[];
  catalog: WorkoutExercise[];
}) => sanitizePlan(inputs.plan, inputs.days, inputs.catalog));

const liftScheduleByDay = lift((inputs: {
  days: string[];
  plan: WorkoutPlanEntry[];
}) => buildScheduleByDay(inputs.days, inputs.plan));

const liftVolumeByGroup = lift((entries: WorkoutPlanEntry[]) =>
  computeVolumeByGroup(entries)
);

const liftTotalVolume = lift((entries: MuscleVolumeEntry[]) =>
  entries.reduce((sum, entry) => sum + entry.totalVolume, 0)
);

const liftGroupCount = lift((entries: MuscleVolumeEntry[]) => entries.length);

const liftFocusGroup = lift((entries: MuscleVolumeEntry[]) => {
  if (entries.length === 0) return "None";
  let candidate = entries[0];
  for (const entry of entries) {
    if (entry.totalVolume > candidate.totalVolume) {
      candidate = entry;
    } else if (
      entry.totalVolume === candidate.totalVolume &&
      entry.muscleGroup.localeCompare(candidate.muscleGroup) < 0
    ) {
      candidate = entry;
    }
  }
  return `${candidate.muscleGroup} (${candidate.totalVolume} reps)`;
});

const removeWorkout = handler(
  (
    event: RemovalEvent | undefined,
    context: {
      plan: Cell<WorkoutPlanEntry[]>;
      daysView: Cell<string[]>;
      catalogView: Cell<WorkoutExercise[]>;
      lastAction: Cell<string>;
    },
  ) => {
    const days = context.daysView.get();
    const catalog = context.catalogView.get();
    if (days.length === 0 || catalog.length === 0) return;

    const exercise = lookupExercise(event?.exercise, catalog);
    if (!exercise) return;
    const day = pickDay(event?.day, days);
    if (!day) return;

    const current = sanitizePlan(context.plan.get(), days, catalog);
    const filtered = current.filter((entry) =>
      !(entry.day === day && entry.exercise === exercise.name)
    );
    if (filtered.length === current.length) return;

    const sorted = sanitizePlan(filtered, days, catalog);
    context.plan.set(sorted);
    context.lastAction.set(`Removed ${exercise.name} on ${day}`);
  },
);

export const workoutRoutinePlanner = pattern<WorkoutRoutinePlannerArgs>(
  ({ days, catalog, plan }) => {
    const lastAction = cell("initialized");

    const daysView = liftSanitizeDays(days);
    const catalogView = liftSanitizeCatalog(catalog);
    const planView = liftPlanView({
      plan,
      days: daysView,
      catalog: catalogView,
    });

    const scheduleByDay = liftScheduleByDay({
      days: daysView,
      plan: planView,
    });

    const volumeByGroup = liftVolumeByGroup(planView);

    const totalVolume = liftTotalVolume(volumeByGroup);

    const groupCount = liftGroupCount(volumeByGroup);

    const focusGroup = liftFocusGroup(volumeByGroup);

    const status =
      str`${totalVolume} total reps across ${groupCount} muscle groups`;
    const focusSummary = str`Top focus: ${focusGroup}`;

    return {
      plan: planView,
      scheduleByDay,
      volumeByGroup,
      totalVolume,
      status,
      focusSummary,
      lastAction,
      scheduleWorkout: scheduleWorkout({
        plan,
        daysView,
        catalogView,
        lastAction,
      }),
      removeWorkout: removeWorkout({
        plan,
        daysView,
        catalogView,
        lastAction,
      }),
    };
  },
);

export default workoutRoutinePlanner;

export type { MuscleVolumeEntry, WorkoutPlanEntry };
