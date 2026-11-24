import { type Cell, Default, handler, lift, pattern } from "commonfabric";

interface SearchResult {
  id: string;
  title: string;
  textScore: number;
  clickRate: number;
  freshness: number;
}

interface SearchWeights {
  text: number;
  clicks: number;
  freshness: number;
}

interface ScoreContributions {
  text: number;
  clicks: number;
  freshness: number;
}

const DEFAULT_WEIGHTS: SearchWeights = {
  text: 0.6,
  clicks: 0.3,
  freshness: 0.1,
};

type WeightDefaults = {
  text: 0.6;
  clicks: 0.3;
  freshness: 0.1;
};

interface SearchRelevanceArgs {
  results: Default<SearchResult[], []>;
  weights: Default<SearchWeights, WeightDefaults>;
}

interface WeightAdjustEvent {
  text?: number;
  clicks?: number;
  freshness?: number;
  textDelta?: number;
  clicksDelta?: number;
  freshnessDelta?: number;
  reset?: boolean;
}

interface ResultMetricEvent {
  id?: string;
  textScore?: number;
  clickRate?: number;
  freshness?: number;
  textDelta?: number;
  clickDelta?: number;
  freshnessDelta?: number;
}

interface ScoredResult {
  id: string;
  title: string;
  score: number;
  contributions: ScoreContributions;
}

const roundValue = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const sanitizeWeightValue = (
  value: unknown,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value <= 0) return 0;
  return roundValue(value);
};

const sanitizeWeights = (input: SearchWeights | undefined): SearchWeights => {
  const source = input ?? DEFAULT_WEIGHTS;
  const text = sanitizeWeightValue(source.text, DEFAULT_WEIGHTS.text);
  const clicks = sanitizeWeightValue(source.clicks, DEFAULT_WEIGHTS.clicks);
  const freshness = sanitizeWeightValue(
    source.freshness,
    DEFAULT_WEIGHTS.freshness,
  );
  const total = text + clicks + freshness;
  if (!Number.isFinite(total) || total <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  return { text, clicks, freshness };
};

const normalizeWeights = (weights: SearchWeights): SearchWeights => {
  const total = weights.text + weights.clicks + weights.freshness;
  if (!Number.isFinite(total) || total <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  const textPortion = roundValue(weights.text / total);
  const clicksPortion = roundValue(weights.clicks / total);
  let freshnessPortion = roundValue(weights.freshness / total);
  const sum = roundValue(textPortion + clicksPortion + freshnessPortion);
  if (sum !== 1) {
    freshnessPortion = roundValue(1 - textPortion - clicksPortion);
  }
  return {
    text: Math.max(0, Math.min(1, textPortion)),
    clicks: Math.max(0, Math.min(1, clicksPortion)),
    freshness: Math.max(0, Math.min(1, freshnessPortion)),
  };
};

const clampFraction = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const bounded = Math.max(0, Math.min(1, value));
  return roundValue(bounded);
};

const sanitizeResultEntry = (
  entry: Partial<SearchResult> | undefined,
  index: number,
): SearchResult => {
  const safeId = typeof entry?.id === "string" && entry.id.trim()
    ? entry.id.trim()
    : `result-${index}`;
  const safeTitle = typeof entry?.title === "string" && entry.title.trim()
    ? entry.title.trim()
    : `Result ${index + 1}`;
  return {
    id: safeId,
    title: safeTitle,
    textScore: clampFraction(entry?.textScore, 0),
    clickRate: clampFraction(entry?.clickRate, 0),
    freshness: clampFraction(entry?.freshness, 0),
  };
};

const sanitizeResults = (
  entries: readonly SearchResult[] | undefined,
): SearchResult[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => sanitizeResultEntry(entry, index));
};

const scoreResult = (
  result: SearchResult,
  weights: SearchWeights,
): ScoredResult => {
  const text = roundValue(result.textScore * weights.text);
  const clicks = roundValue(result.clickRate * weights.clicks);
  const freshness = roundValue(result.freshness * weights.freshness);
  const score = roundValue(text + clicks + freshness);
  return {
    id: result.id,
    title: result.title,
    score,
    contributions: { text, clicks, freshness },
  };
};

const tuneWeightsHandler = handler(
  (
    event: WeightAdjustEvent | undefined,
    context: { weights: Cell<SearchWeights> },
  ) => {
    if (event?.reset) {
      context.weights.set({ ...DEFAULT_WEIGHTS });
      return;
    }

    const current = sanitizeWeights(context.weights.get());
    const next = { ...current };

    const applyAbsolute = (
      key: keyof SearchWeights,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = sanitizeWeightValue(value, next[key]);
    };

    const applyDelta = (
      key: keyof SearchWeights,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = sanitizeWeightValue(next[key] + value, next[key]);
    };

    applyAbsolute("text", event?.text);
    applyAbsolute("clicks", event?.clicks);
    applyAbsolute("freshness", event?.freshness);

    applyDelta("text", event?.textDelta);
    applyDelta("clicks", event?.clicksDelta);
    applyDelta("freshness", event?.freshnessDelta);

    context.weights.set(sanitizeWeights(next));
  },
);

