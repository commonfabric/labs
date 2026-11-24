// CFC Phase 3.c: commit-time row-label re-derivation. The engine executes a
// folded `sqlite` write, reads the affected rows back by rowid, and runs the
// SHARED evaluator against each TRUE committed row — throwing (rolling back
// the WHOLE commit, cell ops included) on any rule-evaluation failure. This
// covers the shapes the runner gate cannot attribute (INSERT…SELECT, upsert,
// columnless INSERT, rule-input UPDATE); no-laundering stays runner-side.
// (Spec: docs/specs/sqlite-builtin/06-cfc.md, "server-side commit evaluation".)

import { assert, assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";

import { Database } from "@db/sqlite";

import type { Operation, SqliteDbRef, SqliteParamsWire } from "../v2.ts";
import { applyCommit, open, read } from "../v2/engine.ts";
import {
  applySqliteCommitWrite,
  MAX_ROW_LABEL_EVAL_ROWS,
  RowLabelCommitError,
} from "../v2/sqlite/commit-eval.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
  runQuery,
} from "../v2/sqlite/exec.ts";
import * as sqliteBarrel from "../v2/sqlite/mod.ts";
import {
  all,
  authoredBy,
  dbOwner,
  match,
  principal,
  whenMatches,
} from "../v2/sqlite/row-label.ts";
import { table } from "../v2/sqlite/schema.ts";

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

// The mailbox-shaped rule: sender (required anchor) ∧ recipients; integrity
// (authored-by-sender) gated on the row's auth column.
const emails = table(
  {
    id: "integer primary key",
    from_addr: "text",
    to_addrs: "text",
    auth: "text",
    body: "text",
  },
  (f) => ({
    confidentiality: all(
      principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
      principal("mailto", match(f.to_addrs, ADDR)),
    ),
    integrity: whenMatches(
      f.auth,
      /dmarc=pass/,
      authoredBy(principal("mailto", match(f.from_addr, ADDR, { min: 1 }))),
    ),
  }),
);

// Rule-less staging table in the SAME db: writes to it stay plain, and it
// feeds the INSERT…SELECT shapes.
const staging = table({
  id: "integer primary key",
  from_addr: "text",
  to_addrs: "text",
  auth: "text",
  body: "text",
});

const ownerOnly = table(
  { id: "integer primary key", note: "text" },
  () => ({ confidentiality: all(dbOwner()) }),
);

// A rule-bearing table whose column is literally named `returning`: quoted
// as an identifier it must not trip the RETURNING-clause scan.
const rtab = table(
  { id: "integer primary key", returning: "text" },
  () => ({ confidentiality: all(dbOwner()) }),
);

// A mailbox-keyed table: the rule reads an INTEGER column, and the driver
// reads an INTEGER column through a 32-bit accessor unless the read renders it
// as text. `/^7$/` under `min: 1` refuses every other id, so a truncated read
// is the difference between a refusal and a silent pass.
const mailboxes = table(
  { id: "integer primary key", source_id: "integer" },
  (f) => ({
    confidentiality: all(
      principal("mailbox", match(f.source_id, /^7$/, { min: 1 })),
      dbOwner(),
    ),
  }),
);

const TABLES = { emails, staging, ownerOnly, rtab, mailboxes };
const DB_ID = "of:commit-eval-db";
const OWNER = "did:key:owner";

const VALID = ["alice@a.example", "bob@b.example", "dmarc=pass", "hi"];
// from_addr is non-empty but yields no address-shaped match: strict-if-present
// fails closed at evaluation.
const VIOLATING = ["not an address", "bob@b.example", "", "boom"];

//
// applyCommit-level: atomic rollback with the cell ops
//

async function freshEngine() {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  return await open({ url: toFileUrl(path) });
}

async function withAttached(
  fn: (
    engine: Awaited<ReturnType<typeof open>>,
    commitSqlite: (
      localSeq: number,
      ops: Operation[],
    ) => ReturnType<typeof applyCommit>,
  ) => void | Promise<void>,
) {
  const engine = await freshEngine();
  const alias = aliasForDbId(DB_ID);
  attachDatabase(
    engine.database,
    alias,
    await Deno.makeTempFile({ suffix: ".sqlite" }),
  );
  ensureTables(engine.database, TABLES, alias);
  try {
    await fn(engine, (localSeq, operations) =>
      applyCommit(engine, {
        sessionId: "session:a",
        principal: "did:key:alice",
        space: "did:key:space",
        sqliteAttachments: new Map([[DB_ID, alias]]),
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        },
      }));
  } finally {
    detachDatabase(engine.database, alias);
  }
}

