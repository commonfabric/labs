# GitHub activity view

This pattern presents the complete pull-request index published by the GitHub
connector. Its default tab lists every synchronized pull request and its
repository, branches, derived status, review decision, check state, merge state,
update time, and snapshot fields. Summary cards count tracked pull requests,
repositories, PRs ready to land, running tests, PRs needing attention, and
drafts.

The recent-activity tab orders the twelve most recently updated pull requests.
The sync-details tab shows the published index generation and collection times.
When a connector health snapshot is supplied, it also shows host status, the
last sync result, any sync error, and the stable Fabric cell identifiers.

The `pullRequests` output carries the same shallow fields used by the table. It
does not export the index's opaque `detail` cells.

## Inputs

- `pullRequestIndex` accepts the
  `commonfabric.github-connector.pull-request-index.v1` value published by the
  connector.
- `health` optionally accepts the `commonfabric.github-connector.health.v1`
  value published by the same host.
- `repoUrl` remains a writable public GitHub repository URL. When no connector
  index is supplied, the pattern shows recent commits for this repository and a
  language-model summary. It defaults to
  `https://github.com/anthropics/claude-code`.

In the public-repository view, a terminal fetch failure leaves the empty commit
view renderable, and a failed summary leaves usable commits visible. Both
recover reactively. An empty request URL or summary prompt keeps its network
operation idle; it is not treated as a completed empty response.

The connector host prints the stable pull-request-index and health cell
identifiers after its initial collection. Supply those cells as the
`pullRequestIndex` and `health` inputs when creating the view piece.
