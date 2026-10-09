import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  cellTx,
  markRuntimeInjectedEventKeys,
  sanitizeRuntimeInjectedEventKeys,
  sendEvent,
} from "../src/cell.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { scopeCallerEventId } from "../src/scheduler/event-identity.ts";
import { dispatchQueuedEvent } from "../src/scheduler/events.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  afterEach,
  beforeEach,
  type Cell,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  type IExtendedStorageTransaction,
  it,
  type JSONSchema,
  Runtime,
  type RuntimeTelemetryMarker,
  type SchedulerTestStorageManager,
  space,
} from "./scheduler-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
// The session a caller-supplied id is chosen within, for the sends whose
// subject is something else: the pair is what a stream send accepts, and one
// session is all a test needs whose ids never repeat across it.
const callerSession = "ses:scheduler-event-receipts";

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string };
};
type PublishTransactVerdict = (response: TransactResponse) => void;
type TestMemoryServer = {
  transact(
    message: TransactMessage,
    publishVerdict?: PublishTransactVerdict,
  ): Promise<TransactResponse>;
};

function emulatedServer(
  storageManager: SchedulerTestStorageManager,
): TestMemoryServer {
  return (storageManager as unknown as { server(): TestMemoryServer }).server();
}

function rejectNextServerTransact(
  storageManager: SchedulerTestStorageManager,
): () => void {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  let shouldReject = true;
  server.transact = async (message, publishVerdict) => {
    if (shouldReject) {
      shouldReject = false;
      const response: TransactResponse = {
        type: "response",
        requestId: message.requestId,
        error: {
          name: "ConflictError",
          message: "forced scheduler receipt test conflict",
        },
      };
      publishVerdict?.(response);
      return response;
    }
    return await original(message, publishVerdict);
  };

  return () => {
    server.transact = original;
  };
}

function delayNextServerTransact(
  storageManager: SchedulerTestStorageManager,
) {
  const server = emulatedServer(storageManager);
  const original = server.transact.bind(server);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let shouldDelay = true;

  server.transact = async (message, publishVerdict) => {
    if (!shouldDelay) return await original(message, publishVerdict);
    shouldDelay = false;
    started.resolve();
    await release.promise;
    return await original(message, publishVerdict);
  };

  return {
    started: started.promise,
    release: () => release.resolve(),
    restore: () => {
      server.transact = original;
    },
  };
}

/**
 * Await a signal the test itself resolves — a gate's deferred, a commit
 * callback. Deliberately no deadline: the package clock preload freezes
 * test-armed positive-delay timers, so a `setTimeout(reject, …)` race here
 * could never fire and would backstop nothing
 * (`docs/development/waiting-in-tests.md`). A signal that never arrives lets
 * the event loop quiesce, and Deno fails the pending wait at once, naming
 * the test; the label keeps the call site readable for whoever reads that
 * failure.
 */
async function waitForSignal(
  signal: Promise<void>,
  _label: string,
): Promise<void> {
  await signal;
}

async function waitForSchedulerCondition(
  runtime: Runtime,
  condition: () => boolean,
  message: string,
): Promise<void> {
  // Iteration-bounded, not wall-clock-bounded: zero-delay yields do not
  // advance the fake clock, so a time deadline could never expire and an
  // unreachable condition would spin forever — hanging the suite to the CI
  // job timeout with no test name. Each round drains the scheduler and
  // yields one real timer turn — transport pumps and the emulated server's
  // fan-out flush (which resolves awaited commits at marker coverage,
  // CT-1950) ride zero-delay timers, which are exempt from the fake clock's
  // test-armed freeze — so a condition the system will ever reach is reached
  // within a bounded number of rounds, and one it never reaches throws
  // `message` instead of hanging.
  for (let round = 0; round < 200 && !condition(); round++) {
    await runtime.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) {
    throw new Error(message);
  }
}

function collectEventCommitMarkers(runtime: Runtime): {
  markers: RuntimeTelemetryMarker[];
  dispose(): void;
} {
  const markers: RuntimeTelemetryMarker[] = [];
  const listener = (event: Event) => {
    const marker = (event as CustomEvent<{
      marker: RuntimeTelemetryMarker;
    }>).detail.marker;
    if (marker.type === "scheduler.event.commit") {
      markers.push(marker);
    }
  };
  runtime.telemetry.addEventListener("telemetry", listener);
  return {
    markers,
    dispose: () => runtime.telemetry.removeEventListener("telemetry", listener),
  };
}

function permanentRejection(
  marker: RuntimeTelemetryMarker,
): string | undefined {
  return (marker as { permanentRejection?: string }).permanentRejection;
}

function receiptCellForEvent<T>(
  runtime: Runtime,
  eventId: string,
): Cell<T> {
  return runtime.getCell<T>(
    space,
    { resultFor: { $ctx: {}, $event: eventId } },
  );
}

function resolvedStreamLink(streamCell: Cell<unknown>, runtime: Runtime) {
  return resolveLink(
    runtime,
    runtime.readTx(),
    streamCell.getAsNormalizedFullLink(),
  );
}

async function processNextQueuedEvent(runtime: Runtime): Promise<void> {
  const scheduler = runtime.scheduler.accessForTestingOnly;
  const queuedEvent = scheduler.eventQueue[0];
  if (queuedEvent !== undefined) {
    await dispatchQueuedEvent(scheduler.eventExecutionState, queuedEvent);
  }
}

