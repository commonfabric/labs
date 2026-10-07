/**
 * Follows each repository's green branch, the branch its CI moves to the
 * newest commit of main whose tests passed, and says of a commit whether the
 * branch is at it now or was at it before. GitHub's activity record for a
 * repository lists every update of a branch, the updates CI makes through the
 * API among them, and each update names the commit it moved the branch to. A
 * commit the branch moved past without stopping at gets no mark.
 */

import { GREEN_BRANCHES } from "./config.ts";
import { type GitHubPage, githubPage } from "./lib.ts";
import type { GreenMark } from "./types.ts";

/** One update of a branch, as GitHub's activity record lists it. */
interface Activity {
  /** The update's identity in the record. */
  readonly id: number;

  /** The commit the update moved the branch to; all zeros for a deletion. */
  readonly after: string;

  /** When the update was made, as an ISO 8601 date. */
  readonly timestamp: string;
}

const DELETED = /^0+$/;

/**
 * The commits one repository's green branch is at and was at, as far back as
 * the `since` of the latest read.
 */
export class GreenBranch {
  #repo: string;
  #branch: string;
  #positions = new Map<string, number>(); // commit to when the branch last moved to it
  #read = new Map<number, number>(); // update to when it was made
  #current: string | undefined;
  #reading: Promise<void> | undefined;

  /** Constructs an instance which follows `branch` of `repo`. */
  constructor(repo: string, branch: string) {
    this.#repo = repo;
    this.#branch = branch;
  }

  /**
   * Reads the updates of the branch made since the last read, and on the
   * first read every update made since `since`, a time in milliseconds, then
   * forgets the updates and commits older than `since`. A refresh asked for
   * while one is reading shares that one. A read that fails is logged and
   * changes nothing, so the next read covers the updates this one missed.
   */
  refresh(since: number): Promise<void> {
    this.#reading ??= this.#readUpdates(since).finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  /** What the branch says of the commit `sha`, if it is or was at it. */
  mark(sha: string): GreenMark | undefined {
    return this.#positions.has(sha) || sha === this.#current
      ? { branch: this.#branch, current: sha === this.#current }
      : undefined;
  }

  /** Helper for `refresh()`, which reads the updates, newest first. */
  async #readUpdates(since: number): Promise<void> {
    const found: Activity[] = [];
    let newest: Activity | undefined;
    // A first read reaches back to `since`; a later one usually finds few
    // updates it has not read.
    let path: string | undefined = `repos/${this.#repo}/activity?${new URLSearchParams(
      {
        ref: `refs/heads/${this.#branch}`,
        per_page: this.#read.size === 0 ? "100" : "10",
      },
    )}`;
    try {
      while (path !== undefined) {
        const page: GitHubPage<Activity[]> = await githubPage(path);
        newest ??= page.value[0];
        const known = page.value.findIndex((update) =>
          this.#read.has(update.id) || Date.parse(update.timestamp) < since
        );
        for (const update of page.value.slice(0, known === -1 ? undefined : known)) {
          found.push(update);
        }
        path = known === -1 ? page.next : undefined;
      }
    } catch (error) {
      console.error(
        `updates of ${this.#repo} ${this.#branch} failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    // Oldest first, so each commit keeps the time the branch last moved to it.
    for (const update of found.reverse()) {
      const at = Date.parse(update.timestamp);
      this.#read.set(update.id, at);
      if (!DELETED.test(update.after)) this.#positions.set(update.after, at);
    }
    const forget = <K>(times: Map<K, number>) => {
      for (const [key, at] of times) if (at < since) times.delete(key);
    };
    forget(this.#read);
    forget(this.#positions);
    this.#current = newest === undefined || DELETED.test(newest.after)
      ? undefined
      : newest.after;
  }
}

const branches = new Map(
  Object.entries(GREEN_BRANCHES).map((
    [repo, branch],
  ) => [repo, new GreenBranch(repo, branch)]),
);

/** The green branch of `repo`, as "owner/name", when it has one. */
export const greenBranchOf = (repo: string): GreenBranch | undefined =>
  branches.get(repo);
