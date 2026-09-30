// Server-execution v2 fan-out stage A — OW17's instance-keyed replica and
// wire, the UNIT-level pins the E2E suite (executor-instance-keyed-
// replica.test.ts) rides on:
//
// - OFF-arm neutrality per re-keyed site: with no explicit instance
//   anywhere — every client, the whole OFF arm — the dependency key,
//   the compaction, the reactivity log, the notification addresses, and
//   the replica reads are byte-identical to the scope-NAME keying (the
//   `scopeKey` field is ABSENT, never `undefined`-valued);
// - the replica holds two instances of one doc: a seal under one
//   principal's identity leaves the other principal's — and the
//   replica's own — local doc untouched, and each identity reads its own;
// - the N-run loop resubscribes ONCE to the UNION of the instance logs:
//   after two instance runs, BOTH instances' reads are registered
//   (mutation: per-run resubscribe → only the last instance's read
//   survives);
// - two instance-named loads of one doc are two watches (distinct watch
//   ids), and the pull-kick reservation is per instance;
// - the seam pins the independent review found UNTESTED (fan-out stage
//   A's fix round, 2026-08-17 — each goes red under the review's
//   mutation): the served event's presync AND preflight carry the
//   event's actor; `Cell.sync` names the cell's transaction identity;
//   the traversal's absent-target kick names the run identity; a seal's
//   read basis is built from the SEALING identity's records; the A3
//   seed memo keys under the RUN's identity (Alice's presence never
//   suppresses Bob's seed); a keyed retraction drops exactly the named
//   instance.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { entityKey, entityNameKey } from "../src/scheduler/keys.ts";
import { sortAndCompactPaths } from "../src/reactive-dependencies.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { watchIdForEntry } from "../src/storage/v2-watch.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  MemorySpace,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import { txToReactivityLog } from "../src/scheduler/reactivity.ts";
import type { EventHandler } from "../src/scheduler/types.ts";

const signer = await Identity.fromPassphrase("stage A instance keying");
const space = signer.did() as MemorySpace;
const alice = { principal: "did:key:z6Mk-stagea-alice", sessionId: "a-s1" };
const bob = { principal: "did:key:z6Mk-stagea-bob", sessionId: "b-s1" };

