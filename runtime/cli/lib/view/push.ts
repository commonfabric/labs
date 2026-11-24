/**
 * Pushing the checked-out branch from `cf view`: push it as it stands to the
 * `origin` remote, and find the page the hosting service offers for creating
 * a pull request. The repository is the one the viewer's working directory is
 * in, which is the one the diff workspace reads files from.
 */

import { repositoryIndependentEnv } from "./gitenv.ts";
import { link, name, say, type TaskOutput, type TaskText } from "./tasklog.ts";

/** Runs git for its standard output, which it returns, or null when git
 * fails. Nothing is shown. */
export type GitQuery = (args: readonly string[]) => string | null;

/** Runs git for its standard output, which it resolves with, or with null
 * when git fails. */
export type GitQueryAsync = (args: readonly string[]) => Promise<string | null>;

/** The git and browser operations a push performs, and where it says what
 * it does and shows what git writes. */
export interface PushIo extends TaskOutput {
  /** Runs git for its standard output, which it returns, or null when git
   * fails. Nothing is shown. */
  readonly query: GitQuery;

  /** Runs git for its standard output, as {@link query} does, but without
   * holding up the viewer while git waits, as it does for a server. Shows
   * what git wrote to its standard error only when it fails. */
  readonly queryAsync: GitQueryAsync;

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

/** What {@link realPushIo} works with: where the push says what it does and
 * shows git's output, and others, each of which has the process's own as its
 * default. */
export interface RealPushIoOptions extends TaskOutput {
  /** A directory in the repository to push. */
  readonly cwd?: string;

  /** The environment the viewer was started with. */
  readonly env?: Readonly<Record<string, string>>;

  /** The program that opens a URL in the browser. */
  readonly opener?: string;

  /** Stops a running git when it aborts. */
  readonly signal?: AbortSignal;
}

/** How the same-named branch on `origin`, as git last fetched or pushed it,
 * stands against the checked-out commit. */
export interface PushedBranch {
  /** The commit `origin`'s branch is at. */
  readonly commit: string;

