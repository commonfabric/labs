/**
 * The runtime-wide read ceiling (`RuntimeOptions.cfcReadMaxConfidentiality`
 * and `cfcReadOnExceed`) applied by `sqliteQuery`. A query declaring no
 * ceiling reads under the runtime's; a query declaring its own reads under
 * the meet of the two, so a pattern can never widen past the runtime's. The
 * ceiling applies to a session-scoped result only, which is what keeps two
 * runtimes of different ceilings over one space from reading each other's
 * rows; a broader result is refused. Spec: docs/specs/sqlite-builtin/06-cfc.md
 * ("Runtime read ceiling").
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  all,
  any,
  dbOwner,
  match,
  principal,
} from "@commonfabric/memory/sqlite/row-label";
import { table } from "@commonfabric/memory/sqlite/schema";
import {
  serverExecutionEnablerCount,
  type SessionReadCeiling,
  type SqliteDbRef,
  type SqliteParamsWire,
} from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { effectiveReadCeiling } from "../src/builtins/sqlite-builtins.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import { meetCfcObservationCeilings } from "../src/cfc/observation.ts";
import { buildCfcReadCeiling } from "../src/cfc/read-ceiling.ts";
import { stampWaveRunContext, waveRunContextOf } from "../src/executor/wave.ts";
import {
  type ErrorWithContext,
  Runtime,
  type RuntimeOptions,
} from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type QueryState = {
  pending?: boolean;
  error?: unknown;
  requestHash?: string;
  result?: Array<Record<string, unknown>>;
  withheld?: number;
};

const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
// The atom the `principal("mailto", …)` rule mints for the addressed row.
const BOB = "did:mailto:bob@example.test";

// `emails`: every row's label carries the db owner, and a row addressed to
// someone also carries that address. Under a ceiling naming the owner alone
// the addressed row exceeds; under one naming the owner and the address it
// fits. `notes`: rule-less, and the table whose INSERT creates the db file.
const tables = {
  emails: table(
    { id: "integer primary key", to_addr: "text", body: "text" },
    (f) => ({
      confidentiality: all(
        dbOwner(),
        principal("mailto", match(f.to_addr, ADDR)),
      ),
    }),
  ),
  notes: table({ id: "integer primary key", body: "text" }),
};

// A db of its own for the aggregate cases: an aggregate's common reader is
// intersected over every rule-bearing table of the db it runs in, and the
// `all` rule above has none. Under this `any` rule the owner reads every row,
// so an aggregate over `shared` carries a label of its own (the owner) for a
// ceiling to admit or refuse.
const aggregateTables = {
  shared: table(
    { id: "integer primary key", to_addr: "text", body: "text" },
    (f) => ({
      confidentiality: any(
        dbOwner(),
        principal("mailto", match(f.to_addr, ADDR)),
      ),
    }),
  ),
  notes: table({ id: "integer primary key", body: "text" }),
};

const ROWS_SQL = "SELECT id, to_addr, body FROM emails ORDER BY id";

const settled = (v: QueryState | undefined): boolean => v?.pending === false;

const bodies = (state: QueryState): unknown[] =>
  (state.result ?? []).map((row) => row.body);

async function seed(
  runtime: Runtime,
  space: `did:${string}:${string}`,
  db: SqliteDbRef,
  sql: string,
  params?: SqliteParamsWire,
): Promise<void> {
  const tx = runtime.edit();
  tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
  const res = await tx.commit();
  if (res.error) throw res.error;
}

/** Seeds `notes` and the one rule-bearing table `db` declares. */
async function seedRows(
  runtime: Runtime,
  space: `did:${string}:${string}`,
  db: SqliteDbRef,
): Promise<void> {
  await seed(runtime, space, db, "INSERT INTO notes (body) VALUES (?)", [
    "seed",
  ]);
  const labeled = Object.keys(db.tables ?? {}).find((n) => n !== "notes")!;
  await seed(
    runtime,
    space,
    db,
    `INSERT INTO ${labeled} (to_addr, body) VALUES (?, ?), (?, ?)`,
    ["", "mine", "bob@example.test", "shared"],
  );
}

