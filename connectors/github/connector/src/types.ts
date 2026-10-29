/** GitHub's combined state for a pull request's status checks. */
export type GithubCheckState =
  | "ERROR"
  | "EXPECTED"
  | "FAILURE"
  | "PENDING"
  | "SUCCESS"
  | null;

/** GitHub's computed merge state for a pull request. */
export type GithubMergeState =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

/** GitHub's review decision for a pull request. */
export type GithubReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** The status presented to people tracking an open pull request. */
export type PullRequestStatus =
  | "draft"
  | "tests-failed"
  | "tests-running"
  | "merge-conflicts"
  | "merge-blocked"
  | "visibility-unknown"
  | "green-and-can-land";

/** A normalized open pull request authored by the authenticated GitHub user. */
export interface GithubPullRequest {
  id: string;
  number: number;
  url: string;
  title: string;
  repository: string;
  repositoryUrl: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string | null;
  headRepository: string | null;
  headRepositoryUrl: string | null;
  isDraft: boolean;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  mergeState: GithubMergeState;
  reviewDecision: GithubReviewDecision;
  checkState: GithubCheckState;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  visibility: "visible" | "unknown";
  status: PullRequestStatus;
}

/** One complete GitHub collection suitable for atomic index publication. */
export interface GithubPullRequestCollection {
  viewer: string;
  observedAt: string;
  pullRequests: GithubPullRequest[];
}

/** The shallow pull-request row stored in the GitHub connector index. */
export interface GithubPullRequestIndexRow extends GithubPullRequest {
  detail: unknown;
}

/** The current complete GitHub pull-request index. */
export interface GithubPullRequestIndex {
  schema: "commonfabric.github-connector.pull-request-index.v1";
  formatVersion: 1;
  viewer: string;
  generatedAt: string;
  lastCompleteCollectionAt: string;
  generation: number;
  pullRequests: GithubPullRequestIndexRow[];
}
