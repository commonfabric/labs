/// <cts-enable />
// FIXTURE (multi-runtime integration): the sqlite db handle's `owner` is
// minted once — by the runtime that CREATES the handle — and must survive
// other runtimes opening the same piece. Every runtime that opens the piece
// re-runs the sqliteDatabase builtin (its `initialized` guard is
// per-runtime-instance), so the fixture just creates a shared (space-scoped)
// db and exposes the handle for the test to inspect `owner` across runtimes.
// Regression fixture for the last-opener-wins owner re-mint.
import { cfSqlite, NAME, pattern, sqliteDatabase } from "commonfabric";

export default pattern(() => {
  // In-body destructuring: top-level destructuring is rejected by the SES
  // verifier.
  const { table } = cfSqlite;

  const db = sqliteDatabase({
    tables: {
      notes: table({ id: "integer primary key", body: "text" }),
    },
  });

  return {
    [NAME]: "SQLite db owner (multi-runtime fixture)",
    db,
  };
});
