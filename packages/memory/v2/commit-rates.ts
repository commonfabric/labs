/**
 * Per-space, per-writer commit rates over the last minute and the last ten
 * minutes, for the health route and the write-storm alarm. One tracker per
 * memory server records every decided commit, accepted or rejected, and
 * reports which spaces are being written to, by which sessions, how often,
 * and whether a space has run past the storm threshold for the sustained
 * window. Memory is bounded by construction: a writer holds at most one
 * bucket per second of the long window, and the writers of a space and the
 * spaces themselves are capped, with the one that committed longest ago
 * evicted past the cap.
 */

/** The long window, over which every count is retained. */
const TEN_MINUTES_MS = 600_000;

/** The short window, whose count the storm threshold is judged against. */
const MINUTE_MS = 60_000;

/** Width of one counting bucket. A window's count is exact to this. */
const BUCKET_MS = 1_000;

/** Spaces the tracker retains at once, before evicting the quietest. */
const DEFAULT_MAX_SPACES = 1024;

/** Writers one space retains at once, before evicting the quietest. */
const DEFAULT_MAX_WRITERS_PER_SPACE = 256;

/** Spaces a report ranks, per window. */
const DEFAULT_TOP_SPACES = 16;

/** Writers a report ranks for one space, per window. */
const DEFAULT_TOP_WRITERS = 8;

/** Default of `CF_COMMIT_STORM_PER_MINUTE`: a space sustaining two commits a
 * second is a storm, well above a board's steady rate and below the ten a
 * second the Topics space saw. */
const DEFAULT_STORM_COMMITS_PER_MINUTE = 120;

/** Default of `CF_COMMIT_STORM_SUSTAINED_SECONDS`: a page load's burst of
 * commits settles well inside five minutes, and a loop does not. */
const DEFAULT_STORM_SUSTAINED_SECONDS = 300;

/** Commits counted over one window, accepted and rejected alike. */
export type CommitWindowCounts = {
  /** Commits the server applied. */
  accepted: number;

  /** Commits the server refused, or whose evaluation threw. */
  rejected: number;

  /** Operations the window's commits carried, accepted or not. The ratio to
   * the commit count is the shape of the traffic: a storm is many commits of
   * one operation each. */
  operations: number;
};

/** One session's share of a space's commits. */
export type CommitWriterRates = {
  /** The committing session's id. */
  session: string;

  /** The principal the session was opened as, where the server knows one. */
  principal?: string;

  /** Commits in the last sixty seconds. */
  minute: CommitWindowCounts;

  /** Commits in the last ten minutes. */
  tenMinutes: CommitWindowCounts;
};

/** One space's commits, and the writers behind them. */
export type CommitSpaceRates = {
  /** The space DID. */
  space: string;

  /** Commits in the last sixty seconds, across every writer. */
  minute: CommitWindowCounts;

  /** Commits in the last ten minutes, across every writer. */
  tenMinutes: CommitWindowCounts;

  /** Present while the space's commits per minute have stayed at or over
   * the storm threshold for the sustained window; `since` is when the
   * run over the threshold began. */
  storm?: { since: number };

  /** Writers with a commit in the last ten minutes, listed or not, among
   * the ones retained: a space keeps at most 256 writers and evicts the
   * one that committed longest ago past that, so at the cap this is the
   * cap rather than the count. */
  activeWriters: number;

  /** The top writers over each window, as one list: the union of the top N
   * by the last minute and the top N by the last ten minutes, ordered by the
   * minute's commits and then the ten minutes'. */
  writers: CommitWriterRates[];
};

/** The thresholds a tracker judges a storm by. */
export type CommitStormThresholds = {
  /** Commits in the last sixty seconds, accepted and rejected together, at
   * or over which a space is over the threshold. */
  commitsPerMinute: number;

  /** How long a space has to stay over the threshold to be in a storm. */
  sustainedSeconds: number;
};

/** What the tracker reports: the thresholds in effect and the busiest
 * spaces, each with its busiest writers. */
