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

const owner = await Identity.fromPassphrase("terminal structure owner");
const service = await Identity.fromPassphrase("terminal structure service");
const space = owner.did();
const rootId = "of:terminal-structure-root";

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
          "during confirmation",
          "across a deadline",
          "through a changed owning backlink",
          "behind a sealed root",
          "behind an unrelated sealed write",
        ] as const
      ) {
        const crossDeadline = phase === "across a deadline";
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
              if (transactions.size === 2 && held === 0) {
                held++;
                await release.promise;
              }
            }
            return result;
          };
          const facade = new Proxy(server, {
            get(target, key, receiver) {
              if (key === "demandedInstancesForSpace") {
                return (
                  requestedSpace: string,
                  options: { excludePrincipal?: string },
                ) =>
                  target.demandedInstancesForSpace(requestedSpace, options)
                    .map((row) => ({ ...row, root: row.id === rootId }));
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
          const verdict = Promise.withResolvers<SealedCommitVerdict>();
          let sealed:
            | ReturnType<NonNullable<typeof provider.replica.sealNative>>
            | undefined;
          try {
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
            for (const { watermark, total } of coveringCommits) {
              expect(total, `durable result at watermark ${watermark}`).toBe(
                10,
              );
            }
            expect(stats.structureLoadFailures).toBe(0);
          } finally {
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
