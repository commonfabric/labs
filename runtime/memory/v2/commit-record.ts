/**
 * Compact commit records: the cells a `commit` row holds when it is not in
 * today's text form. An intact commit's `original` is a tagged body that
 * leaves out its large operation payloads, which live as value objects
 * reached through a {@link FragmentStore}, and its confirmed reads, which live
 * as shared chunks of `(entity, shape, seq)` entries in canonical order, with
 * the permutation that restores the client's order when it differs. A
 * hollowed commit's `original` names only the compaction commit that hollowed
 * it. `digest` carries the commit text's identity for replay and hollowing,
 * and `resolution` has two small forms of its own.
 *
 * Every form reads back as exactly the text today's engine stores. An encoder
 * that cannot reproduce a row writes it as text instead.
 */

import type { Database, Statement } from "@db/sqlite";
// deno-lint-ignore no-external-import -- The runtime's native zstd compresses commit bodies.
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { sha256 } from "@commonfabric/content-hash";
import { decodeULEB128, encodeULEB128 } from "@commonfabric/bytes/leb128";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";
import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import {
  decode as utf8Decode,
  encode as utf8Encode,
  utf8ByteLength,
  utf8SortedKeysOf,
} from "@commonfabric/text/utf8";
import { encodeMemoryBoundary } from "../v2.ts";
import type { FragmentStore } from "./value-store.ts";

/** The commit records' tables (`mem_entity`, `mem_read_shape`, `mem_read_chunk` and its index); idempotent. */
export const COMMIT_RECORD_SCHEMA = `
CREATE TABLE IF NOT EXISTS mem_entity (
  eid   INTEGER PRIMARY KEY,
  id    TEXT    NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS mem_read_shape (
  shid  INTEGER PRIMARY KEY,
  shape TEXT    NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS mem_read_chunk (
  cid   INTEGER PRIMARY KEY,
  hash  BLOB    NOT NULL,
  body  BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS mem_read_chunk_hash ON mem_read_chunk (hash);
`;

/** The cells of one `commit` row this module reads. */
export type StoredCommitCells = {
  /** The row's `seq`. */
  seq: number;

  /** The row's `session_id`. */
  session_id: string;

  /** Today's text, or a tagged blob. */
  original: string | Uint8Array;

  /** The replay identity of a compact row; `null` on a text row. */
  digest: Uint8Array | null;

  /** The chunked confirmed reads; `null` unless they are chunked. */
  reads: Uint8Array | null;
};

/** The cells to write for one commit. `original` is text exactly when the row is in today's form. */
export type EncodedCommit = {
  /** The `original` cell. */
  original: string | Uint8Array;

  /** The `digest` cell. */
  digest: Uint8Array | null;

  /** The `reads` cell. */
  reads: Uint8Array | null;

  /** Why the row stayed text, for counters: "genesis" | "compaction" | "no-round-trip" | undefined. */
  keptText?: string;
};

/** Options of {@link CommitRecords}. */
export type CommitRecordOptions = {
  /** Bound of the entity dictionary caches; a cache is cleared when it reaches its bound. Default 262,144. */
  entityCacheMax?: number;

  /** Bound of the shape dictionary caches, cleared the same way. Default 16,384. */
  shapeCacheMax?: number;

  /** Bound of the chunk-body cache, cleared the same way. Default 16,384. */
  chunkCacheMax?: number;

  /** Run the round-trip check on every encode. Default true. */
  verify?: boolean;

  /** Tests only: replaces the chunk lookup hash (16 bytes), to force collisions. */
  hashForTesting?: (bytes: Uint8Array) => Uint8Array;
};

/** Counters of one {@link CommitRecords} instance. */
export type CommitRecordStats = {
  /** Rows encoded in a compact form, hollowed ones included. */
  encoded: number;

  /** Rows left in today's text form. */
  keptText: number;

  /** Chunks inserted into `mem_read_chunk`. */
  chunksStored: number;

  /** Chunks found already stored. */
  chunksReused: number;

  /** Compact rows whose confirmed reads stayed inside the body. */
  readsVerbatim: number;

  /** Operation payloads stored as fragments. */
  payloadRefs: number;
};

/** The prefix every encoded commit text carries. */
const TEXT_PREFIX = "fvj1:";

/** The prefix of the session of a commit the compaction tool writes. */
const COMPACTION_SESSION_PREFIX = "compaction:";

/** Tags of an `original` blob. */
const ORIGINAL_RAW = 0x01;
const ORIGINAL_ZSTD = 0x02;
const ORIGINAL_HOLLOWED = 0x03;

/** Tag of a `digest` blob. */
const DIGEST_TAG = 0x00;

/**
 * Tags of a `reads` blob: chunk ids alone, the client's order being the
 * canonical one; or a count of chunk ids, the ids, and the client's order,
 * raw or as a zstd frame.
 */
const READS_CANONICAL = 0x00;
const READS_ORDER_RAW = 0x01;
const READS_ORDER_ZSTD = 0x02;

/** Tags of a `resolution` blob. */
const RESOLUTION_SEQ = 0x00;
const RESOLUTION_PENDING = 0x01;

/** Length of the hash a digest carries. */
const DIGEST_HASH_BYTES = 32;

/** Length of the lookup hash of a chunk. */
const CHUNK_HASH_BYTES = 16;

