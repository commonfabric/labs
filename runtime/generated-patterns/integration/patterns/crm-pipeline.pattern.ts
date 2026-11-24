import {
  type Cell,
  cell,
  computed,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface StageConfigInput {
  id?: string;
  label?: string;
  probability?: number;
}

interface StageConfig {
  id: string;
  label: string;
  probability: number;
}

interface DealInput {
  id?: string;
  name?: string;
  stage?: string;
  amount?: number;
}

interface DealState {
  id: string;
  name: string;
  stage: string;
  amount: number;
}

interface DealEvent {
  id?: string;
  name?: string;
  stage?: string;
  amount?: number;
  delta?: number;
}

interface StageProbabilityEvent {
  stage?: string;
  probability?: number;
}

interface AdvanceEvent {
  id?: string;
  direction?: number;
}

interface StageStat {
  id: string;
  label: string;
  probability: number;
  totalAmount: number;
  forecastAmount: number;
  dealCount: number;
  share: number;
}

interface StageTotals {
  stats: StageStat[];
  openTotal: number;
  weightedTotal: number;
}

interface PipelineArgs {
  deals: Default<DealInput[], []>;
  stages: Default<StageConfigInput[], []>;
  defaultAmount: Default<number, 1000>;
}

const defaultStages: StageConfig[] = [
  { id: "prospect", label: "Prospect", probability: 0.2 },
  { id: "qualified", label: "Qualified", probability: 0.4 },
  { id: "proposal", label: "Proposal", probability: 0.6 },
  { id: "negotiation", label: "Negotiation", probability: 0.8 },
  { id: "closed-won", label: "Closed Won", probability: 1 },
];

const formatLabel = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const clampProbability = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = Math.min(Math.max(value, 0), 1);
  return Math.round(clamped * 100) / 100;
};

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeStageConfigs = (input: unknown): StageConfig[] => {
  if (!Array.isArray(input)) {
    return defaultStages.map((stage) => ({ ...stage }));
  }

  const seen = new Set<string>();
  const sanitized: StageConfig[] = [];
  for (let index = 0; index < input.length; index++) {
    const raw = input[index] as StageConfigInput | undefined;
    const fallbackId = `stage-${index + 1}`;
    const id = formatLabel(raw?.id, fallbackId).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const labelFallback = raw?.label ?? id.replace(/-/g, " ");
    const label = formatLabel(labelFallback, id.toUpperCase());
    const defaultProbability = defaultStages[index]?.probability ?? 0;
    const probability = clampProbability(
      raw?.probability,
      defaultProbability,
    );
    sanitized.push({ id, label, probability });
  }

  if (sanitized.length === 0) {
    return defaultStages.map((stage) => ({ ...stage }));
  }

  return sanitized;
};

const ensureStages = (
  stages: readonly StageConfig[] | undefined,
): StageConfig[] => {
  if (Array.isArray(stages) && stages.length > 0) {
    return stages.map((stage) => ({ ...stage }));
  }
  return defaultStages.map((stage) => ({ ...stage }));
};

const sanitizeAmount = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return roundCurrency(Math.max(fallback, 0));
  }
  return roundCurrency(Math.max(input, 0));
};

const sanitizeDealName = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeDealStage = (
  input: unknown,
  stages: readonly StageConfig[],
  fallbackStage: string,
): string => {
  if (typeof input === "string") {
    const candidate = input.trim().toLowerCase();
    if (stages.some((stage) => stage.id === candidate)) {
      return candidate;
    }
  }
  return fallbackStage;
};

const sanitizeDeals = (
  input: unknown,
  stages: readonly StageConfig[],
): DealState[] => {
  if (!Array.isArray(input)) return [];
  const sanitized: DealState[] = [];
  const fallbackStage = stages[0]?.id ?? defaultStages[0].id;

  for (let index = 0; index < input.length; index++) {
    const raw = input[index] as DealInput | undefined;
    const id = formatLabel(raw?.id, `deal-${index + 1}`).toLowerCase();
    const name = sanitizeDealName(raw?.name, `Deal ${index + 1}`);
    const stage = sanitizeDealStage(raw?.stage, stages, fallbackStage);
    const amount = sanitizeAmount(raw?.amount, 0);
    sanitized.push({ id, name, stage, amount });
  }

  sanitized.sort((left, right) => {
    const leftOrder = stages.findIndex((stage) => stage.id === left.stage);
    const rightOrder = stages.findIndex((stage) => stage.id === right.stage);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.name.localeCompare(right.name);
  });

  return sanitized;
};

const generateDealId = (
  deals: readonly DealState[],
  idSeed: Cell<number>,
): string => {
  const used = new Set(deals.map((deal) => deal.id));
  let seed = (idSeed.get() ?? deals.length) + 1;
  let candidate = `deal-${seed}`;
  while (used.has(candidate)) {
    seed += 1;
    candidate = `deal-${seed}`;
  }
  idSeed.set(seed);
  return candidate;
};

