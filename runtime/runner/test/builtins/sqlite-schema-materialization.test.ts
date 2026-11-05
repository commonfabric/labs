import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { SqliteDbRef } from "@commonfabric/memory/v2";

import { sqliteQuery } from "../../src/builtins/sqlite-builtins.ts";
import { collectConsumedLabel } from "../../src/cfc/prepare.ts";
import { cfcLabelViewForCell } from "../../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../../src/cfc/observation.ts";
import { hostValueOf } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("sqlite schema materialization");
const space = signer.did();

interface QueryState {
  pending: boolean;
  result?: { n: number }[];
  error?: unknown;
  requestHash?: string;
}

describe("sqlite-builtins", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("reissues a query when linked or inline declarations change and labels aggregates from all tables", async () => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const setup = runtime.edit();
    const dbId = `of:schema-materialization-${crypto.randomUUID()}`;
    const column = runtime.getCell(space, "column", undefined, setup);
    column.setRawUntyped(fabricFromConvertibleJsValue({
      type: "string",
      sqlType: "text",
      ifc: { confidentiality: ["body-secret"] },
    }));
    const tables = runtime.getCell(space, "tables", undefined, setup);
    tables.setRawUntyped(fabricFromConvertibleJsValue({
      notes: {
        type: "object",
        properties: {
          id: { type: "integer", sqlType: "integer primary key" },
          body: column.getAsLink(),
        },
      },
      other: {
        type: "object",
        properties: {
          hidden: {
            type: "string",
            sqlType: "text",
            ifc: { confidentiality: ["other-secret"] },
          },
        },
      },
    }));
    const inputs = runtime.getCell<{ db: SqliteDbRef }>(
      space,
      "inputs",
      undefined,
      setup,
    );
    inputs.setRawUntyped(fabricFromConvertibleJsValue({
      db: { id: dbId, tables: tables.getAsLink() },
    }));

    setup.recordSqliteWrite!(space, {
      op: "sqlite",
      db: {
        id: dbId,
        tables: hostValueOf(tables.get()) as SqliteDbRef["tables"],
      },
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["synthetic body"],
    });

    const sent: SqliteDbRef[] = [];
    const provider = storageManager.open(space);
    const query = provider.sqliteQuery!.bind(provider);
    provider.sqliteQuery = (db, ...args) => {
      sent.push(db);
      return query(db, ...args);
    };
    const pattern = cf.pattern<{ db: unknown }>(({ db }) =>
      cf.sqliteQuery({
        db: db as never,
        sql: "SELECT COUNT(*) AS n FROM notes",
      })
    );
    const result = runtime.run(
      setup,
      pattern,
      inputs,
      runtime.getCell(space, "result", pattern.resultSchema, setup),
    );
    expect((await setup.commit().settled).error).toBeUndefined();
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      await runtime.settled();
      const first = hostValueOf(result.get()) as unknown as QueryState;
      expect(first.error).toBeUndefined();
      expect(first.result).toEqual([{ n: 1 }]);
      expect(sent).toHaveLength(1);
      const firstTables = hostValueOf(tables.get());
      expect(sent[0].tables).toEqual(firstTables);

      const labels = () =>
        cfcConfidentialityForObservationNode({
          labelView: cfcLabelViewForCell(result.key("result").key(0)),
          logicalPath: ["n"],
        });
      expect(labels()).toEqual(["body-secret", "other-secret"]);

      await runtime.editWithRetry((tx) => {
        column.withTx(tx).key("ifc").key("confidentiality").set([
          "body-secret",
          "updated-secret",
        ]);
      });
      await runtime.idle();
      await runtime.settled();
      const second = hostValueOf(result.get()) as unknown as QueryState;
      expect(second.error).toBeUndefined();
      expect(second.result).toEqual(first.result);
      expect(second.requestHash).not.toBe(first.requestHash);
      expect(sent).toHaveLength(2);
      expect(sent[1].tables).toEqual(hostValueOf(tables.get()));
      expect(labels()).toContain("updated-secret");
      expect(labels()).toContain("other-secret");

      await runtime.editWithRetry((tx) => {
        tables.withTx(tx).key("other").key("properties").key("added").set({
          type: "string",
          sqlType: "text",
          ifc: { confidentiality: ["added-secret"] },
        });
      });
      await runtime.idle();
      await runtime.settled();
      const third = hostValueOf(result.get()) as unknown as QueryState;
      expect(third.error).toBeUndefined();
      expect(third.result).toEqual(first.result);
      expect(third.requestHash).not.toBe(second.requestHash);
      expect(sent).toHaveLength(3);
      expect(sent[2].tables).toEqual(hostValueOf(tables.get()));
      expect(labels()).toContain("added-secret");
      // Earlier requests own their snapshots after the source changes.
      expect(sent[0].tables).toEqual(firstTables);
    } finally {
      cancel();
    }
  });

  it("consumes labels on nested fields of linked schema declarations", async () => {
    const setup = runtime.edit();
    const column = runtime.getCell(space, "labeled-column", {
      type: "object",
      properties: {
        type: { type: "string" },
        sqlType: {
          type: "string",
          ifc: { confidentiality: ["schema-secret"] },
        },
      },
    }, setup);
    column.set({ type: "string", sqlType: "text" });
    const parent = runtime.getCell(space, "parent", undefined, setup);
    parent.set({});
    const inputs = runtime.getCell(space, "labeled-inputs", undefined, setup);
    inputs.setRawUntyped(fabricFromConvertibleJsValue({
      db: {
        id: "of:consumption-only",
        tables: { notes: { properties: { body: column.getAsLink() } } },
      },
      sql: "SELECT body FROM notes",
    }));
    runtime.prepareTxForCommit(setup);
    expect((await setup.commit().settled).error).toBeUndefined();

    const cancels: (() => void)[] = [];
    const builtin = sqliteQuery(
      inputs,
      () => {},
      (cancel) => cancels.push(cancel),
      [parent],
      parent,
      runtime,
    );
    const tx = runtime.edit();
    tx.markLazyMaterialize();
    try {
      builtin.action(tx);
      expect(collectConsumedLabel(tx).confidentiality).toContain(
        "schema-secret",
      );
    } finally {
      for (const cancel of cancels) cancel();
      tx.abort();
    }
  });
});