describe("scheduler event receipts", () => {
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

  it("deduplicates redelivered events by create-only receipt", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const recordEvent = handler<
      { value: number },
      { effects: Cell<{ total: number }> }
    >(
      true,
      {
        type: "object",
        properties: { effects: { type: "object", asCell: ["cell"] } },
      },
      (event, { effects }) => {
        handlerInvocations++;
        const total = effects.key("total");
        total.set(total.get() + event.value);
      },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ total: 0 });
      const effectsTotal = lift(({ total }: { total: number }) => total)(
        effects,
      );
      return { effectsTotal, stream: recordEvent({ effects }) };
    });
    const rootCell = runtime.getCell<
      { effectsTotal: number; stream: unknown }
    >(
      space,
      "receipts redelivery root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:receipt-redelivery:0:receipts-redelivery-root";
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 1 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 1 },
        undefined,
        undefined,
        false,
        { eventId },
      );

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "redelivered event did not settle",
      );
      await root.key("effectsTotal").pull();

      expect(handlerInvocations).toBe(2);
      expect(root.key("effectsTotal").get()).toBe(1);
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);
    } finally {
      commitTelemetry.dispose();
    }
  });

  it("deduplicates redelivered pattern launches by receipt", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    const childPattern = pattern<{ value: number }>(({ value }) => {
      return { value };
    });
    let handlerInvocations = 0;
    const launchChild = handler<{ value: number }, Record<string, never>>(
      true,
      true,
      (event) => {
        handlerInvocations++;
        return childPattern({ value: event.value });
      },
    );
    const rootPattern = pattern(() => {
      return { stream: launchChild({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipts launch root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:receipt-launch:0:receipts-launch-root";
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 7 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 7 },
        undefined,
        undefined,
        false,
        { eventId },
      );

      const resultCell = receiptCellForEvent<{ value: number }>(
        runtime,
        eventId,
      );
      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "redelivered launch event did not settle",
      );
      await resultCell.pull();

      expect(handlerInvocations).toBe(2);
      expect(resultCell.get()).toEqual({ value: 7 });
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);
    } finally {
      commitTelemetry.dispose();
    }
  });

  it("keeps a deferred launch winner live after a concurrent receipt loser", async () => {
    const target = runtime.getCell<unknown>(
      space,
      "deferred receipt winner link",
      undefined,
      tx,
    );
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    const Child = pattern(() => {
      const state = cell(1);
      const doubled = lift((value: number) => value * 2)(state);
      return { state, doubled };
    });
    let handlerInvocations = 0;
    const launchChild = handler<
      { value: number },
      { target: Cell<unknown> }
    >(
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      {
        type: "object",
        properties: {
          target: { asCell: ["cell"] },
        },
        required: ["target"],
      },
      (_event, { target }) => {
        handlerInvocations++;
        const handlerTx = cellTx(target);
        if (handlerTx === undefined) {
          throw new Error("handler target must carry the dispatch transaction");
        }
        handlerTx.tx.immediate = true;
        (handlerTx.tx as { deferRunnerStartUntilCommit?: boolean })
          .deferRunnerStartUntilCommit = true;
        target.set(Child({}));
      },
    );
    const Root = pattern<{ target: Cell<unknown> }>(
      ({ target }) => ({ stream: launchChild({ target }) }),
      {
        type: "object",
        properties: { target: { asCell: ["cell"] } },
        required: ["target"],
      },
    );
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "deferred receipt winner liveness root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, Root, { target }, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();
    await runtime.scheduler.idleWithPendingCommits();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:deferred-winner-live:0:root";
    let cancelDoubled: (() => void) | undefined;
    const gate = delayNextServerTransact(storageManager);
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 7 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      await waitForSignal(
        gate.started,
        "first deferred receipt transaction did not start",
      );
      await runtime.scheduler.runningPromise;
      expect(handlerInvocations).toBe(1);

      runtime.scheduler.queueEvent(
        streamLink,
        { value: 7 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      // Dispatch the queued delivery directly while the first storage commit
      // is gated. This ownership regression needs the two commit callbacks in
      // a fixed order; scheduler preflight may legitimately settle or park the
      // second delivery after it observes the speculative first write.
      await processNextQueuedEvent(runtime);
      expect(handlerInvocations).toBe(2);

      // Let the second delivery commit first. Releasing the first transaction
      // then makes its receipt precondition lose against an already-live child.
      gate.release();

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "concurrent deferred receipt deliveries did not settle",
      );
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);

      await runtime.storageManager.synced();
      await target.sync();
      const winningChild = target.resolveAsCell() as Cell<{
        state: number;
        doubled: number;
      }>;
      cancelDoubled = winningChild.key("doubled").withTx(tx).sink(() => {});
      await runtime.settled();
      await winningChild.key("doubled").pull();
      await runtime.idle();
      expect(winningChild.key("state").get()).toBe(1);
      expect(winningChild.key("doubled").get()).toBe(2);

      // The receipt loser owns only its tombstoned deferred start. A later
      // write proves it did not stop the winner's long-lived computation.
      const updateTx = runtime.edit();
      winningChild.key("state").withTx(updateTx).set(4);
      runtime.prepareTxForCommit(updateTx);
      expect((await updateTx.commit().settled).error).toBeUndefined();
      await waitForSchedulerCondition(
        runtime,
        () => winningChild.key("doubled").get() === 8,
        "deferred receipt loser stopped the winner",
      );
      expect(winningChild.key("doubled").get()).toBe(8);
    } finally {
      gate.release();
      gate.restore();
      cancelDoubled?.();
      commitTelemetry.dispose();
    }
  });

  it("keeps a same-space launched winner live after a sequential receipt loser", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    const Child = pattern(() => {
      const state = cell({ value: 1 });
      const doubled = lift(({ value }: { value: number }) => value * 2)(state);
      return { state, doubled };
    });
    let handlerInvocations = 0;
    const launchChild = handler<unknown, Record<string, never>>(
      true,
      true,
      () => {
        handlerInvocations++;
        return Child({});
      },
    );
    const Root = pattern(() => ({ stream: launchChild({}) }));
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "same-space receipt winner liveness root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, Root, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:same-space-winner-live:0:root";
    let cancelDoubled: (() => void) | undefined;
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );
      await waitForSchedulerCondition(
        runtime,
        () =>
          handlerInvocations === 1 &&
          commitTelemetry.markers.some((marker) =>
            marker.type === "scheduler.event.commit" &&
            marker.error === undefined
          ),
        "same-space winner did not commit",
      );

      const resultCell = receiptCellForEvent<{
        state: { value: number };
        doubled: number;
      }>(runtime, eventId);
      cancelDoubled = resultCell.key("doubled").withTx(tx).sink(() => {});
      await runtime.idle();
      expect(resultCell.key("doubled").get()).toBe(2);

      // Redeliver only after the first receipt is confirmed. The duplicate may
      // invoke its handler, but it does not own the already-running wrapper and
      // must not register failure compensation that stops the winner.
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );
      await waitForSchedulerCondition(
        runtime,
        () =>
          handlerInvocations === 2 &&
          commitTelemetry.markers.some((marker) =>
            permanentRejection(marker) === "receipt-exists"
          ),
        "same-space duplicate did not lose its receipt",
      );

      const updateTx = runtime.edit();
      resultCell.key("state", "value").withTx(updateTx).set(3);
      runtime.prepareTxForCommit(updateTx);
      expect((await updateTx.commit().settled).error).toBeUndefined();
      await waitForSchedulerCondition(
        runtime,
        () => resultCell.key("doubled").get() === 6,
        "receipt loser stopped the same-space winner",
      );
      expect(resultCell.key("doubled").get()).toBe(6);
    } finally {
      cancelDoubled?.();
      commitTelemetry.dispose();
    }
  });

  it("uses one canonical handler-result cell for a cross-space launch receipt", async () => {
    const targetSpace = (await Identity.fromPassphrase(
      "cross-space receipt target",
    )).did();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    const Child = pattern<{ value: number }>(({ value }) => ({ value }));
    let handlerInvocations = 0;
    const launchChild = handler<
      { value: number },
      Record<string, never>
    >(true, true, (event) => {
      handlerInvocations++;
      Child.inSpace(targetSpace)({ value: event.value });
    });
    const rootPattern = pattern(() => ({ stream: launchChild({}) }));
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "cross-space receipt root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:cross-space-receipt:0:cross-space-receipt-root";
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 11 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      runtime.scheduler.queueEvent(
        streamLink,
        { value: 11 },
        undefined,
        undefined,
        false,
        { eventId },
      );

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "cross-space redelivery did not settle",
      );
      await runtime.storageManager.synced();

      const canonicalResult = receiptCellForEvent<unknown>(runtime, eventId);
      await canonicalResult.sync();
      const duplicateChildWrapper = runtime.getCell<unknown>(
        targetSpace,
        { resultFor: { $ctx: {}, $event: eventId } },
      );
      await duplicateChildWrapper.sync();

      // Decision 13: the create-only receipt is the result cell that hosts the
      // handler's launched pattern, not a separate empty witness beside a
      // second same-cause wrapper in the child space. The launched pattern is
      // hand-built (KEYLESS), so it writes no durable pattern pointer (the
      // never-durable contract, L3(a) RULED 2026-08-27); the setup evidence
      // that survives on the space-scoped receipt doc is the result-schema
      // meta its setup stages (the argument/value live on the launch's
      // scoped variant).
      expect(canonicalResult.getMetaRaw("schema")).toBeDefined();
      expect(canonicalResult.getMetaRaw("patternIdentity")).toBeUndefined();
      expect(
        duplicateChildWrapper.getMetaRaw("schema"),
      ).toBeUndefined();
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);
    } finally {
      commitTelemetry.dispose();
    }
  });

  it("does not rematerialize a live cross-space winner on sequential redelivery", async () => {
    const targetSpace = (await Identity.fromPassphrase(
      "cross-space sequential receipt winner target",
    )).did();
    const target = runtime.getCell<unknown>(
      targetSpace,
      "cross-space sequential receipt winner link",
      undefined,
      tx,
    );
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    const Child = pattern<{ launchedValue: number }>(({ launchedValue }) => {
      const ticks = cell({ value: 1 });
      const doubled = lift(({ value }: { value: number }) => value * 2)(ticks);
      return { launchedValue, ticks, doubled };
    });
    let handlerInvocations = 0;
    const launchChild = handler<
      Record<string, never>,
      { current: { value: number }; target: Cell<unknown> }
    >(
      { type: "object", properties: {} },
      {
        type: "object",
        properties: {
          current: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
          target: { asCell: ["cell"] },
        },
        required: ["current", "target"],
      },
      (_event, { current, target }) => {
        handlerInvocations++;
        target.set(
          Child.inSpace(targetSpace)({ launchedValue: current.value }),
        );
      },
    );
    const Root = pattern<{ target: Cell<unknown> }>(({ target }) => {
      const current = cell({ value: 1 });
      return { current, stream: launchChild({ current, target }) };
    }, {
      type: "object",
      properties: { target: { asCell: ["cell"] } },
      required: ["target"],
    });
    const rootCell = runtime.getCell<Record<string, unknown>>(
      space,
      "cross-space sequential receipt winner root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, Root, { target }, rootCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:cross-space-sequential-winner:0:root";
    let cancelChildDoubled: (() => void) | undefined;
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );
      await waitForSchedulerCondition(
        runtime,
        () =>
          handlerInvocations === 1 &&
          commitTelemetry.markers.some((marker) =>
            marker.type === "scheduler.event.commit" &&
            marker.error === undefined
          ),
        "cross-space winner did not commit",
      );
      await runtime.storageManager.synced();
      await target.sync();
      const firstChild = target.resolveAsCell();
      await firstChild.key("launchedValue").pull();
      cancelChildDoubled = firstChild.key("doubled").withTx(tx).sink(() => {});
      await runtime.idle();
      expect(firstChild.key("launchedValue").get()).toBe(1);
      expect(firstChild.key("doubled").get()).toBe(2);
      const firstChildLink = firstChild.getAsNormalizedFullLink();

      const contextTx = runtime.edit();
      root.key("current", "value").withTx(contextTx).set(2);
      runtime.prepareTxForCommit(contextTx);
      expect((await contextTx.commit().settled).error).toBeUndefined();

      // The same event id now observes different captured context. Because the
      // first receipt is already confirmed and its wrapper is live locally,
      // the duplicate must not run its newly-built result pattern into the
      // shared wrapper before the create-only guard rejects its parent commit.
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );
      await waitForSchedulerCondition(
        runtime,
        () =>
          handlerInvocations === 2 &&
          commitTelemetry.markers.some((marker) =>
            permanentRejection(marker) === "receipt-exists"
          ),
        "cross-space duplicate did not lose its receipt",
      );
      await runtime.storageManager.synced();
      await target.sync();

      const survivingChild = target.resolveAsCell();
      await survivingChild.key("launchedValue").pull();
      expect(survivingChild.getAsNormalizedFullLink()).toEqual(firstChildLink);
      expect(survivingChild.key("launchedValue").get()).toBe(1);

      // The duplicate also must not stop the shared canonical wrapper: its
      // child computations remain live after the receipt-exists rejection.
      const tickTx = runtime.edit();
      survivingChild.key("ticks", "value").withTx(tickTx).set(3);
      runtime.prepareTxForCommit(tickTx);
      expect((await tickTx.commit().settled).error).toBeUndefined();
      await waitForSchedulerCondition(
        runtime,
        () => Number(survivingChild.key("doubled").get()) === 6,
        "cross-space receipt loser stopped the winner's child",
      );
      expect(survivingChild.key("doubled").get()).toBe(6);
    } finally {
      cancelChildDoubled?.();
      commitTelemetry.dispose();
    }
  });

  it("retries transient conflicts with the same receipt id", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const recordEvent = handler<
      { value: number },
      { effects: Cell<{ total: number }> }
    >(
      true,
      {
        type: "object",
        properties: { effects: { type: "object", asCell: ["cell"] } },
      },
      (event, { effects }) => {
        handlerInvocations++;
        const total = effects.key("total");
        total.set(total.get() + event.value);
      },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ total: 0 });
      const effectsTotal = lift(({ total }: { total: number }) => total)(
        effects,
      );
      return { effectsTotal, stream: recordEvent({ effects }) };
    });
    const rootCell = runtime.getCell<
      { effectsTotal: number; stream: unknown }
    >(
      space,
      "receipts retry root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const restoreTransact = rejectNextServerTransact(storageManager);
    const eventId = "evt:receipt-retry:0:receipts-retry-root";
    try {
      runtime.scheduler.queueEvent(
        resolvedStreamLink(root.key("stream"), runtime),
        { value: 3 },
        undefined,
        undefined,
        false,
        { eventId },
      );

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2,
        "retrying receipt event did not commit",
      );
      await root.key("effectsTotal").pull();

      expect(handlerInvocations).toBe(2);
      expect(root.key("effectsTotal").get()).toBe(3);
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(false);
    } finally {
      restoreTransact();
      commitTelemetry.dispose();
    }
  });

  it("rejects redelivered idempotent handlers when all writes elide", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const setHandled = handler<
      unknown,
      { effects: Cell<{ handled: boolean }> }
    >(
      true,
      {
        type: "object",
        properties: { effects: { type: "object", asCell: ["cell"] } },
      },
      (_event, { effects }) => {
        handlerInvocations++;
        effects.key("handled").set(true);
      },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ handled: false });
      const handled = lift(({ handled }: { handled: boolean }) => handled)(
        effects,
      );
      return { handled, stream: setHandled({ effects }) };
    });
    const rootCell = runtime.getCell<{ handled: boolean; stream: unknown }>(
      space,
      "receipts idempotent root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const commitTelemetry = collectEventCommitMarkers(runtime);
    const eventId = "evt:receipt-idempotent:0:receipts-idempotent-root";
    try {
      const streamLink = resolvedStreamLink(root.key("stream"), runtime);
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );
      runtime.scheduler.queueEvent(
        streamLink,
        {},
        undefined,
        undefined,
        false,
        { eventId },
      );

      await waitForSchedulerCondition(
        runtime,
        () => handlerInvocations === 2 && commitTelemetry.markers.length >= 2,
        "idempotent redelivered event did not settle",
      );
      await root.key("handled").pull();

      expect(handlerInvocations).toBe(2);
      expect(root.key("handled").get()).toBe(true);
      expect(
        commitTelemetry.markers.some((marker) =>
          permanentRejection(marker) === "receipt-exists"
        ),
      ).toBe(true);
    } finally {
      commitTelemetry.dispose();
    }
  });

  it("cell.send carries a caller-supplied eventId and exposes the receipt link", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const noLaunch = handler<unknown, Record<string, never>>(true, true, () => {
      handlerInvocations++;
    });
    const rootPattern = pattern(() => {
      return { stream: noLaunch({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipts cell-send caller id root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    // Ingress-caller path (verb contract WS-D): the id and the session that
    // chose it ride cell.send's internal options instead of queueEvent
    // directly — the CLI's route.
    const eventId = "evt:receipt-cell-send:0:caller-id-root";
    const session = "ses:receipt-cell-send";
    const outcomes: Array<{
      status: string;
      precondition?: string;
      receiptLink?: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>;
    }> = [];
    const record = (t: IExtendedStorageTransaction) => {
      const status = t.status();
      outcomes.push({
        status: status.status,
        precondition: (status as { error?: { precondition?: string } }).error
          ?.precondition,
        receiptLink: t.handlingReceiptLink,
      });
    };
    const streamCell = root.key("stream") as Cell<unknown>;
    sendEvent(streamCell, {}, record, { eventId, session });
    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 1 && outcomes.length === 1,
      "cell-send event did not settle",
    );
    // Same id, same session: the body re-runs (exactly-once is per commit)
    // but the create-only receipt collides, and the loser's callback still
    // carries the SAME receipt address — the winner's original outcome.
    sendEvent(streamCell, {}, record, { eventId, session });
    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 2 && outcomes.length === 2,
      "cell-send redelivery did not settle",
    );
    await runtime.scheduler.idleWithPendingCommits();

    // The caller's id is scoped to its session and to the stream before it
    // becomes the durable event id, so the receipt address derives from the
    // scoped form.
    const expectedLink = receiptCellForEvent<Record<string, never>>(
      runtime,
      scopeCallerEventId(
        eventId,
        session,
        resolvedStreamLink(streamCell, runtime),
      ),
    ).getAsNormalizedFullLink();

    expect(outcomes[0].status).toBe("done");
    expect(outcomes[0].receiptLink?.id).toBe(expectedLink.id);
    expect(outcomes[0].receiptLink?.space).toBe(expectedLink.space);
    expect(outcomes[1].status).toBe("error");
    expect(outcomes[1].precondition).toBe("receipt-exists");
    expect(outcomes[1].receiptLink?.id).toBe(expectedLink.id);
  });

  it("two verbs sharing one caller-supplied id do not collide", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let incremented = 0;
    let decremented = 0;
    // Two distinct verbs with IDENTICAL input bindings (both bound {}) — the
    // shape the receipt cause cannot tell apart once $event is overwritten by
    // a caller-supplied id. A minted id embeds the stream link and keeps them
    // apart; a caller-supplied one must not lose that.
    const increment = handler<unknown, Record<string, never>>(
      true,
      true,
      () => {
        incremented++;
      },
    );
    const decrement = handler<unknown, Record<string, never>>(
      true,
      true,
      () => {
        decremented++;
      },
    );
    const rootPattern = pattern(() => ({
      increment: increment({}),
      decrement: decrement({}),
    }));
    const rootCell = runtime.getCell<
      { increment: unknown; decrement: unknown }
    >(space, "receipts cross-verb caller id root", undefined, tx);
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const outcomes: Array<{ status: string; precondition?: string }> = [];
    const record = (t: IExtendedStorageTransaction) => {
      const status = t.status();
      outcomes.push({
        status: status.status,
        precondition: (status as { error?: { precondition?: string } }).error
          ?.precondition,
      });
    };
    // The SAME caller id, from the same session, addressed at two different
    // verbs. Each is a distinct invocation of a distinct verb; neither may
    // deduplicate onto the other.
    const eventId = "caller-shared-id";
    const session = "ses:cross-verb";
    sendEvent(root.key("increment"), {}, record, {
      eventId,
      session,
    });
    await waitForSchedulerCondition(
      runtime,
      () => incremented === 1 && outcomes.length === 1,
      "increment did not settle",
    );
    sendEvent(root.key("decrement"), {}, record, {
      eventId,
      session,
    });
    await waitForSchedulerCondition(
      runtime,
      () => outcomes.length === 2,
      "decrement did not settle",
    );
    await runtime.scheduler.idleWithPendingCommits();

    expect(outcomes[0].status).toBe("done");
    expect(outcomes[1].precondition).toBeUndefined();
    expect(outcomes[1].status).toBe("done");
    expect(decremented).toBe(1);
  });

  it("two sessions sharing one caller-supplied id do not collide", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const addComment = handler<unknown, Record<string, never>>(
      true,
      true,
      () => {
        handlerInvocations++;
      },
    );
    const rootPattern = pattern(() => ({ stream: addComment({}) }));
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipts cross-session caller id root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const outcomes: Array<{
      status: string;
      precondition?: string;
      receiptLink?: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>;
    }> = [];
    const record = (t: IExtendedStorageTransaction) => {
      const status = t.status();
      outcomes.push({
        status: status.status,
        precondition: (status as { error?: { precondition?: string } }).error
          ?.precondition,
        receiptLink: t.handlingReceiptLink,
      });
    };
    // One word, two callers: an invocation id is the caller's own, and
    // `add-comment-1` is the word two agents both reach for. Each names one
    // invocation of one verb, and neither may deduplicate onto the other.
    const eventId = "add-comment-1";
    const streamCell = root.key("stream") as Cell<unknown>;
    sendEvent(streamCell, {}, record, { eventId, session: "ses:agent-one" });
    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 1 && outcomes.length === 1,
      "the first session's event did not settle",
    );
    sendEvent(streamCell, {}, record, { eventId, session: "ses:agent-two" });
    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 2 && outcomes.length === 2,
      "the second session's event did not settle",
    );
    await runtime.scheduler.idleWithPendingCommits();

    expect(outcomes[0].status).toBe("done");
    // The second commits its own handling rather than losing the race for a
    // receipt it has no call in, so it is told what its own call did.
    expect(outcomes[1].precondition).toBeUndefined();
    expect(outcomes[1].status).toBe("done");
    expect(outcomes[0].receiptLink?.id).toBeDefined();
    expect(outcomes[1].receiptLink?.id).not.toBe(outcomes[0].receiptLink?.id);
  });

  it("refuses a caller-supplied id sent without its session", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const noLaunch = handler<unknown, Record<string, never>>(true, true, () => {
      handlerInvocations++;
    });
    const rootPattern = pattern(() => ({ stream: noLaunch({}) }));
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipts unsessioned caller id root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    // Derived without one, the address would be reachable by anyone who
    // guessed the id, and the guarantee the id buys — a retry settling on
    // the original outcome — would be handed to whoever got there first.
    const streamCell = root.key("stream") as Cell<unknown>;
    expect(() =>
      sendEvent(streamCell, {}, undefined, { eventId: "add-comment-1" })
    )
      .toThrow(/requires the `session`/);
    await runtime.idle();
    // Refused at the send, so no delivery was queued for the handler.
    expect(handlerInvocations).toBe(0);
  });

  it("creates a receipt document for handlers that launch nothing", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const noLaunch = handler<unknown, Record<string, never>>(true, true, () => {
      handlerInvocations++;
    });
    const rootPattern = pattern(() => {
      return { stream: noLaunch({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipts no launch root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:receipt-empty:0:receipts-empty-root";
    runtime.scheduler.queueEvent(
      resolvedStreamLink(root.key("stream"), runtime),
      {},
      undefined,
      undefined,
      false,
      { eventId },
    );

    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 1,
      "receipt-only event did not run",
    );
    const resultCell = receiptCellForEvent<Record<string, never>>(
      runtime,
      eventId,
    );
    await resultCell.pull();

    expect(resultCell.get()).toEqual({});
  });

  it("projects a plain JSON return into the receipt under plainResultReceipts", async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { experimental: { plainResultReceipts: true } },
    ));
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const returnsPlain = handler<{ value: number }, Record<string, never>>(
      true,
      true,
      (event) => {
        handlerInvocations++;
        return { ok: true, n: event.value };
      },
    );
    // A value-less handler on the same board: its receipt must stay `{}`.
    const returnsNothing = handler<unknown, Record<string, never>>(
      true,
      true,
      () => {},
    );
    const rootPattern = pattern(() => {
      return { plain: returnsPlain({}), empty: returnsNothing({}) };
    });
    const rootCell = runtime.getCell<{ plain: unknown; empty: unknown }>(
      space,
      "plain result receipts root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const plainEventId = "evt:plain-receipt:0:plain-root";
    runtime.scheduler.queueEvent(
      resolvedStreamLink(root.key("plain"), runtime),
      { value: 42 },
      undefined,
      undefined,
      false,
      { eventId: plainEventId },
    );
    const emptyEventId = "evt:plain-receipt:1:plain-root";
    runtime.scheduler.queueEvent(
      resolvedStreamLink(root.key("empty"), runtime),
      {},
      undefined,
      undefined,
      false,
      { eventId: emptyEventId },
    );

    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 1,
      "plain-return event did not run",
    );
    await runtime.scheduler.idleWithPendingCommits();

    // The receipt carries the handler's normalized plain return — the verb's
    // result, readable back by receipt address (verb contract Part 2).
    const plainReceipt = receiptCellForEvent<Record<string, unknown>>(
      runtime,
      plainEventId,
    );
    await plainReceipt.pull();
    expect(plainReceipt.get()).toEqual({ ok: true, n: 42 });

    // Same-id redelivery with a DIFFERENT payload: the body re-runs (exactly-
    // once is per commit, not per execution) but loses the create-only race,
    // so the receipt retains the ORIGINAL result — the retry/readback promise
    // this flag exists to serve, and the first-payload-wins semantics the
    // verb-contract obligations record.
    runtime.scheduler.queueEvent(
      resolvedStreamLink(root.key("plain"), runtime),
      { value: 99 },
      undefined,
      undefined,
      false,
      { eventId: plainEventId },
    );
    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 2,
      "plain-return redelivery did not run",
    );
    await runtime.scheduler.idleWithPendingCommits();
    await plainReceipt.pull();
    expect(plainReceipt.get()).toEqual({ ok: true, n: 42 });

    // Value-less handlers keep the empty witness.
    const emptyReceipt = receiptCellForEvent<Record<string, never>>(
      runtime,
      emptyEventId,
    );
    await emptyReceipt.pull();
    expect(emptyReceipt.get()).toEqual({});
  });

  it("discards a plain JSON return while plainResultReceipts is explicitly off", async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { experimental: { plainResultReceipts: false } },
    ));
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const returnsPlain = handler<unknown, Record<string, never>>(
      true,
      true,
      () => {
        handlerInvocations++;
        return { dropped: true };
      },
    );
    const rootPattern = pattern(() => {
      return { stream: returnsPlain({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "plain result receipts default-off root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:plain-receipt-off:0:default-root";
    runtime.scheduler.queueEvent(
      resolvedStreamLink(root.key("stream"), runtime),
      {},
      undefined,
      undefined,
      false,
      { eventId },
    );

    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 1,
      "default-off plain-return event did not run",
    );
    const receipt = receiptCellForEvent<Record<string, never>>(
      runtime,
      eventId,
    );
    await receipt.pull();
    expect(receipt.get()).toEqual({});
  });

  it("allows redelivered events to commit twice while receipts are disabled", async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { experimental: { commitPreconditions: false } },
    ));

    const { commonfabric } = createTrustedBuilder(runtime);
    const { cell, handler, lift, pattern } = commonfabric;
    let handlerInvocations = 0;
    const recordEvent = handler<
      { value: number },
      { effects: Cell<{ total: number }> }
    >(
      true,
      {
        type: "object",
        properties: { effects: { type: "object", asCell: ["cell"] } },
      },
      (event, { effects }) => {
        handlerInvocations++;
        const total = effects.key("total");
        total.set(total.get() + event.value);
      },
    );
    const rootPattern = pattern(() => {
      const effects = cell({ total: 0 });
      const effectsTotal = lift(({ total }: { total: number }) => total)(
        effects,
      );
      return { effectsTotal, stream: recordEvent({ effects }) };
    });
    const rootCell = runtime.getCell<
      { effectsTotal: number; stream: unknown }
    >(
      space,
      "receipts flag off root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:receipt-flag-off:0:receipts-flag-off-root";
    const streamLink = resolvedStreamLink(root.key("stream"), runtime);
    runtime.scheduler.queueEvent(
      streamLink,
      { value: 5 },
      undefined,
      undefined,
      false,
      { eventId },
    );
    runtime.scheduler.queueEvent(
      streamLink,
      { value: 5 },
      undefined,
      undefined,
      false,
      { eventId },
    );

    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 2,
      "flag-off redelivery did not commit twice",
    );
    await root.key("effectsTotal").pull();

    expect(handlerInvocations).toBe(2);
    expect(root.key("effectsTotal").get()).toBe(10);
  });

  it("delivers a schema-missing payload as an absent event and still receipts it", async () => {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const seenEvents: unknown[] = [];
    const strictVerb = handler(
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      { type: "object", properties: {} },
      (event: { value: number } | undefined) => {
        handlerInvocations++;
        seenEvents.push(event);
      },
    );
    const rootPattern = pattern(() => ({ stream: strictVerb({}) }));
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "invalid payload receipt root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:invalid-payload:0:invalid-root";
    runtime.scheduler.queueEvent(
      resolvedStreamLink(root.key("stream"), runtime),
      { valu: 21 },
      undefined,
      undefined,
      false,
      { eventId },
    );
    await runtime.scheduler.idleWithPendingCommits();

    // `generateHandlerSchema` requires only `$ctx`, so a payload that misses
    // an OPEN event schema does not make the argument invalid — `$event`
    // simply reads back undefined. The body runs with no event and its
    // receipt spends the id, which is why a mismatched payload against an
    // open schema still has to be refused before it is ever dispatched. A
    // schema that declares `additionalProperties: false` opts into the
    // dispatch-side gate instead — see "closed-world event schemas at
    // dispatch" below.
    expect(handlerInvocations).toBe(1);
    expect(seenEvents).toEqual([undefined]);
    const receipt = receiptCellForEvent<Record<string, unknown>>(
      runtime,
      eventId,
    );
    await receipt.pull();
    expect(receipt.get()).toEqual({});
  });

  describe("closed-world event schemas at dispatch", () => {
    // The dispatch-side closed-world gate (verb contract WS-C, C5): an event
    // schema that declares `additionalProperties: false` makes an undeclared
    // field a rejection, never ignored. Characterized before the gate existed
    // (2026-07-31, this file's harness, unmodified code): the extra field was
    // silently STRIPPED — the handler ran, saw only the declared fields, and
    // the receipt spent the event id. The gate replaces that with the existing
    // thrown-handler outcome; an OPEN schema keeps the stripped delivery.

    function snapshotEvent(event: unknown): unknown {
      if (event === undefined) return undefined;
      if (!isObjectOrArray(event)) return event;
      return Object.fromEntries(
        Object.entries(event as Record<string, unknown>),
      );
    }

    function runClosedVerbRoot(rootName: string, eventSchema: JSONSchema) {
      const { commonfabric } = createTrustedBuilder(runtime);
      const { handler, pattern } = commonfabric;
      const observed = {
        invocations: 0,
        events: [] as unknown[],
      };
      const verb = handler(
        eventSchema,
        { type: "object", properties: {} },
        (event: unknown) => {
          observed.invocations++;
          observed.events.push(snapshotEvent(event));
        },
      );
      const rootPattern = pattern(() => ({ stream: verb({}) }));
      const rootCell = runtime.getCell<{ stream: unknown }>(
        space,
        rootName,
        undefined,
        tx,
      );
      const root = runtime.run(tx, rootPattern, {}, rootCell);
      return { root, observed };
    }

    it("rejects an undeclared extra field the way a thrown handler error fails", async () => {
      const { root, observed } = runClosedVerbRoot("closed extra-field root", {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      });
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const errors: string[] = [];
      runtime.scheduler.onError((error) => {
        errors.push(error.message);
      });

      const eventId = "evt:closed-extra:0:closed-extra-field-root";
      const commitStatus = new Promise<string>((resolve) => {
        runtime.scheduler.queueEvent(
          resolvedStreamLink(root.key("stream"), runtime),
          { value: 5, extra: 1 },
          undefined,
          (commitTx) => resolve(commitTx.status().status),
          false,
          { eventId },
        );
      });

      // The rejection is the handling's final outcome, delivered through the
      // existing thrown-handler path: the body never runs, the transaction
      // aborts, onError fires, and the commit callback settles errored.
      expect(await commitStatus).toBe("error");
      await runtime.idle();
      expect(observed.invocations).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("additional property extra");

      // No receipt was created, so the event id is NOT spent — a corrected
      // retry under the same id can still commit (unlike the pre-gate
      // behavior, where the stripped delivery receipted and spent it).
      const receipt = receiptCellForEvent<Record<string, unknown>>(
        runtime,
        eventId,
      );
      await receipt.pull();
      expect(receipt.get()).toBeUndefined();
    });

    it("delivers a valid payload against a closed event schema", async () => {
      const { root, observed } = runClosedVerbRoot("closed valid root", {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      });
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const eventId = "evt:closed-valid:0:closed-valid-root";
      runtime.scheduler.queueEvent(
        resolvedStreamLink(root.key("stream"), runtime),
        { value: 7 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      await runtime.scheduler.idleWithPendingCommits();

      expect(observed.invocations).toBe(1);
      expect(observed.events).toEqual([{ value: 7 }]);
      const receipt = receiptCellForEvent<Record<string, unknown>>(
        runtime,
        eventId,
      );
      await receipt.pull();
      expect(receipt.get()).toEqual({});
    });

    it("still fills defaults for a partial payload against a closed schema", async () => {
      // The measured table (#5147) must stay true under closure: a PRESENT
      // partial object is completed from defaults before `required` is
      // checked, which is why the gate judges the RELAXED schema — the
      // unrelaxed one would refuse a payload the runtime completes.
      const { root, observed } = runClosedVerbRoot("closed defaulted root", {
        type: "object",
        properties: {
          a: { type: "string", default: "fallback" },
          b: { type: "number", default: 7 },
        },
        required: ["a", "b"],
        additionalProperties: false,
      });
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const eventId = "evt:closed-defaulted:0:closed-defaulted-root";
      runtime.scheduler.queueEvent(
        resolvedStreamLink(root.key("stream"), runtime),
        { a: "supplied" },
        undefined,
        undefined,
        false,
        { eventId },
      );
      await runtime.scheduler.idleWithPendingCommits();

      expect(observed.invocations).toBe(1);
      expect(observed.events).toEqual([{ a: "supplied", b: 7 }]);
      const receipt = receiptCellForEvent<Record<string, unknown>>(
        runtime,
        eventId,
      );
      await receipt.pull();
      expect(receipt.get()).toEqual({});
    });

    it("keeps an absent payload deliverable against a closed schema", async () => {
      // Absence is the CLI gate's question (D5); server-side the measured
      // behavior is unchanged by closure: the handler runs with `undefined`
      // (defaults never materialize for an absent event) and the receipt
      // spends the id.
      const { root, observed } = runClosedVerbRoot("closed absent root", {
        type: "object",
        properties: { value: { type: "number", default: 3 } },
        required: ["value"],
        additionalProperties: false,
      });
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const eventId = "evt:closed-absent:0:closed-absent-root";
      runtime.scheduler.queueEvent(
        resolvedStreamLink(root.key("stream"), runtime),
        undefined,
        undefined,
        undefined,
        false,
        { eventId },
      );
      await runtime.scheduler.idleWithPendingCommits();

      expect(observed.invocations).toBe(1);
      expect(observed.events).toEqual([undefined]);
      const receipt = receiptCellForEvent<Record<string, unknown>>(
        runtime,
        eventId,
      );
      await receipt.pull();
      expect(receipt.get()).toEqual({});
    });

    it("exempts a runtime-injected key named by the send's provenance marker", async () => {
      // The LLM tool-call path sends `{ ...input, result: <cell> }` to a
      // handler tool and deliberately hides the slot from the advertised
      // schema (llm-dialog `stripInjectedResult`, CLI
      // `cloneWithoutBoundToolKeys`), so a closed schema that does not
      // declare `result` still receives it. The injection site names its key
      // through the send's internal options (`runtimeInjectedEventKeys`),
      // which travel out-of-band to the dispatch transaction — provenance,
      // not shape. The gate exempts exactly the marked keys; the handler
      // never sees the slot either way — the schema read path only delivers
      // declared fields.
      const { root, observed } = runClosedVerbRoot("closed injected root", {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      });
      const resultHolder = runtime.getCell<Record<string, unknown>>(
        space,
        "closed injected result holder",
        undefined,
        tx,
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const eventId = "evt:closed-injected:0:closed-injected-root";
      const streamCell = root.key("stream") as Cell<unknown>;
      const commitStatus = new Promise<string>((resolve) => {
        // Through cell.send so the payload takes the real dispatch shape
        // (convertCellsToLinks turns the cell into a link) and the marker
        // takes the real injection route (minted send option → queued event
        // → dispatch transaction).
        sendEvent(
          streamCell,
          { value: 7, result: resultHolder },
          (t: IExtendedStorageTransaction) => resolve(t.status().status),
          {
            eventId,
            session: callerSession,
            runtimeInjectedEventKeys: markRuntimeInjectedEventKeys(["result"]),
          },
        );
      });

      expect(await commitStatus).toBe("done");
      expect(observed.invocations).toBe(1);
      expect(observed.events).toEqual([{ value: 7 }]);
    });

    it("ignores an UNMINTED provenance marker — the option is a capability", async () => {
      // The marker's value must come from markRuntimeInjectedEventKeys
      // (runner-internal; no pattern compartment can import it — the sandbox
      // module map exposes only the commonfabric surface). A plain array —
      // exactly what any in-process or sandboxed caller could pass through
      // send options — is dropped at the stream-send chokepoint, so the
      // undeclared key is judged like any other and the send is refused.
      const { root, observed } = runClosedVerbRoot("closed unminted root", {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      });
      const holder = runtime.getCell<Record<string, unknown>>(
        space,
        "closed unminted holder",
        undefined,
        tx,
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const errors: string[] = [];
      runtime.scheduler.onError((error) => {
        errors.push(error.message);
      });

      const eventId = "evt:closed-unminted:0:closed-unminted-root";
      const streamCell = root.key("stream") as Cell<unknown>;
      const commitStatus = new Promise<string>((resolve) => {
        sendEvent(
          streamCell,
          { value: 7, result: holder },
          (t: IExtendedStorageTransaction) => resolve(t.status().status),
          {
            eventId,
            session: callerSession,
            runtimeInjectedEventKeys: ["result"],
          },
        );
      });

      expect(await commitStatus).toBe("error");
      await runtime.idle();
      expect(observed.invocations).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("additional property result");
    });

    it("delivers a marked key the schema DECLARES — the schema governs", async () => {
      // A handler that declares the injected slot asked for it: the marked
      // key is not stripped, the injected value is validated like any field
      // (the link is accepted opaquely), and the handler receives it.
      const { root, observed } = runClosedVerbRoot("closed declared root", {
        type: "object",
        properties: {
          value: { type: "number" },
          result: { asCell: ["cell"] },
        },
        required: ["value"],
        additionalProperties: false,
      });
      const declaredHolder = runtime.getCell<Record<string, unknown>>(
        space,
        "closed declared holder",
        undefined,
        tx,
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const eventId = "evt:closed-declared:0:closed-declared-root";
      const streamCell = root.key("stream") as Cell<unknown>;
      const commitStatus = new Promise<string>((resolve) => {
        sendEvent(
          streamCell,
          { value: 7, result: declaredHolder },
          (t: IExtendedStorageTransaction) => resolve(t.status().status),
          {
            eventId,
            session: callerSession,
            runtimeInjectedEventKeys: markRuntimeInjectedEventKeys(["result"]),
          },
        );
      });

      expect(await commitStatus).toBe("done");
      expect(observed.invocations).toBe(1);
      const delivered = observed.events[0] as Record<string, unknown>;
      expect(delivered.value).toBe(7);
      expect(Object.hasOwn(delivered, "result")).toBe(true);
    });

    it("rejects an UNMARKED result slot even when it carries a cell link", async () => {
      // Shape is not provenance: a caller cannot smuggle an undeclared key
      // past closed-world by supplying a link-valued `result` — only the
      // runtime's own injection site can mark the key, through the internal
      // send options that payload data can never express. Unmarked, the slot
      // is an undeclared field like any other.
      const { root, observed } = runClosedVerbRoot("closed forged root", {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      });
      const smuggled = runtime.getCell<Record<string, unknown>>(
        space,
        "closed forged smuggled holder",
        undefined,
        tx,
      );
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const errors: string[] = [];
      runtime.scheduler.onError((error) => {
        errors.push(error.message);
      });

      const eventId = "evt:closed-forged:0:closed-forged-root";
      const streamCell = root.key("stream") as Cell<unknown>;
      const commitStatus = new Promise<string>((resolve) => {
        sendEvent(
          streamCell,
          { value: 7, result: smuggled },
          (t: IExtendedStorageTransaction) => resolve(t.status().status),
          { eventId, session: callerSession },
        );
      });

      expect(await commitStatus).toBe("error");
      await runtime.idle();
      expect(observed.invocations).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("additional property result");
    });

    it("keeps stripping an extra field against an OPEN event schema", async () => {
      // The gate triggers only on a schema that DECLARES the closure.
      // Everything else keeps the characterized behavior: the schema read
      // path delivers the declared fields, ignores the rest, and receipts.
      // Generated event schemas are still open (the closed-world emission is
      // blocked on a pattern-update-gate migration — plan WS-C), so this is
      // the fleet-wide behavior until that lands.
      const { root, observed } = runClosedVerbRoot("open extra-field root", {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      });
      await tx.commit().settled;
      tx = runtime.edit();
      await root.pull();

      const eventId = "evt:open-extra:0:open-extra-field-root";
      runtime.scheduler.queueEvent(
        resolvedStreamLink(root.key("stream"), runtime),
        { value: 5, extra: 1 },
        undefined,
        undefined,
        false,
        { eventId },
      );
      await runtime.scheduler.idleWithPendingCommits();

      expect(observed.invocations).toBe(1);
      expect(observed.events).toEqual([{ value: 5 }]);
      const receipt = receiptCellForEvent<Record<string, unknown>>(
        runtime,
        eventId,
      );
      await receipt.pull();
      expect(receipt.get()).toEqual({});
    });
  });

  it("withholds the receipt address while receipts are disabled", async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
      { experimental: { commitPreconditions: false } },
    ));

    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, pattern } = commonfabric;
    let handlerInvocations = 0;
    const noop = handler<unknown, Record<string, never>>(true, true, () => {
      handlerInvocations++;
    });
    const rootPattern = pattern(() => ({ stream: noop({}) }));
    const rootCell = runtime.getCell<{ stream: unknown }>(
      space,
      "receipt link flag off root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const receiptLinks: Array<unknown> = [];
    const streamCell = root.key("stream") as Cell<unknown>;
    sendEvent(streamCell, {}, (t: IExtendedStorageTransaction) => {
      receiptLinks.push(t.handlingReceiptLink);
    }, {
      eventId: "evt:receipt-link-off:0:flag-off-root",
      session: callerSession,
    });

    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 1 && receiptLinks.length === 1,
      "flag-off send did not settle",
    );

    // No receipt is created or create-only marked while the flag is off, so
    // there is no address to hand back. Publishing one would advertise a
    // witness that does not exist.
    expect(receiptLinks).toEqual([undefined]);
  });
});

