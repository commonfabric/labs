/**
 * The ceiling `sqliteQuery`'s control state is measured against when a query
 * parameter is read out of a labeled row.
 *
 * A request hash is a function of the parameters, so a parameter derived from
 * a labeled read taints the transaction that claims the request —
 * `{pending, requestHash}` — as surely as it taints the rows. The claim rides
 * the requesting run's own commit, so there is no transaction in which such a
 * parameter is untainted, and an author cannot know which atoms a given
 * transaction will carry. The control paths therefore take §8.12.5 route 2:
 * the runtime declares their policy from the transaction's join. What that
 * store's own empty ceiling was refusing by accident goes to the builtin,
 * which refuses a request carrying confidentiality bound for a database in
 * another space before it is staged, and declares the membership of a shared
 * result.
 *
 * The fixture labels the column a parameter is read OUT of differently from
 * the column the second query projects, so an implementation that widened the
 * projected column's declared ceiling from the transaction, or that declared
 * the control paths from the query's own columns, disagrees with what these
 * cases expect. The membership case goes further and projects a column that
 * declares nothing, so the parameter's clause is the only one that can reach
 * the path it is about.
 *
 * Every case runs at `enforce-strict` with flow labels persisting, the rung
 * where a writer-fit misfit rejects rather than flags.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";

import {
  SQLITE_FOREIGN_SPACE_REFUSAL,
} from "../src/builtins/sqlite-builtins.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-sqlite-control");
const space = signer.did();
const elsewhere = (await Identity.fromPassphrase("runner-cfc-sqlite-foreign"))
  .did();

/**
 * The clause a connector store's column declares: the owner as a bare DID
 * string and a `Resource` atom naming the class, which is the spelling the
 * Loom connectors write. Neither alternative can fit the residency clause a
 * document resolves to, which is what makes an undeclared path a misfit.
 */
const clauseFor = (subject: string, cls: string) => [
  space,
  { type: CFC_ATOM_TYPE.Resource, class: cls, subject },
];

/** The column a parameter is read out of. */
const KEY_CLAUSE = clauseFor(space, "message");
/** The column the parameterized query projects — a different class. */
const BODY_CLAUSE = clauseFor(space, "attachment");

const KEYS_SQL = "SELECT container_id FROM messages ORDER BY container_id";
const BODIES_SQL =
  "SELECT body FROM messages WHERE container_id = ?1 ORDER BY id";

interface KeyRow {
  container_id: string;
}

interface BodyRow {
  body: string;
}

interface QueryState<Row> {
  pending?: boolean;
  result?: Row[];
  error?: unknown;
  requestHash?: string;
}

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[] };
  origin?: string;
};

