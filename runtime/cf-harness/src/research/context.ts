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

/** Host-observed identities, keeping search leads separate from source verification. */
export const researchPatternRecords = (
  kit: HarnessResearchResult,
  confirmed: readonly TrustedPatternRecord[],
): readonly TrustedPatternRecord[] => [
  ...(kit.purpose === "orient" ? kit.leads.map((lead) => lead.pattern) : []),
  ...confirmed,
];
