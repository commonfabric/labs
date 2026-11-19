/**
 * The TEMP VIEWs `installCompactViews()` puts over a compact store, on a
 * synthetic store file read through a read-only connection with fake readers.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";

import {
  type CompactViewReaders,
  installCompactViews,
} from "../compact-views.ts";
import { openSpace } from "../db.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq         INTEGER NOT NULL PRIMARY KEY,
  branch      TEXT    NOT NULL DEFAULT '',
  session_id  TEXT    NOT NULL,
  local_seq   INTEGER NOT NULL,
  original    JSON    NOT NULL,
  resolution  JSON    NOT NULL,
  class       TEXT    NOT NULL DEFAULT 'authored',
  digest      BLOB,
  reads       BLOB
);
CREATE TABLE revision (
  branch      TEXT    NOT NULL DEFAULT '',
  id          TEXT    NOT NULL,
  scope_key   TEXT    NOT NULL DEFAULT 'space',
  seq         INTEGER NOT NULL,
  op_index    INTEGER NOT NULL,
  op          TEXT    NOT NULL,
  data        JSON,
  commit_seq  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE snapshot (
  branch    TEXT    NOT NULL DEFAULT '',
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  value     JSON    NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq)
);
`;

const VALUE_OBJECT_TABLE =
  `CREATE TABLE mem_value_object (vid INTEGER PRIMARY KEY, body BLOB NOT NULL);`;

/** Readers that name what they were handed, so a test sees which one ran. */
const fakeReaders: CompactViewReaders = {
  valueText: (cell) => typeof cell === "number" ? `fvj1:{"vid":${cell}}` : cell,
  commitOriginalText: (row) =>
    typeof row.original === "string" ? row.original : `fvj1:${
      JSON.stringify({
        blob: [...row.original],
        digest: row.digest === null ? null : [...row.digest],
        reads: row.reads === null ? null : [...row.reads],
        seq: row.seq,
        session: row.session_id,
      })
    }`,
  resolutionText: (seq, resolution) =>
    typeof resolution === "string"
      ? resolution
      : `fvj1:{"blob":${JSON.stringify([...resolution])},"seq":${seq}}`,
};

/** Writes a store with one row of each form into a new file and returns its path. */
function writeStore(
  dir: string,
  { compact }: { compact: boolean },
): string {
  const path = `${dir}/space.sqlite`;
  const db = new Database(path);
  try {
    db.exec(SCHEMA);
    if (compact) db.exec(VALUE_OBJECT_TABLE);
    const commit = db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution, digest, reads)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    commit.run(1, "s:one", 1, 'fvj1:{"genesis":1}', 'fvj1:{"seq":1}');
    commit.run(
      2,
      "s:two",
      2,
      Uint8Array.of(0x01, 0x7b, 0x7d),
      Uint8Array.of(0x00),
      Uint8Array.of(0x00, 9),
      Uint8Array.of(0x00, 4),
    );
    const revision = db.prepare(
      `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
       VALUES (?, ?, 0, ?, ?, ?)`,
    );
    revision.run("of:text", 1, "set", 'fvj1:{"value":1}', 1);
    revision.run("of:vid", 2, "set", 7, 2);
    revision.run("of:gone", 2, "delete", null, 2);
    const snapshot = db.prepare(
      `INSERT INTO snapshot (id, seq, value) VALUES (?, ?, ?)`,
    );
    snapshot.run("of:text", 1, 'fvj1:{"value":1}');
    snapshot.run("of:vid", 2, 8);
    commit.finalize();
    revision.finalize();
    snapshot.finalize();
  } finally {
    db.close();
  }
  return path;
}

