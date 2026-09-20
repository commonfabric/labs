/**
 * A client's read ceiling reaching the runtime that serves its queries: the
 * client runtime declares it through its sessions
 * (`SessionDescriptor.readCeiling`), the SpaceServer stamps it onto every run
 * it serves as that session, and the served `sqliteQuery` reads under it —
 * so a bounded client sees the rows its ceiling admits and an unbounded
 * client of the same space sees them all (06-cfc.md, "Runtime read
 * ceiling"). Two client runtimes and a service execution host share one
 * in-process memory server; the serving runtime's query provider is stubbed
 * to answer labeled rows, so what each client is served is decided by the
 * ceiling alone.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type {
  SqliteNativeRow,
  SqliteResultColumn,
} from "@commonfabric/memory/v2";

import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

const owner = await Identity.fromPassphrase("read-ceiling host space");
const service = await Identity.fromPassphrase("read-ceiling host service");
const alice = await Identity.fromPassphrase("read-ceiling host alice");
const bob = await Identity.fromPassphrase("read-ceiling host bob");
const space = owner.did() as MemorySpace;

type QueryView = {
  pending?: boolean;
  result?: { body: string }[];
  error?: unknown;
};
type ClientView = { runtime: Runtime; result: Cell<{ query: QueryView }> };

// Every result column's TRUE origin, which the row-label rule's inputs are
// located by (the shape the server captures for a rule-bearing db).
const columns: SqliteResultColumn[] = [
  { output: "id", table: "emails", column: "id" },
  { output: "to_addr", table: "emails", column: "to_addr" },
  { output: "body", table: "emails", column: "body" },
];

// Under the pattern's rule every row's label carries the db owner — the
// creating run's principal — and the addressed row also carries the address.
// A ceiling naming the owner alone admits `mine` and not `shared`.
const rows: SqliteNativeRow[] = [
  { id: 1, to_addr: "", body: "mine" },
  { id: 2, to_addr: "bob@example.test", body: "shared" },
];

const bodies = (state: QueryView | undefined): string[] =>
  (state?.result ?? []).map((row) => row.body);

async function fixture(scope: "space" | "session") {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const errors: unknown[] = [];
  const clientErrors: unknown[] = [];
  // Resolved by the first refusal each side reports: what a case waits on
  // instead of idling a runtime that, once a run is refused, has nothing
  // left to settle.
  const serverRefused = Promise.withResolvers<void>();
  const clientRefused = Promise.withResolvers<void>();
  const requests: string[] = [];
  const clients: Array<
    { runtime: Runtime; manager: EmulatedStorageManager; cancel?: () => void }
  > = [];
  let host: ExecutorHost | undefined;
  async function close() {
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
        manager.open(space).sqliteQuery = (_db, sql) => {
          requests.push(sql);
          return Promise.resolve({ rows, columns });
        };
        runtime.scheduler.onError((error) => {
          errors.push(error);
          serverRefused.resolve();
        });
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
    const openClient = (
      signer: typeof alice,
      options: Partial<RuntimeOptions> = {},
    ) => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
        errorHandlers: [(error) => {
          clientErrors.push(error);
          clientRefused.resolve();
        }],
        ...options,
      });
      const client = {
        runtime,
        manager,
        cancel: undefined as (() => void) | undefined,
      };
      clients.push(client);
      return client;
    };
    // Alice reads under a ceiling naming herself; bob reads unbounded.
    const first = openClient(alice, {
      cfcReadMaxConfidentiality: [alice.did()],
      cfcReadOnExceed: "skip",
    });
    const scoped = scope === "space"
      ? "Writable<string>"
      : "PerSession<Writable<string>>";
    const pattern = await first.runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { cfSqlite, pattern, PerSession, Writable, sqliteDatabase, sqliteQuery } from "commonfabric";
export default pattern<{ sql: ${scoped} }, { query: any }>(({ sql }) => {
  const db = sqliteDatabase({
    tables: {
      emails: cfSqlite.table(
        { id: "integer primary key", to_addr: "text", body: "text" },
        (f) => ({
          confidentiality: cfSqlite.all(
            cfSqlite.dbOwner(),
            cfSqlite.principal(
              "mailto",
              cfSqlite.match(f.to_addr, /[^\\s<>,;"]+@[^\\s<>,;"]+/g),
            ),
          ),
        }),
      ),
    },
  });
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
        "read-ceiling-host-input",
        pattern.argumentSchema,
      );
      const result = runtime.getCell<{ query: QueryView }>(
        space,
        "read-ceiling-host-result",
        pattern.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const seed = runtime.edit();
      argument.withTx(seed).key("sql").set(
        "SELECT id, to_addr, body FROM emails ORDER BY id",
      );
      expect((await seed.commit()).error).toBeUndefined();
      if (create) {
        const start = runtime.edit();
        runtime.run(start, pattern, argument, result);
        expect((await start.commit()).error).toBeUndefined();
      }
      client.cancel = result.sink(() => {});
      return { runtime, result };
    };
    return {
      first: await attach(first, true),
      join: (signer: typeof alice) => attach(openClient(signer), false),
      requests,
      errors,
      clientErrors,
      refused: () =>
        Promise.all([serverRefused.promise, clientRefused.promise]),
      host,
      async issued(count: number) {
        await waitUntil(
          () => requests.length >= count,
          () =>
            JSON.stringify({
              requests: requests.length,
              stats: host!.stats(),
              errors,
            }),
        );
        expect(requests).toHaveLength(count);
      },
      settled: (view: ClientView) =>
        waitForCellValue<QueryView>(
          view.runtime,
          view.result.key("query"),
          (state) => state?.pending === false,
        ),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("executor-sqlite-read-ceiling", () => {
  it("serves a bounded client the rows its ceiling admits and an unbounded client of the same space every row", async () => {
    const f = await fixture("session");
    try {
      const mine = await f.settled(f.first);
      expect(mine.error).toBeUndefined();
      expect(bodies(mine)).toEqual(["mine"]);
      const second = await f.join(bob);
      const all = await f.settled(second);
      expect(all.error).toBeUndefined();
      expect(bodies(all)).toEqual(["mine", "shared"]);
      // One served query per session instance, each under its own
      // session's ceiling.
      await f.issued(2);
      expect(f.errors).toEqual([]);
      expect(f.clientErrors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("refuses, on the serving runtime, a query whose result is not session-scoped for a bounded session's run", async () => {
    // The same refusal the bounded client's own run gets: a shared result
    // cannot hold one session's filtered rows, so the query is refused
    // before it is staged — on both runtimes — and nothing is issued.
    const f = await fixture("space");
    try {
      await f.refused();
      expect(String(f.errors[0])).toMatch(/reads under a read ceiling/);
      expect(String(f.clientErrors[0])).toMatch(/reads under a read ceiling/);
      expect(f.requests).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
