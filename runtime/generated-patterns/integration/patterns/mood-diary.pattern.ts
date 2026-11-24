import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

const MOOD_SCORE_TABLE = {
  radiant: 2,
  uplifted: 1,
  neutral: 0,
  pressed: -1,
  depleted: -2,
} as const;

type MoodLevel = keyof typeof MOOD_SCORE_TABLE;

const TIME_BUCKETS = [
  "overnight",
  "morning",
  "afternoon",
  "evening",
] as const;

type TimeBucket = typeof TIME_BUCKETS[number];

interface MoodEntrySeed {
  id?: string;
  timestamp?: string;
  mood?: string;
  note?: string;
  tags?: string[];
}

interface MoodEntry {
  id: string;
  timestamp: string;
  date: string;
  timeBucket: TimeBucket;
  mood: MoodLevel;
  score: number;
  note: string;
  tags: string[];
}

interface TagSentiment {
  tag: string;
  averageScore: number;
  entryCount: number;
  positiveShare: number;
}

interface TimeBucketSentiment {
  bucket: TimeBucket;
  averageScore: number;
  entryCount: number;
  positiveShare: number;
}

interface MoodMetrics {
  entryCount: number;
  averageScore: number;
  positiveCount: number;
  negativeCount: number;
  positiveShare: number;
}

interface MoodDiaryArgs {
  entries: Default<MoodEntrySeed[], []>;
}

const roundScore = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    tags.push(trimmed);
  }
  return tags.sort((a, b) => a.localeCompare(b));
};

const sanitizeNote = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 160);
};

const sanitizeMood = (value: unknown): MoodLevel => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized in MOOD_SCORE_TABLE) {
      return normalized as MoodLevel;
    }
  }
  return "neutral";
};

const parseTimestamp = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
};

const bucketForTimestamp = (iso: string): TimeBucket => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "overnight";
  }
  const hour = parsed.getUTCHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "overnight";
};

const sanitizeId = (
  raw: unknown,
  iso: string,
  mood: MoodLevel,
  tags: readonly string[],
  fallback: string,
): string => {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  const tagHint = tags[0] ?? "untagged";
  return `${iso}-${mood}-${tagHint}-${fallback}`;
};

const sortEntries = (left: MoodEntry, right: MoodEntry): number => {
  const timestampCompare = left.timestamp.localeCompare(right.timestamp);
  if (timestampCompare !== 0) {
    return timestampCompare;
  }
  return left.id.localeCompare(right.id);
};

const normalizeEntries = (entries: readonly MoodEntry[]): MoodEntry[] => {
  const deduped = new Map<string, MoodEntry>();
  for (const entry of entries) {
    deduped.set(entry.id, entry);
  }
  return Array.from(deduped.values()).sort(sortEntries);
};

const toMoodEntry = (
  seed: MoodEntrySeed | undefined,
  fallback: string,
): MoodEntry => {
  const timestamp = parseTimestamp(seed?.timestamp);
  const mood = sanitizeMood(seed?.mood);
  const tags = sanitizeTags(seed?.tags);
  const note = sanitizeNote(seed?.note);
  const id = sanitizeId(seed?.id, timestamp, mood, tags, fallback);
  const timeBucket = bucketForTimestamp(timestamp);
  return {
    id,
    timestamp,
    date: timestamp.slice(0, 10),
    timeBucket,
    mood,
    score: MOOD_SCORE_TABLE[mood],
    note,
    tags,
  };
};

const sanitizeEntryList = (
  entries: readonly MoodEntrySeed[] | undefined,
): MoodEntry[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const sanitized = entries.map((entry, index) =>
    toMoodEntry(entry, `seed-${index + 1}`)
  );
  return normalizeEntries(sanitized);
};

const computeMetrics = (entries: readonly MoodEntry[]): MoodMetrics => {
  let total = 0;
  let positive = 0;
  let negative = 0;
  for (const entry of entries) {
    total += entry.score;
    if (entry.score > 0) positive += 1;
    if (entry.score < 0) negative += 1;
  }
  const entryCount = entries.length;
  const averageScore = entryCount === 0 ? 0 : roundScore(total / entryCount);
  const positiveShare = entryCount === 0
    ? 0
    : roundScore(positive / entryCount);
  return {
    entryCount,
    averageScore,
    positiveCount: positive,
    negativeCount: negative,
    positiveShare,
  };
};

