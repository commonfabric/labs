/**
 * A runtime whose storage manager opens a space on a branch: it runs the
 * space's pieces as the branch holds them, beside a runtime on the default
 * branch of the same store.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/index.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const counterPath = "/api/patterns/system/counter.tsx";
const counterSource = `import { computed, handler, pattern, Writable } from 'commonfabric';
const add = handler<{ by: number }, { count: Writable<number> }>(
  ({ by }, { count }) => { count.set(count.get() + by); },
);
export default pattern<{ count: number }>(({ count }) => ({
  count,
  doubled: computed(() => count * 2),
  add: add({ count }),
}));`;

describe("branch-runtime", () => {
  let signer: Identity;
  let space: MemorySpace;
  let server: Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  /** Connects a runtime that opens the space on `branch`. */
  const makeRuntime = (branch?: string): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: signer,
      ...(branch === undefined ? {} : { branches: { [space]: branch } }),
    });
    managers.push(manager);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: false },
    });
    runtimes.push(runtime);
    return runtime;
  };

  /** Starts the counter in `runtime` and returns its result cell. */
  const startCounter = async (runtime: Runtime) => {
    const pattern = await runtime.patternManager.compilePattern({
      main: counterPath,
      files: [{ name: counterPath, contents: counterSource }],
    }, { space });
    const result = runtime.getCell(space, "counter");
    const tx = runtime.edit();
    runtime.runner.run(tx, pattern, { count: 1 }, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.scheduler.idleWithPendingCommits();
    return result;
  };

  /** Sends `add` to the counter `result` names and waits for what follows. */
  // deno-lint-ignore no-explicit-any
  const add = async (runtime: Runtime, result: any, by: number) => {
    result.key("add").send({ by });
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
    await result.pull();
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("branch runtime");
    space = signer.did() as MemorySpace;
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) {
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers) await manager.close();
    await server.close();
  });

  it("runs a piece as a fork holds it, and leaves the default branch alone", async () => {
    const main = makeRuntime();
    const result = await startCounter(main);
    await add(main, result, 10);
    const provider = main.storageManager.open(space);
    const forkSeq = (await provider.listHistory!())[0].seq;
    await add(main, result, 100);
    expect(result.key("doubled").get()).toBe(222);
    await main.patternManager.flushCompileCacheWrites();
    await main.storageManager.synced();
    await provider.createBranch!("fork", { forkSeq });

    const fork = makeRuntime("fork");
    const forked = fork.getCellFromLink(result.getAsNormalizedFullLink());
    await fork.runner.start(forked);
    await forked.pull();
    await fork.scheduler.idleWithPendingCommits();
    expect(forked.key("count").get()).toBe(11);
    expect(forked.key("doubled").get()).toBe(22);

    await add(fork, forked, 1000);
    expect(forked.key("count").get()).toBe(1011);
    expect(forked.key("doubled").get()).toBe(2022);

    await main.storageManager.synced();
    await result.pull();
    expect(result.key("count").get()).toBe(111);
    expect(result.key("doubled").get()).toBe(222);
  });
});
