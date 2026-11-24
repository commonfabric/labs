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

interface LeadInput {
  id?: string;
  name?: string;
  base?: number;
  signals?: Record<string, number>;
}

interface SignalWeightInput {
  signal?: string;
  label?: string;
  weight?: number;
}

const defaultSignalWeights: SignalWeightInput[] = [
  { signal: "engagement", label: "Engagement", weight: 2 },
  { signal: "fit", label: "Product Fit", weight: 3 },
  { signal: "timing", label: "Timing", weight: 1 },
];

interface LeadScoringArgs {
  leads: Default<LeadInput[], []>;
  signalWeights: Default<
    SignalWeightInput[],
    typeof defaultSignalWeights
  >;
  defaultWeight: Default<number, 1>;
}

interface LeadState {
  id: string;
  name: string;
  base: number;
  signals: Record<string, number>;
}

interface SignalWeightState {
  signal: string;
  label: string;
  weight: number;
}

interface LeadSignalBreakdown {
  signal: string;
  label: string;
  count: number;
  weight: number;
  contribution: number;
}

interface LeadScoreSummary extends LeadState {
  score: number;
  signalBreakdown: LeadSignalBreakdown[];
}

interface SignalAggregate {
  signal: string;
  label: string;
  totalCount: number;
  weightedTotal: number;
}

interface SignalMutationEvent {
  leadId?: string;
  signal?: string;
  delta?: number;
  set?: number;
  weight?: number;
  label?: string;
}

const roundTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const sanitizeLabel = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const slugify = (value: string, fallback: string): string => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
};

const normalizeName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const ensureUniqueId = (
  id: string,
  used: Set<string>,
  fallback: string,
): string => {
  let candidate = id.length > 0 ? id : fallback;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${id}-${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
};

const buildSignalLabel = (value: string): string => {
  return value.split("-").map((part) => {
    const head = part.charAt(0).toUpperCase();
    return `${head}${part.slice(1)}`;
  }).join(" ");
};

const sanitizeSignalKey = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return slugify(trimmed, fallback);
    }
  }
  return fallback;
};

const sanitizeWeightValue = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundTwo(Math.max(fallback, 0));
  }
  return roundTwo(Math.max(value, 0));
};

const sanitizeCountValue = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundTwo(Math.max(fallback, 0));
  }
  return roundTwo(Math.max(value, 0));
};

const sanitizeDeltaValue = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundTwo(fallback);
  }
  return roundTwo(value);
};

const sanitizeSignalRecord = (
  input: Record<string, number> | undefined,
): Record<string, number> => {
  if (!input) return {};
  const sanitized: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const fallbackKey = rawKey.length > 0
      ? slugify(rawKey, "signal")
      : "signal";
    const signal = sanitizeSignalKey(rawKey, fallbackKey);
    if (signal.length === 0) continue;
    const value = sanitizeCountValue(rawValue, 0);
    if (value <= 0) continue;
    sanitized[signal] = value;
  }
  const sortedKeys = Object.keys(sanitized).sort();
  const result: Record<string, number> = {};
  for (const key of sortedKeys) {
    result[key] = sanitizeCountValue(sanitized[key], 0);
  }
  return result;
};

const sanitizeLeadList = (
  input: readonly LeadInput[] | undefined,
): LeadState[] => {
  if (!Array.isArray(input)) return [];
  const sanitized: LeadState[] = [];
  const used = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    const fallbackName = `Lead ${index + 1}`;
    const name = normalizeName(raw?.name, fallbackName);
    const fallbackId = slugify(fallbackName, `lead-${index + 1}`);
    const idSource = typeof raw?.id === "string" && raw.id.length > 0
      ? raw.id
      : name;
    const id = ensureUniqueId(
      slugify(idSource, fallbackId),
      used,
      fallbackId,
    );
    const base = sanitizeCountValue(raw?.base, 0);
    sanitized.push({
      id,
      name,
      base,
      signals: sanitizeSignalRecord(raw?.signals),
    });
  }
  sanitized.sort((left, right) => left.name.localeCompare(right.name));
  return sanitized;
};

