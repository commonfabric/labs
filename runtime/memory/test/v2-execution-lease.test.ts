// Server-execution v2: the single-deriver lease
// (docs/specs/server-side-execution/serving-loop.md §2), held in the memory
// server's memory, and the derived-class admission equality check
// (protocol.md §2's `derived` row). These tests are the implementation-side
// mirror of the executable spec model's C6/C7 properties
// (base/spec-model/server-execution/): admission is ONE equality check against
// the map, the holder is a per-start identity so the equality check itself
// fences succession between serving workers (DR1), and the same-process residue
// is closed by the in-process abort-before-reacquire discipline. Nothing about
// the lease is stored, so a restarted process waits for nobody.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  close,
  type Engine,
  open,
  ProtocolError,
} from "../v2/engine.ts";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
  processInstanceId,
} from "../v2/execution-lease.ts";
import {
  type ClientCommit,
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "../v2.ts";

const SPACE = "did:key:space-a";
const SERVICE = "did:key:service";

const createEngine = async (): Promise<{
  engine: Engine;
  path: string;
}> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const setCommit = (localSeq: number, id: string): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{ op: "set", id, value: { value: { n: localSeq } } }],
});

/** Reads every row of the stored table, which nothing writes any more. */
const storedLeaseRows = (engine: Engine): { space: string; holder: string }[] =>
  engine.database.prepare(
    `SELECT space, holder FROM execution_lease ORDER BY space`,
  ).all() as { space: string; holder: string }[];

const commitRows = (
  engine: Engine,
): { seq: number; class: string; holder: string | null }[] =>
  engine.database.prepare(
    `SELECT seq, class, holder FROM "commit" ORDER BY seq`,
  ).all() as { seq: number; class: string; holder: string | null }[];

/** Models the process that held the lease before this one: a row it left. */
const leaveStoredRow = (engine: Engine, holder: string): void => {
  engine.database.prepare(
    `INSERT INTO execution_lease (space, holder, expires_at)
     VALUES (:space, :holder, :expires_at)`,
  ).run({ space: SPACE, holder, expires_at: Date.now() + 3_600_000 });
};

Deno.test("execution_lease: the stored table stays in the schema, and acquiring and releasing leave it empty", async () => {
  const { engine } = await createEngine();
  try {
    const columns = engine.database.prepare(
      `PRAGMA table_info("execution_lease")`,
    ).all() as { name: string }[];
    assertEquals(columns.map((c) => c.name), ["space", "holder", "expires_at"]);

    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    assertEquals(storedLeaseRows(engine), []);
    engine.executionLeases.release(SPACE, holder);
    assertEquals(storedLeaseRows(engine), []);
    assertEquals(commitRows(engine), []);
  } finally {
    close(engine);
  }
});

Deno.test("execution_lease: a pre-stage-B store gains the table on reopen", async () => {
  const { engine, path } = await createEngine();
  close(engine);

  // Rebuild the pre-stage-B shape: drop the table so the store looks like
  // one written before this migration existed.
  {
    const db = new Database(path);
    try {
      db.exec(`DROP TABLE execution_lease`);
      db.exec(`ALTER TABLE "commit" DROP COLUMN holder`);
    } finally {
      db.close();
    }
  }

  const reopened = await open({ url: toFileUrl(path) });
  try {
    assertEquals(storedLeaseRows(reopened), []);
    // The commit `holder` column migrated back too (protocol.md §7 metadata).
    assertEquals(commitRows(reopened), []);
  } finally {
    close(reopened);
  }
});

Deno.test("restart: a new process's map starts empty, so a row or an in-memory holder of an earlier process delays nobody", async () => {
  const { engine, path } = await createEngine();
  const successor = await open({ url: toFileUrl(path) });
  setServerExecutionConfig(true);
  try {
    const earlier = executionLeaseHolder(SERVICE, "earlier-process");
    assert(engine.executionLeases.acquire(SPACE, earlier));
    leaveStoredRow(engine, earlier);

    const holder = executionLeaseHolder(SERVICE, "restarted-process");
    assertEquals(successor.executionLeases.holderOf(SPACE), undefined);
    assert(successor.executionLeases.acquire(SPACE, holder));
    applyCommit(successor, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });
    assertEquals(commitRows(successor), [{ seq: 1, class: "derived", holder }]);
  } finally {
    resetServerExecutionConfig();
    close(successor);
    close(engine);
  }
});

