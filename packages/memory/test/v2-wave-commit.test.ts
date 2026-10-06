// Server-execution v2 stage D: the engine surface of the wave commit step
// (docs/specs/server-side-execution/serving-loop.md §3b–§3d, protocol.md
// §1/§7). These tests pin:
//
// - the annotation carriage: derived-class commits carry the per-write
//   addressing/attribution pair; the ADDRESSING half keys scoped rows at
//   admission (fail-closed — a scoped write with no explicit scope_key is
//   rejected, never defaulted to the service session), the ATTRIBUTION
//   half is stored, and both are refused on any other class (the closed
//   metadata list);
// - consequenceOf storage, derived-only;
// - applyWaveCommit's per-doc re-verification: heads past the wave basis
//   throw the conflict error NAMING the moved docs (whole-wave CAS
//   failure is forbidden), the wave's already-resolved docs are excluded,
//   and nothing is applied on conflict;
// - the basis-index writer: rows land inside the wave's own transaction,
//   in-wave reads (seq null) share the wave's commit seq, and a later run
//   of the same (action, instance) REPLACES the rows as a set (§3b's
//   overwrite-in-place unit — appending is the evidence log's signature).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  applyWaveCommit,
  close,
  type Engine,
  open,
  ProtocolError,
  selectDocHead,
  selectWritePathsSince,
  WaveCommitConflictError,
  WavePreconditionError,
} from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  replaceSchedulerBasisRows,
  selectSchedulerBasisRows,
} from "../v2/scheduler-basis.ts";
import {
  deleteExecutionOutboxRow,
  selectPendingExecutionOutboxRows,
} from "../v2/execution-outbox.ts";
import {
  type ClientCommit,
  commitPreconditionValueHash,
  decodeMemoryBoundary,
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-wave-test-space";
const SERVICE = `service:${SPACE}`;

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const setCommit = (
  localSeq: number,
  ops: Array<{ id: string; scope?: "user" | "session"; n?: number }>,
): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: ops.map((op) => ({
    op: "set" as const,
    id: op.id,
    ...(op.scope !== undefined ? { scope: op.scope } : {}),
    value: { value: { n: op.n ?? localSeq } },
  })),
});

const commitRow = (
  path: string,
  seq: number,
): { annotations: string | null; consequence_of: string | null } => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(
      `SELECT annotations, consequence_of FROM "commit" WHERE seq = :seq`,
    ).get({ seq }) as {
      annotations: string | null;
      consequence_of: string | null;
    };
  } finally {
    db.close();
  }
};

const revisionScopeKeys = (
  path: string,
  id: string,
): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(
      `SELECT scope_key FROM revision WHERE id = :id ORDER BY seq, op_index`,
    ).all({ id }) as { scope_key: string }[]).map((row) => row.scope_key);
  } finally {
    db.close();
  }
};

const withLiveLease = (engine: Engine): string => {
  const holder = executionLeaseHolder(SERVICE);
  assert(acquireExecutionLease(engine, { space: SPACE, holder }));
  return holder;
};

