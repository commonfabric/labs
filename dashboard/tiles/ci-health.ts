/**
 * Reports whether every job the organization runs outside pull requests is
 * passing. It walks every repository the token can see that is not archived,
 * takes each active workflow in it, and reads that workflow's runs on the
 * repository's own default branch, newest first, back to the one that decides
 * the job. Runs from pull requests are left out, so what remains is the work
 * that lands on the default branch and the work a schedule or a manual start
 * kicks off: the main build, the benchmarks, the audits, and everything beside
 * them.
 *
 * A run concluded `success` passes and a run concluded `failure`, `timed_out`,
 * or `startup_failure` fails. A `cancelled` run is either a run a newer one
 * replaced, or whose jobs newer ones replaced, which passed no judgment on the
 * code, or a run that timed out, was stopped while its jobs ran, or had a job
 * fail, which failed; whether a job a runner ran ended in anything but success
 * for a reason other than a concurrency group cancelling it is what tells them
 * apart. Every remaining
 * conclusion — `skipped`, `neutral`, `stale`, `action_required` — passes no
 * judgment either, so the job is decided by the newest run before it that
 * does, however many runs came after that one, among the workflow's newest
 * RUNS_READ_MAX runs of any branch. A pass stays a pass
 * until a run gives the job another verdict.
 *
 * A failure counts only while the job, as it is configured now, would still
 * produce it. When the workflow's file has changed on the default branch since
 * the failing run, the run was made by a definition that no longer exists: a
 * job someone stopped rather than fixed, for example, by taking away the
 * trigger it failed under. Such a job has no verdict until a run under the
 * current definition gives it one, which for a job that still runs is its next
 * run and for one that no longer does is never. Only a failure is cleared this
 * way; a job whose deciding run passed stays green whatever changed since.
 *
 * A job that has been failing for longer than CI_FAILURE_FRESH_HOURS is still
 * failing and still listed, but it goes orange: it is no longer the thing that
 * just broke, and the red is left for a failure somebody can still act on.
 *
 * The labs and loom main builds stay in the body while the tile is not red, so
 * the two builds the team watches are visible even when there is nothing wrong.
 * A red tile shows only what is failing. Every job the collection read, and
 * what its deciding run concluded and took, is on the page behind the tile.
 *
 * The two main builds are judged from the snapshots of their runs that the ci
 * trust tiles read, each time a snapshot arrives, and are published with those
 * tiles. Every other job is judged from a sweep of the organization that runs
 * in the background once every SWEEP_TTL_MS, and as soon as the GitHub
 * webhook relay delivers the activity of a run of one of those jobs. While
 * the relay vouches for the runs held, a sweep reads only the runs that have
 * changed since the last one (github-runs.ts). A collection shows the last
 * sweep that finished and never waits for one, so a slow sweep holds up
 * neither this tile's main builds nor the tiles published with them. When a
 * sweep ends, the tile asks to be collected again from the snapshots already
 * held, so the sweep's findings are shown at once.
 *
 * Whether a failing job's workflow has changed since the failure is read once
 * for each failing run. It is read again after the relay delivers a push to
 * the run's repository's default branch, or when the relay cannot vouch that
 * none has been delivered.
 */

import {
  CI_FAILURE_FRESH_HOURS,
  CI_WORKFLOW,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  REPO,
} from "../config.ts";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { CompletedAttempts } from "../completed-attempts.ts";
import { detailList } from "../detail-list.ts";
import { livePageResponse } from "../live-page.ts";
import {
  type CiJobs,
  CI_JOBS_PATH,
  ciJobRows,
  ciJobsPage,
  ciJobsStatus,
  type Job,
  shortName,
} from "../ci-jobs-page.ts";
import {
  compactSpan,
  dashboardGitHubCredential,
  escapeHtml,
  friendlyError,
  github,
  GITHUB_REQUEST_CONCURRENCY,
  inParallel,
  memo,
  messageOf,
  runDurationMs,
  STATUS_RANK,
} from "../lib.ts";
import type { GitHubCredential } from "../github-auth.ts";
import { type GitHubRun, RunLists } from "../github-runs.ts";
import {
  Freshness,
  type GitHubWebhooks,
  githubWebhooks,
  pushOf,
  sameRepo,
  workflowRunOf,
} from "../github-webhooks.ts";
import { dashboardCacheFile } from "../history-files.ts";
import {
  type OrganizationRepo,
  organizationRepos,
} from "../organization-repos.ts";
import {
  type Ctx,
  type Run,
  runSource,
  type Status,
  type Tile,
  type TileView,
} from "../types.ts";

