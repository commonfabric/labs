import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("compile-cache-space-aware");
const spaceA = signer.did();
const spaceB = (await Identity.fromPassphrase("compile-cache space B")).did();

// `compileOrGetPattern` (the compileAndRun builtin's compile entry) dedupes the
// expensive TS compile on a content hash that ignores the target space. The
// pattern meta-cell fallback is gone, so a piece persisted in space S reloads in
// a fresh runtime ONLY if S holds the source/compiled closure. When the SAME
// program is compiled into two spaces in one session, the second call is a
// content-cache hit — and before the fix it returned the cached pattern without
// ever writing the closure into the second space, leaving a piece created there
// permanently unloadable ("has no stored source"). The hit now replicates the
// closure into the requested space.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "",
        "export default pattern(() => ({ label: 'hello' }));",
      ].join("\n"),
    },
  ],
};

describe("compileOrGetPattern persists the closure per requested space", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("a fresh runtime can start a piece created from a cross-space cache hit", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      // Cold compile into space A: writes the closure there, caches by content.
      const patternA = await rt1.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceA,
      );
      // Same source, different space: a content-cache HIT. The closure must be
      // replicated into space B so a B-resident piece can reload by identity.
      const patternB = await rt1.patternManager.compileOrGetPattern(
        PROGRAM,
        spaceB,
      );
      // The dedupe returns the same compiled instance (TS compile not repeated).
      expect(patternB).toBe(patternA);

      // Run the pattern with a result cell in space B (the persisted piece).
      const tx1 = rt1.edit();
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceB,
        "compile-cache space-aware piece",
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, patternB as any, {}, resultCell1);
      await tx1.commit().settled;
      await r1.pull();
      await rt1.idle();

      const pieceLink = resultCell1.getAsNormalizedFullLink();
      expect(pieceLink.space).toBe(spaceB);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Fresh runtime: load + start the piece from space B. Before the fix this
      // rejects with "has no stored source" because the cache hit never wrote
      // space B's closure.
      const pieceCell = rt2.getCellFromLink(pieceLink);
      await pieceCell.sync();
      const started = await rt2.start(pieceCell);
      expect(started).toBe(true);

      await pieceCell.pull();
      const value = pieceCell.getAsQueryResult() as { label: string };
      expect(value.label).toBe("hello");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  for (const follower of ["concurrent", "cached"]) {
    it(`shares a ${follower} compile without replication when CFC is disabled`, async () => {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "disabled",
      });
      const release = Promise.withResolvers<void>();
      const replication = spy(
        runtime.patternManager,
        "replicatePatternToSpace",
      );
      try {
        const compilePattern = runtime.patternManager.compilePattern.bind(
          runtime.patternManager,
        );
        let compileCount = 0;
        runtime.patternManager.compilePattern = async (program, context) => {
          compileCount++;
          await release.promise;
          return await compilePattern(program, context);
        };
        const compilationA = runtime.patternManager.compileOrGetPattern(
          PROGRAM,
          spaceA,
        );
        if (follower === "cached") {
          release.resolve();
          await compilationA;
        }
        const compilationB = runtime.patternManager.compileOrGetPattern(
          PROGRAM,
          spaceB,
        );
        release.resolve();
        const [patternA, patternB] = await Promise.all([
          compilationA,
          compilationB,
        ]);
        await runtime.patternManager.flushCompileCacheWrites();
        expect(patternB).toBe(patternA);
        expect(compileCount).toBe(1);
        expect(
          replication.calls.filter(({ args }) => args[1] !== args[2]),
        ).toHaveLength(0);
      } finally {
        release.resolve();
        replication.restore();
        await runtime.dispose();
      }
    });
  }

  for (
    const leader of ["persistent", "source-only pending", "source-only cached"]
  ) {
    it(`reloads attached data from the compiled cache after a ${leader} leader`, async () => {
      const rt1 = newRuntime();
      const rt2 = newRuntime();
      const release = Promise.withResolvers<void>();
      try {
        const program: RuntimeProgram = {
          main: "/main.tsx",
          files: [
            {
              name: "/main.tsx",
              contents: [
                "import { dataFile, pattern } from 'commonfabric';",
                "const data = JSON.parse(dataFile('./data.json'));",
                "export default pattern(() => ({ label: data.label }));",
              ].join("\n"),
            },
            { name: "/data.json", contents: '{"label":"hello"}' },
          ],
          dataFiles: ["/data.json"],
        };
        const sourceA = rt1.getCell<RuntimeProgram>(spaceA, "source", {
          type: "object",
          additionalProperties: true,
        });
        const sourceB = rt1.getCell<RuntimeProgram>(spaceB, "source", {
          type: "object",
          additionalProperties: true,
        });
        await Promise.all([sourceA.sync(), sourceB.sync()]);
        await rt1.editWithRetry((tx) => sourceA.withTx(tx).set(program));
        await rt1.editWithRetry((tx) => sourceB.withTx(tx).set(program));
        expect(sourceA.get()).toEqual(program);
        expect(sourceB.get()).toEqual(program);

        const compilePattern = rt1.patternManager.compilePattern.bind(
          rt1.patternManager,
        );
        let compileCount = 0;
        rt1.patternManager.compilePattern = async (program, context) => {
          compileCount++;
          await release.promise;
          return await compilePattern(program, context);
        };
        const compilationA = rt1.patternManager.compileOrGetPattern(
          sourceA.get(),
          leader === "persistent" ? spaceA : undefined,
        );
        if (leader === "source-only cached") {
          release.resolve();
          await compilationA;
        }
        const compilationB = rt1.patternManager.compileOrGetPattern(
          sourceB.get(),
          spaceB,
        );
        release.resolve();
        const [patternA, patternB] = await Promise.all([
          compilationA,
          compilationB,
        ]);
        if (leader === "persistent") {
          expect(compileCount).toBe(1);
          expect(patternB).toBe(patternA);
        }

        const resultCell = rt1.getCell<{ label: string }>(
          spaceB,
          "concurrent-compile piece",
        );
        await resultCell.sync();
        await rt1.editWithRetry((tx) => {
          rt1.run(tx, patternB, {}, resultCell.withTx(tx));
        });
        await resultCell.pull();
        await rt1.idle();
        await rt1.patternManager.flushCompileCacheWrites();
        await storageManager.synced();

        rt2.harness.compileResolvedToRecordGraph = () => {
          throw new Error(
            "A persisted closure must reload without recompiling",
          );
        };
        const reloaded = rt2.getCellFromLink(
          resultCell.getAsNormalizedFullLink(),
        );
        await reloaded.sync();
        expect(await rt2.start(reloaded)).toBe(true);
        await reloaded.pull();
        expect(reloaded.key("label").get()).toBe("hello");
      } finally {
        release.resolve();
        await rt2.dispose();
        await rt1.dispose();
      }
    });
  }
});
