/**
 * The command line of a check that scans a directory: nothing, to scan the
 * check's own default, or the one directory to scan in its place.
 */

import { exists } from "@std/fs/exists";

/**
 * Runs `check` on the directory `args` names, or with no argument where
 * `args` is empty, and returns its exit status. Anything else, a flag, a
 * second argument, or a path that is not a directory, prints `usage` and
 * returns 2 without running the check.
 */
export async function runOnRoot(
  args: readonly string[],
  usage: string,
  check: (root?: string) => Promise<number>,
): Promise<number> {
  const [root, ...rest] = args;
  if (root === undefined) return await check();
  if (
    rest.length > 0 || root.startsWith("-") ||
    !await exists(root, { isDirectory: true })
  ) {
    console.error(`usage: ${usage}`);
    return 2;
  }
  return await check(root);
}
