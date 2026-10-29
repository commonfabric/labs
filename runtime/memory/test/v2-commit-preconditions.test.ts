import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";

import type { FabricValue } from "@commonfabric/api";

import {
  commitPreconditionValueHash,
  type EntityDocument,
  toDocumentPath,
} from "../v2.ts";
import { connect, loopback } from "../v2/client.ts";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
  PreconditionFailedError,
  ProtocolError,
  read,
} from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const toEntityDocument = (value: FabricValue): EntityDocument => ({ value });

Deno.test("origin-committed precondition accepts a committed same-session origin", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:lineage",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:origin",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    const followUp = applyCommit(engine, {
      sessionId: "session:lineage",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "origin-committed",
          originLocalSeq: 1,
        }],
        operations: [{
          op: "set",
          id: "entity:follow-up",
          value: toEntityDocument({ released: true }),
        }],
      },
    });

    assertEquals(followUp.seq, 2);
    assertEquals(read(engine, { id: "entity:follow-up" }), {
      value: { released: true },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("origin-committed precondition rejects a rejected origin localSeq", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:setup",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:source",
          value: toEntityDocument({ version: 1 }),
        }],
      },
    });

    applyCommit(engine, {
      sessionId: "session:other",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "entity:source",
          patches: [{
            op: "replace",
            path: "/value/version",
            value: 2,
          }],
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:lineage",
          commit: {
            localSeq: 1,
            reads: {
              confirmed: [{
                id: "entity:source",
                path: toDocumentPath(["value", "version"]),
                seq: 1,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: "entity:origin-attempt",
              value: toEntityDocument({ shouldNotCommit: true }),
            }],
          },
        }),
      Error,
      "stale confirmed read",
    );

    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:lineage",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "origin-committed",
              originLocalSeq: 1,
            }],
            operations: [{
              op: "set",
              id: "entity:descendant",
              value: toEntityDocument({ shouldNotCommit: true }),
            }],
          },
        }),
      PreconditionFailedError,
      "origin commit not committed",
    );

    assertEquals(rejected.name, "PreconditionFailedError");
    assertEquals(rejected.precondition, "origin-committed");
    assertEquals(read(engine, { id: "entity:descendant" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("commits without preconditions are unaffected", async () => {
  const { engine, path } = await createEngine();

  try {
    const applied = applyCommit(engine, {
      sessionId: "session:no-preconditions",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:plain",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    assertEquals(applied.seq, 1);
    assertEquals(read(engine, { id: "entity:plain" }), {
      value: { ok: true },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-absent precondition applies on a fresh entity", async () => {
  const { engine, path } = await createEngine();

  try {
    const applied = applyCommit(engine, {
      sessionId: "session:entity-absent-fresh",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "entity-absent",
          id: "entity:receipt",
        }],
        operations: [{
          op: "set",
          id: "entity:receipt",
          value: toEntityDocument({ receipt: 1 }),
        }],
      },
    });

    assertEquals(applied.seq, 1);
    assertEquals(read(engine, { id: "entity:receipt" }), {
      value: { receipt: 1 },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-value-hash precondition pins a present value", async () => {
  const { engine, path } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session:value-hash-writer",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:manifest",
          value: toEntityDocument({ version: 1 }),
        }],
      },
    });
    const valueHash = commitPreconditionValueHash({ version: 1 });
    const pin = (localSeq: number) => ({
      localSeq,
      reads: { confirmed: [], pending: [] },
      preconditions: [{
        kind: "entity-value-hash" as const,
        id: "entity:manifest",
        valueHash,
      }],
      operations: [],
    });
    applyCommit(engine, {
      sessionId: "session:value-hash-reader",
      commit: pin(1),
    });
    applyCommit(engine, {
      sessionId: "session:value-hash-writer",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:manifest",
          value: toEntityDocument({ version: 2 }),
        }],
      },
    });
    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:value-hash-reader",
          commit: pin(2),
        }),
      ConflictError,
      "entity-value-hash precondition target changed",
    );
    assertEquals(rejected.name, "ConflictError");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-value-hash null pins absence", async () => {
  const { engine, path } = await createEngine();
  try {
    const pin = (localSeq: number) => ({
      localSeq,
      reads: { confirmed: [], pending: [] },
      preconditions: [{
        kind: "entity-value-hash" as const,
        id: "entity:missing-manifest",
        valueHash: null,
      }],
      operations: [],
    });
    applyCommit(engine, {
      sessionId: "session:absent-hash-reader",
      commit: pin(1),
    });
    applyCommit(engine, {
      sessionId: "session:absent-hash-writer",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:missing-manifest",
          value: toEntityDocument({ appeared: true }),
        }],
      },
    });
    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:absent-hash-reader",
          commit: pin(2),
        }),
      ConflictError,
    );
    assertEquals(rejected.name, "ConflictError");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-value-hash treats metadata-only documents as value-absent", async () => {
  const { engine, path } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session:metadata-writer",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:metadata-only",
          value: { metadata: "present" },
        }],
      },
    });
    const pinAbsentValue = (localSeq: number) => ({
      localSeq,
      reads: { confirmed: [], pending: [] },
      preconditions: [{
        kind: "entity-value-hash" as const,
        id: "entity:metadata-only",
        valueHash: null,
      }],
      operations: [],
    });
    applyCommit(engine, {
      sessionId: "session:metadata-reader",
      commit: pinAbsentValue(1),
    });

    applyCommit(engine, {
      sessionId: "session:metadata-writer",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:metadata-only",
          value: { value: null, metadata: "present" },
        }],
      },
    });
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:metadata-reader",
          commit: pinAbsentValue(2),
        }),
      ConflictError,
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-absent precondition rejects when the entity head already exists", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:entity-absent-existing",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "entity-absent",
          id: "entity:receipt",
        }],
        operations: [{
          op: "set",
          id: "entity:receipt",
          value: toEntityDocument({ receipt: 1 }),
        }],
      },
    });

    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:entity-absent-existing",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "entity-absent",
              id: "entity:receipt",
            }],
            operations: [
              {
                op: "set",
                id: "entity:receipt",
                value: toEntityDocument({ receipt: 2 }),
              },
              {
                op: "set",
                id: "entity:side-effect",
                value: toEntityDocument({ shouldNotCommit: true }),
              },
            ],
          },
        }),
      PreconditionFailedError,
      "entity-absent precondition target already exists",
    );

    assertEquals(rejected.name, "PreconditionFailedError");
    assertEquals(rejected.precondition, "receipt-exists");
    assertEquals(read(engine, { id: "entity:receipt" }), {
      value: { receipt: 1 },
    });
    assertEquals(read(engine, { id: "entity:side-effect" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("set without entity-absent precondition overwrites an existing entity", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:entity-absent-normal-set",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "entity-absent",
          id: "entity:receipt",
        }],
        operations: [{
          op: "set",
          id: "entity:receipt",
          value: toEntityDocument({ receipt: 1 }),
        }],
      },
    });

    const applied = applyCommit(engine, {
      sessionId: "session:entity-absent-normal-set",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:receipt",
          value: toEntityDocument({ receipt: 2 }),
        }],
      },
    });

    assertEquals(applied.seq, 2);
    assertEquals(read(engine, { id: "entity:receipt" }), {
      value: { receipt: 2 },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-absent precondition treats a deleted head as existing", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:entity-absent-delete-head",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:receipt",
          value: toEntityDocument({ receipt: 1 }),
        }],
      },
    });
    applyCommit(engine, {
      sessionId: "session:entity-absent-delete-head",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "entity:receipt" }],
      },
    });

    assertEquals(read(engine, { id: "entity:receipt" }), null);

    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:entity-absent-delete-head",
          commit: {
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "entity-absent",
              id: "entity:receipt",
            }],
            operations: [{
              op: "set",
              id: "entity:receipt",
              value: toEntityDocument({ receipt: 3 }),
            }],
          },
        }),
      PreconditionFailedError,
      "entity-absent precondition target already exists",
    );

    assertEquals(rejected.precondition, "receipt-exists");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-absent precondition-only commit applies for an absent entity", async () => {
  const { engine, path } = await createEngine();

  try {
    const applied = applyCommit(engine, {
      sessionId: "session:entity-absent-only-fresh",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "entity-absent",
          id: "entity:receipt",
        }],
        operations: [],
      },
    });

    assertEquals(applied.seq, 1);
    assertEquals(applied.revisions, []);
    assertEquals(read(engine, { id: "entity:receipt" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("entity-absent precondition-only commit rejects for an existing entity", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:entity-absent-only-existing",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:receipt",
          value: toEntityDocument({ receipt: 1 }),
        }],
      },
    });

    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:entity-absent-only-existing",
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "entity-absent",
              id: "entity:receipt",
            }],
            operations: [],
          },
        }),
      PreconditionFailedError,
      "entity-absent precondition target already exists",
    );

    assertEquals(rejected.precondition, "receipt-exists");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("precondition-only commit validates and records against a committed origin", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:lineage",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "entity:origin",
          value: toEntityDocument({ ok: true }),
        }],
      },
    });

    // A descendant handler that performed no semantic writes still commits
    // its origin-committed precondition: the engine must validate it and
    // record the localSeq instead of rejecting the commit as empty.
    const followUp = applyCommit(engine, {
      sessionId: "session:lineage",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "origin-committed",
          originLocalSeq: 1,
        }],
        operations: [],
      },
    });

    assertEquals(followUp.seq, 2);
    assertEquals(followUp.revisions, []);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("precondition-only commit rejects a missing origin with PreconditionFailedError", async () => {
  const { engine, path } = await createEngine();

  try {
    const rejected = assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:lineage",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "origin-committed",
              originLocalSeq: 99,
            }],
            operations: [],
          },
        }),
      PreconditionFailedError,
      "origin commit not committed",
    );
    assertEquals(rejected.precondition, "origin-committed");
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("malformed preconditions are rejected with ProtocolError", async () => {
  const { engine, path } = await createEngine();

  try {
    const malformed: unknown[] = [
      null,
      "origin-committed",
      { kind: 42 },
      { kind: "origin-committed", originLocalSeq: "1" },
      { kind: "origin-committed", originLocalSeq: 1.5 },
      { kind: "origin-committed" },
      { kind: "entity-value-hash", id: "entity:manifest", valueHash: 42 },
    ];
    for (const precondition of malformed) {
      assertThrows(
        () =>
          applyCommit(engine, {
            sessionId: "session:lineage",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              // deno-lint-ignore no-explicit-any
              preconditions: [precondition as any],
              operations: [{
                op: "set",
                id: "entity:should-not-commit",
                value: toEntityDocument({ ok: false }),
              }],
            },
          }),
        ProtocolError,
      );
    }
    assertEquals(read(engine, { id: "entity:should-not-commit" }), null);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("precondition failures keep name and precondition through client round trip", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-commit-preconditions-client"),
  });
  const client = await connect({ transport: loopback(server) });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-commit-preconditions-client",
    {},
    testSessionOpenAuthFactory,
  );

  try {
    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          preconditions: [{
            kind: "origin-committed",
            originLocalSeq: 99,
          }],
          operations: [{
            op: "set",
            id: "entity:descendant",
            value: toEntityDocument({ shouldNotCommit: true }),
          }],
        }),
      Error,
      "origin commit not committed",
    );

    assertEquals(error.name, "PreconditionFailedError");
    assertEquals(
      (error as Error & { precondition?: unknown }).precondition,
      "origin-committed",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("entity-absent failures keep receipt-exists through client round trip", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-entity-absent-client"),
  });
  const client = await connect({ transport: loopback(server) });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-entity-absent-client",
    {},
    testSessionOpenAuthFactory,
  );

  try {
    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:receipt",
        value: toEntityDocument({ receipt: 1 }),
      }],
    });

    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          preconditions: [{
            kind: "entity-absent",
            id: "entity:receipt",
          }],
          operations: [],
        }),
      Error,
      "entity-absent precondition target already exists",
    );

    assertEquals(error.name, "PreconditionFailedError");
    assertEquals(
      (error as Error & { precondition?: unknown }).precondition,
      "receipt-exists",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("replayed receipt commit returns the stored result instead of an entity-absent rejection", async () => {
  const { engine, path } = await createEngine();

  try {
    const commit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      preconditions: [{
        kind: "entity-absent" as const,
        id: "entity:receipt",
      }],
      operations: [{
        op: "set" as const,
        id: "entity:receipt",
        value: toEntityDocument({ receipt: 1 }),
      }],
    };

    const first = applyCommit(engine, {
      sessionId: "session:replay-receipt",
      commit,
    });

    // Identical same-session resend (same localSeq): replay detection runs
    // BEFORE precondition validation, so the stored result comes back.
    // Re-validating entity-absent here would check against the state the
    // first application created and wrongly reject the idempotent replay.
    const replayed = applyCommit(engine, {
      sessionId: "session:replay-receipt",
      commit,
    });

    assertEquals(replayed.seq, first.seq);
    assertEquals(replayed.branch, first.branch);
    assertEquals(read(engine, { id: "entity:receipt" }), {
      value: { receipt: 1 },
    });
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});

Deno.test("replayed localSeq with different content still fails as a replay mismatch", async () => {
  const { engine, path } = await createEngine();

  try {
    applyCommit(engine, {
      sessionId: "session:replay-mismatch",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        preconditions: [{
          kind: "entity-absent",
          id: "entity:receipt",
        }],
        operations: [{
          op: "set",
          id: "entity:receipt",
          value: toEntityDocument({ receipt: 1 }),
        }],
      },
    });

    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session:replay-mismatch",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            preconditions: [{
              kind: "entity-absent",
              id: "entity:receipt",
            }],
            operations: [{
              op: "set",
              id: "entity:receipt",
              value: toEntityDocument({ receipt: 2 }),
            }],
          },
        }),
      ProtocolError,
      "commit replay mismatch",
    );
  } finally {
    close(engine);
    await Deno.remove(path);
  }
});