/** UTF-8 bytes of an operation payload's JSON from which it becomes a fragment. */
const PAYLOAD_MIN_BYTES = 64;

/** Bytes of a body from which compressing it is attempted. */
const COMPRESS_MIN_BYTES = 32;

/** The largest number a varint of this format carries. */
const MAX_VARINT = 0xFFFF_FFFF;

/**
 * Text every hollowing marker begins with, up to and including the name of its
 * `bytes` member. Derived from the codec the way the compaction tool derives
 * its own, so both recognize the same rows.
 */
const HOLLOWED_MARKER_PREFIX = (() => {
  const probe = encodeMemoryBoundary(
    {
      hollowed: { hash: "", bytes: 0, commitSeq: 0, runId: "" },
    } as FabricValue,
  );
  const at = probe.indexOf('"bytes":');
  if (at < 0) throw new Error("The hollowing marker did not encode.");
  return probe.slice(0, at + '"bytes":'.length);
})();

/** A JSON object as `JSON.parse` builds one. */
type JsonRecord = Record<string, unknown>;

/** A reference from a body to an operation payload: `[index, member, vid]`. */
type PayloadRef = [number, "value" | "patches", number];

/** One confirmed read, keyed by its dictionary ids. */
type ReadEntry = { eid: number; shid: number; seq: number };

/** A confirmed read the encoder has validated, before its ids are known. */
type PendingEntry = { id: string; shape: string; seq: number; read: unknown };

/** The marker members a hollowed row stands for. */
type HollowedMarker = {
  hash: string;
  bytes: number;
  commitSeq: number;
  runId: string;
};

/**
 * A bounded map whose writes made inside a transaction go to a staged layer
 * that {@link StagedCache.settle} publishes or drops, so an id a rolled-back
 * transaction handed out never stays cached for content it no longer names.
 */
class StagedCache<K, V> {
  /** Entries filled from committed state. */
  readonly #main = new Map<K, V>();

  /** Entries filled inside each open stage, innermost last. */
  readonly #staged: Map<K, V>[] = [];

  /** Constructs an instance holding at most `max` committed entries. */
  constructor(readonly max: number) {}

  /** The value cached for `key`, committed or staged. */
  get(key: K): V | undefined {
    const committed = this.#main.get(key);
    if (committed !== undefined) return committed;
    for (let layer = this.#staged.length - 1; layer >= 0; layer--) {
      const staged = this.#staged[layer].get(key);
      if (staged !== undefined) return staged;
    }
    return undefined;
  }

  /**
   * Caches `value` for `key`: in the committed layer when `inTransaction` is
   * false, in the innermost stage when it is true and a stage is open, and
   * nowhere otherwise.
   */
  put(key: K, value: V, inTransaction: boolean): void {
    if (!inTransaction) {
      this.#putMain(key, value);
    } else if (this.#staged.length > 0) {
      this.#staged[this.#staged.length - 1].set(key, value);
    }
  }

  /** Opens an empty stage inside any stage already open. */
  stage(): void {
    this.#staged.push(new Map());
  }

  /**
   * Closes the innermost stage, moving its entries into the stage below (or
   * the committed layer) when `committed`, dropping them otherwise.
   */
  settle(committed: boolean): void {
    const staged = this.#staged.pop();
    if (!committed || staged === undefined) return;
    const below = this.#staged[this.#staged.length - 1];
    for (const [key, value] of staged) {
      if (below !== undefined) below.set(key, value);
      else this.#putMain(key, value);
    }
  }

  /** Helper for `put()` and `settle()`, which writes to the committed layer. */
  #putMain(key: K, value: V): void {
    if (this.#main.size >= this.max && !this.#main.has(key)) {
      this.#main.clear();
    }
    this.#main.set(key, value);
  }
}

/**
 * Reads and writes the compact forms of `commit` rows (SPEC section 3.4) over
 * one connection. Dictionary rows and chunks are looked up in SQLite on a
 * cache miss and inserted on first sight; caches keyed by or holding an id
 * follow the staging rule of {@link CommitRecords.stage}.
 */