const sqliteOp = (sql: string, params?: SqliteParamsWire): Operation => ({
  op: "sqlite",
  db: { id: DB_ID, tables: TABLES, owner: OWNER },
  sql,
  params,
});

Deno.test("INSERT…SELECT with a violating committed row rolls back the WHOLE commit", async () => {
  await withAttached((engine, commitSqlite) => {
    // Stage one valid and one violating row (staging is rule-less: plain path).
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO staging (from_addr, to_addrs, auth, body) VALUES " +
          "(?, ?, ?, ?), (?, ?, ?, ?)",
        [...VALID, ...VIOLATING],
      ),
    ]);
    // The copy commit carries a cell op too — BOTH must roll back.
    const error = assertThrows(() =>
      commitSqlite(2, [
        { op: "set", id: "entity:marker", value: { value: { copied: true } } },
        sqliteOp(
          "INSERT INTO emails (from_addr, to_addrs, auth, body) " +
            "SELECT from_addr, to_addrs, auth, body FROM staging",
        ),
      ])
    );
    assert(error instanceof RowLabelCommitError, String(error));
    assertEquals(error.operationIndex, 1);
    assert(
      error.message.includes("strict-if-present"),
      `unexpected reason: ${error.message}`,
    );
    assertEquals(read(engine, { id: "entity:marker" }), null);
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM emails"),
      [{ n: 0 }],
    );
    // The staging rows themselves survived (their commit was separate).
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM staging"),
      [{ n: 2 }],
    );
  });
});

Deno.test("INSERT…SELECT whose committed rows all satisfy the rule lands with its cell op", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO staging (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
        VALID,
      ),
    ]);
    commitSqlite(2, [
      { op: "set", id: "entity:marker", value: { value: { copied: true } } },
      sqliteOp(
        "INSERT INTO emails (from_addr, to_addrs, auth, body) " +
          "SELECT from_addr, to_addrs, auth, body FROM staging",
      ),
    ]);
    assertEquals(read(engine, { id: "entity:marker" }), {
      value: { copied: true },
    });
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails"),
      [{ from_addr: "alice@a.example" }],
    );
  });
});

Deno.test("upsert re-derives from the POST-IMAGE: violating flip rolls back, valid flip lands", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
          "VALUES (?, ?, ?, ?, ?)",
        [1, ...VALID],
      ),
    ]);
    const upsert = "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
      "VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET " +
      "from_addr = excluded.from_addr";
    // Post-image from_addr matches nothing -> the rule refuses the row.
    assertThrows(
      () => commitSqlite(2, [sqliteOp(upsert, [1, ...VIOLATING])]),
      RowLabelCommitError,
    );
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "alice@a.example" }],
    );
    // A valid post-image is admitted (and the label the read side re-derives
    // follows the new value).
    commitSqlite(3, [
      sqliteOp(upsert, [1, "carol@c.example", "bob@b.example", "", "hi"]),
    ]);
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "carol@c.example" }],
    );
  });
});

Deno.test("UPDATE of a rule-input column is judged by the committed value", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
          "VALUES (?, ?, ?, ?, ?)",
        [1, ...VALID],
      ),
    ]);
    assertThrows(
      () =>
        commitSqlite(2, [
          sqliteOp("UPDATE emails SET from_addr = ? WHERE id = ?", [
            "no address here",
            1,
          ]),
        ]),
      RowLabelCommitError,
    );
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "alice@a.example" }],
    );
    commitSqlite(3, [
      sqliteOp("UPDATE emails SET from_addr = ? WHERE id = ?", [
        "carol@c.example",
        1,
      ]),
    ]);
    assertEquals(
      runQuery(engine.database, "SELECT from_addr FROM emails WHERE id = 1"),
      [{ from_addr: "carol@c.example" }],
    );
  });
});

Deno.test("integrity stays unique: a display-name bait post-image fails closed", async () => {
  await withAttached((_engine, commitSqlite) => {
    // Two address-shaped tokens in from_addr + dmarc=pass: >1 match in an
    // integrity-bearing position must refuse (forged provenance subject).
    assertThrows(
      () =>
        commitSqlite(1, [
          sqliteOp(
            "INSERT INTO emails (from_addr, to_addrs, auth, body) " +
              "SELECT ?, ?, ?, ?",
            [
              '"bait@evil.example" <real@x.example>',
              "bob@b.example",
              "dmarc=pass",
              "hi",
            ],
          ),
        ]),
      RowLabelCommitError,
    );
  });
});

