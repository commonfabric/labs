import { Database } from "@db/sqlite";

// Importing @db/sqlite loads the native SQLite library. Opening an in-memory
// database confirms that the cached library can execute basic statements.
const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE foo (bar TEXT); INSERT INTO foo VALUES ('baz');");
} finally {
  db.close();
}
