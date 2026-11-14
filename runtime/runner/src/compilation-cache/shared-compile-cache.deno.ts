/**
 * The compiled-module cache every toolshed process on a host shares, and every
 * serving worker in each of them: a directory of compiled modules, one file per
 * module, and the claims that keep two of them from compiling the same modules
 * at once. Deno-only: it reads, writes and locks files.
 *
 * The directory holds two trees. `modules/<version>/<identity>.json` is one
 * module as `ProcessModuleByteCache.serialized()` writes it, under the hashes
 * of its compiled-set runtime version and its content identity. The version
 * covers the compiler and transformer build, so a release never reads the
 * bytes another release compiled. Each file is written whole to a temporary
 * name and renamed into place, so a reader sees all of an entry or none of it
 * while the host runs. The rename is not synced, so a host that loses power
 * can leave a file cut short: a file that does not hold its module is removed
 * and counts as a miss, and the compile that follows writes it again.
 * `claims/<key>.lock` is the file a compile of one set of modules locks while
 * it runs. The lock is the operating system's, so a process that ends, however
 * it ends, releases what it held, and a waiter wakes when the lock is released
 * rather than by looking again.
 *
 * The directory is a cache: what cannot be written to it is logged and
 * compiled again by whoever needs it next, and fails no compile.
 *
 * Opening the cache removes the version trees and claim files nothing has used
 * for {@link SHARED_COMPILE_CACHE_RETENTION_MS}. A version is used while a
 * realm reads complete sets from it, marked at most once in each
 * {@link USE_MARK_INTERVAL_MS}, and a claim each time it is taken. A claim
 * file is removed under its own lock, and never while a turn holds it.
 */

import { join } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/logger";
import {
  type CompiledModuleArtifact,
  ProcessModuleByteCache,
} from "@commonfabric/test-support/compile-byte-cache";
import {
  type CompileClaims,
  CompileTurns,
} from "../harness/compile-interleave.ts";
import type { ModuleByteCache } from "../runtime.ts";

const logger = getLogger("shared-compile-cache");

/**
 * How long a version tree or a claim file stays once nothing uses it: a week,
 * long enough that a release still running is never pruned under it, and
 * short enough that the releases a host has stopped running leave.
 */
export const SHARED_COMPILE_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a realm that reads from a version tree leaves its last mark on the
 * tree standing: a day, so that a tree in use is never a week unmarked, and a
 * read costs no write but the first in each day.
 */
export const USE_MARK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The cache and claims over one shared directory. */
export type SharedCompileCache = {
  readonly moduleByteCache: DiskModuleByteCache;
  readonly compileClaims: FileCompileClaims;
};

/**
 * Opens the shared cache at `dir`, creating it where it is missing, and
 * removes what nothing has used for {@link SHARED_COMPILE_CACHE_RETENTION_MS}
 * before `now()`, the clock the cache marks its use by.
 */
export function openSharedCompileCache(
  dir: string,
  now: () => Date = () => new Date(),
): SharedCompileCache {
  Deno.mkdirSync(join(dir, "modules"), { recursive: true });
  Deno.mkdirSync(join(dir, "claims"), { recursive: true });
  const cutoff = now().getTime() - SHARED_COMPILE_CACHE_RETENTION_MS;
  removeVersionsUnusedSince(join(dir, "modules"), cutoff);
  removeClaimsUnusedSince(join(dir, "claims"), cutoff);
  return {
    moduleByteCache: new DiskModuleByteCache(dir, { now }),
    compileClaims: new FileCompileClaims(dir),
  };
}

/**
 * A `ModuleByteCache` over the shared directory, with this realm's own
 * in-memory cache in front of it: a module this realm has read or put is
 * served from memory, and any other is read from its file.
 */
export class DiskModuleByteCache implements ModuleByteCache {
  readonly #dir: string;
  readonly #memory: ProcessModuleByteCache;
  readonly #now: () => Date;

  /** When this realm last marked each version tree as used, by its path. */
  readonly #usedAt = new Map<string, number>();

