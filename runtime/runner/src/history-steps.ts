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
   * The principal that made the commit that began the step, absent where
   * that commit's session had none.
   */
  principal?: string;

  /**
   * Whether every event sent up to the end of the step had its handler run
   * by then: `false` while the serving loop had yet to reach one, so that a
   * fork of the step starts before that handler ran. A step that sent no
   * event is settled when none before it was pending, since a fork computes
   * for itself what a write alone calls for.
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
  // Read oldest first, so that each step is judged by what the serving loop
  // had computed through, and which event was the last sent, when it ended.
  let open: Omit<HistoryStep, "settled"> | undefined;
  let through = 0;
  let lastEvent = 0;
  const close = () => {
    if (open !== undefined) {
      steps.push({ ...open, settled: !served || through >= lastEvent });
    }
  };
  for (let index = commits.length - 1; index >= 0; index--) {
    const commit = commits[index];
    if (commit.class === "derived") {
      through = Math.max(through, commit.derivedThrough ?? 0);
      // A serving loop's commit with no step open belongs to a step the
      // listing cut off.
      if (open !== undefined) {
        open.seq = commit.seq;
        open.writes += commit.writes;
      }
      continue;
    }
    close();
    if (commit.events > 0) lastEvent = commit.seq;
    open = {
      seq: commit.seq,
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
      writes: commit.writes,
      ...(commit.principal !== undefined
        ? { principal: commit.principal }
        : {}),
    };
  }
  close();
  return steps.reverse();
}
