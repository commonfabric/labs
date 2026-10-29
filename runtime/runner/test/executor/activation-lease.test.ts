import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";

import { Identity } from "@commonfabric/identity";
import { resolveScopeKey, streamEntriesDocId } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  acquireExecutionLease,
  ExecutionLeaseCycle,
  executionLeaseHolder,
  liveExecutionLeaseHolder,
  releaseExecutionLease,
} from "@commonfabric/memory/v2/execution-lease";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import { defer } from "@commonfabric/utils/defer";

import { ExecutorHost } from "../../src/executor/host.ts";
import {
  type RuntimeFactoryContext,
  SpaceServer,
} from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import {
  stampWaveRunContext,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("activation lease space");
const serviceSigner = await Identity.fromPassphrase("activation lease service");
const aliceSigner = await Identity.fromPassphrase("activation lease alice");
const space = spaceSigner.did() as MemorySpace;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

async function fixture(options: {
  factoryError?: Error;
  disposeError?: Error;
  servingPosture?: boolean;
  serverExecution?: boolean;
  serverFacade?: (
    server: ReturnType<typeof newSharedServer>,
  ) => ReturnType<typeof newSharedServer>;
} = {}) {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const engine = await server.engineForSpace(space);
  const manager = EmulatedStorageManager.connectTo(server, {
    as: serviceSigner,
  });
  let runtime: Runtime;
  try {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: options.servingPosture ?? true,
      experimental: { serverExecution: options.serverExecution ?? true },
    });
  } catch (error) {
    await manager.close();
    await server.close();
    throw error;
  }
  let transferred = false;
  let disposeCalls = 0;
  const entered = defer<RuntimeFactoryContext>();
  const release = defer<void>();
  const disposeEntered = defer<void>();
  let disposeGate: Promise<void> | undefined;
  const stats = emptyServingLoopStats();
  const dispose = async () => {
    disposeCalls++;
    disposeEntered.resolve();
    await disposeGate;
    try {
      await runtime.dispose();
    } catch (error) {
      await manager.close();
      throw error;
    }
    if (options.disposeError) throw options.disposeError;
  };
  const createRuntime = async (context: RuntimeFactoryContext) => {
    entered.resolve(context);
    await release.promise;
    if (options.factoryError) throw options.factoryError;
    transferred = true;
    return { runtime, dispose };
  };
  const serving = new SpaceServer({
    space,
    engine,
    server: options.serverFacade?.(server) ?? server,
    serviceIdentity: serviceSigner.did(),
    createRuntime,
    localSeqRef: { value: 0 },
    stats,
    policy: {
      flushDeadlineMs: 2_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    },
  });
  return {
    server,
    engine,
    manager,
    runtime,
    entered,
    release,
    stats,
    serving,
    createRuntime,
    disposeEntered,
    holdDisposal(gate: Promise<void>) {
      disposeGate = gate;
    },
    get disposeCalls() {
      return disposeCalls;
    },
    async close(activation?: Promise<unknown>) {
      release.resolve();
      await activation?.catch(() => {});
      try {
        await serving.park("test-teardown");
        if (!transferred) await dispose();
      } finally {
        await server.close();
      }
    },
  };
}

async function freshServingRuntime(server: ReturnType<typeof newSharedServer>) {
  const manager = EmulatedStorageManager.connectTo(server, {
    as: serviceSigner,
  });
  let runtime: Runtime;
  try {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  } catch (error) {
    await manager.close();
    throw error;
  }
  return { runtime, dispose: () => runtime.dispose() };
}

async function commitFirstWork(
  f: Pick<Awaited<ReturnType<typeof fixture>>, "runtime" | "engine">,
) {
  const probe = f.runtime.getCell<number>(space, "first-work", undefined);
  await probe.sync();
  const tx = f.runtime.edit();
  stampWaveRunContext(tx, { actionId: "first-work", kind: "derivation" });
  probe.withTx(tx).set(42);
  expect((await tx.commit().settled).error).toBeUndefined();
  const accepted = await waveSettlementOf(tx);
  expect(accepted).toBeDefined();
  expect(accepted?.error).toBeUndefined();
  expect(
    Engine.read(f.engine, { id: probe.getAsNormalizedFullLink().id })?.value,
  )
    .toBe(42);
}

