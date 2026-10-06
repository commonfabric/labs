import { isObjectNotArray } from "@commonfabric/utils/types";
import { github } from "./lib.ts";
import type { GitHubCredential } from "./github-auth.ts";
import type { Run } from "./types.ts";

/** What is held for one run. */
interface HeldRun {
  /** The run's completed attempts, by attempt number. */
  readonly attempts: Map<number, Run>;

  /** Whether each cancelled attempt listed any job, by attempt number. */
  readonly startedJobs: Map<number, boolean>;

  /** What each attempt did with its jobs, by attempt number. */
  readonly jobCounts: Map<number, JobCounts>;
}

/** How many of an attempt's jobs ran, and how many were skipped. */
export interface JobCounts {
  readonly ran: number;
  readonly skipped: number;
}

/**
 * The completed attempts of one repository's workflow runs, whether each
 * cancelled one listed any job, and how many jobs each one ran and skipped. GitHub's run listing carries only each run's
 * latest attempt, so an earlier attempt takes a request of its own. GitHub
 * reports several events as `cancelled`, among them a newer push replacing a
 * run while it is still queued, a job running past its `timeout-minutes`, and
 * someone stopping a run while it runs. Of those, only the first says nothing
 * about the commit, and an empty job listing is what marks it: the other two
 * ran jobs, though a listing can also hold jobs no runner started. An attempt
 * does not carry its job counts, so they take a request of their own too. A
 * completed attempt and its job counts never change, so each is requested once
 * and held for as long as its run stays among the runs observed.
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
   * already held. Rejects when the request fails, or when GitHub returns
   * anything other than that attempt completed with a conclusion.
   */
  async get(run: Run, attempt: number): Promise<Run> {
    const attempts = this.#held(run).attempts;
    const held = attempts.get(attempt);
    if (held) return held;
    const completed = await github<Run>(
      `repos/${this.#repo}/actions/runs/${run.id}/attempts/${attempt}`,
      this.#credential,
    );
    if (
      completed.id !== run.id ||
      completed.run_attempt !== attempt ||
      completed.status !== "completed" ||
      !completed.conclusion
    ) {
      throw new Error(
        `GitHub run ${run.id} attempt ${attempt} did not include a completed conclusion`,
      );
    }
    attempts.set(attempt, completed);
    return completed;
  }

  /**
   * Returns whether `attempt`, a completed attempt, was cancelled with an empty
   * job listing, as a run is when a newer push replaces it while it is still
   * queued. A cancelled attempt takes a request for its job count unless that
   * count is already held; any other conclusion returns `false` without one.
   * Rejects when the request fails, or when GitHub returns no numeric
   * `total_count`.
   */
  async cancelledBeforeAnyJob(attempt: Run): Promise<boolean> {
    if (attempt.conclusion !== "cancelled") return false;
    const { id, run_attempt: number } = attempt;
    const startedJobs = this.#held(attempt).startedJobs;
    const held = startedJobs.get(number);
    if (held !== undefined) return !held;
    const listing = await github<unknown>(
      `repos/${this.#repo}/actions/runs/${id}/attempts/${number}/jobs?per_page=1`,
      this.#credential,
    );
    if (!isObjectNotArray(listing) || typeof listing.total_count !== "number") {
      throw new Error(
        `GitHub run ${id} attempt ${number} job listing did not include ` +
          "a numeric `total_count`",
      );
    }
    const started = listing.total_count > 0;
    startedJobs.set(number, started);
    return !started;
  }

  /**
   * Returns how many of `attempt`'s jobs ran and how many were skipped,
   * reading every page of the attempt's job listing unless the counts are
   * already held. Rejects when a request fails, or when GitHub returns a page
   * without a numeric `total_count` and a `jobs` array of objects.
   */
  async jobCounts(attempt: Run): Promise<JobCounts> {
    const { id, run_attempt: number } = attempt;
    const held = this.#held(attempt).jobCounts;
    const known = held.get(number);
    if (known) return known;
    let ran = 0, skipped = 0;
    for (let page = 1;; page++) {
      const listing = await github<unknown>(
        `repos/${this.#repo}/actions/runs/${id}/attempts/${number}/jobs` +
          `?per_page=100&page=${page}`,
        this.#credential,
      );
      if (
        !isObjectNotArray(listing) ||
        typeof listing.total_count !== "number" ||
        !Array.isArray(listing.jobs) ||
        !listing.jobs.every(isObjectNotArray)
      ) {
        throw new Error(
          `GitHub run ${id} attempt ${number} job listing page ${page} did ` +
            "not include a numeric `total_count` and a `jobs` array",
        );
      }
      for (const job of listing.jobs) {
        if (job.conclusion === "skipped") skipped++;
        else ran++;
      }
      if (!listing.jobs.length || ran + skipped >= listing.total_count) break;
    }
    const counts = { ran, skipped };
    held.set(number, counts);
    return counts;
  }

  /** Returns what is held for `run`, starting an empty record if nothing is. */
  #held(run: Run): HeldRun {
    let held = this.#runs.get(run.id);
    if (!held) {
      held = { attempts: new Map(), startedJobs: new Map(), jobCounts: new Map() };
      this.#runs.set(run.id, held);
    }
    return held;
  }
}
