import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface FunnelStageInput {
  id?: string;
  label?: string;
  count?: number;
}

interface FunnelAnalyticsArgs {
  stages: Default<FunnelStageInput[], typeof defaultStageSeeds>;
}

interface FunnelStage extends FunnelStageInput {
  id: string;
  label: string;
  count: number;
}

interface StageMetric extends FunnelStage {
  dropOffRate: number;
  conversionRate: number;
  dropOffPercent: string;
  conversionPercent: string;
}

interface FunnelDropOffDetail {
  fromId: string;
  toId: string;
  fromStage: string;
  toStage: string;
  lost: number;
  dropOffRate: number;
  dropOffPercent: string;
}

interface StageUpdateEvent {
  stageId?: string;
  delta?: number;
  value?: number;
}

interface StageUpdateEntry {
  stageId: string;
  label: string;
  count: number;
  mode: "delta" | "value";
}

const defaultStageSeeds: FunnelStageInput[] = [
  { id: "awareness", label: "Awareness", count: 1200 },
  { id: "interest", label: "Interest", count: 720 },
  { id: "evaluation", label: "Evaluation", count: 320 },
  { id: "purchase", label: "Purchase", count: 96 },
];

const normalizeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const sanitizeId = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    const normalized = normalizeSlug(value);
    if (normalized.length > 0) return normalized;
  }
  const fallbackNormalized = normalizeSlug(fallback);
  return fallbackNormalized.length > 0 ? fallbackNormalized : "stage";
};

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeCount = (value: unknown, fallback: number): number => {
  const base = Number.isFinite(fallback) ? Math.round(fallback) : 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return base < 0 ? 0 : base;
  }
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded;
};

const fallbackStageAt = (index: number): FunnelStage => {
  const seed = defaultStageSeeds[index];
  const fallbackLabel = sanitizeLabel(seed?.label, `Stage ${index + 1}`);
  const idSource = seed?.id ?? fallbackLabel;
  const id = sanitizeId(idSource, `stage-${index + 1}`);
  const count = sanitizeCount(seed?.count, seed?.count ?? 0);
  return { id, label: fallbackLabel, count };
};

const cloneDefaultStages = (): FunnelStage[] =>
  defaultStageSeeds.map((_, index) => ({ ...fallbackStageAt(index) }));

const sanitizeStage = (
  value: FunnelStageInput | undefined,
  index: number,
): FunnelStage => {
  const fallback = fallbackStageAt(index);
  const id = sanitizeId(value?.id ?? value?.label, fallback.id);
  const label = sanitizeLabel(value?.label, fallback.label);
  const count = sanitizeCount(value?.count, fallback.count);
  return { id, label, count };
};

const sanitizeStages = (value: unknown): FunnelStage[] => {
  if (!Array.isArray(value)) return cloneDefaultStages();
  const seen = new Set<string>();
  const sanitized: FunnelStage[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = sanitizeStage(
      value[index] as FunnelStageInput | undefined,
      index,
    );
    if (seen.has(entry.id)) continue;
    sanitized.push(entry);
    seen.add(entry.id);
  }
  if (sanitized.length < 2) return cloneDefaultStages();
  return sanitized;
};

const sanitizeStageId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeSlug(value);
  return normalized.length > 0 ? normalized : null;
};

const sanitizeDelta = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
};

const sanitizeValue = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded;
};

const normalizeRatio = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 1000) / 1000;
};

const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

// Module-scope lift definitions
const liftSanitizeStages = lift(sanitizeStages);

const liftStageMetrics = lift((entries: FunnelStage[]) => {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const base = entries[0]?.count ?? 0;
  let previous = base;
  return entries.map((stage, index) => {
    const dropOffBase = index === 0 ? 0 : previous;
    const drop = dropOffBase === 0
      ? 0
      : normalizeRatio((dropOffBase - stage.count) / dropOffBase);
    const conversion = base === 0 ? 0 : normalizeRatio(stage.count / base);
    previous = stage.count;
    return {
      id: stage.id,
      label: stage.label,
      count: stage.count,
      dropOffRate: drop,
      conversionRate: conversion,
      dropOffPercent: formatPercent(drop),
      conversionPercent: formatPercent(conversion),
    };
  });
});

const liftDropOffDetails = lift((metrics: StageMetric[]) => {
  if (!Array.isArray(metrics)) return [];
  const details: FunnelDropOffDetail[] = [];
  for (let index = 1; index < metrics.length; index++) {
    const current = metrics[index];
    const previous = metrics[index - 1];
    const lost = previous.count - current.count;
    details.push({
      fromId: previous.id,
      toId: current.id,
      fromStage: previous.label,
      toStage: current.label,
      lost: lost > 0 ? lost : 0,
      dropOffRate: current.dropOffRate,
      dropOffPercent: current.dropOffPercent,
    });
  }
  return details;
});

const liftStageOrder = lift((metrics: StageMetric[]) =>
  Array.isArray(metrics) ? metrics.map((stage) => stage.id) : []
);