describe("activation-lease", () => {
  for (const initializationMs of [0, 20_000]) {
    it(`commits its first work after ${initializationMs}ms of gated initialization`, async () => {
      const f = await fixture();
      // Lease time and interval callbacks advance together; scheduler and
      // transport dispatch still drain through ordinary task boundaries.
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const activation = f.serving.activate();
      try {
        await f.entered.promise;
        expect(liveExecutionLeaseHolder(f.engine, space)).toBe(
          f.serving.holder,
        );
        const initialHead = Engine.serverSeq(f.engine);
        time.tick(initializationMs);
        expect(Engine.serverSeq(f.engine)).toBe(initialHead);
        f.release.resolve();
        expect(await activation).toBe(true);
        await commitFirstWork(f);
        expect(liveExecutionLeaseHolder(f.engine, space)).toBe(
          f.serving.holder,
        );
      } finally {
        await f.close(activation);
      }
      expect(f.disposeCalls).toBe(1);
      expect(time.next()).toBe(false);
    });
  }

  it("keeps its lease while delegated append recovery opens a target space", async () => {
    const appendEntered = defer<void>();
    const releaseAppend = defer<void>();
    const f = await fixture({
      serverFacade: (server) =>
        new Proxy(server, {
          get(target, property, receiver) {
            if (property === "commitDelegatedAppend") {
              return async (
                ...args: Parameters<typeof server.commitDelegatedAppend>
              ) => {
                appendEntered.resolve();
                await releaseAppend.promise;
                return await target.commitDelegatedAppend(...args);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    const targetSigner = await Identity.fromPassphrase(
      "activation append target",
    );
    const targetSpace = targetSigner.did() as MemorySpace;
    const targetStreamLink = {
      id: "of:activation-target-stream",
      path: [] as string[],
    };
    const targetStream = streamEntriesDocId(targetStreamLink);
    insertExecutionOutboxRows(f.engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream,
        targetStreamLink,
        eventId: "activation-recovery-entry",
        payload: { recovered: true },
        actingPrincipal: aliceSigner.did(),
        actingSession: "session:activation-recovery",
        capabilityRef: "cap:activation-recovery",
      }],
    });
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      f.release.resolve();
      await appendEntered.promise;
      expect(f.serving.active).toBe(false);
      time.tick(20_000);
      releaseAppend.resolve();
      expect(await activation).toBe(true);
      expect(selectPendingExecutionOutboxRows(f.engine, { branch: "" }))
        .toHaveLength(0);
      const targetEngine = await f.server.engineForSpace(targetSpace);
      const entries = Engine.read(targetEngine, { id: targetStream })
        ?.value as { entries: unknown[] };
      expect(entries.entries).toHaveLength(1);
      await commitFirstWork(f);
    } finally {
      releaseAppend.resolve();
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
    expect(time.next()).toBe(false);
  });

  it("releases its initialization lease when the runtime factory rejects", async () => {
    const f = await fixture({ factoryError: new Error("factory rejected") });
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      time.tick(20_000);
      f.release.resolve();
      await expect(activation).rejects.toThrow("factory rejected");
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(f.stats.activeSpaces).toBe(0);
      expect(time.next()).toBe(false);
    } finally {
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
  });

  for (const invalidRuntime of ["servingPosture", "serverExecution"] as const) {
    it(`releases its lease when ${invalidRuntime} validation and disposal fail`, async () => {
      const f = await fixture({
        [invalidRuntime]: false,
        disposeError: new Error("dispose rejected"),
      });
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const activation = f.serving.activate();
      try {
        await f.entered.promise;
        f.release.resolve();
        await expect(activation).rejects.toThrow(invalidRuntime);
        expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
        expect(f.disposeCalls).toBe(1);
        expect(f.stats.activeSpaces).toBe(0);
        expect(time.next()).toBe(false);
      } finally {
        await f.close(activation);
      }
    });
  }

  it("refuses activation and stops renewal when the lease store throws", async () => {
    const f = await fixture();
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      {
        using _renew = stub(ExecutionLeaseCycle.prototype, "renew", () => {
          throw new Error("lease store unavailable");
        });
        time.tick(5_000);
      }
      f.release.resolve();
      expect(await activation).toBe(false);
      expect(f.serving.active).toBe(false);
      expect(f.stats.lease.lost).toBe(1);
      expect(f.stats.waves).toBe(0);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(time.next()).toBe(false);
    } finally {
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
  });

  it("disposes a rejected runtime even when observer cleanup throws", async () => {
    const f = await fixture({ servingPosture: false });
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    try {
      await f.entered.promise;
      {
        using _open = stub(f.manager, "open", () => {
          throw new Error("observer cleanup failed");
        });
        f.release.resolve();
        await expect(activation).rejects.toThrow("servingPosture");
      }
      expect(f.disposeCalls).toBe(1);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(time.next()).toBe(false);
    } finally {
      await f.close(activation);
    }
  });

  for (const renewBeforeRelease of [false, true]) {
    it(`refuses initialization after a rival takes the lease ${renewBeforeRelease ? "at renewal" : "before renewal"}`, async () => {
      const f = await fixture();
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const activation = f.serving.activate();
      const rival = executionLeaseHolder("did:key:activation-rival");
      try {
        await f.entered.promise;
        releaseExecutionLease(f.engine, { space, holder: f.serving.holder });
        expect(acquireExecutionLease(f.engine, { space, holder: rival }))
          .toBe(true);
        if (renewBeforeRelease) time.tick(5_000);
        f.release.resolve();
        expect(await activation).toBe(false);
        expect(f.serving.active).toBe(false);
        expect(f.stats.waves).toBe(0);
        expect(f.stats.activeSpaces).toBe(0);
        expect(f.stats.lease.lost).toBe(1);
        expect(f.disposeCalls).toBe(1);
        expect(liveExecutionLeaseHolder(f.engine, space)).toBe(rival);
        expect(time.next()).toBe(false);
      } finally {
        await f.close(activation);
      }
    });
  }

  it("refuses factory reads of another user's instance after lease takeover", async () => {
    const f = await fixture();
    const aliceManager = EmulatedStorageManager.connectTo(f.server, {
      as: aliceSigner,
    });
    const alice = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: aliceManager,
    });
    const privateValue = alice.getCellFromLink<number>({
      ...alice.getCell<number>(space, "private-value", undefined)
        .getAsNormalizedFullLink(),
      scope: "user",
    });
    const tx = alice.edit();
    privateValue.withTx(tx).set(7);
    expect((await tx.commit().settled).error).toBeUndefined();
    const address = {
      id: privateValue.getAsNormalizedFullLink().id,
      scopeKey: resolveScopeKey("user", { principal: aliceSigner.did() }),
    };
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const activation = f.serving.activate();
    const rival = executionLeaseHolder("did:key:read-through-rival");
    try {
      const context = await f.entered.promise;
      expect(context.storeReadThrough).toBeDefined();
      expect(context.storeReadThrough!(address)?.doc?.value).toBe(7);
      releaseExecutionLease(f.engine, { space, holder: f.serving.holder });
      expect(acquireExecutionLease(f.engine, { space, holder: rival })).toBe(
        true,
      );
      expect(context.storeReadThrough!(address)).toBeUndefined();
      expect(Engine.read(f.engine, address)?.value).toBe(7);
      f.release.resolve();
      expect(await activation).toBe(false);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBe(rival);
      expect(time.next()).toBe(false);
    } finally {
      try {
        await alice.dispose({ closeStorage: false });
      } finally {
        await aliceManager.close();
      }
      await f.close(activation);
    }
    expect(f.disposeCalls).toBe(1);
  });

  for (
    const demand of [
      "session",
      "event",
      "warm",
      "late warm",
      "cleanup warm",
    ] as const
  ) {
    it(`reactivates ${demand} demand after initialization loses its lease without a successor`, async () => {
      const f = await fixture();
      const aliceManager = EmulatedStorageManager.connectTo(f.server, {
        as: aliceSigner,
      });
      const alice = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: aliceManager,
      });
      const nextRuntime = defer<Runtime>();
      let builds = 0;
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const host = new ExecutorHost({
        server: f.server,
        serviceIdentity: serviceSigner.did(),
        ensureSpaceRoots: false,
        policy: { failureParkBackoffBaseMs: 0 },
        createRuntime: async (_space, context) => {
          if (++builds === 1) return await f.createRuntime(context);
          const built = await freshServingRuntime(f.server);
          nextRuntime.resolve(built.runtime);
          return built;
        },
      });
      try {
        const warmNotice = () =>
          f.server.noteExecutorCommit({
            space,
            seq: Engine.serverSeq(f.engine),
            class: "authored",
            sessionId: "initialization-warm-issuer",
            writes: [{ id: "of:surviving-warm-demand", scopeKey: "space" }],
            warm: true,
          });
        const activate = SpaceServer.prototype.activate;
        using _activate = stub(
          SpaceServer.prototype,
          "activate",
          async function (this: SpaceServer) {
            const activated = await activate.call(this);
            if (demand === "cleanup warm" && !activated && builds === 1) {
              // Cleanup removed the old server, but its host activation still
              // owns the in-flight record until this result returns.
              warmNotice();
            }
            return activated;
          },
        );
        if (demand === "session") {
          await alice.getCell<number>(space, "surviving-demand", undefined)
            .sync();
        } else if (demand === "event") {
          const stream = { id: "of:surviving-event-demand", path: ["event"] };
          expect(
            (await f.server.commitDelegatedAppend({
              targetSpace: space,
              targetStream: streamEntriesDocId(stream),
              targetStreamLink: stream,
              eventId: "initialization-event",
              payload: {},
              actingPrincipal: aliceSigner.did(),
              actingSession: "initialization-session",
              capabilityRef: "initialization-capability",
              sessionId: "initialization-delivery",
              localSeq: 1,
            })).deduped,
          ).toBe(false);
          expect(Engine.selectPendingStreamEventDocs(f.engine)).toHaveLength(1);
        } else if (demand === "warm") {
          warmNotice();
        }
        // This joins an existing activation, or starts the late-warm case.
        // No request is issued after lease loss until a fresh factory runs.
        const firstAttempt = host.runLifecycleVerb(space, {
          name: "observe-initial-activation",
          run: () => Promise.resolve(),
        });
        await f.entered.promise;
        if (demand === "late warm") warmNotice();
        expect(f.server.hasLiveSessionsForSpace(space, {
          excludePrincipal: serviceSigner.did(),
        })).toBe(demand === "session");
        const first = host.spaceServer(space)!;
        releaseExecutionLease(f.engine, { space, holder: first.holder });
        time.tick(5_000);
        f.release.resolve();
        await expect(firstAttempt).rejects.toThrow("not served");
        expect(host.stats().reactivationBackoffs).toBe(1);
        const runtime = await nextRuntime.promise;
        await host.runLifecycleVerb(space, {
          name: "observe-successor-activation",
          run: () => Promise.resolve(),
        });
        await commitFirstWork({ runtime, engine: f.engine });
        expect(builds).toBe(2);
        expect(host.stats().activeSpaces).toBe(1);
        expect(f.disposeCalls).toBe(1);
        if (
          demand === "warm" || demand === "late warm" ||
          demand === "cleanup warm"
        ) {
          expect(host.stats().demand.warmWakes).toBe(
            demand === "cleanup warm" ? 1 : 2,
          );
        }
      } finally {
        f.release.resolve();
        await host.close();
        try {
          await alice.dispose({ closeStorage: false });
        } finally {
          await aliceManager.close();
        }
        await f.close();
      }
      expect(time.next()).toBe(false);
    });
  }

  for (const boundary of ["no demand", "rival", "closed"] as const) {
    it(`does not rebuild beyond the ${boundary} boundary after initialization lease loss`, async () => {
      const f = await fixture();
      const aliceManager = EmulatedStorageManager.connectTo(f.server, {
        as: aliceSigner,
      });
      const alice = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: aliceManager,
      });
      let builds = 0;
      using time = new FakeTime();
      using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
      using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
      const host = new ExecutorHost({
        server: f.server,
        serviceIdentity: serviceSigner.did(),
        ensureSpaceRoots: false,
        policy: { failureParkBackoffBaseMs: 0 },
        createRuntime: (_space, context) => {
          builds++;
          return f.createRuntime(context);
        },
      });
      let closing: Promise<void> | undefined;
      const rival = executionLeaseHolder("did:key:initialization-successor");
      try {
        if (boundary !== "no demand") {
          await alice.getCell<number>(space, "remaining-demand", undefined)
            .sync();
        }
        const initial = host.runLifecycleVerb(space, {
          name: "observe-initial-activation",
          run: () => Promise.resolve(),
        });
        await f.entered.promise;
        const first = host.spaceServer(space)!;
        if (boundary === "closed") closing = host.close();
        releaseExecutionLease(f.engine, { space, holder: first.holder });
        if (boundary === "rival") {
          expect(acquireExecutionLease(f.engine, { space, holder: rival }))
            .toBe(true);
        }
        time.tick(5_000);
        f.release.resolve();
        await expect(initial).rejects.toThrow("not served");
        if (boundary === "rival") {
          expect(host.stats().reactivationBackoffs).toBe(1);
          // The automatically scheduled successor is already in backoff.
          // Joining it waits for the actual acquire refusal, not a timeout.
          await expect(host.runLifecycleVerb(space, {
            name: "observe-successor-refusal",
            run: () => Promise.resolve(),
          })).rejects.toThrow("not served");
          expect(host.stats().reactivationBackoffs).toBe(1);
          expect(liveExecutionLeaseHolder(f.engine, space)).toBe(rival);
        } else {
          await closing;
          expect(host.stats().reactivationBackoffs).toBe(0);
          expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
        }
        expect(builds).toBe(1);
        expect(f.disposeCalls).toBe(1);
        expect(host.stats().activeSpaces).toBe(0);
      } finally {
        f.release.resolve();
        await host.close();
        try {
          await alice.dispose({ closeStorage: false });
        } finally {
          await aliceManager.close();
        }
        await f.close();
      }
      expect(time.next()).toBe(false);
    });
  }

  it("backs off repeated initialization lease loss and cancels the next rebuild on close", async () => {
    const f = await fixture();
    const aliceManager = EmulatedStorageManager.connectTo(f.server, {
      as: aliceSigner,
    });
    const alice = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: aliceManager,
    });
    const secondStarted = defer<void>();
    const releaseSecond = defer<void>();
    let builds = 0;
    using time = new FakeTime();
    const controlledTimeout = globalThis.setTimeout;
    const controlledClearTimeout = globalThis.clearTimeout;
    const backoffBase = 123_456;
    const backoffDelays: number[] = [];
    const backoffTimers = new Set<Parameters<typeof clearTimeout>[0]>();
    // Only the host backoffs join the lease clock. Transport and scheduler
    // callbacks still run on their real event boundaries.
    using _timeout = stub(
      globalThis,
      "setTimeout",
      ((...timeoutArgs: Parameters<typeof setTimeout>) => {
        const [callback, delay, ...args] = timeoutArgs;
        if (delay === backoffBase || delay === backoffBase * 2) {
          backoffDelays.push(delay);
          const timer = controlledTimeout(callback, delay, ...args);
          backoffTimers.add(timer);
          return timer;
        }
        return realSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout,
    );
    using _clearTimeout = stub(globalThis, "clearTimeout", (timer) => {
      if (timer !== undefined && backoffTimers.delete(timer)) {
        controlledClearTimeout(timer);
      } else {
        realClearTimeout(timer);
      }
    });
    const host = new ExecutorHost({
      server: f.server,
      serviceIdentity: serviceSigner.did(),
      ensureSpaceRoots: false,
      policy: {
        failureParkBackoffBaseMs: backoffBase,
        failureParkBackoffMaxMs: backoffBase * 4,
      },
      createRuntime: async (_space, context) => {
        if (++builds === 1) return await f.createRuntime(context);
        const built = await freshServingRuntime(f.server);
        secondStarted.resolve();
        await releaseSecond.promise;
        return built;
      },
    });
    const observe = () =>
      host.runLifecycleVerb(space, {
        name: "observe-initialization",
        run: () => Promise.resolve(),
      });
    try {
      await alice.getCell<number>(space, "backoff-demand", undefined).sync();
      await f.entered.promise;
      const initial = observe();
      releaseExecutionLease(f.engine, {
        space,
        holder: host.spaceServer(space)!.holder,
      });
      time.tick(5_000);
      f.release.resolve();
      await expect(initial).rejects.toThrow("not served");
      expect(backoffDelays).toEqual([backoffBase]);
      time.tick(backoffBase - 1);
      expect(builds).toBe(1);
      time.tick(1);
      await secondStarted.promise;
      expect(builds).toBe(2);
      const second = observe();
      releaseExecutionLease(f.engine, {
        space,
        holder: host.spaceServer(space)!.holder,
      });
      time.tick(5_000);
      releaseSecond.resolve();
      await expect(second).rejects.toThrow("not served");
      expect(backoffDelays).toEqual([backoffBase, backoffBase * 2]);
      expect(host.stats().reactivationBackoffs).toBe(2);
      await host.close();
      expect(builds).toBe(2);
      expect(time.next()).toBe(false);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
    } finally {
      f.release.resolve();
      releaseSecond.resolve();
      await host.close();
      try {
        await alice.dispose({ closeStorage: false });
      } finally {
        await aliceManager.close();
      }
      await f.close();
    }
  });

  it("waits for an initializing runtime's disposal before host close returns", async () => {
    const f = await fixture();
    const aliceManager = EmulatedStorageManager.connectTo(f.server, {
      as: aliceSigner,
    });
    const alice = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: aliceManager,
    });
    const releaseDisposal = defer<void>();
    f.holdDisposal(releaseDisposal.promise);
    using time = new FakeTime();
    using _timeout = stub(globalThis, "setTimeout", realSetTimeout);
    using _clearTimeout = stub(globalThis, "clearTimeout", realClearTimeout);
    const host = new ExecutorHost({
      server: f.server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (_space, context) => f.createRuntime(context),
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await alice.getCell<number>(space, "host-demand", undefined).sync();
      await f.entered.promise;
      closing = host.close().then(() => {
        closed = true;
      });
      time.tick(20_000);
      f.release.resolve();
      await f.disposeEntered.promise;
      expect(closed).toBe(false);
      expect(f.disposeCalls).toBe(1);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeDefined();
      releaseDisposal.resolve();
      await closing;
      expect(closed).toBe(true);
      expect(liveExecutionLeaseHolder(f.engine, space)).toBeUndefined();
      expect(host.stats().activeSpaces).toBe(0);
      expect(time.next()).toBe(false);
    } finally {
      f.release.resolve();
      releaseDisposal.resolve();
      await closing;
      await host.close();
      try {
        await alice.dispose({ closeStorage: false });
      } finally {
        await aliceManager.close();
      }
      await f.close();
    }
    expect(f.disposeCalls).toBe(1);
  });
});
