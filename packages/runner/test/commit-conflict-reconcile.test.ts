// Regression guard: a rejected commit must not leave a read staler than the
// server's confirmed head.
//
// Two real Runtimes share ONE in-process MemoryV2Server, each with its own
// per-space replicas (harness recipe from
// cell-write-conflict-granularity.test.ts). Convergence is forced explicitly, so
// replica B is left PROVABLY stale: after A advances the shared doc, B still
// views the old value — it received no subscription update (asserted on the line
// before B's own commit). B's commit-and-conflict round-trip then reconciles B's
// `confirmed` to the server head, so B's post-rejection read is fresh, not stale.
// This pins that reconciliation: if a future change let a rejected commit revert
// to a stale local `confirmed`, this test fails.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("read-repair-strand");
const space = signer.did();

describe("read-repair: stale read after cross-replica conflict", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    // Manual fan-out: the controlled staleness these tests are built on is
    // a gated state, not a timing accident — frames spread only when a test
    // flushes.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  it("a rejected commit must not leave a read staler than the server head", async () => {
    const CAUSE = "strand-doc";

    // A seeds the doc at v0 and publishes it to the shared server.
    // A's commits carry the verdict-resolution mark: this test's premise is
    // controlled staleness (B must NOT have received A's writes yet), and
    // awaiting a coverage-resolving commit forces the batched fan-out
    // through — which is shared with B's session and would destroy the
    // premise. B's convergence to v0 is an explicit sync/pull.
    const docA = rtA.getCell<{ v: string }>(space, CAUSE, undefined);
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v0" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed v0: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
      // No synced(): the barrier holds on A's parked accept, which forces
      // the shared fan-out batch through — to B too, destroying the
      // staleness premise. The awaited verdict-marked commit is already
      // durably accepted, which is all B's explicit pull needs.
    }

    // B converges to v0.
    const docB = rtB.getCell<{ v: string }>(space, CAUSE, undefined);
    await docB.sync();
    await docB.pull();
    expect(docB.get()).toEqual({ v: "v0" });

    // B opens a tx that READS the doc at v0 and stages a write (uncommitted).
    const txB = rtB.edit();
    docB.withTx(txB).get(); // record read at seq(v0)
    docB.withTx(txB).set({ v: "vB" });
    rtB.prepareTxForCommit(txB);

    // A advances the server to v1. B is deliberately NOT synced — it is now in
    // the window where its `confirmed` lags the server.
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v1" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `bump v1: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
      // No synced() here either — same premise-preservation as the seed.
    }

    // B's `confirmed` is provably stale here: it still views v0, because the
    // subscription has not delivered A's v1 (no sync was forced on B).
    expect(docB.get(), "precondition: B is stale before its commit").toEqual({
      v: "v0",
    });

    // The rejected commit must also surface through the telemetry markers:
    // storage.push.error is the client half of the rejected-commit join
    // (space.did + commit.local_seq — known before the response, unlike a
    // confirmed seq).
    const pushMarkers: { type: string; localSeq?: number; error?: string }[] =
      [];
    rtB.telemetry.addEventListener("telemetry", (event) => {
      const marker = (event as RuntimeTelemetryEvent).marker;
      if (marker.type.startsWith("storage.push.")) {
        pushMarkers.push(marker as (typeof pushMarkers)[number]);
      }
    });

    // B commits its v0-based write — the server rejects it (stale read).
    // The verdict receipt is the ordering barrier for the flush: it resolves
    // only after the server staged the rejection's repair docs, so the
    // explicit fan-out below deterministically carries the repair frame the
    // default-mode promise is gated on.
    const commitP = txB.commit();
    await txB.commitVerdict!();
    await server.flushSessions([space]);
    await clock.settle();
    const resB = await commitP;
    expect(resB.error, "B's commit should be rejected (conflict)")
      .toBeDefined();
    expect(
      (resB.error as { name?: string })?.name,
      "cross-replica conflict is a ConflictError",
    ).toBe("ConflictError");

    const startMarker = pushMarkers.find((m) =>
      m.type === "storage.push.start"
    );
    expect(startMarker?.localSeq, "push.start carries the join key")
      .toBeDefined();
    expect(
      pushMarkers.find((m) => m.type === "storage.push.error")?.error,
      "rejected commit emits storage.push.error with the rejection name",
    ).toBe("ConflictError");

    // INVARIANT under test: after the rejection, B's read must not be staler
    // than the server's confirmed head (v1). Pre-fix B reverts to its stale
    // local `confirmed` (v0); read-repair reconciles `confirmed` to the head.
    // Read with NO intervening await so a fire-and-forget sync cannot mask the
    // strand — the assertion sees B's post-commit `confirmed` directly.
    expect(docB.get()).toEqual({ v: "v1" });
  });

  it("fires verdict callbacks at rejection receipt, while commit callbacks and the promise wait for read repair", async () => {
    const CAUSE = "verdict-before-repair-doc";

    // Same choreography as above: A seeds and bumps with verdict-resolving
    // commits; B stages a write over a provably stale read.
    const docA = rtA.getCell<{ v: string }>(space, CAUSE, undefined);
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v0" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed v0: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
    }

    const docB = rtB.getCell<{ v: string }>(space, CAUSE, undefined);
    await docB.sync();
    await docB.pull();
    expect(docB.get()).toEqual({ v: "v0" });

    const txB = rtB.edit();
    docB.withTx(txB).get();
    docB.withTx(txB).set({ v: "vB" });
    rtB.prepareTxForCommit(txB);

    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v1" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `bump v1: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
    }
    expect(docB.get()).toEqual({ v: "v0" });

    // B's commit will be REJECTED. The rejection response arrives promptly,
    // but the read-repair frame that releases the commit promise rides the
    // fan-out, which this manual server withholds until the test flushes.
    // So at the settle() fixpoint the fate is sealed and the VERDICT
    // callback must have run, while the promise — and with it the COMMIT
    // callbacks, whose consumers act on the repaired base — is still held
    // by the repair gate.
    let verdictResult: { error?: unknown } | undefined;
    txB.addVerdictCallback((_tx, result) => {
      verdictResult = result;
    });
    let commitCallbackFired = false;
    txB.addCommitCallback(() => {
      commitCallbackFired = true;
    });
    let promiseSettled = false;
    const receipt = txB.startCommit();
    const commitP = receipt.settled.then((result) => {
      promiseSettled = true;
      return result;
    });

    expect((await receipt.verdict).error?.name).toBe("ConflictError");
    await clock.settle();
    expect(
      (verdictResult?.error as { name?: string } | undefined)?.name,
      "verdict callback fired with the rejection at rejection receipt",
    ).toBe("ConflictError");
    expect(commitCallbackFired, "commit callback still held by the repair gate")
      .toBe(false);
    expect(promiseSettled, "commit promise still held by the repair gate")
      .toBe(false);

    // The test releases the repair fan-out: the frame arrives, the promise
    // resolves with the same rejection the verdict callback saw, and the
    // commit callback fires with it.
    await server.flushSessions([space]);
    await clock.settle();
    const resB = await commitP;
    expect(resB.error?.name).toBe("ConflictError");
    expect(commitCallbackFired, "commit callback fired at promise settlement")
      .toBe(true);
  });

  it("returns a rejected resolveAt-verdict commit at rejection receipt, while its commit callback waits for repair", async () => {
    const CAUSE = "verdict-mode-rejection-doc";

    // Same choreography again: A seeds and bumps; B stages a stale write.
    const docA = rtA.getCell<{ v: string }>(space, CAUSE, undefined);
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v0" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed v0: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
    }

    const docB = rtB.getCell<{ v: string }>(space, CAUSE, undefined);
    await docB.sync();
    await docB.pull();
    expect(docB.get()).toEqual({ v: "v0" });

    const txB = rtB.edit();
    docB.withTx(txB).get();
    docB.withTx(txB).set({ v: "vB" });
    rtB.prepareTxForCommit(txB);

    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v1" });
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `bump v1: ${JSON.stringify(res.error)}`)
        .toBeUndefined();
    }
    expect(docB.get()).toEqual({ v: "v0" });

    // B commits in VERDICT mode. The rejection receipt must settle the
    // returned promise at the settle() fixpoint — no read-repair wait —
    // while the commit callback stays on the settlement timeline, gated on
    // the repair frame this manual server has not been told to send yet.
    const commitCallbackDone = Promise.withResolvers<void>();
    let commitCallbackFired = false;
    txB.addCommitCallback(() => {
      commitCallbackFired = true;
      commitCallbackDone.resolve();
    });
    let verdictModeResult:
      | { error?: { name?: string } }
      | undefined;
    const commitP = txB.commit({ resolveAt: "verdict" }).then((result) => {
      verdictModeResult = result as { error?: { name?: string } };
      return result;
    });

    await clock.settle();
    expect(
      verdictModeResult?.error?.name,
      "verdict-mode promise settled with the rejection at receipt",
    ).toBe("ConflictError");
    expect(
      commitCallbackFired,
      "commit callback still held by the repair gate",
    ).toBe(false);

    // The test releases the repair fan-out: the frame arrives and the
    // settlement timeline (and with it the commit callback) completes.
    await server.flushSessions([space]);
    await clock.settle();
    await commitP;
    await commitCallbackDone.promise;
    expect(commitCallbackFired).toBe(true);
  });
});