describe("sqliteQuery's control state under a labeled parameter", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      // The dials every preset deployment pins, rather than the constructor
      // defaults. `cfcDeclaredMonotonicity` is the one this file is about:
      // it judges whether a DECLARED entry may be replaced at a path, and
      // re-declaring the control state on every issue is the whole mechanism
      // under review — asserting a ratchet with the ratchet's own gate off
      // would be asserting it against nothing.
      cfcWriteFloor: "enforce",
      cfcPolicyEvaluation: "enforce",
      cfcLabelMetadataProtection: "enforce",
      cfcDeclaredMonotonicity: "enforce",
    });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  /**
   * A database whose key column and body column declare DIFFERENT clauses, so
   * a label that reached a path from the parameter is distinguishable from one
   * that rode the projected rows.
   */
  const labeledDb = (extraColumns: Record<string, unknown> = {}): SqliteDbRef =>
    ({
      id: `of:control-state-${crypto.randomUUID()}`,
      tables: {
        messages: {
          type: "object",
          properties: {
            id: { type: "integer", sqlType: "integer primary key" },
            container_id: {
              type: "string",
              sqlType: "text",
              ifc: { confidentiality: KEY_CLAUSE },
            },
            body: {
              type: "string",
              sqlType: "text",
              ifc: { confidentiality: BODY_CLAUSE },
            },
            // Declares nothing, so a query projecting it carries no clause
            // of its own and the only label in sight is the parameter's.
            note: { type: "string", sqlType: "text" },
            ...extraColumns,
          },
          required: [],
        },
      },
    }) as unknown as SqliteDbRef;

  const seed = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
    at: typeof space = space,
  ): Promise<void> => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(at, { op: "sqlite", db, sql, params });
    expect((await tx.commit()).error).toBeUndefined();
  };

  /**
   * Two containers with different row counts, so a query that ran with the
   * wrong parameter — an empty string, or the other container's key — cannot
   * produce the rows a case expects.
   */
  const seedMessages = async (db: SqliteDbRef, at: typeof space = space) => {
    await seed(
      db,
      "INSERT INTO messages (container_id, body, note) VALUES " +
        "(?, ?, ?), (?, ?, ?), (?, ?, ?)",
      [
        "c-alpha",
        "first",
        "n1",
        "c-alpha",
        "second",
        "n2",
        "c-beta",
        "only",
        "n3",
      ],
      at,
    );
  };

  /**
   * Every stored label entry on the document `cell` addresses. Resolved
   * first: a pattern's result holds a LINK to the builtin's result cell, and
   * the scoped instance the builtin writes is what carries the labels.
   */
  const storedEntries = (cell: Cell<unknown>): StoredEntry[] => {
    const tx = runtime.edit();
    try {
      const link = cell.resolveAsCell().getAsNormalizedFullLink();
      return (readStoredCfcMetadata(tx, link)?.labelMap.entries ??
        []) as StoredEntry[];
    } finally {
      tx.abort("label read");
    }
  };

  /**
   * Every confidentiality atom the DECLARED entries at `path` carry. All of
   * them rather than the first: a schema's own declaration and one the
   * runtime made from a transaction are both `declared`, and reading one of
   * the two would answer a different question depending on which landed
   * first.
   */
  const declaredAt = (cell: Cell<unknown>, path: string[]): unknown[] =>
    storedEntries(cell)
      .filter((entry) =>
        entry.origin === "declared" &&
        entry.path.length === path.length &&
        entry.path.every((segment, i) => segment === path[i])
      )
      .flatMap((entry) => entry.label.confidentiality ?? []);

  /**
   * A stable rendering of an atom: the stored form and the fixture's are the
   * same object with its keys in a different order, so comparing the two as
   * written would report every clause as absent.
   */
  const canonical = (value: unknown): string =>
    JSON.stringify(
      value,
      (_key, held) =>
        held !== null && typeof held === "object" && !Array.isArray(held)
          ? Object.fromEntries(
            Object.entries(held as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0
            ),
          )
          : held,
    );

  /** Whether every alternative of `clause` is among `atoms`. */
  const hasClause = (
    atoms: readonly unknown[] | undefined,
    clause: readonly unknown[],
  ): boolean =>
    clause.every((atom) =>
      (atoms ?? []).some((held) => canonical(held) === canonical(atom))
    );

  /**
   * A lift returning one SQL parameter.
   *
   * The result schema is not decoration: a lift with none writes its output
   * document without a schema write-policy input, which the commit refuses
   * once that document carries stored label metadata — so the SECOND labeled
   * value such a lift produces never lands, and a case that flips a parameter
   * would be reading the first one throughout.
   */
  const parameterLift = (
    fn: (input: unknown) => string,
  ): (input: unknown) => unknown => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const { lift } = cf as unknown as {
      lift: (
        fn: (value: unknown) => unknown,
        argumentSchema?: unknown,
        resultSchema?: unknown,
      ) => (value: unknown) => unknown;
    };
    return lift((input: unknown) => [fn(input)], undefined, {
      type: "array",
      items: { type: "string" },
    });
  };

  /**
   * Runs a first query over the labeled key column and a second query whose
   * parameter is read OUT of the first query's rows — the shape a pattern has
   * when it narrows a view to something the user picked out of labeled data.
   */
  const runDerivedParameterPattern = async (
    db: SqliteDbRef,
    cause: string,
    options: { literalParameter?: string } = {},
  ) => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const parameterOf = parameterLift((keys) =>
      String((keys as QueryState<KeyRow>)?.result?.[0]?.container_id ?? "")
    );
    const testPattern = cf.pattern<Record<string, never>>(() => {
      const keys = cf.sqliteQuery.asScope("session")(
        // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        { db, reactOn: db, sql: KEYS_SQL } as any,
      );
      const params = options.literalParameter !== undefined
        ? [options.literalParameter]
        : parameterOf(keys);
      const bodies = cf.sqliteQuery.asScope("session")(
        // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        { db, reactOn: db, sql: BODIES_SQL, params } as any,
      );
      return { keys, bodies };
    });

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      cause,
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state, as it writes it
    return { bodies: result.key("bodies") as Cell<any> };
  };

  it("settles the query whose parameter came out of a labeled row", async () => {
    // The assertion is the ROWS rather than the pending flag: the parameter is
    // an empty string until the first query settles, and that issue settles on
    // its own with no rows. A case that accepted "settled" would pass on it
    // while the labeled issue stayed refused.

    const db = labeledDb();
    await seedMessages(db);
    const { bodies } = await runDerivedParameterPattern(db, "derived-settles");

    const state = await waitForCellValue<QueryState<BodyRow>>(
      runtime,
      bodies,
      (value) => (value?.result ?? []).length === 2,
    );
    expect(state.error).toBeUndefined();
    expect(state.pending).toBe(false);
    expect(state.result).toEqual([{ body: "first" }, { body: "second" }]);
  });

  it("declares the parameter's clause on the request hash", async () => {
    // `/requestHash` rather than `/pending` because of which writes touch
    // which path. The issuing transaction declares on both; the settle then
    // rewrites `pending` from a transaction that reads only its own write
    // destination, and the runtime re-derives that path's entry from what
    // the writer carried, which is nothing. The hash does not change between
    // the two writes, so the entry the issue declared is what stands.

    const db = labeledDb();
    await seedMessages(db);
    const { bodies } = await runDerivedParameterPattern(db, "derived-declares");

    await waitForCellValue<QueryState<BodyRow>>(
      runtime,
      bodies,
      (value) => (value?.result ?? []).length === 2,
    );

    // The clause the PARAMETER carried, on a path no schema declares. The key
    // column's clause is not the projected column's, so this cannot be
    // satisfied by the query's own static confidentiality.
    expect(hasClause(declaredAt(bodies, ["requestHash"]), KEY_CLAUSE))
      .toBe(true);
  });

  it("declares nothing on the control paths of a literal-parameter query", async () => {
    // The control. A literal parameter reads nothing labeled, so the issue
    // transaction carries no clause and the route has nothing to declare —
    // which is why a fixture whose parameter is a literal passes with the
    // control paths undeclared.

    const db = labeledDb();
    await seedMessages(db);
    const { bodies } = await runDerivedParameterPattern(db, "literal-param", {
      literalParameter: "c-alpha",
    });

    const state = await waitForCellValue<QueryState<BodyRow>>(
      runtime,
      bodies,
      (value) => (value?.result ?? []).length === 2,
    );
    expect(state.error).toBeUndefined();
    expect(state.result).toEqual([{ body: "first" }, { body: "second" }]);
    expect(hasClause(declaredAt(bodies, ["requestHash"]), KEY_CLAUSE))
      .toBe(false);
  });

  describe("a shared result", () => {
    // Space scope, where one materialization serves every reader of the
    // space. A session-scoped result is per-reader, so its membership tells
    // its own reader nothing they did not ask for, and the builtin declares
    // nothing on it.

    const runSharedPattern = async (
      db: SqliteDbRef,
      cause: string,
      sql: string,
    ) => {
      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const parameterOf = parameterLift((keys) =>
        String((keys as QueryState<KeyRow>)?.result?.[0]?.container_id ?? "")
      );
      const testPattern = cf.pattern<Record<string, never>>(() => {
        const keys = cf.sqliteQuery.asScope("session")(
          // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
          { db, reactOn: db, sql: KEYS_SQL } as any,
        );
        const rows = cf.sqliteQuery(
          // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
          { db, reactOn: db, sql, params: parameterOf(keys) } as any,
        );
        return { keys, rows };
      });
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        cause,
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      // deno-lint-ignore no-explicit-any -- the builtin's state
      return result.key("rows") as Cell<any>;
    };

    it("carries the parameter's clause on the result's membership", async () => {
      // Which rows came back is a function of the parameter as much as of
      // the rows, and the length and membership of a shared array are
      // readable without dereferencing a row. The projected column declares
      // NOTHING here, so the parameter's clause is the only one that can
      // reach `/result` — a fixture whose projection is labeled would pass
      // on the rows' own clause.

      const db = labeledDb();
      await seedMessages(db);
      const rows = await runSharedPattern(
        db,
        "shared-membership",
        "SELECT note FROM messages WHERE container_id = ?1 ORDER BY id",
      );

      const state = await waitForCellValue<QueryState<{ note: string }>>(
        runtime,
        rows,
        (value) => (value?.result ?? []).length === 2,
      );
      expect(state.error).toBeUndefined();
      expect(state.result).toEqual([{ note: "n1" }, { note: "n2" }]);
      expect(hasClause(declaredAt(rows, ["result"]), KEY_CLAUSE)).toBe(true);
    });

    it("labels each row by the column it came from", async () => {
      // The rows are the columns' to label, and the settle transaction
      // carries nothing of its own, so the parameter's clause reaches the
      // membership and not the row. Route 2 declines at `/body` in any case:
      // the write schema declares there.

      const db = labeledDb();
      await seedMessages(db);
      const rows = await runSharedPattern(db, "shared-rows", BODIES_SQL);

      await waitForCellValue<QueryState<BodyRow>>(
        runtime,
        rows,
        (value) => (value?.result ?? []).length === 2,
      );

      const row = rows.key("result").key(0) as Cell<unknown>;
      const declared = declaredAt(row, ["body"]);
      expect(hasClause(declared, BODY_CLAUSE)).toBe(true);
      expect(hasClause(declared, KEY_CLAUSE)).toBe(false);
    });
  });

  it("accumulates a clause per differently-labeled parameter and drops none", async () => {
    // The ratchet the route asks for: a clause a transaction put on the
    // control state stays there after the read that carried it stops. Three
    // issues of ONE query node, each parameterized out of a differently
    // labeled column of the same row, so each issue's transaction carries one
    // clause and the accumulation is visible one clause at a time.

    const first = clauseFor(space, "first-class");
    const second = clauseFor(space, "second-class");
    const third = clauseFor(space, "third-class");
    const column = (clause: unknown[]) => ({
      type: "string",
      sqlType: "text",
      ifc: { confidentiality: clause },
    });
    const db = labeledDb({
      k1: column(first),
      k2: column(second),
      k3: column(third),
    });
    // Row 0's three key columns name the two-row container, the one-row
    // container, and the two-row container again, so each step's row count
    // says which parameter the query actually ran with.
    await seed(
      db,
      "INSERT INTO messages (container_id, body, k1, k2, k3) VALUES " +
        "(?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
      [
        "c-alpha",
        "first",
        "c-alpha",
        "c-beta",
        "c-alpha",
        "c-alpha",
        "second",
        "x",
        "y",
        "z",
        "c-beta",
        "only",
        "p",
        "q",
        "r",
      ],
    );

    const { commonfabric: cf } = createTrustedBuilder(runtime);
    // Reads ONE column, chosen by `pick`. A branch the lift does not take is
    // a column it does not read, which is what keeps each issue's join down
    // to the one clause this step is about.
    const parameterOf = parameterLift((input) => {
      const { keys, pick } = input as {
        keys?: QueryState<Record<string, string>>;
        pick?: number;
      };
      const row = keys?.result?.[0];
      const name = pick === 0 ? "k1" : pick === 1 ? "k2" : "k3";
      return String(row?.[name] ?? "");
    });
    const testPattern = cf.pattern<{ pick: number }>(({ pick }) => {
      const keys = cf.sqliteQuery.asScope("session")(
        {
          db,
          reactOn: db,
          sql: "SELECT k1, k2, k3 FROM messages ORDER BY id",
          // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        } as any,
      );
      const bodies = cf.sqliteQuery.asScope("session")(
        {
          db,
          reactOn: db,
          sql: BODIES_SQL,
          params: parameterOf({ keys, pick }),
          // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        } as any,
      );
      return { keys, bodies };
    });

    const tx = runtime.edit();
    const pick = runtime.getCell<number>(space, "ratchet-pick", {
      type: "number",
    }, tx);
    pick.set(0);
    const resultCell = runtime.getCell(
      space,
      "ratchet",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      // deno-lint-ignore no-explicit-any -- a cell stands in for the argument
      { pick: pick as any },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state, as it writes it
    const bodies = result.key("bodies") as Cell<any>;

    const rowsFor = (expected: number) =>
      waitForCellValue<QueryState<BodyRow>>(
        runtime,
        bodies,
        (value) => (value?.result ?? []).length === expected,
      );

    await rowsFor(2);
    expect(hasClause(declaredAt(bodies, ["requestHash"]), first)).toBe(true);
    // Absent as much as present: an implementation that declared the whole
    // of what the transaction could ever carry, rather than what THIS issue
    // carried, would satisfy every presence assertion below and none of
    // these.
    expect(hasClause(declaredAt(bodies, ["requestHash"]), second)).toBe(false);
    expect(hasClause(declaredAt(bodies, ["requestHash"]), third)).toBe(false);

    const pickSecond = runtime.edit();
    pick.withTx(pickSecond).set(1);
    expect((await pickSecond.commit()).error).toBeUndefined();
    await rowsFor(1);
    expect(hasClause(declaredAt(bodies, ["requestHash"]), first)).toBe(true);
    expect(hasClause(declaredAt(bodies, ["requestHash"]), second)).toBe(true);
    expect(hasClause(declaredAt(bodies, ["requestHash"]), third)).toBe(false);

    const pickThird = runtime.edit();
    pick.withTx(pickThird).set(2);
    expect((await pickThird.commit()).error).toBeUndefined();
    await rowsFor(2);
    const held = declaredAt(bodies, ["requestHash"]);
    expect(hasClause(held, first)).toBe(true);
    expect(hasClause(held, second)).toBe(true);
    expect(hasClause(held, third)).toBe(true);
  });

  describe("what a reader of the control state carries", () => {
    // The point of the change is a pane that renders from the query's state,
    // so what that reader picks up decides whether the incident is closed.
    // The two paths disagree, and the disagreement is the measurement: a
    // reader of the settled `pending` flag carries nothing, a reader of the
    // request hash carries everything the issues of this query brought.

    const readIntoAnUndeclaredStore = async (
      // deno-lint-ignore no-explicit-any -- the builtin's state
      bodies: Cell<any>,
      field: string,
      cause: string,
    ) => {
      const tx = runtime.edit();
      const seen = bodies.withTx(tx).key(field).get();
      const out = runtime.getCell(space, cause, undefined, tx);
      out.set({ seen: String(seen) });
      tx.prepareCfc();
      return await tx.commit();
    };

    it("lets a reader of the settled pending flag write to an undeclared store", async () => {
      const db = labeledDb();
      await seedMessages(db);
      const { bodies } = await runDerivedParameterPattern(db, "reader-pending");
      await waitForCellValue<QueryState<BodyRow>>(
        runtime,
        bodies,
        (value) => (value?.result ?? []).length === 2,
      );

      const wrote = await readIntoAnUndeclaredStore(
        bodies,
        "pending",
        "reader-pending-probe",
      );
      expect(wrote.error).toBeUndefined();
    });

    it("refuses the same write from a reader of the request hash", async () => {
      const db = labeledDb();
      await seedMessages(db);
      const { bodies } = await runDerivedParameterPattern(db, "reader-hash");
      await waitForCellValue<QueryState<BodyRow>>(
        runtime,
        bodies,
        (value) => (value?.result ?? []).length === 2,
      );

      // The declared clause is a floor every reader of that path carries, so
      // a store that declares nothing cannot hold what this one read. That
      // is the route's documented cost, landing where the route put the
      // declaration and nowhere else.
      const wrote = await readIntoAnUndeclaredStore(
        bodies,
        "requestHash",
        "reader-hash-probe",
      );
      expect(wrote.error).toBeDefined();
    });
  });

  describe("a database in another space", () => {
    it("refuses a query whose transaction carries confidentiality", async () => {
      // The refusal the store's own empty ceiling was carrying by accident:
      // the parameter would otherwise leave for a space whose replica holders
      // are not the audience this document's residency names.

      const db = labeledDb();
      await seedMessages(db, elsewhere);

      const handleTx = runtime.edit();
      const handle = runtime.getCell<SqliteDbRef>(
        elsewhere,
        "foreign handle",
        undefined,
        handleTx,
      );
      handle.set(db);
      expect((await handleTx.commit()).error).toBeUndefined();

      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const parameterOf = parameterLift((keys) =>
        String((keys as QueryState<KeyRow>)?.result?.[0]?.container_id ?? "")
      );
      const testPattern = cf.pattern<{ db: unknown }>(({ db: handleInput }) => {
        const keys = cf.sqliteQuery(
          // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
          { db: handleInput, sql: KEYS_SQL } as any,
        );
        const bodies = cf.sqliteQuery(
          // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
          {
            db: handleInput,
            sql: BODIES_SQL,
            params: parameterOf(keys),
          } as any,
        );
        return { keys, bodies };
      });

      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "foreign-derived",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, { db: handle }, resultCell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();

      // The first query's parameter is a literal, so its transaction carries
      // nothing and the request goes: the refusal below is about the label,
      // not about the space alone.
      // deno-lint-ignore no-explicit-any -- the builtin's state
      const keys = result.key("keys") as Cell<any>;
      const settledKeys = await waitForCellValue<QueryState<KeyRow>>(
        runtime,
        keys,
        (value) => (value?.result ?? []).length === 3,
      );
      expect(settledKeys.error).toBeUndefined();

      // deno-lint-ignore no-explicit-any -- the builtin's state
      const bodies = result.key("bodies") as Cell<any>;
      const refused = await waitForCellValue<QueryState<BodyRow>>(
        runtime,
        bodies,
        (value) => typeof value?.error === "string",
      );
      expect(refused.error).toBe(SQLITE_FOREIGN_SPACE_REFUSAL);
      expect(refused.pending).toBe(false);
      expect(refused.result ?? []).toEqual([]);
      // The refusal is written by the issuing transaction, which carries the
      // clause it is refusing over, so route 2 declares that clause here.
      // This is the one path on which a reader of the control state carries
      // the parameter's label — the success path's `pending` carries nothing,
      // which the reader cases above assert — and a pattern that renders
      // "this query was refused" inherits it.
      expect(hasClause(declaredAt(bodies, ["error"]), KEY_CLAUSE)).toBe(true);
      expect(hasClause(declaredAt(bodies, ["pending"]), KEY_CLAUSE)).toBe(true);
      // No request hash goes with the refusal, so an evaluation whose reads
      // carry nothing asks again rather than finding a memo hit. A refusal
      // folded into the ordinary settled shape would be permanent.
      expect(refused.requestHash).toBeUndefined();
    });

    it("refuses a request that gained a label without moving its hash", async () => {
      // The memo decision returns before anything is staged, so a hit sends
      // nothing — and that is why the gate has to run ahead of it. A request
      // whose label arrives without changing the statement, the parameters
      // or the reader matches the hash an UNLABELED request left behind, and
      // answering it out of those rows is a reading nobody argued for.
      //
      // The label arrives on an input the request hash does not cover, which
      // is what makes the two runs a memo hit rather than a re-issue.

      const db = labeledDb();
      await seedMessages(db, elsewhere);

      const handleTx = runtime.edit();
      const handle = runtime.getCell<SqliteDbRef>(
        elsewhere,
        "foreign handle for memo hit",
        undefined,
        handleTx,
      );
      handle.set(db);
      expect((await handleTx.commit()).error).toBeUndefined();

      const setup = runtime.edit();
      const plain = runtime.getCell<string>(space, "plain note", {
        type: "string",
      }, setup);
      plain.set("nothing to see");
      const labeled = runtime.getCell<string>(space, "labeled note", {
        type: "string",
        ifc: { confidentiality: KEY_CLAUSE },
        // deno-lint-ignore no-explicit-any -- a schema literal with `ifc`
      } as any, setup);
      labeled.set("something to see");
      expect((await setup.commit()).error).toBeUndefined();

      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const testPattern = cf.pattern<{ db: unknown; note: unknown }>((
        { db: handleInput, note },
      ) =>
        cf.sqliteQuery(
          {
            db: handleInput,
            sql: "SELECT container_id FROM messages WHERE container_id = ?1",
            params: ["c-alpha"],
            // An input the builtin READS and the request hash does not
            // cover, which is the whole of what this case needs: reading it
            // moves the transaction's label and leaves the hash alone.
            // `rowSchema` is the one the builtin has; any other would do.
            rowSchema: note,
            // deno-lint-ignore no-explicit-any -- the input is untyped
          } as any,
        )
      );

      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "foreign-memo-hit",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        // deno-lint-ignore no-explicit-any -- cells stand in for the arguments
        { db: handle, note: plain as any },
        resultCell,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();

      // deno-lint-ignore no-explicit-any -- the builtin's state
      const rows = result as Cell<any>;
      const first = await waitForCellValue<QueryState<KeyRow>>(
        runtime,
        rows,
        (value) => (value?.result ?? []).length === 2,
      );
      expect(first.error).toBeUndefined();

      const relabel = runtime.edit();
      // deno-lint-ignore no-explicit-any -- the argument holds a cell
      result.getArgumentCell()!.withTx(relabel).key("note").set(labeled as any);
      expect((await relabel.commit()).error).toBeUndefined();

      const refused = await waitForCellValue<QueryState<KeyRow>>(
        runtime,
        rows,
        (value) => typeof value?.error === "string",
      );
      expect(refused.error).toBe(SQLITE_FOREIGN_SPACE_REFUSAL);
      expect(refused.requestHash).toBeUndefined();
      expect(refused.result ?? []).toEqual([]);
    });

    it("refuses a statically labeled parameter with the flow dial off", async () => {
      // The gate asks what the request carries, and a value's label does not
      // depend on whether the runtime propagates a join onto writes. Keying
      // the derivation on the flow dial rather than on the enforcement dial
      // hands a labeled parameter to a foreign space's provider as though it
      // carried nothing — and `off` is the DEFAULT flow mode, so that is the
      // ordinary case rather than an exotic one.

      const own = runtime;
      const flowless = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        // Enforcement on, flow labels off: a conforming pair, and the one
        // the mistake was invisible at.
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "off",
      });
      try {
        const db = labeledDb();
        await seedMessages(db, elsewhere);

        const handleTx = flowless.edit();
        const handle = flowless.getCell<SqliteDbRef>(
          elsewhere,
          "foreign handle for flowless",
          undefined,
          handleTx,
        );
        handle.set(db);
        expect((await handleTx.commit()).error).toBeUndefined();

        const paramTx = flowless.edit();
        const container = flowless.getCell<string>(space, "flowless choice", {
          type: "string",
          ifc: { confidentiality: KEY_CLAUSE },
          // deno-lint-ignore no-explicit-any -- a schema literal with `ifc`
        } as any, paramTx);
        container.set("c-alpha");
        expect((await paramTx.commit()).error).toBeUndefined();

        const { commonfabric: cf } = createTrustedBuilder(flowless);
        const testPattern = cf.pattern<{ db: unknown; container: string }>((
          { db: handleInput, container: chosen },
        ) =>
          cf.sqliteQuery(
            {
              db: handleInput,
              sql: "SELECT container_id FROM messages WHERE container_id = ?1",
              params: [chosen],
              // deno-lint-ignore no-explicit-any -- the input is untyped
            } as any,
          )
        );

        const tx = flowless.edit();
        const resultCell = flowless.getCell(
          space,
          "flowless-foreign",
          testPattern.resultSchema,
          tx,
        );
        const result = flowless.run(
          tx,
          testPattern,
          // deno-lint-ignore no-explicit-any -- cells stand in for arguments
          { db: handle, container: container as any },
          resultCell,
        );
        flowless.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();

        const refused = await waitForCellValue<QueryState<KeyRow>>(
          flowless,
          // deno-lint-ignore no-explicit-any -- the builtin's state
          result as Cell<any>,
          (value) => typeof value?.error === "string",
        );
        expect(refused.error).toBe(SQLITE_FOREIGN_SPACE_REFUSAL);
        expect(refused.result ?? []).toEqual([]);
      } finally {
        await flowless.dispose({ closeStorage: false });
        runtime = own;
      }
    });

    it("issues again once its own result has carried a label", async () => {
      // What the refusal must measure is the label THIS request's inputs
      // carry, not everything the transaction has touched. A cross-space
      // query's own settled result carries the labels of the columns it
      // projected, and the next issue reads that result to decide whether
      // its writeback is stale — so a check over the transaction's whole
      // consumed set refuses every issue after the first, whatever the
      // parameters are, and the node is dead with a message about a label
      // that is not in its request.

      const db = labeledDb();
      await seedMessages(db, elsewhere);

      const handleTx = runtime.edit();
      const handle = runtime.getCell<SqliteDbRef>(
        elsewhere,
        "foreign handle for re-issue",
        undefined,
        handleTx,
      );
      handle.set(db);
      expect((await handleTx.commit()).error).toBeUndefined();

      // Its own transaction: one transaction holds a writer for one space.
      const choiceTx = runtime.edit();
      const container = runtime.getCell<string>(
        space,
        "container choice",
        { type: "string" },
        choiceTx,
      );
      container.set("c-alpha");
      expect((await choiceTx.commit()).error).toBeUndefined();

      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const testPattern = cf.pattern<{ db: unknown; container: string }>((
        { db: handleInput, container: chosen },
      ) =>
        cf.sqliteQuery(
          {
            db: handleInput,
            sql: "SELECT container_id FROM messages WHERE container_id = ?1",
            params: [chosen],
            // deno-lint-ignore no-explicit-any -- the input is untyped
          } as any,
        )
      );

      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "foreign-reissue",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        // deno-lint-ignore no-explicit-any -- cells stand in for the arguments
        { db: handle, container: container as any },
        resultCell,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();

      // deno-lint-ignore no-explicit-any -- the builtin's state
      const rows = result as Cell<any>;
      const first = await waitForCellValue<QueryState<KeyRow>>(
        runtime,
        rows,
        (value) => (value?.result ?? []).length === 2,
      );
      expect(first.error).toBeUndefined();

      // The parameter is a plain string this test writes: nothing labeled is
      // read on the way to the second request.
      const again = runtime.edit();
      container.withTx(again).set("c-beta");
      expect((await again.commit()).error).toBeUndefined();

      const second = await waitForCellValue<QueryState<KeyRow>>(
        runtime,
        rows,
        (value) => (value?.result ?? []).length === 1,
      );
      expect(second.error).toBeUndefined();
      expect(second.result).toEqual([{ container_id: "c-beta" }]);
    });
  });
});
