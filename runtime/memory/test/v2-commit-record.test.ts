/**
 * The compact commit records of `v2/commit-record.ts`, against a minimal
 * `commit` table and a Map-backed fragment store, over synthetic commits.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { decodeULEB128 } from "@commonfabric/bytes/leb128";
import { fromBase64url } from "@commonfabric/bytes/base64url";
import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { utf8ByteLength } from "@commonfabric/text/utf8";

import {
  type ClientCommit,
  type ConfirmedRead,
  decodeTrustedMemoryBoundary,
  encodeMemoryBoundary,
  type Operation,
  type PendingRead,
} from "../v2.ts";
import {
  COMMIT_RECORD_SCHEMA,
  commitDigest,
  type CommitRecordOptions,
  CommitRecords,
  encodeResolution,
  readCommitOriginalText,
  resolutionText,
  type StoredCommitCells,
} from "../v2/commit-record.ts";
import {
  type FragmentStore,
  VALUE_STORE_SCHEMA,
  ValueStore,
} from "../v2/value-store.ts";

const COMMIT_TABLE = `
CREATE TABLE "commit" (
  seq        INTEGER PRIMARY KEY,
  session_id TEXT,
  original   JSON NOT NULL,
  resolution JSON NOT NULL,
  digest     BLOB,
  reads      BLOB
);
`;

/** A fragment store held in two maps, which dedups equal fragments. */
class MapFragments implements FragmentStore {
  readonly #byText = new Map<string, number>();
  readonly #byVid = new Map<number, string>();

  /** Fragments stored, each counted once. */
  get size(): number {
    return this.#byVid.size;
  }

  /** @inheritDoc */
  storeFragment(json: string): number {
    let vid = this.#byText.get(json);
    if (vid === undefined) {
      vid = this.#byVid.size + 1;
      this.#byText.set(json, vid);
      this.#byVid.set(vid, json);
    }
    return vid;
  }

  /** @inheritDoc */
  fragmentText(vid: number): string {
    const text = this.#byVid.get(vid);
    if (text === undefined) throw new Error(`No fragment ${vid}.`);
    return text;
  }
}

/** A database, its fragment store and its records, as each case uses them. */
type Fixture = {
  db: Database;
  fragments: FragmentStore;
  records: CommitRecords;
};

/** Builds a fixture over an in-memory database. */
function fixtureOf(
  options?: CommitRecordOptions,
  fragments: FragmentStore = new MapFragments(),
): Fixture {
  const db = new Database(":memory:");
  db.exec(COMMIT_TABLE);
  db.exec(COMMIT_RECORD_SCHEMA);
  return { db, fragments, records: new CommitRecords(db, fragments, options) };
}

