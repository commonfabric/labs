import type {
  GithubCheckState,
  GithubMergeState,
  GithubReviewDecision,
  PullRequestStatus,
} from "./types.ts";

export interface PullRequestStatusInput {
  isDraft: boolean;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  mergeState: GithubMergeState;
  reviewDecision: GithubReviewDecision;
  checkState: GithubCheckState;
}

/** Classify the current GitHub fields into a compact status for operators. */
export function classifyPullRequestStatus(
  input: PullRequestStatusInput,
): PullRequestStatus {
  if (input.isDraft || input.mergeState === "DRAFT") return "draft";
  if (input.mergeable === "CONFLICTING" || input.mergeState === "DIRTY") {
    return "merge-conflicts";
  }
  if (input.checkState === "ERROR" || input.checkState === "FAILURE") {
    return "tests-failed";
  }
  if (input.checkState === "EXPECTED" || input.checkState === "PENDING") {
    return "tests-running";
  }
  if (
    input.mergeable === "MERGEABLE" &&
    input.mergeState === "CLEAN" &&
    input.reviewDecision !== "CHANGES_REQUESTED" &&
    input.reviewDecision !== "REVIEW_REQUIRED"
  ) {
    return "green-and-can-land";
  }
  return "merge-blocked";
}
