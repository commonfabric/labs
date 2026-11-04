/**
 * What a caller appends to a `deno test` invocation to make it record:
 * where the registration preload lives on disk, and the permissions that
 * preload needs to read the skip list and leave its name map behind.
 *
 * `deno test --preload` takes a path rather than an import-map
 * specifier, and a test task runs with its own package as the working
 * directory, so every caller needs an absolute path rather than a
 * relative one.
 */

import { fromFileUrl, isAbsolute } from "@std/path";
import { repositoryMarker } from "./paths.ts";

/** Absolute path of the module `--preload` is pointed at. */
export function preloadModulePath(): string {
  return fromFileUrl(new URL("./preload.ts", import.meta.url));
}

/** The `--preload=<path>` argument naming that module. */
export function preloadArgument(): string {
  return `--preload=${preloadModulePath()}`;
}

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

/**
 * The paths by which a preload may reach the repository's marker as it
 * climbs: under the root as given, and under the root with every symbolic
 * link in it resolved, where that differs. Deno names the main module by the path the command
 * gave it, resolved against the working directory where it is relative,
 * and the working directory is always canonical; a grant is checked
 * against a path exactly as the grant writes it. A root that does not
 * exist has only the one path.
 */
function markerPaths(root: string): string[] {
  let canonical: string;
  try {
    canonical = Deno.realPathSync(root);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [repositoryMarker(root)];
    throw error;
  }
  return [...new Set([repositoryMarker(root), repositoryMarker(canonical)])];
}

/** Where the preload of one recording invocation reads and writes. */
export interface RecordingPaths {
  /** The run's spool, which the preload leaves its name map in. */
  spool: string;

  /** The root of the repository holding the invocation's test files. */
  root: string;

  /** The file naming the tests the invocation is not to run, if any. */
  skipList?: string;
}

/**
 * The arguments that make a `deno test` invocation record: the preload,
 * and each permission the preload needs that the invocation's own flags
 * do not already grant.
 *
 * The preload reads the skip list, and it reads the repository's marker
 * as it climbs from the test file to the root, since that climb is what
 * names the file each test is keyed by in the skip list and in the name
 * map. It writes the name map into the spool.
 *
 * Each of those is a path only the environment knows and a test task
 * cannot name: `deno task` expands `$VAR` but not `${VAR:-default}`, and
 * `--allow-write=` with an unset variable ends the run. So the caller
 * appending the preload appends the permissions beside it, for the
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
  const reads = markerPaths(paths.root);
  if (paths.skipList !== undefined) reads.push(paths.skipList);
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
  const args = [preloadArgument()];
  if (!grantsEverything(flags, "--allow-read", "R")) {
    args.push(`--allow-read=${reads.join(",")}`);
  }
  if (!grantsEverything(flags, "--allow-write", "W")) {
    args.push(`--allow-write=${paths.spool}`);
  }
  return args;
}
