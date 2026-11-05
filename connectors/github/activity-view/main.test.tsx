import { assert, type OpaqueCell, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  propValue,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import { renderGithubCommits } from "./tools/commit-list.tsx";
import GithubActivity, {
  type GithubHostHealth,
  type GithubPullRequestFields,
  type GithubPullRequestIndex,
  type PullRequestDetail,
} from "./main.tsx";

const publicCommits = [
  {
    sha: "abc123",
    html_url: "https://github.com/example/widget/commit/abc123",
    commit: {
      message: "Ship the synchronized dashboard\n\nMore detail",
      author: {
        name: "Ada",
        date: "2026-08-28T10:00:00.000Z",
      },
    },
  },
];

const PullRequestDetailFixture = pattern<void, PullRequestDetail>(() => ({
  schema: "commonfabric.github-connector.pull-request.v1",
}));

const pullRequests: GithubPullRequestFields[] = [
  {
    id: "PR_4",
    number: 4,
    url: "https://github.com/example/widget/pull/4",
    title: "Repair release checks",
    repository: "example/widget",
    repositoryUrl: "https://github.com/example/widget",
    baseRefName: "main",
    baseRefOid: "4444444444444444",
    headRefName: "repair-checks",
    headRefOid: "44444444aaaaaaaa",
    headRepository: "example/widget",
    headRepositoryUrl: "https://github.com/example/widget",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeState: "UNSTABLE",
    reviewDecision: "APPROVED",
    checkState: "FAILURE",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    observedAt: "2026-08-28T10:00:00.000Z",
    visibility: "visible",
    status: "tests-failed",
  },
  {
    id: "PR_12",
    number: 12,
    url: "https://github.com/example/widget/pull/12",
    title: "Add synchronized dashboard",
    repository: "example/widget",
    repositoryUrl: "https://github.com/example/widget",
    baseRefName: "main",
    baseRefOid: "1212121212121212",
    headRefName: "synced-dashboard",
    headRefOid: "12121212aaaaaaaa",
    headRepository: "example/widget",
    headRepositoryUrl: "https://github.com/example/widget",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    reviewDecision: "APPROVED",
    checkState: "SUCCESS",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    observedAt: "2026-08-28T10:00:00.000Z",
    visibility: "visible",
    status: "green-and-can-land",
  },
  {
    id: "PR_3",
    number: 3,
    url: "https://github.com/example/runner/pull/3",
    title: "Document provider setup",
    repository: "example/runner",
    repositoryUrl: "https://github.com/example/runner",
    baseRefName: "main",
    baseRefOid: "3333333333333333",
    headRefName: "provider-docs",
    headRefOid: "33333333aaaaaaaa",
    headRepository: "contributor/runner",
    headRepositoryUrl: "https://github.com/contributor/runner",
    isDraft: true,
    mergeable: "UNKNOWN",
    mergeState: "DRAFT",
    reviewDecision: null,
    checkState: null,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
    observedAt: "2026-08-28T10:00:00.000Z",
    visibility: "visible",
    status: "draft",
  },
  {
    id: "PR_7",
    number: 7,
    url: "https://github.com/example/runner/pull/7",
    title: "Refresh runtime adapter",
    repository: "example/runner",
    repositoryUrl: "https://github.com/example/runner",
    baseRefName: "main",
    baseRefOid: "7777777777777777",
    headRefName: "runtime-adapter",
    headRefOid: null,
    headRepository: null,
    headRepositoryUrl: null,
    isDraft: false,
    mergeable: "UNKNOWN",
    mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    checkState: "PENDING",
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    observedAt: "2026-08-28T10:00:00.000Z",
    visibility: "unknown",
    status: "visibility-unknown",
  },
];

const index: Omit<GithubPullRequestIndex, "pullRequests"> = {
  schema: "commonfabric.github-connector.pull-request-index.v1",
  formatVersion: 1,
  viewer: "octocat",
  generatedAt: "2026-08-28T10:00:01.000Z",
  lastCompleteCollectionAt: "2026-08-28T10:00:00.000Z",
  generation: 9,
};

const health: GithubHostHealth = {
  schema: "commonfabric.github-connector.health.v1",
  service: "github-host",
  formatVersion: 1,
  status: "stopped",
  startedAt: "2026-08-28T09:00:00.000Z",
  updatedAt: "2026-08-28T10:05:00.000Z",
  target: {
    spaceDid: "did:key:space",
    cells: { index: "index-cell", health: "health-cell" },
  },
  sync: {
    reason: "periodic",
    status: "complete",
    startedAt: "2026-08-28T10:00:00.000Z",
    completedAt: "2026-08-28T10:00:01.000Z",
    pullRequestCount: 4,
  },
  lastComplete: {
    completedAt: "2026-08-28T10:00:01.000Z",
    pullRequestCount: 4,
  },
};

const PullRequestIndexFixture = pattern<
  { detail: OpaqueCell<PullRequestDetail> & PullRequestDetail },
  GithubPullRequestIndex
>(({ detail }) => ({
  ...index,
  pullRequests: pullRequests.map((row) => ({ ...row, detail })),
}));

const EmptyPullRequestIndexFixture = pattern<void, GithubPullRequestIndex>(
  () => ({ ...index, pullRequests: [] }),
);

export default pattern(() => {
  const detail = PullRequestDetailFixture();
  const pullRequestIndex = PullRequestIndexFixture({ detail });
  const emptyPullRequestIndex = EmptyPullRequestIndexFixture();
  const subject = GithubActivity({
    repoUrl: "https://github.com/example/widget",
    pullRequestIndex,
    health,
  });
  const emptySubject = GithubActivity({
    repoUrl: "https://github.com/example/widget",
    pullRequestIndex: emptyPullRequestIndex,
  });
  const assert_keeps_every_synced_pull_request = assert(() =>
    subject.pullRequestCount === 4 && subject.pullRequests.length === 4
  );
  const assert_counts_repositories = assert(() =>
    subject.repositoryCount === 2
  );
  const assert_counts_actionable_statuses = assert(() =>
    subject.readyToLandCount === 1 && subject.needsAttentionCount === 2
  );
  const assert_orders_recent_activity = assert(() =>
    subject.pullRequests.map((row) => row.number).join(",") === "12,7,4,3"
  );
  const assert_renders_every_synced_pull_request = assert(() => {
    const text = textContent(subject[UI]);
    return pullRequests.every((row) => text.includes(row.title)) &&
      text.includes("runtime-adapter → main") &&
      !text.includes("example/runner:runtime-adapter");
  });
  const assert_keeps_detail_cells_out_of_the_summary = assert(() =>
    subject.pullRequests.every((row) => !("detail" in row))
  );
  const assert_stopped_host_is_neutral = assert(() => {
    const badge = findElementByText(subject[UI], "cf-badge", "stopped");
    return propValue(badge, "color") === "neutral";
  });
  const assert_renders_sync_metadata = assert(() => {
    const text = textContent(subject[UI]);
    return text.includes("periodic") && text.includes("index-cell") &&
      text.includes("health-cell");
  });
  const assert_supports_empty_generations = assert(() =>
    emptySubject.pullRequestCount === 0 &&
    emptySubject.repositoryCount === 0 &&
    emptySubject.pullRequests.length === 0
  );
  const assert_renders_public_repository_commits = assert(() => {
    const ui = renderGithubCommits(publicCommits);
    const text = textContent(ui);
    const link = findElementByText(ui, "a", "View commit →");
    return text.includes("Ship the synchronized dashboard") &&
      !text.includes("More detail") && text.includes("Ada") &&
      propValue(link, "href") ===
        "https://github.com/example/widget/commit/abc123";
  });
  const assert_renders_empty_public_repository = assert(() =>
    textContent(renderGithubCommits([])).includes("No commits found")
  );

  return {
    [TESTS]: [
      { assertion: assert_keeps_every_synced_pull_request },
      { assertion: assert_counts_repositories },
      { assertion: assert_counts_actionable_statuses },
      { assertion: assert_orders_recent_activity },
      { assertion: assert_renders_every_synced_pull_request },
      { assertion: assert_keeps_detail_cells_out_of_the_summary },
      { assertion: assert_stopped_host_is_neutral },
      { assertion: assert_renders_sync_metadata },
      { assertion: assert_supports_empty_generations },
      { assertion: assert_renders_public_repository_commits },
      { assertion: assert_renders_empty_public_repository },
    ],
  };
});