Deno.test("navigateTo handler results navigate once and deduplicate redelivery", async () => {
  const navSigner = await Identity.fromPassphrase(
    "receipts navigate operator",
  );
  const navSpace = navSigner.did();
  const storageManager = StorageManager.emulate({ as: navSigner });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { commitPreconditions: true },
    navigateCallback: (target) => {
      navigations.push(entityRefToString(target.entityId));
    },
  });
  let tx = runtime.edit();

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { NAME, handler, navigateTo, pattern } = commonfabric;

    const Target = pattern(() => ({
      [NAME]: "receipts navigate target",
    }));
    let handlerInvocations = 0;
    const openTarget = handler<Record<string, never>, Record<string, never>>(
      true,
      true,
      () => {
        handlerInvocations++;
        return navigateTo(Target({}));
      },
    );
    const rootPattern = pattern(() => {
      return { stream: openTarget({}) };
    });
    const rootCell = runtime.getCell<{ stream: unknown }>(
      navSpace,
      "receipts navigate root",
      undefined,
      tx,
    );
    const root = runtime.run(tx, rootPattern, {}, rootCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await root.pull();

    const eventId = "evt:receipt-navigate:0:receipts-navigate-root";
    const streamLink = resolveLink(
      runtime,
      runtime.readTx(),
      root.key("stream").getAsNormalizedFullLink(),
    );

    // First delivery: the receipt must not strangle the launch itself —
    // the deferred navigateTo start has to survive its own receipt mark.
    runtime.scheduler.queueEvent(
      streamLink,
      {},
      undefined,
      undefined,
      false,
      { eventId },
    );
    await waitForSchedulerCondition(
      runtime,
      () => navigations.length >= 1,
      "first navigateTo delivery did not navigate",
    );
    expect(handlerInvocations).toBe(1);
    expect(navigations.length).toBe(1);

    // Redelivery of the same event id: the receipt dedupes; no second
    // navigation.
    runtime.scheduler.queueEvent(
      streamLink,
      {},
      undefined,
      undefined,
      false,
      { eventId },
    );
    await waitForSchedulerCondition(
      runtime,
      () => handlerInvocations === 2,
      "redelivered navigateTo event did not run",
    );
    await runtime.idle();
    await runtime.idle();

    expect(navigations.length).toBe(1);
  } finally {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("sanitizeRuntimeInjectedEventKeys: malformed persisted carriage degrades to absent instead of throwing in the drain (verdict blocker, 2026-08-12)", () => {
  // Pre-fix the drain spread malformed carriage straight into the
  // mint: `[...42]` threw on EVERY scan pass — perpetual serving churn
  // from one poisoned entry. The sanitize maps malformed to absent;
  // well-formed carriage passes through for re-minting.
  expect(sanitizeRuntimeInjectedEventKeys(undefined)).toBe(undefined);
  expect(sanitizeRuntimeInjectedEventKeys(42)).toBe(undefined);
  expect(sanitizeRuntimeInjectedEventKeys("detail")).toBe(undefined);
  expect(sanitizeRuntimeInjectedEventKeys([1, 2])).toBe(undefined);
  expect(sanitizeRuntimeInjectedEventKeys({ keys: [] })).toBe(undefined);
  expect(sanitizeRuntimeInjectedEventKeys(null)).toBe(undefined);
  const wellFormed = ["detail", "result"];
  expect(sanitizeRuntimeInjectedEventKeys(wellFormed)).toEqual(wellFormed);
  // The sanitized value re-mints without throwing.
  expect(
    markRuntimeInjectedEventKeys(
      sanitizeRuntimeInjectedEventKeys(wellFormed)!,
    ),
  ).toEqual(wellFormed);
});
