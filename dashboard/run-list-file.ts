/**
 * Keeps the heads of the run lists a `RunLists` holds in a file, so that a
 * dashboard that restarts reads each list only down to the runs it held
 * before, rather than from the top to wherever its readers need. Processes
 * that share the file lock it while each puts its heads in place of the ones
 * the file holds, and replace it whole. A head taken from the file reads its
 * list from the top until it reaches a run it holds, so any head that was whole
 * when it was saved can be taken, however old.
 *
 * Every version of the dashboard reads the file the same way, whichever
 * version wrote it. A run that lacks a field this version reads, or holds one
 * it cannot use, is not taken as read: the head is cut back to the runs above
 * it, so the runs from there down are read from GitHub again. A head whose own
 * fields cannot be used, or that records a time later than the present, is
 * dropped. Fields this version does not know are ignored, and are not written
 * back. A file that cannot be read at all is replaced.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type { GitHubRun } from "./github-runs.ts";

/** The head of one workflow's run list, as the file holds it. */
export interface SavedHead {
  /** The repository whose workflow this is. */
  repo: string;
  /** The workflow, by its file name or its id. */
  workflow: string | number;
  /** The runs from the newest down, newest first, with none missing. */
  runs: GitHubRun[];
  /** Whether `runs` reaches the end of the list. */
  complete: boolean;
  /**
   * How many places nearer the top of the list than its place in `runs` the
   * last run was found, which is less than zero when it was found further
   * down.
   */
  drift: number;
  /** When the top of the list was last read. */
  readAt: number;
  /** When a reading last asked for this head. */
  usedAt: number;
  /** The oldest run each reader last read, and when. */
  readers: SavedReader[];
}

/** The oldest run one reader of a head last read, and when. */
export interface SavedReader {
  /** The reader's name. */
  reader: string;
  /** The id of the oldest run it read. */
  id: number;
  /** When it read. */
  at: number;
}

/** Returns the name a head of `repo`'s `workflow` is held under. */
const headKey = (repo: string, workflow: string | number): string =>
  `${repo} ${workflow}`;

/** A file holding the heads of run lists. */
export class RunListFile {
  #path: string;

  /** Constructs an instance which keeps heads in the file at `path`. */
  constructor(path: string) {
    this.#path = path;
  }

  /** The path of the file. */
  get path(): string {
    return this.#path;
  }

