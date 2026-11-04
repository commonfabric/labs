import { type Cell, sqliteQuery } from "commonfabric";

interface User {
  name: string;
}

// FIXTURE: sqlite-query-row-schema
// Verifies: sqliteQuery<Row> lowers the Row type argument to an injected
//   `rowSchema` property. Cell<T> fields become asCell (keyed by the Row field
//   name, so the aliased link column `author` is detected with no `_cf_link`
//   suffix). Untyped sqliteQuery(...) injects nothing (see sibling fixture).
// deno-lint-ignore-next-line no-explicit-any
export default function TestSqliteQueryRowSchema(db: any) {
  const q = sqliteQuery<{ author: Cell<User>; n: number }>({
    db,
    sql: "SELECT author_cf_link AS author, count(*) AS n FROM m GROUP BY author_cf_link",
  });
  return { q };
}
