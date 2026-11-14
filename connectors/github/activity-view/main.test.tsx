import {
  assert,
  NAME,
  type OpaqueCell,
  pattern,
  TESTS,
  UI,
} from "commonfabric";
import {
  findElement,
  findElementByText,
  findNode,
  hasExactText,
  propValue,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import { renderGithubCommits } from "./tools/commit-list.tsx";
import GithubActivity, {
  type GithubHostHealth,
  type GithubPullRequestFields,
  type GithubPullRequestIndex,
  type PullRequestDetail,
  type PullRequestStatus,
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

// The statuses the fixture above leaves out, one pull request each.
const otherStatuses: PullRequestStatus[] = [
  "tests-running",
  "merge-conflicts",
  "merge-blocked",
];

const OtherStatusesIndexFixture = pattern<void, GithubPullRequestIndex>(
  () => ({
    ...index,
    pullRequests: otherStatuses.map((status, offset) => ({
      ...pullRequests[1],
      id: `PR_${21 + offset}`,
      number: 21 + offset,
      title: `Pull request ${21 + offset}`,
      status,
    })),
  }),
);

/** The health snapshot of a host in `status`, carrying `sync` if given. */
const hostHealth = (
  status: string,
  sync?: GithubHostHealth["sync"],
): GithubHostHealth => {
  const { sync: _sync, lastComplete: _lastComplete, ...rest } = health;
  return { ...rest, status, ...(sync === undefined ? {} : { sync }) };
};

const isElement = (node: unknown, name: string): boolean =>
  typeof node === "object" && node !== null && "name" in node &&
  node.name === name;

/** Whether `root` renders a `cf-badge` reading `label` in `color`. */
const hasBadge = (root: unknown, label: string, color: string): boolean =>
  findNode(
    root,
    (node) =>
      isElement(node, "cf-badge") && hasExactText(node, label) &&
      propValue(node, "color") === color,
  ) !== undefined;

/** The value cell of the table row under `root` headed `header`. */
const rowValue = (root: unknown, header: string): string =>
  textContent(
    findElement(
      findNode(root, (node) =>
        isElement(node, "tr") &&
        hasExactText(findElement(node, "th"), header)),
      "td",
    ),
  ).trim();

/** The number the summary card under `root` labeled `label` shows. */
const statValue = (root: unknown, label: string): string =>
  textContent(
    findElement(
      findNode(root, (node) =>
        isElement(node, "cf-vstack") &&
        hasExactText(findElement(node, "cf-text"), label)),
      "cf-heading",
    ),
  ).trim();

const emptyStateMessages = (root: unknown): string[] => {
  const messages: string[] = [];
  findNode(root, (node) => {
    if (isElement(node, "cf-empty-state")) {
      messages.push(String(propValue(node, "message")));
    }
    return false;
  });
  return messages;
};

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
  const otherStatusesSubject = GithubActivity({
    repoUrl: "https://github.com/example/widget",
    pullRequestIndex: OtherStatusesIndexFixture(),
    health: hostHealth("degraded", {
      reason: "periodic",
      status: "failed",
      startedAt: "2026-08-28T10:00:00.000Z",
      completedAt: "2026-08-28T10:00:01.000Z",
      error: "One repository was unavailable",
    }),
  });
  const readySubject = GithubActivity({
    repoUrl: "https://github.com/example/widget",
    pullRequestIndex: emptyPullRequestIndex,
    health: hostHealth("ready", {
      reason: "periodic",
      status: "complete",
      startedAt: "2026-08-28T10:00:00.000Z",
      completedAt: "2026-08-28T10:00:01.000Z",
      pullRequestCount: 0,
    }),
  });
  const startingSubject = GithubActivity({
    repoUrl: "https://github.com/example/widget",
    pullRequestIndex: emptyPullRequestIndex,
    health: hostHealth("starting"),
  });
  const syncingSubject = GithubActivity({
    repoUrl: "https://github.com/example/widget",
    pullRequestIndex: emptyPullRequestIndex,
    health: hostHealth("syncing", {
      reason: "manual",
      status: "running",
      startedAt: "2026-08-28T10:00:00.000Z",
    }),
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
  const assert_names_the_viewer = assert(() =>
    subject[NAME] === "GitHub pull requests: octocat"
  );
  const assert_colors_each_status = assert(() =>
    hasBadge(subject[UI], "Ready to land", "primary") &&
    hasBadge(subject[UI], "Tests failed", "danger") &&
    hasBadge(subject[UI], "Draft", "neutral") &&
    hasBadge(subject[UI], "Visibility unknown", "accent") &&
    hasBadge(otherStatusesSubject[UI], "Tests running", "accent") &&
    hasBadge(otherStatusesSubject[UI], "Merge conflicts", "danger") &&
    hasBadge(otherStatusesSubject[UI], "Merge blocked", "neutral") &&
    !hasBadge(otherStatusesSubject[UI], "Ready to land", "primary")
  );
  const assert_counts_other_statuses = assert(() =>
    otherStatusesSubject.pullRequestCount === 3 &&
    otherStatusesSubject.readyToLandCount === 0 &&
    otherStatusesSubject.needsAttentionCount === 2 &&
    statValue(otherStatusesSubject[UI], "Tests running") === "1"
  );
  const assert_colors_each_host_state = assert(() =>
    hasBadge(readySubject[UI], "ready", "primary") &&
    hasBadge(otherStatusesSubject[UI], "degraded", "danger") &&
    hasBadge(startingSubject[UI], "starting", "accent") &&
    hasBadge(syncingSubject[UI], "syncing", "accent") &&
    hasBadge(emptySubject[UI], "index available", "primary")
  );
  const assert_renders_each_sync_state = assert(() =>
    rowValue(readySubject[UI], "Last sync") === "complete" &&
    rowValue(readySubject[UI], "Reported PR count") === "0" &&
    rowValue(otherStatusesSubject[UI], "Last sync") === "failed" &&
    rowValue(otherStatusesSubject[UI], "Error") ===
      "One repository was unavailable" &&
    rowValue(syncingSubject[UI], "Last sync") === "running" &&
    rowValue(syncingSubject[UI], "Sync completed") === "—"
  );
  const assert_dashes_a_missing_sync = assert(() =>
    [
      "Last sync",
      "Reason",
      "Sync started",
      "Sync completed",
      "Reported PR count",
      "Error",
    ].every((header) => rowValue(startingSubject[UI], header) === "—")
  );
  const assert_renders_empty_states = assert(() => {
    const messages = emptyStateMessages(emptySubject[UI]).join(",");
    return messages ===
        "No synchronized pull requests,No recent pull-request activity," +
          "No connector health snapshot is connected" &&
      emptyStateMessages(subject[UI]).length === 0;
  });
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
      { assertion: assert_names_the_viewer },
      { assertion: assert_colors_each_status },
      { assertion: assert_counts_other_statuses },
      { assertion: assert_colors_each_host_state },
      { assertion: assert_renders_each_sync_state },
      { assertion: assert_dashes_a_missing_sync },
      { assertion: assert_renders_empty_states },
      { assertion: assert_renders_public_repository_commits },
      { assertion: assert_renders_empty_public_repository },
    ],
  };
});
