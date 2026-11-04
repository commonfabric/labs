import { sqliteQuery } from "commonfabric";

// FIXTURE: sqlite-query-no-type-arg
// Verifies: an untyped sqliteQuery(...) call compiles and is NOT modified — no
// `rowSchema` is injected (the runtime then falls back to suffix/table
// detection). Guards the `!typeArgs` early return of the injection branch.
// deno-lint-ignore-next-line no-explicit-any
export default function TestSqliteQueryNoTypeArg(db: any) {
  const q = sqliteQuery({ db, sql: "SELECT * FROM m" });
  return { q };
}