Deno.test("wave carriage: a derived commit stores annotations and consequenceOf; scoped ops key by the annotated scope_key", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const applied = applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, [
        { id: "of:plain" },
        { id: "of:scoped", scope: "user" },
      ]),
      commitClass: "derived",
      holder,
      annotations: [
        { op: 0, actingUser: "did:key:alice", actingSession: "s-1" },
        {
          op: 1,
          scopeKey: "user:did%3Akey%3Aalice",
          actingUser: "did:key:alice",
        },
      ],
      consequenceOf: ["e1", "e2"],
      waveBasis: { basisSeq: 0, rebasedHeads: [] },
    });
    assertEquals(applied.seq, 1);
    const row = commitRow(path, 1);
    assertEquals(decodeMemoryBoundary(row.annotations!), [
      { op: 0, actingUser: "did:key:alice", actingSession: "s-1" },
      {
        op: 1,
        scopeKey: "user:did%3Akey%3Aalice",
        actingUser: "did:key:alice",
      },
    ]);
    assertEquals(decodeMemoryBoundary(row.consequence_of!), ["e1", "e2"]);
    // The ADDRESSING half was consumed: the scoped row is keyed by the
    // explicit instance, not by anything resolved from the service session.
    assertEquals(revisionScopeKeys(path, "of:scoped"), [
      "user:did%3Akey%3Aalice",
    ]);
    assertEquals(revisionScopeKeys(path, "of:plain"), ["space"]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave admission: a derived commit under a session other than the holder's own service session is refused (protocol.md §2, RULED 2026-08-05)", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // The commit names the RIGHT holder — the lease equality alone would
    // pass — but its producing session is a user session. The
    // derived-envelope defense-in-depth refuses it: the engine-side
    // mapping is `resolveCommitSessionKey(sessionId, principal) ===
    // holder`, i.e. the holder's own service session is the engine
    // session whose key equals the holder identity (mirrors the model's
    // admitDerived envelope comparison).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "user-session-1",
          principal: "did:key:alice",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:doc" }]),
          commitClass: "derived",
          holder,
        }),
      ProtocolError,
      "producing session is not the lease holder's own service session",
    );
    // A principal-less internal session that is not the holder's is
    // refused the same way — the gap this closes is exactly "any honest
    // internal caller naming the right holder".
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:some-other-writer",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:doc" }]),
          commitClass: "derived",
          holder,
        }),
      ProtocolError,
      "producing session is not the lease holder's own service session",
    );
    // The holder's own service session is admitted.
    const applied = applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, [{ id: "of:doc" }]),
      commitClass: "derived",
      holder,
    });
    assertEquals(applied.seq, 1);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: derivedThrough is stored on derived commits and refused on other classes (protocol.md §4, §7)", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const applied = applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, [{ id: "of:doc" }]),
      commitClass: "derived",
      holder,
      derivedThrough: 7,
    });
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT derived_through FROM "commit" WHERE seq = :seq`,
      ).get({ seq: applied.seq }) as { derived_through: number | null };
      assertEquals(row.derived_through, 7);
    } finally {
      db.close();
    }
    // Closed metadata list: derivedThrough is derived-only carriage.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "client-session",
          principal: "did:key:alice",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:other" }]),
          derivedThrough: 9,
        }),
      ProtocolError,
      "derived-commit carriage only",
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("delegated admission: the engine refuses delegated carriage on derived and system classes, and partial carriage on authored (protocol.md §2's delegated row)", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const delegated = {
      actingPrincipal: "did:key:alice",
      actingSession: "sess-1",
      capabilityRef: "cap:grant",
    };
    // Delegated carriage on a DERIVED commit: refused — a derived
    // commit's identity rides its per-write annotations.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, [{ id: "of:delegated-derived" }]),
          commitClass: "derived",
          holder,
          delegated,
        }),
      ProtocolError,
      "server-produced AUTHORED admission only",
    );
    // Delegated carriage on a SYSTEM commit: refused (authored-only).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:direct",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:delegated-system" }]),
          commitClass: "system",
          delegated,
        }),
      ProtocolError,
      "authored-class admission only",
    );
    // Partial carriage (a grant with no actor, an actor with no grant):
    // refused loudly, never defaulted. Since Phase 3's OW15 carve-out
    // the userless arm's refusal names the one declared exception --
    // sessionless-space-scope -- that admits an absent principal; an
    // UNDECLARED userless batch stays refused (the floor negative).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:outbox",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:delegated-partial" }]),
          delegated: {
            actingPrincipal: "",
            capabilityRef: "cap:grant",
          },
        }),
      ProtocolError,
      "admits only under the declared sessionless-space-scope carve-out",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:outbox",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:delegated-partial-2" }]),
          delegated: {
            actingPrincipal: "did:key:alice",
            capabilityRef: "",
          },
        }),
      ProtocolError,
      "partial carriage is refused",
    );
    // Full carriage on authored: admitted; scoped writes key from the
    // CARRIED identity, and the trio is stored on the commit row.
    const applied = applyCommit(engine, {
      sessionId: "server:outbox",
      space: SPACE,
      commit: setCommit(1, [{ id: "of:delegated-scoped", scope: "user" }]),
      delegated,
    });
    assertEquals(
      revisionScopeKeys(path, "of:delegated-scoped"),
      ["user:did%3Akey%3Aalice"],
    );
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT class, acting_principal, acting_session, capability_ref
         FROM "commit" WHERE seq = :seq`,
      ).get({ seq: applied.seq }) as Record<string, string>;
      assertEquals(row.class, "authored");
      assertEquals(row.acting_principal, "did:key:alice");
      assertEquals(row.acting_session, "sess-1");
      assertEquals(row.capability_ref, "cap:grant");
    } finally {
      db.close();
    }
    // A SESSIONLESS delegated batch (no actingSession) carrying a
    // SESSION-scoped op: refused at admission — a sessionless actor has
    // no session instance (scopes.md §5), and falling through would key
    // the row `session:<actingPrincipal>:<delegating envelope session>`,
    // a chimera instance no party ever acted as.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:outbox",
          space: SPACE,
          commit: setCommit(2, [{
            id: "of:delegated-sessionless",
            scope: "session",
          }]),
          delegated: {
            actingPrincipal: "did:key:alice",
            capabilityRef: "cap:grant",
          },
        }),
      ProtocolError,
      "sessionless delegated",
    );
    // The same sessionless carriage with only USER- and space-scoped
    // ops admits: no session component enters those keys, so the
    // absent actingSession is legitimate (a derivation-emitted chain).
    applyCommit(engine, {
      sessionId: "server:outbox",
      space: SPACE,
      commit: setCommit(3, [
        { id: "of:delegated-sessionless-user", scope: "user" },
        { id: "of:delegated-sessionless-space" },
      ]),
      delegated: {
        actingPrincipal: "did:key:alice",
        capabilityRef: "cap:grant",
      },
    });
    assertEquals(
      revisionScopeKeys(path, "of:delegated-sessionless-user"),
      ["user:did%3Akey%3Aalice"],
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: a scoped write with no explicit scope_key is rejected, never defaulted (the silent-empty-instance trap)", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, [{ id: "of:scoped", scope: "user" }]),
          commitClass: "derived",
          holder,
          annotations: [{ op: 0, actingUser: "did:key:alice" }],
        }),
      ProtocolError,
      "no explicit scope_key",
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: an annotated scope_key must match the write's declared scope", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, [{ id: "of:scoped", scope: "session" }]),
          commitClass: "derived",
          holder,
          annotations: [{ op: 0, scopeKey: "user:did%3Akey%3Aalice" }],
        }),
      ProtocolError,
      "does not match",
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: a scope_key annotation targeting a space-scoped write is refused (addressing is one per SCOPED write)", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // protocol.md §1's ADDRESSING is "one per SCOPED write" and §7's
    // closed list sanctions nothing else: an annotation aimed at a
    // space-scoped op must be refused, never silently applied as the
    // row's key (which would re-key a space-visible doc into a scoped
    // instance nothing declared).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, [{ id: "of:plain" }]),
          commitClass: "derived",
          holder,
          annotations: [{ op: 0, scopeKey: "user:did%3Akey%3Aalice" }],
        }),
      ProtocolError,
      "space-scoped",
    );
    // The wave path refuses identically: the annotation must key neither
    // the conflict pre-check nor the write.
    assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(2, [{ id: "of:plain" }]),
          commitClass: "derived",
          holder,
          annotations: [{ op: 0, scopeKey: "user:did%3Akey%3Aalice" }],
          waveBasis: { basisSeq: 0, rebasedHeads: [] },
        }),
      ProtocolError,
      "space-scoped",
    );
    // Nothing was applied under either key.
    assertEquals(revisionScopeKeys(path, "of:plain"), []);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: a non-canonical annotated scope_key is refused at ADMISSION — raw delimiters and malformed escapes never key a row", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const nonCanonical = [
      // Raw ":" in the segment — prefix-shaped, so a prefix-only check
      // admits it, and the segment no longer splits exactly.
      "user:did:key:alice",
      // Raw "/" — descendant composite keys are "/"-delimited, so an
      // admitted "/" corrupts their addressing.
      "user:alice/space",
      // Malformed escapes — percent-decoding downstream would THROW.
      "user:%GG",
      "user:%",
      // Decodable, but not the casing the encoder emits (canon %3A).
      "user:did%3akey%3aalice",
    ];
    let localSeq = 1;
    for (const scopeKey of nonCanonical) {
      assertThrows(
        () =>
          applyCommit(engine, {
            // The holder's OWN service session: stage F's derived-envelope
            // check (producing session must BE the holder) runs before the
            // annotation validation, so the canonical refusal must be
            // probed from an envelope that passes it.
            sessionId: holder,
            space: SPACE,
            commit: setCommit(localSeq++, [{
              id: "of:scoped",
              scope: "user",
            }]),
            commitClass: "derived",
            holder,
            annotations: [{ op: 0, scopeKey }],
          }),
        ProtocolError,
        "not a canonical scope_key",
      );
    }
    // The wave path refuses identically — a refusal, never a phantom
    // conflict.
    assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(localSeq, [{ id: "of:scoped", scope: "user" }]),
          commitClass: "derived",
          holder,
          annotations: [{ op: 0, scopeKey: "user:alice/space" }],
          waveBasis: { basisSeq: 0, rebasedHeads: [] },
        }),
      ProtocolError,
      "not a canonical scope_key",
    );
    // Nothing was applied under ANY key — canonical or corrupt.
    assertEquals(revisionScopeKeys(path, "of:scoped"), []);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave commit: basis-instance keys must be canonical scope keys — a corrupt action or entity instance is refused, and nothing is applied", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // scheduler_basis rows are ADDRESSING: recovery's re-mark scan
    // matches storage rows against these instance values, so a
    // non-canonical key stores a row no canonical key ever matches —
    // a silent liveness hole, refused at the door instead.
    assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:out" }]),
          commitClass: "derived",
          holder,
          waveBasis: { basisSeq: 0, rebasedHeads: [] },
          basisInstances: [{
            action: "action-a",
            actionScopeKey: "user:a/b",
            rows: [{
              entitySpace: SPACE,
              entity: "of:in",
              entityScopeKey: "space",
              seq: 7,
            }],
          }],
        }),
      ProtocolError,
      "not a canonical scope_key",
    );
    assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, [{ id: "of:out" }]),
          commitClass: "derived",
          holder,
          waveBasis: { basisSeq: 0, rebasedHeads: [] },
          basisInstances: [{
            action: "action-a",
            actionScopeKey: "space",
            rows: [{
              entitySpace: SPACE,
              entity: "of:in",
              // A truncated session key — prefix-shaped, one segment short.
              entityScopeKey: "session:x",
              seq: 7,
            }],
          }],
        }),
      ProtocolError,
      "not a canonical scope_key",
    );
    // The refusal rolled back the whole transaction: no commit, no rows.
    assertEquals(revisionScopeKeys(path, "of:out"), []);
    assertEquals(
      selectSchedulerBasisRows(engine, {
        branch: "",
        action: "action-a",
        actionScopeKey: "user:a/b",
      }),
      [],
    );
    assertEquals(
      selectSchedulerBasisRows(engine, {
        branch: "",
        action: "action-a",
        actionScopeKey: "space",
      }),
      [],
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave carriage: annotations and consequenceOf are refused on non-derived classes (closed metadata list)", async () => {
  const { engine } = await createEngine();
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "session-a",
          principal: "user:alice",
          commit: setCommit(1, [{ id: "of:doc" }]),
          annotations: [{ op: 0, actingUser: "did:key:alice" }],
        }),
      ProtocolError,
      "derived-commit carriage",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:direct",
          commit: setCommit(1, [{ id: "of:doc" }]),
          commitClass: "system",
          consequenceOf: ["e1"],
        }),
      ProtocolError,
      "derived-commit carriage",
    );
  } finally {
    close(engine);
  }
});

