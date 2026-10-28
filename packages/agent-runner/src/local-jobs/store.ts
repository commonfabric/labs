/**
 * The durable store of the runner's local jobs: one SQLite file the runner
 * alone writes, holding each job's request, state, result and the ordered
 * events a caller watches it by.
 *
 * A job moves `queued` → `running` → one of `completed`, `failed`,
 * `cancelled`, `interrupted`. Every move, and everything a job reports while
 * it runs, is appended as an event with the next `seq` for that job, in the
 * same transaction as the move, so a caller that has read up to `seq` and
 * asks for what follows misses nothing. Messages wait on the conversation's
 * newest job, are delivered at a turn boundary, or open or move to its
 * follow-up when it ends with a recorded run. Pending messages receive their
 * outcome before the terminal event, which is always the job's last event.
 *
 * A job found `running` when the store opens was cut off by a stop or a
 * crash. It is ended `interrupted` and never run again: a job may already
 * have changed things through its commands, and running it twice could do
 * them twice.
 */

import type { HarnessInlineImageAttachment } from "@commonfabric/cf-harness/contracts/image";
import type { HarnessRunDepth } from "@commonfabric/cf-harness/contracts/run-depth";
import type { HarnessModelLimits } from "@commonfabric/cf-harness/model/client";
import type {
  HarnessTaskDomain,
  HarnessTaskTag,
} from "@commonfabric/cf-harness/task-classification";
import { hashStringOf } from "@commonfabric/data-model";
import { Database } from "@db/sqlite";

import type { ReasoningEffort } from "./profiles.ts";

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
  resultSchema?: unknown;
  tools?: string[];
  maxModelTurns?: number;
  imageAttachments?: HarnessInlineImageAttachment[];

  /** A person is waiting: ordered first and eligible for the reserved slot. */
  interactive?: boolean;

  /** How far the caller wants the job taken; the harness's default when absent. */
  depth?: HarnessRunDepth;

  /** The task's kinds of work, in place of the harness's classification. */
  tags?: HarnessTaskTag[];

  /** Where the task's work happens, in place of the harness's; `[]` is none. */
  domains?: HarnessTaskDomain[];

  /**
   * The reasoning effort the job runs at, no more than its profile's; the
   * profile's when absent.
   */
  reasoningEffort?: ReasoningEffort;

  /**
   * The caller can host the job's browser. Its contents are not read yet;
   * declaring it is what counts, as on the console's task route.
   */
  browserHost?: Record<string, unknown>;

  /**
   * Pieces the job holds from its first turn, by the name the model sees:
   * each address becomes an input cell, and the model a handle to it. Only a
   * profile with a fabric session holds them, and only pieces in its space.
   */
  inputs?: Record<string, string>;

  /**
   * Where each space an input names outside the profile's own is served: a
   * space DID mapped to its toolshed's origin. The job is routed there for
   * that space and nowhere else.
   */
  foreignSpaces?: Record<string, string>;
}

/** One event of a job, in `seq` order. */
export interface LocalJobEvent {
  seq: number;
  at: string;
  kind: string;
  body: Record<string, unknown>;
}

/** Attachment fields shared by enqueue and follow-up messages. */
export type LocalJobAttachments = Pick<
  LocalJobRequest,
  "imageAttachments" | "inputs" | "foreignSpaces"
>;

/** A caller's message, with its current delivery outcome. */
export interface LocalJobMessage extends LocalJobAttachments {
  key: string;
  target: string;
  message: string;
  instructions?: string;
  acceptedAt: string;
  delivery: "pending" | "delivered" | "follow-up" | "dropped";
  jobId: string;
  turn?: number;
  reason?: "cancelled" | "not_continuable" | "interrupted";
}

/** The body a caller sends to the message route. */
export interface LocalJobMessageRequest extends LocalJobAttachments {
  caller: string;
  idempotencyKey: string;
  message: string;
  instructions?: string;
}

