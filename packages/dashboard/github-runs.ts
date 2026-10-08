/**
 * Reads GitHub's lists of workflow runs. Every list of runs the dashboard
 * reads, for any repository and any workflow, comes through here, and the
 * dashboard's GitHub client refuses a run list asked for anywhere else.
 *
 * GitHub serves a workflow's unfiltered run list current. A list narrowed by
 * branch, event, status, actor, creation time, commit, or check suite comes
 * from an index that can be days or months behind it: it leaves out runs that
 * exist, and shows the runs it does list as they stood when the index last
 * caught up. A reader that took such a list for the workflow's runs would show
 * a result weeks old as the newest one. So which runs exist, and in what order,
 * is read only from the unfiltered list. A filtered list is used only to name
 * runs that may have changed, and each run it names is then read by its id.
 *
 * The unfiltered list carries every run, whatever it ran for, so a reader that
 * wants one branch's runs may have to read a long way down it. A `RunLists`
 * therefore keeps, for each workflow, the head of its list: its runs from the
 * newest down, with none missing between them. Each reading brings the head up
 * to date by reading the list from the top until it reaches a run already
 * held, which once the head is held is usually one short page, and reads
 * further down only when a reader asks for runs the head does not reach. The
 * head is kept as deep as the deepest of its readers last read, and a reader
 * that stops reading stops holding it after a day.
 *
 * GitHub lists runs newest first, and a newer run has the larger id. Runs land
 * at the top of the list and can be deleted from anywhere in it between two
 * requests, so a page asked for by its number can start some way from where it
 * was expected to. Each page is a view of the list at one moment, so runs from
 * a page are added after the last run held only when that one page holds the
 * run too, or shows it deleted by holding runs on either side of it. A walk to
 * such a page moves down the list while pages hold only newer runs, and up it
 * while they hold only older ones.
 *
 * A run's state changes after it is listed: it finishes, or someone runs it
 * again. A run near the top of the list is read again with the list. Further
 * down, a held run the reader wants that had not finished is read again by its
 * id, and one that has been run again since it was held is found through
 * filtered lists that its reader names, and read again by its id. GitHub lets
 * a run be started again for thirty days after it was created, so those lists
 * are read back no further than that. A run that is gone when it is read again
 * is dropped.
 */

import {
  type GitHubRequestOptions,
  GitHubStatusError,
  RUN_LIST_ACCESS,
} from "./lib.ts";

/** A workflow run, as far as any part of the dashboard reads one. */
export interface GitHubRun {
  id: number;
  name?: string;
  path?: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  display_title: string;
  created_at: string;
  run_started_at: string;
  updated_at: string;
  html_url: string;
  head_commit: { message: string } | null;
}

/**
 * Makes one GitHub API request, with the caller's token and on its rate-limit
 * terms, passing `options` through to the dashboard's GitHub client.
 */
export type RunRequest = <T>(
  path: string,
  options: GitHubRequestOptions,
) => Promise<T>;

/** What a filtered run list is narrowed by. */
export interface RunFilter {
  branch?: string;
  event?: string;
  status?: string;
}

/** Which of a workflow's runs a reader reads, and how far down the list. */
export interface RunReading {
  /**
   * Names the reader. The head of a workflow's list is kept as deep as each
   * of its readers last read, so two readers that read to different depths
   * have different names.
   */
  reader: string;
  /**
   * Returns whether the reader keeps `run`. Only those runs are returned, read
   * again when they had not finished, and counted against `limit`.
   */
  wants(run: GitHubRun): boolean;
  /**
   * Returns whether `run`, the run at `depth` of the list counted from 0, is
   * the last run the reader needs. Every run is offered, newest first, each
   * once, until this returns true, `limit` runs the reader wants have been
   * offered, or the list ends; a run read again under `confirmStop` is offered
   * again.
   */
  until(run: GitHubRun, depth: number): boolean;
  /** The most runs the reader wants to read. */
  limit?: number;
  /** How many of the newest runs to read from the top of the list, 1 to 100. */
  newest?: number;
  /**
   * Whether the run `until` stops at is read again by its id when this
   * reading did not read it from the list, and the reading goes on past it
   * when, read again, it is no longer the last run needed.
   */
  confirmStop?: boolean;
  /**
   * Filtered lists that name the held runs that may have been run again: a
   * held run the reader wants, which a list shows updated after the copy held,
   * is read again by its id. The list filtered to the reader's branch or event
   * is the usual one.
   */
  recheck: readonly RunFilter[];
}