  /** How many commits each side has that the other does not, or null when
   * the checkout's history is shallow, so that git cannot count them. */
  readonly counts: {
    /** How many commits the checkout has that `origin`'s branch does not. */
    readonly added: number;

    /** How many commits `origin`'s branch has that the checkout does not,
     * which a push removes from it. */
    readonly removed: number;
  } | null;
}

/**
 * Force-pushes the checked-out branch to the same-named branch on `origin`,
 * unless that branch has commits the checked-out branch has never included.
 * The branch `origin` names as its default is never pushed: that is `main`
 * when given, and otherwise what {@link defaultBranch} asks `origin`, with a
 * step, shown with `io`, that says so. The push refuses when `origin` names
 * none or cannot be asked. When `origin` already has the branch and there is
 * an `ask`, pushes nothing, and returns what `ask` returns, given the
 * branch's name, how `origin`'s branch stands, and `origin`'s default branch;
 * otherwise it pushes, and returns one line saying how that ended. Shows a
 * step that says which branch it pushes before git starts, and that is done
 * once git succeeds. Once the push succeeds, calls `onPushed` with the
 * branch's name and the address of the page the server offers for creating a
 * pull request, or null when it offers none; by default, it opens the page,
 * and the line it returns ends with what `onPushed` returns. When git fails
 * to push, or to say which branch is the default, calls `onFailed` with what
 * the push printed, which is nothing in the second case, and `origin`'s
 * default branch, in the first case; the line it returns says the push was aborted when it failed after `signal` aborted;
 * git's own output has been shown by then.
 */
export async function pushBranch<Asked = never>(
  io: PushIo,
  signal?: AbortSignal,
  onPushed: (
    branch: string,
    url: string | null,
  ) => Promise<TaskText> | TaskText = (_, url) =>
    url === null ? [] : openPage(io, url),
  onFailed: (output: string, main?: string) => void = () => {},
  ask?: (
    branch: string,
    remote: PushedBranch,
    main: string,
  ) => Promise<Asked>,
  main?: string,
): Promise<TaskText | Asked> {
  const gitDir = io.query(["rev-parse", "--absolute-git-dir"])?.trim();
  if (!gitDir) return say`This is not a git repository.`;
  const paged = io.pagedGitDir();
  if (paged !== null && paged !== gitDir) {
    return say`Not pushing: git is paging output for ${paged}, but the viewer is running in ${gitDir}.`;
  }
  // The full name, since a short one is qualified, as `heads/foo`, when a
  // tag shares it.
  const head = io.query(["symbolic-ref", "--quiet", "HEAD"])?.trim();
  const branch = head?.startsWith("refs/heads/")
    ? head.slice("refs/heads/".length)
    : undefined;
  if (!branch) {
    return say`This checkout is not on a branch. Check out or create a branch first.`;
  }
  if (main === undefined) {
    const asking = io.step(
      say`Asking ${name("origin")} which branch is its default`,
    );
    const named = await defaultBranch(io.queryAsync, "origin");
    if (named === null || signal?.aborted) {
      onFailed("");
      return signal?.aborted
        ? say`Push aborted.`
        : say`Not pushing: ${name("origin")}'s default branch is unknown.`;
    }
    asking();
    main = named;
  }
  if (branch === main) {
    return say`Rename the branch first. You were about to push your ${main} branch.`;
  }
  if (ask) {
    const remote = pushedBranch(io.query, branch);
    if (remote !== null) return await ask(branch, remote, main);
  }
  const pushing = io.step(say`Pushing ${branch} to ${name("origin")}`);
  const push = await io.run([
    "push",
    "--force-with-lease",
    "--force-if-includes",
    "--progress",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!push.success) {
    onFailed(push.output, main);
    return signal?.aborted
      ? say`Push aborted.`
      : say`Pushing ${branch} to ${name("origin")} failed.`;
  }
  pushing();
  const then = await onPushed(branch, offeredPullRequestUrl(push.output));
  const pushed = say`Pushed ${branch} to ${name("origin")}.`;
  return then.length === 0 ? pushed : say`${pushed} ${then}`;
}

/**
 * Resolves with the branch that the server of the remote named `remote` says
 * is its repository's default now, or with null when the server names none or
 * git cannot ask it. Git sets `refs/remotes/<remote>/HEAD` when it clones and
 * leaves it as it is when the default branch changes, so that ref is not
 * consulted.
 */
export async function defaultBranch(
  query: GitQueryAsync,
  remote: string,
): Promise<string | null> {
  const listed = await query(["ls-remote", "--symref", remote, "HEAD"]);
  return /^ref: refs\/heads\/([^\t]+)\tHEAD$/m.exec(listed ?? "")?.[1] ??
    null;
}

/**
 * Returns how `branch` on `origin`, as git last fetched or pushed it, stands
 * against the checked-out commit, or null when git has never seen `origin`
 * have it. Throws when git cannot compare the two.
 */
export function pushedBranch(
  git: GitQuery,
  branch: string,
): PushedBranch | null {
  const tracking = `refs/remotes/origin/${branch}`;
  const commit = git(["rev-parse", "--verify", "--quiet", tracking])?.trim();
  if (!commit) return null;
  // A shallow history's commits end at the depth it was cloned or fetched
  // to, so counting them leaves out those beyond it.
  if (git(["rev-parse", "--is-shallow-repository"])?.trim() === "true") {
    return { commit, counts: null };
  }
  const counts = /^(\d+)\s+(\d+)$/.exec(
    git(["rev-list", "--left-right", "--count", `${tracking}...HEAD`])
      ?.trim() ?? "",
  );
  if (counts === null) {
    throw new Error(`git could not compare ${branch} with origin's`);
  }
  return {
    commit,
    counts: { removed: Number(counts[1]), added: Number(counts[2]) },
  };
}

/** Returns what pushing `branch`, which `origin` has as `pushed` says,
 * would do, in a sentence or two. */
export function describePush(branch: string, pushed: PushedBranch): TaskText {
  const commits = (count: number) =>
    say`${String(count)} ${count === 1 ? say`commit` : say`commits`}`;
  const { counts } = pushed;
  const effect = counts === null
    ? say`This checkout's history is shallow, so the commits pushing would add or remove cannot be counted.`
    : counts.removed > 0
    ? say`Pushing would replace it, removing ${
      commits(counts.removed)
    } that this checkout does not have${
      counts.added > 0 ? say` and adding ${commits(counts.added)}` : []
    }.`
    : counts.added > 0
    ? say`Pushing would add ${commits(counts.added)} to it.`
    : say`Pushing would leave it as it is.`;
  return say`${name("origin")} already has ${branch}, at ${
    pushed.commit.slice(0, 12)
  } when last fetched or pushed. ${effect}`;
}

/** Opens the page at `url` for creating a pull request, and returns a
 * sentence saying so, or giving its address when it cannot be opened. */
export function openPage(io: Pick<PushIo, "open">, url: string): TaskText {
  return io.open(url)
    ? say`Opened ${link(url)}`
    : say`Create a pull request at ${link(url)}`;
}

/** Whether git's output says the push was refused, as against failing to
 * reach the server or to finish, so that pushing again would be refused
 * again: git rejected the update, or GitHub denied the account permission
 * to push, which it says on a line of its own over HTTPS and over SSH. */
export function pushRefused(output: string): boolean {
  return /^\s*! \[(remote )?rejected\]|^(remote: |ERROR: )Permission to \S+ denied to /m
    .test(output);
}

/**
 * The address of the page a server offered for creating a pull request (or a
 * merge request) in the output of `git push`, or null when it offered none.
 * Servers send such offers on lines prefixed `remote:`, with the address on
 * the line making the offer or on the next such line. The address ends at
 * the first character that is not printable ASCII.
 */
export function offeredPullRequestUrl(output: string): string | null {
  let linesLeft = 0;
  for (const line of output.split(/\r\n|\r|\n/)) {
    const message = /^remote:(.*)$/.exec(line)?.[1];
    if (message === undefined) continue;
    if (/create (a )?(pull|merge) request/i.test(message)) linesLeft = 2;
    if (linesLeft === 0) continue;
    linesLeft--;
    const url = /https?:\/\/[!-~]+/.exec(message);
    if (url) return url[0];
  }
  return null;
}

/**
 * Decodes `stream` as UTF-8 and passes each piece of text to `write` as it
 * arrives. An abort of `signal` stops the relay as well as the process writing
 * the stream, in case a process it started still holds the pipe; the relay
 * then resolves. Rejects with any other failure to read the stream.
 */
export async function relayText(
  stream: ReadableStream<BufferSource>,
  write: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const texts = stream.pipeThrough(new TextDecoderStream(), { signal });
    for await (const text of texts) write(text);
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
}

/** The real operations, against the repository at `cwd`. */
export function realPushIo({
  cwd = Deno.cwd(),
  env = Deno.env.toObject(),
  opener = Deno.build.os === "darwin" ? "open" : "xdg-open",
  write,
  step,
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
  // The viewer holds the terminal, so git and ssh ask for nothing there: a
  // question goes to the user's own askpass program when they have one, and
  // otherwise fails.
  const repoEnv = {
    ...repositoryIndependentEnv(env),
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: env.SSH_ASKPASS ?? "false",
    SSH_ASKPASS_REQUIRE: "force",
  };
  // Runs git, passing what it writes to its standard output and to its
  // standard error to `out` and `err`, and resolves to whether it succeeded.
  // Git does not start once `signal` has aborted, since a process started
  // then cannot be stopped.
  const spawn = async (
    args: readonly string[],
    out: (text: string) => void,
    err: (text: string) => void,
  ) => {
    if (signal?.aborted) return false;
    const child = git(args, repoEnv).spawn();
    const [status] = await Promise.all([
      child.status,
      relayText(child.stdout, out, signal),
      relayText(child.stderr, err, signal),
    ]);
    return status.success;
  };
  return {
    query: (args) => capture(args, repoEnv),
    queryAsync: async (args) => {
      let output = "";
      let errors = "";
      const success = await spawn(
        args,
        (text) => output += text,
        (text) => errors += text,
      );
      if (success) return output;
      write(errors);
      return null;
    },
    run: async (args) => {
      let output = "";
      const shown = (text: string) => {
        write(text);
        output += text;
      };
      return { success: await spawn(args, shown, shown), output };
    },
    write,
    step,
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
