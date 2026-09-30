import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { EventHandler } from "../src/scheduler/types.ts";
import type { CommitError } from "../src/storage/interface.ts";

// A transaction settles in one of three ways: its commit succeeds, its commit
// is rejected, or it is aborted. All three end the transaction and decide the
// fate of the writes it staged, so all three reach the callbacks registered to
// compensate for writes that did not become durable.
//
// Work that re-runs what another transaction already carries is the exception,
// because it never attempted the work its callbacks describe. The idempotency
// recheck is the one that exists: it re-runs each computation against a
// throwaway transaction to compare the writes, then aborts it, and takes that
// transaction from createDuplicateWorkTransaction so it registers no callbacks
// to settle.

const signer = await Identity.fromPassphrase("transaction abort settlement");
const space = signer.did();

describe("an aborted transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("settles its callbacks with an aborted outcome", () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "abort settles callbacks",
      undefined,
    );
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });

    const outcomes: (CommitError | undefined)[] = [];
    tx.addCommitCallback((_settledTx, result) => {
      outcomes.push(result.error);
    });

    tx.abort("aborted by test");

    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.name).toBe("StorageTransactionAborted");
  });

  it("settles its callbacks exactly once", async () => {
    const cell = runtime.getCell<{ value: number }>(
      space,
      "abort settles once",
      undefined,
    );
    const tx = runtime.edit();
    cell.withTx(tx).set({ value: 1 });

    let settlements = 0;
    tx.addCommitCallback(() => {
      settlements++;
    });

    tx.abort("aborted by test");
    const commit = await tx.commit();

    expect(commit.error).toBeDefined();
    expect(settlements).toBe(1);
  });

  it("drops a follow-up event sent by a handler that then throws", async () => {
    const setupTx = runtime.edit();
    const origin = runtime.getCell<unknown>(
      space,
      "abort lineage origin stream",
      { asCell: ["stream"] },
      setupTx,
    );
    const followUp = runtime.getCell<unknown>(
      space,
      "abort lineage follow-up stream",
      { asCell: ["stream"] },
      setupTx,
    );
    const delivered = runtime.getCell<unknown[]>(
      space,
      "abort lineage delivered payloads",
      undefined,
      setupTx,
    );
    delivered.withTx(setupTx).set([]);
    await setupTx.commit();

    let errors = 0;
    runtime.scheduler.onError(() => {
      errors++;
    });

    // The origin handler's transaction is aborted when the handler throws, so
    // its writes never become durable. The follow-up it sent describes work
    // that depends on those writes.
    const originHandler: EventHandler = (handlerTx) => {
      runtime.scheduler.queueEvent(
        followUp.getAsNormalizedFullLink(),
        "follow-up payload",
        undefined,
        undefined,
        false,
        { originTx: handlerTx },
      );
      throw new Error("origin handler failed after sending a follow-up");
    };
    const followUpHandler: EventHandler = (handlerTx, event: unknown) => {
      const current = delivered.withTx(handlerTx).get();
      delivered.withTx(handlerTx).set([...current, event]);
    };

    runtime.scheduler.addEventHandler(
      originHandler,
      origin.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      followUpHandler,
      followUp.getAsNormalizedFullLink(),
    );

    // An origin left unsettled parks its follow-up at the head of the queue
    // with no wake source, so idle() never resolves and the failure surfaces as
    // an unresolved promise rather than as the assertions below.
    runtime.scheduler.queueEvent(origin.getAsNormalizedFullLink(), {});
    await runtime.idle();
    await runtime.idle();

    expect(errors).toBe(1);
    expect(delivered.get()).toEqual([]);
  });

  it("leaves a child alone when the idempotency recheck aborts", async () => {
    const { cell, lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const childPattern = pattern<{ source: number }>(({ source }) => ({
      doubled: lift((value: number) => value * 2)(source),
    }));
    const produceChild = lift((source: number) => childPattern({ source }));
    const rootPattern = pattern(() => {
      const source = cell(3);
      return { source, child: produceChild(source) };
    });

    const setupTx = runtime.edit();
    const rootCell = runtime.getCell<{ source: number; child: unknown }>(
      space,
      "recheck child survival root",
      undefined,
      setupTx,
    );
    const root = runtime.run(setupTx, rootPattern, {}, rootCell);
    await setupTx.commit();
    await runtime.idle();
    const stopReading = root.key("child").sink(() => {});

    try {
      await runtime.idle();
      const registrations = runtime.runner.cancels.size;
      expect(await root.key("child").key("doubled").pull()).toBe(6);

      // Every computation now runs a second time against a throwaway
      // transaction that is aborted. The child belongs to the run that
      // committed, and has to survive that abort untouched.
      runtime.scheduler.enableIdempotencyCheck();
      try {
        const bumpTx = runtime.edit();
        root.key("source").withTx(bumpTx).set(5);
        expect((await bumpTx.commit()).error).toBeUndefined();
        await runtime.scheduler.idleWithPendingCommits();
      } finally {
        runtime.scheduler.disableIdempotencyCheck();
      }

      expect(runtime.runner.cancels.size).toBe(registrations);
      expect(await root.key("child").key("doubled").pull()).toBe(10);
    } finally {
      stopReading();
    }
  });
});
