/**
 * Pushing the checked-out branch from `cf view`: push it as it stands to the
 * `origin` remote, and open the page the hosting service offers for creating a
 * pull request. The repository is the one the viewer's working directory is in,
 * which is the one the diff workspace reads files from.
 */

/** The git and browser operations a push performs. */
export interface PushIo {
  /** Runs git for its standard output, which it returns, or null when git
   * fails. Nothing is shown. */
  query(args: readonly string[]): string | null;

  /** Runs git with its output shown as it arrives. Resolves to whether git
   * succeeded, and to everything it printed. */
  run(args: readonly string[]): Promise<{ success: boolean; output: string }>;

  /** The canonical git directory named by an inherited `GIT_DIR`, which git
   * exports to a pager it starts when its own repository was named that way, or
   * null when there is none. */
  pagedGitDir(): string | null;

  /** Starts opening `url` in the browser, returning whether that could
   * start. */
  open(url: string): boolean;
}

/** What {@link realPushIo} works with. Each optional one has the process's
 * own as its default. */
export interface RealPushIoOptions {
  /** A directory in the repository to push. */
  readonly cwd?: string;

  /** The environment the viewer was started with. */
  readonly env?: Readonly<Record<string, string>>;

  /** The program that opens a URL in the browser. */
  readonly opener?: string;

  /** Shows git's output. */
  readonly write: (text: string) => void;

  /** Stops a running git when it aborts. */
  readonly signal?: AbortSignal;
}

/**
 * Force-pushes the checked-out branch to the same-named branch on `origin`,
 * unless that branch has commits the checked-out branch has never included,
 * and opens the pull request page when the server offers one. The branch
 * `origin` names as its default is never pushed, so the push refuses when
 * `origin` names none. Returns one line saying how it ended, which says the
 * push was aborted when it failed after `signal` aborted; git's own output has
 * been shown by then.
 */
export async function pushBranch(
  io: PushIo,
  signal?: AbortSignal,
): Promise<string> {
  const gitDir = io.query(["rev-parse", "--absolute-git-dir"])?.trim();
  if (!gitDir) return "This is not a git repository.";
  const paged = io.pagedGitDir();
  if (paged !== null && paged !== gitDir) {
    return `Not pushing: git is paging output for ${paged}, but the viewer ` +
      `is running in ${gitDir}.`;
  }
  // The full name, since a short one is qualified, as `heads/foo`, when a
  // tag shares it.
  const head = io.query(["symbolic-ref", "--quiet", "HEAD"])?.trim();
  const branch = head?.startsWith("refs/heads/")
    ? head.slice("refs/heads/".length)
    : undefined;
  if (!branch) {
    return "This checkout is not on a branch. Check out or create a branch " +
      "first.";
  }
  const main = io.query(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    ?.trim().slice("refs/remotes/origin/".length);
  if (!main) {
    return "Not pushing: origin's default branch is unknown. " +
      "`git remote set-head origin --auto` finds it.";
  }
  if (branch === main) {
    return `Rename the branch first. You were about to push your ${main} ` +
      "branch.";
  }
  const pushed = `Pushed ${branch} to origin`;
  const push = await io.run([
    "push",
    "--force-with-lease",
    "--force-if-includes",
    "--progress",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!push.success) {
    return signal?.aborted
      ? "Push aborted."
      : `Pushing ${branch} to origin failed.`;
  }
  const url = offeredPullRequestUrl(push.output);
  if (url === null) return `${pushed}.`;
  return io.open(url)
    ? `${pushed} and opened ${url}`
    : `${pushed}. Create a pull request at ${url}`;
}

/**
 * The address of the page a server offered for creating a pull request (or a
 * merge request) in the output of `git push`, or null when it offered none.
 * Servers send such offers on lines prefixed `remote:`, with the address on
 * the line making the offer or on the next such line.
 */
export function offeredPullRequestUrl(output: string): string | null {
  let linesLeft = 0;
  for (const line of output.split(/\r\n|\r|\n/)) {
    const message = /^remote:(.*)$/.exec(line)?.[1];
    if (message === undefined) continue;
    if (/create (a )?(pull|merge) request/i.test(message)) linesLeft = 2;
    if (linesLeft === 0) continue;
    linesLeft--;
    const url = /https?:\/\/\S+/.exec(message);
    if (url) return url[0];
  }
  return null;
}

/** The real operations, against the repository at `cwd`. */
export function realPushIo({
  cwd = Deno.cwd(),
  env = Deno.env.toObject(),
  opener = Deno.build.os === "darwin" ? "open" : "xdg-open",
  write,
  signal,
}: RealPushIoOptions): PushIo {
  const decoder = new TextDecoder();
  const git = (args: readonly string[], commandEnv: Record<string, string>) =>
    new Deno.Command("git", {
      args: [...args],
      cwd,
      env: commandEnv,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    });
  const capture = (
    args: readonly string[],
    commandEnv: Record<string, string>,
  ): string | null => {
    const result = git(args, commandEnv).outputSync();
    return result.success ? decoder.decode(result.stdout) : null;
  };
  // Git exports variables such as `GIT_DIR` to the pager it starts. Without
  // them, git finds the repository from the working directory.
  const local = new Set(
    capture(["rev-parse", "--local-env-vars"], { ...env })?.split("\n"),
  );
  // The viewer holds the terminal, so git and ssh ask for nothing there: a
  // question goes to the user's own askpass program when they have one, and
  // otherwise fails.
  const repoEnv = {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !local.has(name)),
    ),
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: env.SSH_ASKPASS ?? "false",
    SSH_ASKPASS_REQUIRE: "force",
  };
  return {
    query: (args) => capture(args, repoEnv),
    run: async (args) => {
      const child = git(args, repoEnv).spawn();
      let output = "";
      // An abort stops the relays as well as git, in case a process git
      // started still holds the pipes.
      const relay = async (stream: ReadableStream<BufferSource>) => {
        try {
          const texts = stream.pipeThrough(new TextDecoderStream(), { signal });
          for await (const text of texts) {
            write(text);
            output += text;
          }
        } catch (error) {
          if (!signal?.aborted) throw error;
        }
      };
      const [status] = await Promise.all([
        child.status,
        relay(child.stdout),
        relay(child.stderr),
      ]);
      return { success: status.success, output };
    },
    pagedGitDir: () =>
      env.GIT_DIR === undefined
        ? null
        : capture(["rev-parse", "--absolute-git-dir"], { ...env })?.trim() ??
          env.GIT_DIR,
    // Some openers wait for the browser to exit, so the viewer neither waits
    // for one nor stays open for it.
    open: (url) => {
      try {
        new Deno.Command(opener, {
          args: [url],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn().unref();
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
  };
}
