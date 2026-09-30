// End-to-end test of the sqlite.query / sqlite.execute protocol verbs over the
// in-process loopback transport (same protocol as the real websocket). Proves
// the server handlers, ATTACH + ensureTables, the statement guard, and cell-db
// persistence work through the wire, without a real toolshed.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { parseClientMessage, Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import { cfLink, table } from "../v2/sqlite/schema.ts";
import { all, match, principal } from "../v2/sqlite/row-label.ts";
import { encodeMemoryBoundary, type SqliteDbRef } from "../v2.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-sqlite-protocol-test";

// Unique db id per test so the (deterministic, persistent) cell-db file does not
// leak data across tests or across suite runs.
let dbId: string;
const dbRef = (): SqliteDbRef => ({
  id: dbId,
  tables: {
    messages: table({
      id: "integer primary key",
      author_cf_link: cfLink(),
      body: "text",
      payload: "blob",
    }),
  },
});

describe("sqlite protocol verbs (loopback)", () => {
  let server: Server;
  let client: Awaited<ReturnType<typeof connect>>;
  // deno-lint-ignore no-explicit-any
  let session: any;

  beforeEach(async () => {
    dbId = `of:test-db-${crypto.randomUUID()}`;
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://sqlite-protocol-test"),
      acl: { mode: "off", delegatingDids: [TEST_SESSION_OPEN_PRINCIPAL] },
    });
    client = await connect({ transport: loopback(server) });
    session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  // Seed rows through the real write path (a folded `sqlite` op in a transact
  // commit, applied atomically by the engine) — there is no standalone write RPC.
  let seedSeq = 1000;
  const seedRows = (
    db: SqliteDbRef,
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) =>
    session.transact({
      localSeq: seedSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "sqlite", db, sql, params }],
    });

  it("refuses reader carriage when the connected server lacks the capability", async () => {
    const flags = client.serverFlags!;
    const advertised = flags.sqliteQueryReader;
    delete flags.sqliteQueryReader;
    try {
      await expect(session.sqliteQuery(dbRef(), "SELECT 1", undefined, {
        principal: SPACE,
      })).rejects.toThrow(
        "server does not support carried reader authorization",
      );
    } finally {
      flags.sqliteQueryReader = advertised;
    }
  });

  it("preserves the carried reader when selecting a scoped database over the wire", async () => {
    const db = { ...dbRef(), scope: "user" as const };
    await seedRows(db, "INSERT INTO messages (body) VALUES (?)", [
      "reader's rows",
    ]);
    const own = await session.sqliteQuery(
      db,
      "SELECT body FROM messages",
      undefined,
      {
        principal: TEST_SESSION_OPEN_PRINCIPAL,
      },
    );
    expect(own.rows).toEqual([{ body: "reader's rows" }]);
    const other = await session.sqliteQuery(
      db,
      "SELECT body FROM messages",
      undefined,
      {
        principal: "did:key:another-reader",
      },
    );
    expect(other.rows).toEqual([]);
    await expect(
      session.sqliteQuery(
        { ...db, scope: "session" },
        "SELECT body FROM messages",
        undefined,
        {
          principal: TEST_SESSION_OPEN_PRINCIPAL,
        },
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed reader carriage at the protocol boundary", () => {
    const base = {
      type: "sqlite.query",
      requestId: "reader-parse",
      space: SPACE,
      sessionId: "session",
      db: dbRef(),
      sql: "SELECT 1",
    };
    for (
      const reader of [null, {}, { principal: "" }, { principal: 1 }, {
        principal: SPACE,
        sessionId: "",
      }, { principal: SPACE, sessionId: 1 }]
    ) {
      expect(parseClientMessage(encodeMemoryBoundary({ ...base, reader })))
        .toBeNull();
    }
    const reader = { principal: SPACE, sessionId: "reader-session" };
    expect(parseClientMessage(encodeMemoryBoundary({ ...base, reader })))
      .toMatchObject({ reader });
  });

  it("writes (folded commit) then reads back over the protocol", async () => {
    const db = dbRef();
    await seedRows(
      db,
      "INSERT INTO messages (author_cf_link, body) VALUES (?, ?)",
      ["sigil-link", "hello"],
    );

    const r = await session.sqliteQuery(
      db,
      "SELECT body FROM messages ORDER BY id",
    );
    expect(r.rows).toEqual([{ body: "hello" }]);
  });

  it("round-trips BLOB binds and rows over the memory protocol", async () => {
    const db = dbRef();
    const payload = new FabricBytes(new Uint8Array([0, 1, 2, 255]));
    await seedRows(
      db,
      "INSERT INTO messages (body, payload) VALUES (?, ?)",
      ["binary", payload],
    );

    const result = await session.sqliteQuery(
      db,
      "SELECT payload FROM messages WHERE payload = ?",
      [payload],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.payload).toBeInstanceOf(FabricBytes);
    expect((result.rows[0]!.payload as FabricBytes).slice()).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
  });

  it("round-trips reserved SQLite column names over the memory protocol", async () => {
    const db = dbRef();
    await seedRows(
      db,
      "INSERT INTO messages (body) VALUES (?)",
      ["key-safe"],
    );

    const params = Object.fromEntries([
      ["constructor", 1],
      ["__proto__", 2],
    ]);
    const result = await session.sqliteQuery(
      db,
      'SELECT :constructor AS "constructor", :__proto__ AS "__proto__" ' +
        "FROM messages",
      params,
    );

    expect(result.rows).toHaveLength(1);
    expect(Object.hasOwn(result.rows[0]!, "constructor")).toBe(true);
    expect(Object.hasOwn(result.rows[0]!, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(result.rows[0]!, "constructor")?.value,
    )
      .toBe(1);
    expect(Object.getOwnPropertyDescriptor(result.rows[0]!, "__proto__")?.value)
      .toBe(2);
  });

  it("binds nested BLOB values as JSON byte arrays", async () => {
    const db = dbRef();
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    await seedRows(db, "INSERT INTO messages (body) VALUES (?)", ["json"]);

    const result = await session.sqliteQuery(
      db,
      "SELECT :payload AS value FROM messages",
      { payload: { bytes, nested: [new FabricBytes(new Uint8Array([4, 5]))] } },
    );

    expect(JSON.parse(result.rows[0]!.value as string)).toEqual({
      bytes: [1, 2, 3],
      nested: [[4, 5]],
    });
  });

  it("returns an empty result for an auto-created (empty) table", async () => {
    const r = await session.sqliteQuery(dbRef(), "SELECT * FROM messages");
    expect(r.rows).toEqual([]);
  });

  it("enforces the statement guard over the protocol", async () => {
    const db = dbRef();
    // write statement through the read verb
    await expect(
      session.sqliteQuery(db, "INSERT INTO messages (body) VALUES ('x')"),
    )
      .rejects.toThrow();
    // core-table reference
    await expect(session.sqliteQuery(db, "SELECT * FROM commit")).rejects
      .toThrow();
    // DDL through the folded write path aborts the commit.
    await expect(seedRows(db, "DROP TABLE messages")).rejects.toThrow();
  });

  it("applies a sqlite write folded into a transact commit (atomic path)", async () => {
    const db = dbRef();
    // A commit with a cell `set` AND a `sqlite` op — the server attaches the
    // cell-db before applyCommit and the engine runs the write inside the same
    // transaction.
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:entity-x", value: { value: { ok: true } } },
        {
          op: "sqlite",
          db,
          sql: "INSERT INTO messages (body) VALUES (?)",
          params: ["folded"],
        },
      ],
    });
    const r = await session.sqliteQuery(db, "SELECT body FROM messages");
    expect(r.rows).toEqual([{ body: "folded" }]);
  });

  it("caps the folded-write statement length (DoS bound on the write path)", async () => {
    // The sqlite.query parse branch caps sql at 100k; the folded-write path must
    // too (it rides transact, parsed loosely). An over-long folded statement is
    // rejected before the guard tokenizes it.
    const db = dbRef();
    const hugeSql = "INSERT INTO messages (body) VALUES ('" +
      "x".repeat(100_001) + "')";
    await expect(seedRows(db, hugeSql)).rejects.toThrow();
  });

  it("isolates concurrent folded commits to two cell-dbs in one space (B1)", async () => {
    // Two folded commits to DISTINCT cell-dbs in the SAME space, fired
    // concurrently over two connections (the engine/Database is shared per
    // space). The fix detaches each cell-db before the post-commit await, so the
    // ≤1-attached invariant holds and neither write leaks into the other db.
    const client2 = await connect({ transport: loopback(server) });
    const session2 = await client2.mount(
      SPACE,
      {},
      testSessionOpenAuthFactory,
    );
    try {
      const dbA: SqliteDbRef = {
        id: `of:b1-a-${crypto.randomUUID()}`,
        tables: dbRef().tables,
      };
      const dbB: SqliteDbRef = {
        id: `of:b1-b-${crypto.randomUUID()}`,
        tables: dbRef().tables,
      };
      await Promise.all([
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:b1-x", value: { value: { ok: true } } },
            {
              op: "sqlite",
              db: dbA,
              sql: "INSERT INTO messages (body) VALUES (?)",
              params: ["A"],
            },
          ],
        }),
        session2.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:b1-y", value: { value: { ok: true } } },
            {
              op: "sqlite",
              db: dbB,
              sql: "INSERT INTO messages (body) VALUES (?)",
              params: ["B"],
            },
          ],
        }),
      ]);
      expect((await session.sqliteQuery(dbA, "SELECT body FROM messages")).rows)
        .toEqual([{ body: "A" }]);
      expect((await session.sqliteQuery(dbB, "SELECT body FROM messages")).rows)
        .toEqual([{ body: "B" }]);
    } finally {
      await client2.close();
    }
  });

  it("detaches the cell-db when schema setup fails, leaving the handle usable (P2)", async () => {
    const id = `of:p2-detach-${crypto.randomUUID()}`;
    // A hostile `db.tables` payload: the sqlType fails DDL validation, so
    // ensureTables throws AFTER the cell-db is attached. The attach must be
    // cleaned up, not leaked on the shared per-space connection.
    const badDb = {
      id,
      tables: {
        messages: {
          type: "object",
          required: [],
          properties: {
            body: { type: "string", sqlType: "text); DROP TABLE x;--" },
          },
        },
      },
    } as unknown as SqliteDbRef;
    await expect(
      session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "sqlite",
            db: badDb,
            sql: "INSERT INTO messages (body) VALUES ('x')",
          },
        ],
      }),
    ).rejects.toThrow();

    // No leaked alias: a VALID write to the SAME handle id now attaches and
    // commits (previously the dangling attach would fail re-attach).
    const goodDb: SqliteDbRef = { id, tables: dbRef().tables };
    await seedRows(goodDb, "INSERT INTO messages (body) VALUES (?)", ["ok"]);
    const r = await session.sqliteQuery(goodDb, "SELECT body FROM messages");
    expect(r.rows).toEqual([{ body: "ok" }]);
  });

  it("surfaces a row-label commit violation as a terminal RowLabelCommitError (name preserved over the wire)", async () => {
    // A folded write whose committed row violates the table's row-label rule
    // (Phase 3.c commit-time re-derivation, sqlite/commit-eval.ts) is TERMINAL:
    // re-running recomputes the identical refused write. The server MUST
    // serialize the class name UNCHANGED so the runner classifies it
    // non-retryable (runner storage/rejection.ts `isTerminalRejection`).
    // Collapsing it into a generic TransactionError (the pre-fix behavior) would
    // let the doomed handler burn its retry budget and starve concurrent
    // siblings — this asserts the exact server-side serialization the runner
    // integration test otherwise only covers end-to-end.
    const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
    const ruleDb: SqliteDbRef = {
      id: `of:rowlabel-terminal-${crypto.randomUUID()}`,
      owner: SPACE,
      tables: {
        // A required-anchor sender rule: a from_addr with no address-shaped
        // match fails closed (strict-if-present) when re-derived at commit.
        emails: table(
          { id: "integer primary key", from_addr: "text", body: "text" },
          (f) => ({
            confidentiality: all(
              principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
            ),
          }),
        ),
      },
    };
    let name: string | undefined;
    try {
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "sqlite",
            db: ruleDb,
            sql: "INSERT INTO emails (from_addr, body) VALUES (?, ?)",
            params: ["not an address", "boom"],
          },
        ],
      });
    } catch (error) {
      name = (error as { name?: string }).name;
    }
    // Not "TransactionError": the terminal identity survived the wire.
    expect(name).toBe("RowLabelCommitError");
  });

  it("rolls back the whole commit when a folded sqlite op fails", async () => {
    const db = dbRef();
    await expect(session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:entity-y", value: { value: { ok: true } } },
        {
          op: "sqlite",
          db,
          sql: "INSERT INTO messages (body) VALUES (?)",
          params: ["doomed"],
        },
        { op: "sqlite", db, sql: "DROP TABLE messages" }, // guard throws -> rollback
      ],
    })).rejects.toThrow();
    // The good INSERT rolled back with the rest of the commit.
    const r = await session.sqliteQuery(
      db,
      "SELECT count(*) AS n FROM messages",
    );
    expect(r.rows).toEqual([{ n: 0 }]);
  });

  it("does not exhaust the attach limit across many cell-dbs (LRU evicts)", async () => {
    // More than SQLITE_MAX_ATTACHED distinct cell-dbs in one space; each must
    // still work (the server evicts least-recently-used attachments).
    for (let i = 0; i < 14; i++) {
      const db: SqliteDbRef = {
        id: `${dbId}-lru-${i}`,
        tables: { t: table({ id: "integer primary key", v: "text" }) },
      };
      await seedRows(db, "INSERT INTO t (v) VALUES (?)", [`${i}`]);
      const r = await session.sqliteQuery(db, "SELECT v FROM t");
      expect(r.rows).toEqual([{ v: `${i}` }]);
    }
  });

  it("persists across separate requests (cell-db is file-backed)", async () => {
    const db = dbRef();
    await seedRows(db, "INSERT INTO messages (body) VALUES (?)", ["a"]);
    await seedRows(db, "INSERT INTO messages (body) VALUES (?)", ["b"]);
    const r = await session.sqliteQuery(
      db,
      "SELECT count(*) AS n FROM messages",
    );
    expect(r.rows).toEqual([{ n: 2 }]);
  });

  it("re-runs ensureTables when the declared schema adds a table", async () => {
    const id = `of:ensure-${crypto.randomUUID()}`;
    const v1: SqliteDbRef = {
      id,
      tables: { messages: table({ id: "integer primary key", body: "text" }) },
    };
    await seedRows(v1, "INSERT INTO messages (body) VALUES (?)", ["a"]);
    // Evolve the declaration: add a NEW table. The (space,id,schema) key changes,
    // so ensureTables must re-run and create `notes` (it isn't skipped by the
    // first-write cache) — otherwise this write would fail "no such table".
    const v2: SqliteDbRef = {
      id,
      tables: {
        messages: table({ id: "integer primary key", body: "text" }),
        notes: table({ id: "integer primary key", note: "text" }),
      },
    };
    await seedRows(v2, "INSERT INTO notes (note) VALUES (?)", ["n"]);
    const r = await session.sqliteQuery(v2, "SELECT note FROM notes");
    expect(r.rows).toEqual([{ note: "n" }]);
  });

  it("surfaces a query against an UNDECLARED table (not masked as empty)", async () => {
    const db = dbRef();
    // Materialize the cell-db file (create the declared `messages` table).
    await seedRows(db, "INSERT INTO messages (body) VALUES (?)", ["a"]);
    // A query against a table that is NOT in the declared schema is a real
    // mistake (a typo here). The file exists and every declared table was
    // created on the write, so "no such table: nope" must surface — it must NOT
    // be swallowed into `[]` by the create-on-read fallback.
    await expect(session.sqliteQuery(db, "SELECT * FROM nope")).rejects
      .toThrow();
  });

  it("reads [] for a DECLARED table not yet materialized (schema evolved)", async () => {
    const id = `of:evolve-read-${crypto.randomUUID()}`;
    const v1: SqliteDbRef = {
      id,
      tables: { messages: table({ id: "integer primary key", body: "text" }) },
    };
    // Write with v1 → the file exists, but only `messages` is materialized.
    await seedRows(v1, "INSERT INTO messages (body) VALUES (?)", ["a"]);
    // Evolve the declared schema (add `notes`) and READ it before any write
    // creates it. `notes` IS declared, so it reads as a fresh, empty table — []
    // — rather than erroring.
    const v2: SqliteDbRef = {
      id,
      tables: {
        messages: table({ id: "integer primary key", body: "text" }),
        notes: table({ id: "integer primary key", note: "text" }),
      },
    };
    const r = await session.sqliteQuery(v2, "SELECT note FROM notes");
    expect(r.rows).toEqual([]);
  });

  it("reads [] for a declared-but-unmaterialized table whose name has a space", async () => {
    // Guards against the "no such table" parser truncating at whitespace: a
    // quoted table name with a space (`"my notes"`) must be matched whole
    // against the declared schema, so reading it before any write yields [].
    const id = `of:spaced-${crypto.randomUUID()}`;
    const v1: SqliteDbRef = {
      id,
      tables: { messages: table({ id: "integer primary key", body: "text" }) },
    };
    await seedRows(v1, "INSERT INTO messages (body) VALUES (?)", ["a"]);
    const v2: SqliteDbRef = {
      id,
      tables: {
        messages: table({ id: "integer primary key", body: "text" }),
        "my notes": table({ id: "integer primary key", note: "text" }),
      },
    };
    const r = await session.sqliteQuery(v2, 'SELECT note FROM "my notes"');
    expect(r.rows).toEqual([]);
  });

  it("reads [] for a declared-but-unmaterialized table queried in a different case", async () => {
    // SQLite identifiers are case-insensitive: a table declared `Notes` is
    // reachable as `notes`. Before it is materialized, reading `notes` must
    // still resolve to the declared `Notes` and return [] (not rethrow) —
    // otherwise the create-on-read contract would flip on write history.
    const id = `of:case-${crypto.randomUUID()}`;
    const v1: SqliteDbRef = {
      id,
      tables: { messages: table({ id: "integer primary key", body: "text" }) },
    };
    await seedRows(v1, "INSERT INTO messages (body) VALUES (?)", ["a"]);
    const v2: SqliteDbRef = {
      id,
      tables: {
        messages: table({ id: "integer primary key", body: "text" }),
        Notes: table({ id: "integer primary key", note: "text" }),
      },
    };
    const r = await session.sqliteQuery(v2, "SELECT note FROM notes");
    expect(r.rows).toEqual([]);
  });

  it("a pooled reader sees a write committed after its connection opened", async () => {
    const db = dbRef();
    await seedRows(db, "INSERT INTO messages (body) VALUES (?)", ["a"]);
    // First read opens + caches the pooled read-only connection (sees 1 row).
    expect(
      (await session.sqliteQuery(db, "SELECT count(*) AS n FROM messages"))
        .rows,
    ).toEqual([{ n: 1 }]);
    // A second write lands via the separate engine-attach commit path.
    await seedRows(db, "INSERT INTO messages (body) VALUES (?)", ["b"]);
    // The REUSED pooled connection must observe the newly-committed row (each
    // query is a fresh read transaction — no WAL required for this sequential
    // write-then-read pattern).
    expect(
      (await session.sqliteQuery(db, "SELECT count(*) AS n FROM messages"))
        .rows,
    ).toEqual([{ n: 2 }]);
  });
});
