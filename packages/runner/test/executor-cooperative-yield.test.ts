// Server-execution v2 stage C tuning, T3 (serving-loop.md §2/§3): the
// serving scheduler's cooperative macrotask yield and the mid-wave lease
// renew, pinned end to end on the ExecutorHost harness (a real memory
// server, a client session, the SpaceServer's serving runtime).
//
// The attribution that motivated it (stage-c-attribution-report §2b/§3):
// the settle loop ran a whole wave's runs on one microtask chain, so the
// 100-ms flush deadline fired seconds LATE (`wavesBudgetExhausted` was a
// symptom, not a bound) and the lease-renew `setInterval` starved for up
// to 10 s against a 15-s TTL (t2: `wave-commit-rejected` then
// `lease-lost` on every space within 10 ms).
//
// - (i) HONEST DEADLINE: a synthetic 30-step walk (40 ms of synchronous
//   work per step, 1.2 s total) under a 100-ms deadline commits its first
//   (exhausted) wave within ~one step of the deadline, not after the whole
//   walk. Mutation (the yield removed from settle.ts) → the first commit
//   carries the whole walk → RED.
// - (ii) MID-WAVE RENEW: a 45-step (1.8-s) walk with a 900-ms lease TTL,
//   the renew TIMER inert (600 s) and a 5-s deadline — the wave outlives
//   the TTL twice over and still COMMITS under a live lease, because the
//   yield observer renewed it mid-wave; `lease.lost` stays 0 and the
//   lease row's expiry moved during the wave. Mutation (the observer's
//   renew removed, or the yield removed) → the lease lapses at 900 ms and
//   the wave's commit is refused at admission → RED.
// - (iii) POSTURE GATE: a runtime without `servingPosture` constructs no
//   yielder — the OFF arm and flag-ON clients keep their settle loops'
//   exact microtask shape.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { liveExecutionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { CooperativeYield } from "../src/scheduler/cooperative-yield.ts";
import { awaitAdmitted, settleServing } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("cooperative yield space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "cooperative yield service",
);
const aliceSigner = await Identity.fromPassphrase("cooperative yield alice");

/** Synchronous CPU work — a stand-in for one demand-walk instance run. */
const burn = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
};

const WALK_STEPS = 30;
const STEP_MS = 40;

/** Reads the expiry as a millisecond timestamp through SQLite's REAL accessor. */
const leaseExpiry = (engine: Engine.Engine): number =>
  (engine.database.prepare(
    // The engine's INTEGER accessor truncates to 32 bits; millisecond
    // timestamps are exactly representable as REAL values.
    `SELECT CAST(expires_at AS REAL) AS expires_at
     FROM execution_lease WHERE space = :space`,
  ).get({ space }) as { expires_at: number } | undefined)?.expires_at ?? 0;

