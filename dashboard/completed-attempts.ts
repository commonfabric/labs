import { isObjectNotArray } from "@commonfabric/utils/types";
import { github } from "./lib.ts";
import type { GitHubCredential } from "./github-auth.ts";
import type { Run } from "./types.ts";

/** What is held for one run. */
interface HeldRun {
  /** The run's completed attempts, by attempt number. */
  readonly attempts: Map<number, Run>;

  /**
   * Whether each cancelled attempt has a job a runner ran that did not
   * succeed, by attempt number.
   */
  readonly failedOnRunner: Map<number, boolean>;

  /** The job listing of each attempt read to its end, by attempt number. */
  readonly listings: Map<number, readonly ListedJob[]>;
}

/** What a job listing says about one job. */
interface ListedJob {
  /** Also the id of the job's check run, which carries its annotations. */
  readonly id: number;
  readonly conclusion: string | null;
  /** Empty, or `null`, for a job no runner picked up. */
  readonly runner_name: string | null;
}

/**
 * How the annotation GitHub puts on a job that a concurrency group cancelled,
 * in favor of a newer run or job, starts.
 */
const REPLACED_ANNOTATION = "Canceling since a higher priority waiting request for ";

/** How many annotations GitHub returns on each page of a check run's list. */
const ANNOTATIONS_PER_PAGE = 100;

/** Whether `value` is a string or `null`. */
function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Whether `value` is an annotation with a string or `null` `message`. */
function isAnnotation(
  value: unknown,
): value is { readonly message: string | null } {
  return isObjectNotArray(value) && isStringOrNull(value.message);
}

/** How many of an attempt's jobs ran, and how many were skipped. */
export interface JobCounts {
  readonly ran: number;
  readonly skipped: number;
}

/**
 * The completed attempts of one repository's workflow runs, whether each
 * cancelled one has a job a runner ran that did not succeed for a reason of
 * its own, and how many jobs each one ran and skipped. GitHub's run listing
 * carries only each run's latest attempt, so an earlier attempt takes a
 * request of its own. GitHub reports several events as `cancelled`, among them
 * a concurrency group replacing a run or a job with a newer one, whether it is
 * queued or running, a job running past its `timeout-minutes`, and someone
 * stopping a run while it runs. Only the last two say anything about the
 * commit. A run replaced while queued lists no jobs, and a job replaced while
 * queued is listed with an empty runner name. A job a runner was running when
 * it was cancelled carries an annotation saying why, and a concurrency group's
 * annotation starts with REPLACED_ANNOTATION. A cancelled attempt therefore
 * judges the commit exactly when a job a runner ran ended in anything but
 * success, other than by a concurrency group cancelling it. An attempt does not
 * carry its jobs, nor a job its annotations, so each takes a request of its
 * own. A completed attempt and its jobs never change, so each answer is
 * requested once and held for as long as its run stays among the runs
 * observed. GitHub sometimes leaves an attempt that a rerun followed without a
 * conclusion, in progress long after its last job ended, and such an attempt is
 * held with the conclusion its jobs give it.
 */
export class CompletedAttempts {
  #repo: string;
  #credential: GitHubCredential | undefined;
  #runs = new Map<number, HeldRun>();

  /**
   * Constructs an instance that reads the runs of `repo`, an "owner/name",
   * with `credential`, or with the dashboard's own GitHub credential when none
   * is given.
   */
  constructor(repo: string, credential?: GitHubCredential) {
    this.#repo = repo;
    this.#credential = credential;
  }

