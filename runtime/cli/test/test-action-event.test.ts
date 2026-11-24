/** Action wrapping demands copied fields while leaving descendants cold. */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  type IExtendedStorageTransaction,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { pullActionEvent } from "../lib/test-action-event.ts";

/** An event with independently deferred immediate and descendant producers. */
async function fixture() {
  const signer = await Identity.fromPassphrase("test-action-event");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const source = runtime.getCell<number>(space, "source");
  const descendant = runtime.getCell<number>(space, "descendant");
  const immediate = runtime.getCell<{ scalar: number; descendant: number }>(
    space,
    "immediate",
  );
  const event = runtime.getCell<{ record: unknown }>(space, "event");
  source.withTx(tx).set(2);
  descendant.withTx(tx).set(0);
  immediate.withTx(tx).setRawUntyped({
    scalar: 0,
    descendant: descendant.getAsLink(),
  });
  event.withTx(tx).setRawUntyped({ record: immediate.getAsLink() });
  await tx.commit().settled;

  const runs = { immediate: 0, descendant: 0 };
  const produceDescendant = (tx: IExtendedStorageTransaction) => {
    runs.descendant++;
    descendant.withTx(tx).set(source.withTx(tx).get() * 100);
  };
  const produceImmediate = (tx: IExtendedStorageTransaction) => {
    runs.immediate++;
    immediate.withTx(tx).setRawUntyped({
      scalar: source.withTx(tx).get(),
      descendant: descendant.getAsLink(),
    });
  };
  runtime.scheduler.subscribe(
    Object.assign(produceDescendant, {
      writes: [descendant.getAsNormalizedFullLink()],
    }),
    { deferUntilDemand: true },
  );
  runtime.scheduler.subscribe(
    Object.assign(produceImmediate, {
      writes: [immediate.getAsNormalizedFullLink()],
    }),
    { deferUntilDemand: true },
  );
  await runtime.idle();
  return {
    runtime,
    source,
    event,
    descendant,
    runs,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

describe("test-action-event", () => {
  it("readies wrapper fields without demanding linked descendants", async () => {
    await using docs = await fixture();
    // Exercise the CLI's wrapper construction, beyond the runtime primitive's
    // projection tests, so a recursive pull here would demand the descendant.
    const result = await pullActionEvent(docs.event, {
      surface: "TestSurface",
      action: "Record",
    }) as { record: { scalar: number; descendant: number } };

    expect(docs.runs.immediate).toBeGreaterThan(0);
    expect(docs.runs.descendant).toBe(0);
    expect(result.record.scalar).toBe(2);
    expect(await docs.descendant.pull()).toBe(200);
    expect(docs.runs.descendant).toBeGreaterThan(0);
  });
});
