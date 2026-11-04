import {
  computed,
  Default,
  fetchJson,
  NAME,
  pattern,
  resultOf,
  UI,
  Writable,
} from "commonfabric";

type GithubResponse = {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    user_view_type: string;
    site_admin: boolean;
  };
  html_url: string;
  description: string | null;
  fork: boolean;
  url: string;
  forks_url: string;
  keys_url: string;
  collaborators_url: string;
  teams_url: string;
  hooks_url: string;
  issue_events_url: string;
  events_url: string;
  assignees_url: string;
  branches_url: string;
  tags_url: string;
  blobs_url: string;
  git_tags_url: string;
  git_refs_url: string;
  trees_url: string;
  statuses_url: string;
  languages_url: string;
  stargazers_url: string;
  contributors_url: string;
  subscribers_url: string;
  subscription_url: string;
  commits_url: string;
  git_commits_url: string;
  comments_url: string;
  issue_comment_url: string;
  contents_url: string;
  compare_url: string;
  merges_url: string;
  archive_url: string;
  downloads_url: string;
  issues_url: string;
  pulls_url: string;
  milestones_url: string;
  notifications_url: string;
  labels_url: string;
  releases_url: string;
  deployments_url: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  git_url: string;
  ssh_url: string;
  clone_url: string;
  svn_url: string;
  homepage: string | null;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  language: string | null;
  has_issues: boolean;
  has_projects: boolean;
  has_downloads: boolean;
  has_wiki: boolean;
  has_pages: boolean;
  has_discussions: boolean;
  forks_count: number;
  mirror_url: string | null;
  archived: boolean;
  disabled: boolean;
  open_issues_count: number;
  license: {
    key: string;
    name: string;
    spdx_id: string;
    url: string;
    node_id: string;
  } | null;
  allow_forking: boolean;
  is_template: boolean;
  web_commit_signoff_required: boolean;
  topics: string[];
  visibility: string;
  forks: number;
  open_issues: number;
  watchers: number;
  default_branch: string;
  temp_clone_token: string | null;
  custom_properties: Record<string, any>;
  // GitHub omits `organization` for user-owned repos.
  organization?: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    user_view_type: string;
    site_admin: boolean;
  };
  network_count: number;
  subscribers_count: number;
};

function parseUrl(url: string): { org: string; user: string } {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return { org: match[1], user: match[2] };
  }
  return { org: "", user: "" };
}

export default pattern<
  { repoUrl: Writable<string | Default<"https://github.com/vercel/next.js">> }
>((state) => {
  // Parse URL and create API endpoint
  const output = computed(() => parseUrl(state.repoUrl.get()));
  const apiUrl = computed(() => {
    const { org, user } = output;
    if (org && user) {
      return `https://api.github.com/repos/${org}/${user}`;
    }
    return "";
  });

  // Fetch repository data
  const repoRequest = fetchJson<GithubResponse>({
    url: apiUrl,
  });
  const data = resultOf(repoRequest);

  const validData = data;

  return {
    [NAME]: "GitHub Repository Details",
    [UI]: (
      <div>
        <div>
          <cf-input
            $value={state.repoUrl}
            placeholder="https://github.com/owner/repo"
            customStyle="width: 100%; padding: 8px; font-size: 14px;"
          />
        </div>

        <div>
          <h3 id="github-title">
            {validData.name}
          </h3>
          <p>
            by {validData.owner.login}
          </p>
          <p>{validData.description}</p>
          <div>
            <div>
              <span>⭐</span>
              <strong>{validData.stargazers_count}</strong> stars
            </div>
            <div>
              <span>🍴</span>
              <strong>{validData.forks_count}</strong> forks
            </div>
            <div>
              <span>🔤</span>
              <strong>{validData.language}</strong>
            </div>
            <div>
              <a
                href={validData.html_url}
                target="_blank"
              >
                View on GitHub →
              </a>
            </div>
          </div>
        </div>
      </div>
    ),
    repo: validData,
  };
});
