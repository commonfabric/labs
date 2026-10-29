/**
 * Retains one host-local space allocation per portable calendar occurrence.
 * Candidates complete ordinary genesis before the association commits. Only
 * the retained address may be published or shared by a meeting daemon.
 */

import { Database } from "@db/sqlite";
import { z } from "@hono/zod-openapi";

import { aclDocId } from "@commonfabric/memory/acl";
import type { DID } from "@commonfabric/memory/interface";
import {
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  type GenesisRoot,
} from "@commonfabric/memory/v2";
import { isGenesisRoot } from "@commonfabric/memory/v2/genesis-root";
import type { Server } from "@commonfabric/memory/v2/server";

import {
  isExplicitSpaceOwner,
  isValidSpaceDid,
} from "@/lib/space-authority.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Portable occurrence signature and proposed allocation at the host boundary. */
export const meetingRoomRequestSchema = z.object({
  key: z.object({
    scheme: z.literal("ical-uid-slot"),
    item_key: digest,
    occurrence_key: digest,
  }).strict(),
  requestId: z.string().uuid(),
  candidate: z.union([
    z.object({ root: z.custom<GenesisRoot>(isGenesisRoot) }).strict(),
    z.object({ space: z.string().refine(isValidSpaceDid) }).strict(),
  ]),
}).strict();

/** Input accepted by the authenticated meeting-room boundary. */
export type MeetingRoomRequest = z.infer<typeof meetingRoomRequestSchema>;

/**
 * Canonical address and allocating principal. Only that principal receives the
 * retained creation intent, needed to resume its own publication journal.
 */
export type MeetingRoomAllocation = {
  space: string;
  creator: string;
  intent?: { requestId: string; root: GenesisRoot };
};

const rowSchema = z.object({
  key: z.string(),
  space: z.string().refine(isValidSpaceDid),
  creator: z.string().refine(isValidSpaceDid),
  request_id: z.string().uuid(),
  root: z.string().nullable(),
});

type AllocationRow = z.infer<typeof rowSchema>;

/** A caller's candidate lacks ownership or its request changes occurrence. */
export class MeetingRoomError extends Error {
  #code: "not-owner" | "request-conflict";

  /** Constructs an instance carrying a public refusal code. */
  constructor(code: "not-owner" | "request-conflict") {
    super(code);
    this.#code = code;
  }

  /** Safe public refusal code. */
  get code(): "not-owner" | "request-conflict" {
    return this.#code;
  }
}

/**
 * Ensures one canonical meeting address in one host's durable allocation store.
 * Callers learn an address without receiving membership or publication rights.
 */
export class MeetingRooms {
  #path: string;
  #server: Server;
  #createSpace: (creator: DID, root: GenesisRoot) => Promise<DID>;

  /** Constructs an instance bound to the host's store and memory server. */
  constructor(options: {
    path: string;
    server: Server;
    createSpace: (creator: DID, root: GenesisRoot) => Promise<DID>;
  }) {
    this.#path = options.path;
    this.#server = options.server;
    this.#createSpace = options.createSpace;
  }

  /**
   * Returns the retained address or records one fully created candidate.
   * An existing candidate requires an explicit owner grant to the caller.
   * An unrecorded or losing candidate is abandoned without publication. Storage
   * and genesis failures propagate; a retry reads the association first.
   */
  async ensure(
    principal: string,
    request: MeetingRoomRequest,
  ): Promise<MeetingRoomAllocation> {
    if (!isValidSpaceDid(principal)) throw new Error("Invalid principal");
    const parsed = meetingRoomRequestSchema.parse(request);
    const key = JSON.stringify([
      parsed.key.scheme,
      parsed.key.item_key,
      parsed.key.occurrence_key,
    ]);
    const existing = this.#read(key, principal, parsed.requestId);
    const row = existing ?? await this.#allocate(principal, parsed, key);
    const result: MeetingRoomAllocation = {
      space: row.space,
      creator: row.creator,
    };
    if (row.creator === principal && row.root !== null) {
      result.intent = { requestId: row.request_id, root: this.#root(row) };
    }
    return result;
  }

  /** Opens the shared association store with durable SQLite commits. */
  #open(): Database {
    const db = new Database(this.#path);
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS meeting_rooms (
          key TEXT PRIMARY KEY,
          space TEXT NOT NULL,
          creator TEXT NOT NULL,
          request_id TEXT NOT NULL,
          root TEXT,
          UNIQUE (creator, request_id)
        );
      `);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Reads an association without converting storage failures to absence. */
  #read(
    key: string,
    principal: DID,
    requestId: string,
  ): AllocationRow | undefined {
    const db = this.#open();
    try {
      this.#checkRequest(db, principal, requestId, key);
      const row = db.prepare("SELECT * FROM meeting_rooms WHERE key = ?")
        .get(key);
      return row === undefined ? undefined : rowSchema.parse(row);
    } finally {
      db.close();
    }
  }

  /** Refuses a request already retained for another occurrence. */
  #checkRequest(
    db: Database,
    principal: DID,
    requestId: string,
    key: string,
  ): void {
    const prior = db.prepare(
      "SELECT key FROM meeting_rooms WHERE creator = ? AND request_id = ?",
    ).get(principal, requestId);
    if (prior !== undefined && prior.key !== key) {
      throw new MeetingRoomError("request-conflict");
    }
  }

  /** Creates or validates one candidate, then retains the transaction's winner. */
  async #allocate(
    principal: DID,
    request: MeetingRoomRequest,
    key: string,
  ): Promise<AllocationRow> {
    let space = "space" in request.candidate
      ? request.candidate.space
      : undefined;
    if (space === undefined) {
      if (!("root" in request.candidate)) {
        throw new Error("Missing candidate root");
      }
      space = await this.#createSpace(principal, request.candidate.root);
      if (!isValidSpaceDid(space)) throw new Error("Invalid created space DID");
    }
    const acl = await this.#server.readDocument(space, aclDocId(space));
    if (!isExplicitSpaceOwner(acl?.value, principal)) {
      throw new MeetingRoomError("not-owner");
    }
    await this.#server.flushSpace(space);
    const db = this.#open();
    try {
      return db.transaction(() => {
        this.#checkRequest(db, principal, request.requestId, key);
        db.prepare(`
          INSERT INTO meeting_rooms
            (key, space, creator, request_id, root)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (key) DO NOTHING
        `).run(
          key,
          space,
          principal,
          request.requestId,
          "root" in request.candidate
            ? encodeMemoryBoundary(request.candidate.root)
            : null,
        );
        return rowSchema.parse(
          db.prepare("SELECT * FROM meeting_rooms WHERE key = ?").get(key),
        );
      }).immediate();
    } finally {
      db.close();
    }
  }

  /** Decodes the allocating principal's retained genesis intent. */
  #root(row: AllocationRow): GenesisRoot {
    if (row.root === null) throw new Error("Missing retained genesis root");
    const root = decodeTrustedMemoryBoundary(row.root);
    if (!isGenesisRoot(root)) throw new Error("Invalid retained genesis root");
    return root;
  }
}
