// Read-label provenance via SQLite column-origin metadata, on a read-only
// connection opened exactly as the ReadConnectionPool does. The soundness
// contract under aliasing / spoofing / expressions / joins / UNION / CTE / view:
// a non-null origin is the TRUE source column; anything the engine can't
// attribute reports null (the caller fails closed).

import { assertEquals, assertStringIncludes, fail } from "@std/assert";
import { Database } from "@db/sqlite";
import {
  columnOriginAvailable,
  columnOrigins,
  ensureColumnOriginAvailable,
  librarySource,
  openSource,
  SQLITE3_RELEASE_VERSION,
} from "../v2/sqlite/column-origin.ts";
import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";

// Bind @db/sqlite's column-origin symbols before the sync columnOrigins() calls
// (production does this once before a labeled query via the server handler).
await ensureColumnOriginAvailable();

// The origin symbols are bound by dlopen'ing the same libsqlite3 file
// `@db/sqlite` loaded, found by rebuilding the release URL `@db/sqlite` derives
// from its package version. A pin the lockfile no longer resolves to names a
// different file, which gives the process a second libsqlite3 image whose SQLite
// globals `@db/sqlite` never initialized; the statement handles below then
// dispatch through that zeroed state and segfault. The crash takes down the run
// from that test onwards, so the tests that pass a handle across the boundary
// run only when the pin matches, and this reports the mismatch instead.
const resolved: { version?: string; problem?: string } = await (async () => {
  let text: string;
  try {
    text = await Deno.readTextFile(
      new URL("../../../deno.lock", import.meta.url),
    );
  } catch (e) {
    return { problem: `deno.lock could not be read (${e})` };
  }
  let specifiers: Record<string, string>;
  try {
    specifiers = JSON.parse(text).specifiers ?? {};
  } catch (e) {
    return { problem: `deno.lock could not be parsed (${e})` };
  }
  const keys = Object.keys(specifiers).filter((k) =>
    k.startsWith("jsr:@db/sqlite@")
  );
  if (keys.length !== 1) {
    return {
      problem: `expected exactly one jsr:@db/sqlite specifier in deno.lock, ` +
        `found ${keys.length}${keys.length ? `: ${keys.join(", ")}` : ""}. ` +
        `Every package declaring @db/sqlite has to resolve to one version.`,
    };
  }
  return { version: specifiers[keys[0]] };
})();
const pinMatchesLock = resolved.version === SQLITE3_RELEASE_VERSION;

Deno.test("pinned libsqlite3 release matches the resolved @db/sqlite", () => {
  if (resolved.problem) {
    fail(
      `cannot check SQLITE3_RELEASE_VERSION against the lockfile: ` +
        `${resolved.problem}`,
    );
  }
  assertEquals(
    resolved.version,
    SQLITE3_RELEASE_VERSION,
    `deno.lock resolves @db/sqlite to ${resolved.version}, but ` +
      `SQLITE3_RELEASE_VERSION in v2/sqlite/column-origin.ts pins the ` +
      `libsqlite3 release to ${SQLITE3_RELEASE_VERSION}. Set the pin to the ` +
      `resolved version so both open the same file.`,
  );
});

//
// Picking the library file
//
// Provenance has to be read from the same libsqlite3 image that runs the query,
// so the only acceptable file is the one `@db/sqlite` picks. These cover the
// picking rule and the refusal to substitute a different file for one that
// cannot be opened.
//

Deno.test("library source follows @db/sqlite's own precedence", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  // @db/sqlite reads DENO_SQLITE_LOCAL first, so it wins even with a path set.
  assertEquals(
    librarySource(
      env({ DENO_SQLITE_LOCAL: "1", DENO_SQLITE_PATH: "/x.dylib" }),
    ),
    { kind: "local" },
  );
  // Only "1" selects the local build.
  assertEquals(
    librarySource(
      env({ DENO_SQLITE_LOCAL: "0", DENO_SQLITE_PATH: "/x.dylib" }),
    ),
    { kind: "path", path: "/x.dylib" },
  );
  assertEquals(librarySource(env({ DENO_SQLITE_PATH: "/x.dylib" })), {
    kind: "path",
    path: "/x.dylib",
  });
  // @db/sqlite tests the path for truthiness, so an empty one is not a path.
  assertEquals(librarySource(env({ DENO_SQLITE_PATH: "" })), {
    kind: "release",
  });
  assertEquals(librarySource(env({})), { kind: "release" });
});

Deno.test("an override that cannot be opened reports, and binds nothing", async () => {
  // A file that is not a library stands in for the real case: a libsqlite3 built
  // without SQLITE_ENABLE_COLUMN_METADATA, which @db/sqlite loads happily while
  // the origin symbols are missing from it.
  const path = Deno.makeTempFileSync({ suffix: ".dylib" });
  Deno.writeTextFileSync(path, "not a library");
  try {
    const result = await openSource({ kind: "path", path });
    // Binding the prebuilt release here instead would be a second image.
    assertEquals("lib" in result, false);
    assertStringIncludes(
      (result as { problem: string }).problem,
      "$DENO_SQLITE_PATH",
    );
    assertStringIncludes((result as { problem: string }).problem, path);
  } finally {
    Deno.removeSync(path);
  }
});

