import {
  type Action,
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  type IExtendedStorageTransaction,
  it,
  type Runtime,
  type SchedulerTestStorageManager,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";

describe("scheduler deferred demand", () => {
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

  it("waits for a child's output consumer while preserving ordinary sibling startup", async () => {
    const source = runtime.getCell<number>(space, "source", undefined, tx);
    const output = runtime.getCell<number>(space, "output", undefined, tx);
    const siblingOutput = runtime.getCell<number>(
      space,
      "sibling",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    siblingOutput.set(0);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();

    let childRuns = 0;
    let siblingRuns = 0;
    const child: Action = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        childRuns++;
        output.withTx(actionTx).set(source.withTx(actionTx).get() * 10);
      },
      { writes: [output.getAsNormalizedFullLink()] },
    );
    const sibling: Action = Object.assign(
      (actionTx: IExtendedStorageTransaction) => {
        siblingRuns++;
        siblingOutput.withTx(actionTx).set(1);
      },
      { writes: [siblingOutput.getAsNormalizedFullLink()] },
    );
    const cancellations: (() => void)[] = [];
    let cancelConsumer: (() => void) | undefined;
    const parent: Action = () => {
      cancellations.push(
        runtime.scheduler.subscribe(child, { deferUntilDemand: true }),
      );
      cancellations.push(runtime.scheduler.subscribe(sibling));
    };
    cancellations.push(runtime.scheduler.subscribe(parent, { isEffect: true }));
    try {
      await runtime.idle();
      expect(childRuns).toBe(0);
      expect(siblingRuns).toBe(1);
      expect(output.get()).toBe(0);
      cancelConsumer = output.sink(() => {});
      await runtime.idle();
      expect(childRuns).toBe(1);
      expect(output.get()).toBe(10);
      cancelConsumer();
      cancelConsumer = undefined;
      await runtime.idle();
      source.withTx(tx).set(2);
      expect((await tx.commit().settled).error).toBeUndefined();
      tx = runtime.edit();
      await runtime.idle();
      expect(childRuns).toBe(1);
      expect(await output.pull()).toBe(20);
      expect(childRuns).toBe(2);
    } finally {
      cancelConsumer?.();
      for (const cancel of cancellations) cancel();
    }
  });

  it("rejects effects and absent effective outputs before registering a computation", () => {
    const output = runtime.getCell<number>(
      space,
      "guard-output",
      undefined,
      tx,
    );
    const link = output.getAsNormalizedFullLink();
    const missing: Action = () => {};
    const ignored: Action = Object.assign(() => {}, {
      writes: [link],
      ignoredSchedulingWrites: [toMemorySpaceAddress(link)],
    });
    for (const action of [missing, ignored]) {
      expect(() =>
        runtime.scheduler.subscribe(action, { deferUntilDemand: true })
      )
        .toThrow("requires a declared write surface");
      expect(runtime.scheduler.isComputation(action)).toBe(false);
    }
    const effect: Action = Object.assign(() => {}, { writes: [link] });
    expect(() =>
      runtime.scheduler.subscribe(effect, {
        isEffect: true,
        deferUntilDemand: true,
      })
    )
      .toThrow("requires a computation");
    expect(runtime.scheduler.isEffect(effect)).toBe(false);
    expect(runtime.scheduler.isComputation(effect)).toBe(false);
    const cancel = runtime.scheduler.subscribe(effect, { isEffect: true });
    try {
      expect(() =>
        runtime.scheduler.subscribe(effect, { deferUntilDemand: true })
      )
        .toThrow("requires a computation");
      expect(runtime.scheduler.isEffect(effect)).toBe(true);
    } finally {
      cancel();
    }
    expect(() =>
      runtime.scheduler.subscribe(effect, { deferUntilDemand: true })
    ).toThrow("requires a computation");
    expect(runtime.scheduler.isEffect(effect)).toBe(false);
    expect(runtime.scheduler.isComputation(effect)).toBe(false);
  });
});
