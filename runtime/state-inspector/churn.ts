// Commit-rate churn over time — the retrospective, offline view of "is this
// space writing more than it should be?".
//
// Why this exists as its own query (see docs/plans/space-clone-rehearsal.md):
// `hotEntities` ranks entities by all-time write count, which cannot show a
// storm STARTING or a settle COMPLETING — both are shapes in time, not totals.
// The July 2026 Topics write storm (20 compiler-generated cells producing 96%
// of all commits, peaking at ~1,598 commits/minute) is invisible to a total and
// obvious in a rate curve.
//
// Two neighbors exist and neither fills this slot: the OTel commit telemetry
// reports live rates, but only where a collector was attached when it mattered;
// the workload diagnostics (labs#4950) instrument an orchestrated run of a live
// runtime. This reads the durable store after the fact — any space, any window,
// no instrumentation required at incident time.
//
// Deliberately threshold-free: it reports, it does not judge. What counts as
// "settled" differs per space, and a wrong default would give false confidence
// at exactly the moment a migration checklist is trusted most.

import type { SpaceDb } from "./db.ts";

/** One time bucket of write activity. */
export interface ChurnBucket {
  /** Bucket start, UTC, `YYYY-MM-DD HH:MM:SS` (the store's own clock format). */
  start: string;

  /** Unix seconds for the bucket start — for plotting without re-parsing. */
  startEpoch: number;

  commits: number;
  revisions: number;
}

/** An entity ranked by writes within a single bucket. */
export interface ChurnEntity {
  id: string;
  scope: string;
  writes: number;
  sessions: number;
}

export interface ChurnReport {
  bucketSeconds: number;
  branch: string;

  /** First bucket start the curve covers; null on an empty window. */
  from: string | null;

  /** Last such bucket start, null under the same condition. */
  to: string | null;

  /**
   * Start of the last bucket that actually holds a commit (null when none do).
   *
   * Distinguishes the two shapes a flat tail can have: a curve that ran out of
   * data at its last write, and a window that was genuinely observed through to
   * its end and stayed quiet. Only the second is evidence of a settle, and
   * without this they render identically.
   */
  lastCommit: string | null;

  totals: { commits: number; revisions: number };

  /**
   * Contiguous, zero-filled from `from` to `to` so gaps read as quiet.
   *
   * Extends to cover an explicit `since`/`until` even where no commit landed:
   * "the rate returned to baseline and STAYED there" is a claim about a period
   * of time, and a curve that stops at its own last write can never show it —
   * it ends on a busy bucket by construction, exactly when a storm has just
   * stopped.
   */
  buckets: ChurnBucket[];

  /** The busiest bucket by commits, or null when the window is empty. */
  peak: ChurnBucket | null;

  /** Top writers inside `peak` — what to blame for the busiest minute. */
  peakEntities: ChurnEntity[];

  /**
   * Commits whose `created_at` SQLite could not parse as a time, and which are
   * therefore absent from every bucket. Nonzero means the curve is incomplete —
   * surfaced rather than silently dropped.
   */
  untimedCommits: number;
}

export interface ChurnOptions {
  branch?: string;

  /** Bucket width in seconds. Default 60. */
  bucketSeconds?: number;

  /**
   * Lower bound on `commit.created_at`, inclusive. `YYYY-MM-DD HH:MM:SS` or ISO.
   *
   * Also widens the curve: the buckets cover the whole window asked for, not
   * just the part of it that happened to contain writes.
   */
  since?: string;

  /**
   * Upper bound on `commit.created_at`, exclusive.
   *
   * This is the observation boundary as well as a filter — pass the moment you
   * stopped watching (`now`, after a migration) and the trailing quiet buckets
   * are reported instead of implied.
   */
  until?: string;

  /** How many entities to attribute the peak bucket to. Default 10. */
  top?: number;
}

/**
 * Zero-filling is what makes a curve readable, but a year-long store bucketed
 * by the second would materialize ~31M rows. Rather than silently truncate (and
 * report a curve with holes as if it were complete), refuse and say what to do.
 */
const MAX_BUCKETS = 20_000;

