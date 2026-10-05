import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  getServerExecutionConfig,
  type ScopeKeyIdentity,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as Engine from "@commonfabric/memory/v2/engine";
import type {
  DemandedInstanceRow,
  SessionDemand,
} from "@commonfabric/memory/v2/server";

import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "../memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("demand pass owner");
const service = await Identity.fromPassphrase("demand pass service");
const aliceSigner = await Identity.fromPassphrase("demand pass alice");
const alice = aliceSigner.did();
const bob = (await Identity.fromPassphrase("demand pass bob")).did();
const space = owner.did();

/** Drains transport and scheduler work with positive-delay timers fixed. */
async function settle<T>(work: Promise<T>): Promise<T> {
  await clock.settle();
  return await work;
}

/**
 * A space-scoped demand row of `sessionId` for `id`, demanded by `principal`
 * or by an anonymous session when none is given. The ids the cases use are
 * `computed:` ids, which own no piece, so a root among them costs the pass no
 * structure load.
 */
const row = (
  id: string,
  sessionId: string,
  principal?: string,
): DemandedInstanceRow => ({
  id,
  scope: "space",
  scopeKey: "space",
  identity: {
    ...(principal === undefined ? {} : { principal }),
    sessionId,
  },
  root: false,
});

/** A session's share of the demand set holding `rows`. */
const share = (
  sessionId: string,
  rows: DemandedInstanceRow[],
): SessionDemand => ({
  sessionId,
  rows: new Map(rows.map((entry) => [`space\0${entry.id}`, entry])),
});

