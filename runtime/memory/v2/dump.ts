// Read-only, crash-consistent snapshots of space SQLite stores for offline
// autopsy (the `cf inspect --remote` workflow). This is the sanctioned way to
// extract a space's durable store over the wire:
//
//   * It never mutates the source DB — `VACUUM INTO` only reads the source and
//     writes a brand-new single-file copy.
//   * It never runs the engine's migration path (which DDLs the store on open);
//     we open `@db/sqlite` directly, the same read-only discipline the
//     state-inspector uses.
//   * It produces ONE consistent file even though the live server keeps the
//     store in WAL mode — `VACUUM INTO` checkpoints into the copy, so the result
//     has no `-wal`/`-shm` companions to ship.
//
// `store` here is the SAME value the toolshed hands `MemoryServer` (its
// `#store`). The server resolves each space's file via `resolveSpaceStoreUrl`,
// so we MUST resolve through the same helper rather than assuming files sit
// directly under `store` — directory mode nests them one more `engine-v3/` deep.

import * as Path from "@std/path";

import { Database } from "@db/sqlite";

import type { MemorySpace } from "../interface.ts";
import {
  resolveSpaceStoreDirUrl,
  resolveSpaceStoreUrl,
  spaceFromStoreFilename,
} from "./storage-path.ts";

const SQLITE_SUFFIX = ".sqlite";

export type SpaceStoreInfo = {
  /** Canonical space DID (decoded from the on-disk filename). */
  space: string;

  sizeBytes: number;
  mtimeMs: number;
};

/**
 * List the space stores for a memory `store` (the value passed to
 * `MemoryServer`). Resolves the actual per-space directory via the shared
 * `resolveSpaceStoreDirUrl`, so it matches the server's on-disk layout exactly.
 * Newest-first by mtime.
 */
export function listSpaceStores(store: URL): SpaceStoreInfo[] {
  const dir = Path.fromFileUrl(resolveSpaceStoreDirUrl(store));
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch (error) {
    // The store dir may simply not exist yet → no spaces. Permission / IO
    // errors must surface rather than masquerade as an empty store.
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const out: SpaceStoreInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(SQLITE_SUFFIX)) continue;
    const stem = entry.name.slice(0, -SQLITE_SUFFIX.length);
    // Mode-aware inverse of the store's filename encoding: directory-mode stems
    // are already the literal id (a blanket decodeURIComponent would corrupt
    // ids containing percent-sequences); single-file stems decode once.
    const space = spaceFromStoreFilename(store, stem);
    if (space === null) continue; // not a store filename we wrote
    let stat: Deno.FileInfo;
    try {
      stat = Deno.statSync(Path.join(dir, entry.name));
    } catch (error) {
      // Tolerate a file removed between readdir and stat; surface anything else.
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    out.push({
      space,
      sizeBytes: stat.size,
      mtimeMs: stat.mtime?.getTime() ?? 0,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Resolve the on-disk sqlite path for a space within `store`, or null if it does
 * not exist. Uses the same `resolveSpaceStoreUrl` the server uses (so the path
 * always matches), and that helper's `encodeStoreSubject` rejects path-traversal
 * in the space id (`/`, `\`, `..`, NUL) — an attacker-supplied id can't escape.
 */
export function spaceStorePath(
  store: URL,
  space: string,
): string | null {
  let path: string;
  try {
    path = Path.fromFileUrl(resolveSpaceStoreUrl(store, space as MemorySpace));
  } catch {
    return null; // invalid space id
  }
  try {
    return Deno.statSync(path).isFile ? path : null;
  } catch (error) {
    // Absent space → null; permission / IO errors must surface.
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/**
 * Write a crash-consistent single-file copy of the space store at `sourcePath`
 * to `destPath` via `VACUUM INTO`. Does not mutate the source and runs no
 * migrations. Safe while the server holds the source open in WAL mode.
 *
 * Known limitation: opening read-only means a space whose `-wal` still has
 * un-checkpointed frames AND which no writer currently holds open can fail here,
 * because WAL recovery needs write access to `-shm`/`-wal`. In practice the
 * toolshed holds active spaces open (so `-shm` exists and recovery is a no-op);
 * an idle space with a dirty WAL is the edge that can throw. The caller (the
 * dump route) turns that into a 500, so it fails safe rather than corrupting or
 * silently truncating — acceptable for the staging-only debugging use.
 */
export function snapshotSpaceStore(sourcePath: string, destPath: string): void {
  // `VACUUM INTO` is documented to work against a read-only source connection
  // (it is the recommended hot-backup-to-file mechanism). Opening read-only
  // guarantees we cannot mutate the live store even by accident.
  const db = new Database(sourcePath, { readonly: true });
  try {
    const stmt = db.prepare("VACUUM main INTO ?");
    try {
      stmt.run(destPath);
    } finally {
      stmt.finalize();
    }
  } finally {
    db.close();
  }
}
