import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  getServerExecutionConfig,
  resolveScopeKey,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";

const owner = await Identity.fromPassphrase("root preload owner");
const service = await Identity.fromPassphrase("root preload service");
const space = owner.did();
const rootIds = [
  "of:preload-root-a",
  "of:preload-root-b",
  "of:preload-root-c",
] as const;

/** Drains transport and scheduler work with positive-delay timers fixed. */
async function settle<T>(work: Promise<T>): Promise<T> {
  await clock.settle();
  return await work;
}

describe("SpaceServer", () => {
  // The demand pass's structure loads run one at a time, because a load may
  // start a piece. Each begins by syncing the root document it was handed, and
  // those syncs are what these cases watch: whether the pass has them all in
  // flight at once, which is what lets the replica coalesce them into one
  // pull, or issues them one resolved sync after another.

  let previous: boolean;
  let cycles: ArrivalLog<void>;
  let server: ReturnType<typeof newSharedServer>;
  let serving: SpaceServer | undefined;
  let client: Runtime | undefined;
  let clientManager:
    | ReturnType<typeof EmulatedStorageManager.connectTo>
    | undefined;

  beforeEach(() => {
    previous = getServerExecutionConfig();
    setServerExecutionConfig(true);
    cycles = new ArrivalLog();
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  });

  afterEach(async () => {
    try {
      if (serving !== undefined) await settle(serving.park("test-teardown"));
      if (client !== undefined) await settle(client.dispose());
      if (clientManager !== undefined) await settle(clientManager.close());
      await settle(server.close());
    } finally {
      serving = undefined;
      client = undefined;
      clientManager = undefined;
      setServerExecutionConfig(previous);
    }
  });

  /**
   * Writes a plain value document at each of `rootIds` and exposes all three
   * as space-scoped demand roots.
   *
   * None carries pattern metadata, so each one's structure load is a
   * single-hop traversal that syncs the root and terminalizes — the shape a
   * board's value documents take, and the one the pass pays a round trip for.
   * A client runtime is held open for the case's whole length, because a space
   * with no live client session parks itself idle.
   */
  async function openFixture() {
    const engine = await server.engineForSpace(space);
    const commit = Engine.applyCommit(engine, {
      space,
      sessionId: "preload-fixture",
      principal: service.did(),
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: rootIds.map((id) => ({
          op: "set",
          id,
          scope: "space",
          value: { value: { plain: 1 } },
        })),
      },
    });
    expect(commit.revisions).toHaveLength(rootIds.length);
    clientManager = EmulatedStorageManager.connectTo(server, { as: owner });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    // One read opens the session the space's liveness is read from. Its
    // document is beside the case's own and is never demanded.
    await settle(
      client.getCellFromLink({
        space,
        id: "of:preload-presence",
        scope: "space",
        path: [],
      }).sync(),
    );
    const manager = EmulatedStorageManager.connectTo(server, { as: service });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const scopeKey = resolveScopeKey("space", { principal: service.did() });
    // Every root sync, in the order it was ISSUED, and the order each one
    // RESOLVED. Issued together the two orders differ; issued one at a time
    // they interleave, because each sync resolves before the next is made.
    const issued: string[] = [];
    const resolved: string[] = [];
    let concurrentPeak = 0;
    let inFlight = 0;
    const sync = manager.syncCell.bind(manager);
    manager.syncCell = async (cell, options) => {
      const id = cell.getAsNormalizedFullLink().id;
      const watched = (rootIds as readonly string[]).includes(id);
      if (watched) {
        issued.push(id);
        inFlight += 1;
        concurrentPeak = Math.max(concurrentPeak, inFlight);
      }
      try {
        return await sync(cell, options);
      } finally {
        if (watched) {
          inFlight -= 1;
          resolved.push(id);
        }
      }
    };
    const facade = new Proxy(server, {
      get(target, key, receiver) {
        if (key === "demandedInstancesForSpace") {
          return () =>
            rootIds.map((id) => ({ id, scope: "space", scopeKey, root: true }));
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
      onWaveCycle: cycles.record,
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
    server.setServerExecutionObserver({
      commitAdmitted: (notice) => serving?.enqueueCommit(notice),
    });
    return {
      engine,
      manager,
      runtime,
      stats,
      serving,
      issued,
      resolved,
      concurrentPeak: () => concurrentPeak,
    };
  }

  describe("instance members", () => {
    describe("activate()", () => {
      it("holds every demanded root's sync in flight at once before the structure loads run", async () => {
        const fixture = await openFixture();

        expect(await settle(fixture.serving.activate())).toBe(true);
        await awaitEach(
          cycles,
          () => fixture.stats.structureLoadTerminal === rootIds.length,
        );

        expect(fixture.concurrentPeak()).toBe(rootIds.length);
        expect(fixture.stats.demand.structureRootsPreloaded).toBe(
          rootIds.length,
        );
      });

      it("defers a root a commit touched while the pull that read it was in flight", async () => {
        // The pull registers each root's watch, and a registered watch is what
        // lets the traversal read from the replica rather than fetch — so a
        // commit admitted between the two is one the root's reading may not
        // carry. The verdict is meta-less either way here; what the case turns
        // on is whether the pass invalidates it.

        const fixture = await openFixture();
        const sync = fixture.manager.syncCell.bind(fixture.manager);
        let wrote = false;
        fixture.manager.syncCell = async (cell, options) => {
          // The pull's call carries no transaction; a traversal's carries its
          // own immediate one.
          if (
            !wrote && cell.tx === undefined &&
            cell.getAsNormalizedFullLink().id === rootIds[0]
          ) {
            wrote = true;
            await server.writeDocument(space, rootIds[0], { plain: 2 });
          }
          return await sync(cell, options);
        };

        expect(await settle(fixture.serving.activate())).toBe(true);
        // The invalidated root parks once its retry reads the written value,
        // so the pass parks more often than it has roots.
        await awaitEach(
          cycles,
          () => fixture.stats.structureLoadTerminal > rootIds.length,
        );

        expect(wrote).toBe(true);
        expect(fixture.stats.structureLoadDeferred).toBe(1);
        expect(fixture.stats.structureLoadFailures).toBe(0);
        expect(fixture.stats.structureLoadStuck).toBe(0);
      });

      it("syncs each demanded root it terminalizes, and terminalizes each one once", async () => {
        const fixture = await openFixture();

        expect(await settle(fixture.serving.activate())).toBe(true);
        await awaitEach(
          cycles,
          () => fixture.stats.structureLoadTerminal === rootIds.length,
        );

        expect(new Set(fixture.resolved)).toEqual(new Set(rootIds));
        expect(fixture.stats.structureLoadDeferred).toBe(0);
        expect(fixture.stats.structureLoadFailures).toBe(0);
      });
    });
  });
});