const toDealInputs = (deals: readonly DealState[]): DealInput[] => {
  return deals.map((deal) => ({
    id: deal.id,
    name: deal.name,
    stage: deal.stage,
    amount: deal.amount,
  }));
};

const computeStageTotals = (
  stages: readonly StageConfig[],
  deals: readonly DealState[],
): StageTotals => {
  const stats: StageStat[] = stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    probability: roundCurrency(stage.probability),
    totalAmount: 0,
    forecastAmount: 0,
    dealCount: 0,
    share: 0,
  }));

  const indexById = new Map<string, number>();
  for (let index = 0; index < stats.length; index++) {
    indexById.set(stats[index].id, index);
  }

  for (const deal of deals) {
    const index = indexById.get(deal.stage) ?? 0;
    const stage = stats[index];
    stage.totalAmount = roundCurrency(stage.totalAmount + deal.amount);
    stage.dealCount += 1;
  }

  let openTotal = 0;
  let weightedTotal = 0;

  for (const entry of stats) {
    openTotal += entry.totalAmount;
    entry.forecastAmount = roundCurrency(entry.totalAmount * entry.probability);
    weightedTotal += entry.forecastAmount;
  }

  const safeWeighted = roundCurrency(weightedTotal);
  for (const entry of stats) {
    if (safeWeighted === 0) {
      entry.share = 0;
    } else {
      entry.share = roundCurrency(entry.forecastAmount / safeWeighted);
    }
  }

  return {
    stats,
    weightedTotal: safeWeighted,
    openTotal: roundCurrency(openTotal),
  };
};

const buildForecastRecord = (
  stats: readonly StageStat[],
): Record<string, number> => {
  const record: Record<string, number> = {};
  for (const entry of stats) {
    record[entry.id] = entry.forecastAmount;
  }
  return record;
};

const formatCurrency = (value: number | undefined): string => {
  const safeValue = typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
  return safeValue.toFixed(2);
};

const formatStageCount = (count: number | undefined): string => {
  const value = typeof count === "number" ? Math.max(count, 0) : 0;
  const rounded = Math.round(value);
  const suffix = rounded === 1 ? "stage" : "stages";
  return `${rounded} ${suffix}`;
};

const recordDeal = handler(
  (
    event: DealEvent | undefined,
    context: {
      deals: Cell<DealInput[]>;
      sanitizedStages: Cell<StageConfig[]>;
      defaultAmount: Cell<number>;
      idSeed: Cell<number>;
      lastAction: Cell<string>;
    },
  ) => {
    const stages = ensureStages(context.sanitizedStages.get());
    const fallbackStage = stages[0]?.id ?? defaultStages[0].id;
    const deals = sanitizeDeals(context.deals.get(), stages);
    const defaultAmount = sanitizeAmount(context.defaultAmount.get(), 1000) ||
      1000;

    const requestedId = formatLabel(event?.id, "").toLowerCase();
    const existingIndex = requestedId.length > 0
      ? deals.findIndex((deal) => deal.id === requestedId)
      : -1;

    let targetId = requestedId;
    if (existingIndex === -1 && targetId.length === 0) {
      targetId = generateDealId(deals, context.idSeed);
    } else if (existingIndex === -1 && targetId.length > 0) {
      const used = new Set(deals.map((deal) => deal.id));
      if (used.has(targetId)) {
        context.lastAction.set(`duplicate-id ${targetId}`);
        return;
      }
    }

    const fallbackName = existingIndex >= 0
      ? deals[existingIndex].name
      : `Deal ${deals.length + 1}`;
    const name = sanitizeDealName(event?.name, fallbackName);

    const delta = typeof event?.delta === "number" &&
        Number.isFinite(event.delta)
      ? event.delta
      : 0;
    const sanitizedDelta = roundCurrency(delta);
    const absoluteAmount = sanitizeAmount(event?.amount, defaultAmount);

    const nextStage = sanitizeDealStage(
      event?.stage,
      stages,
      existingIndex >= 0 ? deals[existingIndex].stage : fallbackStage,
    );

    if (existingIndex >= 0) {
      const current = deals[existingIndex];
      const nextAmount = event?.amount !== undefined
        ? absoluteAmount
        : roundCurrency(Math.max(current.amount + sanitizedDelta, 0));
      deals[existingIndex] = {
        id: current.id,
        name,
        stage: nextStage,
        amount: nextAmount,
      };
    } else {
      const startingAmount = event?.amount !== undefined
        ? absoluteAmount
        : roundCurrency(Math.max(defaultAmount + sanitizedDelta, 0));
      deals.push({
        id: targetId,
        name,
        stage: nextStage,
        amount: startingAmount,
      });
    }

    deals.sort((left, right) => {
      const leftOrder = stages.findIndex((stage) => stage.id === left.stage);
      const rightOrder = stages.findIndex((stage) => stage.id === right.stage);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.name.localeCompare(right.name);
    });

    context.deals.set(toDealInputs(deals));
    context.lastAction.set(`record:${targetId || deals[existingIndex]?.id}`);
  },
);