export type CommitRatesReport = {
  /** The storm thresholds in effect. */
  storm: CommitStormThresholds;

  /** Spaces with a commit in the last ten minutes, listed or not, among
   * the ones retained: the tracker keeps at most 1,024 spaces and evicts
   * the one that committed longest ago past that, so at the cap this is
   * the cap rather than the count. */
  activeSpaces: number;

  /** Retained spaces in a storm right now, listed or not. */
  storms: number;

  /** The top spaces over each window, ranked the way a space ranks its
   * writers. */
  spaces: CommitSpaceRates[];
};

/** One decided commit, as the tracker records it. */
export type RecordedCommit = {
  space: string;
  session: string;
  principal?: string;
  accepted: boolean;
  operations: number;
};

/** The storm thresholds read from the environment: each variable as
 * `readEnv` returns it when that is a positive number, and the default
 * otherwise, including when the variable is unset or `readEnv` throws
 * because the process may not read it. The reader is a parameter so that
 * every one of those cases can be exercised directly, whatever permissions
 * the calling process has. */
export const commitStormThresholds = (
  readEnv: (name: string) => string | undefined,
): CommitStormThresholds => {
  const positive = (name: string, fallback: number): number => {
    let raw: string | undefined;
    try {
      raw = readEnv(name);
    } catch {
      return fallback;
    }
    const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    commitsPerMinute: positive(
      "CF_COMMIT_STORM_PER_MINUTE",
      DEFAULT_STORM_COMMITS_PER_MINUTE,
    ),
    sustainedSeconds: positive(
      "CF_COMMIT_STORM_SUSTAINED_SECONDS",
      DEFAULT_STORM_SUSTAINED_SECONDS,
    ),
  };
};

/** Counts for one second's worth of commits. */
type Bucket = CommitWindowCounts & {
  /** The bucket's time, in whole buckets since the epoch. */
  index: number;
};

const emptyCounts = (): CommitWindowCounts => ({
  accepted: 0,
  rejected: 0,
  operations: 0,
});

const addCounts = (
  into: CommitWindowCounts,
  counts: CommitWindowCounts,
): void => {
  into.accepted += counts.accepted;
  into.rejected += counts.rejected;
  into.operations += counts.operations;
};

const totalCommits = (counts: CommitWindowCounts): number =>
  counts.accepted + counts.rejected;

/**
 * Commits over the long window, one bucket per second that saw any,
 * oldest first. A clock that steps backwards lands its commits in the
 * newest bucket rather than opening one out of order, so the list stays
 * sorted and the windows stay readable.
 */
class CommitSeries {
  #buckets: Bucket[] = [];

  /** Records one commit at `now`. */
  add(now: number, accepted: boolean, operations: number): void {
    this.prune(now);
    const index = Math.floor(now / BUCKET_MS);
    const newest = this.#buckets.at(-1);
    const bucket = newest !== undefined && newest.index >= index
      ? newest
      : this.#open(index);
    if (accepted) bucket.accepted++;
    else bucket.rejected++;
    bucket.operations += operations;
  }

  /** Drops the buckets that have left the long window as of `now`. */
  prune(now: number): void {
    const oldest = Math.floor((now - TEN_MINUTES_MS) / BUCKET_MS) + 1;
    let drop = 0;
    while (
      drop < this.#buckets.length && this.#buckets[drop].index < oldest
    ) {
      drop++;
    }
    if (drop > 0) this.#buckets.splice(0, drop);
  }

  /** Whether any commit remains inside the long window as of `now`. */
  active(now: number): boolean {
    this.prune(now);
    return this.#buckets.length > 0;
  }

  /** The commits inside the last `windowMs` as of `now`: the buckets whose
   * whole second began no earlier than `now - windowMs`. */
  counts(now: number, windowMs: number): CommitWindowCounts {
    const oldest = Math.floor((now - windowMs) / BUCKET_MS) + 1;
    const total = emptyCounts();
    for (let i = this.#buckets.length - 1; i >= 0; i--) {
      const bucket = this.#buckets[i];
      if (bucket.index < oldest) break;
      addCounts(total, bucket);
    }
    return total;
  }

  #open(index: number): Bucket {
    const bucket = { ...emptyCounts(), index };
    this.#buckets.push(bucket);
    return bucket;
  }
}

/** What eviction ranks by: the tracker-wide sequence number of the entry's
 * latest commit, which orders two commits in one second the way their
 * arrival did, and is untouched by a clock that steps. */
