// idle() consults the head event's park state while a wake timer is armed.
//
// waitForQuiescence has a branch that fires when a wake timer is pending and the
// event queue is non-empty: it asks whether the head event is parked (a
// time-gated retry, or a handler still loading) before deciding to keep idle()
// open. Reaching the head-park check needs two facts true at the same re-check —
// a wake timer armed and an event queued.
//
// This drives both from the real scheduler: a debounced computation that is
// invalidated after its first run arms the shared wake timer and waits, and an
// event queued against a piece stream sits in the queue until the next tick
// dispatches it. idle()'s first evaluation runs synchronously when called, so
// with the wake armed and the event still queued it takes the head-park check.

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
  Cell,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { resolveLink } from "../src/link-resolution.ts";

describe("idle consults head-event park with a wake timer armed", () => {
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

  it("evaluates the head-park branch with a debounce wake pending", async () => {
    // A debounced computation: reads `source`, writes `derived`. Once it has run
    // and is then invalidated, the scheduler arms the shared wake timer and
    // holds the re-run for the debounce window instead of running it now.
    const source = runtime.getCell<number>(
      space,
      "idle-park-source",
      undefined,
      tx,
    );
    const derived = runtime.getCell<number>(
      space,
      "idle-park-derived",
      undefined,
      tx,
    );
    source.set(0);
    derived.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    let runs = 0;
    const compute: Action = (actionTx) => {
      runs++;
      const value = (source.withTx(actionTx).get() ?? 0) as number;
      derived.withTx(actionTx).send(value + 1);
    };
    // A long debounce so the armed wake stays pending for the whole test rather
    // than firing mid-flight; it is cancelled when the runtime is disposed.
    const DEBOUNCE_MS = 30_000;
    runtime.scheduler.setDebounce(compute, DEBOUNCE_MS);
    runtime.scheduler.subscribe(compute, {
      reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(derived.getAsNormalizedFullLink())],
    }, {});
    // First run, so a later invalidation is a re-run the debounce can hold.
    await derived.pull();

    // An event handler on a separate piece; queuing an event puts it in the
    // queue for the next tick to dispatch.
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, pattern } = commonfabric;
    let invocations = 0;
    const bump = handler<
      { value: number },
      { effects: Cell<{ total: number }> }
    >(
      true,
      {
        type: "object",
        properties: { effects: { type: "object", asCell: ["cell"] } },
      },
      (event, { effects }) => {
        invocations++;
        const total = effects.key("total");
        total.set(total.get() + event.value);
      },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ total: 0 });
      return { effects, stream: bump({ effects }) };
    });
    const rootCell = runtime.getCell<
      { effects: { total: number }; stream: unknown }
    >(space, "idle-park-piece", undefined, tx);
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.idle();

    const streamLink = resolveLink(
      runtime,
      runtime.readTx(),
      root.key("stream").getAsNormalizedFullLink(),
    );

    // Invalidate the debounced computation: it has run once, so this arms the
    // shared wake timer and parks the re-run for the debounce window rather than
    // running it now. Drain the commit round trip with the clock held —
    // awaiting the commit under auto-advance would fire the armed wake (a
    // nominal delay is not a hold there), un-arming the very state under test.
    // The parked re-run is a pull computation that nothing demands, so
    // draining does not run it.
    source.withTx(tx).send(5);
    const invalidationCommit = tx.commit().settled;
    tx = runtime.edit();
    await clock.settle();
    await invalidationCommit;

    // Guard the coverage intent: the head-event park branch is only reached with
    // a wake timer pending, so fail loudly if the debounce did not arm one
    // rather than pass while silently skipping the branch under test.
    const gates = runtime.scheduler.accessForTestingOnly.gates;
    expect(gates.hasWakeTimer()).toBe(true);

    // Queue the event (now in the queue) and, in the same synchronous turn, ask
    // for idle. idle()'s first check sees the wake timer armed and the event
    // queued, so it evaluates the head-event park branch.
    runtime.scheduler.queueEvent(
      streamLink,
      { value: 3 },
      true,
      undefined,
      false,
      { eventId: "evt:idle-park:0:idle-park-piece" },
    );
    await runtime.idle();

    // The event converged while the wake timer was pending, and idle() returned
    // rather than hanging. The debounced re-run stays parked: idle() does not
    // wait for a pull computation that nothing is demanding, so `compute` has
    // still run only once and `derived` is unchanged.
    const total = (root.key("effects").key("total") as Cell<number>).get();
    expect(total).toBe(3);
    expect(invocations).toBe(1);
    expect(runs).toBe(1);
    expect(derived.get() ?? 0).toBe(1);
  });
});
