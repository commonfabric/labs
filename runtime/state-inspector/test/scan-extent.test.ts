/**
 * A capped space-wide scan returns a SUBSET that looks exactly like a complete
 * one. These tests pin the two properties that tell them apart: every capped
 * scan reports how far it reached, and a `kind` filter selects DURING the scan
 * so the limit counts the entities the caller asked for.
 *
 * The seeded space makes the two orders disagree on purpose — six busy free
 * cells sort ahead of the three quiet pieces — because that is the shape where
 * filtering after the scan returns "the pieces among the first N entities"
 * rather than pieces, and the two are indistinguishable from the result.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { openSpace, type SpaceDb } from "../db.ts";
import {
  countEntities,
  DEFAULT_SCAN_LIMIT,
  entityKinds,
  isCompleteScan,
  isEntityKind,
  listEntityModels,
  rowLimit,
  scanLimit,
  visibleEntityRows,
} from "../model.ts";
import { reconstructDocument } from "../reconstruct.ts";
import { contentFingerprint } from "../fingerprint.ts";
import { listScopes, scopeOverlay } from "../scopes.ts";
import { buildAllDetails } from "../detail.ts";
import { hotEntities } from "../queries.ts";
import { contendedEntities } from "../conflicts.ts";
import { buildSpaceGraph, subgraphAround } from "../graph.ts";
import { buildInspectorBundle, renderInspectorHtml } from "../html.ts";

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
`;

const SESSION = "session:did:key:zSpaceAAAA:11111111-2222-3333";
const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

interface SeedEntity {
  id: string;

  /** The stored document, written once per revision. */
  document: Record<string, unknown>;

  revisions: number;

  /** Branch the revisions are written on. Defaults to the space branch. */
  branch?: string;

  /** Written after the revisions: the entity's visible head is a tombstone. */
  deleted?: boolean;

  /** Scope the revisions are written under. Defaults to the shared scope. */
  scope?: string;
}

/** A stored payload `decodeStored` cannot read, standing in for a bad write. */
const UNDECODABLE = "<<< not a document >>>" as unknown as Record<
  string,
  unknown
>;

/** Six busy cells, one module, three quiet pieces — busiest scanned first. */
const ENTITIES: SeedEntity[] = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `of:cell-${i + 1}`,
    document: { value: `cell ${i + 1}` },
    revisions: 5,
  })),
  {
    id: "of:mod",
    document: {
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        code: "export default () => null;\n",
        filename: "/api/patterns/system/notes/notebook.tsx",
        imports: [],
      },
    },
    revisions: 2,
  },
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `of:piece-${i + 1}`,
    document: {
      value: { $NAME: `Topic ${i + 1}` },
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
    },
    revisions: 1,
  })),
];

const TOTAL = ENTITIES.length;
const PIECES = ENTITIES.filter((e) => e.id.startsWith("of:piece-")).length;

function seed(
  path: string,
  entities: SeedEntity[] = ENTITIES,
  branches: { name: string; parent?: string; forkSeq?: number }[] = [],
): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const branchRow = db.prepare(
    `INSERT INTO branch (name, parent_branch, fork_seq, head_seq)
     VALUES (?, ?, ?, 9999)`,
  );
  for (const b of branches) {
    branchRow.run(b.name, b.parent ?? null, b.forkSeq ?? null);
  }
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  let seq = 0;
  const write = (entity: SeedEntity, op: string, data: string | null) => {
    seq++;
    const branch = entity.branch ?? "";
    commit.run(seq, branch, SESSION, seq);
    rev.run(branch, entity.id, entity.scope ?? "space", seq, op, data, seq);
  };
  for (const entity of entities) {
    for (let n = 0; n < entity.revisions; n++) {
      write(
        entity,
        "set",
        entity.document === UNDECODABLE
          ? (UNDECODABLE as unknown as string)
          : JSON.stringify(entity.document),
      );
    }
    if (entity.deleted) write(entity, "delete", null);
  }
  db.close();
}

/** Open a space seeded for one test, and clean it up after. */
async function withSeeded(
  entities: SeedEntity[],
  branches: { name: string; parent?: string; forkSeq?: number }[],
  run: (space: SpaceDb) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-scan-" });
  seed(`${dir}/space.sqlite`, entities, branches);
  const space = openSpace(`${dir}/space.sqlite`);
  try {
    run(space);
  } finally {
    space.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const cells = (n: number, revisions: number, opts: Partial<SeedEntity> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `of:cell-${i + 1}`,
    document: { value: `cell ${i + 1}` },
    revisions,
    ...opts,
  }));

