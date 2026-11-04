/**
 * Decides where the dashboard's on-disk caches live, so every store that keeps
 * history across restarts agrees on one directory. DASHBOARD_CACHE_DIR names
 * it outright; without that the caches fall back to the temporary directory
 * the platform offers.
 *
 * Also replaces a cache file for the processes that share it. A writer holds
 * the file's lock, writes a temporary file beside it, and renames that over
 * it, so a file is never changed in place and a reader reads one whole
 * version. Each writer removes the temporary files that writes cut short left
 * behind the first time it takes the lock.
 */

import { basename, dirname, join } from "@std/path";
import { describeFailure } from "@commonfabric/js-values/describe-failure";

type Environment = (name: string) => string | undefined;

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function dashboardCacheDirectory(
  env: Environment = Deno.env.get,
): string {
  return env("DASHBOARD_CACHE_DIR") ?? env("TMPDIR") ?? env("TEMP") ??
    env("TMP") ?? (Deno.build.os === "windows" ? "." : "/tmp");
}

export function dashboardCacheFile(
  basename: string,
  env: Environment = Deno.env.get,
): string {
  return join(dashboardCacheDirectory(env), basename);
}

/**
 * One cache file that the processes sharing it replace whole while holding
 * its lock, and that decodes to a `T`. An instance remembers the version of
 * the file it last read or wrote, by its device, inode, size, and modification
 * time to the millisecond, with what that version decodes to. No version is
 * changed in place, and a version's inode is freed only once a later version
 * replaces it, so the file is still the version remembered unless the inode
 * was then reused by a file of the same size modified within the same
 * millisecond.
 */
export class CacheFile<T = never> {
  #path: string;
  #version: string | undefined;
  #value: T | undefined;
  #reading: Promise<T | undefined> | undefined;
  #holding = false;
  #swept = false;

  /** Constructs an instance for the cache file at `path`. */
  constructor(path: string) {
    this.#path = path;
  }

  /** The path of the file. */
  get path(): string {
    return this.#path;
  }

  /**
   * Runs `body` holding the lock on the file that every process writing it
   * holds, once `removeLeftoverTemporaries()` has run.
   */
  async locked<R>(body: () => Promise<R>): Promise<R> {
    const lock = await Deno.open(`${this.#path}.lock`, {
      create: true,
      write: true,
    });
    try {
      await lock.lock(true);
      this.#holding = true;
      try {
        await this.removeLeftoverTemporaries();
        return await body();
      } finally {
        this.#holding = false;
      }
    } finally {
      lock.close();
    }
  }

  /**
   * Returns whether the file is the version this instance last read or wrote.
   * It never is on a platform that gives no inode numbers.
   */
  async isUnchanged(): Promise<boolean> {
    return await this.#isAt(this.#version);
  }

  /**
   * Returns what `decode` makes of the file's text, or `undefined` when there
   * is no file. While the file is still the version this instance last read or
   * wrote, returns what it decoded or was given for that version without
   * reading the file. Calls made while a read is in progress share it, unless
   * this instance holds the lock: a read started before the lock was taken
   * can have read a version that was replaced before it was.
   */
  async read(decode: (text: string) => T): Promise<T | undefined> {
    const version = this.#version;
    const value = this.#value;
    if (value !== undefined && await this.#isAt(version)) return value;
    if (this.#holding) return await this.#readNow(decode);
    this.#reading ??= this.#readNow(decode).finally(() => {
      this.#reading = undefined;
    });
    return await this.#reading;
  }

  /**
   * Removes the temporary files beside the file that interrupted writes left
   * behind, the first time it is called. The caller holds the lock, or no
   * process writes the file any more, and only a process holding the lock
   * writes the file, so every temporary file is a leftover. A file that cannot
   * be removed is logged and left.
   */
  async removeLeftoverTemporaries(): Promise<void> {
    if (this.#swept) return;
    this.#swept = true;
    const directory = dirname(this.#path);
    const name = basename(this.#path);
    const leftovers: string[] = [];
    try {
      for await (const entry of Deno.readDir(directory)) {
        if (entry.isFile && isTemporaryOf(entry.name, name)) {
          leftovers.push(join(directory, entry.name));
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(
          `Cache files could not list ${directory}: ${describeFailure(error)}`,
        );
      }
    }
    for (const leftover of leftovers) {
      try {
        await Deno.remove(leftover);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          console.error(
            `Cache files could not remove ${leftover}: ${
              describeFailure(error)
            }`,
          );
        }
      }
    }
  }

  /**
   * Replaces the file with `text`, which decodes to `value` when one is given.
   * The caller holds the lock.
   */
  async write(text: string, value?: T): Promise<void> {
    this.#version = versionOf(
      await replaceFile(this.#path, encoder.encode(text)),
    );
    this.#value = value;
  }

  /** Helper for `isUnchanged()` and `read()`. */
  async #isAt(version: string | undefined): Promise<boolean> {
    if (version === undefined) return false;
    try {
      return versionOf(await Deno.stat(this.#path)) === version;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  /**
   * Helper for `read()`, which reads and decodes the file, and remembers what
   * it decoded with the version read.
   */
  async #readNow(decode: (text: string) => T): Promise<T | undefined> {
    // What an earlier version decoded to is let go before the file is read.
    this.#version = undefined;
    this.#value = undefined;
    let file: Deno.FsFile;
    try {
      file = await Deno.open(this.#path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    let version: string | undefined;
    try {
      version = versionOf(await file.stat());
    } catch (error) {
      file.close();
      throw error;
    }
    // The stream closes the file once it has been read.
    const decoded = decode(await new Response(file.readable).text());
    this.#version = version;
    this.#value = decoded;
    return decoded;
  }
}

/**
 * Replaces the file at `path` with `bytes` through a temporary file named
 * `<path>.<UUID>.tmp`, and returns what `Deno.stat()` says of the new file.
 * The temporary file is removed when the write fails. Anything that removes
 * leftover temporary files beside `path` leaves this one alone until the call
 * settles; `CacheFile` does so by holding the file's lock for both.
 */
export async function replaceFile(
  path: string,
  bytes: Uint8Array,
): Promise<Deno.FileInfo> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeFile(temporary, bytes, { createNew: true });
    const info = await Deno.stat(temporary);
    await Deno.rename(temporary, path);
    return info;
  } catch (error) {
    try {
      await Deno.remove(temporary);
    } catch {
      // Ignore cleanup when no temporary file remains.
    }
    throw error;
  }
}

/**
 * Helper for `CacheFile.removeLeftoverTemporaries()`, which returns whether
 * `name` is the name of a temporary file written for the file named `of`,
 * either `<of>.<UUID>.tmp` or `<of>.tmp-<UUID>`.
 */
function isTemporaryOf(name: string, of: string): boolean {
  const id = name.startsWith(`${of}.tmp-`)
    ? name.slice(of.length + 5)
    : name.startsWith(`${of}.`) && name.endsWith(".tmp")
    ? name.slice(of.length + 1, -4)
    : undefined;
  return id !== undefined && UUID.test(id);
}

/** Helper for `CacheFile`, which returns the version `info` names. */
function versionOf(info: Deno.FileInfo): string | undefined {
  return info.ino === null || info.mtime === null
    ? undefined
    : `${info.dev}:${info.ino}:${info.size}:${info.mtime.getTime()}`;
}
