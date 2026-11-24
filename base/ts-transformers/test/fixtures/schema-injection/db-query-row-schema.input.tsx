import { type Cell, sqliteDatabase } from "commonfabric";

interface User {
  name: string;
}

// FIXTURE: db-query-row-schema
// Verifies: the METHOD form db.query<Row>(sql, options?) lowers the Row type
// argument to an injected `rowSchema` in the OPTIONS object (arg 1, not arg 0).
// Cell<T> Row fields become asCell, keyed by the Row field name — so an aliased
// link column (SELECT author_cf_link AS author) is detected with no _cf_link
// suffix, exactly like the free-function sqliteQuery<Row> form.
export default function TestDbQueryRowSchema() {
  const db = sqliteDatabase();
  const q = db.query<{ author: Cell<User>; n: number }>(
    "SELECT author_cf_link AS author, count(*) AS n FROM m GROUP BY author_cf_link",
  );
  return { q };
}
