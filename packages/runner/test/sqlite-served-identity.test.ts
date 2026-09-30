// OW53 (verification-coverage.md §3): the sqlite builtins' identity
// consumptions under SERVED execution. On a serving runtime the ambient
// trust-snapshot provider names the SERVICE, while the run's acting
// principal arrives WITH the work — the stamped wave-run context
// (serving-loop.md §3c: "never the serving runtime's ambient identity";
// protocol.md §1: identity is "carried into keys, not resolved from
// ambient state"). These pins drive the raw builtins with hand-stamped
// transactions — the exact context shape the serving loop's stamper
// attaches (space-server.ts `#stampRun`) — on a runtime whose ambient
// identity plays the service, so every ambient-vs-run divergence is
// observable in one realm. Composed true-ON coverage lives in
// packages/patterns/integration/sqlite-db-owner-multi-runtime.test.ts and
// sqlite-read-clearance-multi-runtime.test.ts.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { match, principal } from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { servedCommitDestination } from "./support/served-commits.ts";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  sqliteDatabase,
  sqliteQuery,
  sqliteRunActingPrincipal,
} from "../src/builtins/sqlite-builtins.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../src/executor/wave.ts";

const serviceSigner = await Identity.fromPassphrase("ow53 service");
const aliceSigner = await Identity.fromPassphrase("ow53 alice");
const bobSigner = await Identity.fromPassphrase("ow53 bob");
const space = serviceSigner.did();

/** The stamp a demanded derivation run carries on the serving runtime
 * (observed shape: `scopeKeyIdentity` present, `acting` settled later
 * from the discovered scope — so `attributionFromScope` is set and the
 * context carries NO eager `acting`). */
const demandedStamp = (
  tx: IExtendedStorageTransaction,
  principalDid: string,
  sessionId: string,
) =>
  stampWaveRunContext(tx, {
    actionId: "test:ow53",
    kind: "derivation",
    scopeKeyIdentity: { principal: principalDid, sessionId },
    attributionFromScope: true,
  });

interface QueryState {
  pending?: boolean;
  result?: unknown[];
  error?: unknown;
  requestHash?: string;
  withheld?: number;
}

