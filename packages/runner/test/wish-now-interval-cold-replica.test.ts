import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("wish now interval cold replica");
const space = signer.did();

// A pattern whose only dependency is the space's shared interval clock.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { computed, pattern, wish } from 'commonfabric';",
        "",
        "export default pattern<Record<string, never>, { tick: number | null }>(",
        "  () => {",
        "    const now = wish<number>({ query: '#now/300' });",
        "    const tick = computed(() => now.result ?? null);",
        "    return { tick };",
        "  },",
        ");",
      ].join("\n"),
    },
  ],
};

function commitConflictCount(): number {
  const counts = getLoggerCountsBreakdown()["storage.v2"] ?? {};
  return (counts as Record<string, { total?: number }>)["commit-conflict"]
    ?.total ?? 0;
}

/**
 * The interval `#now` cell is one document per space and interval, shared by
 * every piece that wishes for it. A runtime whose replica has not loaded it
 * reads it as absent while the store holds the last tick, so a first tick
 * staged on that read is refused as a stale read, and every commit of the
 * same batch that read the wish's result falls with it. The wish holds until
 * the cell has loaded, and publishes nothing before.
 */
describe("wish-now-interval-cold-replica", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await managerA?.close();
    await managerB?.close();
    await server?.close();
  });

  it("publishes no tick from a second session until the stored clock cell has loaded, and then commits without a conflict", async () => {
    // Two managers with their own replicas, loopback-connected to one
    // in-process server: the second session reads the first session's clock
    // cell cold, as a fresh runtime does. Its load is held, so the second
    // session's first commit is staged while the cell is still unloaded.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
    const held: Array<() => void> = [];
    const cancels: Array<() => void> = [];
    const releaseHeld = () => {
      for (const release of held.splice(0)) release();
    };
    try {
      // Session 1 wishes for the clock, which mints the shared cell and
      // writes its first tick.
      const tx1 = rt1.edit();
      const pattern1 = await rt1.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx1,
      });
      const result1 = rt1.getCell<{ tick: number | null }>(
        space,
        "wish now cold replica first",
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, pattern1 as any, {}, result1);
      rt1.prepareTxForCommit(tx1);
      expect((await tx1.commit().settled).error).toBeUndefined();
      await rt1.idle();
      await rt1.storageManager.synced();
      await rt1.idle();
      await r1.key("tick").pull();
      expect(typeof r1.key("tick").get()).toBe("number");
      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Session 2 starts a piece of its own in the same space, with the clock
      // cell's load held back.
      const clockId = rt2.getCell(space, {
        wish: { now: true, interval: 300_000 },
      }).getAsNormalizedFullLink().id;
      const sync = managerB.syncCell.bind(managerB);
      let holding = true;
      /** Resolves once the second session asks for the clock cell. */
      const firstHold = Promise.withResolvers<void>();
      using _sync = stub(managerB, "syncCell", (cell, options) => {
        if (!holding || cell.getAsNormalizedFullLink().id !== clockId) {
          return sync(cell, options);
        }
        const gate = Promise.withResolvers<void>();
        held.push(() => gate.resolve());
        firstHold.resolve();
        return gate.promise.then(() => sync(cell, options));
      });
      getLogger("storage.v2").resetCounts();
      const conflictsBefore = commitConflictCount();
      const tx2 = rt2.edit();
      const pattern2 = await rt2.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx2,
      });
      const result2 = rt2.getCell<{ tick: number | null }>(
        space,
        "wish now cold replica second",
        undefined,
        tx2,
      );
      // deno-lint-ignore no-explicit-any
      const r2 = rt2.run(tx2, pattern2 as any, {}, result2);
      rt2.prepareTxForCommit(tx2);
      expect((await tx2.commit().settled).error).toBeUndefined();
      // A wish that loads the cell before acquiring it asks for it here and
      // waits; one that acquires it unloaded publishes a tick instead, so
      // the race ends either way.
      const tickPublished = new Promise<void>((resolve) => {
        cancels.push(
          r2.key("tick").sink((value) => {
            if (typeof value === "number") resolve();
          }),
        );
      });
      await Promise.race([firstHold.promise, tickPublished]);
      await rt2.scheduler.idle();
      // The wish is waiting on the held load and has published nothing.
      expect(held.length).toBeGreaterThanOrEqual(1);
      expect(r2.key("tick").get() ?? null).toBeNull();
      expect(commitConflictCount() - conflictsBefore).toBe(0);

      holding = false;
      releaseHeld();
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
      await r2.key("tick").pull();
      expect(typeof r2.key("tick").get()).toBe("number");
      expect(
        commitConflictCount() - conflictsBefore,
        "acquiring a stored clock cell must not commit-conflict",
      ).toBe(0);
    } finally {
      releaseHeld();
      for (const cancel of cancels.splice(0)) cancel();
      await rt1.dispose();
      await rt2.dispose();
    }
  });
});
