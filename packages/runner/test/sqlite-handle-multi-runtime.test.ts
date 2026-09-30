// Multi-runtime stability of the SqliteDb handle (CFC Phase 3 rule-bearing
// dbs). A rowLabel rule's term LIST (`all(a, b, …)` — an array of objects)
// used to split into per-element entity docs when the handle value was stored
// (Cell.set anchors every object-in-array). Those term docs are not
// reachable through any schema-driven sync, so a SECOND runtime deep-resolved
// the links to `null` and `sqliteQuery` hashed `allOf: [null]` while the
// creator runtime hashed the resolved AST — two request hashes fighting over
// ONE shared (space-scoped) result cell, each runtime seeing the other's hash
// as "new inputs" and re-issuing forever (the query never settles).
//
// Guarded contract: the stored handle value is SELF-CONTAINED (no linked
// docs), so every runtime that can read the handle doc has the full resolved
// spec — one request hash per logical query, shared result-cell dedup works.
//
// The harness runs two real Runtimes with SEPARATE storage managers over one
// in-process memory server (separate heaps are the point: the bug only shows
// when a doc can exist server-side but not in the reading runtime's heap; the
// single-StorageManager emulate() setup would mask it).

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { SqliteTableSchemas } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { createCell } from "../src/cell.ts";
import { isSigilLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

// Fresh identity per RUN: the server derives the on-disk cell-db file from the
// (causal) db id, so a fixed passphrase would reuse a stale $TMPDIR db across
// test runs (the classic same-file repro trap).
const signer = await Identity.fromPassphrase(
  `sqlite handle multi runtime ${crypto.randomUUID()}`,
);
const space = signer.did();

// Two storage managers, ONE server (`EmulatedStorageManager.connectTo`
// against a caller-owned `newSharedServer()`), so each manager has its own
// heap/replica while sharing the durable state.

// The pattern under test: a rule-bearing db whose rule is a term LIST
// (`all(sender, recipients)` — the mailbox shape), plus a shared query.
// Rebuilt per runtime (each has its own trusted builder); the causal ids
// derive from the shared result cell, so both runtimes address the same docs.

const RESULT_CAUSE = "sqlite-handle-multi-runtime";

// The tables flow through the pattern ARGUMENT (a real doc, like a compiled
// pattern's static data) rather than a builder literal: that is the shape
// where the handle write used to capture `tables` as a LINK into the pattern's
// doc graph — whose term-list splits a second runtime never loads.
function makeTables(
  cf: ReturnType<typeof createTrustedBuilder>["commonfabric"],
) {
  const { table, all, principal, match } = cf.cfSqlite;
  const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;
  return {
    emails: table(
      {
        id: "integer primary key",
        from_addr: "text",
        to_addrs: "text",
      },
      (f) => ({
        confidentiality: all(
          principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
          principal("mailto", match(f.to_addrs, ADDR)),
        ),
      }),
    ),
    // Rule-less sibling: its INSERT creates the on-disk cell-db (a fresh,
    // never-written db reads back `{ rows: [] }` with NO column provenance,
    // which a rule-bearing read refuses fail-closed).
    notes: table({ id: "integer primary key", body: "text" }),
  };
}

/** Fold one INSERT into `notes` through db.exec so the cell-db file exists. */
async function seedDbFile(
  runtime: Runtime,
  resultCell: ReturnType<Runtime["getCell"]>,
) {
  const handleLink = resultCell.key("db").resolveAsCell()
    .getAsNormalizedFullLink();
  const tx = runtime.edit();
  const db = createCell(
    runtime,
    { ...handleLink, schema: undefined },
    tx,
    false,
    "sqlite",
  ) as unknown as { exec(sql: string, params?: readonly unknown[]): void };
  db.exec("INSERT INTO notes (body) VALUES (?)", ["seed"]);
  const res = await tx.commit();
  expect(res.error).toBeUndefined();
}

function makePattern(
  cf: ReturnType<typeof createTrustedBuilder>["commonfabric"],
) {
  return cf.pattern<{ tables: SqliteTableSchemas }>(({ tables }) => {
    const db = cf.sqliteDatabase({ tables });
    const q = cf.sqliteQuery({
      db,
      sql: "SELECT id, from_addr, to_addrs FROM emails",
      reactOn: db,
    });
    return { db, q };
  });
}

type QueryState = {
  pending?: boolean;
  error?: unknown;
  requestHash?: string;
  result?: unknown[];
};

/** Run the pattern and return schema-less cells for the handle and query docs. */
function runPattern(runtime: Runtime) {
  const { commonfabric: cf } = createTrustedBuilder(runtime);
  const pattern = makePattern(cf);
  const tx = runtime.edit();
  const resultCell = runtime.getCell(space, RESULT_CAUSE, undefined, tx);
  runtime.run(tx, pattern, { tables: makeTables(cf) }, resultCell);
  // The handle and the query are computations: a reader has to demand
  // them, and the runtime's disposal ends the subscription.
  resultCell.sink(() => {});
  const commit = tx.commit();
  return { resultCell, commit };
}

/** All sigil links reachable in a RAW stored value (never descends into one). */
function collectSigilLinks(value: unknown, out: unknown[] = []): unknown[] {
  if (isSigilLink(value)) {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectSigilLinks(v, out);
    return out;
  }
  if (isObjectOrArray(value)) {
    for (const v of Object.values(value)) collectSigilLinks(v, out);
    return out;
  }
  return out;
}

describe("sqlite handle across runtimes (rule term lists)", () => {
  let server: MemoryV2Server.Server;
  let runtimeA: Runtime;
  let runtimeB: Runtime | undefined;

  beforeEach(() => {
    server = newSharedServer();
    runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    runtimeB = undefined;
  });

  afterEach(async () => {
    // Drain in-flight async builtin work (the query RPC + write-back) before
    // dispose — Client.close rejects pending requests, which would otherwise
    // surface as uncaught rejections and cancel the rest of the suite. Bounded
    // so a genuinely fighting (bug-state) pair cannot hang teardown forever.
    const grace = new Promise((r) => setTimeout(r, 3000));
    await Promise.race([
      Promise.allSettled([runtimeA.settled(), runtimeB?.settled()]),
      grace,
    ]);
    // Scheduler only, not `dispose({ closeStorage: false })`: BOTH runtimes
    // must stop before EITHER is torn down, because each can still be answering
    // the other's shared query. A dispose call quiesces one runtime completely
    // before the next one starts, which is the ordering this pair rules out.
    runtimeB?.scheduler.dispose();
    runtimeA.scheduler.dispose();
    await Promise.allSettled([
      runtimeB?.storageManager.synced(),
      runtimeA.storageManager.synced(),
    ]);
    await runtimeB?.dispose();
    await runtimeA.dispose();
    await server.close();
  });

  it("stores the handle value self-contained (term list stays inline)", async () => {
    const { resultCell, commit } = runPattern(runtimeA);
    await commit;
    await runtimeA.idle();

    const handle = resultCell.key("db").resolveAsCell();
    const raw = handle.getRaw() as Record<string, unknown>;
    expect(raw).toBeDefined();
    // The rule survived storage (still a 2-term conjunction)…
    const rowLabel = (handle.key("tables").key("emails") as unknown as {
      get: () => { rowLabel?: { confidentiality?: { allOf?: unknown[] } } };
    }).get()?.rowLabel;
    expect(rowLabel?.confidentiality?.allOf?.length).toBe(2);
    // …and nothing in the stored handle value is a link to another doc: a
    // split-out term doc is unreachable by schema-driven sync, so a second
    // runtime would resolve it to null and destabilize the request hash.
    expect(collectSigilLinks(raw)).toEqual([]);

    // db.exec's rev bump must keep it self-contained too: it writes from a
    // handler frame, where a whole-value set would entity-split the term list
    // right back into linked docs. Only the `rev` leaf may change.
    await seedDbFile(runtimeA, resultCell);
    await runtimeA.idle();
    const afterExec = handle.getRaw() as Record<string, unknown>;
    expect((afterExec as { rev?: number }).rev).toBe(1);
    expect(collectSigilLinks(afterExec)).toEqual([]);
  });

  it("a second runtime keeps a sparse array in a column's stored confidentiality atom when its declaration omits the label", async () => {
    const atom = () => ({
      type: "custom-policy",
      parameters: new Array<string>(1),
    });
    const { commonfabric: cfA } = createTrustedBuilder(runtimeA);
    const declared = (labeled: boolean) => ({
      items: cfA.table({
        id: "integer primary key",
        tag: labeled
          ? { type: "integer", ifc: { confidentiality: [atom()] } }
          : { type: "integer" },
      }),
    });
    const pattern = (cf: typeof cfA) =>
      cf.pattern<{ tables: SqliteTableSchemas }>(({ tables }) => ({
        db: cf.sqliteDatabase({ tables }),
      }));
    const cause = "sqlite-sparse-atom";
    const tablesCause = "sqlite-sparse-atom-tables";

    const tx = runtimeA.edit();
    const tables = runtimeA.getCell<unknown>(space, tablesCause, undefined, tx);
    tx.writeValueOrThrow(
      tables.getAsNormalizedFullLink(),
      declared(true) as unknown as FabricValue,
    );
    const resultCell = runtimeA.getCell(space, cause, undefined, tx);
    runtimeA.run(tx, pattern(cfA), { tables }, resultCell);
    resultCell.sink(() => {});
    expect((await tx.commit()).error).toBeUndefined();
    await runtimeA.settled();
    const redeclare = runtimeA.edit();
    redeclare.writeValueOrThrow(
      tables.getAsNormalizedFullLink(),
      declared(false) as unknown as FabricValue,
    );
    expect((await redeclare.commit()).error).toBeUndefined();
    await runtimeA.storageManager.synced();

    // The init that merges a declaration into the stored handle runs once per
    // runtime, so the re-declaration is read by a second one.
    runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    const { commonfabric: cfB } = createTrustedBuilder(runtimeB);
    const resultCellB = runtimeB.getCell(space, cause, undefined);
    await runtimeB.runSynced(resultCellB, pattern(cfB));
    // A reader demands the handle, so the second runtime runs its init.
    resultCellB.sink(() => {});
    await runtimeB.settled();
    await runtimeB.storageManager.synced();

    const handle = resultCellB.key("db").resolveAsCell().getRawUntyped() as {
      tables: Record<string, {
        properties: Record<string, {
          ifc?: { confidentiality?: { parameters: unknown[] }[] };
        }>;
      }>;
    };
    const parameters = handle.tables.items.properties.tag.ifc!
      .confidentiality![0].parameters;
    expect(parameters.length).toBe(1);
    expect(Object.hasOwn(parameters, 0)).toBe(false);
  });

  it("a second runtime adopts the settled shared query instead of re-issuing", async () => {
    const a = runPattern(runtimeA);
    await a.commit;
    await runtimeA.idle();
    await seedDbFile(runtimeA, a.resultCell);
    const qCellA = a.resultCell.key("q").resolveAsCell();
    const qA = await waitForCellValue<QueryState>(
      runtimeA,
      qCellA,
      (v) => v?.pending === false && v?.error === undefined,
    );
    expect(qA.error).toBeUndefined();
    const hashA = qA.requestHash;
    expect(typeof hashA).toBe("string");
    await runtimeA.storageManager.synced();

    // Second runtime, separate heap, same server: HYDRATES the same piece
    // (no inputs re-provided — a pure loader, like a second tab).
    runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    // Count B's server reads: with a stable request hash B must DEDUP against
    // the settled shared result, never issue its own request. (The red failure
    // mode: B's sqliteDatabase re-init rewrote the handle — dropping `rev`,
    // re-deriving `tables` — so BOTH runtimes saw "new inputs", each write
    // invalidating the other's hash on the ONE shared result cell.)
    const providerB = runtimeB.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const originalB = providerB.sqliteQuery.bind(providerB);
    let issuesFromB = 0;
    providerB.sqliteQuery = (...args) => {
      issuesFromB++;
      return originalB(...args);
    };

    const { commonfabric: cfB } = createTrustedBuilder(runtimeB);
    const resultCellB = runtimeB.getCell(space, RESULT_CAUSE, undefined);
    await runtimeB.runSynced(resultCellB, makePattern(cfB));
    const qCellB = resultCellB.key("q").resolveAsCell();
    // Same piece ⇒ same shared query result doc in both runtimes.
    expect(qCellB.getAsNormalizedFullLink().id).toBe(
      qCellA.getAsNormalizedFullLink().id,
    );

    const qB = await waitForCellValue<QueryState>(
      runtimeB!,
      qCellB,
      (v) => v?.pending === false && v?.requestHash === hashA,
    );
    expect(qB.error).toBeUndefined();

    // Stability: B adopted the settled result (no re-issue), and A's hash
    // survived B's hydration untouched.
    await runtimeB!.settled();
    await runtimeA.settled();
    expect(issuesFromB).toBe(0);
    const settledA = qCellA.get() as QueryState;
    expect(settledA.requestHash).toBe(hashA);
    expect(settledA.pending).toBe(false);
    expect(settledA.error).toBeUndefined();
  });

  it("a second runtime recovers a pending query left by a stopped runtime", async () => {
    const a = runPattern(runtimeA);
    await a.commit;
    const qCellA = a.resultCell.key("q").resolveAsCell();
    const initial = await waitForCellValue<QueryState>(
      runtimeA,
      qCellA,
      (value) => value?.pending === false,
    );
    expect(typeof initial.requestHash).toBe("string");

    const providerA = runtimeA.storageManager.open(space) as unknown as {
      sqliteQuery: (...args: unknown[]) => Promise<unknown>;
    };
    const originalA = providerA.sqliteQuery.bind(providerA);
    let resumeA: (() => Promise<void>) | undefined;
    providerA.sqliteQuery = (...args) =>
      new Promise((resolve, reject) => {
        resumeA = async () => {
          try {
            resolve(await originalA(...args));
          } catch (error) {
            reject(error);
          }
        };
      });
    await seedDbFile(runtimeA, a.resultCell);
    const pending = await waitForCellValue<QueryState>(
      runtimeA,
      qCellA,
      (value) =>
        value?.pending === true && value.requestHash !== initial.requestHash,
    );
    expect(typeof pending.requestHash).toBe("string");
    await runtimeA.patternManager.flushCompileCacheWrites();
    await runtimeA.storageManager.synced();
    runtimeA.scheduler.dispose();

    runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    const providerB = runtimeB.storageManager.open(space) as unknown as {
      sqliteQuery: (...args: unknown[]) => Promise<unknown>;
    };
    const originalB = providerB.sqliteQuery.bind(providerB);
    let issuesFromB = 0;
    providerB.sqliteQuery = (...args) => {
      issuesFromB++;
      return originalB(...args);
    };

    const { commonfabric: cfB } = createTrustedBuilder(runtimeB);
    const resultCellB = runtimeB.getCell(space, RESULT_CAUSE, undefined);
    const cancelResultSink = resultCellB.sink(() => {});
    await runtimeB.runSynced(resultCellB, makePattern(cfB));
    const qCellB = resultCellB.key("q").resolveAsCell();
    const recovered = await waitForCellValue<QueryState>(
      runtimeB,
      qCellB,
      (value) => value?.pending === false,
    );

    expect(issuesFromB).toBe(1);
    expect(recovered.pending).toBe(false);
    expect(recovered.requestHash).toBe(pending.requestHash);
    expect(recovered.error).toBeUndefined();
    cancelResultSink();
    expect(resumeA).toBeDefined();
    await resumeA!();
    await runtimeA.settled();
  });
});
