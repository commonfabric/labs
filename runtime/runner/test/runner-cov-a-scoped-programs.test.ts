import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { getPatternSource, resolveEntryIdentity } from "../src/index.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("runner scoped program selection");
const space = owner.did();
const childSpace =
  (await Identity.fromPassphrase("runner scoped program child")).did();

const sourceOf = (factor: number) => `
import { computed, pattern } from "commonfabric";
export default pattern<{ value: number }, { doubled: number }>(
  ({ value }) => ({ doubled: computed(() => value * ${factor}) }),
);
`;

const programOf = (factor: number) => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: sourceOf(factor) }],
});

// The content identity of a source no store holds.
const unloadableIdentity = await resolveEntryIdentity(
  "/main.tsx",
  (name) =>
    name === "/main.tsx"
      ? Promise.resolve(sourceOf(5))
      : Promise.reject(new Error(`not found: ${name}`)),
);

describe("runner", () => {
  describe("scoped program selection", () => {
    // A user-scoped piece on a serving runtime with server execution shares
    // one registration across its instances, and a coordinator follows its
    // pointer to whichever program it selects.

    let server: ReturnType<typeof newLoopbackServer>;
    let storage: EmulatedStorageManager;
    let runtime: Runtime;
    let lease: ExecutionLeaseCycle;
    let demands: Array<() => void>;
    let errors: Error[];

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const holder = executionLeaseHolder(owner.did());
      storage = EmulatedStorageManager.connectTo(server, {
        as: owner,
        id: holder,
      });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      const engine = await server.engineForSpace(space);
      lease = new ExecutionLeaseCycle({
        leases: engine.executionLeases,
        space,
        holder,
      });
      expect(await lease.acquire()).toBe(true);
      demands = [];
      errors = [];
      runtime.scheduler.onError((error) => errors.push(error));
    });

    afterEach(async () => {
      for (const cancel of demands) cancel();
      await runtime.dispose();
      await lease.release();
      await storage.close();
      await server.close();
    });

    /** Runs the default program as a user-scoped piece with input 3. */
    async function runScoped(name: string) {
      const program = await runtime.patternManager.compilePattern(
        programOf(2),
        { space },
      );
      const result = runtime.getCell<{ doubled: number }>(
        space,
        name,
        program.resultSchema,
        undefined,
        "user",
      );
      const tx = runtime.edit();
      runtime.run(tx, program, { value: 3 }, result);
      expect((await tx.commit().settled).error).toBeUndefined();
      demands.push(result.sink(() => {}));
      expect(await result.pull()).toEqual({ doubled: 6 });
      return result;
    }

    /** Points `result` at `identity`'s `symbol` and lets the work settle. */
    async function select(
      result: Cell<unknown>,
      identity: string,
      symbol: string,
    ) {
      const tx = runtime.edit();
      result.withTx(tx).setMetaRaw(
        "patternIdentity",
        { identity, symbol },
        rawMetaWriteAuthorization,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    }

    /**
     * Compiles the program that triples on another runtime, so this one
     * holds it only in the store, and returns its identity.
     */
    async function compileElsewhere() {
      const compiler = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: owner,
        }),
      });
      const tripled = await compiler.patternManager.compilePattern(
        programOf(3),
        { space },
      );
      const ref = compiler.patternManager.getArtifactEntryRef(tripled)!;
      await compiler.patternManager.flushCompileCacheWrites();
      await compiler.storageManager.synced();
      await compiler.dispose();
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          ref.identity,
          ref.symbol,
        ),
      ).toBeUndefined();
      return ref;
    }

    it("keeps only the program the later of two runs in one transaction names", async () => {
      const result = await runScoped("two-runs");
      const piece = result.getAsNormalizedFullLink().id;
      const tripled = await runtime.patternManager.compilePattern(
        programOf(3),
        { space },
      );
      const quadrupled = await runtime.patternManager.compilePattern(
        programOf(4),
        { space },
      );

      const tx = runtime.edit();
      runtime.run(tx, tripled, { value: 3 }, result);
      runtime.run(tx, quadrupled, { value: 3 }, result);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();

      expect(await result.pull()).toEqual({ doubled: 12 });
      expect(runtime.runner.accessForTestingOnly.scopedProgramCounts())
        .toEqual([{ piece, variants: 1 }]);
      expect(errors).toEqual([]);
    });

    it("runs a selected program it had to load first", async () => {
      const ref = await compileElsewhere();
      const result = await runScoped("load-selected");

      await select(result, ref.identity, ref.symbol);

      expect(await result.pull()).toEqual({ doubled: 9 });
      expect(errors).toEqual([]);
    });

    it("installs nothing for a selected program that loads after the piece stops", async () => {
      const ref = await compileElsewhere();
      const result = await runScoped("stopped-while-loading");
      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      const loading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      manager.loadPatternByIdentity = async (...args) => {
        loading.resolve();
        await release.promise;
        return load(...args);
      };
      const tx = runtime.edit();
      result.withTx(tx).setMetaRaw(
        "patternIdentity",
        ref,
        rawMetaWriteAuthorization,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await loading.promise;

      runtime.runner.stop(result);
      release.resolve();
      await runtime.idle();

      expect(runtime.runner.accessForTestingOnly.scopedProgramCounts())
        .toEqual([]);
      expect(runtime.runner.cancels.size).toBe(0);
      expect(errors).toEqual([]);
    });

    it("clears a stopped piece's registration even when a cleanup throws, and starts it again", async () => {
      const result = await runScoped("cleanup-throws");
      const piece = result.getAsNormalizedFullLink().id;
      const stopObserving = runtime.scheduler.observeUnsubscribe((action) => {
        if (
          "implementationHash" in action &&
          action.implementationHash === "cf:runner/program-selection"
        ) {
          throw new Error("The cleanup fails");
        }
      });
      try {
        expect(() => runtime.runner.stop(result)).toThrow("The cleanup fails");
      } finally {
        stopObserving();
      }

      expect(runtime.runner.accessForTestingOnly.scopedProgramCounts())
        .toEqual([]);
      expect(runtime.runner.cancels.size).toBe(0);

      expect(await runtime.runner.start(result)).toBe(true);
      await runtime.idle();
      expect(runtime.runner.accessForTestingOnly.scopedProgramCounts())
        .toEqual([{ piece, variants: 1 }]);
      const tx = runtime.edit();
      result.getArgumentCell()!.withTx(tx).key("value").set(5);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(await result.pull()).toEqual({ doubled: 10 });
    });

    it("starts no program for a pointer move its stopped coordinator still sees", async () => {
      // The coordinator's unsubscribe throws before it takes effect, so the
      // stopped registration's coordinator still runs on a pointer move. It
      // subscribes no variant's actions, and none runs.

      const result = await runScoped("coordinator-outlives-stop");
      const tripled = await runtime.patternManager.compilePattern(
        programOf(3),
        { space },
      );
      const ref = runtime.patternManager.getArtifactEntryRef(tripled)!;
      const scheduler = runtime.scheduler;
      const unsubscribe = scheduler.unsubscribe;
      scheduler.unsubscribe = function (action, options) {
        if (
          "implementationHash" in action &&
          action.implementationHash === "cf:runner/program-selection"
        ) {
          throw new Error("The unsubscribe fails");
        }
        return unsubscribe.call(this, action, options);
      };
      try {
        expect(() => runtime.runner.stop(result)).toThrow(
          "The unsubscribe fails",
        );
      } finally {
        scheduler.unsubscribe = unsubscribe;
      }
      const nodes = scheduler.getSizes().nodes;

      await select(result, ref.identity, ref.symbol);

      expect(scheduler.getSizes().nodes).toBe(nodes);
      expect(await result.pull()).toEqual({ doubled: 6 });
      expect(runtime.runner.accessForTestingOnly.scopedProgramCounts())
        .toEqual([]);
      expect(runtime.runner.cancels.size).toBe(0);
      expect(errors).toEqual([]);
    });

    it("keeps only the program the later of two runs in one transaction names when each initializes a session input", async () => {
      // Each variant installs an initializer for its session-scoped input,
      // which initializes nothing for a variant the pointer does not select.

      const sessionScaling = (factor: number): Pattern => {
        const pattern = trustPattern(runtime, {
          argumentSchema: {
            type: "object",
            properties: {
              value: { type: "number" },
              draft: {
                type: "number",
                default: 0,
                asCell: [{ kind: "cell", scope: "session" }],
              },
            },
          },
          resultSchema: {
            type: "object",
            properties: { doubled: { type: "number" } },
          },
          result: { doubled: { $alias: { partialCause: "out", path: [] } } },
          nodes: [{
            module: {
              type: "javascript",
              implementation: (value: number) => value * factor,
            },
            inputs: { $alias: { cell: "argument", path: ["value"] } },
            outputs: { $alias: { partialCause: "out", path: [] } },
          }],
        });
        runtime.patternManager.associatePatternIdentity(pattern, {
          identity: `test-session-scaling-${factor}`,
          symbol: "default",
        });
        return pattern;
      };
      const result = runtime.getCell<{ doubled: number }>(
        space,
        "session-inputs",
        undefined,
        undefined,
        "user",
      );
      const first = runtime.edit();
      runtime.run(first, sessionScaling(2), { value: 3 }, result);
      expect((await first.commit().settled).error).toBeUndefined();
      demands.push(result.sink(() => {}));
      expect(await result.pull()).toEqual({ doubled: 6 });
      const piece = result.getAsNormalizedFullLink().id;

      const tx = runtime.edit();
      runtime.run(tx, sessionScaling(3), { value: 3 }, result);
      runtime.run(tx, sessionScaling(4), { value: 3 }, result);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();

      expect(await result.pull()).toEqual({ doubled: 12 });
      expect(runtime.runner.accessForTestingOnly.scopedProgramCounts())
        .toEqual([{ piece, variants: 1 }]);
      expect(errors).toEqual([]);
    });

    it("keeps the registration of a scoped child a parent resumes while it runs", async () => {
      // A user-scoped child in another space with a source of its own resumes
      // independently: a parent starting while it runs takes the child's
      // registration as it is.

      const childPath = "/api/patterns/system/child.tsx";
      const parentPath = "/api/patterns/system/parent.tsx";
      const parent = await runtime.patternManager.compilePattern({
        main: parentPath,
        files: [
          {
            name: parentPath,
            contents: `import { pattern } from "commonfabric";
import Child from "./child.tsx";
export default pattern(() => ({
  child: Child.asScope("user").inSpace("${childSpace}")({ value: 3 }),
}));`,
          },
          { name: childPath, contents: sourceOf(2) },
        ],
      }, { space });
      const result = runtime.getCell<{ child: { doubled: number } }>(
        space,
        "resumes-scoped-child",
      );
      const tx = runtime.edit();
      runtime.runner.run(tx, parent, {}, result, {
        sourceOrigin: "system:system/parent.tsx",
      });
      expect((await tx.commit().settled).error).toBeUndefined();
      await result.pull();
      await runtime.idle();
      const child = result.key("child").resolveAsCell();
      demands.push(child.sink(() => {}));
      expect(await child.pull()).toEqual({ doubled: 6 });
      expect(getPatternSource(child)).toBe("system:system/child.tsx");
      runtime.runner.stop(result);
      runtime.runner.stop(child);

      expect(await runtime.runner.start(child)).toBe(true);
      await runtime.idle();
      const key = runtime.runner.accessForTestingOnly.getDocKey(child);
      const registration = runtime.runner.cancels.get(key);
      expect(registration).toBeDefined();
      expect(await runtime.runner.start(result)).toBe(true);
      await runtime.idle();

      expect(runtime.runner.cancels.get(key)).toBe(registration);
      runtime.runner.stop(child);
      const update = runtime.edit();
      child.getArgumentCell()!.withTx(update).key("value").set(5);
      expect((await update.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(await child.pull()).toEqual({ doubled: 6 });
      expect(errors).toEqual([]);
    });

    it("reports a selected program no store holds as unavailable", async () => {
      const result = await runScoped("unavailable-selected");

      await select(result, unloadableIdentity, "default");

      expect(errors.map((error) => error.message)).toEqual([
        `Selected program ${unloadableIdentity}\0default is unavailable`,
      ]);
    });
  });
});