describe("sqlite-served-identity", () => {
  let storageManager: EmulatedStorageManager;
  let server: ReturnType<typeof newLoopbackServer>;
  let lease: ExecutionLeaseCycle;
  let runtime: Runtime;

  beforeEach(async () => {
    // The ambient identity is the SERVICE (the serving runtime's default
    // provider is bound to `storageManager.as` — runtime.ts). The flag is
    // ON: the per-instance scoped-read row these pins read through is
    // claimable only under EXPERIMENTAL_SERVER_EXECUTION (protocol.md §2).
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    lease = new ExecutionLeaseCycle({
      engine: await server.engineForSpace(space),
      space,
      holder: executionLeaseHolder(serviceSigner.did()),
    });
    expect(lease.acquire()).toBe(true);
    storageManager = EmulatedStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager?.close();
    lease.release();
    await server.close();
  });

  /** Drive the raw sqliteDatabase builtin once on `tx` (creation run) and
   * return the committed handle value. */
  const driveMint = async (
    rt: Runtime,
    tx: IExtendedStorageTransaction,
  ): Promise<SqliteDbRef & { owner?: string }> => {
    const parent = rt.getCell(
      space,
      `ow53 mint parent ${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    const inputs = rt.getImmutableCell(
      space,
      {
        tables: {
          notes: table({ id: "integer primary key", body: "text" }),
        },
      },
      undefined,
      tx,
    );
    let handle: Cell<SqliteDbRef> | undefined;
    const builtin = sqliteDatabase(
      inputs as never,
      (_rtx, result) => {
        handle = result as Cell<SqliteDbRef>;
      },
      () => {},
      [parent],
      parent,
      rt,
    );
    builtin.action(tx);
    expect((await tx.commit()).error).toBeUndefined();
    return handle!.get() as SqliteDbRef & { owner?: string };
  };

  it("mints the stamped run's carried principal as the db owner on a served creation, never the runtime's ambient identity", async () => {
    const tx = runtime.edit();
    demandedStamp(tx, aliceSigner.did(), "sess-alice");
    const handle = await driveMint(runtime, tx);
    // The creating run acts as alice (the demand-supplied principal); the
    // ambient provider names the service. dbOwner() semantics
    // (docs/specs/sqlite-builtin/06-cfc.md: "the principal that created
    // the SqliteDb cell") + serving-loop.md §3c pick the RUN's principal.
    expect(handle.owner).toBe(aliceSigner.did());
  });

  it("initializes each demanded session through the same database factory", async () => {
    const setup = runtime.edit();
    const parent = runtime.getCell(space, "session factory", undefined, setup);
    parent.set({});
    const inputs = runtime.getImmutableCell(
      space,
      { tables: {} },
      undefined,
      setup,
    );
    expect((await setup.commit()).error).toBeUndefined();
    const handles: SqliteDbRef[] = [];
    const builtin = sqliteDatabase(
      inputs,
      (tx, handle) =>
        handles.push({ ...(handle as Cell<SqliteDbRef>).withTx(tx).get() }),
      () => {},
      [parent],
      parent,
      runtime,
      { ...parent.getAsNormalizedFullLink(), scope: "session" },
    );
    runtime.installSealDestination(
      servedCommitDestination(
        runtime,
        space,
        await server.engineForSpace(space),
        lease,
      ),
    );
    for (const session of ["first", "second", "first"]) {
      const tx = runtime.edit();
      demandedStamp(tx, serviceSigner.did(), session);
      builtin.action(tx);
      expect((await tx.commit()).error).toBeUndefined();
    }
    expect(handles).toHaveLength(2);
    expect(handles[0].id).toBe(handles[1].id);
    expect(handles.map((handle) => handle.scope)).toEqual([
      "session",
      "session",
    ]);
    expect(handles.map((handle) => handle.owner)).toEqual([
      serviceSigner.did(),
      serviceSigner.did(),
    ]);
  });

  it("mints no owner on a served creation whose run carries no acting principal (fail closed, ownerless handle)", async () => {
    const tx = runtime.edit();
    // An actor-less served run (wave-fallback shape): stamped, but the
    // context carries no identity. Minting the SERVICE as owner would
    // grant it dbOwner() row admission nothing sanctioned; an ownerless
    // handle fails closed downstream (dbOwner() refuses to resolve).
    stampWaveRunContext(tx, { actionId: "test:ow53", kind: "derivation" });
    const handle = await driveMint(runtime, tx);
    expect(handle.owner).toBeUndefined();
  });

  it("fails loud when a stamped context carries a divergent acting/demanded pair (the undecided-identity tripwire)", () => {
    // No context the stamper produces today can diverge (`acting` is
    // derived FROM the demanded pair where both exist). If a future
    // carriage ever splits them, the helper must surface the undecided
    // identity-model question instead of silently picking whose rows a
    // cleared read admits (flag, don't fill — see the helper's comment).
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "test:ow53-diverge",
      kind: "derivation",
      acting: { user: aliceSigner.did() },
      scopeKeyIdentity: { principal: bobSigner.did(), sessionId: "sess-x" },
    });
    expect(() => sqliteRunActingPrincipal(runtime, tx)).toThrow(/diverge/);
    tx.abort();
  });

  it("keeps the ambient provider as the owner source on an unstamped creation (client neutrality)", async () => {
    // A client runtime: the ambient identity IS the acting user, and a
    // client's runs are never wave-stamped (ON-arm speculation and the
    // whole OFF arm alike — the OFF mint path is additionally pinned by
    // sqlite-db-owner.test.ts).
    const clientManager = EmulatedStorageManager.emulate({ as: aliceSigner });
    const client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    try {
      const tx = client.edit();
      const handle = await driveMint(client, tx);
      expect(handle.owner).toBe(aliceSigner.did());
    } finally {
      await client.idle();
      await client.dispose();
      await clientManager.close();
    }
  });

  it("replays handle materialization when the first transaction does not commit", async () => {
    const first = runtime.edit();
    const parent = runtime.getCell(
      space,
      `ow53 retry parent ${crypto.randomUUID()}`,
      undefined,
      first,
    );
    const inputs = runtime.getImmutableCell(
      space,
      {
        tables: {
          notes: table({ id: "integer primary key", body: "text" }),
        },
      },
      undefined,
      first,
    );
    let handle: Cell<SqliteDbRef> | undefined;
    let publications = 0;
    const builtin = sqliteDatabase(
      inputs as never,
      (_tx, result) => {
        handle = result as Cell<SqliteDbRef>;
        publications++;
      },
      () => {},
      [parent],
      parent,
      runtime,
    );

    builtin.action(first);
    expect(handle!.withTx(first).get()).toBeDefined();
    first.abort(new Error("reject the first scheduler attempt"));

    const retry = runtime.edit();
    builtin.action(retry);
    expect(handle!.withTx(retry).get()).toBeDefined();
    expect((await retry.commit()).error).toBeUndefined();

    expect(handle!.get()).toBeDefined();
    expect(publications).toBe(2);
  });

  it("replays handle materialization when a successful seal is withdrawn", async () => {
    const setup = runtime.edit();
    const parent = runtime.getCell(
      space,
      `ow53 wave retry parent ${crypto.randomUUID()}`,
      undefined,
      setup,
    );
    parent.withTx(setup).set({});
    const inputs = runtime.getImmutableCell(
      space,
      {
        tables: {
          notes: table({ id: "integer primary key", body: "text" }),
        },
      },
      undefined,
      setup,
    );
    expect((await setup.commit()).error).toBeUndefined();

    // This test abandons rather than commits the wave, so the basis sequence
    // is not consulted.
    const wave = new WaveAccumulator({
      space,
      basisSeq: 0,
      scopeKeyIdentity: {
        principal: serviceSigner.did(),
        sessionId: "ow53-wave-retry",
      },
      replicaFor: (target) => storageManager.open(target).replica,
    });
    runtime.installSealDestination(wave);

    let handle: Cell<SqliteDbRef> | undefined;
    let publications = 0;
    const builtin = sqliteDatabase(
      inputs as never,
      (_tx, result) => {
        handle = result as Cell<SqliteDbRef>;
        publications++;
      },
      () => {},
      [parent],
      parent,
      runtime,
    );

    let settlement: ReturnType<typeof waveSettlementOf>;
    try {
      const first = runtime.edit();
      stampWaveRunContext(first, {
        actionId: "sqlite-database-withdrawal",
        kind: "derivation",
      });
      builtin.action(first);
      expect((await first.commit()).error).toBeUndefined();
      settlement = waveSettlementOf(first);
      expect(settlement).toBeDefined();
    } finally {
      runtime.clearSealDestination();
      wave.abandon("test withdrawal");
      await wave.settled();
    }

    expect((await settlement!).error).toBeDefined();
    expect(handle!.get()).toBeUndefined();

    const retry = runtime.edit();
    builtin.action(retry);
    expect(handle!.withTx(retry).get()).toBeDefined();
    expect((await retry.commit()).error).toBeUndefined();
    expect(handle!.get()).toBeDefined();
    expect(publications).toBe(2);
  });

  // The cleared-read half (CFC Phase 3.b under served execution)

  const KEY = /z[1-9A-HJ-NP-Za-km-z]+/g;

  /** A rule-bearing, clearance-permitted table whose rows each name their
   * intended reader (the integration fixture's shape). */
  const clearedTables = () => ({
    notes: table(
      { id: "integer primary key", reader: "text", body: "text" },
      (f) => ({
        confidentiality: principal("key", match(f.reader, KEY, { min: 1 })),
      }),
      { allowReadClearance: true },
    ),
  });

  /** Seed rows for both readers and return a query builtin over the db,
   * plus the result cell captured from its first run. `dbScope` narrows
   * the db (and so the cleared result, via `narrowestScope`) below the
   * clearance-forced `user` floor. */
  const clearedQuerySetup = async (dbScope?: "session") => {
    const db = {
      id: `of:ow53-${crypto.randomUUID()}`,
      tables: clearedTables(),
      ...(dbScope !== undefined && { scope: dbScope }),
    } as unknown as SqliteDbRef;
    const seedTx = runtime.edit();
    seedTx.recordSqliteWrite!(space, {
      op: "sqlite",
      db: db as never,
      sql: "INSERT INTO notes (reader, body) VALUES (?, ?), (?, ?), (?, ?)",
      params: [
        aliceSigner.did(),
        "alice-1",
        aliceSigner.did(),
        "alice-2",
        bobSigner.did(),
        "bob-only",
      ],
    });
    expect((await seedTx.commit()).error).toBeUndefined();

    const setupTx = runtime.edit();
    const parent = runtime.getCell(
      space,
      `ow53 query parent ${crypto.randomUUID()}`,
      undefined,
      setupTx,
    );
    const inputs = runtime.getImmutableCell(
      space,
      {
        db: db as never,
        sql: "SELECT id, reader, body FROM notes ORDER BY id",
        reactOn: 1,
        readClearance: true,
      },
      undefined,
      setupTx,
    );
    expect((await setupTx.commit()).error).toBeUndefined();

    let resultCell: Cell<QueryState> | undefined;
    const builtin = sqliteQuery(
      inputs as never,
      (_rtx, result) => {
        resultCell = result as Cell<QueryState>;
      },
      () => {},
      [parent],
      parent,
      runtime,
    );

    /** A SECOND instance of the same query (fresh parent, fresh result
     * cell, fresh per-closure in-flight set) — the determinism pin's
     * probe: nothing per-instance may reach the request hash. */
    const makeBuiltin = async () => {
      const ptx = runtime.edit();
      const p = runtime.getCell(
        space,
        `ow53 query parent ${crypto.randomUUID()}`,
        undefined,
        ptx,
      );
      expect((await ptx.commit()).error).toBeUndefined();
      let cell: Cell<QueryState> | undefined;
      const b = sqliteQuery(
        inputs as never,
        (_rtx, result) => {
          cell = result as Cell<QueryState>;
        },
        () => {},
        [p],
        p,
        runtime,
      );
      return { builtin: b, result: () => cell! };
    };

    return { builtin, result: () => resultCell!, makeBuiltin };
  };

  it({
    name:
      "keys a cleared read's request hash by each stamped run's acting reader (per-reader runs stage different hashes)",
    // provider.sqliteQuery loads the column-metadata FFI lib
    // (process-lifetime by design) — exempt from the leak detector.
    sanitizeResources: false,
  }, async () => {
    const { builtin, result } = await clearedQuerySetup();

    // Each stamped run stages its claim `{pending, requestHash}` into its
    // OWN transaction. These probes compare staged request identities;
    // the composed sqlite-read-clearance-multi-runtime test covers their
    // durable per-instance landing through serving waves.
    const tx1 = runtime.edit();
    demandedStamp(tx1, aliceSigner.did(), "sess-alice");
    builtin.action(tx1);
    const aliceHash = (result().withTx(tx1).get() as QueryState | undefined)
      ?.requestHash;
    tx1.abort();

    const tx2 = runtime.edit();
    demandedStamp(tx2, bobSigner.did(), "sess-bob");
    builtin.action(tx2);
    const bobHash = (result().withTx(tx2).get() as QueryState | undefined)
      ?.requestHash;
    tx2.abort();

    expect(aliceHash).toBeDefined();
    expect(bobHash).toBeDefined();
    // A cleared result depends on WHO is asking (builtins.md §2, RULED
    // 2026-08-02: the reader principal is part of the memo key). With the
    // ambient provider consumed instead, both runs hash the SERVICE and
    // the two hashes collide reader-blind.
    expect(aliceHash).not.toBe(bobHash);
  });

  it({
    name:
      "keys a session-scoped cleared read's request identity by the run's session (two sessions of one user stage distinct hashes)",
    sanitizeResources: false,
  }, async () => {
    // Cleared session results include both reader and session in the memo
    // hash. The outbox also resolves the target's scope instance. This pin
    // checks staged hashes; executor-sqlite-instances covers non-clearance
    // completions against a space database under a live execution lease.
    const { builtin, result } = await clearedQuerySetup("session");

    const tx1 = runtime.edit();
    demandedStamp(tx1, aliceSigner.did(), "sess-one");
    builtin.action(tx1);
    const hashOne = (result().withTx(tx1).get() as QueryState | undefined)
      ?.requestHash;
    tx1.abort();

    const tx2 = runtime.edit();
    demandedStamp(tx2, aliceSigner.did(), "sess-two");
    builtin.action(tx2);
    const hashTwo = (result().withTx(tx2).get() as QueryState | undefined)
      ?.requestHash;
    tx2.abort();

    expect(hashOne).toBeDefined();
    expect(hashTwo).toBeDefined();
    expect(hashOne).not.toBe(hashTwo);
  });

  it({
    name:
      "derives a session-scoped cleared read's request hash from query and identity alone (same session re-staged from a fresh instance, same hash)",
    sanitizeResources: false,
  }, async () => {
    // The distinct-across-sessions pin above would ALSO pass if the hash
    // carried per-run noise — a nonce splits any two stagings. Staging the
    // identical (query, user, session) from a FRESH builtin instance
    // (fresh parent, fresh result cell, fresh in-flight set) must
    // reproduce the SAME hash: the request identity is derived from the
    // query and the carried identity, nothing per-run and nothing
    // per-instance — determinism is what makes the session join a KEY
    // rather than a cache-buster.
    const { builtin, result, makeBuiltin } = await clearedQuerySetup(
      "session",
    );

    const tx1 = runtime.edit();
    demandedStamp(tx1, aliceSigner.did(), "sess-one");
    builtin.action(tx1);
    const first = (result().withTx(tx1).get() as QueryState | undefined)
      ?.requestHash;
    tx1.abort();

    const second = await makeBuiltin();
    const tx2 = runtime.edit();
    demandedStamp(tx2, aliceSigner.did(), "sess-one");
    second.builtin.action(tx2);
    const restaged = (second.result().withTx(tx2).get() as
      | QueryState
      | undefined)?.requestHash;
    tx2.abort();

    expect(first).toBeDefined();
    expect(restaged).toBe(first);
  });

  it({
    name:
      "keeps a user-scoped cleared read's request identity session-blind (two sessions of one user share one hash)",
    sanitizeResources: false,
  }, async () => {
    // The unchanged arm of the 2026-08-22 ruling: at USER granularity the
    // session never joins the request identity, so two sessions of one
    // user share the user-scoped cleared cell AND its hash — the sharing
    // IS the contract (one cleared cell per query-and-reader-at-matching-
    // granularity), and the hash shape stays byte-identical to the
    // pre-ruling reader keying. Green on both sides of the session fix.
    const { builtin, result } = await clearedQuerySetup();

    const tx1 = runtime.edit();
    demandedStamp(tx1, aliceSigner.did(), "sess-one");
    builtin.action(tx1);
    const hashOne = (result().withTx(tx1).get() as QueryState | undefined)
      ?.requestHash;
    tx1.abort();

    const tx2 = runtime.edit();
    demandedStamp(tx2, aliceSigner.did(), "sess-two");
    builtin.action(tx2);
    const hashTwo = (result().withTx(tx2).get() as QueryState | undefined)
      ?.requestHash;
    tx2.abort();

    expect(hashOne).toBeDefined();
    expect(hashOne).toBe(hashTwo);
  });
});
