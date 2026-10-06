/// <cts-enable />
// FIXTURE (multi-runtime integration, CFC Phase 3.b): cross-reader isolation
// of read-time-clearance query results.
//
// Each notes row names its intended reader (a full did:key string) in its own
// `reader` column, and the row rule mints exactly that principal as the row's
// confidentiality. A `readClearance: true` query therefore returns each acting
// reader ONLY the rows naming them — and because the cleared result is
// reader-specific, each reader must get an ISOLATED result cell (per-`user`
// scope) keyed by a reader-aware request hash. Regression fixture for the
// #4478 review P0 (52e3e7e7): a space-scoped result cell plus a reader-blind
// request hash let one reader observe another reader's filtered rows.
import {
  cfSqlite,
  handler,
  NAME,
  pattern,
  resultOf,
  sqliteDatabase,
  type SqliteDb,
} from "commonfabric";

interface NoteRow {
  id: number;
  reader: string;
  body: string;
}

/** Seed rows addressed to specific readers (full did:key strings). */
const seed = handler<
  { rows: { reader: string; body: string }[] },
  { db: SqliteDb }
>(({ rows }, { db }) => {
  for (const row of rows) {
    db.exec("INSERT INTO notes (reader, body) VALUES (?, ?)", [
      row.reader,
      row.body,
    ]);
  }
});

export default pattern(() => {
  // In-body destructuring: top-level destructuring is rejected by the SES
  // verifier, and the rule callback is the recognized `table(columns, rule)`
  // boundary (evaluated eagerly into a serialized AST).
  const { table, principal, match } = cfSqlite;
  // The base58btc multikey suffix of a did:key (z6Mk…). principal("key", …)
  // re-mints `did:key:<match>`, so each row's confidentiality is exactly the
  // did:key stored in its own reader column — one conjunctive clause naming
  // one principal.
  const KEY = /z[1-9A-HJ-NP-Za-km-z]+/g;

  const notes = table(
    {
      id: "integer primary key",
      reader: "text",
      body: "text",
    },
    // A bare term (no all() wrapper) — the simplest form for a single
    // alternative. (Term LISTS used to split into per-element linked docs on
    // the stored handle and destabilize the request hash across runtimes;
    // fixed in #4509 — the handle is stored self-contained — and guarded by
    // packages/runner/test/sqlite-handle-multi-runtime.test.ts.)
    (f) => ({
      confidentiality: principal("key", match(f.reader, KEY, { min: 1 })),
    }),
    // Phase 3.b: opt the table into read-time clearance.
    { allowReadClearance: true },
  );

  const db = sqliteDatabase({ tables: { notes } });

  // Baseline (no clearance): a shared, reader-blind result — every reader
  // sees every row, so any isolation observed on qClear is clearance-made.
  const qAll = db.query<NoteRow>(
    "SELECT id, reader, body FROM notes ORDER BY id",
    { reactOn: db },
  );

  // Read-time clearance: rows filtered to the ACTING reader per runtime.
  const qClear = db.query<NoteRow>(
    "SELECT id, reader, body FROM notes ORDER BY id",
    { reactOn: db, readClearance: true },
  );
  const allResult = resultOf(qAll);
  const clearResult = resultOf(qClear);

  return {
    [NAME]: "SQLite read-time clearance (multi-runtime fixture)",
    db,
    qAll: allResult,
    qClear: clearResult,
    seed: seed({ db }),
  };
});
