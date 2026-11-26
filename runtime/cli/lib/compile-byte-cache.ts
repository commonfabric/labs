import { join } from "@std/path";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import {
  type CompileClaims,
  type CompiledModuleArtifact,
  CompileTurns,
  type ModuleByteCache,
} from "@commonfabric/runner";
import { openSharedCompileCache } from "@commonfabric/runner/compilation-cache/shared-compile-cache.deno";
import {
  createCompileByteCache,
  flushCompileByteCache,
  ProcessModuleByteCache,
} from "@commonfabric/test-support/compile-byte-cache";
import {
  commonFabricCacheDir,
  type Environment,
} from "@commonfabric/test-support/records";

let defaultModuleByteCache: ModuleByteCache | undefined;

export function getDefaultModuleByteCache(): ModuleByteCache {
  defaultModuleByteCache ??= createCompileByteCache();
  return defaultModuleByteCache;
}

export function flushDefaultModuleByteCache(): void {
  if (defaultModuleByteCache !== undefined) {
    try {
      flushCompileByteCache(defaultModuleByteCache);
    } catch (error) {
      console.error("[compile-byte-cache] failed to write cache file:", error);
    }
  }
}

/**
 * The directory the connections `cf` opens keep compiled modules in:
 * `compiled-modules` in Common Fabric's per-user cache directory
 * (`commonFabricCacheDir()`). `undefined` where the environment names no
 * home directory.
 */
export function connectionCompileCacheDir(
  env: Environment,
): string | undefined {
  const cacheDir = commonFabricCacheDir(env);
  return cacheDir === undefined
    ? undefined
    : join(cacheDir, "compiled-modules");
}

/**
 * The module cache a {@link ConnectionCompileCache} uses, and, where that
 * cache is over its directory, the directory's claims.
 */
type CompileCacheParts = { modules: ModuleByteCache; claims?: CompileClaims };

/**
 * The compile cache a connection `cf` opens compiles through, over a
 * directory of the kind a toolshed's serving workers share
 * (`openSharedCompileCache()`): every process that opens the directory reads
 * the modules any of them compiled, and two that would compile the same
 * modules at once take turns, so that the second reads what the first wrote.
 * A turn is first a turn among the runtimes of this process, then a claim in
 * the directory. The directory is opened when a compile first asks for
 * anything, so a command that compiles nothing does not open it. Where there
 * is no directory, the cache keeps modules in this process's memory, and its
 * turns are among the runtimes of this process alone. It does the same from
 * the first failure of the directory, whether opening it, reading it or
 * locking in it, and gives the reason to `report`.
 */
export class ConnectionCompileCache implements ModuleByteCache, CompileClaims {
  readonly #dir: string | undefined;
  readonly #report: (message: string) => void;
  readonly #turns = new CompileTurns();
  #parts: CompileCacheParts | undefined;

  constructor(
    dir: string | undefined,
    report: (message: string) => void = (message) => console.error(message),
  ) {
    this.#dir = dir;
    this.#report = report;
  }

  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined {
    const parts = this.#current();
    try {
      return parts.modules.getCompleteSet(runtimeVersion, identities);
    } catch (error) {
      return this.#fallBack(parts, error).modules.getCompleteSet(
        runtimeVersion,
        identities,
      );
    }
  }

  putAll(
    runtimeVersion: string,
    modules: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void {
    // The directory's cache logs, and survives, a failure to write to the
    // directory.
    this.#current().modules.putAll(runtimeVersion, modules);
  }

  async take(key: string): Promise<() => void> {
    const endTurn = await this.#turns.take(key);
    let endClaim: () => void;
    try {
      endClaim = await this.#claim(key);
    } catch (error) {
      endTurn();
      throw error;
    }
    return () => {
      try {
        endClaim();
      } finally {
        endTurn();
      }
    };
  }

  /**
   * Helper for `take()`, which takes the directory's claim for `key`, and
   * returns what ends it: nothing, where the cache keeps modules in memory.
   */
  async #claim(key: string): Promise<() => void> {
    const parts = this.#current();
    if (parts.claims === undefined) return () => {};
    try {
      return await parts.claims.take(key);
    } catch (error) {
      this.#fallBack(parts, error);
      return () => {};
    }
  }

  /**
   * Helper for the members above, which returns the parts in use, opening
   * the directory the first time.
   */
  #current(): CompileCacheParts {
    if (this.#parts !== undefined) return this.#parts;
    if (this.#dir === undefined) {
      this.#parts = { modules: new ProcessModuleByteCache() };
      return this.#parts;
    }
    try {
      const { moduleByteCache, compileClaims } = openSharedCompileCache(
        this.#dir,
      );
      this.#parts = { modules: moduleByteCache, claims: compileClaims };
      return this.#parts;
    } catch (error) {
      return this.#fallBack(undefined, error);
    }
  }

  /**
   * Helper for the members above, which reports `error`, the failure of the
   * directory parts `failed` (`undefined` for a directory that did not open),
   * and keeps modules in this process's memory from then on. Where another
   * failure has already done so, the parts it put in place stay.
   */
  #fallBack(
    failed: CompileCacheParts | undefined,
    error: unknown,
  ): CompileCacheParts {
    if (this.#parts !== undefined && this.#parts !== failed) {
      return this.#parts;
    }
    const parts = { modules: new ProcessModuleByteCache() };
    this.#parts = parts;
    this.#report(
      `[compile-byte-cache] ${this.#dir} failed, so compiled modules are ` +
        `kept in this process only from now on: ${describeFailure(error)}`,
    );
    return parts;
  }
}

const connectionCompileCaches = new Map<
  string | undefined,
  ConnectionCompileCache
>();

/**
 * The compile cache the connections `cf` opens compile through, one per
 * process for each directory {@link connectionCompileCacheDir} names, so
 * that a connection reuses what an earlier connection of the process or an
 * earlier process compiled.
 */
export function connectionCompileCache(
  env: Environment = Deno.env.get,
): ConnectionCompileCache {
  const dir = connectionCompileCacheDir(env);
  let cache = connectionCompileCaches.get(dir);
  if (cache === undefined) {
    cache = new ConnectionCompileCache(dir);
    connectionCompileCaches.set(dir, cache);
  }
  return cache;
}
