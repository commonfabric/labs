import { fromFileUrl } from "@std/path";

import { Database } from "@db/sqlite";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  type HarnessChatBrowserAccessLease,
  type HarnessChatContext,
  type HarnessChatEventEnvelope,
  type HarnessChatPolicy,
  type HarnessChatSessionStatus,
  type HarnessChatTurnInput,
  type HarnessChatTurnRecord,
  type HarnessChatTurnStatus,
} from "./contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import type { HarnessAssignedPiece } from "./contracts/assigned-piece.ts";
import {
  createHarnessTranscriptOmissions,
  isHarnessTranscriptOmissions,
  restoreHarnessTranscriptOmissions,
} from "./contracts/transcript-omissions.ts";
import {
  type HarnessChatEventListOptions,
  type HarnessChatResearchContext,
  type HarnessChatSessionSnapshot,
  type HarnessChatSessionStore,
  type HarnessChatSessionTurnEventMutation,
  HarnessChatStoreAliasedError,
  HarnessChatStoreHeldError,
  type HarnessChatStoreHolder,
  type HarnessChatTurnListOptions,
} from "./session-store.ts";

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`;

const INIT = `
CREATE TABLE IF NOT EXISTS chat_session (
  session_id  TEXT NOT NULL PRIMARY KEY,
  status      TEXT NOT NULL,
  transcript  TEXT NOT NULL,
  research_context TEXT,
  assigned_pieces TEXT,
  transcript_omissions TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_session_updated_at
  ON chat_session (updated_at);

CREATE TABLE IF NOT EXISTS chat_turn (
  session_id      TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  turn            TEXT NOT NULL,
  input           TEXT NOT NULL,
  context         TEXT,
  policy          TEXT NOT NULL,
  browser_access  TEXT,
  metadata        TEXT,
  started_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  ended_at        TEXT,
  cancel_reason   TEXT,
  error           TEXT,
  PRIMARY KEY (session_id, turn_id),
  FOREIGN KEY (session_id) REFERENCES chat_session(session_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_turn_session_status_updated
  ON chat_turn (session_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_turn_updated_at
  ON chat_turn (updated_at);

CREATE TABLE IF NOT EXISTS chat_event (
  sequence    INTEGER NOT NULL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  turn_id     TEXT,
  kind        TEXT NOT NULL,
  emitted_at  TEXT NOT NULL,
  event       TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_session(session_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_event_session_sequence
  ON chat_event (session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_chat_event_emitted_at
  ON chat_event (emitted_at);

`;

type SessionRow = {
  status: string;
  transcript: string;
  research_context: string | null;
  assigned_pieces: string | null;
  transcript_omissions: string | null;
};

type EventRow = {
  event: string;
};

type TurnRow = {
  session_id: string;
  turn: string;
  input: string;
  context: string | null;
  policy: string;
  browser_access: string | null;
  metadata: string | null;
};

export interface OpenSqliteHarnessChatSessionStoreOptions {
  url: URL;

  /**
   * The record written beside the database for whoever is refused it. One
   * naming this process is minted when none is given.
   */
  holder?: HarnessChatStoreHolder;
}

const databaseAddress = (url: URL): URL => {
  if (url.protocol !== "file:") {
    throw new Error(
      `unsupported SQLite chat session store URL protocol: ${url.protocol}; expected file:`,
    );
  }
  return url;
};

const parseJsonColumn = <Value>(
  value: string,
  column: string,
): Value => {
  try {
    return JSON.parse(value) as Value;
  } catch (error) {
    throw new Error(
      `failed to parse ${column}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const parseNullableJsonColumn = <Value>(
  value: string | null,
  column: string,
): Value | undefined =>
  value === null ? undefined : parseJsonColumn<Value>(value, column);

/** Suffix of the file beside a database that carries its hold. */
const HOLDER_FILE_SUFFIX = "-holder";

/**
 * Returns the path of the file carrying the hold on the database at `url`,
 * which must exist. The database path is resolved through every link first,
 * so two spellings of one database name one hold file rather than one each.
 */
export const sqliteHarnessChatSessionStoreHolderPath = async (
  url: URL,
): Promise<string> => `${await resolvedDatabasePath(url)}${HOLDER_FILE_SUFFIX}`;

/** Returns the path of the database at `url`, resolved through every link. */
const resolvedDatabasePath = (url: URL): Promise<string> =>
  Deno.realPath(fromFileUrl(databaseAddress(url)));

const isStoreHolder = (value: unknown): value is HarnessChatStoreHolder => {
  if (!isObjectOrArray(value)) {
    return false;
  }
  const holder = value as Record<string, unknown>;
  return typeof holder.instanceId === "string" &&
    typeof holder.pid === "number" &&
    typeof holder.heldSince === "string";
};

/**
 * Reads the holder record at `path`, or `undefined` where what is there is
 * not one: the holder writes the record after taking the hold, so a reader
 * refused in that moment can find the file empty or half written.
 */
const readStoreHolder = async (
  path: string,
): Promise<HarnessChatStoreHolder | undefined> => {
  const text = await Deno.readTextFile(path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isStoreHolder(value) ? value : undefined;
};

const turnRowParams = (turn: HarnessChatTurnRecord) => ({
  session_id: turn.sessionId,
  turn_id: turn.turn.turnId,
  status: turn.turn.status,
  turn: JSON.stringify(turn.turn),
  input: JSON.stringify(turn.input),
  context: turn.context === undefined ? null : JSON.stringify(turn.context),
  policy: JSON.stringify(turn.policy),
  browser_access: turn.browserAccess === undefined
    ? null
    : JSON.stringify(turn.browserAccess),
  metadata: turn.metadata === undefined ? null : JSON.stringify(turn.metadata),
  started_at: turn.turn.startedAt,
  updated_at: turn.turn.updatedAt,
  ended_at: turn.turn.endedAt ?? null,
  cancel_reason: turn.turn.cancelReason ?? null,
  error: turn.turn.error === undefined ? null : JSON.stringify(turn.turn.error),
});

export class SqliteHarnessChatSessionStore implements HarnessChatSessionStore {
  readonly database: Database;

  #holderFile?: Deno.FsFile;

  /**
   * Constructs a store over `database`. `holderFile` is the handle whose
   * lock is the hold on the database, released when the store closes; a
   * store without one belongs to this process alone.
   */
  constructor(database: Database, holderFile?: Deno.FsFile) {
    this.database = database;
    this.#holderFile = holderFile;
  }

  saveSession(snapshot: HarnessChatSessionSnapshot): void {
    this.database.prepare(`
      INSERT INTO chat_session (
        session_id,
        status,
        transcript,
        research_context,
        assigned_pieces,
        transcript_omissions,
        created_at,
        updated_at,
        closed_at
      )
      VALUES (
        :session_id,
        :status,
        :transcript,
        :research_context,
        :assigned_pieces,
        :transcript_omissions,
        :created_at,
        :updated_at,
        :closed_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
        status = :status,
        transcript = :transcript,
        research_context = :research_context,
        assigned_pieces = :assigned_pieces,
        transcript_omissions = :transcript_omissions,
        updated_at = :updated_at,
        closed_at = :closed_at
    `).run({
      session_id: snapshot.session.sessionId,
      status: JSON.stringify(snapshot.session),
      transcript: JSON.stringify(snapshot.transcript),
      transcript_omissions: JSON.stringify(
        createHarnessTranscriptOmissions(snapshot.transcript),
      ),
      research_context: snapshot.researchContext === undefined
        ? null
        : JSON.stringify(snapshot.researchContext),
      assigned_pieces: snapshot.assignedPieces === undefined
        ? null
        : JSON.stringify(snapshot.assignedPieces),
      created_at: snapshot.session.createdAt,
      updated_at: snapshot.session.updatedAt,
      closed_at: snapshot.session.closedAt ?? null,
    });
  }

  getSession(
    sessionId: string,
  ): HarnessChatSessionSnapshot | undefined {
    const row = this.database.prepare(`
      SELECT status, transcript, research_context, assigned_pieces, transcript_omissions
      FROM chat_session
      WHERE session_id = :session_id
    `).get({ session_id: sessionId }) as SessionRow | undefined;
    return row === undefined ? undefined : decodeSessionRow(row);
  }

  listSessions(): readonly HarnessChatSessionSnapshot[] {
    return (this.database.prepare(`
      SELECT status, transcript, research_context, assigned_pieces, transcript_omissions
      FROM chat_session
      ORDER BY created_at ASC, session_id ASC
    `).all() as SessionRow[]).map(decodeSessionRow);
  }

  saveSessionAndAppendEvent(
    snapshot: HarnessChatSessionSnapshot,
    event: HarnessChatEventEnvelope,
  ): void {
    this.database.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      this.saveSession(snapshot);
      this.appendEvent(event);
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  }

  saveSessionTurnAndAppendEvent(
    mutation: HarnessChatSessionTurnEventMutation,
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      if (mutation.createTurn) {
        const inserted = this.insertTurn(mutation.turn);
        if (!inserted) {
          this.database.exec("ROLLBACK;");
          return false;
        }
      } else {
        this.saveTurn(mutation.turn);
      }
      this.saveSession(mutation.session);
      this.appendEvent(mutation.event);
      this.database.exec("COMMIT;");
      return true;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
  }

  insertTurn(turn: HarnessChatTurnRecord): boolean {
    return this.database.prepare(`
      INSERT OR IGNORE INTO chat_turn (
        session_id,
        turn_id,
        status,
        turn,
        input,
        context,
        policy,
        browser_access,
        metadata,
        started_at,
        updated_at,
        ended_at,
        cancel_reason,
        error
      )
      VALUES (
        :session_id,
        :turn_id,
        :status,
        :turn,
        :input,
        :context,
        :policy,
        :browser_access,
        :metadata,
        :started_at,
        :updated_at,
        :ended_at,
        :cancel_reason,
        :error
      )
    `).run(turnRowParams(turn)) > 0;
  }

  saveTurn(turn: HarnessChatTurnRecord): void {
    this.database.prepare(`
      INSERT INTO chat_turn (
        session_id,
        turn_id,
        status,
        turn,
        input,
        context,
        policy,
        browser_access,
        metadata,
        started_at,
        updated_at,
        ended_at,
        cancel_reason,
        error
      )
      VALUES (
        :session_id,
        :turn_id,
        :status,
        :turn,
        :input,
        :context,
        :policy,
        :browser_access,
        :metadata,
        :started_at,
        :updated_at,
        :ended_at,
        :cancel_reason,
        :error
      )
      ON CONFLICT(session_id, turn_id) DO UPDATE SET
        status = :status,
        turn = :turn,
        input = :input,
        context = :context,
        policy = :policy,
        browser_access = :browser_access,
        metadata = :metadata,
        updated_at = :updated_at,
        ended_at = :ended_at,
        cancel_reason = :cancel_reason,
        error = :error
    `).run(turnRowParams(turn));
  }

  getTurn(
    sessionId: string,
    turnId: string,
  ): HarnessChatTurnRecord | undefined {
    const row = this.database.prepare(`
      SELECT session_id, turn, input, context, policy, browser_access, metadata
      FROM chat_turn
      WHERE session_id = :session_id AND turn_id = :turn_id
    `).get({ session_id: sessionId, turn_id: turnId }) as TurnRow | undefined;
    return row === undefined ? undefined : decodeTurnRow(row);
  }

  listTurns(
    options: HarnessChatTurnListOptions = {},
  ): readonly HarnessChatTurnRecord[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (options.sessionId !== undefined) {
      clauses.push("session_id = :session_id");
      params.session_id = options.sessionId;
    }
    if (options.status !== undefined) {
      clauses.push("status = :status");
      params.status = options.status;
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.database.prepare(`
      SELECT session_id, turn, input, context, policy, browser_access, metadata
      FROM chat_turn
      ${where}
      ORDER BY started_at ASC, turn_id ASC
    `).all(params) as TurnRow[]).map(decodeTurnRow);
  }

  appendEvent(event: HarnessChatEventEnvelope): void {
    this.database.prepare(`
      INSERT INTO chat_event (
        sequence,
        session_id,
        turn_id,
        kind,
        emitted_at,
        event
      )
      VALUES (
        :sequence,
        :session_id,
        :turn_id,
        :kind,
        :emitted_at,
        :event
      )
    `).run({
      sequence: event.sequence,
      session_id: event.sessionId,
      turn_id: event.turnId ?? null,
      kind: event.event.kind,
      emitted_at: event.emittedAt,
      event: JSON.stringify(event),
    });
  }

  listEvents(
    options: HarnessChatEventListOptions = {},
  ): readonly HarnessChatEventEnvelope[] {
    const clauses: string[] = [];
    const params: Record<string, number | string> = {};
    if (options.sessionId !== undefined) {
      clauses.push("session_id = :session_id");
      params.session_id = options.sessionId;
    }
    if (options.afterSequence !== undefined) {
      clauses.push("sequence > :after_sequence");
      params.after_sequence = options.afterSequence;
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const limit = options.limit === undefined ? "" : "LIMIT :limit";
    if (options.limit !== undefined) {
      params.limit = options.limit;
    }
    return (this.database.prepare(`
      SELECT event
      FROM chat_event
      ${where}
      ORDER BY sequence ASC
      ${limit}
    `).all(params) as EventRow[]).map((row) =>
      parseJsonColumn<HarnessChatEventEnvelope>(row.event, "chat_event.event")
    );
  }

  latestSequence(): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM chat_event
    `).get() as { sequence: number };
    return row.sequence;
  }

  /**
   * Closes the database connection, then releases the hold, so no other
   * process can take the database while this one still has it open; a
   * connection that fails to close still releases it.
   */
  close(): void {
    try {
      this.database.close();
    } finally {
      this.#holderFile?.close();
      this.#holderFile = undefined;
    }
  }
}

const decodeSessionRow = (row: SessionRow): HarnessChatSessionSnapshot => {
  const transcript = parseJsonColumn<HarnessTranscriptMessage[]>(
    row.transcript,
    "chat_session.transcript",
  );
  if (row.transcript_omissions != null) {
    const omissions = parseJsonColumn<unknown>(
      row.transcript_omissions,
      "chat_session.transcript_omissions",
    );
    if (!isHarnessTranscriptOmissions(omissions)) {
      throw new Error("Stored transcript omissions have an invalid format");
    }
    restoreHarnessTranscriptOmissions(transcript, omissions);
  }
  return {
    ...(row.research_context == null ? {} : {
      researchContext: parseJsonColumn<HarnessChatResearchContext>(
        row.research_context,
        "chat_session.research_context",
      ),
    }),
    ...(row.assigned_pieces == null ? {} : {
      assignedPieces: parseJsonColumn<HarnessAssignedPiece[]>(
        row.assigned_pieces,
        "chat_session.assigned_pieces",
      ),
    }),
    session: parseJsonColumn<HarnessChatSessionStatus>(
      row.status,
      "chat_session.status",
    ),
    transcript,
  };
};

const decodeTurnRow = (row: TurnRow): HarnessChatTurnRecord => {
  const context = parseNullableJsonColumn<HarnessChatContext>(
    row.context,
    "chat_turn.context",
  );
  const browserAccess = parseNullableJsonColumn<HarnessChatBrowserAccessLease>(
    row.browser_access,
    "chat_turn.browser_access",
  );
  const metadata = parseNullableJsonColumn<Record<string, unknown>>(
    row.metadata,
    "chat_turn.metadata",
  );
  return {
    sessionId: row.session_id,
    turn: parseJsonColumn<HarnessChatTurnStatus>(row.turn, "chat_turn.turn"),
    input: parseJsonColumn<HarnessChatTurnInput>(row.input, "chat_turn.input"),
    policy: parseJsonColumn<HarnessChatPolicy>(row.policy, "chat_turn.policy"),
    ...(context !== undefined ? { context } : {}),
    ...(browserAccess !== undefined ? { browserAccess } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
};

/**
 * Opens the database at `options.url` and holds it for this process until the
 * store closes, creating the database and its schema when they are absent.
 * The hold is an exclusive advisory lock on a file beside the database, taken
 * before the database is connected: one that another live process holds is
 * refused with a `HarnessChatStoreHeldError` naming that holder, and nothing
 * has touched it. The operating system releases the lock with the handle, so
 * a holder that exits without closing releases it just the same, and a hold
 * is never stale while it is held. A hold is also the only evidence of a
 * holder: a process that opened the database without taking one leaves no
 * trace here, and its database reads as unheld. A database with more than
 * one name (hard links) is refused under every name with a
 * `HarnessChatStoreAliasedError`, since a hold beside one name is not seen
 * from another.
 */
export const openSqliteHarnessChatSessionStore = async (
  options: OpenSqliteHarnessChatSessionStoreOptions,
): Promise<SqliteHarnessChatSessionStore> => {
  const address = databaseAddress(options.url);
  // The hold file is named by the database's resolved path, so the database
  // has to exist first; to SQLite an empty file is an empty database.
  (await Deno.open(fromFileUrl(address), { write: true, create: true }))
    .close();
  const store = await resolvedDatabasePath(address);
  // A hard link is a second name the resolution cannot see, and a hold
  // beside one name would not be seen from the other.
  const names = (await Deno.stat(store)).nlink ?? 1;
  if (names > 1) {
    throw new HarnessChatStoreAliasedError(store, names);
  }
  const holderPath = `${store}${HOLDER_FILE_SUFFIX}`;
  const holderFile = await Deno.open(holderPath, {
    read: true,
    write: true,
    create: true,
  });
  try {
    if (!(await holderFile.tryLock(true))) {
      throw new HarnessChatStoreHeldError(
        store,
        await readStoreHolder(holderPath),
      );
    }
    // Written in place: the lock lives on this file's inode, so a record
    // renamed over it would leave later openers locking a file nobody holds.
    await Deno.writeTextFile(
      holderPath,
      JSON.stringify(
        options.holder ?? {
          instanceId: crypto.randomUUID(),
          pid: Deno.pid,
          heldSince: new Date().toISOString(),
        },
      ),
    );
    const database = await new Database(address, {
      create: true,
    });
    try {
      database.exec(PRAGMAS);
      database.transaction(() => {
        database.exec(INIT);
        const columns = database.prepare("PRAGMA table_info(chat_session)")
          .all() as {
            name: string;
          }[];
        if (!columns.some((column) => column.name === "research_context")) {
          database.exec(
            "ALTER TABLE chat_session ADD COLUMN research_context TEXT",
          );
        }
        if (!columns.some((column) => column.name === "assigned_pieces")) {
          database.exec(
            "ALTER TABLE chat_session ADD COLUMN assigned_pieces TEXT",
          );
        }
        if (!columns.some((column) => column.name === "transcript_omissions")) {
          database.exec(
            "ALTER TABLE chat_session ADD COLUMN transcript_omissions TEXT",
          );
        }
      }).immediate();
    } catch (error) {
      database.close();
      throw error;
    }
    return new SqliteHarnessChatSessionStore(database, holderFile);
  } catch (error) {
    holderFile.close();
    throw error;
  }
};
