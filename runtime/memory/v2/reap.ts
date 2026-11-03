/**
 * Reaping a deleted space's store (`docs/specs/random-space-identities.md`,
 * "Reaping a deleted space"): the store is reduced to the deletion commit and
 * what that commit needs to stand, so the space goes on refusing every
 * principal as deleted, under the same `aclRevision`, and its DID never again
 * has no history. It runs offline, against a copy of the space's backup, and
 * never writes that copy: it writes a fresh result beside it.
 */

import { Database } from "@db/sqlite";
import { resolve } from "@std/path";

import { decodeTrustedMemoryBoundary, type EntityDocument } from "../v2.ts";
import { isDeletionTombstone } from "../acl.ts";
import {
  checkRewrittenStore,
  fileSize,
  preflightOfflineStore,
} from "./offline-store.ts";
import { storeSchemaRefusals } from "./compact.ts";
import { cellDatabaseFilePrefix } from "./storage-path.ts";

/** A store a reap will not take, by name. */
export class ReapRefused extends Error {
  override readonly name = "ReapRefused";
}

/** What a reap of a store keeps, and what it removes. */
export type ReapPlan = {
  /** The deleted space. */
  space: string;

  /** The id of the space's ACL document, which holds the deletion tombstone. */
  aclId: string;

  /** The seq of the deletion commit, which is the store's server sequence. */
  deletionSeq: number;

  /** The principal the deletion tombstone names. */
  deletedBy: string;

  /** The rows the reap removes, by table, for each table it removes any from. */
  removed: Record<string, number>;

  /**
   * The start of the file names of the space's cell databases, which are
   * files beside the live store rather than rows in it, so a reap of a copy
   * cannot reach them: the install that puts the result in place of the live
   * store moves them out of the live directory, beside the live store it
   * moves aside. It is a hash, which another space's cell databases can
   * share, rarely (`cellDatabaseFilePrefix()`).
   */
  cellDatabaseFilePrefix: string;
};

/** A finished reap. */
export type ReapRun = ReapPlan & {
  /** The result's path. */
  out: string;

  /** The result's size, in bytes. */
  outBytes: number;
};

/** The id of a space's ACL document: the one `of:did:…` id a store holds. */
const ACL_ID_PATTERN = "of:did:%";

/**
 * Each table whose rows a reap may keep, with the condition a kept row meets,
 * over the named parameters `:acl` (the ACL document's id), `:seq` (the
 * deletion commit's) and the deletion commit's `:invocation` and
 * `:authorization` refs. Every other table is emptied. A ref compares with
 * `IS`, so a commit that references none keeps no row: `=` against `NULL` is
 * unknown, and `NOT` of unknown would keep every row.
 */
const KEPT: ReadonlyMap<string, string> = new Map([
  ["commit", `seq = :seq`],
  ["invocation", `ref IS :invocation`],
  ["authorization", `ref IS :authorization`],
  [
    "revision",
    `branch = '' AND id = :acl AND scope_key = 'space' AND seq = :seq`,
  ],
  ["head", `branch = '' AND id = :acl AND scope_key = 'space'`],
  ["branch", `name = ''`],
]);

/** The quoted name of `table`, for SQL. */
const quoted = (table: string): string => `"${table.replaceAll('"', '""')}"`;

/** The members of `parameters` that `condition` names, which is all SQLite
 * accepts for its statement. */
const parametersOf = (
  condition: string,
  parameters: KeptParameters,
): Partial<KeptParameters> =>
  Object.fromEntries(
    Object.entries(parameters).filter(([name]) =>
      condition.includes(`:${name}`)
    ),
  );

/** The tables `db` declares, but SQLite's own. */
const tablesOf = (db: Database): string[] =>
  db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all<{ name: string }>().map((row) => row.name);

/** The named parameters {@link KEPT}'s conditions read, for `plan`. */
type KeptParameters = {
  acl: string;
  seq: number;
  invocation: string | null;
  authorization: string | null;
};

/**
 * Refuses the store `db` holds when it predates a migration the server runs
 * on opening it: a reap takes only a store the server has opened, and plans
 * over the columns that store has.
 *
 * @throws ReapRefused naming each migration the store predates.
 */
export const refuseUnmigratedStore = async (db: Database): Promise<void> => {
  const migrations = await storeSchemaRefusals(db);
  if (migrations.length > 0) {
    throw new ReapRefused(
      `${
        migrations.join("; ")
      }: the store predates a migration the server runs on opening it, and a reap takes only a store the server has opened`,
    );
  }
};

/**
 * Plans the reap of the store `db` holds, read-only, once
 * {@link refuseUnmigratedStore} has passed it: what it keeps, and how
 * many rows of each table it removes.
 *
 * @throws ReapRefused when the store is not a deleted space's: its ACL
 *   document is not one document holding a deletion tombstone, or commits
 *   follow the deletion commit, which no server admits.
 */
export const planReap = (db: Database): ReapPlan => {
  const { plan } = planWithParameters(db);
  return plan;
};

/**
 * Helper for {@link planReap} and {@link reapStore}, which also returns the
 * parameters the kept rows are selected by.
 */
