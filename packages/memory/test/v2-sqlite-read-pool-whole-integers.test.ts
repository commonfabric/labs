/**
 * A pooled read returns an INTEGER column as the integer the row holds, on an
 * ordinary query as on a labeled one.
 *
 * `@db/sqlite` reads an INTEGER column through `sqlite3_column_int`, the
 * 32-bit accessor, unless the connection is opened with `int64`, and hands
 * over the low 32 bits of anything wider. Nothing downstream can tell: a
 * wrapped value is a well-formed JS number. So the guarantee is established
 * here, with values stored on disk and read back through the pool's own
 * connection. A second, default-mode connection to the same file is the
 * control: it shows each wide value really does wrap at the driver, which is
 * what makes a whole value from the pool a fact about the pool.
 *
 * Spec: docs/specs/sqlite-builtin/01-api.md ("The `Row` type argument").
 */

import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ensureColumnOriginAvailable } from "../v2/sqlite/column-origin.ts";
import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";

// `queryWithOrigins()` resolves column origins over FFI, so it cannot run at
// all without it (production binds it once before issuing one).
await ensureColumnOriginAvailable();

// One stored value per regime, as the decimal text SQLite is given: within 32
// bits; an epoch-millisecond timestamp, which is past 2^31; past 2^32; the
// last integer a double names, and its negation; the first a double cannot;
// and the two ends of what an INTEGER holds.
const STORED: [string, number | bigint][] = [
  ["7", 7],
  ["-7", -7],
  ["1789000000000", 1789000000000],
  ["4294967303", 4294967303],
  ["9007199254740991", 9007199254740991],
  ["-9007199254740991", -9007199254740991],
  ["9007199254740993", 9007199254740993n],
  ["9223372036854775807", 9223372036854775807n],
  ["-9223372036854775808", -9223372036854775808n],
];
const WIDE = STORED.filter(([text]) => Math.abs(Number(text)) > 2 ** 31);

function withStore<T>(run: (path: string) => T): T {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE readings (id integer primary key, n integer)");
    STORED.forEach(([text], index) => {
      db.exec(`INSERT INTO readings VALUES (${index + 1}, ${text})`);
    });
  } finally {
    db.close();
  }
  try {
    return run(path);
  } finally {
    Deno.removeSync(path);
  }
}

function withPool<T>(run: (pool: ReadConnectionPool) => T): T {
  const pool = new ReadConnectionPool();
  try {
    return run(pool);
  } finally {
    pool.close();
  }
}

describe("ReadConnectionPool over a stored INTEGER", () => {
  it("stores values a default-mode connection returns wrapped", () => {
    // The control. Every case below would pass against a fixture whose values
    // all fit in 32 bits, so this shows the wide ones do not survive the
    // driver's default accessor.

    withStore((path) => {
      const db = new Database(path, { readonly: true });
      try {
        const wrapped = db.prepare(
          "SELECT n FROM readings WHERE n > 2147483647 OR n < -2147483648",
        ).all<{ n: number }>();
        expect(wrapped.length).toBe(WIDE.length);
        for (const { n } of wrapped) {
          expect(Math.abs(n)).toBeLessThanOrEqual(2 ** 31);
        }
      } finally {
        db.close();
      }
    });
  });

  describe("query()", () => {
    it("returns each stored value whole, as a `number` within ±(2^53 - 1) and a `bigint` beyond", () => {
      withStore((path) => {
        withPool((pool) => {
          const rows = pool.query(path, "SELECT n FROM readings ORDER BY id");
          expect(rows.map((row) => row.n)).toEqual(
            STORED.map(([, value]) => value),
          );
        });
      });
    });

    it("returns the digits SQLite shows for each value", () => {
      // `toEqual` on a `number` cannot distinguish 9007199254740992 from
      // ...993, so the digits are compared as text against what was stored.

      withStore((path) => {
        withPool((pool) => {
          const rows = pool.query(path, "SELECT n FROM readings ORDER BY id");
          expect(rows.map((row) => String(row.n))).toEqual(
            STORED.map(([text]) => text),
          );
        });
      });
    });

    it("returns an aggregate and an expression over a wide value whole", () => {
      withStore((path) => {
        withPool((pool) => {
          const rows = pool.query(
            path,
            "SELECT max(n) AS newest, n + 1 AS next FROM readings " +
              "WHERE n = 1789000000000",
          );
          expect(rows).toEqual([{
            newest: 1789000000000,
            next: 1789000000001,
          }]);
        });
      });
    });
  });

  describe("queryWithOrigins()", () => {
    it("returns each stored value whole", () => {
      // Compared against what was stored rather than against `query()`: both
      // run on one connection, so the two agreeing would show nothing.

      withStore((path) => {
        withPool((pool) => {
          const { rows } = pool.queryWithOrigins(
            path,
            "SELECT n FROM readings ORDER BY id",
          );
          expect(rows.map((row) => String(row.n))).toEqual(
            STORED.map(([text]) => text),
          );
        });
      });
    });
  });
});
