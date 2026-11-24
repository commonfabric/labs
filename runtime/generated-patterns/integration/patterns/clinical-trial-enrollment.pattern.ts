import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

const toTitleCase = (value: string): string => {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
};

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeId = (value: unknown): string | null => {
  const text = sanitizeText(value);
  return text ? text.toUpperCase() : null;
};

const clampNumber = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = Math.min(Math.max(value, min), max);
  return Math.round(clamped);
};

const sanitizeCondition = (value: unknown): string => {
  const text = sanitizeText(value);
  if (!text) return "Any";
  return toTitleCase(text);
};

const sanitizeSite = (value: unknown): string => {
  const text = sanitizeText(value);
  if (!text) return "Unassigned";
  return toTitleCase(text);
};

interface CandidateLike {
  id?: string;
  candidateId?: string;
  age?: number;
  condition?: string;
  consentGiven?: boolean;
  biomarkerScore?: number;
  site?: string;
  priorTherapy?: boolean;
}

/** Canonical representation of a enrollment candidate. */
interface TrialCandidate {
  /** Uppercased participant identifier. */
  id: string;

  /** Participant age capped to a sensible inclusive range. */
  age: number;

  /** Primary condition label stored in title case. */
  condition: string;

  /** Whether informed consent has been collected. */
  consentGiven: boolean;

  /** Latest biomarker score from screening, 0-100 range. */
  biomarkerScore: number;

  /** Recruiting site in title case. */
  site: string;

  /** Indicates if prior therapy disqualifies the participant. */
  priorTherapy: boolean;
}

const sanitizeCandidateEntry = (
  value: CandidateLike | undefined,
): TrialCandidate | null => {
  const id = sanitizeId(value?.id ?? value?.candidateId);
  if (!id) return null;
  const age = clampNumber(value?.age, 18, 90, 18);
  const condition = sanitizeCondition(value?.condition);
  const biomarker = clampNumber(value?.biomarkerScore, 0, 100, 0);
  const consent = Boolean(value?.consentGiven);
  const site = sanitizeSite(value?.site);
  const priorTherapy = Boolean(value?.priorTherapy);
  return {
    id,
    age,
    condition,
    consentGiven: consent,
    biomarkerScore: biomarker,
    site,
    priorTherapy,
  };
};

const defaultCandidates: TrialCandidate[] = [
  {
    id: "P-001",
    age: 45,
    condition: "Hypertension",
    consentGiven: true,
    biomarkerScore: 67,
    site: "North Campus",
    priorTherapy: false,
  },
  {
    id: "P-002",
    age: 52,
    condition: "Diabetes",
    consentGiven: false,
    biomarkerScore: 71,
    site: "North Campus",
    priorTherapy: false,
  },
  {
    id: "P-003",
    age: 29,
    condition: "Hypertension",
    consentGiven: true,
    biomarkerScore: 58,
    site: "West Clinic",
    priorTherapy: true,
  },
  {
    id: "P-004",
    age: 62,
    condition: "Hypertension",
    consentGiven: true,
    biomarkerScore: 82,
    site: "East Facility",
    priorTherapy: false,
  },
];

const sanitizeCandidates = (
  value: readonly CandidateLike[] | undefined,
): TrialCandidate[] => {
  if (!Array.isArray(value)) {
    return defaultCandidates.map((candidate) => ({ ...candidate }));
  }
  const map = new Map<string, TrialCandidate>();
  for (const entry of value) {
    const sanitized = sanitizeCandidateEntry(entry);
    if (!sanitized) continue;
    map.set(sanitized.id, sanitized);
  }
  if (map.size === 0) {
    return defaultCandidates.map((candidate) => ({ ...candidate }));
  }
  const list = Array.from(map.values());
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
};

/** Enrollment guardrails shared across derives and handlers. */
interface EnrollmentCriteria {
  /** Minimum allowed age, inclusive. */
  minAge: number;

  /** Maximum allowed age, inclusive. */
  maxAge: number;

  /** Required condition label; null accepts any condition. */
  requiredCondition: string | null;

  /** Lowest acceptable biomarker score. */
  minBiomarkerScore: number;

  /** Whether consent is mandatory prior to enrollment. */
  requireConsent: boolean;

  /** Approved recruiting sites. Empty array means all sites. */
  allowedSites: string[];

  /** Permits participants that already received therapy. */
  allowPriorTherapy: boolean;
}

const defaultCriteria: EnrollmentCriteria = {
  minAge: 30,
  maxAge: 70,
  requiredCondition: "Hypertension",
  minBiomarkerScore: 60,
  requireConsent: true,
  allowedSites: [],
  allowPriorTherapy: false,
};

const sanitizeAllowedSites = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const sites = new Set<string>();
  for (const entry of value) {
    const text = sanitizeText(entry);
    if (!text) continue;
    sites.add(toTitleCase(text));
  }
  return Array.from(sites).sort((a, b) => a.localeCompare(b));
};

