import {
  assertEquals,
  assertExists,
  assertMatch,
  assertThrows,
} from "@std/assert";
import { toFileUrl } from "@std/path";

import type { FabricValue } from "@commonfabric/data-model";
import {
  type EntityRef,
  entityRefFromString,
  LINK_V1_TAG,
} from "@commonfabric/data-model/cell-rep";
import { Database } from "@db/sqlite";

import {
  decodeMemoryBoundary,
  DEFAULT_BRANCH,
  encodeMemoryBoundary,
  type EntityDocument,
  toDocumentPath,
} from "../v2.ts";
import {
  applyCommit,
  close,
  ConflictError,
  createBranch,
  deleteBranch,
  type Engine,
  entityIdExists,
  listBranches,
  listEntityIdPage,
  listEntityIds,
  open,
  ProtocolError,
  read,
} from "../v2/engine.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const createEngineWithOptions = async (
  options: Omit<Parameters<typeof open>[0], "url">,
): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), ...options });
  return { engine, path };
};

const invocationFor = (
  localSeq: number,
  extra: Record<string, unknown> = {},
) => ({
  iss: "did:key:alice",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: "did:key:space",
  args: { localSeq, ...extra },
});

const authorization = {
  signature: "sig:alice",
  access: { "proof:1": {} },
};

const decodeStored = <Value extends FabricValue>(
  source: string | null | undefined,
): Value => decodeMemoryBoundary<Value>(source ?? "null");

const toEntityDocument = (
  value: unknown,
  source?: EntityRef,
  metadata: Record<string, unknown> = {},
): EntityDocument => {
  const document: Record<string, unknown> = {
    ...metadata,
    ...(source !== undefined ? { source } : {}),
  };
  if (value !== undefined) {
    document.value = value;
  }
  return document as EntityDocument;
};

