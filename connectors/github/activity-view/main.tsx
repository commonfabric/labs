import {
  computed,
  Default,
  fetchJson,
  generateText,
  NAME,
  type OpaqueCell,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type CommitResponse,
  formatDate,
  renderGithubCommits,
} from "./tools/commit-list.tsx";

/** The connector's derived status for an open pull request. */
export type PullRequestStatus =
  | "draft"
  | "tests-failed"
  | "tests-running"
  | "merge-conflicts"
  | "merge-blocked"
  | "visibility-unknown"
  | "green-and-can-land";

/** An opaque synchronized pull-request snapshot. */
export interface PullRequestDetail {
  schema?: "commonfabric.github-connector.pull-request.v1";
}

/** The shallow fields published for every synchronized pull request. */
export interface GithubPullRequestFields {
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
  mergeState: string;
  reviewDecision: string | null;
  checkState: string | null;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  visibility: "visible" | "unknown";
  status: PullRequestStatus;
}

/** A pull-request row accepted from the connector index. */
export interface GithubPullRequestIndexRow extends GithubPullRequestFields {
  detail?: OpaqueCell<PullRequestDetail>;
}

/** One complete generation of synchronized pull requests. */
export interface GithubPullRequestIndex {
  schema: "commonfabric.github-connector.pull-request-index.v1";
  formatVersion: number;
  viewer: string;
  generatedAt: string;
  lastCompleteCollectionAt: string;
  generation: number;
  pullRequests: GithubPullRequestIndexRow[];
}

/** The GitHub host health snapshot published beside the index. */
export interface GithubHostHealth {
  schema: "commonfabric.github-connector.health.v1";
  service: string;
  formatVersion: number;
  status: string;
  startedAt: string;
  updatedAt: string;
  target: {
    spaceDid: string;
    cells: { index: string; health: string };
  };
  sync?: {
    reason: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    pullRequestCount?: number;
    error?: string;
  };
  lastComplete?: {
    completedAt: string;
    pullRequestCount: number;
  };
}

/** Inputs for connector data and the public-repository fallback. */
export interface GithubActivityInput {
  repoUrl: Writable<
    string | Default<"https://github.com/anthropics/claude-code">
  >;
  pullRequestIndex?: GithubPullRequestIndex;
  health?: GithubHostHealth;
}

/** The rendered view and its machine-readable pull-request summary. */
export interface GithubActivityOutput {
  [NAME]: string;
  [UI]: VNode;
  pullRequests: GithubPullRequestFields[];
  pullRequestCount: number;
  repositoryCount: number;
  readyToLandCount: number;
  needsAttentionCount: number;
}

type SyncedTab = "pull-requests" | "recent" | "sync";

/** Parse a public GitHub repository URL. */
function parseUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return { owner: "", repo: "" };
}

/** Return whether a derived status requires attention before landing. */
function isAttentionStatus(status: PullRequestStatus): boolean {
  return status === "tests-failed" || status === "merge-conflicts" ||
    status === "merge-blocked" || status === "visibility-unknown";
}

/** Return the display label for a derived pull-request status. */
function statusLabel(status: PullRequestStatus): string {
  switch (status) {
    case "green-and-can-land":
      return "Ready to land";
    case "tests-running":
      return "Tests running";
    case "tests-failed":
      return "Tests failed";
    case "merge-conflicts":
      return "Merge conflicts";
    case "merge-blocked":
      return "Merge blocked";
    case "visibility-unknown":
      return "Visibility unknown";
    case "draft":
      return "Draft";
  }
}

/** Return the badge color for a derived pull-request status. */
function statusColor(
  status: PullRequestStatus,
): "neutral" | "primary" | "accent" | "danger" {
  if (status === "green-and-can-land") return "primary";
  if (status === "tests-running" || status === "visibility-unknown") {
    return "accent";
  }
  if (status === "tests-failed" || status === "merge-conflicts") {
    return "danger";
  }
  return "neutral";
}

/** Return the badge color for the connector host state. */
function healthColor(
  status: string | undefined,
): "neutral" | "primary" | "accent" | "danger" {
  if (status === "ready" || status === undefined) return "primary";
  if (status === "degraded") return "danger";
  if (status === "starting" || status === "syncing") return "accent";
  return "neutral";
}

/** Format a nullable GitHub enum value for display. */
function enumLabel(value: string | null): string {
  if (value === null || value.length === 0) return "None";
  return value.toLowerCase().replaceAll("_", " ").replace(
    /^./,
    (first) => first.toUpperCase(),
  );
}

