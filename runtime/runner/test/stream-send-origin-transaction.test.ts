import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { handler } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import { type Cell, sendEvent } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("stream send origin transaction");
const space = signer.did();

describe("stream-send-origin-transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let stream: Cell<unknown>;
  let appended: unknown[];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Explicit schemas: a unit test compiles without the CTS transforms.
    const record = handler(
      true as const,
      { type: "object", properties: {} } as const,
      (_event, _ctx) => {},
    );
    const recorder = pattern<{ value: number }>(({ value }) => ({
      value,
      record: record({}),
    }));
    const tx = runtime.edit();
    const result = runtime.getCell<{ value: number; record: unknown }>(
      space,
      "stream-send-origin-transaction-result",
      undefined,
      tx,
    );
    runtime.run(tx, recorder, { value: 0 }, result);
    await tx.commit().settled;
    await runtime.idle();
    stream = result.key("record");

    // A client under server execution: a fire's durable act is the append.
    appended = [];
    const replica = storageManager.open(space).replica;
    replica.enqueueEventAppend = (entry) => {
      appended.push(entry.payload);
      return Promise.resolve({ delivered: true });
    };
    runtime.experimental.serverExecution = true;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("appends a fire with no transaction at once", () => {
    stream.send({ n: 1 });
    expect(appended).toEqual([{ n: 1 }]);
  });

  it("appends a fire made inside a transaction once that transaction commits", async () => {
    const tx = runtime.edit();
    stream.withTx(tx).send({ n: 2 });
    expect(appended).toEqual([]);
    await tx.commit().settled;
    await runtime.idle();
    expect(appended).toEqual([{ n: 2 }]);
  });

  it("appends nothing for a fire made inside a transaction that is aborted", async () => {
    const tx = runtime.edit();
    stream.withTx(tx).send({ n: 3 });
    tx.abort("the attempt runs again");
    await runtime.idle();
    expect(appended).toEqual([]);
  });

  it("appends one event when an edit's attempt is aborted and run again", async () => {
    // Stands in for `editWithRetry` running its callback a second time: the
    // first attempt's transaction is aborted, the second commits.
    for (const commit of [false, true]) {
      const tx = runtime.edit();
      stream.withTx(tx).send({ n: 4 });
      if (commit) await tx.commit().settled;
      else tx.abort("absent documents are present; the action re-runs");
    }
    await runtime.idle();
    expect(appended).toEqual([{ n: 4 }]);
  });

  it("appends a fire made while its transaction's commit is in flight once the commit lands", async () => {
    const tx = runtime.edit();
    // A write, so that the commit has a round trip to be in flight for.
    runtime.getCell<number>(
      space,
      "stream-send-origin-in-flight",
      undefined,
      tx,
    )
      .set(1);
    const commit = tx.commit();
    expect(tx.status().status).toBe("pending");
    stream.withTx(tx).send({ n: 5 });
    expect(appended).toEqual([]);
    await commit.settled;
    await runtime.idle();
    expect(appended).toEqual([{ n: 5 }]);
  });

  it("appends a fire made through a transaction that already committed at once", async () => {
    const tx = runtime.edit();
    await tx.commit().settled;
    stream.withTx(tx).send({ n: 6 });
    expect(appended).toEqual([{ n: 6 }]);
  });

  it("appends nothing for a fire made through a transaction that already failed", async () => {
    const tx = runtime.edit();
    tx.abort("the transaction failed before the fire");
    stream.withTx(tx).send({ n: 7 });
    await runtime.idle();
    expect(appended).toEqual([]);
  });

  it("leaves no intent outstanding and signals no outcome for a fire whose transaction is aborted", async () => {
    const outcomes: unknown[] = [];
    const stop = runtime.subscribeEventIntentOutcomes((outcome) => {
      outcomes.push(outcome);
    });
    const tx = runtime.edit();
    stream.withTx(tx).send({ n: 8 });
    tx.abort("the attempt runs again");
    await runtime.idle();
    stop();
    expect(outcomes).toEqual([]);
    expect(runtime.speculationOverlay?.pendingIntentCount).toBe(0);
  });

  it("appends a caller's event once, and signals no outcome, when an attempt aborted under its id runs again", async () => {
    // Stands in for `PieceController.edit()`, whose every attempt sends under
    // one caller event id.
    const outcomes: unknown[] = [];
    const stop = runtime.subscribeEventIntentOutcomes((outcome) => {
      outcomes.push(outcome);
    });
    const sendOptions = {
      eventId: "edit-attempt",
      session: "stream-send-origin-transaction",
    };
    for (const commit of [false, true]) {
      const tx = runtime.edit();
      sendEvent(stream.withTx(tx), { n: 9 }, undefined, sendOptions);
      if (commit) await tx.commit().settled;
      else tx.abort("absent documents are present; the action re-runs");
    }
    await runtime.idle();
    stop();
    expect(appended).toEqual([{ n: 9 }]);
    expect(outcomes).toEqual([]);
    expect(runtime.speculationOverlay?.pendingIntentCount).toBe(1);
  });

  it("reports nothing to the sender for an attempt whose transaction did not commit", async () => {
    // Stands in for the webhook forwarder, whose every `editWithRetry`
    // attempt sends with the same callbacks: the aborted attempt sent
    // nothing, so only the one that commits reports its append. Its served
    // outcome never comes here, with no server to consequence the event.
    const settled: string[] = [];
    const delivered: boolean[] = [];
    const appendedOnce = Promise.withResolvers<void>();
    for (const commit of [false, true]) {
      const tx = runtime.edit();
      sendEvent(
        stream.withTx(tx),
        { n: 11 },
        (settledTx) => settled.push(settledTx.status().status),
        {
          onAppended: (delivery) => {
            delivered.push(delivery.delivered);
            if (delivery.delivered) appendedOnce.resolve();
          },
        },
      );
      if (commit) await tx.commit().settled;
      else tx.abort("the attempt runs again");
    }
    await appendedOnce.promise;
    await runtime.idle();
    expect(appended).toEqual([{ n: 11 }]);
    expect(delivered).toEqual([true]);
    expect(settled).toEqual([]);
  });

  it("adds no pending commit while the sending transaction is open", async () => {
    const tx = runtime.edit();
    stream.withTx(tx).send({ n: 10 });
    expect(storageManager.hasPendingCommits()).toBe(false);
    await tx.commit().settled;
    expect(appended).toEqual([{ n: 10 }]);
  });
});
