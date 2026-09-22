import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import { sqliteQuery } from "../src/builtins/sqlite-builtins.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { CooperativeYield } from "../src/scheduler/cooperative-yield.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { getTransactionWriteAttempts } from "../src/storage/transaction-inspection.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("sqlite query cancellation");
const space = signer.did();

describe("sqlite-query-cancellation", () => {
  for (const phase of ["action", "flush", "response"] as const) {
    it(`starts no further work after cancellation before ${phase}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      let cancel!: () => void;
      let result: Cell<{ pending: boolean; result?: unknown }> | undefined;
      let queries = 0;
      using _query = stub(storageManager.open(space), "sqliteQuery", () => {
        queries++;
        cancel();
        return Promise.resolve({ rows: [{ content: "message" }] });
      });
      using writebacks = stub(
        runtime,
        "editWithRetry",
        runtime.editWithRetry.bind(runtime),
      );
      try {
        const setup = runtime.edit();
        const parent = runtime.getCell(space, "query-parent", undefined, setup);
        parent.set({});
        const inputs = runtime.getImmutableCell(
          space,
          {
            db: { id: "of:canceled-query" },
            sql: "SELECT content FROM messages",
          },
          undefined,
          setup,
        );
        expect((await setup.commit()).error).toBeUndefined();
        const builtin = sqliteQuery(
          inputs,
          (_tx, cell) => result = cell,
          (stop) => cancel = stop,
          [parent],
          parent,
          runtime,
        );
        const tx = runtime.edit();
        if (phase === "action") cancel();
        builtin.action(tx);
        if (phase === "flush") cancel();
        expect((await tx.commit()).error).toBeUndefined();
        await tx.postCommitEffectsSettled();

        expect(queries).toBe(phase === "response" ? 1 : 0);
        expect(writebacks.calls).toHaveLength(0);
        if (phase === "action") {
          expect(result).toBeUndefined();
          expect(getTransactionWriteAttempts(tx)).toHaveLength(0);
        } else {
          expect(result?.get()).toMatchObject({ pending: true });
          expect(result?.get().result).toBeUndefined();
        }
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.synced();
        await storageManager.close();
      }
    });
  }

  it("stops completion preparation with its piece and reissues the pending query on restart", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const provider = storageManager.open(space);
    const count = 12;
    const rows = Array.from(
      { length: count },
      (_, i) => ({ content: `row-${i}` }),
    );
    const stopped = Promise.withResolvers<void>();
    let queries = 0;
    using _query = stub(provider, "sqliteQuery", () => {
      queries++;
      return Promise.resolve({
        rows,
        columns: [{ output: "content", table: "messages", column: "content" }],
      });
    });
    using _slices = stub(
      CooperativeYield.prototype,
      "maybeYield",
      function (this: CooperativeYield) {
        return this.yieldNow();
      },
    );
    let cancelView: (() => void) | undefined;
    try {
      const pattern = cf.pattern(() => {
        const db = cf.sqliteDatabase({
          tables: {
            messages: cf.table({
              content: {
                type: "string",
                sqlType: "text",
                ifc: { confidentiality: [cfcAtom.space(space)] },
              },
            }),
          },
        });
        return cf.sqliteQuery({ db, sql: "SELECT content FROM messages" });
      });
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "cancelable-query",
        pattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, pattern, {}, resultCell);
      const preparedRows = new Set<string>();
      let rowTargets: Set<URI> | undefined;
      const edit = runtime.editWithRetry.bind(runtime);
      using _completion = stub(
        runtime,
        "editWithRetry",
        (fn, maxRetries, options) =>
          edit(
            (wtx) => {
              const value = fn(wtx);
              const targets = new Set(
                wtx.getCfcState().writePolicyInputs.flatMap(
                  (input) =>
                    input.kind === "schema" &&
                      typeof input.schema === "object" &&
                      input.schema.properties?.content !== undefined
                      ? [input.target.id]
                      : [],
                ),
              );
              if (targets.size !== count || rowTargets !== undefined) {
                return value;
              }
              rowTargets = new Set(
                getTransactionWriteAttempts(wtx)?.filter(({ id }) =>
                  targets.has(id)
                ).map(({ id }) => id),
              );
              expect(rowTargets.size).toBe(count);
              const write = wtx.writeOrThrow.bind(wtx);
              wtx.writeOrThrow = (address, value, options) => {
                const result = write(address, value, options);
                if (
                  address.path[0] === "cfc" && targets.has(address.id) &&
                  !preparedRows.has(address.id)
                ) {
                  preparedRows.add(address.id);
                  if (preparedRows.size === 1) {
                    setTimeout(() => {
                      runtime.runner.stop(resultCell);
                      stopped.resolve();
                    }, 0);
                  }
                }
                return result;
              };
              return value;
            },
            maxRetries,
            options,
          ),
      );
      expect((await tx.commit()).error).toBeUndefined();
      cancelView = result.sink(() => {});
      await runtime.settled();
      expect(preparedRows.size).toBeGreaterThan(0);
      await stopped.promise;
      expect(preparedRows.size).toBeLessThan(count);
      expect(queries).toBe(1);
      expect(result.get()).toMatchObject({ pending: true });
      for (const id of rowTargets!) {
        expect(
          runtime.readTx().readOrThrow({
            space,
            id,
            type: "application/json",
            path: [],
          }),
        ).toBeUndefined();
      }

      const restart = runtime.edit();
      runtime.run(restart, pattern, {}, resultCell);
      expect((await restart.commit()).error).toBeUndefined();
      await runtime.settled();
      expect(queries).toBe(2);
      expect(result.get()).toMatchObject({ pending: false, result: rows });
    } finally {
      cancelView?.();
      await runtime.dispose({ closeStorage: false });
      await storageManager.synced();
      await storageManager.close();
    }
  });
});
