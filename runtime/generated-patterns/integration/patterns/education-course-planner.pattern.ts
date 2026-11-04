import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface CourseModule {
  id: string;
  title: string;
  durationWeeks: number;
}

interface TimelineEntry {
  id: string;
  title: string;
  startWeek: number;
  endWeek: number;
}

interface ReorderEvent {
  from?: number;
  to?: number;
}

const defaultModules: CourseModule[] = [
  { id: "orientation", title: "Orientation", durationWeeks: 1 },
  { id: "foundations", title: "Core Foundations", durationWeeks: 2 },
  { id: "project", title: "Capstone Project", durationWeeks: 3 },
];

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeDuration = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const integer = Math.round(value);
  return integer > 0 ? integer : 1;
};

const buildModuleId = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
};

const sanitizeModule = (
  module: CourseModule | undefined,
): CourseModule | null => {
  const title = sanitizeText(module?.title);
  if (!title) return null;
  const idSource = sanitizeText(module?.id) ?? title;
  const id = buildModuleId(idSource);
  if (id.length === 0) return null;
  const durationWeeks = sanitizeDuration(module?.durationWeeks);
  return { id, title, durationWeeks };
};

const sanitizeModules = (
  value: readonly CourseModule[] | undefined,
): CourseModule[] => {
  if (!Array.isArray(value)) return structuredClone(defaultModules);
  const seen = new Set<string>();
  const sanitized: CourseModule[] = [];
  for (const item of value) {
    const entry = sanitizeModule(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    sanitized.push(entry);
  }
  return sanitized.length > 0 ? sanitized : structuredClone(defaultModules);
};

const sanitizeStartWeek = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : 1;
};

const buildTimeline = (
  modules: readonly CourseModule[],
  startWeek: number,
): TimelineEntry[] => {
  const result: TimelineEntry[] = [];
  let currentWeek = startWeek;
  for (const module of modules) {
    const duration = sanitizeDuration(module.durationWeeks);
    const start = currentWeek;
    const end = currentWeek + duration - 1;
    result.push({
      id: module.id,
      title: module.title,
      startWeek: start,
      endWeek: end,
    });
    currentWeek = end + 1;
  }
  return result;
};

const formatTimeline = (entries: readonly TimelineEntry[]): string => {
  if (entries.length === 0) return "No modules scheduled";
  const segments = entries.map((entry) =>
    `${entry.title} (W${entry.startWeek}-W${entry.endWeek})`
  );
  return segments.join(" → ");
};

const clampIndex = (value: unknown, length: number): number => {
  if (length <= 0) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const index = Math.round(value);
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
};

interface EducationCoursePlannerArgs {
  modules: Default<CourseModule[], typeof defaultModules>;
  startWeek: Default<number, 1>;
}

const liftSanitizeModules = lift(sanitizeModules);
const liftSanitizeStartWeek = lift(sanitizeStartWeek);

const liftBuildTimeline = lift((inputs: {
  modules: CourseModule[];
  start: number;
}) => buildTimeline(inputs.modules, inputs.start));

const liftTotalDuration = lift((entries: CourseModule[] | undefined) => {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce(
    (sum, entry) => sum + sanitizeDuration(entry.durationWeeks),
    0,
  );
});

const liftModuleOrder = lift((entries: CourseModule[] | undefined) => {
  if (!Array.isArray(entries)) return [] as string[];
  return entries.map((entry) => entry.id);
});

const liftReorderCountView = lift((count: number | undefined) => {
  if (typeof count !== "number" || !Number.isFinite(count)) return 0;
  return Math.max(0, Math.trunc(count));
});

const liftTimelineSummary = lift((entries: TimelineEntry[] | undefined) =>
  Array.isArray(entries) ? formatTimeline(entries) : "No modules scheduled"
);

const reorderModules = handler(
  (
    event: ReorderEvent | undefined,
    manager: {
      modules: Cell<CourseModule[]>;
      reorderCount: Cell<number>;
      lastAction: Cell<string>;
    },
  ) => {
    const currentModules = sanitizeModules(manager.modules.get());
    if (currentModules.length < 2) {
      return;
    }
    const from = clampIndex(event?.from, currentModules.length);
    const to = clampIndex(event?.to, currentModules.length);
    if (from === to) return;
    const updated = currentModules.slice();
    const [moved] = updated.splice(from, 1);
    updated.splice(to, 0, moved);
    manager.modules.set(updated);
    const count = (manager.reorderCount.get() ?? 0) + 1;
    manager.reorderCount.set(count);
    const position = to + 1;
    manager.lastAction.set(`Moved ${moved.title} to position ${position}`);
  },
);

export const educationCoursePlanner = pattern<EducationCoursePlannerArgs>(
  ({ modules, startWeek }) => {
    const reorderCount = cell(0);
    const lastAction = cell("initialized");

    const modulesView = liftSanitizeModules(modules);
    const startWeekView = liftSanitizeStartWeek(startWeek);

    const timeline = liftBuildTimeline({
      modules: modulesView,
      start: startWeekView,
    });

    const totalDuration = liftTotalDuration(modulesView);

    const moduleOrder = liftModuleOrder(modulesView);

    const reorderCountView = liftReorderCountView(reorderCount);

    const timelineSummary = liftTimelineSummary(timeline);

    const label = str`Course timeline: ${timelineSummary}`;

    return {
      modules,
      startWeek,
      modulesView,
      moduleOrder,
      timeline,
      timelineSummary,
      totalDuration,
      label,
      reorderCount: reorderCountView,
      lastAction,
      reorder: reorderModules({ modules, reorderCount, lastAction }),
    };
  },
);

export default educationCoursePlanner;
