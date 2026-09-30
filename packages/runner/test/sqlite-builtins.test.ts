// Phase 0 wiring smoke test: the SQLite builtins are registered and reachable
// end to end through the builder -> module registry -> result cells. Server-side
// execution is not wired yet, so query/execute resolve to a structured
// not-implemented error (asserted here so the wiring — not fabricated results —
// is what's tested).

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { createBuilder } from "../src/builder/factory.ts";
import { createCell } from "../src/cell.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("sqlite builtins (Phase 0 wiring)", () => {
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
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("table()/cfLink() are exposed and produce schemas", () => {
    const t = cf.table({
      id: "integer primary key",
      author_cf_link: cf.cfLink(),
    });
    expect((t as { type: string }).type).toBe("object");
    expect(cf.cfLink()).toEqual({
      type: "string",
      cfLink: true,
      sqlType: "text",
    });
  });

  it("reads through the query builtin (full builder->server->engine path)", async () => {
    // Deterministic single-effect read: a fresh db's declared table is created
    // server-side (ensureTables) and the query returns an empty result. Writes
    // are the imperative SqliteDb.exec (folded into the caller's commit; see
    // sqlite-db-exec.test.ts / sqlite-commit-fold.test.ts); read-after-write
    // reactivity within a pattern is intentionally not auto-driven.
    const queryPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      return cf.sqliteQuery({ db, sql: "SELECT body FROM notes", reactOn: db });
    });
    const resultCell = runtime.getCell(
      space,
      "sqlite-query-real",
      queryPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, queryPattern, {}, resultCell);
    tx.commit();

    const q = await waitForCellValue<QueryState>(
      runtime,
      result,
      (v) => v?.pending === false,
    );
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([]);
  });

  it("settled() waits for an in-flight reactive query flush (no stale read)", async () => {
    // Regression for the lunch-poll CI flake (assertions read a sqlite query
    // result before it settled under load). A reactive `sqliteQuery` issues its
    // server read from a POST-COMMIT outbox flush (an async RPC + result
    // writeback). `idle()` deliberately returns before that I/O, so a reader
    // must use `runtime.settled()` — which waits for the in-flight async builtin
    // work — to observe a settled result rather than `{ pending: true }`.
    //
    // We make the server read unmistakably slow so the flush is guaranteed
    // in-flight. `idle()` alone resolves against the half-settled
    // `{ pending: true }` state; `settled()` stays open until the flush writes
    // the result back.
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = async (...a) => {
      await new Promise((r) => setTimeout(r, 50));
      return await original(...a);
    };
    try {
      const queryPattern = cf.pattern(() => {
        const db = cf.sqliteDatabase({
          tables: {
            notes: cf.table({ id: "integer primary key", body: "text" }),
          },
        });
        return cf.sqliteQuery({
          db,
          sql: "SELECT body FROM notes",
          reactOn: db,
        });
      });
      const resultCell = runtime.getCell(
        space,
        "sqlite-settled",
        queryPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, queryPattern, {}, resultCell);
      await tx.commit();

      // Observe the result so the effect runs in pull mode. `idle()` returns
      // before the latency-bounded flush completes (still pending); `settled()`
      // waits for it.
      const view = result as unknown as {
        get: () => QueryState;
        sink: (f: () => void) => () => void;
      };
      const cancel = view.sink(() => {});
      try {
        await runtime.idle();
        expect(view.get().pending).toBe(true);

        // The slow server read is a frozen test-side timer. Begin the settled()
        // wait, fire the read, and confirm settled() stayed open until the flush
        // wrote the result back.
        const settledPromise = runtime.settled();
        await clock.tick(50);
        await settledPromise;
        const v = view.get();
        expect(v.pending).toBe(false);
        expect(v.error).toBeUndefined();
        expect(v.result).toEqual([]);
      } finally {
        cancel();
      }
    } finally {
      provider.sqliteQuery = original;
    }
  });

  // The db's on-disk file is the server's job; what the *runner* must get right
  // is forwarding the author-declared scope to the wire. `.asScope("user")` is
  // what the transformer lowers `const db: PerUser<SqliteDb> = sqliteDatabase()`
  // into; it sets the node default scope, which the runner folds into the output
  // binding and the builtin stamps onto the SqliteDbRef. We spy on the storage
  // provider to capture the ref `db.query` actually sends.
  async function capturedQueryScope(
    // deno-lint-ignore no-explicit-any
    makeDb: () => any,
    label: string,
  ): Promise<unknown> {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (db: { scope?: unknown }, ...rest: unknown[]) => unknown;
    };
    const original = provider.sqliteQuery.bind(provider);
    let seenScope: unknown = "<<unset>>";
    const issued = defer<void>();
    provider.sqliteQuery = (db, ...rest) => {
      seenScope = db?.scope;
      issued.resolve();
      return original(db, ...rest);
    };
    try {
      const queryPattern = cf.pattern(() => {
        const db = makeDb();
        return cf.sqliteQuery({
          db,
          sql: "SELECT body FROM notes",
          reactOn: db,
        });
      });
      const resultCell = runtime.getCell(
        space,
        label,
        queryPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, queryPattern, {}, resultCell);
      tx.commit();
      // The query is a computation, so a reader has to demand it; the wire
      // call is the event here, not a result value: the spy above resolves
      // `issued` when `db.query` reaches the provider.
      const cancel = (result as unknown as {
        sink: (f: () => void) => () => void;
      }).sink(() => {});
      try {
        await issued.promise;
      } finally {
        cancel();
      }
      return seenScope;
    } finally {
      provider.sqliteQuery = original;
    }
  }

  const tables = () => ({
    tables: { notes: cf.table({ id: "integer primary key", body: "text" }) },
  });

  it("forwards a user-scoped db (.asScope) to the query wire", async () => {
    expect(
      await capturedQueryScope(
        () => cf.sqliteDatabase.asScope("user")(tables()),
        "sqlite-scope-user",
      ),
    ).toBe("user");
  });

  it("forwards space scope for an unscoped db", async () => {
    expect(
      await capturedQueryScope(
        () => cf.sqliteDatabase(tables()),
        "sqlite-scope-default",
      ),
    ).toBe("space");
  });

  // Drive a query to its terminal state through `settled()` and read the result
  // cell — the event-driven wait, with no sleep or polling loop. `settled()`
  // stays open until the post-commit flush writes the result (or error) back, so
  // the write-back handlers run every time rather than depending on whether the
  // async flush lands inside the observation window.
  async function runQueryToSettled(sql: string, label: string) {
    const queryPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      return cf.sqliteQuery({ db, sql, reactOn: db });
    });
    const resultCell = runtime.getCell(
      space,
      label,
      queryPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, queryPattern, {}, resultCell);
    await tx.commit();

    const view = result as unknown as {
      get: () => QueryState;
      sink: (f: () => void) => () => void;
    };
    const cancel = view.sink(() => {});
    try {
      await runtime.idle();
      await runtime.settled();
      return view.get();
    } finally {
      cancel();
    }
  }

  it("writes a successful query result back through the post-commit flush", async () => {
    const q = await runQueryToSettled(
      "SELECT body FROM notes",
      "sqlite-success-writeback",
    );
    expect(q.pending).toBe(false);
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([]);
  });

  it("writes reserved SQLite aliases back in a Fabric-safe row form", async () => {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = () =>
      Promise.resolve({
        rows: [Object.fromEntries([
          ["constructor", 1],
          ["__proto__", 2],
        ])],
      });
    try {
      const q = await runQueryToSettled(
        'SELECT 1 AS "constructor", 2 AS "__proto__"',
        "sqlite-reserved-alias-writeback",
      );
      expect(q.pending).toBe(false);
      expect(q.error).toBeUndefined();
      expect(q.result).toEqual([[
        ["constructor", 1],
        ["__proto__", 2],
      ]]);
    } finally {
      provider.sqliteQuery = original;
    }
  });

  it("attaches row labels to reserved SQLite alias rows", async () => {
    const rowCount = 2;
    const schemaWritesByAttempt: Map<string, number>[] = [];
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    (runtime as any).editWithRetry = (fn: any, ...args: any[]) =>
      originalEditWithRetry((writeTx) => {
        const value = fn(writeTx);
        const schemaWritesByTarget = new Map<string, number>();
        const prepared = (writeTx as any).accessForTestingOnly
          .buildPreparedDigestInput();
        for (const input of prepared.writePolicyInputs ?? []) {
          if (input.kind !== "schema" || input.target?.path?.length !== 0) {
            continue;
          }
          const id = String(input.target.id);
          schemaWritesByTarget.set(id, (schemaWritesByTarget.get(id) ?? 0) + 1);
        }
        schemaWritesByAttempt.push(schemaWritesByTarget);
        return value;
      }, ...args);
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = () =>
      Promise.resolve({
        rows: Array.from(
          { length: rowCount },
          (_, i) => Object.fromEntries([["constructor", i + 1]]),
        ),
        columns: [{ output: "constructor", table: "items", column: "id" }],
      });
    try {
      const queryPattern = cf.pattern(() => {
        const { table, constant } = cf.cfSqlite;
        const db = cf.sqliteDatabase({
          tables: {
            items: table(
              {
                id: {
                  type: "integer",
                  ifc: { confidentiality: ["column-secret"] },
                },
              },
              () => ({ confidentiality: constant("secret") }),
            ),
          },
        });
        return cf.sqliteQuery({
          db,
          sql: 'SELECT id AS "constructor" FROM items',
          reactOn: db,
        });
      });
      const resultCell = runtime.getCell(
        space,
        "sqlite-reserved-alias-row-label",
        queryPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, queryPattern, {}, resultCell);
      await tx.commit();

      const view = result as unknown as {
        get: () => QueryState;
        sink: (f: () => void) => () => void;
      };
      const cancel = view.sink(() => {});
      try {
        await runtime.idle();
        await runtime.settled();
        expect(view.get().pending).toBe(false);
        expect(view.get().error).toBeUndefined();
        expect(view.get().result).toEqual(Array.from(
          { length: rowCount },
          (_, i) => [["constructor", i + 1]],
        ));
        for (let i = 0; i < rowCount; i++) {
          const rowCell = result.key("result").key(i).resolveAsCell();
          const rowLabel = cfcLabelViewForCell(rowCell);
          expect(cfcConfidentialityForObservationNode({
            labelView: rowLabel,
            logicalPath: [],
          })).toContainEqual("secret");
          expect(cfcConfidentialityForObservationNode({
            labelView: rowLabel,
            logicalPath: ["0", "1"],
          })).toEqual(expect.arrayContaining(["secret", "column-secret"]));
          const rowId = rowCell.getAsNormalizedFullLink().id;
          const rowAttempts = schemaWritesByAttempt
            .map((attempt) => attempt.get(rowId))
            .filter((count): count is number => count !== undefined);
          expect(rowAttempts.length).toBeGreaterThan(0);
          expect(rowAttempts.every((count) => count === 1)).toBe(true);
        }
      } finally {
        cancel();
      }
    } finally {
      provider.sqliteQuery = original;
    }
  });

  it("writes an error result when the sqlite read fails, rather than staying pending", async () => {
    // Force the server read to fail. The builtin must surface that as a settled
    // error result on the query cell, not leave the query pending forever.
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = () =>
      Promise.reject(new Error("sqlite backend unavailable"));
    try {
      const q = await runQueryToSettled(
        "SELECT body FROM notes",
        "sqlite-error-writeback",
      );
      expect(q.pending).toBe(false);
      expect(q.error).toBeDefined();
      expect(q.result).toBeUndefined();
    } finally {
      provider.sqliteQuery = original;
    }
  });

  // Issue a query and hold its server read in flight on `gate` (a Promise the
  // test resolves by hand — no sleep or timer). While it is held, a write bumps
  // the db revision, so the query re-issues with a new request hash: a genuine
  // supersede. When the held read finally finishes, its flush must notice the
  // hash changed and leave the newer query's state alone.
  async function runStaleFlush(
    outcome: "resolve" | "reject",
    label: string,
  ): Promise<{ q: QueryState; secondHash: string }> {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.sqliteQuery = async (...a) => {
      await gate;
      if (outcome === "reject") throw new Error("sqlite read failed late");
      return await original(...a);
    };
    try {
      const pattern = cf.pattern(() => {
        const db = cf.sqliteDatabase({
          tables: {
            notes: cf.table({ id: "integer primary key", body: "text" }),
          },
        });
        const q = cf.sqliteQuery({
          db,
          sql: "SELECT body FROM notes",
          reactOn: db,
        });
        return { db, q };
      });
      const resultCell = runtime.getCell(space, label, undefined, tx);
      runtime.run(tx, pattern, {}, resultCell);
      await tx.commit();

      const qCell = resultCell.key("q").resolveAsCell() as unknown as {
        get: () => QueryState;
        sink: (f: () => void) => () => void;
      };
      const cancel = qCell.sink(() => {});
      try {
        // The first query is issued; its server read now waits on the gate.
        await runtime.idle();
        const firstHash = qCell.get().requestHash;
        expect(typeof firstHash).toBe("string");
        expect(qCell.get().pending).toBe(true);

        // A write bumps the db revision, re-issuing the query with a new hash
        // while the first read is still held.
        const execTx = runtime.edit();
        const handleLink = resultCell.key("db").resolveAsCell()
          .getAsNormalizedFullLink();
        const db = createCell(
          runtime,
          { ...handleLink, schema: undefined },
          execTx,
          false,
          "sqlite",
        ) as unknown as {
          exec(sql: string, params?: readonly unknown[]): void;
        };
        db.exec("INSERT INTO notes (body) VALUES (?)", ["seed"]);
        expect((await execTx.commit()).error).toBeUndefined();
        await runtime.idle();
        const secondHash = qCell.get().requestHash;
        expect(secondHash).not.toBe(firstHash);
        expect(typeof secondHash).toBe("string");

        // Release both reads. The first (now stale) flush must find the hash
        // changed and skip its write-back.
        release();
        await runtime.settled();
        return { q: qCell.get(), secondHash: secondHash! };
      } finally {
        cancel();
      }
    } finally {
      provider.sqliteQuery = original;
    }
  }

  it("issues a new query when `reactOn` goes from a hole to an element holding `undefined`", async () => {
    const tick = runtime.getCell<unknown[]>(
      space,
      "sqlite-hole-tick",
      undefined,
      tx,
    );
    tick.setRawUntyped(new Array(1));
    const pattern = cf.pattern<{ tick: unknown[] }>(({ tick }) => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      return cf.sqliteQuery({
        db,
        sql: "SELECT body FROM notes",
        reactOn: tick,
      });
    });
    const result = runtime.run(
      tx,
      pattern,
      { tick },
      runtime.getCell(space, "sqlite-hole-result", pattern.resultSchema, tx),
    );
    expect((await tx.commit()).error).toBeUndefined();
    const cancel = result.key("pending").sink(() => {});
    try {
      await runtime.settled();
      const first = result.key("requestHash").get();
      expect(typeof first).toBe("string");

      const next = runtime.edit();
      tick.withTx(next).setRawUntyped([undefined]);
      expect((await next.commit()).error).toBeUndefined();
      await runtime.settled();
      expect(result.key("requestHash").get()).not.toBe(first);
    } finally {
      cancel();
    }
  });

  it("a superseded query's successful flush does not overwrite the newer request", async () => {
    const { q, secondHash } = await runStaleFlush("resolve", "sqlite-stale-ok");
    // Only the newer query settled its own result; the stale flush was skipped.
    expect(q.requestHash).toBe(secondHash);
    expect(q.pending).toBe(false);
    expect(q.error).toBeUndefined();
  });

  it("a superseded query's failed flush does not overwrite the newer request", async () => {
    const { q, secondHash } = await runStaleFlush("reject", "sqlite-stale-err");
    // Both reads reject, but only the newer query's error survives — the stale
    // flush's error write is skipped.
    expect(q.requestHash).toBe(secondHash);
    expect(q.pending).toBe(false);
    expect(q.error).toBeDefined();
  });
});

type QueryState = {
  pending: boolean;
  result?: unknown[];
  error?: unknown;
  requestHash?: string;
};