Deno.test("dbOwner() rule: owner present on the op passes, absent fails closed", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp("INSERT INTO ownerOnly (note) SELECT ?", ["hello"]),
    ]);
    assertEquals(
      runQuery(engine.database, "SELECT note FROM ownerOnly"),
      [{ note: "hello" }],
    );
    const noOwner: Operation = {
      op: "sqlite",
      db: { id: DB_ID, tables: TABLES },
      sql: "INSERT INTO ownerOnly (note) SELECT ?",
      params: ["nope"],
    };
    const error = assertThrows(() => commitSqlite(2, [noOwner]));
    assert(error instanceof RowLabelCommitError, String(error));
    assert(error.message.includes("dbOwner"), error.message);
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM ownerOnly"),
      [{ n: 1 }],
    );
  });
});

Deno.test("a violating write hidden behind an unterminated comment still rolls back", async () => {
  // SQLite tolerates an unterminated trailing block comment (whitespace to
  // EOF), which SWALLOWS the appended RETURNING suffix: the DML applies but
  // returns no rows. The returned-count === changes invariant catches it and
  // rolls the commit back rather than under-evaluating.
  await withAttached((engine, commitSqlite) => {
    assertThrows(
      () =>
        commitSqlite(1, [
          sqliteOp(
            "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?) /* oops",
            ["alice@a.example", "bob@b.example"],
          ),
        ]),
      RowLabelCommitError,
      "incomplete",
    );
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM emails"),
      [{ n: 0 }],
    );
  });
});

Deno.test("a pre-3.c op without owner backfills dbOwner() from the handle doc", async () => {
  await withAttached((engine, commitSqlite) => {
    const ownerlessOp: Operation = {
      op: "sqlite",
      db: { id: DB_ID, tables: TABLES }, // no `owner` — an old client's shape
      sql: "INSERT INTO ownerOnly (note) SELECT ?",
      params: ["hello"],
    };
    // Without a handle doc the owner stays unresolved: fail closed (also
    // proves the backfill read tolerates a missing doc).
    assertThrows(() => commitSqlite(1, [ownerlessOp]), RowLabelCommitError);
    // Seed the db handle cell the way sqliteDatabase stamps it, then the
    // same ownerless op resolves the owner from the committed doc.
    commitSqlite(2, [{
      op: "set",
      id: DB_ID,
      value: { value: { id: DB_ID, owner: OWNER } },
    }]);
    commitSqlite(3, [ownerlessOp]);
    assertEquals(
      runQuery(engine.database, "SELECT note FROM ownerOnly"),
      [{ note: "hello" }],
    );
  });
});

Deno.test("a pre-3.c op against a USER-scoped handle backfills dbOwner() at that scope", async () => {
  // The db handle cell is `user`-scoped, so its doc lives under the commit's
  // user scope key — a default-scope backfill read would miss it and the op
  // would wrongly fail closed. The backfill must resolve the handle at the op's
  // declared scope (with the commit principal/session) to stay rolling-upgrade
  // compatible for scoped dbs. commitSqlite runs as principal "did:key:alice".
  await withAttached((engine, commitSqlite) => {
    const scopedOwnerlessOp: Operation = {
      op: "sqlite",
      // no `owner` (old client) and `scope: "user"` — a user-scoped handle.
      db: { id: DB_ID, tables: TABLES, scope: "user" },
      sql: "INSERT INTO ownerOnly (note) SELECT ?",
      params: ["scoped"],
    };
    // Seed the handle ONLY at the default scope: the user-scoped read must not
    // find it, so a `dbOwner()` op still fails closed. Proves the read is
    // genuinely scope-qualified (not silently falling back to default scope).
    commitSqlite(1, [{
      op: "set",
      id: DB_ID,
      value: { value: { id: DB_ID, owner: OWNER } },
    }]);
    assertThrows(
      () => commitSqlite(2, [scopedOwnerlessOp]),
      RowLabelCommitError,
    );
    // Now seed the handle at the USER scope (the way a user-scoped sqliteDatabase
    // stamps it) — the same scoped op resolves the owner and lands.
    commitSqlite(3, [{
      op: "set",
      id: DB_ID,
      scope: "user",
      value: { value: { id: DB_ID, owner: OWNER } },
    }]);
    commitSqlite(4, [scopedOwnerlessOp]);
    assertEquals(
      runQuery(engine.database, "SELECT note FROM ownerOnly"),
      [{ note: "scoped" }],
    );
  });
});

