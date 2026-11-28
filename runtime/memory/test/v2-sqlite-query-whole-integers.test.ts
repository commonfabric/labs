/**
 * The server's `sqlite.query` verb returns a stored INTEGER whole for a
 * database that declares no labels, which is the read every ordinary pattern
 * query makes.
 *
 * The pool's own test establishes what its connection returns. This one takes
 * the value the rest of the way a client sees it: written by a folded `sqlite`
 * operation in a commit, read by the server's unlabeled query path, and
 * carried over the wire codec. The timestamp is the one a Topics board stored
 * as a topic's last activity and read back as -271580728.
 */

import { expect } from "@std/expect";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { table } from "../v2/sqlite/schema.ts";
import type { SqliteDbRef } from "../v2.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-sqlite-query-whole-integers-test";
const LAST_ACTIVITY_AT = 1795024749000;

describe("sqlite.query over a stored INTEGER", () => {
  let server: Server;
  let client: Awaited<ReturnType<typeof connect>>;
  // deno-lint-ignore no-explicit-any
  let session: any;
  let db: SqliteDbRef;
  let localSeq: number;

  beforeEach(async () => {
    // A fresh id per case, so the cell database file of one case is not read
    // by another.
    db = {
      id: `of:whole-integers-${crypto.randomUUID()}`,
      tables: {
        topics: table({
          id: "integer primary key",
          last_activity_at: "integer",
        }),
      },
    };
    localSeq = 1;
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://sqlite-query-whole-integers-test"),
      acl: { mode: "off", delegatingDids: [TEST_SESSION_OPEN_PRINCIPAL] },
    });
    client = await connect({ transport: loopback(server) });
    session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  const write = (sql: string, params?: ReadonlyArray<unknown>) =>
    session.transact({
      localSeq: localSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "sqlite", db, sql, params }],
    });

  it("returns an epoch-millisecond timestamp bound as a parameter", async () => {
    await write("INSERT INTO topics (id, last_activity_at) VALUES (1, ?)", [
      LAST_ACTIVITY_AT,
    ]);
    const { rows } = await session.sqliteQuery(
      db,
      "SELECT last_activity_at FROM topics",
    );
    expect(rows).toEqual([{ last_activity_at: LAST_ACTIVITY_AT }]);
  });

  it("returns an epoch-millisecond timestamp written as a literal", async () => {
    // A literal leaves how a parameter is bound out of what the row holds, and
    // the text SQLite renders shows the stored value beside the one read.

    await write(
      "INSERT INTO topics (id, last_activity_at) VALUES (1, 1795024749000)",
    );
    const { rows } = await session.sqliteQuery(
      db,
      "SELECT last_activity_at, CAST(last_activity_at AS TEXT) AS digits, " +
        "max(last_activity_at) AS newest FROM topics",
    );
    expect(rows).toEqual([{
      last_activity_at: LAST_ACTIVITY_AT,
      digits: "1795024749000",
      newest: LAST_ACTIVITY_AT,
    }]);
  });

  it("returns a value past 2^53 as a `bigint`", async () => {
    await write(
      "INSERT INTO topics (id, last_activity_at) VALUES (1, 9007199254740993)",
    );
    const { rows } = await session.sqliteQuery(
      db,
      "SELECT last_activity_at FROM topics",
    );
    expect(rows).toEqual([{ last_activity_at: 9007199254740993n }]);
  });

  it("returns a value within 32 bits as the same `number`", async () => {
    await write(
      "INSERT INTO topics (id, last_activity_at) VALUES (1, 7), (2, -7)",
    );
    const { rows } = await session.sqliteQuery(
      db,
      "SELECT last_activity_at FROM topics ORDER BY id",
    );
    expect(rows).toEqual([{ last_activity_at: 7 }, { last_activity_at: -7 }]);
  });
});
