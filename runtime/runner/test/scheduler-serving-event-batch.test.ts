import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("serving event batch");
const space = signer.did();

describe("scheduler serving event batch", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;
  let releaseLoad: (() => void) | undefined;

  afterEach(async () => {
    // A load a test holds in flight would keep the parked event, and the
    // runtime's disposal behind it, waiting.
    releaseLoad?.();
    releaseLoad = undefined;
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /**
   * Three cells, each set by a stream handler from one event, read together
   * by one derivation whose runs are counted. Three events are queued before
   * the scheduler takes any, each under its own durable id so that none
   * collapses into another. Each handler writes a cell of its own. With no
   * serving loop to seal them into one wave, each handler commits on its
   * own, and a commit can be refused and its handler run again; that run
   * comes after the first derivation run behind the events, which is what
   * these tests read.
   */
  async function queueThreeEvents(servingPosture: boolean) {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture,
    });
    const tx = runtime.edit();
    const slots = [1, 2, 3].map((by) => {
      const slot = runtime!.getCell<number>(
        space,
        `serving event batch slot ${by} ${servingPosture}`,
        undefined,
        tx,
      );
      slot.set(0);
      return slot;
    });
    const stream = runtime.getCell<unknown>(
      space,
      `serving event batch stream ${servingPosture}`,
      undefined,
      tx,
    );
    stream.setRaw({ $stream: true });
    tx.commit();
    await runtime.idle();

    const derived: number[] = [];
    const derivation: Action = (readTx) => {
      derived.push(
        slots.reduce((sum, slot) => sum + slot.withTx(readTx).get(), 0),
      );
    };
    runtime.scheduler.subscribe(derivation, {
      reads: slots.map((slot) =>
        toMemorySpaceAddress(slot.getAsNormalizedFullLink())
      ),
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.idle();
    expect(derived).toEqual([0]);

    runtime.scheduler.addEventHandler(
      (handlerTx: IExtendedStorageTransaction, event: { by: number }) => {
        slots[event.by - 1].withTx(handlerTx).set(event.by);
      },
      stream.getAsNormalizedFullLink(),
    );
    const link = stream.getAsNormalizedFullLink();
    for (const by of [1, 2, 3]) {
      runtime.scheduler.queueEvent(link, { by }, true, undefined, false, {
        eventId: `serving-event-batch-${servingPosture}-${by}`,
      });
    }
    // `idle()` returns ahead of the handler commits' writeback; a commit
    // still in flight when the runtime is disposed fails against the closed
    // store.
    await runtime.settled();
    // Read through the derivation's own transaction: a read outside one
    // under the serving posture reaches for the store, and a pull left
    // behind would outlive the test.
    return derived;
  }

  it("runs every ready event's handler before one derivation pass under the serving posture", async () => {
    const derived = await queueThreeEvents(true);
    // The first run behind the events read all three handlers' writes.
    expect(derived[1]).toBe(6);
    expect(derived.at(-1)).toBe(6);
  });

  it("settles the derivations after each event outside the serving posture", async () => {
    const derived = await queueThreeEvents(false);
    // A run behind each event, the first reading only its write.
    expect(derived).toEqual([0, 1, 3, 6]);
  });

  /**
   * A serving runtime holding a cell, a derivation whose runs record what it
   * read, a stream whose handler writes the cell, and a stream whose
   * handler's inputs read a document whose load stays in flight until the
   * test ends, so an event on it parks at the head. A pass
   * the test starts runs whatever the two streams are sent: until then,
   * queueing an event schedules nothing.
   */
  async function parkingRuntime() {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
    });
    const tx = runtime.edit();
    const cell = <T>(name: string) =>
      runtime!.getCell<T>(space, `parking ${name}`, undefined, tx);
    const slot = cell<number>("slot");
    slot.set(0);
    const cold = cell<number>("cold");
    cold.set(0);
    const writing = cell<unknown>("writing stream");
    writing.setRaw({ $stream: true });
    const parking = cell<unknown>("parking stream");
    parking.setRaw({ $stream: true });
    tx.commit();
    await runtime.idle();

    const derived: number[] = [];
    runtime.scheduler.subscribe((readTx) => {
      derived.push(slot.withTx(readTx).get());
    }, {
      reads: [toMemorySpaceAddress(slot.getAsNormalizedFullLink())],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.idle();
    expect(derived).toEqual([0]);

    runtime.scheduler.addEventHandler(
      (handlerTx: IExtendedStorageTransaction, event: { value: number }) => {
        slot.withTx(handlerTx).set(event.value);
      },
      writing.getAsNormalizedFullLink(),
    );
    runtime.scheduler.addEventHandler(
      () => {},
      parking.getAsNormalizedFullLink(),
      (depTx: IExtendedStorageTransaction) => {
        cold.withTx(depTx).get();
      },
    );

    const coldLink = cold.getAsNormalizedFullLink();
    const coldKey = `${coldLink.space}/${coldLink.scope}/${coldLink.id}`;
    const load = Promise.withResolvers<void>();
    const manager = storageManager!;
    manager.pendingLoadAddresses = () => [{
      space: coldLink.space,
      scope: coldLink.scope,
      id: coldLink.id,
    }];
    manager.pendingLoadGeneration = (key) => key === coldKey ? 1 : undefined;
    manager.loadsSettled = () => load.promise;
    releaseLoad = () => load.resolve();

    // Marked as running a pass, the scheduler latches the passes the events
    // ask for rather than scheduling them; the pass the test runs ends that,
    // and `latch()` marks it so again.
    const access = runtime.scheduler.accessForTestingOnly;
    access.scheduled = true;
    return {
      runtime,
      slot,
      derived,
      writing: writing.getAsNormalizedFullLink(),
      parking: parking.getAsNormalizedFullLink(),
      pass: () => access.execute(),
      latch: () => {
        access.scheduled = true;
      },
      failLoad: (error: Error) => load.reject(error),
    };
  }

  it("keeps the settle a pass deferred waiting through a pass that only queued another event behind the parked head", async () => {
    // An event queued behind the parked head dirties nothing, so the pass it
    // asks for leaves the deferred settle to the park's end, which settles
    // behind both events.
    const env = await parkingRuntime();
    env.runtime.scheduler.queueEvent(env.writing, { value: 1 });
    env.runtime.scheduler.queueEvent(env.parking, {});
    await env.pass();
    expect(env.derived).toEqual([0]);

    env.latch();
    env.runtime.scheduler.queueEvent(env.writing, { value: 3 });
    await env.pass();
    expect(env.derived).toEqual([0]);

    const settled = env.runtime.idle();
    releaseLoad!();
    await settled;
    expect(env.derived).toEqual([0, 3]);
  });

  it("settles the events a pass ran once a drop takes its parked head off the queue", async () => {
    // The flush deadline's purge drops a parked in-process event before its
    // loads settle. The settle the pass left to the park's release runs
    // all the same, for a waiter that parked on it, as the serving loop's
    // settle does.
    const env = await parkingRuntime();
    env.runtime.scheduler.queueEvent(env.writing, { value: 1 });
    env.runtime.scheduler.queueEvent(env.parking, {});
    await env.pass();
    // The handler ran, and its settle waits behind the parked event.
    expect(env.derived).toEqual([0]);

    const settled = env.runtime.idle();
    const purged = env.runtime.scheduler.purgeQueuedEvents(
      (event) => event.eventLink.id === env.parking.id,
      "the test drops the parked event",
    );
    expect(purged).toBe(1);
    await settled;
    expect(env.derived).toEqual([0, 1]);
  });

  it("settles the events a pass ran once its parked head's load fails", async () => {
    // A failed load ends the park as its release would, dropping the
    // client event that parked, and the settle the pass left to the park's
    // end runs all the same.
    const env = await parkingRuntime();
    env.runtime.scheduler.queueEvent(env.writing, { value: 1 });
    env.runtime.scheduler.queueEvent(env.parking, {});
    await env.pass();
    expect(env.derived).toEqual([0]);

    const settled = env.runtime.idle();
    env.failLoad(new Error("the test's load fails"));
    await settled;
    expect(env.derived).toEqual([0, 1]);
  });

  it("settles in the pass when the event before a parked head was dropped rather than run", async () => {
    // An event whose origin transaction failed drops at the head without a
    // handler running, so nothing waits to be settled behind the parked
    // event, and the derivation the direct write dirtied runs in the pass.
    const env = await parkingRuntime();
    const write = env.runtime.edit();
    env.slot.withTx(write).set(2);
    await write.commit().settled;
    const failed = env.runtime.edit();
    failed.abort("the test's origin fails");
    env.runtime.scheduler.queueEvent(
      env.writing,
      { value: 3 },
      true,
      undefined,
      false,
      { originTx: failed },
    );
    env.runtime.scheduler.queueEvent(env.parking, {});
    await env.pass();
    expect(env.derived).toEqual([0, 2]);
  });
});
