import { handler, SqliteDb } from "commonfabric";

interface DbState {
  db: SqliteDb;
}

// FIXTURE: sqlite-db-handler-state
// Verifies: a SqliteDb-typed handler-state field lowers to an `asCell: ["sqlite"]`
// wrapper, so the handler receives the live handle cell and `db.exec(...)` is valid.
// The "sqlite" cell brand is authoritative and survives capability shrinking (like
// Stream): the read/write inference would otherwise collapse SqliteDb's read-only
// method surface to `asCell: ["readonly"]`, disagreeing with the schema generator's
// object-formatter path (which stamps "sqlite"). Both paths now agree — this closed
// the two-path brand inconsistency (#20 in 08-open-questions).
const writeNote = handler<unknown, DbState>((_, { db }) => {
  db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
});

export { writeNote };