Deno.test('a quoted identifier named "returning" does not trip the RETURNING scan', async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp('INSERT INTO rtab ("returning") VALUES (?)', ["x"]),
    ]);
    assertEquals(
      runQuery(engine.database, 'SELECT "returning" AS r FROM rtab'),
      [{ r: "x" }],
    );
  });
});

Deno.test("DELETE and rule-less-table writes stay plain on a rule-bearing db", async () => {
  await withAttached((engine, commitSqlite) => {
    commitSqlite(1, [
      sqliteOp(
        "INSERT INTO emails (id, from_addr, to_addrs, auth, body) " +
          "VALUES (?, ?, ?, ?, ?)",
        [1, ...VALID],
      ),
      // Violating VALUES land fine in the rule-less staging table.
      sqliteOp(
        "INSERT INTO staging (from_addr, to_addrs, auth, body) " +
          "SELECT ?, ?, ?, ?",
        VIOLATING,
      ),
    ]);
    commitSqlite(2, [sqliteOp("DELETE FROM emails WHERE id = ?", [1])]);
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM emails"),
      [{ n: 0 }],
    );
    assertEquals(
      runQuery(engine.database, "SELECT count(*) AS n FROM staging"),
      [{ n: 1 }],
    );
  });
});

//
// direct applySqliteCommitWrite: shape rejects + caps
//
// (No wrapping transaction here — these assert the THROW; rollback is the
// applyCommit-level tests' concern.)
//

function bareDb(): Database {
  const db = new Database(":memory:");
  ensureTables(db, TABLES);
  return db;
}

const bareOp = (
  sql: string,
  params?: SqliteParamsWire,
  tables: SqliteDbRef["tables"] = TABLES,
) => ({
  op: "sqlite" as const,
  db: { id: DB_ID, tables, owner: OWNER },
  sql,
  params,
});

Deno.test("a CTE-fronted write to a RULE-LESS table of a mixed db keeps the plain path", () => {
  // The target resolves BEFORE any shape check (mirroring the runner gate's
  // order), so only rule-bearing targets pay the recognized-keyword rule.
  const db = bareDb();
  try {
    const result = applySqliteCommitWrite(
      db,
      bareOp(
        "WITH x(v) AS (SELECT 'ok') INSERT INTO staging (from_addr) " +
          "SELECT v FROM x",
      ),
    );
    assertEquals(result.changes, 1);
  } finally {
    db.close();
  }
});

Deno.test("commit eval fails closed on the shapes it cannot attribute", () => {
  const db = bareDb();
  try {
    // CTE-fronted write TARGETING the rule-bearing table.
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "WITH x(v) AS (SELECT 'a@b.c') INSERT INTO emails (from_addr) " +
              "SELECT v FROM x",
          ),
        ),
      RowLabelCommitError,
      "unrecognized write shape",
    );
    // A target the shared parser cannot attribute at all.
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp("INSERT INTO (bad) VALUES (?)", ["x"]),
        ),
      RowLabelCommitError,
      "cannot attribute",
    );
    // Undeclared target table in a rule-bearing db.
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp("INSERT INTO mystery (a) VALUES (?)", ["x"]),
        ),
      RowLabelCommitError,
      "undeclared table",
    );
    // Every rowid alias shadowed by declared columns: affected rows cannot
    // be identified.
    const shadowed = table(
      { rowid: "text", _rowid_: "text", oid: "text" },
      () => ({ confidentiality: all(dbOwner()) }),
    );
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp("INSERT INTO shadowed (rowid) VALUES (?)", ["x"], {
            shadowed,
          }),
        ),
      RowLabelCommitError,
      "shadowed",
    );
    // A declared `__cf_rowid` column collides with the evaluation alias.
    const colliding = table(
      { id: "integer primary key", __cf_rowid: "text" },
      () => ({ confidentiality: all(dbOwner()) }),
    );
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp("INSERT INTO colliding (__cf_rowid) VALUES (?)", ["x"], {
            colliding,
          }),
        ),
      RowLabelCommitError,
      "collides",
    );
    // A statement that already carries RETURNING.
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "INSERT INTO emails (from_addr, to_addrs) VALUES (?, ?) " +
              "RETURNING id",
            ["alice@a.example", "bob@b.example"],
          ),
        ),
      RowLabelCommitError,
      "RETURNING",
    );
    // An invalid wire-supplied spec never evaluates as "no label".
    const badTables = {
      emails: { ...emails, rowLabel: { version: 99 } },
    };
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "INSERT INTO emails (from_addr) VALUES (?)",
            ["alice@a.example"],
            badTables,
          ),
        ),
      RowLabelCommitError,
      "invalid rowLabel rule",
    );
  } finally {
    db.close();
  }
});

