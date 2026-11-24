import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type TrendDirection = "steady" | "rising" | "falling";

interface SatisfactionSampleInput {
  id?: string;
  date?: string;
  score?: number;
  responses?: number;
  channel?: string;
}

interface SatisfactionEntry extends SatisfactionSampleInput {
  id: string;
  date: string;
  score: number;
  responses: number;
  channel: string;
}

interface DailySummaryInternal {
  date: string;
  weightedSum: number;
  responseCount: number;
  average: number;
}

interface DailySummary {
  date: string;
  average: number;
  responseCount: number;
}

interface MovingAveragePoint {
  date: string;
  dailyAverage: number;
  trailing3: number;
  trailing7: number;
}

interface CustomerSatisfactionArgs {
  responses: Default<SatisfactionSampleInput[], typeof defaultResponses>;
}

const defaultResponses: SatisfactionSampleInput[] = [
  {
    id: "seed-1",
    date: "2024-05-01",
    score: 4.3,
    responses: 26,
    channel: "Email",
  },
  {
    id: "seed-2",
    date: "2024-05-02",
    score: 3.9,
    responses: 18,
    channel: "Chat",
  },
  {
    id: "seed-3",
    date: "2024-05-03",
    score: 4.6,
    responses: 22,
    channel: "In-App",
  },
];

const roundToTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeDate = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().slice(0, 10);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return "1970-01-01";
};

const sanitizeScore = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  const clamped = Math.min(5, Math.max(1, value));
  return roundToTwo(clamped);
};

const sanitizeResponses = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const rounded = Math.round(value);
  return Math.max(1, rounded);
};

const sanitizeChannel = (value: unknown): string => {
  if (typeof value !== "string") return "general";
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return "general";
  return trimmed.replace(/\s+/g, "-");
};

const sanitizeId = (
  value: unknown,
  fallback: string,
  date: string,
  channel: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const normalizedChannel = channel.length > 0 ? channel : "general";
  return `${date}-${normalizedChannel}-${fallback}`;
};

const sanitizeEntry = (
  seed: SatisfactionSampleInput | undefined,
  fallback: string,
): SatisfactionEntry => {
  const date = sanitizeDate(seed?.date);
  const channel = sanitizeChannel(seed?.channel);
  const score = sanitizeScore(seed?.score);
  const responses = sanitizeResponses(seed?.responses);
  const id = sanitizeId(seed?.id, fallback, date, channel);
  return {
    id,
    date,
    score,
    responses,
    channel,
  };
};

const sortEntries = (
  left: SatisfactionEntry,
  right: SatisfactionEntry,
): number => {
  if (left.date !== right.date) {
    return left.date.localeCompare(right.date);
  }
  return left.id.localeCompare(right.id);
};

const normalizeEntries = (
  entries: readonly SatisfactionEntry[],
): SatisfactionEntry[] => {
  const unique = new Map<string, SatisfactionEntry>();
  for (const entry of entries) {
    unique.set(entry.id, entry);
  }
  return Array.from(unique.values()).sort(sortEntries);
};

const sanitizeEntryList = (value: unknown): SatisfactionEntry[] => {
  if (!Array.isArray(value)) return [];
  const collected = value.map((raw, index) =>
    sanitizeEntry(
      raw as SatisfactionSampleInput | undefined,
      `seed-${index + 1}`,
    )
  );
  return normalizeEntries(collected);
};

const computeDailySummaries = (
  entries: readonly SatisfactionEntry[],
): DailySummaryInternal[] => {
  const totals = new Map<string, { weighted: number; responses: number }>();
  for (const entry of entries) {
    const bucket = totals.get(entry.date) ?? { weighted: 0, responses: 0 };
    bucket.weighted += entry.score * entry.responses;
    bucket.responses += entry.responses;
    totals.set(entry.date, bucket);
  }
  const summaries: DailySummaryInternal[] = [];
  for (const [date, bucket] of totals.entries()) {
    const average = bucket.responses === 0
      ? 0
      : bucket.weighted / bucket.responses;
    summaries.push({
      date,
      weightedSum: bucket.weighted,
      responseCount: bucket.responses,
      average: roundToTwo(average),
    });
  }
  summaries.sort((left, right) => left.date.localeCompare(right.date));
  return summaries;
};

const projectDailySummaries = (
  summaries: readonly DailySummaryInternal[],
): DailySummary[] => {
  return summaries.map((summary) => ({
    date: summary.date,
    average: summary.average,
    responseCount: summary.responseCount,
  }));
};

const computeWindowAverage = (
  summaries: readonly DailySummaryInternal[],
  index: number,
  windowSize: number,
): number => {
  let weighted = 0;
  let responses = 0;
  for (let offset = 0; offset < windowSize; offset += 1) {
    const position = index - offset;
    if (position < 0) break;
    const summary = summaries[position];
    weighted += summary.weightedSum;
    responses += summary.responseCount;
  }
  if (responses === 0) return 0;
  return roundToTwo(weighted / responses);
};

