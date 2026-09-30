/** Exercises non-clearance SQLite result scopes through a service execution host. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { encodeCfLinkValue } from "../src/builtins/sqlite/cf-link.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
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
  pending?: boolean;
  result?: { body: string }[];
  error?: unknown;
};
type SqlResponse = {
  rows: { body: string; target_cf_link?: string; other_cf_link?: string }[];
  columns?: { output: string; table: string; column: string }[];
};
type ClientView = { runtime: Runtime; result: Cell<{ query: QueryView }> };

async function fixture(
  scope: "space" | "user" | "session",
  confidentialLinks = false,
) {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const errors: unknown[] = [];
  const retirementEvents = new EventTarget();
  const requests: Array<
    {
      scope?: string;
      db: string;
      sql: string;
      response: ReturnType<
        typeof Promise.withResolvers<SqlResponse>
      >;
    }
  > = [];
  const clients: Array<
    { runtime: Runtime; manager: EmulatedStorageManager; cancel?: () => void }
  > = [];
  let host: ExecutorHost | undefined;
  let serverRuntime: Runtime | undefined;
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
      onEffectRetired: () =>
        retirementEvents.dispatchEvent(new Event("retired")),
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
        serverRuntime = runtime;
        manager.open(space).sqliteQuery = (db, sql) => {
          const response = Promise.withResolvers<SqlResponse>();
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
    const targetTx = first.runtime.edit();
    const target = first.runtime.getCell(space, "sqlite-host-private-target", {
      type: "object",
      ifc: { confidentiality: ["target-content"] },
    }, targetTx);
    target.set({ name: "Ada" });
    first.runtime.prepareTxForCommit(targetTx);
    expect((await targetTx.commit()).error).toBeUndefined();
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
  const db = sqliteDatabase({ tables: { notes: table({ body: "text"${
          confidentialLinks
            ? ', target_cf_link: { type: "string", sqlType: "text", ifc: { confidentiality: ["sql-link-column"] } }, other_cf_link: { type: "string", sqlType: "text", ifc: { confidentiality: ["other-link-column"] } }'
            : ""
        } }) } });
  return { query: sqliteQuery.asScope("${scope}")({ db, sql${
          confidentialLinks
            ? ', rowSchema: { type: "object", properties: { body: { type: "string" }, target_cf_link: { asCell: ["cell"], type: "object" }, other_cf_link: { asCell: ["cell"], type: "object" } } }'
            : ""
        } } as any) };
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
      argument.withTx(seed).key("sql").set(
        confidentialLinks
          ? "SELECT body, target_cf_link, other_cf_link FROM notes"
          : "SELECT body FROM notes",
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
      stats: () => host!.stats(),
      effectsRetired: () =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (host!.stats().memo.inflight !== 0) return;
            retirementEvents.removeEventListener("retired", check);
            resolve();
          };
          retirementEvents.addEventListener("retired", check);
          check();
        }),
      get serverRuntime() {
        return serverRuntime!;
      },
      linkResponse(body: string): SqlResponse {
        return {
          rows: [{
            body,
            target_cf_link: encodeCfLinkValue(target),
            other_cf_link: encodeCfLinkValue(target),
          }],
          columns: ["body", "target_cf_link", "other_cf_link"].map((
            column,
          ) => ({
            output: column,
            table: "notes",
            column,
          })),
        };
      },
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
          (state) =>
            state?.pending === false && state.result?.[0]?.body === body,
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
    it(`publishes complete confidential references in a served ${scope} result`, async () => {
      const f = await fixture(scope, true);
      try {
        await f.issued(1);
        f.requests[0].response.resolve(f.linkResponse("private links"));
        expect((await f.value(f.first, "private links")).error).toBeUndefined();
        const tx = f.first.runtime.edit();
        const selected = f.first.result.withTx(tx).key("query").asSchema({
          type: "object",
          properties: {
            result: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  target_cf_link: { asCell: ["cell"], type: "object" },
                },
              },
            },
          },
        }).get() as { result: { target_cf_link: Cell<{ name: string }> }[] };
        const held = selected.result[0].target_cf_link;
        expect(getCfcReferenceProvenance(held)).toBeDefined();
        const before = deriveFlowJoin(tx).confidentiality ?? [];
        expect(before).toContain("sql-link-column");
        // Reading result membership observes every projected column.
        expect(before).toContain("other-link-column");
        expect(before).not.toContain("target-content");
        expect(held.get()).toEqual({ name: "Ada" });
        expect(deriveFlowJoin(tx).confidentiality).toContain("target-content");
        tx.abort("checked hosted reference");
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  it("keeps the served effect in flight until every reference and publication commits", async () => {
    const f = await fixture("user", true);
    const materialized = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      await f.issued(1);
      const before = f.stats();
      const edit = f.serverRuntime.editWithRetry.bind(f.serverRuntime);
      let held = false;
      f.serverRuntime.editWithRetry = (fn, retries, options) => {
        let linkWrite = false;
        return edit(
          (tx) => {
            const value = fn(tx);
            linkWrite = tx.getCfcState().writePolicyInputs.some((input) =>
              input.kind === "link-write" &&
              input.target.path.at(-1) === "target_cf_link"
            );
            return value;
          },
          retries,
          options,
        ).then(async (outcome) => {
          if (!outcome.error && linkWrite && !held) {
            held = true;
            materialized.resolve();
            await release.promise;
          }
          return outcome;
        });
      };
      f.requests[0].response.resolve(f.linkResponse("held completion"));
      await materialized.promise;
      expect(f.stats().memo.inflight).toBe(1);
      expect(f.stats().outbox.completed).toBe(before.outbox.completed);
      expect(f.requests).toHaveLength(1);
      const pending = f.first.result.key("query").get();
      expect(pending.pending).toBe(true);
      expect(pending.result).toBeUndefined();
      const retired = f.effectsRetired();
      release.resolve();
      await f.value(f.first, "held completion");
      await retired;
      expect(f.stats().memo.inflight).toBe(0);
      expect(f.stats().outbox.completed).toBe(before.outbox.completed + 1);
      expect(f.requests).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it("reports a failed served field without publishing partial rows", async () => {
    const f = await fixture("user", true);
    try {
      await f.issued(1);
      const edit = f.serverRuntime.editWithRetry.bind(f.serverRuntime);
      let refused = false;
      let firstField: string | undefined;
      f.serverRuntime.editWithRetry = (fn, retries, options) =>
        edit(
          (tx) => {
            const value = fn(tx);
            const field = tx.getCfcState().writePolicyInputs.find((input) =>
              input.kind === "link-write" &&
              ["target_cf_link", "other_cf_link"].includes(
                input.target.path.at(-1) ?? "",
              )
            );
            if (field?.kind === "link-write") {
              firstField ??= field.target.path.at(-1);
            }
            if (
              !refused && field?.kind === "link-write" &&
              field.target.path.at(-1) !== firstField
            ) {
              refused = true;
              throw new Error("injected served field failure");
            }
            return value;
          },
          retries,
          options,
        );
      f.requests[0].response.resolve(f.linkResponse("private links"));
      const state = await waitForCellValue<QueryView>(
        f.first.runtime,
        f.first.result.key("query"),
        (state) => state?.pending === false && state.error !== undefined,
      );
      expect(refused).toBe(true);
      expect(state.result).toBeUndefined();
      expect(String(state.error)).toContain("injected served field failure");
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

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
    for (const confidentialLinks of [false, true]) {
      it(`completes ${confidentialLinks ? "confidential " : ""}equal queries independently in two ${scope} instances`, async () => {
        const f = await fixture(scope, confidentialLinks);
        try {
          await f.issued(1);
          const second = await f.join(scope === "user" ? bob : alice);
          await f.issued(2);
          expect(f.requests[0].db).toBe(f.requests[1].db);
          expect(f.requests[0].sql).toBe(f.requests[1].sql);
          f.requests[1].response.resolve(
            confidentialLinks
              ? f.linkResponse("second")
              : { rows: [{ body: "second" }] },
          );
          await f.value(second, "second");
          f.requests[0].response.resolve(
            confidentialLinks
              ? f.linkResponse("first")
              : { rows: [{ body: "first" }] },
          );
          await f.value(f.first, "first");
          expect(f.errors).toEqual([]);
        } finally {
          await f.close();
        }
      });
    }
  }
});
