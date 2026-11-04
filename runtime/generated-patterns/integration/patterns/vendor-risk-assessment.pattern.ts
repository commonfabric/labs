import { type Cell, cell, Default, handler, lift, pattern } from "commonfabric";

type RiskTier = "low" | "medium" | "high";

interface VendorResponseInput {
  topic?: string;
  rating?: number;
  weight?: number;
}

interface VendorInput {
  id?: string;
  name?: string;
  category?: string;
  responses?: VendorResponseInput[];
}

interface ResponseRecord {
  topic: string;
  rating: number;
  weight: number;
}

interface VendorRecord {
  id: string;
  name: string;
  category: string;
  responses: ResponseRecord[];
}

interface ThresholdState {
  medium: number;
  high: number;
}

interface ResponseBreakdown extends ResponseRecord {
  contribution: number;
}

interface VendorRiskSummary {
  id: string;
  name: string;
  category: string;
  total: number;
  tier: RiskTier;
  breakdown: ResponseBreakdown[];
}

interface TierCounts {
  high: number;
  medium: number;
  low: number;
}

interface TierEntry {
  tier: RiskTier;
  vendors: {
    id: string;
    name: string;
    score: number;
  }[];
}

interface ResponseAdjustmentEvent {
  vendorId?: string;
  topic?: string;
  rating?: number;
  weight?: number;
  category?: string;
  name?: string;
}

interface VendorRiskAssessmentArgs {
  vendors: Default<VendorInput[], typeof defaultVendors>;
}

const baselineThresholds: ThresholdState = {
  medium: 50,
  high: 80,
};

const defaultVendors: VendorRecord[] = [
  {
    id: "vendor-apex-cloud",
    name: "Apex Cloud",
    category: "Infrastructure",
    responses: [
      { topic: "compliance", rating: 15, weight: 1 },
      { topic: "financial", rating: 12, weight: 1 },
      { topic: "security", rating: 30, weight: 2 },
    ],
  },
  {
    id: "vendor-data-harbor",
    name: "Data Harbor",
    category: "Analytics",
    responses: [
      { topic: "compliance", rating: 22, weight: 1 },
      { topic: "financial", rating: 10, weight: 1 },
      { topic: "security", rating: 18, weight: 1 },
    ],
  },
  {
    id: "vendor-orbita-supplies",
    name: "Orbita Supplies",
    category: "Hardware",
    responses: [
      { topic: "compliance", rating: 8, weight: 1 },
      { topic: "financial", rating: 6, weight: 1 },
      { topic: "security", rating: 10, weight: 1 },
    ],
  },
];

const tierOrder: readonly RiskTier[] = ["high", "medium", "low"];

const tierWeight: Record<RiskTier, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const roundOne = (value: number): number => Math.round(value * 10) / 10;

const slugify = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const formatNumber = (value: number): string => {
  const rounded = roundOne(value);
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
};

const sanitizeVendorId = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const sanitizeVendorName = (value: unknown, fallbackId: string): string => {
  if (typeof value !== "string") {
    return `Vendor ${fallbackId}`;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : `Vendor ${fallbackId}`;
};

const sanitizeCategory = (value: unknown): string => {
  if (typeof value !== "string") {
    return "General";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "General";
};

const sanitizeTopic = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const slug = slugify(trimmed);
  return slug.length > 0 ? slug : fallback;
};

const sanitizeRating = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.min(Math.max(value, 0), 100);
  return roundOne(clamped);
};

const sanitizeWeight = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const clamped = Math.min(Math.max(value, 0.1), 5);
  return roundOne(clamped);
};

const cloneResponses = (
  responses: readonly ResponseRecord[],
): ResponseRecord[] => responses.map((response) => ({ ...response }));

const cloneDefaultVendors = (): VendorRecord[] =>
  defaultVendors.map((vendor) => ({
    id: vendor.id,
    name: vendor.name,
    category: vendor.category,
    responses: cloneResponses(vendor.responses),
  }));