  constructor(
    dir: string,
    { memory = new ProcessModuleByteCache(), now = () => new Date() }: {
      memory?: ProcessModuleByteCache;
      now?: () => Date;
    } = {},
  ) {
    this.#dir = dir;
    this.#memory = memory;
    this.#now = now;
  }

  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined {
    const bodies = new Map<string, CompiledModuleArtifact>();
    for (const identity of identities) {
      const artifact = this.#memory.get(runtimeVersion, identity) ??
        this.#read(runtimeVersion, identity);
      if (artifact === undefined) return undefined;
      bodies.set(identity, artifact);
    }
    this.#markUsed(this.#versionDir(runtimeVersion));
    return bodies;
  }

  putAll(
    runtimeVersion: string,
    modules: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void {
    this.#memory.putAll(runtimeVersion, modules);
    const versionDir = this.#versionDir(runtimeVersion);
    try {
      Deno.mkdirSync(versionDir, { recursive: true });
      for (const { identity } of modules) {
        const path = join(versionDir, `${hashStringOf(identity)}.json`);
        if (exists(path)) continue;
        const serialized = this.#memory.serialized(runtimeVersion, identity);
        // A module the memory cache evicted as soon as it was put is larger
        // than that cache holds, and no realm would read it back whole.
        if (serialized === undefined) continue;
        writeTextFileAtomicSync(path, JSON.stringify(serialized));
      }
    } catch (error) {
      // The modules are compiled and this realm holds them; what the
      // directory lacks, the next realm to need it compiles again.
      logger.error("shared-compile-cache-write-failed", () => [
        `writing compiled modules under ${versionDir} failed; a realm that ` +
        "needs them compiles them again",
        error,
      ]);
    }
  }

  /**
   * Helper for `getCompleteSet()`, which reads one module's file into the
   * memory cache and returns it, or `undefined` where there is no file. A file
   * that does not hold the module is removed and is a miss, so that the
   * compile that follows writes it again: one cut short when its host lost
   * power, or one that names another module, which only a hash collision
   * would write.
   *
   * @throws Error when a file that is there cannot be read, which is a fault
   * of the host, not a miss.
   */
  #read(
    runtimeVersion: string,
    identity: string,
  ): CompiledModuleArtifact | undefined {
    const path = join(
      this.#versionDir(runtimeVersion),
      `${hashStringOf(identity)}.json`,
    );
    let text: string;
    try {
      text = Deno.readTextFileSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      parsed = undefined;
    }
    this.#memory.restore([parsed]);
    const artifact = this.#memory.get(runtimeVersion, identity);
    if (artifact === undefined) {
      logger.warn("shared-compile-cache-file-removed", () => [
        `${path} does not hold the compiled module it is named for; ` +
        "removing it, and compiling the module again",
      ]);
      removeIfThere(path);
    }
    return artifact;
  }

  /**
   * Helper for `getCompleteSet()`, which marks `versionDir` as used, unless
   * this realm marked it within {@link USE_MARK_INTERVAL_MS}, so that opening
   * the cache does not prune a version a running release only reads. A tree
   * that is gone, as one whose modules this realm holds in memory alone, has
   * nothing to mark, and a mark that fails is logged and fails no read.
   */
  #markUsed(versionDir: string): void {
    const now = this.#now();
    const last = this.#usedAt.get(versionDir);
    if (last !== undefined && now.getTime() - last < USE_MARK_INTERVAL_MS) {
      return;
    }
    this.#usedAt.set(versionDir, now.getTime());
    try {
      Deno.utimeSync(versionDir, now, now);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      // The read this follows succeeded; a tree left unmarked is at worst
      // pruned and compiled again.
      logger.error("shared-compile-cache-mark-failed", () => [
        `marking ${versionDir} as used failed`,
        error,
      ]);
    }
  }

  /** The tree that holds `runtimeVersion`'s modules. */
  #versionDir(runtimeVersion: string): string {
    return join(this.#dir, "modules", hashStringOf(runtimeVersion));
  }
}

/**
 * `CompileClaims` over the shared directory: a turn for a key is this realm's
 * turn for it, then an exclusive lock on the key's claim file. Two realms or
 * processes that take a turn for the same key take it one after the other, the
 * second once the first ends its turn or its process ends.
 */
