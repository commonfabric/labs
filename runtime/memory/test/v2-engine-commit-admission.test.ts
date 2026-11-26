import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  type ApplyCommitOptions,
  applyWaveCommit,
  close,
  COMMIT_CLASS_MEMO_MAX_ENTRIES,
  commitClassOfSeq,
  type Engine,
  open,
  OpFieldBaselineMismatchError,
  ProtocolError,
  read,
  RowLabelCommitError,
} from "../v2/engine.ts";
import { OWNER_RELEASE_BY_INTENT_RECORD_PREFIX } from "../v2/cfc-owner-release-by-intent.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import { CODEMIRROR_CHANGESET_CODEC } from "../v2/operation-codec.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
} from "../v2/sqlite/exec.ts";
import { all, dbOwner } from "../v2/sqlite/row-label.ts";
import { table } from "../v2/sqlite/schema.ts";
import {
  type Operation,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  toValuePath,
} from "../v2.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const SPACE = "did:key:z6Mk-engine-commit-admission-space";

const commit = (localSeq: number, operations: Operation[]) => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations,
});

describe("engine commit admission", () => {
  let path: string;
  let engine: Engine;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  const apply = (
    localSeq: number,
    operations: Operation[],
    options: Partial<ApplyCommitOptions> = {},
  ) =>
    applyCommit(engine, {
      sessionId: "session:a",
      commit: commit(localSeq, operations),
      ...options,
    });

  describe("commitClassOfSeq()", () => {
    it("serves a remembered class until the memo reaches its bound, then reads the store again", () => {
      const bound = COMMIT_CLASS_MEMO_MAX_ENTRIES;
      engine.database.prepare(`
        WITH RECURSIVE n(seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM n WHERE seq < :last)
        INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
        SELECT seq, 'session:memo', seq, '{}', '{}' FROM n
      `).run({ last: bound + 1 });

      expect(commitClassOfSeq(engine, 1)).toBe("authored");
      engine.database.exec(
        `UPDATE "commit" SET class = 'system' WHERE seq = 1`,
      );
      expect(commitClassOfSeq(engine, 1)).toBe("authored");
      for (let seq = 2; seq <= bound; seq++) commitClassOfSeq(engine, seq);
      expect(commitClassOfSeq(engine, 1)).toBe("authored");

      expect(commitClassOfSeq(engine, bound + 1)).toBe("authored");
      expect(commitClassOfSeq(engine, 1)).toBe("system");
    });
  });

  describe("refusals", () => {
    it("throws a malformed wave precondition as itself, even after one that fails", () => {
      setServerExecutionConfig(true);
      try {
        const holder = executionLeaseHolder(`service:${SPACE}`);
        expect(engine.executionLeases.acquire(SPACE, holder)).toBe(true);
        expect(() =>
          applyWaveCommit(engine, {
            sessionId: holder,
            space: SPACE,
            commitClass: "derived",
            holder,
            commit: {
              ...commit(1, [{
                op: "set",
                id: "of:wave",
                value: { value: 1 },
              }]),
              preconditions: [
                {
                  kind: "entity-value-hash",
                  id: "of:guard",
                  valueHash: "stale",
                },
                null as never,
              ],
            },
            waveBasis: { basisSeq: 0, rebasedHeads: [] },
          })
        ).toThrow(
          new ProtocolError("malformed commit precondition: not an object"),
        );
        expect(read(engine, { id: "of:wave" })).toBeNull();
      } finally {
        resetServerExecutionConfig();
      }
    });

    it("throws for an operation baseline hash that is not a nonempty string", () => {
      apply(1, [{
        op: "set",
        id: "of:field",
        value: { value: { body: "a" } },
      }]);
      for (const baselineHash of ["", 7]) {
        expect(() =>
          apply(2, [{
            op: "apply-op",
            id: "of:field",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "alice:1",
            baselineHash: baselineHash as string,
            payload: { updates: [] },
          }])
        ).toThrow(
          new OpFieldBaselineMismatchError(
            "apply-op baselineHash is malformed",
          ),
        );
      }
      expect(read(engine, { id: "of:field" })).toEqual({
        value: { body: "a" },
      });
    });

    it("throws for a release record in a commit that names no space", () => {
      const record = `${OWNER_RELEASE_BY_INTENT_RECORD_PREFIX}request`;
      expect(() => apply(1, [{ op: "set", id: record, value: { value: {} } }]))
        .toThrow(
          new ProtocolError(
            "memory v2 commit names no space, and creates a release record",
          ),
        );
      expect(read(engine, { id: record })).toBeNull();
    });

    it("throws for a set whose value is not a document", () => {
      expect(() => apply(1, [{ op: "set", id: "of:bare", value: 7 as never }]))
        .toThrow("memory v2 set operations require explicit document objects");
    });
  });

  describe("SQLite operations", () => {
    const DB_ID = "of:engine-admission-db";
    const owned = table(
      { id: "integer primary key", note: "text" },
      () => ({ confidentiality: all(dbOwner()) }),
    );

    it("throws for a user-scoped write in a userless delegated batch, and for a space-scoped one with no attachment", () => {
      setServerExecutionConfig(true);
      try {
        const delegated = {
          actingPrincipal: "",
          capabilityRef: "capability:sqlite",
          sessionlessSpaceScope: true,
        };
        const write = (scope: "user" | "space"): Operation => ({
          op: "sqlite",
          db: { id: DB_ID, scope },
          sql: "INSERT INTO notes (note) VALUES ('x')",
        });

        expect(() => apply(1, [write("user")], { space: SPACE, delegated }))
          .toThrow(
            "delegated admission rejected: a userless delegated batch carries a user-scoped SQLite write",
          );
        expect(() => apply(2, [write("space")], { space: SPACE, delegated }))
          .toThrow(
            new ProtocolError(
              `sqlite op for db ${DB_ID} has no attachment (server must attach before applyCommit)`,
            ),
          );
      } finally {
        resetServerExecutionConfig();
      }
    });

    it("leaves a user-scoped database's owner unresolved for a commit with no principal, which its owner rule then refuses", async () => {
      const alias = aliasForDbId(DB_ID);
      const file = await Deno.makeTempFile({ suffix: ".sqlite" });
      attachDatabase(engine.database, alias, file);
      ensureTables(engine.database, { owned }, alias);
      try {
        expect(() =>
          apply(1, [{
            op: "sqlite",
            db: { id: DB_ID, scope: "user", tables: { owned } },
            sql: "INSERT INTO owned (note) VALUES ('x')",
          }], {
            space: SPACE,
            sqliteAttachments: new Map([[DB_ID, alias]]),
          })
        ).toThrow(RowLabelCommitError);
        expect(
          engine.database.prepare(`SELECT count(*) AS n FROM ${alias}.owned`)
            .get<{ n: number }>()!.n,
        ).toBe(0);
      } finally {
        detachDatabase(engine.database, alias);
        await Deno.remove(file);
      }
    });
  });

  describe("replay", () => {
    it("returns a replayed deletion's revision without a document", () => {
      apply(1, [{ op: "set", id: "of:gone", value: { value: 1 } }]);
      const first = apply(2, [{ op: "delete", id: "of:gone" }]);

      const replayed = apply(2, [{ op: "delete", id: "of:gone" }]);

      expect(replayed.seq).toBe(first.seq);
      expect(replayed.revisions).toEqual([{
        id: "of:gone",
        scope: "space",
        scopeKey: "space",
        branch: "",
        seq: first.seq,
        opIndex: 0,
        commitSeq: first.seq,
        op: "delete",
      }]);
    });
  });

  describe("snapshots", () => {
    it("writes no snapshot for a patch history when the snapshot interval is zero, and writes one otherwise", async () => {
      const snapshotRows = async (snapshotInterval: number) => {
        const file = await Deno.makeTempFile({ suffix: ".sqlite" });
        const unsnapshotted = await open({
          url: toFileUrl(file),
          snapshotInterval,
        });
        try {
          applyCommit(unsnapshotted, {
            sessionId: "session:a",
            commit: commit(1, [{ op: "set", id: "of:n", value: { value: 0 } }]),
          });
          for (let n = 1; n <= 3; n++) {
            applyCommit(unsnapshotted, {
              sessionId: "session:a",
              commit: commit(n + 1, [{
                op: "patch",
                id: "of:n",
                patches: [{ op: "replace", path: "/value", value: n }],
              }]),
            });
          }
          expect(read(unsnapshotted, { id: "of:n" })).toEqual({ value: 3 });
          return unsnapshotted.database.prepare(
            `SELECT count(*) AS n FROM snapshot`,
          ).get<{ n: number }>()!.n;
        } finally {
          close(unsnapshotted);
          await Deno.remove(file);
        }
      };

      expect(await snapshotRows(0)).toBe(0);
      expect(await snapshotRows(2)).toBeGreaterThan(0);
    });
  });
});
