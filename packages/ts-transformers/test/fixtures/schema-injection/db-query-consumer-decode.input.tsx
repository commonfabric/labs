import {
  type Cell,
  lift,
  pattern,
  resultOf,
  sqliteDatabase,
} from "commonfabric";

interface User {
  name: string;
}

// FIXTURE: db-query-consumer-decode
// Verifies the CONSUMER half of `_cf_link` auto-decode: reading
// `resultOf(q).rows[0].author_cf_link` off a typed
// `db.query<{ author_cf_link: Cell<User> }>`
// lowers (via the <Row> return type) to a consumer input schema where
// `rows.items.author_cf_link` carries `asCell: ["cell"]`. Combined with the
// runtime storing a sigil OBJECT (Piece A), that asCell read rehydrates the
// column to a live Cell. The cell-ness also survives the lift's RESULT type
// (factory result types are not stripped), so the pattern's result schema for
// `author` carries `asCell: ["cell"]` too — consumers of the pattern get the
// live Cell, not a dereferenced copy.
const readAuthor = lift(
  (qv: { rows: Array<{ author_cf_link: Cell<User> }> }) =>
    qv.rows[0]?.author_cf_link,
);

export default pattern(() => {
  const db = sqliteDatabase();
  const q = db.query<{ author_cf_link: Cell<User> }>(
    "SELECT author_cf_link FROM people",
  );
  return { author: readAuthor(resultOf(q)) };
});