/** The runs a page of a list carries. */
const PAGE = 100;

/** How many runs a reading reads from the top of the list by default. */
const NEWEST = 20;

/**
 * How long a read of the top of a list, or of a filtered list, serves later
 * readings, so that readings made close together share one read.
 */
const REUSE_MS = 20_000;

/**
 * How long a reader that has stopped reading keeps a head as deep as it read,
 * and a head nobody reads is kept at all.
 */
const READER_TTL_MS = 86_400_000;

/** How long after it was created GitHub lets a run be started again. */
export const RERUN_MS = 30 * 86_400_000;

/** The head of one workflow's list, and the readers it is held for. */
class Head {
  /** The runs from the newest down, newest first, with none missing. */
  runs: GitHubRun[] = [];
  /** Whether `runs` reaches the end of the list. */
  complete = false;
  /**
   * How many places nearer the top of the list than its place in `runs` the
   * last run held was found, which runs deleted above it and still held make
   * more than zero.
   */
  drift = 0;
  /** When the top of the list was last read, and how many runs that read. */
  readAt = -Infinity;
  readSize = 0;
  /** The runs read from GitHub since the top of the list was last read. */
  fresh = new Set<number>();
  /** When each filtered list was last read, by its query. */
  rechecked = new Map<string, number>();
  /** The oldest run each reader last read, and when. */
  reach = new Map<string, { id: number; at: number }>();
  /** When a reading last asked for this head. */
  usedAt = Date.now();
  #queue: Promise<void> = Promise.resolve();

  /** Runs `task` once every task given before it has finished. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }
}

/** One workflow's run list, as GitHub serves it. */
class RunList {
  constructor(
    readonly request: RunRequest,
    readonly repo: string,
    readonly workflow: string | number,
  ) {}