Deno.test("memory v2 engine reserves sync schema reference strings", async () => {
  const { engine, path } = await createEngine();
  const id = "entity:reserved-sync-schema-ref";
  const reservedRef = "schema-ref@2:sha256:user-controlled";

  try {
    applyCommit(engine, {
      sessionId: "session:reserved-sync-schema-ref",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({
            harmless: reservedRef,
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:target",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
            $alias: {
              id: "of:legacy-target",
              path: [],
              schema: "opaque-legacy-schema-name",
            },
          }),
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:reserved-sync-schema-ref-set",
              value: toEntityDocument({
                $alias: {
                  id: "of:target",
                  path: [],
                  schema: reservedRef,
                },
              }),
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    applyCommit(engine, {
      sessionId: "session:reserved-sync-schema-ref",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/harmlessPatch",
            value: reservedRef,
          }],
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: reservedRef,
              }],
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    for (
      const path of [
        `/value/ref/~1/${LINK_V1_TAG}/schema`,
        "/value/$alias/schema",
      ]
    ) {
      assertThrows(
        () =>
          applyCommit(engine, {
            sessionId: "session:reserved-sync-schema-ref",
            commit: {
              localSeq: 3,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "patch",
                id,
                patches: [{
                  op: "move",
                  from: "/value/harmless",
                  path,
                }],
              }],
            },
          }),
        ProtocolError,
        "reserved wire schema reference",
      );
    }

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:reserved-sync-schema-ref-hidden-by-set",
              value: toEntityDocument({
                $alias: {
                  id: "of:target",
                  path: [],
                  schema: reservedRef,
                },
              }),
            }, {
              op: "set",
              id: "entity:reserved-sync-schema-ref-hidden-by-set",
              value: toEntityDocument({ safe: true }),
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );
    assertEquals(
      read(engine, { id: "entity:reserved-sync-schema-ref-hidden-by-set" }),
      null,
    );

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: reservedRef,
              }],
            }, {
              op: "delete",
              id,
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    // A reserved reference that exists only in a mid-commit state — placed by
    // one patch and cleaned by the next in the same commit — is still stored
    // history (readable at its seq) and must be rejected.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-sync-schema-ref",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: reservedRef,
              }],
            }, {
              op: "patch",
              id,
              patches: [{
                op: "replace",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
                value: "opaque-schema-name",
              }],
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    assertEquals(
      read(engine, { id }),
      toEntityDocument({
        harmless: reservedRef,
        harmlessPatch: reservedRef,
        ref: {
          "/": {
            [LINK_V1_TAG]: {
              id: "of:target",
              path: [],
              schema: "opaque-schema-name",
            },
          },
        },
        $alias: {
          id: "of:legacy-target",
          path: [],
          schema: "opaque-legacy-schema-name",
        },
      }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays stateful entities across set and delete revisions", async () => {
  const { engine, path } = await createEngine();
  const reservedRef = "schema-ref@2:sha256:harmless-position";
  const id = "entity:stateful-replay";

  try {
    applyCommit(engine, {
      sessionId: "session:stateful-replay",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({ base: true }),
        }],
      },
    });

    // One commit whose replay walks every stateful branch without throwing:
    // a candidate patch placing a reserved string in a harmless position,
    // a wholesale set, a follow-up patch, and a tombstoning delete.
    applyCommit(engine, {
      sessionId: "session:stateful-replay",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/harmless",
            value: reservedRef,
          }],
        }, {
          op: "set",
          id,
          value: toEntityDocument({ replaced: true }),
        }, {
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/afterSet",
            value: "clean",
          }],
        }, {
          op: "delete",
          id,
        }],
      },
    });

    assertEquals(read(engine, { id }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine validates clean moves against snapshot-backed pre-state", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 1,
  });
  const reservedRef = "schema-ref@2:sha256:snapshot-resident";
  const id = "entity:snapshot-move";

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot-move",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({
            harmless: reservedRef,
            ref: {
              "/": {
                [LINK_V1_TAG]: {
                  id: "of:target",
                  path: [],
                  schema: "opaque-schema-name",
                },
              },
            },
          }),
        }],
      },
    });
    // Force a snapshot so the clean-move probe reads the snapshot row rather
    // than the base set revision.
    applyCommit(engine, {
      sessionId: "session:snapshot-move",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{ op: "add", path: "/value/padding", value: "clean" }],
        }],
      },
    });

    // The move commit's own serialization is clean; only the snapshot-backed
    // pre-state carries the reserved string, and relocating it into a schema
    // position must still be rejected.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:snapshot-move",
          invocation: invocationFor(3),
          authorization,
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id,
              patches: [{
                op: "move",
                from: "/value/harmless",
                path: `/value/ref/~1/${LINK_V1_TAG}/schema`,
              }],
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );

    // A clean move between harmless positions over the same snapshot-backed
    // pre-state is allowed.
    applyCommit(engine, {
      sessionId: "session:snapshot-move",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "move",
            from: "/value/harmless",
            path: "/value/relocated",
          }],
        }],
      },
    });
    const document = read(engine, { id });
    assertEquals(
      (document?.value as Record<string, unknown>).relocated,
      reservedRef,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine reserves request CAS schema reference strings", async () => {
  const { engine, path } = await createEngine();
  const reservedRef = "schema-cas@1:sha256:user-controlled";
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:reserved-request-schema-ref",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:reserved-request-schema-ref",
              value: toEntityDocument({
                $alias: {
                  id: "of:target",
                  path: [],
                  schema: reservedRef,
                },
              }),
            }],
          },
        }),
      ProtocolError,
      "reserved wire schema reference",
    );
    assertEquals(
      read(engine, { id: "entity:reserved-request-schema-ref" }),
      null,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine lists live space-scoped entity identifiers", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:fid1:second",
            value: toEntityDocument({ payload: "second" }),
          },
          {
            op: "set",
            id: "of:fid1:first",
            value: toEntityDocument({ payload: "first" }),
          },
          {
            op: "set",
            id: "of:fid1:user-only",
            scope: "user",
            value: toEntityDocument({ payload: "private" }),
          },
        ],
      },
    });

    assertEquals(listEntityIds(engine), [
      "of:fid1:first",
      "of:fid1:second",
    ]);
    assertEquals(listEntityIdPage(engine, { limit: 1 }), ["of:fid1:first"]);
    assertEquals(
      listEntityIdPage(engine, { after: "of:fid1:first", limit: 1 }),
      ["of:fid1:second"],
    );
    assertEquals(entityIdExists(engine, "of:fid1:first"), true);
    assertEquals(entityIdExists(engine, "of:fid1:missing"), false);

    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "of:fid1:first" }],
      },
    });

    assertEquals(listEntityIds(engine), ["of:fid1:second"]);
    assertEquals(entityIdExists(engine, "of:fid1:first"), false);
    assertEquals(
      engine.database.prepare(`
        SELECT id, scope_key, op
        FROM head
        ORDER BY id, scope_key
      `).all(),
      [
        { id: "of:fid1:first", scope_key: "space", op: "delete" },
        { id: "of:fid1:second", scope_key: "space", op: "set" },
        {
          id: "of:fid1:user-only",
          scope_key: "user:did%3Akey%3Aalice",
          op: "set",
        },
      ],
    );

    const plan = engine.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM head
      WHERE branch = :branch
        AND scope_key = :scope_key
        AND op <> 'delete'
      ORDER BY id ASC
    `).all({ branch: "", scope_key: "space" }) as Array<{ detail: string }>;
    assertEquals(plan.length, 1);
    assertMatch(
      plan[0].detail,
      /^SEARCH head USING COVERING INDEX idx_head_live_entity_ids /,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine stores independent scoped instances for the same id", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          value: toEntityDocument({ scope: "space" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          scope: "user",
          value: toEntityDocument({ scope: "alice" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped",
          scope: "session",
          value: toEntityDocument({ scope: "alice-session" }),
        }],
      },
    });

    assertEquals(read(engine, { id: "entity:scoped" }), {
      value: { scope: "space" },
    });
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "user",
        principal: "did:key:alice",
        sessionId: "session:alice",
      }),
      { value: { scope: "alice" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:alice",
      }),
      { value: { scope: "alice-session" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "user",
        principal: "did:key:bob",
        sessionId: "session:bob",
      }),
      null,
    );
    assertEquals(
      read(engine, {
        id: "entity:scoped",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:other",
      }),
      null,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine binds session scoped instances to the principal", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:shared",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:session-principal",
          scope: "session",
          value: toEntityDocument({ owner: "alice" }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:shared",
      principal: "did:key:bob",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:session-principal",
          scope: "session",
          value: toEntityDocument({ owner: "bob" }),
        }],
      },
    });

    assertEquals(
      read(engine, {
        id: "entity:session-principal",
        scope: "session",
        principal: "did:key:alice",
        sessionId: "session:shared",
      }),
      { value: { owner: "alice" } },
    );
    assertEquals(
      read(engine, {
        id: "entity:session-principal",
        scope: "session",
        principal: "did:key:bob",
        sessionId: "session:shared",
      }),
      { value: { owner: "bob" } },
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine encodes user and session scoped principal keys symmetrically", async () => {
  const { engine, path } = await createEngine();

  try {
    const principals = ["did:key:foo", "did:key:bar"];
    for (const [index, principal] of principals.entries()) {
      applyCommit(engine, {
        sessionId: "session:shared",
        principal,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: "entity:encoded-user",
              scope: "user",
              value: toEntityDocument({ owner: principal }),
            },
            {
              op: "set",
              id: "entity:encoded-session",
              scope: "session",
              value: toEntityDocument({ owner: principal }),
            },
          ],
        },
      });

      assertEquals(
        read(engine, {
          id: "entity:encoded-user",
          scope: "user",
          principal,
          sessionId: "session:shared",
        }),
        { value: { owner: principal } },
      );
      assertEquals(
        read(engine, {
          id: "entity:encoded-session",
          scope: "session",
          principal,
          sessionId: "session:shared",
        }),
        { value: { owner: principal } },
      );
      assertEquals(
        read(engine, {
          id: "entity:encoded-user",
          scope: "user",
          principal: principals[1 - index],
          sessionId: "session:shared",
        }),
        index === 0 ? null : { value: { owner: principals[0] } },
      );
    }

    const scopeKeys = (
      engine.database.prepare(
        `SELECT DISTINCT scope_key FROM revision WHERE id IN ('entity:encoded-user', 'entity:encoded-session') ORDER BY scope_key`,
      ).all() as Array<{ scope_key: string }>
    ).map((row) => row.scope_key);
    assertEquals(scopeKeys, [
      "session:did%3Akey%3Abar:session%3Ashared",
      "session:did%3Akey%3Afoo:session%3Ashared",
      "user:did%3Akey%3Abar",
      "user:did%3Akey%3Afoo",
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine requires principal context for user and session scoped reads", async () => {
  const { engine, path } = await createEngine();

  try {
    assertThrows(
      () => read(engine, { id: "entity:principal-required", scope: "user" }),
      ProtocolError,
      "user scoped memory operations require a principal",
    );
    assertThrows(
      () =>
        read(engine, {
          id: "entity:principal-required",
          scope: "session",
          sessionId: "session:present",
        }),
      ProtocolError,
      "session scoped memory operations require a principal",
    );
    assertThrows(
      () =>
        read(engine, {
          id: "entity:principal-required",
          scope: "session",
          principal: "did:key:foo",
        }),
      ProtocolError,
      "session scoped memory operations require a session id",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine migrates pre-scope entity tables to space scope", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  const legacyDb = new Database(path, { create: true });
  try {
    legacyDb.exec(`
      CREATE TABLE "commit" (
        seq                INTEGER NOT NULL PRIMARY KEY,
        branch             TEXT    NOT NULL DEFAULT '',
        session_id         TEXT    NOT NULL,
        local_seq          INTEGER NOT NULL,
        invocation_ref     TEXT,
        authorization_ref  TEXT,
        original           JSON    NOT NULL,
        resolution         JSON    NOT NULL,
        created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_commit_session_local_seq
        ON "commit" (session_id, local_seq);
      CREATE TABLE revision (
        branch      TEXT    NOT NULL DEFAULT '',
        id          TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        op_index    INTEGER NOT NULL,
        op          TEXT    NOT NULL,
        data        JSON,
        commit_seq  INTEGER NOT NULL,
        PRIMARY KEY (branch, id, seq, op_index)
      );
      CREATE INDEX idx_revision_branch_id_seq
        ON revision (branch, id, seq, op_index);
      CREATE INDEX idx_revision_commit ON revision (commit_seq);
      CREATE INDEX idx_revision_branch ON revision (branch, seq);
      CREATE TABLE head (
        branch    TEXT    NOT NULL,
        id        TEXT    NOT NULL,
        seq       INTEGER NOT NULL,
        op_index  INTEGER NOT NULL,
        PRIMARY KEY (branch, id)
      );
      CREATE INDEX idx_head_branch ON head (branch);
      CREATE TABLE snapshot (
        branch  TEXT    NOT NULL DEFAULT '',
        id      TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        value   JSON    NOT NULL,
        PRIMARY KEY (branch, id, seq)
      );
      CREATE INDEX idx_snapshot_lookup ON snapshot (branch, id, seq);
      CREATE TABLE branch (
        name           TEXT    NOT NULL PRIMARY KEY,
        parent_branch  TEXT,
        fork_seq       INTEGER,
        created_seq    INTEGER NOT NULL DEFAULT 0,
        head_seq       INTEGER NOT NULL DEFAULT 0,
        status         TEXT    NOT NULL DEFAULT 'active',
        created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        deleted_at     TEXT
      );
      INSERT INTO branch (name, created_seq, head_seq, status)
      VALUES ('', 0, 1, 'active');
      INSERT INTO "commit" (seq, branch, session_id, local_seq, original, resolution)
      VALUES (1, '', 'legacy-session', 1, '{}', '{}');
    `);
    legacyDb.prepare(
      `INSERT INTO revision (branch, id, seq, op_index, op, data, commit_seq)
       VALUES ('', 'entity:legacy', 1, 0, 'set', ?, 1)`,
    ).run(encodeMemoryBoundary(toEntityDocument({ migrated: true })));
    legacyDb.prepare(
      `INSERT INTO head (branch, id, seq, op_index)
       VALUES ('', 'entity:legacy', 1, 0)`,
    ).run();
    legacyDb.prepare(
      `INSERT INTO snapshot (branch, id, seq, value)
       VALUES ('', 'entity:legacy', 1, ?)`,
    ).run(encodeMemoryBoundary(toEntityDocument({ migrated: true })));
  } finally {
    legacyDb.close();
  }

  let engine = await open({ url });
  try {
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
    applyCommit(engine, {
      sessionId: "session:scoped",
      principal: "did:key:scoped",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:legacy",
          scope: "user",
          value: toEntityDocument({ migrated: false, scoped: true }),
        }],
      },
    });
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
    assertEquals(
      read(engine, {
        id: "entity:legacy",
        scope: "user",
        principal: "did:key:scoped",
        sessionId: "session:scoped",
      }),
      { value: { migrated: false, scoped: true } },
    );
  } finally {
    close(engine);
  }

  engine = await open({ url });
  try {
    assertEquals(read(engine, { id: "entity:legacy", scope: "space" }), {
      value: { migrated: true },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine backfills current head operations", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const url = toFileUrl(path);
  let engine = await open({ url });
  try {
    applyCommit(engine, {
      sessionId: "session:migration",
      principal: "did:key:migration",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "entity:migrated-live",
            value: toEntityDocument({ live: true }),
          },
          {
            op: "set",
            id: "entity:migrated-deleted",
            value: toEntityDocument({ live: false }),
          },
          {
            op: "set",
            id: "entity:migrated-user",
            scope: "user",
            value: toEntityDocument({ private: true }),
          },
        ],
      },
    });
    applyCommit(engine, {
      sessionId: "session:migration",
      principal: "did:key:migration",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:migrated-deleted" }],
      },
    });
  } finally {
    close(engine);
  }

  const legacyDb = new Database(path);
  try {
    legacyDb.exec(`
      DROP INDEX idx_head_live_entity_ids;
      ALTER TABLE head DROP COLUMN op;
    `);
    assertEquals(
      legacyDb.prepare(`PRAGMA table_info("head")`).all().some(
        (row) => (row as { name: string }).name === "op",
      ),
      false,
    );
  } finally {
    legacyDb.close();
  }

  engine = await open({ url });
  try {
    assertEquals(listEntityIds(engine), ["entity:migrated-live"]);
    assertEquals(
      engine.database.prepare(`
        SELECT id, scope_key, op
        FROM head
        ORDER BY id, scope_key
      `).all(),
      [
        {
          id: "entity:migrated-deleted",
          scope_key: "space",
          op: "delete",
        },
        { id: "entity:migrated-live", scope_key: "space", op: "set" },
        {
          id: "entity:migrated-user",
          scope_key: "user:did%3Akey%3Amigration",
          op: "set",
        },
      ],
    );
    assertEquals(
      engine.database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_head_live_entity_ids'
      `).get(),
      { name: "idx_head_live_entity_ids" },
    );
    assertEquals(
      (engine.database.prepare(`PRAGMA table_info("head")`).all() as Array<{
        name: string;
        dflt_value: string | null;
      }>).find(({ name }) => name === "op")?.dflt_value,
      null,
    );
    assertThrows(
      () =>
        engine.database.prepare(`
          INSERT INTO head (branch, id, scope_key, seq, op_index)
          VALUES ('', 'entity:migrated-live', 'space', 1, 0)
          ON CONFLICT (branch, id, scope_key) DO UPDATE
          SET seq = excluded.seq, op_index = excluded.op_index
        `).run(),
      Error,
      "NOT NULL constraint failed: head.op",
    );
  } finally {
    close(engine);
  }

  const defaultedDb = new Database(path);
  try {
    defaultedDb.exec(`
      DROP INDEX idx_head_live_entity_ids;
      DROP INDEX idx_head_branch;
      ALTER TABLE head RENAME TO head_defaulted_migration;
      CREATE TABLE head (
        branch    TEXT    NOT NULL,
        id        TEXT    NOT NULL,
        scope_key TEXT    NOT NULL DEFAULT 'space',
        seq       INTEGER NOT NULL,
        op_index  INTEGER NOT NULL,
        op        TEXT    NOT NULL DEFAULT 'set'
          CHECK (op IN ('set', 'patch', 'delete')),
        PRIMARY KEY (branch, id, scope_key)
      );
      CREATE INDEX idx_head_branch ON head (branch);
      INSERT INTO head (branch, id, scope_key, seq, op_index)
      SELECT branch, id, scope_key, seq, op_index
      FROM head_defaulted_migration;
      DROP TABLE head_defaulted_migration;
    `);
    assertEquals(
      defaultedDb.prepare(`
        SELECT op FROM head
        WHERE id = 'entity:migrated-deleted' AND scope_key = 'space'
      `).get(),
      { op: "set" },
    );
  } finally {
    defaultedDb.close();
  }

  engine = await open({ url });
  try {
    assertEquals(listEntityIds(engine), ["entity:migrated-live"]);
    assertEquals(
      engine.database.prepare(`
        SELECT op FROM head
        WHERE id = 'entity:migrated-deleted' AND scope_key = 'space'
      `).get(),
      { op: "delete" },
    );
    assertEquals(
      (engine.database.prepare(`PRAGMA table_info("head")`).all() as Array<{
        name: string;
        dflt_value: string | null;
      }>).find(({ name }) => name === "op")?.dflt_value,
      null,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine conflicts are scoped by declared scope", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:conflict",
          scope: "user",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });

    const spaceWrite = applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:conflict",
            path: toDocumentPath(["value"]),
            seq: 0,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:space-only",
          value: toEntityDocument("ok"),
        }],
      },
    });
    assertEquals(spaceWrite.seq, 2);

    applyCommit(engine, {
      sessionId: "session:alice",
      principal: "did:key:alice",
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:conflict",
          scope: "user",
          value: toEntityDocument({ count: 2 }),
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:alice",
          principal: "did:key:alice",
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [{
                id: "entity:conflict",
                scope: "user",
                path: toDocumentPath(["value"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:conflict-result",
              scope: "user",
              value: toEntityDocument("stale"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: stale-read ConflictError carries every conflicted entity and previews them in the message", async () => {
  // The message preview is a compatibility surface for transports that retain
  // only standard Error fields. The structured array includes every stale instance.

  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";

  try {
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:stale-named",
          value: toEntityDocument({ v: 1 }),
        }, {
          op: "set",
          id: "entity:also-stale",
          value: toEntityDocument({ v: 1 }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:stale-named",
          value: toEntityDocument({ v: 2 }),
        }, {
          op: "set",
          id: "entity:also-stale",
          value: toEntityDocument({ v: 2 }),
        }],
      },
    });

    const error = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [
                {
                  id: "entity:stale-named",
                  path: toDocumentPath(["value"]),
                  seq: 1,
                },
                {
                  id: "entity:also-stale",
                  path: toDocumentPath(["value"]),
                  seq: 1,
                },
              ],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:stale-result",
              value: toEntityDocument("late"),
            }],
          },
        }),
      ConflictError,
    );
    assertEquals(error.of, "entity:stale-named");
    assertEquals(error.scope, "space");
    assertEquals(error.seq, 1);
    assertEquals(error.conflictSeq, 2);
    assertEquals(
      error.conflicts,
      [
        { of: "entity:stale-named", scope: "space", seq: 1, conflictSeq: 2 },
        { of: "entity:also-stale", scope: "space", seq: 1, conflictSeq: 2 },
      ],
    );
    assertEquals(
      Array.from(
        error.message.matchAll(/stale confirmed read: (\S+) at seq/g),
        (match) => match[1],
      ),
      ["entity:stale-named", "entity:also-stale"],
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: leaf-only commit conflict — disjoint-key writers merge, same-key/container readers still conflict", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:map";
  const scope = "space" as const;

  try {
    // seq 1: establish a map with keys a, b.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ a: "1", b: "2" }),
        }],
      },
    });

    // seq 2: a concurrent writer ADDS a new key `c`. An add/remove patch is the
    // case where `touchedPathsForPatch` used to inject the parent ["value"].
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/c", value: "3" }],
        }],
      },
    });

    // DISTINCT-KEY: a writer whose conflict read is only the SIBLING key `a`
    // (as a keyed `.set()`'s own-key/diff read is) must NOT conflict with the
    // seq-2 add of `c`. Leaf-only: ["value","c"] does not overlap ["value","a"].
    // Pre-fix (parent-injected ["value"]) this collided — the write-contention bug.
    const merged = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [{
            id,
            scope,
            path: toDocumentPath(["value", "a"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/d", value: "4" }],
        }],
      },
    });
    assertEquals(merged.seq, 3);

    // SAME-KEY: a writer that read `c` (the key the seq-2 add created) MUST still
    // conflict — genuine read-modify-write is preserved (leaf exactly matches).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value", "c"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sink",
              scope,
              value: toEntityDocument("x"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // CONTAINER READER: a writer that read the whole container ["value"] MUST
    // still conflict with a key add (the container's value changed) — caught via
    // the bidirectional overlap (the container read is a prefix of the leaf add).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sink2",
              scope,
              value: toEntityDocument("y"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: nonRecursive shape read conflicts with key add but not a disjoint deep-value write", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:shape";
  const scope = "space" as const;

  try {
    // seq 1: container with a value at key x.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ x: "1" }),
        }],
      },
    });
    // seq 2: a key ADD (changes the container's key-set).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "add", path: "/value/y", value: "3" }],
        }],
      },
    });
    // seq 3: a disjoint DEEP-VALUE replace strictly below the container.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "replace", path: "/value/x", value: "2" }],
        }],
      },
    });

    // A: a SHAPE (nonRecursive) reader of the container observed at seq 2 must
    // NOT conflict with the seq-3 deep-value replace — it never depended on x's
    // value, only the container's shape.
    const ok = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: {
          confirmed: [{
            id,
            scope,
            path: toDocumentPath(["value"]),
            seq: 2,
            nonRecursive: true,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:sinkA",
          scope,
          value: toEntityDocument("ok"),
        }],
      },
    });
    assertEquals(ok.seq, 4);

    // B: a RECURSIVE reader of the same container observed at seq 2 MUST conflict
    // with the seq-3 deep-value replace (its read covered x).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 2,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkB",
              scope,
              value: toEntityDocument("x"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // C: a SHAPE reader observed at seq 1 MUST still conflict with the seq-2 key
    // ADD — adding a key changes the key-set the shape read observed.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 6,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkC",
              scope,
              value: toEntityDocument("y"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: nonRecursive shape read conflicts with array move and splice patches", async () => {
  // A non-recursive (keyset / shape) read is matched against a patch via the
  // parent-injecting `touchedPathsForPatch` (patchOverlapsNonRecursiveRead). The
  // add/remove arms are covered above; this pins the `move` and `splice` arms —
  // reordering or splicing an array changes the shape a keyset reader observed,
  // so it must conflict (the patch's parent path is injected and prefix-matches
  // the read).
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:array-shape";
  const scope = "space" as const;

  try {
    // seq 1: a container holding an array.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          scope,
          value: toEntityDocument({ arr: ["a", "b", "c"] }),
        }],
      },
    });

    // seq 2: a MOVE within the array (reorders elements).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{ op: "move", from: "/value/arr/0", path: "/value/arr/2" }],
        }],
      },
    });

    // A shape reader of the array observed at seq 1 MUST conflict with the seq-2
    // move (covers `touchedPathsForPatch`'s `move` arm via the injected parent).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value", "arr"]),
                seq: 1,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkMove",
              scope,
              value: toEntityDocument("m"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // seq 3: a SPLICE on the array (removes an element, adds another).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          scope,
          patches: [{
            op: "splice",
            path: "/value/arr",
            index: 0,
            remove: 1,
            add: ["z"],
          }],
        }],
      },
    });

    // A shape reader observed at seq 2 (after the move, before the splice) MUST
    // conflict with the seq-3 splice (covers `touchedPathsForPatch`'s `splice`
    // arm: the spliced array path prefix-matches the keyset read).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                scope,
                path: toDocumentPath(["value", "arr"]),
                seq: 2,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkSplice",
              scope,
              value: toEntityDocument("s"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: leaf-only matcher does NOT conflict on a synthetic indexed-array add (intentional; runner never emits one)", async () => {
  // DIVERGENCE MARKER. The recursive commit matcher is leaf-only, so an indexed
  // array `add` (which the engine accepts but the runner never produces) touches
  // ONLY the added index — it does not conflict a reader of a sibling index.
  // This is intentional: it keeps commit-conflict aligned with the leaf-only
  // scheduler reader-dirty index (the invariant #4210 relies on). Production
  // safety comes from the diff generator never emitting an indexed-array add (see
  // packages/runner/test/memory-v2-native-commit.test.ts and the
  // `assertNoIndexedArrayStructuralOps` guard in storage/v2-transaction.ts), NOT
  // from the matcher conflicting it. Ben's #4307 deliberately diverges here (its
  // "keeps array add conflicts conservative" test asserts the opposite); that
  // extra conservatism is what makes #4307 incompatible with #4210, because the
  // reader-dirty index would not re-trigger the conflicted reader.
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:array-leaf-only";

  try {
    // seq 1: array seed.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({ poll: { answers: ["bob"] } }),
        }],
      },
    });

    // seq 2: a (synthetic) indexed-array add inserting at index 1.
    applyCommit(engine, {
      sessionId: "session:other",
      principal: "did:key:other",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "add",
            path: "/value/poll/answers/1",
            value: "alice",
          }],
        }],
      },
    });

    // A reader of the sibling index `answers/0` observed at seq 1 is NOT rejected
    // by the leaf-only matcher: the seq-2 add touched only `answers/1`. (Here
    // `answers/0` is in fact unchanged by an insert at index 1, so allowing it is
    // also semantically correct; the general point is that leaf-only conflicts no
    // sibling-index reader on an indexed add — hence the runner must never emit
    // one.)
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id,
            path: toDocumentPath(["value", "poll", "answers", "0"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ firstAnswer: "bob" }),
        }],
      },
    });
    assertEquals(read(engine, { id: "entity:derived" }), {
      value: { firstAnswer: "bob" },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: leaf-only matcher conflicts conservatively with array splice and whole-array replace (the shapes the runner DOES emit)", async () => {
  // The runner encodes every array length change as a `splice` on the array path
  // or a whole-array `replace` (never an indexed add/remove). Both carry the
  // ARRAY's own path, which the leaf-only matcher treats as touching every index
  // below it — so a recursive reader of any sibling index conflicts. This pins
  // that leaf-only stays conservative (no false-negative) for the array ops that
  // actually occur in production, which is what makes #4220 safe given the
  // divergence-marker test above.
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const id = "entity:array-conservative";

  try {
    // seq 1: array seed.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: toEntityDocument({ arr: ["a", "b", "c"] }),
        }],
      },
    });

    // seq 2: a SPLICE on the array path (how the runner encodes a length change).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "splice",
            path: "/value/arr",
            index: 0,
            remove: 1,
            add: ["z"],
          }],
        }],
      },
    });

    // A recursive reader of the sibling index `arr/0` observed at seq 1 MUST
    // conflict with the seq-2 splice (the splice's array path prefix-matches the
    // index read) — leaf-only stays conservative for shifts encoded as splice.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id,
                path: toDocumentPath(["value", "arr", "0"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkSplice",
              value: toEntityDocument("s"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // seq 3: a whole-array REPLACE (the runner's fallback for messy shifts).
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id,
          patches: [{
            op: "replace",
            path: "/value/arr",
            value: ["p", "q"],
          }],
        }],
      },
    });

    // A recursive reader of `arr/1` observed at seq 2 MUST conflict with the
    // seq-3 whole-array replace (replace's array path prefix-matches the read).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [{
                id,
                path: toDocumentPath(["value", "arr", "1"]),
                seq: 2,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:sinkReplace",
              value: toEntityDocument("r"),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine persists set and delete commits as seq revisions", async () => {
  const { engine, path } = await createEngine();

  try {
    const document = toEntityDocument(
      { hello: "world" },
      entityRefFromString("origin"),
    );

    const setResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:1",
          value: document,
        }],
      },
    });

    assertEquals(setResult.seq, 1);
    assertEquals(setResult.branch, DEFAULT_BRANCH);
    assertEquals(read(engine, { id: "entity:1" }), document);

    const commitRow = engine.database.prepare(
      `SELECT seq, branch, session_id, local_seq, invocation_ref,
              authorization_ref, original, resolution
       FROM "commit"
       WHERE seq = 1`,
    ).get() as
      | {
        seq: number;
        branch: string;
        session_id: string;
        local_seq: number;
        invocation_ref: string | null;
        authorization_ref: string | null;
        original: string;
        resolution: string;
      }
      | undefined;
    assertExists(commitRow);
    assertEquals(commitRow.seq, 1);
    assertEquals(commitRow.branch, DEFAULT_BRANCH);
    assertEquals(commitRow.session_id, "session:1");
    assertEquals(commitRow.local_seq, 1);
    assertEquals(commitRow.invocation_ref, null);
    assertEquals(commitRow.authorization_ref, null);
    assertEquals(decodeStored(commitRow.original), {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:1",
        value: document,
      }],
    });
    assertEquals(decodeStored(commitRow.resolution), { seq: 1 });

    const revisionRow = engine.database.prepare(
      `SELECT branch, id, seq, op_index, op, data, commit_seq
       FROM revision
       WHERE id = 'entity:1' AND seq = 1`,
    ).get() as
      | {
        branch: string;
        id: string;
        seq: number;
        op_index: number;
        op: string;
        data: string;
        commit_seq: number;
      }
      | undefined;
    assertExists(revisionRow);
    assertEquals(revisionRow.branch, DEFAULT_BRANCH);
    assertEquals(revisionRow.id, "entity:1");
    assertEquals(revisionRow.seq, 1);
    assertEquals(revisionRow.op_index, 0);
    assertEquals(revisionRow.op, "set");
    assertEquals(decodeStored(revisionRow.data), document);
    assertEquals(revisionRow.commit_seq, 1);
    assertEquals(
      engine.database.prepare(
        "SELECT COUNT(*) AS count FROM invocation",
      ).get() as { count: number },
      { count: 0 },
    );
    assertEquals(
      engine.database.prepare(
        "SELECT COUNT(*) AS count FROM authorization",
      ).get() as { count: number },
      { count: 0 },
    );

    const deleteResult = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:1" }],
      },
    });

    assertEquals(deleteResult.seq, 2);
    assertEquals(read(engine, { id: "entity:1" }), null);

    const deleteRevision = engine.database.prepare(
      `SELECT op, data
       FROM revision
       WHERE id = 'entity:1' AND seq = 2`,
    ).get() as
      | {
        op: string;
        data: string | null;
      }
      | undefined;
    assertEquals(deleteRevision, { op: "delete", data: null });

    const headRow = engine.database.prepare(
      `SELECT branch, id, seq, op_index
       FROM head
       WHERE branch = '' AND id = 'entity:1'`,
    ).get() as
      | {
        branch: string;
        id: string;
        seq: number;
        op_index: number;
      }
      | undefined;
    assertEquals(headRow, {
      branch: "",
      id: "entity:1",
      seq: 2,
      op_index: 0,
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine preserves source-only entity documents", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:source-only",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:piece:1",
          value: toEntityDocument(undefined, entityRefFromString("process:1")),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "of:piece:1" }),
      toEntityDocument(undefined, entityRefFromString("process:1")),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine ignores supplied transact invocation metadata", async () => {
  const { engine, path } = await createEngine();

  try {
    const rawInvocation = {
      iss: 42,
      aud: { unexpected: true },
      cmd: ["not", "a", "string"],
      sub: null,
      args: {
        localSeq: 1,
      },
      note: "untrusted transport payload",
    };

    applyCommit(engine, {
      sessionId: "session:raw-invocation",
      invocation: {
        iss: "did:key:space",
        aud: null,
        cmd: "/memory/transact",
        sub: "did:key:space",
        args: {
          localSeq: 1,
        },
      },
      invocationPayload: rawInvocation,
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:raw-invocation",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    const row = engine.database.prepare(
      `SELECT invocation_ref, authorization_ref
       FROM "commit"
       WHERE session_id = ? AND local_seq = ?`,
    ).get(["session:raw-invocation", 1]) as
      | {
        invocation_ref: string | null;
        authorization_ref: string | null;
      }
      | undefined;
    assertExists(row);
    assertEquals(row.invocation_ref, null);
    assertEquals(row.authorization_ref, null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine preserves root objects whose data includes value siblings", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:value-siblings",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:value-siblings",
          value: toEntityDocument("hello", undefined, {
            other: "data",
          }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:value-siblings" }),
      toEntityDocument("hello", undefined, {
        other: "data",
      }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine replays patch revisions for current and point-in-time reads", async () => {
  const { engine, path } = await createEngine();

  try {
    const original = toEntityDocument(
      {
        profile: { name: "Alice" },
        tags: ["one"],
      },
      entityRefFromString("origin"),
    );

    applyCommit(engine, {
      sessionId: "session:patch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:patch",
          value: original,
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:patch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:patch",
          patches: [
            { op: "replace", path: "/value/profile/name", value: "Bob" },
            { op: "add", path: "/value/profile/title", value: "Dr" },
            {
              op: "splice",
              path: "/value/tags",
              index: 1,
              remove: 0,
              add: ["two", "three"],
            },
          ],
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:patch" }),
      toEntityDocument(
        {
          profile: { name: "Bob", title: "Dr" },
          tags: ["one", "two", "three"],
        },
        entityRefFromString("origin"),
      ),
    );
    assertEquals(read(engine, { id: "entity:patch", seq: 1 }), original);

    const patchRevision = engine.database.prepare(
      `SELECT op, data
       FROM revision
       WHERE id = 'entity:patch' AND seq = 2`,
    ).get() as
      | {
        op: string;
        data: string;
      }
      | undefined;
    assertEquals(patchRevision?.op, "patch");
    assertEquals(decodeStored(patchRevision?.data), [
      { op: "replace", path: "/value/profile/name", value: "Bob" },
      { op: "add", path: "/value/profile/title", value: "Dr" },
      {
        op: "splice",
        path: "/value/tags",
        index: 1,
        remove: 0,
        add: ["two", "three"],
      },
    ]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine materializes snapshots and reuses them for later reads", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 2,
  });

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot",
          value: toEntityDocument({ tags: ["one"] }),
        }],
      },
    });

    for (const [localSeq, value] of [[2, "two"], [3, "three"]] as const) {
      applyCommit(engine, {
        sessionId: "session:snapshot",
        invocation: invocationFor(localSeq),
        authorization,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:snapshot",
            patches: [{
              op: "splice",
              path: "/value/tags",
              index: localSeq - 1,
              remove: 0,
              add: [value],
            }],
          }],
        },
      });
    }

    const snapshotRow = engine.database.prepare(
      `SELECT seq, value
       FROM snapshot
       WHERE branch = '' AND id = 'entity:snapshot'
       ORDER BY seq DESC
       LIMIT 1`,
    ).get() as
      | {
        seq: number;
        value: string;
      }
      | undefined;
    assertEquals(snapshotRow?.seq, 3);
    assertEquals(decodeStored(snapshotRow?.value), {
      value: { tags: ["one", "two", "three"] },
    });

    applyCommit(engine, {
      sessionId: "session:snapshot",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:snapshot",
          patches: [{
            op: "splice",
            path: "/value/tags",
            index: 3,
            remove: 0,
            add: ["four"],
          }],
        }],
      },
    });

    engine.database.prepare(
      "DELETE FROM revision WHERE id = 'entity:snapshot' AND seq = 2",
    ).run();

    assertEquals(
      read(engine, { id: "entity:snapshot", seq: 3 }),
      toEntityDocument({ tags: ["one", "two", "three"] }),
    );
    assertEquals(
      read(engine, { id: "entity:snapshot" }),
      toEntityDocument({ tags: ["one", "two", "three", "four"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine compacts old snapshots beyond retention", async () => {
  const { engine, path } = await createEngineWithOptions({
    snapshotInterval: 1,
    snapshotRetention: 2,
  });

  try {
    applyCommit(engine, {
      sessionId: "session:snapshot-retention",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:snapshot-retention",
          value: toEntityDocument({ tags: ["one"] }),
        }],
      },
    });

    for (
      const [localSeq, value] of [[2, "two"], [3, "three"], [
        4,
        "four",
      ]] as const
    ) {
      applyCommit(engine, {
        sessionId: "session:snapshot-retention",
        invocation: invocationFor(localSeq),
        authorization,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:snapshot-retention",
            patches: [{
              op: "splice",
              path: "/value/tags",
              index: localSeq - 1,
              remove: 0,
              add: [value],
            }],
          }],
        },
      });
    }

    const snapshotRows = engine.database.prepare(
      `SELECT seq
       FROM snapshot
       WHERE branch = '' AND id = 'entity:snapshot-retention'
       ORDER BY seq ASC`,
    ).all() as Array<{ seq: number }>;
    assertEquals(snapshotRows, [{ seq: 3 }, { seq: 4 }]);
    assertEquals(
      read(engine, { id: "entity:snapshot-retention", seq: 2 }),
      toEntityDocument({ tags: ["one", "two"] }),
    );
    assertEquals(
      read(engine, { id: "entity:snapshot-retention" }),
      toEntityDocument({ tags: ["one", "two", "three", "four"] }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects stale confirmed reads and allows non-overlapping ones", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({
            profile: { name: "Alice" },
            settings: { theme: "light" },
          }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "settings"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{
            op: "replace",
            path: "/value/settings/theme",
            value: "dark",
          }],
        }],
      },
    });

    const allowed = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "profile", "name"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:derived",
          value: toEntityDocument({ derivedFromName: true }),
        }],
      },
    });
    assertEquals(allowed.seq, 3);

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(3),
          authorization,
          commit: {
            localSeq: 3,
            reads: {
              confirmed: [{
                id: "entity:source",
                path: toDocumentPath(["value", "settings"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:rejected",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    assertEquals(read(engine, { id: "entity:derived" }), {
      value: { derivedFromName: true },
    });
    assertEquals(read(engine, { id: "entity:rejected" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine resolves pending reads and rejects stale pending reads", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({ foo: 0, bar: 0 }),
        }],
      },
    });

    const base = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [{
            id: "entity:source",
            path: toDocumentPath(["value", "foo"]),
            seq: 1,
          }],
          pending: [],
        },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/foo", value: 1 }],
        }],
      },
    });
    assertEquals(base.seq, 2);

    const derived = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:source",
            path: toDocumentPath(["value", "foo"]),
            localSeq: 2,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:target",
          value: toEntityDocument({ derived: true }),
        }],
      },
    });
    assertEquals(derived.seq, 3);

    const resolutionRow = engine.database.prepare(
      `SELECT resolution
       FROM "commit"
       WHERE session_id = 'session:1' AND local_seq = 3`,
    ).get() as { resolution: string } | undefined;
    assertEquals(decodeStored(resolutionRow?.resolution), {
      seq: 3,
      resolvedPendingReads: [{
        localSeq: 2,
        seq: 2,
      }],
    });

    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/bar", value: 1 }],
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(4),
          authorization,
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath(["value", "bar"]),
                localSeq: 2,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:broken",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "stale pending read",
    );

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath(["value"]),
                localSeq: 99,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:missing",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      Error,
      "pending dependency",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: array pending reads scan at the highest layer and require every layer to resolve", async () => {
  // CT-1872 1c: an array localSeq names every pending layer the read sat on.
  // Non-highest elements impose resolution ONLY (the dependency must have an
  // accepted commit row) — staleness is based at the HIGHEST element, so a
  // foreign write that lands before the highest element's resolution must NOT
  // reject the read, while an unresolved element still must.
  //
  // NOTE: this pins main's de-facto basis semantics made explicit on the wire,
  // not an endorsement of the scan interval. The staleness scan starts at the
  // highest layer's resolution seq, so foreign writes in (reader's confirmed
  // basis, that resolution] go unscanned — a pre-existing gap tracked as
  // CT-1910 (pending-read basis over-advance), whose fix (own-session
  // exclusion + true-basis validation) supersedes the max-basis rule.

  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({ foo: 0 }),
        }],
      },
    });

    // The dependency: localSeq 2 commits durably (seq 2).
    const dependency = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "replace", path: "/value/foo", value: 1 }],
        }],
      },
    });
    assertEquals(dependency.seq, 2);

    // A LATER overlapping foreign write to the same doc (a whole-doc set is
    // path-blind, so it overlaps ANY read of entity:source): a normal pending
    // read via localSeq 2 is now stale.
    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({ foo: 2 }),
        }],
      },
    });

    // A newer same-session blind layer (localSeq 3, zero reads) lands AFTER
    // the foreign write: the doc's stack top below the reader.
    const top = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{ op: "add", path: "/value/blind", value: true }],
        }],
      },
    });
    assertEquals(top.seq, 4);

    // Array [2, 3]: staleness is based at the HIGHEST layer (3 → seq 4), so
    // the foreign seq-3 write is outside the scan; element 2 imposes
    // resolution only ⇒ ACCEPTED.
    const accepted = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:source",
            path: toDocumentPath([]),
            localSeq: [2, 3],
          }],
        },
        operations: [{
          op: "set",
          id: "entity:target",
          value: toEntityDocument({ derived: true }),
        }],
      },
    });
    assertEquals(accepted.seq, 5);

    // The array does NOT waive resolution for any element: one uncommitted
    // member rejects the whole read.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: [2, 99],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:unresolved",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ConflictError,
      "pending dependency not resolved",
    );

    // Malformed dependency sets are protocol violations, not conflicts: an
    // empty array names no layer at all…
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(7),
          authorization,
          commit: {
            localSeq: 7,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: [],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:malformed-empty",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ProtocolError,
      "names no localSeq",
    );

    // …and a non-integer element is not a localSeq.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(8),
          authorization,
          commit: {
            localSeq: 8,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: [1.5],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:malformed-float",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ProtocolError,
      "malformed localSeq",
    );

    // Control: based at the LOWER layer alone (scalar 2), the foreign seq-3
    // write is inside the scan interval — the max-basis rule, not the
    // scenario, is what admitted the commit above.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(6),
          authorization,
          commit: {
            localSeq: 6,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:source",
                path: toDocumentPath([]),
                localSeq: 2,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:control",
              value: toEntityDocument({ ok: false }),
            }],
          },
        }),
      ConflictError,
      "stale pending read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: full-stack dependency recording rejects a fabricated composite an under-declared commit smuggles through", async () => {
  // CT-1872 1c, end to end at the engine: a fabricated composite must die on
  // the resolution edge, because no staleness scan can catch it.
  //
  //   base:  D = { items: [] }                                  (seq 1)
  //   T1  (localSeq 10): items = ["A"]  — REJECTED (stale read on title)
  //   T1.5 (localSeq 11): blind append "B", zero reads — APPLIED → items ["B"]
  //   T2  (localSeq 12): observed items ["A","B"] through the client stack
  //
  // T2's observation is not STALE — ["A","B"] never existed at any seq; "A"
  // lived only in the client's optimistic layer for a commit the server
  // refused. An under-declared T2 (scalar top-of-stack read: what a client
  // emits toward a server without the `pendingReadStacks` flag) passes both
  // resolution (T1.5 has a commit row) and the staleness scan (nothing touched
  // items after seq(T1.5)) and is durably ACCEPTED with a phantom premise.
  // The full-stack array shape (#4606) also names T1, and the missing commit
  // row rejects it.

  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:seed",
      invocation: invocationFor(1, { actor: "seed" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:D",
          value: toEntityDocument({ items: [], title: "t0" }),
        }],
      },
    });

    // Foreign write (seq 2) bumps title so T1's confirmed read goes stale.
    applyCommit(engine, {
      sessionId: "session:other",
      invocation: invocationFor(1, { actor: "other" }),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:D",
          patches: [{
            op: "replace",
            path: "/value/title",
            value: "t-foreign",
          }],
        }],
      },
    });

    // T1: REJECTED — its items=["A"] write is discarded everywhere.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(10),
          authorization,
          commit: {
            localSeq: 10,
            reads: {
              confirmed: [{
                id: "entity:D",
                path: toDocumentPath(["value", "title"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "patch",
              id: "entity:D",
              patches: [{
                op: "replace",
                path: "/value/items",
                value: ["A"],
              }],
            }],
          },
        }),
      ConflictError,
      "stale confirmed read",
    );

    // T1.5: blind append, zero reads — applies onto the T1-less base.
    applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(11),
      authorization,
      commit: {
        localSeq: 11,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:D",
          patches: [{ op: "add", path: "/value/items/-", value: "B" }],
        }],
      },
    });

    // Under-declared shape (pre-#4606 client): top-of-stack read only.
    // ACCEPTED — resolution and staleness both legitimately pass, and the
    // phantom ["A","B"] premise lands durably. This pins WHY the full-stack
    // shape below is load-bearing (and stays reachable via version skew).
    const smuggled = applyCommit(engine, {
      sessionId: "session:1",
      invocation: invocationFor(12),
      authorization,
      commit: {
        localSeq: 12,
        reads: {
          confirmed: [],
          pending: [{
            id: "entity:D",
            path: toDocumentPath(["value", "items"]),
            localSeq: 11,
          }],
        },
        operations: [{
          op: "set",
          id: "entity:phantom",
          value: toEntityDocument({ observedItems: ["A", "B"] }),
        }],
      },
    });
    assertEquals(smuggled.seq, 4);
    const durable = read(engine, { id: "entity:D" });
    assertEquals(
      (durable as { value?: { items?: unknown } } | null)?.value?.items,
      ["B"],
    );

    // Full-stack array shape (#4606): the same observation also names T1,
    // whose commit row does not exist — rejected on the resolution edge.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:1",
          invocation: invocationFor(13),
          authorization,
          commit: {
            localSeq: 13,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:D",
                path: toDocumentPath(["value", "items"]),
                localSeq: [10, 11],
              }],
            },
            operations: [{
              op: "set",
              id: "entity:caught",
              value: toEntityDocument({ observedItems: ["A", "B"] }),
            }],
          },
        }),
      ConflictError,
      "pending dependency not resolved: 10",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine reconstructs state across delete boundaries", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:timeline",
          value: toEntityDocument({
            phase: "one",
            data: { start: true },
          }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:timeline",
          patches: [{ op: "add", path: "/value/data/step", value: 2 }],
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:timeline" }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:timeline",
      invocation: invocationFor(4),
      authorization,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:timeline",
          value: toEntityDocument({
            phase: "two",
            data: { restart: true },
          }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:timeline", seq: 1 }),
      toEntityDocument({ phase: "one", data: { start: true } }),
    );
    assertEquals(
      read(engine, { id: "entity:timeline", seq: 2 }),
      toEntityDocument({ phase: "one", data: { start: true, step: 2 } }),
    );
    assertEquals(read(engine, { id: "entity:timeline", seq: 3 }), null);
    assertEquals(
      read(engine, { id: "entity:timeline" }),
      toEntityDocument({ phase: "two", data: { restart: true } }),
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine supports branch inheritance, divergence, and deletion", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });

    assertEquals(createBranch(engine, DEFAULT_BRANCH), {
      name: DEFAULT_BRANCH,
      parentBranch: null,
      forkSeq: null,
      createdSeq: 0,
      headSeq: 1,
      status: "active",
    });
    const featureBranch = {
      name: "feature",
      parentBranch: DEFAULT_BRANCH,
      forkSeq: 1,
      createdSeq: 1,
      headSeq: 1,
      status: "active" as const,
    };
    assertEquals(
      createBranch(engine, "feature"),
      featureBranch,
    );
    assertEquals(createBranch(engine, "feature"), featureBranch);
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 1 }),
    );

    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 2 }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:branch",
      invocation: invocationFor(3),
      authorization,
      commit: {
        localSeq: 3,
        branch: "feature",
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-doc",
          value: toEntityDocument({ count: 10 }),
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:branch-doc" }),
      toEntityDocument({ count: 2 }),
    );
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 10 }),
    );
    assertEquals(
      listBranches(engine),
      [{
        name: "",
        parentBranch: null,
        forkSeq: null,
        createdSeq: 0,
        headSeq: 2,
        status: "active",
      }, {
        name: "feature",
        parentBranch: "",
        forkSeq: 1,
        createdSeq: 1,
        headSeq: 3,
        status: "active",
      }],
    );

    deleteBranch(engine, "feature");
    assertEquals(
      listBranches(engine).find((branch) => branch.name === "feature"),
      {
        name: "feature",
        parentBranch: "",
        forkSeq: 1,
        createdSeq: 1,
        headSeq: 3,
        status: "deleted",
      },
    );
    assertEquals(
      read(engine, { id: "entity:branch-doc", branch: "feature" }),
      toEntityDocument({ count: 10 }),
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:branch",
          invocation: invocationFor(4),
          authorization,
          commit: {
            localSeq: 4,
            branch: "feature",
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:branch-doc",
              value: toEntityDocument({ count: 11 }),
            }],
          },
        }),
      Error,
      "branch is not active",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:branch",
          invocation: invocationFor(5),
          authorization,
          commit: {
            localSeq: 5,
            branch: "missing",
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "entity:branch-doc",
              value: toEntityDocument({ count: 12 }),
            }],
          },
        }),
      Error,
      "unknown branch: missing",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine rejects branch reads before createdSeq", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:branch-bounds",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:branch-bounds-doc",
          value: toEntityDocument({ count: 1 }),
        }],
      },
    });
    createBranch(engine, "feature");

    assertThrows(
      () =>
        read(engine, {
          id: "entity:branch-bounds-doc",
          branch: "feature",
          seq: 0,
        }),
      Error,
      "seq 0 is out of range for branch feature",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine persists fabric patch values at the storage boundary", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:rich-patch",
      invocation: invocationFor(1),
      authorization,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:rich-patch",
          value: toEntityDocument({ counter: 1n }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:rich-patch",
      invocation: invocationFor(2),
      authorization,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:rich-patch",
          patches: [{
            op: "replace",
            path: "/value/counter",
            value: 2n,
          }],
        }],
      },
    });

    assertEquals(
      read(engine, { id: "entity:rich-patch" }),
      toEntityDocument({ counter: 2n }),
    );

    const patchRow = engine.database.prepare(
      `SELECT data
         FROM revision
         WHERE id = 'entity:rich-patch' AND seq = 2`,
    ).get() as { data: string } | undefined;
    assertEquals(decodeStored(patchRow?.data), [{
      op: "replace",
      path: "/value/counter",
      value: 2n,
    }]);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("memory v2 engine: nonRecursive shape read conflicts with a mergeable create-from-absent (createsKey) but not an append to an existing array", async () => {
  const { engine, path } = await createEngine();
  const sessionId = "session:alice";
  const principal = "did:key:alice";
  const scope = "space" as const;
  const created = "entity:created";
  const existing = "entity:existing";

  try {
    // `created`: seq 1 sets a container with NO `items`; seq 2 pushes the first
    // element, materializing `items` — the append carries `createsKey`.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: created, scope, value: toEntityDocument({}) },
        ],
      },
    });
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: created,
          scope,
          patches: [{
            op: "append",
            path: "/value/items",
            values: ["a"],
            createsKey: true,
          }],
        }],
      },
    });

    // `existing`: seq 3 sets a container WITH `items`; seq 4 appends to it — no
    // `createsKey`, because the key already existed.
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: existing,
          scope,
          value: toEntityDocument({ items: ["a"] }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: existing,
          scope,
          patches: [{ op: "append", path: "/value/items", values: ["b"] }],
        }],
      },
    });

    // B (checked first so its commit seq is deterministic): a SHAPE reader of the
    // parent MUST NOT conflict with an append to an ALREADY-PRESENT child array —
    // only the array's contents changed, not the parent's key set.
    const ok = applyCommit(engine, {
      sessionId,
      principal,
      commit: {
        localSeq: 5,
        reads: {
          confirmed: [{
            id: existing,
            scope,
            path: toDocumentPath(["value"]),
            seq: 3,
            nonRecursive: true,
          }],
          pending: [],
        },
        operations: [
          {
            op: "set",
            id: "entity:sinkB",
            scope,
            value: toEntityDocument("b"),
          },
        ],
      },
    });
    assertEquals(ok.seq, 5);

    // A: a SHAPE reader of the parent, observed BEFORE the create, MUST conflict
    // with the create-from-absent append — the parent gained the `items` key.
    // This is the gap the `createsKey` flag closes.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 6,
            reads: {
              confirmed: [{
                id: created,
                scope,
                path: toDocumentPath(["value"]),
                seq: 1,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [
              {
                op: "set",
                id: "entity:sinkA",
                scope,
                value: toEntityDocument("a"),
              },
            ],
          },
        }),
      Error,
      "stale confirmed read",
    );

    // C: a SHAPE reader of the ARRAY ITSELF still conflicts with the append — its
    // own key set (indices / length) changed. Independent of `createsKey`.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId,
          principal,
          commit: {
            localSeq: 7,
            reads: {
              confirmed: [{
                id: existing,
                scope,
                path: toDocumentPath(["value", "items"]),
                seq: 3,
                nonRecursive: true,
              }],
              pending: [],
            },
            operations: [
              {
                op: "set",
                id: "entity:sinkC",
                scope,
                value: toEntityDocument("c"),
              },
            ],
          },
        }),
      Error,
      "stale confirmed read",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("read forwards an explicit scopeKey to readState (protocol.md §2's read row — the exported wrapper must not drop it)", async () => {
  const { engine, path } = await createEngine();
  try {
    // Alice's session writes her user-scoped instance.
    applyCommit(engine, {
      sessionId: "sess-alice",
      space: "did:key:space",
      principal: "did:key:alice",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:scoped-read",
          scope: "user",
          value: { value: { owner: "alice" } },
        }],
      },
    });
    // A DIFFERENT identity reads the instance by explicit key. The
    // wrapper must forward the key: dropping it resolves the scope from
    // (principal, sessionId) and returns the WRONG document (the
    // reader's own empty instance).
    const doc = read(engine, {
      id: "entity:scoped-read",
      scopeKey: "user:did%3Akey%3Aalice",
      principal: "did:key:service",
      sessionId: "sess-service",
    });
    assertEquals(doc?.value, { owner: "alice" });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