export function commitChurn(
  space: SpaceDb,
  options: ChurnOptions = {},
): ChurnReport {
  const branch = options.branch ?? "";
  const bucketSeconds = options.bucketSeconds ?? 60;
  const top = options.top ?? 10;
  if (!Number.isInteger(bucketSeconds) || bucketSeconds <= 0) {
    throw new Error("bucketSeconds must be a positive whole number of seconds");
  }

  const db = space.db;
  // A bound SQLite cannot read as a time compares as NULL, so it matches NO
  // rows — and the report then says "no timed commits in window", which is
  // indistinguishable from a genuinely quiet space. The runbook has operators
  // typing `--since '<when you started>'` by hand to confirm a settle, so a
  // mistyped bound reporting silence is a false all-clear on exactly the check
  // it would be used for. Refuse instead.
  const sinceEpoch = parseStoreTime(db, "since", options.since);
  const untilEpoch = parseStoreTime(db, "until", options.until);
  // Same failure with two readable bounds: an empty or backwards interval also
  // matches no commits, and also renders as a quiet window rather than as the
  // mistake it is. `until` is exclusive, so equal bounds are empty too.
  if (sinceEpoch !== null && untilEpoch !== null && sinceEpoch >= untilEpoch) {
    throw new Error(
      `--since ${JSON.stringify(options.since)} is not before --until ` +
        `${JSON.stringify(options.until)}, so the window is empty — which ` +
        `would report as a quiet space rather than as a bad window.`,
    );
  }

  // `strftime('%s', …)` yields NULL for a value it cannot parse as a time, which
  // is how untimed rows are separated from real zero-activity buckets. It also
  // yields TEXT, and SQLite sorts every INTEGER before every TEXT — so each
  // comparison casts, or the bounds silently match everything (or nothing).
  const window: string[] = [`c.branch = :branch`];
  const params: Record<string, string | number> = { branch, b: bucketSeconds };
  if (options.since !== undefined) {
    window.push(
      `CAST(strftime('%s', c.created_at) AS INTEGER) >= ` +
        `CAST(strftime('%s', :since) AS INTEGER)`,
    );
    params.since = options.since;
  }
  if (options.until !== undefined) {
    window.push(
      `CAST(strftime('%s', c.created_at) AS INTEGER) < ` +
        `CAST(strftime('%s', :until) AS INTEGER)`,
    );
    params.until = options.until;
  }
  const where = window.join(" AND ");

  const untimed = db
    .prepare(
      `SELECT count(*) n FROM "commit" c
       WHERE c.branch = :branch AND strftime('%s', c.created_at) IS NULL`,
    )
    .get<{ n: number }>({ branch })!.n;

  // One row per bucket. LEFT JOIN so a commit that wrote no revisions still
  // counts as a commit; count(DISTINCT c.seq) so the join fan-out cannot
  // inflate the commit count.
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%s', c.created_at) / :b AS INTEGER) * :b AS bucket,
              count(DISTINCT c.seq) commits,
              count(r.commit_seq) revisions
       FROM "commit" c
       LEFT JOIN revision r ON r.commit_seq = c.seq
       WHERE ${where} AND strftime('%s', c.created_at) IS NOT NULL
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all<{ bucket: number; commits: number; revisions: number }>(params);

  if (rows.length === 0) {
    return {
      bucketSeconds,
      branch,
      from: null,
      to: null,
      lastCommit: null,
      totals: { commits: 0, revisions: 0 },
      buckets: [],
      peak: null,
      peakEntities: [],
      untimedCommits: untimed,
    };
  }

  // Widen to the requested window before measuring the span, so the bucket cap
  // is applied to what will actually be materialized.
  const bucketOf = (epoch: number) =>
    Math.floor(epoch / bucketSeconds) * bucketSeconds;
  // `until` is exclusive, so the last bucket the window touches is the one
  // holding the instant before it — otherwise an `until` landing exactly on a
  // boundary would materialize a bucket the filter excluded, reporting a zero
  // that is an artifact rather than an observation.
  const first = sinceEpoch === null
    ? rows[0].bucket
    : Math.min(rows[0].bucket, bucketOf(sinceEpoch));
  const lastObserved = rows[rows.length - 1].bucket;
  const last = untilEpoch === null
    ? lastObserved
    : Math.max(lastObserved, bucketOf(untilEpoch - 1));
  const span = (last - first) / bucketSeconds + 1;
  if (span > MAX_BUCKETS) {
    throw new Error(
      `window spans ${Math.round(span)} buckets at ${bucketSeconds}s ` +
        `(limit ${MAX_BUCKETS}); widen --bucket or narrow --since/--until.`,
    );
  }

  const observed = new Map(rows.map((r) => [r.bucket, r]));
  const buckets: ChurnBucket[] = [];
  for (let t = first; t <= last; t += bucketSeconds) {
    const hit = observed.get(t);
    buckets.push({
      start: epochToStoreTime(db, t),
      startEpoch: t,
      commits: hit?.commits ?? 0,
      revisions: hit?.revisions ?? 0,
    });
  }

  const totals = rows.reduce(
    (acc, r) => ({
      commits: acc.commits + r.commits,
      revisions: acc.revisions + r.revisions,
    }),
    { commits: 0, revisions: 0 },
  );

  // Peak by commits; revisions break the tie, so a burst of fat commits ranks
  // above the same number of trivial ones.
  const peak = buckets.reduce((best, b) =>
    b.commits > best.commits ||
      (b.commits === best.commits && b.revisions > best.revisions)
      ? b
      : best
  );

  return {
    bucketSeconds,
    branch,
    from: buckets[0].start,
    to: buckets[buckets.length - 1].start,
    lastCommit: epochToStoreTime(db, lastObserved),
    totals,
    buckets,
    peak,
    peakEntities: entitiesInWindow(space, {
      branch,
      fromEpoch: peak.startEpoch,
      toEpoch: peak.startEpoch + bucketSeconds,
      limit: top,
    }),
    untimedCommits: untimed,
  };
}