type Recency = {
  lastRecorded: number;
};

/** One writer of a space: a session, with its principal when known. */
type Writer = Recency & {
  session: string;
  principal?: string;
  series: CommitSeries;
};

/** One space's commits and writers, and where it stands against the storm
 * threshold. */
type SpaceWindow = Recency & {
  series: CommitSeries;
  writers: Map<string, Writer>;

  /** When the space's commits per minute last rose to the threshold without
   * having fallen below it since; `undefined` while under it. */
  overSince?: number;
};

/** Both windows of one series, as a report carries them. */
type Windows = {
  minute: CommitWindowCounts;
  tenMinutes: CommitWindowCounts;
};

const windowsOf = (series: CommitSeries, now: number): Windows => ({
  minute: series.counts(now, MINUTE_MS),
  tenMinutes: series.counts(now, TEN_MINUTES_MS),
});

/** The union of the top `n` entries by each window, ordered by the minute's
 * commits and then the ten minutes'. An entry hot this minute and one that
 * was hot earlier in the ten both make the list. */
const topByEachWindow = <T extends Windows>(entries: T[], n: number): T[] => {
  const byMinute = [...entries].sort((a, b) =>
    totalCommits(b.minute) - totalCommits(a.minute)
  ).slice(0, n);
  const byTenMinutes = [...entries].sort((a, b) =>
    totalCommits(b.tenMinutes) - totalCommits(a.tenMinutes)
  ).slice(0, n);
  const chosen = new Set<T>([...byMinute, ...byTenMinutes]);
  return [...chosen].sort((a, b) =>
    totalCommits(b.minute) - totalCommits(a.minute) ||
    totalCommits(b.tenMinutes) - totalCommits(a.tenMinutes)
  );
};

/** Evicts from `map` the entry that committed longest ago. */
const evictQuietest = <T extends Recency>(map: Map<string, T>): void => {
  let quietestKey: string | undefined;
  let quietest = Infinity;
  for (const [key, entry] of map) {
    if (entry.lastRecorded < quietest) {
      quietest = entry.lastRecorded;
      quietestKey = key;
    }
  }
  if (quietestKey !== undefined) map.delete(quietestKey);
};

/**
 * Records every decided commit of a memory server and reports the rates.
 *
 * Recording is a few array operations per commit, so it runs inside the
 * transaction path. Reporting walks every retained space and writer, and
 * drops the ones with nothing left in the long window, so a report is also
 * what reclaims the memory of a space that went quiet.
 */
export class CommitRateTracker {
  readonly #now: () => number;
  readonly #storm: CommitStormThresholds;
  readonly #maxSpaces: number;
  readonly #maxWritersPerSpace: number;
  readonly #topSpaces: number;
  readonly #topWriters: number;
  readonly #spaces = new Map<string, SpaceWindow>();

  /** Commits recorded so far; the latest one's number is what eviction
   * ranks a space or writer by. */
  #sequence = 0;

  /**
   * Constructs an instance judging storms by `storm`, reading the time
   * from `now` (`Date.now` unless given), and bounded by the caps given or
   * their defaults.
   */
  constructor(
    options: {
      now?: () => number;
      storm?: CommitStormThresholds;
      maxSpaces?: number;
      maxWritersPerSpace?: number;
      topSpaces?: number;
      topWriters?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#storm = options.storm ?? {
      commitsPerMinute: DEFAULT_STORM_COMMITS_PER_MINUTE,
      sustainedSeconds: DEFAULT_STORM_SUSTAINED_SECONDS,
    };
    this.#maxSpaces = options.maxSpaces ?? DEFAULT_MAX_SPACES;
    this.#maxWritersPerSpace = options.maxWritersPerSpace ??
      DEFAULT_MAX_WRITERS_PER_SPACE;
    this.#topSpaces = options.topSpaces ?? DEFAULT_TOP_SPACES;
    this.#topWriters = options.topWriters ?? DEFAULT_TOP_WRITERS;
  }