export class CommitRecords {
  readonly #database: Database;
  readonly #fragments: FragmentStore;
  readonly #verify: boolean;
  readonly #chunkHash: (body: Uint8Array) => Uint8Array;
  readonly #statements = new Map<string, Statement>();
  readonly #entityById: StagedCache<string, number>;
  readonly #entityByEid: StagedCache<number, string>;
  readonly #shapeByText: StagedCache<string, number>;
  readonly #shapeByShid: StagedCache<number, string>;
  readonly #chunkByCid: StagedCache<number, Uint8Array>;
  readonly #stats: CommitRecordStats = {
    encoded: 0,
    keptText: 0,
    chunksStored: 0,
    chunksReused: 0,
    readsVerbatim: 0,
    payloadRefs: 0,
  };

  /**
   * Constructs an instance over `database`, which must hold
   * {@link COMMIT_RECORD_SCHEMA} and a `commit` table, storing operation
   * payloads through `fragments`. Statements are prepared on first use.
   */
  constructor(
    database: Database,
    fragments: FragmentStore,
    options: CommitRecordOptions = {},
  ) {
    this.#database = database;
    this.#fragments = fragments;
    this.#verify = options.verify ?? true;
    this.#chunkHash = options.hashForTesting ??
      ((body) => sha256(body).subarray(0, CHUNK_HASH_BYTES));
    const entityMax = options.entityCacheMax ?? 262_144;
    const shapeMax = options.shapeCacheMax ?? 16_384;
    this.#entityById = new StagedCache(entityMax);
    this.#entityByEid = new StagedCache(entityMax);
    this.#shapeByText = new StagedCache(shapeMax);
    this.#shapeByShid = new StagedCache(shapeMax);
    this.#chunkByCid = new StagedCache(options.chunkCacheMax ?? 16_384);
  }

  /**
   * The cells for a commit whose stored text is `text`
   * (`encodeMemoryBoundary(commit)` or a hollowing marker), at `seq` under
   * `sessionId`. Only inside a write transaction (it inserts dictionary rows,
   * chunks and fragments). Rows that stay text are `seq` 1, the compaction
   * tool's own commits, and any row whose compact form does not read back as
   * `text`; a row that falls back may leave dictionary rows, chunks or
   * fragments behind, which nothing references.
   */
  encode(text: string, row: { seq: number; sessionId: string }): EncodedCommit {
    if (row.seq === 1) return this.#keptText(text, "genesis");
    if (row.sessionId.startsWith(COMPACTION_SESSION_PREFIX)) {
      return this.#keptText(text, "compaction");
    }
    const encoded = text.startsWith(HOLLOWED_MARKER_PREFIX)
      ? this.#encodeMarker(text)
      : this.#encodeIntact(text, row);
    if (encoded === undefined) return this.#keptText(text, "no-round-trip");
    this.#stats.encoded++;
    return encoded;
  }

  /** The row's text: as stored, reassembled, or the exact marker text. */
  originalText(row: StoredCommitCells): string {
    const original = row.original;
    if (typeof original === "string") return original;
    switch (original[0]) {
      case ORIGINAL_RAW:
      case ORIGINAL_ZSTD:
        return this.#intactText(original, row.reads);
      case ORIGINAL_HOLLOWED: {
        const marker = markerOfCells(original, row.digest, row.seq);
        const text = this.#markerText(marker);
        if (text === undefined) {
          throw new Error(
            `Commit ${marker.commitSeq}, which hollowed commit ${row.seq}, is not a compaction commit.`,
          );
        }
        return text;
      }
      default:
        throw new Error(
          `Commit ${row.seq} has an \`original\` blob with unknown tag ${
            original[0]
          }.`,
        );
    }
  }

  /** Whether the row is a hollowing marker in either form. */
  isHollowed(row: StoredCommitCells): boolean {
    return typeof row.original === "string"
      ? row.original.startsWith(HOLLOWED_MARKER_PREFIX)
      : row.original[0] === ORIGINAL_HOLLOWED;
  }

  /** Replay identity (3.4.2): text equality, digest equality, or false for a hollowed row. */
  matchesStored(row: StoredCommitCells, incomingText: string): boolean {
    if (this.isHollowed(row)) return false;
    if (typeof row.original === "string") {
      return row.original === incomingText;
    }
    return row.digest !== null &&
      bytesEqual(row.digest, commitDigest(incomingText));
  }

  /**
   * The cells that hollow a compact intact row in place: tag `0x03` +
   * `commitSeq`, digest kept, reads `null`. Throws for a row in today's form
   * (the compaction tool writes today's marker text for those) and for a row
   * already hollowed.
   */
  hollowCompact(
    row: StoredCommitCells,
    compactionCommitSeq: number,
  ): EncodedCommit {
    const original = row.original;
    if (
      typeof original === "string" ||
      (original[0] !== ORIGINAL_RAW && original[0] !== ORIGINAL_ZSTD)
    ) {
      throw new Error(
        `Commit ${row.seq} is not a compact intact row, so it cannot be hollowed in place.`,
      );
    }
    if (row.digest === null) {
      throw new Error(`Commit ${row.seq} is compact but has no \`digest\`.`);
    }
    return {
      original: concatBytes([
        Uint8Array.of(ORIGINAL_HOLLOWED),
        encodeULEB128(compactionCommitSeq),
      ]),
      digest: row.digest,
      reads: null,
    };
  }

  /** The vids and cids a row references (for the compaction sweep). */
  references(row: StoredCommitCells): { vids: number[]; cids: number[] } {
    const original = row.original;
    if (
      typeof original === "string" ||
      (original[0] !== ORIGINAL_RAW && original[0] !== ORIGINAL_ZSTD)
    ) {
      return { vids: [], cids: [] };
    }
    const [, refs] = parseBody(original);
    return {
      vids: refs.map(([, , vid]) => vid),
      cids: row.reads === null ? [] : readsCellOf(row.reads).cids,
    };
  }

  /**
   * Opens a staging scope for the id-keyed caches (SPEC section 3.3.4): until
   * {@link settle}, what a read inside a transaction learns is cached in the
   * stage rather than nowhere.
   */
  stage(): void {
    for (const cache of this.#caches()) cache.stage();
  }

  /** Publishes (true) or drops (false) what the scope cached. */
  settle(committed: boolean): void {
    for (const cache of this.#caches()) cache.settle(committed);
  }

  /** A copy of this instance's counters. */
  stats(): CommitRecordStats {
    return { ...this.#stats };
  }

  /** Finalizes this instance's statements. */
  close(): void {
    for (const statement of this.#statements.values()) statement.finalize();
    this.#statements.clear();
  }

  /** Helper for `stage()` and `settle()`, which lists every cache. */
  #caches(): StagedCache<unknown, unknown>[] {
    return [
      this.#entityById,
      this.#entityByEid,
      this.#shapeByText,
      this.#shapeByShid,
      this.#chunkByCid,
    ] as StagedCache<unknown, unknown>[];
  }

  /** Helper for `encode()`, which counts and returns a row left as text. */
  #keptText(text: string, reason: string): EncodedCommit {
    this.#stats.keptText++;
    return { original: text, digest: null, reads: null, keptText: reason };
  }

  /**
   * Helper for `encode()`, which builds the hollowed cells of marker `text`,
   * or returns `undefined` when the marker does not have exactly the shape the
   * compaction tool writes or does not reassemble to `text`.
   */
  #encodeMarker(text: string): EncodedCommit | undefined {
    const marker = parseMarker(text);
    if (marker === undefined) return undefined;
    const hash = fromBase64urlOrUndefined(marker.hash);
    if (
      hash === undefined || hash.length !== DIGEST_HASH_BYTES ||
      !isVarint(marker.bytes) || !isVarint(marker.commitSeq)
    ) {
      return undefined;
    }
    if (this.#markerText(marker) !== text) return undefined;
    return {
      original: concatBytes([
        Uint8Array.of(ORIGINAL_HOLLOWED),
        encodeULEB128(marker.commitSeq),
      ]),
      digest: digestOf(hash, marker.bytes),
      reads: null,
    };
  }

  /**
   * Helper for `encode()`, which builds the compact cells of a whole commit,
   * or returns `undefined` when its text is not one `JSON.stringify` of its
   * own parse writes or the record does not read back as `text`.
   */
  #encodeIntact(
    text: string,
    row: { seq: number; sessionId: string },
  ): EncodedCommit | undefined {
    if (!text.startsWith(TEXT_PREFIX)) return undefined;
    const json = text.slice(TEXT_PREFIX.length);
    const tree = parseJson(json);
    if (!isRecord(tree) || JSON.stringify(tree) !== json) return undefined;

    let reads: Uint8Array | null = null;
    let readsVerbatim = false;
    const readsMember = tree.reads;
    if (isRecord(readsMember) && Object.hasOwn(readsMember, "confirmed")) {
      const chunked = this.#chunkReads(readsMember.confirmed);
      if (chunked === undefined) {
        readsVerbatim = true;
      } else {
        delete readsMember.confirmed;
        reads = chunked;
      }
    }

    const refs: PayloadRef[] = [];
    const operations = tree.operations;
    if (Array.isArray(operations)) {
      operations.forEach((operation: unknown, index) => {
        const member = payloadMemberOf(operation);
        if (member === undefined) return;
        const payload = (operation as JsonRecord)[member];
        const fragment = JSON.stringify(payload);
        if (utf8ByteLength(fragment) < PAYLOAD_MIN_BYTES) return;
        refs.push([index, member, this.#fragments.storeFragment(fragment)]);
        delete (operation as JsonRecord)[member];
      });
    }

    const encoded: EncodedCommit = {
      original: originalBlobOf(utf8Encode(JSON.stringify([tree, refs]))),
      digest: commitDigest(text),
      reads,
    };
    if (this.#verify) {
      const decoded = this.originalText({
        seq: row.seq,
        session_id: row.sessionId,
        original: encoded.original,
        digest: encoded.digest,
        reads: encoded.reads,
      });
      if (decoded !== text) return undefined;
    }
    this.#stats.payloadRefs += refs.length;
    if (readsVerbatim) this.#stats.readsVerbatim++;
    return encoded;
  }

  /**
   * Helper for `#encodeIntact()`, which stores confirmed reads as chunks in
   * canonical order and returns the `reads` cell, carrying the client's order
   * when it is not the canonical one, or `undefined` when the reads stay
   * verbatim (SPEC section 3.4.4). Reads that validation sends verbatim insert
   * nothing; an id past the varint range is found only after its dictionary
   * row is inserted.
   */
  #chunkReads(confirmed: unknown): Uint8Array | undefined {
    const pending = validatedReads(confirmed);
    if (pending === undefined) return undefined;
    const entries = pending.map((read) => ({
      eid: this.#entityId(read.id),
      shid: this.#shapeId(read.shape),
      seq: read.seq,
    }));
    if (entries.some(({ eid, shid }) => !isVarint(eid) || !isVarint(shid))) {
      return undefined;
    }
    // `Array.prototype.sort` is stable, so equal entries keep the client's
    // order among themselves.
    const canonical = entries.map((_, index) => index).sort((a, b) =>
      entries[a].eid - entries[b].eid || entries[a].shid - entries[b].shid ||
      entries[a].seq - entries[b].seq
    );

    const cids: Uint8Array[] = [];
    for (const chunk of chunksOf(canonical.map((index) => entries[index]))) {
      const cid = this.#chunkId(chunkBodyOf(chunk));
      if (!isVarint(cid)) return undefined;
      cids.push(encodeULEB128(cid));
    }
    if (canonical.every((index, position) => index === position)) {
      return concatBytes([Uint8Array.of(READS_CANONICAL), ...cids]);
    }
    const positions = new Array<number>(canonical.length);
    canonical.forEach((index, position) => positions[index] = position);
    const { tag, order } = readsOrderTagged(orderBodyOf(positions));
    return concatBytes([tag, encodeULEB128(cids.length), ...cids, order]);
  }

  /** Helper for `originalText()`, which reassembles an intact row's text. */
  #intactText(original: Uint8Array, reads: Uint8Array | null): string {
    const [tree, refs] = parseBody(original);
    const operations = tree.operations;
    for (const [index, member, vid] of refs) {
      if (!Array.isArray(operations) || !isRecord(operations[index])) {
        throw new Error(
          `A commit body references operation ${index}, which it does not hold.`,
        );
      }
      const operation = operations[index] as JsonRecord;
      operation[member] = JSON.parse(this.#fragments.fragmentText(vid));
      operations[index] = inKeyOrder(operation);
    }
    if (reads !== null) {
      if (!isRecord(tree.reads)) {
        throw new Error("A commit with chunked reads has no `reads` member.");
      }
      tree.reads.confirmed = this.#decodeReads(reads);
      tree.reads = inKeyOrder(tree.reads);
    }
    return TEXT_PREFIX + JSON.stringify(tree);
  }

  /**
   * Helper for `#intactText()`, which expands a `reads` cell into reads, in
   * the client's order.
   */
  #decodeReads(cell: Uint8Array): JsonRecord[] {
    const { cids, positions } = readsCellOf(cell);
    const shapes = new Map<number, JsonRecord>();
    const canonical: JsonRecord[] = [];
    for (const cid of cids) {
      for (const { eid, shid, seq } of chunkEntriesOf(this.#chunkBody(cid))) {
        let shape = shapes.get(shid);
        if (shape === undefined) {
          shape = JSON.parse(this.#shapeText(shid)) as JsonRecord;
          shapes.set(shid, shape);
        }
        canonical.push(
          inKeyOrder({ ...shape, id: this.#entityText(eid), seq }),
        );
      }
    }
    if (positions === undefined) return canonical;
    const order = positionsOf(positions, canonical.length);
    return order.map((position) => canonical[position]);
  }

  /**
   * Helper for `originalText()` and `#encodeMarker()`, which reassembles the
   * marker text a hollowed row stands for, or returns `undefined` when the
   * row at `marker.commitSeq` is not a compaction commit.
   */
  #markerText(marker: Omit<HollowedMarker, "runId">): string | undefined {
    const runId = this.#compactionRunId(marker.commitSeq);
    if (runId === undefined) return undefined;
    return encodeMemoryBoundary(
      {
        hollowed: {
          hash: marker.hash,
          bytes: marker.bytes,
          commitSeq: marker.commitSeq,
          runId,
        },
      } as FabricValue,
    );
  }

  /** The run id of the compaction commit at `seq`, or `undefined` when there is none. */
  #compactionRunId(seq: number): string | undefined {
    const row = this.#statement(`SELECT session_id FROM "commit" WHERE seq = ?`)
      .get<{ session_id: string }>(seq);
    const session = row?.session_id;
    return typeof session === "string" &&
        session.startsWith(COMPACTION_SESSION_PREFIX)
      ? session.slice(COMPACTION_SESSION_PREFIX.length)
      : undefined;
  }

  /** Helper for `#chunkReads()`, which returns the eid of `id`, inserting it on first sight. */
  #entityId(id: string): number {
    return this.#dictionaryId(
      id,
      this.#entityById,
      this.#entityByEid,
      `SELECT eid AS n FROM mem_entity WHERE id = ?`,
      `INSERT INTO mem_entity (id) VALUES (?)`,
    );
  }

  /** Helper for `#chunkReads()`, which returns the shid of `shape`, inserting it on first sight. */
  #shapeId(shape: string): number {
    return this.#dictionaryId(
      shape,
      this.#shapeByText,
      this.#shapeByShid,
      `SELECT shid AS n FROM mem_read_shape WHERE shape = ?`,
      `INSERT INTO mem_read_shape (shape) VALUES (?)`,
    );
  }

  /** Helper for `#entityId()` and `#shapeId()`. */
  #dictionaryId(
    text: string,
    byText: StagedCache<string, number>,
    byId: StagedCache<number, string>,
    selectSql: string,
    insertSql: string,
  ): number {
    const cached = byText.get(text);
    if (cached !== undefined) return cached;
    let id = this.#statement(selectSql).get<{ n: number }>(text)?.n;
    if (id === undefined) {
      this.#statement(insertSql).run(text);
      id = this.#database.lastInsertRowId;
    }
    const inTransaction = this.#database.inTransaction;
    byText.put(text, id, inTransaction);
    byId.put(id, text, inTransaction);
    return id;
  }

  /** Helper for `#decodeReads()`, which returns the id text of `eid`. */
  #entityText(eid: number): string {
    return this.#dictionaryText(
      eid,
      this.#entityByEid,
      this.#entityById,
      `SELECT id AS t FROM mem_entity WHERE eid = ?`,
      "mem_entity",
    );
  }

  /** Helper for `#decodeReads()`, which returns the shape text of `shid`. */
  #shapeText(shid: number): string {
    return this.#dictionaryText(
      shid,
      this.#shapeByShid,
      this.#shapeByText,
      `SELECT shape AS t FROM mem_read_shape WHERE shid = ?`,
      "mem_read_shape",
    );
  }

  /** Helper for `#entityText()` and `#shapeText()`. */
  #dictionaryText(
    id: number,
    byId: StagedCache<number, string>,
    byText: StagedCache<string, number>,
    selectSql: string,
    table: string,
  ): string {
    const cached = byId.get(id);
    if (cached !== undefined) return cached;
    const text = this.#statement(selectSql).get<{ t: string }>(id)?.t;
    if (text === undefined) throw new Error(`${table} has no row ${id}.`);
    const inTransaction = this.#database.inTransaction;
    byId.put(id, text, inTransaction);
    byText.put(text, id, inTransaction);
    return text;
  }

  /** Helper for `#chunkReads()`, which returns the cid of `body`, inserting it when new. */
  #chunkId(body: Uint8Array): number {
    const hash = this.#chunkHash(body);
    const candidates = this.#statement(
      `SELECT cid, body FROM mem_read_chunk WHERE hash = ? ORDER BY cid`,
    ).all<{ cid: number; body: Uint8Array }>(hash);
    let cid = candidates.find((row) => bytesEqual(row.body, body))?.cid;
    if (cid === undefined) {
      this.#statement(`INSERT INTO mem_read_chunk (hash, body) VALUES (?, ?)`)
        .run(hash, body);
      cid = this.#database.lastInsertRowId;
      this.#stats.chunksStored++;
    } else {
      this.#stats.chunksReused++;
    }
    this.#chunkByCid.put(cid, body, this.#database.inTransaction);
    return cid;
  }

  /** Helper for `#decodeReads()`, which returns the body of chunk `cid`. */
  #chunkBody(cid: number): Uint8Array {
    const cached = this.#chunkByCid.get(cid);
    if (cached !== undefined) return cached;
    const body = this.#statement(
      `SELECT body FROM mem_read_chunk WHERE cid = ?`,
    ).get<{ body: Uint8Array }>(cid)?.body;
    if (body === undefined) {
      throw new Error(`mem_read_chunk has no row ${cid}.`);
    }
    this.#chunkByCid.put(cid, body, this.#database.inTransaction);
    return body;
  }

  /** The prepared statement for `sql`, prepared on first use. */
  #statement(sql: string): Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