/** Return the visible prefix of a Git object identifier. */
function shortOid(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

/** Present synchronized pull requests or public repository activity. */
export default pattern<GithubActivityInput, GithubActivityOutput>((state) => {
  const activeTab = new Writable.perSession<SyncedTab>("pull-requests");

  const parsed = computed(() => parseUrl(state.repoUrl.get()));
  const fallbackApiUrl = computed(() => {
    // Empty URL and prompt inputs keep both network-backed built-ins idle.
    if (state.pullRequestIndex !== undefined) return "";
    const { owner, repo } = parsed;
    if (owner && repo) {
      return `https://api.github.com/repos/${owner}/${repo}/commits`;
    }
    return "";
  });

  const commitsData = fetchJson<CommitResponse>({ url: fallbackApiUrl });
  const commits = commitsData.result;
  const fallbackPrompt = computed(() => {
    const commitList = commits ?? [];
    if (commitList.length === 0) return "";
    const messages = commitList
      .slice(0, 10)
      .map((commit) => `- ${commit.commit.message.split("\n")[0]}`)
      .join("\n");
    return `Recent commits:\n${messages}`;
  });
  const summary = generateText({
    system:
      "You are a concise technical writer. Summarize the recent development activity based on these commit messages. Focus on themes and notable changes. Keep it to 2-3 sentences.",
    prompt: fallbackPrompt,
  });

  const repoName = computed(() => {
    const { owner, repo } = parsed;
    return owner && repo ? `${owner}/${repo}` : "GitHub Activity";
  });
  const indexedPullRequests = computed(() =>
    [...(state.pullRequestIndex?.pullRequests ?? [])].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.repository.localeCompare(right.repository) ||
      left.number - right.number
    )
  );
  const pullRequests = computed<GithubPullRequestFields[]>(() =>
    indexedPullRequests.map((row) => ({
      id: row.id,
      number: row.number,
      url: row.url,
      title: row.title,
      repository: row.repository,
      repositoryUrl: row.repositoryUrl,
      baseRefName: row.baseRefName,
      baseRefOid: row.baseRefOid,
      headRefName: row.headRefName,
      headRefOid: row.headRefOid,
      headRepository: row.headRepository,
      headRepositoryUrl: row.headRepositoryUrl,
      isDraft: row.isDraft,
      mergeable: row.mergeable,
      mergeState: row.mergeState,
      reviewDecision: row.reviewDecision,
      checkState: row.checkState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      observedAt: row.observedAt,
      visibility: row.visibility,
      status: row.status,
    }))
  );
  const pullRequestCount = computed(() => indexedPullRequests.length);
  const repositoryCount = computed(() => {
    const repositories = indexedPullRequests.map((row) => row.repository);
    return repositories.filter((repository, index) =>
      repositories.indexOf(repository) === index
    ).length;
  });
  const readyToLandCount = computed(() =>
    indexedPullRequests.filter((row) => row.status === "green-and-can-land")
      .length
  );
  const needsAttentionCount = computed(() =>
    indexedPullRequests.filter((row) => isAttentionStatus(row.status)).length
  );
  const testsRunningCount = computed(() =>
    indexedPullRequests.filter((row) => row.status === "tests-running").length
  );
  const draftCount = computed(() =>
    indexedPullRequests.filter((row) => row.status === "draft").length
  );
  const recentPullRequests = computed(() => indexedPullRequests.slice(0, 12));
  const pieceName = computed(() =>
    state.pullRequestIndex
      ? `GitHub pull requests: ${state.pullRequestIndex.viewer}`
      : `GitHub Activity: ${repoName}`
  );

  return {
    [NAME]: pieceName,
    [UI]: state.pullRequestIndex
      ? (
        <cf-screen>
          <cf-vstack gap="4" padding="4">
            <cf-hstack justify="between" align="center" gap="3" wrap>
              <div>
                <cf-heading level={2}>GitHub pull requests</cf-heading>
                <cf-text tone="muted">
                  @{state.pullRequestIndex.viewer} · generation{" "}
                  {state.pullRequestIndex.generation}
                </cf-text>
              </div>
              <cf-badge
                color={healthColor(state.health?.status)}
                variant="solid"
              >
                {state.health?.status ?? "index available"}
              </cf-badge>
            </cf-hstack>

            <cf-hgroup gap="md" wrap>
              <cf-card style={{ minWidth: "150px", flex: "1" }}>
                <cf-vstack gap="1">
                  <cf-text tone="muted">Tracked PRs</cf-text>
                  <cf-heading level={3}>{pullRequestCount}</cf-heading>
                </cf-vstack>
              </cf-card>
              <cf-card style={{ minWidth: "150px", flex: "1" }}>
                <cf-vstack gap="1">
                  <cf-text tone="muted">Repositories</cf-text>
                  <cf-heading level={3}>{repositoryCount}</cf-heading>
                </cf-vstack>
              </cf-card>
              <cf-card style={{ minWidth: "150px", flex: "1" }}>
                <cf-vstack gap="1">
                  <cf-text tone="muted">Ready to land</cf-text>
                  <cf-heading level={3}>{readyToLandCount}</cf-heading>
                </cf-vstack>
              </cf-card>
              <cf-card style={{ minWidth: "150px", flex: "1" }}>
                <cf-vstack gap="1">
                  <cf-text tone="muted">Tests running</cf-text>
                  <cf-heading level={3}>{testsRunningCount}</cf-heading>
                </cf-vstack>
              </cf-card>
              <cf-card style={{ minWidth: "150px", flex: "1" }}>
                <cf-vstack gap="1">
                  <cf-text tone="muted">Needs attention</cf-text>
                  <cf-heading level={3}>{needsAttentionCount}</cf-heading>
                </cf-vstack>
              </cf-card>
              <cf-card style={{ minWidth: "150px", flex: "1" }}>
                <cf-vstack gap="1">
                  <cf-text tone="muted">Drafts</cf-text>
                  <cf-heading level={3}>{draftCount}</cf-heading>
                </cf-vstack>
              </cf-card>
            </cf-hgroup>

            <cf-tabs $value={activeTab}>
              <cf-tab-list>
                <cf-tab value="pull-requests">All pull requests</cf-tab>
                <cf-tab value="recent">Recent activity</cf-tab>
                <cf-tab value="sync">Sync details</cf-tab>
              </cf-tab-list>

              <cf-tab-panel value="pull-requests">
                <cf-vstack gap="3" padding="3">
                  <cf-text tone="muted">
                    {computed(() =>
                      `${pullRequestCount} synchronized pull requests`
                    )}
                  </cf-text>

                  {computed(() => pullRequestCount === 0)
                    ? <cf-empty-state message="No synchronized pull requests" />
                    : (
                      <cf-card>
                        <cf-table full-width hover>
                          <thead>
                            <tr>
                              <th>Repository</th>
                              <th>Pull request</th>
                              <th>Status</th>
                              <th>Review</th>
                              <th>Checks</th>
                              <th>Merge</th>
                              <th>Updated</th>
                              <th>Snapshot</th>
                            </tr>
                          </thead>
                          <tbody>
                            {indexedPullRequests.map((row) => (
                              <tr>
                                <td>
                                  <a
                                    href={row.repositoryUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {row.repository}
                                  </a>
                                </td>
                                <td>
                                  <cf-vstack gap="1">
                                    <a
                                      href={row.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      #{row.number} {row.title}
                                    </a>
                                    <cf-text variant="caption" tone="muted">
                                      {row.headRepository
                                        ? `${row.headRepository}:`
                                        : ""}
                                      {row.headRefName} → {row.baseRefName}
                                    </cf-text>
                                  </cf-vstack>
                                </td>
                                <td>
                                  <cf-badge
                                    color={statusColor(row.status)}
                                    variant="solid"
                                  >
                                    {statusLabel(row.status)}
                                  </cf-badge>
                                </td>
                                <td>{enumLabel(row.reviewDecision)}</td>
                                <td>{enumLabel(row.checkState)}</td>
                                <td>{enumLabel(row.mergeState)}</td>
                                <td>{formatDate(row.updatedAt)}</td>
                                <td>
                                  <details>
                                    <summary>Fields</summary>
                                    <cf-vstack gap="1">
                                      <cf-text variant="caption">
                                        ID: {row.id}
                                      </cf-text>
                                      <cf-text variant="caption">
                                        Visibility: {row.visibility}
                                      </cf-text>
                                      <cf-text variant="caption">
                                        Mergeable: {enumLabel(row.mergeable)}
                                      </cf-text>
                                      <cf-text variant="caption">
                                        Base: {row.baseRefName} @{" "}
                                        {shortOid(row.baseRefOid)}
                                      </cf-text>
                                      <cf-text variant="caption">
                                        Head: {row.headRefName} @{" "}
                                        {shortOid(row.headRefOid)}
                                      </cf-text>
                                      <cf-text variant="caption">
                                        Created: {formatDate(row.createdAt)}
                                      </cf-text>
                                      <cf-text variant="caption">
                                        Observed: {formatDate(row.observedAt)}
                                      </cf-text>
                                    </cf-vstack>
                                  </details>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </cf-table>
                      </cf-card>
                    )}
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="recent">
                <cf-vstack gap="3" padding="3">
                  <cf-heading level={4}>
                    Recently updated pull requests
                  </cf-heading>
                  {recentPullRequests.length === 0
                    ? (
                      <cf-empty-state message="No recent pull-request activity" />
                    )
                    : recentPullRequests.map((row) => (
                      <cf-card>
                        <cf-hstack
                          justify="between"
                          align="center"
                          gap="3"
                          wrap
                        >
                          <cf-vstack gap="1">
                            <a
                              href={row.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {row.repository} #{row.number}: {row.title}
                            </a>
                            <cf-text variant="caption" tone="muted">
                              Updated {formatDate(row.updatedAt)} · observed
                              {" "}
                              {formatDate(row.observedAt)}
                            </cf-text>
                          </cf-vstack>
                          <cf-badge
                            color={statusColor(row.status)}
                            variant="solid"
                          >
                            {statusLabel(row.status)}
                          </cf-badge>
                        </cf-hstack>
                      </cf-card>
                    ))}
                </cf-vstack>
              </cf-tab-panel>

              <cf-tab-panel value="sync">
                <cf-vstack gap="3" padding="3">
                  <cf-card>
                    <cf-vstack gap="2">
                      <cf-heading level={4}>Published index</cf-heading>
                      <cf-table full-width>
                        <tbody>
                          <tr>
                            <th>Viewer</th>
                            <td>@{state.pullRequestIndex.viewer}</td>
                          </tr>
                          <tr>
                            <th>Generation</th>
                            <td>{state.pullRequestIndex.generation}</td>
                          </tr>
                          <tr>
                            <th>Collection observed</th>
                            <td>
                              {formatDate(
                                state.pullRequestIndex.lastCompleteCollectionAt,
                              )}
                            </td>
                          </tr>
                          <tr>
                            <th>Index published</th>
                            <td>
                              {formatDate(state.pullRequestIndex.generatedAt)}
                            </td>
                          </tr>
                          <tr>
                            <th>Pull requests</th>
                            <td>{pullRequestCount}</td>
                          </tr>
                        </tbody>
                      </cf-table>
                    </cf-vstack>
                  </cf-card>

                  {state.health
                    ? (
                      <cf-card>
                        <cf-vstack gap="2">
                          <cf-heading level={4}>Connector host</cf-heading>
                          <cf-table full-width>
                            <tbody>
                              <tr>
                                <th>Status</th>
                                <td>{state.health.status}</td>
                              </tr>
                              <tr>
                                <th>Updated</th>
                                <td>{formatDate(state.health.updatedAt)}</td>
                              </tr>
                              <tr>
                                <th>Last sync</th>
                                <td>{state.health.sync?.status ?? "—"}</td>
                              </tr>
                              <tr>
                                <th>Reason</th>
                                <td>{state.health.sync?.reason ?? "—"}</td>
                              </tr>
                              <tr>
                                <th>Sync started</th>
                                <td>
                                  {formatDate(state.health.sync?.startedAt)}
                                </td>
                              </tr>
                              <tr>
                                <th>Sync completed</th>
                                <td>
                                  {formatDate(state.health.sync?.completedAt)}
                                </td>
                              </tr>
                              <tr>
                                <th>Reported PR count</th>
                                <td>
                                  {state.health.sync?.pullRequestCount ?? "—"}
                                </td>
                              </tr>
                              <tr>
                                <th>Error</th>
                                <td>{state.health.sync?.error ?? "—"}</td>
                              </tr>
                              <tr>
                                <th>Index cell</th>
                                <td style="font-family: monospace; overflow-wrap: anywhere;">
                                  {state.health.target.cells.index}
                                </td>
                              </tr>
                              <tr>
                                <th>Health cell</th>
                                <td style="font-family: monospace; overflow-wrap: anywhere;">
                                  {state.health.target.cells.health}
                                </td>
                              </tr>
                            </tbody>
                          </cf-table>
                        </cf-vstack>
                      </cf-card>
                    )
                    : (
                      <cf-empty-state message="No connector health snapshot is connected" />
                    )}
                </cf-vstack>
              </cf-tab-panel>
            </cf-tabs>
          </cf-vstack>
        </cf-screen>
      )
      : (
        <div>
          <div style="margin-bottom: 16px;">
            <cf-input
              $value={state.repoUrl}
              placeholder="https://github.com/owner/repo"
              customStyle="width: 100%; padding: 8px; font-size: 14px;"
            />
          </div>

          {summary.pending
            ? (
              <div style="margin-bottom: 16px;">
                <cf-loader show-elapsed /> Generating summary...
              </div>
            )
            : summary.result
            ? (
              <div style="margin-bottom: 16px; padding: 12px; background: #f5f5f5; border-radius: 4px;">
                <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600;">
                  Activity Summary
                </h3>
                <p style="margin: 0; line-height: 1.5;">{summary.result}</p>
              </div>
            )
            : null}

          {computed(() => renderGithubCommits(commits))}
        </div>
      ),
    pullRequests,
    pullRequestCount,
    repositoryCount,
    readyToLandCount,
    needsAttentionCount,
  };
});
