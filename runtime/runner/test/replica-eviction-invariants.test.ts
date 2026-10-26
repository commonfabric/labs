// Two properties that hold today and that any change letting a space replica
// drop documents has to preserve. A replica currently keeps every document it
// pulls for as long as it is open; work to make it hand documents back has to
// leave both of these standing.
//
// These are deliberately small and fast — they are meant to be the loop you run
// while working on eviction, rather than a 100 KB suite whose failure you then
// have to localize. Neither test knows anything about how eviction is
// configured: they assert the behavior a reader is entitled to, so they answer
// the question whatever the mechanism turns out to be.
//
// What each one is a guard against:
//
//   1. A list projection whose element documents stop being read, and are then
//      read again, has to rebuild. If the elements' documents were evicted when
//      the list emptied, the restored list can come back with an empty
//      aggregate.
//   2. A commit that conflicts across two replicas has to settle. The waiting
//      side advances only when a sync frame arrives, and a sync frame only
//      arrives over a watch. If the watch behind the conflicted document were
//      given up, this would wait forever rather than fail — the wait has no
//      timer, by design.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { OpaqueCell } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("replica eviction invariants");
const space = signer.did();

const numberSchema = { type: "number" } as const satisfies JSONSchema;
const booleanSchema = { type: "boolean" } as const satisfies JSONSchema;
const numberElementArgumentSchema = {
  type: "object",
  properties: { element: numberSchema },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

describe("a list projection survives its input emptying", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commonfabric"]["lift"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    ({ lift, pattern } = commonfabric);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("rebuilds after the list is emptied and restored", async () => {
    let predicateRuns = 0;
    const isPositive = lift((value: number) => {
      predicateRuns++;
      return value > 0;
    });
    const predicate = pattern<{ element: number }, unknown>(
      ({ element }) => isPositive(element),
      numberElementArgumentSchema,
      booleanSchema,
    );
    const filtered = pattern<{ values: number[] }>(({ values }) => ({
      values,
      positives: (values as unknown as OpaqueCell<number[]>)
        // deno-lint-ignore no-explicit-any
        .filterWithPattern(predicate as any, {}),
    }));

    const result = runtime.run(
      tx,
      filtered,
      { values: [1, 2, 3] },
      runtime.getCell(space, "eviction-filter", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();
    expect(result.key("positives").get()).toEqual([1, 2, 3]);

    // Emptying the list stops every element run, so nothing reads their result
    // documents any more.
    // deno-lint-ignore no-explicit-any
    result.withTx(tx).key("values").set(undefined as any);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();
    expect(result.key("positives").get()).toEqual([]);

    // Restoring it rebuilds the aggregate, and rebuilding it costs one run of
    // the predicate per element. A replica that evicted the elements' result
    // documents has to fetch them back, and a run that reads one before it
    // arrives runs again once it does — so the count, not the aggregate, is
    // what shows the waste. The aggregate below stays correct either way.
    const runsBeforeRestore = predicateRuns;
    result.withTx(tx).key("values").set([4, 5]);
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();
    expect(result.key("positives").get()).toEqual([4, 5]);
    expect(predicateRuns - runsBeforeRestore).toBe(2);
  });
});

describe("a cross-replica conflict settles", () => {
  // Two managers over one in-process server, so a commit on one can conflict
  // with a commit on the other.

  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    // Manual fan-out: the controlled staleness below is a gated state, not
    // a timing accident — frames spread only when the test flushes.
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
    await rtB?.dispose();
    await rtA?.dispose();
    await storageB?.close();
    await storageA?.close();
    await server?.close();
  });

  it("resolves a stale commit instead of waiting forever", async () => {
    const cause = "eviction-conflict";
    const docA = rtA.getCell<{ v: string }>(space, cause, undefined);
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v0" });
      rtA.prepareTxForCommit(tx);
      // Verdict-marked, no synced(): the barrier would hold on the parked
      // accept and force the shared fan-out through, destroying the
      // controlled staleness this test is built on. The awaited verdict is
      // durably accepted, which is all B's explicit sync/pull needs.
      expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
        .toBeUndefined();
    }

    // B catches up, then stages a write over a read taken at v0.
    const docB = rtB.getCell<{ v: string }>(space, cause, undefined);
    await docB.sync();
    await docB.pull();
    expect(docB.get()).toEqual({ v: "v0" });

    const txB = rtB.edit();
    docB.withTx(txB).get();
    docB.withTx(txB).set({ v: "vB" });
    rtB.prepareTxForCommit(txB);

    // A moves the server on. B is deliberately not synced, so its read is now
    // stale and its commit has to conflict.
    {
      const tx = rtA.edit();
      docA.withTx(tx).set({ v: "v1" });
      rtA.prepareTxForCommit(tx);
      expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
        .toBeUndefined();
    }
    expect(docB.get()).toEqual({ v: "v0" });

    // The rejection receipt resolves at the verdict; the DROP still has to
    // travel through the read-repair gate, which needs a sync frame to
    // reach B through the watch behind the document. The flush below is
    // that frame's release, and synced() settling is the proof the gate
    // opened — if the watch were gone the wait would never end, so synced()
    // hanging is the symptom, not a failure message.
    const rejected = await txB.commit({ holdSyncedUntilCovered: false })
      .verdict;
    expect(rejected.error?.name).toBe("ConflictError");
    await server.flushSessions([space]);
    await clock.settle();
    await rtB.storageManager.synced();

    // And B is left able to see the server's value rather than its stale one.
    await docB.sync();
    await docB.pull();
    expect(docB.get()).toEqual({ v: "v1" });
  });
});