/** A refusal to accept a message. */
export interface LocalJobMessageRefusal {
  code:
    | "not_found"
    | "not_callers"
    | "not_continuable"
    | "follow_up_only"
    | "beyond_profile"
    | "unknown_profile"
    | "idempotency_conflict";
  error: string;
}

/** A job as a caller reads it. */
export interface LocalJob {
  id: string;
  caller: string;
  profile: string;
  idempotencyKey: string;
  request: LocalJobRequest;
  state: LocalJobState;

  /** The predecessor whose recorded run this job continues. */
  continues?: string;

  /** This job's sole follow-up, once one has opened. */
  continuedBy?: string;

  /** The message that opened this follow-up. */
  openedBy?: LocalJobMessage;

  /** Current records of messages that waited on this job, in acceptance order. */
  messages: LocalJobMessage[];

  /** The `seq` of the job's latest event. */
  seq: number;

  /**
   * The tool the job is using, from its latest `step` event; `returned`
   * when that call has returned and its loop's model is working.
   */
  step?: Record<string, unknown>;

  /** Every command the job ran, from its `command` events, in order. */
  commands: Record<string, unknown>[];

  /** The job's validated result or final text, once it completed. */
  result?: unknown;

  errorCode?: string;

  /** What the run said of its error, from the job's final `state` event. */
  errorDetail?: string;

  /** Usage, turns and tool calls, once the job ran. */
  report?: Record<string, unknown>;

  cancelRequestedAt?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** The ending a running job is given. */
export interface LocalJobEnding {
  /** Whether the run left a complete checkpoint a follow-up can use. */
  recordedRun?: boolean;

