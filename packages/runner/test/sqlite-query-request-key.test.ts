import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("sqlite request correlation");
const space = signer.did();

describe("sqlite query request keys", () => {
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

  it("forwards optional keys through a compiled handle query without replacing unchanged rows", async () => {
    const pattern = await runtime.patternManager.compilePattern(`
      import { pattern, type SqliteDb } from "commonfabric";
      export default pattern<{ db: SqliteDb; requestKey?: string }>(({ db, requestKey }) => {
        return db.query<{ id: number }>("SELECT id FROM notes ORDER BY id", { requestKey });
      });
    `);
    const db: SqliteDbRef = {
      id: `of:compiled-key-notes-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key" }) },
    };
    const seed = runtime.edit();
    seed.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO notes (id) VALUES (1)",
    });
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    const handle = runtime.getCell<SqliteDbRef>(
      space,
      "compiled-handle",
      undefined,
      tx,
    );
    handle.set(db);
    const key = runtime.getCell<string | undefined>(
      space,
      "compiled-key",
      undefined,
      tx,
    );
    key.set("A");
    const result = runtime.run(
      tx,
      pattern,
      { db: handle, requestKey: key },
      runtime.getCell(space, "compiled-query", pattern.resultSchema, tx),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = result.sink(() => {});
    try {
      await runtime.settled();
      expect(result.key("requestKey").get()).toBe("A");
      expect(result.key("result").get()).toEqual([{ id: 1 }]);
      const rows = result.key("result").getRaw();
      expect(Array.isArray(rows)).toBe(true);
      let previousHash = result.key("requestHash").get();
      for (const value of ["B", undefined, "A"]) {
        const edit = runtime.edit();
        key.withTx(edit).set(value);
        expect((await edit.commit().settled).error).toBeUndefined();
        await runtime.settled();
        expect(result.key("pending").get()).toBe(false);
        expect(result.key("error").get()).toBeUndefined();
        expect(result.key("requestKey").get()).toBe(value);
        expect(result.key("requestHash").get()).not.toBe(previousHash);
        expect(result.key("result").get()).toEqual([{ id: 1 }]);
        expect(result.key("result").getRaw()).toEqual(rows);
        previousHash = result.key("requestHash").get();
      }
    } finally {
      cancel();
    }
  });

  it("returns the request key with pending and empty results", async () => {
    const provider = storageManager.open(space);
    const original = provider.sqliteQuery?.bind(provider);
    if (!original) throw new Error("SQLite query provider is required");
    const entered = defer();
    const release = defer();
    provider.sqliteQuery = async (...args) => {
      entered.resolve();
      await release.promise;
      return await original(...args);
    };
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const pattern = cf.pattern<{ requestKey: string }>(({ requestKey }) => {
      const db = cf.sqliteDatabase({
        tables: { notes: cf.table({ id: "integer primary key" }) },
      });
      return cf.sqliteQuery({
        db,
        sql: "SELECT id FROM notes",
        requestKey,
      });
    });
    const tx = runtime.edit();
    const key = runtime.getCell<string>(space, "labeled-request-key", {
      type: "string",
      ifc: { confidentiality: ["request-secret"] },
    }, tx);
    key.set("empty search");
    const result = runtime.run(
      tx,
      pattern,
      { requestKey: key },
      runtime.getCell(space, "empty", pattern.resultSchema, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = result.key("pending").sink(() => {});
    try {
      await entered.promise;
      expect(result.key("pending").get()).toBe(true);
      expect(result.key("requestKey").get()).toBe("empty search");
      expect(cfcConfidentialityForObservationNode({
        labelView: cfcLabelViewForCell(
          result.key("requestKey").resolveAsCell(),
        ),
        logicalPath: [],
      })).toContainEqual("request-secret");
      release.resolve();
      await runtime.settled();
      expect(result.key("pending").get()).toBe(false);
      expect(result.key("requestKey").get()).toBe("empty search");
      expect(result.key("result").get()).toEqual([]);
      expect(cfcConfidentialityForObservationNode({
        labelView: cfcLabelViewForCell(
          result.key("requestKey").resolveAsCell(),
        ),
        logicalPath: [],
      })).toContainEqual("request-secret");
    } finally {
      release.resolve();
      await runtime.settled();
      cancel();
      provider.sqliteQuery = original;
    }
  });

  it("preserves the request key's confidentiality label after a provider error", async () => {
    const provider = storageManager.open(space);
    const original = provider.sqliteQuery;
    provider.sqliteQuery = () => Promise.reject(new Error("query refused"));
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const pattern = cf.pattern<{ requestKey: string }>(({ requestKey }) => {
      const db = cf.sqliteDatabase({
        tables: { notes: cf.table({ id: "integer primary key" }) },
      });
      return cf.sqliteQuery({ db, sql: "SELECT id FROM notes", requestKey });
    });
    const tx = runtime.edit();
    const key = runtime.getCell<string>(space, "labeled-error-key", {
      type: "string",
      ifc: { confidentiality: ["request-secret"] },
    }, tx);
    key.set("failed search");
    const result = runtime.run(
      tx,
      pattern,
      { requestKey: key },
      runtime.getCell(space, "labeled-error", pattern.resultSchema, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = result.key("pending").sink(() => {});
    try {
      await runtime.settled();
      expect(result.key("pending").get()).toBe(false);
      expect(result.key("error").get()).toBe("query refused");
      expect(result.key("result").get()).toBeUndefined();
      expect(result.key("requestKey").get()).toBe("failed search");
      expect(cfcConfidentialityForObservationNode({
        labelView: cfcLabelViewForCell(
          result.key("requestKey").resolveAsCell(),
        ),
        logicalPath: [],
      })).toContainEqual("request-secret");
    } finally {
      cancel();
      provider.sqliteQuery = original;
    }
  });

  for (const outcome of ["success", "error"] as const) {
    it(`keeps the current request key when a superseded query finishes with ${outcome}`, async () => {
      const provider = storageManager.open(space);
      const original = provider.sqliteQuery?.bind(provider);
      if (!original) throw new Error("SQLite query provider is required");
      const entered = defer();
      const release = defer();
      let calls = 0;
      provider.sqliteQuery = async (...args) => {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
          if (outcome === "error") throw new Error("superseded query failed");
        }
        return await original(...args);
      };
      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const pattern = cf.pattern<{ requestKey: string }>(({ requestKey }) => {
        const db = cf.sqliteDatabase({
          tables: { notes: cf.table({ id: "integer primary key" }) },
        });
        return cf.sqliteQuery({
          db,
          sql: "SELECT id FROM notes",
          requestKey,
        });
      });
      const tx = runtime.edit();
      const key = runtime.getCell<string>(space, "request-key", undefined, tx);
      key.set("A");
      const result = runtime.run(
        tx,
        pattern,
        { requestKey: key },
        runtime.getCell(space, "superseded", pattern.resultSchema, tx),
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      const cancel = result.key("pending").sink(() => {});
      try {
        await entered.promise;
        const next = runtime.edit();
        key.withTx(next).set("B");
        expect((await next.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(result.key("requestKey").get()).toBe("B");
        await waitForCellValue(
          runtime,
          result.key("pending"),
          (v) => v === false,
        );
        expect(result.key("requestKey").get()).toBe("B");
        expect(calls).toBe(2);
        release.resolve();
        await runtime.settled();
        expect(result.key("requestKey").get()).toBe("B");
        expect(result.key("error").get()).toBeUndefined();
        expect(result.key("result").get()).toEqual([]);
      } finally {
        release.resolve();
        await runtime.settled();
        cancel();
        provider.sqliteQuery = original;
      }
    });
  }

  for (const failure of ["parameter", "provider"] as const) {
    it(`returns the request key for a ${failure} error`, async () => {
      if (failure === "provider") {
        storageManager.open(space).sqliteQuery = () =>
          Promise.reject(new Error("query refused"));
      }
      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const pattern = cf.pattern(() => {
        const db = cf.sqliteDatabase({
          tables: { notes: cf.table({ id: "integer primary key" }) },
        });
        return cf.sqliteQuery({
          db,
          sql: failure === "parameter"
            ? "SELECT id FROM notes WHERE id = ?"
            : "SELECT id FROM notes",
          params: failure === "parameter" ? [undefined] : [],
          requestKey: "failed search",
        });
      });
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        pattern,
        {},
        runtime.getCell(space, "refused", pattern.resultSchema, tx),
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await waitForCellValue(
        runtime,
        result.key("pending"),
        (v) => v === false,
      );
      expect(result.key("requestKey").get()).toBe("failed search");
      expect(result.key("error").get()).toBeDefined();
      expect(result.key("result").get()).toBeUndefined();
    });
  }
});
