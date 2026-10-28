/**
 * The ceiling `sqliteQuery`'s control state is measured against when a query
 * parameter is read out of a labeled row.
 *
 * A request hash is a function of the parameters, so a parameter derived from
 * a labeled read taints the transaction that claims the request —
 * `{pending, requestHash}` — as surely as it taints the rows. The claim rides
 * the requesting run's own commit, so there is no transaction in which such a
 * parameter is untainted, and an author cannot know which atoms a given
 * transaction will carry. The runtime-owned control paths carry the
 * transaction's join in their derived component. The builtin refuses a
 * request carrying confidentiality bound for a database in another space
 * before it is staged, and declares the membership of a shared result.
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
import { defer } from "@commonfabric/utils/defer";

import {
  SQLITE_FOREIGN_SPACE_REFUSAL,
} from "../src/builtins/sqlite-builtins.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
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
  observes?: string;
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
      // defaults. Declared monotonicity remains enforced while the control
      // state's derived labels follow each issue's reads.
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
    expect((await tx.commit().settled).error).toBeUndefined();
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

  /** All confidentiality atoms declared at `path`. */
  const declaredAt = (cell: Cell<unknown>, path: string[]): unknown[] =>
    storedEntries(cell)
      .filter((entry) =>
        entry.origin === "declared" &&
        entry.path.length === path.length &&
        entry.path.every((segment, i) => segment === path[i])
      )
      .flatMap((entry) => entry.label.confidentiality ?? []);

  /** All confidentiality atoms derived for one observation class at `path`. */
  const derivedAt = (
    cell: Cell<unknown>,
    path: string[],
    observes: "value" | "shape" = "value",
  ): unknown[] =>
    storedEntries(cell)
      .filter((entry) =>
        entry.origin === "derived" && entry.observes === observes &&
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
   * The confidentiality a reader of `path` in the query's state carries: the
   * join of that one read, off a transaction then abandoned.
   */
  const readerCarries = (
    // deno-lint-ignore no-explicit-any -- the builtin's state
    state: Cell<any>,
    path: readonly string[],
  ): unknown[] => {
    const tx: IExtendedStorageTransaction = runtime.edit();
    try {
      let cell = state.resolveAsCell().withTx(tx);
      for (const segment of path) cell = cell.key(segment);
      cell.get();
      return deriveFlowJoin(tx).confidentiality;
    } finally {
      tx.abort("observation only");
    }
  };

  /**
   * The result's top: its length, which a reader takes without opening a
   * row, and which carries what the membership does.
   */
  const RESULT_TOP = ["result", "length"];

  /** The atoms of `atoms` that are not among `others`. */
  const atomsBeyond = (
    atoms: readonly unknown[],
    others: readonly unknown[],
  ): unknown[] =>
    atoms.filter((atom) =>
      !others.some((held) => canonical(held) === canonical(atom))
    );

  /**
   * Runs `before` ahead of every query the provider is handed, and sends
   * the query once it resolves. The builtin hands a request over from the
   * flush of the transaction that claimed it, so a request arriving here
   * is a claim that has committed.
   */
  const beforeEachQuery = (
    before: (
      sql: string,
      params: SqliteParamsWire | undefined,
    ) => Promise<void> | void,
  ) => {
    const provider = runtime.storageManager.open(space);
    const send = provider.sqliteQuery!.bind(provider);
    provider.sqliteQuery = async (db, sql, params, reader) => {
      await before(sql, params);
      return await send(db, sql, params, reader);
    };
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
    expect((await tx.commit().settled).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state, as it writes it
    return { bodies: result.key("bodies") as Cell<any> };
  };

  /**
   * One query node whose parameter is read out of one of three differently
   * labeled columns of the same row, the one `pick` names. The row count
   * says which parameter the query ran with: two rows under `first` and
   * under `third`, one under `second`.
   */
  const runPickedParameterPattern = async (cause: string) => {
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
    // Reads ONE query's rows, chosen by `pick`. A branch the lift does not
    // take is a result it does not read, which is what keeps each issue's
    // join down to the one clause this step is about.
    const parameterOf = parameterLift((input) => {
      const { keys, pick } = input as {
        keys?: QueryState<Record<string, string>>[];
        pick?: number;
      };
      const index = pick === 0 ? 0 : pick === 1 ? 1 : 2;
      const row = keys?.[index]?.result?.[0];
      return String(row?.[`k${index + 1}`] ?? "");
    });
    const testPattern = cf.pattern<{ pick: number }>(({ pick }) => {
      const keys = ["k1", "k2", "k3"].map((name) =>
        cf.sqliteQuery.asScope("session")(
          {
            db,
            reactOn: db,
            sql: `SELECT ${name} FROM messages ORDER BY id`,
            // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
          } as any,
        )
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
    const pick = runtime.getCell<number>(space, `${cause}-pick`, {
      type: "number",
    }, tx);
    pick.set(0);
    const resultCell = runtime.getCell(
      space,
      cause,
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
    expect((await tx.commit().settled).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state, as it writes it
    const bodies = result.key("bodies") as Cell<any>;

    const rowsFor = (expected: number) =>
      waitForCellValue<QueryState<BodyRow>>(
        runtime,
        bodies,
        (value) => (value?.result ?? []).length === expected,
      );

    return { pick, bodies, rowsFor, first, second, third };
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

  it("derives the parameter's clause on the request hash", async () => {
    // `/requestHash` rather than `/pending` because of which writes touch
    // which path. The hash moves on every issue, so every labeled issue
    // writes its derived component. The flag is written only by a claim that
    // finds it down, and whether this fixture's labeled claim does is the
    // order two settles landed in. The reader cases below decide that order.

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
    expect(hasClause(derivedAt(bodies, ["requestHash"]), KEY_CLAUSE))
      .toBe(true);
    expect(declaredAt(bodies, ["requestHash"])).toEqual([]);
  });

  it("declares nothing on the control paths of a literal-parameter query", async () => {
    // The control. A literal parameter reads nothing labeled, so the issue
    // transaction carries no clause to stamp on the control paths.

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
    expect(hasClause(derivedAt(bodies, ["requestHash"]), KEY_CLAUSE))
      .toBe(false);
    expect(declaredAt(bodies, ["requestHash"])).toEqual([]);
  });

  it("settles a query whose parameter is labeled from its first issue", async () => {
    // The cases above read the parameter out of a first query's rows, so the
    // first issue runs with an empty, unlabeled parameter and the labeled one
    // comes later. A pane opened with a pick already stored issues labeled
    // from the start: the transaction that CREATES the result store then
    // carries the parameter's clause, and the settle that writes the rows
    // must still carry nothing of its own. It carried that clause through
    // the store's own link resolution, so every row was refused at its root.

    const db = labeledDb();
    await seedMessages(db);
    const seedTx = runtime.edit();
    const picked = runtime.getCell<string>(space, "first-issue-picked", {
      type: "string",
      ifc: { confidentiality: KEY_CLAUSE },
      // deno-lint-ignore no-explicit-any -- `ifc` is not on the schema type
    } as any, seedTx);
    picked.set("c-alpha");
    expect((await seedTx.commit().settled).error).toBeUndefined();

    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const parameterOf = parameterLift((pick) => String(pick ?? ""));
    const testPattern = cf.pattern<{ picked: string }>(({ picked }) => {
      const bodies = cf.sqliteQuery.asScope("session")(
        // deno-lint-ignore no-explicit-any -- the builtin's input is untyped
        {
          db,
          reactOn: db,
          sql: BODIES_SQL,
          params: parameterOf(picked),
        } as any,
      );
      return { bodies };
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "first-issue",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      // deno-lint-ignore no-explicit-any -- a cell stands in for the argument
      { picked: picked as any },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    // deno-lint-ignore no-explicit-any -- the builtin's state, as it writes it
    const bodies = result.key("bodies") as Cell<any>;

    const state = await waitForCellValue<QueryState<BodyRow>>(
      runtime,
      bodies,
      (value) =>
        (value?.result ?? []).length === 2 || value?.error !== undefined,
    );
    expect(state.error).toBeUndefined();
    expect(state.pending).toBe(false);
    expect(state.result).toEqual([{ body: "first" }, { body: "second" }]);
    // The first issue did carry the parameter's clause, which is what makes
    // this a different case from the ones above.
    expect(hasClause(derivedAt(bodies, ["requestHash"]), KEY_CLAUSE))
      .toBe(true);
    // The rows are the columns' to label, at the root as at the column: a
    // fix that declared the parameter's clause on each row would settle this
    // query too.
    const row = bodies.key("result").key(0) as Cell<unknown>;
    expect(hasClause(declaredAt(row, []), KEY_CLAUSE)).toBe(false);
    expect(hasClause(declaredAt(row, ["body"]), KEY_CLAUSE)).toBe(false);
    expect(hasClause(declaredAt(row, ["body"]), BODY_CLAUSE)).toBe(true);
  });

  describe("a shared result", () => {
    // Space scope, where one materialization serves every reader of the
    // space. `sqlite-query-row-set-members.test.ts` covers the same
    // declaration on a session-scoped result.

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
      expect((await tx.commit().settled).error).toBeUndefined();
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
      // membership and not the row. The write schema declares `/body`, so
      // runtime ownership cannot admit a misfit there.

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

  it("replaces the hash's value label while retaining parameter existence labels", async () => {
    // Three issues read separately projected, differently labeled columns.
    // The parameter's existence carries the first clause throughout. Its
    // value's second clause leaves the third issue's join, and the hash's
    // derived value label follows that join.

    const { pick, bodies, rowsFor, first, second, third } =
      await runPickedParameterPattern("ratchet");

    await rowsFor(2);
    expect(hasClause(derivedAt(bodies, ["requestHash"]), first)).toBe(true);
    expect(hasClause(derivedAt(bodies, ["requestHash"]), second)).toBe(false);
    expect(hasClause(derivedAt(bodies, ["requestHash"]), third)).toBe(false);

    const pickSecond = runtime.edit();
    pick.withTx(pickSecond).set(1);
    expect((await pickSecond.commit().settled).error).toBeUndefined();
    await rowsFor(1);
    expect(hasClause(derivedAt(bodies, ["requestHash"]), first)).toBe(true);
    expect(hasClause(derivedAt(bodies, ["requestHash"]), second)).toBe(true);
    expect(hasClause(derivedAt(bodies, ["requestHash"]), third)).toBe(false);

    const pickThird = runtime.edit();
    pick.withTx(pickThird).set(2);
    expect((await pickThird.commit().settled).error).toBeUndefined();
    await rowsFor(2);
    const held = derivedAt(bodies, ["requestHash"]);
    expect(hasClause(held, first)).toBe(true);
    expect(hasClause(held, second)).toBe(false);
    expect(hasClause(held, third)).toBe(true);
    const existence = derivedAt(bodies, ["requestHash"], "shape");
    expect(hasClause(existence, first)).toBe(true);
    expect(hasClause(existence, second)).toBe(false);
    expect(hasClause(existence, third)).toBe(false);
    expect(declaredAt(bodies, ["requestHash"])).toEqual([]);
  });

  describe("what a reader of the control state carries", () => {
    // A reader consumes both value and frozen existence labels. A clean
    // settle replaces the pending flag's value label, while the shape entry
    // keeps a labeled claim's influence. Holding a request at the provider
    // fixes the claims' order without depending on elapsed time.

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
      return await tx.commit().settled;
    };

    /**
     * Settles the derived-parameter query with its labeled claim having
     * raised the flag. The first query is held at the provider until the
     * issue with the empty parameter has settled, so the labeled claim finds
     * the flag down and writes it with the parameter's derived label.
     */
    const settledOverARaisedFlag = async (cause: string) => {
      const db = labeledDb();
      await seedMessages(db);
      const unlabeledIssueSettled = defer();
      beforeEachQuery(async (sql) => {
        if (sql === KEYS_SQL) await unlabeledIssueSettled.promise;
      });
      const { bodies } = await runDerivedParameterPattern(db, cause);
      // On the sink rather than through `waitForCellValue()`: the held
      // request is work the runtime is waiting on, so a wait that idles the
      // runtime first would wait on the request this releases.
      const cancel = bodies.sink((value: QueryState<BodyRow> | undefined) => {
        if (value?.pending === false) unlabeledIssueSettled.resolve();
      });
      await waitForCellValue<QueryState<BodyRow>>(
        runtime,
        bodies,
        (value) => (value?.result ?? []).length === 2,
      );
      cancel();
      return bodies;
    };

    it("commits a write from a reader of a pending flag no labeled issue raised", async () => {
      // The issue with the empty parameter is held at the provider until the
      // labeled one has claimed, so the labeled claim finds the flag up. A
      // write of the value a path already holds is no write, which leaves
      // the labeled transaction stamping the hash it moved and nowhere
      // else. The held issue then settles nothing, because the store records
      // another request's hash.

      const db = labeledDb();
      await seedMessages(db);
      const labeledIssueClaimed = defer();
      beforeEachQuery(async (sql, params) => {
        if (sql !== BODIES_SQL) return;
        if ((params as unknown[])[0] === "") await labeledIssueClaimed.promise;
        else labeledIssueClaimed.resolve();
      });
      const { bodies } = await runDerivedParameterPattern(
        db,
        "reader-pending-standing",
      );
      await waitForCellValue<QueryState<BodyRow>>(
        runtime,
        bodies,
        (value) => (value?.result ?? []).length === 2,
      );

      expect(hasClause(derivedAt(bodies, ["requestHash"]), KEY_CLAUSE))
        .toBe(true);
      expect(hasClause(derivedAt(bodies, ["pending"]), KEY_CLAUSE))
        .toBe(false);
      const wrote = await readIntoAnUndeclaredStore(
        bodies,
        "pending",
        "reader-pending-standing-probe",
      );
      expect(wrote.error).toBeUndefined();
    });

    it("refuses a reader's write while a labeled claim holds the flag raised", async () => {
      const db = labeledDb();
      await seedMessages(db);
      const unlabeledSettled = defer();
      const labeledClaimed = defer();
      const releaseLabeled = defer();
      beforeEachQuery(async (sql, params) => {
        if (sql === KEYS_SQL) await unlabeledSettled.promise;
        if (sql === BODIES_SQL && (params as unknown[])[0] !== "") {
          labeledClaimed.resolve();
          await releaseLabeled.promise;
        }
      });
      const { bodies } = await runDerivedParameterPattern(
        db,
        "reader-pending-in-flight",
      );
      const cancel = bodies.sink((value: QueryState<BodyRow> | undefined) => {
        if (value?.pending === false) unlabeledSettled.resolve();
      });
      try {
        await labeledClaimed.promise;
        expect(bodies.get()?.pending).toBe(true);
        expect(hasClause(derivedAt(bodies, ["pending"]), KEY_CLAUSE))
          .toBe(true);
        expect(declaredAt(bodies, ["pending"])).toEqual([]);
        const wrote = await readIntoAnUndeclaredStore(
          bodies,
          "pending",
          "reader-pending-in-flight-probe",
        );
        expect(wrote.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
      } finally {
        releaseLabeled.resolve();
        cancel();
      }
    });

    it("keeps the pending flag's existence label after a clean settle", async () => {
      // The clean settle replaces the value label. Its frozen shape entry
      // still taints a reader of the flag, without declaring a store policy.

      const bodies = await settledOverARaisedFlag("reader-pending-raised");

      expect(hasClause(derivedAt(bodies, ["pending"]), KEY_CLAUSE))
        .toBe(false);
      expect(declaredAt(bodies, ["pending"])).toEqual([]);
      expect(hasClause(derivedAt(bodies, ["pending"], "shape"), KEY_CLAUSE))
        .toBe(true);
      const wrote = await readIntoAnUndeclaredStore(
        bodies,
        "pending",
        "reader-pending-raised-probe",
      );
      expect(wrote.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
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

      // The hash's derived label still taints its reader, so a store that
      // declares nothing cannot hold what this one read.
      const wrote = await readIntoAnUndeclaredStore(
        bodies,
        "requestHash",
        "reader-hash-probe",
      );
      expect(wrote.error).toBeDefined();
    });

    describe("the pending flag against the result's top", () => {
      // A clean completion clears the pending flag's value label. Its
      // frozen existence label still records the labeled claim. The
      // result's membership carries only issues that actually settled rows.

      it("carries no clause on a raised flag that the result's length lacks", async () => {
        const bodies = await settledOverARaisedFlag("bound-raised");

        const flag = readerCarries(bodies, ["pending"]);
        const top = readerCarries(bodies, RESULT_TOP);
        expect(hasClause(flag, KEY_CLAUSE)).toBe(true);
        expect(atomsBeyond(flag, top)).toEqual([]);
        // The projected column's clause is on the top and not on the flag.
        expect(atomsBeyond(BODY_CLAUSE, top)).toEqual([]);
        expect(atomsBeyond(BODY_CLAUSE, flag)).toEqual([BODY_CLAUSE[1]]);
      });

      it("carries no clause that the result's length lacks after three labeled issues", async () => {
        // The second and third issues each follow a settle, so each finds
        // the flag down and raises it.

        const { pick, bodies, rowsFor, second, third } =
          await runPickedParameterPattern("bound-accumulated");
        await rowsFor(2);
        for (const [picked, rows] of [[1, 1], [2, 2]] as const) {
          const tx = runtime.edit();
          pick.withTx(tx).set(picked);
          expect((await tx.commit().settled).error).toBeUndefined();
          await rowsFor(rows);
        }

        const flag = readerCarries(bodies, ["pending"]);
        const top = readerCarries(bodies, RESULT_TOP);
        expect(hasClause(flag, second)).toBe(true);
        expect(hasClause(flag, third)).toBe(false);
        expect(derivedAt(bodies, ["pending"])).toEqual([]);
        expect(declaredAt(bodies, ["pending"])).toEqual([]);
        expect(atomsBeyond(flag, top)).toEqual([]);
        expect(atomsBeyond(BODY_CLAUSE, top)).toEqual([]);
        expect(atomsBeyond(BODY_CLAUSE, flag)).toEqual([BODY_CLAUSE[1]]);
      });

      it("keeps a superseded claim's existence label off the result's membership", async () => {
        // The second issue raises the flag and is held until the third
        // claims it. Only the third settles rows. The flag's frozen shape
        // entry keeps the second clause, while the result never receives it.

        const { pick, bodies, rowsFor, second } =
          await runPickedParameterPattern("bound-superseded");
        await rowsFor(2);
        const secondClaimed = defer();
        const thirdClaimed = defer();
        beforeEachQuery(async (sql, params) => {
          if (sql !== BODIES_SQL) return;
          if ((params as unknown[])[0] === "c-beta") {
            secondClaimed.resolve();
            await thirdClaimed.promise;
          } else {
            thirdClaimed.resolve();
          }
        });
        // Nothing else reads the query between the two picks, and a query
        // nothing reads issues nothing.
        const cancel = bodies.sink(() => {});
        const pickSecond = runtime.edit();
        pick.withTx(pickSecond).set(1);
        expect((await pickSecond.commit().settled).error).toBeUndefined();
        await secondClaimed.promise;
        const pickThird = runtime.edit();
        pick.withTx(pickThird).set(2);
        expect((await pickThird.commit().settled).error).toBeUndefined();
        await rowsFor(2);
        cancel();

        const flag = readerCarries(bodies, ["pending"]);
        const top = readerCarries(bodies, RESULT_TOP);
        expect(hasClause(flag, second)).toBe(true);
        expect(derivedAt(bodies, ["pending"])).toEqual([]);
        expect(declaredAt(bodies, ["pending"])).toEqual([]);
        expect(hasClause(top, second)).toBe(false);
        expect(atomsBeyond(flag, top)).toEqual([second[1]]);
      });

      it("keeps a failed claim's existence label off the result's membership", async () => {
        // A failure settles the pending flag cleanly and writes no rows.
        // The flag's frozen shape entry keeps the failed claim's clause;
        // the result's membership keeps the last successful issue's label.

        const { pick, bodies, rowsFor, first, second } =
          await runPickedParameterPattern("bound-failed");
        await rowsFor(2);
        beforeEachQuery((sql, params) => {
          if (sql === BODIES_SQL && (params as unknown[])[0] === "c-beta") {
            throw new Error("provider refused");
          }
        });
        const tx = runtime.edit();
        pick.withTx(tx).set(1);
        expect((await tx.commit().settled).error).toBeUndefined();
        const failed = await waitForCellValue<QueryState<BodyRow>>(
          runtime,
          bodies,
          (value) => value?.error !== undefined,
        );
        expect(failed.error).toBe("provider refused");
        expect(failed.pending).toBe(false);

        const flag = readerCarries(bodies, ["pending"]);
        const top = readerCarries(bodies, RESULT_TOP);
        expect(hasClause(flag, second)).toBe(true);
        expect(derivedAt(bodies, ["pending"])).toEqual([]);
        expect(declaredAt(bodies, ["pending"])).toEqual([]);
        expect(hasClause(top, first)).toBe(true);
        expect(atomsBeyond(second, top)).toEqual([second[1]]);
      });
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
      expect((await handleTx.commit().settled).error).toBeUndefined();

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
      expect((await tx.commit().settled).error).toBeUndefined();

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
      // clause it is refusing over. The paths it writes carry that derived
      // label, which a pattern rendering "this query was refused" inherits.
      expect(hasClause(derivedAt(bodies, ["error"]), KEY_CLAUSE)).toBe(true);
      expect(hasClause(derivedAt(bodies, ["pending"]), KEY_CLAUSE)).toBe(true);
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
      expect((await handleTx.commit().settled).error).toBeUndefined();

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
      expect((await setup.commit().settled).error).toBeUndefined();

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
      expect((await tx.commit().settled).error).toBeUndefined();

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
      expect((await relabel.commit().settled).error).toBeUndefined();

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
        expect((await handleTx.commit().settled).error).toBeUndefined();

        const paramTx = flowless.edit();
        const container = flowless.getCell<string>(space, "flowless choice", {
          type: "string",
          ifc: { confidentiality: KEY_CLAUSE },
          // deno-lint-ignore no-explicit-any -- a schema literal with `ifc`
        } as any, paramTx);
        container.set("c-alpha");
        expect((await paramTx.commit().settled).error).toBeUndefined();

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
        expect((await tx.commit().settled).error).toBeUndefined();

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
      expect((await handleTx.commit().settled).error).toBeUndefined();

      // Its own transaction: one transaction holds a writer for one space.
      const choiceTx = runtime.edit();
      const container = runtime.getCell<string>(
        space,
        "container choice",
        { type: "string" },
        choiceTx,
      );
      container.set("c-alpha");
      expect((await choiceTx.commit().settled).error).toBeUndefined();

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
      expect((await tx.commit().settled).error).toBeUndefined();

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
      expect((await again.commit().settled).error).toBeUndefined();

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
