import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("start instantiate after");
const space = signer.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "",
      "export default pattern<{ value: number }, { doubled: number }>(",
      "  ({ value }) => ({ doubled: computed(() => value * 2) }),",
      ");",
    ].join("\n"),
  }],
};

describe("runner", () => {
  describe("start() with `instantiateAfter`", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtimes: Runtime[];

    const newRuntime = (): Runtime => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      runtimes.push(runtime);
      return runtime;
    };

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtimes = [];
    });

    afterEach(async () => {
      for (const runtime of runtimes) await runtime.dispose();
      await storageManager.close();
    });

    /**
     * Runs `PROGRAM`'s piece with `value` 3 in a runtime of its own, moves
     * `value` to 5 once the piece is stopped, and returns the runtime and the
     * piece's result cell.
     */
    const stoppedPiece = async (name: string) => {
      const runtime = newRuntime();
      const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
      });
      const argument = runtime.getCell<{ value: number }>(
        space,
        `${name} argument`,
        compiled.argumentSchema,
      );
      const result = runtime.getCell<{ doubled: number }>(
        space,
        `${name} result`,
        compiled.resultSchema,
      );
      const tx = runtime.edit();
      argument.withTx(tx).set({ value: 3 });
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit().settled).error).toBeUndefined();
      await result.pull();
      runtime.runner.stop(result);
      const move = runtime.edit();
      argument.withTx(move).key("value").set(5);
      expect((await move.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await runtime.storageManager.synced();
      return { runtime, result };
    };

    /** `result`'s document as `runtime` holds it. */
    const resultIn = (runtime: Runtime, result: Cell<{ doubled: number }>) =>
      runtime.getCellFromLink<{ doubled: number }>(
        result.getAsNormalizedFullLink(),
      );

    /** Settles once `runtime` has loaded a pattern by its identity. */
    const patternLoadIn = (runtime: Runtime): Promise<void> => {
      const loadedOnce = Promise.withResolvers<void>();
      const load = runtime.patternManager.loadPatternByIdentity.bind(
        runtime.patternManager,
      );
      runtime.patternManager.loadPatternByIdentity = (async (...args) => {
        const loaded = await load(...args);
        loadedOnce.resolve();
        return loaded;
      }) as typeof load;
      return loadedOnce.promise;
    };

    it("instantiates a piece this runtime stopped only once the work it waits for settles", async () => {
      const { runtime, result } = await stoppedPiece("stopped here");
      const work = Promise.withResolvers<void>();

      const started = runtime.start(result, {
        instantiateAfter: work.promise,
      });
      await runtime.idle();

      expect(runtime.runner.isRunning(result)).toBe(false);

      work.resolve();

      expect(await started).toBe(true);
      expect(runtime.runner.isRunning(result)).toBe(true);
      await runtime.idle();
      expect((await result.pull()).doubled).toBe(10);
    });

    it("waits as well for the work a start joining it adds", async () => {
      const { runtime, result } = await stoppedPiece("joined");
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();

      const started = runtime.start(result, {
        instantiateAfter: first.promise,
      });
      const joined = runtime.start(result, {
        instantiateAfter: second.promise,
      });
      first.resolve();
      await first.promise;
      await runtime.idle();

      expect(runtime.runner.isRunning(result)).toBe(false);

      second.resolve();

      expect(await Promise.all([started, joined])).toEqual([true, true]);
      expect(runtime.runner.isRunning(result)).toBe(true);
    });

    it("loads a piece's root and pattern while it waits, and instantiates it once the work settles", async () => {
      const { result } = await stoppedPiece("cold");
      const cold = newRuntime();
      const piece = resultIn(cold, result);
      const patternLoaded = patternLoadIn(cold);
      const work = Promise.withResolvers<void>();

      let settled = false;
      const started = cold.start(piece, { instantiateAfter: work.promise })
        .finally(() => settled = true);
      await patternLoaded;
      await cold.storageManager.synced();
      await cold.idle();

      expect(piece.getRaw()).toBeDefined();
      expect(settled).toBe(false);
      expect(cold.runner.isRunning(piece)).toBe(false);

      work.resolve();

      expect(await started).toBe(true);
      expect(cold.runner.isRunning(piece)).toBe(true);
      await cold.idle();
      expect((await piece.pull()).doubled).toBe(10);
    });

    it("installs nothing again for a piece something else started while it waited", async () => {
      const { result } = await stoppedPiece("started meanwhile");
      const cold = newRuntime();
      const piece = resultIn(cold, result);
      const work = Promise.withResolvers<void>();

      let settled = false;
      const started = cold.start(piece, { instantiateAfter: work.promise })
        .finally(() => settled = true);
      // The same piece reached through a link document, which a start does
      // not join to one in flight for the piece's own document.
      const tx = cold.edit();
      const alias = cold.getCell(
        space,
        "started meanwhile alias",
        undefined,
        tx,
      );
      alias.setRaw(piece.getAsLink());
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(cold.runner.isRunning(piece)).toBe(false);
      expect(await cold.start(alias)).toBe(true);
      expect(settled).toBe(false);
      const { id } = piece.getAsNormalizedFullLink();
      const registration = () =>
        [...cold.runner.cancels].filter(([key]) => key.endsWith(`/${id}`));
      const installed = registration();

      work.resolve();

      expect(await started).toBe(true);
      expect(installed).toHaveLength(1);
      expect(registration()).toEqual(installed);
    });

    it("returns `false` and installs nothing for a piece stopped while it waited", async () => {
      const { result } = await stoppedPiece("stopped meanwhile");
      const cold = newRuntime();
      const piece = resultIn(cold, result);
      const patternLoaded = patternLoadIn(cold);
      const work = Promise.withResolvers<void>();

      const started = cold.start(piece, { instantiateAfter: work.promise });
      await patternLoaded;
      await cold.storageManager.synced();
      cold.runner.stop(piece);
      work.resolve();

      expect(await started).toBe(false);
      expect(cold.runner.isRunning(piece)).toBe(false);
    });

    it("rejects with the work's error and leaves the piece stopped", async () => {
      const { result } = await stoppedPiece("refused");
      const cold = newRuntime();
      const piece = resultIn(cold, result);
      const failure = new Error("the awaited work failed");

      await expect(
        cold.start(piece, { instantiateAfter: Promise.reject(failure) }),
      ).rejects.toBe(failure);
      expect(cold.runner.isRunning(piece)).toBe(false);
    });

    it("instantiates without waiting where no work is given", async () => {
      const { result } = await stoppedPiece("unheld");
      const cold = newRuntime();
      const piece = resultIn(cold, result);

      expect(await cold.start(piece)).toBe(true);
      expect(cold.runner.isRunning(piece)).toBe(true);
    });
  });
});