const liftOverallConversionRate = lift((metrics: StageMetric[]) => {
  if (!Array.isArray(metrics) || metrics.length === 0) return 0;
  const last = metrics[metrics.length - 1];
  return normalizeRatio(last.conversionRate);
});

const liftOverallConversionPercent = lift((ratio: number) =>
  formatPercent(normalizeRatio(ratio))
);

const liftWorstStage = lift((metrics: StageMetric[] | undefined) => {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return { label: "No stages", dropOffPercent: "0.0%" };
  }
  if (metrics.length === 1) {
    return {
      label: metrics[0].label,
      dropOffPercent: metrics[0].dropOffPercent,
    };
  }
  let worst = metrics[1];
  for (let index = 2; index < metrics.length; index++) {
    const candidate = metrics[index];
    if (candidate.dropOffRate > worst.dropOffRate) {
      worst = candidate;
      continue;
    }
    if (
      candidate.dropOffRate === worst.dropOffRate &&
      candidate.label.localeCompare(worst.label) < 0
    ) {
      worst = candidate;
    }
  }
  return { label: worst.label, dropOffPercent: worst.dropOffPercent };
});

const liftWorstLabel = lift((entry: { label: string }) => entry.label);

const liftWorstPercent = lift(
  (entry: { dropOffPercent: string }) => entry.dropOffPercent,
);

const liftHistoryView = lift((entries: StageUpdateEntry[] | undefined) =>
  Array.isArray(entries) ? entries : []
);

const liftLastUpdate = lift((entries: StageUpdateEntry[]) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { stageId: "none", label: "None", count: 0, mode: "delta" };
  }
  return entries[entries.length - 1];
});

const updateStageCount = handler(
  (
    event: StageUpdateEvent | undefined,
    context: {
      stages: Cell<FunnelStageInput[]>;
      history: Cell<StageUpdateEntry[]>;
    },
  ) => {
    const stageId = sanitizeStageId(event?.stageId);
    if (!stageId) return;

    const current = sanitizeStages(context.stages.get());
    const index = current.findIndex((entry) => entry.id === stageId);
    if (index === -1) return;

    const value = sanitizeValue(event?.value);
    const delta = sanitizeDelta(event?.delta);

    let nextCount = current[index].count;
    let mode: "delta" | "value" | null = null;

    if (value !== null) {
      nextCount = value;
      mode = "value";
    } else if (delta !== null) {
      nextCount = current[index].count + delta;
      if (nextCount < 0) nextCount = 0;
      mode = "delta";
    }

    if (mode === null || nextCount === current[index].count) return;

    const updated = current.map((stage, position) =>
      position === index ? { ...stage, count: nextCount } : stage
    );
    context.stages.set(updated);

    const historyValue = context.history.get();
    const historyList = Array.isArray(historyValue) ? historyValue : [];
    const trimmed = historyList.slice(-4);
    context.history.set([
      ...trimmed,
      {
        stageId: current[index].id,
        label: current[index].label,
        count: nextCount,
        mode,
      },
    ]);
  },
);

const loadStageSnapshot = handler(
  (
    event: { stages?: FunnelStageInput[] } | undefined,
    context: {
      stages: Cell<FunnelStageInput[]>;
      history: Cell<StageUpdateEntry[]>;
    },
  ) => {
    if (!event?.stages) return;
    const sanitized = sanitizeStages(event.stages);
    context.stages.set(sanitized);
    context.history.set([]);
  },
);

export const funnelAnalytics = pattern<FunnelAnalyticsArgs>(
  ({ stages }) => {
    const updateHistory = cell<StageUpdateEntry[]>([]);

    const stageList = liftSanitizeStages(stages);
    const stageMetrics = liftStageMetrics(stageList);
    const dropOffDetails = liftDropOffDetails(stageMetrics);
    const stageOrder = liftStageOrder(stageMetrics);
    const overallConversionRate = liftOverallConversionRate(stageMetrics);
    const overallConversionPercent = liftOverallConversionPercent(
      overallConversionRate,
    );

    const overallConversionLabel =
      str`Overall conversion ${overallConversionPercent}`;

    const worstStage = liftWorstStage(stageMetrics);
    const worstLabel = liftWorstLabel(worstStage);
    const worstPercent = liftWorstPercent(worstStage);
    const dropOffSummary = str`${worstLabel} drop-off ${worstPercent}`;

    const historyView = liftHistoryView(updateHistory);
    const lastUpdate = liftLastUpdate(historyView);

    return {
      stages,
      stageMetrics,
      dropOffDetails,
      stageOrder,
      overallConversionRate,
      overallConversionPercent,
      overallConversionLabel,
      dropOffSummary,
      updateHistory: historyView,
      lastUpdate,
      updateStage: updateStageCount({ stages, history: updateHistory }),
      loadSnapshot: loadStageSnapshot({ stages, history: updateHistory }),
    };
  },
);

export type {
  FunnelAnalyticsArgs,
  FunnelDropOffDetail,
  FunnelStage,
  StageMetric,
  StageUpdateEntry,
};

export default funnelAnalytics;