/** 3.4.2. */
export function commitDigest(text: string): Uint8Array {
  return digestOf(fromBase64url(hashStringOf(text)), utf8ByteLength(text));
}

/** 3.4.5: the cell to write for resolution text `text` of the row at `seq`. */
export function encodeResolution(
  text: string,
  seq: number,
): string | Uint8Array {
  if (!isVarint(seq)) return text;
  if (text === encodeMemoryBoundary({ seq })) {
    return Uint8Array.of(RESOLUTION_SEQ);
  }
  if (!text.startsWith(TEXT_PREFIX)) return text;
  const tree = parseJson(text.slice(TEXT_PREFIX.length));
  if (
    !isRecord(tree) || tree.seq !== seq ||
    !Array.isArray(tree.resolvedPendingReads) ||
    Object.keys(tree).length !== 2
  ) {
    return text;
  }
  const parts: Uint8Array[] = [
    Uint8Array.of(RESOLUTION_PENDING),
    encodeULEB128(tree.resolvedPendingReads.length),
  ];
  for (const resolved of tree.resolvedPendingReads as unknown[]) {
    if (
      !isRecord(resolved) || !isVarint(resolved.localSeq) ||
      !isVarint(resolved.seq)
    ) {
      return text;
    }
    parts.push(encodeULEB128(resolved.localSeq), encodeULEB128(resolved.seq));
  }
  const cell = concatBytes(parts);
  return resolutionText(cell, seq) === text ? cell : text;
}