Deno.test("a local @db/sqlite build reports rather than binding another file", async () => {
  const result = await openSource({ kind: "local" });
  assertEquals("lib" in result, false);
  assertStringIncludes(
    (result as { problem: string }).problem,
    "DENO_SQLITE_LOCAL",
  );
});

//
// Reading column origins
//
// These cover that the symbols bind at all, and what the bound library
// reports for a query once the picking rule above has chosen a file.
//

function seed(path: string): void {
  const db = new Database(path); // writable for setup
  db.exec("CREATE TABLE emails (from_email TEXT, subject TEXT, body TEXT)");
  db.exec("CREATE TABLE people (from_email TEXT, name TEXT)");
  db.exec("CREATE VIEW v_emails AS SELECT from_email, subject FROM emails");
  db.exec("INSERT INTO emails VALUES ('a@x.com','hi','secret')");
  db.exec("INSERT INTO people VALUES ('a@x.com','Ada')");
  db.close();
}

/** Open read-only (as the pool does) and return per-output-column origin. */
function origins(
  roDb: Database,
  sql: string,
): Array<[string | null, string | null]> {
  const stmt = roDb.prepare(sql);
  try {
    const o = columnOrigins(stmt.unsafeHandle, stmt.columnNames().length);
    return o.map((c) => [c.table, c.column]);
  } finally {
    stmt.finalize();
  }
}

Deno.test({
  name: "column-origin metadata is reachable in this deployment",
  sanitizeResources: false,
}, () => {
  // Bound above via ensureColumnOriginAvailable(); a labeled query that can't
  // bind the symbols fails loudly rather than mislabeling.
  assertEquals(columnOriginAvailable(), true);
});

Deno.test({
  name: "column origin is sound through alias / spoof / expression / join",
  sanitizeResources: false,
  ignore: !pinMatchesLock,
}, () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  seed(path);
  const ro = new Database(path, { readonly: true });
  try {
    // Alias resolved to the true source column.
    assertEquals(
      origins(ro, "SELECT from_email AS renamed, subject FROM emails"),
      [["emails", "from_email"], ["emails", "subject"]],
    );
    // Spoof defeated: output named `from_email` but origin is `subject`.
    assertEquals(
      origins(ro, "SELECT subject AS from_email FROM emails"),
      [["emails", "subject"]],
    );
    // Expression + literal: no single origin -> null -> caller fails closed.
    assertEquals(
      origins(ro, "SELECT upper(from_email) AS x, 1 AS n FROM emails"),
      [[null, null], [null, null]],
    );
    // Join: same column name in two tables is disambiguated by origin table.
    assertEquals(
      origins(
        ro,
        "SELECT e.from_email, p.from_email FROM emails e " +
          "JOIN people p ON e.from_email = p.from_email",
      ),
      [["emails", "from_email"], ["people", "from_email"]],
    );
    // SELECT * carries every column's true origin.
    assertEquals(
      origins(ro, "SELECT * FROM emails"),
      [["emails", "from_email"], ["emails", "subject"], ["emails", "body"]],
    );
  } finally {
    ro.close();
    Deno.removeSync(path);
  }
});

Deno.test({
  name:
    "pool.queryWithOrigins returns rows + per-column origin (real pool path)",
  sanitizeResources: false,
  ignore: !pinMatchesLock,
}, () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  seed(path);
  const pool = new ReadConnectionPool();
  try {
    const { rows, columns } = pool.queryWithOrigins(
      path,
      "SELECT from_email AS sender, subject FROM emails ORDER BY subject",
    );
    assertEquals(rows, [{ sender: "a@x.com", subject: "hi" }]);
    // Output name is the alias; origin is the TRUE source column.
    assertEquals(columns, [
      { output: "sender", table: "emails", column: "from_email" },
      { output: "subject", table: "emails", column: "subject" },
    ]);
  } finally {
    pool.close();
    Deno.removeSync(path);
  }
});

Deno.test({
  name:
    "compound/CTE/view origins are sound (true source or null, never wrong)",
  sanitizeResources: false,
  ignore: !pinMatchesLock,
}, () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  seed(path);
  const ro = new Database(path, { readonly: true });
  try {
    // For each of these the only conceivable source column is `from_email`; the
    // soundness requirement is that origin.column is EITHER `from_email` (true
    // source) OR null (fail closed) — never some other column.
    const sound = (sql: string) => {
      for (const [, col] of origins(ro, sql)) {
        if (col !== null && col !== "from_email") {
          throw new Error(`unsound origin ${col} for: ${sql}`);
        }
      }
    };
    sound("SELECT from_email FROM emails UNION SELECT from_email FROM people");
    sound("WITH c AS (SELECT from_email FROM emails) SELECT from_email FROM c");
    sound("SELECT from_email FROM v_emails");
    sound("SELECT from_email FROM (SELECT from_email FROM emails)");
  } finally {
    ro.close();
    Deno.removeSync(path);
  }
});