const sanitizeSignalWeights = (
  input: readonly SignalWeightInput[] | undefined,
  fallbackWeight: number,
): SignalWeightState[] => {
  const source = Array.isArray(input) && input.length > 0
    ? input
    : defaultSignalWeights;
  const sanitized: SignalWeightState[] = [];
  const used = new Set<string>();
  for (let index = 0; index < source.length; index++) {
    const raw = source[index];
    const fallbackSignal = `signal-${index + 1}`;
    const candidate = raw?.signal ?? raw?.label ?? fallbackSignal;
    const signal = sanitizeSignalKey(candidate, fallbackSignal);
    if (signal.length === 0 || used.has(signal)) continue;
    used.add(signal);
    const label = sanitizeLabel(
      raw?.label,
      buildSignalLabel(signal),
    );
    const weight = sanitizeWeightValue(raw?.weight, fallbackWeight);
    sanitized.push({ signal, label, weight });
  }
  if (sanitized.length === 0) {
    return sanitizeSignalWeights(defaultSignalWeights, fallbackWeight);
  }
  sanitized.sort((left, right) => left.label.localeCompare(right.label));
  return sanitized;
};

const computeWeightRecord = (
  weights: readonly SignalWeightState[],
): Record<string, SignalWeightState> => {
  const record: Record<string, SignalWeightState> = {};
  for (const entry of weights) {
    record[entry.signal] = entry;
  }
  return record;
};

