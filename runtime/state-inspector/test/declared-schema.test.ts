/**
 * The DECLARED schema of a named owned cell or stream, which the entity itself
 * does not carry: it is resolved from where the owner piece names it, link
 * first and the owner's result schema second. What the link stores decides,
 * including when what it stores is a boolean, and the naming link is found in
 * either at-rest form.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import {
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";

import { openSpace } from "../db.ts";
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
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 9, 'active');
`;

const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

/** A link in the legacy at-rest sigil form. */
function link(id: string, schema?: unknown): unknown {
  return {
    "/": {
      "link@1": { id, path: [], ...(schema === undefined ? {} : { schema }) },
    },
  };
}

/** The owner's result schema, which stands in when a link declares nothing. */
const OWNER_SCHEMA = {
  type: "object",
  properties: {
    fromOwner: { $ref: "#/$defs/OwnerDeclared" },
    permissive: { $ref: "#/$defs/OwnerDeclared" },
  },
  $defs: {
    OwnerDeclared: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

/**
 * A piece naming three owned cells: one whose link carries a schema, one whose
 * link carries the schema `true`, and one whose link carries none at all. The
 * owner's result schema declares the last two, so it can be told apart from
 * what a link says.
 */
function seed(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );

  // A modern link instance survives at rest only through the codec envelope.
  setModernCellRepConfig(true);
  let modernPieceValue: string;
  try {
    modernPieceValue = jsonFromFabricValue({
      value: {
        modernNamed: new FabricLink({ id: "of:modern-cell", path: [] }),
      },
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: OWNER_SCHEMA,
    });
  } finally {
    resetModernCellRepConfig();
  }

  commit.run(1, 1);
  rev.run(
    "of:piece",
    1,
    JSON.stringify({
      value: {
        fromLink: link("of:link-schema-cell", {
          type: "object",
          properties: { declaredOnTheLink: { type: "string" } },
        }),
        permissive: link("of:permissive-cell", true),
        fromOwner: link("of:owner-schema-cell"),
      },
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: OWNER_SCHEMA,
    }),
    1,
  );
  for (
    const [seq, id] of [
      [2, "of:link-schema-cell"],
      [3, "of:permissive-cell"],
      [4, "of:owner-schema-cell"],
    ] as const
  ) {
    commit.run(seq, seq);
    rev.run(
      id,
      seq,
      JSON.stringify({ value: "v", result: link("of:piece") }),
      seq,
    );
  }

  commit.run(5, 5);
  rev.run("of:modern-piece", 5, modernPieceValue, 5);
  commit.run(6, 6);
  rev.run(
    "of:modern-cell",
    6,
    JSON.stringify({ value: "v", result: link("of:modern-piece") }),
    6,
  );
  db.close();
}

/** Every entity's detail, keyed by id. */
async function details(): Promise<Map<string, EntityDetail>> {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-declared-" });
  const dbPath = `${dir}/space.sqlite`;
  seed(dbPath);
  const space = openSpace(dbPath);
  try {
    return new Map(buildAllDetails(space).details.map((d) => [d.id, d]));
  } finally {
    space.close();
    await Deno.remove(dir, { recursive: true });
  }
}

describe("declared-schema", () => {
  describe("buildAllDetails()", () => {
    it("resolves a named cell's schema from the link that names it", async () => {
      const detail = (await details()).get("of:link-schema-cell");
      expect(detail?.schema).toEqual({
        type: "object",
        properties: { declaredOnTheLink: { type: "string" } },
      });
      expect(detail?.schemaSource).toContain("link");
    });

    it("resolves `true` from a link that stores it, not the owner's declaration", async () => {
      // `true` constrains nothing, which is a fact about the link and not an
      // absence: the owner's declaration standing in here would report a
      // constraint the stored link does not carry.
      const detail = (await details()).get("of:permissive-cell");
      expect(detail?.schema).toBe(true);
      expect(detail?.schemaKeys).toBe(undefined);
      expect(detail?.schemaSource).toContain("link");
    });

    it("falls back to the owner's result schema for a link storing no schema", async () => {
      const detail = (await details()).get("of:owner-schema-cell");
      expect(detail?.schema).toEqual(OWNER_SCHEMA.$defs.OwnerDeclared);
      expect(detail?.schemaSource).toContain("owner schema");
    });

    it("names a cell whose owner points at it with a modern `FabricLink`", async () => {
      // The naming pass indexes children by link, so a modern link has to be
      // read as one — otherwise the cell is never named and never reaches the
      // declared-schema lookup at all.
      const detail = (await details()).get("of:modern-cell");
      expect(detail?.label).toBe("modernNamed");
    });
  });
});
