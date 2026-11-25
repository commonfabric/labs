/**
 * What a caller appends to a `deno test` invocation so that its tests can
 * record: permission to read the skip list and to write their results into
 * the spool.
 */

import { isAbsolute } from "@std/path";

/**
 * Whether a flag list grants one permission over the whole filesystem,
 * given the long flag naming it and the letter it takes as a short one.
 * Short flags cluster, so `-RW` grants read and write together, and `-A`
 * grants everything however it is written.
 */
function grantsEverything(
  flags: readonly string[],
  long: string,
  letter: string,
): boolean {
  return flags.some((flag) => {
    if (flag === long || flag === "--allow-all") return true;
    if (!/^-[A-Za-z]+$/.test(flag)) return false;
    return flag.includes(letter) || flag.includes("A");
  });
}

/** Where the tests of one recording invocation read and write. */
export interface RecordingPaths {
  /** The run's spool, which the tests write their results into. */
  spool: string;

  /** The file naming the tests the invocation is not to run, if any. */
  skipList?: string;
}

/**
 * The permissions a `deno test` invocation's tests need to record that the
 * invocation's own flags do not already grant.
 *
 * Each of those is a path only the environment knows and a test task
 * cannot name: `deno task` expands `$VAR` but not `${VAR:-default}`, and
 * `--allow-write=` with an unset variable ends the run. So the caller
 * asking the invocation to record appends the permissions, for the
 * invocation that needs them and no other.
 *
 * Deno merges two path lists for one permission, so an invocation
 * carrying a list of its own takes these on top of it and one carrying
 * none takes them alone. An invocation already permitted to read, or to
 * write, everywhere is given no list for that permission. Beside `-A` or
 * `--allow-all`, a path list ends the run before it starts, with `the
 * argument '--allow-all...' cannot be used with '--allow-write[=<PATH>...]'`.
 * Beside a bare `--allow-read` or `--allow-write`, a short flag, or a
 * cluster holding one of them, it cuts that grant down to the list.
 */
export function recordingArguments(
  flags: readonly string[],
  paths: RecordingPaths,
): string[] {
  const reads = paths.skipList === undefined ? [] : [paths.skipList];
  for (const path of [...reads, paths.spool]) {
    if (!isAbsolute(path)) {
      throw new Error(
        `test records: a path to grant must be absolute: "${path}"`,
      );
    }
    // A comma is what separates one path from the next inside an
    // `--allow-read=` or `--allow-write=` list, and Deno offers no way to
    // write one that is part of a path, so a path holding one is granted
    // as two paths that are not it.
    if (path.includes(",")) {
      throw new Error(
        `test records: a path to grant cannot hold a comma: "${path}"`,
      );
    }
  }
  const args: string[] = [];
  if (reads.length > 0 && !grantsEverything(flags, "--allow-read", "R")) {
    args.push(`--allow-read=${reads.join(",")}`);
  }
  if (!grantsEverything(flags, "--allow-write", "W")) {
    args.push(`--allow-write=${paths.spool}`);
  }
  return args;
}
