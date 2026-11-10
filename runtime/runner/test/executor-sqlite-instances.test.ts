/** Exercises non-clearance SQLite result scopes through a service execution host. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

const owner = await Identity.fromPassphrase("sqlite host space");
const service = await Identity.fromPassphrase("sqlite host service");
const alice = await Identity.fromPassphrase("sqlite host alice");
const bob = await Identity.fromPassphrase("sqlite host bob");
const space = owner.did() as MemorySpace;
type QueryView = {
  rows?: { body: string }[];
  error?: unknown;
};
type ClientView = { runtime: Runtime; result: Cell<{ query: QueryView }> };

async function fixture(scope: "space" | "user" | "session") {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const errors: unknown[] = [];
  const requests: Array<
    {
      scope?: string;
      db: string;
      sql: string;
      response: ReturnType<
        typeof Promise.withResolvers<{ rows: { body: string }[] }>
      >;
    }
  > = [];
  const clients: Array<
    { runtime: Runtime; manager: EmulatedStorageManager; cancel?: () => void }
  > = [];
  let host: ExecutorHost | undefined;
  async function close() {
    for (const request of requests) request.response.resolve({ rows: [] });
    for (const client of clients) client.cancel?.();
    await host?.close();
    for (const client of clients) {
      try {
        await client.runtime.dispose({ closeStorage: false });
      } finally {
        await client.manager.close();
      }
    }
    await server.close();
  }
  try {
    host = new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      // The host factory contract returns a promise.
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
        manager.open(space).sqliteQuery = (db, sql) => {
          const response = Promise.withResolvers<
            { rows: { body: string }[] }
          >();
          requests.push({ scope: db.scope, db: db.id, sql, response });
          return response.promise;
        };
        runtime.scheduler.onError((error) => errors.push(error));
        return {
          runtime,
          dispose: async () => {
            try {
              await runtime.dispose();
            } catch (error) {
              await manager.close();
              throw error;
            }
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    const openClient = (signer: typeof alice) => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      const client = {
        runtime,
        manager,
        cancel: undefined as (() => void) | undefined,
      };
      clients.push(client);
      return client;
    };
    const first = openClient(alice);
    const scoped = scope === "space"
      ? "Writable<string>"
      : `${scope === "user" ? "PerUser" : "PerSession"}<Writable<string>>`;
    const pattern = await first.runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { pattern, PerUser, PerSession, Writable, sqliteDatabase, sqliteQuery, table } from "commonfabric";
export default pattern<{ sql: ${scoped} }, { query: any }>(({ sql }) => {
  const db = sqliteDatabase({ tables: { notes: table({ body: "text" }) } });
  return { query: sqliteQuery.asScope("${scope}")({ db, sql }) };
});
`,
      }],
    }, { space });
    const attach = async (
      client: typeof first,
      create: boolean,
    ): Promise<ClientView> => {
      const runtime = client.runtime;
      const argument = runtime.getCell<{ sql: string }>(
        space,
        "sqlite-host-input",
        pattern.argumentSchema,
      );
      const result = runtime.getCell<{ query: QueryView }>(
        space,
        "sqlite-host-result",
        pattern.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const seed = runtime.edit();
      argument.withTx(seed).key("sql").set("SELECT body FROM notes");
      expect((await seed.commit().settled).error).toBeUndefined();
      if (create) {
        const start = runtime.edit();
        runtime.run(start, pattern, argument, result);
        expect((await start.commit().settled).error).toBeUndefined();
      }
      client.cancel = result.sink(() => {});
      return { runtime, result };
    };
    return {
      first: await attach(first, true),
      join: (signer: typeof alice) => attach(openClient(signer), false),
      requests,
      errors,
      async issued(count: number) {
        await waitUntil(
          () =>
            requests.length >= count || host!.stats().outbox.completed >= count,
          () =>
            JSON.stringify({
              requests: requests.length,
              stats: host!.stats(),
              errors,
            }),
        );
        expect(requests).toHaveLength(count);
        expect(requests.every((request) => request.scope === "space")).toBe(
          true,
        );
      },
      value: (view: ClientView, body: string) =>
        waitForCellValue<QueryView>(
          view.runtime,
          view.result.key("query"),
          (state) => state?.rows?.[0]?.body === body,
        ),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("executor-sqlite-instances", () => {
  for (const scope of ["space", "user", "session"] as const) {
    it(`completes one ${scope} result from a space database`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        f.requests[0].response.resolve({ rows: [{ body: "first" }] });
        expect((await f.value(f.first, "first")).error).toBeUndefined();
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }
  for (const scope of ["user", "session"] as const) {
    it(`completes equal queries independently in two ${scope} instances`, async () => {
      const f = await fixture(scope);
      try {
        await f.issued(1);
        const second = await f.join(scope === "user" ? bob : alice);
        await f.issued(2);
        expect(f.requests[0].db).toBe(f.requests[1].db);
        expect(f.requests[0].sql).toBe(f.requests[1].sql);
        f.requests[1].response.resolve({ rows: [{ body: "second" }] });
        await f.value(second, "second");
        f.requests[0].response.resolve({ rows: [{ body: "first" }] });
        await f.value(f.first, "first");
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }
});