Deno.test("holder identity: service identity + process-instance component, stable within the process (DR1)", () => {
  const holder = executionLeaseHolder(SERVICE);
  // Stable across every mint within one process lifetime: the process
  // component is minted once at process start.
  assertEquals(holder, executionLeaseHolder(SERVICE));
  assertEquals(holder, `${SERVICE}#${processInstanceId}`);
  // Fresh for a genuinely-new process: a different process component yields
  // a different holder — which is what makes the admission equality check
  // fence cross-process succession for free.
  const successor = executionLeaseHolder(SERVICE, "successor-process");
  assert(holder !== successor);
});

Deno.test("acquire: takes a free space and keeps one's own, and leaves another holder's lease alone", async () => {
  const { engine } = await createEngine();
  try {
    const mine = executionLeaseHolder(SERVICE);
    const other = executionLeaseHolder(SERVICE, "other-process");

    // Free: taken.
    assert(engine.executionLeases.acquire(SPACE, mine));
    assertEquals(engine.executionLeases.holderOf(SPACE), mine);

    // Held by another: refused, holder untouched.
    assert(!engine.executionLeases.acquire(SPACE, other));
    assertEquals(engine.executionLeases.holderOf(SPACE), mine);

    // Our own: kept.
    assert(engine.executionLeases.acquire(SPACE, mine));
    assertEquals(engine.executionLeases.holderOf(SPACE), mine);
  } finally {
    close(engine);
  }
});

Deno.test("release: frees the caller's own lease and leaves a foreign one alone", async () => {
  const { engine } = await createEngine();
  try {
    const mine = executionLeaseHolder(SERVICE);
    const other = executionLeaseHolder(SERVICE, "other-process");
    assert(engine.executionLeases.acquire(SPACE, mine));

    engine.executionLeases.release(SPACE, other);
    assertEquals(engine.executionLeases.holderOf(SPACE), mine);

    engine.executionLeases.release(SPACE, mine);
    assertEquals(engine.executionLeases.holderOf(SPACE), undefined);
  } finally {
    close(engine);
  }
});

Deno.test("releaseAllOf: frees every lease of one holder, counts them, and leaves other holders' alone", async () => {
  const { engine } = await createEngine();
  try {
    const mine = executionLeaseHolder(SERVICE);
    const other = executionLeaseHolder(SERVICE, "other-process");
    assert(engine.executionLeases.acquire("did:key:space-a", mine));
    assert(engine.executionLeases.acquire("did:key:space-b", mine));
    assert(engine.executionLeases.acquire("did:key:space-c", other));

    assertEquals(engine.executionLeases.releaseAllOf(mine), 2);

    assertEquals(engine.executionLeases.holderOf("did:key:space-a"), undefined);
    assertEquals(engine.executionLeases.holderOf("did:key:space-b"), undefined);
    assertEquals(engine.executionLeases.holderOf("did:key:space-c"), other);
    assertEquals(engine.executionLeases.releaseAllOf(mine), 0);
  } finally {
    close(engine);
  }
});

Deno.test("admission: off the flag, `derived` stays unclaimable even under a live matching lease", async () => {
  const { engine } = await createEngine();
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, "of:doc-1"),
          commitClass: "derived",
          holder,
        }),
      ProtocolError,
      "EXPERIMENTAL_SERVER_EXECUTION",
    );
    assertEquals(commitRows(engine), []);
  } finally {
    close(engine);
  }
});