/** Top entities by write count within a half-open epoch-second window. */
function entitiesInWindow(
  space: SpaceDb,
  opts: {
    branch: string;
    fromEpoch: number;
    toEpoch: number;
    limit: number;
  },
): ChurnEntity[] {
  return space.db
    .prepare(
      `SELECT r.id, r.scope_key, count(*) writes,
              count(DISTINCT c.session_id) sessions
       FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
       WHERE c.branch = :branch
         AND CAST(strftime('%s', c.created_at) AS INTEGER) >= :from
         AND CAST(strftime('%s', c.created_at) AS INTEGER) < :to
       GROUP BY r.id, r.scope_key
       ORDER BY writes DESC, r.id
       LIMIT :limit`,
    )
    .all<
      { id: string; scope_key: string; writes: number; sessions: number }
    >({
      branch: opts.branch,
      from: opts.fromEpoch,
      to: opts.toEpoch,
      limit: opts.limit,
    })
    .map((r) => ({
      id: r.id,
      scope: r.scope_key,
      writes: r.writes,
      sessions: r.sessions,
    }));
}

/** Render an epoch second back into the store's own UTC text format. */
function epochToStoreTime(db: SpaceDb["db"], epoch: number): string {
  return db
    .prepare(`SELECT datetime(:e, 'unixepoch') t`)
    .get<{ t: string }>({ e: epoch })!.t;
}

/**
 * A window bound as an epoch second, parsed by SQLite itself so the curve's
 * edges and the SQL filter can never disagree about what a timestamp means.
 *
 * Null only for an absent bound. A bound that is present but unreadable throws:
 * see the refusal note in `commitChurn`.
 */
function parseStoreTime(
  db: SpaceDb["db"],
  option: string,
  text: string | undefined,
): number | null {
  if (text === undefined) return null;
  const epoch = db
    .prepare(`SELECT CAST(strftime('%s', :t) AS INTEGER) e`)
    .get<{ e: number | null }>({ t: text })?.e ?? null;
  if (epoch === null) {
    throw new Error(
      `--${option} ${JSON.stringify(text)} is not a time SQLite can read. ` +
        `Use 'YYYY-MM-DD HH:MM:SS' (UTC) or an ISO timestamp — left as is it ` +
        `would match no commits and report the window as quiet.`,
    );
  }
  return epoch;
}

/** Commits per minute for a bucket — the unit the incident record speaks in. */
export function commitsPerMinute(bucket: ChurnBucket, seconds: number): number {
  return (bucket.commits * 60) / seconds;
}