// The set of repositories and the workflows in them changes far more slowly
// than a job's result, so the inventory is read once an hour while the results
// behind it are read every SWEEP_TTL_MS.
const INVENTORY_TTL_MS = 3_600_000;

// How often the runs of every job other than the two main builds are read
// when no delivery of the relay has asked for it sooner.
export const SWEEP_TTL_MS = 300_000;

// The two main builds the dashboard used to carry a tile each for, whose runs
// the ci trust tiles read as well.
const PINNED = [
  runSource(REPO, CI_WORKFLOW, "main"),
  runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"),
];

const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
]);

const PULL_REQUEST_EVENTS = new Set([
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
]);

// The most runs of one workflow, of any branch or event, read for a verdict.
// A workflow with no verdict among its newest runs this far down has none.
const RUNS_READ_MAX = 1_000;

interface Workflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

interface RepoInventory {
  repo: string; // "owner/name"
  branch: string;
  workflows: Workflow[];
  error?: string; // set when the workflow listing could not be read
}

// One workflow's newest runs, or why they could not be read.
interface Listing {
  inventory: RepoInventory;
  workflow: Workflow;
  runs: Run[]; // newest first, none of them a pull request's
  error?: string;
}

const isWorkflow = (value: unknown): value is Workflow =>
  typeof value === "object" && value !== null &&
  Number.isSafeInteger((value as Workflow).id) &&
  typeof (value as Workflow).name === "string" &&
  typeof (value as Workflow).path === "string" &&
  typeof (value as Workflow).state === "string";


function workflowFile(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// Where a workflow's own runs are listed, for a row with no run to link at.
function workflowUrl(repo: string, path: string): string {
  return `https://github.com/${repo}/actions/workflows/${workflowFile(path)}`;
}

function isPinned(repo: string, path: string): boolean {
  return PINNED.some((source) =>
    source.repo === repo && source.workflow === workflowFile(path)
  );
}

async function repoWorkflows(
  repo: OrganizationRepo,
  credential: GitHubCredential,
): Promise<RepoInventory> {
  const inventory: RepoInventory = {
    repo: repo.name,
    branch: repo.branch,
    workflows: [],
  };
  try {
    for (let page = 1;; page++) {
      const answer = await github<{ workflows?: unknown }>(
        `repos/${repo.name}/actions/workflows?per_page=100&page=${page}`,
        credential,
      );
      const batch = answer.workflows;
      if (!Array.isArray(batch) || !batch.every(isWorkflow)) {
        throw new Error("GitHub workflows returned invalid data");
      }
      for (const workflow of batch) {
        if (workflow.state === "active") inventory.workflows.push(workflow);
      }
      if (batch.length < 100) break;
    }
  } catch (error) {
    inventory.error = messageOf(error);
  }
  return inventory;
}

/** Every readable repository in the organization, with its active workflows. */
async function readInventory(credential: GitHubCredential): Promise<RepoInventory[]> {
  const repos = await organizationRepos(credential);
  return await inParallel(
    GITHUB_REQUEST_CONCURRENCY,
    repos.map((repo) => () => repoWorkflows(repo, credential)),
  );
}

/**
 * Reads one workflow's newest runs on its repository's default branch,
 * leaving out any a pull request started, down to the first that concluded
 * `success` or failed, to the end of the list, or through RUNS_READ_MAX runs
 * of any branch. That run is read again by its id when it was not read from
 * the top of the list, so one started again since it was read is judged as it
 * stands now.
 */
async function readRuns(
  lists: RunLists,
  inventory: RepoInventory,
  workflow: Workflow,
  credential: GitHubCredential,
): Promise<Listing> {
  const onBranch = (run: GitHubRun) =>
    !PULL_REQUEST_EVENTS.has(run.event) && run.head_branch === inventory.branch;
  try {
    const runs = await lists.runs(
      (path, options) => github(path, credential, options),
      inventory.repo,
      workflow.id,
      {
        reader: "ci",
        confirmStop: true,
        wants: onBranch,
        recheck: [{ branch: inventory.branch }],
        until: (run, depth) =>
          depth === RUNS_READ_MAX - 1 ||
          onBranch(run) &&
            (run.conclusion === "success" ||
              FAILING_CONCLUSIONS.has(run.conclusion ?? "")),
      },
    );
    return { inventory, workflow, runs };
  } catch (error) {
    return { inventory, workflow, runs: [], error: messageOf(error) };
  }
}

/** Whether a completed run says the job failed, passed, or nothing at all. */
async function verdictOf(
  run: Run,
  attempts: CompletedAttempts,
): Promise<Status | undefined> {
  const conclusion = run.conclusion ?? "";
  if (conclusion === "success") return "good";
  if (FAILING_CONCLUSIONS.has(conclusion)) return "bad";
  if (conclusion === "cancelled") {
    return await attempts.cancelledWithoutVerdict(run) ? undefined : "bad";
  }
  return undefined;
}

/**
 * The newest run of `runs`, one workflow's newest runs as `readRuns` reads
 * them, that carries a verdict, and that verdict, however many runs that
 * judged nothing or are still going came after it. Rejects when a verdict
 * cannot be read.
 */
async function settle(
  runs: readonly Run[],
  attempts: CompletedAttempts,
): Promise<{ run: Run; status: Status } | undefined> {
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const status = await verdictOf(run, attempts);
    if (status !== undefined) return { run, status };
  }
  return undefined;
}

