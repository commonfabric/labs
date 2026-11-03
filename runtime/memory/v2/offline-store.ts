/**
 * The safety rails an offline rewrite of a space's store keeps, shared by
 * compaction and reaping (`docs/plans/compact-space.md`, "The store must be
 * offline", and `docs/specs/random-space-identities.md`, "Reaping a deleted
 * space"): the run takes only a store nothing has open, never overwrites a
 * result, and checks what it wrote before handing it on.
 */

import type { Database } from "@db/sqlite";

/** The file's stat, or undefined for a file that is not there. Any other
 * failure — a permission refused, an I/O error — is not absence and is
 * rethrown: a companion the run cannot read is not a companion it may
 * treat as empty. */
const statIfPresent = (path: string): Deno.FileInfo | undefined => {
  try {
    return Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
};

/** The size of the file at `path`, or 0 when there is none. */
export const fileSize = (path: string): number =>
  statIfPresent(path)?.size ?? 0;

/** Whether any directory entry is at `path` — a file, a directory, or a
 * symlink whether or not its target exists. The result is written through
 * whatever is there, so nothing may be. */
export const entryExists = (path: string): boolean => {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

/**
 * Refuses, by throwing what `refused` makes of the reason, a run over
 * `store` that would write `out`, unless `store` is there, nothing holds it
 * open, and nothing is at `out`. A store some process holds open in WAL mode
 * has a log beside it, and a stale log left beside a replaced database is
 * recovered onto the replacement.
 */
export const preflightOfflineStore = (
  store: string,
  out: string,
  refused: (reason: string) => Error,
): void => {
  try {
    Deno.statSync(store);
  } catch {
    throw refused(`no store at ${store}`);
  }
  for (const companion of ["-wal", "-journal"]) {
    if (fileSize(`${store}${companion}`) > 0) {
      throw refused(
        `${store}${companion} is not empty: a process holds the store open, or a log was left beside it; the run writes only a store nothing has open`,
      );
    }
  }
  if (entryExists(out)) {
    throw refused(`${out} exists; the result is never overwritten`);
  }
};

/**
 * The checks a rewrite ends with on `db`, its foreign keys and its
 * integrity, after its log is checkpointed into the file.
 *
 * @throws Error naming the check that failed.
 */
export const checkRewrittenStore = (db: Database): void => {
  const violations = db.prepare(`PRAGMA foreign_key_check`).all();
  if (violations.length > 0) {
    throw new Error(
      `PRAGMA foreign_key_check reports ${violations.length} violation(s) after the run; the store is left as it is`,
    );
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const integrity = db.prepare(`PRAGMA integrity_check`).all<
    { integrity_check: string }
  >();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error(
      `PRAGMA integrity_check: ${
        integrity.map((row) => row.integrity_check).join("; ")
      }`,
    );
  }
};
