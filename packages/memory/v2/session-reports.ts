/**
 * The diagnostics clients report about their own sessions (04-protocol.md
 * §4.14), as one memory server keeps them for the health route: running
 * totals, and the most recent reports in full. The remote-echo breaker is the
 * one reporter (docs/plans/scheduler-remote-echo-breaker.md): a trip says a
 * client is deferring an action that kept rewriting a document another writer
 * kept rewriting back, and a clear says how that ended. Memory is bounded by
 * construction: the recent list is a ring.
 */

import type {
  CellScope,
  EchoBreakerClearReport,
  SessionReport,
} from "../v2.ts";
import { SESSION_REPORT_TEXT_MAX } from "../v2.ts";

/** Reports kept in full, newest last. */
const DEFAULT_RECENT = 64;

/** One report as the server recorded it. */
export type RecordedSessionReport = SessionReport & {
  /** When the server received it, in epoch milliseconds. */
  at: number;

  /** The space the report's session is open on. */
  space: string;

  /** The reporting session's id. */
  session: string;

  /** The principal the session was opened as, where the server knows one. */
  principal?: string;
};

/** What the log reports for the health route. */
export type SessionReportsReport = {
  /** The remote-echo breaker's reports since the server started. */
  echoBreaker: {
    /** Trips reported. */
    trips: number;

    /** Clears reported, by how the trip ended. */
    clears: Record<EchoBreakerClearReport["reason"], number>;
  };

  /** The most recent reports, oldest first, at most 64. */
  recent: RecordedSessionReport[];
};

const SCOPES: ReadonlySet<string> = new Set(["space", "user", "session"]);
const CLEAR_REASONS: ReadonlySet<string> = new Set([
  "convergence",
  "quiet",
  "retired",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 &&
  value.length <= SESSION_REPORT_TEXT_MAX;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Returns `value` as a session report when it is one of the shapes section
 * 4.14 defines, with every string within {@link SESSION_REPORT_TEXT_MAX} and
 * every count a non-negative integer, and `null` otherwise. The result is a
 * fresh object holding only the defined fields, so nothing else a client sent
 * reaches the log.
 */
export const parseSessionReport = (value: unknown): SessionReport | null => {
  if (!isPlainRecord(value) || value.kind !== "echo-breaker") return null;
  const document = value.document;
  if (
    !isPlainRecord(document) || !isBoundedText(document.id) ||
    typeof document.scope !== "string" || !SCOPES.has(document.scope) ||
    !isBoundedText(value.action)
  ) {
    return null;
  }
  const named = {
    kind: "echo-breaker" as const,
    document: { id: document.id, scope: document.scope as CellScope },
    action: value.action,
  };
  if (value.event === "trip") return { ...named, event: "trip" };
  if (
    value.event === "clear" && typeof value.reason === "string" &&
    CLEAR_REASONS.has(value.reason) && isCount(value.renewals) &&
    isCount(value.trippedMs)
  ) {
    return {
      ...named,
      event: "clear",
      reason: value.reason as EchoBreakerClearReport["reason"],
      renewals: value.renewals,
      trippedMs: value.trippedMs,
    };
  }
  return null;
};

/**
 * Records the session reports a memory server receives and reports them.
 * Recording is a counter bump and a ring write, so it runs on the receive
 * path; the totals are lifetime counts, and the ring keeps the newest reports
 * in full.
 */
export class SessionReportLog {
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #recent: RecordedSessionReport[] = [];

  #trips = 0;
  readonly #clears: Record<EchoBreakerClearReport["reason"], number> = {
    convergence: 0,
    quiet: 0,
    retired: 0,
  };

  /**
   * Constructs an instance reading the time from `now` (`Date.now` unless
   * given) and keeping `recent` reports in full (64 unless given).
   */
  constructor(options: { now?: () => number; recent?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#capacity = Math.max(1, options.recent ?? DEFAULT_RECENT);
  }

  /** Records one report from the session `session` open on `space`. */
  record(
    entry: {
      space: string;
      session: string;
      principal?: string;
      report: SessionReport;
    },
  ): RecordedSessionReport {
    const recorded: RecordedSessionReport = {
      ...entry.report,
      at: this.#now(),
      space: entry.space,
      session: entry.session,
      ...(entry.principal === undefined ? {} : { principal: entry.principal }),
    };
    if (entry.report.event === "trip") this.#trips++;
    else this.#clears[entry.report.reason]++;
    this.#recent.push(recorded);
    if (this.#recent.length > this.#capacity) this.#recent.shift();
    return recorded;
  }

  /** The totals so far and the most recent reports, oldest first. */
  report(): SessionReportsReport {
    return {
      echoBreaker: { trips: this.#trips, clears: { ...this.#clears } },
      recent: this.#recent.map((entry) => ({
        ...entry,
        document: { ...entry.document },
      })),
    };
  }
}