const sanitizeCriteria = (
  value: Partial<EnrollmentCriteria> | undefined,
): EnrollmentCriteria => {
  const minAge = clampNumber(value?.minAge, 18, 90, defaultCriteria.minAge);
  const maxAge = clampNumber(value?.maxAge, minAge, 95, defaultCriteria.maxAge);
  const requiredCondition = value?.requiredCondition === null
    ? null
    : value?.requiredCondition === undefined
    ? defaultCriteria.requiredCondition
    : sanitizeCondition(value.requiredCondition);
  const minBiomarkerScore = clampNumber(
    value?.minBiomarkerScore,
    0,
    100,
    defaultCriteria.minBiomarkerScore,
  );
  return {
    minAge,
    maxAge,
    requiredCondition,
    minBiomarkerScore,
    requireConsent: Boolean(
      value?.requireConsent ?? defaultCriteria.requireConsent,
    ),
    allowedSites: sanitizeAllowedSites(value?.allowedSites),
    allowPriorTherapy: Boolean(
      value?.allowPriorTherapy ?? defaultCriteria.allowPriorTherapy,
    ),
  };
};

interface CriteriaPatch {
  minAge?: number;
  maxAge?: number;
  requiredCondition?: string | null;
  minBiomarkerScore?: number;
  requireConsent?: boolean;
  allowedSites?: string[];
  allowPriorTherapy?: boolean;
}

const sanitizeCriteriaPatch = (
  value: CriteriaPatch | undefined,
): Partial<EnrollmentCriteria> | null => {
  if (value === undefined || value === null) return null;
  const patch: Partial<EnrollmentCriteria> = {};
  if (value.minAge !== undefined) patch.minAge = value.minAge;
  if (value.maxAge !== undefined) patch.maxAge = value.maxAge;
  if (value.requiredCondition !== undefined) {
    patch.requiredCondition = value.requiredCondition === null
      ? null
      : sanitizeCondition(value.requiredCondition);
  }
  if (value.minBiomarkerScore !== undefined) {
    patch.minBiomarkerScore = value.minBiomarkerScore;
  }
  if (value.requireConsent !== undefined) {
    patch.requireConsent = Boolean(value.requireConsent);
  }
  if (value.allowedSites !== undefined) {
    patch.allowedSites = sanitizeAllowedSites(value.allowedSites);
  }
  if (value.allowPriorTherapy !== undefined) {
    patch.allowPriorTherapy = Boolean(value.allowPriorTherapy);
  }
  return Object.keys(patch).length > 0 ? patch : null;
};

interface CandidatePatch {
  id?: string;
  candidateId?: string;
  age?: number;
  condition?: string;
  consentGiven?: boolean;
  biomarkerScore?: number;
  site?: string;
  priorTherapy?: boolean;
}

const sanitizeCandidatePatch = (
  value: CandidatePatch | undefined,
): { id: string; updates: CandidateLike } | null => {
  const id = sanitizeId(value?.id ?? value?.candidateId);
  if (!id) return null;
  const updates: CandidateLike = { id };
  if (value?.age !== undefined) updates.age = value.age;
  if (value?.condition !== undefined) updates.condition = value.condition;
  if (value?.consentGiven !== undefined) {
    updates.consentGiven = Boolean(value.consentGiven);
  }
  if (value?.biomarkerScore !== undefined) {
    updates.biomarkerScore = value.biomarkerScore;
  }
  if (value?.site !== undefined) updates.site = value.site;
  if (value?.priorTherapy !== undefined) {
    updates.priorTherapy = Boolean(value.priorTherapy);
  }
  return { id, updates };
};

/** Detailed screening result for each participant. */
interface ScreeningResult {
  candidate: TrialCandidate;
  eligible: boolean;
  reasons: string[];
}

const buildScreeningReport = (
  candidates: readonly TrialCandidate[],
  criteria: EnrollmentCriteria,
): ScreeningResult[] => {
  const results: ScreeningResult[] = [];
  const allowedSites = criteria.allowedSites;
  const requireSiteMatch = allowedSites.length > 0;
  for (const candidate of candidates) {
    const reasons: string[] = [];
    if (candidate.age < criteria.minAge) {
      reasons.push("below minimum age");
    } else if (candidate.age > criteria.maxAge) {
      reasons.push("above maximum age");
    }
    if (
      criteria.requiredCondition &&
      candidate.condition !== criteria.requiredCondition
    ) {
      reasons.push("condition mismatch");
    }
    if (candidate.biomarkerScore < criteria.minBiomarkerScore) {
      reasons.push("biomarker below threshold");
    }
    if (criteria.requireConsent && !candidate.consentGiven) {
      reasons.push("consent pending");
    }
    if (!criteria.allowPriorTherapy && candidate.priorTherapy) {
      reasons.push("previous therapy excluded");
    }
    if (
      requireSiteMatch &&
      !allowedSites.includes(candidate.site)
    ) {
      reasons.push("site not approved");
    }
    results.push({ candidate, eligible: reasons.length === 0, reasons });
  }
  results.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
  return results;
};

