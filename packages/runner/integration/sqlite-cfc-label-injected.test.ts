#!/usr/bin/env -S deno run -A

/**
 * Integration test (CFC Phase 2, read propagation over an INJECTED source): a
 * `db.query` whose handle arrives through a pattern INPUT link to an on-disk
 * source (03.3) labels its result exactly like a handle built in-frame does.
 *
 * The sibling label tests all build the database IN-FRAME with
 * `sqliteDatabase({ tables })` and hand it straight to `db.query`. This one
 * takes the operator's path instead: the handle is a raw `{ id, tables, rev }`
 * write at the id `deriveDiskHandleId` derives, the file is registered with the
 * server, and the handle arrives as the piece's `db` ARGUMENT — so the contract
 * reaches the builtin through an argument whose schema is the opaque `SqliteDb`
 * brand. The pattern never names the file.
 *
 * Both label arms are covered, because they fail independently: an aliased
 * column read carries its origin column's declared confidentiality, and an
 * expression over that column has a NULL origin, so it inherits the whole-db
 * union with `observes: "value"`. Each is asserted twice — STORED on the row's
 * own entity doc, and INHERITED by a consumer that reads the leaf.
 *
 * Where the labels live is itself the point. A labeled result splits each row
 * into its own entity doc and stores the label THERE; the query doc holds only
 * `{ pending, result, requestHash }` and carries no label view at any path.
 * That is true of the in-frame path too, so a probe of the query doc reports
 * "unlabeled" for a fully labeled result.
 */

import { Database } from "@db/sqlite";

import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { deriveDiskHandleId } from "../../cli/lib/sqlite-source.ts";
import app from "../../toolshed/app.ts";
import {
  cfcLabelViewForCellWithStatus,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewForResolvedCellWithStatus,
} from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import { type Cell, entityIdFrom, parseLink, Runtime } from "../src/index.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

/**
 * The contract an operator seeds for the on-disk file. TWO tables carry a
 * label, and the queries touch only `records` — which is what makes the two
 * label arms tell each other apart. An origin-attributed column carries its
 * OWN column's atom and nothing else; a null-origin column carries the union
 * of every labeled column in the db, `meta.k` included, because an expression
 * could have derived from anywhere. A fixture with one labeled atom cannot
 * distinguish them: both arms would yield the same answer.
 */
const TABLES = {
  records: {
    properties: {
      body: { type: "string", ifc: { confidentiality: ["secret-body"] } },
    },
  },
  meta: {
    properties: {
      k: { type: "string", ifc: { confidentiality: ["meta-atom"] } },
    },
  },
};

type QueryState = {
  pending?: boolean;
  error?: unknown;
  result?: unknown[];
  requestHash?: string;
};

function seedDiskDb(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT)");
  db.exec("CREATE TABLE meta (k TEXT)");
  db.exec("INSERT INTO records (body) VALUES ('top secret')");
  db.close();
}

/**
 * A stuck-condition backstop, not a bound on how long a settle may legitimately
 * take. This test holds a live client and an in-process server, so the event
 * loop never drains and Deno's "Promise resolution is still pending" fail-fast
 * cannot fire; an unsatisfied wait would hang the lane to its ambient limit
 * instead of failing it. `docs/development/waiting-in-tests.md` covers the
 * distinction, and `test/support/wait-until.ts` keeps a deadline for the same
 * reason. Sized so only a multi-minute stall reaches it.
 */
const SETTLE_BACKSTOP_MS = 60_000;

/**
 * Resolves once the query cell records a SETTLED result for a request other
 * than `superseded`. The result write raises the change the sink delivers, so
 * this waits on the event rather than polling. Reads go through `getRaw` so the
 * pattern's result schema cannot project `requestHash` away. Crossing
 * `SETTLE_BACKSTOP_MS` rejects with the query's own state, so a settle that
 * never arrives names the pending, errored, or superseded request it was
 * waiting on rather than reporting only that time ran out.
 */
