import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
import { summarizeSpace } from "../queries.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, scope_key TEXT NOT NULL,
  seq INTEGER NOT NULL, op_index INTEGER NOT NULL, op TEXT NOT NULL,
  data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (name TEXT, head_seq INTEGER, status TEXT);
INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
  VALUES (1, 'session:did:key:zX:u', 1, '{}', '{}');
INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
  VALUES ('of:a', 'space', 1, 0, 'set', '{"value":1}', 1);
INSERT INTO branch VALUES ('', 1, 'active');
`;

describe("queries", () => {
  describe("summarizeSpace()", () => {
    it("returns whether the scheduler basis table exists, and how many rows it holds", async () => {
      const dir = await Deno.makeTempDir({
        prefix: "state-inspector-queries-",
      });
      try {
        const summarize = (name: string, extra: string) => {
          const path = `${dir}/${name}.sqlite`;
          const db = new Database(path, { create: true });
          db.exec(SCHEMA + extra);
          db.close();
          const space = openSpace(path);
          try {
            const { hasSchedulerBasisTable, schedulerBasisRows, commits } =
              summarizeSpace(space);
            return { hasSchedulerBasisTable, schedulerBasisRows, commits };
          } finally {
            space.close();
          }
        };

        expect(summarize("absent", "")).toEqual({
          hasSchedulerBasisTable: false,
          schedulerBasisRows: 0,
          commits: 1,
        });
        expect(
          summarize("empty", "CREATE TABLE scheduler_basis (x INTEGER);"),
        ).toEqual({
          hasSchedulerBasisTable: true,
          schedulerBasisRows: 0,
          commits: 1,
        });
        expect(
          summarize(
            "populated",
            `CREATE TABLE scheduler_basis (x INTEGER);
             INSERT INTO scheduler_basis VALUES (1), (2), (3);`,
          ),
        ).toEqual({
          hasSchedulerBasisTable: true,
          schedulerBasisRows: 3,
          commits: 1,
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