/** Aggregate eligible counts per recruiting site. */
interface SiteSummaryEntry {
  site: string;
  eligible: number;
  total: number;
  eligibleRatio: number;
}

const buildSiteSummary = (
  report: readonly ScreeningResult[],
): SiteSummaryEntry[] => {
  const totals = new Map<string, { eligible: number; total: number }>();
  for (const entry of report) {
    const site = entry.candidate.site;
    const current = totals.get(site) ?? { eligible: 0, total: 0 };
    const eligible = entry.eligible ? current.eligible + 1 : current.eligible;
    totals.set(site, { eligible, total: current.total + 1 });
  }
  const summary: SiteSummaryEntry[] = [];
  for (const [site, counts] of totals.entries()) {
    const ratio = counts.total === 0
      ? 0
      : Math.round((counts.eligible / counts.total) * 100) / 100;
    summary.push({
      site,
      eligible: counts.eligible,
      total: counts.total,
      eligibleRatio: ratio,
    });
  }
  summary.sort((a, b) => a.site.localeCompare(b.site));
  return summary;
};

interface ClinicalTrialEnrollmentArgs {
  participants: Default<TrialCandidate[], typeof defaultCandidates>;
  criteria: Default<EnrollmentCriteria, typeof defaultCriteria>;
}

const updateCriteria = handler(
  (
    event: CriteriaPatch | undefined,
    context: { criteria: Cell<EnrollmentCriteria> },
  ) => {
    const patch = sanitizeCriteriaPatch(event);
    if (!patch) return;
    const current = sanitizeCriteria(context.criteria.get());
    const merged = sanitizeCriteria({ ...current, ...patch });
    context.criteria.set(merged);
  },
);

const recordScreening = handler(
  (
    event: CandidatePatch | undefined,
    context: { participants: Cell<TrialCandidate[]> },
  ) => {
    const patch = sanitizeCandidatePatch(event);
    if (!patch) return;
    const current = sanitizeCandidates(context.participants.get());
    const index = current.findIndex((candidate) => candidate.id === patch.id);
    if (index === -1) return;
    const merged = sanitizeCandidateEntry({
      ...current[index],
      ...patch.updates,
    });
    if (!merged) return;
    const next = current.slice();
    next[index] = merged;
    context.participants.set(sanitizeCandidates(next));
  },
);

const liftScreening = lift(
  (input: { candid: TrialCandidate[]; crit: EnrollmentCriteria }) =>
    buildScreeningReport(input.candid, input.crit),
);

const liftEligibleCandidates = lift((report: ScreeningResult[]) =>
  report.filter((entry) => entry.eligible).map((entry) => entry.candidate)
);

const liftIneligibleReport = lift((report: ScreeningResult[]) =>
  report
    .filter((entry) => !entry.eligible)
    .map((entry) => ({
      id: entry.candidate.id,
      reasons: entry.reasons,
    }))
);

const liftEligibleIds = lift((list: readonly TrialCandidate[]) =>
  list.map((candidate) => candidate.id)
);

const liftCandidateCount = lift(
  (list: readonly TrialCandidate[]) => list.length,
);

const liftEligibleCount = lift((ids: readonly string[]) => ids.length);

const liftSiteSummary = lift((report: ScreeningResult[]) =>
  buildSiteSummary(report)
);

const liftSanitizeCandidates = lift(sanitizeCandidates);
const liftSanitizeCriteria = lift(sanitizeCriteria);

export const clinicalTrialEnrollment = pattern<ClinicalTrialEnrollmentArgs>(
  ({ participants, criteria }) => {
    const candidateView = liftSanitizeCandidates(participants);
    const criteriaView = liftSanitizeCriteria(criteria);
    const screening = liftScreening({
      candid: candidateView,
      crit: criteriaView,
    });
    const eligibleCandidates = liftEligibleCandidates(screening);
    const ineligibleReport = liftIneligibleReport(screening);
    const eligibleIds = liftEligibleIds(eligibleCandidates);
    const candidateCount = liftCandidateCount(candidateView);
    const eligibleCount = liftEligibleCount(eligibleIds);
    const eligibleSummary =
      str`${eligibleCount} of ${candidateCount} participants eligible`;
    const siteSummary = liftSiteSummary(screening);

    return {
      candidates: candidateView,
      criteria: criteriaView,
      screening,
      eligibleCandidates,
      eligibleIds,
      eligibleCount,
      eligibleSummary,
      ineligibleReport,
      siteSummary,
      updateCriteria: updateCriteria({ criteria }),
      recordScreening: recordScreening({ participants }),
    };
  },
);

export type {
  ClinicalTrialEnrollmentArgs,
  EnrollmentCriteria,
  ScreeningResult,
  SiteSummaryEntry,
  TrialCandidate,
};

export default clinicalTrialEnrollment;
