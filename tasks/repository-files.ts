/**
 * The files of a working tree as git sees them, for the checks that make a
 * claim about every file in the repository, and the git runner and default
 * base revision those checks share.
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
  const listed = await gitIn(root)("ls-files", "-z", ...args);
  return listed.split("\0").filter((file) => file !== "");
}

/**
 * Runs git with `args` and returns its standard output. Throws when git
 * fails, naming the command and what git said.
 */
export type Git = (...args: string[]) => Promise<string>;

/**
 * A {@link Git} that runs in `directory`, or in the process's own directory
 * where none is given.
 */
export function gitIn(directory?: string): Git {
  const where = directory === undefined ? "" : ` in ${directory}`;
  return async (...args) => {
    const { code, stdout, stderr } = await new Deno.Command("git", {
      args: directory === undefined ? args : ["-C", directory, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      const message = new TextDecoder().decode(stderr).trim();
      throw new Error(`\`git ${args.join(" ")}\` failed${where}: ${message}`);
    }
    return new TextDecoder().decode(stdout);
  };
}

/** Runs git in the process's own directory. */
export const git: Git = gitIn();

/**
 * The revision a change is compared against where the command line names
 * none, in the repository `run` runs git in: `upstream/main` in a checkout
 * of a fork, which is where a pull request's base lives, and `origin/main`
 * otherwise. Each is given by its full name, so that a local branch of the
 * same short name does not stand in for it. Throws when git fails.
 */
export async function defaultBase(run: Git): Promise<string> {
  const upstream = "refs/remotes/upstream/main";
  const listed = await run("for-each-ref", "--format=%(refname)", upstream);
  return listed.trim() === upstream ? upstream : "refs/remotes/origin/main";
}
