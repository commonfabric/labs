/**
 * The environment for git commands about the repository a directory is in,
 * for a viewer that git may have started as its pager with variables that
 * name git's own repository.
 */

/** `env` without the variables that tie git to one repository, as
 * `git rev-parse --local-env-vars` lists them, apart from those that carry
 * configuration, such as the settings `git -c` passes on, so that git finds
 * the repository from the directory it runs in. Git can export some of them to
 * the pager it starts: it exports `GIT_DIR` for a linked worktree, for
 * instance, and with `GIT_DIR` and no `GIT_WORK_TREE`, git takes the
 * directory it runs in as the top of that repository's working tree. Throws
 * git's message when git cannot list them. */
export function repositoryIndependentEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  return withoutLocalVariables(
    env,
    gitCommand(LOCAL_VARIABLES, env).outputSync(),
  );
}

/** The environment for git commands about the repository a directory is in,
 * made from `env`, the environment this process started with in the
 * directory `start`. When git finds the same repository and working tree from
 * `start` without the variables that tie it to one, as it does for a linked
 * worktree, the result leaves them out, as {@link repositoryIndependentEnv}
 * does, so that git finds each directory's own repository. When it finds
 * another or none, as for a repository named with `--git-dir` and
 * `--work-tree`, the result names the repository `env` names, by absolute
 * paths, which hold wherever git runs. Rejects with git's message when git
 * cannot list the variables. */
export async function repositoryEnv(
  env: Readonly<Record<string, string>>,
  start: string,
): Promise<Record<string, string>> {
  const independent = withoutLocalVariables(
    env,
    await gitCommand(LOCAL_VARIABLES, env).output(),
  );
  const [named, found] = await Promise.all(
    [env, independent].map((commandEnv) =>
      gitCommand(
        ["rev-parse", "--absolute-git-dir", "--show-toplevel"],
        commandEnv,
        start,
      ).output()
    ),
  );
  const decoder = new TextDecoder();
  const repository = decoder.decode(named.stdout);
  const [gitDir, workTree] = repository.split("\n");
  return !named.success || decoder.decode(found.stdout) === repository
    ? independent
    : { ...independent, GIT_DIR: gitDir, GIT_WORK_TREE: workTree };
}

const LOCAL_VARIABLES = ["rev-parse", "--local-env-vars"];

function gitCommand(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd?: string,
): Deno.Command {
  return new Deno.Command("git", {
    args: [...args],
    cwd,
    env: { ...env },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
}

/** `env` without the variables named on the lines `listed` wrote, apart from
 * those that carry configuration. Throws git's message when `listed` failed. */
function withoutLocalVariables(
  env: Readonly<Record<string, string>>,
  listed: Deno.CommandOutput,
): Record<string, string> {
  const decoder = new TextDecoder();
  if (!listed.success) {
    throw new Error(
      `git rev-parse --local-env-vars failed: ${
        decoder.decode(listed.stderr).trim()
      }`,
    );
  }
  const local = new Set(decoder.decode(listed.stdout).split("\n"));
  return Object.fromEntries(
    Object.entries(env).filter(([name]) =>
      !local.has(name) || name.startsWith("GIT_CONFIG")
    ),
  );
}
