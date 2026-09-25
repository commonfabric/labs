import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { AdmittedCommitNotice } from "@commonfabric/memory/v2/server";

import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { readWatermarkSeq } from "../../src/executor/watermark.ts";
import { parseLink } from "../../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import { Runtime } from "../../src/runtime.ts";
import type { SealedCommitVerdict } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { readValueAtPath } from "../../src/storage/v2-path.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { sessionDemandOf } from "../support/session-demand.ts";

const owner = await Identity.fromPassphrase("terminal structure owner");
const service = await Identity.fromPassphrase("terminal structure service");
const space = owner.did();
const rootId = "of:terminal-structure-root";
// The flush deadline the stepped-clock phases run the serving loop under, and
// the size of the step their clock takes. A wave here settles in a fraction of
// this, so the deadline timer stays out of the settle race and the step alone
// decides where the wave is cut.
const steppedFlushDeadlineMs = 1000;

async function settle<T>(work: Promise<T>): Promise<T> {
  await clock.settle();
  return await work;
}

describe("SpaceServer", () => {
  let prior: boolean;
  let server: ReturnType<typeof newSharedServer>;
  let serving: SpaceServer | undefined;
  let creator: Runtime | undefined;
  let creatorManager:
    | ReturnType<typeof EmulatedStorageManager.connectTo>
    | undefined;

  beforeEach(() => {
    prior = getServerExecutionConfig();
    setServerExecutionConfig(true);
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
  });

  afterEach(async () => {
    try {
      if (serving !== undefined) await settle(serving.park("test-teardown"));
      if (creator !== undefined) await settle(creator.dispose());
      if (creatorManager !== undefined) await settle(creatorManager.close());
      await settle(server.close());
    } finally {
      serving = undefined;
      creator = undefined;
      creatorManager = undefined;
      setServerExecutionConfig(prior);
    }
  });

  describe("instance members", () => {
    describe("activate()", () => {
      for (
        const phase of [
          "during a structure load",
          "across a deadline",
          "at the post-input deadline",
          "at the re-armed retry deadline",
          "with work left at the deadline",
          "through a changed owning backlink",
          "behind a sealed root",
          "behind an unrelated sealed write",
        ] as const
      ) {
        const crossDeadline = phase === "across a deadline";
        const postInputDeadline = phase === "at the post-input deadline";
        const rearmedDeadline = phase === "at the re-armed retry deadline";
        const workLeftDeadline = phase === "with work left at the deadline";
        const steppedDeadline = rearmedDeadline || workLeftDeadline;
        const cutDeadline = postInputDeadline || steppedDeadline;
        const shadow = phase === "behind a sealed root";
        it(`settles a piece created ${phase} before covering its input`, async () => {
          const engine = await server.engineForSpace(space);
          const setupPublications: Promise<void>[] = [];
          server.setServerExecutionObserver({
            commitAdmitted: () => {
              setupPublications.push(server.idle());
            },
          });
          creatorManager = EmulatedStorageManager.connectTo(server, {
            as: owner,
          });
          creator = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: creatorManager,
            experimental: { serverExecution: true },
          });
          const compiled = await creator.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: [
                "import { computed, pattern } from 'commonfabric';",
                "export default pattern<{ n: number }, { total: number }>(",
                "  ({ n }) => ({ total: computed(() => n + 7) }),",
                ");",
              ].join("\n"),
            }],
          }, { space });
          await settle(creator.storageManager.synced());

          const manager = EmulatedStorageManager.connectTo(server, {
            as: service,
          });
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: manager,
            experimental: { serverExecution: true },
            servingPosture: true,
          });
          const ref = creator.patternManager.getArtifactEntryRef(compiled)!;
          const loaded = await runtime.patternManager.loadPatternByIdentity(
            ref.identity,
            ref.symbol,
            space,
          );
          expect(loaded).toBeDefined();
          await settle(runtime.storageManager.synced());
          await Promise.all(setupPublications);

          const root = creator.getCellFromLink<{ total: number }>({
            space,
            id: rootId,
            scope: "space",
            path: [],
          });
          const argument = creator.getCell<{ n: number }>(
            space,
            "terminal-structure-argument",
            undefined,
          );
          const pieceRoot = phase === "through a changed owning backlink"
            ? creator.getCellFromLink<{ total: number }>({
              space,
              id: "of:terminal-created-owner",
              scope: "space",
              path: [],
            })
            : root;
          await settle(pieceRoot.sync());
          await settle(root.sync());
          await settle(argument.sync());

          const stats = emptyServingLoopStats();
          const release = Promise.withResolvers<void>();
          const transactions = new Set<unknown>();
          let held = 0;
          let creationSeq: number | undefined;
          const coveringCommits: { watermark: number; total: unknown }[] = [];
          const sync = manager.syncCell.bind(manager);
          manager.syncCell = async (cell, options) => {
            const result = await sync(cell, options);
            if (
              cell.getAsNormalizedFullLink().id === rootId &&
              cell.tx?.tx.immediate
            ) {
              transactions.add(cell.tx.tx);
              if (transactions.size === 1 && held === 0) {
                held++;
                await release.promise;
              }
            }
            return result;
          };
          const facade = new Proxy(server, {
            get(target, key, receiver) {
              if (key === "demandForSpace") {
                return (
                  requestedSpace: string,
                  options: { excludePrincipal?: string },
                ) =>
                  sessionDemandOf(
                    target.demandedInstancesForSpace(requestedSpace, options)
                      .map((row) => ({ ...row, root: row.id === rootId })),
                  );
              }
              const value = Reflect.get(target, key, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          serving = new SpaceServer({
            space,
            server: facade,
            engine,
            serviceIdentity: service.did(),
            ensureSpaceRoots: false,
            localSeqRef: { value: 0 },
            stats,
            policy: steppedDeadline
              ? { flushDeadlineMs: steppedFlushDeadlineMs }
              : undefined,
            createRuntime: () =>
              Promise.resolve({
                runtime,
                dispose: async () => {
                  await runtime.dispose();
                  await manager.close();
                },
              }),
            decorateWaveCommitSink: (sink) => ({
              currentHeads: (space, docs) => sink.currentHeads(space, docs),
              concurrentWritePaths: (space, doc, seq) =>
                sink.concurrentWritePaths(space, doc, seq),
              commitWave: async (batch) => {
                const result = await sink.commitWave(batch);
                if (
                  creationSeq !== undefined &&
                  readWatermarkSeq(engine) >= creationSeq
                ) {
                  const stored = Engine.read(engine, {
                    id: pieceRoot.getAsNormalizedFullLink().id,
                    scope: "space",
                  });
                  const totalLink = parseLink(
                    readValueAtPath(stored?.value, ["total"]),
                    pieceRoot,
                  );
                  const total = totalLink === undefined
                    ? undefined
                    : readValueAtPath(
                      Engine.read(engine, {
                        id: totalLink.id,
                        scope: totalLink.scope,
                      })?.value,
                      totalLink.path,
                    );
                  coveringCommits.push({
                    watermark: readWatermarkSeq(engine),
                    total,
                  });
                }
                return result;
              },
            }),
          });
          server.setServerExecutionObserver({
            demandChanged: (_space, reason, principal) => {
              if (principal !== service.did()) {
                serving?.noteDemandChanged(reason);
              }
            },
            commitAdmitted: (notice: AdmittedCommitNotice) => {
              if (
                notice.class === "authored" &&
                notice.writes.some(({ id }) => id === rootId)
              ) {
                creationSeq ??= notice.seq;
              }
              serving?.enqueueCommit(notice);
            },
          });
          const provider = runtime.storageManager.open(space);
          let restoreTime: (() => void) | undefined;
          let cancelLeftover: (() => void) | undefined;
          let deadlineSampled = false;
          let deadlineStepped = false;
          let leftoverRuns = 0;
          const deadlinePurges: { count: number; watermark: number }[] = [];
          const verdict = Promise.withResolvers<SealedCommitVerdict>();
          let sealed:
            | ReturnType<NonNullable<typeof provider.replica.sealNative>>
            | undefined;
          try {
            if (postInputDeadline) {
              const originalDate = Date;
              const now = Date.now;
              let expireSample = false;
              // SES freezes Date.now, so replace its global constructor binding
              // while retaining ordinary date construction and every other read.
              class DeadlineDate extends originalDate {
                static override now() {
                  if (!expireSample) return now();
                  expireSample = false;
                  deadlineSampled = true;
                  return now() + 100;
                }
              }
              expect(Reflect.set(globalThis, "Date", DeadlineDate)).toBe(true);
              restoreTime = () => {
                expect(Reflect.set(globalThis, "Date", originalDate)).toBe(
                  true,
                );
              };
              const leftover = runtime.getCell(space, "post-input-lt1-copy")
                .getAsNormalizedFullLink();
              cancelLeftover = runtime.scheduler.addEventHandler(() => {
                leftoverRuns++;
              }, leftover);
              let inputApplied = false;
              const inputSynced = manager.inputSynced.bind(manager);
              manager.inputSynced = async () => {
                await inputSynced();
                if (creationSeq !== undefined) inputApplied = true;
              };
              const foreignFloor = provider.replica.unappliedForeignSeqFloor!
                .bind(provider.replica);
              provider.replica.unappliedForeignSeqFloor = () => {
                const floor = foreignFloor();
                if (inputApplied && !deadlineSampled && floor === undefined) {
                  // The input barrier has completed. This copy arrives before
                  // the synchronous deadline decision, while its timer is held.
                  runtime.scheduler.queueEvent(
                    leftover,
                    {},
                    false,
                    undefined,
                    true,
                    {
                      eventId: "post-input-lt1-copy",
                      time: now(),
                      served: { firedAt: { user: owner.did() } },
                    },
                  );
                  expireSample = true;
                }
                return floor;
              };
            }
            if (cutDeadline) {
              const purge = runtime.scheduler.purgeQueuedEvents.bind(
                runtime.scheduler,
              );
              runtime.scheduler.purgeQueuedEvents = (predicate, reason) => {
                const count = purge(predicate, reason);
                deadlinePurges.push({
                  count,
                  watermark: readWatermarkSeq(engine),
                });
                return count;
              };
            }
            if (steppedDeadline) {
              const originalDate = Date;
              const now = Date.now;
              let step = 0;
              // SES freezes Date.now, so the step rides the global constructor
              // binding, which retains ordinary date construction and every
              // other read. The step stays on, and every later wave reads its
              // own deadline from the stepped clock, so the wave stepped over
              // is the only one that runs past its deadline.
              class SteppedDate extends originalDate {
                static override now() {
                  return now() + step;
                }
              }
              expect(Reflect.set(globalThis, "Date", SteppedDate)).toBe(true);
              restoreTime = () => {
                expect(Reflect.set(globalThis, "Date", originalDate)).toBe(
                  true,
                );
              };
              const stepPastDeadline = () => {
                step = steppedFlushDeadlineMs;
                deadlineStepped = true;
              };
              // A demanded root joins the re-armed set either when its
              // confirmation is invalidated (counted `structureLoadDeferred`)
              // or when a commit re-arms a terminal decision (counted
              // `structureLoadRearmed`).
              const rearmQueued = () =>
                stats.structureLoadDeferred + stats.structureLoadRearmed > 0;
              if (rearmedDeadline) {
                const inputSynced = manager.inputSynced.bind(manager);
                manager.inputSynced = async () => {
                  await inputSynced();
                  // The load pass this settle awaited put the demanded root in
                  // the re-armed set, which the settle loop reads right after
                  // this barrier. A whole flush deadline stepped here puts the
                  // wave past its deadline at the re-armed retry.
                  if (!deadlineStepped && rearmQueued()) {
                    stepPastDeadline();
                  }
                };
              } else {
                const leftover = runtime.getCell(space, "work-left-lt1-copy")
                  .getAsNormalizedFullLink();
                cancelLeftover = runtime.scheduler.addEventHandler(() => {
                  leftoverRuns++;
                }, leftover);
                // The settle probes the scheduler after its idle wait too,
                // ahead of the barrier. The probe guarding the deadline
                // decision is the one after the barrier.
                let barrierCrossed = false;
                const inputSynced = manager.inputSynced.bind(manager);
                manager.inputSynced = async () => {
                  await inputSynced();
                  barrierCrossed = true;
                };
                const idle = runtime.idle.bind(runtime);
                runtime.idle = async () => {
                  await idle();
                  barrierCrossed = false;
                };
                const isIdle = runtime.scheduler.isIdle.bind(runtime.scheduler);
                runtime.scheduler.isIdle = () => {
                  const afterBarrier = barrierCrossed;
                  barrierCrossed = false;
                  // The settle loop reaches this probe with the re-armed retry
                  // already spent. The copy lands and the clock steps in the
                  // same synchronous stretch as the deadline decision the probe
                  // guards, so the wave is cut with the copy still queued.
                  if (afterBarrier && !deadlineStepped && rearmQueued()) {
                    runtime.scheduler.queueEvent(
                      leftover,
                      {},
                      false,
                      undefined,
                      true,
                      {
                        eventId: "work-left-lt1-copy",
                        time: now(),
                        served: { firedAt: { user: owner.did() } },
                      },
                    );
                    stepPastDeadline();
                  }
                  return isIdle();
                };
              }
            }
            expect(await settle(serving.activate())).toBe(true);
            expect(held).toBe(1);
            sealed = phase.startsWith("behind")
              ? provider.replica.sealNative!(
                {
                  operations: [{
                    op: "set",
                    id: shadow ? rootId : "of:terminal-unrelated",
                    scope: "space",
                    type: "application/json",
                    value: { value: {} },
                  }],
                },
                undefined,
                verdict.promise,
              )
              : undefined;
            const tx = creator.edit();
            argument.withTx(tx).set({ n: 3 });
            creator.run(tx, compiled, argument, pieceRoot);
            if (pieceRoot !== root) {
              root.withTx(tx).setMetaRaw(
                "result",
                pieceRoot.getAsWriteRedirectLink(),
                rawMetaWriteAuthorization,
              );
            }
            const creationCommit = tx.commit();
            await clock.settle();
            expect(creationSeq).toBeDefined();
            if (crossDeadline) {
              await clock.tick(100);
              await clock.settle();
              expect(stats.wavesBudgetExhausted).toBeGreaterThan(0);
            }
            release.resolve();
            await clock.settle();
            expect((await settle(creationCommit)).error).toBeUndefined();
            await clock.settle();
            if (sealed !== undefined) {
              try {
                if (shadow) {
                  expect(provider.replica.unappliedForeignSeqFloor!()).toBe(
                    creationSeq,
                  );
                  expect(readWatermarkSeq(engine)).toBeLessThan(creationSeq!);
                  expect(stats.structureLoadTerminal).toBe(0);
                  expect(coveringCommits).toEqual([]);
                } else {
                  await clock.tick(100);
                  await clock.settle();
                  expect(stats.wavesBudgetExhausted).toBeGreaterThan(0);
                  expect(stats.structureLoadTerminal).toBe(0);
                  expect(readWatermarkSeq(engine)).toBeLessThan(creationSeq!);
                }
              } finally {
                verdict.resolve({ withdrawn: { message: "test release" } });
                await settle(sealed.settled);
              }
              await clock.settle();
            }
            expect(coveringCommits.length).toBeGreaterThan(0);
            if (postInputDeadline) {
              expect(deadlineSampled).toBe(true);
              expect(stats.wavesBudgetExhausted).toBe(1);
              expect(deadlinePurges).toHaveLength(1);
              expect(deadlinePurges[0].count).toBe(1);
              expect(deadlinePurges[0].watermark).toBeLessThan(creationSeq!);
              expect(stats.events.lt1LeftoversPurged).toBe(1);
              expect(leftoverRuns).toBe(0);
            }
            if (rearmedDeadline) {
              expect(deadlineStepped).toBe(true);
              expect(stats.wavesBudgetExhausted).toBe(1);
              expect(deadlinePurges).toHaveLength(1);
              expect(deadlinePurges[0].count).toBe(0);
              expect(deadlinePurges[0].watermark).toBeLessThan(creationSeq!);
              expect(stats.events.lt1LeftoversPurged).toBe(0);
            }
            if (workLeftDeadline) {
              expect(deadlineStepped).toBe(true);
              expect(stats.wavesBudgetExhausted).toBe(1);
              expect(deadlinePurges).toHaveLength(1);
              expect(deadlinePurges[0].count).toBe(1);
              expect(deadlinePurges[0].watermark).toBeLessThan(creationSeq!);
              expect(stats.events.lt1LeftoversPurged).toBe(1);
              expect(leftoverRuns).toBe(0);
            }
            for (const { watermark, total } of coveringCommits) {
              expect(total, `durable result at watermark ${watermark}`).toBe(
                10,
              );
            }
            expect(stats.structureLoadFailures).toBe(0);
          } finally {
            restoreTime?.();
            cancelLeftover?.();
            release.resolve();
            if (sealed !== undefined) {
              verdict.resolve({ withdrawn: { message: "test cleanup" } });
              await settle(sealed.settled);
            }
          }
        });
      }
    });
  });
});
