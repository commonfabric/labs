import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { runInServingContext } from "../../src/executor/serving-context.ts";
import {
  inServingContext,
  listenServingMemoryServer,
  startServingMemoryServer,
} from "../../src/executor/serving-memory-server.deno.ts";
import { Runtime } from "../../src/runtime.ts";
import type { StorageNotification } from "../../src/storage/interface.ts";
import { StorageManager } from "../../src/storage/v2.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

const alice = await Identity.fromPassphrase("serving memory server alice");

type Counter = { count: number };

/** A counter whose only writer is a handler, so a served event moves it. */
const COUNTER_SOURCE = `
import { handler, pattern, Writable } from "commonfabric";
const bump = handler<Record<string, never>, { count: Writable<number> }>(
  (_event, { count }) => count.set(count.get() + 1),
);
export default pattern(() => {
  const count = new Writable<number>(0).for("count");
  return { count, bump: bump({ count }) };
});
`;

/** The counter, with the count held per user rather than per space. */
const USER_COUNTER_SOURCE = `
import { Default, handler, pattern, PerUser, Writable } from "commonfabric";
const bump = handler<Record<string, never>, { count: Writable<number> }>(
  (_event, { count }) => count.set(count.get() + 1),
);
export default pattern<{ count?: PerUser<Writable<number | Default<0>>> }>(
  ({ count }) => ({ count, bump: bump({ count: count! }) }),
);
`;

/** A fetch of a URL a client writes, which on the ON arm the loop makes. */
const FETCH_SOURCE = `
import { fetchJson, pattern, Writable } from "commonfabric";
export default pattern<{ url: Writable<string> }>(({ url }) => {
  const fetched = fetchJson<{ v: number }>({ url });
  return { url, v: fetched.result.v };
});
`;

/**
 * Starts the counter from `writer`, fires one bump, and waits until `reader`
 * reads the count the serving loop committed. Under ON the firing client
 * commits only the event, and may show its consequence speculatively; the
 * reader fired nothing, so the count it reads is the store's.
 */
async function expectServedBump(writer: Runtime, reader: Runtime) {
  const space = alice.did() as MemorySpace;
  const cancels: Array<() => void> = [];
  try {
    const pattern = await writer.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
    }, { space });
    const result = writer.getCell<Counter>(
      space,
      "counter",
      pattern.resultSchema,
    );
    const start = writer.edit();
    writer.run(start, pattern, {}, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancels.push(result.sink(() => {}));
    await waitForCellValue<Counter>(writer, result, (v) => v?.count === 0);
    result.key("bump").send({});

    const read = reader.getCellFromLink<Counter>(
      result.getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    const value = await waitForCellValue<Counter>(
      reader,
      read,
      (v) => v?.count === 1,
    );
    expect(value.count).toBe(1);
  } finally {
    for (const cancel of cancels) cancel();
  }
}