Deno.test("wave commit: re-verification throws NAMING docs whose head passed the basis, and applies nothing", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // A rival authored commit moves of:x to seq 1 — past a wave whose
    // basis was 0.
    applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: setCommit(1, [{ id: "of:x", n: 99 }]),
    });
    assertEquals(selectDocHead(engine, { id: "of:x", scopeKey: "space" }), 1);
    const error = assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, [{ id: "of:x" }, { id: "of:y" }]),
          commitClass: "derived",
          holder,
          waveBasis: { basisSeq: 0, rebasedHeads: [] },
        }),
      WaveCommitConflictError,
    );
    assertEquals(error.conflictedDocs, ["of:x space"]);
    // Nothing applied: of:y has no head, and the store seq is still the
    // rival's.
    assertEquals(selectDocHead(engine, { id: "of:y", scopeKey: "space" }), 0);
    const db = new Database(path, { readonly: true });
    try {
      assertEquals(
        db.prepare(`SELECT COUNT(*) AS n FROM "commit"`).get(),
        { n: 1 },
      );
    } finally {
      db.close();
    }
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave commit: a rebased doc re-verifies against the exact head its merge decision observed", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: setCommit(1, [{ id: "of:x", n: 99 }]),
    });
    // The wave rebased its write to of:x against head 1: the batch still
    // writes it, and re-verification requires the head to EQUAL 1.
    const applied = applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, [{ id: "of:x" }, { id: "of:y" }]),
      commitClass: "derived",
      holder,
      waveBasis: {
        basisSeq: 0,
        rebasedHeads: [{ doc: "of:x space", head: 1 }],
      },
    });
    assertEquals(applied.seq, 2);
    assertEquals(selectDocHead(engine, { id: "of:y", scopeKey: "space" }), 2);

    // A head that moved PAST the decision invalidates the merge: the
    // same rebased claim against the now-stale head 1 conflicts, named.
    applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: setCommit(2, [{ id: "of:x", n: 100 }]),
    });
    const error = assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(3, [{ id: "of:x" }]),
          commitClass: "derived",
          holder,
          waveBasis: {
            basisSeq: 0,
            rebasedHeads: [{ doc: "of:x space", head: 1 }],
          },
        }),
      WaveCommitConflictError,
    );
    assertEquals(error.conflictedDocs, ["of:x space"]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave commit: precondition failures are named BY INDEX, and nothing is applied", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // of:taken exists, so its entity-absent precondition fails; of:free
    // does not, so its precondition holds.
    applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: setCommit(1, [{ id: "of:taken", n: 1 }]),
    });
    const error = assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: {
            ...setCommit(1, [{ id: "of:out" }]),
            preconditions: [
              { kind: "entity-absent", id: "of:free" },
              { kind: "entity-absent", id: "of:taken" },
            ],
          },
          commitClass: "derived",
          holder,
          waveBasis: { basisSeq: 1, rebasedHeads: [] },
        }),
      WavePreconditionError,
    );
    assertEquals(error.failedPreconditions, [1]);
    assertEquals(selectDocHead(engine, { id: "of:out", scopeKey: "space" }), 0);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave commit: a failed value pin is named BY INDEX, and nothing is applied", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // of:moved changed after its pin was taken; of:still did not.
    applyCommit(engine, {
      sessionId: "rival-session",
      principal: "user:rival",
      commit: setCommit(1, [{ id: "of:still", n: 1 }, {
        id: "of:moved",
        n: 2,
      }]),
    });
    const error = assertThrows(
      () =>
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: {
            ...setCommit(1, [{ id: "of:out" }]),
            preconditions: [
              {
                kind: "entity-value-hash",
                id: "of:still",
                valueHash: commitPreconditionValueHash({ n: 1 }),
              },
              {
                kind: "entity-value-hash",
                id: "of:moved",
                valueHash: commitPreconditionValueHash({ n: 1 }),
              },
            ],
          },
          commitClass: "derived",
          holder,
          waveBasis: { basisSeq: 1, rebasedHeads: [] },
        }),
      WavePreconditionError,
    );
    assertEquals(error.failedPreconditions, [1]);
    assertEquals(selectDocHead(engine, { id: "of:out", scopeKey: "space" }), 0);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave commit: basis rows land in the same transaction; in-wave reads share the wave's commit seq; a later run REPLACES the instance's rows", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const applied = applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, [{ id: "of:out" }]),
      commitClass: "derived",
      holder,
      waveBasis: { basisSeq: 0, rebasedHeads: [] },
      basisInstances: [{
        action: "action-a",
        actionScopeKey: "space",
        rows: [
          {
            entitySpace: SPACE,
            entity: "of:in",
            entityScopeKey: "space",
            seq: 7,
          },
          // An in-wave read: seq null shares the wave's own commit seq.
          {
            entitySpace: SPACE,
            entity: "of:sealed",
            entityScopeKey: "space",
            seq: null,
          },
        ],
      }],
    });
    assertEquals(
      selectSchedulerBasisRows(engine, {
        branch: "",
        action: "action-a",
        actionScopeKey: "space",
      }),
      [
        {
          entitySpace: SPACE,
          entity: "of:in",
          entityScopeKey: "space",
          seq: 7,
        },
        {
          entitySpace: SPACE,
          entity: "of:sealed",
          entityScopeKey: "space",
          seq: applied.seq,
        },
      ],
    );
    // The next run of the same (action, instance) replaces the set —
    // overwrite in place, never append beside (§3b).
    replaceSchedulerBasisRows(engine, {
      branch: "",
      action: "action-a",
      actionScopeKey: "space",
      rows: [{
        entitySpace: SPACE,
        entity: "of:other",
        entityScopeKey: "space",
        seq: 9,
      }],
    });
    assertEquals(
      selectSchedulerBasisRows(engine, {
        branch: "",
        action: "action-a",
        actionScopeKey: "space",
      }),
      [{
        entitySpace: SPACE,
        entity: "of:other",
        entityScopeKey: "space",
        seq: 9,
      }],
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave rebase input: selectWritePathsSince reports whole-doc rewrites as the root path and patches as their pointer paths", async () => {
  const { engine } = await createEngine();
  try {
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, [{ id: "of:doc" }]),
    });
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:doc",
          patches: [{ op: "replace", path: "/value/a", value: 1 }],
        }],
      },
    });
    assertEquals(
      selectWritePathsSince(engine, {
        id: "of:doc",
        scopeKey: "space",
        sinceSeq: 0,
      }),
      [[], ["value", "a"]],
    );
    assertEquals(
      selectWritePathsSince(engine, {
        id: "of:doc",
        scopeKey: "space",
        sinceSeq: 1,
      }),
      [["value", "a"]],
    );
  } finally {
    close(engine);
  }
});

