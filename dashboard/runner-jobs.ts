/**
 * Follows which GitHub Actions jobs are queued and running, and how each job
 * that ends ended, from what GitHub says about jobs and runs: the
 * `workflow_job` and `workflow_run` deliveries of the webhook relay, and the
 * same objects read from GitHub's API.
 *
 * The runners page (runners-page.ts) runs a `JobTracker` in the browser as
 * well as on the server, so every declaration the class uses is one that page
 * hands the browser by name.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

/** How a job that has ended ended. */
export type Outcome = "passed" | "failed" | "neither";

/** What GitHub says about one job, at one moment. */
export interface JobNews {
  readonly kind: "job";
  readonly id: number;
  readonly runId: number;
  readonly attempt: number;
  /** The organization or user whose repository it is. */
  readonly owner: string;
  /** The repository's name, without its owner's. */
  readonly repository: string;
  readonly workflow: string;
  readonly branch: string;
  readonly sha: string;
  readonly name: string;
  /** `queued`, `waiting`, `in_progress`, `completed`, and so on. */
  readonly status: string;
  readonly conclusion: string | null;
  /** The labels a runner must have to take the job. */
  readonly labels: readonly string[];
  readonly runner: string | null;
  readonly runnerGroup: string | null;
  readonly createdAt: string | null;
  readonly startedAt: string | null;
  readonly url: string;
}

/** What GitHub says about one run, at one moment. */
export interface RunNews {
  readonly kind: "run";
  readonly id: number;
  readonly attempt: number;
  readonly status: string;
  readonly conclusion: string | null;
  /** The number of the pull request the run is for, if GitHub says. */
  readonly pullRequest: number | null;
}

export type News = JobNews | RunNews;

/** A job that is queued or running. */
export interface ActiveJob {
  readonly id: number;
  readonly runId: number;
  readonly attempt: number;
  readonly owner: string;
  readonly repository: string;
  readonly workflow: string;
  readonly branch: string;
  readonly sha: string;
  readonly name: string;
  readonly running: boolean;
  /** When it was queued, or, once it runs, when it started, in milliseconds. */
  readonly since: number | null;
  readonly labels: readonly string[];
  readonly runner: string | null;
  readonly runnerGroup: string | null;
  readonly url: string;
}

/** Everything a `JobTracker` holds, as JSON can carry it. */
export interface TrackerSnapshot {
  readonly jobs: readonly ActiveJob[];
  /** Each run's latest attempt, and the attempt that finished, if one did. */
  readonly runs: readonly (readonly [number, number, number])[];
  readonly pullRequests: readonly (readonly [number, number])[];
  readonly outcomes: readonly (readonly [number, Outcome])[];
}

/**
 * Returns how a job or run that ended with `conclusion` ended: passing,
 * failing, or neither, as one cancelled or skipped does.
 */
export function outcomeOf(conclusion: string | null): Outcome {
  switch (conclusion) {
    case "success":
    case "neutral":
      return "passed";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failed";
    default:
      return "neither";
  }
}

/**
 * Holds the jobs queued and running, and how the latest jobs to end ended.
 *
 * Deliveries can arrive out of order, so news that a job is queued after news
 * that it runs, or any news of a job after news that it ended, is out of date
 * and changes nothing. A run attempted again drops the jobs of its earlier
 * attempt, and news of an earlier attempt changes nothing. A run that ends
 * ends every job of it still held: as passed if it passed, and otherwise as
 * neither, since nothing says how they would have ended.
 */
export class JobTracker {
  #jobs = new Map<number, ActiveJob>();
  #attempts = new Map<number, number>();
  #finished = new Map<number, number>();
  #pullRequests = new Map<number, number>();
  #outcomes = new Map<number, Outcome>();

  /** The jobs queued and running, by ID. */
  get jobs(): ReadonlyMap<number, ActiveJob> {
    return this.#jobs;
  }

  /** How the job `id` ended, if it has ended lately. */
  outcome(id: number): Outcome | undefined {
    return this.#outcomes.get(id);
  }

  /** The number of the pull request run `runId` is for, if known. */
  pullRequest(runId: number): number | undefined {
    return this.#pullRequests.get(runId);
  }

