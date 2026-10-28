/**
 * Builds the shared collection context handed to every tile, and says which
 * deliveries of the GitHub webhook relay change the runs a source reads.
 */

import {
  type GitHubDelivery,
  pushOf,
  sameRepo,
  workflowRunOf,
} from "./github-webhooks.ts";
import { github } from "./lib.ts";
import {
  CI_RUNS_MAX,
  CI_RUNS_MAX_AGE_DAYS,
  CI_WORKFLOW,
  REPO,
} from "./config.ts";
import { type GitHubRun, type RunFilter, RunLists } from "./github-runs.ts";
import { type GreenBranch, greenBranchOf } from "./green-branch.ts";
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
// with the repo it came from so a combined stream (recent commits) can link each
// row to the right repo, and a run on main with what the repo's green branch
// says of its commit, read alongside the runs. Each tile slices this base to
// its own window.
async function fetchRuns(
  lists: RunLists,
  source: RunSource,
  greenBranchOf: (repo: string) => GreenBranch | undefined,
): Promise<Run[]> {
  const scope = SCOPES[source.scope];
  const cutoff = Date.now() - CI_RUNS_MAX_AGE_DAYS * 86_400_000;
  const green = source.scope === "main"
    ? greenBranchOf(source.repo)
    : undefined;
  const [runs] = await Promise.all([lists.runs(
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
  ), green?.refresh(cutoff)]);
  return runs
    .filter((run) => !startedBefore(run, cutoff))
    .map((run) => {
      const mark = green?.mark(run.head_sha);
      return mark === undefined
        ? { ...run, repo: source.repo }
        : { ...run, repo: source.repo, green: mark };
    });
}

/**
 * Returns whether `delivery` changes what `source` reads: the activity of one
 * of its runs, or, for a source of runs on main, a push to the repository's
 * green branch, which `green` names.
 */
export function changesRunSource(
  source: RunSource,
  delivery: GitHubDelivery,
  green: (repo: string) => GreenBranch | undefined = greenBranchOf,
): boolean {
  const activity = workflowRunOf(delivery);
  if (activity !== undefined) {
    return sameRepo(activity.repo, source.repo) &&
      activity.workflowFile === source.workflow &&
      SCOPES[source.scope].has(activity.run);
  }
  const push = pushOf(delivery);
  return push !== undefined && source.scope === "main" &&
    green(source.repo)?.isPushedBy(push.repo, push.ref) === true;
}

/**
 * Builds the context, reading each repository's green branch through
 * `green`, which defaults to the branches `GREEN_BRANCHES` names, and the
 * runs of every source through `lists`. Each call reads the source again
 * through `lists`, which shares the reads made close together.
 */
export function makeCtx(
  green: (repo: string) => GreenBranch | undefined = greenBranchOf,
  lists: RunLists = new RunLists(),
): Ctx {
  const runsFor = (source: RunSource): Promise<Run[]> =>
    fetchRuns(lists, source, green);
  return {
    runs: () => runsFor(runSource(REPO, CI_WORKFLOW, "main")),
    runsFor,
    runLists: lists,
    env: (k) => Deno.env.get(k),
  };
}
