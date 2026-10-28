/**
 * The spool lifecycle. The entry point that owns a run creates a directory
 * for it, stamps the run's context into it while the facts are certainly
 * true, and holds an advisory file lock for the run's duration. The
 * operating system releases that lock on any process death, so whether a
 * spool is live is a fact the kernel reports, never a guess from
 * timestamps. Whatever ships a spool consumes exactly that directory and
 * deletes it afterward.
 */

import { join } from "@std/path";
import {
  parseContextLine,
  parseRecordLine,
  type RunContext,
  serializeContextLine,
  type TestRecord,
} from "./schema.ts";
import { FRAGMENT_PREFIX, FRAGMENT_SUFFIX } from "./fragment.ts";

/** File inside a spool holding the stamped context line. */
export const CONTEXT_FILE = "context.ndjson";

/** File inside a spool whose advisory lock marks the owner as alive. */
export const LOCK_FILE = "owner.lock";

/** Spool directories are `run-<reportId>` under the spool root. */
export const SPOOL_DIR_PREFIX = "run-";

/**
 * A spool under construction is `staging-<reportId>` until its owner holds
 * the lock and the context is stamped, so a sweeping process never sees a
 * spool it could adopt out from under a starting owner.
 */
export const SPOOL_STAGING_PREFIX = "staging-";

/** A spool this process owns or has adopted; the lock is held until close. */
export interface HeldSpool {
  dir: string;

  /** Releases the lock and closes the lock file. */
  close(): void;
}

/**
 * Creates and locks a fresh spool directory for a run, stamping the given
 * context into it. The caller sets CF_TEST_RECORDS_DIR to `dir` for its
 * producers and ships the directory when the run ends.
 *
 * The directory is built under a staging name and renamed into place only
 * after the lock is held and the context is written: the advisory lock
 * lives on the open file handle, so it survives the rename, and a
 * concurrent sweep can never adopt a spool whose owner has not locked it
 * yet.
 */
export async function createRunSpool(
  root: string,
  context: RunContext,
): Promise<HeldSpool> {
  const staging = join(root, `${SPOOL_STAGING_PREFIX}${context.reportId}`);
  const dir = join(root, `${SPOOL_DIR_PREFIX}${context.reportId}`);
  await Deno.mkdir(staging, { recursive: true });
  let lock: Deno.FsFile | undefined;
  try {
    await Deno.writeTextFile(
      join(staging, CONTEXT_FILE),
      serializeContextLine(context),
    );
    lock = await Deno.open(join(staging, LOCK_FILE), {
      create: true,
      write: true,
    });
    const locked = await lock.tryLock(true);
    if (!locked) {
      throw new Error(
        `another process holds the lock of freshly created spool ${staging}`,
      );
    }
    await Deno.rename(staging, dir);
  } catch (error) {
    lock?.close();
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw error;
  }
  const held = lock;
  return {
    dir,
    close: () => {
      try {
        held.close();
      } catch {
        // The lock dies with the file handle either way.
      }
    },
  };
}

/**
 * Tries to adopt a spool directory whose owner may be dead. Returns the
 * held spool when the owner's lock was free — the kernel released it on the
 * owner's death — and undefined while the owner still holds it, which is
 * what makes sweeping safe with any number of parallel runs.
 */
export async function tryAdoptSpool(
  dir: string,
): Promise<HeldSpool | undefined> {
  let lock: Deno.FsFile;
  try {
    lock = await Deno.open(join(dir, LOCK_FILE), { create: true, write: true });
  } catch {
    return undefined;
  }
  let locked = false;
  try {
    locked = await lock.tryLock(true);
  } catch {
    lock.close();
    return undefined;
  }
  if (!locked) {
    lock.close();
    return undefined;
  }
  return {
    dir,
    close: () => {
      try {
        lock.close();
      } catch {
        // The lock dies with the file handle either way.
      }
    },
  };
}

/** Lists spool directories under a root, oldest first by name. */
export function listSpools(root: string): Promise<string[]> {
  return listPrefixed(root, SPOOL_DIR_PREFIX);
}

/**
 * Lists staging directories under a root: spools whose owners died between
 * creating the directory and renaming it into place. Nothing ever ran with
 * such a directory as its spool, so a sweeper deletes them rather than
 * shipping them.
 */
export function listStagingSpools(root: string): Promise<string[]> {
  return listPrefixed(root, SPOOL_STAGING_PREFIX);
}

async function listPrefixed(root: string, prefix: string): Promise<string[]> {
  const dirs: string[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(root);
  } catch {
    return dirs;
  }
  try {
    for await (const entry of entries) {
      if (entry.isDirectory && entry.name.startsWith(prefix)) {
        dirs.push(join(root, entry.name));
      }
    }
  } catch {
    // A root vanishing mid-listing yields the entries read so far.
  }
  return dirs.sort();
}

/** What a spool held: its stamped context, records, and any read warnings. */
export interface SpoolContents {
  context: RunContext | undefined;
  records: TestRecord[];
  warnings: string[];
}

/**
 * Reads a spool's stamped context and every fragment, line by line. A torn
 * final line from a killed producer is dropped with a warning and costs
 * only itself; a line that does not parse as a record is dropped the same
 * way. Fragments are never concatenated as bytes.
 */
export async function readSpool(dir: string): Promise<SpoolContents> {
  const warnings: string[] = [];
  let context: RunContext | undefined;
  try {
    const text = await Deno.readTextFile(join(dir, CONTEXT_FILE));
    const line = text.split("\n", 1)[0] ?? "";
    context = parseContextLine(line);
    if (context === undefined) {
      warnings.push(`unreadable context line in ${dir}`);
    }
  } catch {
    context = undefined;
  }
  const records: TestRecord[] = [];
  let names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile && entry.name.startsWith(FRAGMENT_PREFIX) &&
        entry.name.endsWith(FRAGMENT_SUFFIX)
      ) {
        names.push(entry.name);
      }
    }
  } catch {
    names = [];
  }
  names.sort();
  for (const name of names) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, name));
    } catch (error) {
      warnings.push(`unreadable fragment ${name}: ${error}`);
      continue;
    }
    const lines = text.split("\n");
    const tail = lines.pop();
    if (tail !== undefined && tail.length > 0) {
      warnings.push(`dropped a torn final line in ${name}`);
    }
    for (const line of lines) {
      if (line.length === 0) continue;
      const record = parseRecordLine(line);
      if (record === undefined) {
        warnings.push(`dropped a line no reader accepts in ${name}`);
        continue;
      }
      records.push(record);
    }
  }
  return { context, records, warnings };
}

/** Removes a shipped spool directory. */
export async function deleteSpool(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true });
}