export class FileCompileClaims implements CompileClaims {
  readonly #dir: string;
  readonly #open: typeof Deno.open;

  /** This realm's turns, so that one waiter per key holds the file open. */
  readonly #turns = new CompileTurns();

  /** Constructs claims over `dir`, whose files `open` opens. */
  constructor(dir: string, open: typeof Deno.open = Deno.open) {
    this.#dir = dir;
    this.#open = open;
  }

  async take(key: string): Promise<() => void> {
    const endTurn = await this.#turns.take(key);
    let file: Deno.FsFile;
    try {
      file = await this.#lockedClaimFile(
        join(this.#dir, "claims", `${hashStringOf(key)}.lock`),
      );
    } catch (error) {
      endTurn();
      throw error;
    }
    return () => {
      // Closing the file releases its lock.
      try {
        file.close();
      } finally {
        endTurn();
      }
    };
  }

  /**
   * Helper for `take()`, which opens the claim file at `path`, creating it
   * where it is missing, and returns it once this realm holds its lock and
   * has marked it used. Opening a cache removes a claim file nothing holds
   * (`removeClaimsUnusedSince()`), which can come between this realm's
   * opening of the file and its lock on it. The lock is then on a file no
   * longer at `path`, which the next realm to take the claim would not wait
   * for, so the file now at `path` is opened in its place.
   */
  async #lockedClaimFile(path: string): Promise<Deno.FsFile> {
    for (;;) {
      const file = await this.#open(path, {
        create: true,
        read: true,
        write: true,
      });
      try {
        await file.lock(true);
        if (isFileAt(await file.stat(), path)) {
          // By path: the file is the one there, and stays there while this
          // realm holds its lock, since a file is removed only under it.
          const now = new Date();
          await Deno.utime(path, now, now);
          return file;
        }
      } catch (error) {
        file.close();
        throw error;
      }
      file.close();
    }
  }
}

/**
 * Whether the file `info` describes is the one at `path` now. On a platform
 * that numbers no files, any file at `path` counts as it.
 */
function isFileAt(info: Deno.FileInfo, path: string): boolean {
  let at: Deno.FileInfo;
  try {
    at = Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  return at.ino === info.ino && at.dev === info.dev;
}

/** Whether `path` names something, telling a missing path from a failed look. */
function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Removes the file at `path`, which another process may remove first. */
function removeIfThere(path: string): void {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * Helper for `openSharedCompileCache()`, which removes each version tree in
 * `dir` last marked used before `cutoff`, in epoch milliseconds. A tree
 * another process removes first is already gone. A process still running the
 * tree's release keeps the modules it has read in memory, and compiles and
 * writes again the ones it has not.
 */
function removeVersionsUnusedSince(dir: string, cutoff: number): void {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    let modified: Date | null;
    try {
      modified = Deno.lstatSync(path).mtime;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (modified !== null && modified.getTime() < cutoff) removeIfThere(path);
  }
}

/**
 * Helper for `openSharedCompileCache()`, which removes each claim file in
 * `dir` last taken before `cutoff`, in epoch milliseconds, that no turn
 * holds. It removes a file only while holding the file's own lock, so a turn
 * that holds or is about to mark the claim keeps its file, and a turn that
 * opened the file before it was removed finds on taking the lock that the
 * file is gone (`FileCompileClaims`).
 */
function removeClaimsUnusedSince(dir: string, cutoff: number): void {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    let file: Deno.FsFile;
    try {
      file = Deno.openSync(path, { read: true, write: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    try {
      if (!file.tryLockSync(true)) continue;
      const info = file.statSync();
      if (
        info.mtime !== null && info.mtime.getTime() < cutoff &&
        isFileAt(info, path)
      ) {
        removeIfThere(path);
      }
    } finally {
      file.close();
    }
  }
}

/** Writes `text` to `path` whole: to a temporary name, then renamed. */
function writeTextFileAtomicSync(path: string, text: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    Deno.writeTextFileSync(temporary, text);
    Deno.renameSync(temporary, path);
  } catch (error) {
    try {
      Deno.removeSync(temporary);
    } catch (cleanup) {
      if (!(cleanup instanceof Deno.errors.NotFound)) throw cleanup;
    }
    throw error;
  }
}
