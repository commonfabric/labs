import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
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

const owner = await Identity.fromPassphrase("terminal confirmation owner");
const service = await Identity.fromPassphrase("terminal confirmation service");
const space = owner.did();
const elsewhere = (await Identity.fromPassphrase("terminal confirmation other"))
  .did();
const ids = [
  "of:confirmation-a",
  "of:confirmation-b",
  "of:confirmation-c",
] as const;

/** Drains transport and scheduler work with positive-delay timers fixed. */
async function settle<T>(work: Promise<T>): Promise<T> {
  await clock.settle();
  return await work;
}

describe("SpaceServer", () => {
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
   * Creates a durable owning chain and exposes only its root as demand.
   *
   * Each document's `result` backlink names the next one. The last document
   * names `onward` where that is given, so the chain resolves there instead.
   */
  async function openFixture(
    scope: "space" | "user" = "space",
    onward?: { space: MemorySpace; id: URI },
  ) {
    const engine = await server.engineForSpace(space);
    const next = [
      ...ids.slice(1).map((id) => ({ space, id })),
      ...(onward === undefined ? [] : [onward]),
    ];
    const manager = EmulatedStorageManager.connectTo(server, { as: service });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const scopeKey = resolveScopeKey(scope, { principal: service.did() });
    const commit = Engine.applyCommit(engine, {
      space,
      sessionId: "confirmation-fixture",
      principal: service.did(),
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: ids.map((id, index) => ({
          op: "set",
          id,
          scope,
          value: {
            value: { plain: 1 },
            ...(index < next.length
              ? {
                result: runtime.getCellFromLink({
                  ...next[index],
                  scope,
                  path: [],
                }).getAsWriteRedirectLink(),
              }
              : {}),
          },
        })),
      },
    });
    expect(commit.revisions).toHaveLength(ids.length);
    let demanded = true;
    let syncs = 0;
    const sync = manager.syncCell.bind(manager);
    manager.syncCell = (cell, options) => {
      syncs++;
      return sync(cell, options);
    };
    const facade = new Proxy(server, {
      get(target, key, receiver) {
        if (key === "demandedInstancesForSpace") {
          return () =>
            demanded ? [{ id: ids[0], scope, scopeKey, root: true }] : [];
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
      manager,
      runtime,
      stats,
      serving,
      syncCount: () => syncs,
      setDemand(value: boolean) {
        demanded = value;
        serving!.noteDemandChanged();
      },
    };
  }

  /**
   * Installs a loadable pattern at the chain's terminus in the engine while
   * the serving replica keeps the copy it already holds.
   *
   * The terminus is synced onto the serving runtime before the instantiation
   * commit, and the shared server's fan-out is manual, so that commit sits
   * undelivered until `server.flushSessions` spreads it. What the replica
   * then reads is behind the store on the one document a structure-load
   * verdict turns on, which is the state the confirming re-traversal exists
   * for. The commit itself resolves on that same frame, so the caller awaits
   * it through the returned teardown rather than here; admission — which the
   * engine is authoritative from — is what this waits on.
   */
  async function installStalePattern(
    fixture: Awaited<ReturnType<typeof openFixture>>,
  ): Promise<() => Promise<void>> {
    const manager = EmulatedStorageManager.connectTo(server, { as: owner });
    const creator = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    const terminus = { space, id: ids[2], scope: "space" as const, path: [] };
    // The compiler's own commits have to reach both replicas, so the tenure's
    // notice observer stands aside while they publish. It is back in place
    // before the instantiation commit, the one the serving replica must not
    // see.
    const publications: Promise<void>[] = [];
    server.setServerExecutionObserver({
      commitAdmitted: () => publications.push(server.idle()),
    });
    try {
      const compiled = await settle(creator.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents:
            "import { pattern } from 'commonfabric'; export default pattern(() => ({ total: 10 }));",
        }],
      }, { space }));
      const root = creator.getCellFromLink(terminus);
      await settle(root.sync());
      await settle(Promise.all(publications));
      await settle(fixture.runtime.getCellFromLink(terminus).sync());
      const admitted = Promise.withResolvers<void>();
      server.setServerExecutionObserver({
        commitAdmitted: (notice) => {
          serving?.enqueueCommit(notice);
          admitted.resolve();
        },
      });
      const tx = creator.edit();
      creator.run(tx, compiled, {}, root);
      const committed = tx.commit();
      await settle(admitted.promise);
      return async () => {
        expect((await settle(committed)).error).toBeUndefined();
        await settle(creator.dispose());
        await settle(manager.close());
      };
    } catch (error) {
      await creator.dispose();
      await manager.close();
      throw error;
    }
  }

  describe("instance members", () => {
    describe("activate()", () => {
      // A sync count here counts CALLS, and the demand pass calls `syncCell`
      // for each address it is about to load before it loads any of them —
      // the instance a demand names, and the space instance a scoped demand
      // falls back to. The call a traversal then makes for one of those
      // documents is answered from the watch the pull registered, so a count
      // below carries one call more per address than the documents read. What
      // the documents-read claim rests on is the session's tracked and watch
      // sizes, asserted beside the first of them.

      it("leaves a successor tenure independent of a parked load", async () => {
        const releases = [
          Promise.withResolvers<void>(),
          Promise.withResolvers<void>(),
        ];
        const held = [0, 0];
        const hold = (
          fixture: Awaited<ReturnType<typeof openFixture>>,
          index: number,
        ) => {
          const sync = fixture.manager.syncCell.bind(fixture.manager);
          fixture.manager.syncCell = async (cell, options) => {
            const result = await sync(cell, options);
            if (
              cell.getAsNormalizedFullLink().id === ids[1] && held[index] === 0
            ) {
              held[index]++;
              await releases[index].promise;
            }
            return result;
          };
        };
        const predecessor = await openFixture();
        hold(predecessor, 0);
        try {
          expect(await settle(predecessor.serving.activate())).toBe(true);
          expect(held).toEqual([1, 0]);
          await settle(predecessor.serving.park("new-tenure"));
          const successor = await openFixture();
          hold(successor, 1);
          expect(await settle(successor.serving.activate())).toBe(true);
          expect(held).toEqual([1, 1]);
          releases[0].resolve();
          await clock.settle();
          expect(predecessor.stats.structureLoadTerminal).toBe(0);
          expect(predecessor.stats.structureLoadFailures).toBe(0);
          expect(successor.stats.structureLoadTerminal).toBe(0);
          releases[1].resolve();
          await clock.settle();
          expect(successor.stats.structureLoadTerminal).toBe(1);
          expect(successor.stats.structureLoadFailures).toBe(0);
        } finally {
          for (const release of releases) release.resolve();
        }
      });

      for (const parkDuringLoad of [false, true]) {
        it(`${parkDuringLoad ? "cancels" : "starts"} a resolved piece ${parkDuringLoad ? "after park" : "during its tenure"}`, async () => {
          const fixture = await openFixture();
          const publications: Promise<void>[] = [];
          server.setServerExecutionObserver({
            commitAdmitted: () => publications.push(server.idle()),
          });
          const creatorManager = EmulatedStorageManager.connectTo(server, {
            as: owner,
          });
          const creator = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: creatorManager,
            experimental: { serverExecution: true },
          });
          const release = Promise.withResolvers<void>();
          try {
            const compiled = await creator.patternManager.compilePattern({
              main: "/main.tsx",
              files: [{
                name: "/main.tsx",
                contents:
                  "import { pattern } from 'commonfabric'; export default pattern(() => ({ total: 10 }));",
              }],
            }, { space });
            const root = creator.getCellFromLink({
              space,
              id: ids[2],
              scope: "space",
              path: [],
            });
            await settle(root.sync());
            const tx = creator.edit();
            creator.run(tx, compiled, {}, root);
            expect((await settle(tx.commit())).error).toBeUndefined();
            await settle(creator.storageManager.synced());
            await Promise.all(publications);
            server.setServerExecutionObserver({
              commitAdmitted: (notice) => fixture.serving.enqueueCommit(notice),
            });
            const ref = creator.patternManager.getArtifactEntryRef(compiled)!;
            const load = fixture.runtime.patternManager.loadPatternByIdentity
              .bind(fixture.runtime.patternManager);
            let held = 0;
            fixture.runtime.patternManager.loadPatternByIdentity = async (
              ...args
            ) => {
              const pattern = await load(...args);
              if (args[0] === ref.identity && held === 0) {
                expect(pattern).toBeDefined();
                held++;
                await release.promise;
              }
              return pattern;
            };
            const start = fixture.runtime.start.bind(fixture.runtime);
            let starts = 0;
            fixture.runtime.start = async (cell) => {
              starts++;
              return await start(cell);
            };
            expect(await settle(fixture.serving.activate())).toBe(true);
            expect(held).toBe(1);
            expect(starts).toBe(0);
            if (parkDuringLoad) {
              await settle(fixture.serving.park("pattern-resolution"));
            }
            release.resolve();
            await clock.settle();
            expect(starts).toBe(parkDuringLoad ? 0 : 1);
            const servingRoot = fixture.runtime.getCellFromLink({
              space,
              id: ids[2],
              scope: "space",
              path: [],
            });
            expect(fixture.runtime.runner.pieceGraphIsInstalled(servingRoot))
              .toBe(!parkDuringLoad);
            expect(fixture.stats.structureLoadFailures).toBe(0);
          } finally {
            release.resolve();
            await settle(creator.dispose());
            await settle(creatorManager.close());
          }
        });
      }

      for (const scope of ["space", "user"] as const) {
        it(`settles a cold ${scope} chain from the engine without a second traversal`, async () => {
          const fixture = await openFixture(scope);
          expect(await settle(fixture.serving.activate())).toBe(true);
          expect(fixture.stats.structureLoadTerminal).toBe(1);
          expect(fixture.stats.structureLoadConfirmationsSkipped).toBe(1);
          expect(server.demandSetSizesForSpace(space).perSession).toMatchObject(
            [
              {
                tracked: scope === "space" ? 3 : 4,
                watches: scope === "space" ? 3 : 4,
              },
            ],
          );
          expect(fixture.syncCount()).toBe(scope === "space" ? 4 : 6);

          const syncs = fixture.syncCount();
          await settle(
            server.writeDocument(space, "of:confirmation-unrelated", {
              plain: 2,
            }),
          );
          expect(fixture.syncCount()).toBe(syncs);
          expect(fixture.stats.structureLoadTerminal).toBe(1);
          expect(fixture.stats.structureLoadRearmed).toBe(0);
        });
      }

      it("re-asks a chain whose terminus is in another space", async () => {
        // The engine co-hosted with this tenure holds its own space alone, so
        // it cannot answer for a terminus in another one: both traversals
        // sync all four documents.

        const fixture = await openFixture("space", {
          space: elsewhere,
          id: "of:confirmation-elsewhere",
        });
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.stats.structureLoadTerminal).toBe(1);
        expect(fixture.stats.structureLoadConfirmationsSkipped).toBe(0);
        expect(fixture.syncCount()).toBe(9);
      });

      it("re-asks the chain once the engine's database has closed", async () => {
        // The server closes, and its engine with it, between the first
        // traversal's last read and the confirmation. Nothing past the load
        // pass can run against a closed engine, so the settle that follows
        // it waits until the tenure has parked.

        const fixture = await openFixture();
        const sync = fixture.manager.syncCell.bind(fixture.manager);
        let closed = false;
        fixture.manager.syncCell = async (cell, options) => {
          const result = await sync(cell, options);
          if (
            cell.getAsNormalizedFullLink().id === ids[2] &&
            cell.tx?.tx.immediate && !closed
          ) {
            closed = true;
            await server.close();
          }
          return result;
        };
        const release = Promise.withResolvers<void>();
        const idle = fixture.runtime.idle.bind(fixture.runtime);
        fixture.runtime.idle = async () => {
          if (closed) await release.promise;
          return await idle();
        };
        try {
          expect(await settle(fixture.serving.activate())).toBe(true);
          expect(fixture.stats.structureLoadTerminal).toBe(1);
          expect(fixture.stats.structureLoadConfirmationsSkipped).toBe(0);
          expect(fixture.syncCount()).toBe(7);
        } finally {
          const parked = fixture.serving.park("confirmation-test");
          release.resolve();
          await settle(parked);
        }
      });

      it("re-asks the chain and starts a piece the replica is behind on", async () => {
        const fixture = await openFixture();
        const disposeCreator = await installStalePattern(fixture);
        const release = Promise.withResolvers<void>();
        try {
          const reAsked = Promise.withResolvers<void>();
          const sync = fixture.manager.syncCell.bind(fixture.manager);
          let rootSyncs = 0;
          fixture.manager.syncCell = async (cell, options) => {
            if (
              cell.getAsNormalizedFullLink().id === ids[0] &&
              cell.tx?.tx.immediate && ++rootSyncs === 2
            ) {
              reAsked.resolve();
              await release.promise;
            }
            return await sync(cell, options);
          };
          let starts = 0;
          const start = fixture.runtime.start.bind(fixture.runtime);
          fixture.runtime.start = async (cell) => {
            starts++;
            return await start(cell);
          };
          expect(await settle(fixture.serving.activate())).toBe(true);

          // The first traversal read the replica's copy, which predates the
          // pattern; the engine holds it, so the decision goes to the chain.
          await settle(reAsked.promise);
          expect(fixture.stats.structureLoadConfirmationsSkipped).toBe(0);
          expect(starts).toBe(0);

          // The frame the replica was missing lands between the traversals.
          await settle(server.flushSessions([space]));
          release.resolve();
          await clock.settle();

          expect(starts).toBe(1);
          expect(fixture.stats.structureLoadTerminal).toBe(0);
          expect(fixture.stats.structureLoadFailures).toBe(0);
          expect(
            fixture.runtime.runner.pieceGraphIsInstalled(
              fixture.runtime.getCellFromLink({
                space,
                id: ids[2],
                scope: "space",
                path: [],
              }),
            ),
          ).toBe(true);
        } finally {
          release.resolve();
          await disposeCreator();
        }
      });

      it("confirms again when a departed demand returns", async () => {
        const fixture = await openFixture();
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.stats.structureLoadTerminal).toBe(1);
        fixture.setDemand(false);
        await clock.tick(300);
        await clock.settle();
        expect(fixture.stats.demand.demandedInstances).toBe(0);
        fixture.setDemand(true);
        await clock.tick(300);
        await clock.settle();
        expect(fixture.stats.structureLoadTerminal).toBe(2);
        expect(fixture.stats.structureLoadConfirmationsSkipped).toBe(2);
        expect(fixture.syncCount()).toBe(8);
      });

      it("retires a decision when demand leaves during a structure load", async () => {
        const fixture = await openFixture();
        const release = Promise.withResolvers<void>();
        const sync = fixture.manager.syncCell.bind(fixture.manager);
        let reads = 0;
        let held = 0;
        fixture.manager.syncCell = async (cell, options) => {
          const result = await sync(cell, options);
          if (
            cell.getAsNormalizedFullLink().id === ids[1] &&
            cell.tx?.tx.immediate && ++reads === 1
          ) {
            held++;
            await release.promise;
          }
          return result;
        };
        try {
          expect(await settle(fixture.serving.activate())).toBe(true);
          expect(held).toBe(1);
          fixture.setDemand(false);
          release.resolve();
          await clock.settle();
          expect(fixture.stats.demand.demandedInstances).toBe(0);
          const decisions = fixture.stats.structureLoadTerminal;
          fixture.setDemand(true);
          await clock.tick(300);
          await clock.settle();
          expect(fixture.stats.structureLoadTerminal).toBe(decisions + 1);
          expect(fixture.syncCount()).toBe(8);
        } finally {
          release.resolve();
        }
      });

      it("retries a failed chain sync in traversal 1 without terminalizing", async () => {
        const fixture = await openFixture();
        const sync = fixture.manager.syncCell.bind(fixture.manager);
        let failing = true;
        fixture.manager.syncCell = async (cell, options) => {
          if (
            cell.getAsNormalizedFullLink().id === ids[1] &&
            cell.tx?.tx.immediate && failing
          ) {
            throw new Error("injected chain sync failure");
          }
          return await sync(cell, options);
        };
        expect(await settle(fixture.serving.activate())).toBe(true);
        const failures = fixture.stats.structureLoadFailures;
        expect(failures).toBeGreaterThan(0);
        expect(fixture.stats.structureLoadTerminal).toBe(0);
        failing = false;
        await settle(
          server.writeDocument(space, "of:confirmation-retry", { plain: 2 }),
        );
        expect(fixture.stats.structureLoadTerminal).toBe(1);
        expect(fixture.stats.structureLoadFailures).toBe(failures);
      });

      it("retries a failed chain sync in traversal 2 and starts the piece", async () => {
        const fixture = await openFixture();
        const disposeCreator = await installStalePattern(fixture);
        const sync = fixture.manager.syncCell.bind(fixture.manager);
        let matching = 0;
        let failing = true;
        fixture.manager.syncCell = async (cell, options) => {
          if (
            cell.getAsNormalizedFullLink().id === ids[1] &&
            cell.tx?.tx.immediate && ++matching >= 2 && failing
          ) {
            throw new Error("injected chain sync failure");
          }
          return await sync(cell, options);
        };
        let starts = 0;
        const start = fixture.runtime.start.bind(fixture.runtime);
        fixture.runtime.start = async (cell) => {
          starts++;
          return await start(cell);
        };
        try {
          expect(await settle(fixture.serving.activate())).toBe(true);
          const failures = fixture.stats.structureLoadFailures;
          expect(failures).toBeGreaterThan(0);
          expect(starts).toBe(0);
          expect(fixture.stats.structureLoadTerminal).toBe(0);
          failing = false;
          await settle(server.flushSessions([space]));
          await settle(
            server.writeDocument(space, "of:confirmation-retry", { plain: 2 }),
          );
          expect(starts).toBe(1);
          expect(fixture.stats.structureLoadTerminal).toBe(0);
          expect(fixture.stats.structureLoadFailures).toBe(failures);
        } finally {
          await disposeCreator();
        }
      });

      for (const pass of [1, 2]) {
        // Traversal 2 runs only where the engine holds a pattern pointer the
        // serving replica has not caught up to, so that case stages one:
        // without it the first traversal's verdict stands on its own.

        for (const failure of [false, true]) {
          it(`discards traversal ${pass} ${failure ? "failure" : "success"} after tenure ends`, async () => {
            const fixture = await openFixture();
            const disposeCreator = pass === 2
              ? await installStalePattern(fixture)
              : undefined;
            const release = Promise.withResolvers<void>();
            const sync = fixture.manager.syncCell.bind(fixture.manager);
            let matching = 0;
            let held = 0;
            fixture.manager.syncCell = async (cell, options) => {
              const result = await sync(cell, options);
              if (
                cell.getAsNormalizedFullLink().id === ids[1] &&
                cell.tx?.tx.immediate &&
                ++matching === pass
              ) {
                held++;
                await release.promise;
                if (failure) {
                  throw new Error("injected late chain sync failure");
                }
              }
              return result;
            };
            try {
              expect(await settle(fixture.serving.activate())).toBe(true);
              expect(held).toBe(1);
              const parked = fixture.serving.park("confirmation-test");
              await clock.settle();
              release.resolve();
              await settle(parked);
              expect(fixture.stats.structureLoadTerminal).toBe(0);
              expect(fixture.stats.structureLoadFailures).toBe(0);
              expect(fixture.stats.structureLoadDeferred).toBe(0);
            } finally {
              release.resolve();
              await disposeCreator?.();
            }
          });
        }
      }
    });
  });
});