const updateResultMetricsHandler = handler(
  (
    event: ResultMetricEvent | undefined,
    context: { results: Cell<SearchResult[]> },
  ) => {
    const list = sanitizeResults(context.results.get());
    if (list.length === 0) return;

    const fallbackId = list[0].id;
    const targetId = typeof event?.id === "string" && event.id.trim()
      ? event.id.trim()
      : fallbackId;
    const index = list.findIndex((entry) => entry.id === targetId);
    if (index < 0) return;

    const next = { ...list[index] };

    const applyAbsolute = (
      key: keyof Pick<SearchResult, "textScore" | "clickRate" | "freshness">,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = clampFraction(value, next[key]);
    };

    const applyDelta = (
      key: keyof Pick<SearchResult, "textScore" | "clickRate" | "freshness">,
      value: number | undefined,
    ) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      next[key] = clampFraction(next[key] + value, next[key]);
    };

    applyAbsolute("textScore", event?.textScore);
    applyAbsolute("clickRate", event?.clickRate);
    applyAbsolute("freshness", event?.freshness);

    applyDelta("textScore", event?.textDelta);
    applyDelta("clickRate", event?.clickDelta);
    applyDelta("freshness", event?.freshnessDelta);

    const updated = list.map((entry, position) =>
      position === index ? next : entry
    );
    context.results.set(updated);
  },
);

// Module-scope lift definitions
const liftSanitizeResults = lift(sanitizeResults);
const liftSanitizeWeights = lift(sanitizeWeights);
const liftNormalizeWeights = lift(normalizeWeights);

const liftRankedResults = lift((input: {
  results: SearchResult[];
  weights: SearchWeights;
}): ScoredResult[] => {
  const scored = input.results.map((entry) =>
    scoreResult(entry, input.weights)
  );
  return scored.sort((a, b) => {
    if (b.score === a.score) return a.id.localeCompare(b.id);
    return b.score - a.score;
  });
});

const liftRelevanceOrder = lift((entries: ScoredResult[]) =>
  entries.map((entry) => entry.id)
);

const liftScoreSample = lift((entries: ScoredResult[]) =>
  entries.map((entry) => `${entry.title}: ${entry.score.toFixed(3)}`)
);

const liftTopResult = lift((entries: ScoredResult[]) => entries[0] ?? null);

const liftTopTitle = lift((entry: ScoredResult | null) =>
  entry?.title ?? "(none)"
);

const liftTopScore = lift((entry: ScoredResult | null) =>
  entry ? entry.score.toFixed(3) : "0.000"
);

const liftWeightSummary = lift((values: SearchWeights) => {
  const textPortion = values.text.toFixed(3);
  const clicksPortion = values.clicks.toFixed(3);
  const freshnessPortion = values.freshness.toFixed(3);
  return "Weights text " + textPortion + " | clicks " + clicksPortion +
    " | freshness " + freshnessPortion;
});

const liftContributionSummary = lift((entry: ScoredResult | null) => {
  if (!entry) return "text 0.000 | clicks 0.000 | freshness 0.000";
  const parts = entry.contributions;
  return "text " + parts.text.toFixed(3) + " | clicks " +
    parts.clicks.toFixed(3) + " | freshness " +
    parts.freshness.toFixed(3);
});

const liftScoreSummary = lift((input: {
  title: string;
  score: string;
  weights: string;
}) => `${input.title} leads at ${input.score} with ${input.weights}`);

export const searchRelevanceTuning = pattern<SearchRelevanceArgs>(
  ({ results, weights }) => {
    const sanitizedResults = liftSanitizeResults(results);
    const sanitizedWeights = liftSanitizeWeights(weights);
    const normalizedWeights = liftNormalizeWeights(sanitizedWeights);

    const scoringInputs = {
      results: sanitizedResults,
      weights: normalizedWeights,
    };

    const rankedResults = liftRankedResults(scoringInputs);

    const relevanceOrder = liftRelevanceOrder(rankedResults);

    const scoreSample = liftScoreSample(rankedResults);

    const topResult = liftTopResult(rankedResults);

    const topTitle = liftTopTitle(topResult);

    const topScore = liftTopScore(topResult);

    const weightSummary = liftWeightSummary(normalizedWeights);

    const contributionSummary = liftContributionSummary(topResult);

    const scoreSummary = liftScoreSummary({
      title: topTitle,
      score: topScore,
      weights: weightSummary,
    });

    return {
      results,
      weights,
      sanitizedResults,
      sanitizedWeights,
      normalizedWeights,
      rankedResults,
      relevanceOrder,
      scoreSample,
      topResult,
      topTitle,
      topScore,
      weightSummary,
      contributionSummary,
      scoreSummary,
      tuneWeights: tuneWeightsHandler({ weights }),
      updateResult: updateResultMetricsHandler({ results }),
    };
  },
);

export default searchRelevanceTuning;
