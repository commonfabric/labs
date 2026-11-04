/**
 * Observes terminal confirmation and demand-grace causality on a real serving
 * loop. Only the grace callback is held; loop-idle events drive each assertion.
 * These controlled scheduling observations make no latency claim.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import { defer } from "@commonfabric/utils/defer";

import type { Cell } from "../../packages/runner/src/cell.ts";
import { SpaceServer } from "../../packages/runner/src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../packages/runner/src/executor/stats.ts";
import { Runtime } from "../../packages/runner/src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../packages/runner/src/storage/v2-emulate.ts";

const space = (await Identity.fromPassphrase("terminal campaign space")).did();
const signer = await Identity.fromPassphrase("terminal campaign service");
const server = newLoopbackServer({ subscriptionRefreshDelayMs: "manual" });
const engine = await server.engineForSpace(space);
const stats = emptyServingLoopStats();
const roots = ["of:campaign-plain-a"];
const facade = new Proxy(server, {
  get(target, key, receiver) {
    if (key === "demandedInstancesForSpace") {
      return () =>
        roots.map((id) => ({
          id,
          scope: "space",
          scopeKey: "space",
          root: true,
        }));
    }
    const value = Reflect.get(target, key, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const syncs: { id: string; callers: string[]; engineSeq: number }[] = [];
const snapshots: Record<string, unknown>[] = [];
let loopIdle = defer<void>();
let heldGrace: { id: number; fire: () => void } | undefined;
let graceArms = 0;
let graceFires = 0;
let graceCancels = 0;
let inputWaitTimerFires = 0;
let deadlineTimerArms = 0;
let deadlineTimerFires = 0;
const timerFirings: { caller: string; delay: unknown }[] = [];
const setTimer = globalThis.setTimeout;
const clearTimer = globalThis.clearTimeout;

globalThis.setTimeout = new Proxy(setTimer, {
  apply(target, receiver, args) {
    const stack = new Error().stack ?? "";
    if (stack.includes("SpaceServer.noteDemandChanged")) {
      expect(heldGrace).toBeUndefined();
      const [callback, , ...callbackArgs] = args;
      expect(typeof callback).toBe("function");
      const id = -(++graceArms);
      heldGrace = {
        id,
        fire: () => {
          heldGrace = undefined;
          graceFires += 1;
          if (typeof callback === "function") callback(...callbackArgs);
        },
      };
      return id;
    }
    const caller = stack.split("\n")[2] ?? "";
    const inputWait = caller.includes("SpaceServer.#waitForInput");
    const callback = args[0];
    const deadline = caller.includes("/executor/space-server.ts:") &&
      stack.includes("SpaceServer.#waveCycle") &&
      typeof callback === "function" &&
      Function.prototype.toString.call(callback).includes('"deadline"');
    if (deadline) deadlineTimerArms += 1;
    if (inputWait || deadline) {
      expect(typeof callback).toBe("function");
      args[0] = (...callbackArgs: unknown[]) => {
        timerFirings.push({ caller, delay: args[1] });
        if (inputWait) inputWaitTimerFires += 1;
        if (deadline) deadlineTimerFires += 1;
        if (typeof callback === "function") callback(...callbackArgs);
      };
    }
    const timer = Reflect.apply(target, receiver, args);
    if (inputWait) loopIdle.resolve();
    return timer;
  },
});
globalThis.clearTimeout = (id) => {
  if (heldGrace?.id === id) {
    heldGrace = undefined;
    graceCancels += 1;
  } else clearTimer(id);
};

const serving = new SpaceServer({
  space,
  server: facade,
  engine,
  serviceIdentity: signer.did(),
  ensureSpaceRoots: false,
  localSeqRef: { value: 0 },
  stats,
  createRuntime: () => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const sync = manager.syncCell.bind(manager);
    manager.syncCell = <T>(
      cell: Cell<T>,
      options?: Parameters<typeof manager.syncCell>[1],
    ): Promise<Cell<T>> => {
      syncs.push({
        id: cell.getAsNormalizedFullLink().id,
        callers: (new Error().stack ?? "").split("\n").filter((line) =>
          /confirmNoPatternMeta|followResultCellChain|attemptStructureLoad/
            .test(
              line,
            )
        ),
        engineSeq: Engine.serverSeq(engine),
      });
      return sync(cell, options);
    };
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    return Promise.resolve({
      runtime,
      dispose: async () => {
        try {
          await runtime.dispose();
        } finally {
          await manager.close();
        }
      },
    });
  },
});

const snapshot = (phase: string) => {
  expect(inputWaitTimerFires).toBe(0);
  expect(deadlineTimerArms).toBeGreaterThan(0);
  expect(deadlineTimerFires).toBe(0);
  expect(stats.wavesBudgetExhausted).toBe(0);
  snapshots.push({
    phase,
    graceArms,
    graceFires,
    graceCancels,
    inputWaitTimerFires,
    deadlineTimerArms,
    deadlineTimerFires,
    terminal: stats.structureLoadTerminal,
    passes: stats.demand.demandPasses,
    waveClosures: stats.waves,
    budgetExhaustedCycles: stats.wavesBudgetExhausted,
    engineSeq: Engine.serverSeq(engine),
    watermark: serving.watermark,
    syncs: syncs.length,
    sessionsIncludingServing: server.demandSetSizesForSpace(space),
    sessionsExcludingServing: server.demandSetSizesForSpace(space, {
      excludePrincipal: signer.did(),
    }),
  });
};

/** Fires exactly the observed demand-grace callback and waits for loop idle. */
async function fireGrace(): Promise<void> {
  expect(heldGrace).toBeDefined();
  loopIdle = defer<void>();
  heldGrace!.fire();
  await loopIdle.promise;
}

