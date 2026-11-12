import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  getServerExecutionConfig,
  resolveScopeKey,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import { cellTx } from "../../src/cell.ts";
import {
  DEFAULT_FLUSH_DEADLINE_MS,
  SpaceServer,
} from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { readWatermarkSeq } from "../../src/executor/watermark-engine.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { PieceStateMovedError } from "../../src/stored-setup-build.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { sessionDemandOf } from "../support/session-demand.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("structure load arms owner");
const service = await Identity.fromPassphrase("structure load arms service");
const space = owner.did();
const elsewhere = (await Identity.fromPassphrase("structure load arms other"))
  .did();
const logger = getLogger("space-server");

/** The pattern pointer every piece document here carries. */
const pointer = { identity: "structure-load-arms-pattern", symbol: "default" };

/** Drains transport and scheduler work with positive-delay timers fixed. */
async function settle<T>(work: Promise<T>): Promise<T> {
  await clock.settle();
  return await work;
}

/** How many times `key` was logged at `level` so far. */
function logged(key: string, level: "debug" | "info" | "warn"): number {
  return logger.countsByKey[key]?.[level] ?? 0;
}

/** A demand row: a watch root of the session `sessionId` of `principal`. */
type DemandRow = { id: string; principal: string; sessionId: string };

