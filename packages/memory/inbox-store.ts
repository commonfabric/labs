/** SQLite-backed private inboxes with immutable, idempotent delivery receipts. */

import { Database } from "@db/sqlite";
import { hashStringOf } from "@commonfabric/data-model";
import { isDIDKey } from "@commonfabric/identity/did";
import {
  INBOX_CAPABILITY,
  InboxError,
  type InboxMessage,
  type InboxPayload,
  type InboxReceipt,
  snapshotInboxPayload,
} from "./inbox.ts";

interface Row {
  sequence: number;
  recipient: string;
  sender: string;
  operation: string;
  hash: string;
  received: number;
  payload: string | null;
}

const receipt = (row: Row): InboxReceipt => ({
  recipientDid: row.recipient,
  senderDid: row.sender,
  operationId: row.operation,
  payloadHash: row.hash,
  receivedAt: row.received,
});
const message = (row: Row): InboxMessage => ({
  receipt: receipt(row),
  payload: JSON.parse(row.payload!),
});
const did = (value: string) => {
  if (!isDIDKey(value)) throw new InboxError("invalid-request");
};
const operation = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new InboxError("invalid-request");
  }
};

/** Owns one service-private database; caller identities come from verified requests. */
export class InboxStore {
  #database: Database;
  #closed = false;

  /** Opens durable storage, or an isolated in-memory database for a test server. */
  constructor(path: string) {
    this.#database = new Database(path);
    this.#database.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox_recipients (recipient TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS inbox_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, sender TEXT NOT NULL,
        operation TEXT NOT NULL, hash TEXT NOT NULL, received REAL NOT NULL, payload TEXT,
        UNIQUE(recipient,sender,operation));
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox_messages(recipient,sequence) WHERE payload IS NOT NULL;
      CREATE INDEX IF NOT EXISTS inbox_sender ON inbox_messages(recipient,sender) WHERE payload IS NOT NULL;`,
    );
  }

  /** Explicitly opts the authenticated recipient into delivery. */
  enable(recipient: string): { recipientDid: string; enabled: true } {
    did(recipient);
    this.#database.prepare("INSERT OR IGNORE INTO inbox_recipients VALUES (?)")
      .run(recipient);
    return { recipientDid: recipient, enabled: true };
  }

  /** Returns public readiness without revealing message data. */
  status(recipient: string): { recipientDid: string; enabled: boolean } {
    did(recipient);
    return {
      recipientDid: recipient,
      enabled: !!this.#database.prepare(
        "SELECT recipient FROM inbox_recipients WHERE recipient=?",
      ).get(recipient),
    };
  }

  /** Commits a delivery and its immutable receipt in one transaction. */
  send(
    sender: string,
    request: {
      recipientDid: string;
      operationId: string;
      payload: InboxPayload;
    },
  ): InboxReceipt {
    did(sender);
    did(request.recipientDid);
    operation(request.operationId);
    const snapshot = snapshotInboxPayload(request.payload);
    const hash = hashStringOf(snapshot.payload);
    const payload = snapshot.json;
    return this.#database.transaction(() => {
      const existing = this.#row(
        request.recipientDid,
        sender,
        request.operationId,
      );
      if (existing) {
        if (existing.hash !== hash) throw new InboxError("operation-conflict");
        return receipt(existing);
      }
      if (!this.status(request.recipientDid).enabled) {
        throw new InboxError("not-enabled");
      }
      const counts = this.#database.prepare(`SELECT count(*) AS total,
        count(CASE WHEN payload IS NOT NULL THEN 1 END) AS pending,
        count(CASE WHEN payload IS NOT NULL AND sender=? THEN 1 END) AS senderPending
        FROM inbox_messages WHERE recipient=?`).get<
        { total: number; pending: number; senderPending: number }
      >(sender, request.recipientDid)!;
      if (
        counts.total >= INBOX_CAPABILITY.maxReceipts ||
        counts.pending >= INBOX_CAPABILITY.maxPending ||
        counts.senderPending >= INBOX_CAPABILITY.maxPendingPerSender
      ) throw new InboxError("inbox-full");
      this.#database.prepare(
        "INSERT INTO inbox_messages(recipient,sender,operation,hash,received,payload) VALUES (?,?,?,?,?,?)",
      )
        .run(
          request.recipientDid,
          sender,
          request.operationId,
          hash,
          Date.now(),
          payload,
        );
      return receipt(
        this.#row(request.recipientDid, sender, request.operationId)!,
      );
    }).immediate();
  }

  /** Lists only pending deliveries addressed to the authenticated recipient. */
  list(
    recipient: string,
    options: { cursor?: string; limit?: number } = {},
  ): { messages: InboxMessage[]; nextCursor: string | null } {
    did(recipient);
    const limit = options.limit ?? 50;
    const cursor = options.cursor ?? "0";
    if (
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))
    ) throw new InboxError("invalid-request");
    const rows = this.#database.prepare(
      "SELECT CAST(sequence AS REAL) AS sequence, recipient, sender, operation, hash, received, payload FROM inbox_messages WHERE recipient=? AND payload IS NOT NULL AND sequence>? ORDER BY sequence LIMIT ?",
    )
      .all<Row>(recipient, Number(cursor), limit + 1);
    return {
      messages: rows.slice(0, limit).map(message),
      nextCursor: rows.length > limit ? String(rows[limit - 1].sequence) : null,
    };
  }

  /** Reads a pending message only in the authenticated recipient's inbox. */
  get(
    recipient: string,
    key: { senderDid: string; operationId: string },
  ): { message: InboxMessage | null } {
    did(recipient);
    did(key.senderDid);
    operation(key.operationId);
    const row = this.#row(recipient, key.senderDid, key.operationId);
    return {
      message: row?.payload !== null && row !== undefined ? message(row) : null,
    };
  }

  /** Removes message content while preserving retry identity and receipt. */
  acknowledge(
    recipient: string,
    key: { senderDid: string; operationId: string },
  ): { acknowledged: boolean } {
    did(recipient);
    did(key.senderDid);
    operation(key.operationId);
    const row = this.#row(recipient, key.senderDid, key.operationId);
    if (!row) return { acknowledged: false };
    this.#database.prepare(
      "UPDATE inbox_messages SET payload=NULL WHERE recipient=? AND sender=? AND operation=?",
    ).run(recipient, key.senderDid, key.operationId);
    return { acknowledged: true };
  }

  /** Releases the owned database connection. */
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }

  #row(recipient: string, sender: string, operation: string): Row | undefined {
    return this.#database.prepare(
      "SELECT * FROM inbox_messages WHERE recipient=? AND sender=? AND operation=?",
    ).get<Row>(recipient, sender, operation);
  }
}