  /** Reads one page of the unfiltered list, rejecting one out of order. */
  async page(page: number, size: number): Promise<GitHubRun[]> {
    const runs = await this.#list({
      per_page: String(size),
      page: String(page),
    });
    for (let i = 1; i < runs.length; i++) {
      if (!(runs[i].id < runs[i - 1].id)) {
        throw new Error(
          `GitHub listed run ${runs[i].id} after run ${runs[i - 1].id} ` +
            `in ${this.repo} ${this.workflow}, out of order`,
        );
      }
    }
    return runs;
  }

  /** Reads one page of the list narrowed by `filter`. */
  async filtered(filter: RunFilter, page: number): Promise<GitHubRun[]> {
    return await this.#list({
      ...filter,
      per_page: String(PAGE),
      page: String(page),
    });
  }

  /** Reads the run as GitHub serves it now, or `undefined` once deleted. */
  async run(id: number): Promise<GitHubRun | undefined> {
    const path = `repos/${this.repo}/actions/runs/${id}`;
    try {
      return narrow(
        await this.request<GitHubRun>(path, { ignoreStatuses: [404] }),
      );
    } catch (error) {
      if (error instanceof GitHubStatusError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  /** Helper for `page()` and `filtered()`, which reads one list request. */
  async #list(query: Record<string, string>): Promise<GitHubRun[]> {
    const answer = await this.request<{ workflow_runs?: GitHubRun[] }>(
      `repos/${this.repo}/actions/workflows/${this.workflow}/runs?${
        new URLSearchParams(query)
      }`,
      { runListAccess: RUN_LIST_ACCESS },
    );
    return (answer.workflow_runs ?? []).map(narrow);
  }
}

/**
 * The heads of the run lists of the workflows a set of readers reads. Readers
 * that read the same workflow through one `RunLists` share its head.
 */
export class RunLists {
  #heads = new Map<string, Head>();

  /**
   * Reads a workflow's runs that `reading` wants, newest first, from the
   * newest run down to the one `reading.until` stops at, the `reading.limit`th
   * run it wants, or the end of the list.
   */
  async runs(
    request: RunRequest,
    repo: string,
    workflow: string | number,
    reading: RunReading,
  ): Promise<GitHubRun[]> {
    const newest = reading.newest ?? NEWEST;
    if (!Number.isInteger(newest) || newest < 1 || newest > PAGE) {
      throw new RangeError(`newest must be 1 to ${PAGE}, not ${newest}`);
    }
    const limit = reading.limit ?? Infinity;
    if (!(limit === Infinity || Number.isInteger(limit) && limit >= 1)) {
      throw new RangeError(`limit must be a whole number from 1, not ${limit}`);
    }
    const now = Date.now();
    for (const [key, head] of this.#heads) {
      if (now - head.usedAt > READER_TTL_MS) this.#heads.delete(key);
    }
    const key = `${repo} ${workflow}`;
    const held = this.#heads.get(key) ?? new Head();
    this.#heads.set(key, held);
    held.usedAt = now;
    const list = new RunList(request, repo, workflow);
    return await held.exclusive(async () => {
      await readTop(list, held, newest);
      await recheck(list, held, reading);
      const count = await readDown(list, held, reading);
      if (count > 0) {
        held.reach.set(reading.reader, {
          id: held.runs[count - 1].id,
          at: Date.now(),
        });
      }
      trim(held);
      return held.runs.slice(0, count).filter((run) => reading.wants(run));
    });
  }
}

/**
 * Helper for `RunLists.runs()`, which drops `head`'s readers that have not
 * read for READER_TTL_MS, and its runs below the oldest run any remaining
 * reader read.
 */
function trim(head: Head): void {
  const now = Date.now();
  let deepest = Infinity;
  for (const [reader, { id, at }] of head.reach) {
    if (now - at > READER_TTL_MS) head.reach.delete(reader);
    else deepest = Math.min(deepest, id);
  }
  const below = head.runs.findIndex((run) => run.id < deepest);
  if (below !== -1) {
    head.runs.length = below;
    head.complete = false;
  }
}

/**
 * Helper for `RunLists.runs()`, which brings `head` up to date with the top
 * of the list: reads the top `size` runs, and follows them down the list until
 * they reach a run `head` holds or pass the newest one. The runs read replace
 * the held ones they reach past, so a held run the list no longer carries,
 * having been deleted, is dropped. When they pass the newest held run without
 * reaching any, every held run that was in their way is gone, and the head
 * starts again from them. A top read that leaves out the newest held run is
 * rejected as behind unless that run has been deleted.
 */
async function readTop(list: RunList, head: Head, size: number): Promise<void> {
  if (Date.now() - head.readAt < REUSE_MS && head.readSize >= size) return;
  const readAt = Date.now();
  const held = new Set(head.runs.map((run) => run.id));
  const newestHeld = head.runs[0]?.id ?? Infinity;
  const top = await list.page(1, size);
  let ended = top.length < size;
  const reaches = () => top.some((run) => held.has(run.id));
  const passes = () => (top.at(-1)?.id ?? Infinity) < newestHeld;
  while (!ended && !reaches() && !passes()) {
    ({ ended } = await follow(list, top, 0));
  }
  if (
    newestHeld !== Infinity && !top.some((run) => run.id === newestHeld) &&
    await list.run(newestHeld) !== undefined
  ) {
    // Only a deletion or a list served behind the runs held leaves out the
    // newest run held, and reading that run by its id tells the two apart.
    throw new Error(
      `GitHub listed ${list.repo} ${list.workflow} without its run ` +
        `${newestHeld}, which still exists: the list is behind`,
    );
  }
  // A top read that reaches the end of the list is the whole list.
  const joins = reaches() && !ended;
  const last = top.at(-1)?.id ?? Infinity;
  head.runs = joins
    ? [...top, ...head.runs.filter((run) => run.id < last)]
    : top;
  if (!joins) head.drift = 0;
  head.complete = ended || (joins && head.complete);
  head.readAt = readAt;
  head.readSize = size;
  head.fresh = new Set(top.map((run) => run.id));
}

/**
 * Helper for `RunLists.runs()`, which reads again by its id each held run
 * `reading` wants that a list in `reading.recheck` shows updated after the
 * copy held, unless it has been read since the top of the list was. Each list
 * is read down to the oldest run held, or to runs too old to start again, and
 * one read within REUSE_MS is not read again. A list that cannot be read is
 * logged and passed over.
 */
async function recheck(
  list: RunList,
  head: Head,
  reading: RunReading,
): Promise<void> {
  const held = new Map(head.runs.map((run) => [run.id, run]));
  const oldest = head.runs.at(-1)?.id ?? Infinity;
  const since = Date.now() - RERUN_MS;
  const changed = new Set<number>();
  await Promise.all(reading.recheck.map(async (filter) => {
    const key = JSON.stringify(filter);
    if (Date.now() - (head.rechecked.get(key) ?? -Infinity) < REUSE_MS) return;
    for (let page = 1;; page++) {
      let listed: GitHubRun[];
      try {
        listed = await list.filtered(filter, page);
      } catch (error) {
        // The list only names runs that may have changed, so the reading goes
        // on without it, and the next reading reads it again.
        console.error(
          `run list ${list.repo} ${list.workflow} ${key} failed:`,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      for (const run of listed) {
        const copy = held.get(run.id);
        if (
          copy !== undefined && reading.wants(copy) &&
          Date.parse(run.updated_at) > Date.parse(copy.updated_at)
        ) changed.add(run.id);
      }
      const last = listed.at(-1);
      if (
        last === undefined || listed.length < PAGE || last.id <= oldest ||
        Date.parse(last.created_at) < since
      ) break;
    }
    head.rechecked.set(key, Date.now());
  }));
  await Promise.all([...changed].map((id) => readAgain(list, head, id)));
}

/**
 * Helper for `RunLists.runs()`, which offers `head`'s runs to `reading` until
 * it stops, reading further down the list when the runs held run out first. A
 * run the reader wants, held unfinished, is read again by its id before it is
 * offered, unless this reading read it from the list. Returns how many runs
 * were offered.
 */
async function readDown(
  list: RunList,
  head: Head,
  reading: RunReading,
): Promise<number> {
  const limit = reading.limit ?? Infinity;
  let wanted = 0;
  for (let index = 0;; index++) {
    if (index >= head.runs.length) {
      if (head.complete) return head.runs.length;
      const { added, dropped, ended, drift } = await follow(
        list,
        head.runs,
        head.drift,
      );
      for (const run of added) head.fresh.add(run.id);
      head.complete = ended;
      head.drift = drift;
      if (dropped > 0) {
        // Runs offered already that turned out to be deleted are taken back.
        index -= dropped;
        wanted = head.runs.slice(0, index).filter(reading.wants).length;
      }
      if (index >= head.runs.length) return head.runs.length;
    }
    const { id, status } = head.runs[index];
    const wants = reading.wants(head.runs[index]);
    if (wants && status !== "completed" && !await readAgain(list, head, id)) {
      index--;
      continue;
    }
    const full = wants && ++wanted === limit;
    if (!reading.until(head.runs[index], index)) {
      if (full) return index + 1;
      continue;
    }
    if (!reading.confirmStop || head.fresh.has(id)) return index + 1;
    if (!await readAgain(list, head, id)) {
      if (wants) wanted--;
      index--;
      continue;
    }
    if (full || reading.until(head.runs[index], index)) return index + 1;
  }
}

/**
 * Helper for `readDown()` and `recheck()`, which replaces `head`'s run `id`
 * with the run as GitHub serves it now, unless it has been read since the top
 * of the list was, and drops it if it has been deleted. Returns whether `head`
 * still holds it.
 */
async function readAgain(
  list: RunList,
  head: Head,
  id: number,
): Promise<boolean> {
  if (head.fresh.has(id)) return true;
  const run = await list.run(id);
  head.fresh.add(id);
  const index = head.runs.findIndex((held) => held.id === id);
  if (run === undefined) {
    if (index !== -1) head.runs.splice(index, 1);
    return false;
  }
  if (index !== -1) head.runs[index] = run;
  return index !== -1;
}

/**
 * Helper for `readTop()` and `readDown()`, which adds to `runs`, the top of
 * the list with none missing and at least one run, the runs that follow the
 * last of them, from one page that holds that run as well. A page that holds
 * runs on both sides of it, but not the run, shows it deleted, and it is
 * dropped, as are all the held runs when the first page holds only older
 * runs. A page holding only newer runs sends the walk on down the list, a page
 * at a time, and one holding only older runs sends it back up. A walk that has
 * turned round has found the run at the edge of two pages read at different
 * moments, and goes on with pages that hold where the run is expected in their
 * middle. The run is expected `drift` places nearer the top than its place in
 * `runs`. Returns the runs added, how many were dropped from the end of
 * `runs`, whether the list ends there, and the drift found.
 */
async function follow(
  list: RunList,
  runs: GitHubRun[],
  drift: number,
): Promise<
  { added: GitHubRun[]; dropped: number; ended: boolean; drift: number }
> {
  let dropped = 0;
  const dropAfter = (kept: number) => {
    while (runs.length > 0 && runs[runs.length - 1].id < kept) {
      runs.pop();
      dropped++;
    }
  };
  let position = Math.max(0, runs.length - 1 - drift);
  let room: Room = "after";
  let direction = 0;
  for (;;) {
    const last = runs[runs.length - 1].id;
    const { page, size } = pageHolding(position, room);
    const start = (page - 1) * size;
    const batch = await list.page(page, size);
    const newer = batch.filter((run) => run.id > last).length;
    const holds = batch[newer]?.id === last;
    const older = batch.length - newer - (holds ? 1 : 0);
    if (holds && older === 0 && batch.length === size) {
      // The page ends with the last run, so the runs after it are on a page
      // that holds it nearer its start.
      position = start + newer;
      room = "after";
      continue;
    }
    if (holds || older > 0 && (newer > 0 || page === 1)) {
      // Without the last run, the page shows it deleted, and with it every
      // held run older than the oldest newer run the page holds.
      if (!holds) dropAfter(newer > 0 ? batch[newer - 1].id : Infinity);
      const first = newer + (holds ? 1 : 0);
      const added = batch.slice(first);
      const found = runs.length - (start + first);
      for (const run of added) runs.push(run);
      return { added, dropped, ended: batch.length < size, drift: found };
    }
    if (newer > 0 && batch.length < size) {
      // The list ends before the last run: it and the held runs after the
      // oldest run on this page are gone.
      dropAfter(batch[batch.length - 1].id);
      return { added: [], dropped, ended: true, drift };
    }
    if (batch.length === 0 && page === 1) {
      dropAfter(Infinity);
      return { added: [], dropped, ended: true, drift: 0 };
    }
    const step = newer > 0 ? 1 : -1;
    if (direction !== 0 && step !== direction) room = "around";
    else if (room !== "around") room = step > 0 ? "after" : "before";
    direction = step;
    position = step > 0 ? start + size : Math.max(0, start - 1);
  }
}

/** Where a page holds a position: near its start, near its end, or mid-way. */
type Room = "after" | "before" | "around";

/**
 * Helper for `follow()`, which returns the page, and the number of runs a page
 * holds, of a page that holds the run at `position` of the list, with the most
 * room `room` asks for.
 */
function pageHolding(
  position: number,
  room: Room,
): { page: number; size: number } {
  let best = { page: 1, size: PAGE, score: -1 };
  for (let size = PAGE; size > PAGE / 2; size--) {
    const page = Math.floor(position / size) + 1;
    const before = position - (page - 1) * size;
    const after = page * size - 1 - position;
    const score = room === "after"
      ? after
      : room === "before"
      ? before
      : Math.min(before, after);
    if (score > best.score) best = { page, size, score };
  }
  return best;
}

/**
 * Helper for `RunList`, which returns the fields of `run` the dashboard reads.
 * GitHub sends around 18 KB for each run, carrying its repository, head
 * repository, whole head commit, and both actors, and a head can hold
 * thousands of runs for a day.
 */
function narrow(run: GitHubRun): GitHubRun {
  return {
    id: run.id,
    name: run.name,
    path: run.path,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    run_attempt: run.run_attempt,
    display_title: run.display_title,
    created_at: run.created_at,
    run_started_at: run.run_started_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
    head_commit: run.head_commit && { message: run.head_commit.message },
  };
}
