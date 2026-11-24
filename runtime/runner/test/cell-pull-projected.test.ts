/** Projected pulls demand only the reads made by their projection. */

import { hostValueOf, pullProjected } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  space,
  txToReactivityLog,
} from "./scheduler-test-utils.ts";

/** An event with an immediate producer and an independently dirty descendant. */
async function fixture() {
  const testRuntime = createSchedulerTestRuntime(import.meta.url);
  const { runtime, tx } = testRuntime;
  const source = runtime.getCell<number>(space, "source");
  const descendant = runtime.getCell<number>(space, "descendant");
  const immediate = runtime.getCell<{ scalar: number; descendant: number }>(
    space,
    "immediate",
  );
  const event = runtime.getCell<{ record: unknown }>(space, "event");
  source.withTx(tx).set(1);
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
  for (const action of [produceDescendant, produceImmediate]) {
    const setup = runtime.edit();
    action(setup);
    const log = txToReactivityLog(setup);
    await setup.commit().settled;
    runtime.scheduler.subscribe(action, log, { isEffect: false });
  }
  const update = runtime.edit();
  source.withTx(update).set(2);
  await update.commit().settled;
  await runtime.idle();
  runs.immediate = 0;
  runs.descendant = 0;
  return {
    runtime,
    source,
    event,
    descendant,
    runs,
    async [Symbol.asyncDispose]() {
      await disposeSchedulerTestRuntime(testRuntime);
    },
  };
}

describe("pullProjected()", () => {
  it("readies copied fields without demanding their recursive descendants", async () => {
    await using docs = await fixture();
    // Projected callbacks belong to hosts, not to the cells pattern code holds.
    expect("pullProjected" in docs.event).toBe(false);
    const result = await pullProjected(docs.event.asSchema(true), (value) => ({
      ...(value as { record: { scalar: number; descendant: number } }),
    }));

    expect(docs.runs.immediate).toBeGreaterThan(0);
    expect(docs.runs.descendant).toBe(0);
    // The returned view is fresh, rather than bound to the finished effect.
    expect(result.record.scalar).toBe(2);
    expect(await docs.descendant.pull()).toBe(200);
    expect(docs.runs.descendant).toBeGreaterThan(0);
  });

  it("demands nested values when the projection explicitly reads them", async () => {
    await using docs = await fixture();
    const result = await pullProjected(docs.event, hostValueOf);

    expect(result).toEqual({ record: { scalar: 2, descendant: 200 } });
    expect(docs.runs.immediate).toBeGreaterThan(0);
    expect(docs.runs.descendant).toBeGreaterThan(0);
  });

  it("releases demand after returning", async () => {
    await using docs = await fixture();
    await pullProjected(docs.event, hostValueOf);
    const runs = { ...docs.runs };
    const update = docs.runtime.edit();
    docs.source.withTx(update).set(3);
    await update.commit().settled;
    await docs.runtime.idle();

    expect(docs.runs).toEqual(runs);
  });
});
