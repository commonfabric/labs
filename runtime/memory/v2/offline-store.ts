/**
 * The safety rails an offline rewrite of a space's store keeps, shared by
 * compaction and reaping (`docs/plans/compact-space.md`, "The store must be
 * offline", and `docs/specs/random-space-identities.md`, "Reaping a deleted
 * space"): the run takes only a store nothing has open, never overwrites a
 * result, and checks what it wrote before handing it on.
 */

import { Database } from "@db/sqlite";

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
 * `store` that would write `out`, unless `store` is there, no log that is not
 * empty is beside it, no connection holds it, and nothing is at `out`.
 *
 * A stale log left beside a replaced database is recovered onto the
 * replacement, so a log that is not empty is refused whoever left it. Whether
 * a connection holds the store is asked of SQLite: the check takes the file's
 * exclusive lock and lets it go, which any connection to a WAL-mode store
 * prevents, idle or not, as does a connection to a rollback-mode store inside
 * a transaction. An idle connection to a rollback-mode store holds no lock,
 * so nothing here can see it; that the store is a copy nothing has open is
 * the procedure's to ensure.
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
  if (!exclusiveLockFree(store)) {
    throw refused(
      `${store} is held by another connection: a process has it open; the run writes only a store nothing has open`,
    );
  }
};

/**
 * Whether the exclusive lock on the SQLite file at `store` can be taken at
 * once. The connection takes it before its first access, so a WAL-mode store
 * is read with no shared-memory index, and it writes nothing.
 */
const exclusiveLockFree = (store: string): boolean => {
  const db = new Database(store, { create: false });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (/database is locked/.test(String(error))) return false;
      throw error;
    }
    db.exec("COMMIT");
    return true;
  } finally {
    db.close();
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
      `PRAGMA foreign_key_check reports ${violations.length} violation(s) after the run`,
    );
  }
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get<
    { busy: number }
  >();
  if (checkpoint?.busy !== 0) {
    throw new Error(
      "PRAGMA wal_checkpoint(TRUNCATE) could not finish: another connection reads the file the run wrote",
    );
  }
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