/**
 * Whether the workflow's file has changed on the default branch since `run`
 * was created, going by the newest commit there that touched the file. It is
 * asked only of a failing run, since a failure is what a stale definition can
 * wrongly keep on the board. A read that fails throws, and the caller keeps the
 * failure standing: a failure is never hidden on the strength of a request that
 * did not answer.
 */
async function redefinedSince(
  inventory: RepoInventory,
  workflow: Workflow,
  run: Run,
  credential: GitHubCredential,
): Promise<boolean> {
  const commits = await github<unknown>(
    `repos/${inventory.repo}/commits` +
      `?path=${encodeURIComponent(workflow.path)}` +
      `&sha=${encodeURIComponent(inventory.branch)}&per_page=1`,
    credential,
  );
  if (!Array.isArray(commits)) {
    throw new Error("GitHub commits returned invalid data");
  }
  const newest = commits[0];
  if (newest === undefined) return false;
  const commit = isObjectNotArray(newest) ? newest.commit : undefined;
  const committer = isObjectNotArray(commit) ? commit.committer : undefined;
  const date = isObjectNotArray(committer) ? committer.date : undefined;
  if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) {
    throw new Error("GitHub commits returned invalid data");
  }
  return Date.parse(date) > Date.parse(run.created_at);
}

/**
 * The job one workflow's runs describe. `redefined` says whether a failing
 * run's workflow has changed since the run, answering `false` when that cannot
 * be read.
 */
async function jobOf(
  listing: Listing,
  attempts: CompletedAttempts,
  redefined: (listing: Listing, run: Run) => Promise<boolean>,
  now: number,
): Promise<Job> {
  const { inventory, workflow } = listing;
  const job = {
    repo: shortName(inventory.repo),
    workflow: workflow.name,
    path: workflow.path,
    pinned: isPinned(inventory.repo, workflow.path),
    href: workflowUrl(inventory.repo, workflow.path),
    runningHref: listing.runs.find((run) => run.status === "in_progress")
      ?.html_url,
  };
  const unreadable = (result: string): Job => ({
    ...job,
    status: "warn",
    failing: false,
    result,
  });
  if (listing.error !== undefined) {
    return unreadable(friendlyError(listing.error));
  }
  let deciding: { run: Run; status: Status } | undefined;
  try {
    deciding = await settle(listing.runs, attempts);
  } catch (error) {
    return unreadable(friendlyError(messageOf(error)));
  }

  if (deciding === undefined) {
    // A job whose runs all passed over their work, as one gated off with a
    // job-level `if:` does, has runs and no verdict among them.
    const ran = listing.runs.some((run) => run.status === "completed");
    return {
      ...job,
      status: "unknown",
      failing: false,
      result: ran ? "no run judged anything" : "no completed run",
    };
  }
  const { run } = deciding;
  let { status } = deciding;
  const startedAt = Number.isFinite(Date.parse(run.run_started_at))
    ? Date.parse(run.run_started_at)
    : undefined;
  let failing = status === "bad";
  let result = run.conclusion ?? "";
  if (failing && await redefined(listing, run)) {
    status = "unknown";
    failing = false;
    result = "changed since it failed";
  }
  return {
    ...job,
    // A failure nobody has fixed in two days is not the thing that just
    // broke. It stays in the list and stays a failure, in orange.
    status: failing && stale(startedAt, now) ? "warn" : status,
    failing,
    result,
    event: run.event,
    startedAt,
    ranMs: runDurationMs(run),
    href: run.html_url,
  };
}