describe("SpaceServer", () => {
  // Each case hands the serving loop its client demand directly, as the
  // per-session shares the memory server's `demandForSpace()` returns, and
  // keeps a share's object while that session's demand is unchanged — the
  // contract the loop's delta reconcile rests on. What the cases read is what
  // a pass does to the scheduler: the instances it enters and leaves, and the
  // demanding pairs it re-arms the currency check for.

  let previous: boolean;
  let server: ReturnType<typeof newSharedServer>;
  let serving: SpaceServer | undefined;

  beforeEach(() => {
    previous = getServerExecutionConfig();
    setServerExecutionConfig(true);
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
  });

  afterEach(async () => {
    try {
      if (serving !== undefined) await settle(serving.park("test-teardown"));
      await settle(server.close());
    } finally {
      serving = undefined;
      setServerExecutionConfig(previous);
    }
  });

  /**
   * Opens a serving loop whose client demand is `initial`, or, given
   * `"served"`, the demand of the memory server's own client sessions.
   */
  async function openFixture(initial: SessionDemand[] | "served") {
    const engine = await server.engineForSpace(space);
    const manager = EmulatedStorageManager.connectTo(server, { as: service });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const entered: string[] = [];
    const left: string[] = [];
    const rearmed: Array<{ id: string; demander: ScopeKeyIdentity }> = [];
    const scheduler = runtime.scheduler;
    const enter = scheduler.enterDemandedEntity.bind(scheduler);
    const leave = scheduler.leaveDemandedEntity.bind(scheduler);
    const rearm = scheduler.rearmNotCurrentForDemander.bind(scheduler);
    // A failing enter throws after the scheduler has counted the entity,
    // which is where the scheduler's own enter can throw.
    let throwOnEnter: string | undefined;
    let throwOnRearm: string | undefined;
    scheduler.enterDemandedEntity = (address) => {
      entered.push(address.id);
      const writers = enter(address);
      if (address.id === throwOnEnter) {
        throwOnEnter = undefined;
        throw new Error(`entering ${address.id} fails`);
      }
      return writers;
    };
    scheduler.leaveDemandedEntity = (address) => {
      left.push(address.id);
      leave(address);
    };
    scheduler.rearmNotCurrentForDemander = (address, demander) => {
      if (address.id === throwOnRearm) {
        throwOnRearm = undefined;
        throw new Error(`re-arming ${address.id} fails`);
      }
      rearmed.push({ id: address.id, demander });
      return rearm(address, demander);
    };
    let demand = initial === "served" ? [] : initial;
    const excluded: Array<string | undefined> = [];
    const facade = initial === "served" ? server : new Proxy(server, {
      get(target, key, receiver) {
        if (key === "demandForSpace") {
          return (
            _space: string,
            options: { excludePrincipal?: string } = {},
          ) => {
            excluded.push(options.excludePrincipal);
            return demand;
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stats = emptyServingLoopStats();
    serving = new SpaceServer({
      space,
      server: facade,
      engine,
      serviceIdentity: service.did(),
      ensureSpaceRoots: false,
      localSeqRef: { value: 0 },
      stats,
      policy: { idleParkMs: 600_000 },
      createRuntime: () =>
        Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        }),
    });
    const tenure = serving;
    server.setServerExecutionObserver({
      commitAdmitted: (notice) => tenure.enqueueCommit(notice),
    });
    expect(await settle(tenure.activate())).toBe(true);
    return {
      engine,
      stats,
      serving: tenure,
      entered,
      left,
      rearmed,
      excluded,
      /** Replaces the client demand and runs the pass it wakes. */
      async pass(next: SessionDemand[] = demand): Promise<void> {
        demand = next;
        const passes = stats.demand.demandPasses;
        tenure.noteDemandChanged();
        await clock.tick(300);
        await clock.settle();
        expect(stats.demand.demandPasses).toBeGreaterThan(passes);
      },
      /**
       * Replaces the client demand and runs the pass it wakes, which throws
       * when it enters `id`, or when it first re-arms a demanding pair of
       * `id` given `"rearm"`, along with any pass the loop runs after it.
       */
      async passThrowingOn(
        id: string,
        next: SessionDemand[],
        call: "enter" | "rearm" = "enter",
      ): Promise<void> {
        demand = next;
        if (call === "enter") throwOnEnter = id;
        else throwOnRearm = id;
        tenure.noteDemandChanged();
        await clock.tick(300);
        await clock.settle();
        expect(throwOnEnter).toBeUndefined();
        expect(throwOnRearm).toBeUndefined();
      },
      /** Forgets the scheduler calls recorded so far. */
      forget(): void {
        entered.length = 0;
        left.length = 0;
        rearmed.length = 0;
      },
    };
  }

  describe("instance members", () => {
    describe("activate()", () => {
      it("reads client demand without the serving principal's sessions", async () => {
        const fixture = await openFixture([]);

        expect(fixture.excluded.length).toBeGreaterThan(0);
        expect(new Set(fixture.excluded)).toEqual(new Set([service.did()]));
      });

      it("enters every demanded key on the tenure's first pass", async () => {
        const fixture = await openFixture([
          share("s1", [
            row("computed:a", "s1", alice),
            row("computed:b", "s1", alice),
          ]),
        ]);

        expect(fixture.entered.toSorted()).toEqual([
          "computed:a",
          "computed:b",
        ]);
        expect(fixture.stats.demand.demandKeysReconciled).toBe(2);
        expect(fixture.stats.demand.demandedInstances).toBe(2);
        expect(fixture.stats.demand.demandedRows).toBe(2);
        expect(fixture.stats.demand.demandedPairs).toBe(2);
      });
    });

    describe("noteDemandChanged()", () => {
      it("reconciles no key and touches no instance on a pass over unchanged demand", async () => {
        const fixture = await openFixture([
          share("s1", [
            row("computed:a", "s1", alice),
            row("computed:b", "s1", alice),
          ]),
          share("s2", [row("computed:b", "s2", bob)]),
        ]);
        const reconciled = fixture.stats.demand.demandKeysReconciled;
        fixture.forget();

        await fixture.pass();

        expect(fixture.stats.demand.demandKeysReconciled).toBe(reconciled);
        expect(fixture.entered).toEqual([]);
        expect(fixture.left).toEqual([]);
        expect(fixture.rearmed).toEqual([]);
        expect(fixture.stats.demand.demandedInstances).toBe(2);
        expect(fixture.stats.demand.demandedRows).toBe(3);
        expect(fixture.stats.demand.demandedPairs).toBe(3);
      });

      it("counts only the keys of passes that complete when a pass throws partway", async () => {
        const fixture = await openFixture([
          share("s1", [row("computed:a", "s1", alice)]),
        ]);
        const reconciled = fixture.stats.demand.demandKeysReconciled;

        await fixture.passThrowingOn("computed:c", [
          share("s1", [
            row("computed:a", "s1", alice),
            row("computed:b", "s1", alice),
            row("computed:c", "s1", alice),
          ]),
        ]);
        await fixture.pass();

        expect(fixture.stats.demand.demandKeysReconciled).toBe(reconciled + 3);
      });

      it("enters a key again, and leaves it once for each enter, after a pass whose enter of it throws", async () => {
        const fixture = await openFixture([
          share("s1", [row("computed:a", "s1", alice)]),
        ]);
        fixture.forget();

        await fixture.passThrowingOn("computed:c", [
          share("s1", [
            row("computed:a", "s1", alice),
            row("computed:c", "s1", alice),
          ]),
        ]);
        await fixture.pass();

        expect(fixture.entered.filter((id) => id === "computed:c")).toEqual([
          "computed:c",
          "computed:c",
        ]);
        expect(fixture.serving.demandedIdentitiesOf("computed:c")).toEqual([
          { principal: alice, sessionId: "s1" },
        ]);

        await fixture.pass([share("s1", [row("computed:a", "s1", alice)])]);

        expect(fixture.left).toEqual(["computed:c", "computed:c"]);
      });

      it("re-arms a pair again after a pass whose re-arm of it throws", async () => {
        const first = share("s1", [row("computed:a", "s1", alice)]);
        const fixture = await openFixture([first]);
        fixture.forget();

        await fixture.passThrowingOn(
          "computed:a",
          [first, share("s2", [row("computed:a", "s2", bob)])],
          "rearm",
        );
        await fixture.pass();

        expect(fixture.rearmed).toEqual([{
          id: "computed:a",
          demander: { principal: bob, sessionId: "s2" as never },
        }]);
        expect(fixture.stats.demand.demandedPairs).toBe(2);
      });

      it("enters the keys a session gains and leaves the keys no session keeps", async () => {
        const kept = share("s2", [row("computed:b", "s2", bob)]);
        const fixture = await openFixture([
          share("s1", [
            row("computed:a", "s1", alice),
            row("computed:b", "s1", alice),
          ]),
          kept,
        ]);
        fixture.forget();

        await fixture.pass([
          share("s1", [
            row("computed:b", "s1", alice),
            row("computed:c", "s1", alice),
          ]),
          kept,
        ]);

        expect(fixture.entered).toEqual(["computed:c"]);
        expect(fixture.left).toEqual(["computed:a"]);
        expect(fixture.rearmed.map((entry) => entry.id)).toEqual([
          "computed:c",
        ]);
        expect(fixture.stats.demand.demandedInstances).toBe(2);
        expect(fixture.stats.demand.demandedPairs).toBe(3);
      });

      it("re-arms the currency check for an arriving pair alone, and retires a departing one", async () => {
        const first = share("s1", [row("computed:a", "s1", alice)]);
        const fixture = await openFixture([first]);
        fixture.forget();

        await fixture.pass([
          first,
          share("s2", [row("computed:a", "s2", bob)]),
        ]);

        expect(fixture.entered).toEqual([]);
        expect(fixture.rearmed).toEqual([{
          id: "computed:a",
          demander: { principal: bob, sessionId: "s2" as never },
        }]);
        expect(fixture.serving.demandedIdentitiesOf("computed:a")).toHaveLength(
          2,
        );
        fixture.forget();

        await fixture.pass([first]);

        expect(fixture.left).toEqual([]);
        expect(fixture.rearmed).toEqual([]);
        expect(fixture.serving.demandedIdentitiesOf("computed:a")).toEqual([
          { principal: alice, sessionId: "s1" },
        ]);
        expect(fixture.stats.demand.demandedPairs).toBe(1);
      });

      it("enters an anonymous session's key with no demanding pair", async () => {
        const fixture = await openFixture([]);
        fixture.forget();

        await fixture.pass([
          share("anonymous", [row("computed:a", "anonymous")]),
        ]);

        expect(fixture.entered).toEqual(["computed:a"]);
        expect(fixture.rearmed).toEqual([]);
        expect(fixture.serving.demandedIdentitiesOf("computed:a")).toEqual([]);
        expect(fixture.stats.demand.demandedPairs).toBe(0);
      });

      it("rebuilds no session's share on a pass over a live session's unchanged demand", async () => {
        const engine = await server.engineForSpace(space);
        Engine.applyCommit(engine, {
          space,
          sessionId: "demand-pass-seed",
          principal: service.did(),
          commitClass: "system",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: ["computed:a", "computed:b"].map((id) => ({
              op: "set",
              id,
              scope: "space",
              value: { value: { id } },
            })),
          },
        });
        const client = await MemoryV2Client.connect({
          transport: MemoryV2Client.loopback(server),
        });
        try {
          const session = await client.mount(
            space,
            {},
            testPrincipalSessionOpenAuthFactory(aliceSigner),
          );
          await session.watchSet(
            ["computed:a", "computed:b"].map((id) => ({
              id,
              kind: "graph" as const,
              query: {
                roots: [{ id, selector: { path: [], schema: false as const } }],
              },
            })),
          );
          const fixture = await openFixture("served");
          expect(fixture.stats.demand.demandedInstances).toBe(2);
          const builds = server.accessForTestingOnly.sessionDemandBuilds;
          const reconciled = fixture.stats.demand.demandKeysReconciled;
          fixture.forget();

          await fixture.pass();

          expect(server.accessForTestingOnly.sessionDemandBuilds).toBe(builds);
          expect(fixture.stats.demand.demandKeysReconciled).toBe(reconciled);
          expect(fixture.entered).toEqual([]);
          expect(fixture.left).toEqual([]);
        } finally {
          await settle(client.close());
        }
      });

      it("keeps a warm key demanded after the session demanding it departs", async () => {
        const fixture = await openFixture([
          share("s1", [row("computed:warm", "s1", alice)]),
        ]);
        fixture.forget();
        fixture.serving.enqueueCommit({
          space,
          seq: Engine.serverSeq(fixture.engine),
          class: "authored",
          sessionId: "warm-issuer",
          writes: [{ id: "computed:warm", scopeKey: "space" }],
          warm: true,
        });
        await fixture.pass([]);

        expect(fixture.entered).toEqual([]);
        expect(fixture.left).toEqual([]);
        expect(fixture.serving.demandedIdentitiesOf("computed:warm")).toEqual(
          [],
        );
        expect(fixture.stats.demand.demandedInstances).toBe(1);
        expect(fixture.stats.demand.demandedRows).toBe(0);
      });
    });
  });
});
