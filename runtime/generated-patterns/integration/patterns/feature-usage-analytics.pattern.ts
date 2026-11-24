import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface FeatureUsageArgs {
  events: Default<FeatureUsageInput[], []>;
  defaultDelta: Default<number, 1>;
}

interface FeatureUsageInput {
  feature?: string;
  cohort?: string;
  count?: number;
}

interface FeatureUsageBucket {
  feature: string;
  cohort: string;
  count: number;
}

interface FeatureUsageEvent {
  feature?: string;
  cohort?: string;
  delta?: number;
  value?: number;
}

interface TopEntry {
  name: string;
  count: number;
}

interface MetricsData {
  featureTotals: Record<string, number>;
  cohortTotals: Record<string, number>;
  matrix: Record<string, Record<string, number>>;
  total: number;
  topFeature: TopEntry;
  topCohort: TopEntry;
  snapshot: UsageMetricsSnapshot;
}

interface UsageMetricsSnapshot {
  total: number;
  features: Record<string, number>;
  cohorts: Record<string, number>;
  featureCount: number;
  cohortCount: number;
  topFeature: string;
  topFeatureCount: number;
  topCohort: string;
  topCohortCount: number;
}

const sanitizeLabel = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeCount = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  const rounded = Math.round(input);
  return rounded < 0 ? 0 : rounded;
};

const sanitizeEvents = (value: unknown): FeatureUsageBucket[] => {
  if (!Array.isArray(value)) return [];
  const aggregated = new Map<string, FeatureUsageBucket>();
  for (let index = 0; index < value.length; index++) {
    const raw = value[index] as FeatureUsageInput | undefined;
    const fallbackFeature = `feature-${index + 1}`;
    const feature = sanitizeLabel(raw?.feature, fallbackFeature);
    const cohort = sanitizeLabel(raw?.cohort, "general");
    const count = sanitizeCount(raw?.count, 0);
    const key = `${feature}::${cohort}`;
    const existing = aggregated.get(key);
    if (existing) {
      aggregated.set(key, {
        feature,
        cohort,
        count: existing.count + count,
      });
    } else {
      aggregated.set(key, { feature, cohort, count });
    }
  }
  const buckets = Array.from(aggregated.values());
  buckets.sort((left, right) => {
    const featureOrder = left.feature.localeCompare(right.feature);
    if (featureOrder !== 0) return featureOrder;
    return left.cohort.localeCompare(right.cohort);
  });
  return buckets;
};

const computeFeatureTotals = (
  buckets: readonly FeatureUsageBucket[],
): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const bucket of buckets) {
    const { feature, count } = bucket;
    totals[feature] = (totals[feature] ?? 0) + count;
  }
  return totals;
};

const computeCohortTotals = (
  buckets: readonly FeatureUsageBucket[],
): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const bucket of buckets) {
    const { cohort, count } = bucket;
    totals[cohort] = (totals[cohort] ?? 0) + count;
  }
  return totals;
};

const computeMatrix = (
  buckets: readonly FeatureUsageBucket[],
): Record<string, Record<string, number>> => {
  const output: Record<string, Record<string, number>> = {};
  for (const bucket of buckets) {
    const featureEntry = output[bucket.feature] ?? {};
    featureEntry[bucket.cohort] = bucket.count;
    output[bucket.feature] = featureEntry;
  }
  return output;
};

const pickTopEntry = (totals: Record<string, number>): TopEntry => {
  const keys = Object.keys(totals);
  if (keys.length === 0) return { name: "none", count: 0 };
  let best = keys[0];
  for (let index = 1; index < keys.length; index++) {
    const candidate = keys[index];
    const value = totals[candidate] ?? 0;
    const bestValue = totals[best] ?? 0;
    if (value > bestValue) {
      best = candidate;
      continue;
    }
    if (value === bestValue && candidate.localeCompare(best) < 0) {
      best = candidate;
    }
  }
  return { name: best, count: totals[best] ?? 0 };
};

const formatTopFeature = (entry: TopEntry): string => {
  const name = entry.name;
  const count = entry.count;
  if (count === 0) return `${name} (0 events)`;
  const plural = count === 1 ? "event" : "events";
  return `${name} (${count} ${plural})`;
};

const formatCohortCount = (count: number): string => {
  const sanitized = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  const plural = sanitized === 1 ? "cohort" : "cohorts";
  return `${sanitized} ${plural}`;
};

// Module-scope lift definitions
const liftSanitizeEvents = lift((value: FeatureUsageInput[] | undefined) =>
  sanitizeEvents(value)
);

const liftDefaultDelta = lift((value: number | undefined) => {
  const sanitized = sanitizeCount(value, 1);
  return sanitized === 0 ? 1 : sanitized;
});