/** 3.4.5: the text a resolution cell stands for. */
export function resolutionText(cell: string | Uint8Array, seq: number): string {
  if (typeof cell === "string") return cell;
  if (cell[0] === RESOLUTION_SEQ && cell.length === 1) {
    return encodeMemoryBoundary({ seq });
  }
  if (cell[0] !== RESOLUTION_PENDING) {
    throw new Error(`A \`resolution\` blob has unknown tag ${cell[0]}.`);
  }
  let at = 1;
  const next = (): number => {
    const { value, nextIndex } = decodeULEB128(cell, at);
    at = nextIndex;
    return value;
  };
  const count = next();
  const resolvedPendingReads: { localSeq: number; seq: number }[] = [];
  for (let index = 0; index < count; index++) {
    const localSeq = next();
    resolvedPendingReads.push({ localSeq, seq: next() });
  }
  return encodeMemoryBoundary({ resolvedPendingReads, seq });
}

/**
 * Stateless `originalText` over a Database, for tools. Prepares what the row
 * needs and finalizes it before returning, so a caller reading many rows
 * keeps a {@link CommitRecords} instead.
 */
export function readCommitOriginalText(
  database: Database,
  fragments: FragmentStore,
  row: StoredCommitCells,
): string {
  if (typeof row.original === "string") return row.original;
  const records = new CommitRecords(database, fragments);
  try {
    return records.originalText(row);
  } finally {
    records.close();
  }
}

