/**
 * Pushing the checked-out branch from `cf view`: push it as it stands to the
 * `origin` remote, and find the page the hosting service offers for creating
 * a pull request. The repository is the one the viewer's working directory is
 * in, which is the one the diff workspace reads files from.
 */

import { repositoryIndependentEnv } from "./gitenv.ts";

/** Runs git for its standard output, which it returns, or null when git
 * fails. Nothing is shown. */
export type GitQuery = (args: readonly string[]) => string | null;

/** The git and browser operations a push performs. */
export interface PushIo {
  /** Runs git for its standard output, which it returns, or null when git
   * fails. Nothing is shown. */
  readonly query: GitQuery;

  /** Runs git with its output shown as it arrives. Resolves to whether git
   * succeeded, and to everything it printed. */
  run(args: readonly string[]): Promise<{ success: boolean; output: string }>;

  /** Shows `text` where git's output is shown. */
  write(text: string): void;

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
 * The branch `origin` names as its default is never pushed, so the push
 * refuses when `origin` names none. When `origin` already has the branch and
 * there is an `ask`, pushes nothing, and returns what `ask` returns, given
 * the branch's name and how `origin`'s branch stands; otherwise it pushes,
 * and returns one line saying how that ended. Says which branch it pushes,
 * with `io`, before git starts. Once the push succeeds, calls `onPushed` with
 * the branch's name and the address of the page the server offers for
 * creating a pull request, or null when it offers none; by default, it opens
 * the page, and the line it returns ends with what `onPushed` returns. When
 * git fails, calls `onFailed` with what git printed, and the line it returns
 * says the push was aborted when it failed after `signal` aborted; git's own
 * output has been shown by then.
 */
export async function pushBranch<Asked = never>(
  io: PushIo,
  signal?: AbortSignal,
  onPushed: (
    branch: string,
    url: string | null,
  ) => Promise<string> | string = (_, url) =>
    url === null ? "" : openPage(io, url),
  onFailed: (output: string) => void = () => {},
  ask?: (branch: string, remote: PushedBranch) => Promise<Asked>,
): Promise<string | Asked> {
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
  if (ask) {
    const remote = pushedBranch(io.query, branch);
    if (remote !== null) return await ask(branch, remote);
  }
  const pushed = `Pushed ${branch} to origin`;
  io.write(`Pushing ${branch} to origin.\n`);
  const push = await io.run([
    "push",
    "--force-with-lease",
    "--force-if-includes",
    "--progress",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!push.success) {
    onFailed(push.output);
    return signal?.aborted
      ? "Push aborted."
      : `Pushing ${branch} to origin failed.`;
  }
  const then = await onPushed(branch, offeredPullRequestUrl(push.output));
  return then === "" ? `${pushed}.` : `${pushed}. ${then}`;
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
 * would do, a sentence per line. */
export function describePush(branch: string, pushed: PushedBranch): string {
  const commits = (count: number) =>
    count === 1 ? "1 commit" : `${count} commits`;
  const { counts } = pushed;
  const effect = counts === null
    ? "This checkout's history is shallow, so the commits pushing would add " +
      "or remove cannot be counted."
    : counts.removed > 0
    ? `Pushing would replace it, removing ${commits(counts.removed)} that ` +
      `this checkout does not have${
        counts.added > 0 ? ` and adding ${commits(counts.added)}` : ""
      }.`
    : counts.added > 0
    ? `Pushing would add ${commits(counts.added)} to it.`
    : "Pushing would leave it as it is.";
  return `origin already has ${branch}, at ${pushed.commit.slice(0, 12)} ` +
    `when last fetched or pushed.\n${effect}`;
}

/** Opens the page at `url` for creating a pull request, and returns a
 * sentence saying so, or giving its address when it cannot be opened. */
export function openPage(io: Pick<PushIo, "open">, url: string): string {
  return io.open(url) ? `Opened ${url}` : `Create a pull request at ${url}`;
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
  return {
    query: (args) => capture(args, repoEnv),
    run: async (args) => {
      const child = git(args, repoEnv).spawn();
      let output = "";
      const shown = (text: string) => {
        write(text);
        output += text;
      };
      const [status] = await Promise.all([
        child.status,
        relayText(child.stdout, shown, signal),
        relayText(child.stderr, shown, signal),
      ]);
      return { success: status.success, output };
    },
    write,
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
