/**
 * Reports whether every job the organization runs outside pull requests is
 * passing. It walks every repository the token can see that is not archived,
 * takes each active workflow in it, and reads that workflow's newest completed
 * runs on the repository's own default branch. Runs from pull requests are left
 * out, so what remains is the work that lands on the default branch and the
 * work a schedule or a manual start kicks off: the main build, the benchmarks,
 * the audits, and everything beside them.
 *
 * A run concluded `success` passes and a run concluded `failure`, `timed_out`,
 * or `startup_failure` fails. A `cancelled` run is either a queued run a newer
 * push replaced, which passed no judgment on the code, or a run that timed out
 * or was stopped while its jobs ran, which failed; an empty job listing is what
 * tells them apart. Every remaining conclusion — `skipped`, `neutral`, `stale`,
 * `action_required` — passes no judgment either, so the job is decided by the
 * newest run before it that does.
 *
 * A failure counts only while the job, as it is configured now, would still
 * produce it. When the workflow's file has changed on the default branch since
 * the failing run, the run was made by a definition that no longer exists: a
 * job someone stopped rather than fixed, for example, by taking away the
 * trigger it failed under. Such a job has no verdict until a run under the
 * current definition gives it one, which for a job that still runs is its next
 * run and for one that no longer does is never.
 *
 * A job that has been failing for longer than CI_FAILURE_FRESH_HOURS is still
 * failing and still listed, but it goes orange: it is no longer the thing that
 * just broke, and the red is left for a failure somebody can still act on.
 *
 * The labs and loom main builds stay in the body while the tile is not red, so
 * the two builds the team watches are visible even when there is nothing wrong.
 * A red tile shows only what is failing. Every job the collection read, and
 * what its deciding run concluded and took, is on the page behind the tile.
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
import {
  type CiJobs,
  CI_JOBS_PATH,
  ciJobsResponse,
  type Job,
} from "../ci-jobs-page.ts";
import {
  compactSpan,
  escapeHtml,
  friendlyError,
  github,
  memo,
  runDurationMs,
  STATUS_RANK,
  worstStatus,
} from "../lib.ts";
import type { Run, Status, Tile, TileView } from "../types.ts";

const ORG = REPO.split("/")[0];

// The set of repositories and the workflows in them changes far more slowly
// than a job's result, so the inventory is read once an hour while the results
// behind it are read on the tile's own interval.
const INVENTORY_TTL_MS = 3_600_000;

// Requests in flight at once. The inventory is tens of repositories wide and
// GitHub asks for a client's requests to be spread out rather than fired
// together.
const REQUEST_CONCURRENCY = 8;

// Runs read per workflow, of any status. The newest completed one carrying a
// verdict decides the job, the completed ones ahead of it cover a run of
// conclusions that carry none, and one still going tells a run it replaced
// from one that was stopped.
const RUNS_PER_WORKFLOW = 5;

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

// Runs asked for a page at a time. A pull request from a fork's branch named
// after the default branch lands among the default branch's runs, so the pages
// go on until the window holds enough runs that are not a pull request's; a
// page this large almost always holds them.
const RUNS_PAGE = 20;

interface OrgRepo {
  full_name: string;
  default_branch: string;
  archived: boolean;
}

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

// One workflow's newest completed runs, or why they could not be read.
interface Listing {
  inventory: RepoInventory;
  workflow: Workflow;
  runs: Run[]; // newest first, none of them a pull request's
  error?: string;
}

const isOrgRepo = (value: unknown): value is OrgRepo =>
  typeof value === "object" && value !== null &&
  typeof (value as OrgRepo).full_name === "string" &&
  typeof (value as OrgRepo).default_branch === "string" &&
  typeof (value as OrgRepo).archived === "boolean";

const isWorkflow = (value: unknown): value is Workflow =>
  typeof value === "object" && value !== null &&
  Number.isSafeInteger((value as Workflow).id) &&
  typeof (value as Workflow).name === "string" &&
  typeof (value as Workflow).path === "string" &&
  typeof (value as Workflow).state === "string";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

function workflowFile(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// Where a workflow's own runs are listed, for a row with no run to link at.
function workflowUrl(repo: string, path: string): string {
  return `https://github.com/${repo}/actions/workflows/${workflowFile(path)}`;
}

// The two main builds the dashboard used to carry a tile each for.
function isPinned(repo: string, path: string): boolean {
  const file = workflowFile(path);
  return (repo === REPO && file === CI_WORKFLOW) ||
    (repo === LOOM_REPO && file === LOOM_CI_WORKFLOW);
}

/** Runs tasks with a bounded number in flight, answering in the given order. */
async function inParallel<T>(
  limit: number,
  tasks: readonly (() => Promise<T>)[],
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return results;
}

/**
 * Every repository in the organization the token can see, minus the archived
 * ones. A token that cannot see a private repository is not shown it here, so
 * the tile covers what the token reaches and says nothing about the rest.
 */
