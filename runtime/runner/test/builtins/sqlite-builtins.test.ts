/// <reference path="../clock.d.ts" />

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { defer } from "@commonfabric/async/defer";
import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { constant, whenMatches } from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import type {
  SqliteDbRef,
  SqliteParamsWire,
  SqliteQueryResult,
} from "@commonfabric/memory/v2";

import { sqliteDatabase } from "../../src/builtins/sqlite-builtins.ts";
import { SQLITE_ROW_SALT } from "../../src/builtins/sqlite/row-identity.ts";
import { type Cell, hostValueOf } from "../../src/cell.ts";
import { Runtime, type RuntimeOptions } from "../../src/runtime.ts";
import {
  MAX_ENFORCEMENT_CFC_OPTIONS,
  MAX_ENFORCEMENT_SINK_CEILINGS,
} from "../../src/runtime-presets.ts";
import { runtimeSecretId } from "../../src/runtime-secret.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../../src/storage/commit-receipt.ts";
import type { CommitError, Result, Unit } from "../../src/storage/interface.ts";
import { getTransactionWriteAttempts } from "../../src/storage/transaction-inspection.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

type QueryState = {
  pending?: boolean;
  error?: unknown;
  result?: Array<Record<string, unknown>>;
};

const PROMPT_INFLUENCE = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

const notes = table({ id: "integer primary key", body: "text" });