/** Builds a digest from a 32-byte hash and the text's UTF-8 length. */
function digestOf(hash: Uint8Array, byteLength: number): Uint8Array {
  return concatBytes([
    Uint8Array.of(DIGEST_TAG),
    hash,
    encodeULEB128(byteLength),
  ]);
}

/**
 * Helper for `originalText()`, which reads the marker members a hollowed
 * row's cells carry, all but its run id.
 */
function markerOfCells(
  original: Uint8Array,
  digest: Uint8Array | null,
  seq: number,
): Omit<HollowedMarker, "runId"> {
  if (
    digest === null || digest[0] !== DIGEST_TAG ||
    digest.length <= 1 + DIGEST_HASH_BYTES
  ) {
    throw new Error(`Hollowed commit ${seq} has no valid \`digest\`.`);
  }
  return {
    hash: toUnpaddedBase64url(digest.subarray(1, 1 + DIGEST_HASH_BYTES)),
    bytes: decodeULEB128(digest, 1 + DIGEST_HASH_BYTES).value,
    commitSeq: decodeULEB128(original, 1).value,
  };
}

/**
 * The members of marker text `text` when its decoded value is exactly
 * `{ hollowed: { bytes, commitSeq, hash, runId } }` with numbers and strings
 * where the compaction tool writes them, else `undefined`.
 */