const planWithParameters = (
  db: Database,
): { plan: ReapPlan; parameters: KeptParameters } => {
  const heads = db.prepare(
    `SELECT h.id, h.seq, h.op, r.data FROM head h
     JOIN revision r ON r.branch = h.branch AND r.id = h.id
       AND r.scope_key = h.scope_key AND r.seq = h.seq
       AND r.op_index = h.op_index
     WHERE h.branch = '' AND h.scope_key = 'space' AND h.id LIKE ?`,
  ).all<{ id: string; seq: number; op: string; data: string | null }>(
    ACL_ID_PATTERN,
  );
  if (heads.length !== 1) {
    throw new ReapRefused(
      `the store holds ${heads.length} ACL documents; a deleted space's holds one, its deletion tombstone`,
    );
  }
  const [acl] = heads;
  const value = acl.op === "set" && acl.data !== null
    ? (decodeTrustedMemoryBoundary(acl.data) as EntityDocument | null)?.value
    : undefined;
  if (!isDeletionTombstone(value)) {
    throw new ReapRefused(
      `${acl.id} holds no deletion tombstone: only a deleted space's store is reaped`,
    );
  }
  // The deletion commit is the newest: no server admits one after it.
  const deletion = db.prepare(
    `SELECT seq, invocation_ref, authorization_ref FROM "commit"
     ORDER BY seq DESC LIMIT 1`,
  ).get<{
    seq: number;
    invocation_ref: string | null;
    authorization_ref: string | null;
  }>();
  if (deletion === undefined || deletion.seq < acl.seq) {
    throw new ReapRefused(
      `the deletion commit ${acl.seq} is not in the commit log`,
    );
  }
  if (deletion.seq !== acl.seq) {
    throw new ReapRefused(
      `commit ${deletion.seq} follows the deletion commit ${acl.seq}; no server admits a commit to a deleted space, so this store is not one a server wrote`,
    );
  }
  const parameters: KeptParameters = {
    acl: acl.id,
    seq: acl.seq,
    invocation: deletion.invocation_ref,
    authorization: deletion.authorization_ref,
  };
  const removed: Record<string, number> = {};
  for (const table of tablesOf(db)) {
    const kept = KEPT.get(table);
    const count = db.prepare(
      kept === undefined
        ? `SELECT COUNT(*) AS n FROM ${quoted(table)}`
        : `SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE NOT (${kept})`,
    ).get<{ n: number }>(
      kept === undefined ? {} : parametersOf(kept, parameters),
    )!.n;
    if (count > 0) removed[table] = count;
  }
  const space = acl.id.slice("of:".length);
  return {
    plan: {
      space,
      aclId: acl.id,
      deletionSeq: acl.seq,
      deletedBy: value.deleted.by,
      removed,
      cellDatabaseFilePrefix: cellDatabaseFilePrefix(space),
    },
    parameters,
  };
};

/**
 * Reaps the deleted space's store at `options.store`, a copy of its backup,
 * into a fresh file at `options.out`, `<store>.reaped.sqlite` beside it by
 * default. The store itself is only read. The result keeps the deletion
 * commit's row, the invocation and authorization rows it references, the
 * deletion tombstone's revision and head rows, and the default branch's
 * row; every other row of every table is removed, and the result is checked
 * and vacuumed before it is returned.
 *
 * @throws ReapRefused when the store is not a deleted space's, is held open,
 *   predates a migration the server runs on opening it, or the result path
 *   exists.
 */
export const reapStore = async (
  options: { store: string; out?: string },
): Promise<ReapRun> => {
  const store = resolve(options.store);
  const out = options.out === undefined
    ? `${store}.reaped.sqlite`
    : resolve(options.out);
  preflightOfflineStore(store, out, (reason) => new ReapRefused(reason));

  // Planned on a connection that cannot write, which also makes the copy
  // the run rewrites, so the store is never written.
  let planned: { plan: ReapPlan; parameters: KeptParameters };
  const source = new Database(store, { readonly: true });
  try {
    await refuseUnmigratedStore(source);
    planned = planWithParameters(source);
    source.prepare(`VACUUM main INTO ?`).run(out);
  } finally {
    source.close();
  }

  const result = new Database(out);
  try {
    result.exec("PRAGMA locking_mode = EXCLUSIVE");
    result.exec("PRAGMA foreign_keys = OFF");
    result.transaction(() => {
      for (const table of tablesOf(result)) {
        const kept = KEPT.get(table);
        if (kept === undefined) {
          result.exec(`DELETE FROM ${quoted(table)}`);
        } else {
          result.prepare(`DELETE FROM ${quoted(table)} WHERE NOT (${kept})`)
            .run(parametersOf(kept, planned.parameters));
        }
      }
    }).immediate();
    checkRewrittenStore(result);
    result.exec("VACUUM");
  } finally {
    result.close();
  }
  return { ...planned.plan, out, outBytes: fileSize(out) };
};

/** A reap plan as an operator reads it. */
export const formatReapPlan = (plan: ReapPlan): string => {
  const removed = Object.entries(plan.removed);
  return [
    `space      ${plan.space}, deleted by ${plan.deletedBy}`,
    `keeps      the deletion commit at seq ${plan.deletionSeq}, its ` +
    `invocation and authorization, and ${plan.aclId}'s deletion tombstone`,
    removed.length === 0
      ? "removes    nothing; the store is already reaped"
      : `removes    ${
        removed.map(([table, n]) => `${table} ${n.toLocaleString("en-US")}`)
          .join(", ")
      }`,
    `cells      the space's cell databases are among the files beside the ` +
    `live store named ${plan.cellDatabaseFilePrefix}*.sqlite, a hash ` +
    "another space's can share; the install moves them out of the live " +
    "directory, beside the live store it moves aside",
  ].join("\n");
};

/** A finished reap as an operator reads it. */
export const formatReapRun = (run: ReapRun): string =>
  [
    formatReapPlan(run),
    `result     ${run.out} (${(run.outBytes / 1e6).toFixed(1)} MB)`,
  ].join("\n");
