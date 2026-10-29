import {
  cfSqlite,
  handler,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  table,
} from "commonfabric";

// FIXTURE (integration, CFC Phase 3.c): server-side commit-time row-label
// re-derivation. `guarded` carries the mailbox rule (sender required-anchor ∧
// recipients ∧ db owner); `staging` is rule-less and feeds the INSERT…SELECT
// shapes the runner gate cannot attribute — the SERVER evaluates the committed
// rows and rolls the whole commit back on violation.
//
const seed = handler<Record<string, never>, { db: SqliteDb }>((_, { db }) => {
  // Attributable INSERT (runner-evaluated, 3.a) into the guarded table.
  db.exec(
    "INSERT INTO guarded (id, from_addr, to_addrs, body) VALUES (?, ?, ?, ?)",
    [1, "alice@a.example", "bob@b.example", "first"],
  );
  // Rule-less staging rows: one valid, one whose from_addr matches no address
  // (strict-if-present will refuse a guarded row derived from it).
  db.exec(
    "INSERT INTO staging (from_addr, to_addrs, body) VALUES (?, ?, ?), (?, ?, ?)",
    [
      "carol@c.example",
      "dave@d.example",
      "ok",
      "not an address",
      "erin@e.example",
      "bad",
    ],
  );
});

// INSERT…SELECT copying EVERY staging row — includes the violating one, so
// the server must roll the whole statement back (nothing persists, not even
// the valid row riding the same statement).
const copyBad = handler<Record<string, never>, { db: SqliteDb }>(
  (_, { db }) => {
    db.exec(
      "INSERT INTO guarded (from_addr, to_addrs, body) " +
        "SELECT from_addr, to_addrs, body FROM staging",
    );
  },
);

// INSERT…SELECT restricted to rows whose committed image satisfies the rule.
const copyGood = handler<Record<string, never>, { db: SqliteDb }>(
  (_, { db }) => {
    db.exec(
      "INSERT INTO guarded (from_addr, to_addrs, body) " +
        "SELECT from_addr, to_addrs, body FROM staging " +
        "WHERE from_addr LIKE '%@%'",
    );
  },
);

// Upsert whose POST-IMAGE violates the rule. Row id=2 exists by now — copyGood
// (run before this in the driver) copied carol's staging row into `guarded`,
// auto-assigning id=2 — so `ON CONFLICT(id)` FIRES and takes the DO UPDATE
// branch, flipping row 2's sender to junk. The server re-derives from the
// post-image and rolls back (row 2 keeps carol).
const upsertBad = handler<Record<string, never>, { db: SqliteDb }>(
  (_, { db }) => {
    db.exec(
      "INSERT INTO guarded (id, from_addr, to_addrs, body) " +
        "VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET from_addr = excluded.from_addr",
      [2, "not an address", "dave@d.example", "x"],
    );
  },
);

// Upsert whose post-image is valid: row 1's sender flips to carol2, and the
// read side re-derives the row's label from the NEW value.
const upsertGood = handler<Record<string, never>, { db: SqliteDb }>(
  (_, { db }) => {
    db.exec(
      "INSERT INTO guarded (id, from_addr, to_addrs, body) " +
        "VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET from_addr = excluded.from_addr",
      [1, "carol2@c.example", "bob@b.example", "x"],
    );
  },
);

export default pattern(() => {
  const { all, principal, match, dbOwner } = cfSqlite;
  const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

  const guarded = table(
    {
      id: "integer primary key",
      from_addr: "text",
      to_addrs: "text",
      body: "text",
    },
    (f) => ({
      confidentiality: all(
        principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
        principal("mailto", match(f.to_addrs, ADDR)),
        dbOwner(),
      ),
    }),
  );
  const staging = table({
    id: "integer primary key",
    from_addr: "text",
    to_addrs: "text",
    body: "text",
  });

  const db = sqliteDatabase({ tables: { guarded, staging } });

  // Projects every rule input column (the read side locates them by origin).
  const q = db.query<{
    id: number;
    from_addr: string;
    to_addrs: string;
    body: string;
  }>(
    "SELECT id, from_addr, to_addrs, body FROM guarded ORDER BY id",
    { reactOn: db },
  );
  const qStaging = db.query<{ id: number; from_addr: string }>(
    "SELECT id, from_addr FROM staging ORDER BY id",
    { reactOn: db },
  );

  return {
    q,
    qStaging,
    seed: seed({ db }),
    copyBad: copyBad({ db }),
    copyGood: copyGood({ db }),
    upsertBad: upsertBad({ db }),
    upsertGood: upsertGood({ db }),
  };
});