/** Whether a run is old enough that a failure of it is no longer news. */
function stale(startedAt: number | undefined, now: number): boolean {
  return startedAt !== undefined &&
    now - startedAt >= CI_FAILURE_FRESH_HOURS * 3_600_000;
}

/** What the tile's own row for a job says beside its name. */
function jobDetail(job: Job, now: number): string {
  const age = job.startedAt === undefined
    ? ""
    : `${compactSpan(now - job.startedAt)} ago`;
  if (job.status === "good") return age;
  // A failure says how long ago it ran whether it is red or has aged to
  // orange; for an old one, how long it has been failing is the point.
  if (!job.failing) return job.result;
  return age === "" ? job.result : `${job.result} · ${age}`;
}

function ciHealthView(collected: CiJobs, now = Date.now()): TileView {
  const { jobs, repos } = collected;
  const repoCount = repos.length;
  const rows = ciJobRows(collected);
  // A job that is failing is counted as failing however old the failure is;
  // its age decides the color, not whether it is named.
  const failing = rows.filter((row) => row.failing);
  const blind = rows.filter((row) => row.status === "warn" && !row.failing);
  // A job the tile has no verdict for is not one it can call passing, so the
  // count says how many jobs the headline actually speaks for.
  const measured = jobs.filter((job) => job.status !== "unknown").length;
  const status = ciJobsStatus(collected);

  const headline = failing.length === 1
    ? `${failing[0].repo} failing`
    : failing.length > 1
    ? `${failing.length} failing`
    : blind.length > 0
    ? `${blind.length} unreadable`
    : measured === 0
    ? "—"
    : "passing";

  // A red tile lists only what is failing, however old. Any other lists what
  // could not be read beside that, and the two main builds.
  const visible = rows
    .filter((row) =>
      row.failing ||
      (status !== "bad" && (row.status === "warn" || row.pinned))
    )
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);

  // The rows carry no links of their own: the whole tile is the link to the
  // page behind it.
  const body = detailList(
    visible.map((row) => ({
      status: row.status,
      name: `${row.repo} · ${row.workflow}`,
      detail: jobDetail(row, now),
    })),
    { subject: "Failing job details", focusKey: "jobs" },
  );

  // The scope rides in the header rather than on a line of its own, which is
  // the room the job list needs to reach the height of the tiles beside it.
  const scope = `${measured} job${measured === 1 ? "" : "s"} · ${repoCount} repo${
    repoCount === 1 ? "" : "s"
  }`;

  return {
    status,
    value: escapeHtml(headline),
    valueLabel: headline,
    aside: `<span class="hfacet" title="${escapeHtml(scope)}">${
      escapeHtml(scope)
    }</span>`,
    // One line under the headline, which the list takes when there is one: a
    // second would grow the tile past the ones it shares a row with.
    sub: body === undefined && measured === 0 ? "no jobs found" : undefined,
    extra: body,
    href: CI_JOBS_PATH,
    hint: "every job ↗",
  };
}

// What a sweep of the organization found: every repository and its
// workflows, every job other than the two main builds, and whether each
// failing run's workflow has changed since the run, by run id.
interface Sweep {
  repos: RepoInventory[];
  jobs: Job[];
  redefined: Redefinitions;
  at: number;
}

// Whether each failing run's workflow has changed since the run, by run id,
// with the repository the run is in.
type Redefinitions = Map<number, { repo: string; answer: Promise<boolean> }>;

/** The ci tile, and a way to wait for the sweep it has under way. */
export interface CiHealthTile extends Tile {
  sweeping(): Promise<void>;
  /** What the latest collection saw, which the tile's page renders. */
  jobs(): CiJobs | undefined;
}

/**
 * Builds the ci tile, which reads every workflow's runs through `lists`, and
 * learns of their activity, and of pushes, from `webhooks`.
 */
