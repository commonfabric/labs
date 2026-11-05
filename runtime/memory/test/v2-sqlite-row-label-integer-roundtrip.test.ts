/**
 * A row rule gates on the INTEGER the row actually holds, read through the
 * pooled connection a labeled query really runs on.
 *
 * The evaluator's own tests establish what text a JS number shows a regex.
 * They cannot establish that the number is the stored one: `@db/sqlite` reads
 * an INTEGER column through `sqlite3_column_int` — the 32-bit accessor —
 * unless the connection is opened with `int64`, so a stored 4294967303
 * arrives as 7 and a gate meant for mailbox 7 admits a row from another
 * mailbox entirely. Nothing about that is visible to the evaluator: 7 and a
 * wrapped 7 are the same JS value. So the guarantee has to be established
 * here, at the driver, with values stored on disk and read back out.
 *
 * Spec: docs/specs/sqlite-builtin/06-cfc.md ("Per-row labels").
 */

import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  columnOriginAvailable,
  columnOriginUnavailableReason,
  ensureColumnOriginAvailable,
} from "../v2/sqlite/column-origin.ts";
import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";
import {
  all,
  constant,
  dbOwner,
  evaluateRowLabel,
  match,
  principal,
  regexInputText,
  type RowLabelSpec,
  whenMatches,
} from "../v2/sqlite/row-label.ts";
import { table } from "../v2/sqlite/schema.ts";

// The labeled read path resolves column origins over FFI, so a labeled query
// cannot run at all without it (production binds it once before issuing one).
await ensureColumnOriginAvailable();

const OWNER = "did:key:zOwner";
const SEVEN = "did:mailbox:seven";
const BIG = "did:mailbox:big";
const ERA = "did:era:2024";

// Three stored ids: one small, one past 2^31 (where the 32-bit accessor wraps),
// one past 2^53 (where a double cannot name the integer at all). The timestamp
// is an ordinary epoch-millisecond value, which is itself past 2^31.
const ROWS = [
  { id: 1, source_id: "7" },
  { id: 2, source_id: "4294967303" },
  { id: 3, source_id: "9007199254740993" },
];
const TS = "1725000000000";

function spec(): RowLabelSpec {
  const schema = table(
    { id: "integer primary key", source_id: "integer", ts: "integer" },
    (f) => ({
      confidentiality: all(
        whenMatches(f.source_id, /^7$/, constant(SEVEN)),
        whenMatches(f.source_id, /^4294967303$/, constant(BIG)),
        whenMatches(f.ts, new RegExp(`^${TS}$`), constant(ERA)),
        principal("mailbox", match(f.source_id, /\d+/, { min: 1 })),
        dbOwner(),
      ),
    }),
  );
  return schema.rowLabel as RowLabelSpec;
}

function withStore<T>(run: (path: string) => T): T {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TABLE messages (id integer primary key, source_id integer, " +
        "ts integer)",
    );
    for (const row of ROWS) {
      db.exec(
        `INSERT INTO messages VALUES (${row.id}, ${row.source_id}, ${TS})`,
      );
    }
  } finally {
    db.close();
  }
  try {
    return run(path);
  } finally {
    Deno.removeSync(path);
  }
}

describe("row-label over a stored INTEGER", () => {
  it("binds the column-origin symbols a labeled query needs", () => {
    expect(columnOriginUnavailableReason()).toBeUndefined();
    expect(columnOriginAvailable()).toBe(true);
  });

  it("shows the regex the digits SQLite stored, not the low 32 bits", () => {
    withStore((path) => {
      const pool = new ReadConnectionPool();
      try {
        const { rows } = pool.queryWithOrigins(
          path,
          "SELECT id, source_id, ts FROM messages ORDER BY id",
        );
        expect(rows.map((row) => regexInputText(row.source_id))).toEqual(
          ROWS.map((row) => row.source_id),
        );
        expect(rows.map((row) => regexInputText(row.ts))).toEqual([
          TS,
          TS,
          TS,
        ]);
      } finally {
        pool.close();
      }
    });
  });

  it("gates each row on its own mailbox", () => {
    withStore((path) => {
      const pool = new ReadConnectionPool();
      try {
        const { rows } = pool.queryWithOrigins(
          path,
          "SELECT id, source_id, ts FROM messages ORDER BY id",
        );
        const labels = rows.map((row) =>
          evaluateRowLabel(spec(), row, { dbOwner: OWNER })
        );
        expect(labels).toEqual([
          {
            confidentiality: [SEVEN, ERA, "did:mailbox:7", OWNER],
            integrity: [],
          },
          {
            confidentiality: [BIG, ERA, "did:mailbox:4294967303", OWNER],
            integrity: [],
          },
          {
            confidentiality: [ERA, "did:mailbox:9007199254740993", OWNER],
            integrity: [],
          },
        ]);
      } finally {
        pool.close();
      }
    });
  });

  it("leaves an ordinary read on the connection it always used", () => {
    // The labeled path is the one that has to see whole integers. An
    // unlabeled `query()` keeps whatever the driver gave it before, so a
    // consumer reading rows outside CFC sees no change from this.
    withStore((path) => {
      const pool = new ReadConnectionPool();
      try {
        const rows = pool.query(
          path,
          "SELECT source_id FROM messages ORDER BY id",
        );
        expect(rows.map((row) => typeof row.source_id)).toEqual([
          "number",
          "number",
          "number",
        ]);
      } finally {
        pool.close();
      }
    });
  });
});
