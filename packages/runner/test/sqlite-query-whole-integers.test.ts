/**
 * An ordinary `sqliteQuery` carries a stored INTEGER into its result whole: an
 * epoch-millisecond timestamp as a `number`, and a value past 2^53 as a
 * `bigint`.
 *
 * The pool's own test establishes what the read connection returns. This
 * establishes the rest of the path an unlabeled query takes with that value:
 * across the provider, through the write-back into the result cell, and out
 * of a read of that cell. An unlabeled row is keyed on its content, so a
 * `bigint` has to survive being hashed as well as being stored.
 *
 * A typed `Row` reads the result under its own column schema, and no column
 * schema a `Row` lowers to admits a `bigint`. The typed cases establish what
 * such a consumer sees, and that selecting the column as text reads it exactly.
 *
 * Spec: docs/specs/sqlite-builtin/01-api.md ("The `Row` type argument").
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type QueryState = {
  pending: boolean;
  result?: Array<Record<string, unknown>>;
  error?: unknown;
};

describe("sqliteQuery over a stored INTEGER", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `whole-int-${crypto.randomUUID()}`,
    );
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Seeds a timestamp and a value past 2^53, as SQL literals rather than bound
   * parameters, so what the rows hold does not depend on how a parameter is
   * encoded. */
  const seededDb = async (): Promise<SqliteDbRef> => {
    const db: SqliteDbRef = {
      id: `of:whole-int-${crypto.randomUUID()}`,
      tables: { readings: table({ id: "integer primary key", n: "integer" }) },
    };
    const seedTx = runtime.edit();
    seedTx.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO readings (id, n) VALUES " +
        "(1, 1789000000000), (2, 9007199254740993)",
    });
    const seeded = await seedTx.commit();
    expect(seeded.error).toBeUndefined();
    return db;
  };

  /** Runs `sql` as an ordinary `sqliteQuery` and returns its settled result
   * cell. `rowSchema` is what the transformer injects for a typed `Row`. */
  const settledQuery = async (
    db: SqliteDbRef,
    sql: string,
    rowSchema?: JSONSchema,
  ) => {
    const tx = runtime.edit();
    const pattern = cf.pattern(() =>
      cf.sqliteQuery({
        db,
        sql,
        reactOn: db,
        ...(rowSchema === undefined ? {} : { rowSchema }),
        // The raw handle object stands in for a `sqliteDatabase` result here.
        // deno-lint-ignore no-explicit-any
      } as any)
    );
    const resultCell = runtime.getCell(
      space,
      `whole-int-result-${crypto.randomUUID()}`,
      pattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, pattern, {}, resultCell);
    await tx.commit();
    const state = await waitForCellValue<QueryState>(
      runtime,
      result,
      (s) =>
        s?.pending === false &&
        (s.error !== undefined ||
          (Array.isArray(s.result) && s.result.length === 2)),
    );
    expect(state.error).toBeUndefined();
    return { result, state };
  };

  /** The rows as a consumer whose `Row` lowers to `rowSchema` reads them. */
  const readUnder = (
    result: Awaited<ReturnType<typeof settledQuery>>["result"],
    rowSchema: JSONSchema,
  ): Array<Record<string, unknown>> => {
    const wrapSchema = {
      type: "object",
      additionalProperties: true,
      properties: { result: { type: "array", items: rowSchema } },
    } as unknown as JSONSchema;
    const tree = result.asSchema(wrapSchema).get() as {
      result?: Array<Record<string, unknown>>;
    };
    return tree.result ?? [];
  };

  const columnSchema = (n: unknown): JSONSchema =>
    ({ type: "object", properties: { n } }) as unknown as JSONSchema;

  it("returns a timestamp as a `number` and a value past 2^53 as a `bigint`", async () => {
    const db = await seededDb();
    const { state } = await settledQuery(
      db,
      "SELECT n FROM readings ORDER BY id",
    );
    expect(state.result).toEqual([
      { n: 1789000000000 },
      { n: 9007199254740993n },
    ]);
  });

  // What a `Row` field of type `number`, of type `bigint`, and of their union
  // each lower to.
  const TYPED: [string, unknown][] = [
    ["`number`", { type: "number" }],
    ["`bigint`", { type: "integer" }],
    ["`number | bigint`", { anyOf: [{ type: "number" }, { type: "integer" }] }],
  ];

  for (const [declared, n] of TYPED) {
    it(`reads the timestamp and no value past 2^53 under a column declared ${declared}`, async () => {
      const db = await seededDb();
      const rowSchema = columnSchema(n);
      const { result } = await settledQuery(
        db,
        "SELECT n FROM readings ORDER BY id",
        rowSchema,
      );
      expect(readUnder(result, rowSchema).map((row) => row.n)).toEqual([
        1789000000000,
        undefined,
      ]);
    });
  }

  it("reads both values exactly as digits when the column is selected as text and declared `string`", async () => {
    const db = await seededDb();
    const rowSchema = columnSchema({ type: "string" });
    const { result } = await settledQuery(
      db,
      "SELECT CAST(n AS TEXT) AS n FROM readings ORDER BY id",
      rowSchema,
    );
    expect(readUnder(result, rowSchema).map((row) => row.n)).toEqual([
      "1789000000000",
      "9007199254740993",
    ]);
  });
});
