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

// A handler writes a row via the imperative db.exec (folded into its commit).
// db.exec bumps a `rev` on the db handle in the SAME commit, so `reactOn: db`
// re-runs the query after the write (no explicit version cell needed).
const seed = handler<
  Record<string, never>,
  { db: SqliteDb; author: Cell<User> }
>((_, { db, author }) => {
  db.exec("INSERT INTO people (author_cf_link) VALUES (?)", [author]);
});

// FIXTURE (integration): a typed db.query<Row> surfaces a `_cf_link` result
// column as a live Cell end to end (transformer rowSchema injection + runtime
// decode + consumer asCell read), and `reactOn: db` re-runs after a db.exec
// write — through the real toolshed server.
export default pattern(() => {
  const db = sqliteDatabase({
    tables: {
      people: table({ id: "integer primary key", author_cf_link: "text" }),
    },
  });
  const author = cell<User>({ name: "Ada" });

  const q = db.query<{ author_cf_link: Cell<User> }>(
    "SELECT author_cf_link FROM people ORDER BY id",
    { reactOn: db },
  );

  return {
    q: resultOf(q),
    author,
    seed: seed({ db, author }),
  };
});
