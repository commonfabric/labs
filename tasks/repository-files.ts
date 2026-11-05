/**
 * The files of a working tree as git sees them, for the checks that make a
 * claim about every file in the repository.
 */

/**
 * Every file the working tree at `root` holds that the repository does not
 * ignore: tracked files still present, and untracked files no ignore rule
 * matches. Paths are relative to `root`, slash-separated, and sorted.
 *
 * This is the population a check means when it claims something of every
 * file in the repository. A directory walk reaches more than that: a
 * dependency cache, a build output, a scratch checkout nested inside an
 * ignored directory. None of those is the repository's.
 *
 * Throws when git cannot list the tree, as it cannot outside a working tree,
 * since an empty list would read as a tree holding nothing.
 */
export async function repositoryFiles(root: string): Promise<string[]> {
  const [listed, deleted] = await Promise.all([
    gitLsFiles(root, ["--cached", "--others", "--exclude-standard"]),
    gitLsFiles(root, ["--deleted"]),
  ]);
  const gone = new Set(deleted);
  return listed.filter((file) => !gone.has(file)).sort();
}

/**
 * Runs `git ls-files -z` with `args` in `root` and returns its entries.
 * Throws when git fails.
 */
export async function gitLsFiles(
  root: string,
  args: readonly string[],
): Promise<string[]> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", root, "ls-files", "-z", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    const message = new TextDecoder().decode(stderr).trim();
    throw new Error(`\`git ls-files\` failed in ${root}: ${message}`);
  }
  return new TextDecoder().decode(stdout).split("\0").filter((file) =>
    file !== ""
  );
}
