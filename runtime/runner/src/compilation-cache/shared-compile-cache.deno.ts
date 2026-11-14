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
 * name and renamed into place, so a reader sees all of an entry or none of it.
 * `claims/<key>.lock` is the file a compile of one set of modules locks while
 * it runs. The lock is the operating system's, so a process that ends, however
 * it ends, releases what it held, and a waiter wakes when the lock is released
 * rather than by looking again.
 *
 * Opening the cache removes the version trees and claim files nothing has used
 * for {@link SHARED_COMPILE_CACHE_RETENTION_MS}. A version is used each time a
 * realm first reads it, and a claim each time it is taken.
 */

import { join } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model";
import {
  type CompiledModuleArtifact,
  ProcessModuleByteCache,
} from "@commonfabric/test-support/compile-byte-cache";
import {
  type CompileClaims,
  CompileTurns,
} from "../harness/compile-interleave.ts";
import type { ModuleByteCache } from "../runtime.ts";

/**
 * How long a version tree or a claim file stays once nothing uses it: a week,
 * long enough that a release still running is never pruned under it, and
 * short enough that the releases a host has stopped running leave.
 */
export const SHARED_COMPILE_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The cache and claims over one shared directory. */
export type SharedCompileCache = {
  readonly moduleByteCache: DiskModuleByteCache;
  readonly compileClaims: FileCompileClaims;
};

/**
 * Opens the shared cache at `dir`, creating it where it is missing, and
 * removes what nothing has used for {@link SHARED_COMPILE_CACHE_RETENTION_MS}
 * before `now`.
 */
export function openSharedCompileCache(
  dir: string,
  now: Date = new Date(),
): SharedCompileCache {
  Deno.mkdirSync(join(dir, "modules"), { recursive: true });
  Deno.mkdirSync(join(dir, "claims"), { recursive: true });
  const cutoff = now.getTime() - SHARED_COMPILE_CACHE_RETENTION_MS;
  removeUnusedSince(join(dir, "modules"), cutoff);
  removeUnusedSince(join(dir, "claims"), cutoff);
  return {
    moduleByteCache: new DiskModuleByteCache(dir),
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

  /** The version trees this realm has marked as used. */
  readonly #usedVersions = new Set<string>();

  constructor(dir: string, memory = new ProcessModuleByteCache()) {
    this.#dir = dir;
    this.#memory = memory;
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
    return bodies;
  }

  putAll(
    runtimeVersion: string,
    modules: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void {
    this.#memory.putAll(runtimeVersion, modules);
    const versionDir = this.#versionDir(runtimeVersion);
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
  }

  /**
   * Helper for `getCompleteSet()`, which reads one module's file into the
   * memory cache and returns it, or `undefined` where there is no file. A file
   * that names another module, which only a hash collision would write, is a
   * miss, and the compile that follows replaces it.
   *
   * @throws Error when the file cannot be read or does not parse; each file is
   * written whole, so either is a fault of the host, not a miss.
   */
  #read(
    runtimeVersion: string,
    identity: string,
  ): CompiledModuleArtifact | undefined {
    const versionDir = this.#versionDir(runtimeVersion);
    let text: string;
    try {
      text = Deno.readTextFileSync(
        join(versionDir, `${hashStringOf(identity)}.json`),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    this.#memory.restore([JSON.parse(text)]);
    const artifact = this.#memory.get(runtimeVersion, identity);
    if (artifact !== undefined) this.#markUsed(versionDir);
    return artifact;
  }

  /**
   * Helper for `#read()`, which marks `versionDir` as used the first time this
   * realm reads from it, so that opening the cache does not prune a version a
   * running release only reads.
   */
  #markUsed(versionDir: string): void {
    if (this.#usedVersions.has(versionDir)) return;
    this.#usedVersions.add(versionDir);
    const now = new Date();
    Deno.utimeSync(versionDir, now, now);
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

  /** This realm's turns, so that one waiter per key holds the file open. */
  readonly #turns = new CompileTurns();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async take(key: string): Promise<() => void> {
    const endTurn = await this.#turns.take(key);
    let file: Deno.FsFile;
    try {
      const path = join(this.#dir, "claims", `${hashStringOf(key)}.lock`);
      file = await Deno.open(path, { create: true, read: true, write: true });
      try {
        await file.lock(true);
        const now = new Date();
        await Deno.utime(path, now, now);
      } catch (error) {
        file.close();
        throw error;
      }
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

/**
 * Helper for `openSharedCompileCache()`, which removes each entry of `dir`
 * last modified before `cutoff`, in epoch milliseconds. An entry another
 * process removes first is already gone.
 */
function removeUnusedSince(dir: string, cutoff: number): void {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    try {
      const modified = Deno.lstatSync(path).mtime;
      if (modified !== null && modified.getTime() < cutoff) {
        Deno.removeSync(path, { recursive: true });
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
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