/**
 * Runs a query pattern whose result is session-scoped, as a query under a
 * runtime ceiling must declare, and returns its settled state.
 */
async function runQuery(
  runtime: Runtime,
  space: `did:${string}:${string}`,
  db: SqliteDbRef,
  query: Record<string, unknown>,
  cause = `read-ceiling-${crypto.randomUUID()}`,
): Promise<{ state: QueryState; cell: ReturnType<Runtime["getCell"]> }> {
  const { commonfabric: cf } = createTrustedBuilder(runtime);
  const p = cf.pattern(() =>
    cf.sqliteQuery.asScope("session")(
      // deno-lint-ignore no-explicit-any
      { db, reactOn: db, ...query } as any,
    )
  );
  const tx = runtime.edit();
  const resultCell = runtime.getCell(space, cause, p.resultSchema, tx);
  const result = runtime.run(tx, p, {}, resultCell);
  await tx.commit();
  const state = await waitForCellValue<QueryState>(runtime, result, settled);
  return { state, cell: result };
}

describe("sqliteQuery under a runtime read ceiling", () => {
  describe("constructor()", () => {
    // The option is enforcement config: a malformed one surfaces at boot, as
    // the sink ceilings and policy records do.

    let storageManager: ReturnType<typeof StorageManager.emulate>;

    beforeEach(async () => {
      const signer = await Identity.fromPassphrase(
        `read-ceiling-ctor-${crypto.randomUUID()}`,
      );
      storageManager = StorageManager.emulate({ as: signer });
    });

    afterEach(async () => {
      await storageManager.close();
    });

    const construct = (options: Partial<RuntimeOptions>): Runtime =>
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        ...options,
      });

    it("throws on an empty ceiling, which admits nothing", () => {
      expect(() => construct({ cfcReadMaxConfidentiality: [] })).toThrow(
        /cfcReadMaxConfidentiality/,
      );
    });

    it("throws on a ceiling that is not a list", () => {
      expect(() =>
        construct({
          cfcReadMaxConfidentiality:
            "did:key:owner" as unknown as CfcConfClause[],
        })
      ).toThrow(/cfcReadMaxConfidentiality/);
    });

    it("throws on a clause that is neither an atom nor an `anyOf`", () => {
      expect(() =>
        construct({
          cfcReadMaxConfidentiality: [42 as unknown as CfcConfClause],
        })
      ).toThrow(/cfcReadMaxConfidentiality/);
      expect(() =>
        construct({
          cfcReadMaxConfidentiality: [{ anyOf: [] }],
        })
      ).toThrow(/cfcReadMaxConfidentiality/);
    });

    it("throws on an `onExceed` outside `fail` and `skip`", () => {
      expect(() =>
        construct({
          cfcReadMaxConfidentiality: ["did:key:owner"],
          cfcReadOnExceed: "drop" as unknown as "skip",
        })
      ).toThrow(/cfcReadOnExceed/);
    });

    it("throws on an `onExceed` without a ceiling to qualify", () => {
      expect(() => construct({ cfcReadOnExceed: "skip" })).toThrow(
        /cfcReadOnExceed/,
      );
    });

    it("hands the ceiling to the storage manager's sessions for a client under server execution", async () => {
      // Such a client executes no query of its own: the space server's
      // runtime serves them, under the ceiling the client's sessions
      // declare.
      let declared: SessionReadCeiling | undefined;
      storageManager.setSessionReadCeiling = (ceiling) => {
        declared = ceiling;
      };
      const runtime = construct({
        experimental: { serverExecution: true },
        cfcReadMaxConfidentiality: ["did:key:owner"],
        cfcReadOnExceed: "skip",
      });
      try {
        expect(declared).toEqual({
          maxConfidentiality: ["did:key:owner"],
          onExceed: "skip",
        });
        expect(runtime.cfcReadMaxConfidentiality).toEqual(["did:key:owner"]);
      } finally {
        await runtime.dispose();
      }
    });

    it("declares no ceiling to the sessions of a client off server execution", async () => {
      // The OFF arm executes its own queries under the runtime's option; a
      // declared ceiling would be a wire delta on an arm whose wire is
      // byte-identical to the pre-flag one.
      let declared = false;
      storageManager.setSessionReadCeiling = () => {
        declared = true;
      };
      const runtime = construct({
        cfcReadMaxConfidentiality: ["did:key:owner"],
      });
      try {
        expect(declared).toBe(false);
      } finally {
        await runtime.dispose();
      }
    });

    it("throws on a ceiling for a client under server execution whose manager cannot carry it", () => {
      (storageManager as { setSessionReadCeiling?: unknown })
        .setSessionReadCeiling = undefined;
      expect(() =>
        construct({
          experimental: { serverExecution: true },
          cfcReadMaxConfidentiality: ["did:key:owner"],
        })
      ).toThrow(/cannot carry the ceiling/);
    });

    it("releases the server-execution enabler it claimed when it refuses that ceiling", () => {
      // The refusal is thrown inside the construction scope whose rollback
      // releases the process-global enabler; a leaked one would pin the
      // ambient flag for the process lifetime.
      (storageManager as { setSessionReadCeiling?: unknown })
        .setSessionReadCeiling = undefined;
      const before = serverExecutionEnablerCount();
      expect(() =>
        construct({
          experimental: { serverExecution: true },
          cfcReadMaxConfidentiality: ["did:key:owner"],
        })
      ).toThrow();
      expect(serverExecutionEnablerCount()).toBe(before);
    });

    it("throws on a ceiling with a hole in it", () => {
      expect(() => construct({ cfcReadMaxConfidentiality: new Array(1) }))
        .toThrow(/cfcReadMaxConfidentiality\[0\]/);
      const holed: CfcConfClause[] = [];
      holed[1] = "did:key:owner";
      expect(() => construct({ cfcReadMaxConfidentiality: holed })).toThrow(
        /cfcReadMaxConfidentiality\[0\]/,
      );
    });

    it("holds a frozen copy of the ceiling it was given", async () => {
      const given: CfcConfClause[] = ["did:key:owner", { anyOf: ["a", "b"] }];
      const runtime = construct({ cfcReadMaxConfidentiality: given });
      try {
        given.push("did:key:intruder");
        expect(runtime.cfcReadMaxConfidentiality).toEqual([
          "did:key:owner",
          { anyOf: ["a", "b"] },
        ]);
        expect(Object.isFrozen(runtime.cfcReadMaxConfidentiality)).toBe(true);
        expect(Object.isFrozen(runtime.cfcReadMaxConfidentiality![1])).toBe(
          true,
        );
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("effectiveReadCeiling()", () => {
    // The ceiling a run's queries read under: the runtime's own met with
    // the one the run's session carries. Pinned on a runtime with and
    // without an option of its own, against a stamped and an unstamped
    // transaction.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime | undefined;

    beforeEach(async () => {
      const signer = await Identity.fromPassphrase(
        `read-ceiling-effective-${crypto.randomUUID()}`,
      );
      storageManager = StorageManager.emulate({ as: signer });
      runtime = undefined;
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager.close();
    });

    const serving = (options: Partial<RuntimeOptions> = {}): Runtime => {
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        servingPosture: true,
        experimental: { serverExecution: true },
        ...options,
      });
      return runtime;
    };

    const stamped = (
      rt: Runtime,
      readCeiling: SessionReadCeiling | undefined,
    ) => {
      const tx = rt.edit();
      stampWaveRunContext(tx, {
        actionId: "test:read-ceiling",
        kind: "derivation",
        scopeKeyIdentity: { principal: "did:key:zAlice", sessionId: "s1" },
        ...(readCeiling !== undefined ? { readCeiling } : {}),
      });
      return tx;
    };

    it("returns the runtime's option on an unstamped run", () => {
      const rt = serving({
        cfcReadMaxConfidentiality: ["did:key:owner"],
        cfcReadOnExceed: "skip",
      });
      expect(effectiveReadCeiling(rt, undefined)).toEqual({
        maxConfidentiality: ["did:key:owner"],
        onExceed: "skip",
      });
    });

    it("returns no ceiling on a stamped run that carries none, for a runtime with no option", () => {
      const rt = serving();
      const tx = stamped(rt, undefined);
      try {
        expect(effectiveReadCeiling(rt, waveRunContextOf(tx))).toEqual({
          maxConfidentiality: undefined,
          onExceed: undefined,
        });
      } finally {
        tx.abort();
      }
    });

    it("returns the carried ceiling on a stamped run, for a runtime with no option", () => {
      const rt = serving();
      const tx = stamped(rt, {
        maxConfidentiality: ["did:key:zAlice"],
        onExceed: "skip",
      });
      try {
        expect(effectiveReadCeiling(rt, waveRunContextOf(tx))).toEqual({
          maxConfidentiality: ["did:key:zAlice"],
          onExceed: "skip",
        });
      } finally {
        tx.abort();
      }
    });

    it("meets the runtime's option with the carried ceiling, the mode meeting toward `fail`", () => {
      const rt = serving({
        cfcReadMaxConfidentiality: ["did:key:owner"],
        cfcReadOnExceed: "fail",
      });
      const tx = stamped(rt, {
        maxConfidentiality: ["did:key:zAlice"],
        onExceed: "skip",
      });
      try {
        const effective = effectiveReadCeiling(rt, waveRunContextOf(tx));
        expect(effective.onExceed).toBe("fail");
        // The same meet a query's declared ceiling gets against a
        // runtime's: a row fits it only if it fits each.
        expect(effective.maxConfidentiality).toEqual(
          meetCfcObservationCeilings(["did:key:owner"], ["did:key:zAlice"]),
        );
      } finally {
        tx.abort();
      }
    });

    it("takes the carried `skip` when the runtime's option names no mode", () => {
      const rt = serving({ cfcReadMaxConfidentiality: ["did:key:owner"] });
      const tx = stamped(rt, {
        maxConfidentiality: ["did:key:zAlice"],
        onExceed: "skip",
      });
      try {
        expect(effectiveReadCeiling(rt, waveRunContextOf(tx)).onExceed).toBe(
          "skip",
        );
      } finally {
        tx.abort();
      }
    });
  });

  describe("buildCfcReadCeiling()", () => {
    it("detaches and freezes the ceiling to its leaves, so a retained alias cannot move it", () => {
      const nested = { type: "https://example.test/atom", subject: { id: 1 } };
      const clause = { anyOf: [nested, "did:key:zOther"] };
      const built = buildCfcReadCeiling({
        cfcReadMaxConfidentiality: [clause],
      });
      nested.subject.id = 2;
      clause.anyOf.push("did:key:zWidened");
      const alternatives =
        (built.maxConfidentiality![0] as { anyOf: unknown[] }).anyOf;
      expect(alternatives.length).toBe(2);
      expect((alternatives[0] as { subject: { id: number } }).subject.id).toBe(
        1,
      );
      expect(Object.isFrozen(alternatives)).toBe(true);
      expect(Object.isFrozen(alternatives[0])).toBe(true);
      expect(Object.isFrozen((alternatives[0] as { subject: unknown }).subject))
        .toBe(true);
    });

    it("names the fields a caller labels in its refusals", () => {
      const labels = {
        ceiling: "run manifest cfc.maxConfidentiality",
        onExceed: "run manifest cfc.onExceed",
      };
      expect(() =>
        buildCfcReadCeiling({ cfcReadMaxConfidentiality: [] }, labels)
      ).toThrow(/^run manifest cfc\.maxConfidentiality: an empty ceiling/);
      expect(() =>
        buildCfcReadCeiling(
          { cfcReadMaxConfidentiality: ["a", 42 as unknown as string] },
          labels,
        )
      ).toThrow(/^run manifest cfc\.maxConfidentiality\[1\]: expected an atom/);
      expect(() =>
        buildCfcReadCeiling(
          { cfcReadOnExceed: "drop" as unknown as "skip" },
          labels,
        )
      ).toThrow(/^run manifest cfc\.onExceed: expected "fail" or "skip"/);
      expect(() => buildCfcReadCeiling({ cfcReadOnExceed: "skip" }, labels))
        .toThrow(
          /^run manifest cfc\.onExceed: qualifies `run manifest cfc\.maxConfidentiality`/,
        );
    });

    it("names the runtime options when no labels are given", () => {
      expect(() => buildCfcReadCeiling({ cfcReadMaxConfidentiality: [] }))
        .toThrow(/^cfcReadMaxConfidentiality: an empty ceiling/);
    });
  });

  describe("one runtime", () => {
    let signer: Identity;
    let space: `did:${string}:${string}`;
    let db: SqliteDbRef;
    let aggregateDb: SqliteDbRef;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime | undefined;
    let errors: ErrorWithContext[];

    beforeEach(async () => {
      signer = await Identity.fromPassphrase(
        `read-ceiling-${crypto.randomUUID()}`,
      );
      space = signer.did();
      storageManager = StorageManager.emulate({ as: signer });
      db = {
        id: `of:read-ceiling-${crypto.randomUUID()}`,
        tables,
        owner: signer.did(),
      };
      aggregateDb = {
        id: `of:read-ceiling-agg-${crypto.randomUUID()}`,
        tables: aggregateTables,
        owner: signer.did(),
      };
      runtime = undefined;
      errors = [];
    });

    afterEach(async () => {
      await runtime?.idle();
      await runtime?.dispose();
      await storageManager.close();
    });

    const start = async (
      options: Partial<RuntimeOptions>,
    ): Promise<Runtime> => {
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        errorHandlers: [(error) => errors.push(error)],
        ...options,
      });
      await seedRows(runtime, space, db);
      await seedRows(runtime, space, aggregateDb);
      return runtime;
    };

    it("withholds, under `skip`, the rows a query declaring no ceiling would otherwise read", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [signer.did()],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, db, { sql: ROWS_SQL });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["mine"]);
    });

    it("resolves the db-owner placeholder in the runtime's ceiling per db", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [{ __ctDbOwner: true }],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, db, { sql: ROWS_SQL });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["mine"]);
    });

    it("resolves a placeholder inside an `anyOf` of the runtime's ceiling", async () => {
      // Under an OR-clause ceiling a row fits when its label is at least as
      // wide, so over `shared` only the addressed row — labeled owner OR
      // bob — fits `{anyOf: [owner, bob]}`. An unresolved placeholder
      // would leave the clause unsatisfiable and admit nothing.
      const rt = await start({
        cfcReadMaxConfidentiality: [{ anyOf: [{ __ctDbOwner: true }, BOB] }],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, aggregateDb, {
        sql: "SELECT id, to_addr, body FROM shared ORDER BY id",
      });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["shared"]);
    });

    it("refuses a query's `onExceed: null` rather than reading it as absent", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [signer.did()],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, db, {
        sql: ROWS_SQL,
        onExceed: null,
      });
      expect(String(state.error)).toMatch(/invalid onExceed/);
    });

    it("refuses the query under `fail`, the default mode, when a row exceeds", async () => {
      const rt = await start({ cfcReadMaxConfidentiality: [signer.did()] });
      const { state } = await runQuery(rt, space, db, { sql: ROWS_SQL });
      expect(String(state.error)).toMatch(/ceiling/);
      expect(state.result).toBeUndefined();
    });

    it("returns both rows under a query's ceiling naming the address, with no runtime ceiling", async () => {
      // The control for the two meets below: the query ceiling they widen
      // with admits the addressed row on its own.
      const rt = await start({});
      const { state } = await runQuery(rt, space, db, {
        sql: ROWS_SQL,
        maxConfidentiality: [signer.did(), BOB],
      });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["mine", "shared"]);
    });

    it("meets a query's wider ceiling with the runtime's, so the query cannot widen past it", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [signer.did()],
        cfcReadOnExceed: "skip",
      });
      // Alone, this ceiling admits both rows.
      const { state } = await runQuery(rt, space, db, {
        sql: ROWS_SQL,
        maxConfidentiality: [signer.did(), BOB],
      });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["mine"]);
    });

    it("meets a Row schema's ceiling with the runtime's on the same terms", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [signer.did()],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, db, {
        sql: ROWS_SQL,
        rowSchema: {
          type: "object",
          ifc: { maxConfidentiality: [signer.did(), BOB] },
        },
      });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["mine"]);
    });

    it("keeps a query's own narrower ceiling", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [signer.did(), BOB],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, db, {
        sql: ROWS_SQL,
        maxConfidentiality: [signer.did()],
      });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["mine"]);
    });

    it("lets a query's own `onExceed` stand over the runtime's default", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [signer.did()],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, db, {
        sql: ROWS_SQL,
        onExceed: "fail",
      });
      expect(String(state.error)).toMatch(/ceiling/);
    });

    describe("an aggregate projection, which has no ceiling of its own", () => {
      // The aggregate over `shared` is labeled by the rule's common reader,
      // the owner. The first case is the control: the same query under a
      // ceiling admitting the owner is what the two refusals are measured
      // against.

      const COUNT_SQL = "SELECT COUNT(*) AS n FROM shared";

      it("returns the aggregate when the runtime's ceiling admits its reader", async () => {
        const rt = await start({ cfcReadMaxConfidentiality: [signer.did()] });
        const { state } = await runQuery(rt, space, aggregateDb, {
          sql: COUNT_SQL,
        });
        expect(state.error).toBeUndefined();
        expect(state.result?.[0]?.n).toBe(2);
      });

      it("refuses the aggregate when the runtime's ceiling omits its reader", async () => {
        const rt = await start({
          cfcReadMaxConfidentiality: ["did:key:someone-else"],
        });
        const { state } = await runQuery(rt, space, aggregateDb, {
          sql: COUNT_SQL,
        });
        expect(String(state.error)).toMatch(/ceiling/);
      });

      // A runtime-wide `skip` is a mode the query author never chose. On a
      // projection where skip cannot apply, refusing would fail every
      // aggregate on the runtime for a word the query never said, so the
      // default falls back to the builtin's `fail`: admitted, the aggregate
      // returns; not admitted, the ceiling refuses it. A query's OWN `skip`
      // on the same projection is still refused, as it is without a runtime
      // ceiling.
      it("a runtime `skip` falls back to `fail` and returns the admitted aggregate", async () => {
        const rt = await start({
          cfcReadMaxConfidentiality: [signer.did()],
          cfcReadOnExceed: "skip",
        });
        const { state } = await runQuery(rt, space, aggregateDb, {
          sql: COUNT_SQL,
        });
        expect(state.error).toBeUndefined();
        expect(state.result?.[0]?.n).toBe(2);
      });

      it("a runtime `skip` falls back to `fail` and refuses the aggregate its ceiling omits", async () => {
        const rt = await start({
          cfcReadMaxConfidentiality: ["did:key:someone-else"],
          cfcReadOnExceed: "skip",
        });
        const { state } = await runQuery(rt, space, aggregateDb, {
          sql: COUNT_SQL,
        });
        expect(String(state.error)).toMatch(/ceiling/);
        expect(String(state.error)).not.toMatch(/aggregate/);
      });

      it("the query's own `skip` is still refused on an aggregate", async () => {
        const rt = await start({
          cfcReadMaxConfidentiality: [signer.did()],
          cfcReadOnExceed: "skip",
        });
        const { state } = await runQuery(rt, space, aggregateDb, {
          sql: COUNT_SQL,
          onExceed: "skip",
        });
        expect(String(state.error)).toMatch(/aggregate/);
      });
    });

    it("returns every row of a table whose rows carry no label", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: ["did:key:someone-else"],
        cfcReadOnExceed: "skip",
      });
      const { state } = await runQuery(rt, space, db, {
        sql: "SELECT id, body FROM notes ORDER BY id",
      });
      expect(state.error).toBeUndefined();
      expect(bodies(state)).toEqual(["seed"]);
    });

    it("refuses a query whose result is not session-scoped, writing nothing", async () => {
      const rt = await start({
        cfcReadMaxConfidentiality: [signer.did()],
        cfcReadOnExceed: "skip",
      });
      const { commonfabric: cf } = createTrustedBuilder(rt);
      const p = cf.pattern(() =>
        // deno-lint-ignore no-explicit-any
        cf.sqliteQuery({ db, reactOn: db, sql: ROWS_SQL } as any)
      );
      const tx = rt.edit();
      const cell = rt.getCell(
        space,
        "read-ceiling-space-scoped",
        undefined,
        tx,
      );
      rt.run(tx, p, {}, cell);
      await tx.commit();
      // The query runs once a reader demands it.
      cell.sink(() => {});
      await rt.idle();
      expect(errors.map((e) => String(e))).toEqual([
        expect.stringMatching(/session-scoped/),
      ]);
      expect(cell.get()).toBeUndefined();
    });
  });

  describe("two runtimes over one space", () => {
    // Each runtime's storage manager is its own session, so a session-scoped
    // result is that runtime's own instance: the runtime with a ceiling
    // reads its rows under it, the runtime without one reads every row, and
    // neither adopts the other's result or re-issues over it.

    let signer: Identity;
    let space: `did:${string}:${string}`;
    let db: SqliteDbRef;
    let server: MemoryV2Server.Server;
    let runtimeA: Runtime;
    let runtimeB: Runtime;

    beforeEach(async () => {
      signer = await Identity.fromPassphrase(
        `read-ceiling-pair-${crypto.randomUUID()}`,
      );
      space = signer.did();
      server = newSharedServer();
      db = {
        id: `of:read-ceiling-pair-${crypto.randomUUID()}`,
        tables,
        owner: signer.did(),
      };
      runtimeA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
        cfcReadMaxConfidentiality: [signer.did()],
        cfcReadOnExceed: "skip",
      });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
      });
      await seedRows(runtimeA, space, db);
    });

    afterEach(async () => {
      const grace = new Promise((r) => setTimeout(r, 3000));
      await Promise.race([
        Promise.allSettled([runtimeA.settled(), runtimeB.settled()]),
        grace,
      ]);
      runtimeB.scheduler.dispose();
      runtimeA.scheduler.dispose();
      await Promise.allSettled([
        runtimeB.storageManager.synced(),
        runtimeA.storageManager.synced(),
      ]);
      await runtimeB.dispose();
      await runtimeA.dispose();
      await server.close();
    });

    it("keeps each runtime's rows its own for one shared query, whichever runs first", async () => {
      const cause = "read-ceiling-shared-query";
      const b = await runQuery(runtimeB, space, db, { sql: ROWS_SQL }, cause);
      expect(b.state.error).toBeUndefined();
      expect(bodies(b.state)).toEqual(["mine", "shared"]);
      await runtimeB.storageManager.synced();

      const a = await runQuery(runtimeA, space, db, { sql: ROWS_SQL }, cause);
      expect(a.state.error).toBeUndefined();
      expect(bodies(a.state)).toEqual(["mine"]);

      // Both settle, and each still reads its own rows.
      await runtimeA.settled();
      await runtimeB.settled();
      const settledA = await waitForCellValue<QueryState>(
        runtimeA,
        a.cell,
        settled,
      );
      expect(bodies(settledA)).toEqual(["mine"]);
      expect(settledA.requestHash).toBe(a.state.requestHash);
      const settledB = await waitForCellValue<QueryState>(
        runtimeB,
        b.cell,
        settled,
      );
      expect(bodies(settledB)).toEqual(["mine", "shared"]);
      expect(settledB.requestHash).toBe(b.state.requestHash);
    });
  });
});