Deno.test("delegated carriage: a sessionless delegated batch carrying a session-scoped SQLITE op is refused at admission (scopes.md §5 — the entity-write refusal's sqlite twin)", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:outbox",
          space: SPACE,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "sqlite",
              db: {
                id: "of:notes-db",
                scope: "session",
                tables: { notes: { columns: { body: "TEXT" } } },
              },
              sql: "INSERT INTO notes (body) VALUES ('x')",
            }],
          },
          delegated: {
            actingPrincipal: "did:key:alice",
            capabilityRef: "cap:grant",
          },
        }),
      ProtocolError,
      "sessionless delegated",
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("wave replay does not re-insert durable outbox rows: the stored result returns with replayed=true and FP1 carriage is skipped (stage-G round-2 thread 5)", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const options = {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, [{ id: "of:replay-appends" }]),
      commitClass: "derived" as const,
      holder,
      annotations: [],
      consequenceOf: [],
      waveBasis: { basisSeq: 0, rebasedHeads: [] },
      outboxAppends: [{
        targetSpace: "did:key:z6Mk-wave-test-target",
        targetStream: "of:replay-stream",
        eventId: "evt-replay-1",
        payload: { n: 1 },
        actingPrincipal: "did:key:alice",
        actingSession: "sess-1",
        capabilityRef: "cap:replay",
      }],
    };
    const applied = applyWaveCommit(engine, options);
    assertEquals(applied.seq, 1);
    assertEquals(applied.replayed, undefined);
    assertEquals(
      selectPendingExecutionOutboxRows(engine, { branch: "" }).length,
      1,
    );

    // Simulate the delivered-and-retired window: the drain delivered the
    // row and deleted it BEFORE the replay arrives (crash between the
    // sink's commit and its caller's ack, then a re-drive of the same
    // wave with the same localSeq).
    const [row] = selectPendingExecutionOutboxRows(engine, { branch: "" });
    deleteExecutionOutboxRow(engine, row.rowId);
    assertEquals(
      selectPendingExecutionOutboxRows(engine, { branch: "" }).length,
      0,
    );

    // The exact replay: same session, same localSeq, same commit — with
    // a re-derived basis (a crash-replay re-runs the wave against
    // CURRENT state, so its basisSeq is fresh; the stored original the
    // replay matches on is the COMMIT, which carries no basis). The
    // stored result returns — and the outbox insert must NOT re-run
    // (pre-fix it did, resurrecting the delivered row as duplicate
    // delivery work).
    const replayed = applyWaveCommit(engine, {
      ...options,
      waveBasis: { basisSeq: applied.seq, rebasedHeads: [] },
    });
    assertEquals(replayed.seq, 1);
    assertEquals(replayed.replayed, true);
    assertEquals(
      selectPendingExecutionOutboxRows(engine, { branch: "" }).length,
      0,
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});