describe("scan-extent", () => {
  let dir: string;
  let space: SpaceDb;

  beforeAll(async () => {
    dir = await Deno.makeTempDir({ prefix: "state-inspector-scan-extent-" });
    seed(`${dir}/space.sqlite`, ENTITIES, [{ name: "" }]);
    space = openSpace(`${dir}/space.sqlite`);
  });

  afterAll(async () => {
    space.close();
    await Deno.remove(dir, { recursive: true });
  });

  describe("countEntities()", () => {
    it("returns every entity on the branch and scope, however busy each is", () => {
      expect(countEntities(space)).toBe(TOTAL);
    });

    it("returns 0 for a scope the space stores nothing under", () => {
      expect(countEntities(space, { scope: "user:did:key:zNobody" })).toBe(0);
    });
  });

  describe("entityKinds", () => {
    it("names every kind a listing presents, in the order it presents them", () => {
      expect(entityKinds).toEqual([
        "piece",
        "module",
        "stream",
        "schema",
        "owned-cell",
        "free-cell",
        "unknown",
        "deleted",
      ]);
    });
  });

  describe("isEntityKind()", () => {
    it("returns true for a name a listing presents", () => {
      expect(isEntityKind("owned-cell")).toBe(true);
    });

    it("returns false for a plural spelling of one", () => {
      expect(isEntityKind("pieces")).toBe(false);
    });
  });

  describe("listEntityModels()", () => {
    it("returns the entities the limit allowed and reports the result truncated", () => {
      const listing = listEntityModels(space, { limit: 3 });
      expect(listing.entities.length).toBe(3);
      expect(listing.extent).toEqual({
        limit: 3,
        total: TOTAL,
        truncated: true,
        unreadable: 0,
      });
    });

    it("reports truncation one below the entity count and not at it", () => {
      expect(listEntityModels(space, { limit: TOTAL - 1 }).extent.truncated)
        .toBe(true);
      const whole = listEntityModels(space, { limit: TOTAL });
      expect(whole.entities.length).toBe(TOTAL);
      expect(whole.extent.truncated).toBe(false);
    });

    it("returns up to `limit` entities OF the requested kind, not the kinds among the first `limit` entities", () => {
      // The scan runs busiest-first, and at this limit it reaches only cells,
      // so a filter applied to its RESULT would return nothing. Assert that
      // first: it is what keeps the assertion below from passing vacuously.
      const unfiltered = listEntityModels(space, { limit: 6 });
      expect(unfiltered.entities.filter((e) => e.kind === "piece")).toEqual([]);

      const listing = listEntityModels(space, { kind: "piece", limit: 6 });
      expect(listing.entities.map((e) => e.kind)).toEqual(
        Array(PIECES).fill("piece"),
      );
      expect(listing.extent.truncated).toBe(false);
    });

    it("reports truncation when the space holds more of the requested kind than the limit", () => {
      const listing = listEntityModels(space, { kind: "piece", limit: 2 });
      expect(listing.entities.length).toBe(2);
      expect(listing.extent).toEqual({
        limit: 2,
        total: TOTAL,
        truncated: true,
        unreadable: 0,
      });
    });

    it("resolves a piece's pattern module across the entities the filter dropped", () => {
      const listing = listEntityModels(space, { kind: "piece" });
      expect(listing.entities.map((e) => e.lineage.pattern?.moduleId)).toEqual(
        Array(PIECES).fill("of:mod"),
      );
    });

    it("returns no entities for a kind the space holds none of", () => {
      const listing = listEntityModels(space, { kind: "schema" });
      expect(listing.entities).toEqual([]);
      expect(listing.extent.truncated).toBe(false);
    });

    it("returns nothing but reports truncation for a limit below one", () => {
      const listing = listEntityModels(space, { limit: 0 });
      expect(listing.entities).toEqual([]);
      expect(listing.extent).toEqual({
        limit: 0,
        total: TOTAL,
        truncated: true,
        unreadable: 0,
      });
    });
  });

  describe("buildSpaceGraph()", () => {
    it("returns the cap it applied and that the space outran it", () => {
      const graph = buildSpaceGraph(space, { limit: 3 });
      expect(graph.extent).toEqual({
        limit: 3,
        total: TOTAL,
        truncated: true,
        unreadable: 0,
      });
    });

    it("returns `truncated` false for a limit the whole space fits inside", () => {
      const graph = buildSpaceGraph(space, { limit: TOTAL });
      expect(graph.extent.truncated).toBe(false);
    });
  });

  describe("subgraphAround()", () => {
    it("returns the extent of the scan the neighborhood was cut from", () => {
      const graph = buildSpaceGraph(space, { limit: 3 });
      expect(subgraphAround(graph, "of:cell-1", 2).extent).toEqual(
        graph.extent,
      );
    });
  });

  describe("buildAllDetails()", () => {
    it("returns the details the limit allowed and reports the pass truncated", () => {
      const listing = buildAllDetails(space, { limit: 3 });
      expect(listing.details.length).toBe(3);
      expect(listing.extent).toEqual({
        limit: 3,
        total: TOTAL,
        truncated: true,
        unreadable: 0,
      });
    });

    it("returns `truncated` false for a limit the whole space fits inside", () => {
      expect(buildAllDetails(space, { limit: TOTAL }).extent.truncated).toBe(
        false,
      );
    });
  });

  describe("renderInspectorHtml()", () => {
    it("names the cap and the space's entity count in a truncated explorer", () => {
      const html = renderInspectorHtml(
        buildInspectorBundle(space, { limit: 3 }),
      );
      expect(html).toContain(`capped at 3 of ${TOTAL} entities`);
    });

    it("says nothing about a cap in an explorer that covers the space", () => {
      const html = renderInspectorHtml(
        buildInspectorBundle(space, { limit: TOTAL }),
      );
      expect(html).not.toContain("capped at");
    });
  });

  describe("visibleEntityRows()", () => {
    it("returns the entities a child branch inherited from its parent, not only the ones written on it", async () => {
      await withSeeded(
        [
          ...cells(3, 2),
          {
            id: "of:kid",
            document: { value: "kid" },
            revisions: 1,
            branch: "kid",
          },
        ],
        [{ name: "" }, { name: "kid", parent: "", forkSeq: 6 }],
        (kidSpace) => {
          // The parent's entities are readable from the child (that is what
          // `reconstructDocument` resolves), so the scan has to enumerate them.
          expect(
            reconstructDocument(kidSpace, { id: "of:cell-1", branch: "kid" }),
          ).toEqual({ value: "cell 1" });
          expect(
            visibleEntityRows(kidSpace, { branch: "kid" }).map((r) => r.id),
          ).toEqual(["of:cell-1", "of:cell-2", "of:cell-3", "of:kid"]);
        },
      );
    });

    it("omits an entity a child branch deleted, while the parent still lists it", async () => {
      await withSeeded(
        [
          ...cells(2, 1),
          {
            id: "of:cell-1",
            document: { value: "cell 1" },
            revisions: 0,
            branch: "kid",
            deleted: true,
          },
        ],
        [{ name: "" }, { name: "kid", parent: "", forkSeq: 2 }],
        (space) => {
          // The child's delete is the nearest row, so it hides the entity the
          // parent still holds — the same resolution a read makes.
          expect(
            reconstructDocument(space, { id: "of:cell-1", branch: "kid" }),
          ).toBeUndefined();
          expect(
            visibleEntityRows(space, { branch: "kid" }).map((r) => r.id),
          ).toEqual(["of:cell-2"]);
          expect(visibleEntityRows(space).map((r) => r.id)).toEqual([
            "of:cell-1",
            "of:cell-2",
          ]);
        },
      );
    });

    it("omits an entity whose visible head is a delete, and returns it under `includeDeleted`", async () => {
      await withSeeded(
        [
          ...cells(2, 1),
          {
            id: "of:gone",
            document: { value: "gone" },
            revisions: 1,
            deleted: true,
          },
        ],
        [{ name: "" }],
        (deleted) => {
          expect(visibleEntityRows(deleted).map((r) => r.id)).toEqual([
            "of:cell-1",
            "of:cell-2",
          ]);
          expect(
            visibleEntityRows(deleted, { includeDeleted: true }).map((r) =>
              r.id
            ),
          ).toContain("of:gone");
        },
      );
    });
  });

  describe("a child branch's scans", () => {
    /** Three inherited entities and one written on the child itself. */
    const inherited = (run: (space: SpaceDb) => void) =>
      withSeeded(
        [
          ...cells(3, 2),
          {
            id: "of:kid",
            document: { value: "kid" },
            revisions: 1,
            branch: "kid",
          },
        ],
        [{ name: "" }, { name: "kid", parent: "", forkSeq: 6 }],
        run,
      );

    it("counts the inherited entities in the extent rather than reporting a complete listing", async () => {
      await inherited((kidSpace) => {
        const listing = listEntityModels(kidSpace, { branch: "kid", limit: 2 });
        expect(listing.extent).toEqual({
          limit: 2,
          total: 4,
          truncated: true,
          unreadable: 0,
        });
      });
    });

    it("describes an inherited entity with the version log of the branch that holds its writes", async () => {
      await inherited((kidSpace) => {
        const listing = buildAllDetails(kidSpace, { branch: "kid" });
        expect(listing.extent.total).toBe(4);
        const detail = listing.details.find((d) => d.id === "of:cell-1");
        // Two writes, both on the parent before the fork — an empty log here
        // would describe an entity the child reads fine as having no history.
        expect(detail?.versions.map((v) => v.seq)).toEqual([1, 2]);
      });
    });
  });

  describe("a space holding a deleted entity", () => {
    /** Two live cells and one whose visible head is a tombstone. */
    const withTombstone = (run: (space: SpaceDb) => void) =>
      withSeeded(
        [
          ...cells(2, 2),
          {
            id: "of:gone",
            document: { value: "gone" },
            revisions: 1,
            deleted: true,
          },
        ],
        [{ name: "" }],
        run,
      );

    it("counts only the entities a detail pass describes, so a limit above them reports no truncation", async () => {
      await withTombstone((space) => {
        const listing = buildAllDetails(space, { limit: 2 });
        expect(listing.details.map((d) => d.id)).toEqual([
          "of:cell-1",
          "of:cell-2",
        ]);
        // Counting the tombstone would make this 3 of a 2-entity limit, and
        // announce a cap over a pass that described everything it could.
        expect(listing.extent).toEqual({
          limit: 2,
          total: 2,
          truncated: false,
          unreadable: 0,
        });
      });
    });

    it("counts only the entities a graph holds", async () => {
      await withTombstone((space) => {
        expect(buildSpaceGraph(space, { limit: 2 }).extent).toEqual({
          limit: 2,
          total: 2,
          truncated: false,
          unreadable: 0,
        });
      });
    });

    it("keeps the tombstone in the entity listing, which describes the space's records", async () => {
      await withTombstone((space) => {
        const listing = listEntityModels(space);
        expect(listing.entities.map((e) => e.id)).toContain("of:gone");
        expect(listing.extent.total).toBe(3);
      });
    });
  });

  describe("a module that ranks below the pieces pointing at it", () => {
    /** The document all three busy pieces share. */
    const PIECE_DOC = {
      value: { $NAME: "Topic" },
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
    };

    /** Three busy pieces, and their module written once, so it sorts last. */
    const quietModule = (run: (space: SpaceDb) => void) =>
      withSeeded(
        [
          ...Array.from({ length: 3 }, (_, i) => ({
            id: `of:piece-${i + 1}`,
            document: PIECE_DOC,
            revisions: 3,
          })),
          {
            id: "of:mod",
            document: {
              value: {
                kind: "source",
                identity: MODULE_IDENTITY,
                code: "export default () => null;\n",
                filename: "/api/patterns/system/notes/notebook.tsx",
                imports: [],
              },
            },
            revisions: 1,
          },
        ],
        [{ name: "" }],
        run,
      );

    it("resolves the pattern of every piece a capped `kind` scan returns", async () => {
      await quietModule((space) => {
        // The module sorts last, so a scan that stopped at the cap never
        // reached it. Assert that first: it is what keeps the assertion below
        // from passing vacuously.
        expect(
          listEntityModels(space, { limit: 2 }).entities.map((e) => e.kind),
        ).toEqual(["piece", "piece"]);

        const listing = listEntityModels(space, { kind: "piece", limit: 2 });
        expect(listing.extent.truncated).toBe(true);
        expect(listing.entities.map((e) => e.lineage.pattern?.moduleId))
          .toEqual(
            ["of:mod", "of:mod"],
          );
      });
    });
  });

  describe("scanLimit()", () => {
    it("floors a fractional limit, which no entity count could ever equal", () => {
      expect(scanLimit(1.5)).toBe(1);
      expect(scanLimit(-3)).toBe(0);
      expect(scanLimit(undefined)).toBe(DEFAULT_SCAN_LIMIT);
      expect(scanLimit(NaN)).toBe(DEFAULT_SCAN_LIMIT);
    });
  });

  describe("rowLimit()", () => {
    it("returns undefined for a negative, which a row listing reads as unlimited", () => {
      expect(rowLimit(-1)).toBeUndefined();
      expect(rowLimit(0)).toBe(0);
      expect(rowLimit(20)).toBe(20);
    });

    it("refuses a limit no SQL LIMIT would have accepted", () => {
      // SQLite answers each of these with a datatype mismatch; `slice` would
      // read them as one row, no rows, and every row.
      for (const bad of [1.5, NaN, Infinity, -Infinity]) {
        expect(() => rowLimit(bad)).toThrow("whole number of rows");
      }
    });
  });

  describe("a row listing's refusal", () => {
    it("lands before the scan, as the SQL LIMIT it replaced did", async () => {
      // A space with no tables at all. If the limit were checked at the
      // terminal slice, the walk would run first and fail on the missing
      // `revision` table — so the error naming the LIMIT is proof the refusal
      // came before any query, without reaching into the driver to count them.
      const dir = await Deno.makeTempDir({ prefix: "state-inspector-ff-" });
      const path = `${dir}/empty.sqlite`;
      new Database(path, { create: true }).close();
      const empty = openSpace(path);
      try {
        expect(() => hotEntities(empty, { limit: 1.5 }))
          .toThrow("whole number of rows");
        expect(() => contendedEntities(empty, { limit: 1.5 }))
          .toThrow("whole number of rows");
      } finally {
        empty.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("a fractional limit", () => {
    it("caps every scan the same way rather than passing through one of them", async () => {
      await withSeeded(cells(2, 1), [{ name: "" }], (space) => {
        // Before normalizing, `kept.length === limit` could never hold against
        // 1.5, so the entity listing returned BOTH entities while detail and
        // graph returned one — three scans disagreeing on one input.
        expect(listEntityModels(space, { limit: 1.5 }).entities.length).toBe(1);
        expect(buildAllDetails(space, { limit: 1.5 }).details.length).toBe(1);
        expect(buildSpaceGraph(space, { limit: 1.5 }).extent).toEqual({
          limit: 1,
          total: 2,
          truncated: true,
          unreadable: 0,
        });
      });
    });
  });

  describe("a space holding an entity that will not decode", () => {
    /** One readable entity and one whose stored payload is not decodable. */
    const withCorrupt = (run: (space: SpaceDb) => void) =>
      withSeeded(
        [
          { id: "of:good", document: { value: "readable" }, revisions: 1 },
          { id: "of:bad", document: UNDECODABLE, revisions: 1 },
        ],
        [{ name: "" }],
        run,
      );

    it("counts the entity a detail pass could not describe rather than dropping it silently", async () => {
      await withCorrupt((space) => {
        const listing = buildAllDetails(space);
        expect(listing.details.map((d) => d.id)).toEqual(["of:good"]);
        // `truncated` stays false — the cap was never reached — so without a
        // count of its own this pass would report itself complete over one of
        // two entities, and `--require-complete` would exit 0.
        expect(listing.extent.truncated).toBe(false);
        expect(listing.extent.unreadable).toBe(1);
        expect(isCompleteScan(listing.extent)).toBe(false);
      });
    });

    it("counts the entity a graph could not place", async () => {
      await withCorrupt((space) => {
        const graph = buildSpaceGraph(space);
        expect(graph.extent.unreadable).toBe(1);
        expect(isCompleteScan(graph.extent)).toBe(false);
      });
    });

    it("reports the entity listing complete, because it returns a row for one it cannot read", async () => {
      await withCorrupt((space) => {
        const listing = listEntityModels(space);
        expect(listing.entities.map((e) => e.id).sort()).toEqual([
          "of:bad",
          "of:good",
        ]);
        expect(listing.extent.unreadable).toBe(0);
        expect(isCompleteScan(listing.extent)).toBe(true);
      });
    });
  });

  describe("a fingerprint of a child branch", () => {
    const MINE = "user:did:key:zBob";

    /** A parent entity the child overrides, and a parent-only user scope. */
    const forked = (run: (space: SpaceDb) => void) =>
      withSeeded(
        [
          { id: "of:shared", document: { value: "PARENT" }, revisions: 1 },
          {
            id: "of:mine",
            document: { value: "parent user state" },
            revisions: 1,
            scope: MINE,
          },
          {
            id: "of:shared",
            document: { value: "CHILD" },
            revisions: 1,
            branch: "kid",
          },
        ],
        [{ name: "" }, { name: "kid", parent: "", forkSeq: 2 }],
        run,
      );

    it("enumerates the per-user scope the child inherited rather than only its own", async () => {
      await forked((space) => {
        expect(listScopes(space, { branch: "kid" }).map((s) => s.raw)).toEqual(
          listScopes(space).map((s) => s.raw),
        );
        expect(listScopes(space, { branch: "kid" }).map((s) => s.raw))
          .toContain(MINE);
      });
    });

    it("hashes the value the branch reads, not the parent's", async () => {
      await forked((space) => {
        // The read resolves the child's override; a fingerprint that hashed the
        // default branch would certify two different contents as identical —
        // the one failure this module exists to prevent.
        expect(reconstructDocument(space, { id: "of:shared", branch: "kid" }))
          .toEqual({ value: "CHILD" });
        const kid = contentFingerprint(space, { branch: "kid" });
        const root = contentFingerprint(space);
        const shared = (r: typeof kid) =>
          r.perEntity.find((e) => e.id === "of:shared")?.hash;
        expect(shared(kid)).not.toBe(shared(root));
        expect(kid.perEntity.map((e) => e.scope)).toContain(MINE);
      });
    });
  });

  describe("an entity deleted in one scope and live in another", () => {
    const MINE = "user:did:key:zBob";

    /** Shared value kept; the per-user copy written and then deleted. */
    const halfDeleted = (run: (space: SpaceDb) => void) =>
      withSeeded(
        [
          { id: "of:x", document: { value: "shared" }, revisions: 1 },
          {
            id: "of:x",
            document: { value: "bob's" },
            revisions: 1,
            scope: MINE,
            deleted: true,
          },
        ],
        [{ name: "" }],
        run,
      );

    it("reports the deletion as divergence rather than dropping the scope", async () => {
      await halfDeleted((space) => {
        // `visibleRevisionRows` enumerates RECORDS, so a tombstoned head still
        // reaches the overlay. Filtering tombstones there would leave one
        // variant and report `divergent: false` — erasing the very difference
        // an overlay is for. `visibleEntityRows` is the read-visible set.
        const overlay = scopeOverlay(space, "of:x");
        expect(overlay.variants.map((v) => `${v.scope}=${v.summary}`)).toEqual([
          `space="shared"`,
          `${MINE}=(absent)`,
        ]);
        expect(overlay.divergent).toBe(true);
      });
    });

    it("keeps the scope out of the read-visible entity rows", async () => {
      await halfDeleted((space) => {
        expect(visibleEntityRows(space, { scope: MINE })).toEqual([]);
        expect(
          visibleEntityRows(space, { scope: MINE, includeDeleted: true }).map((
            r,
          ) => r.id),
        ).toEqual(["of:x"]);
      });
    });
  });

  describe("a `kind` scan meeting a row it cannot classify", () => {
    it("counts the unclassifiable row it dropped, so strictness can refuse", async () => {
      await withSeeded(
        [
          {
            id: "of:piece-1",
            document: {
              value: { $NAME: "Topic" },
              patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
            },
            revisions: 1,
          },
          { id: "of:bad", document: UNDECODABLE, revisions: 1 },
        ],
        [{ name: "" }],
        (space) => {
          // The filter drops the undecodable row because its kind cannot be
          // determined — which is precisely why the omission has to be
          // reported. `scripts/topics-export.ts` runs this exact scan and
          // refuses to write a rollback payload when `isCompleteScan` says
          // no, so this report is what stands between an operator and a
          // partial export that reads like a whole one.
          const listing = listEntityModels(space, { kind: "piece" });
          expect(listing.entities.map((e) => e.id)).toEqual(["of:piece-1"]);
          expect(listing.extent.unreadable).toBe(1);
          expect(isCompleteScan(listing.extent)).toBe(false);

          // Unfiltered keeps it, modeled `unknown`, so nothing is missing.
          const all = listEntityModels(space);
          expect(all.entities.map((e) => e.id).sort()).toEqual([
            "of:bad",
            "of:piece-1",
          ]);
          expect(isCompleteScan(all.extent)).toBe(true);
        },
      );
    });

    it("does not count a document whose shape classifies as `unknown`", async () => {
      await withSeeded(
        [
          {
            id: "of:piece-1",
            document: {
              value: { $NAME: "Topic" },
              patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
            },
            revisions: 1,
          },
          // Decodes fine; its shape is simply not one the model names. Its kind
          // WAS determined — `unknown` — so dropping it is an answer, not a gap.
          { id: "of:odd", document: { cfc: {}, slug: "x" }, revisions: 1 },
        ],
        [{ name: "" }],
        (space) => {
          const listing = listEntityModels(space, { kind: "piece" });
          expect(listing.entities.map((e) => e.id)).toEqual(["of:piece-1"]);
          expect(listing.extent.unreadable).toBe(0);
          expect(isCompleteScan(listing.extent)).toBe(true);
        },
      );
    });

    it("already reports itself truncated whenever the module walk runs past the cap", async () => {
      const MODULE = {
        value: {
          kind: "source",
          identity: MODULE_IDENTITY,
          code: "export default () => null;\n",
          filename: "/api/patterns/system/notes/notebook.tsx",
          imports: [],
        },
      };
      await withSeeded(
        [
          ...Array.from({ length: 2 }, (_, i) => ({
            id: `of:piece-${i + 1}`,
            document: {
              value: { $NAME: "Topic" },
              patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
            },
            revisions: 3,
          })),
          // Both sit past a cap of 1, so only the module walk reaches them.
          { id: "of:bad", document: UNDECODABLE, revisions: 2 },
          { id: "of:mod", document: MODULE, revisions: 1 },
        ],
        [{ name: "" }],
        (space) => {
          // The walk resolves the module and passes an undecodable row on the
          // way, which it does not count. It does not have to: the walk is
          // reachable ONLY after collection stopped at the cap, so the result
          // already reports itself incomplete, and raising the limit hands the
          // same row to the pass that DOES count it. Both halves asserted here,
          // because the invariant lives in the loop bounds and nothing else
          // would notice if an edit broke it.
          const capped = listEntityModels(space, { kind: "piece", limit: 1 });
          expect(capped.entities[0].lineage.pattern?.moduleId).toBe("of:mod");
          expect(capped.extent.truncated).toBe(true);
          expect(isCompleteScan(capped.extent)).toBe(false);

          // Still `kind: "piece"` — uncapped, not unfiltered. The distinction
          // decides the expected count: a FILTERED scan drops the undecodable
          // row and counts it, where an unfiltered one would keep it as
          // `unknown` and report zero.
          const uncapped = listEntityModels(space, { kind: "piece" });
          expect(uncapped.extent.truncated).toBe(false);
          expect(uncapped.extent.unreadable).toBe(1);
          expect(isCompleteScan(uncapped.extent)).toBe(false);
        },
      );
    });

    it("does not count an unreadable row a deleted-only filter dropped", async () => {
      await withSeeded(
        [
          {
            id: "of:gone",
            document: { value: "was here" },
            revisions: 1,
            deleted: true,
          },
          { id: "of:bad", document: UNDECODABLE, revisions: 1 },
        ],
        [{ name: "" }],
        (space) => {
          // The reverse of the tombstone-vs-piece case below. What makes an
          // entity `deleted` is the OP of its visible row, read before any
          // payload is — so a row that would not decode is definitively not a
          // tombstone, and dropping it leaves nothing out of the answer.
          const listing = listEntityModels(space, { kind: "deleted" });
          expect(listing.entities.map((e) => e.id)).toEqual(["of:gone"]);
          expect(listing.extent.unreadable).toBe(0);
          expect(isCompleteScan(listing.extent)).toBe(true);

          // The same undecodable row IS a gap for any other kind, which is what
          // keeps the assertion above from passing for the wrong reason.
          const pieces = listEntityModels(space, { kind: "piece" });
          expect(pieces.entities).toEqual([]);
          expect(pieces.extent.unreadable).toBe(1);
          expect(isCompleteScan(pieces.extent)).toBe(false);
        },
      );
    });

    it("does not count a tombstone the filter dropped, which is no error", async () => {
      await withSeeded(
        [
          {
            id: "of:piece-1",
            document: {
              value: { $NAME: "Topic" },
              patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
            },
            revisions: 1,
          },
          {
            id: "of:gone",
            document: { value: "was here" },
            revisions: 1,
            deleted: true,
          },
        ],
        [{ name: "" }],
        (space) => {
          // A deleted entity is definitively not a piece. Only a row whose kind
          // could not be DETERMINED is a gap in the answer.
          const listing = listEntityModels(space, { kind: "piece" });
          expect(listing.entities.map((e) => e.id)).toEqual(["of:piece-1"]);
          expect(listing.extent.unreadable).toBe(0);
          expect(isCompleteScan(listing.extent)).toBe(true);
        },
      );
    });
  });

  describe("a detail pass over a branch's own and inherited entities", () => {
    /** `of:kept` inherited untouched; `of:override` rewritten on the child. */
    const forked = (run: (space: SpaceDb) => void) =>
      withSeeded(
        [
          { id: "of:kept", document: { value: "p1" }, revisions: 2 },
          { id: "of:override", document: { value: "parent" }, revisions: 1 },
          {
            id: "of:override",
            document: { value: "child" },
            revisions: 1,
            branch: "kid",
          },
        ],
        [{ name: "" }, { name: "kid", parent: "", forkSeq: 3 }],
        run,
      );

    it("reports only the overriding branch's history for an entity the child rewrote", async () => {
      await forked((space) => {
        const detail = buildAllDetails(space, { branch: "kid" }).details
          .find((d) => d.id === "of:override");
        // The value came from the child alone — `reconstructWithinBranch` never
        // composes across the fork — so crediting this entity with the parent's
        // writes would report revisions no read from here can reach.
        expect(detail?.versions.map((v) => v.seq)).toEqual([4]);
        expect(detail?.revisions).toBe(1);
      });
    });

    it("reports the parent's history for an entity the child only inherited", async () => {
      await forked((space) => {
        const detail = buildAllDetails(space, { branch: "kid" }).details
          .find((d) => d.id === "of:kept");
        expect(detail?.versions.map((v) => v.seq)).toEqual([1, 2]);
        expect(detail?.revisions).toBe(2);
      });
    });
  });

  describe("the standalone HTML explorer", () => {
    it("marks a page missing an entity it could not reconstruct, not only a capped one", async () => {
      await withSeeded(
        [
          { id: "of:good", document: { value: "readable" }, revisions: 1 },
          { id: "of:bad", document: UNDECODABLE, revisions: 1 },
        ],
        [{ name: "" }],
        (space) => {
          const bundle = buildInspectorBundle(space);
          // The cap was never reached, so the cap banner stays away — and
          // before this the page said nothing at all, while its tree omitted an
          // entity. A generated page outlives the stderr notice: it gets opened
          // days later and shared with someone who never ran the command.
          expect(bundle.extent).toMatchObject({
            truncated: false,
            unreadable: 1,
          });
          const html = renderInspectorHtml(bundle);
          expect(html).not.toContain("capped at");
          expect(html).toContain("could not be reconstructed");
          expect(html).toContain("a higher --limit will not recover them");
        },
      );
    });

    it("shows the per-user cells of an entity a child branch inherited", async () => {
      const MINE = "user:did:key:zBob";
      await withSeeded(
        [
          { id: "of:shared", document: { value: "space value" }, revisions: 1 },
          {
            id: "of:shared",
            document: { value: "bob's value" },
            revisions: 1,
            scope: MINE,
          },
          {
            id: "of:kidonly",
            document: { value: "kid" },
            revisions: 1,
            branch: "kid",
          },
        ],
        [{ name: "" }, { name: "kid", parent: "", forkSeq: 2 }],
        (space) => {
          // The scope list and the overlays have to describe one domain: a page
          // naming a per-user scope while finding no cells in it reports the
          // divergence as absent rather than as unreached.
          const bundle = buildInspectorBundle(space, { branch: "kid" });
          expect(bundle.scopes.map((s) => s.raw)).toContain(MINE);
          expect(bundle.overlays.map((o) => o.id)).toEqual(["of:shared"]);
          const overlay = scopeOverlay(space, "of:shared", { branch: "kid" });
          expect(overlay.variants.map((v) => v.scope)).toEqual([
            "space",
            MINE,
          ]);
          expect(overlay.divergent).toBe(true);
        },
      );
    });
  });
});
