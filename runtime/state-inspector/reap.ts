// Verification of a reaped space store against the store it was reaped from
// (docs/specs/random-space-identities.md, "Reaping a deleted space"): the
// deletion commit and the deletion tombstone read back unchanged, the server
// sequence is the same, and nothing else of the space is left. Read-only on
// both files, and a second implementation of what the run keeps: the
// deletion is found here from the backup's own rows, and every table the
// result holds is held to it, so that a run that kept or dropped the wrong
// rows is caught by the store it left behind. Nothing here throws for what it
// finds in the files: each finding is a named check that fails.

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isDeletionTombstone } from "@commonfabric/memory/acl";

import type { CompactionCheck, StoreVerification } from "./compaction.ts";
import { openSpace } from "./db.ts";
import { decodeStored } from "./decode.ts";

/** The outcome of {@link verifyReap}. */
export type ReapVerification = StoreVerification & {
  /** The reaped store. */
  result: string;

  /** The store it was reaped from. */
  against: string;
};

/**
 * The rows of each table a reaped store keeps, over the deletion commit's seq
 * (`:seq`), the ACL document's id (`:acl`) and the commit's invocation and
 * authorization refs. A table not named here keeps none.
 */
const KEPT: ReadonlyMap<string, string> = new Map([
  ["commit", `seq = :seq`],
  [
    "invocation",
    `ref IN (SELECT invocation_ref FROM against."commit" WHERE seq = :seq)`,
  ],
  [
    "authorization",
    `ref IN (SELECT authorization_ref FROM against."commit" WHERE seq = :seq)`,
  ],
  [
    "revision",
    `branch = '' AND id = :acl AND scope_key = 'space' AND seq = :seq`,
  ],
  ["head", `branch = '' AND id = :acl AND scope_key = 'space'`],
  ["branch", `name = ''`],
]);

/** The members of `parameters` that `sql` names, which is all SQLite accepts
 * for its statement. */
const parametersOf = (
  sql: string,
  parameters: { acl: string; seq: number },
): Record<string, string | number> =>
  Object.fromEntries(
    Object.entries(parameters).filter(([name]) => sql.includes(`:${name}`)),
  );

/** The quoted name of `table`, for SQL. */
const quoted = (table: string): string => `"${table.replaceAll('"', '""')}"`;

/**
 * Verifies `options.result`, a reaped store, against `options.against`, the
 * store it was reaped from: the result passes its integrity and foreign-key
 * checks, the backup's ACL document holds a deletion tombstone at the server
 * sequence, every row the reap keeps is in the result exactly as in the
 * backup, and the result holds no other row of any table, nor any table the
 * backup lacks.
 */
export function verifyReap(
  options: { result: string; against: string },
): ReapVerification {
  const started = performance.now();
  const checks: CompactionCheck[] = [];
  const check = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
  };
  const finish = (): ReapVerification => ({
    ok: checks.every((entry) => entry.passed),
    result: options.result,
    against: options.against,
    checks,
    elapsedMs: performance.now() - started,
  });

  const main = openSpace(options.result);
  try {
    main.db.prepare(`ATTACH DATABASE ? AS against`).run(options.against);

    // 1. The file itself.
    const integrity = main.all<{ integrity_check: string }>(
      `PRAGMA integrity_check`,
    );
    check(
      "integrity_check",
      integrity.length === 1 && integrity[0].integrity_check === "ok",
      integrity.map((row) => row.integrity_check).join("; "),
    );
    const violations = main.all(`PRAGMA main.foreign_key_check`).length;
    check(
      "foreign_key_check",
      violations === 0,
      violations === 0 ? "no violations" : `${violations} violation(s)`,
    );

    // 2. The deletion, as the backup records it.
    const acl = main.all<{ id: string; seq: number; data: string | null }>(
      `SELECT h.id, h.seq, r.data FROM against.head h
       JOIN against.revision r ON r.branch = h.branch AND r.id = h.id
         AND r.scope_key = h.scope_key AND r.seq = h.seq
         AND r.op_index = h.op_index
       WHERE h.branch = '' AND h.scope_key = 'space' AND h.id LIKE 'of:did:%'
         AND h.op = 'set'`,
    );
    let tombstone = false;
    try {
      tombstone = acl.length === 1 && acl[0].data !== null &&
        isDeletionTombstone(
          (decodeStored(acl[0].data) as { value?: unknown } | null)?.value,
        );
    } catch {
      tombstone = false;
    }
    check(
      "the backup's ACL document holds a deletion tombstone",
      tombstone,
      acl.length === 1
        ? `${acl[0].id} at seq ${acl[0].seq}`
        : `${acl.length} ACL documents`,
    );
    if (!tombstone) return finish();
    const { id, seq } = acl[0];
    const parameters = { acl: id, seq };

    // 3. The server sequence.
    const latest = (schema: string) =>
      main.get<{ seq: number | null }>(
        `SELECT MAX(seq) AS seq FROM ${schema}."commit"`,
      )?.seq ?? null;
    check(
      "the server sequence is the deletion commit's",
      latest("main") === seq && latest("against") === seq,
      `result ${latest("main")}, backup ${latest("against")}, deletion ${seq}`,
    );

    // 4. Every table: the kept rows identical, and nothing else.
    const tablesOf = (schema: string) =>
      new Set(
        main.all<{ name: string }>(
          `SELECT name FROM ${schema}.sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        ).map((row) => row.name),
      );
    const resultTables = tablesOf("main");
    const backupTables = tablesOf("against");
    const lost = [...backupTables].filter((table) => !resultTables.has(table));
    check(
      "every table of the backup is in the result",
      lost.length === 0,
      lost.length === 0 ? "all present" : `missing: ${lost.join(", ")}`,
    );
    const added = [...resultTables].filter((table) => !backupTables.has(table));
    check(
      "every table of the result is in the backup",
      added.length === 0,
      added.length === 0 ? "none added" : `added: ${added.join(", ")}`,
    );
    for (const table of [...resultTables].filter((t) => backupTables.has(t))) {
      const kept = KEPT.get(table) ?? "0";
      const named = parametersOf(kept, parameters);
      const extra = main.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT * FROM main.${quoted(table)}
           EXCEPT SELECT * FROM against.${quoted(table)} WHERE ${kept})`,
        named,
      )!.n;
      const missing = main.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT * FROM against.${quoted(table)} WHERE ${kept}
           EXCEPT SELECT * FROM main.${quoted(table)})`,
        named,
      )!.n;
      check(
        `${table}: only the kept rows, unchanged`,
        extra === 0 && missing === 0,
        extra === 0 && missing === 0
          ? "as kept"
          : `${extra} row(s) not kept or changed, ${missing} kept row(s) missing`,
      );
    }
    return finish();
  } catch (error) {
    check(
      "the stores can be compared",
      false,
      describeFailure(error),
    );
    return finish();
  } finally {
    main.close();
  }
}
