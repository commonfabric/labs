/**
 * Restarts static cross-space children after independent source changes.
 * The cold cases use a second runtime over the same durable store.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  getPatternSource,
  getPieceSourceRevisions,
  getPieceSourceSnapshot,
  preparePieceSourceTransitionBaseline,
  Runtime,
} from "../src/index.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

/** Builds a child whose output identifies both its code and stored input. */
function childSource(marker: string): string {
  return `import { computed, pattern } from 'commonfabric';
export default pattern<{ value: string }, { marker: string }>(({ value }) => ({
  marker: computed(() => '${marker} ' + value),
}));`;
}

const childPath = "/api/patterns/system/child.tsx";
const parentPath = "/api/patterns/system/parent.tsx";

describe("child-source-resume", () => {
  for (const mode of ["warm", "cold", "serving"]) {
    const cold = mode !== "warm";
    for (const detach of [false, true]) {
      it(`retains ${detach ? "owner-edited" : "adopted"} code and inputs on a ${mode} parent restart`, async () => {
        const signer = await Identity.fromPassphrase("child source resume");
        const target = (await Identity.fromPassphrase("independent child"))
          .did();
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const managers: EmulatedStorageManager[] = [];
        const runtimes: Runtime[] = [];
        const seen: string[][] = [];

        /** Connects an independent runtime and records serving demand roots. */
        const makeRuntime = (serving = false) => {
          const manager = EmulatedStorageManager.connectTo(server, {
            as: signer,
          });
          managers.push(manager);
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: manager,
            servingPosture: serving,
            ...(serving ? { experimental: { serverExecution: true } } : {}),
          });
          if (serving) {
            runtime.installSealDestination({ seal: (tx) => tx.tx.commit() }, {
              runStamper: (tx, info) =>
                stampWaveRunContext(tx, {
                  actionId: info.actionId,
                  kind: info.kind,
                }),
              runDemanderResolver: (roots) => {
                seen.push([...roots]);
                return [];
              },
            });
          }
          runtimes.push(runtime);
          return runtime;
        };

        const runtime = makeRuntime();
        try {
          const parent = await runtime.patternManager.compilePattern({
            main: parentPath,
            files: [
              {
                name: parentPath,
                contents: `import { pattern } from 'commonfabric';
import Child from './child.tsx';
export default pattern(() => ({ child: Child.inSpace('${target}')({ value: 'parent' }) }));`,
              },
              { name: childPath, contents: childSource("original") },
            ],
          }, { space: signer.did() });
          const result = runtime.getCell(signer.did(), "parent");
          const tx = runtime.edit();
          runtime.runner.run(tx, parent, {}, result, {
            sourceOrigin: "system:system/parent.tsx",
          });
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
          await result.pull();
          await runtime.scheduler.idleWithPendingCommits();
          const child = result.key("child").resolveAsCell();
          await child.pull();
          expect(getPatternSource(child)).toBe("system:system/child.tsx");
          expect(child.key("marker").get()).toBe("original parent");
          const candidate = await runtime.patternManager.compilePattern({
            main: childPath,
            files: [{ name: childPath, contents: childSource("updated") }],
          }, { space: child.space });
          const expected = getPieceSourceSnapshot(child)!;
          await runtime.runner.runSynced(child, candidate, { value: "owner" }, {
            pieceSourceTransition: {
              revisionId: crypto.randomUUID(),
              timestamp: Date.now(),
              operation: detach ? "edit" : "origin-update",
              origin: detach ? null : expected.origin,
              expected,
              baseline: await preparePieceSourceTransitionBaseline(
                runtime,
                child,
                expected,
              ),
            },
          });
          await child.pull();
          await runtime.scheduler.idleWithPendingCommits();
          const ref = getPatternIdentityRef(child);
          const history = getPieceSourceRevisions(child);
          expect(child.key("marker").get()).toBe("updated owner");
          await runtime.patternManager.flushCompileCacheWrites();
          await runtime.storageManager.synced();
          runtime.runner.stop(result);
          const reader = cold ? makeRuntime(mode === "serving") : runtime;
          const resumed = reader.getCellFromLink(
            result.getAsNormalizedFullLink(),
          );
          await reader.runner.start(resumed);
          await resumed.pull();
          await reader.scheduler.idleWithPendingCommits();
          const resumedChild = resumed.key("child").resolveAsCell();
          await resumedChild.pull();
          expect(getPatternIdentityRef(resumedChild)).toEqual(ref);
          expect(getPieceSourceRevisions(resumedChild)).toEqual(history);
          expect(getPatternSource(resumedChild)).toBe(
            detach ? undefined : "system:system/child.tsx",
          );
          expect(resumedChild.key("marker").get()).toBe("updated owner");
          if (mode === "serving") {
            const childDemands = seen.filter((roots) =>
              roots.includes(resumedChild.sourceURI)
            );
            expect(childDemands.length).toBeGreaterThan(0);
            for (const roots of childDemands) {
              expect(roots).toContain(resumed.sourceURI);
            }
          }
        } finally {
          for (const runtime of runtimes) {
            runtime.clearSealDestination();
            await runtime.dispose({ closeStorage: false });
          }
          for (const manager of managers) await manager.close();
          await server.close();
        }
      });
    }
  }
  describe("parent ownership", () => {
    let runtime: Runtime;
    beforeEach(async () => {
      const signer = await Identity.fromPassphrase("child resume ownership");
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.emulate({ as: signer }),
      });
    });
    afterEach(async () => {
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose();
    });

    /** Creates a static child, with an optional independent source origin. */
    async function create(tracked = true, crossSpace = true) {
      const space = (await Identity.fromPassphrase("child resume ownership"))
        .did();
      const target =
        (await Identity.fromPassphrase("child resume ownership target")).did();
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern({
        main: parentPath,
        files: [
          {
            name: parentPath,
            contents: `import { pattern } from 'commonfabric';
import Child from './child.tsx';
export default pattern<{ value: string }>(({ value }) => ({ child: Child${
              crossSpace ? `.inSpace('${target}')` : ""
            }({ value }) }));`,
          },
          { name: childPath, contents: childSource("original") },
        ],
      }, { space, tx });
      const parent = runtime.getCell(space, "parent");
      runtime.runner.run(
        tx,
        pattern,
        { value: "parent" },
        parent,
        tracked ? { sourceOrigin: "system:system/parent.tsx" } : {},
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await parent.pull();
      await runtime.idle();
      const child = parent.key("child").resolveAsCell();
      expect(runtime.runner.isRunning(child)).toBe(true);
      return { parent, child, pattern };
    }

    for (const abort of [false, true]) {
      it(`does not start the child after its parent ${abort ? "transaction aborts" : "stops before committing"}`, async () => {
        const { parent, child, pattern } = await create();
        runtime.runner.stop(parent);
        expect(runtime.runner.isRunning(child)).toBe(false);
        const tx = runtime.edit();
        runtime.runner.run(tx, pattern, { value: "parent" }, parent);
        expect(runtime.runner.isRunning(child)).toBe(false);
        if (abort) tx.abort("test refusal");
        else {
          runtime.runner.stop(parent);
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
        }
        await runtime.idle();
        expect(runtime.runner.isRunning(child)).toBe(false);
      });
    }

    it("leaves a replacement child running when the original parent stops", async () => {
      const { parent, child, pattern } = await create();
      runtime.runner.stop(parent);
      const tx = runtime.edit();
      runtime.runner.run(tx, pattern, { value: "parent" }, parent);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      const key = runtime.runner.accessForTestingOnly.getDocKey(child);
      const original = runtime.runner.cancels.get(key);
      expect(original).toBeDefined();
      runtime.runner.stop(child);
      const replacement = runtime.edit();
      runtime.runner.run(replacement, undefined, undefined, child);
      runtime.prepareTxForCommit(replacement);
      expect((await replacement.commit()).error).toBeUndefined();
      await runtime.idle();
      const current = runtime.runner.cancels.get(key);
      expect(current).toBeDefined();
      expect(current).not.toBe(original);
      runtime.runner.stop(parent);
      expect(runtime.runner.cancels.get(key)).toBe(current);
    });

    for (const crossSpace of [false, true]) {
      it(`rebinds an untracked ${crossSpace ? "cross-space" : "same-space"} child's inputs`, async () => {
        const { parent, child, pattern } = await create(false, crossSpace);
        runtime.runner.stop(parent);
        const tx = runtime.edit();
        runtime.runner.run(tx, pattern, { value: "changed" }, parent);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await parent.pull();
        await child.pull();
        expect(child.key("marker").get()).toBe("original changed");
      });
    }
  });
});