function settled(query: Cell<QueryState>, superseded?: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // The sink can fire DURING `sink()` itself, before it has returned the
    // canceller, so the callback reaches it through this record rather than
    // through a binding that is still uninitialized on that first call.
    const sub: {
      done: boolean;
      cancel?: () => void;
      timer?: ReturnType<typeof setTimeout>;
    } = {
      done: false,
    };
    const stop = () => {
      sub.done = true;
      if (sub.timer !== undefined) clearTimeout(sub.timer);
      sub.cancel?.();
    };
    const check = () => {
      if (sub.done) return;
      if (query.key("pending").getRaw() !== false) return;
      if (
        superseded !== undefined &&
        query.key("requestHash").getRaw() === superseded
      ) {
        return;
      }
      stop();
      resolve();
    };
    sub.timer = setTimeout(() => {
      if (sub.done) return;
      stop();
      reject(
        new Error(
          `query never settled within ${SETTLE_BACKSTOP_MS} ms; q=` +
            JSON.stringify({
              pending: query.key("pending").getRaw(),
              error: query.key("error").getRaw(),
              requestHash: query.key("requestHash").getRaw(),
              superseded,
              result: query.key("result").getRaw(),
            }),
        ),
      );
    }, SETTLE_BACKSTOP_MS);
    sub.cancel = query.sink(check);
    if (sub.done) sub.cancel();
  });
}

/** The label a consumer INHERITS by reading `query.result[0].<column>`: the
 *  read traverses the links (pattern result -> query result -> the row's own
 *  entity doc), and the traces it accumulates carry the label back out. */
async function inheritedConfidentiality(
  runtime: Runtime,
  leaf: Cell<unknown>,
): Promise<readonly unknown[]> {
  const dtx = runtime.edit();
  leaf.withTx(dtx).get();
  const conf = cfcConfidentialityForObservationNode({
    labelView: cfcLabelViewForDereferenceTraces(
      dtx,
      dtx.getCfcState().dereferenceTraces,
    ),
    logicalPath: [],
  });
  await dtx.commit();
  return conf;
}