function parseMarker(text: string): HollowedMarker | undefined {
  const tree = parseJson(text.slice(TEXT_PREFIX.length));
  if (!isRecord(tree) || Object.keys(tree).length !== 1) return undefined;
  const marker = tree.hollowed;
  if (
    !isRecord(marker) || Object.keys(marker).length !== 4 ||
    typeof marker.hash !== "string" || typeof marker.runId !== "string" ||
    typeof marker.bytes !== "number" || typeof marker.commitSeq !== "number"
  ) {
    return undefined;
  }
  return {
    hash: marker.hash,
    bytes: marker.bytes,
    commitSeq: marker.commitSeq,
    runId: marker.runId,
  };
}

/**
 * Helper for `#chunkReads()`, which validates confirmed reads for chunking and
 * returns them with their shapes, or `undefined` when they stay verbatim: a
 * read that is not a plain object, has a non-string `id` or a `seq` outside
 * the varint range, or two reads of one `(id, scope ?? "space")` with
 * different seqs.
 */
function validatedReads(confirmed: unknown): PendingEntry[] | undefined {
  if (!Array.isArray(confirmed)) return undefined;
  const seqByDocument = new Map<string, number>();
  const result: PendingEntry[] = [];
  for (const read of confirmed as unknown[]) {
    if (
      !isRecord(read) || !Object.hasOwn(read, "id") ||
      !Object.hasOwn(read, "seq") || typeof read.id !== "string" ||
      !isVarint(read.seq)
    ) {
      return undefined;
    }
    const { id: _id, seq: _seq, ...rest } = read;
    const id = read.id as string;
    const seq = read.seq as number;
    const document = JSON.stringify([id, read.scope ?? "space"]);
    const seen = seqByDocument.get(document);
    if (seen !== undefined && seen !== seq) return undefined;
    seqByDocument.set(document, seq);
    result.push({ id, seq, shape: JSON.stringify(rest), read });
  }
  return result;
}

/**
 * Helper for `#chunkReads()`, which cuts canonically ordered entries into
 * chunks: one ends after the last entry of an eid the boundary rule selects,
 * and at the end of the list.
 */
function chunksOf(entries: readonly ReadEntry[]): ReadEntry[][] {
  const chunks: ReadEntry[][] = [];
  let current: ReadEntry[] = [];
  entries.forEach((entry, index) => {
    current.push(entry);
    const next = entries[index + 1];
    if (
      next === undefined ||
      (next.eid !== entry.eid && isChunkBoundary(entry.eid))
    ) {
      chunks.push(current);
      current = [];
    }
  });
  return chunks;
}

/** Whether a chunk ends after the last entry of `eid` (SPEC section 3.4.4). */
function isChunkBoundary(eid: number): boolean {
  return (((Math.imul(eid, 0x9E3779B1) >>> 0) >>> 7) & 63) === 0;
}

/** The body of a chunk: count, then `(eidDelta, shid)` pairs, then seqs. */
function chunkBodyOf(chunk: readonly ReadEntry[]): Uint8Array {
  const parts: Uint8Array[] = [encodeULEB128(chunk.length)];
  let previous = 0;
  for (const { eid, shid } of chunk) {
    parts.push(encodeULEB128(eid - previous), encodeULEB128(shid));
    previous = eid;
  }
  for (const { seq } of chunk) parts.push(encodeULEB128(seq));
  return concatBytes(parts);
}

/** The entries a chunk body holds, in order. */
function chunkEntriesOf(body: Uint8Array): ReadEntry[] {
  let at = 0;
  const next = (): number => {
    const { value, nextIndex } = decodeULEB128(body, at);
    at = nextIndex;
    return value;
  };
  const count = next();
  const entries: ReadEntry[] = [];
  let eid = 0;
  for (let index = 0; index < count; index++) {
    eid += next();
    entries.push({ eid, shid: next(), seq: 0 });
  }
  for (const entry of entries) entry.seq = next();
  return entries;
}

/**
 * The cids a `reads` cell lists, in chunk order, and the bytes of the
 * client's order (raw, decompressed when the cell holds a zstd frame), or
 * `undefined` when the client's order is the canonical one.
 */
