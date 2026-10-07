/**
 * The durable store of the runner's local jobs: one SQLite file the runner
 * alone writes, holding each job's request, state, result and the ordered
 * events a caller watches it by.
 *
 * A job moves `queued` → `running` → one of `completed`, `failed`,
 * `cancelled`, `interrupted`. Every move, and everything a job reports while
 * it runs, is appended as an event with the next `seq` for that job, in the
 * same transaction as the move, so a caller that has read up to `seq` and
 * asks for what follows misses nothing.
 *
 * A job found `running` when the store opens was cut off by a stop or a
 * crash. It is ended `interrupted` and never run again: a job may already
 * have changed things through its commands, and running it twice could do
 * them twice.
 */

import type { HarnessModelLimits } from "@commonfabric/cf-harness/model/client";
import type { HarnessInlineImageAttachment } from "@commonfabric/cf-harness/contracts/image";

import { hashStringOf } from "@commonfabric/data-model";
import { Database } from "@db/sqlite";

/** A job's state. */
export type LocalJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** The states no later write moves a job out of. */
export const LOCAL_JOB_TERMINAL_STATES: ReadonlySet<LocalJobState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** The error code of a job a stop or a crash cut off. */
export const RUNNER_RESTARTED = "RUNNER_RESTARTED";

/** What a caller asked for: everything but who asked and under which key. */
export interface LocalJobRequest extends HarnessModelLimits {
  task: string;
  instructions?: string;
  context?: unknown;
  resultSchema: unknown;
  tools?: string[];
  maxModelTurns?: number;
  imageAttachments?: HarnessInlineImageAttachment[];

  /**
   * The caller can host the job's browser. Its contents are not read yet;
   * declaring it is what counts, as on the console's task route.
   */
  browserHost?: Record<string, unknown>;
}

/** One event of a job, in `seq` order. */
export interface LocalJobEvent {
  seq: number;
  at: string;
  kind: string;
  body: Record<string, unknown>;
}

/** A job as a caller reads it. */
export interface LocalJob {
  id: string;
  caller: string;
  profile: string;
  idempotencyKey: string;
  request: LocalJobRequest;
  state: LocalJobState;

  /** The `seq` of the job's latest event. */
  seq: number;

  /** The tool the job is using, from its latest `step` event. */
  step?: Record<string, unknown>;

  /** Every command the job ran, from its `command` events, in order. */
  commands: Record<string, unknown>[];

  /** The value the model submitted, once the job completed. */
  result?: unknown;

  errorCode?: string;

  /** Usage, turns and tool calls, once the job ran. */
  report?: Record<string, unknown>;

  cancelRequestedAt?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** The ending a running job is given. */
export interface LocalJobEnding {
  state: "completed" | "failed" | "cancelled" | "interrupted";
  result?: unknown;
  errorCode?: string;
  report?: Record<string, unknown>;
}

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`;

const INIT = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  caller TEXT NOT NULL,
  profile TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL,
  cancel_requested_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  report_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (caller, idempotency_key)
);
CREATE TABLE IF NOT EXISTS job_events (
  job_id TEXT NOT NULL REFERENCES jobs (id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, created_at);
`;

/** A `jobs` row as SQLite returns it. */
interface JobRow {
  id: string;
  caller: string;
  profile: string;
  idempotency_key: string;
  request_json: string;
  state: LocalJobState;
  cancel_requested_at: string | null;
  result_json: string | null;
  error_code: string | null;
  report_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** An event row as SQLite returns it. */
interface EventRow {
  seq: number;
  at: string;
  kind: string;
  body_json: string;
}

/** The store, over one SQLite database it owns. */
export class LocalJobStore {
  #database: Database;
  #now: () => Date;
  #newId: () => string;
  #listeners = new Set<(jobId: string, event: LocalJobEvent) => void>();

  /**
   * Constructs an instance over an open database. Use `open` to create the
   * database and its tables.
   */
  constructor(
    database: Database,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => `job-${crypto.randomUUID()}`);
  }

  /**
   * Opens the store at `path`, creating it when absent; `":memory:"` opens
   * one that lives as long as the process.
   */
  static open(
    path: string,
    options: { now?: () => Date; newId?: () => string } = {},
  ): LocalJobStore {
    const database = new Database(path, { create: true });
    try {
      database.exec(PRAGMAS);
      database.exec(INIT);
    } catch (error) {
      database.close();
      throw error;
    }
    return new LocalJobStore(database, options);
  }

  /** Closes the database. */
  close(): void {
    this.#database.close();
  }