  /**
   * Reads the head of `repo`'s `workflow` the file holds, or `undefined` when
   * it holds none or cannot be read.
   */
  async load(
    repo: string,
    workflow: string | number,
  ): Promise<SavedHead | undefined> {
    return (await this.#read()).get(headKey(repo, workflow));
  }

  /**
   * Puts the heads `heads` returns in place of the heads of the same lists the
   * file holds, except where the file's head was read from the top of its list
   * more recently, or at the same moment and holds more runs, and replaces the
   * file with the result, less the heads last used before `since`. `heads` is called once the file is locked, and what it
   * returns is serialized before anything else runs.
   */
  async save(heads: () => SavedHead[], since: number): Promise<void> {
    const lock = await Deno.open(`${this.#path}.lock`, {
      create: true,
      write: true,
    });
    try {
      await lock.lock(true);
      const kept = await this.#read();
      for (const head of heads()) {
        if (head.runs.length === 0) continue;
        const key = headKey(head.repo, head.workflow);
        const held = kept.get(key);
        if (
          held === undefined || head.readAt > held.readAt ||
          head.readAt === held.readAt && head.runs.length >= held.runs.length
        ) {
          kept.set(key, head);
        }
      }
      const saved = [...kept.values()].filter((head) => head.usedAt >= since);
      const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
      try {
        // A run's name and path are absent when GitHub sends none, and are
        // written as null so that every field a run has is in the file.
        await Deno.writeTextFile(
          temporary,
          JSON.stringify(
            { heads: saved },
            (_, value) => value === undefined ? null : value,
          ),
        );
        await Deno.rename(temporary, this.#path);
      } catch (error) {
        await Deno.remove(temporary).catch(() => {});
        throw error;
      }
    } finally {
      lock.close();
    }
  }

  /**
   * Helper for `load()` and `save()`, which reads the heads the file holds, by
   * their keys. A file that cannot be read holds none, and the reason it
   * cannot be read is logged unless it does not exist.
   */
  async #read(): Promise<Map<string, SavedHead>> {
    const heads = new Map<string, SavedHead>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(this.#path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(
          `run lists in ${this.#path} could not be read:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      return heads;
    }
    if (!isObjectNotArray(parsed) || !Array.isArray(parsed.heads)) {
      return heads;
    }
    const now = Date.now();
    for (const value of parsed.heads) {
      const head = savedHead(value, now);
      if (head !== undefined) {
        heads.set(headKey(head.repo, head.workflow), head);
      }
    }
    return heads;
  }
}

/** Whether `value` is a whole number of at least `least`. */
const isWhole = (value: unknown, least: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= least;

/** Whether `value` is a time no later than `now`. */
const isPast = (value: unknown, now: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value <= now;

/** Whether `value` is a string or null. */
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * Helper for `RunListFile.#read()`, which returns the head `value` holds, cut
 * back above its first run that cannot be used or is out of order, or
 * `undefined` when `value` is not a head, records a time later than `now`, or
 * holds no run that can be used.
 */
function savedHead(value: unknown, now: number): SavedHead | undefined {
  if (!isObjectNotArray(value)) return undefined;
  const { repo, workflow, runs, complete, drift, readAt, usedAt, readers } =
    value;
  if (
    typeof repo !== "string" ||
    !(typeof workflow === "string" || isWhole(workflow, 1)) ||
    !Array.isArray(runs) || typeof complete !== "boolean" ||
    !isWhole(drift, -Infinity) || !isPast(readAt, now) ||
    !isPast(usedAt, now) ||
    !Array.isArray(readers)
  ) return undefined;
  const held: SavedReader[] = [];
  for (const entry of readers) {
    if (!isObjectNotArray(entry)) return undefined;
    const { reader, id, at } = entry;
    if (typeof reader !== "string" || !isWhole(id, 1) || !isPast(at, now)) {
      return undefined;
    }
    held.push({ reader, id, at });
  }
  const kept: GitHubRun[] = [];
  for (const entry of runs) {
    const run = savedRun(entry);
    if (run === undefined || run.id >= (kept.at(-1)?.id ?? Infinity)) break;
    kept.push(run);
  }
  if (kept.length === 0) return undefined;
  const whole = kept.length === runs.length;
  return {
    repo,
    workflow,
    runs: kept,
    complete: whole && complete,
    drift: whole ? drift : 0,
    readAt,
    usedAt,
    readers: held,
  };
}

/**
 * Helper for `savedHead()`, which returns the run `value` holds, or
 * `undefined` when it lacks a field a run has or holds one that cannot be
 * used.
 */
function savedRun(value: unknown): GitHubRun | undefined {
  if (!isObjectNotArray(value)) return undefined;
  const {
    id,
    name,
    path,
    event,
    head_branch,
    head_sha,
    status,
    conclusion,
    run_attempt,
    display_title,
    created_at,
    run_started_at,
    updated_at,
    html_url,
    head_commit,
  } = value;
  const commit = head_commit === null
    ? null
    : isObjectNotArray(head_commit) && typeof head_commit.message === "string"
    ? { message: head_commit.message }
    : undefined;
  if (
    !isWhole(id, 1) || !isNullableString(name) || !isNullableString(path) ||
    typeof event !== "string" || !isNullableString(head_branch) ||
    typeof head_sha !== "string" || typeof status !== "string" ||
    !isNullableString(conclusion) || !isWhole(run_attempt, 1) ||
    typeof display_title !== "string" || typeof created_at !== "string" ||
    typeof run_started_at !== "string" || typeof updated_at !== "string" ||
    typeof html_url !== "string" || commit === undefined
  ) return undefined;
  return {
    id,
    name: name ?? undefined,
    path: path ?? undefined,
    event,
    head_branch,
    head_sha,
    status,
    conclusion,
    run_attempt,
    display_title,
    created_at,
    run_started_at,
    updated_at,
    html_url,
    head_commit: commit,
  } satisfies Record<keyof GitHubRun, unknown>;
}
