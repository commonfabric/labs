/**
 * Builds the shared collection context handed to every tile. Its data sources
 * are memoized, so several tiles reading the same source — one repository's CI
 * runs, say — trigger only one fetch between them.
 */

import { github, memo } from "./lib.ts";
import {
  CI_RUNS_MAX,
  CI_RUNS_MAX_AGE_DAYS,
  CI_WORKFLOW,
  REPO,
} from "./config.ts";
import { type GitHubRun, type RunFilter, RunLists } from "./github-runs.ts";
import {
  type Ctx,
  type Run,
  runSource,
  type RunScope,
  type RunSource,
  runSourceKey,
} from "./types.ts";

/**
 * How a scope picks its runs out of a workflow's runs, and the filtered list
 * that names its runs that may have changed since they were read.
 */
const SCOPES: Record<
  RunScope,
  { has(run: GitHubRun): boolean; recheck: RunFilter }
> = {
  main: {
    has: (run) => run.head_branch === "main",
    recheck: { branch: "main" },
  },
  "pull requests": {
    has: (run) => run.event === "pull_request",
    recheck: { event: "pull_request" },
  },
};

// Whether `run` started before `cutoff`. A run with an unreadable start time is
// kept rather than read as ancient.
function startedBefore(run: GitHubRun, cutoff: number): boolean {
  const t = Date.parse(run.run_started_at);
  return Number.isFinite(t) && t < cutoff;
}

// Up to CI_RUNS_MAX runs of one source, newest first, stopping early once runs
// pass the age cutoff — i.e. min(CI_RUNS_MAX, ~2 months). Each run is tagged
// with the repo it came from so a combined stream (recent-runs) can link each
// row to the right repo. Each tile slices this base to its own window.
async function fetchRuns(lists: RunLists, source: RunSource): Promise<Run[]> {
  const scope = SCOPES[source.scope];
  const cutoff = Date.now() - CI_RUNS_MAX_AGE_DAYS * 86_400_000;
  const runs = await lists.runs(
    (path, options) => github(path, undefined, options),
    source.repo,
    source.workflow,
    {
      reader: runSourceKey(source),
      newest: 100,
      wants: scope.has,
      limit: CI_RUNS_MAX,
      recheck: [scope.recheck],
      // A run older than the window cannot be started again into it, since
      // GitHub stops that thirty days after a run is created.
      until: (run) => Date.parse(run.created_at) < cutoff,
    },
  );
  return runs
    .filter((run) => !startedBefore(run, cutoff))
    .map((run) => ({ ...run, repo: source.repo }));
}

export function makeCtx(): Ctx {
  // One memoized fetcher per source, created on first use and shared for ~20s
  // across every tile that reads it.
  const lists = new RunLists();
  const fetchers = new Map<string, () => Promise<Run[]>>();
  const runsFor = (source: RunSource): Promise<Run[]> => {
    const key = runSourceKey(source);
    let fetch = fetchers.get(key);
    if (!fetch) {
      fetch = memo(20_000, () => fetchRuns(lists, source));
      fetchers.set(key, fetch);
    }
    return fetch();
  };
  return {
    runs: () => runsFor(runSource(REPO, CI_WORKFLOW, "main")),
    runsFor,
    env: (k) => Deno.env.get(k),
  };
}
