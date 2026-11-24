/**
 * A runtime whose storage manager opens a space on a branch: it runs the
 * space's pieces as the branch holds them, beside a runtime on the default
 * branch of the same store.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { Server } from "@commonfabric/memory/v2/server";
import { ExecutorHost } from "../src/executor/host.ts";
import { waitForSettledThroughHead } from "../src/executor/watermark.ts";
import { Runtime } from "../src/index.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const counterPath = "/api/patterns/system/counter.tsx";
const counterSource =
  `import { computed, handler, pattern, Writable } from 'commonfabric';
const add = handler<{ by: number }, { count: Writable<number> }>(
  ({ by }, { count }) => { count.set(count.get() + by); },
);
export default pattern<{ count: number }>(({ count }) => ({
  count,
  doubled: computed(() => count * 2),
  add: add({ count }),
}));`;

const fetcherPath = "/api/patterns/system/fetcher.tsx";
const fetcherSource =
  `import { fetchText, handler, pattern, resultOf, Writable } from 'commonfabric';
const setUrl = handler<{ url: string }, { url: Writable<string> }>(
  (event, { url }) => { url.set(event.url); },
);
export default pattern<{ url: string }>(({ url }) => {
  const fetched = fetchText({ url });
  return { text: resultOf(fetched), setUrl: setUrl({ url }) };
});`;

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

  describe("of a space a serving loop runs", () => {
    let host: ExecutorHost;
    let client: Runtime;

    beforeEach(() => {
      const service = signer;
      host = new ExecutorHost({
        server,
        serviceIdentity: service.did(),
        // The host factory contract is asynchronous.
        // deno-lint-ignore require-await
        createRuntime: async () => {
          const manager = EmulatedStorageManager.connectTo(server, {
            as: service,
          });
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: manager,
            servingPosture: true,
            experimental: { serverExecution: true },
          });
          return {
            runtime,
            dispose: async () => {
              await runtime.dispose();
              await manager.close();
            },
          };
        },
        policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      });
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      managers.push(manager);
      client = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      runtimes.push(client);
    });

    afterEach(async () => {
      await host.close();
    });

    it("runs a piece as it stood after an earlier event", async () => {
      const pattern = await client.patternManager.compilePattern({
        main: counterPath,
        files: [{ name: counterPath, contents: counterSource }],
      }, { space });
      const result = client.getCell<{ count: number; doubled: number }>(
        space,
        "counter",
        pattern.resultSchema,
      );
      await result.sync();
      const tx = client.edit();
      client.run(tx, pattern, { count: 1 }, result);
      expect((await tx.commit().settled).error).toBeUndefined();
      const cancel = result.sink(() => {});
      const doubled = result.key("doubled");
      await waitForCellValue(client, doubled, (value) => value === 2, {
        stuckLabel: "the counter's first derivation",
      });
      result.key("add").send({ by: 10 });
      await waitForCellValue(client, doubled, (value) => value === 22, {
        stuckLabel: "the first event's consequences",
      });
      const provider = client.storageManager.open(space);
      await client.idle();
      await client.storageManager.synced();
      await waitForSettledThroughHead(
        client,
        space,
        await provider.serverHeadSeq!(),
      );
      const forkSeq = (await provider.listHistory!())[0].seq;
      result.key("add").send({ by: 100 });
      await waitForCellValue(client, doubled, (value) => value === 222, {
        stuckLabel: "the second event's consequences",
      });
      await client.patternManager.flushCompileCacheWrites();
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
      expect(doubled.get()).toBe(222);

      await provider.restoreBranch!({ sourceSeq: forkSeq });
      await waitForCellValue(client, doubled, (value) => value === 22, {
        stuckLabel: "the restored state",
      });
      expect(result.key("count").get()).toBe(11);

      result.key("add").send({ by: 1 });
      await waitForCellValue(client, doubled, (value) => value === 24, {
        stuckLabel: "an event after the restore",
      });
      cancel();
    });
  });

  it("fetches again in a fork only once the fork's request differs", async () => {
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      fetched.push(url);
      return Promise.resolve(new Response(`body of ${url}`, { status: 200 }));
    };
    try {
      const main = makeRuntime();
      const pattern = await main.patternManager.compilePattern({
        main: fetcherPath,
        files: [{ name: fetcherPath, contents: fetcherSource }],
      }, { space });
      const result = main.getCell<{ text: string | undefined }>(
        space,
        "fetcher",
        pattern.resultSchema,
      );
      const tx = main.edit();
      main.runner.run(tx, pattern, { url: "http://fork.test/one" }, result);
      main.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      const text = result.key("text");
      await waitForCellValue(
        main,
        text,
        (value) => value === "body of http://fork.test/one",
        { stuckLabel: "the first fetch" },
      );
      await main.patternManager.flushCompileCacheWrites();
      await main.storageManager.synced();
      expect(fetched).toEqual(["http://fork.test/one"]);
      await main.storageManager.open(space).createBranch!("fork");

      const fork = makeRuntime("fork");
      const forked = fork.getCellFromLink(result.getAsNormalizedFullLink());
      await fork.runner.start(forked);
      await waitForCellValue(
        fork,
        forked.key("text"),
        (value) => value === "body of http://fork.test/one",
        { stuckLabel: "the fork's inherited fetch result" },
      );
      await fork.scheduler.idleWithPendingCommits();
      await fork.storageManager.synced();
      expect(fetched).toEqual(["http://fork.test/one"]);

      forked.key("setUrl").send({ url: "http://fork.test/two" });
      await waitForCellValue(
        fork,
        forked.key("text"),
        (value) => value === "body of http://fork.test/two",
        { stuckLabel: "the fork's own fetch" },
      );
      expect(fetched).toEqual(["http://fork.test/one", "http://fork.test/two"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("with `forkBranch`, writing to a space its `branches` does not list", () => {
    let other: MemorySpace;

    /** Connects a runtime that opens `space` on "fork" and forks the rest. */
    const makeForkingRuntime = (): {
      runtime: Runtime;
      manager: EmulatedStorageManager;
    } => {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: signer,
        branches: { [space]: "fork" },
        forkBranch: "fork",
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: false },
      });
      return { runtime, manager };
    };

    /** Commits `value` to the note in `other`, through `runtime`. */
    const writeNote = async (runtime: Runtime, value: string) => {
      const note = runtime.getCell<string>(other, "note");
      await note.sync();
      const tx = runtime.edit();
      note.withTx(tx).set(value);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.storageManager.synced();
    };

    /** Reads the note in `other` as `runtime`'s server holds it now. */
    const readNote = async (runtime: Runtime) => {
      await runtime.storageManager.synced();
      const note = runtime.getCell<string>(other, "note");
      await note.sync();
      return note.get();
    };

    /** Each branch of `of` beside the default, with its status. */
    const forksOf = async (runtime: Runtime, of: MemorySpace) =>
      (await runtime.storageManager.open(of).listBranches!())
        .filter((branch) => branch.name !== "")
        .map(({ name, status }) => [name, status]);

    beforeEach(async () => {
      other = (await Identity.fromPassphrase("branch runtime other"))
        .did() as MemorySpace;
    });

    it("reads that space as it stood at the first open, and leaves what its default branch holds as it was", async () => {
      const main = makeRuntime();
      await writeNote(main, "on main");
      await main.storageManager.open(space).createBranch!("fork");
      const { runtime: fork, manager } = makeForkingRuntime();
      try {
        expect(await readNote(fork)).toBe("on main");

        await writeNote(fork, "on fork");

        expect(await readNote(fork)).toBe("on fork");
        expect(await readNote(main)).toBe("on main");
        expect(await forksOf(main, other)).toEqual([["fork", "active"]]);
      } finally {
        await fork.dispose({ closeStorage: false });
        await manager.close();
      }
    });

    it("deletes that space's branch when its storage manager closes, and leaves the listed space's branch active", async () => {
      const main = makeRuntime();
      await writeNote(main, "on main");
      await main.storageManager.open(space).createBranch!("fork");
      const { runtime: fork, manager } = makeForkingRuntime();
      try {
        // Opening the listed space is what puts its provider among those
        // the close walks.
        await fork.storageManager.open(space).listBranches!();
        await writeNote(fork, "on fork");
      } finally {
        await fork.dispose({ closeStorage: false });
        await manager.close();
      }

      expect(await forksOf(main, other)).toEqual([["fork", "deleted"]]);
      expect(await forksOf(main, space)).toEqual([["fork", "active"]]);
      expect(await readNote(main)).toBe("on main");
    });
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
