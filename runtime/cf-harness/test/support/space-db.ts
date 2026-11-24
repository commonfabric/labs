/**
 * A space database in the shape the server's store writes, seeded with one
 * labelled cell, for a test that reads a run's cell labels back from its
 * space. The reader proves which space a file holds from the file's name,
 * so the file is named for the space's DID.
 */

import { Database } from "@db/sqlite";
import type { FabricValue } from "@commonfabric/data-model";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";

/** The space the seeded database holds, which its file is named for. */
export const SPACE_DB_DID =
  "did:key:z6MkfrQ3tCDZgvJcLwPTvxNsFR8RgTsHTa5JzmnW9pQrUvNq";

/** The one cell the space holds a label for. */
export const LABELED_CELL_ID = `of:fid1:${"labeled".padEnd(44, "0")}`;

/** The label the space holds on {@link LABELED_CELL_ID}, at its root. */
export const LABELED_CELL_LABEL = {
  confidentiality: ["demo-secret"],
  integrity: ["cf-compiled-by:cf-compiler"],
} as const;

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 1, 'active');
`;

const LABELED_DOCUMENT = {
  value: { secret: "the combination is 1234" },
  cfc: {
    version: 1,
    schemaHash: "fid1:C4ajDsLKcfdMDDs3lbNShZBcQCVA4qhVo5mRoBcgpB0",
    labelMap: {
      version: 1,
      entries: [{ path: [], label: LABELED_CELL_LABEL, origin: "declared" }],
    },
  },
};

/**
 * Writes the seeded database under `directory` and returns its path. The
 * document goes in through the codec, tagged the way the server writes one.
 */
export const seedSpaceDb = (directory: string): string => {
  const path = `${directory}/${SPACE_DB_DID}.sqlite`;
  const db = new Database(path, { create: true });
  try {
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
       VALUES (1, 'session:did:key:zX:u', 1, '{}', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
       VALUES (?, 1, 0, 'set', ?, 1)`,
    ).run(
      LABELED_CELL_ID,
      jsonFromFabricValue(LABELED_DOCUMENT as unknown as FabricValue),
    );
  } finally {
    db.close();
  }
  return path;
};
