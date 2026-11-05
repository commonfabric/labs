/**
 * `sqliteQuery` over a `db` input that does not read back as a database
 * handle: the failure reaches the query result as its `error` rather than
 * throwing out of the reactive action.
 *
 * The truthiness guard admits any non-empty value, and an object read that
 * resolved to nothing is `{}` — truthy, and not a handle. A throw there kills
 * the action for good: the scheduler logs one failure and no later pass
 * re-runs the query once the handle does read, so the piece stays pending
 * with nothing to show for it. Reported as the result's `error` — the state
 * an unencodable parameter already produces — the pattern can render it and a
 * later pass can still succeed.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

interface QueryState {
  pending: boolean;
  result?: unknown;
  error?: unknown;
}

describe("sqliteQuery()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Runs a query whose `db` is `dbInput` and returns the settled result. The
   * cause names the case so each `it()` gets a result cell of its own.
   */
  async function settledQueryOver(
    label: string,
    dbInput: unknown,
  ): Promise<QueryState> {
    const queryPattern = cf.pattern(() =>
      // The cast is the subject: each case supplies a `db` the handle type
      // excludes, which is what a read resolving to nothing produces at
      // runtime whatever the declaration says.
      cf.sqliteQuery({ db: dbInput as never, sql: "SELECT body FROM notes" })
    );
    const resultCell = runtime.getCell(
      space,
      `sqlite-invalid-handle-${label}`,
      queryPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, queryPattern, {}, resultCell);
    await tx.commit().settled;
    return await waitForCellValue<QueryState>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
  }

  describe("a `db` that is not a database handle", () => {
    it("settles an empty object with `error` naming the invalid handle", async () => {
      const state = await settledQueryOver("empty-object", {});
      expect(state.error).toBe("sqlite: invalid database handle");
      expect(state.result).toBeUndefined();
      expect(state.pending).toBe(false);
    });

    it("settles a handle missing its `id` with the same `error`", async () => {
      const state = await settledQueryOver("no-id", { tables: {} });
      expect(state.error).toBe("sqlite: invalid database handle");
    });

    it("settles a string `db` with the same `error`", async () => {
      const state = await settledQueryOver("string", "of:fid1:not-a-handle");
      expect(state.error).toBe("sqlite: invalid database handle");
    });
  });

  describe("a `db` that becomes a handle after the error", () => {
    // The other half of the contract the reported error buys. Settling the
    // error rather than throwing is only worth anything if the action that
    // settled it is still subscribed to its inputs: an action killed by a
    // throw reports the same first state and never reaches the second. So the
    // case drives one query across both, through a single input cell.

    it("re-runs the same action and settles a successful result once the input reads back as a handle", async () => {
      const dbRef: SqliteDbRef = {
        id: `of:recovers-${crypto.randomUUID()}`,
        tables: { notes: table({ id: "integer primary key", body: "text" }) },
      };
      // Seeded through the real write path, so a recovered read that returns
      // this row cannot be confused with a query answering over no table.
      const seedTx = runtime.edit();
      seedTx.recordSqliteWrite!(space, {
        op: "sqlite",
        db: dbRef,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["recovered"],
      });
      expect((await seedTx.commit().settled).error).toBeUndefined();

      // `{}` is what an object read that resolved to nothing produces, and is
      // the state the handle arrives late from.
      const inputs = runtime.getCell<{ db: unknown }>(
        space,
        "sqlite-invalid-handle-recovers-inputs",
        undefined,
        tx,
      );
      inputs.set({ db: {} });

      const queryPattern = cf.pattern<{ db: unknown }>(({ db }) =>
        cf.sqliteQuery({
          db: db as never,
          sql: "SELECT body FROM notes",
          reactOn: db as never,
        })
      );
      const resultCell = runtime.getCell(
        space,
        "sqlite-invalid-handle-recovers-result",
        queryPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, queryPattern, inputs, resultCell);
      await tx.commit().settled;

      const failed = await waitForCellValue<QueryState>(
        runtime,
        result,
        (value) => value?.pending === false,
      );
      expect(failed.error).toBe("sqlite: invalid database handle");

      await runtime.editWithRetry((edit) => {
        inputs.withTx(edit).key("db").set(dbRef);
      });

      const recovered = await waitForCellValue<QueryState>(
        runtime,
        result,
        (value) => value?.pending === false && value?.error === undefined,
      );
      expect(recovered.result).toEqual([{ body: "recovered" }]);
    });
  });
});