  /**
   * Holds the latest attempt of each completed run in `runs`, and forgets
   * everything held for every run not among them.
   */
  observe(runs: readonly Run[]): void {
    const visible = new Set(runs.map((run) => run.id));
    for (const id of this.#runs.keys()) {
      if (!visible.has(id)) this.#runs.delete(id);
    }
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion) {
        this.#held(run).attempts.set(run.run_attempt, run);
      }
    }
  }

  /**
   * Returns attempt `attempt` of `run`, requesting it from GitHub unless it is
   * already held. An attempt earlier than `run`'s latest has ended, since
   * GitHub reruns only a run that has completed, so when GitHub returns it
   * without a conclusion it is returned as completed with the conclusion
   * `#concludedByJobs` reads from its jobs. Rejects when a request fails, when
   * GitHub returns another run's attempt or another attempt, when it returns
   * the latest attempt other than completed with a conclusion, or as
   * `#concludedByJobs` does.
   */
  async get(run: Run, attempt: number): Promise<Run> {
    const attempts = this.#held(run).attempts;
    const held = attempts.get(attempt);
    if (held) return held;
    const answer = await github<Run>(
      `repos/${this.#repo}/actions/runs/${run.id}/attempts/${attempt}`,
      this.#credential,
    );
    if (answer.id !== run.id || answer.run_attempt !== attempt) {
      throw new Error(
        `GitHub answered for run ${answer.id} attempt ${answer.run_attempt} ` +
          `when asked for run ${run.id} attempt ${attempt}`,
      );
    }
    const conclusion = attempt < run.run_attempt
      ? answer.conclusion ?? await this.#concludedByJobs(answer)
      : answer.status === "completed"
      ? answer.conclusion
      : null;
    if (!conclusion) {
      throw new Error(
        `GitHub run ${run.id} attempt ${attempt} did not include a completed conclusion`,
      );
    }
    const completed = { ...answer, status: "completed", conclusion };
    attempts.set(attempt, completed);
    return completed;
  }

  /**
   * Returns the conclusion `attempt`'s jobs give it, reading every page of its
   * job listing: "failure" when a job ended in
   * anything but success, a skip, or cancellation; otherwise "cancelled" when
   * a job was cancelled or none is listed, as GitHub concludes a run replaced
   * while queued; and otherwise "success". Rejects as `#jobs` does, and when a
   * job has not ended.
   */
  async #concludedByJobs(attempt: Run): Promise<string> {
    let conclusion = "success";
    let listed = false;
    for await (const job of this.#jobs(attempt)) {
      listed = true;
      if (job.conclusion === null) {
        throw new Error(
          `GitHub run ${attempt.id} attempt ${attempt.run_attempt} lists ` +
            `job ${job.id}, which has not ended`,
        );
      }
      if (job.conclusion === "cancelled") {
        if (conclusion === "success") conclusion = "cancelled";
      } else if (job.conclusion !== "success" && job.conclusion !== "skipped") {
        conclusion = "failure";
      }
    }
    return listed ? conclusion : "cancelled";
  }

  /**
   * Returns whether `attempt`, a completed attempt, was cancelled without any
   * job a runner ran ending in anything but success, other than by a
   * concurrency group cancelling it, so that it says nothing about the commit,
   * as when a newer run replaces it, or its jobs. A cancelled attempt takes
   * requests for its job listing, up to the page holding the first job a
   * runner ran that did not succeed for a reason of its own, and for the
   * annotations of each job a runner ran that was cancelled, up to and
   * including that one, unless the answer is already held; any other
   * conclusion returns `false` without one. Rejects as `#jobs` and `#replaced`
   * do.
   */
  async cancelledWithoutVerdict(attempt: Run): Promise<boolean> {
    if (attempt.conclusion !== "cancelled") return false;
    const failedOnRunner = this.#held(attempt).failedOnRunner;
    const held = failedOnRunner.get(attempt.run_attempt);
    if (held !== undefined) return !held;
    let failed = false;
    for await (const job of this.#jobs(attempt)) {
      if (!job.runner_name || job.conclusion === "success") continue;
      if (job.conclusion === "cancelled" && await this.#replaced(job)) continue;
      failed = true;
      break;
    }
    failedOnRunner.set(attempt.run_attempt, failed);
    return !failed;
  }

  /**
   * Returns how many of `attempt`'s jobs ran and how many were skipped,
   * reading every page of the attempt's job listing. Rejects as `#jobs` does.
   */
  async jobCounts(attempt: Run): Promise<JobCounts> {
    let ran = 0, skipped = 0;
    for await (const job of this.#jobs(attempt)) {
      if (job.conclusion === "skipped") skipped++;
      else ran++;
    }
    return { ran, skipped };
  }

  /**
   * Yields each job in `attempt`'s job listing, from the listing held when an
   * earlier read reached its end, and otherwise requesting each page only once
   * the jobs before it have been consumed and holding the listing once its
   * last job has been. Rejects when a request fails, when GitHub returns a
   * page without a numeric `total_count` and a `jobs` array of objects each
   * with a numeric `id` and a string or `null` `conclusion` and
   * `runner_name`, or when the pages end before `total_count` jobs.
   */
  async *#jobs(attempt: Run): AsyncGenerator<ListedJob> {
    const { id, run_attempt: number } = attempt;
    const listings = this.#held(attempt).listings;
    const held = listings.get(number);
    if (held) {
      yield* held;
      return;
    }
    const jobs: ListedJob[] = [];
    for (let page = 1;; page++) {
      const listing = await github<unknown>(
        `repos/${this.#repo}/actions/runs/${id}/attempts/${number}/jobs` +
          `?per_page=100&page=${page}`,
        this.#credential,
      );
      if (
        !isObjectNotArray(listing) ||
        typeof listing.total_count !== "number" ||
        !Array.isArray(listing.jobs)
      ) {
        throw new Error(
          `GitHub run ${id} attempt ${number} job listing page ${page} did ` +
            "not include a numeric `total_count` and a `jobs` array",
        );
      }
      for (const job of listing.jobs) {
        if (
          !isObjectNotArray(job) || typeof job.id !== "number" ||
          !isStringOrNull(job.conclusion) || !isStringOrNull(job.runner_name)
        ) {
          throw new Error(
            `GitHub run ${id} attempt ${number} job listing page ${page} ` +
              "holds a job without a numeric `id` and a string or null " +
              "`conclusion` and `runner_name`",
          );
        }
        const listed = {
          id: job.id,
          conclusion: job.conclusion,
          runner_name: job.runner_name,
        };
        jobs.push(listed);
        yield listed;
      }
      if (jobs.length >= listing.total_count) {
        listings.set(number, jobs);
        return;
      }
      if (!listing.jobs.length) {
        throw new Error(
          `GitHub run ${id} attempt ${number} job listing ended after ` +
            `${jobs.length} of its ${listing.total_count} jobs`,
        );
      }
    }
  }

  /**
   * Returns whether a concurrency group cancelled `job`, going by whether one
   * of its check run's annotations starts with REPLACED_ANNOTATION, requesting
   * each page of the annotations only until one does. Rejects when a request
   * fails, or when GitHub returns a page that is not an array of objects each
   * with a string or `null` `message`.
   */
  async #replaced(job: ListedJob): Promise<boolean> {
    for (let page = 1;; page++) {
      const annotations = await github<unknown>(
        `repos/${this.#repo}/check-runs/${job.id}/annotations` +
          `?per_page=${ANNOTATIONS_PER_PAGE}&page=${page}`,
        this.#credential,
      );
      if (!Array.isArray(annotations) || !annotations.every(isAnnotation)) {
        throw new Error(
          `GitHub check run ${job.id} annotations page ${page} is not an ` +
            "array of objects each with a string or null `message`",
        );
      }
      if (
        annotations.some((annotation) =>
          annotation.message?.startsWith(REPLACED_ANNOTATION)
        )
      ) {
        return true;
      }
      if (annotations.length < ANNOTATIONS_PER_PAGE) return false;
    }
  }

  /** Returns what is held for `run`, starting an empty record if nothing is. */
  #held(run: Run): HeldRun {
    let held = this.#runs.get(run.id);
    if (!held) {
      held = {
        attempts: new Map(),
        failedOnRunner: new Map(),
        listings: new Map(),
      };
      this.#runs.set(run.id, held);
    }
    return held;
  }
}