const ensureUniqueId = (id: string, used: Set<string>): string => {
  let candidate = id;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${id}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const ensureUniqueTopic = (
  topic: string,
  used: Set<string>,
): string => {
  let candidate = topic;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${topic}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const sanitizeResponseList = (
  value: unknown,
  vendorId: string,
): ResponseRecord[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const used = new Set<string>();
  const sanitized: ResponseRecord[] = [];
  let fallbackIndex = 1;
  for (const entry of value) {
    const raw = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const fallbackTopic = `${vendorId}-topic-${fallbackIndex}`;
    fallbackIndex += 1;
    const topic = ensureUniqueTopic(
      sanitizeTopic(raw["topic"], fallbackTopic),
      used,
    );
    sanitized.push({
      topic,
      rating: sanitizeRating(raw["rating"]),
      weight: sanitizeWeight(raw["weight"]),
    });
  }
  sanitized.sort((left, right) => left.topic.localeCompare(right.topic));
  return sanitized;
};

const sanitizeVendorList = (value: unknown): VendorRecord[] => {
  const list = Array.isArray(value) ? value : cloneDefaultVendors();
  const sanitized: VendorRecord[] = [];
  const used = new Set<string>();
  let fallbackIndex = 1;
  for (const entry of list) {
    const raw = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    const fallbackId = `vendor-${fallbackIndex}`;
    fallbackIndex += 1;
    const id = ensureUniqueId(
      sanitizeVendorId(raw["id"], fallbackId),
      used,
    );
    const name = sanitizeVendorName(raw["name"], id);
    const category = sanitizeCategory(raw["category"]);
    const responses = sanitizeResponseList(raw["responses"], id);
    sanitized.push({ id, name, category, responses });
  }
  sanitized.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return left.id.localeCompare(right.id);
  });
  return sanitized;
};

const calculateRiskScore = (
  responses: readonly ResponseRecord[],
): number => {
  let total = 0;
  for (const response of responses) {
    total += response.rating * response.weight;
  }
  return roundOne(total);
};

const assignTier = (
  score: number,
  thresholds: ThresholdState,
): RiskTier => {
  if (score >= thresholds.high) {
    return "high";
  }
  if (score >= thresholds.medium) {
    return "medium";
  }
  return "low";
};

const buildBreakdown = (
  responses: readonly ResponseRecord[],
): ResponseBreakdown[] =>
  responses.map((response) => ({
    topic: response.topic,
    rating: response.rating,
    weight: response.weight,
    contribution: roundOne(response.rating * response.weight),
  }));

const buildSummaries = (
  vendors: readonly VendorRecord[],
  thresholds: ThresholdState,
): VendorRiskSummary[] => {
  const summaries: VendorRiskSummary[] = [];
  for (const vendor of vendors) {
    const breakdown = buildBreakdown(vendor.responses);
    const total = roundOne(
      breakdown.reduce((sum, item) => sum + item.contribution, 0),
    );
    const tier = assignTier(total, thresholds);
    summaries.push({
      id: vendor.id,
      name: vendor.name,
      category: vendor.category,
      total,
      tier,
      breakdown,
    });
  }
  summaries.sort((left, right) => {
    const tierDiff = tierWeight[left.tier] - tierWeight[right.tier];
    if (tierDiff !== 0) {
      return tierDiff;
    }
    if (right.total !== left.total) {
      return right.total - left.total;
    }
    return left.name.localeCompare(right.name);
  });
  return summaries;
};

const buildTierCounts = (
  summaries: readonly VendorRiskSummary[],
): TierCounts => {
  const counts: TierCounts = { high: 0, medium: 0, low: 0 };
  for (const summary of summaries) {
    counts[summary.tier] += 1;
  }
  return counts;
};

const buildTierBreakdown = (
  summaries: readonly VendorRiskSummary[],
): TierEntry[] =>
  tierOrder.map((tier) => ({
    tier,
    vendors: summaries
      .filter((summary) => summary.tier === tier)
      .map((summary) => ({
        id: summary.id,
        name: summary.name,
        score: summary.total,
      })),
  }));

const formatTopVendor = (
  summary: VendorRiskSummary | null,
): string => {
  if (!summary) {
    return "No vendors";
  }
  return `${summary.name} (${formatNumber(summary.total)})`;
};

const formatAuditMessage = (
  vendor: VendorRecord,
  topic: string,
  response: ResponseRecord,
): string => {
  const total = calculateRiskScore(vendor.responses);
  return `Adjusted ${topic} for ${vendor.id} to ${
    formatNumber(response.rating)
  } ` +
    `@ ${formatNumber(response.weight)} (total ${formatNumber(total)})`;
};

const readAuditLog = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      entries.push(item);
    }
  }
  return entries;
};

// Module-scope lift definitions
const liftSanitizeVendorList = lift(sanitizeVendorList);

const liftVendorRiskSummaries = lift((records: VendorRecord[]) =>
  buildSummaries(records, baselineThresholds)
);

const liftTierCounts = lift(buildTierCounts);
const liftTierBreakdown = lift(buildTierBreakdown);

const liftHighRiskCount = lift((counts: TierCounts) => counts.high);
const liftMediumRiskCount = lift((counts: TierCounts) => counts.medium);
const liftLowRiskCount = lift((counts: TierCounts) => counts.low);

const liftRiskOverview = lift((counts: TierCounts) =>
  `High: ${counts.high}, Medium: ${counts.medium}, Low: ${counts.low}`
);

const liftHighestRiskVendor = lift((summaries: VendorRiskSummary[]) =>
  summaries.length > 0 ? summaries[0] : null
);

const liftHighestRiskLabel = lift(formatTopVendor);
const liftAuditTrail = lift((entries: string[]) => [...entries]);