  /** Takes in `news`, and returns whether the jobs held changed. */
  take(news: News): boolean {
    const held = this.#jobs.size;
    if (!this.#current(news.kind === "job" ? news.runId : news.id, news.attempt)) {
      return false;
    }
    const changed = news.kind === "job" ? this.#takeJob(news) : this.#takeRun(news);
    return changed || this.#jobs.size !== held;
  }

  /**
   * Forgets every job held, apart from those `keep` picks out, and takes in
   * `news` afresh, keeping what it knew of how jobs and runs ended and which
   * attempt of each run is the latest.
   */
  replace(news: readonly News[], keep: (job: ActiveJob) => boolean = () => false): void {
    const kept = [...this.#jobs.values()].filter(keep);
    this.#jobs.clear();
    for (const job of kept) this.#jobs.set(job.id, job);
    for (const item of news) this.take(item);
  }

  /** Returns everything held, as JSON can carry it. */
  snapshot(): TrackerSnapshot {
    return {
      jobs: [...this.#jobs.values()],
      runs: [...this.#attempts].map(([run, attempt]) =>
        [run, attempt, this.#finished.get(run) ?? 0] as const
      ),
      pullRequests: [...this.#pullRequests],
      outcomes: [...this.#outcomes],
    };
  }

  /** Replaces everything held with what `snapshot` holds. */
  restore(snapshot: TrackerSnapshot): void {
    this.#jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));
    this.#attempts = new Map(snapshot.runs.map(([run, attempt]) => [run, attempt]));
    this.#finished = new Map(
      snapshot.runs.filter(([, , finished]) => finished > 0).map((
        [run, , finished],
      ) => [run, finished]),
    );
    this.#pullRequests = new Map(snapshot.pullRequests);
    this.#outcomes = new Map(snapshot.outcomes);
  }

  /**
   * Helper for `take()`, which returns whether news of `attempt` of run
   * `run` is current, dropping the jobs of an earlier attempt when it is a
   * later one.
   */
  #current(run: number, attempt: number): boolean {
    const latest = this.#attempts.get(run) ?? 0;
    if (attempt < latest) return false;
    if (attempt > latest) {
      for (const [id, job] of this.#jobs) {
        if (job.runId === run && job.attempt < attempt) this.#jobs.delete(id);
      }
      this.#attempts.set(run, attempt);
      // A run that still has jobs held keeps its attempt, so that news of
      // the attempt is not taken for a later one.
      const held = new Set([...this.#jobs.values()].map((job) => job.runId));
      JobTracker.#prune(this.#attempts, held);
    }
    return true;
  }

  /** Helper for `take()`, which takes in news of a job. */
  #takeJob(news: JobNews): boolean {
    const held = this.#jobs.get(news.id);
    if (news.status === "completed") {
      this.#ended(news.id, outcomeOf(news.conclusion));
      return held !== undefined;
    }
    const running = news.status === "in_progress";
    if (
      this.#outcomes.has(news.id) ||
      (this.#finished.get(news.runId) ?? 0) >= news.attempt ||
      (!running && held?.running)
    ) {
      return false;
    }
    const since = Date.parse((running ? news.startedAt ?? news.createdAt : news.createdAt) ?? "");
    this.#jobs.set(news.id, {
      id: news.id,
      runId: news.runId,
      attempt: news.attempt,
      owner: news.owner,
      repository: news.repository,
      workflow: news.workflow,
      branch: news.branch,
      sha: news.sha,
      name: news.name,
      running,
      since: Number.isNaN(since) ? null : since,
      labels: news.labels,
      runner: running && news.runner ? news.runner : null,
      runnerGroup: news.runnerGroup || null,
      url: news.url,
    });
    return true;
  }

  /** Helper for `take()`, which takes in news of a run. */
  #takeRun(news: RunNews): boolean {
    // Learning which pull request a run is for changes how its jobs are named.
    let renamed = false;
    if (news.pullRequest !== null && this.#pullRequests.get(news.id) !== news.pullRequest) {
      this.#pullRequests.set(news.id, news.pullRequest);
      JobTracker.#prune(this.#pullRequests);
      renamed = [...this.#jobs.values()].some((job) => job.runId === news.id);
    }
    if (news.status !== "completed") return renamed;
    this.#finished.set(news.id, news.attempt);
    JobTracker.#prune(this.#finished);
    const outcome = outcomeOf(news.conclusion) === "passed" ? "passed" : "neither";
    let changed = false;
    for (const [id, job] of this.#jobs) {
      if (job.runId !== news.id) continue;
      this.#ended(id, outcome);
      changed = true;
    }
    return changed;
  }

  /** Helper for the take methods, which notes that job `id` ended `outcome`. */
  #ended(id: number, outcome: Outcome): void {
    this.#jobs.delete(id);
    this.#outcomes.set(id, outcome);
    JobTracker.#prune(this.#outcomes);
  }

  /** How many ended jobs, runs, and pull requests are remembered at most. */
  static get remembered(): number {
    return 4000;
  }

  /**
   * Forgets the entries of `map` with the smallest keys, the oldest, apart
   * from those `kept` names, once it holds a fifth more than `remembered`.
   */
  static #prune(map: Map<number, unknown>, kept: ReadonlySet<number> = new Set()): void {
    const most = JobTracker.remembered;
    if (map.size <= most + most / 5) return;
    const keys = [...map.keys()].filter((key) => !kept.has(key)).sort((a, b) => a - b);
    for (const key of keys.slice(0, map.size - most)) map.delete(key);
  }
}

/**
 * Reads a job as a `workflow_job` delivery or GitHub's API describes it, in
 * repository `fullName`, or returns `undefined` when it does not have that
 * shape.
 */
export function jobNewsOf(job: unknown, fullName: string): JobNews | undefined {
  if (!isObjectNotArray(job)) return undefined;
  const [owner, repository] = fullName.split("/");
  const text = (value: unknown): string | null => typeof value === "string" ? value : null;
  const {
    id,
    run_id: runId,
    run_attempt: attempt,
    name,
    status,
    labels,
    html_url: url,
  } = job;
  if (
    typeof id !== "number" || typeof runId !== "number" ||
    typeof attempt !== "number" || typeof name !== "string" ||
    typeof status !== "string" || !Array.isArray(labels) ||
    repository === undefined
  ) {
    return undefined;
  }
  return {
    kind: "job",
    id,
    runId,
    attempt,
    owner,
    repository,
    workflow: text(job.workflow_name) ?? "",
    branch: text(job.head_branch) ?? "",
    sha: text(job.head_sha) ?? "",
    name,
    status,
    conclusion: text(job.conclusion),
    labels: labels.filter((label) => typeof label === "string"),
    runner: text(job.runner_name),
    runnerGroup: text(job.runner_group_name),
    createdAt: text(job.created_at),
    startedAt: text(job.started_at),
    url: text(url) ?? `https://github.com/${fullName}/actions/runs/${runId}`,
  };
}

/**
 * Reads a run as a `workflow_run` delivery or GitHub's API describes it, or
 * returns `undefined` when it does not have that shape.
 */
export function runNewsOf(run: unknown): RunNews | undefined {
  if (!isObjectNotArray(run)) return undefined;
  const { id, run_attempt: attempt, status, conclusion, pull_requests: pulls } = run;
  if (typeof id !== "number" || typeof status !== "string") return undefined;
  const pull = Array.isArray(pulls) ? pulls.find(isObjectNotArray) : undefined;
  return {
    kind: "run",
    id,
    attempt: typeof attempt === "number" ? attempt : 1,
    status,
    conclusion: typeof conclusion === "string" ? conclusion : null,
    pullRequest: typeof pull?.number === "number" ? pull.number : null,
  };
}

/**
 * Reads what a delivery of the webhook relay says about a job or a run, or
 * returns `undefined` for a delivery of any other event, or one that does not
 * have the shape of its event.
 */
export function newsOf(event: string, payload: unknown): News | undefined {
  if (!isObjectNotArray(payload) || !isObjectNotArray(payload.repository)) {
    return undefined;
  }
  const fullName = payload.repository.full_name;
  if (typeof fullName !== "string") return undefined;
  if (event === "workflow_job") return jobNewsOf(payload.workflow_job, fullName);
  if (event === "workflow_run") return runNewsOf(payload.workflow_run);
  return undefined;
}