describe("installCompactViews()", () => {
  let dir: string;
  let db: Database | undefined;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "compact-views-" });
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    await Deno.remove(dir, { recursive: true });
  });

  it("presents every payload form as text on a read-only connection", () => {
    db = new Database(writeStore(dir, { compact: true }), {
      readonly: true,
    });
    expect(installCompactViews(db, fakeReaders)).toBe(true);

    expect(
      db.prepare(`SELECT id, data FROM revision ORDER BY id`).all(),
    ).toEqual([
      { id: "of:gone", data: null },
      { id: "of:text", data: 'fvj1:{"value":1}' },
      { id: "of:vid", data: 'fvj1:{"vid":7}' },
    ]);
    expect(
      db.prepare(`SELECT id, value FROM snapshot ORDER BY id`).all(),
    ).toEqual([
      { id: "of:text", value: 'fvj1:{"value":1}' },
      { id: "of:vid", value: 'fvj1:{"vid":8}' },
    ]);
    expect(
      db.prepare(`SELECT seq, original, resolution FROM "commit" ORDER BY seq`)
        .all(),
    ).toEqual([
      {
        seq: 1,
        original: 'fvj1:{"genesis":1}',
        resolution: 'fvj1:{"seq":1}',
      },
      {
        seq: 2,
        original:
          'fvj1:{"blob":[1,123,125],"digest":[0,9],"reads":[0,4],"seq":2,"session":"s:two"}',
        resolution: 'fvj1:{"blob":[0],"seq":2}',
      },
    ]);
  });

  it("presents a payload as SQL text, exact for empty and non-ASCII text", () => {
    db = new Database(writeStore(dir, { compact: true }), {
      readonly: true,
    });
    const texts = new Map([[7, ""], [
      8,
      'fvj1:{"value":"h\u00e9llo \u2603 \ud834\udd1e"}',
    ]]);
    installCompactViews(db, {
      ...fakeReaders,
      valueText: (cell) => typeof cell === "number" ? texts.get(cell)! : cell,
    });

    expect(
      db.prepare(
        `SELECT typeof(data) AS kind, data FROM revision WHERE id = 'of:vid'`,
      ).get(),
    ).toEqual({ kind: "text", data: "" });
    expect(
      db.prepare(
        `SELECT typeof(value) AS kind, value FROM snapshot WHERE id = 'of:vid'`,
      ).get(),
    ).toEqual({ kind: "text", value: texts.get(8) });
  });

  it("passes every other column through under its own name, in table order", () => {
    db = new Database(writeStore(dir, { compact: true }), {
      readonly: true,
    });
    installCompactViews(db, fakeReaders);
    for (const table of ["revision", "snapshot", "commit"]) {
      const viewColumns = db.prepare(
        `SELECT name FROM pragma_table_info(?, 'temp') ORDER BY cid`,
      ).all<{ name: string }>(table).map(({ name }) => name);
      const tableColumns = db.prepare(
        `SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid`,
      ).all<{ name: string }>(table).map(({ name }) => name);
      expect(viewColumns).toEqual(tableColumns);
    }
    expect(
      db.prepare(
        `SELECT branch, scope_key, seq, op_index, op, commit_seq FROM revision WHERE id = 'of:vid'`,
      ).get(),
    ).toEqual({
      branch: "",
      scope_key: "space",
      seq: 2,
      op_index: 0,
      op: "set",
      commit_seq: 2,
    });
    expect(
      db.prepare(
        `SELECT branch, session_id, local_seq, class, digest, reads FROM "commit" WHERE seq = 2`,
      ).get(),
    ).toEqual({
      branch: "",
      session_id: "s:two",
      local_seq: 2,
      class: "authored",
      digest: Uint8Array.of(0x00, 9),
      reads: Uint8Array.of(0x00, 4),
    });
  });

  it("plans a primary-key lookup on the `revision` view as a search on the table's key", () => {
    db = new Database(writeStore(dir, { compact: true }), {
      readonly: true,
    });
    installCompactViews(db, fakeReaders);
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT data FROM revision
       WHERE branch = '' AND id = 'of:vid' AND scope_key = 'space' AND seq = 2 AND op_index = 0`,
    ).all<{ detail: string }>().map(({ detail }) => detail);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatch(
      /^SEARCH main\.revision USING INDEX sqlite_autoindex_revision_1 \(branch=\? AND id=\? AND scope_key=\? AND seq=\? AND op_index=\?\)$/,
    );
  });

  it("installs nothing and returns `false` on a store without `mem_value_object`", () => {
    db = new Database(writeStore(dir, { compact: false }), {
      readonly: true,
    });
    expect(installCompactViews(db, fakeReaders)).toBe(false);
    expect(
      db.prepare(`SELECT name FROM sqlite_temp_master`).all(),
    ).toEqual([]);
    expect(
      db.prepare(`SELECT data FROM revision WHERE id = 'of:vid'`).get(),
    ).toEqual({ data: 7 });
  });

  it("reads a store the engine wrote as text through `openSpace()`", async () => {
    const path = `${dir}/engine.sqlite`;
    const document = {
      value: { title: "a synthetic title long enough to be stored by vid" },
    };
    const commit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:doc", value: document }],
    };
    const engine = await open({ url: toFileUrl(path) });
    try {
      applyCommit(engine, {
        sessionId: "session:views",
        commit: {
          ...commit,
          operations: [{ op: "set", id: "of:first", value: { value: 1 } }],
        },
      } as never);
      applyCommit(engine, {
        sessionId: "session:views",
        commit: { ...commit, localSeq: 2 },
      } as never);
      const raw = engine.database.prepare(
        `SELECT typeof(data) AS kind FROM revision WHERE id = 'of:doc'`,
      ).get<{ kind: string }>();
      expect(raw).toEqual({ kind: "integer" });
    } finally {
      close(engine);
    }

    const space = openSpace(path);
    try {
      expect(
        space.get(`SELECT data FROM revision WHERE id = 'of:doc'`),
      ).toEqual({ data: encodeMemoryBoundary(document) });
      expect(
        space.get(`SELECT original, resolution FROM "commit" WHERE seq = 2`),
      ).toEqual({
        original: encodeMemoryBoundary({ ...commit, localSeq: 2 }),
        resolution: encodeMemoryBoundary({ seq: 2 }),
      });
    } finally {
      space.close();
    }
  });
});