const advanceDealStage = handler(
  (
    event: AdvanceEvent | undefined,
    context: {
      deals: Cell<DealInput[]>;
      sanitizedStages: Cell<StageConfig[]>;
      lastAction: Cell<string>;
    },
  ) => {
    const stages = ensureStages(context.sanitizedStages.get());
    if (stages.length === 0) return;
    const deals = sanitizeDeals(context.deals.get(), stages);
    const targetId = formatLabel(event?.id, "").toLowerCase();
    if (targetId.length === 0) return;
    const index = deals.findIndex((deal) => deal.id === targetId);
    if (index === -1) return;

    const directionRaw = typeof event?.direction === "number" &&
        Number.isFinite(event.direction)
      ? Math.trunc(event.direction)
      : 1;
    const direction = directionRaw === 0 ? 1 : Math.sign(directionRaw);

    const currentStageIndex = stages.findIndex((stage) =>
      stage.id === deals[index].stage
    );
    const nextIndex = Math.min(
      Math.max(currentStageIndex + direction, 0),
      stages.length - 1,
    );
    const nextStage = stages[nextIndex]?.id ?? deals[index].stage;
    deals[index] = {
      ...deals[index],
      stage: nextStage,
    };

    deals.sort((left, right) => {
      const leftOrder = stages.findIndex((stage) => stage.id === left.stage);
      const rightOrder = stages.findIndex((stage) => stage.id === right.stage);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.name.localeCompare(right.name);
    });

    context.deals.set(toDealInputs(deals));
    context.lastAction.set(`advance:${targetId}:${nextStage}`);
  },
);

const adjustStageProbability = handler(
  (
    event: StageProbabilityEvent | undefined,
    context: {
      stages: Cell<StageConfigInput[]>;
      sanitizedStages: Cell<StageConfig[]>;
      lastAction: Cell<string>;
    },
  ) => {
    const stages = ensureStages(context.sanitizedStages.get());
    const stageId = sanitizeDealStage(event?.stage, stages, stages[0].id);
    const probability = clampProbability(event?.probability, 0);

    const nextStages = stages.map((stage) =>
      stage.id === stageId ? { ...stage, probability } : stage
    );

    context.stages.set(nextStages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      probability: stage.probability,
    })));

    context.lastAction.set(`adjust:${stageId}:${probability.toFixed(2)}`);
  },
);

const liftSanitizeStageConfigs = lift((value: StageConfigInput[] | undefined) =>
  sanitizeStageConfigs(value)
);

const liftSanitizeDefaultAmount = lift((value: number | undefined) => {
  const sanitized = sanitizeAmount(value, 1000);
  return sanitized === 0 ? 1000 : sanitized;
});

const liftFormatCurrency = lift(formatCurrency);
const liftFormatStageCount = lift(formatStageCount);

export const crmPipeline = pattern<PipelineArgs>(
  ({ deals, stages, defaultAmount }) => {
    const lastAction = cell("none");
    const idSeed = cell(0);

    const stageList = liftSanitizeStageConfigs(stages);

    const defaultAmountValue = liftSanitizeDefaultAmount(defaultAmount);

    const dealView = computed(() => {
      const stagesValue = ensureStages(stageList);
      return sanitizeDeals(deals, stagesValue);
    });

    const totals = computed(() => {
      const stagesValue = ensureStages(stageList);
      const dealsValue = Array.isArray(dealView) ? dealView : [];
      const result = computeStageTotals(stagesValue, dealsValue);
      return result;
    });

    const stageStats = totals.stats;
    const totalForecast = totals.weightedTotal;
    const openPipeline = totals.openTotal;
    const stageForecastRecord = buildForecastRecord(stageStats);
    const stageCount = stageStats.length;
    const dealCount = dealView.length;

    const formattedForecast = liftFormatCurrency(totalForecast);
    const formattedOpen = liftFormatCurrency(openPipeline);
    const formattedStageCount = liftFormatStageCount(stageCount);
    const summaryLabel =
      str`${formattedStageCount} forecast ${formattedForecast} open ${formattedOpen}`;

    const record = recordDeal({
      deals,
      sanitizedStages: stageList,
      defaultAmount: defaultAmountValue,
      idSeed,
      lastAction,
    });

    const advance = advanceDealStage({
      deals,
      sanitizedStages: stageList,
      lastAction,
    });

    const adjust = adjustStageProbability({
      stages,
      sanitizedStages: stageList,
      lastAction,
    });

    return {
      stages: stageList,
      deals: dealView,
      totals,
      stageStats,
      totalForecast,
      openPipeline,
      stageForecastRecord,
      stageCount,
      dealCount,
      summaryLabel,
      lastAction,
      controls: {
        record,
        advance,
        adjust,
      },
    };
  },
);

export type { DealEvent, StageProbabilityEvent };

export default crmPipeline;