const computeLeadSummaries = (
  leads: readonly LeadState[],
  weights: Record<string, SignalWeightState>,
  fallbackWeight: number,
): LeadScoreSummary[] => {
  const known = new Set<string>();
  for (const entry of Object.keys(weights)) {
    known.add(entry);
  }
  for (const lead of leads) {
    for (const key of Object.keys(lead.signals)) {
      known.add(key);
    }
  }
  const orderedSignals = Array.from(known.values()).sort();
  const summaries: LeadScoreSummary[] = [];
  const sanitizedFallback = sanitizeWeightValue(fallbackWeight, 1);
  for (const lead of leads) {
    const breakdown: LeadSignalBreakdown[] = [];
    let score = sanitizeCountValue(lead.base, 0);
    for (const key of orderedSignals) {
      const count = sanitizeCountValue(lead.signals[key], 0);
      if (count <= 0) continue;
      const match = weights[key];
      const weight = match
        ? sanitizeWeightValue(match.weight, sanitizedFallback)
        : sanitizedFallback;
      const label = match
        ? sanitizeLabel(match.label, buildSignalLabel(key))
        : buildSignalLabel(key);
      const contribution = roundTwo(count * weight);
      breakdown.push({ signal: key, label, count, weight, contribution });
      score = roundTwo(score + contribution);
    }
    summaries.push({
      id: lead.id,
      name: lead.name,
      base: sanitizeCountValue(lead.base, 0),
      signals: { ...lead.signals },
      score,
      signalBreakdown: breakdown,
    });
  }
  summaries.sort((left, right) => {
    const delta = roundTwo(right.score - left.score);
    if (Math.abs(delta) > 0.001) return delta > 0 ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
  return summaries;
};

const aggregateSignalTotals = (
  summaries: readonly LeadScoreSummary[],
): SignalAggregate[] => {
  const totals = new Map<string, SignalAggregate>();
  for (const summary of summaries) {
    for (const entry of summary.signalBreakdown) {
      const existing = totals.get(entry.signal);
      if (existing) {
        existing.totalCount = roundTwo(existing.totalCount + entry.count);
        existing.weightedTotal = roundTwo(
          existing.weightedTotal + entry.contribution,
        );
      } else {
        totals.set(entry.signal, {
          signal: entry.signal,
          label: entry.label,
          totalCount: entry.count,
          weightedTotal: entry.contribution,
        });
      }
    }
  }
  const list = Array.from(totals.values());
  list.sort((left, right) => left.label.localeCompare(right.label));
  return list;
};

const formatDecimal = (value: number): string => {
  return roundTwo(value).toFixed(2);
};

const applySignalMutation = handler(
  (
    event: SignalMutationEvent | undefined,
    context: {
      leads: Cell<LeadInput[]>;
      weights: Cell<SignalWeightInput[]>;
      defaultWeight: Cell<number>;
      history: Cell<string[]>;
      lastMutation: Cell<string>;
      sequence: Cell<number>;
    },
  ) => {
    const fallbackWeight = sanitizeWeightValue(
      context.defaultWeight.get(),
      1,
    );
    const leads = sanitizeLeadList(context.leads.get());
    const weights = sanitizeSignalWeights(
      context.weights.get(),
      fallbackWeight,
    );

    const signalFallback = `signal-${weights.length + 1}`;
    const signalKey = sanitizeSignalKey(
      event?.signal,
      signalFallback,
    );
    if (signalKey.length === 0) {
      context.lastMutation.set("ignored missing-signal");
      return;
    }

    const leadId = sanitizeSignalKey(event?.leadId, "");
    const targetIndex = leadId.length > 0
      ? leads.findIndex((lead) => lead.id === leadId)
      : -1;
    if (targetIndex < 0) {
      context.lastMutation.set(`${signalKey} missing-lead`);
      return;
    }

    const delta = sanitizeDeltaValue(event?.delta, 0);
    const hasOverride = typeof event?.set === "number" &&
      Number.isFinite(event.set);
    const override = hasOverride
      ? sanitizeCountValue(event?.set, 0)
      : undefined;
    const proposedWeight = typeof event?.weight === "number"
      ? sanitizeWeightValue(event.weight, fallbackWeight)
      : undefined;
    const hasLabelOverride = typeof event?.label === "string" &&
      event.label.trim().length > 0;
    const overrideLabel = hasLabelOverride
      ? sanitizeLabel(event?.label, buildSignalLabel(signalKey))
      : undefined;

    const nextLeads = leads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      base: lead.base,
      signals: { ...lead.signals },
    }));
    const target = nextLeads[targetIndex];
    const currentCount = sanitizeCountValue(target.signals[signalKey], 0);
    let nextCount = currentCount;
    if (override !== undefined) {
      nextCount = override;
    } else if (delta !== 0) {
      nextCount = sanitizeCountValue(currentCount + delta, currentCount);
    }
    const sanitizedNext = sanitizeCountValue(nextCount, 0);
    let leadChanged = false;
    if (sanitizedNext <= 0) {
      if (signalKey in target.signals) {
        delete target.signals[signalKey];
        leadChanged = true;
      }
    } else if (Math.abs(sanitizedNext - currentCount) > 0.001) {
      target.signals[signalKey] = sanitizedNext;
      leadChanged = true;
    }

    const nextWeights = weights.map((entry) => ({ ...entry }));
    const weightIndex = nextWeights.findIndex((entry) =>
      entry.signal === signalKey
    );
    let weightsChanged = false;
    const resolvedWeight = proposedWeight ??
      nextWeights[weightIndex]?.weight ??
      fallbackWeight;
    if (weightIndex >= 0) {
      const existing = nextWeights[weightIndex];
      const nextWeight = sanitizeWeightValue(resolvedWeight, fallbackWeight);
      const nextLabel = hasLabelOverride
        ? overrideLabel ?? existing.label
        : existing.label;
      if (
        Math.abs(nextWeight - existing.weight) > 0.001 ||
        nextLabel !== existing.label
      ) {
        nextWeights[weightIndex] = {
          signal: signalKey,
          label: nextLabel,
          weight: nextWeight,
        };
        weightsChanged = true;
      }
    } else {
      nextWeights.push({
        signal: signalKey,
        label: overrideLabel ?? buildSignalLabel(signalKey),
        weight: sanitizeWeightValue(resolvedWeight, fallbackWeight),
      });
      weightsChanged = true;
    }

    if (!leadChanged && !weightsChanged) {
      context.lastMutation.set(`${leadId}>${signalKey} noop`);
      return;
    }

    const leadPayload = nextLeads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      base: lead.base,
      signals: { ...lead.signals },
    }));
    context.leads.set(leadPayload);

    nextWeights.sort((left, right) => left.label.localeCompare(right.label));
    context.weights.set(nextWeights.map((entry) => ({
      signal: entry.signal,
      label: entry.label,
      weight: entry.weight,
    })));

    const descriptor: string[] = [];
    if (override !== undefined) {
      descriptor.push(`=${formatDecimal(sanitizedNext)}`);
    } else if (leadChanged && delta !== 0) {
      const prefix = delta > 0 ? "+" : "";
      descriptor.push(`${prefix}${formatDecimal(delta)}`);
    }
    if (weightsChanged && proposedWeight !== undefined) {
      descriptor.push(`w=${formatDecimal(proposedWeight)}`);
    }
    const message = `${leadId}>${signalKey} ${
      descriptor.length > 0 ? descriptor.join(" ") : "updated"
    }`;

    const history = Array.isArray(context.history.get())
      ? [...(context.history.get() ?? [])]
      : [];
    history.push(message);
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }
    context.history.set(history);
    context.lastMutation.set(message);
    context.sequence.set(context.sequence.get() + 1);
  },
);

// Module-scope lift definitions
const liftSanitizedDefaultWeight = lift((value: number | undefined) =>
  sanitizeWeightValue(value, 1)
);

const liftSanitizedLeads = lift((value: LeadInput[] | undefined) =>
  sanitizeLeadList(value)
);

const liftSanitizedWeights = lift((
  input: {
    weights: SignalWeightInput[] | undefined;
    fallback: number;
  },
) => sanitizeSignalWeights(input.weights, input.fallback));