const adjustVendorResponse = handler(
  (
    event: ResponseAdjustmentEvent | undefined,
    context: {
      vendors: Cell<VendorInput[]>;
      audit: Cell<string[]>;
    },
  ) => {
    const vendorId = sanitizeVendorId(event?.vendorId, "");
    if (vendorId.length === 0) {
      return;
    }
    const topic = sanitizeTopic(event?.topic, "");
    if (topic.length === 0) {
      return;
    }
    const currentValue = context.vendors.get();
    const current = sanitizeVendorList(currentValue);
    let mutated = false;
    let trackedTopic: string | null = null;
    const updated = current.map((vendor) => {
      if (vendor.id !== vendorId) {
        return vendor;
      }
      const existingResponses = cloneResponses(vendor.responses);
      const index = existingResponses.findIndex((entry) =>
        entry.topic === topic
      );
      let responseChanged = false;
      if (index >= 0) {
        const currentResponse = existingResponses[index];
        const nextRating = event?.rating === undefined
          ? currentResponse.rating
          : sanitizeRating(event.rating);
        const nextWeight = event?.weight === undefined
          ? currentResponse.weight
          : sanitizeWeight(event.weight);
        if (
          nextRating !== currentResponse.rating ||
          nextWeight !== currentResponse.weight
        ) {
          existingResponses[index] = {
            topic,
            rating: nextRating,
            weight: nextWeight,
          };
          responseChanged = true;
        }
      } else {
        if (event?.rating === undefined && event?.weight === undefined) {
          return vendor;
        }
        existingResponses.push({
          topic,
          rating: sanitizeRating(event?.rating),
          weight: sanitizeWeight(event?.weight),
        });
        responseChanged = true;
      }
      const sanitizedResponses = sanitizeResponseList(
        existingResponses,
        vendor.id,
      );
      const nextCategory = event?.category === undefined
        ? vendor.category
        : sanitizeCategory(event.category);
      const nextName = event?.name === undefined
        ? vendor.name
        : sanitizeVendorName(event.name, vendor.id);
      if (
        !responseChanged &&
        nextCategory === vendor.category &&
        nextName === vendor.name
      ) {
        return vendor;
      }
      mutated = true;
      if (responseChanged) {
        trackedTopic = topic;
      }
      return {
        id: vendor.id,
        name: nextName,
        category: nextCategory,
        responses: sanitizedResponses,
      };
    });
    if (!mutated) {
      return;
    }
    const normalized = sanitizeVendorList(updated);
    context.vendors.set(normalized);
    if (!trackedTopic) {
      return;
    }
    const targetVendor = normalized.find((vendor) => vendor.id === vendorId);
    if (!targetVendor) {
      return;
    }
    const response = targetVendor.responses.find((entry) =>
      entry.topic === trackedTopic
    );
    if (!response) {
      return;
    }
    const currentLog = readAuditLog(context.audit.get());
    const nextLog = [
      ...currentLog,
      formatAuditMessage(
        targetVendor,
        trackedTopic,
        response,
      ),
    ].slice(-10);
    context.audit.set(nextLog);
  },
);

export const vendorRiskAssessment = pattern<VendorRiskAssessmentArgs>(
  ({ vendors }) => {
    const auditLog = cell<string[]>([]);

    const vendorsView = liftSanitizeVendorList(vendors);
    const vendorRiskSummaries = liftVendorRiskSummaries(vendorsView);

    const tierCounts = liftTierCounts(vendorRiskSummaries);
    const tierBreakdown = liftTierBreakdown(vendorRiskSummaries);
    const highRiskCount = liftHighRiskCount(tierCounts);
    const mediumRiskCount = liftMediumRiskCount(tierCounts);
    const lowRiskCount = liftLowRiskCount(tierCounts);

    const riskOverview = liftRiskOverview(tierCounts);

    const highestRiskVendor = liftHighestRiskVendor(vendorRiskSummaries);

    const highestRiskLabel = liftHighestRiskLabel(highestRiskVendor);
    const auditTrail = liftAuditTrail(auditLog);

    return {
      vendors,
      vendorsView,
      vendorRiskSummaries,
      tierBreakdown,
      tierCounts,
      highRiskCount,
      mediumRiskCount,
      lowRiskCount,
      riskOverview,
      highestRiskVendor,
      highestRiskLabel,
      auditTrail,
      adjustResponse: adjustVendorResponse({
        vendors,
        audit: auditLog,
      }),
    };
  },
);

export default vendorRiskAssessment;

export type {
  ResponseAdjustmentEvent,
  TierCounts,
  TierEntry,
  VendorInput,
  VendorRecord,
  VendorResponseInput,
  VendorRiskAssessmentArgs,
  VendorRiskSummary,
};
export type { RiskTier };