  /**
   * Records one decided commit, and returns whether its space is in a storm
   * once it is counted.
   */
  record(commit: RecordedCommit): { storm: boolean } {
    const now = this.#now();
    const space = this.#space(commit.space);
    this.#endBrokenRun(space, now);
    const sequence = ++this.#sequence;
    space.lastRecorded = sequence;
    space.series.add(now, commit.accepted, commit.operations);
    const writer = this.#writer(space, commit);
    writer.lastRecorded = sequence;
    writer.series.add(now, commit.accepted, commit.operations);
    return { storm: this.#judgeStorm(space, now) };
  }

  /** The thresholds in effect and the busiest spaces, each with its busiest
   * writers, as of now. */
  report(): CommitRatesReport {
    const now = this.#now();
    const spaces: CommitSpaceRates[] = [];
    let storms = 0;
    for (const [key, space] of this.#spaces) {
      if (!space.series.active(now)) {
        this.#spaces.delete(key);
        continue;
      }
      const writers: CommitWriterRates[] = [];
      for (const [writerKey, writer] of space.writers) {
        if (!writer.series.active(now)) {
          space.writers.delete(writerKey);
          continue;
        }
        writers.push({
          session: writer.session,
          ...(writer.principal === undefined
            ? {}
            : { principal: writer.principal }),
          ...windowsOf(writer.series, now),
        });
      }
      const storm = this.#judgeStorm(space, now);
      if (storm) storms++;
      const since = space.overSince;
      spaces.push({
        space: key,
        ...windowsOf(space.series, now),
        ...(storm && since !== undefined ? { storm: { since } } : {}),
        activeWriters: writers.length,
        writers: topByEachWindow(writers, this.#topWriters),
      });
    }
    return {
      storm: { ...this.#storm },
      activeSpaces: spaces.length,
      storms,
      spaces: topByEachWindow(spaces, this.#topSpaces),
    };
  }

  /** Helper for `record()`, which finds or opens the space's window,
   * evicting the quietest space when the cap is reached. */
  #space(key: string): SpaceWindow {
    let space = this.#spaces.get(key);
    if (space === undefined) {
      if (this.#spaces.size >= this.#maxSpaces) evictQuietest(this.#spaces);
      space = {
        lastRecorded: this.#sequence,
        series: new CommitSeries(),
        writers: new Map(),
      };
      this.#spaces.set(key, space);
    }
    return space;
  }

  /** Helper for `record()`, which finds or opens the commit's writer in its
   * space, evicting the quietest writer when the cap is reached. */
  #writer(space: SpaceWindow, commit: RecordedCommit): Writer {
    const key = `${commit.session}\u0000${commit.principal ?? ""}`;
    let writer = space.writers.get(key);
    if (writer === undefined) {
      if (space.writers.size >= this.#maxWritersPerSpace) {
        evictQuietest(space.writers);
      }
      writer = {
        lastRecorded: this.#sequence,
        session: commit.session,
        ...(commit.principal === undefined
          ? {}
          : { principal: commit.principal }),
        series: new CommitSeries(),
      };
      space.writers.set(key, writer);
    }
    return writer;
  }

  /** Helper for `record()`, which ends the space's run over the threshold
   * if expiry took the minute under it at any time before `now`, whether or
   * not anything read the tracker then. The minute changes only at whole
   * seconds, as commits leave it, so its count a millisecond before `now`
   * is its count over the whole interval since the commit before this one;
   * a commit landing on the very second its predecessor leaves keeps the
   * run, since the count never stood under the threshold for any time. */
  #endBrokenRun(space: SpaceWindow, now: number): void {
    const before = totalCommits(space.series.counts(now - 1, MINUTE_MS));
    if (before < this.#storm.commitsPerMinute) space.overSince = undefined;
  }

  /** Helper for `record()` and `report()`, which moves the space's run over
   * the threshold along by its commits in the last minute as of `now`, and
   * returns whether that run has lasted the sustained window. A count under
   * the threshold ends the run, and one at or over it begins one where none
   * is under way. */
  #judgeStorm(space: SpaceWindow, now: number): boolean {
    const perMinute = totalCommits(space.series.counts(now, MINUTE_MS));
    if (perMinute >= this.#storm.commitsPerMinute) {
      space.overSince ??= now;
    } else {
      space.overSince = undefined;
    }
    return space.overSince !== undefined &&
      now - space.overSince >= this.#storm.sustainedSeconds * 1000;
  }
}
