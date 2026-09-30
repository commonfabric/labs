/** Exercises compiled home discovery and foreign SQLite reads on a serving host. */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { Server } from "@commonfabric/memory/v2/server";
import { table } from "@commonfabric/memory/sqlite/schema";

import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("home sqlite executor");
const consumer = (await Identity.fromPassphrase("home sqlite consumer")).did();
const alice = await Identity.fromPassphrase("home sqlite Alice");
const bob = await Identity.fromPassphrase("home sqlite Bob");

type View = {
  query?: { pending: boolean; result?: { body: string }[]; error?: string };
};

describe("executor-home-sqlite", () => {
  it("serves each user's home database through the same compiled consumer", async () => {
    const server = new Server({
      store: new URL("memory://executor-home-sqlite"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      sessionOpenAuth: { audience: "did:key:home-sqlite-test" },
      acl: { mode: "off", delegatingDids: [service.did()] },
    });
    await server.writeDocument(consumer, `of:${consumer}`, {
      [alice.did()]: "OWNER",
      [bob.did()]: "WRITE",
    });
    const clients: {
      runtime: Runtime;
      manager: EmulatedStorageManager;
      cancel?: () => void;
    }[] = [];
    const errors: unknown[] = [];
    const host = new ExecutorHost({
      server,
      ensureSpaceRoots: false,
      serviceIdentity: service.did(),
      // deno-lint-ignore require-await
      createRuntime: async (space) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        runtime.scheduler.onError((error) => errors.push(error));
        return { runtime, dispose: () => runtime.dispose() };
      },
    });
    try {
      for (const user of [alice, bob]) {
        await server.writeDocument(user.did(), `of:${user.did()}`, {
          [user.did()]: "OWNER",
        });
        const manager = EmulatedStorageManager.connectTo(server, { as: user });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        runtime.scheduler.onError((error) => errors.push(error));
        const client: typeof clients[number] = { runtime, manager };
        clients.push(client);
        const db = {
          id: `of:home-sqlite-${crypto.randomUUID()}`,
          tables: { notes: table({ body: "text" }) },
        };
        const seed = runtime.edit();
        seed.recordSqliteWrite!(user.did(), {
          op: "sqlite",
          db,
          sql: "INSERT INTO notes VALUES (?)",
          params: [user.did()],
        });
        const handle = runtime.getCell(
          user.did(),
          "db handle",
          undefined,
          seed,
        );
        handle.set(db);
        const provider = runtime.getCell(
          user.did(),
          "provider",
          undefined,
          seed,
        );
        provider.set({ db: handle });
        const home = runtime.getCell(user.did(), user.did(), undefined, seed);
        home.set({
          defaultPattern: {
            favorites: [{ cell: provider, tags: ["loom_resources_v1"] }],
          },
        });
        expect((await seed.commit()).error).toBeUndefined();
        const pattern = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
import { pattern, wish, PerUser, PerSession, Writable, SqliteDb, sqliteQuery } from "commonfabric";
export default pattern<{ sql: PerSession<Writable<string>> }, { query: any }>(({ sql }) => {
  const resources = wish<Writable<PerUser<{ db: SqliteDb }>>>({ query: "#loom_resources_v1", scope: ["~"], headless: true });
  const db = resources.result?.get()?.db;
  const query = sqliteQuery.asScope("session")({ db: db!, sql });
  return { query };
});`,
          }],
        }, { space: consumer });
        const result = runtime.getCell<View>(
          consumer,
          "shared inbox",
          pattern.resultSchema,
        );
        await result.sync();
        const argument = runtime.getCell<{ sql: string }>(
          consumer,
          "shared input",
          pattern.argumentSchema,
        );
        await argument.sync();
        const args = runtime.edit();
        argument.withTx(args).key("sql").set("SELECT body FROM notes");
        expect((await args.commit()).error).toBeUndefined();
        if (user === alice) {
          const start = runtime.edit();
          runtime.run(start, pattern, argument, result);
          expect((await start.commit()).error).toBeUndefined();
        }
        client.cancel = result.sink(() => {});
        const value = await waitForCellValue<View>(
          runtime,
          result,
          (value) =>
            value?.query?.pending === false &&
            value.query.result?.[0]?.body === user.did(),
        );
        expect(value.query?.error).toBeUndefined();
      }
      expect(errors).toEqual([]);
    } finally {
      for (const client of clients) client.cancel?.();
      await host.close();
      for (const client of clients) {
        await client.runtime.dispose({ closeStorage: false });
        await client.manager.close();
      }
      await server.close();
    }
  });
});
