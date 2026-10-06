import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import type { ChangeGroup } from "../src/storage/interface.ts";

describe("tx-carried source action identity", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("suppresses a computation's own commit by transaction source action", async () => {
    const value = runtime.getCell<number>(
      space,
      "tx-identity-self-value",
      undefined,
      tx,
    );
    value.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runs = 0;
    const valueAddress = toMemorySpaceAddress(value.getAsNormalizedFullLink());
    const action = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const current = value.withTx(actionTx).get();
        value.withTx(actionTx).set(current);
      }) as Action,
      {
        writes: [value.getAsNormalizedFullLink()],
      },
    );

    runtime.scheduler.subscribe(
      action,
      {
        reads: [valueAddress],
        shallowReads: [],
        writes: [valueAddress],
      },
      {},
    );

    const cancel = value.withTx(tx).sink(() => {});
    try {
      value.withTx(tx).set(1);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.scheduler.idle();
      expect(runs).toBe(1);

      value.withTx(tx).set(2);
      await tx.commit().settled;
      tx = runtime.edit();
      await runtime.scheduler.idle();
      expect(runs).toBe(2);
    } finally {
      cancel();
    }
  });

  it("does not starve sibling pull effects that share a diagnostic id", async () => {
    const source = runtime.getCell<number>(
      space,
      "tx-identity-shared-id-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "tx-identity-shared-id-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        const next = source.withTx(actionTx).get();
        output.withTx(actionTx).set(next * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );
    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );

    source.withTx(tx).set(2);
    await tx.commit().settled;
    tx = runtime.edit();

    // Guards P5's object-identity rule: these two actions share the
    // diagnostic id "pull:<uri>"; id-based suppression would starve one.
    const [first, second] = await Promise.all([
      output.pull(),
      output.pull(),
    ]);

    expect(first).toBe(20);
    expect(second).toBe(20);
  });

  it("keeps changeGroup suppression for external subscribers", async () => {
    const value = runtime.getCell<number>(
      space,
      "tx-identity-change-group",
      undefined,
      tx,
    );
    value.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const changeGroup = {} as ChangeGroup;
    const values: number[] = [];
    const cancel = value.sink((next) => {
      values.push(next);
    }, { changeGroup });
    try {
      await runtime.scheduler.idle();
      expect(values).toEqual([0]);

      const sameGroupTx = runtime.edit({ changeGroup });
      value.withTx(sameGroupTx).set(1);
      await sameGroupTx.commit().settled;
      await runtime.scheduler.idle();
      expect(values).toEqual([0]);

      const noGroupTx = runtime.edit();
      value.withTx(noGroupTx).set(2);
      await noGroupTx.commit().settled;
      await runtime.scheduler.idle();
      expect(values).toEqual([0, 2]);
    } finally {
      cancel();
    }
  });
});
