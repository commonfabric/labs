import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { sqliteQuery } from "../src/builtins/sqlite-builtins.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("cross-space sqlite reader");
const source = (await Identity.fromPassphrase("cross-space sqlite source"))
  .did();
const consumer = signer.did();

interface QueryState {
  pending: boolean;
  result?: unknown;
  error?: unknown;
}

describe("sqlite-cross-space", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  it("refuses a foreign served query without the identity needed to publish its result", async () => {
    const seed = runtime.edit();
    const handle = runtime.getCell(source, "identity handle", undefined, seed);
    handle.set({ id: "of:identity-query" });
    expect((await seed.commit()).error).toBeUndefined();
    const setup = runtime.edit();
    const parent = runtime.getCell(
      consumer,
      "identity parent",
      undefined,
      setup,
    );
    parent.set({});
    const inputs = runtime.getCell(
      consumer,
      "identity arguments",
      undefined,
      setup,
    );
    inputs.set({ db: handle, sql: "SELECT 1" });
    expect((await setup.commit()).error).toBeUndefined();
    for (
      const context of [
        { acting: { user: consumer } },
        { scopeKeyIdentity: { principal: consumer } },
      ]
    ) {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "foreign query",
        kind: "derivation",
        ...context,
      });
      const builtin = sqliteQuery(
        inputs,
        () => {
          throw new Error("must not publish without identity");
        },
        () => {},
        [parent],
        parent,
        runtime,
        {
          ...parent.getAsNormalizedFullLink(),
          scope: "session",
        },
      );
      expect(() => builtin.action(tx)).toThrow(
        "complete scoped reader identity",
      );
      tx.abort();
    }
  });

  it("queries the referenced handle's space when the consumer has a database with the same id", async () => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const db: SqliteDbRef = {
      id: `of:cross-space-${crypto.randomUUID()}`,
      tables: { notes: table({ body: "text" }) },
    };
    for (
      const [space, body] of [[source, "source"], [
        consumer,
        "consumer",
      ]] as const
    ) {
      const seed = runtime.edit();
      seed.recordSqliteWrite!(space, {
        op: "sqlite",
        db,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: [body],
      });
      expect((await seed.commit()).error).toBeUndefined();
    }
    const handleTx = runtime.edit();
    const handle = runtime.getCell<SqliteDbRef>(
      source,
      "source handle",
      undefined,
      handleTx,
    );
    handle.set(db);
    expect((await handleTx.commit()).error).toBeUndefined();
    const tx = runtime.edit();
    const queryPattern = cf.pattern<{ db: unknown }>(({ db }) =>
      cf.sqliteQuery({ db: db as never, sql: "SELECT body FROM notes" })
    );
    const result = runtime.run(
      tx,
      queryPattern,
      { db: handle },
      runtime.getCell(
        consumer,
        "cross-space result",
        queryPattern.resultSchema,
        tx,
      ),
    );
    expect((await tx.commit()).error).toBeUndefined();
    const state = await waitForCellValue<QueryState>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    expect(state.error).toBeUndefined();
    expect(state.result).toEqual([{ body: "source" }]);
    const switchTx = runtime.edit();
    const localHandle = runtime.getCell(
      consumer,
      "local handle",
      undefined,
      switchTx,
    );
    localHandle.set(db);
    result.getArgumentCell()!.withTx(switchTx).key("db").set(localHandle);
    expect((await switchTx.commit()).error).toBeUndefined();
    const switched = await waitForCellValue<QueryState>(
      runtime,
      result,
      (value) =>
        value?.pending === false &&
        JSON.stringify(value.result) === '[{"body":"consumer"}]',
    );
    expect(switched.error).toBeUndefined();
    expect(switched.result).toEqual([{ body: "consumer" }]);
  });
});