  state: "completed" | "failed" | "cancelled" | "interrupted";
  result?: unknown;
  errorCode?: string;
  errorDetail?: string;
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
  continues TEXT REFERENCES jobs (id),
  recorded_run INTEGER NOT NULL DEFAULT 0,
  run_root TEXT,
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
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY,
  caller TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  target TEXT NOT NULL REFERENCES jobs (id),
  message TEXT NOT NULL,
  instructions TEXT,
  attachments_json TEXT NOT NULL DEFAULT '{}',
  accepted_at TEXT NOT NULL,
  holder TEXT NOT NULL REFERENCES jobs (id),
  delivery TEXT NOT NULL,
  turn INTEGER,
  reason TEXT,
  opened_job TEXT REFERENCES jobs (id),
  after_cancel INTEGER NOT NULL DEFAULT 0,
  UNIQUE (caller, idempotency_key)
);
CREATE INDEX IF NOT EXISTS messages_holder ON messages (holder, delivery, seq);
CREATE UNIQUE INDEX IF NOT EXISTS messages_opened_job ON messages (opened_job);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, created_at);
`;

/** A `jobs` row as SQLite returns it. */
interface JobRow {
  continues: string | null;
  recorded_run: number;
  run_root: string | null;
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

/** A message row as SQLite returns it. */
interface MessageRow {
  seq: number;
  caller: string;
  idempotency_key: string;
  target: string;
  message: string;
  instructions: string | null;
  attachments_json: string;
  accepted_at: string;
  holder: string;
  delivery: LocalJobMessage["delivery"];
  turn: number | null;
  reason: LocalJobMessage["reason"] | null;
  opened_job: string | null;
  after_cancel: number;
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
  #appended: [string, LocalJobEvent][] = [];
  #notifications: [string, LocalJobEvent][] = [];
  #notifying = false;
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

  //
  // Instance members
  //

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
    const result = this.#write(() => {
      const conflict = {
        conflict:
          `The idempotency key \`${idempotencyKey}\` already names a different request.`,
      };
      if (this.#messageRow(caller, idempotencyKey) !== undefined) {
        return conflict;
      }
      const existing = this.#database.prepare(`
        SELECT * FROM jobs WHERE caller = :caller AND idempotency_key = :key
      `).get({ caller, key: idempotencyKey }) as JobRow | undefined;
      if (existing !== undefined) {
        if (
          existing.profile !== profile ||
          hashStringOf(JSON.parse(existing.request_json)) !==
            hashStringOf(JSON.parse(JSON.stringify(request)))
        ) return conflict;
        return { id: existing.id, created: false };
      }
      return {
        id: this.#insert(
          caller,
          profile,
          idempotencyKey,
          request,
          this.#now().toISOString(),
        ),
        created: true,
      };
    });
    return "conflict" in result
      ? result
      : { job: this.get(result.id)!, created: result.created };
  }

  /** Names the first and current jobs, visiting each conversation link once. */
  conversation(id: string): { root: LocalJob; head: LocalJob } | undefined {
    const target = this.#row(id);
    if (target === undefined) return undefined;
    let root = target;
    while (root.continues !== null) {
      const prior = this.#row(root.continues);
      if (prior === undefined) {
        throw new Error("Cannot find the conversation's predecessor job.");
      }
      root = prior;
    }
    let head = target;
    for (;;) {
      const next = this.#database.prepare(
        "SELECT * FROM jobs WHERE continues = :id",
      ).get({ id: head.id }) as JobRow | undefined;
      if (next === undefined) break;
      head = next;
    }
    return { root: this.#view(root), head: this.#view(head) };
  }

  /** Records the harness artifact root while its job is running. */
  recordRunRoot(id: string, runRoot: string): void {
    this.#database.prepare(
      "UPDATE jobs SET run_root = :runRoot WHERE id = :id AND state = 'running'",
    ).run({ id, runRoot });
  }

  /** The runs whose durable checkpoints recovery must inspect. */
  runningRuns(): { id: string; runRoot?: string }[] {
    const rows = this.#database.prepare(
      "SELECT id, run_root FROM jobs WHERE state = 'running'",
    ).all() as { id: string; run_root: string | null }[];
    return rows.map((row) => ({
      id: row.id,
      ...(row.run_root === null ? {} : { runRoot: row.run_root }),
    }));
  }

  /**
   * Accepts or replays a caller's message in conversation order. Replay is
   * resolved before the head or its state; only a new follow-up checks the
   * host's profile availability.
   */
  acceptMessage(
    target: string,
    request: LocalJobMessageRequest,
    options: {
      validateFollowUp?: (
        profile: string,
        request: LocalJobRequest,
      ) => LocalJobMessageRefusal | undefined;
    } = {},
  ):
    | { message: LocalJobMessage; job: LocalJob; created: boolean }
    | LocalJobMessageRefusal {
    const attachments = JSON.stringify({
      imageAttachments: request.imageAttachments,
      inputs: request.inputs,
      foreignSpaces: request.foreignSpaces,
    });
    const hasAttachments = attachments !== "{}";
    const result = this.#write(
      (): { created: boolean } | LocalJobMessageRefusal => {
        const { caller, idempotencyKey: key, message, instructions } = request;
        const conflict: LocalJobMessageRefusal = {
          code: "idempotency_conflict",
          error: "The key already names another request.",
        };
        const existing = this.#messageRow(caller, key);
        if (existing !== undefined) {
          return existing.target === target && existing.message === message &&
              existing.instructions === (instructions ?? null) &&
              hashStringOf(JSON.parse(existing.attachments_json)) ===
                hashStringOf(JSON.parse(attachments))
            ? { created: false }
            : conflict;
        }
        if (
          this.#database.prepare(
            "SELECT id FROM jobs WHERE caller = :caller AND idempotency_key = :key",
          ).get({ caller, key }) !== undefined
        ) return conflict;
        const targetRow = this.#row(target);
        if (targetRow === undefined) {
          return { code: "not_found", error: "No such job." };
        }
        if (targetRow.caller !== caller) {
          return {
            code: "not_callers",
            error: "The job belongs to another caller.",
          };
        }
        const head = this.#row(this.conversation(target)!.head.id)!;
        const finished = LOCAL_JOB_TERMINAL_STATES.has(head.state);
        if (
          finished && head.recorded_run === 0
        ) {
          return {
            code: "not_continuable",
            error: "The head has no recorded run to continue.",
          };
        }
        if (!finished && head.cancel_requested_at === null) {
          if (instructions !== undefined || hasAttachments) {
            return {
              code: "follow_up_only",
              error: "Instructions and attachments require a follow-up.",
            };
          }
        }
        if (finished || hasAttachments) {
          const refusal = options.validateFollowUp?.(
            head.profile,
            localJobRunRequestOf(
              followUpRequestOf(JSON.parse(head.request_json), request),
              request,
            ),
          );
          if (refusal !== undefined) return refusal;
        }
        const at = this.#now().toISOString();
        this.#database.prepare(`
        INSERT INTO messages (caller, idempotency_key, target, message, instructions, attachments_json,
          accepted_at, holder, delivery, after_cancel)
        VALUES (:caller, :key, :target, :message, :instructions, :attachments, :at, :holder, 'pending', :after)
      `).run({
            caller,
            key,
            target,
            message,
            instructions: instructions ?? null,
            attachments,
            at,
            holder: head.id,
            after: head.cancel_requested_at === null ? 0 : 1,
          });
        if (finished) {
          this.#openFollowUp(head, this.#messageRow(caller, key)!, at);
        } else {
          this.#append(
            head.id,
            "message",
            { key, delivery: "pending" },
            at,
          );
        }
        return { created: true };
      },
    );
    if ("code" in result) return result;
    const message = messageOf(
      this.#messageRow(request.caller, request.idempotencyKey)!,
    );
    return { message, job: this.get(message.jobId)!, created: result.created };
  }

  /** Takes the answerable prefix of waiting messages for a running turn. */
  takeMessages(id: string, turn: number): string[] {
    return this.#write(() => {
      if (this.#row(id)?.state !== "running") return [];
      const taken: string[] = [];
      for (const row of this.#waiting(id)) {
        if (
          row.instructions !== null || row.attachments_json !== "{}" ||
          row.after_cancel !== 0
        ) break;
        this.#database.prepare(
          "UPDATE messages SET delivery = 'delivered', turn = :turn WHERE seq = :seq",
        ).run({ turn, seq: row.seq });
        this.#append(id, "message", {
          key: row.idempotency_key,
          delivery: "delivered",
          turn,
        }, this.#now().toISOString());
        taken.push(row.message);
      }
      return taken;
    });
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
   * Appends a progress event a running job reports and
   * returns it; `undefined` when the job is not running.
   */
  report(
    id: string,
    kind: "step" | "command" | "text" | "usage",
    body: Record<string, unknown>,
  ): LocalJobEvent | undefined {
    const appended = this.#write(() => {
      const row = this.#row(id);
      if (row?.state !== "running") return [];
      return [this.#append(id, kind, body, this.#now().toISOString())];
    });
    return appended[0];
  }

  /**
   * Asks for job `id` to stop. A queued job ends `cancelled` at once; a
   * running one is marked, and ends when its run stops. Returns the job, or
   * `undefined` when there is none.
   */
  requestCancel(id: string): LocalJob | undefined {
    const at = this.#now().toISOString();
    this.#write(() => {
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
        this.#settleMessages(row, "cancelled", false, at);
        return [this.#append(id, "state", { state: "cancelled" }, at)];
      }
      this.#database.prepare(
        "UPDATE jobs SET cancel_requested_at = :at WHERE id = :id",
      ).run({ id, at });
      return [this.#append(id, "cancel", { requestedAt: at }, at)];
    });
    return this.get(id);
  }

  /**
   * Moves a queued job to `running`, interactive first and oldest within
   * each class. `interactiveOnly` holds background jobs in the queue.
   */
  claimNext(interactiveOnly = false): LocalJob | undefined {
    const at = this.#now().toISOString();
    let claimed: string | undefined;
    this.#write(() => {
      const row = this.#database.prepare(`
        SELECT id FROM jobs WHERE state = 'queued'
          AND (:interactive_only = 0 OR json_extract(request_json, '$.interactive') = 1)
        ORDER BY COALESCE(json_extract(request_json, '$.interactive'), 0) DESC,
          created_at, rowid LIMIT 1
      `).get({ interactive_only: interactiveOnly ? 1 : 0 }) as
        | { id: string }
        | undefined;
      if (row === undefined) return [];
      claimed = row.id;
      this.#database.prepare(`
        UPDATE jobs SET state = 'running', started_at = :at,
          attempt = attempt + 1 WHERE id = :id
      `).run({ id: row.id, at });
      return [this.#append(row.id, "state", { state: "running" }, at)];
    });
    if (claimed === undefined) return undefined;
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
      const recorded = ending.recordedRun === true;
      this.#database.prepare(`
        UPDATE jobs SET state = :state, result_json = :result,
          error_code = :error_code, report_json = :report, finished_at = :at, recorded_run = :recorded
        WHERE id = :id
      `).run({
        id,
        state,
        recorded: recorded ? 1 : 0,
        result: completed ? JSON.stringify(ending.result ?? null) : null,
        error_code: completed || state === "cancelled"
          ? null
          : ending.errorCode ?? null,
        report: ending.report === undefined
          ? null
          : JSON.stringify(ending.report),
        at,
      });
      this.#settleMessages(row, state, recorded, at);
      return [this.#append(
        id,
        "state",
        {
          state,
          ...(!completed && state !== "cancelled"
            ? {
              ...(ending.errorCode !== undefined
                ? { errorCode: ending.errorCode }
                : {}),
              ...(ending.errorDetail !== undefined
                ? { errorDetail: ending.errorDetail }
                : {}),
            }
            : {}),
        },
        at,
      )];
    });
    if (appended.length === 0) return undefined;
    return this.get(id);
  }

  /**
   * Ends every job found `running` as `interrupted`, with `RUNNER_RESTARTED`,
   * and returns their ids. `continuable` names runs whose artifacts the lane
   * checked; their waiting messages can open follow-ups in this transaction.
   * The runner calls it once, before it claims anything.
   */
  recover(continuable: ReadonlySet<string> = new Set()): string[] {
    const at = this.#now().toISOString();
    const ids: string[] = [];
    this.#write(() => {
      const rows = this.#database.prepare(
        "SELECT * FROM jobs WHERE state = 'running'",
      ).all() as JobRow[];
      return rows.map((row) => {
        const { id } = row;
        ids.push(id);
        this.#database.prepare(`
          UPDATE jobs SET state = 'interrupted', error_code = :code, recorded_run = :recorded,
            report_json = :report, finished_at = :at WHERE id = :id
        `).run({
          id,
          code: RUNNER_RESTARTED,
          at,
          recorded: continuable.has(id) ? 1 : 0,
          report: row.run_root === null ? row.report_json : JSON.stringify({
            ...(row.report_json === null ? {} : JSON.parse(row.report_json)),
            runRef: row.run_root,
          }),
        });
        this.#settleMessages(row, "interrupted", continuable.has(id), at);
        return this.#append(
          id,
          "state",
          { state: "interrupted", errorCode: RUNNER_RESTARTED },
          at,
        );
      });
    });
    return ids;
  }

  /** Inserts an enqueue or a follow-up with its initial state event. */
  #insert(
    caller: string,
    profile: string,
    key: string,
    request: LocalJobRequest,
    at: string,
    continues?: string,
  ): string {
    const id = this.#newId();
    this.#database.prepare(
      `INSERT INTO jobs (id, caller, profile, idempotency_key,
      request_json, state, created_at, continues)
      VALUES (:id, :caller, :profile, :key, :request, 'queued', :at, :continues)`,
    )
      .run({
        id,
        caller,
        profile,
        key,
        request: JSON.stringify(request),
        at,
        continues: continues ?? null,
      });
    this.#append(id, "state", { state: "queued" }, at);
    return id;
  }

  /** Reads a message by its caller's key inside a transaction. */
  #messageRow(caller: string, key: string): MessageRow | undefined {
    return this.#database.prepare(
      "SELECT * FROM messages WHERE caller = :caller AND idempotency_key = :key",
    ).get({ caller, key }) as MessageRow | undefined;
  }

  /** Reads a holder's waiting messages in acceptance order. */
  #waiting(id: string): MessageRow[] {
    return this.#database.prepare(
      "SELECT * FROM messages WHERE holder = :id AND delivery = 'pending' ORDER BY seq",
    ).all({ id }) as MessageRow[];
  }

  /** Opens the sole follow-up and records the message that opened it. */
  #openFollowUp(head: JobRow, message: MessageRow, at: string): string {
    const request: LocalJobRequest = JSON.parse(head.request_json);
    const id = this.#insert(
      head.caller,
      head.profile,
      message.idempotency_key,
      followUpRequestOf(request, messageOf(message)),
      at,
      head.id,
    );
    this.#database.prepare(
      "UPDATE messages SET holder = :id, opened_job = :id, delivery = 'follow-up', after_cancel = 0 WHERE seq = :seq",
    ).run({ id, seq: message.seq });
    return id;
  }

  /** Gives waiting messages their outcome before the holder's terminal event. */
  #settleMessages(
    row: JobRow,
    state: LocalJobState,
    recorded: boolean,
    at: string,
  ): void {
    let followUp: string | undefined;
    for (const message of this.#waiting(row.id)) {
      const reason = state === "cancelled" && message.after_cancel === 0
        ? "cancelled"
        : !recorded
        ? state === "interrupted" ? "interrupted" : "not_continuable"
        : undefined;
      const key = message.idempotency_key;
      if (reason !== undefined) {
        this.#database.prepare(
          "UPDATE messages SET delivery = 'dropped', reason = :reason WHERE seq = :seq",
        ).run({ reason, seq: message.seq });
        this.#append(
          row.id,
          "message",
          { key, delivery: "dropped", reason },
          at,
        );
      } else if (followUp === undefined) {
        followUp = this.#openFollowUp(row, message, at);
        this.#append(row.id, "message", {
          key,
          delivery: "follow-up",
          jobId: followUp,
        }, at);
      } else {
        this.#database.prepare(
          "UPDATE messages SET holder = :id, after_cancel = 0 WHERE seq = :seq",
        ).run({ id: followUp, seq: message.seq });
        this.#append(row.id, "message", {
          key,
          delivery: "moved",
          jobId: followUp,
        }, at);
        this.#append(followUp, "message", { key, delivery: "pending" }, at);
      }
    }
  }

  /** Helper for writes, which runs `body` in one immediate transaction. */
  #write<T>(body: () => T): T {
    this.#appended = [];
    let result: T;
    try {
      result = this.#database.transaction(body).immediate();
      for (const event of this.#appended) this.#notifications.push(event);
    } finally {
      this.#appended = [];
    }
    if (!this.#notifying) {
      this.#notifying = true;
      try {
        while (this.#notifications.length) {
          const [id, event] = this.#notifications.shift()!;
          this.#notify(id, [event]);
        }
      } finally {
        this.#notifying = false;
      }
    }
    return result;
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
    const event = { seq, at, kind, body };
    this.#appended.push([id, event]);
    return event;
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
    const continuedBy = this.#database.prepare(
      "SELECT id FROM jobs WHERE continues = :id",
    ).get({ id: row.id }) as { id: string } | undefined;
    const openedBy = this.#database.prepare(
      "SELECT * FROM messages WHERE opened_job = :id",
    ).get({ id: row.id }) as MessageRow | undefined;
    const messages = this.#database.prepare(`
      SELECT m.* FROM job_events e JOIN messages m
        ON m.caller = :caller
        AND m.idempotency_key = json_extract(e.body_json, '$.key')
      WHERE e.job_id = :id AND e.kind = 'message'
        AND json_extract(e.body_json, '$.delivery') = 'pending'
      ORDER BY m.seq
    `).all({ caller: row.caller, id: row.id }) as MessageRow[];
    const steps = events.filter((event) => event.kind === "step");
    const errorDetail = events.findLast((event) => event.kind === "state")
      ?.body.errorDetail;
    return {
      id: row.id,
      caller: row.caller,
      profile: row.profile,
      idempotencyKey: row.idempotency_key,
      request: JSON.parse(row.request_json),
      state: row.state,
      ...(row.continues !== null ? { continues: row.continues } : {}),
      ...(continuedBy !== undefined ? { continuedBy: continuedBy.id } : {}),
      ...(openedBy !== undefined ? { openedBy: messageOf(openedBy) } : {}),
      messages: messages.map(messageOf),
      seq: events.at(-1)?.seq ?? 0,
      ...(steps.length > 0 ? { step: steps.at(-1)!.body } : {}),
      commands: events.filter((event) => event.kind === "command").map((
        event,
      ) => event.body),
      ...(row.result_json !== null
        ? { result: JSON.parse(row.result_json) }
        : {}),
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
      ...(typeof errorDetail === "string" ? { errorDetail } : {}),
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

  //
  // Static members
  //

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
      for (
        const [table, additions] of [
          ["jobs", [["continues", "TEXT REFERENCES jobs (id)"], [
            "recorded_run",
            "INTEGER NOT NULL DEFAULT 0",
          ], ["run_root", "TEXT"]]],
          ["messages", [["attachments_json", "TEXT NOT NULL DEFAULT '{}'"]]],
        ] as const
      ) {
        const columns = database.prepare(`PRAGMA table_info(${table})`)
          .all() as { name: string }[];
        for (const [name, declaration] of additions) {
          if (!columns.some((column) => column.name === name)) {
            database.exec(
              `ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`,
            );
          }
        }
      }
      database.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS jobs_continues ON jobs (continues)",
      );
    } catch (error) {
      database.close();
      throw error;
    }
    return new LocalJobStore(database, options);
  }
}

/** Helper for reads, which decodes one event row. */
const eventOf = (row: EventRow): LocalJobEvent => ({
  seq: row.seq,
  at: row.at,
  kind: row.kind,
  body: JSON.parse(row.body_json),
});

/** Decodes the current public record of a message. */
const messageOf = (row: MessageRow): LocalJobMessage => ({
  key: row.idempotency_key,
  target: row.target,
  message: row.message,
  ...(row.instructions !== null ? { instructions: row.instructions } : {}),
  ...JSON.parse(row.attachments_json),
  acceptedAt: row.accepted_at,
  delivery: row.delivery,
  jobId: row.holder,
  ...(row.turn !== null ? { turn: row.turn } : {}),
  ...(row.reason !== null ? { reason: row.reason } : {}),
});

/**
 * Adds the opening message's inputs and routes to the conversation's retained
 * request.
 */
const followUpRequestOf = (
  request: LocalJobRequest,
  message: Pick<
    LocalJobMessageRequest,
    "message" | "instructions" | keyof LocalJobAttachments
  >,
): LocalJobRequest => ({
  ...request,
  task: message.message,
  ...(message.instructions === undefined
    ? {}
    : { instructions: message.instructions }),
  ...(message.imageAttachments === undefined
    ? {}
    : { imageAttachments: message.imageAttachments }),
  ...(message.inputs === undefined
    ? {}
    : { inputs: { ...request.inputs, ...message.inputs } }),
  ...(message.foreignSpaces === undefined ? {} : {
    foreignSpaces: { ...request.foreignSpaces, ...message.foreignSpaces },
  }),
});

/** Selects this run's attachments, retaining the request's other bounds. */
export const localJobRunRequestOf = (
  request: LocalJobRequest,
  attachments: LocalJobAttachments | undefined,
): LocalJobRequest => ({
  ...request,
  imageAttachments: attachments?.imageAttachments,
  inputs: attachments?.inputs,
  foreignSpaces: attachments?.foreignSpaces,
});
