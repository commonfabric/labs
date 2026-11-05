/**
 * A pooled read returns the text a JSON function builds as a string, whichever
 * plan SQLite picks for the statement.
 *
 * SQLite marks what `json_object`, `json_group_array`, `json()`, `->`, and
 * `json_extract` of a container path return with a JSON subtype, and
 * `@db/sqlite` by default parses a TEXT column carrying that subtype into an
 * object or array. The subtype does not survive a sorter, so the same
 * expression reaches a consumer as a string under one plan and as an object
 * under another. A consumer's `Row` type says `string`, and a typed consumer
 * never runs on a value its type does not admit.
 *
 * The pool's own connection is the thing under test, so every read here goes
 * through `ReadConnectionPool.query()`. A second, default-mode connection to
 * the same file is the control: it shows that the unsorted statement really
 * does carry the subtype as far as the driver, which is what makes a string
 * from the pool a fact about the pool rather than about the statement.
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

// `body` has no index, so ordering by it needs a sorter; `id` is the rowid, so
// ordering by it does not. The projected expression is the same in both.
const PACKED = "json_object('id', id, 'body', body)";
const SORTED = `SELECT ${PACKED} AS j FROM messages ORDER BY body`;
const UNSORTED = `SELECT ${PACKED} AS j FROM messages ORDER BY id`;
const SORTER = "USE TEMP B-TREE FOR ORDER BY";

// One statement per way a result column comes to carry the JSON subtype, each
// free of a sorter, a materialized subquery, and a CTE.
const SUBTYPE_SOURCES: [string, string][] = [
  ["json_object()", `SELECT ${PACKED} AS j FROM messages WHERE id = 1`],
  ["json_group_array()", "SELECT json_group_array(id) AS j FROM messages"],
  [
    "json_group_object()",
    "SELECT json_group_object(id, body) AS j FROM messages",
  ],
  ["json()", "SELECT json(envelope) AS j FROM messages WHERE id = 1"],
  [
    "json_array()",
    "SELECT json_array(id, body) AS j FROM messages WHERE id = 1",
  ],
  [
    "json_extract() of a container path",
    "SELECT json_extract(envelope, '$.tags') AS j FROM messages WHERE id = 1",
  ],
  [
    "the -> operator",
    "SELECT envelope -> '$.tags' AS j FROM messages WHERE id = 1",
  ],
  [
    "json_each.value of a container",
    "SELECT value AS j FROM messages, json_each(envelope, '$.nested') " +
    "WHERE messages.id = 1",
  ],
];

function withStore<T>(run: (path: string) => T): T {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TABLE messages (id integer primary key, body text, envelope text)",
    );
    db.exec(
      "INSERT INTO messages VALUES " +
        `(1, 'zebra', '{"tags":["a","b"],"nested":[{"k":1}]}'), ` +
        `(2, 'apple', '{"tags":[],"nested":[]}')`,
    );
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

/** The plan SQLite reports for `sql`, one detail line per step. */
function planOf(path: string, sql: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all<{ detail: string }>()
      .map((step) => step.detail);
  } finally {
    db.close();
  }
}

/** The JS types of column `j` as a default-mode connection returns them. */
function defaultModeTypes(path: string, sql: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(sql).all<{ j: unknown }>().map((row) => typeof row.j);
  } finally {
    db.close();
  }
}

describe("ReadConnectionPool over a JSON-subtype column", () => {
  describe("query()", () => {
    it("reads the two statements under different plans, one with a sorter", () => {
      // Everything below compares a sorted plan with an unsorted one. Should a
      // future SQLite plan both statements alike, those cases compare a plan
      // with itself, and this is the case that reports it.

      withStore((path) => {
        expect(planOf(path, SORTED)).toContain(SORTER);
        expect(planOf(path, UNSORTED)).not.toContain(SORTER);
      });
    });

    it("returns a string for a packed column under the sorted plan", () => {
      withStore((path) => {
        withPool((pool) => {
          const rows = pool.query(path, SORTED);
          expect(rows.map((row) => typeof row.j)).toEqual(["string", "string"]);
        });
      });
    });

    it("returns a string for the same column under the unsorted plan", () => {
      withStore((path) => {
        // The control: by default the driver parses this statement's column,
        // so the subtype demonstrably reaches it under this plan.
        expect(defaultModeTypes(path, UNSORTED)).toEqual(["object", "object"]);

        withPool((pool) => {
          const rows = pool.query(path, UNSORTED);
          expect(rows.map((row) => typeof row.j)).toEqual(["string", "string"]);
        });
      });
    });

    it("returns the same text under both plans", () => {
      withStore((path) => {
        withPool((pool) => {
          const sorted = pool.query<{ j: string }>(path, SORTED);
          const unsorted = pool.query<{ j: string }>(path, UNSORTED);
          expect(sorted.map((row) => row.j).sort()).toEqual(
            unsorted.map((row) => row.j).sort(),
          );
          expect(unsorted.map((row) => JSON.parse(row.j))).toEqual([
            { id: 1, body: "zebra" },
            { id: 2, body: "apple" },
          ]);
        });
      });
    });

    for (const [source, sql] of SUBTYPE_SOURCES) {
      it(`returns a string for ${source}`, () => {
        withStore((path) => {
          // The control, as above: the default mode parses this column.
          expect(defaultModeTypes(path, sql)).toEqual(["object"]);

          withPool((pool) => {
            const rows = pool.query(path, sql);
            expect(rows.map((row) => typeof row.j)).toEqual(["string"]);
          });
        });
      });
    }
  });

  describe("queryWithOrigins()", () => {
    it("returns a string for a packed column", () => {
      withStore((path) => {
        withPool((pool) => {
          const { rows } = pool.queryWithOrigins(
            path,
            UNSORTED,
          );
          expect(rows.map((row) => typeof row.j)).toEqual(["string", "string"]);
        });
      });
    });
  });
});