describe({
  name: "sqlite-builtins",
  // The server loads the column-metadata library for a db that declares
  // `ifc`, and keeps it for the life of the process.
  sanitizeResources: false,
}, () => {
  let signer: Identity;
  let space: `did:${string}:${string}`;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const start = (options: Partial<RuntimeOptions> = {}) => {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...options,
    });
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`builtins-${crypto.randomUUID()}`);
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  describe("sqliteDatabase()", () => {
    // Each derivation is a fresh builtin instance over the same parent and
    // cause, as a second runtime opening the piece would be, so every one
    // after the first finds the handle the first committed.

    let parent: Cell<unknown>;

    beforeEach(async () => {
      start();
      const setup = runtime.edit();
      parent = runtime.getCell(space, "parent", undefined, setup);
      parent.set({});
      expect((await setup.commit().settled).error).toBeUndefined();
    });

    const derive = async (
      options: { tables?: Record<string, unknown> },
    ): Promise<SqliteDbRef> => {
      const setup = runtime.edit();
      const inputs = runtime.getCell(
        space,
        `inputs-${crypto.randomUUID()}`,
        undefined,
        setup,
      );
      inputs.setRawUntyped(fabricFromConvertibleJsValue(options));
      expect((await setup.commit().settled).error).toBeUndefined();
      let handle: Cell<SqliteDbRef> | undefined;
      const builtin = sqliteDatabase(
        inputs,
        (_tx, result) => handle = result,
        () => {},
        [parent],
        parent,
        runtime,
      );
      const tx = runtime.edit();
      builtin.action(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      return hostValueOf(handle!.get()) as SqliteDbRef;
    };

    it("keeps the handle of a db that declares no tables", async () => {
      const first = await derive({});
      expect(first.tables).toBeUndefined();
      expect(await derive({})).toEqual(first);
    });

    it("keeps the prior handle over a re-derivation holding an unresolved table", async () => {
      const first = await derive({ tables: { notes } });
      expect(await derive({ tables: { notes, other: null } })).toEqual(first);
      expect((await derive({ tables: { notes, other: notes } })).tables)
        .toEqual({ notes, other: notes });
    });

    it("keeps the prior handle over a re-derivation whose row rule does not validate", async () => {
      const ruled = table(
        { id: "integer primary key", tag: "text" },
        (f) => ({
          confidentiality: whenMatches(f.tag, /^x$/, constant("did:tag:x")),
        }),
      );
      const first = await derive({ tables: { ruled } });
      expect(first.tables).toEqual({ ruled });
      // A rule whose term list resolved to `null`, as a runtime that has not
      // loaded the documents the list was split into reads it.
      const unresolved = {
        ...ruled,
        rowLabel: { version: 1, confidentiality: null },
      };
      expect(await derive({ tables: { ruled: unresolved } })).toEqual(first);
    });
  });

  describe("sqliteQuery()", () => {
    const seed = async (
      db: SqliteDbRef,
      sql: string,
      params?: SqliteParamsWire,
    ) => {
      const tx = runtime.edit();
      tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    // The result is session-scoped, as a query under a runtime read ceiling
    // must declare it.
    const query = async (
      db: SqliteDbRef,
      inputs: Record<string, unknown>,
    ): Promise<QueryState> => {
      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const p = cf.pattern(() =>
        cf.sqliteQuery.asScope("session")(
          // deno-lint-ignore no-explicit-any
          { db, reactOn: db, ...inputs } as any,
        )
      );
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        `query-${crypto.randomUUID()}`,
        p.resultSchema,
        tx,
      );
      const result = runtime.run(tx, p, {}, resultCell);
      await tx.commit().settled;
      return await waitForCellValue<QueryState>(
        runtime,
        result,
        (v) => v?.pending === false,
      );
    };

    const newDb = (fields: Partial<SqliteDbRef> = {}): SqliteDbRef => ({
      id: `of:builtins-${crypto.randomUUID()}`,
      tables: { notes },
      ...fields,
    });

    it("returns an error when the storage provider cannot run queries", async () => {
      start();
      const db = newDb();
      await seed(db, "INSERT INTO notes (body) VALUES (?)", ["hello"]);
      expect((await query(db, { sql: "SELECT body FROM notes" })).result)
        .toEqual([{ body: "hello" }]);
      storageManager.open(space).sqliteQuery = undefined;
      const state = await query(db, { sql: "SELECT id, body FROM notes" });
      expect(state.error).toMatch(/sqliteQuery unavailable/);
      expect(state.result).toBeUndefined();
    });

    it("returns an error for two labeled columns projected to one output name", async () => {
      start();
      const db = newDb({
        tables: {
          notes: {
            type: "object",
            properties: {
              id: { type: "integer", sqlType: "integer primary key" },
              body: {
                type: "string",
                sqlType: "text",
                ifc: { confidentiality: ["body-secret"] },
              },
            },
          },
        },
      });
      await seed(db, "INSERT INTO notes (body) VALUES (?)", ["hello"]);
      const state = await query(db, {
        sql: "SELECT a.body, b.body FROM notes a JOIN notes b",
      });
      expect(state.error).toMatch(/same output name \("body"\)/);
      expect(
        (await query(db, {
          sql: "SELECT a.body, b.body AS other FROM notes a JOIN notes b",
        })).error,
      ).toBeUndefined();
    });

    it("returns an error for a ceiling declared on both the row schema and the query", async () => {
      start();
      const db = newDb({ owner: signer.did() });
      const rowSchema = {
        type: "object",
        properties: { body: { type: "string" } },
        ifc: { maxConfidentiality: [signer.did()] },
      };
      const state = await query(db, {
        sql: "SELECT body FROM notes",
        rowSchema,
        maxConfidentiality: [signer.did()],
      });
      expect(state.error).toMatch(/declare the output ceiling once/);
      expect(
        (await query(db, { sql: "SELECT body FROM notes", rowSchema })).error,
      ).toBeUndefined();
    });

    it("returns an error for a query ceiling naming the owner of a db that has none", async () => {
      start();
      const ceiling = { maxConfidentiality: [{ __ctDbOwner: true }] };
      const sql = "SELECT body FROM notes";
      expect((await query(newDb(), { sql, ...ceiling })).error).toMatch(
        /ceiling references the db owner but the db ref carries no owner/,
      );
      expect(
        (await query(newDb({ owner: signer.did() }), { sql, ...ceiling }))
          .error,
      ).toBeUndefined();
    });

    it("returns an error under a runtime ceiling naming the owner of a db that has none", async () => {
      start({
        cfcReadMaxConfidentiality: [{ __ctDbOwner: true }],
        cfcReadOnExceed: "skip",
      });
      const sql = "SELECT body FROM notes";
      expect((await query(newDb(), { sql })).error).toMatch(
        /ceiling references the db owner but the db ref carries no owner/,
      );
      expect((await query(newDb({ owner: signer.did() }), { sql })).error)
        .toBeUndefined();
    });

    it("returns the refusal of the commit that writes the rows back as the query's error", async () => {
      // The writeback is the one transaction that mints the space's row
      // salt, which nothing here has minted yet, so naming the salt's
      // document refuses that commit and nothing else.
      start();
      const db = newDb();
      await seed(db, "INSERT INTO notes (body) VALUES (?)", ["hello"]);
      const salt = runtimeSecretId(SQLITE_ROW_SALT);
      const refusal: CommitError = {
        name: "AuthorizationError",
        message: "the space refused the write",
      };
      const edit = runtime.edit.bind(runtime);
      let refused = 0;
      runtime.edit = (...args) => {
        const opened = edit(...args);
        const commit = opened.commit.bind(opened);
        opened.commit = (options) => {
          const written = getTransactionWriteAttempts(opened) ?? [];
          if (refused === 0 && written.some(({ id }) => id === salt)) {
            refused++;
            opened.abort(refusal);
            return createTransactionCommitReceipt(
              Promise.resolve<Result<Unit, CommitError>>({ error: refusal }),
            );
          }
          return commit(options);
        };
        return opened;
      };
      let state: QueryState;
      try {
        state = await query(db, { sql: "SELECT body FROM notes" });
      } finally {
        runtime.edit = edit;
      }
      expect(refused).toBe(1);
      expect(state.error).toBe(refusal.message);
      expect(state.result).toBeUndefined();
    });

    it("leaves a running query's claim alone when the next query is refused", async () => {
      // The next query's statement carries a caveat the `sqliteQuery` sink's
      // ceiling does not admit, so its request is refused before it starts,
      // while the first is held at the provider with its claim standing —
      // the pending flag up under its own request hash.
      start({
        ...MAX_ENFORCEMENT_CFC_OPTIONS,
        cfcEnforcementMode: "enforce-strict",
        cfcSinkMaxConfidentiality: {
          ...MAX_ENFORCEMENT_SINK_CEILINGS,
          sqliteQuery: [],
        },
      });
      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const db = newDb();
      const issued = defer<void>();
      const held = defer<void>();
      const provider = storageManager.open(space);
      const sqliteQuery = provider.sqliteQuery!.bind(provider);
      provider.sqliteQuery = async (...args): Promise<SqliteQueryResult> => {
        issued.resolve();
        await held.promise;
        return await sqliteQuery(...args);
      };

      const tx = runtime.edit();
      const hostileSql = runtime.getCell<string>(space, "hostile-sql", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      }, tx);
      hostileSql.set("SELECT body FROM notes");
      const inputs = runtime.getCell<{ sql: string }>(
        space,
        "inputs",
        undefined,
        tx,
      );
      inputs.set({ sql: "SELECT id FROM notes" });
      const p = cf.pattern<{ sql: string }>(({ sql }) =>
        // deno-lint-ignore no-explicit-any
        cf.sqliteQuery({ db, sql, reactOn: db } as any)
      );
      const result = runtime.run(
        tx,
        p,
        inputs,
        runtime.getCell(space, "result", undefined, tx),
      );
      runtime.prepareTxForCommit(tx);
      await tx.commit().settled;
      result.sink(() => {});
      await issued.promise;
      await waitForCellValue<{ pending?: boolean }>(
        runtime,
        result,
        (value) => value?.pending === true,
      );
      const claimed = result.withTx().key("requestHash").get();

      const refused = defer<void>();
      runtime.scheduler.onError((error: Error) => {
        if (error.message.includes("CFC enforcement rejected commit")) {
          refused.resolve();
        }
      });
      await runtime.editWithRetry((edit) => {
        // deno-lint-ignore no-explicit-any
        inputs.withTx(edit).key("sql").set(hostileSql as any);
      });
      await result.pull();
      await clock.settle();
      await refused.promise;
      await runtime.idle();

      expect(result.withTx().key("pending").get()).toBe(true);
      expect(result.withTx().key("requestHash").get()).toBe(claimed);
      expect(result.withTx().key("error").get()).toBeUndefined();

      held.resolve();
      await runtime.settled();
    });

    it("leaves a link column raw where its value is no link and absent where the query leaves it out", async () => {
      // A row schema can mark a column `asCell` that the statement does not
      // project, and can name a column's schema by a `$ref` to a definition
      // it does not carry; neither is a link to decode.
      start();
      const db = newDb({
        tables: {
          people: table({
            id: "integer primary key",
            ref_cf_link: "text",
            note: "text",
          }),
        },
      });
      await seed(
        db,
        "INSERT INTO people (ref_cf_link, note) VALUES (?, ?)",
        ["not a link", "kept"],
      );
      const rowSchema = {
        type: "object",
        properties: {
          ref_cf_link: { asCell: ["cell"], type: "object" },
          note: { $ref: "#/$defs/Missing" },
          extra: true,
        },
      };
      const sql = "SELECT ref_cf_link, note FROM people";
      const projected = await query(db, { sql, rowSchema });
      expect(projected.error).toBeUndefined();
      expect(projected.result?.map((row) => ({ ...row }))).toEqual([
        { ref_cf_link: "not a link", note: "kept" },
      ]);
      const omitted = await query(db, {
        sql: "SELECT note FROM people",
        rowSchema,
      });
      expect(omitted.error).toBeUndefined();
      expect(omitted.result?.map((row) => ({ ...row }))).toEqual([
        { note: "kept" },
      ]);
    });
  });
});