describe("stage A: instance keying — unit pins", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    await runtime.dispose();
    await storageManager.close();
  });

  it("OFF-arm neutrality: keys, compaction, and logged addresses without an explicit instance are byte-identical to the scope-NAME keying; an explicit instance is preferred where present", () => {
    const own = runtime.scopeKeyIdentity;
    const address: IMemorySpaceAddress = {
      space,
      id: "of:stagea-doc" as never,
      scope: "user",
      path: ["a"],
    };
    // Without `scopeKey`: exactly the pre-stage-A string.
    expect(entityKey(address, own)).toBe(
      `${space}/${resolveScopeKey("user", own)}/of:stagea-doc`,
    );
    // With one: the instance, the identity not consulted.
    expect(entityKey({ ...address, scopeKey: "user:x" }, own)).toBe(
      `${space}/user:x/of:stagea-doc`,
    );
    // The name-keyed twin (the writer/materializer index) ignores both.
    expect(
      entityNameKey(
        { ...address, scopeKey: "user:x" } as IMemorySpaceAddress,
      ),
    ).toBe(`${space}/user/of:stagea-doc`);
    expect(entityNameKey(address)).toBe(entityNameKey({ ...address }));

    // Compaction: two name-equal reads compact as before; two reads of
    // DIFFERENT instances stay apart (the union of an N-run loop's logs).
    const compacted = sortAndCompactPaths([
      { ...address, path: ["a"] },
      { ...address, path: ["a", "b"] },
    ]);
    expect(compacted.length).toBe(1);
    expect(Object.hasOwn(compacted[0], "scopeKey")).toBe(false);
    const twoInstances = sortAndCompactPaths([
      { ...address, scopeKey: resolveScopeKey("user", alice) },
      { ...address, scopeKey: resolveScopeKey("user", bob) },
    ]);
    expect(twoInstances.length).toBe(2);
    expect(
      twoInstances.map((read) => read.scopeKey).toSorted(),
    ).toEqual(
      [resolveScopeKey("user", alice), resolveScopeKey("user", bob)]
        .toSorted(),
    );
  });

  it("OFF-arm neutrality: a transaction with no run identity logs addresses without any `scopeKey` property; a stamped run's SCOPED reads carry its instance and its space reads do not", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "stagea-log-scoped",
      undefined,
      undefined,
      "user",
    );
    const spaceCell = runtime.getCell<{ value: number }>(
      space,
      "stagea-log-space",
      undefined,
    );
    // Unstamped (every client, the OFF arm).
    const plain = runtime.edit();
    cell.withTx(plain).get();
    spaceCell.withTx(plain).get();
    const plainLog = txToReactivityLog(plain);
    expect(plainLog.reads.length).toBeGreaterThan(0);
    for (const read of plainLog.reads) {
      expect(Object.hasOwn(read, "scopeKey")).toBe(false);
    }
    expect(plain.tx.scopeKeyIdentity).toBeUndefined();
    plain.abort();

    // Stamped as Alice (a served per-instance run).
    const stamped = runtime.edit();
    stampWaveRunContext(stamped, {
      actionId: "stagea-log",
      kind: "derivation",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    expect(stamped.tx.scopeKeyIdentity).toEqual(alice);
    cell.withTx(stamped).get();
    spaceCell.withTx(stamped).get();
    const stampedLog = txToReactivityLog(stamped);
    const scopedReads = stampedLog.reads.filter((read) =>
      read.scope === "user"
    );
    const spaceReads = stampedLog.reads.filter((read) =>
      (read.scope ?? "space") === "space"
    );
    expect(scopedReads.length).toBeGreaterThan(0);
    for (const read of scopedReads) {
      expect(read.scopeKey).toBe(resolveScopeKey("user", alice));
    }
    expect(spaceReads.length).toBeGreaterThan(0);
    for (const read of spaceReads) {
      expect(Object.hasOwn(read, "scopeKey")).toBe(false);
    }
    // One identity per transaction: a DIFFERENT identity is refused.
    expect(() => {
      stamped.tx.scopeKeyIdentity = bob;
    }).toThrow(/one transaction serves one identity/);
    // The same identity again is idempotent.
    stamped.tx.scopeKeyIdentity = { ...alice };
    stamped.abort();
  });

  it("the replica holds two instances of one doc: a seal as Alice leaves Bob's and the replica's own local doc untouched, and each identity reads its own (the R7 read shape at the replica level)", async () => {
    const replica = storageManager.open(space).replica;
    // Own-identity write (the OFF path): lands in the replica's own
    // instance only.
    const ownCell = runtime.getCell<{ value: string }>(
      space,
      "stagea-two-instances-cell",
      undefined,
      undefined,
      "user",
    );
    const ownTx = runtime.edit();
    ownCell.withTx(ownTx).set({ value: "own" });
    expect((await ownTx.commit()).error).toBeUndefined();
    const docId = ownCell.getAsNormalizedFullLink().id;
    const readAs = (identity: ScopeKeyIdentity | undefined) =>
      (replica.getDocument(docId, "user", identity)?.value as
        | { value?: string }
        | undefined)?.value;
    expect(readAs(undefined)).toBe("own");
    expect(readAs(runtime.scopeKeyIdentity)).toBe("own");
    expect(readAs(alice)).toBeUndefined();
    expect(readAs(bob)).toBeUndefined();

    // A seal under Alice's identity through the wave stamp: the pending
    // layer lands on ALICE's instance and nowhere else.
    const seals: IExtendedStorageTransaction[] = [];
    const destination: TransactionSealDestination = {
      seal: (tx) => {
        seals.push(tx);
        return tx.tx.commit();
      },
    };
    runtime.installSealDestination(destination, {
      runStamper: (tx: IExtendedStorageTransaction, info: ServerRunInfo) => {
        stampWaveRunContext(tx, {
          actionId: info.actionId,
          kind: info.kind,
          scopeKeyIdentity: alice,
          actionScopeKey: resolveScopeKey("user", alice),
        });
      },
    });
    // Drive the write through the replica's own sealNative with the
    // identity option — the exact seam the wave uses.
    const aliceTx = runtime.edit();
    stampWaveRunContext(aliceTx, {
      actionId: "stagea-seal-alice",
      kind: "derivation",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    const { promise, resolve } = Promise.withResolvers<
      { committed: { seq: number } }
    >();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: docId,
          type: "application/json",
          scope: "user",
          value: { value: { value: "alice-pending" } } as never,
        }],
        preconditions: [],
      } as never,
      aliceTx.tx,
      promise,
      { identity: alice },
    );
    expect(sealed.localSeq).toBeGreaterThan(0);
    // Visible through Alice's instance, invisible to Bob and to the
    // replica's own instance.
    expect(readAs(alice)).toBe("alice-pending");
    expect(readAs(bob)).toBeUndefined();
    expect(readAs(undefined)).toBe("own");
    // The verdict confirms exactly Alice's layer (F1a: sealed commits
    // confirm at verdict), still keyed apart from the replica's own.
    resolve({ committed: { seq: 999 } } as never);
    await sealed.settled;
    expect(readAs(alice)).toBe("alice-pending");
    expect(readAs(undefined)).toBe("own");
    expect(readAs(bob)).toBeUndefined();
    aliceTx.abort();
    runtime.clearSealDestination();
  });

  it("keyed retraction (finding 1's replica half): a KEYED remove of a keyed-delivered foreign instance drops exactly that instance and the replica's OWN instance survives — and an UNKEYED remove names the own instance, which is why the server may never send one for a keyed delivery", async () => {
    // The serving replica's stage-A steady state: its OWN instance of a
    // user-scoped doc (from its own commit) plus Alice's instance (from
    // a KEYED lease-holder frame). Then the memory server retracts
    // Alice's entry — a former holder's catch-up (protocol.md §3's
    // filter once the lease lapsed). The wire invariant the memory server
    // now keeps (`v2-explicit-read.test.ts` "finding 1 (wire half)"): a
    // keyed delivery is retracted KEYED. This is the replica's side of
    // that contract — a keyed remove resolves to the named instance, an
    // unkeyed one to the own instance — so both halves together are what
    // keeps the own doc intact.

    const replica = storageManager.open(space).replica as SpaceReplica;
    const ownCell = runtime.getCell<{ value: string }>(
      space,
      "stagea-keyed-retraction-cell",
      undefined,
      undefined,
      "user",
    );
    const ownTx = runtime.edit();
    ownCell.withTx(ownTx).set({ value: "own" });
    expect((await ownTx.commit()).error).toBeUndefined();
    const docId = ownCell.getAsNormalizedFullLink().id;
    const aliceKey = resolveScopeKey("user", alice);
    const readAs = (identity: ScopeKeyIdentity | undefined) =>
      (replica.getDocument(docId, "user", identity)?.value as
        | { value?: string }
        | undefined)?.value;
    expect(readAs(undefined)).toBe("own");

    // A KEYED lease-holder frame delivers Alice's instance.
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 0,
      toSeq: 5,
      upserts: [{
        branch: "",
        id: docId,
        scope: "user",
        scopeKey: aliceKey,
        seq: 5,
        doc: { value: { value: "alice" } },
      }],
      removes: [],
    }, "integrate");
    expect(readAs(alice)).toBe("alice");
    expect(readAs(undefined)).toBe("own");

    // The KEYED retraction: exactly Alice's instance goes; the own
    // instance is untouched. (Mutation: `#applySessionSync()` ignoring
    // `remove.scopeKey` wipes the own instance and keeps Alice's stale
    // one — the exact inverse.)
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 5,
      toSeq: 6,
      upserts: [],
      removes: [{ branch: "", id: docId, scope: "user", scopeKey: aliceKey }],
    }, "integrate");
    expect(readAs(alice)).toBeUndefined();
    expect(readAs(undefined)).toBe("own");

    // Re-delivered keyed (the re-arm after a survived blip), then an
    // UNKEYED remove: that names the OWN instance — the client cannot
    // tell it apart from a legitimate retraction of its own watch, which
    // is exactly why the memory server keys every retraction on a keyed
    // wire (the pre-fix former-holder catch-up sent this frame for
    // ALICE's entry and wiped the own doc: `own: undefined, alice: alice`).
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 6,
      toSeq: 7,
      upserts: [{
        branch: "",
        id: docId,
        scope: "user",
        scopeKey: aliceKey,
        seq: 7,
        doc: { value: { value: "alice-2" } },
      }],
      removes: [],
    }, "integrate");
    expect(readAs(alice)).toBe("alice-2");
    replica.accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 7,
      toSeq: 8,
      upserts: [],
      removes: [{ branch: "", id: docId, scope: "user" }],
    }, "integrate");
    expect(readAs(undefined)).toBeUndefined();
    expect(readAs(alice)).toBe("alice-2");
  });

  it("the N-run loop resubscribes ONCE to the union of its instance logs: after two instance runs both instances' reads are registered (mutation: per-run replacement keeps only the last)", async () => {
    const rootId = "of:stagea-union-root";
    runtime.installSealDestination(
      { seal: (tx: IExtendedStorageTransaction) => tx.tx.commit() },
      {
        runStamper: (
          tx: IExtendedStorageTransaction,
          info: ServerRunInfo,
        ) => {
          stampWaveRunContext(tx, {
            actionId: info.actionId,
            kind: info.kind,
            ...(info.scopeKeyIdentity !== undefined
              ? { scopeKeyIdentity: info.scopeKeyIdentity }
              : {}),
            ...(info.actionScopeKey !== undefined
              ? { actionScopeKey: info.actionScopeKey }
              : {}),
          });
        },
        // Stage B's seam: the registry returns DEMANDERS; the node's
        // read of the user-scoped input is what narrows it, so the
        // probe run (alice) discovers `user` and bob's instance runs
        // in the same pass — two instance runs, one union.
        runDemanderResolver: (pieceRootIds) =>
          pieceRootIds.includes(rootId) ? [alice, bob] : [],
      },
    );
    const scoped = runtime.getCell<{ value: number }>(
      space,
      "stagea-union-input",
      undefined,
      undefined,
      "user",
    );
    const action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        // Each instance run reads ITS instance of the scoped input.
        scoped.withTx(tx).get();
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );
    await runtime.scheduler.run(action);
    await runtime.idle();

    const inputId = scoped.getAsNormalizedFullLink().id;
    const snapshot = runtime.scheduler.getGraphSnapshot();
    const node = snapshot.nodes.find((candidate) =>
      candidate.reads?.some((read) => read.includes(inputId))
    );
    expect(node).toBeDefined();
    const inputReads = node!.reads!.filter((read) => read.includes(inputId));
    // BOTH instances registered — the union.
    expect(
      inputReads.some((read) => read.includes(resolveScopeKey("user", alice))),
    ).toBe(true);
    expect(
      inputReads.some((read) => read.includes(resolveScopeKey("user", bob))),
    ).toBe(true);
    // And the graph stays SINGULAR: one node for the action (C11b).
    expect(
      snapshot.nodes.filter((candidate) =>
        candidate.reads?.some((read) => read.includes(inputId))
      ).length,
    ).toBe(1);
  });

  it("the writer index is instance-AGNOSTIC: a user-scoped-DECLARED writer and a reader running as Alice keep their dependent edge (mutation: an instance-keyed writer index loses it)", async () => {
    const rootId = "of:stagea-edge-root";
    runtime.installSealDestination(
      { seal: (tx: IExtendedStorageTransaction) => tx.tx.commit() },
      {
        runStamper: (
          tx: IExtendedStorageTransaction,
          info: ServerRunInfo,
        ) => {
          stampWaveRunContext(tx, {
            actionId: info.actionId,
            kind: info.kind,
            ...(info.scopeKeyIdentity !== undefined
              ? { scopeKeyIdentity: info.scopeKeyIdentity }
              : {}),
            ...(info.actionScopeKey !== undefined
              ? { actionScopeKey: info.actionScopeKey }
              : {}),
          });
        },
        runDemanderResolver: (pieceRootIds) =>
          pieceRootIds.includes(rootId) ? [alice] : [],
      },
    );
    const shared = runtime.getCell<{ value: number }>(
      space,
      "stagea-edge-doc",
      undefined,
      undefined,
      "user",
    );
    const sharedLink = shared.getAsNormalizedFullLink();
    // The WRITER: a node whose DECLARED surface is the doc at USER scope
    // (scope NAME — a declared surface never names an instance; one node
    // writes every instance of it, C11b).
    const writer = Object.assign((_tx: IExtendedStorageTransaction) => {}, {
      schedulerObservationIdentity: { pieceId: "space:writer" },
    });
    runtime.scheduler.subscribe(writer, {
      reads: [],
      shallowReads: [],
      writes: [{
        space,
        id: sharedLink.id,
        scope: "user",
        path: [],
      }],
    });
    // The READER: runs AS ALICE (the demanded instance), so its logged
    // read of the doc names `user:<alice>` — not the runtime's own
    // instance the writer's surface resolves to at cardinality 1.
    const reader = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        shared.withTx(tx).get();
      },
      {
        schedulerObservationIdentity: {
          pieceId: `space:${rootId}`,
          pieceRootId: rootId,
        },
      },
    );
    await runtime.scheduler.run(reader);
    await runtime.idle();
    const snapshot = runtime.scheduler.getGraphSnapshot();
    const writerId = snapshot.nodes.find((node) =>
      node.writes?.some((write) => write.includes(sharedLink.id))
    )?.id;
    const readerId = snapshot.nodes.find((node) =>
      node.reads?.some((read) =>
        read.includes(sharedLink.id) &&
        read.includes(resolveScopeKey("user", alice))
      )
    )?.id;
    expect(writerId).toBeDefined();
    expect(readerId).toBeDefined();
    // THE EDGE: writer → reader survives although the reader's read
    // names Alice's instance and the writer's surface names the scope.
    expect(
      snapshot.edges.some((edge) =>
        edge.from === writerId && edge.to === readerId
      ),
    ).toBe(true);
  });

  it("seam pin (M16+M17): a SERVED event's dependency preflight runs under the event's actor and its presync receives the actor — a client-side event passes neither (mutations: either identity dropped → red)", async () => {
    // Every mechanism the served handler's actor-instance read rides on
    // (the true-R7 E2E pins the composite; each half here): the
    // preflight's dependency probe tx carries the actor as its
    // `scopeKeyIdentity` (so its absent reads kick instance-named loads
    // and the pending-load park cross-matches them), and `presyncInputs`
    // is handed the same actor (so the handler's inputs load AS the
    // actor). Absent on client-side events, byte-identical there.

    runtime.installSealDestination(
      { seal: (tx: IExtendedStorageTransaction) => tx.tx.commit() },
      {
        runStamper: (tx: IExtendedStorageTransaction, info: ServerRunInfo) => {
          stampWaveRunContext(tx, {
            actionId: info.actionId,
            kind: info.kind,
            ...(info.scopeKeyIdentity !== undefined
              ? { scopeKeyIdentity: info.scopeKeyIdentity }
              : {}),
            ...(info.actionScopeKey !== undefined
              ? { actionScopeKey: info.actionScopeKey }
              : {}),
          });
        },
      },
    );
    const stream = runtime.getCell<unknown>(space, "stagea-served-stream");
    const seen: {
      preflight: Array<ScopeKeyIdentity | undefined>;
      presync: Array<ScopeKeyIdentity | undefined>;
      handled: number;
    } = { preflight: [], presync: [], handled: 0 };
    const handler: EventHandler = Object.assign(
      (_tx: IExtendedStorageTransaction, _event: unknown) => {
        seen.handled += 1;
      },
      {
        populateDependencies: (depTx: IExtendedStorageTransaction) => {
          seen.preflight.push(depTx.tx.scopeKeyIdentity);
        },
        presyncInputs: (_event: unknown, identity?: ScopeKeyIdentity) => {
          seen.presync.push(identity);
          return Promise.resolve();
        },
      },
    );
    runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
    // A served event, fired at Alice (the SpaceServer drain's carriage).
    runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      { n: 1 },
      true,
      undefined,
      false,
      {
        served: {
          firedAt: { user: alice.principal, session: alice.sessionId },
        },
      },
    );
    await runtime.idle();
    expect(seen.handled).toBe(1);
    expect(seen.preflight).toEqual([alice]);
    expect(seen.presync).toEqual([alice]);
    // A client-side event of the same stream: no identity anywhere.
    runtime.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {
      n: 2,
    });
    await runtime.idle();
    expect(seen.handled).toBe(2);
    expect(seen.preflight[1]).toBeUndefined();
    expect(seen.presync[1]).toBeUndefined();
    runtime.clearSealDestination();
  });

  it("seam pin (M15): Cell.sync names the cell's TRANSACTION identity — a cell bound to a run stamped as Alice loads through syncCell with her identity, and the load registers under her instance; an unbound cell passes no options (mutation: identity dropped → red)", async () => {
    const calls: Array<{ scopeKeyIdentity?: ScopeKeyIdentity } | undefined> =
      [];
    const original = storageManager.syncCell.bind(storageManager);
    (storageManager as { syncCell: typeof storageManager.syncCell })
      .syncCell = (cell, options) => {
        calls.push(options);
        return original(cell, options);
      };
    const scoped = runtime.getCell<{ value: number }>(
      space,
      "stagea-cell-sync-identity",
      undefined,
      undefined,
      "user",
    );
    // Bound to a transaction stamped as Alice: the sync names her.
    const aliceTx = runtime.edit();
    stampWaveRunContext(aliceTx, {
      actionId: "stagea-cell-sync",
      kind: "derivation",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    const bound = scoped.withTx(aliceTx);
    const load = bound.sync();
    // The pending-load ledger keys the in-flight load under HER instance
    // (the address the event preflight's park cross-matches).
    const inFlight = storageManager.pendingLoadAddresses?.() ?? [];
    expect(
      inFlight.some((address) =>
        address.id === scoped.getAsNormalizedFullLink().id &&
        (address as { scopeKey?: string }).scopeKey ===
          resolveScopeKey("user", alice)
      ),
    ).toBe(true);
    await load.catch(() => undefined);
    expect(calls).toEqual([{ scopeKeyIdentity: alice }]);
    aliceTx.abort();
    // The same cell with no transaction: the pre-stage-A call, no options.
    await scoped.sync().catch(() => undefined);
    expect(calls[1]).toBeUndefined();
  });

  it("seam pin (M23): the traversal's absent-target kick names the RUN identity — a read inside a run stamped as Alice that meets a link to a never-loaded scoped doc kicks the load AS Alice (mutation: identity dropped → the runtime's own)", async () => {
    // A doc holding a link to a user-scoped target the replica has never
    // seen; a schema-driven read follows the link, finds the target
    // absent, and kicks `ensureLinkedDocLoaded` — the stage-A site
    // threads the traversal's run identity into that kick.

    const target = runtime.getCell<{ label: string }>(
      space,
      "stagea-kick-target",
      undefined,
      undefined,
      "user",
    );
    const holder = runtime.getCell<{ ref: { label: string } }>(
      space,
      "stagea-kick-holder",
      undefined,
    );
    const seedTx = runtime.edit();
    holder.withTx(seedTx).setRawUntyped({ ref: target.getAsLink() });
    expect((await seedTx.commit()).error).toBeUndefined();

    const kicks: Array<ScopeKeyIdentity | undefined> = [];
    const originalKick = runtime.ensureLinkedDocLoaded;
    runtime.ensureLinkedDocLoaded = (link, sourceSpace, identity) => {
      if (link.id === target.getAsNormalizedFullLink().id) {
        kicks.push(identity);
      }
      return originalKick.call(runtime, link, sourceSpace, identity);
    };
    try {
      const aliceTx = runtime.edit();
      stampWaveRunContext(aliceTx, {
        actionId: "stagea-kick",
        kind: "derivation",
        scopeKeyIdentity: alice,
        actionScopeKey: resolveScopeKey("user", alice),
      });
      const typed = runtime.getCell<{ ref: { label: string } }>(
        space,
        "stagea-kick-holder",
        {
          type: "object",
          properties: {
            ref: {
              type: "object",
              properties: { label: { type: "string" } },
            },
          },
        } as const,
        aliceTx,
      );
      typed.get();
      aliceTx.abort();
      expect(kicks).toEqual([alice]);
      // The kick reserved ALICE's instance, not the runtime's own: a
      // later own-identity read of the same target still gets its kick.
      expect(
        storageManager.shouldPullDoc(
          space,
          target.getAsNormalizedFullLink().id,
          "user",
          alice,
        ),
      ).toBe(false);
      expect(
        storageManager.shouldPullDoc(
          space,
          target.getAsNormalizedFullLink().id,
          "user",
        ),
      ).toBe(true);
    } finally {
      runtime.ensureLinkedDocLoaded = originalKick;
    }
  });

  it("seam pin (M19): a seal's read basis is built from the SEALING identity's records — a run as Alice that read HER instance at seq 5 seals a confirmed read at seq 5, not the own instance's absent seq 0 (mutation: identity dropped → red)", async () => {
    const replica = storageManager.open(space).replica;
    const scoped = runtime.getCell<{ value: string }>(
      space,
      "stagea-buildreads-cell",
      undefined,
      undefined,
      "user",
    );
    const docId = scoped.getAsNormalizedFullLink().id;
    // Alice's instance arrives KEYED at seq 5; the replica's own instance
    // of the doc is never loaded (seq 0).
    (replica as SpaceReplica).accessForTestingOnly.applySessionSync({
      type: "sync",
      fromSeq: 0,
      toSeq: 5,
      upserts: [{
        branch: "",
        id: docId,
        scope: "user",
        scopeKey: resolveScopeKey("user", alice),
        seq: 5,
        doc: { value: { value: "alice" } },
      }],
      removes: [],
    }, "integrate");
    const aliceTx = runtime.edit();
    stampWaveRunContext(aliceTx, {
      actionId: "stagea-buildreads",
      kind: "derivation",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    // The run reads HER instance (the tx→replica seam) ...
    expect(scoped.withTx(aliceTx).get()).toEqual({ value: "alice" });
    // ... and seals under her identity: the commit's confirmed read of
    // the doc names the seq HER record holds.
    const { promise, resolve } = Promise.withResolvers<
      { committed: { seq: number } }
    >();
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: docId,
          type: "application/json",
          scope: "user",
          value: { value: { value: "alice-2" } } as never,
        }],
        preconditions: [],
      } as never,
      aliceTx.tx,
      promise,
      { identity: alice },
    );
    const read = sealed.commit.reads.confirmed.find((entry) =>
      entry.id === docId
    );
    expect(read?.seq).toBe(5);
    resolve({ committed: { seq: 6 } } as never);
    await sealed.settled;
    aliceTx.abort();
  });

  it("seam pin (M9, the A3 seed-memo site): a `Writable(initial)`-shaped cell serialized inside Alice's run seeds HER instance and memoizes under HER key — a later run as Bob still seeds HIS default (mutation: memo keyed by the runtime's identity → Alice's presence suppresses Bob's seed)", () => {
    // The runtime-constructed `Writable(value)` shape: a ROOT-linked
    // scoped cell whose schema carries the default. Serializing it as a
    // value into another doc is the seed site (data-updating.ts): the
    // seed writes the default into the target when absent, memoized per
    // (space, INSTANCE, id) under the writing run's identity.

    const seedCell = runtime.getCell<string>(
      space,
      "stagea-seed-target",
      { type: "string", default: "hello" } as const,
      undefined,
      "user",
    );
    const seedLink = seedCell.getAsNormalizedFullLink();
    const holder = runtime.getCell<{ slot: unknown }>(
      space,
      "stagea-seed-holder",
      undefined,
    );
    const readSeed = (tx: IExtendedStorageTransaction) =>
      tx.readValueOrThrow({ ...seedLink, path: [] });

    // Alice's run: her instance is already PRESENT (she wrote it), so the
    // serialization's presence check finds it and MEMOIZES — under HER
    // instance key (the memo records presence, never a seed it wrote).
    const aliceTx = runtime.edit();
    stampWaveRunContext(aliceTx, {
      actionId: "stagea-seed-alice",
      kind: "derivation",
      scopeKeyIdentity: alice,
      actionScopeKey: resolveScopeKey("user", alice),
    });
    seedCell.withTx(aliceTx).set("alice-wrote-this");
    holder.withTx(aliceTx).set({ slot: seedCell });
    expect(readSeed(aliceTx)).toBe("alice-wrote-this");

    // Bob's run serializes the same cell: HIS instance is absent, so it
    // must be seeded. Pre-fix the memo keyed under the runtime's own
    // identity for every run — Alice's presence check had memoized the
    // doc under that one key, Bob's check was skipped, and his default
    // never landed (the panel's Lens 2d hazard: one user's presence
    // suppressing another's seed).
    const bobTx = runtime.edit();
    stampWaveRunContext(bobTx, {
      actionId: "stagea-seed-bob",
      kind: "derivation",
      scopeKeyIdentity: bob,
      actionScopeKey: resolveScopeKey("user", bob),
    });
    holder.withTx(bobTx).set({ slot: seedCell });
    expect(readSeed(bobTx)).toBe("hello");
    aliceTx.abort();
    bobTx.abort();
  });

  it("two instance-named loads of one doc are two watches, and the pull-kick reservation is per instance", () => {
    const address = {
      id: "of:stagea-watch" as never,
      type: "application/json" as const,
      scope: "user" as const,
    };
    const selector = { path: [], schema: false as const };
    const plain = watchIdForEntry(address, selector, "");
    const asAlice = watchIdForEntry(
      { ...address, scopeKey: resolveScopeKey("user", alice) },
      selector,
      "",
    );
    const asBob = watchIdForEntry(
      { ...address, scopeKey: resolveScopeKey("user", bob) },
      selector,
      "",
    );
    expect(asAlice).not.toBe(asBob);
    expect(asAlice).not.toBe(plain);
    // An unnamed entry's id is independent of the field's existence.
    expect(watchIdForEntry({ ...address, scopeKey: undefined }, selector, ""))
      .toBe(plain);

    // The manager reserves one kick per (space, instance, id).
    expect(storageManager.shouldPullDoc(space, address.id, "user", alice))
      .toBe(true);
    expect(storageManager.shouldPullDoc(space, address.id, "user", alice))
      .toBe(false);
    expect(storageManager.shouldPullDoc(space, address.id, "user", bob))
      .toBe(true);
    // The own-identity reservation is a distinct key from either.
    expect(storageManager.shouldPullDoc(space, address.id, "user")).toBe(true);
  });
});

