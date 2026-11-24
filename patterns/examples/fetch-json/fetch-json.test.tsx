import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  findElementByText,
  findNodeById,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import FetchJson from "./fetch-json.tsx";

// A repository response with every field the pattern's response type
// requires, as GitHub sends it.
const ROCKET = {
  id: 1,
  node_id: "node_id",
  name: "rocket",
  full_name: "acme/rocket",
  private: false,
  owner: {
    login: "acme",
    id: 1,
    node_id: "node_id",
    avatar_url: "https://api.github.com/users/acme/avatar_url",
    gravatar_id: "gravatar_id",
    url: "https://api.github.com/users/acme/url",
    html_url: "https://github.com/acme",
    followers_url: "https://api.github.com/users/acme/followers_url",
    following_url: "https://api.github.com/users/acme/following_url",
    gists_url: "https://api.github.com/users/acme/gists_url",
    starred_url: "https://api.github.com/users/acme/starred_url",
    subscriptions_url: "https://api.github.com/users/acme/subscriptions_url",
    organizations_url: "https://api.github.com/users/acme/organizations_url",
    repos_url: "https://api.github.com/users/acme/repos_url",
    events_url: "https://api.github.com/users/acme/events_url",
    received_events_url:
      "https://api.github.com/users/acme/received_events_url",
    type: "type",
    user_view_type: "user_view_type",
    site_admin: false,
  },
  html_url: "https://github.com/acme/rocket",
  description: "A rocket for testing",
  fork: false,
  url: "https://api.github.com/repos/acme/rocket/url",
  forks_url: "https://api.github.com/repos/acme/rocket/forks_url",
  keys_url: "https://api.github.com/repos/acme/rocket/keys_url",
  collaborators_url:
    "https://api.github.com/repos/acme/rocket/collaborators_url",
  teams_url: "https://api.github.com/repos/acme/rocket/teams_url",
  hooks_url: "https://api.github.com/repos/acme/rocket/hooks_url",
  issue_events_url: "https://api.github.com/repos/acme/rocket/issue_events_url",
  events_url: "https://api.github.com/repos/acme/rocket/events_url",
  assignees_url: "https://api.github.com/repos/acme/rocket/assignees_url",
  branches_url: "https://api.github.com/repos/acme/rocket/branches_url",
  tags_url: "https://api.github.com/repos/acme/rocket/tags_url",
  blobs_url: "https://api.github.com/repos/acme/rocket/blobs_url",
  git_tags_url: "https://api.github.com/repos/acme/rocket/git_tags_url",
  git_refs_url: "https://api.github.com/repos/acme/rocket/git_refs_url",
  trees_url: "https://api.github.com/repos/acme/rocket/trees_url",
  statuses_url: "https://api.github.com/repos/acme/rocket/statuses_url",
  languages_url: "https://api.github.com/repos/acme/rocket/languages_url",
  stargazers_url: "https://api.github.com/repos/acme/rocket/stargazers_url",
  contributors_url: "https://api.github.com/repos/acme/rocket/contributors_url",
  subscribers_url: "https://api.github.com/repos/acme/rocket/subscribers_url",
  subscription_url: "https://api.github.com/repos/acme/rocket/subscription_url",
  commits_url: "https://api.github.com/repos/acme/rocket/commits_url",
  git_commits_url: "https://api.github.com/repos/acme/rocket/git_commits_url",
  comments_url: "https://api.github.com/repos/acme/rocket/comments_url",
  issue_comment_url:
    "https://api.github.com/repos/acme/rocket/issue_comment_url",
  contents_url: "https://api.github.com/repos/acme/rocket/contents_url",
  compare_url: "https://api.github.com/repos/acme/rocket/compare_url",
  merges_url: "https://api.github.com/repos/acme/rocket/merges_url",
  archive_url: "https://api.github.com/repos/acme/rocket/archive_url",
  downloads_url: "https://api.github.com/repos/acme/rocket/downloads_url",
  issues_url: "https://api.github.com/repos/acme/rocket/issues_url",
  pulls_url: "https://api.github.com/repos/acme/rocket/pulls_url",
  milestones_url: "https://api.github.com/repos/acme/rocket/milestones_url",
  notifications_url:
    "https://api.github.com/repos/acme/rocket/notifications_url",
  labels_url: "https://api.github.com/repos/acme/rocket/labels_url",
  releases_url: "https://api.github.com/repos/acme/rocket/releases_url",
  deployments_url: "https://api.github.com/repos/acme/rocket/deployments_url",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  pushed_at: "2026-01-01T00:00:00Z",
  git_url: "https://api.github.com/repos/acme/rocket/git_url",
  ssh_url: "https://api.github.com/repos/acme/rocket/ssh_url",
  clone_url: "https://api.github.com/repos/acme/rocket/clone_url",
  svn_url: "https://api.github.com/repos/acme/rocket/svn_url",
  homepage: null,
  size: 1,
  stargazers_count: 42,
  watchers_count: 42,
  language: "TypeScript",
  has_issues: false,
  has_projects: false,
  has_downloads: false,
  has_wiki: false,
  has_pages: false,
  has_discussions: false,
  forks_count: 7,
  mirror_url: null,
  archived: false,
  disabled: false,
  open_issues_count: 3,
  license: null,
  allow_forking: false,
  is_template: false,
  web_commit_signoff_required: false,
  topics: [],
  visibility: "public",
  forks: 7,
  open_issues: 3,
  watchers: 42,
  default_branch: "main",
  temp_clone_token: null,
  custom_properties: {},
  network_count: 7,
  subscribers_count: 5,
};

export const fetchMocks = [
  {
    urlIncludes: "api.github.com/repos/acme/rocket",
    contentType: "application/json",
    body: JSON.stringify(ROCKET),
  },
];

export default pattern(() => {
  const repoUrl = Writable.of("https://github.com/acme/rocket");
  const subject = FetchJson({ repoUrl });

  const assert_shows_fetched_repo = assert(() =>
    subject.repo?.name === "rocket" &&
    subject.repo?.owner.login === "acme" &&
    hasText(findNodeById(subject[UI], "github-title"), "rocket") &&
    hasText(subject[UI], "by acme") &&
    hasText(subject[UI], "A rocket for testing") &&
    hasText(subject[UI], "42 stars") && hasText(subject[UI], "7 forks") &&
    hasText(subject[UI], "TypeScript")
  );
  const assert_links_to_repo = assert(() =>
    propValue(
      findElementByText(subject[UI], "a", "View on GitHub"),
      "href",
    ) === "https://github.com/acme/rocket"
  );
  const assert_no_placeholder = assert(() =>
    !hasText(subject[UI], "Unknown") &&
    !hasText(subject[UI], "No description provided")
  );

  const action_enter_non_github_url = action(() =>
    repoUrl.set("https://example.com/somewhere")
  );
  // A URL that names no GitHub repository fetches nothing, so the repository
  // fetched before is no longer shown.
  const assert_previous_repo_dropped = assert(() =>
    !hasText(subject[UI], "by acme") &&
    !hasText(subject[UI], "A rocket for testing")
  );

  return {
    [TESTS]: [
      { settle: true },
      { assertion: assert_shows_fetched_repo },
      { assertion: assert_links_to_repo },
      { assertion: assert_no_placeholder },
      { action: action_enter_non_github_url },
      { settle: true },
      { assertion: assert_previous_repo_dropped },
    ],
    subject,
  };
});
