import type { CommitSummary } from "@commonfabric/memory/v2";

/**
 * One step of a space's history: a commit someone or something outside the
 * space's own computation made, such as an event, an edit or a restore,
 * together with the commits the space's serving loop made computing what
 * followed from it.
 */
export type HistoryStep = {
  /**
   * The seq of the step's last commit: the point of history that holds the
   * state the step left, which is where a fork of it starts.
   */
  seq: number;

  /** The seq of the commit that began the step. */
  startSeq: number;

  /** When the step began, as an ISO 8601 UTC time. */
  at: string;

  /**
   * What began the step: `event` for a commit that sent events, `restore`
   * for one that restored the branch to another point of history, and
   * `write` for any other.
   */
  kind: "event" | "restore" | "write";

  /** How many events the commit that began the step sent. */
  events: number;

  /** The seq the step restored the branch to, for a `restore` step. */
  restoredSeq?: number;

  /** How many documents the step's commits wrote, counted per commit. */
  writes: number;

  /**
   * Whether the state the step left holds everything its first commit called
   * for: `false` while the serving loop had yet to compute it when the next
   * step began, so that a fork of the step starts before that computation.
   */
  settled: boolean;
};

/** What {@link historySteps} is told of the space beyond its commits. */
export type HistoryStepsOptions = {
  /**
   * Whether a serving loop computes what follows from the space's commits.
   * A stretch of history can hold none of the loop's commits while it has
   * yet to reach them, so their absence does not say the space is unserved.
   */
  served?: boolean;
};

/**
 * Groups the commits of a branch's history, newest first as a history
 * listing returns them, into the steps they make, newest first. Commits
 * older than the oldest step's first commit belong to a step the listing
 * cut off, and are left out.
 */
export function historySteps(
  commits: readonly CommitSummary[],
  options: HistoryStepsOptions = {},
): HistoryStep[] {
  // Where no serving loop commits, each client computes what follows from
  // its own commits and stores it with them. A commit of a loop's shows the
  // space was served, whatever the caller knows of it now.
  const served = options.served === true ||
    commits.some((commit) => commit.class === "derived");
  const steps: HistoryStep[] = [];
  let seq: number | undefined;
  let writes = 0;
  let derivedThrough = 0;
  for (const commit of commits) {
    seq ??= commit.seq;
    writes += commit.writes;
    if (commit.class === "derived") {
      derivedThrough = Math.max(derivedThrough, commit.derivedThrough ?? 0);
      continue;
    }
    steps.push({
      seq,
      startSeq: commit.seq,
      at: commit.createdAt,
      kind: commit.restored !== undefined
        ? "restore"
        : commit.events > 0
        ? "event"
        : "write",
      events: commit.events,
      ...(commit.restored !== undefined
        ? { restoredSeq: commit.restored.seq }
        : {}),
      writes,
      settled: !served || derivedThrough >= commit.seq,
    });
    seq = undefined;
    writes = 0;
    derivedThrough = 0;
  }
  return steps;
}