async function runTest(base: URL, contractArrivesLate: boolean) {
  const account = await Identity.fromPassphrase(
    "sqlite-cfc-label-injected " + crypto.randomUUID(),
  );
  const runtime = new Runtime({
    apiUrl: base,
    // Server-execution v2 posture (testing.md §2): this test serves
    // toolshed's `app.ts` IN-PROCESS (`Deno.serve` below) with NO
    // ExecutorHost, so it is a single-process harness — client and memory
    // server in one process, nothing serving — and its client is OFF BY
    // CONSTRUCTION, whatever EXPERIMENTAL_SERVER_EXECUTION says (a flag-ON
    // client here would divert its derivations to a server that does not
    // exist and wedge).
    storageManager: StorageManager.open({
      as: account,
      memoryHost: new URL(base),
    }),
  });
  const space = account.did();
  const diskPath = Deno.makeTempFileSync({ suffix: ".sqlite" });
  seedDiskDb(diskPath);

  try {
    // The operator half of 03.3, as `cf piece link sqlite:` performs it: a RAW
    // write of the self-contained handle at the (space, path)-derived id, and
    // the path registered with the server under that id. Raw, because the
    // stored handle must hold its `tables` INLINE — a schema-driven `set` of a
    // proxy would capture them as links no query-side load resolves.
    const handleId = deriveDiskHandleId(space, diskPath);
    const handle = runtime.getCellFromEntityId(space, entityIdFrom(handleId));
    const writeHandle = (tables: unknown) =>
      runtime.editWithRetry((tx) => {
        handle.withTx(tx).setRawUntyped(
          fabricFromConvertibleJsValue({ id: handleId, tables, rev: 0 }),
          true,
        );
      });
    // `contractArrivesLate` reproduces the operator sequence where the file is
    // connected before its contract is known: the queries settle UNLABELED
    // against an empty contract, and only a later reconcile declares `tables`.
    const seeded = await writeHandle(contractArrivesLate ? {} : TABLES);
    if (seeded.error) throw seeded.error;
    await runtime.storageManager.synced();

    const provider = runtime.storageManager.open(space);
    if (!provider.registerSqliteDiskSource) {
      throw new Error("storage provider does not support disk sources");
    }
    await provider.registerSqliteDiskSource(handleId, diskPath);

    const patternSource = await Deno.readTextFile(
      new URL("./sqlite-cfc-label-injected.tsx", import.meta.url),
    );
    const compiled = await runtime.patternManager.compilePattern(
      patternSource,
      { space },
    );
    const resultCell = runtime.getCell(
      space,
      `sqlite-cfc-label-injected-${crypto.randomUUID()}`,
      compiled.resultSchema,
    );
    // The handle reaches the pattern as its `db` ARGUMENT: the argument doc's
    // `db` field links to the handle cell, exactly what the piece link writes.
    const result = await runtime.runSynced(resultCell, compiled, {
      db: handle,
    });
    const cancelSink = result.sink(() => {});

    try {
      const direct = result.key("direct") as Cell<QueryState>;
      const derived = result.key("derived") as Cell<QueryState>;
      /** The row's own entity doc, which a labeled result splits each row into
       *  and stores the row's labels on. Declared here because the labeled
       *  reads below and the contract-free probe above them both need it. */
      const rowDoc = (query: Cell<QueryState>) => {
        const link = parseLink(query.key("result").key(0).getRaw());
        if (!link?.id) {
          throw new Error("result row did not split into its own entity doc");
        }
        return runtime.getCellFromLink({
          ...link,
          space: link.space ?? space,
          path: [],
        });
      };
      /** Each query and the one column of its result that carries a label. */
      const columns = [
        ["direct", direct, "secret"],
        ["derived", derived, "shouted"],
      ] as const;
      await Promise.all([settled(direct), settled(derived)]);

      if (contractArrivesLate) {
        await runtime.idle();
        await runtime.storageManager.synced();
        // The queries settled against an EMPTY contract, so their results carry
        // no label yet. Pinning that is what makes the reconcile below the
        // thing under test: an implementation that labeled a contract-free
        // result would reach the same end state and pass every assertion after
        // this block. Both halves the labeled case checks are checked here,
        // because they fail independently — what is STORED on the row's own
        // doc, and what a consumer reading the leaf INHERITS.
        for (const [name, query, column] of columns) {
          const stored = cfcLabelViewForCellWithStatus(rowDoc(query));
          if (stored.readFailed || stored.view !== undefined) {
            throw new Error(
              `the contract-free ${name} result was labeled at "${column}" ` +
                `before the contract arrived; got ${JSON.stringify(stored)}`,
            );
          }
          const inherited = await inheritedConfidentiality(
            runtime,
            query.key("result").key(0).key(column),
          );
          if (inherited.length !== 0) {
            throw new Error(
              `a consumer inherited confidentiality from the contract-free ` +
                `${name} result at "${column}"; got ${
                  JSON.stringify(inherited)
                }`,
            );
          }
        }
        const before = {
          direct: direct.key("requestHash").getRaw(),
          derived: derived.key("requestHash").getRaw(),
        };
        // The reconcile: the same handle, now carrying the contract. Its value
        // changes, so each query re-issues under a new request hash and
        // rewrites its result — this time under the label schema.
        const declared = await writeHandle(TABLES);
        if (declared.error) throw declared.error;
        await Promise.all([
          settled(direct, before.direct),
          settled(derived, before.derived),
        ]);
      }

      await runtime.idle();
      await runtime.storageManager.synced();

      for (const [name, query] of columns) {
        const error = query.key("error").getRaw();
        if (error !== undefined) {
          throw new Error(`${name} query failed: ${JSON.stringify(error)}`);
        }
      }

      // (a) The rows read back through the injected source.
      const row = direct.key("result").key(0).get() as
        | Record<string, unknown>
        | undefined;
      if (!row || row.secret !== "top secret") {
        throw new Error(`unexpected direct row: ${JSON.stringify(row)}`);
      }
      const derivedRow = derived.key("result").key(0).get() as
        | Record<string, unknown>
        | undefined;
      if (!derivedRow || derivedRow.shouted !== "TOP SECRET") {
        throw new Error(
          `unexpected derived row: ${JSON.stringify(derivedRow)}`,
        );
      }

      // (b) The label is STORED on each row's own entity doc — the per-field
      // entry an aliased column gets, and the `observes: "value"` entry the
      // null-origin expression gets from the whole-db union.
      const storedEntry = (query: Cell<QueryState>, column: string) => {
        const stored = cfcLabelViewForCellWithStatus(rowDoc(query));
        if (stored.readFailed) {
          throw new Error(`label metadata read failed for "${column}"`);
        }
        const entry = stored.view?.entries.find((e) =>
          e.path.length === 1 && e.path[0] === column
        );
        if (!entry?.label.confidentiality?.some((a) => a === "secret-body")) {
          throw new Error(
            `no stored confidentiality on the row doc for "${column}"; got ${
              JSON.stringify(stored)
            }`,
          );
        }
        return entry;
      };
      // The ORIGIN arm: `secret` reads one column, so it carries that column's
      // atom and NOT `meta.k`'s, and it declares no observation class. Both
      // halves matter — a column that picked up the whole-db union, or gained
      // `observes`, went through the null-origin arm instead.
      const secretEntry = storedEntry(direct, "secret");
      const secretAtoms = [...(secretEntry.label.confidentiality ?? [])].sort();
      if (
        secretAtoms.length !== 1 || secretAtoms[0] !== "secret-body" ||
        secretEntry.observes !== undefined
      ) {
        throw new Error(
          `the aliased column did not take the origin arm; got ${
            JSON.stringify(secretEntry)
          }`,
        );
      }
      // The NULL-ORIGIN arm: `upper(body)` names no single source, so it takes
      // the union of every labeled column in the db — including `meta.k`,
      // which its query never touches — and is value-class.
      //
      // Every check on this arm compares the COMPLETE set rather than asking
      // whether one atom is present. A partial union satisfies a membership
      // check, so `some(...)` cannot tell the whole-db union from a query-scoped
      // one, and a propagation that dropped `meta-atom` on the way to a reader
      // would read as correct. `atomsOf` sorts because the union's order is not
      // stable between the two arms of this test.
      const WHOLE_DB_UNION = ["meta-atom", "secret-body"];
      const atomsOf = (conf: readonly unknown[] | undefined) =>
        [...(conf ?? [])].map(String).sort();
      const sameAtoms = (
        conf: readonly unknown[] | undefined,
        expected: readonly string[],
      ) =>
        JSON.stringify(atomsOf(conf)) === JSON.stringify([...expected].sort());

      const derivedEntry = storedEntry(derived, "shouted");
      if (!sameAtoms(derivedEntry.label.confidentiality, WHOLE_DB_UNION)) {
        throw new Error(
          `the null-origin column did not take the whole-db union; wanted ${
            JSON.stringify(WHOLE_DB_UNION)
          }, got ${JSON.stringify(derivedEntry)}`,
        );
      }
      if (derivedEntry.observes !== "value") {
        throw new Error(
          `the null-origin column's stored label is not value-class; got ${
            JSON.stringify(derivedEntry)
          }`,
        );
      }

      // (c) A consumer reading the leaf inherits that confidentiality.
      const secretConf = await inheritedConfidentiality(
        runtime,
        direct.key("result").key(0).key("secret"),
      );
      if (!sameAtoms(secretConf, ["secret-body"])) {
        throw new Error(
          `the aliased column did not inherit exactly its origin's ` +
            `confidentiality; got ${JSON.stringify(secretConf)}`,
        );
      }
      const shoutedConf = await inheritedConfidentiality(
        runtime,
        derived.key("result").key(0).key("shouted"),
      );
      if (!sameAtoms(shoutedConf, WHOLE_DB_UNION)) {
        throw new Error(
          `the null-origin column did not inherit the whole-db union; wanted ${
            JSON.stringify(WHOLE_DB_UNION)
          }, got ${JSON.stringify(shoutedConf)}`,
        );
      }

      // (d) The labels live on the row docs, NOT on the query doc. The
      // one-hop reader follows a link the selected path lands ON, and these
      // paths CROSS one at `result/0`, so it reports nothing for a result
      // that plainly carries labels. Pinning that keeps the contrast in (e)
      // honest, and keeps a future reader from probing the query doc, finding
      // nothing, and reporting a fully labeled result as unlabeled.
      for (const path of [[], ["result"], ["result", 0]] as const) {
        let probe: Cell<unknown> = direct as Cell<unknown>;
        for (const key of path) probe = probe.key(key as never);
        const view = cfcLabelViewForCellWithStatus(probe).view;
        if (view !== undefined) {
          throw new Error(
            `the one-hop reader gained a label view at ${
              JSON.stringify(path)
            }: ${JSON.stringify(view)} — update this test, (e), and the ` +
              `loom-side probe together`,
          );
        }
      }

      // (e) The INSPECTION reader — what `cf cell get-label` calls — resolves
      // the links the path crosses and reports the label a person asked about.
      // Selecting the column reports it at the selection; selecting the row
      // reports each labeled column. Reference and content observation classes
      // retain separate entries even when they share a path.
      const resolvedAt = (
        query: Cell<QueryState>,
        path: readonly (string | number)[],
      ) => {
        let probe: Cell<unknown> = query as Cell<unknown>;
        for (const key of path) probe = probe.key(key as never);
        const status = cfcLabelViewForResolvedCellWithStatus(probe);
        if (status.readFailed) {
          throw new Error(
            `label read failed at ${JSON.stringify(path)} — fail closed`,
          );
        }
        return status.view;
      };
      const atColumn = resolvedAt(direct, ["result", 0, "secret"]);
      const columnConf = atColumn?.entries.filter((e) => e.path.length === 0)
        .flatMap((e) => e.label.confidentiality ?? []);
      if (
        !sameAtoms(columnConf, ["secret-body"])
      ) {
        throw new Error(
          `get-label reported no confidentiality at result/0/secret; got ${
            JSON.stringify(atColumn)
          }`,
        );
      }
      const atRow = resolvedAt(direct, ["result", 0]);
      const rowConf = atRow?.entries.filter((e) =>
        e.path.length === 1 && e.path[0] === "secret"
      ).flatMap((e) => e.label.confidentiality ?? []);
      if (!sameAtoms(rowConf, ["secret-body"])) {
        throw new Error(
          `get-label reported no per-column entry at result/0; got ${
            JSON.stringify(atRow)
          }`,
        );
      }
      // The null-origin column reaches the same reader with its class intact.
      const atDerived = resolvedAt(derived, ["result", 0, "shouted"]);
      const derivedConf = atDerived?.entries.filter((e) =>
        e.path.length === 0 && e.observes === "value"
      ).flatMap((e) => e.label.confidentiality ?? []);
      if (
        !sameAtoms(derivedConf, WHOLE_DB_UNION)
      ) {
        throw new Error(
          `get-label lost the null-origin column's value-class whole-db ` +
            `union; wanted ${JSON.stringify(WHOLE_DB_UNION)} with ` +
            `observes "value", got ${JSON.stringify(atDerived)}`,
        );
      }
    } finally {
      cancelSink();
    }
  } finally {
    // The file removal is in an inner `finally` so a rejecting `dispose()`
    // cannot leave a temp SQLite file behind on every failing run.
    try {
      await runtime.dispose();
    } finally {
      try {
        Deno.removeSync(diskPath);
      } catch {
        // The file is gone either way.
      }
    }
  }
}

const serve = (contractArrivesLate: boolean) => async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  try {
    await runTest(base, contractArrivesLate);
  } finally {
    await server.shutdown();
  }
};

Deno.test({
  name: "sqlite db.query labels a result read through an injected input handle",
  fn: serve(false),
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name:
    "sqlite db.query relabels an injected result when the contract arrives after the first read",
  fn: serve(true),
  sanitizeResources: false,
  sanitizeOps: false,
});
