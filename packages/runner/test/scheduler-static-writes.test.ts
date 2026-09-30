import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import { entityKey } from "../src/scheduler/keys.ts";
import { forEachOverlappingWriter } from "../src/scheduler/scheduling-writes.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
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
  txToReactivityLog,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  ReactivityLog,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

const SCHEDULER_SIGNAL_TIMEOUT_MS = 5_000;

async function waitForSchedulerSignal<T>(
  signal: Promise<T>,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(message)),
          SCHEDULER_SIGNAL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function runActionOnce(
  runtime: Runtime,
  action: Action,
): Promise<ReactivityLog> {
  const actionTx = runtime.edit();
  action(actionTx);
  const log = txToReactivityLog(actionTx);
  runtime.prepareTxForCommit(actionTx);
  expect((await actionTx.commit()).error).toBeUndefined();
  return log;
}

// Identity entity keys resolve scoped addresses against (stage E).
const TEST_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};
const identityThunk = () => TEST_IDENTITY;

describe("static write surface demand", () => {
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

  it("keeps a declared writer dormant while its output has no demand", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-dormant-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-dormant-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        output.withTx(actionTx).send(value * 10);
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

    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(runs).toBe(0);
    expect(output.get()).toBe(0);
  });

  it("runs a declared writer when demand arrives at its output", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-demand-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-demand-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        output.withTx(actionTx).send(value * 10);
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

    source.withTx(tx).send(3);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();
    expect(runs).toBe(0);

    const observed = Promise.withResolvers<number>();
    const cancel = output.withTx(tx).sink((value) => {
      if (value === 30) observed.resolve(value);
    });
    try {
      const value = await waitForSchedulerSignal(
        observed.promise,
        "sink did not wake its dirty writer",
      );
      await runtime.scheduler.idle();

      expect(value).toBe(30);
      expect(runs).toBe(1);
      expect(output.get()).toBe(30);
    } finally {
      cancel();
    }
  });

  it("wakes a dirty transitive writer when demand returns through a clean writer", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-transitive-source",
      undefined,
      tx,
    );
    const middle = runtime.getCell<number>(
      space,
      "static-writes-transitive-middle",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-transitive-output",
      undefined,
      tx,
    );
    source.set(1);
    middle.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let sourceWriterRuns = 0;
    let outputWriterRuns = 0;
    const middleLink = middle.getAsNormalizedFullLink();
    const outputLink = output.getAsNormalizedFullLink();
    const sourceWriter = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        sourceWriterRuns++;
        middle.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      { writes: [middleLink] },
    );
    const outputWriter = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        outputWriterRuns++;
        output.withTx(actionTx).send(middle.withTx(actionTx).get());
      }) as Action,
      { writes: [outputLink] },
    );

    runtime.scheduler.subscribe(sourceWriter, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(middleLink)],
    }, {});
    runtime.scheduler.subscribe(outputWriter, {
      reads: [toMemorySpaceAddress(middleLink)],
      shallowReads: [],
      writes: [toMemorySpaceAddress(outputLink)],
    }, {});

    const firstObserved = Promise.withResolvers<number>();
    const cancelFirst = output.withTx(tx).sink((value) => {
      if (value === 10) firstObserved.resolve(value);
    });
    try {
      await waitForSchedulerSignal(
        firstObserved.promise,
        "initial transitive demand did not settle",
      );
      await runtime.scheduler.idle();
    } finally {
      cancelFirst();
    }
    expect(sourceWriterRuns).toBe(1);
    expect(outputWriterRuns).toBe(1);

    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    source.withTx(tx).send(2);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    await runtime.scheduler.idle();
    expect(sourceWriterRuns).toBe(1);
    expect(outputWriterRuns).toBe(1);
    expect(output.get()).toBe(10);

    const redemanded = Promise.withResolvers<number>();
    const cancelSecond = output.withTx(tx).sink((value) => {
      if (value === 20) redemanded.resolve(value);
    });
    try {
      const value = await waitForSchedulerSignal(
        redemanded.promise,
        "transitive dirty writer did not wake when demand returned",
      );
      await runtime.scheduler.idle();

      expect(value).toBe(20);
      expect(sourceWriterRuns).toBe(2);
      expect(outputWriterRuns).toBe(2);
      expect(output.get()).toBe(20);
    } finally {
      cancelSecond();
    }
  });

  it("wakes a dirty writer when an unsubscribed effect is reactivated", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-reactivate-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-reactivate-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writerRuns = 0;
    let effectRuns = 0;
    let expected = 10;
    let observed = Promise.withResolvers<number>();
    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        writerRuns++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      { writes: [outputLink] },
    );
    const effect = ((actionTx: IExtendedStorageTransaction) => {
      effectRuns++;
      const value = output.withTx(actionTx).get();
      if (value === expected) observed.resolve(value);
    }) as Action;

    runtime.scheduler.subscribe(writer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(outputLink)],
    }, {});

    let effectLog = await runActionOnce(runtime, effect);
    runtime.scheduler.resubscribe(effect, effectLog, { isEffect: true });
    try {
      await waitForSchedulerSignal(
        observed.promise,
        "initial effect activation did not wake its writer",
      );
      await runtime.scheduler.idle();
      expect(writerRuns).toBe(1);
      expect(effectRuns).toBe(2);
      runtime.scheduler.unsubscribe(effect);

      expect((await tx.commit()).error).toBeUndefined();
      tx = runtime.edit();
      source.withTx(tx).send(2);
      expect((await tx.commit()).error).toBeUndefined();
      tx = runtime.edit();
      await runtime.scheduler.idle();
      expect(writerRuns).toBe(1);
      expect(output.get()).toBe(10);

      expected = 20;
      observed = Promise.withResolvers<number>();
      effectLog = await runActionOnce(runtime, effect);
      runtime.scheduler.resubscribe(effect, effectLog, { isEffect: true });
      const value = await waitForSchedulerSignal(
        observed.promise,
        "reactivated effect did not wake its dirty writer",
      );
      await runtime.scheduler.idle();

      expect(value).toBe(20);
      expect(writerRuns).toBe(2);
      expect(effectRuns).toBe(4);
      expect(output.get()).toBe(20);
    } finally {
      runtime.scheduler.unsubscribe(effect);
    }
  });

  it("wakes an invalid dormant computation when it is promoted to an effect", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-promote-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-promote-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computationRuns = 0;
    const promotedObserved = Promise.withResolvers<number>();
    const outputLink = output.getAsNormalizedFullLink();
    const computation = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        computationRuns++;
        const value = source.withTx(actionTx).get() * 10;
        output.withTx(actionTx).send(value);
        if (value === 30) promotedObserved.resolve(value);
      }) as Action,
      { writes: [outputLink] },
    );

    runtime.scheduler.subscribe(computation, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(outputLink)],
    }, {});

    const initial = Promise.withResolvers<number>();
    const cancel = output.withTx(tx).sink((value) => {
      if (value === 10) initial.resolve(value);
    });
    try {
      await waitForSchedulerSignal(
        initial.promise,
        "initial computation demand did not settle",
      );
      await runtime.scheduler.idle();
    } finally {
      cancel();
    }
    expect(computationRuns).toBe(1);

    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    source.withTx(tx).send(2);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    await runtime.scheduler.idle();
    expect(computationRuns).toBe(1);
    expect(output.get()).toBe(10);
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

    const computationLog = await runActionOnce(runtime, computation);
    expect(output.get()).toBe(20);
    tx = runtime.edit();

    // The direct dependency changes after the manual run produced its log.
    // Resubscribe must preserve the concurrent invalid status and use the
    // action's false-to-true liveness transition to schedule another run.
    source.withTx(tx).send(3);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    expect(runtime.scheduler.isDirty(computation)).toBe(true);

    runtime.scheduler.resubscribe(computation, computationLog, {
      isEffect: true,
    });
    try {
      const value = await waitForSchedulerSignal(
        promotedObserved.promise,
        "promoted effect did not wake itself after concurrent invalidation",
      );
      await runtime.scheduler.idle();

      expect(value).toBe(30);
      expect(computationRuns).toBe(3);
      expect(output.get()).toBe(30);
    } finally {
      runtime.scheduler.unsubscribe(computation);
    }
  });

  it("wakes dirty upstream work when an annotated materializer is restored", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-materializer-source",
      undefined,
      tx,
    );
    const intermediate = runtime.getCell<number>(
      space,
      "static-writes-materializer-intermediate",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-materializer-output",
      undefined,
      tx,
    );
    source.set(1);
    intermediate.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writerRuns = 0;
    let materializerRuns = 0;
    const observed = Promise.withResolvers<number>();
    const intermediateLink = intermediate.getAsNormalizedFullLink();
    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        writerRuns++;
        intermediate.withTx(actionTx).send(
          source.withTx(actionTx).get() * 10,
        );
      }) as Action,
      { writes: [intermediateLink] },
    );
    const materializer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        materializerRuns++;
        const value = intermediate.withTx(actionTx).get();
        output.withTx(actionTx).send(value);
        if (value === 20) observed.resolve(value);
      }) as Action,
      { materializerWriteEnvelopes: [outputLink] },
    ) as Action & {
      materializerWriteEnvelopes: ReturnType<
        typeof output.getAsNormalizedFullLink
      >[];
    };

    runtime.scheduler.subscribe(writer, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(intermediateLink)],
    }, {});
    runtime.scheduler.subscribe(materializer, {
      reads: [toMemorySpaceAddress(intermediateLink)],
      shallowReads: [],
      writes: [toMemorySpaceAddress(outputLink)],
    }, {});
    await runtime.scheduler.idle();
    expect(writerRuns).toBe(1);
    expect(materializerRuns).toBe(1);
    expect(output.get()).toBe(10);

    runtime.scheduler.unsubscribe(materializer);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    source.withTx(tx).send(2);
    expect((await tx.commit()).error).toBeUndefined();
    tx = runtime.edit();
    await runtime.scheduler.idle();
    expect(writerRuns).toBe(1);
    expect(intermediate.get()).toBe(10);
    expect(runtime.scheduler.isDirty(writer)).toBe(true);

    const materializerLog = await runActionOnce(runtime, materializer);
    expect(output.get()).toBe(10);
    tx = runtime.edit();

    runtime.scheduler.resubscribe(materializer, materializerLog);
    try {
      const value = await waitForSchedulerSignal(
        observed.promise,
        "restored materializer did not wake its dirty upstream writer",
      );
      await runtime.scheduler.idle();

      expect(value).toBe(20);
      expect(writerRuns).toBe(2);
      expect(materializerRuns).toBe(3);
      expect(output.get()).toBe(20);
    } finally {
      runtime.scheduler.unsubscribe(materializer);
    }
  });

  it("does not warn for scoped-slot writes outside the declared surface", async () => {
    getLogger("scheduler").resetCounts();
    const source = runtime.getCell<number>(
      space,
      "static-writes-scoped-source",
      undefined,
      tx,
    );
    const declared = runtime.getCell<number>(
      space,
      "static-writes-scoped-declared",
      undefined,
      tx,
    );
    const scopedTarget = runtime.getCell<number>(
      space,
      "static-writes-scoped-target",
      undefined,
      tx,
    );
    source.set(1);
    declared.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Per-user/per-session slots are runtime-mediated (scope defaults,
    // UI state) and not part of the authored surface; the declaration-gap
    // diagnostic must not flag them.
    const scopedLink = {
      ...scopedTarget.getAsNormalizedFullLink(),
      scope: "session" as const,
    };
    let runs = 0;
    const declaredLink = declared.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        runtime.getCellFromLink<number>(scopedLink, undefined, actionTx)
          .send(value);
      }) as Action,
      {
        writes: [declaredLink],
      },
    );

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredLink)],
      },
      {},
    );

    const cancel = declared.withTx(tx).sink(() => {});
    try {
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(runs).toBe(1);
      expect(
        getLoggerCountsBreakdown().scheduler?.["write-surface-violation"]
          ?.debug ?? 0,
      ).toBe(0);
    } finally {
      cancel();
      getLogger("scheduler").resetCounts();
    }
  });

  it("warns when a computation writes outside its declared surface", async () => {
    getLogger("scheduler").resetCounts();
    const source = runtime.getCell<number>(
      space,
      "static-writes-violation-source",
      undefined,
      tx,
    );
    const declared = runtime.getCell<number>(
      space,
      "static-writes-violation-declared",
      undefined,
      tx,
    );
    const undeclared = runtime.getCell<number>(
      space,
      "static-writes-violation-undeclared",
      undefined,
      tx,
    );
    source.set(1);
    declared.set(0);
    undeclared.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const declaredLink = declared.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        undeclared.withTx(actionTx).send(value);
      }) as Action,
      {
        writes: [declaredLink],
      },
    );

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredLink)],
      },
      {},
    );

    const cancel = declared.withTx(tx).sink(() => {});
    try {
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(runs).toBe(1);
      expect(undeclared.get()).toBe(2);
      expect(
        getLoggerCountsBreakdown().scheduler?.["write-surface-violation"]
          ?.debug,
      ).toBe(1);
    } finally {
      cancel();
      getLogger("scheduler").resetCounts();
    }
  });
});

describe("overlapping writers", () => {
  it("stops overlapping-writer scans early for recursive and shallow reads", () => {
    const first: Action = function firstOverlappingWriter() {};
    const second: Action = function secondOverlappingWriter() {};
    const address: IMemorySpaceAddress = {
      space: "did:key:overlapping-writer-scan",
      scope: "space",
      id: "of:shared",
      path: ["value"],
    };
    const writes = new WeakMap<Action, IMemorySpaceAddress[]>([
      [first, [address]],
      [second, [address]],
    ]);
    const state = {
      scopeKeyIdentity: identityThunk,
      writersByEntity: new Map([[
        entityKey(address, TEST_IDENTITY),
        new Set([first, second]),
      ]]),
      getSchedulingWrites: (action: Action) => writes.get(action),
    };

    for (const shallow of [false, true]) {
      const visited: Action[] = [];
      forEachOverlappingWriter(
        state,
        shallow ? [] : [address],
        shallow ? [address] : [],
        (writer) => {
          visited.push(writer);
          return true;
        },
      );
      expect(visited).toEqual([first]);
    }
  });
});