const computeTagBreakdown = (
  entries: readonly MoodEntry[],
): TagSentiment[] => {
  const buckets = new Map<string, {
    total: number;
    count: number;
    positive: number;
  }>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const bucket = buckets.get(tag) ?? {
        total: 0,
        count: 0,
        positive: 0,
      };
      bucket.total += entry.score;
      bucket.count += 1;
      if (entry.score > 0) {
        bucket.positive += 1;
      }
      buckets.set(tag, bucket);
    }
  }
  return Array.from(buckets.entries())
    .map(([tag, bucket]) => ({
      tag,
      averageScore: bucket.count === 0
        ? 0
        : roundScore(bucket.total / bucket.count),
      entryCount: bucket.count,
      positiveShare: bucket.count === 0
        ? 0
        : roundScore(bucket.positive / bucket.count),
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
};

const computeTimeBreakdown = (
  entries: readonly MoodEntry[],
): TimeBucketSentiment[] => {
  const buckets = new Map<TimeBucket, {
    total: number;
    count: number;
    positive: number;
  }>();
  for (const bucket of TIME_BUCKETS) {
    buckets.set(bucket, { total: 0, count: 0, positive: 0 });
  }
  for (const entry of entries) {
    const bucket = buckets.get(entry.timeBucket);
    if (!bucket) continue;
    bucket.total += entry.score;
    bucket.count += 1;
    if (entry.score > 0) bucket.positive += 1;
  }
  const summaries: TimeBucketSentiment[] = [];
  for (const key of TIME_BUCKETS) {
    const bucket = buckets.get(key);
    if (!bucket || bucket.count === 0) continue;
    summaries.push({
      bucket: key,
      averageScore: roundScore(bucket.total / bucket.count),
      entryCount: bucket.count,
      positiveShare: roundScore(bucket.positive / bucket.count),
    });
  }
  return summaries;
};

const logMoodEntry = handler(
  (
    event: MoodEntrySeed | undefined,
    context: {
      entries: Cell<MoodEntrySeed[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const existing = sanitizeEntryList(context.entries.get());
    const priorSeed = context.runtimeSeed.get() ?? existing.length;
    const entry = toMoodEntry(event, `runtime-${priorSeed + 1}`);
    const nextEntries = normalizeEntries([...existing, entry]);
    context.entries.set(nextEntries);
    context.runtimeSeed.set(priorSeed + 1);
  },
);

// Module-scope lift definitions
const liftSanitizeEntryList = lift((
  value: readonly MoodEntrySeed[] | undefined,
) => sanitizeEntryList(value));
const liftMetrics = lift((items: readonly MoodEntry[]) =>
  computeMetrics(items)
);
const liftTagSentiment = lift((items: readonly MoodEntry[]) =>
  computeTagBreakdown(items)
);
const liftTimeSentiment = lift((items: readonly MoodEntry[]) =>
  computeTimeBreakdown(items)
);
const liftEntryCount = lift((value: MoodMetrics) => value.entryCount);
const liftAverageScore = lift((value: MoodMetrics) => value.averageScore);
const liftPositivePercent = lift((value: MoodMetrics) =>
  Math.round(value.positiveShare * 100)
);
const liftLatestEntry = lift((items: readonly MoodEntry[]) =>
  items.length === 0 ? null : items[items.length - 1]
);

export const moodDiaryPattern = pattern<MoodDiaryArgs>(
  ({ entries }) => {
    const runtimeSeed = cell(0);

    const entryLog = liftSanitizeEntryList(entries);
    const metrics = liftMetrics(entryLog);
    const tagSentiment = liftTagSentiment(entryLog);
    const timeSentiment = liftTimeSentiment(entryLog);
    const entryCount = liftEntryCount(metrics);
    const averageScore = liftAverageScore(metrics);
    const positivePercent = liftPositivePercent(metrics);
    const sentimentSummary =
      str`${entryCount} moods logged avg ${averageScore} ${positivePercent}% positive`;
    const latestEntry = liftLatestEntry(entryLog);

    return {
      entryLog,
      metrics,
      tagSentiment,
      timeSentiment,
      sentimentSummary,
      latestEntry,
      logEntry: logMoodEntry({ entries, runtimeSeed }),
    };
  },
);

export type { MoodEntry, TagSentiment, TimeBucketSentiment };

export default moodDiaryPattern;