  /**
   * Calls `listener` with every event appended from now on, after its
   * transaction commits. Returns the call that stops it.
   */
  subscribe(
    listener: (jobId: string, event: LocalJobEvent) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Adds a job, or returns the one `caller` already added under
   * `idempotencyKey` when its request is the same; `created` says which. A
   * key that already names a different request is a `conflict`, and adds
   * nothing.
   */
  enqueue(
    caller: string,
    profile: string,
    idempotencyKey: string,
    request: LocalJobRequest,
  ): { job: LocalJob; created: boolean } | { conflict: string } {
    const requestJson = JSON.stringify(request);
    const existing = this.#database.prepare(`
      SELECT * FROM jobs WHERE caller = :caller AND idempotency_key = :key
    `).get({ caller, key: idempotencyKey }) as JobRow | undefined;
    if (existing !== undefined) {
      if (
        existing.profile !== profile ||
        hashStringOf(JSON.parse(existing.request_json)) !==
          hashStringOf(JSON.parse(requestJson))
      ) {
        return {
          conflict:
            `The idempotency key \`${idempotencyKey}\` already names a different request.`,
        };
      }
      return { job: this.#view(existing), created: false };
    }
    const id = this.#newId();
    const at = this.#now().toISOString();
    const appended = this.#write(() => {
      this.#database.prepare(`
        INSERT INTO jobs (id, caller, profile, idempotency_key, request_json,
          state, created_at)
        VALUES (:id, :caller, :profile, :key, :request, 'queued', :at)
      `).run({
        id,
        caller,
        profile,
        key: idempotencyKey,
        request: requestJson,
        at,
      });
      return [this.#append(id, "state", { state: "queued" }, at)];
    });
    this.#notify(id, appended);
    return { job: this.get(id)!, created: true };
  }

  /** The job named `id`, or `undefined`. */
  get(id: string): LocalJob | undefined {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = :id")
      .get({ id }) as JobRow | undefined;
    return row === undefined ? undefined : this.#view(row);
  }

  /** The newest `limit` jobs, newest first. */
  list(limit: number): LocalJob[] {
    return (this.#database.prepare(`
      SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT :limit
    `).all({ limit }) as JobRow[]).map((row) => this.#view(row));
  }

  /** The events of job `id` after `seq`, in order. */
  events(id: string, after = 0): LocalJobEvent[] {
    return (this.#database.prepare(`
      SELECT seq, at, kind, body_json FROM job_events
      WHERE job_id = :id AND seq > :after ORDER BY seq
    `).all({ id, after }) as EventRow[]).map(eventOf);
  }

  /**
   * Appends an event a running job reports — a `step` or a `command` — and
   * returns it; `undefined` when the job is not running.
   */
  report(
    id: string,
    kind: "step" | "command",
    body: Record<string, unknown>,
  ): LocalJobEvent | undefined {
    const appended = this.#write(() => {
      const row = this.#row(id);
      if (row?.state !== "running") return [];
      return [this.#append(id, kind, body, this.#now().toISOString())];
    });
    this.#notify(id, appended);
    return appended[0];
  }

  /**
   * Asks for job `id` to stop. A queued job ends `cancelled` at once; a
   * running one is marked, and ends when its run stops. Returns the job, or
   * `undefined` when there is none.
   */
  requestCancel(id: string): LocalJob | undefined {
    const at = this.#now().toISOString();
    const appended = this.#write(() => {
      const row = this.#row(id);
      if (row === undefined || LOCAL_JOB_TERMINAL_STATES.has(row.state)) {
        return [];
      }
      if (row.cancel_requested_at !== null) return [];
      if (row.state === "queued") {
        this.#database.prepare(`
          UPDATE jobs SET state = 'cancelled', cancel_requested_at = :at,
            finished_at = :at WHERE id = :id
        `).run({ id, at });
        return [this.#append(id, "state", { state: "cancelled" }, at)];
      }
      this.#database.prepare(
        "UPDATE jobs SET cancel_requested_at = :at WHERE id = :id",
      ).run({ id, at });
      return [this.#append(id, "cancel", { requestedAt: at }, at)];
    });
    this.#notify(id, appended);
    return this.get(id);
  }

  /** Moves the oldest queued job to `running` and returns it. */
  claimNext(): LocalJob | undefined {
    const at = this.#now().toISOString();
    let claimed: string | undefined;
    const appended = this.#write(() => {
      const row = this.#database.prepare(`
        SELECT id FROM jobs WHERE state = 'queued'
        ORDER BY created_at, rowid LIMIT 1
      `).get() as { id: string } | undefined;
      if (row === undefined) return [];
      claimed = row.id;
      this.#database.prepare(`
        UPDATE jobs SET state = 'running', started_at = :at,
          attempt = attempt + 1 WHERE id = :id
      `).run({ id: row.id, at });
      return [this.#append(row.id, "state", { state: "running" }, at)];
    });
    if (claimed === undefined) return undefined;
    this.#notify(claimed, appended);
    return this.get(claimed);
  }

  /**
   * Ends running job `id`. A job asked to stop ends `cancelled` whatever its
   * run reported. Returns the job, or `undefined` when it was not running.
   */
  finish(id: string, ending: LocalJobEnding): LocalJob | undefined {
    const at = this.#now().toISOString();
    const appended = this.#write(() => {
      const row = this.#row(id);
      if (row?.state !== "running") return [];
      const state = row.cancel_requested_at !== null
        ? "cancelled"
        : ending.state;
      const completed = state === "completed";
      this.#database.prepare(`
        UPDATE jobs SET state = :state, result_json = :result,
          error_code = :error_code, report_json = :report, finished_at = :at
        WHERE id = :id
      `).run({
        id,
        state,
        result: completed ? JSON.stringify(ending.result ?? null) : null,
        error_code: completed || state === "cancelled"
          ? null
          : ending.errorCode ?? null,
        report: ending.report === undefined
          ? null
          : JSON.stringify(ending.report),
        at,
      });
      return [this.#append(
        id,
        "state",
        {
          state,
          ...(!completed && state !== "cancelled" &&
              ending.errorCode !== undefined
            ? { errorCode: ending.errorCode }
            : {}),
        },
        at,
      )];
    });
    if (appended.length === 0) return undefined;
    this.#notify(id, appended);
    return this.get(id);
  }

  /**
   * Ends every job found `running` as `interrupted`, with `RUNNER_RESTARTED`,
   * and returns their ids. The runner calls it once, before it claims
   * anything.
   */
  recover(): string[] {
    const at = this.#now().toISOString();
    const ids: string[] = [];
    const appended = this.#write(() => {
      const rows = this.#database.prepare(
        "SELECT id FROM jobs WHERE state = 'running'",
      ).all() as { id: string }[];
      return rows.map(({ id }) => {
        ids.push(id);
        this.#database.prepare(`
          UPDATE jobs SET state = 'interrupted', error_code = :code,
            finished_at = :at WHERE id = :id
        `).run({ id, code: RUNNER_RESTARTED, at });
        return this.#append(
          id,
          "state",
          { state: "interrupted", errorCode: RUNNER_RESTARTED },
          at,
        );
      });
    });
    ids.forEach((id, index) => this.#notify(id, [appended[index]]));
    return ids;
  }

  /** Helper for writes, which runs `body` in one immediate transaction. */
  #write<T>(body: () => T): T {
    return this.#database.transaction(body).immediate();
  }

  /** Helper for writes, which reads one row inside the open transaction. */
  #row(id: string): JobRow | undefined {
    return this.#database.prepare("SELECT * FROM jobs WHERE id = :id")
      .get({ id }) as JobRow | undefined;
  }

  /** Helper for writes, which appends the job's next event and returns it. */
  #append(
    id: string,
    kind: string,
    body: Record<string, unknown>,
    at: string,
  ): LocalJobEvent {
    const { seq } = this.#database.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_events
      WHERE job_id = :id
    `).get({ id }) as { seq: number };
    this.#database.prepare(`
      INSERT INTO job_events (job_id, seq, at, kind, body_json)
      VALUES (:id, :seq, :at, :kind, :body)
    `).run({ id, seq, at, kind, body: JSON.stringify(body) });
    return { seq, at, kind, body };
  }

  /** Helper for writes, which tells subscribers of committed events. */
  #notify(id: string, events: readonly LocalJobEvent[]): void {
    for (const event of events) {
      for (const listener of this.#listeners) listener(id, event);
    }
  }

  /** Helper for reads, which builds a job's view from its row and events. */
  #view(row: JobRow): LocalJob {
    const events = this.events(row.id);
    const steps = events.filter((event) => event.kind === "step");
    return {
      id: row.id,
      caller: row.caller,
      profile: row.profile,
      idempotencyKey: row.idempotency_key,
      request: JSON.parse(row.request_json),
      state: row.state,
      seq: events.at(-1)?.seq ?? 0,
      ...(steps.length > 0 ? { step: steps.at(-1)!.body } : {}),
      commands: events.filter((event) => event.kind === "command").map((
        event,
      ) => event.body),
      ...(row.result_json !== null
        ? { result: JSON.parse(row.result_json) }
        : {}),
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
      ...(row.report_json !== null
        ? { report: JSON.parse(row.report_json) }
        : {}),
      ...(row.cancel_requested_at !== null
        ? { cancelRequestedAt: row.cancel_requested_at }
        : {}),
      createdAt: row.created_at,
      ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
      ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    };
  }
}

/** Helper for reads, which decodes one event row. */
const eventOf = (row: EventRow): LocalJobEvent => ({
  seq: row.seq,
  at: row.at,
  kind: row.kind,
  body: JSON.parse(row.body_json),
});