const liftWeightRecord = lift(
  (list: SignalWeightState[] | undefined) =>
    computeWeightRecord(Array.isArray(list) ? list : []),
);

const liftLeadSummaries = lift((
  input: {
    leads: LeadState[] | undefined;
    weightMap: Record<string, SignalWeightState>;
    fallback: number;
  },
) => {
  const leadList = Array.isArray(input.leads) ? input.leads : [];
  return computeLeadSummaries(
    leadList,
    input.weightMap,
    input.fallback,
  );
});

const liftSignalSummary = lift((list: LeadScoreSummary[] | undefined) =>
  aggregateSignalTotals(Array.isArray(list) ? list : [])
);

const liftScoreByLead = lift((list: LeadScoreSummary[] | undefined) => {
  const record: Record<string, number> = {};
  for (const entry of list ?? []) {
    record[entry.id] = entry.score;
  }
  return record;
});

const liftTotalScore = lift((list: LeadScoreSummary[] | undefined) => {
  let total = 0;
  for (const entry of list ?? []) {
    total = roundTwo(total + entry.score);
  }
  return total;
});

const liftLeadCount = lift((list: LeadScoreSummary[] | undefined) =>
  Array.isArray(list) ? list.length : 0
);

const liftSignalCount = lift((list: SignalAggregate[] | undefined) =>
  Array.isArray(list) ? list.length : 0
);

const liftTopScoreLabel = lift((value: number | undefined) =>
  formatDecimal(typeof value === "number" ? value : 0)
);

const liftLastMutationView = lift((value: string | undefined) => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return "none";
});

const liftHistoryView = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? [...entries] : []
);

export const leadScoring = pattern<LeadScoringArgs>(
  ({ leads, signalWeights, defaultWeight }) => {
    const history = cell<string[]>([]);
    const lastMutation = cell("none");
    const sequence = cell(0);

    const sanitizedDefaultWeight = liftSanitizedDefaultWeight(defaultWeight);

    const sanitizedLeads = liftSanitizedLeads(leads);

    const sanitizedWeights = liftSanitizedWeights({
      weights: signalWeights,
      fallback: sanitizedDefaultWeight,
    });

    const weightRecord = liftWeightRecord(sanitizedWeights);

    const leadSummaries = liftLeadSummaries({
      leads: sanitizedLeads,
      weightMap: weightRecord,
      fallback: sanitizedDefaultWeight,
    });

    const signalSummary = liftSignalSummary(leadSummaries);

    const scoreByLead = liftScoreByLead(leadSummaries);

    const totalScore = liftTotalScore(leadSummaries);

    const signalTotals = computed(() => {
      const record: Record<string, number> = {};
      for (const entry of signalSummary) {
        record[entry.signal] = entry.totalCount;
      }
      return record;
    });

    const weightedSignalTotals = computed(() => {
      const record: Record<string, number> = {};
      for (const entry of signalSummary) {
        record[entry.signal] = entry.weightedTotal;
      }
      return record;
    });

    const leadCount = liftLeadCount(leadSummaries);

    const signalCount = liftSignalCount(signalSummary);

    const topLeadName = leadSummaries.length > 0
      ? leadSummaries[0].name
      : "none";

    const topLeadScore = leadSummaries.length > 0 ? leadSummaries[0].score : 0;

    const topScoreLabel = liftTopScoreLabel(topLeadScore);

    const summaryLabel =
      str`${leadCount} leads scored; top ${topLeadName} ${topScoreLabel} across ${signalCount} signals`;

    const lastMutationView = liftLastMutationView(lastMutation);

    const historyView = liftHistoryView(history);

    const mutationControls = {
      applySignal: applySignalMutation({
        leads,
        weights: signalWeights,
        defaultWeight: sanitizedDefaultWeight,
        history,
        lastMutation,
        sequence,
      }),
    };

    return {
      leads: sanitizedLeads,
      signalWeights: sanitizedWeights,
      leaderboard: leadSummaries,
      scoreByLead,
      totalScore,
      signalSummary,
      signalTotals,
      weightedSignalTotals,
      leadCount,
      signalCount,
      topLead: topLeadName,
      topScore: topLeadScore,
      summaryLabel,
      lastMutation: lastMutationView,
      history: historyView,
      controls: mutationControls,
    };
  },
);

export type {
  LeadInput,
  LeadScoreSummary,
  LeadScoringArgs,
  SignalAggregate,
  SignalWeightInput,
};

export default leadScoring;