describe("serving-memory-server", () => {
  describe("startServingMemoryServer()", () => {
    it("commits the consequence of an ON client's event, which a second client reads from the store", async () => {
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
      });
      const runtimes = [0, 1].map(() =>
        new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: EmulatedStorageManager.connectTo(serving.server, {
            as: alice,
          }),
          experimental: { serverExecution: true },
        })
      );
      const [writer, reader] = runtimes;
      try {
        await expectServedBump(writer, reader);
      } finally {
        await serving.host.close();
        // Each runtime's dispose closes its own storage manager.
        for (const runtime of runtimes) await runtime.dispose();
      }
    });

    it("serves an event whose handler reads a user-scoped document a client wrote", async () => {
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
      });
      const runtimes = [0, 1].map(() =>
        new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: EmulatedStorageManager.connectTo(serving.server, {
            as: alice,
          }),
          experimental: { serverExecution: true },
        })
      );
      const [writer, reader] = runtimes;
      const space = alice.did() as MemorySpace;
      const cancels: Array<() => void> = [];
      try {
        const pattern = await writer.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: USER_COUNTER_SOURCE }],
        }, { space });
        const result = writer.getCell<Counter>(
          space,
          "user-counter",
          pattern.resultSchema,
        );
        const start = writer.edit();
        writer.run(start, pattern, {}, result);
        expect((await start.commit().settled).error).toBeUndefined();
        cancels.push(result.sink(() => {}));
        const seed = writer.edit();
        result.withTx(seed).key("count").set(5);
        expect((await seed.commit().settled).error).toBeUndefined();
        await waitForCellValue<Counter>(writer, result, (v) => v?.count === 5);
        result.key("bump").send({});

        const read = reader.getCellFromLink<Counter>(
          result.getAsNormalizedFullLink(),
        );
        cancels.push(read.sink(() => {}));
        const value = await waitForCellValue<Counter>(
          reader,
          read,
          (v) => v !== undefined && v.count !== 5,
        );
        expect(value.count).toBe(6);
      } finally {
        for (const cancel of cancels) cancel();
        await serving.host.close();
        for (const runtime of runtimes) await runtime.dispose();
      }
    });

    it("runs the serving loop's work in the serving context, and a client's frames outside it", async () => {
      // Each record is one crossing. The host activates the space when the
      // client's session opens it, and disposes its runtime when the test
      // closes it. The serving replica integrates the client's writes from
      // its admission feed; the client integrates server frames on a turn
      // armed by the committing side's request. The served derivation that
      // reads the client's write makes the fetch.
      const activations: boolean[] = [];
      const disposals: boolean[] = [];
      const servingIntegrations: boolean[] = [];
      const clientIntegrations: boolean[] = [];
      const fetches: boolean[] = [];
      const servingStorageReady = Promise.withResolvers<StorageManager>();
      const servingIntegrated = Promise.withResolvers<void>();
      const recordIntegrations = (into: boolean[]) => ({
        next: (notification: StorageNotification) => {
          if (notification.type === "integrate") {
            into.push(inServingContext());
            if (into === servingIntegrations) servingIntegrated.resolve();
          }
          return undefined;
        },
      });
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        prepareStorageManager: (manager) => {
          activations.push(inServingContext());
          manager.subscribe(recordIntegrations(servingIntegrations));
          servingStorageReady.resolve(manager);
          return () => disposals.push(inServingContext());
        },
        fetch: () => {
          fetches.push(inServingContext());
          return Promise.resolve(
            new Response('{"v":7}', {
              headers: { "content-type": "application/json" },
            }),
          );
        },
      });
      const storageManager = EmulatedStorageManager.connectTo(serving.server, {
        as: alice,
      });
      storageManager.subscribe(recordIntegrations(clientIntegrations));
      const client = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      const space = alice.did() as MemorySpace;
      const cancels: Array<() => void> = [];
      try {
        const pattern = await client.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: FETCH_SOURCE }],
        }, { space });
        const result = client.getCell<{ url: string; v?: number }>(
          space,
          "fetcher",
          pattern.resultSchema,
        );
        const start = client.edit();
        client.run(start, pattern, { url: "" }, result);
        expect((await start.commit().settled).error).toBeUndefined();
        cancels.push(result.sink(() => {}));
        // Hold the initial URL in the serving replica before the client
        // changes it, so that change crosses the integration boundary.
        const servingStorage = await servingStorageReady.promise;
        await runInServingContext(
          true,
          () => servingStorage.syncCell(result.key("url")),
        );
        const point = client.edit();
        result.withTx(point).key("url").set("https://example.test/v");
        expect((await point.commit().settled).error).toBeUndefined();
        await waitForCellValue<{ v?: number }>(
          client,
          result,
          (value) => value?.v === 7,
        );
        await servingIntegrated.promise;
        await serving.host.close();

        expect(activations.length).toBeGreaterThan(0);
        expect(activations.every((serving) => serving)).toBe(true);
        expect(disposals.length).toBeGreaterThan(0);
        expect(disposals.every((serving) => serving)).toBe(true);
        expect(servingIntegrations.length).toBeGreaterThan(0);
        expect(servingIntegrations.every((serving) => serving)).toBe(true);
        expect(clientIntegrations.length).toBeGreaterThan(0);
        expect(clientIntegrations.every((serving) => !serving)).toBe(true);
        expect(fetches).toStrictEqual([true]);
      } finally {
        for (const cancel of cancels) cancel();
        await serving.host.close();
        await client.dispose();
      }
    });

    it("runs a lifecycle verb in the serving context, whatever asked for it", async () => {
      await using serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
      });
      const receipt = await serving.host.runLifecycleVerb(
        alice.did() as MemorySpace,
        { name: "probe", run: () => Promise.resolve(inServingContext()) },
      );
      expect(receipt).toBe(true);
    });

    it("closes the serving loop and the server once, however often it is asked", async () => {
      const serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
      });
      const first = serving.close();
      expect(serving.close()).toBe(first);
      await first;
      await serving[Symbol.asyncDispose]();
      expect(serving.host.stats().activeSpaces).toBe(0);
    });
  });

  describe("listenServingMemoryServer()", () => {
    it("serves the event of an ON client connected over its websocket", async () => {
      await using serving = await listenServingMemoryServer();
      const runtimes = [0, 1].map(() =>
        new Runtime({
          apiUrl: serving.url,
          storageManager: StorageManager.open({
            as: alice,
            memoryHost: serving.url,
          }),
          experimental: { serverExecution: true },
        })
      );
      const [writer, reader] = runtimes;
      try {
        await expectServedBump(writer, reader);
      } finally {
        await serving.host.close();
        for (const runtime of runtimes) await runtime.dispose();
      }
    });
  });
});