describe("stage C tuning T3: cooperative yield + mid-wave renew", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;
  let servingRuntime: Runtime | undefined;

  const newHost = (
    policy?: ConstructorParameters<typeof ExecutorHost>[0]["policy"],
  ): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy,
    });

  beforeEach(() => {
    server = newSharedServer({
      sessions: new MemoryV2Server.SessionRegistry({ ttlMs: 600_000 }),
      subscriptionRefreshDelayMs: 0,
    });
    servingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  const openClient = () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  };

  /** Activate the space through an authored client commit and wait for
   * the loop to sit idle in wait-for-input (its watermark covering the
   * input). Only an ACTIVE space runs the wave that advances W, so the
   * settle barrier reports the activation as well as the cycle. */
  const activate = async (): Promise<Engine.Engine> => {
    openClient();
    const engine = await server.engineForSpace(space);
    const input = clientRuntime.getCell<{ value: number }>(
      space,
      "yield-input",
      undefined,
    );
    const tx = clientRuntime.edit();
    input.withTx(tx).set({ value: 1 });
    expect((await tx.commit().settled).error).toBeUndefined();
    await settleServing(engine, clientRuntime, space);
    expect(host!.spaceServer(space)?.active).toBe(true);
    return engine;
  };

  /** Register the synthetic walk on the SERVING runtime: WALK_STEPS
   * effects, each burning STEP_MS synchronously and sealing one write.
   * They run in the next execute pass — one settle of ~1.2 s inside the
   * wave that their first seal opens. Returns the out-doc ids. */
  const registerWalk = (steps: number = WALK_STEPS): string[] => {
    const runtime = servingRuntime!;
    const trigger = runtime.getCell<{ value: number }>(
      space,
      "yield-input",
      undefined,
    );
    const outIds: string[] = [];
    for (let step = 0; step < steps; step++) {
      const out = runtime.getCell<{ step: number; n: number }>(
        space,
        `yield-walk-out-${step}`,
        undefined,
      );
      outIds.push(out.getAsNormalizedFullLink().id);
      const walk = (tx: IExtendedStorageTransaction): void => {
        const value = trigger.withTx(tx).get() as
          | { value?: number }
          | undefined;
        burn(STEP_MS);
        out.withTx(tx).set({ step, n: value?.value ?? 0 });
      };
      Object.defineProperty(walk, "name", {
        value: `synthetic-walk-${step}`,
        configurable: true,
      });
      runtime.scheduler.register(walk, undefined, { isEffect: true });
    }
    return outIds;
  };

  const storedOutCount = (
    engine: Engine.Engine,
    outIds: readonly string[],
  ): number =>
    outIds.filter((id) => Engine.read(engine, { id }) !== null).length;

  it("(i) the flush deadline is honest: a 1.2-s synthetic walk under a 100-ms deadline commits its first, exhausted wave within about one step of the deadline — not after the whole walk (mutation: yield removed → the first commit waits out the walk)", async () => {
    host = newHost({ flushDeadlineMs: 100, idleParkMs: 600_000 });
    const engine = await activate();
    const before = host.stats();
    const seqBefore = Engine.serverSeq(engine);

    const outIds = registerWalk();
    // The predicate runs on each commit's admission, before a later wave
    // can commit, so the steps counted here are the ones the first commit
    // carried.
    let stepsInFirstCommit = -1;
    await awaitAdmitted(server, () => {
      if (Engine.serverSeq(engine) === seqBefore) return false;
      stepsInFirstCommit = storedOutCount(engine, outIds);
      return true;
    });
    // Without the yield the deadline can only fire after the walk's last
    // step. With it the first (exhausted) commit lands about one step past
    // the deadline, a few steps into the walk. Each step burns STEP_MS of
    // wall-clock time, so a process descheduled mid-walk lets fewer steps
    // run before the deadline, never more.
    expect(stepsInFirstCommit).toBeGreaterThan(0);
    expect(stepsInFirstCommit).toBeLessThan(WALK_STEPS / 2);
    // The walk still completes in full: every step's write lands, and W
    // eventually covers everything (the last cycle settles un-exhausted).
    await awaitAdmitted(
      server,
      () => storedOutCount(engine, outIds) === WALK_STEPS,
    );
    // The walk is twelve deadlines long, so waves were exhausted on the
    // way to the writes above.
    expect(host.stats().wavesBudgetExhausted)
      .toBeGreaterThan(before.wavesBudgetExhausted);
    // The scheduler yielded (the mechanism, not just the effect).
    expect(servingRuntime!.scheduler.servingYield).toBeDefined();
    expect(servingRuntime!.scheduler.servingYield!.yieldCount)
      .toBeGreaterThan(0);
    expect(host.stats().lease.lost).toBe(0);
  });

  it("(ii) a wave longer than TTL/3 renews the lease MID-WAVE from the yield observer, with the renew timer inert: a 1.8-s walk outlives a 900-ms TTL twice over and still commits under a live lease; lease.lost stays 0 (mutation: renew-on-yield removed → the lease lapses and the wave's commit is refused)", async () => {
    // The TTL clock starts at acquire (activation), so the headroom for
    // activation + boot settle + walk registration is the TTL itself:
    // 900 ms against a measured 30–100 ms; a slower box has ~9× slack.
    const ttlMs = 900;
    const walkSteps = 45;
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      // The interval timer never fires within the test: every renewal
      // that lands is the mid-wave belt.
      renewIntervalMs: 600_000,
      leaseTtlMs: ttlMs,
    });
    const engine = await activate();
    const spaceServer = host.spaceServer(space)!;
    const expiryAtStart = leaseExpiry(engine);
    expect(expiryAtStart).toBeGreaterThan(Date.now());
    const seqBefore = Engine.serverSeq(engine);
    const derivedBefore = host.stats().derivedCommits;

    const outIds = registerWalk(walkSteps);
    // The wave commits — under a lease that would have EXPIRED 900 ms in
    // without the mid-wave renew (the walk is 1 800 ms; the deadline 5 s,
    // so it is ONE wave).
    await awaitAdmitted(
      server,
      () => storedOutCount(engine, outIds) === walkSteps,
    );
    expect(Engine.serverSeq(engine)).toBeGreaterThan(seqBefore);
    expect(host.stats().derivedCommits).toBeGreaterThan(derivedBefore);
    expect(host.stats().lease.lost).toBe(0);
    expect(spaceServer.active).toBe(true);
    // The row was renewed while the wave ran (no timer could have).
    expect(leaseExpiry(engine)).toBeGreaterThan(expiryAtStart);
    expect(liveExecutionLeaseHolder(engine, space)).toBe(spaceServer.holder);
    expect(servingRuntime!.scheduler.servingYield!.yieldCount)
      .toBeGreaterThan(0);
  });

  it("(iii) posture gate: a runtime without servingPosture constructs no yielder — the OFF arm and flag-ON clients keep their settle loop's exact microtask shape", async () => {
    openClient();
    expect(clientRuntime.scheduler.servingYield).toBeUndefined();
    const flagOnClientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const flagOnClient = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: flagOnClientManager,
      experimental: { serverExecution: true },
    });
    try {
      expect(flagOnClient.scheduler.servingYield).toBeUndefined();
    } finally {
      await flagOnClient.dispose();
      await flagOnClientManager.close();
    }
  });

  it("CooperativeYield unit: lets a timer that fell due mid-slice fire within two yields", async () => {
    // The slice accounting is covered on the fake clock in
    // `scheduler/CooperativeYield.test.ts`. This case needs Deno's own
    // timer queue, which the fake clock replaces. That queue runs timers
    // one list per delay, earliest list first, so a zero-delay timer left
    // pending by other work can carry the first yield's turn ahead of the
    // due timer; the second yield's turn cannot pass it.

    const yielder = new CooperativeYield(20);
    let firedDuringYield = -1;
    setTimeout(() => {
      firedDuringYield = yielder.yieldCount;
    }, 10);
    // Work outlasts both the timer's delay and the slice.
    burn(25);
    const turn = yielder.maybeYield();
    expect(turn).toBeDefined();
    await turn;
    await yielder.yieldNow();
    expect([1, 2]).toContain(firedDuringYield);
  });
});
