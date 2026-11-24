export type CommitResponse = Array<{
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
}>;

/** Format an ISO timestamp in UTC. */
export function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
}

/** Render public repository commits returned by the GitHub API. */
export function renderGithubCommits(
  commitList: CommitResponse | undefined,
) {
  if (!commitList || commitList.length === 0) {
    return (
      <div style="padding: 16px; text-align: center; color: #666;">
        No commits found
      </div>
    );
  }
  return (
    <div style="max-height: 500px; overflow-y: auto;">
      {commitList.slice(0, 20).map((commit) => (
        <cf-card style="margin-bottom: 8px;">
          <div style="padding: 12px;">
            <div style="font-weight: 500; margin-bottom: 4px;">
              {commit.commit.message.split("\n")[0]}
            </div>
            <div style="font-size: 13px; color: #666; margin-bottom: 8px;">
              {commit.commit.author.name} • {formatDate(
                commit.commit.author.date,
              )}
            </div>
            <a
              href={commit.html_url}
              target="_blank"
              rel="noopener noreferrer"
              style="font-size: 13px; color: #0969da;"
            >
              View commit →
            </a>
          </div>
        </cf-card>
      ))}
    </div>
  );
}
