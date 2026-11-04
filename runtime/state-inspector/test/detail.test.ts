/**
 * The detail pass over a LEGACY process cell — a `{ $TYPE, resultRef, … }`
 * value from before the modern piece manifest.
 *
 * This is the one place `detail.ts` derives an entity's owned-cell manifest by
 * WALKING a value for links rather than reading a manifest the store wrote, so
 * it is where the link walk decides what the detail says a piece owns. Nothing
 * else covered it, which is why a longer comment inside the block moved the
 * coverage gate: the whole block was unexecuted.
 *
 * LEGACY-PROCESS-CELL: retires with the process-cell era, together with the
 * `regime === "legacy"` branches in `model.ts` and `detail.ts`.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { openSpace, type SpaceDb } from "../db.ts";
import { buildAllDetails, type EntityDetail } from "../detail.ts";

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
`;

/** A plain-JSON sigil link to an entity id. */
const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  const session = "session:did:key:zSpaceAAAA:11111111-2222-3333";

  // The legacy process cell. `internal` is a plain value holding links at
  // assorted depths rather than a manifest, so the detail has to walk it.
  commit.run(1, session, 1);
  rev.run(
    "of:process",
    1,
    JSON.stringify({
      value: {
        $TYPE: "recipe",
        resultRef: link("of:result"),
        argument: link("of:arg"),
        internal: {
          counter: link("of:owned-1"),
          nested: { deeper: [link("of:owned-2")] },
        },
      },
    }),
    1,
  );

  // Its result cell, which is where a legacy process cell's name lives. A
  // legacy result links back to its process cell through a TOP-LEVEL `source`,
  // which is what classifies it as a piece rather than a free cell.
  commit.run(2, session, 2);
  rev.run(
    "of:result",
    2,
    JSON.stringify({
      value: { $NAME: "Legacy Notebook", $UI: {} },
      source: link("of:process"),
    }),
    2,
  );

  // The three cells the process cell names: its argument and its two owned.
  ["of:arg", "of:owned-1", "of:owned-2"].forEach((id, index) => {
    const seq = index + 3;
    commit.run(seq, session, seq);
    rev.run(id, seq, JSON.stringify({ value: { n: seq } }), seq);
  });
  db.close();
}

describe("detail", () => {
  describe("a legacy process cell", () => {
    let dir: string;
    let space: SpaceDb;
    let detail: EntityDetail;

    beforeAll(async () => {
      dir = await Deno.makeTempDir({
        prefix: "state-inspector-legacy-detail-",
      });
      const path = `${dir}/did:key:zSpaceAAAA.sqlite`;
      seed(path);
      space = openSpace(path);
      detail = buildAllDetails(space).details.find((d) =>
        d.id === "of:process"
      )!;
    });

    afterAll(async () => {
      space.close();
      await Deno.remove(dir, { recursive: true });
    });

    it("classifies the entity as a legacy process piece", () => {
      expect(detail.kind).toBe("piece");
      expect(detail.regime).toBe("legacy");
      expect(detail.role).toBe("piece (legacy process)");
    });

    it("resolves `resultRef` to the result cell as the detail's result lineage", () => {
      expect(detail.lineage.result?.id).toBe("of:result");
    });

    it("names the owned cells by walking `internal`, at every depth it holds them", () => {
      // The manifest a modern piece stores explicitly, recovered here by the
      // link walk — which is the whole reason this path reads a value for links.
      expect(detail.lineage.internal?.map((r) => r.id).sort()).toEqual([
        "of:owned-1",
        "of:owned-2",
      ]);
    });

    it("resolves each walked link to its target's label, not just its id", () => {
      const result = detail.lineage.result!;
      expect(result.kind).toBe("piece");
      expect(result.label).toBe("Legacy Notebook");
    });

    it("reports the process cell's own outgoing links with the path each sat at", () => {
      const at = new Map(detail.outLinks.map((l) => [l.id, l.at]));
      expect(at.get("of:result")).toBe("resultRef");
      expect(at.get("of:owned-2")).toBe("internal/nested/deeper/0");
    });
  });
});