export function createCiHealth(
  lists: RunLists = new RunLists(),
  webhooks: GitHubWebhooks = githubWebhooks,
): CiHealthTile {
  // The inventory is read on first use and shared until it goes stale. A read
  // that fails is not kept, so the next sweep tries again.
  let inventory: (() => Promise<RepoInventory[]>) | undefined;
  // The last sweep that finished, why the last one failed if it did, and the
  // one under way. A sweep starts once every SWEEP_TTL_MS, or when a delivery
  // asks for one, and a collection never waits for one. A delivery's sweep
  // reads with the latest collection's context and credential.
  let swept: Sweep | undefined;
  let sweepFailure: string | undefined;
  let sweepStartedAt = -Infinity;
  let sweep: Promise<void> | undefined;
  let sweepWanted = false;
  let collectedWith: { ctx: Ctx; credential: GitHubCredential } | undefined;
  // Whether each failing run's workflow has changed since the run, kept from
  // sweep to sweep while the relay vouches for it. A push to a repository's
  // default branch drops the answers for that repository's runs.
  let redefined: Redefinitions = new Map();
  const definitions = new Freshness(webhooks, () => false);
  webhooks.listen((delivery) => {
    const push = pushOf(delivery);
    if (push === undefined || push.ref !== `refs/heads/${push.defaultBranch}`) {
      return;
    }
    for (const [id, { repo }] of redefined) {
      if (sameRepo(repo, push.repo)) redefined.delete(id);
    }
  });
  // What the latest collection to finish saw, which is what the page renders.
  // The tile is collected once for each of its snapshots, and the scheduler
  // shows the view of the collection that started last, so the page keeps
  // what that one saw even when an earlier one finishes after it.
  let collected: CiJobs | undefined;
  let collectionsStarted = 0;
  let collectedFrom = 0;
  // One job-listing cache per workflow, by workflow id, held across
  // collections. It reads with the credential the tile was given, like every
  // other request the tile makes.
  const attempts = new Map<number, CompletedAttempts>();

  const judge = (
    listing: Listing,
    redefined: Redefinitions,
    credential: GitHubCredential,
  ): Promise<Job> => {
    let held = attempts.get(listing.workflow.id);
    if (!held) {
      held = new CompletedAttempts(listing.inventory.repo, credential);
      attempts.set(listing.workflow.id, held);
    }
    held.observe(listing.runs);
    const changedSince = (failing: Listing, run: Run): Promise<boolean> => {
      let answer = redefined.get(run.id)?.answer;
      if (!answer) {
        answer = redefinedSince(failing.inventory, failing.workflow, run, credential)
          .catch((error) => {
            // The failure stands, and the reason it could not be checked is
            // logged with the other unreadable reads. The next sweep asks
            // again.
            redefined.delete(run.id);
            console.error(
              `ci: could not read ${shortName(failing.inventory.repo)} · ${failing.workflow.name}'s history:`,
              messageOf(error),
            );
            return false;
          });
        redefined.set(run.id, { repo: failing.inventory.repo, answer });
      }
      return answer;
    };
    return jobOf(listing, held, changedSince, Date.now());
  };

  const readSweep = async (credential: GitHubCredential): Promise<Sweep> => {
    inventory ??= memo(INVENTORY_TTL_MS, () => readInventory(credential));
    const repos = await inventory();
    const readable = repos.filter((repo) => repo.error === undefined);
    for (const id of attempts.keys()) {
      if (!readable.some((repo) => repo.workflows.some((w) => w.id === id))) {
        attempts.delete(id);
      }
    }
    const listings = await inParallel(
      GITHUB_REQUEST_CONCURRENCY,
      readable.flatMap((repo) =>
        repo.workflows
          .filter((workflow) => !isPinned(repo.repo, workflow.path))
          .map((workflow) => () => readRuns(lists, repo, workflow, credential))
      ),
    );
    let read: (() => void) | undefined;
    if (!definitions.current) {
      redefined = new Map();
      read = definitions.reading();
    }
    const checked = redefined;
    const jobs = await inParallel(
      GITHUB_REQUEST_CONCURRENCY,
      listings.map((listing) => () => judge(listing, checked, credential)),
    );
    read?.();
    logUnreadable([
      ...repos.filter((repo) => repo.error !== undefined).map((repo) =>
        repo.repo
      ),
      ...jobs.filter(isUnreadable).map(jobName),
    ]);
    return { repos, jobs, redefined: checked, at: Date.now() };
  };

  // Starts a sweep when one is due. Once it ends, the tile asks to be
  // collected again, so what the sweep found is shown without waiting for
  // the next snapshot, and a sweep a delivery asked for meanwhile starts.
  const startSweep = (ctx: Ctx, credential: GitHubCredential): void => {
    if (sweep) return;
    if (!sweepWanted && Date.now() - sweepStartedAt < SWEEP_TTL_MS) return;
    sweepWanted = false;
    sweepStartedAt = Date.now();
    sweep = readSweep(credential).then(
      (result) => {
        swept = result;
        sweepFailure = undefined;
      },
      (error) => {
        sweepFailure = messageOf(error);
        console.error(
          "ci: could not read the repository inventory:",
          sweepFailure,
        );
      },
    ).finally(() => {
      sweep = undefined;
      ctx.collectAgain?.();
      if (sweepWanted && collectedWith) {
        startSweep(collectedWith.ctx, collectedWith.credential);
      }
    });
  };

  // A run of a job the sweep judges, on its repository's default branch and
  // not for a pull request, asks for a sweep at once when it finishes, which
  // is when it can give the job a verdict.
  webhooks.listen((delivery) => {
    const activity = workflowRunOf(delivery);
    if (
      activity === undefined ||
      activity.run.status !== "completed" ||
      activity.run.head_branch !== activity.defaultBranch ||
      PULL_REQUEST_EVENTS.has(activity.run.event) ||
      isPinned(activity.repo, activity.run.path)
    ) return;
    sweepWanted = true;
    if (collectedWith) {
      startSweep(collectedWith.ctx, collectedWith.credential);
    }
  });

  // The two main builds, judged from the snapshots of their runs the tile is
  // collected from. A snapshot that is missing or out of date makes its build
  // unreadable rather than graying the tile.
  const judgePinned = (ctx: Ctx, from: Sweep, credential: GitHubCredential): Promise<Job[]> =>
    Promise.all(from.repos.flatMap((repo) =>
      repo.workflows
        .filter((workflow) => isPinned(repo.repo, workflow.path))
        .map(async (workflow) => {
          const source = runSource(repo.repo, workflowFile(workflow.path), "main");
          const problem = ctx.runSourceProblem?.(source);
          const listing: Listing = problem !== undefined
            ? { inventory: repo, workflow, runs: [], error: problem }
            : {
              inventory: repo,
              workflow,
              runs: (await ctx.runsFor(source)).filter((run) =>
                !PULL_REQUEST_EVENTS.has(run.event)
              ),
            };
          const job = await judge(listing, from.redefined, credential);
          // A snapshot's own problem is logged where the snapshot is read.
          if (problem === undefined && isUnreadable(job)) {
            logUnreadable([jobName(job)]);
          }
          return job;
        })
    ));

  return {
    label: "ci",
    // The same interval as the ci trust tiles, so the scheduler collects this
    // tile with them from each snapshot of the main builds' runs.
    intervalMs: 30_000,
    runSources: PINNED,
    reportsSourceProblems: true,
    routes: [{
      path: CI_JOBS_PATH,
      handler: () => livePageResponse(ciJobsPage(collected)),
      live: true,
    }],
    sweeping: () => sweep ?? Promise.resolve(),
    jobs: () => collected,
    async collect(ctx): Promise<TileView> {
      const credential = dashboardGitHubCredential(ctx);
      if (!credential) {
        return { status: "unknown", value: "—", sub: "set GH_TOKEN" };
      }

      const collection = ++collectionsStarted;
      collectedWith = { ctx, credential };
      startSweep(ctx, credential);
      if (sweepFailure !== undefined) {
        return {
          status: "unknown",
          value: "—",
          sub: friendlyError(sweepFailure),
        };
      }
      if (swept === undefined) {
        return { status: "unknown", value: "—", sub: "reading every repository" };
      }

      const jobs: CiJobs = {
        jobs: [...await judgePinned(ctx, swept, credential), ...swept.jobs],
        repos: swept.repos.map((repo) => shortName(repo.repo)),
        unreadableRepos: swept.repos
          .filter((repo) => repo.error !== undefined)
          .map((repo) => repo.repo),
        collectedAt: swept.at,
      };
      if (collection > collectedFrom) {
        collected = jobs;
        collectedFrom = collection;
      }
      return ciHealthView(jobs);
    },
  };
}

// A job whose runs could not be read, as distinct from an old failure, which
// is orange too and is read perfectly well.
function isUnreadable(job: Job): boolean {
  return job.status === "warn" && !job.failing;
}

function jobName(job: Job): string {
  return `${job.repo} · ${job.workflow}`;
}

function logUnreadable(names: string[]): void {
  if (names.length > 0) console.error("ci: could not read:", names.join(", "));
}

export const ciHealth = createCiHealth(
  new RunLists(dashboardCacheFile("fabric-wall-run-lists-ci.json")),
);
