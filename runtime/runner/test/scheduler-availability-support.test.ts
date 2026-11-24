import type { Action, EventHandler } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getCellWithStatus } from "../src/cell.ts";
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
} from "./scheduler-test-utils.ts";
import type {
  Cell,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("availability scheduler support", () => {
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

  it("settles only live scheduler actions and wakes materializers", async () => {
    const scheduler = runtime.scheduler;
    const unregistered: Action = () => {};
    const unregisteredToken = scheduler.withExecutingAction(
      unregistered,
      () => scheduler.getExecutingActionToken(),
    );

    expect(unregisteredToken).toBeDefined();
    expect(
      scheduler.scheduleExternalDependencySettlement(unregisteredToken!),
    ).toBe(false);

    const output = runtime.getCell<number>(
      space,
      "external-settlement-materializer-output",
      undefined,
      tx,
    );
    output.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runs = 0;
    const materializer = Object.assign(
      () => {
        runs++;
      },
      { materializerWriteEnvelopes: [output.getAsNormalizedFullLink()] },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof output.getAsNormalizedFullLink
      >[];
    };
    scheduler.subscribe(materializer, {
      reads: [],
      shallowReads: [],
      writes: [],
    });
    await scheduler.idle();
    expect(runs).toBe(1);

    const materializerToken = scheduler.withExecutingAction(
      materializer,
      () => scheduler.getExecutingActionToken(),
    );
    expect(materializerToken).toBeDefined();
    expect(
      scheduler.scheduleExternalDependencySettlement(materializerToken!),
    ).toBe(true);
    await scheduler.idle();
    expect(runs).toBe(2);
  });

  it("clears an input-parked event watcher during disposal", async () => {
    const eventStream = runtime.getCell<number>(
      space,
      "dispose-input-park-event",
      undefined,
      tx,
    );
    const ready = runtime.getCell<boolean>(
      space,
      "dispose-input-park-ready",
      undefined,
      tx,
    );
    eventStream.set(0);
    ready.set(false);
    await tx.commit().settled;
    tx = runtime.edit();

    let handlerRuns = 0;
    const handler: EventHandler = Object.assign(
      () => {
        handlerRuns++;
      },
      {
        inputReadiness: (readTx: IExtendedStorageTransaction) =>
          ready.withTx(readTx).get()
            ? { ready: true as const }
            : { ready: false as const, reason: "pending" as const },
      },
    );
    runtime.scheduler.addEventHandler(
      handler,
      eventStream.getAsNormalizedFullLink(),
      (readTx) => ready.withTx(readTx).get(),
    );
    runtime.scheduler.queueEvent(eventStream.getAsNormalizedFullLink(), 1);
    await runtime.scheduler.idle();
    expect(handlerRuns).toBe(0);

    runtime.scheduler.dispose();
    expect(handlerRuns).toBe(0);
  });

  it("rejects status reads for foreign Cell implementations", () => {
    expect(() => getCellWithStatus({} as Cell<unknown>)).toThrow(
      "Expected a runner cell",
    );
  });
});