describe("stage A: OFF-arm serialized forms carry no scopeKey", () => {
  // The OFF-arm serialized-form witness the stage-A build report claimed and
  // the independent review found unpinned (finding 9): with the flag OFF and no
  // serving posture — every client today — no storage notification change
  // address, reactivity-log address, replica state, or replica document carries
  // a `scopeKey` own-property. Adopted from the review's probe
  // (`zz-review-off-notification-probe`).

  let offManager: ReturnType<typeof StorageManager.emulate>;
  let offRuntime: Runtime;

  beforeEach(() => {
    offManager = StorageManager.emulate({ as: signer });
    offRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: offManager,
      // OFF: no experimental flag, no serving posture.
    });
  });

  afterEach(async () => {
    await offRuntime.dispose();
    await offManager.close();
  });

  const walk = (
    value: unknown,
    path: string,
    hits: string[],
    seen = new Set<unknown>(),
    depth = 0,
  ): void => {
    if (
      !isObjectOrArray(value) || seen.has(value) ||
      depth > 12
    ) {
      return;
    }
    seen.add(value);
    if (Object.hasOwn(value as object, "scopeKey")) hits.push(path);
    for (
      const [key, child] of Object.entries(value as Record<string, unknown>)
    ) {
      if (key === "scopeKey") continue;
      walk(child, `${path}.${key}`, hits, seen, depth + 1);
    }
  };

  it("a scoped commit at OFF: zero scopeKey own-properties anywhere in the notifications, the reactivity log, the replica states, or the replica documents", async () => {
    const hits: string[] = [];
    let notifications = 0;
    offManager.subscribe({
      next: (notification: unknown) => {
        notifications += 1;
        const changes = (notification as { changes?: Iterable<unknown> })
          .changes;
        if (changes !== undefined) {
          for (const change of changes) walk(change, "change", hits);
        }
        walk(
          { ...(notification as object), changes: undefined },
          "notification",
          hits,
        );
        return { done: false };
      },
    } as never);
    const userCell = offRuntime.getCell<{ value: string }>(
      space,
      "stagea-off-user",
      undefined,
      undefined,
      "user",
    );
    const sessionCell = offRuntime.getCell<{ value: string }>(
      space,
      "stagea-off-session",
      undefined,
      undefined,
      "session",
    );
    const spaceCell = offRuntime.getCell<{ value: string }>(
      space,
      "stagea-off-space",
      undefined,
    );
    const tx = offRuntime.edit();
    userCell.withTx(tx).set({ value: "u" });
    sessionCell.withTx(tx).set({ value: "s" });
    spaceCell.withTx(tx).set({ value: "sp" });
    userCell.withTx(tx).get();
    walk(txToReactivityLog(tx), "log", hits);
    expect((await tx.commit()).error).toBeUndefined();
    await offRuntime.idle();
    await offManager.synced();
    const replica = offManager.open(space).replica;
    for (const cell of [userCell, sessionCell, spaceCell]) {
      const link = cell.getAsNormalizedFullLink();
      walk(
        replica.get({
          id: link.id,
          type: "application/json",
          path: [],
          scope: link.scope,
        } as never),
        "state",
        hits,
      );
      walk(replica.getDocument(link.id as never, link.scope), "doc", hits);
    }
    expect(notifications).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
});
