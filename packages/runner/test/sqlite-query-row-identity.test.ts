import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { URI } from "@commonfabric/memory/interface";
import type { SqliteDbRef, SqliteParamsWire } from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { createBuilder } from "../src/builder/factory.ts";
import type { Cell } from "../src/cell.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type QueryState = {
  pending: boolean;
  result?: Array<{ id: number; body: string }>;
  error?: unknown;
  requestHash?: string;
};

/** One entity write the server was asked to commit: its op and the entity. */
type WrittenOp = { op: string; id: string };

const NOTES_SQL = "SELECT id, body FROM notes ORDER BY id";

/** The `notes` table with no column labeled. */
const plainTables = {
  notes: table({ id: "integer primary key", body: "text" }),
};

/** The `notes` table with `body` labeled, as a stricter re-declaration. */
const labeledTables = {
  notes: table({
    id: "integer primary key",
    body: {
      type: "string",
      sqlType: "text",
      ifc: { confidentiality: ["secret"] },
    },
  }),
};

describe("sqlite-query-row-identity", () => {
  // Every commit a runtime sends crosses the loopback transport as a frame the
  // server's own parser understands, so the frames are read there, ahead of
  // the server, and every `transact` frame's operations are kept in order.
  // That is the record the cases below measure the write-back against: which
  // entities a run wrote, and which of them nothing had written before.

  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let signer: Identity;
  let space: `did:${string}:${string}`;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  let written: WrittenOp[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`rowid-${crypto.randomUUID()}`);
    space = signer.did();
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    written = [];
    const connect = server.connect.bind(server);
    server.connect = (send) => {
      const connection = connect(send);
      const receive = connection.receive.bind(connection);
      connection.receive = (payload: string) => {
        const message = MemoryV2Server.parseClientMessage(payload);
        if (message?.type === "transact") {
          for (const operation of message.commit.operations) {
            if ("id" in operation) {
              written.push({ op: operation.op, id: operation.id });
            }
          }
        }
        return receive(payload);
      };
      return connection;
    };
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    await server?.close();
  });

  /** Runs one folded `sqlite` write against `db` through its own commit. */
  const execSqlite = async (
    db: SqliteDbRef,
    sql: string,
    params?: SqliteParamsWire,
  ): Promise<void> => {
    const tx = runtime.edit();
    tx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    const res = await tx.commit();
    if (res.error) throw res.error;
  };

  /**
   * A piece running one query over `db`, re-issued whenever `tick` changes.
   * `db` is the handle itself or a cell holding it, so a case can re-declare
   * the handle under a running query. Returns the piece's result cell and the
   * tick cell that drives the re-run.
   */
  const runQuery = async (
    db: SqliteDbRef | Cell<SqliteDbRef>,
    label: string,
    sql = NOTES_SQL,
  ) => {
    const tx = runtime.edit();
    const tick = runtime.getCell<number>(space, `${label}-tick`, undefined, tx);
    tick.set(0);
    const queryPattern = cf.pattern<{ tick: number; db: SqliteDbRef }>(
      ({ tick, db }) =>
        cf.sqliteQuery({
          db,
          sql,
          reactOn: tick,
          // The raw handle object stands in for a `sqliteDatabase` result here.
          // deno-lint-ignore no-explicit-any
        } as any),
    );
    const result = runtime.run(
      tx,
      queryPattern,
      { tick, db },
      runtime.getCell(space, `${label}-result`, queryPattern.resultSchema, tx),
    );
    await tx.commit();
    return { result, tick };
  };

  /** Waits for the query to settle under a request hash other than `after`. */
  const settledPast = (
    result: ReturnType<Runtime["getCell"]>,
    after: string | undefined,
  ) =>
    waitForCellValue<QueryState>(
      runtime,
      result,
      (v) => v?.pending === false && v.requestHash !== after,
    );

  /** Bumps `tick` so the query re-runs, and waits for that run to settle. */
  const rerun = async (
    result: ReturnType<Runtime["getCell"]>,
    tick: ReturnType<Runtime["getCell"]>,
    previous: QueryState,
  ): Promise<QueryState> => {
    const tx = runtime.edit();
    tick.withTx(tx).set((tick.withTx(tx).get() as number) + 1);
    await tx.commit();
    const state = await settledPast(result, previous.requestHash);
    await runtime.settled();
    return state;
  };

  /** The entity each stored result row links to, in row order. */
  const rowDocIds = (result: ReturnType<Runtime["getCell"]>): string[] => {
    const raw = result.key("result").getRaw() as unknown[];
    return raw.map((entry) => {
      const link = parseLink(entry as Parameters<typeof parseLink>[0], result);
      if (!link?.id) throw new Error("a result row is stored inline");
      return link.id;
    });
  };

  /**
   * The confidentiality atoms the row document `id` carries at `body`, read
   * off the document's own stored label under a transaction of its own.
   */
  const bodyConfidentiality = async (
    id: string,
  ): Promise<readonly unknown[]> => {
    const tx = runtime.edit();
    const row = runtime.getCellFromLink(
      { space, id: id as URI, path: [] },
      undefined,
      tx,
    );
    const atoms = cfcConfidentialityForObservationNode({
      labelView: cfcLabelViewForCell(row),
      logicalPath: ["body"],
    });
    await tx.commit();
    return atoms;
  };

  const seededDb = async (
    tables = plainTables,
    rows = "(1, 'a'), (2, 'b'), (3, 'c')",
  ): Promise<SqliteDbRef> => {
    const db: SqliteDbRef = { id: `of:rowid-${crypto.randomUUID()}`, tables };
    await execSqlite(db, `INSERT INTO notes (id, body) VALUES ${rows}`);
    return db;
  };

  it("re-runs over unchanged rows without minting or writing a row document", async () => {
    const db = await seededDb();
    const { result, tick } = await runQuery(db, "unchanged");
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual([
      { id: 1, body: "a" },
      { id: 2, body: "b" },
      { id: 3, body: "c" },
    ]);
    const rowsBefore = rowDocIds(result);
    expect(rowsBefore).toHaveLength(3);
    const known = new Set(written.map((w) => w.id));
    const mark = written.length;

    const second = await rerun(result, tick, first);
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual(first.result);

    const secondRun = written.slice(mark);
    expect(rowDocIds(result)).toEqual(rowsBefore);
    expect(secondRun.filter((w) => rowsBefore.includes(w.id))).toEqual([]);
    expect(secondRun.filter((w) => !known.has(w.id))).toEqual([]);
  });

  it("writes only the changed row's document when one row changes", async () => {
    const db = await seededDb();
    const { result, tick } = await runQuery(db, "changed");
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    const rowsBefore = rowDocIds(result);
    const known = new Set(written.map((w) => w.id));
    const mark = written.length;

    await execSqlite(db, "UPDATE notes SET body = 'B' WHERE id = 2");
    const second = await rerun(result, tick, first);
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual([
      { id: 1, body: "a" },
      { id: 2, body: "B" },
      { id: 3, body: "c" },
    ]);

    const rowsAfter = rowDocIds(result);
    expect(rowsAfter[0]).toBe(rowsBefore[0]);
    expect(rowsAfter[1]).not.toBe(rowsBefore[1]);
    expect(rowsAfter[2]).toBe(rowsBefore[2]);
    const secondRun = written.slice(mark);
    const rowWrites = secondRun.filter((w) =>
      rowsBefore.includes(w.id) || rowsAfter.includes(w.id)
    );
    expect(rowWrites.map((w) => w.id)).toEqual([rowsAfter[1]]);
    expect(
      secondRun.filter((w) => !known.has(w.id) && w.id !== rowsAfter[1]),
    ).toEqual([]);
  });

  it("links a row whose content returns to the document it had before", async () => {
    const db = await seededDb();
    const { result, tick } = await runQuery(db, "returning");
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    const rowsBefore = rowDocIds(result);

    await execSqlite(db, "UPDATE notes SET body = 'B' WHERE id = 2");
    const second = await rerun(result, tick, first);
    expect(second.error).toBeUndefined();
    expect(rowDocIds(result)[1]).not.toBe(rowsBefore[1]);
    const known = new Set(written.map((w) => w.id));
    const mark = written.length;

    await execSqlite(db, "UPDATE notes SET body = 'b' WHERE id = 2");
    const third = await rerun(result, tick, second);
    expect(third.error).toBeUndefined();
    expect(third.result).toEqual(first.result);

    const thirdRun = written.slice(mark);
    expect(rowDocIds(result)).toEqual(rowsBefore);
    expect(thirdRun.filter((w) => rowsBefore.includes(w.id))).toEqual([]);
    expect(thirdRun.filter((w) => !known.has(w.id))).toEqual([]);
  });

  it("stores two rows of equal content as one document", async () => {
    const db = await seededDb(plainTables, "(1, 'a'), (2, 'a'), (3, 'c')");
    const { result } = await runQuery(
      db,
      "equal",
      "SELECT body FROM notes ORDER BY id",
    );
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual([{ body: "a" }, { body: "a" }, { body: "c" }]);

    const rows = rowDocIds(result);
    expect(rows[0]).toBe(rows[1]);
    expect(rows[2]).not.toBe(rows[0]);
    expect(written.filter((w) => w.id === rows[0])).toHaveLength(1);
  });

  it({
    name:
      "writes no document of a column-labeled result whose rows move to other positions",
    sanitizeResources: false,
  }, async () => {
    // A labeled handle has the server load the column-metadata library, which
    // stays loaded for the life of the process, so this case is exempt from
    // the dynamic-library leak check. The rows are ordered by `body`, so
    // rewriting one row's body moves it to the front and every other row to
    // another position. The rewritten row is new content and gets a document
    // of its own; the two rows that only moved keep theirs.

    const db = await seededDb(labeledTables);
    const { result, tick } = await runQuery(
      db,
      "labeled-reorder",
      "SELECT id, body FROM notes ORDER BY body",
    );
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual([
      { id: 1, body: "a" },
      { id: 2, body: "b" },
      { id: 3, body: "c" },
    ]);
    const rowsBefore = rowDocIds(result);
    const known = new Set(written.map((w) => w.id));
    const mark = written.length;

    await execSqlite(db, "UPDATE notes SET body = 'A' WHERE id = 3");
    const second = await rerun(result, tick, first);
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual([
      { id: 3, body: "A" },
      { id: 1, body: "a" },
      { id: 2, body: "b" },
    ]);

    const rowsAfter = rowDocIds(result);
    expect(rowsAfter.slice(1)).toEqual(rowsBefore.slice(0, 2));
    expect(rowsBefore).not.toContain(rowsAfter[0]);
    const secondRun = written.slice(mark);
    expect(secondRun.filter((w) => rowsBefore.includes(w.id))).toEqual([]);
    expect(secondRun.filter((w) => !known.has(w.id)).map((w) => w.id))
      .toEqual([rowsAfter[0]]);
  });

  it({
    name: "stores two column-labeled rows of equal content as one document",
    sanitizeResources: false,
  }, async () => {
    // A labeled handle has the server load the column-metadata library, which
    // stays loaded for the life of the process, so this case is exempt from
    // the dynamic-library leak check.

    const db = await seededDb(labeledTables, "(1, 'a'), (2, 'a'), (3, 'c')");
    const { result } = await runQuery(
      db,
      "labeled-equal",
      "SELECT body FROM notes ORDER BY id",
    );
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual([{ body: "a" }, { body: "a" }, { body: "c" }]);

    const rows = rowDocIds(result);
    expect(rows[0]).toBe(rows[1]);
    expect(rows[2]).not.toBe(rows[0]);
    expect(written.filter((w) => w.id === rows[0])).toHaveLength(1);
  });

  it({
    name:
      "leaves the document of a column-labeled row standing once no result holds it",
    sanitizeResources: false,
  }, async () => {
    // A labeled handle has the server load the column-metadata library, which
    // stays loaded for the life of the process, so this case is exempt from
    // the dynamic-library leak check. A row document is written once: a row whose data changed is another document,
    // and the one it had stays as it was, for a reader who retained a
    // reference to it. Nothing collects it, so the count of row documents a
    // result cell has written grows by one per distinct row it ever held.

    const db = await seededDb(labeledTables);
    const { result, tick } = await runQuery(db, "labeled-growth");
    let state = await settledPast(result, undefined);
    await runtime.settled();
    expect(state.error).toBeUndefined();
    const rowDocuments = new Set(rowDocIds(result));
    expect(rowDocuments.size).toBe(3);

    for (const body of ["B1", "B2", "B3"]) {
      await execSqlite(db, "UPDATE notes SET body = ? WHERE id = 2", [body]);
      state = await rerun(result, tick, state);
      expect(state.error).toBeUndefined();
      for (const id of rowDocIds(result)) rowDocuments.add(id);
    }

    expect(rowDocIds(result)).toHaveLength(3);
    expect(rowDocuments.size).toBe(6);
    for (const id of rowDocuments) {
      expect(written.filter((w) => w.id === id)).toHaveLength(1);
    }
  });

  it({
    name:
      "moves a row whose label changes under unchanged content to a document carrying the new label",
    sanitizeResources: false,
  }, async () => {
    // A labeled handle has the server load the column-metadata library, which
    // stays loaded for the life of the process, so this case is exempt from
    // the dynamic-library leak check. The handle is re-declared with `body`
    // labeled while the query runs, as a stricter re-declaration of a column
    // is allowed to do; the rows read back identical, and only the label they
    // are written under differs.

    const db = await seededDb();
    const tx = runtime.edit();
    const handle = runtime.getCell<SqliteDbRef>(
      space,
      "relabel-handle",
      undefined,
      tx,
    );
    handle.set(db);
    await tx.commit();
    const { result, tick } = await runQuery(handle, "relabel");
    const first = await settledPast(result, undefined);
    await runtime.settled();
    expect(first.error).toBeUndefined();
    const rowsBefore = rowDocIds(result);
    const mark = written.length;

    const relabel = runtime.edit();
    handle.withTx(relabel).set({ ...db, tables: labeledTables });
    await relabel.commit();
    const second = await rerun(result, tick, first);
    expect(second.error).toBeUndefined();
    expect(second.result).toEqual(first.result);

    const rowsAfter = rowDocIds(result);
    expect(rowsAfter.filter((id) => rowsBefore.includes(id))).toEqual([]);
    const secondRun = written.slice(mark);
    expect(secondRun.filter((w) => rowsBefore.includes(w.id))).toEqual([]);
    for (const id of rowsAfter) {
      expect(secondRun.map((w) => w.id)).toContain(id);
    }
    for (const id of rowsAfter) {
      expect(await bodyConfidentiality(id)).toContainEqual("secret");
    }
  });
});
