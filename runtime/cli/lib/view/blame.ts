/**
 * Line attribution for the pager's blame column: running `git blame`, parsing
 * its porcelain output, reading a commit's own attribution, and the short
 * label the column shows for each line.
 */

import { repositoryEnv } from "./gitenv.ts";

/** A file for `git blame` to attribute, or a commit to attribute to itself. */
export type BlameRequest = FileBlameRequest | CommitBlameRequest;

/** A file for `git blame` to attribute. */
export interface FileBlameRequest {
  /** The directory git runs in, which selects the repository. */
  readonly cwd: string;

  /** The file, absolute or relative to {@link cwd}. */
  readonly path: string;

  /** The commit to attribute the file as of; absent for the working tree. */
  readonly rev?: string;

  /** Text to attribute in place of the file's own content, as the bytes a
   * save would write. Lines it changes are attributed to no commit. */
  readonly contents?: Uint8Array;
}

/** A commit, attributed as a single line to its own author and author time. */
export interface CommitBlameRequest {
  /** The directory git runs in, which selects the repository. */
  readonly cwd: string;

  /** Always absent: a commit request names no file. */
  readonly path?: never;

  /** The commit. */
  readonly rev: string;

  /** Always absent: a commit request has no text of its own. */
  readonly contents?: never;
}

/** Where one displayed line comes from, for the blame column. */
export interface BlameTarget {
  readonly request: BlameRequest;

  /** The 0-based line of the blamed file; 0 for a commit. */
  readonly line: number;

  /** The text the line must have in the blamed file for its attribution to
   * apply; absent when the line is known to be that file line. */
  readonly text?: string;
}

/** One line's attribution. */
export interface BlameLine {
  /** The full hash of the commit that last changed the line; all zeros for a
   * line no commit has. */
  readonly commit: string;

  readonly author: string;

  /** The author time, in seconds since the epoch. */
  readonly time: number;

  /** The line's content, without its line terminator; empty for a commit. */
  readonly text: string;

  /** The commit's page on GitHub, when the repository's remote is there. */
  readonly url?: string;
}

/** Columns the blame column takes at the right of the screen, including the
 * space that separates it from the text. */
export const BLAME_WIDTH = 20;

/** Identifies the file a request attributes, whatever text it attributes. */
export function blameKey(request: BlameRequest): string {
  return `${request.cwd}\0${request.path ?? ""}\0${request.rev ?? ""}`;
}

/** A function that runs `git blame` for a request, resolving to one entry
 * per line of the file, or one entry for a commit, each committed line linked
 * to its commit's page when the repository has a remote on GitHub. It rejects
 * with git's message when git fails, for example because the file is not
 * tracked, and when its signal aborts, which stops git. */
export type BlameRunner = (
  request: BlameRequest,
  signal: AbortSignal,
) => Promise<BlameLine[]>;

/** A {@link BlameRunner} that finds each directory's GitHub page once, and
 * reuses it for every later request from that directory. Git runs in the
 * environment {@link repositoryEnv} makes from `env`, the environment the
 * viewer was started with in the directory `start`. */
export function blameRunner(
  env: Readonly<Record<string, string>> = Deno.env.toObject(),
  start: string = Deno.cwd(),
): BlameRunner {
  const pages = new Map<string, Promise<string | null>>();
  let environment: Promise<Record<string, string>> | undefined;
  return async (request, signal) => {
    const repoEnv = await (environment ??= repositoryEnv(env, start));
    let page = pages.get(request.cwd);
    if (!page) {
      page = githubPage(request.cwd, repoEnv, signal);
      pages.set(request.cwd, page);
    }
    const [lines, url] = await Promise.all([
      blame(request, repoEnv, signal),
      page,
    ]);
    return url === null
      ? lines
      : lines.map((line) =>
        uncommitted(line)
          ? line
          : { ...line, url: `${url}/commit/${line.commit}` }
      );
  };
}

/** Runs `git blame` for a file request, or `git show` for a commit request,
 * in the environment `env`, and parses what it writes. */
