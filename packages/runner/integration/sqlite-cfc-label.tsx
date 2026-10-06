import {
  handler,
  pattern,
  resultOf,
  sqliteDatabase,
  type SqliteDb,
  table,
} from "commonfabric";

// FIXTURE (integration): `notes.body` is declared confidential via per-column
// `ifc`. A `db.query` that reads it must make the result carry that
// confidentiality so a downstream consumer inherits it — CFC labels coming back
// OUT of SQLite. The query selects `body` under an ALIAS to also prove the
// label keys off the column's TRUE origin (column-origin provenance), not the
// output name.
const seed = handler<Record<string, never>, { db: SqliteDb }>((_, { db }) => {
  db.exec("INSERT INTO notes (body) VALUES (?)", ["top secret"]);
});

export default pattern(() => {
  const db = sqliteDatabase({
    tables: {
      notes: table({
        id: "integer primary key",
        body: {
          type: "string",
          ifc: { confidentiality: ["secret-body"] },
        },
      }),
    },
  });

  const q = db.query<{ secret: string }>(
    "SELECT body AS secret FROM notes ORDER BY id",
    { reactOn: db },
  );

  return { q: resultOf(q), seed: seed({ db }) };
});