async function organizationRepos(token: string): Promise<OrgRepo[]> {
  const repos: OrgRepo[] = [];
  for (let page = 1;; page++) {
    const batch = await github<unknown>(
      `orgs/${ORG}/repos?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || !batch.every(isOrgRepo)) {
      throw new Error("GitHub organization repositories returned invalid data");
    }
    for (const repo of batch) if (!repo.archived) repos.push(repo);
    if (batch.length < 100) return repos;
  }
}

async function repoWorkflows(
  repo: OrgRepo,
  token: string,
): Promise<RepoInventory> {
  const inventory: RepoInventory = {
    repo: repo.full_name,
    branch: repo.default_branch,
    workflows: [],
  };
  try {
    for (let page = 1;; page++) {
      const answer = await github<{ workflows?: unknown }>(
        `repos/${repo.full_name}/actions/workflows?per_page=100&page=${page}`,
        token,
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
async function readInventory(token: string): Promise<RepoInventory[]> {
  const repos = await organizationRepos(token);
  return await inParallel(
    REQUEST_CONCURRENCY,
    repos.map((repo) => () => repoWorkflows(repo, token)),
  );
}

/**
 * One workflow's newest runs on its repository's default branch, leaving out
 * any a pull request started. A run that lands between two pages moves an
 * earlier one onto the next, so a run is taken once however many pages hold it.
 */
async function readRuns(
  inventory: RepoInventory,
  workflow: Workflow,
  token: string,
): Promise<Listing> {
  try {
    const runs = new Map<number, Run>();
    for (let page = 1; runs.size < RUNS_PER_WORKFLOW; page++) {
      const answer = await github<{ workflow_runs?: Run[] }>(
        `repos/${inventory.repo}/actions/workflows/${workflow.id}/runs` +
          `?branch=${encodeURIComponent(inventory.branch)}` +
          `&per_page=${RUNS_PAGE}&page=${page}`,
        token,
      );
      const batch = answer.workflow_runs ?? [];
      for (const run of batch) {
        if (!PULL_REQUEST_EVENTS.has(run.event)) runs.set(run.id, run);
      }
      if (batch.length < RUNS_PAGE) break;
    }
    return {
      inventory,
      workflow,
      runs: [...runs.values()].slice(0, RUNS_PER_WORKFLOW),
    };
  } catch (error) {
    return { inventory, workflow, runs: [], error: messageOf(error) };
  }
}

/**
 * Whether a completed run says the job failed, passed, or nothing at all.
 * `runs` are the workflow's other recent runs, of any status.
 */
async function verdictOf(
  run: Run,
  runs: readonly Run[],
  attempts: CompletedAttempts,
): Promise<Status | undefined> {
  const conclusion = run.conclusion ?? "";
  if (conclusion === "success") return "good";
  if (FAILING_CONCLUSIONS.has(conclusion)) return "bad";
  if (conclusion === "cancelled") {
    // A newer run created while this one was still going replaced it. A
    // concurrency group that cancels in progress stops the older run when the
    // newer one starts, whether or not the older one had started its jobs, and
    // that judges nothing about the code.
    const ended = Date.parse(run.updated_at);
    const replaced = runs.some((other) =>
      Date.parse(other.created_at) > Date.parse(run.created_at) &&
      Date.parse(other.created_at) <= ended
    );
    if (replaced) return undefined;
    // Otherwise a run cancelled with an empty job listing is one a newer push
    // replaced while it was still queued, and one that ran jobs timed out or
    // was stopped.
    return await attempts.cancelledBeforeAnyJob(run) ? undefined : "bad";
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
  token: string,
): Promise<boolean> {
  const commits = await github<unknown>(
    `repos/${inventory.repo}/commits` +
      `?path=${encodeURIComponent(workflow.path)}` +
      `&sha=${encodeURIComponent(inventory.branch)}&per_page=1`,
    token,
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

/** The job one workflow's runs describe. */
async function jobOf(
  listing: Listing,
  attempts: CompletedAttempts,
  token: string,
  now: number,
): Promise<Job> {
  const { inventory, workflow } = listing;
  const job = {
    repo: shortName(inventory.repo),
    workflow: workflow.name,
    pinned: isPinned(inventory.repo, workflow.path),
    href: workflowUrl(inventory.repo, workflow.path),
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

  for (const run of listing.runs) {
    if (run.status !== "completed") continue;
    let status: Status | undefined;
    try {
      status = await verdictOf(run, listing.runs, attempts);
    } catch (error) {
      return unreadable(friendlyError(messageOf(error)));
    }
    if (status === undefined) continue;
    const startedAt = Number.isFinite(Date.parse(run.run_started_at))
      ? Date.parse(run.run_started_at)
      : undefined;
    let failing = status === "bad";
    let result = run.conclusion ?? "";
    if (failing) {
      let redefined: boolean;
      try {
        redefined = await redefinedSince(inventory, workflow, run, token);
      } catch (error) {
        // The failure stands, and the reason it could not be checked is
        // logged with the collection's other unreadable reads.
        console.error(
          `ci: could not read ${job.repo} · ${job.workflow}'s history:`,
          messageOf(error),
        );
        redefined = false;
      }
      if (redefined) {
        status = "unknown";
        failing = false;
        result = "changed since it failed";
      }
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
  // A job whose recent runs all passed over their work, as one gated off with
  // a job-level `if:` does, has runs and no verdict among them.
  const ran = listing.runs.some((run) => run.status === "completed");
  return {
    ...job,
    status: "unknown",
    failing: false,
    result: ran ? "recent runs judged nothing" : "no completed run",
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
  const { jobs, repoCount, unreadableRepos } = collected;
  // A repository whose workflows could not be listed stands in the body as a
  // row of its own, since the jobs behind it are the ones nobody can see.
  const rows: Job[] = [
    ...jobs,
    ...unreadableRepos.map((repo): Job => ({
      repo: shortName(repo),
      workflow: "workflows",
      pinned: false,
      status: "warn",
      failing: false,
      result: "unreadable",
      href: `https://github.com/${repo}/actions`,
    })),
  ];
  // A job that is failing is counted as failing however old the failure is;
  // its age decides the color, not whether it is named.
  const failing = rows.filter((row) => row.failing);
  const blind = rows.filter((row) => row.status === "warn" && !row.failing);
  // A job the tile has no verdict for is not one it can call passing, so the
  // count says how many jobs the headline actually speaks for.
  const measured = jobs.filter((job) => job.status !== "unknown").length;
  // A job with no verdict says nothing about the tile's color, so the color
  // comes from the rows that carry one. Nothing carrying one at all is not the
  // same as nothing being wrong, and reads gray.
  const judged = rows.filter((row) => row.status !== "unknown");
  const status: Status = judged.length === 0
    ? "unknown"
    : worstStatus(judged.map((row) => row.status));

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
  // page behind it, and an anchor cannot hold another.
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

export function createCiHealth(): Tile {
  // The inventory is read on first use and shared until it goes stale. A read
  // that fails is not kept, so the next collection tries again.
  let inventory: (() => Promise<RepoInventory[]>) | undefined;
  // What the last finished collection saw, which is what the page renders.
  let collected: CiJobs | undefined;
  // One job-count cache per repository, held across collections. It reads
  // with the token the tile was given, like every other request the tile makes.
  const attempts = new Map<string, CompletedAttempts>();
  const attemptsFor = (repo: string, token: string): CompletedAttempts => {
    let held = attempts.get(repo);
    if (!held) {
      held = new CompletedAttempts(repo, token);
      attempts.set(repo, held);
    }
    return held;
  };

  return {
    label: "ci",
    intervalMs: 300_000,
    routes: [{
      path: CI_JOBS_PATH,
      handler: () => ciJobsResponse(collected),
    }],
    async collect(ctx): Promise<TileView> {
      const token = ctx.env("GH_TOKEN") ?? ctx.env("GITHUB_TOKEN");
      if (!token) {
        return { status: "unknown", value: "—", sub: "set GH_TOKEN" };
      }

      inventory ??= memo(INVENTORY_TTL_MS, () => readInventory(token));
      let repos: RepoInventory[];
      try {
        repos = await inventory();
      } catch (error) {
        const message = messageOf(error);
        console.error("ci: could not read the repository inventory:", message);
        return {
          status: "unknown",
          value: "—",
          sub: friendlyError(message),
        };
      }

      const readable = repos.filter((repo) => repo.error === undefined);
      const listings = await inParallel(
        REQUEST_CONCURRENCY,
        readable.flatMap((repo) =>
          repo.workflows.map((workflow) => () =>
            readRuns(repo, workflow, token)
          )
        ),
      );
      // Each repository's job-count cache keeps what the runs just read need
      // and forgets the rest, so it is handed every run of that repository at
      // once, before any of its jobs are decided.
      for (const repo of readable) {
        attemptsFor(repo.repo, token).observe(
          listings.filter((listing) => listing.inventory.repo === repo.repo)
            .flatMap((listing) => listing.runs),
        );
      }
      for (const repo of attempts.keys()) {
        if (!readable.some((entry) => entry.repo === repo)) {
          attempts.delete(repo);
        }
      }

      const jobs = await inParallel(
        REQUEST_CONCURRENCY,
        listings.map((listing) => () =>
          jobOf(
            listing,
            attemptsFor(listing.inventory.repo, token),
            token,
            Date.now(),
          )
        ),
      );
      const unreadableRepos = repos.filter((repo) => repo.error !== undefined)
        .map((repo) => repo.repo);
      const unreadable = [
        ...unreadableRepos,
        // An old failure is orange too, and is read perfectly well.
        ...jobs.filter((job) => job.status === "warn" && !job.failing).map((job) =>
          `${job.repo} · ${job.workflow}`
        ),
      ];
      if (unreadable.length > 0) {
        console.error("ci: could not read:", unreadable.join(", "));
      }
      collected = {
        jobs,
        repoCount: repos.length,
        unreadableRepos,
        collectedAt: Date.now(),
      };
      return ciHealthView(collected);
    },
  };
}

export const ciHealth = createCiHealth();
