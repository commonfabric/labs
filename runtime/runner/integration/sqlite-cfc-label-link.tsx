import {
  type Cell,
  cell,
  handler,
  pattern,
  resultOf,
  sqliteDatabase,
  type SqliteDb,
  table,
} from "commonfabric";

interface User {
  name: string;
}

// FIXTURE (integration): a single query projects BOTH a CFC-labeled column
// (`note`, confidential) AND an asCell `_cf_link` column (`author_cf_link`).
// The labeled-write path (result written under the per-field label schema) must
// not break the link column's rehydration — the consumer should inherit `note`'s
// confidentiality AND resolve `author_cf_link` to a live Cell.
const seed = handler<
  Record<string, never>,
  { db: SqliteDb; author: Cell<User> }
>((_, { db, author }) => {
  db.exec("INSERT INTO people (note, author_cf_link) VALUES (?, ?)", [
    "hush",
    author,
  ]);
});

export default pattern(() => {
  const db = sqliteDatabase({
    tables: {
      people: table({
        id: "integer primary key",
        note: { type: "string", ifc: { confidentiality: ["secret-note"] } },
        author_cf_link: "text",
      }),
    },
  });
  const author = cell<User>({ name: "Ada" });

  const q = db.query<{ note: string; author_cf_link: Cell<User> }>(
    "SELECT note, author_cf_link FROM people ORDER BY id",
    { reactOn: db },
  );

  return { q: resultOf(q), author, seed: seed({ db, author }) };
});