/** Encodes `text` at `seq`, writes the row, and returns the row as SQLite gives it back. */
function writeCommit(
  { db, records }: Fixture,
  seq: number,
  text: string,
  sessionId = "session:synthetic",
): StoredCommitCells & { keptText?: string } {
  const encoded = records.encode(text, { seq, sessionId });
  db.prepare(
    `INSERT INTO "commit" (seq, session_id, original, resolution, digest, reads)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    sessionId,
    encoded.original,
    encodeMemoryBoundary({ seq }),
    encoded.digest,
    encoded.reads,
  );
  return { ...readRow(db, seq), keptText: encoded.keptText };
}

/** The stored cells of commit `seq`. */
function readRow(db: Database, seq: number): StoredCommitCells {
  return db.prepare(
    `SELECT seq, session_id, original, digest, reads FROM "commit" WHERE seq = ?`,
  ).get<StoredCommitCells>(seq)!;
}

/** A small deterministic generator (mulberry32). */
function randomOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Synthetic commits and values drawn from one seeded generator. */
class Generator {
  readonly #random: () => number;

  /** Constructs an instance drawing from `seed`. */
  constructor(seed: number) {
    this.#random = randomOf(seed);
  }

  /** An integer in `[0, n)`. */
  int(n: number): number {
    return Math.floor(this.#random() * n);
  }

  /** One of `items`. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  /** Whether an event of probability `p` happens. */
  chance(p: number): boolean {
    return this.#random() < p;
  }

  /** A string with awkward characters, of about `length` code units. */
  text(length: number): string {
    const alphabet = [
      "a",
      "b",
      "z",
      " ",
      '"',
      "\\",
      "/",
      "\u0001",
      "\u0000",
      "\n",
      "\u007f",
      "é",
      "ü",
      "€",
      "😀",
      "𝄞",
      " ",
    ];
    let result = "";
    while (result.length < length) result += this.pick(alphabet);
    return result;
  }

  /** A FabricValue of bounded depth with awkward members. */
  value(depth: number): FabricValue {
    const kind = depth <= 0 ? this.int(4) : this.int(7);
    switch (kind) {
      case 0:
        return this.text(this.int(3) === 0 ? this.int(120) : this.int(8));
      case 1:
        return this.pick([
          0,
          -0,
          1,
          -1,
          0.5,
          Number.MAX_SAFE_INTEGER,
          Number.MIN_SAFE_INTEGER,
          1e21,
          5e-324,
          Number.MAX_VALUE,
          -1.5e-7,
          NaN,
          Infinity,
        ]);
      case 2:
        return this.pick([true, false, null]);
      case 3:
        return this.pick([[], {}, ""]);
      case 4:
      case 5: {
        const record: Record<string, FabricValue> = {};
        const n = this.int(6);
        for (let i = 0; i < n; i++) {
          const key = this.pick(["a", "b", "ä", "/x", "10", "9", "k" + i]);
          record[key] = this.chance(0.05) ? undefined : this.value(depth - 1);
        }
        return record;
      }
      default: {
        const n = this.int(6);
        return Array.from({ length: n }, () => this.value(depth - 1));
      }
    }
  }

  /** A confirmed read of `id`, `scope` at `seq`, with optional members. */
  confirmedRead(id: string, scope: string | undefined, seq: number) {
    const read: Record<string, unknown> = {
      id,
      path: Array.from(
        { length: this.int(4) },
        () => this.pick(["value", "items", "0", "title", "x/y", "ünï"]),
      ),
      seq,
    };
    if (scope !== undefined) read.scope = scope;
    if (this.chance(0.2)) read.branch = this.pick(["", "feature"]);
    if (this.chance(0.3)) read.nonRecursive = true;
    return read as unknown as ConfirmedRead;
  }

  /** A synthetic commit; with `clash`, one document is read at two seqs. */
  commit(clash = false): ClientCommit {
    const sizes = [this.int(20), 20 + this.int(280), 300 + this.int(1700)];
    const count = this.chance(0.05)
      ? sizes[2]!
      : this.chance(0.25)
      ? sizes[1]!
      : sizes[0]!;
    const seqs = new Map<string, number>();
    const confirmed: ConfirmedRead[] = [];
    for (let i = 0; i < count; i++) {
      const id = `of:synthetic-${this.int(count + 40).toString(36)}`;
      const scope = this.pick([undefined, "space", "user", "session"]);
      const key = `${id} ${scope ?? "space"}`;
      let seq = seqs.get(key);
      if (seq === undefined) {
        seq = this.int(5000);
        seqs.set(key, seq);
      }
      confirmed.push(this.confirmedRead(id, scope, seq));
    }
    if (clash && confirmed.length > 0) {
      const first = confirmed[0]!;
      confirmed.push({ ...first, seq: first.seq + 1 });
    }
    const pending: PendingRead[] = Array.from(
      { length: this.int(4) },
      () => {
        const read: Record<string, unknown> = {
          id: `of:pending-${this.int(50)}`,
          path: ["value"],
          localSeq: this.chance(0.5) ? this.int(9) : [this.int(9), this.int(9)],
        };
        if (this.chance(0.5)) read.basisSeq = this.int(100);
        if (this.chance(0.3)) read.scope = "user";
        if (this.chance(0.3)) read.nonRecursive = true;
        return read as unknown as PendingRead;
      },
    );
    const operations: Operation[] = Array.from(
      { length: this.int(6) },
      () => this.operation(),
    );
    const commit: Record<string, unknown> = {
      localSeq: this.int(1000),
      reads: { confirmed, pending },
      operations,
    };
    if (this.chance(0.2)) {
      commit.preconditions = [
        { kind: "origin-committed", originLocalSeq: this.int(9) },
        { kind: "entity-value-hash", id: "of:pre", valueHash: null },
      ];
    }
    if (this.chance(0.05)) {
      commit.genesisRoot = { cause: "synthetic-cause" };
    }
    if (this.chance(0.2)) commit.codeCID = "synthetic-code-cid";
    if (this.chance(0.2)) commit.branch = "feature";
    if (this.chance(0.1)) {
      commit.merge = {
        sourceBranch: "feature",
        sourceSeq: 4,
        baseBranch: "",
        baseSeq: 2,
      };
    }
    if (this.chance(0.1)) {
      commit.eventAppends = [{ id: "of:stream", eventId: "event-1" }];
    }
    return commit as unknown as ClientCommit;
  }

  /** One operation of any kind, with a payload above or below 64 bytes. */
  operation(): Operation {
    const id = `of:op-${this.int(30)}`;
    switch (this.int(5)) {
      case 0:
        return { op: "set", id, value: { value: this.value(4) } };
      case 1:
        return {
          op: "patch",
          id,
          patches: [
            { op: "replace", path: "/value/a", value: this.value(3) },
            { op: "append", path: "/value/list", values: [this.value(2)] },
          ],
        } as Operation;
      case 2:
        return { op: "delete", id, scope: "session" };
      case 3:
        return {
          op: "sqlite",
          db: { id: "of:db" },
          sql: "INSERT INTO t (a) VALUES (?)",
          params: [this.value(1)],
        } as Operation;
      default:
        return {
          op: "apply-op",
          id,
          path: ["value", "text"],
          codec: "synthetic@1",
          submissionId: "s-1",
          payload: this.value(3),
        } as unknown as Operation;
    }
  }
}

/** A commit with the given confirmed reads and nothing else. */
function commitReading(confirmed: ConfirmedRead[]): ClientCommit {
  return {
    localSeq: 1,
    reads: { confirmed, pending: [] },
    operations: [],
  };
}

/** A confirmed read of `id` at `seq` with path `["value"]`. */
function readOf(id: string, seq: number, scope?: "user"): ConfirmedRead {
  return {
    id,
    path: ["value"],
    seq,
    ...(scope === undefined ? {} : { scope }),
  } as unknown as ConfirmedRead;
}

describe("commit-record", () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixtureOf();
  });

  afterEach(() => {
    f.records.close();
    f.db.close();
  });

  describe("CommitRecords", () => {
    describe("instance members", () => {
      describe("encode() and originalText()", () => {
        it("reads back 500 generated commits exactly, their confirmed reads in the client's order", () => {
          const generate = new Generator(0xC0FFEE);
          let compact = 0;
          let chunked = 0;
          let reordered = 0;
          for (let seq = 2; seq < 502; seq++) {
            const commit = generate.commit(seq % 37 === 0);
            const text = encodeMemoryBoundary(commit);
            const row = writeCommit(f, seq, text);
            if (typeof row.original !== "string") compact++;
            if (row.reads !== null) chunked++;
            if (row.reads !== null && row.reads[0] !== 0x00) reordered++;
            const decoded = f.records.originalText(row);
            expect(decoded).toBe(text);
            expect(decodeTrustedMemoryBoundary(decoded)).toEqual(commit);
          }
          expect(compact).toBe(500);
          expect(chunked).toBeGreaterThan(450);
          expect(reordered).toBeGreaterThan(0);
          expect(reordered).toBeLessThan(chunked);
          expect(f.records.stats().keptText).toBe(0);
          expect(f.records.stats().payloadRefs).toBeGreaterThan(0);
        });

        it("reads back awkward payloads exactly, storing a payload as a fragment only from 64 bytes", () => {
          const fragments = new MapFragments();
          const local = fixtureOf(undefined, fragments);
          try {
            // `{"value":"<s>"}` is 12 bytes plus the string's.
            const sized = (bytes: number): Operation => ({
              op: "set",
              id: "of:sized",
              value: { value: "x".repeat(bytes - 12) },
            });
            const deep = (n: number): FabricValue =>
              n === 0 ? [] : [deep(n - 1)];
            const payloads: Operation[] = [
              sized(63),
              sized(64),
              sized(65),
              { op: "set", id: "of:empty", value: {} },
              { op: "set", id: "of:empty-list", value: { value: [] } },
              {
                op: "set",
                id: "of:control",
                value: { value: '\u0001\u0000\u001f"\\ ref \u0001 byte' },
              },
              { op: "set", id: "of:deep", value: { value: deep(60) } },
              {
                op: "set",
                id: "of:numbers",
                value: {
                  value: [
                    -0,
                    5e-324,
                    Number.MAX_VALUE,
                    Number.MAX_SAFE_INTEGER,
                    NaN,
                    -Infinity,
                    1e21,
                  ],
                },
              },
              { op: "patch", id: "of:empty-patch", patches: [] },
            ];
            const commit: ClientCommit = {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: payloads,
            };
            const text = encodeMemoryBoundary(commit);
            const row = writeCommit(local, 2, text);
            expect(local.records.originalText(row)).toBe(text);
            expect(row.reads).toEqual(Uint8Array.of(0x00));
            const stored = local.records.references(row).vids.map((vid) =>
              fragments.fragmentText(vid)
            );
            expect(stored.map((json) => utf8ByteLength(json))).toEqual(
              stored.map((json) => Math.max(64, utf8ByteLength(json))),
            );
            expect(stored).toContain(JSON.stringify({ value: "x".repeat(52) }));
            expect(stored).toContain(JSON.stringify({ value: "x".repeat(53) }));
            expect(stored).not.toContain(
              JSON.stringify({ value: "x".repeat(51) }),
            );
          } finally {
            local.records.close();
            local.db.close();
          }
        });

        it("stores identical payloads, dictionary rows and chunks once", () => {
          const fragments = new MapFragments();
          const local = fixtureOf(undefined, fragments);
          try {
            const commit = new Generator(7).commit();
            commit.operations.push({
              op: "set",
              id: "of:big",
              value: { value: "y".repeat(200) },
            });
            const text = encodeMemoryBoundary(commit);
            writeCommit(local, 2, text);
            const count = (table: string) =>
              local.db.prepare(`SELECT count(*) AS n FROM ${table}`).get<
                { n: number }
              >()!.n;
            const before = [
              count("mem_entity"),
              count("mem_read_shape"),
              count("mem_read_chunk"),
              fragments.size,
            ];
            const again = writeCommit(local, 3, text);
            expect([
              count("mem_entity"),
              count("mem_read_shape"),
              count("mem_read_chunk"),
              fragments.size,
            ]).toEqual(before);
            expect(local.records.originalText(again)).toBe(text);
          } finally {
            local.records.close();
            local.db.close();
          }
        });

        it("keeps a commit with two reads of one `(id, scope)` at different seqs verbatim, and chunks one id read in two scopes", () => {
          const clash = encodeMemoryBoundary(commitReading([
            readOf("of:b", 5),
            readOf("of:a", 1),
            readOf("of:b", 6),
          ]));
          const clashRow = writeCommit(f, 2, clash);
          expect(typeof clashRow.original).not.toBe("string");
          expect(clashRow.reads).toBe(null);
          expect(f.records.originalText(clashRow)).toBe(clash);
          expect(f.records.stats().readsVerbatim).toBe(1);

          const scoped = commitReading([
            readOf("of:b", 5),
            readOf("of:a", 1),
            readOf("of:b", 6, "user"),
          ]);
          const scopedRow = writeCommit(f, 3, encodeMemoryBoundary(scoped));
          expect(scopedRow.reads).not.toBe(null);
          expect(f.records.originalText(scopedRow)).toBe(
            encodeMemoryBoundary(scoped),
          );
        });

        it("keeps the client's order of confirmed reads, storing an order only when it is not the canonical one", () => {
          // Entity ids are handed out in order of first sight, so reads of
          // ids first seen in this order are in canonical order.
          const ids = Array.from(
            { length: 600 },
            (_, i) => `of:order-${String(i).padStart(4, "0")}`,
          );
          const inOrder = ids.map((id, i) => readOf(id, i + 1));
          const canonicalRow = writeCommit(
            f,
            2,
            encodeMemoryBoundary(commitReading(inOrder)),
          );
          expect(canonicalRow.reads![0]).toBe(0x00);

          // A few reads reversed: an order too short to compress.
          const reversed = commitReading(inOrder.slice(0, 5).reverse());
          const reversedRow = writeCommit(
            f,
            3,
            encodeMemoryBoundary(reversed),
          );
          expect(reversedRow.reads![0]).toBe(0x01);
          expect(f.records.originalText(reversedRow)).toBe(
            encodeMemoryBoundary(reversed),
          );

          // The same reads in a scrambled order, whose order compresses,
          // share the canonical order's chunks.
          const scrambled = commitReading(
            inOrder.map((_, i) => inOrder[(i * 7919) % inOrder.length]),
          );
          const scrambledRow = writeCommit(
            f,
            4,
            encodeMemoryBoundary(scrambled),
          );
          expect(scrambledRow.reads![0]).toBe(0x02);
          expect(f.records.originalText(scrambledRow)).toBe(
            encodeMemoryBoundary(scrambled),
          );
          expect(f.records.references(scrambledRow).cids).toEqual(
            f.records.references(canonicalRow).cids,
          );

          // Equal reads keep their places among the others.
          const repeated = commitReading(
            scrambled.reads.confirmed.concat(inOrder.slice(0, 50)),
          );
          const repeatedRow = writeCommit(
            f,
            5,
            encodeMemoryBoundary(repeated),
          );
          expect(repeatedRow.reads![0]).not.toBe(0x00);
          expect(f.records.originalText(repeatedRow)).toBe(
            encodeMemoryBoundary(repeated),
          );
        });

        it("refuses a `reads` blob whose order is not a permutation of its reads", () => {
          // Entity ids are handed out in order of first sight, so `of:p`
          // comes first in canonical order.
          const reads = [readOf("of:p", 1), readOf("of:q", 2)];
          writeCommit(f, 2, encodeMemoryBoundary(commitReading(reads)));
          const reversed = commitReading(reads.reverse());
          const row = writeCommit(f, 3, encodeMemoryBoundary(reversed));
          expect(row.reads![0]).toBe(0x01);
          // The order's last varint names the first read again.
          const forged = Uint8Array.from(row.reads!);
          forged[forged.length - 1] = 2;
          expect(() => f.records.originalText({ ...row, reads: forged }))
            .toThrow(
              "not a permutation",
            );
        });

        it("shares all chunks but one or two between read sets that differ in one read", () => {
          const reads = Array.from(
            { length: 800 },
            (_, i) => readOf(`of:chunked-${String(i).padStart(4, "0")}`, i),
          );
          const first = writeCommit(
            f,
            2,
            encodeMemoryBoundary(commitReading(reads)),
          );
          const changed = reads.map((read, i) =>
            i === 400 ? { ...read, seq: 9999 } : read
          );
          const second = writeCommit(
            f,
            3,
            encodeMemoryBoundary(commitReading(changed)),
          );
          const firstCids = f.records.references(first).cids;
          const secondCids = f.records.references(second).cids;
          expect(firstCids.length).toBeGreaterThan(3);
          expect(secondCids.length).toBe(firstCids.length);
          const shared = secondCids.filter((cid) => firstCids.includes(cid));
          expect(shared.length).toBeGreaterThanOrEqual(firstCids.length - 2);
          expect(shared.length).toBeLessThan(firstCids.length);
        });

        it("gives distinct chunks distinct cids and equal chunks one cid when every chunk hash collides", () => {
          const local = fixtureOf({
            hashForTesting: () => new Uint8Array(16),
          });
          try {
            const texts = [
              commitReading([readOf("of:p", 1)]),
              commitReading([readOf("of:q", 2)]),
              commitReading([readOf("of:p", 1)]),
            ].map((commit) => encodeMemoryBoundary(commit));
            const rows = texts.map((text, i) =>
              writeCommit(local, i + 2, text)
            );
            const cids = rows.map((row) => local.records.references(row).cids);
            expect(cids[0]).not.toEqual(cids[1]);
            expect(cids[2]).toEqual(cids[0]);
            rows.forEach((row, i) =>
              expect(local.records.originalText(row)).toBe(texts[i])
            );
            expect(local.records.stats().chunksStored).toBe(2);
            expect(local.records.stats().chunksReused).toBe(1);
          } finally {
            local.records.close();
            local.db.close();
          }
        });

        it("keeps `seq` 1 and compaction commits as text", () => {
          const text = encodeMemoryBoundary(commitReading([readOf("of:a", 1)]));
          expect(f.records.encode(text, { seq: 1, sessionId: "s" })).toEqual({
            original: text,
            digest: null,
            reads: null,
            keptText: "genesis",
          });
          expect(
            f.records.encode(text, { seq: 4, sessionId: "compaction:run" })
              .keptText,
          ).toBe("compaction");
        });

        it("keeps a text whose member name repeats as text that reads back exactly", () => {
          const text =
            'fvj1:{"localSeq":1,"localSeq":2,"operations":[],"reads":{"confirmed":[],"pending":[]}}';
          const row = writeCommit(f, 2, text);
          expect(row.keptText).toBe("no-round-trip");
          expect(f.records.originalText(row)).toBe(text);
        });

        it("reads back a payload with integer-like keys exactly", () => {
          // The codec and `JSON.parse` both enumerate `9` before `10`.
          const commit = commitReading([readOf("of:a", 1)]);
          commit.operations.push({
            op: "set",
            id: "of:a",
            value: { value: { "10": "ten".repeat(20), "9": "nine" } },
          });
          const text = encodeMemoryBoundary(commit);
          const row = writeCommit(f, 2, text);
          expect(row.keptText).toBe(undefined);
          expect(f.records.references(row).vids.length).toBe(1);
          expect(f.records.originalText(row)).toBe(text);
        });

        it("keeps reads verbatim when a `seq` is 2^32", () => {
          const text = encodeMemoryBoundary(
            commitReading([readOf("of:b", 2 ** 32), readOf("of:a", 1)]),
          );
          const row = writeCommit(f, 2, text);
          expect(row.reads).toBe(null);
          expect(f.records.originalText(row)).toBe(text);
        });
      });

      describe("hollowing markers", () => {
        const runId = "2026-01-01T00:00:00.000Z";

        beforeEach(() => {
          f.db.prepare(
            `INSERT INTO "commit" (seq, session_id, original, resolution)
             VALUES (10, ?, 'fvj1:{}', 'fvj1:{}')`,
          ).run(`compaction:${runId}`);
        });

        const markerOf = (text: string, run: string) =>
          encodeMemoryBoundary({
            hollowed: {
              hash: hashStringOf(text),
              bytes: utf8ByteLength(text),
              commitSeq: 10,
              runId: run,
            },
          });

        it("stores a marker of the compaction tool's format as tag `0x03` that reads back exactly", () => {
          const marker = markerOf('fvj1:{"payload":1}', runId);
          const row = writeCommit(f, 5, marker);
          expect(row.original).toEqual(Uint8Array.of(0x03, 10));
          expect(row.reads).toBe(null);
          expect(f.records.originalText(row)).toBe(marker);
          expect(f.records.isHollowed(row)).toBe(true);
          expect(f.records.matchesStored(row, marker)).toBe(false);
        });

        it("keeps a marker whose run id does not match its compaction commit as text", () => {
          const marker = markerOf('fvj1:{"payload":1}', "another-run");
          const row = writeCommit(f, 5, marker);
          expect(row.original).toBe(marker);
          expect(row.keptText).toBe("no-round-trip");
          expect(f.records.isHollowed(row)).toBe(true);
        });

        it("hollows a compact intact row into the marker today's tool writes for it", () => {
          const text = encodeMemoryBoundary(new Generator(3).commit());
          const intact = writeCommit(f, 5, text);
          expect(f.records.isHollowed(intact)).toBe(false);
          const hollowed = f.records.hollowCompact(intact, 10);
          const row = { ...intact, ...hollowed };
          expect(f.records.originalText(row)).toBe(markerOf(text, runId));
          expect(f.records.isHollowed(row)).toBe(true);
          expect(f.records.matchesStored(row, text)).toBe(false);
          expect(f.records.references(row)).toEqual({ vids: [], cids: [] });
        });

        it("refuses to hollow a row in today's form", () => {
          const row = writeCommit(f, 1, 'fvj1:{"genesis":true}');
          expect(() => f.records.hollowCompact(row, 10)).toThrow();
        });
      });

      describe("matchesStored()", () => {
        it("returns true for the stored text and false for one changed character, for compact and text rows", () => {
          const text = encodeMemoryBoundary(new Generator(11).commit());
          const changed = text.replace('"localSeq":', '"localSeq":1');
          const compact = writeCommit(f, 2, text);
          const plain = writeCommit(f, 3, text, "compaction:run");
          expect(typeof compact.original).not.toBe("string");
          expect(typeof plain.original).toBe("string");
          for (const row of [compact, plain]) {
            expect(f.records.matchesStored(row, text)).toBe(true);
            expect(f.records.matchesStored(row, changed)).toBe(false);
          }
        });
      });

      describe("stage() and settle()", () => {
        it("decodes an eid reused after a rolled-back stage as its new id", () => {
          const insertedEid = (id: string) =>
            f.db.prepare(`SELECT eid FROM mem_entity WHERE id = ?`).get<
              { eid: number }
            >(id)?.eid;
          f.db.exec("BEGIN IMMEDIATE");
          f.records.stage();
          writeCommit(
            f,
            2,
            encodeMemoryBoundary(commitReading([readOf("of:gone", 1)])),
          );
          const goneEid = insertedEid("of:gone");
          f.records.settle(false);
          f.db.exec("ROLLBACK");

          f.db.exec("BEGIN IMMEDIATE");
          f.records.stage();
          const text = encodeMemoryBoundary(
            commitReading([readOf("of:kept", 1)]),
          );
          const row = writeCommit(f, 2, text);
          f.records.settle(true);
          f.db.exec("COMMIT");

          expect(insertedEid("of:kept")).toBe(goneEid);
          expect(row.reads).not.toBe(null);
          expect(f.records.originalText(row)).toBe(text);

          const again = encodeMemoryBoundary(
            commitReading([readOf("of:gone", 1)]),
          );
          const againRow = writeCommit(f, 3, again);
          expect(againRow.reads).not.toBe(null);
          expect(f.records.originalText(againRow)).toBe(again);
        });

        it("caches nothing from a transaction without a stage", () => {
          f.db.exec("BEGIN IMMEDIATE");
          writeCommit(
            f,
            2,
            encodeMemoryBoundary(commitReading([readOf("of:gone", 1)])),
          );
          f.db.exec("ROLLBACK");
          const text = encodeMemoryBoundary(
            commitReading([readOf("of:kept", 1)]),
          );
          f.db.exec("BEGIN IMMEDIATE");
          const row = writeCommit(f, 2, text);
          f.db.exec("COMMIT");
          expect(row.reads).not.toBe(null);
          expect(f.records.originalText(row)).toBe(text);

          const again = encodeMemoryBoundary(
            commitReading([readOf("of:gone", 1)]),
          );
          const againRow = writeCommit(f, 3, again);
          expect(againRow.reads).not.toBe(null);
          expect(f.records.originalText(againRow)).toBe(again);
        });
      });

      describe("references()", () => {
        it("lists the fragment vids and chunk cids a row names, and nothing for a text row", () => {
          const fragments = new MapFragments();
          const local = fixtureOf(undefined, fragments);
          try {
            const commit = commitReading([readOf("of:a", 1)]);
            commit.operations.push({
              op: "set",
              id: "of:a",
              value: { value: "z".repeat(100) },
            });
            const row = writeCommit(local, 2, encodeMemoryBoundary(commit));
            const cids = local.db.prepare(`SELECT cid FROM mem_read_chunk`)
              .all<{ cid: number }>().map(({ cid }) => cid);
            expect(local.records.references(row)).toEqual({
              vids: [fragments.storeFragment(
                JSON.stringify({ value: "z".repeat(100) }),
              )],
              cids,
            });
            const text = writeCommit(local, 1, "fvj1:{}");
            expect(local.records.references(text)).toEqual({
              vids: [],
              cids: [],
            });
          } finally {
            local.records.close();
            local.db.close();
          }
        });
      });
    });
  });

  describe("commitDigest()", () => {
    it("returns `0x00`, the base64url-decoded `hashStringOf()` and the UTF-8 length", () => {
      const text = encodeMemoryBoundary(new Generator(5).commit());
      const digest = commitDigest(text);
      expect(digest[0]).toBe(0x00);
      expect(digest.subarray(1, 33)).toEqual(fromBase64url(hashStringOf(text)));
      const length = decodeULEB128(digest, 33);
      expect(length.value).toBe(utf8ByteLength(text));
      expect(length.nextIndex).toBe(digest.length);
    });
  });

  describe("encodeResolution() and resolutionText()", () => {
    it("writes `{seq}` as `0x00`, pending resolutions as `0x01`, and anything else as text, each reading back exactly", () => {
      const seqOnly = encodeMemoryBoundary({ seq: 42 });
      const pending = encodeMemoryBoundary({
        seq: 42,
        resolvedPendingReads: [{ localSeq: 3, seq: 40 }, {
          localSeq: 4,
          seq: 41,
        }],
      });
      const withOperations = encodeMemoryBoundary({
        seq: 42,
        operationResolutions: [{ operationIndex: 0 }],
      });
      const otherSeq = encodeMemoryBoundary({ seq: 41 });

      expect(encodeResolution(seqOnly, 42)).toEqual(Uint8Array.of(0x00));
      expect(encodeResolution(pending, 42)).toEqual(
        Uint8Array.of(0x01, 2, 3, 40, 4, 41),
      );
      expect(encodeResolution(withOperations, 42)).toBe(withOperations);
      expect(encodeResolution(otherSeq, 42)).toBe(otherSeq);
      for (const text of [seqOnly, pending, withOperations, otherSeq]) {
        expect(resolutionText(encodeResolution(text, 42), 42)).toBe(text);
      }
    });
  });

  describe("readCommitOriginalText()", () => {
    it("returns what `originalText()` returns", () => {
      const text = encodeMemoryBoundary(new Generator(9).commit());
      const row = writeCommit(f, 2, text);
      expect(readCommitOriginalText(f.db, f.fragments, row)).toBe(
        f.records.originalText(row),
      );
    });
  });

  describe("with the real `ValueStore`", () => {
    it("reads back generated commits whose payloads it stores", () => {
      const db = new Database(":memory:");
      db.exec(COMMIT_TABLE);
      db.exec(COMMIT_RECORD_SCHEMA);
      db.exec(VALUE_STORE_SCHEMA);
      const values = new ValueStore(db);
      const records = new CommitRecords(db, values);
      const local: Fixture = { db, fragments: values, records };
      try {
        const generate = new Generator(0xBEEF);
        db.exec("BEGIN IMMEDIATE");
        values.stage();
        records.stage();
        for (let seq = 2; seq < 82; seq++) {
          const commit = generate.commit();
          const row = writeCommit(local, seq, encodeMemoryBoundary(commit));
          expect(typeof row.original).not.toBe("string");
          expect(records.originalText(row)).toBe(
            encodeMemoryBoundary(commit),
          );
        }
        values.settle(true);
        records.settle(true);
        db.exec("COMMIT");
        expect(records.stats().payloadRefs).toBeGreaterThan(0);
      } finally {
        records.close();
        values.close();
        db.close();
      }
    });
  });
});