describe("SpaceServer", () => {
  let previous: boolean;
  let previousLevel: typeof logger.level;
  let server: ReturnType<typeof newSharedServer>;
  let serving: SpaceServer | undefined;

  beforeEach(() => {
    previous = getServerExecutionConfig();
    setServerExecutionConfig(true);
    // The structure load's info and debug reports are what several cases
    // count, and their messages are built only at this level.
    previousLevel = logger.level;
    logger.level = "debug";
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
  });

  afterEach(async () => {
    try {
      if (serving !== undefined) await settle(serving.park("test-teardown"));
      await settle(server.close());
    } finally {
      serving = undefined;
      logger.level = previousLevel;
      setServerExecutionConfig(previous);
    }
  });

  /**
   * A tenure over `space` whose client demand is the watch roots `initial`
   * names, each demanded by one viewer session.
   *
   * `commit()` writes documents as the memory server's own direct writes do,
   * announcing them to the tenure's feed and marking them for the sessions
   * watching them, whose frames `server.flushSessions()` then delivers.
   * `traversals(id)` counts the structure loads' reads of `id` and
   * `pulls(id)` the pass's pulls of it; `onSync` runs at the start of each
   * such read, so a case can act while a pass waits on one.
   *
   * The pattern `pointer` names loads once `loadable` is set, and a start of
   * a piece runs `onStart` and reports the piece started, so a case decides
   * what a start does. The owed-default seed runs `onSeed`, and following a
   * piece's origin runs `onReconcile` and finds the piece current.
   */
  async function openFixture(initial: readonly (string | DemandRow)[]) {
    const engines = new Map<string, Engine.Engine>();
    for (const target of [space, elsewhere]) {
      engines.set(target, await server.engineForSpace(target));
    }
    let localSeq = 0;
    const commit = (
      documents: Record<string, EntityDocument>,
      target: MemorySpace = space,
    ) => {
      const applied = Engine.applyCommit(engines.get(target)!, {
        space: target,
        sessionId: "structure-load-arms",
        principal: service.did(),
        commitClass: "system",
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: Object.entries(documents).map(([id, value]) => ({
            op: "set" as const,
            id,
            value,
          })),
        },
      });
      server.noteExecutorCommit({
        space: target,
        seq: applied.seq,
        class: "system",
        sessionId: "structure-load-arms",
        writes: Object.keys(documents).map((id) => ({
          id,
          scopeKey: "space" as const,
        })),
      });
      return applied.seq;
    };
    const scopeKey = resolveScopeKey("space", { principal: service.did() });
    const rowsOf = (roots: readonly (string | DemandRow)[]) =>
      roots.map((root) => {
        const { id, principal, sessionId } = typeof root === "string"
          ? { id: root, principal: owner.did(), sessionId: "viewer" }
          : root;
        return {
          id,
          scope: "space" as const,
          scopeKey,
          root: true,
          identity: { principal, sessionId },
        };
      });
    let rows = rowsOf(initial);
    const traversals = new Map<string, number>();
    const pulls = new Map<string, number>();
    const hooks: {
      onSync?: (id: string, traversal: boolean) => Promise<void> | void;
      onStart?: (id: string) => Promise<void> | void;
      onSeed?: (id: string) => Promise<boolean>;
      onReconcile?: (id: string) => Promise<void>;
    } = {};
    const manager = EmulatedStorageManager.connectTo(server, { as: service });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const sync = manager.syncCell.bind(manager);
    manager.syncCell = async (cell, options) => {
      const { id } = cell.getAsNormalizedFullLink();
      const traversal = cellTx(cell)?.tx.immediate === true;
      const counts = traversal ? traversals : pulls;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      await hooks.onSync?.(id, traversal);
      return await sync(cell, options);
    };
    let loadable = false;
    const pattern = createTrustedBuilder(runtime).commonfabric.pattern(
      () => ({}),
    );
    const load = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    runtime.patternManager.loadPatternByIdentity = (identity, ...rest) =>
      identity === pointer.identity
        ? Promise.resolve(loadable ? pattern : undefined)
        : load(identity, ...rest);
    const starts: string[] = [];
    runtime.start = async (cell) => {
      const { id } = cell.getAsNormalizedFullLink();
      starts.push(id);
      await hooks.onStart?.(id);
      return true;
    };
    const seeds: string[] = [];
    runtime.runner.seedOwedDefaultsFor = (cell, identity) => {
      const { space: target, id } = cell.getAsNormalizedFullLink();
      seeds.push(
        `${target === space ? "" : `${target} `}${id} for ` +
          identity.sessionId,
      );
      return hooks.onSeed?.(id) ?? Promise.resolve(true);
    };
    const reconciles: string[] = [];
    runtime.sourceReconciler.reconcile = async (cell) => {
      const { id } = cell.getAsNormalizedFullLink();
      reconciles.push(id);
      await hooks.onReconcile?.(id);
      return "current";
    };
    const facade = new Proxy(server, {
      get(target, key) {
        if (key === "demandForSpace") return () => sessionDemandOf(rows);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stats = emptyServingLoopStats();
    serving = new SpaceServer({
      space,
      server: facade,
      engine: engines.get(space)!,
      serviceIdentity: service.did(),
      ensureSpaceRoots: false,
      localSeqRef: { value: 0 },
      stats,
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
      engine: engines.get(space)!,
      stats,
      serving,
      runtime,
      hooks,
      starts,
      seeds,
      reconciles,
      commit,
      traversals: (id: string) => traversals.get(id) ?? 0,
      pulls: (id: string) => pulls.get(id) ?? 0,
      set loadable(value: boolean) {
        loadable = value;
      },
      /** A `result` backlink to the document `id` in `target`. */
      link: (id: URI, target: MemorySpace = space) =>
        runtime.getCellFromLink({ space: target, id, scope: "space", path: [] })
          .getAsWriteRedirectLink(),
      setDemand(roots: readonly (string | DemandRow)[]) {
        rows = rowsOf(roots);
        serving!.noteDemandChanged();
      },
      /** Reports `id`'s piece start as having failed to commit. */
      failStart(id: string) {
        runtime.pieceStartCommitFailureObserver!({
          actionId: `piece-start/${id}`,
          error: new Error("test failure of the piece's start commit"),
        });
      },
    };
  }

  describe("instance members", () => {
    describe("activate()", () => {
      it("skips a root that a failed start parked while its own load was failing, until a commit to it re-arms it", async () => {
        // The failed start parks the key terminal while its traversal is out,
        // and the traversal's failure then leaves it pending as well. Parked
        // wins: no pass pulls or traverses it until a commit touches it.

        const plain = "of:arms-parked-and-pending";
        const fixture = await openFixture([plain]);
        fixture.commit({ [plain]: { value: { plain: 1 } } });
        const startFailures = logged("structure-load-start-failed", "info");
        let failing = true;
        fixture.hooks.onSync = (id, traversal) => {
          if (id !== plain || !traversal || !failing) return;
          failing = false;
          fixture.failStart(plain);
          throw new Error("injected traversal failure");
        };
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.stats.structureLoadFailures).toBe(2);
        expect(logged("structure-load-start-failed", "info")).toBe(
          startFailures + 1,
        );
        const pulls = fixture.pulls(plain);
        const traversals = fixture.traversals(plain);
        const preloaded = fixture.stats.demand.structureRootsPreloaded;

        await settle(
          server.writeDocument(space, "of:arms-unrelated", { plain: 2 }),
        );
        expect(fixture.stats.demand.demandPasses).toBeGreaterThan(1);
        expect(fixture.pulls(plain)).toBe(pulls);
        expect(fixture.traversals(plain)).toBe(traversals);
        expect(fixture.stats.demand.structureRootsPreloaded).toBe(preloaded);
        expect(fixture.stats.structureLoadTerminal).toBe(0);

        const terminals = logged("structure-load-terminal", "info");
        fixture.commit({ [plain]: { value: { plain: 3 } } });
        await clock.settle();
        expect(fixture.stats.structureLoadRearmed).toBe(1);
        expect(fixture.traversals(plain)).toBeGreaterThan(traversals);
        expect(fixture.stats.structureLoadTerminal).toBe(1);
        expect(logged("structure-load-terminal", "info")).toBe(terminals + 1);
        expect(fixture.stats.structureLoadFailures).toBe(2);
      });

      it("leaves a pending root that a failed start re-armed during the pass to the retry after the settle", async () => {
        // A commit to the root lands while the pass pulls it, and then its
        // piece's start is reported failed, so the failure re-arms the root
        // rather than parking it. The pass that is under way does not load it
        // over the replica it pulled: the retry after the settle does.

        const plain = "of:arms-rearmed-by-failed-start";
        const fixture = await openFixture([plain]);
        fixture.commit({ [plain]: { value: { plain: 1 } } });
        let failing = true;
        let rearmed = false;
        fixture.hooks.onSync = (id, traversal) => {
          if (id !== plain) return;
          if (traversal && failing) {
            throw new Error("injected traversal failure");
          }
          if (traversal || failing || rearmed) return;
          rearmed = true;
          fixture.commit({ [plain]: { value: { plain: 2 } } });
          fixture.failStart(plain);
        };
        expect(await settle(fixture.serving.activate())).toBe(true);
        const failures = fixture.stats.structureLoadFailures;
        expect(failures).toBeGreaterThan(0);
        expect(fixture.traversals(plain)).toBe(failures);

        const startFailures = logged("structure-load-start-failed", "info");
        failing = false;
        await settle(
          server.writeDocument(space, "of:arms-unrelated", { plain: 2 }),
        );
        expect(rearmed).toBe(true);
        expect(fixture.stats.structureLoadFailures).toBe(failures + 1);
        expect(logged("structure-load-start-failed", "info")).toBe(
          startFailures,
        );
        // One retry parks the root; the commit, drained after it, re-arms the
        // parked root once more.
        expect(fixture.traversals(plain)).toBe(failures + 2);
        expect(fixture.stats.structureLoadTerminal).toBe(2);
        expect(fixture.stats.structureLoadRearmed).toBe(1);
        expect(fixture.stats.structureLoadDeferred).toBe(0);
      });

      it("defers a root whose confirmation reads a pattern that does not load yet, and starts it once the pattern loads", async () => {
        // The serving replica holds the root from before the commit that
        // gave it a pattern pointer, so the first traversal reads no
        // pointer; the engine holds one, so the confirmation reads again,
        // after the frame lands, and finds a pattern that does not load.

        const piece = "of:arms-confirmed-unloadable";
        const fixture = await openFixture([piece]);
        fixture.commit({ [piece]: { value: { plain: 1 } } });
        await settle(server.flushSessions([space]));
        await settle(
          fixture.runtime.getCellFromLink({
            space,
            id: piece,
            scope: "space",
            path: [],
          }).sync(),
        );
        fixture.commit({
          [piece]: { value: { plain: 1 }, patternIdentity: pointer },
        });
        const reread = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let reads = 0;
        fixture.hooks.onSync = async (id, traversal) => {
          if (id === piece && traversal && ++reads === 2) {
            reread.resolve();
            await release.promise;
          }
        };
        const deferrals = logged("structure-load-deferred", "debug");
        try {
          expect(await settle(fixture.serving.activate())).toBe(true);
          await settle(reread.promise);
          // The frame the replica was missing lands between the traversals.
          await settle(server.flushSessions([space]));
          release.resolve();
          await clock.settle();
        } finally {
          release.resolve();
        }
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(fixture.stats.structureLoadConfirmationsSkipped).toBe(0);
        expect(fixture.stats.structureLoadTerminal).toBe(0);
        expect(fixture.stats.structureLoadDeferred).toBe(reads - 1);
        // The confirmation's deferral leaves the root pending, and every
        // retry after it reads the pointer at once and defers again.
        expect(logged("structure-load-deferred", "debug")).toBe(
          deferrals + reads - 2,
        );
        expect(fixture.starts).toEqual([]);

        fixture.loadable = true;
        await settle(
          server.writeDocument(space, "of:arms-unrelated", { plain: 2 }),
        );
        expect(fixture.starts).toEqual([piece]);
        expect(fixture.stats.structureLoadTerminal).toBe(0);
        expect(fixture.stats.structureLoadFailures).toBe(0);
      });

      it("discards a confirmation that starts the piece after the tenure ends", async () => {
        // The confirmation's start resolves after the park: the pass ends
        // there, so the parked tenure counts no pass.

        const piece = "of:arms-confirmed-after-park";
        const fixture = await openFixture([piece]);
        fixture.loadable = true;
        fixture.commit({ [piece]: { value: { plain: 1 } } });
        await settle(server.flushSessions([space]));
        await settle(
          fixture.runtime.getCellFromLink({
            space,
            id: piece,
            scope: "space",
            path: [],
          }).sync(),
        );
        fixture.commit({
          [piece]: { value: { plain: 1 }, patternIdentity: pointer },
        });
        const reread = Promise.withResolvers<void>();
        const reading = Promise.withResolvers<void>();
        let reads = 0;
        fixture.hooks.onSync = async (id, traversal) => {
          if (id === piece && traversal && ++reads === 2) {
            reread.resolve();
            await reading.promise;
          }
        };
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        fixture.hooks.onStart = async () => {
          started.resolve();
          await release.promise;
        };
        try {
          expect(await settle(fixture.serving.activate())).toBe(true);
          await settle(reread.promise);
          await settle(server.flushSessions([space]));
          reading.resolve();
          await settle(started.promise);
          expect(reads).toBe(2);
          const passes = fixture.stats.demand.demandPasses;
          const parked = fixture.serving.park("confirmation-test");
          await clock.settle();
          release.resolve();
          await settle(parked);
          expect(fixture.starts).toEqual([piece]);
          expect(fixture.stats.demand.demandPasses).toBe(passes);
          expect(fixture.seeds).toEqual([]);
          expect(fixture.stats.structureLoadTerminal).toBe(0);
          expect(fixture.stats.structureLoadDeferred).toBe(0);
          expect(fixture.stats.structureLoadFailures).toBe(0);
        } finally {
          reading.resolve();
          release.resolve();
        }
      });

      it("parks a root whose piece's last start failed, and retries one a commit touched while the pass declined it", async () => {
        // The piece's own document parks when its start's commit is reported
        // failed. A document whose backlink leads to that piece then declines
        // to start it: a commit to the document while the pass reads the
        // chain, drained by a wave the pass outlives, re-arms it for one more
        // try, after which it parks too.

        const piece = "of:arms-declined-piece";
        const argument = "of:arms-declined-argument";
        const fixture = await openFixture([piece]);
        fixture.commit({
          [piece]: { value: {}, patternIdentity: pointer },
          [argument]: { value: {}, result: fixture.link(piece) },
        });
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.stats.structureLoadDeferred).toBeGreaterThan(0);
        fixture.failStart(piece);

        const declines = logged("structure-load-start-declined", "info");
        const release = Promise.withResolvers<void>();
        let held = 0;
        fixture.hooks.onSync = async (id, traversal) => {
          if (id !== piece || !traversal || held++ > 0) return;
          fixture.commit({
            [argument]: { value: { touched: 1 }, result: fixture.link(piece) },
          });
          await release.promise;
        };
        try {
          fixture.setDemand([piece, argument]);
          await clock.settle();
          expect(held).toBe(1);
          await clock.tick(DEFAULT_FLUSH_DEADLINE_MS);
          await clock.settle();
          expect(fixture.stats.wavesBudgetExhausted).toBeGreaterThan(0);
          release.resolve();
          await clock.settle();
        } finally {
          release.resolve();
        }
        expect(fixture.traversals(argument)).toBe(2);
        expect(logged("structure-load-start-declined", "info")).toBe(
          declines + 1,
        );
        expect(fixture.starts).toEqual([]);
        expect(fixture.stats.structureLoadRearmed).toBe(0);

        // A commit to the piece re-arms both and readmits its start.
        fixture.loadable = true;
        fixture.commit({ [piece]: { value: {}, patternIdentity: pointer } });
        await clock.settle();
        expect(fixture.stats.structureLoadRearmed).toBe(2);
        expect(fixture.starts).toContain(piece);
      });

      it("follows the origin of a piece a commit gave a pattern before starting it, holding the watermark below that commit until it starts", async () => {
        // The root parks with no pattern pointer; a commit gives it one and a
        // recorded origin, which re-arms it, and the retry finds the origin
        // not yet followed this tenure. The settle leaves the root to the
        // cycle the follow's completion wakes, and the watermark stays below
        // the commit until then.

        const piece = "of:arms-origin-after-rearm";
        const fixture = await openFixture([piece]);
        fixture.loadable = true;
        fixture.commit({ [piece]: { value: { plain: 1 } } });
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.stats.structureLoadTerminal).toBe(1);

        const followed = logged("origin-followed", "debug");
        const following = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        fixture.hooks.onReconcile = async () => {
          following.resolve();
          await release.promise;
        };
        try {
          const seq = fixture.commit({
            [piece]: {
              value: { plain: 1 },
              patternIdentity: pointer,
              patternSource: "fabric:structure-load-arms-origin",
            },
          });
          await settle(server.flushSessions([space]));
          await settle(following.promise);
          await clock.settle();
          expect(fixture.stats.structureLoadRearmed).toBe(1);
          expect(fixture.starts).toEqual([]);
          const traversals = fixture.traversals(piece);
          await settle(
            server.writeDocument(space, "of:arms-unrelated", { plain: 2 }),
          );
          expect(fixture.traversals(piece)).toBeGreaterThan(traversals);
          expect(readWatermarkSeq(fixture.engine)).toBeLessThan(seq);

          release.resolve();
          await clock.settle();
          expect(fixture.reconciles).toEqual([piece]);
          expect(logged("origin-followed", "debug")).toBe(followed + 1);
          expect(fixture.stats.originFollows).toBe(1);
          expect(fixture.starts).toEqual([piece]);
          await settle(
            server.writeDocument(space, "of:arms-unrelated", { plain: 3 }),
          );
          expect(readWatermarkSeq(fixture.engine)).toBeGreaterThanOrEqual(seq);
        } finally {
          release.resolve();
        }
      });

      it("starts a piece on its stored source when following its origin throws", async () => {
        const piece = "of:arms-origin-follow-fails";
        const fixture = await openFixture([piece]);
        fixture.loadable = true;
        fixture.commit({
          [piece]: {
            value: {},
            patternIdentity: pointer,
            patternSource: "fabric:structure-load-arms-origin",
          },
        });
        fixture.hooks.onReconcile = () =>
          Promise.reject(new Error("injected origin follow failure"));
        const failures = logged("origin-follow-failed", "warn");
        expect(await settle(fixture.serving.activate())).toBe(true);
        await clock.settle();
        expect(fixture.reconciles).toEqual([piece]);
        expect(logged("origin-follow-failed", "warn")).toBe(failures + 1);
        expect(fixture.stats.originFollows).toBe(1);
        expect(fixture.starts).toEqual([piece]);
      });

      it("asks again for the defaults a piece owes a viewer after seeding them throws, beside a viewer who arrives", async () => {
        const piece = "of:arms-seeded-piece";
        const fixture = await openFixture([piece]);
        fixture.loadable = true;
        fixture.commit({ [piece]: { value: {}, patternIdentity: pointer } });
        let failing = true;
        fixture.hooks.onSeed = () =>
          failing
            ? Promise.reject(new Error("injected seed failure"))
            : Promise.resolve(true);
        const seedFailures = logged("demand-seed-failed", "warn");
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.starts).toEqual([piece]);
        expect(fixture.seeds).toEqual([`${piece} for viewer`]);
        expect(logged("demand-seed-failed", "warn")).toBe(seedFailures + 1);
        expect(fixture.stats.demand.ownedDefaultSeeds).toBe(0);

        failing = false;
        const arrivals = logged("demand-arrival", "debug");
        fixture.setDemand([piece, {
          id: piece,
          principal: owner.did(),
          sessionId: "second-viewer",
        }]);
        await clock.tick(300);
        await clock.settle();
        expect(fixture.stats.demandArrivals).toBe(1);
        expect(logged("demand-arrival", "debug")).toBe(arrivals + 1);
        expect(fixture.seeds).toEqual([
          `${piece} for viewer`,
          `${piece} for viewer`,
          `${piece} for second-viewer`,
        ]);
        expect(fixture.stats.demand.ownedDefaultSeeds).toBe(2);
        expect(fixture.starts).toEqual([piece]);
      });

      it("seeds no viewer who arrives once the tenure ends while seeding throws, and reports no failure", async () => {
        const piece = "of:arms-seed-after-park";
        const fixture = await openFixture([piece]);
        fixture.loadable = true;
        fixture.commit({ [piece]: { value: {}, patternIdentity: pointer } });
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.seeds).toEqual([`${piece} for viewer`]);

        let parked: Promise<void> | undefined;
        fixture.hooks.onSeed = () => {
          parked ??= fixture.serving.park("seed-test");
          return Promise.reject(new Error("injected seed failure"));
        };
        const seedFailures = logged("demand-seed-failed", "warn");
        fixture.setDemand([
          piece,
          ...["second-viewer", "third-viewer"].map(
            (sessionId) => ({ id: piece, principal: owner.did(), sessionId }),
          ),
        ]);
        await clock.settle();
        await settle(parked!);
        expect(fixture.seeds).toEqual([
          `${piece} for viewer`,
          `${piece} for second-viewer`,
        ]);
        expect(logged("demand-seed-failed", "warn")).toBe(seedFailures);
        expect(fixture.stats.demand.ownedDefaultSeeds).toBe(1);
        expect(fixture.stats.demandArrivals).toBe(0);
      });

      it("seeds the defaults a piece in its own space owes, and leaves a piece in another space to that space", async () => {
        const local = "of:arms-local-piece";
        const localArgument = "of:arms-local-argument";
        const foreign = "of:arms-foreign-piece";
        const foreignArgument = "of:arms-foreign-argument";
        const fixture = await openFixture([localArgument, foreignArgument]);
        fixture.loadable = true;
        fixture.commit(
          { [foreign]: { value: {}, patternIdentity: pointer } },
          elsewhere,
        );
        fixture.commit({
          [local]: { value: {}, patternIdentity: pointer },
          [localArgument]: { value: {}, result: fixture.link(local) },
          [foreignArgument]: {
            value: {},
            result: fixture.link(foreign, elsewhere),
          },
        });
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect([...fixture.starts].sort()).toEqual([foreign, local].sort());
        expect(fixture.seeds).toEqual([`${local} for viewer`]);
        expect(fixture.stats.demand.ownedDefaultSeeds).toBe(1);
      });

      it("parks a root whose start is refused, after retrying one a commit touched while it was refused", async () => {
        const piece = "of:arms-refused-piece";
        const fixture = await openFixture([piece]);
        fixture.loadable = true;
        fixture.commit({ [piece]: { value: {}, patternIdentity: pointer } });
        fixture.hooks.onStart = (id) => {
          if (fixture.starts.length === 1) {
            fixture.commit({
              [piece]: { value: { touched: 1 }, patternIdentity: pointer },
            });
          }
          throw new PieceStateMovedError(id, pointer, [], []);
        };
        const refusals = logged("structure-load-refused", "info");
        expect(await settle(fixture.serving.activate())).toBe(true);
        await clock.settle();
        // The retry parks the root, and the commit, drained after it,
        // re-arms the parked root once more.
        expect(fixture.starts).toEqual([piece, piece, piece]);
        expect(fixture.stats.structureLoadRefused).toBe(3);
        expect(fixture.stats.structureLoadRearmed).toBe(1);
        expect(logged("structure-load-refused", "info")).toBe(refusals + 3);
        expect(fixture.stats.structureLoadFailures).toBe(0);
      });
    });
  });
});