function readsCellOf(
  cell: Uint8Array,
): { cids: number[]; positions: Uint8Array | undefined } {
  const cids: number[] = [];
  const tag = cell[0];
  if (tag === READS_CANONICAL) {
    for (let at = 1; at < cell.length;) {
      const { value, nextIndex } = decodeULEB128(cell, at);
      cids.push(value);
      at = nextIndex;
    }
    return { cids, positions: undefined };
  }
  if (tag !== READS_ORDER_RAW && tag !== READS_ORDER_ZSTD) {
    throw new Error(`A \`reads\` blob has unknown tag ${tag}.`);
  }
  const count = decodeULEB128(cell, 1);
  let at = count.nextIndex;
  for (let index = 0; index < count.value; index++) {
    const { value, nextIndex } = decodeULEB128(cell, at);
    cids.push(value);
    at = nextIndex;
  }
  const order = cell.subarray(at);
  return {
    cids,
    positions: tag === READS_ORDER_ZSTD ? zstdDecompressSync(order) : order,
  };
}

/**
 * The client's order of confirmed reads as bytes: for each read in that
 * order, the zigzag-encoded difference between its position in canonical
 * order and the previous read's (0 before the first), as a varint.
 */
function orderBodyOf(positions: readonly number[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let previous = 0;
  for (const position of positions) {
    const delta = position - previous;
    parts.push(encodeULEB128(delta >= 0 ? 2 * delta : -2 * delta - 1));
    previous = position;
  }
  return concatBytes(parts);
}

/** The `reads` tag and order bytes: raw, or a zstd frame when strictly smaller. */
function readsOrderTagged(
  body: Uint8Array,
): { tag: Uint8Array; order: Uint8Array } {
  if (body.length >= COMPRESS_MIN_BYTES) {
    const frame = zstdCompressSync(body, {
      params: { [constants.ZSTD_c_compressionLevel]: 3 },
    });
    if (frame.length < body.length) {
      return { tag: Uint8Array.of(READS_ORDER_ZSTD), order: frame };
    }
  }
  return { tag: Uint8Array.of(READS_ORDER_RAW), order: body };
}

/**
 * The canonical positions {@link orderBodyOf} wrote, checked to be a
 * permutation of `count` positions.
 */
function positionsOf(body: Uint8Array, count: number): number[] {
  const positions: number[] = [];
  const seen = new Uint8Array(count);
  let previous = 0;
  for (let at = 0; at < body.length;) {
    const { value, nextIndex } = decodeULEB128(body, at);
    at = nextIndex;
    const position = previous +
      (value % 2 === 0 ? value / 2 : -(value + 1) / 2);
    if (position < 0 || position >= count || seen[position] === 1) {
      throw new Error(
        "A `reads` blob's order is not a permutation of its reads.",
      );
    }
    seen[position] = 1;
    positions.push(position);
    previous = position;
  }
  if (positions.length !== count) {
    throw new Error(
      "A `reads` blob's order is not a permutation of its reads.",
    );
  }
  return positions;
}

/** Tags a body as raw or as a zstd frame, whichever is strictly smaller. */
function originalBlobOf(body: Uint8Array): Uint8Array {
  if (body.length >= COMPRESS_MIN_BYTES) {
    const frame = zstdCompressSync(body, {
      params: { [constants.ZSTD_c_compressionLevel]: 3 },
    });
    if (frame.length < body.length) {
      return concatBytes([Uint8Array.of(ORIGINAL_ZSTD), frame]);
    }
  }
  return concatBytes([Uint8Array.of(ORIGINAL_RAW), body]);
}

/** The `[tree, refs]` an intact row's `original` blob holds. */
function parseBody(original: Uint8Array): [JsonRecord, PayloadRef[]] {
  const payload = original.subarray(1);
  const json = utf8Decode(
    original[0] === ORIGINAL_ZSTD ? zstdDecompressSync(payload) : payload,
  );
  const body = JSON.parse(json) as [JsonRecord, PayloadRef[]];
  if (!Array.isArray(body) || !isRecord(body[0]) || !Array.isArray(body[1])) {
    throw new Error("A commit body is not `[tree, refs]`.");
  }
  return body;
}

/**
 * Which member of an operation holds a payload the body may leave out:
 * `value` of a `set`, `patches` of a `patch`, each only when present.
 */
function payloadMemberOf(
  operation: unknown,
): "value" | "patches" | undefined {
  if (!isRecord(operation)) return undefined;
  if (operation.op === "set" && Object.hasOwn(operation, "value")) {
    return "value";
  }
  if (operation.op === "patch" && Object.hasOwn(operation, "patches")) {
    return "patches";
  }
  return undefined;
}

/** A copy of `record` with its members in the codec's UTF-8 key order. */
function inKeyOrder(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    utf8SortedKeysOf(record).map((key) => [key, record[key]]),
  );
}

/** Whether `value` is a JSON object (not an array, not `null`). */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is an integer a varint of this format carries. */
function isVarint(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 &&
    (value as number) <= MAX_VARINT;
}

/** `JSON.parse(json)`, or `undefined` when `json` is not JSON. */
function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** `fromBase64url(text)`, or `undefined` when `text` is not base64url. */
function fromBase64urlOrUndefined(text: string): Uint8Array | undefined {
  try {
    const bytes = fromBase64url(text);
    return toUnpaddedBase64url(bytes) === text ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Whether two byte arrays hold the same bytes. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** The bytes of `parts`, one after another. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
