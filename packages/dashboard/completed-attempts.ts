import { github } from "./lib.ts";
import type { Run } from "./types.ts";

/**
 * The completed attempts of one repository's workflow runs. GitHub's run
 * listing carries only each run's latest attempt, so an earlier attempt takes a
 * request of its own. A completed attempt never changes, so each is requested
 * once and held for as long as its run stays among the runs observed.
 */
export class CompletedAttempts {
  #repo: string;
  #attempts = new Map<number, Map<number, Run>>();

  /** Constructs an instance that reads the runs of `repo`, an "owner/name". */
  constructor(repo: string) {
    this.#repo = repo;
  }

  /**
   * Holds the latest attempt of each completed run in `runs`, and forgets the
   * attempts of every run not among them.
   */
  observe(runs: readonly Run[]): void {
    const visible = new Set(runs.map((run) => run.id));
    for (const id of this.#attempts.keys()) {
      if (!visible.has(id)) this.#attempts.delete(id);
    }
    for (const run of runs) {
      if (run.status === "completed" && run.conclusion) {
        this.#attemptsOf(run).set(run.run_attempt, run);
      }
    }
  }

  /**
   * Returns attempt `attempt` of `run`, requesting it from GitHub unless it is
   * already held. Rejects when the request fails, or when GitHub returns
   * anything other than that attempt completed with a conclusion.
   */
  async get(run: Run, attempt: number): Promise<Run> {
    const attempts = this.#attemptsOf(run);
    const held = attempts.get(attempt);
    if (held) return held;
    const completed = await github<Run>(
      `repos/${this.#repo}/actions/runs/${run.id}/attempts/${attempt}`,
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

  /** Returns the attempts held for `run`, starting an empty set if none are. */
  #attemptsOf(run: Run): Map<number, Run> {
    let attempts = this.#attempts.get(run.id);
    if (!attempts) {
      attempts = new Map();
      this.#attempts.set(run.id, attempts);
    }
    return attempts;
  }
}
