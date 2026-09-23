/** Selects bounded research context while keeping evidence and handle scopes distinct. */

import type { TrustedPatternRecord } from "../contracts/trusted-pattern.ts";

import type {
  HarnessResearchPurpose,
  HarnessResearchResult,
  HarnessResearchRunSummary,
} from "../contracts/research.ts";

/** Interprets scoped results and saved unscoped kits without rewriting history. */
export const researchPurposeOf = (
  result: HarnessResearchResult,
): HarnessResearchPurpose =>
  result.purpose ??
    (result.recommendation.kind === "focused-api" ? "answer" : "orient");

/**
 * Keeps the latest orientation and two latest answers in
 * their original order. Whole kits, including examples, remain intact; durable
 * evidence and inherited CFC context have their own retention rules.
 */
export const selectResearchContext = (
  runs: readonly HarnessResearchRunSummary[],
): HarnessResearchRunSummary[] => {
  const orientation = runs.findLast((run) =>
    researchPurposeOf(run.kit) === "orient"
  );
  const focused = runs.filter((run) => researchPurposeOf(run.kit) === "answer")
    .slice(-2);
  const selected = new Set([orientation, ...focused]);
  return runs.filter((run) => selected.has(run));
};

/** Small prior findings for a new question, with recipes and old bindings omitted. */
export const researchStartingContext = (
  run: Pick<HarnessResearchRunSummary, "researchRunId" | "kit">,
) => ({
  researchRunId: run.researchRunId,
  purpose: researchPurposeOf(run.kit),
  task: run.kit.task,
  summary: run.kit.summary,
  patterns: run.kit.patterns.map((
    { patternId, importHint, argumentType, resultType },
  ) => ({ patternId, importHint, argumentType, resultType })),
  ...(run.kit.purpose === "orient"
    ? { leads: run.kit.leads, questions: run.kit.questions }
    : {}),
  rules: run.kit.rules,
  sources: run.kit.sources,
  missing: run.kit.missing,
});

/** Host-observed identities, keeping search leads separate from source verification. */
export const researchPatternRecords = (
  kit: HarnessResearchResult,
  confirmed: readonly TrustedPatternRecord[],
): readonly TrustedPatternRecord[] => [
  ...(kit.purpose === "orient" ? kit.leads.map((lead) => lead.pattern) : []),
  ...confirmed,
];