try {
  for (const suffix of ["a", "b", "c"]) {
    await server.writeDocument(space, `of:campaign-plain-${suffix}`, {
      plain: 1,
    });
  }
  expect(await serving.activate()).toBe(true);
  await loopIdle.promise;
  expect(stats.structureLoadTerminal).toBe(1);
  snapshot("initial-terminal");

  roots.push("of:campaign-plain-b");
  const passes = stats.demand.demandPasses;
  for (let index = 0; index < 20; index++) serving.noteDemandChanged();
  expect(graceArms).toBe(1);
  expect(stats.demand.demandPasses).toBe(passes);
  await fireGrace();
  expect(stats.structureLoadTerminal).toBe(2);
  expect(stats.demand.demandPasses).toBeGreaterThan(passes);
  snapshot("twenty-notes-one-grace-callback");

  roots.push("of:campaign-plain-c");
  serving.noteDemandChanged();
  const fired = graceFires;
  const input = await server.writeDocument(space, "of:campaign-input", {
    n: 1,
  });
  loopIdle = defer<void>();
  serving.enqueueCommit({
    space,
    seq: input.seq,
    class: "system",
    sessionId: "session:campaign-input",
    writes: [{ id: "of:campaign-input", scopeKey: "space" }],
  });
  await loopIdle.promise;
  expect(stats.structureLoadTerminal).toBe(3);
  expect(graceFires).toBe(fired);
  expect(heldGrace).toBeDefined();
  snapshot("input-pass-before-grace-fires");
  await fireGrace();

  roots.shift();
  serving.noteDemandChanged();
  await fireGrace();
  const beforeRearrival = syncs.filter((row) =>
    row.id === "of:campaign-plain-a"
  )
    .length;
  roots.push("of:campaign-plain-a");
  serving.noteDemandChanged();
  await fireGrace();
  expect(stats.structureLoadTerminal).toBe(4);
  expect(syncs.filter((row) => row.id === "of:campaign-plain-a").length)
    .toBeGreaterThan(beforeRearrival);
  snapshot("departure-rearrival-reconfirms");
  console.log(
    JSON.stringify({ status: "passed", snapshots, syncs, timerFirings }),
  );
} catch (error) {
  console.log(JSON.stringify({
    status: "failed",
    snapshots,
    syncs,
    timerFirings,
    inputWaitTimerFires,
    deadlineTimerArms,
    deadlineTimerFires,
    budgetExhaustedCycles: stats.wavesBudgetExhausted,
  }));
  throw error;
} finally {
  try {
    await serving.park("campaign-probe-complete");
  } finally {
    globalThis.setTimeout = setTimer;
    globalThis.clearTimeout = clearTimer;
    await server.close();
  }
}
