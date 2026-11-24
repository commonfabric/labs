/**
 * Fetches and caches the native SQLite library that `@db/sqlite` loads, and
 * checks that the cached library runs statements. Continuous integration runs
 * it through `deno task initialize-db` before the tests that open databases.
 */

import { Database } from "@db/sqlite";

/**
 * Runs statements against a new in-memory database, throwing when the native
 * library cannot. Importing `@db/sqlite` is what loads the library, fetching
 * it first when the cache lacks it.
 */
export function checkSqliteLibrary(): void {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE foo (bar TEXT); INSERT INTO foo VALUES ('baz');");
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  checkSqliteLibrary();
}
