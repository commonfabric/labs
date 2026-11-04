import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

type Weekday = typeof WEEKDAY_LABELS[number];

interface SleepSessionSeed {
  id?: string;
  date?: string;
  hours?: number;
  tags?: string[];
  weekday?: Weekday;
}

interface SleepSessionEntry {
  id: string;
  date: string;
  hours: number;
  tags: string[];
  weekday: Weekday;
}

interface TagAverage {
  tag: string;
  averageHours: number;
  sessionCount: number;
}

interface WeekdayAverage {
  weekday: Weekday;
  averageHours: number;
  sessionCount: number;
}

interface SleepMetrics {
  sessionCount: number;
  totalHours: number;
  averageHours: number;
}

interface SleepJournalArgs {
  sessions: Default<SleepSessionSeed[], []>;
}

const roundHours = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const toFiniteHours = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundHours(Math.max(0, value));
  }
  const parsed = typeof value === "string" ? Number(value) : 0;
  if (Number.isFinite(parsed)) {
    return roundHours(Math.max(0, parsed));
  }
  return 0;
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const toIsoDate = (value: unknown): string => {
  if (typeof value === "string" && isoDatePattern.test(value)) {
    return value;
  }
  if (typeof value === "string") {
    const attempt = new Date(value);
    if (!Number.isNaN(attempt.getTime())) {
      return attempt.toISOString().slice(0, 10);
    }
  }
  return "1970-01-01";
};

const weekdayFromDate = (date: string): Weekday => {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return "Sunday";
  }
  const index = parsed.getUTCDay();
  return WEEKDAY_LABELS[index] ?? "Sunday";
};

const sanitizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags;
};

const sanitizeId = (
  id: unknown,
  fallback: string,
  date: string,
  hours: number,
  tags: string[],
): string => {
  if (typeof id === "string") {
    const trimmed = id.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  const tagHint = tags[0] ?? "untagged";
  return `${date}-${tagHint}-${hours.toFixed(2)}-${fallback}`;
};

const toSessionEntry = (
  seed: SleepSessionSeed | undefined,
  fallback: string,
): SleepSessionEntry => {
  const isoDate = toIsoDate(seed?.date);
  const hours = toFiniteHours(seed?.hours);
  const tags = sanitizeTags(seed?.tags);
  const weekday = WEEKDAY_LABELS.includes(seed?.weekday as Weekday)
    ? seed?.weekday as Weekday
    : weekdayFromDate(isoDate);
  const id = sanitizeId(seed?.id, fallback, isoDate, hours, tags);
  return { id, date: isoDate, hours, tags, weekday };
};

const sanitizeSessionList = (
  entries: readonly SleepSessionSeed[] | undefined,
): SleepSessionEntry[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  return Array.from(
    entries,
    (entry, index) => toSessionEntry(entry, `seed-${index + 1}`),
  );
};

const computeTagSummaries = (
  entries: readonly SleepSessionEntry[],
): TagAverage[] => {
  const buckets = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const bucket = buckets.get(tag) ?? { total: 0, count: 0 };
      bucket.total += entry.hours;
      bucket.count += 1;
      buckets.set(tag, bucket);
    }
  }
  return Array.from(buckets.entries())
    .map(([tag, bucket]) => ({
      tag,
      averageHours: roundHours(
        bucket.count === 0 ? 0 : bucket.total / bucket.count,
      ),
      sessionCount: bucket.count,
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
};

const computeWeekdaySummaries = (
  entries: readonly SleepSessionEntry[],
): WeekdayAverage[] => {
  const buckets = new Map<Weekday, { total: number; count: number }>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.weekday) ?? { total: 0, count: 0 };
    bucket.total += entry.hours;
    bucket.count += 1;
    buckets.set(entry.weekday, bucket);
  }
  const summaries: WeekdayAverage[] = [];
  for (const weekday of WEEKDAY_LABELS) {
    const bucket = buckets.get(weekday);
    if (!bucket) continue;
    summaries.push({
      weekday,
      averageHours: roundHours(
        bucket.count === 0 ? 0 : bucket.total / bucket.count,
      ),
      sessionCount: bucket.count,
    });
  }
  return summaries;
};

const computeMetrics = (
  entries: readonly SleepSessionEntry[],
): SleepMetrics => {
  const sessionCount = entries.length;
  const totalHours = roundHours(
    entries.reduce((sum, entry) => sum + entry.hours, 0),
  );
  const averageHours = sessionCount === 0
    ? 0
    : roundHours(totalHours / sessionCount);
  return { sessionCount, totalHours, averageHours };
};

const logSleepSession = handler(
  (
    event: SleepSessionSeed | undefined,
    context: {
      sessions: Cell<SleepSessionSeed[]>;
      idSeed: Cell<number>;
    },
  ) => {
    const priorCount = context.idSeed.get() ?? 0;
    const existing = sanitizeSessionList(context.sessions.get());
    const nextIndex = Math.max(priorCount, existing.length) + 1;
    const entry = toSessionEntry(event, `runtime-${nextIndex}`);
    const nextSeeds = [...existing, entry];
    context.sessions.set(nextSeeds);
    context.idSeed.set(nextIndex);
  },
);

// Module-scope lift definitions
const liftSessionLog = lift((
  entries: readonly SleepSessionSeed[] | undefined,
) => sanitizeSessionList(entries));

const liftTagAverages = lift((entries: readonly SleepSessionEntry[]) =>
  computeTagSummaries(entries)
);

const liftWeekdayAverages = lift((entries: readonly SleepSessionEntry[]) =>
  computeWeekdaySummaries(entries)
);

const liftMetrics = lift((entries: readonly SleepSessionEntry[]) =>
  computeMetrics(entries)
);

const liftSessionCount = lift((value: SleepMetrics) => value.sessionCount);
const liftTotalHours = lift((value: SleepMetrics) => value.totalHours);
const liftAverageHours = lift((value: SleepMetrics) => value.averageHours);

const liftLatestView = lift((entries: readonly SleepSessionEntry[]) =>
  entries.length === 0 ? null : entries[entries.length - 1]
);

export const sleepJournalPattern = pattern<SleepJournalArgs>(
  ({ sessions }) => {
    const idSeed = cell(0);

    const sessionLog = liftSessionLog(sessions);
    const tagAverages = liftTagAverages(sessionLog);
    const weekdayAverages = liftWeekdayAverages(sessionLog);
    const metrics = liftMetrics(sessionLog);
    const sessionCount = liftSessionCount(metrics);
    const totalHours = liftTotalHours(metrics);
    const averageHours = liftAverageHours(metrics);
    const summary =
      str`${sessionCount} sessions averaging ${averageHours} hours`;
    const totalsLabel = str`${totalHours} total hours slept`;

    const latestView = liftLatestView(sessionLog);

    return {
      sessionLog,
      tagAverages,
      weekdayAverages,
      metrics,
      summary,
      totalsLabel,
      latestEntry: latestView,
      log: logSleepSession({ sessions, idSeed }),
    };
  },
);

export default sleepJournalPattern;

export type { SleepSessionEntry };
