import { Identity } from "@commonfabric/identity";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Cell } from "../src/cell.ts";
import { sendEvent } from "../src/cell.ts";
import { handlingCommittedBy } from "../src/handling-commit.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("handling commit seq");
const space = signer.did();

describe("handling-commit", () => {
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

  /** Runs a pattern exposing one handler, and returns its stream. */
  async function standUpStream(): Promise<Cell<unknown>> {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    const touch = handler<unknown, Record<string, never>>(
      true,
      true,
      () => {},
    );
    const rootPattern = pattern(() => ({ stream: touch({}) }));
    const tx = runtime.edit();
    const root = runtime.run(
      tx,
      rootPattern,
      {},
      runtime.getCell<{ stream: unknown }>(
        space,
        "handling commit root",
        undefined,
        tx,
      ),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    await root.pull();
    return root.key("stream") as Cell<unknown>;
  }

  /** Sends `eventId` to `stream` and returns the transaction its commit
   * callback received. */
  async function sendAndHandle(
    stream: Cell<unknown>,
    eventId: string,
  ): Promise<IExtendedStorageTransaction> {
    const handled = Promise.withResolvers<IExtendedStorageTransaction>();
    sendEvent(stream, {}, (tx) => handled.resolve(tx), {
      eventId,
      session: "ses:handling-commit",
    });
    await runtime.idle();
    return await handled.promise;
  }

  it("returns the sequence the handling committed its receipt at", async () => {
    const stream = await standUpStream();
    const tx = await sendAndHandle(stream, "evt:handling-commit:first");
    const seq = await handlingCommittedBy(runtime, tx);
    await runtime.scheduler.idleWithPendingCommits();

    const receipt = tx.handlingReceiptLink!;
    const stored = storageManager.open(receipt.space).replica.get({
      id: receipt.id,
      scope: receipt.scope,
    })?.since;
    expect(seq).toBeGreaterThan(0);
    expect(seq).toBe(stored);
  });

  it("returns the original handling's sequence for a redelivery refused as receipt-exists", async () => {
    const stream = await standUpStream();
    const first = await sendAndHandle(stream, "evt:handling-commit:repeat");
    const original = await handlingCommittedBy(runtime, first);
    await runtime.scheduler.idleWithPendingCommits();

    const repeat = await sendAndHandle(stream, "evt:handling-commit:repeat");
    const status = repeat.status();
    expect(status.status).toBe("error");
    expect(
      status.status === "error" && "precondition" in status.error
        ? status.error.precondition
        : undefined,
    ).toBe("receipt-exists");
    expect(repeat.committedSeq?.(space)).toBeUndefined();
    expect(await handlingCommittedBy(runtime, repeat)).toBe(original);
  });

  it("returns the later write for a redelivery once the receipt was written again, and the handling's own commit for the original transaction", async () => {
    const stream = await standUpStream();
    const first = await sendAndHandle(stream, "evt:handling-commit:edited");
    const original = await handlingCommittedBy(runtime, first);
    await runtime.scheduler.idleWithPendingCommits();

    const edit = runtime.edit();
    runtime.getCellFromLink(first.handlingReceiptLink!).withTx(edit).set({
      edited: true,
    });
    expect((await edit.commit().settled).error).toBeUndefined();
    const edited = edit.committedSeq!(space)!;

    const repeat = await sendAndHandle(stream, "evt:handling-commit:edited");
    expect(original).toBeLessThan(edited);
    expect(await handlingCommittedBy(runtime, repeat)).toBe(edited);
    expect(await handlingCommittedBy(runtime, first)).toBe(original);
  });

  it("returns undefined for a transaction that handled no event", async () => {
    const tx = runtime.edit();
    expect(await handlingCommittedBy(runtime, tx)).toBeUndefined();
    tx.abort();
  });
});