const computeMovingSeries = (
  summaries: readonly DailySummaryInternal[],
): MovingAveragePoint[] => {
  return summaries.map((summary, index) => ({
    date: summary.date,
    dailyAverage: summary.average,
    trailing3: computeWindowAverage(summaries, index, 3),
    trailing7: computeWindowAverage(summaries, index, 7),
  }));
};

const computeOverallAverage = (
  summaries: readonly DailySummaryInternal[],
): number => {
  let weighted = 0;
  let responses = 0;
  for (const summary of summaries) {
    weighted += summary.weightedSum;
    responses += summary.responseCount;
  }
  if (responses === 0) return 0;
  return roundToTwo(weighted / responses);
};

const computeChannelAverages = (
  entries: readonly SatisfactionEntry[],
): Record<string, number> => {
  const totals = new Map<string, { weighted: number; responses: number }>();
  for (const entry of entries) {
    const bucket = totals.get(entry.channel) ?? { weighted: 0, responses: 0 };
    bucket.weighted += entry.score * entry.responses;
    bucket.responses += entry.responses;
    totals.set(entry.channel, bucket);
  }
  const sortedChannels = Array.from(totals.entries())
    .sort((left, right) => left[0].localeCompare(right[0]));
  const record: Record<string, number> = {};
  for (const [channel, bucket] of sortedChannels) {
    record[channel] = bucket.responses === 0
      ? 0
      : roundToTwo(bucket.weighted / bucket.responses);
  }
  return record;
};

const determineTrend = (
  series: readonly MovingAveragePoint[],
): TrendDirection => {
  if (series.length < 2) return "steady";
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const delta = latest.trailing3 - previous.trailing3;
  if (delta > 0.05) return "rising";
  if (delta < -0.05) return "falling";
  return "steady";
};

const logSurveyResponse = handler(
  (
    event: SatisfactionSampleInput | undefined,
    context: {
      responses: Cell<SatisfactionSampleInput[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const existing = sanitizeEntryList(context.responses.get());
    const currentSeed = context.runtimeSeed.get() ?? 0;
    const candidate = sanitizeEntry(event, `runtime-${currentSeed + 1}`);
    const updated = normalizeEntries([...existing, candidate]);
    context.responses.set(updated);
    context.runtimeSeed.set(currentSeed + 1);
  },
);

const liftSanitizeEntryList = lift((
  value: readonly SatisfactionSampleInput[] | undefined,
) => sanitizeEntryList(value));

const liftComputeDailySummaries = lift((
  entries: readonly SatisfactionEntry[],
) => computeDailySummaries(entries));

const liftProjectDailySummaries = lift((
  summaries: readonly DailySummaryInternal[],
) => projectDailySummaries(summaries));

const liftComputeMovingSeries = lift((
  summaries: readonly DailySummaryInternal[],
) => computeMovingSeries(summaries));

const liftComputeOverallAverage = lift((
  summaries: readonly DailySummaryInternal[],
) => computeOverallAverage(summaries));

const liftFormatAverage = lift((value: number) => value.toFixed(2));

const liftResponseCount = lift((entries: readonly SatisfactionEntry[]) =>
  entries.reduce((sum, entry) => sum + entry.responses, 0)
);

const liftDayCount = lift((summaries: readonly DailySummaryInternal[]) =>
  summaries.length
);

const liftDetermineTrend = lift((series: readonly MovingAveragePoint[]) =>
  determineTrend(series)
);

const liftComputeChannelAverages = lift((
  entries: readonly SatisfactionEntry[],
) => computeChannelAverages(entries));

export const customerSatisfactionTracker = pattern<CustomerSatisfactionArgs>(
  ({ responses }) => {
    const runtimeSeed = cell(0);

    const responseLog = liftSanitizeEntryList(responses);

    const dailySummaryInternal = liftComputeDailySummaries(responseLog);

    const dailySummaries = liftProjectDailySummaries(dailySummaryInternal);

    const movingAverages = liftComputeMovingSeries(dailySummaryInternal);

    const overallAverage = liftComputeOverallAverage(dailySummaryInternal);

    const overallAverageLabel = liftFormatAverage(overallAverage);

    const responseCount = liftResponseCount(responseLog);

    const dayCount = liftDayCount(dailySummaryInternal);

    const trendDirection = liftDetermineTrend(movingAverages);

    const channelAverages = liftComputeChannelAverages(responseLog);

    const summary =
      str`${responseCount} responses across ${dayCount} days avg ${overallAverageLabel} trend ${trendDirection}`;

    return {
      responseLog,
      dailySummaries,
      movingAverages,
      overallAverage,
      overallAverageLabel,
      responseCount,
      dayCount,
      trendDirection,
      channelAverages,
      summary,
      recordResponse: logSurveyResponse({ responses, runtimeSeed }),
    };
  },
);

export type {
  DailySummary,
  MovingAveragePoint,
  SatisfactionEntry,
  TrendDirection,
};

export default customerSatisfactionTracker;
