import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { Action, EventHandler } from "../src/scheduler.ts";
import type { ServedEventFailureOutcome } from "../src/scheduler/types.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ReplicaLoadFailureError } from "../src/storage/interface.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

type TransactError = {
  name: string;
  message: string;
  permanentEvidence?: true;
  aclRevision?: number;
};

function rejectNextTransact(
  runtime: SchedulerTestRuntime["runtime"],
  error: TransactError,
): () => void {
  type Response = {
    type: "response";
    requestId: string;
    error: TransactError;
  };
  const server = (runtime.storageManager as unknown as {
    server(): {
      transact(
        message: { requestId: string },
        publish?: (response: Response) => void,
      ): Promise<Response>;
    };
  }).server();
  const original = server.transact.bind(server);
  let armed = true;
  server.transact = (message, publish) => {
    if (!armed) return original(message, publish);
    armed = false;
    const response: Response = {
      type: "response",
      requestId: message.requestId,
      error,
    };
    publish?.(response);
    return Promise.resolve(response);
  };
  return () => {
    server.transact = original;
  };
}

describe("event dispatch parks on in-flight closure loads", () => {
  // CT-1795: a handler must not dispatch against a provisional snapshot while a
  // replica load for an address in its read closure is still in flight.
  //
  // The wish shape: a computation reads a cold document (the wish kicks a
  // fire-and-forget pull and settles CLEAN on a provisional value), and a
  // handler's closure reads through that computation's output. The graph is
  // eventually correct — the load's arrival re-invalidates the computation
  // through the one channel — but the handler is at-most-once (D7), so its
  // dispatch must park until the closure's in-flight loads complete (a
  // definitively absent doc counts as complete). The wake source is load
  // completion, mirroring the lineage park's callback wake.

  let env: SchedulerTestRuntime;
  let releaseHeldSync: (() => void) | undefined;

  beforeEach(() => {
    env = createSchedulerTestRuntime(import.meta.url);
  });

  afterEach(async () => {
    releaseHeldSync?.();
    await disposeSchedulerTestRuntime(env);
  });

  // Delay provider.sync for one document id until the returned release fires;
  // every other sync passes through untouched. This pins the in-flight-load
  // window deterministically instead of racing a real network.
  function holdSyncFor(id: string): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    const manager = env.storageManager as unknown as {
      open: (space: string) => {
        sync: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const originalOpen = manager.open.bind(manager);
    manager.open = (openSpace: string) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, prop, receiver) {
          if (prop === "sync") {
            return async (syncId: unknown, ...rest: unknown[]) => {
              if (syncId === id) await promise;
              return (target.sync as (...a: unknown[]) => Promise<unknown>)(
                syncId,
                ...rest,
              );
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    releaseHeldSync = resolve;
    return resolve;
  }

  function observeNextLoadPark(): Promise<void> {
    const manager = env.storageManager as unknown as {
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    const original = manager.loadsSettled.bind(manager);
    const observed = Promise.withResolvers<void>();
    manager.loadsSettled = (keys) => {
      observed.resolve();
      return original(keys);
    };
    return observed.promise;
  }

  it("parks the head event until the closure's load completes, then dispatches once", async () => {
    const { runtime, tx } = env;
    // The cold document (never written — the load completes "absent"), the
    // wish-like computation's output, and the event stream link.
    const coldDoc = runtime.getCell<string>(space, "load-park-cold", undefined);
    const result = runtime.getCell<string>(
      space,
      "load-park-result",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "load-park-events",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    // Wish-like computation: reads the cold doc, settles clean on a
    // provisional value while the load is still in flight.
    let computationRuns = 0;
    const wishLike: Action = (actionTx: IExtendedStorageTransaction) => {
      computationRuns++;
      const value = coldDoc.withTx(actionTx).get();
      result.withTx(actionTx).send(value ?? "");
    };
    runtime.scheduler.subscribe(wishLike, {
      reads: [toMemorySpaceAddress(coldDoc.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
    }, {});

    // Handler whose closure reads the computation's output.
    let handlerRuns = 0;
    const handler: EventHandler = (actionTx) => {
      handlerRuns++;
      result.withTx(actionTx).get();
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => {
        result.withTx(depTx).get();
      },
    );

    // The load is in flight before the event arrives (the wish's
    // fire-and-forget pull); hold it open.
    const release = holdSyncFor(coldDoc.getAsNormalizedFullLink().id);
    const loadInFlight = runtime.storageManager.syncCell(coldDoc)
      .catch(() => {});
    // The park is observed from inside the event phase of the pass that
    // registers it, and that pass goes on to settle. Its settle marker is
    // the first one after the park, so listen from before the event.
    let parkObserved = false;
    const parkingPassSettled = Promise.withResolvers<void>();
    const onTelemetry = (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (parkObserved && marker.type === "scheduler.settle") {
        parkingPassSettled.resolve();
      }
    };
    runtime.telemetry.addEventListener("telemetry", onTelemetry);
    const loadParkObserved = observeNextLoadPark().then(() => {
      parkObserved = true;
    });

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);

    // The preflight runs the never-ran computation first. On the following
    // pass it registers the load park; that is the barrier awaited here,
    // with no deadline. A park that never comes lets the event loop
    // quiesce, and Deno fails the pending wait, naming the test.
    await loadParkObserved;
    expect(computationRuns).toBeGreaterThanOrEqual(1);
    expect(handlerRuns, "handler must not dispatch while the load is in flight")
      .toBe(0);

    // An unrelated scheduler wake while the load is still pending must observe
    // the parked head rather than re-running its dependency preflight or
    // dispatching through it. A queued wake runs only after the pass that
    // parked the head has settled, so wait for that, then run the pass
    // directly: its end is the pass's own promise.
    try {
      await parkingPassSettled.promise;
    } finally {
      runtime.telemetry.removeEventListener("telemetry", onTelemetry);
    }
    await runtime.scheduler.accessForTestingOnly.execute();
    expect(handlerRuns, "a scheduler re-tick must keep the parked head blocked")
      .toBe(0);

    // Load completes (absent counts as complete) → the park wakes and the
    // handler dispatches exactly once.
    release();
    await loadInFlight;
    await runtime.idle();
    expect(handlerRuns).toBe(1);

    // No residual re-dispatch.
    await runtime.idle();
    expect(handlerRuns).toBe(1);
  });

  it("drops once when a required load fails instead of dispatching fail-open", async () => {
    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(
      space,
      "load-park-failure-cold",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "load-park-failure-event",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    let handlerRuns = 0;
    let callbackRuns = 0;
    let callbackStatus: string | undefined;
    const handler: EventHandler = () => {
      handlerRuns++;
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => coldDoc.withTx(depTx).get(),
    );

    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    const load = Promise.withResolvers<void>();
    const parkObserved = Promise.withResolvers<void>();
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () => [{
      space: link.space,
      scope: link.scope,
      id: link.id,
    }];
    manager.pendingLoadGeneration = (candidate) =>
      candidate === key ? 1 : undefined;
    manager.loadsSettled = () => {
      parkObserved.resolve();
      return load.promise;
    };

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      (commitTx) => {
        callbackRuns++;
        callbackStatus = commitTx.status().status;
      },
    );
    await parkObserved.promise;
    expect(handlerRuns).toBe(0);

    load.reject(new Error("replica unavailable"));
    await runtime.idle();
    expect(handlerRuns).toBe(0);
    expect(callbackRuns).toBe(1);
    expect(callbackStatus).toBe("error");
    await runtime.idle();
    expect(callbackRuns).toBe(1);
  });

  it("a SERVED event's load-park failure reaches the drain as a load-park DEFERRAL, not a drop", async () => {
    // The SERVED counterpart of the test above, and the reason the two
    // arms differ (verification-coverage.md's OW45 residue member): a
    // client event has no durable entry, so its load-park failure has
    // nowhere to be re-delivered from and keeps the terminal drop. A
    // SERVED event's entry IS durable, so the same failure must reach the
    // drain as a DEFERRAL — no consequence sealed, the entry left pending
    // for a later drain. events.md §5's T3 predicate is "no runnable
    // handler", never "the run raced", and a transient read failure over
    // a doc that exists durably is the second. This pins the contract the
    // SpaceServer's `onFailure` branches on; the end-to-end consequence,
    // ordering, and exactly-once behaviour live in
    // executor-events-down.test.ts.

    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(
      space,
      "load-park-served-cold",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "load-park-served-event",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    let handlerRuns = 0;
    const handler: EventHandler = () => {
      handlerRuns++;
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => coldDoc.withTx(depTx).get(),
    );

    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    const load = Promise.withResolvers<void>();
    const parkObserved = Promise.withResolvers<void>();
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () => [{
      space: link.space,
      scope: link.scope,
      id: link.id,
    }];
    manager.pendingLoadGeneration = (candidate) =>
      candidate === key ? 1 : undefined;
    manager.loadsSettled = () => {
      parkObserved.resolve();
      return load.promise;
    };

    const outcomes: unknown[] = [];
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      true,
      undefined,
      false,
      {
        served: {
          streamEntry: { sidecarId: "of:stream-events:pin", index: 0, seq: 1 },
          onFailure: (outcome) => outcomes.push(outcome),
        },
      },
    );
    await parkObserved.promise;
    expect(handlerRuns).toBe(0);

    load.reject(
      new ReplicaLoadFailureError({
        failureClass: "session-revoked",
        permanentEvidence: false,
        recoveryEpoch: "load:1",
      }, new Error("memory session revoked: unauthorized")),
    );
    await runtime.idle();
    expect(handlerRuns).toBe(0);
    // The pin: `deferred` (the entry stays pending for a later drain),
    // carrying the cause that keeps it off the queued class's bounded
    // creation-race budget. Pre-fix this read [{ kind: "dropped" }] and
    // the drain sealed the entry.
    expect(outcomes).toEqual([{
      kind: "deferred",
      cause: "load-park",
      role: "failed-head",
      failure: {
        failureClass: "session-revoked",
        permanentEvidence: false,
        recoveryEpoch: "load:1",
      },
    }]);
    await runtime.idle();
    expect(outcomes.length, "settled exactly once").toBe(1);
  });

  it("the barrier's exclusions: the same-space durable sibling defers, while another space's entry and a streamEntry-less LT1 copy are left alone", async () => {
    // The barrier's TWO DELIBERATE EXCLUSIONS, pinned rather than merely
    // documented. When a served head's load park fails, every later-arrived
    // DURABLE served entry in the SAME space defers with it (events.md §2's
    // arrival order). Two neighbours are deliberately left alone:
    //   - another SPACE's entry — §2 orders within one space, and deferring a
    //     stranger's event would be a liveness cost with no ordering benefit;
    //   - an LT1 in-process copy (`served` with no `streamEntry`) — it has no
    //     durable entry to re-drain, so deferring it would LOSE it; its durable
    //     twin re-drains with a `streamEntry` on its own.
    // Both were argued in review and neither was exercised — they were also
    // exactly the two uncovered lines the coverage ratchet caught.

    const { runtime, tx } = env;
    const otherSpace = (await Identity.fromPassphrase("load-park other space"))
      .did() as MemorySpace;
    const coldDoc = runtime.getCell<string>(
      space,
      "barrier-exclusions-cold",
      undefined,
    );
    const headCell = runtime.getCell<number>(
      space,
      "barrier-exclusions-head",
      undefined,
    );
    const siblingCell = runtime.getCell<number>(
      space,
      "barrier-exclusions-sibling",
      undefined,
    );
    const lt1Cell = runtime.getCell<number>(
      space,
      "barrier-exclusions-lt1",
      undefined,
    );
    // Its OWN doc id: same-stream sends coalesce by id, so reusing the
    // sibling's id would merge the two queue slots instead of giving the
    // barrier a distinct cross-space neighbour to skip.
    const otherSpaceCell = runtime.getCell<number>(
      space,
      "barrier-exclusions-other-space",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    // A FRESH function per handler: addEventHandler stamps
    // `populateDependencies` onto the function object itself, so sharing one
    // `noop` would give every stream the head's closure — and all four would
    // park on the armed doc instead of just the head.
    const freshHandler = (): EventHandler => () => {};
    // Only the HEAD reads the cold doc, so only the head parks.
    runtime.scheduler.addEventHandler(
      freshHandler(),
      headCell.getAsNormalizedFullLink(),
      (depTx) => coldDoc.withTx(depTx).get(),
    );
    const siblingLink = siblingCell.getAsNormalizedFullLink();
    const lt1Link = lt1Cell.getAsNormalizedFullLink();
    // A link in ANOTHER space; the barrier compares `eventLink.space`.
    const otherSpaceLink = {
      ...otherSpaceCell.getAsNormalizedFullLink(),
      space: otherSpace,
    };
    runtime.scheduler.addEventHandler(freshHandler(), siblingLink);
    runtime.scheduler.addEventHandler(freshHandler(), lt1Link);
    runtime.scheduler.addEventHandler(freshHandler(), otherSpaceLink);

    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    const load = Promise.withResolvers<void>();
    load.promise.catch(() => {});
    const parkObserved = Promise.withResolvers<void>();
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () => [{
      space: link.space,
      scope: link.scope,
      id: link.id,
    }];
    manager.pendingLoadGeneration = (candidate) =>
      candidate === key ? 1 : undefined;
    manager.loadsSettled = () => {
      parkObserved.resolve();
      return load.promise;
    };

    const outcomes = new Map<string, unknown[]>();
    const record = (who: string) => (outcome: unknown) => {
      const seen = outcomes.get(who) ?? [];
      seen.push(outcome);
      outcomes.set(who, seen);
    };
    const servedEntry = { sidecarId: "of:stream-events:pin", index: 0, seq: 1 };

    // The head goes in first and must be PARKED before the others queue, so
    // the queue is unambiguously [head(parked), sibling, otherSpace, lt1].
    runtime.scheduler.queueEvent(
      headCell.getAsNormalizedFullLink(),
      1,
      true,
      undefined,
      false,
      {
        eventId: "barrier-exclusions-head",
        served: { streamEntry: servedEntry, onFailure: record("head") },
      },
    );
    await parkObserved.promise;

    runtime.scheduler.queueEvent(siblingLink, 1, true, undefined, false, {
      served: { streamEntry: servedEntry, onFailure: record("sibling") },
    });
    runtime.scheduler.queueEvent(otherSpaceLink, 1, true, undefined, false, {
      served: { streamEntry: servedEntry, onFailure: record("otherSpace") },
    });
    // The LT1 shape: served carriage, NO streamEntry.
    runtime.scheduler.queueEvent(lt1Link, 1, true, undefined, false, {
      served: { onFailure: record("lt1") },
    });

    load.reject(
      new ReplicaLoadFailureError({
        failureClass: "session-revoked",
        permanentEvidence: false,
        recoveryEpoch: "load:1",
      }, new Error("memory session revoked: unauthorized")),
    );
    await runtime.idle();

    // Swept: the head and its same-space durable sibling.
    expect(outcomes.get("head")).toEqual([{
      kind: "deferred",
      cause: "load-park",
      role: "failed-head",
      failure: {
        failureClass: "session-revoked",
        permanentEvidence: false,
        recoveryEpoch: "load:1",
      },
    }]);
    expect(
      outcomes.get("sibling"),
      "a later-arrived same-space durable entry defers with the head",
    ).toEqual([{
      kind: "deferred",
      cause: "arrival-barrier",
      blockedBy: "barrier-exclusions-head",
    }]);
    // Left alone: another space's entry (§2 is per-space) and the LT1 copy
    // (no durable entry to re-drain — deferring it would lose it).
    expect(
      outcomes.get("otherSpace"),
      "another space's entry must not be swept",
    ).toBeUndefined();
    expect(
      outcomes.get("lt1"),
      "a streamEntry-less LT1 copy must not be swept",
    ).toBeUndefined();
  });

  it("re-parks the same event for a fresh load generation", async () => {
    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(
      space,
      "load-park-generation-cold",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "load-park-generation-event",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    let handlerRuns = 0;
    const handler: EventHandler = () => {
      handlerRuns++;
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => coldDoc.withTx(depTx).get(),
    );

    const link = coldDoc.getAsNormalizedFullLink();
    const key = `${link.space}/${link.scope}/${link.id}`;
    let generation = 1;
    let pending = true;
    const waits = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const parks = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    let parkCount = 0;
    const manager = runtime.storageManager as unknown as {
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
      pendingLoadGeneration(key: string): number | undefined;
      loadsSettled(keys: readonly string[]): Promise<void>;
    };
    manager.pendingLoadAddresses = () =>
      pending ? [{ space: link.space, scope: link.scope, id: link.id }] : [];
    manager.pendingLoadGeneration = (candidate) =>
      pending && candidate === key ? generation : undefined;
    manager.loadsSettled = () => {
      const index = parkCount++;
      parks[index]?.resolve();
      return waits[index]!.promise;
    };

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await parks[0].promise;
    expect(handlerRuns).toBe(0);

    // A distinct generation begins before the first park releases. The event
    // history must compare generations, not permanently whitelist this key.
    generation = 2;
    waits[0].resolve();
    await parks[1].promise;
    expect(handlerRuns).toBe(0);
    expect(parkCount).toBe(2);

    pending = false;
    waits[1].resolve();
    await runtime.idle();
    expect(handlerRuns).toBe(1);
  });

  it("dispatches immediately when no closure load is in flight", async () => {
    const { runtime, tx } = env;
    const doc = runtime.getCell<string>(space, "no-load-doc", undefined);
    const eventCell = runtime.getCell<number>(
      space,
      "no-load-events",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    let handlerRuns = 0;
    const handler: EventHandler = (actionTx) => {
      handlerRuns++;
      doc.withTx(actionTx).get();
    };
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
      (depTx) => {
        doc.withTx(depTx).get();
      },
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();
    expect(handlerRuns).toBe(1);
  });

  it("routes only proven-no-commit finalization failures through terminal cover", async () => {
    const { runtime, tx } = env;
    const result = runtime.getCell<number>(
      space,
      "served-finalization-result",
      undefined,
    );
    const eventCell = runtime.getCell<number>(
      space,
      "served-finalization-event",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (actionTx, value) => result.withTx(actionTx).send(value as number),
      eventCell.getAsNormalizedFullLink(),
    );

    const dispatch = async (
      eventId: string,
      error: TransactError,
    ): Promise<ServedEventFailureOutcome[]> => {
      const outcomes: ServedEventFailureOutcome[] = [];
      const restore = rejectNextTransact(runtime, error);
      try {
        runtime.scheduler.queueEvent(
          eventCell.getAsNormalizedFullLink(),
          1,
          true,
          undefined,
          false,
          {
            eventId,
            served: {
              streamEntry: {
                sidecarId: "of:stream-events:finalization",
                index: 0,
                seq: 1,
              },
              onFailure: (outcome) => outcomes.push(outcome),
            },
          },
        );
        await runtime.scheduler.idleWithPendingCommits();
        await runtime.idle();
        return outcomes;
      } finally {
        restore();
      }
    };

    expect(
      await dispatch("row-label", {
        name: "RowLabelCommitError",
        message: "sqlite commit refused: row label verdict",
      }),
    ).toEqual([{
      kind: "deferred",
      cause: "delivery-failure",
      role: "failed-head",
      phase: "commit-finalization",
      failure: {
        failureClass: "protocol",
        recoveryEpoch: "row-label-verdict",
        permanentEvidence: true,
      },
    }]);

    expect(
      await dispatch("current-acl", {
        name: "AuthorizationError",
        message: "write authorization denied",
        permanentEvidence: true,
        aclRevision: 9,
      }),
    ).toEqual([{
      kind: "deferred",
      cause: "delivery-failure",
      role: "failed-head",
      phase: "commit-finalization",
      failure: {
        failureClass: "authorization",
        recoveryEpoch: "acl:9",
        permanentEvidence: true,
      },
    }]);

    expect(
      await dispatch("ambiguous-authorization", {
        name: "AuthorizationError",
        message: "authorization outcome has no current ACL evidence",
      }),
      "an ambiguous finalization outcome must remain outside explicit replay",
    ).toEqual([]);
  });

  it("loadsSettled resolves when keys contains a duplicate", async () => {
    // F4d: loadsSettled counts remaining by keys.length but adds a single
    // shared onSettled callback to each entry's waiter Set, which fires once
    // per settled entry. A duplicated key inflates the count without adding a
    // matching callback, so remaining never reaches zero and the promise hangs.

    const { runtime, tx } = env;
    const coldDoc = runtime.getCell<string>(
      space,
      "loads-settled-dupe",
      undefined,
    );
    await tx.commit().settled;
    env.tx = runtime.edit();

    const storage = runtime.storageManager as unknown as {
      loadsSettled(keys: readonly string[]): Promise<void>;
      pendingLoadAddresses(): readonly {
        space: string;
        scope: string;
        id: string;
      }[];
    };

    // Pin one in-flight load for the cold doc so a pending-load entry exists.
    const release = holdSyncFor(coldDoc.getAsNormalizedFullLink().id);
    const loadInFlight = runtime.storageManager.syncCell(coldDoc).catch(
      () => {},
    );
    // Let the synchronous pending-load registration settle onto the map.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const addresses = storage.pendingLoadAddresses();
    expect(addresses.length).toBe(1);
    const { space: s, scope, id } = addresses[0];
    const key = `${s}/${scope}/${id}`;

    // Wait on the same key twice; a correct loadsSettled dedupes and resolves.
    const settled = storage.loadsSettled([key, key]);

    release();
    await loadInFlight;

    // No deadline: a `loadsSettled` that never resolves leaves this wait
    // pending, and Deno fails the test on it.
    await settled;
  });
});