Deno.test("admission: under the flag, the live holder's derived commit is admitted and carries class + holder", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });
    assertEquals(commitRows(engine), [
      { seq: 1, class: "derived", holder },
    ]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("admission: the one equality check rejects non-holders, missing holders, and missing spaces", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));

    const attempt = (options: { holder?: string; space?: string }) =>
      assertThrows(
        () =>
          applyCommit(engine, {
            sessionId: "server:executor",
            space: options.space,
            commit: setCommit(1, "of:doc-1"),
            commitClass: "derived",
            holder: options.holder,
          }),
        ProtocolError,
        "execution lease",
      );

    // A different holder — the model's forged/foreign probe (C6).
    attempt({
      space: SPACE,
      holder: executionLeaseHolder(SERVICE, "other-process"),
    });
    // No holder at all.
    attempt({ space: SPACE });
    // No space to look a lease up under.
    attempt({ holder });
    assertEquals(commitRows(engine), []);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("admission: a released lease matches NOBODY, its last holder included", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    engine.executionLeases.release(SPACE, holder);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, "of:doc-1"),
          commitClass: "derived",
          holder,
        }),
      ProtocolError,
      "execution lease",
    );
    assertEquals(commitRows(engine), []);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("admission: a stored row names nobody, its holder included", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    leaveStoredRow(engine, holder);
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, "of:doc-1"),
          commitClass: "derived",
          holder,
        }),
      ProtocolError,
      "execution lease",
    );
    assertEquals(commitRows(engine), []);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("admission: authored and system commits ignore the lease, and a stray holder never sticks to them", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    // No lease exists; both non-derived classes admit exactly as before.
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "authored",
      // A stray holder on a non-derived class is ignored, not persisted:
      // protocol.md §7 scopes the metadata to derived commits only.
      holder: executionLeaseHolder(SERVICE),
    });
    applyCommit(engine, {
      sessionId: "server:direct",
      commit: setCommit(1, "of:doc-2"),
      commitClass: "system",
    });
    assertEquals(commitRows(engine), [
      { seq: 1, class: "authored", holder: null },
      { seq: 2, class: "system", holder: null },
    ]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("admission: a holder smuggled into the client payload is inert", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    // The wire cannot express a holder: `ClientCommit` has no such field,
    // and admission reads it only from the server-internal options — the
    // same server-determination rule as the class itself (protocol.md §1).
    const smuggled = {
      ...setCommit(1, "of:doc-1"),
      holder: executionLeaseHolder(SERVICE),
      commitClass: "derived",
    } as unknown as ClientCommit;
    applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:mallory",
      commit: smuggled,
      commitClass: "authored",
    });
    assertEquals(commitRows(engine), [
      { seq: 1, class: "authored", holder: null },
    ]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

//
// The C7 pair, against the real engine. The model's `sealProbe` /
// `deliverProbe` steps become: capture the cycle's tenure when work seals,
// and gate the commit on `isCurrentTenure` at delivery time — the in-process
// discipline a SpaceServer's commit step will implement (serving-loop.md §2's
// stop-committing MUST, enforced before any reacquire).
//

Deno.test("discipline (C7a): a probe sealed before a release never commits — the release ends the tenure before any reacquire", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const cycle = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space: SPACE,
      holder: executionLeaseHolder(SERVICE),
    });

    assert(await cycle.acquire());
    const sealedTenure = cycle.tenure; // work seals under the first tenure

    // A park releases the lease: the tenure ends HERE, before any reacquire
    // is possible — "stop committing immediately".
    await cycle.release();
    assert(!cycle.held);
    assert(!cycle.isCurrentTenure(sealedTenure));

    // Same process re-acquires: same holder (DR1 — the process component is
    // stable within a process lifetime), NEW tenure.
    assert(await cycle.acquire());
    assert(cycle.held);
    assertEquals(cycle.holder, executionLeaseHolder(SERVICE));
    assert(cycle.tenure !== sealedTenure);

    // Delivery of the stale probe: the discipline aborts it in-process.
    if (cycle.isCurrentTenure(sealedTenure)) {
      applyCommit(engine, {
        sessionId: cycle.holder,
        space: SPACE,
        commit: setCommit(1, "of:doc-1"),
        commitClass: "derived",
        holder: cycle.holder,
      });
    }
    assertEquals(commitRows(engine), []);

    // And work sealed under the CURRENT tenure commits fine — the fence is
    // not vacuous (C7a's "live probes still flow").
    if (cycle.isCurrentTenure(cycle.tenure)) {
      applyCommit(engine, {
        sessionId: cycle.holder,
        space: SPACE,
        commit: setCommit(1, "of:doc-1"),
        commitClass: "derived",
        holder: cycle.holder,
      });
    }
    assertEquals(commitRows(engine).map((r) => r.class), ["derived"]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("discipline (C7b): without the in-process check the same-process stale probe WOULD be admitted — the residue the MUST exists for", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const cycle = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space: SPACE,
      holder: executionLeaseHolder(SERVICE),
    });
    assert(await cycle.acquire());
    await cycle.release();
    assert(await cycle.acquire()); // same holder, new tenure, held again

    // Deliver the earlier tenure's probe WITHOUT consulting the discipline: the
    // admission equality check alone cannot tell the tenures apart, because
    // the holder value is identical by design (DR1). This admission is the
    // reachable stale-admission of the model's C7b — the reason the
    // abort-before-reacquire MUST is load-bearing, and why it is an
    // in-process obligation rather than wire machinery.
    applyCommit(engine, {
      sessionId: cycle.holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder: cycle.holder,
    });
    assertEquals(commitRows(engine).map((r) => r.class), ["derived"]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

//
// Idempotent replay vs. the lease (owner review on #5349, 2026-08-12): a
// byte-identical retry of an ALREADY-ACCEPTED derived commit — same
// session, same localSeq, same class + holder envelope — answers from the
// store, never from current authority. The lease equality check admits NEW
// derived commits; a network retry of an accepted one must return the
// stored seq even after the producing lease was released or succeeded by a
// new holder. Fresh (new-localSeq) derived commits keep the
// full admission check in every one of those states, and a same-key
// resubmission that differs — in bytes OR in its class/holder envelope —
// is still refused as a replay mismatch. The mints below commit with
// `sessionId === holder` (no principal): stage F's envelope-session rule
// (protocol.md §2, RULED 2026-08-05) admits a fresh derived commit only
// from the lease holder's own service session.
//

Deno.test("replay: a byte-identical retry answers from the store after the lease is RELEASED — fresh commits stay rejected", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    const first = applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });

    engine.executionLeases.release(SPACE, holder);

    // The reviewer's repro: the retry of the accepted commit must not be
    // re-admitted against the (now absent) lease.
    const replay = applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });
    assertEquals(replay.seq, first.seq);
    assertEquals(replay.branch, first.branch);
    // The stored answer carries the same revisions (the replay result is
    // reconstructed from the store, so compare the load-bearing fields —
    // the stored shape has always normalized e.g. the defaulted scope).
    assertEquals(
      replay.revisions.map(({ id, seq, opIndex, op }) => ({
        id,
        seq,
        opIndex,
        op,
      })),
      first.revisions.map(({ id, seq, opIndex, op }) => ({
        id,
        seq,
        opIndex,
        op,
      })),
    );
    // Answered from the store: no second row was inserted.
    assertEquals(commitRows(engine), [
      { seq: first.seq, class: "derived", holder },
    ]);

    // A FRESH derived commit (new localSeq) still needs the lease.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(2, "of:doc-2"),
          commitClass: "derived",
          holder,
        }),
      ProtocolError,
      "execution lease",
    );
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("replay: after SUCCESSION the old holder's accepted commit still replays from the store — its fresh commits do not, the successor's do", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    // p0 holds the lease and lands a derived commit.
    const p0 = executionLeaseHolder(SERVICE, "process-0");
    assert(engine.executionLeases.acquire(SPACE, p0));
    const first = applyCommit(engine, {
      sessionId: p0,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder: p0,
    });

    // p0 is replaced; p1 succeeds it (DR1: fresh process component).
    engine.executionLeases.release(SPACE, p0);
    const p1 = executionLeaseHolder(SERVICE, "process-1");
    assert(engine.executionLeases.acquire(SPACE, p1));

    // The byte-identical retry of p0's ACCEPTED commit answers from the
    // store — the successor owning the lease is irrelevant to it.
    const replay = applyCommit(engine, {
      sessionId: p0,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder: p0,
    });
    assertEquals(replay.seq, first.seq);

    // p0's FRESH derived commit is fenced by the equality check, exactly
    // as before the reorder.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: p0,
          space: SPACE,
          commit: setCommit(2, "of:doc-2"),
          commitClass: "derived",
          holder: p0,
        }),
      ProtocolError,
      "execution lease",
    );

    // …and the successor's fresh derived commit is admitted.
    applyCommit(engine, {
      sessionId: p1,
      space: SPACE,
      commit: setCommit(2, "of:doc-2"),
      commitClass: "derived",
      holder: p1,
    });
    assertEquals(commitRows(engine), [
      { seq: first.seq, class: "derived", holder: p0 },
      { seq: first.seq + 1, class: "derived", holder: p1 },
    ]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("replay: a same-key DIFFERENT-bytes resubmission is refused as a replay mismatch, not answered", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });
    engine.executionLeases.release(SPACE, holder);

    // Same session + localSeq, different payload bytes: the existing
    // replay-mismatch semantics apply ahead of any admission answer.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, "of:doc-CHANGED"),
          commitClass: "derived",
          holder,
        }),
      ProtocolError,
      "commit replay mismatch",
    );
    assertEquals(commitRows(engine).length, 1);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("replay: the stored class + holder are part of the replay identity — a same-bytes resubmission under a different envelope is refused", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });
    engine.executionLeases.release(SPACE, holder);

    // Same key + bytes, but claimed by a DIFFERENT holder: not the stored
    // submission — refused, never answered with the stored seq.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, "of:doc-1"),
          commitClass: "derived",
          holder: executionLeaseHolder(SERVICE, "other-process"),
        }),
      ProtocolError,
      "commit replay mismatch",
    );

    // Same key + bytes under a different CLASS: also not the stored
    // submission (the class is admission-path identity, protocol.md §1).
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commit: setCommit(1, "of:doc-1"),
          commitClass: "system",
        }),
      ProtocolError,
      "commit replay mismatch",
    );
    assertEquals(commitRows(engine).length, 1);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("replay: authored replays are untouched — a stray holder stays inert on both the original and the retry", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    // Original authored commit with a stray holder (persisted as NULL —
    // see "a stray holder never sticks" above).
    const first = applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "authored",
      holder: executionLeaseHolder(SERVICE),
    });
    // Retry without the stray holder: same stored submission, stored seq.
    const bare = applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "authored",
    });
    assertEquals(bare.seq, first.seq);
    // Retry with a (different) stray holder: still inert, still a replay.
    const stray = applyCommit(engine, {
      sessionId: "session-a",
      principal: "user:alice",
      commit: setCommit(1, "of:doc-1"),
      commitClass: "authored",
      holder: executionLeaseHolder(SERVICE, "other-process"),
    });
    assertEquals(stray.seq, first.seq);
    assertEquals(commitRows(engine), [
      { seq: first.seq, class: "authored", holder: null },
    ]);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("replay: a retry while the lease is STILL HELD keeps answering from the store", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = executionLeaseHolder(SERVICE);
    assert(engine.executionLeases.acquire(SPACE, holder));
    const first = applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });
    const replay = applyCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commit: setCommit(1, "of:doc-1"),
      commitClass: "derived",
      holder,
    });
    assertEquals(replay.seq, first.seq);
    assertEquals(commitRows(engine).length, 1);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});

Deno.test("discipline (C7b): cross-process succession is fenced by the equality check alone — no discipline needed", async () => {
  const { engine } = await createEngine();
  setServerExecutionConfig(true);
  try {
    // Process p0 holds the lease and seals a probe.
    const p0 = executionLeaseHolder(SERVICE, "process-0");
    assert(engine.executionLeases.acquire(SPACE, p0));
    // …and then it is replaced.
    engine.executionLeases.release(SPACE, p0);

    // A genuinely-new process succeeds it: fresh process component (DR1).
    const p1 = executionLeaseHolder(SERVICE, "process-1");
    assert(engine.executionLeases.acquire(SPACE, p1));

    // p0's in-flight probe arrives at the store's door: the ONE equality
    // check rejects it, because p0's holder can never equal p1's.
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server:executor",
          space: SPACE,
          commit: setCommit(1, "of:doc-1"),
          commitClass: "derived",
          holder: p0,
        }),
      ProtocolError,
      "execution lease",
    );
    assertEquals(commitRows(engine), []);
  } finally {
    resetServerExecutionConfig();
    close(engine);
  }
});