Deno.test("commit eval judges an INTEGER column by its stored digits", () => {
  // 4294967303 is 7 in the low 32 bits, which is exactly the id the rule
  // admits. Read as 7 the violating row commits; read as itself it refuses.
  const db = bareDb();
  try {
    assertEquals(
      applySqliteCommitWrite(
        db,
        bareOp("INSERT INTO mailboxes (id, source_id) VALUES (?, ?)", [1, 7]),
      ).changes,
      1,
    );
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp("INSERT INTO mailboxes (id, source_id) VALUES (?, ?)", [
            2,
            4294967303,
          ]),
        ),
      RowLabelCommitError,
      "matched nothing",
    );
  } finally {
    db.close();
  }
});

Deno.test("commit eval reads back the row it wrote, whatever its rowid", () => {
  // The affected row is identified by rowid, and a rowid past 2^31 truncates
  // into the range of one already stored: rowid 4294967303 collides with 7.
  // Reading back the wrong row judges a violating write by a valid row's
  // values, so the write lands unevaluated.
  const db = bareDb();
  try {
    applySqliteCommitWrite(
      db,
      bareOp("INSERT INTO mailboxes (id, source_id) VALUES (?, ?)", [7, 7]),
    );
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp("INSERT INTO mailboxes (id, source_id) VALUES (?, ?)", [
            4294967303,
            999,
          ]),
        ),
      RowLabelCommitError,
      "matched nothing",
    );
  } finally {
    db.close();
  }
});

Deno.test("commit eval evaluates the columnless-INSERT default row", () => {
  const db = bareDb();
  try {
    // All-defaults row: from_addr is NULL, which the min:1 anchor refuses.
    assertThrows(
      () =>
        applySqliteCommitWrite(db, bareOp("INSERT INTO emails DEFAULT VALUES")),
      RowLabelCommitError,
      "at least 1",
    );
  } finally {
    db.close();
  }
});

Deno.test("commit eval caps the affected-row count (fail closed, not silent)", () => {
  const db = bareDb();
  try {
    // Seed staging beyond the cap directly (test-side; no guard involved).
    const insert = db.prepare("INSERT INTO staging (from_addr) VALUES (?)");
    db.exec("BEGIN");
    for (let i = 0; i <= MAX_ROW_LABEL_EVAL_ROWS; i++) {
      insert.run("alice@a.example");
    }
    db.exec("COMMIT");
    assertThrows(
      () =>
        applySqliteCommitWrite(
          db,
          bareOp(
            "INSERT INTO emails (from_addr) SELECT from_addr FROM staging",
          ),
        ),
      RowLabelCommitError,
      "cap",
    );
  } finally {
    db.close();
  }
});

Deno.test("a no-op write (UPDATE matching nothing) passes without evaluation", () => {
  const db = bareDb();
  try {
    const result = applySqliteCommitWrite(
      db,
      bareOp("UPDATE emails SET from_addr = ? WHERE id = ?", ["x", 42]),
    );
    assertEquals(result.changes, 0);
  } finally {
    db.close();
  }
});

Deno.test("the sqlite barrel re-exports the shared parser and the 3.c surface", () => {
  // `mod.ts` is the server-side aggregation point; keep the shared modules
  // reachable through it (and their identities intact).
  assertEquals(sqliteBarrel.MAX_ROW_LABEL_EVAL_ROWS, MAX_ROW_LABEL_EVAL_ROWS);
  assertEquals(sqliteBarrel.applySqliteCommitWrite, applySqliteCommitWrite);
  assertEquals(typeof sqliteBarrel.parseWriteTable, "function");
  assertEquals(typeof sqliteBarrel.blankWriteSql, "function");
});