async function blame(
  request: BlameRequest,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<BlameLine[]> {
  const { path, rev } = request;
  const [args, parse] = path === undefined
    ? [
      [
        "show",
        "--no-patch",
        "--no-show-signature",
        "--format=%H%n%at%n%aN",
        `${rev}^{commit}`,
        "--",
      ],
      (output: string) => [parseCommitLine(output)],
    ]
    : [
      [
        "blame",
        "--porcelain",
        ...request.contents ? ["--contents", "-"] : [],
        ...rev ? [rev] : [],
        "--",
        path,
      ],
      parseBlamePorcelain,
    ];
  const child = new Deno.Command("git", {
    args,
    cwd: request.cwd,
    env,
    clearEnv: true,
    stdin: request.contents ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn();
  // Git may exit without reading its input, as it does for a file it cannot
  // blame; its own message then says why, so a failed write is not reported.
  const written = request.contents
    ? feed(child.stdin, request.contents)
    : Promise.resolve();
  const [output] = await Promise.all([child.output(), written]);
  const decoder = new TextDecoder();
  if (!output.success) {
    const message = decoder.decode(output.stderr).trim().split("\n")[0];
    throw new Error(message || `git ${args[0]} failed`);
  }
  return parse(decoder.decode(output.stdout));
}

/** Parses the output of `git show --no-patch --format=%H%n%at%n%aN` into the
 * commit's attribution. Throws when the output does not follow that format. */
export function parseCommitLine(output: string): BlameLine {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\n(\d+)\n(.*)\n$/.exec(output);
  if (!match) throw new Error(`Unexpected git show output: ${output}`);
  return {
    commit: match[1],
    author: match[3],
    time: Number(match[2]),
    text: "",
  };
}

/** The GitHub page of the repository at `cwd`: that of the remote git
 * fetches from when given none, or else `origin`, or else the first other
 * remote on GitHub. Null when none of them is on GitHub. */
async function githubPage(
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string | null> {
  const [fetched, configured] = await Promise.all([
    gitOutput(cwd, ["ls-remote", "--get-url"], env, signal),
    gitOutput(
      cwd,
      ["config", "--get-regexp", "^remote\\..*\\.url$"],
      env,
      signal,
    ),
  ]);
  const remotes = configured.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.url (.*)$/.exec(line);
    return match ? [{ name: match[1], url: match[2] }] : [];
  });
  const origin = remotes.filter((remote) => remote.name === "origin");
  const others = remotes.filter((remote) => remote.name !== "origin");
  const urls = [fetched.trim(), ...[...origin, ...others].map((r) => r.url)];
  return urls.map(githubRepositoryPage).find((page) => page !== null) ?? null;
}

/** What git writes to its output for `args` in `cwd` and the environment
 * `env`, or nothing when it fails. */
async function gitOutput(
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [...args],
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "null",
    signal,
  }).output();
  return output.success ? new TextDecoder().decode(output.stdout) : "";
}

/** The page of the GitHub repository a remote URL names, in any of the forms
 * GitHub offers for cloning, or null for a URL that names none. */
export function githubRepositoryPage(remote: string): string | null {
  const match =
    /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/:]+@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
      .exec(remote);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/** Writes `bytes` to `stdin` and closes it, settling once that has finished
 * or failed. */
export async function feed(
  stdin: WritableStream<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> {
  const writer = stdin.getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch {
    writer.releaseLock();
  }
}

/** Parses `git blame --porcelain` output into one entry per line of the
 * blamed file. Throws when the output does not follow the porcelain format. */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const commits = new Map<
    string,
    { author: string; time: number }
  >();
  const lines: BlameLine[] = [];
  const rows = output.split("\n");
  let i = 0;
  while (i < rows.length && rows[i] !== "") {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(rows[i]);
    if (!header) throw new Error(`Unexpected git blame line: ${rows[i]}`);
    const commit = header[1];
    const finalLine = Number(header[2]) - 1;
    const info = commits.get(commit) ?? { author: "", time: 0 };
    i++;
    while (i < rows.length && !rows[i].startsWith("\t")) {
      const space = rows[i].indexOf(" ");
      const key = space < 0 ? rows[i] : rows[i].slice(0, space);
      const value = space < 0 ? "" : rows[i].slice(space + 1);
      if (key === "author") info.author = value;
      else if (key === "author-time") info.time = Number(value);
      i++;
    }
    if (i >= rows.length) throw new Error("Truncated git blame output");
    commits.set(commit, info);
    lines[finalLine] = { commit, ...info, text: rows[i].slice(1) };
    i++;
  }
  return lines;
}

/** The steps of {@link blameAge}'s units, smallest first: each unit's
 * suffix and its length in seconds. */
const AGE_UNITS: readonly { suffix: string; seconds: number }[] = [
  { suffix: "s", seconds: 1 },
  { suffix: "m", seconds: 60 },
  { suffix: "h", seconds: 60 * 60 },
  { suffix: "d", seconds: 24 * 60 * 60 },
  { suffix: "y", seconds: 365 * 24 * 60 * 60 },
];

/** How long before `now` (in milliseconds since the epoch) the author time
 * `time` (in seconds since the epoch) is, in at most four characters below
 * ten thousand years. The age is rounded to the nearest second; while that
 * count reaches the size of the next unit (60 seconds, 60 minutes, 24 hours,
 * 365 days), it is rounded to the nearest of that unit instead. A time after
 * `now` is `0s` old. */
export function blameAge(time: number, now: number): string {
  const age = Math.max(0, now / 1000 - time);
  let unit = AGE_UNITS[0];
  let count = Math.round(age);
  for (const next of AGE_UNITS.slice(1)) {
    if (count < next.seconds / unit.seconds) break;
    unit = next;
    count = Math.round(age / unit.seconds);
  }
  return `${count}${unit.suffix}`;
}

/** The column's label for a line: its age at `now` (in milliseconds since the
 * epoch) right-aligned in four columns, then the author; or `uncommitted`. */
export function blameLabel(line: BlameLine, now: number): string {
  if (uncommitted(line)) return "uncommitted";
  return `${blameAge(line.time, now).padStart(4)} ${line.author}`;
}

/** Whether no commit has `line`: it was changed after the last one. */
function uncommitted(line: BlameLine): boolean {
  return /^0+$/.test(line.commit);
}
