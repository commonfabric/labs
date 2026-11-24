// A SqliteDb cell can be scoped (space/user/session). For a non-`space` scope
// the server folds the request's principal (user) / session id (session) into
// the on-disk filename, so each user / each session gets its own cell-db file —
// matching how the rest of the memory system partitions scoped data. `space`
// scope (or an absent scope) keeps the original unqualified file (no migration).
//
// These tests drive the real protocol path (transact write fold + sqlite.query
// read) so they exercise `#cellDbPath` / `#attachCommitSqliteDbs` end to end.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Server } from "../v2/server.ts";
import { connect, loopback } from "../v2/client.ts";
import { table } from "../v2/sqlite/schema.ts";
import type { CellScope, SqliteDbRef } from "../v2.ts";
import { testSessionOpenAuth } from "./v2-auth-test-helpers.ts";
import { authorizeLoopbackSessionOpen } from "../v2/session-open-auth.ts";

const SPACE = "did:key:z6Mk-sqlite-scope-test";
const ALICE = "did:key:z6Mk-alice";
const BOB = "did:key:z6Mk-bob";

const TABLES = { notes: table({ id: "integer primary key", body: "text" }) };

describe("sqlite cell-db scope (per-user / per-session files)", () => {
  let server: Server;
  let dbId: string;

  beforeEach(() => {
    dbId = `of:scope-db-${crypto.randomUUID()}`;
    server = new Server({
      store: new URL("memory://sqlite-scope-test"),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: testSessionOpenAuth,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  // Open a session bound to `principal` with an explicit `sessionId`.
  const openSession = async (sessionId: string, principal: string) => {
    const client = await connect({ transport: loopback(server) });
    const session = await client.mount(
      SPACE,
      { sessionId },
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal },
      }),
    );
    return { client, session };
  };

  const dbRef = (scope?: CellScope): SqliteDbRef => ({
    id: dbId,
    tables: TABLES,
    scope,
  });

  let seq = 1;
  // deno-lint-ignore no-explicit-any
  const insert = (session: any, db: SqliteDbRef, body: string) =>
    session.transact({
      localSeq: seq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "sqlite",
        db,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: [body],
      }],
    });
  // deno-lint-ignore no-explicit-any
  const bodies = async (session: any, db: SqliteDbRef): Promise<string[]> => {
    const r = await session.sqliteQuery(
      db,
      "SELECT body FROM notes ORDER BY id",
    );
    return (r.rows as { body: string }[]).map((row) => row.body);
  };

  it("isolates a user-scoped db per principal (same id, same space)", async () => {
    const a = await openSession("session:a", ALICE);
    const b = await openSession("session:b", BOB);
    try {
      const db = dbRef("user");
      // Alice and Bob write to the SAME (space, id, scope) — only the principal
      // differs — and must not see each other's rows.
      await insert(a.session, db, "alice-note");
      await insert(b.session, db, "bob-note");
      expect(await bodies(a.session, db)).toEqual(["alice-note"]);
      expect(await bodies(b.session, db)).toEqual(["bob-note"]);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it("isolates a session-scoped db per session (same principal)", async () => {
    const s1 = await openSession("session:one", ALICE);
    const s2 = await openSession("session:two", ALICE);
    try {
      const db = dbRef("session");
      await insert(s1.session, db, "one");
      await insert(s2.session, db, "two");
      expect(await bodies(s1.session, db)).toEqual(["one"]);
      expect(await bodies(s2.session, db)).toEqual(["two"]);
    } finally {
      await s1.client.close();
      await s2.client.close();
    }
  });

  it("shares a space-scoped db across principals and sessions", async () => {
    const a = await openSession("session:a", ALICE);
    const b = await openSession("session:b", BOB);
    try {
      const db = dbRef("space");
      await insert(a.session, db, "shared-by-alice");
      // Bob (different principal & session) reads the same space-scoped file.
      expect(await bodies(b.session, db)).toEqual(["shared-by-alice"]);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it("treats an absent scope identically to `space` (no per-user file)", async () => {
    const a = await openSession("session:a", ALICE);
    const b = await openSession("session:b", BOB);
    try {
      // Write with no scope (legacy path), read back with explicit space scope:
      // same file, so the row is visible — confirming space scope is unqualified.
      await insert(a.session, dbRef(undefined), "legacy");
      expect(await bodies(b.session, dbRef("space"))).toEqual(["legacy"]);
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it("keeps user and space scopes in separate files for one principal", async () => {
    const a = await openSession("session:a", ALICE);
    try {
      await insert(a.session, dbRef("space"), "space-row");
      await insert(a.session, dbRef("user"), "user-row");
      // Same id, same principal — but distinct scope ⇒ distinct files.
      expect(await bodies(a.session, dbRef("space"))).toEqual(["space-row"]);
      expect(await bodies(a.session, dbRef("user"))).toEqual(["user-row"]);
    } finally {
      await a.client.close();
    }
  });
});