const liftComputeMetrics = lift((list: FeatureUsageBucket[] | undefined) => {
  const buckets = Array.isArray(list) ? list : [];
  const featureTotals = computeFeatureTotals(buckets);
  const cohortTotals = computeCohortTotals(buckets);
  const matrix = computeMatrix(buckets);
  const total = buckets.reduce((sum, entry) => sum + entry.count, 0);
  const topFeature = pickTopEntry(featureTotals);
  const topCohort = pickTopEntry(cohortTotals);
  const snapshot: UsageMetricsSnapshot = {
    total,
    features: featureTotals,
    cohorts: cohortTotals,
    featureCount: Object.keys(featureTotals).length,
    cohortCount: Object.keys(cohortTotals).length,
    topFeature: topFeature.name,
    topFeatureCount: topFeature.count,
    topCohort: topCohort.name,
    topCohortCount: topCohort.count,
  };
  return {
    featureTotals,
    cohortTotals,
    matrix,
    total,
    topFeature,
    topCohort,
    snapshot,
  } as MetricsData;
});

const liftFormatTopFeature = lift((entry: TopEntry | undefined) =>
  entry ? formatTopFeature(entry) : formatTopFeature({
    name: "none",
    count: 0,
  })
);

const liftFormatCohortCount = lift((count: number | undefined) =>
  formatCohortCount(typeof count === "number" ? count : 0)
);

const liftNormalizeLastEvent = lift((value: string | undefined) => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return "none";
});

const recordFeatureUsage = handler(
  (
    event: FeatureUsageEvent | undefined,
    context: {
      events: Cell<FeatureUsageInput[]>;
      defaultDelta: Cell<number>;
      lastEvent: Cell<string>;
    },
  ) => {
    const buckets = sanitizeEvents(context.events.get());
    const fallbackFeature = `feature-${buckets.length + 1}`;
    const feature = sanitizeLabel(event?.feature, fallbackFeature);
    const cohort = sanitizeLabel(event?.cohort, "general");
    const defaultDelta = sanitizeCount(context.defaultDelta.get(), 1) || 1;
    const delta = sanitizeCount(event?.delta, defaultDelta) || defaultDelta;
    const hasOverride = typeof event?.value === "number" &&
      Number.isFinite(event.value);
    const override = hasOverride
      ? sanitizeCount(event?.value, delta)
      : undefined;

    const index = buckets.findIndex((entry) =>
      entry.feature === feature && entry.cohort === cohort
    );
    if (index >= 0) {
      const existing = buckets[index];
      const next = override ?? existing.count + delta;
      buckets[index] = { feature, cohort, count: next };
    } else {
      const initial = override ?? delta;
      buckets.push({ feature, cohort, count: initial });
    }

    buckets.sort((left, right) => {
      const featureOrder = left.feature.localeCompare(right.feature);
      if (featureOrder !== 0) return featureOrder;
      return left.cohort.localeCompare(right.cohort);
    });

    context.events.set(buckets.map((entry) => ({
      feature: entry.feature,
      cohort: entry.cohort,
      count: entry.count,
    })));

    const descriptor = override !== undefined ? `=${override}` : `+${delta}`;
    context.lastEvent.set(`${feature}>${cohort} ${descriptor}`);
  },
);

export const featureUsageAnalytics = pattern<FeatureUsageArgs>(
  ({ events, defaultDelta }) => {
    const lastEvent = cell("none");

    const usageBuckets = liftSanitizeEvents(events);

    const defaultDeltaValue = liftDefaultDelta(defaultDelta);

    const metricsData = liftComputeMetrics(usageBuckets);

    const featureTotals = metricsData.featureTotals;
    const cohortTotals = metricsData.cohortTotals;
    const matrix = metricsData.matrix;
    const totalCount = metricsData.total;
    const topFeatureEntry = metricsData.topFeature;
    const topCohortEntry = metricsData.topCohort;
    const metricsSnapshot = metricsData.snapshot;
    const featureCount = Object.keys(featureTotals).length;
    const cohortCount = Object.keys(cohortTotals).length;

    const topFeatureLabel = liftFormatTopFeature(topFeatureEntry);

    const cohortLabel = liftFormatCohortCount(cohortCount);

    const lastEventView = liftNormalizeLastEvent(lastEvent);

    const statusLabel =
      str`Top feature ${topFeatureLabel} across ${cohortLabel}`;

    return {
      usage: usageBuckets,
      featureTotals,
      cohortTotals,
      matrix,
      totalCount,
      featureCount,
      cohortCount,
      topFeature: topFeatureEntry.name,
      topFeatureCount: topFeatureEntry.count,
      topCohort: topCohortEntry.name,
      topCohortCount: topCohortEntry.count,
      statusLabel,
      lastEvent: lastEventView,
      metricsSnapshot,
      controls: {
        record: recordFeatureUsage({
          events,
          defaultDelta: defaultDeltaValue,
          lastEvent,
        }),
      },
    };
  },
);

export default featureUsageAnalytics;
