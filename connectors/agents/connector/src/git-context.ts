import type { NativeSessionSnapshot } from "./types.ts";
import { terminateChildProcess } from "./child-process.ts";

export interface GitContext {
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  gitHeadSha: string | null;
  gitRemotes: Array<{ name: string; urls: string[] }>;
  gitObservedAt: string | null;
  gitObservationFailed?: boolean;
}

export interface GitCommandResult {
  code: number;
  stdout: string;
}

export type GitCommandRunner = (
  args: string[],
  signal?: AbortSignal,
) => Promise<GitCommandResult>;

export type GitPathCanonicalizer = (path: string) => Promise<string>;

const EMPTY_GIT_CONTEXT: GitContext = {
  gitRepo: null,
  gitBranch: null,
  gitWorktreeRoot: null,
  gitHeadSha: null,
  gitRemotes: [],
  gitObservedAt: null,
};

const runGitCommand: GitCommandRunner = async (args, signal) => {
  signal?.throwIfAborted();
  const child = new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const abort = () => terminateChildProcess(child);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const output = await child.output();
    signal?.throwIfAborted();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};

function valueOf(result: GitCommandResult): string | null {
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

export interface GitContextObservation {
  resolve(cwd: string | null, signal?: AbortSignal): Promise<GitContext>;
  validateCheckout(
    directory: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  resolveCheckout(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GitContext | null>;
  enrich(
    snapshot: NativeSessionSnapshot,
    signal?: AbortSignal,
  ): Promise<NativeSessionSnapshot>;
}

class CachedGitContextObservation implements GitContextObservation {
  readonly #runner: GitCommandRunner;
  readonly #clock: () => Date;
  readonly #canonicalizePath: GitPathCanonicalizer;
  readonly #directories = new Map<string, Promise<GitContext>>();
  readonly #roots = new Map<
    string,
    Promise<Omit<GitContext, "gitWorktreeRoot">>
  >();

  constructor(
    runner: GitCommandRunner,
    clock: () => Date,
    canonicalizePath: GitPathCanonicalizer,
  ) {
    this.#runner = runner;
    this.#clock = clock;
    this.#canonicalizePath = canonicalizePath;
  }

  resolve(cwd: string | null, signal?: AbortSignal): Promise<GitContext> {
    const directory = cwd?.trim();
    if (!directory) return Promise.resolve({ ...EMPTY_GIT_CONTEXT });
    let context = this.#directories.get(directory);
    if (!context) {
      context = this.#resolveDirectory(directory, signal);
      this.#directories.set(directory, context);
    }
    return context;
  }

  async validateCheckout(
    directory: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const rootResult = await this.#run(
      ["-C", directory, "rev-parse", "--show-toplevel"],
      signal,
    );
    if (rootResult.code === -1) {
      throw new Error(
        "Git process failed while validating a discovered checkout",
      );
    }
    const root = valueOf(rootResult);
    if (!root) return false;
    const [canonicalDirectory, canonicalRoot] = await Promise.all([
      this.#canonicalizePath(directory),
      this.#canonicalizePath(root),
    ]);
    signal?.throwIfAborted();
    return canonicalDirectory === canonicalRoot;
  }

  async resolveCheckout(
    directory: string,
    signal?: AbortSignal,
  ): Promise<GitContext | null> {
    signal?.throwIfAborted();
    const rootResult = await this.#run(
      ["-C", directory, "rev-parse", "--show-toplevel"],
      signal,
    );
    if (rootResult.code === -1) {
      throw new Error(
        "Git process failed while validating a discovered checkout",
      );
    }
    if (rootResult.code !== 0) return null;
    const root = valueOf(rootResult);
    if (!root) {
      throw new Error(
        "Git returned no worktree root for a discovered checkout",
      );
    }
    const branch = (await this.#requiredOutput(
      ["-C", root, "branch", "--show-current"],
      signal,
    )).trim() || null;
    let repo = valueOf(
      await this.#run(
        ["-C", root, "remote", "get-url", "upstream"],
        signal,
      ),
    );
    if (!repo) {
      repo = valueOf(
        await this.#run(
          ["-C", root, "remote", "get-url", "origin"],
          signal,
        ),
      );
    }
    const headSha = await this.#checkoutHeadSha(root, signal);
    const remoteOutput = await this.#requiredOutput(
      ["-C", root, "remote", "-v"],
      signal,
    );
    const remotes = remoteRows(remoteOutput);
    const publishedRepo = repo ? publishableRemoteUrl(repo) : null;
    const context: GitContext = {
      gitRepo: publishedRepo ?? preferredRepo(remotes),
      gitBranch: branch,
      gitWorktreeRoot: root,
      gitHeadSha: headSha,
      gitRemotes: remotes,
      gitObservedAt: this.#clock().toISOString(),
    };
    const { gitWorktreeRoot: _gitWorktreeRoot, ...rootContext } = context;
    this.#directories.set(directory, Promise.resolve(context));
    this.#roots.set(root, Promise.resolve(rootContext));
    return context;
  }

  async enrich(
    snapshot: NativeSessionSnapshot,
    signal?: AbortSignal,
  ): Promise<NativeSessionSnapshot> {
    const context = await this.resolve(snapshot.summary.cwd, signal);
    const {
      gitHeadSha: _gitHeadSha,
      gitRemotes: _gitRemotes,
      gitObservedAt: _gitObservedAt,
      gitObservationFailed: _gitObservationFailed,
      ...summaryContext
    } = context;
    return {
      ...snapshot,
      summary: {
        ...snapshot.summary,
        ...summaryContext,
      },
    };
  }

  async #resolveDirectory(
    directory: string,
    signal?: AbortSignal,
  ): Promise<GitContext> {
    const rootResult = await this.#run(
      ["-C", directory, "rev-parse", "--show-toplevel"],
      signal,
    );
    const root = valueOf(rootResult);
    if (!root) {
      return {
        ...EMPTY_GIT_CONTEXT,
        ...(rootResult.code === -1 ? { gitObservationFailed: true } : {}),
      };
    }

    let context = this.#roots.get(root);
    if (!context) {
      context = this.#resolveRoot(root, signal);
      this.#roots.set(root, context);
    }
    return { ...await context, gitWorktreeRoot: root };
  }

  async #resolveRoot(
    root: string,
    signal?: AbortSignal,
  ): Promise<Omit<GitContext, "gitWorktreeRoot">> {
    const branchResult = await this.#run(
      ["-C", root, "branch", "--show-current"],
      signal,
    );
    const branch = valueOf(branchResult);
    let repo = valueOf(
      await this.#run(
        ["-C", root, "remote", "get-url", "upstream"],
        signal,
      ),
    );
    if (!repo) {
      repo = valueOf(
        await this.#run(
          ["-C", root, "remote", "get-url", "origin"],
          signal,
        ),
      );
    }
    const head = await this.#headObservation(root, signal);
    const remoteResult = await this.#run(
      ["-C", root, "remote", "-v"],
      signal,
    );
    const remotes = remoteRows(valueOf(remoteResult) ?? "");
    const publishedRepo = repo ? publishableRemoteUrl(repo) : null;
    const complete = branchResult.code === 0 && head.complete &&
      remoteResult.code === 0;
    return {
      gitRepo: publishedRepo ?? preferredRepo(remotes),
      gitBranch: branch,
      gitHeadSha: head.value,
      gitRemotes: remotes,
      gitObservedAt: complete ? this.#clock().toISOString() : null,
      ...(!complete ? { gitObservationFailed: true } : {}),
    };
  }

  async #checkoutHeadSha(
    root: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const observation = await this.#headObservation(root, signal);
    if (observation.complete) return observation.value;
    throw new Error(
      "Git command failed while observing checkout: rev-parse HEAD",
    );
  }

  async #headObservation(
    root: string,
    signal?: AbortSignal,
  ): Promise<{ value: string | null; complete: boolean }> {
    const result = await this.#run(["-C", root, "rev-parse", "HEAD"], signal);
    const value = valueOf(result);
    if (value) return { value, complete: true };
    if (result.code === -1) return { value: null, complete: false };
    const symbolicHead = valueOf(
      await this.#run(["-C", root, "symbolic-ref", "-q", "HEAD"], signal),
    );
    return symbolicHead
      ? { value: null, complete: true }
      : { value: null, complete: false };
  }

  async #requiredOutput(
    args: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#run(args, signal);
    if (result.code !== 0) {
      throw new Error(
        `Git command failed while observing checkout: ${
          args.slice(2).join(" ")
        }`,
      );
    }
    return result.stdout;
  }

  async #run(
    args: string[],
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    try {
      return await this.#runner(args, signal);
    } catch {
      signal?.throwIfAborted();
      return { code: -1, stdout: "" };
    }
  }
}

const PUBLISHABLE_REMOTE_PROTOCOLS = new Set([
  "git:",
  "http:",
  "https:",
  "ssh:",
]);
const SCP_REMOTE_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:(?!\/\/)\S+$/;

function publishableRemoteUrl(value: string): string | null {
  if (
    /^[^:]+::/.test(value) || /^file:/i.test(value) || /^[A-Za-z]:/.test(value)
  ) return null;
  if (SCP_REMOTE_PATTERN.test(value)) return value;
  try {
    const url = new URL(value);
    if (!PUBLISHABLE_REMOTE_PROTOCOLS.has(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function remoteRows(
  output: string,
): Array<{ name: string; urls: string[] }> {
  const byName = new Map<string, Set<string>>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(.+)\s+\((?:fetch|push)\)$/);
    if (!match) continue;
    const urls = byName.get(match[1]) ?? new Set<string>();
    const url = publishableRemoteUrl(match[2]);
    if (!url) continue;
    urls.add(url);
    byName.set(match[1], urls);
  }
  return [...byName.entries()]
    .map(([name, urls]) => ({ name, urls: [...urls].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function preferredRepo(
  remotes: Array<{ name: string; urls: string[] }>,
): string | null {
  return remotes.find((remote) => remote.name === "upstream")?.urls[0] ??
    remotes.find((remote) => remote.name === "origin")?.urls[0] ?? null;
}

export class GitContextResolver {
  readonly #runner: GitCommandRunner;
  readonly #clock: () => Date;
  readonly #canonicalizePath: GitPathCanonicalizer;

  constructor(
    runner: GitCommandRunner = runGitCommand,
    clock: () => Date = () => new Date(),
    canonicalizePath: GitPathCanonicalizer = (path) => Deno.realPath(path),
  ) {
    this.#runner = runner;
    this.#clock = clock;
    this.#canonicalizePath = canonicalizePath;
  }

  beginObservation(): GitContextObservation {
    return new CachedGitContextObservation(
      this.#runner,
      this.#clock,
      this.#canonicalizePath,
    );
  }

  resolve(cwd: string | null, signal?: AbortSignal): Promise<GitContext> {
    return this.beginObservation().resolve(cwd, signal);
  }

  validateCheckout(
    directory: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.beginObservation().validateCheckout(directory, signal);
  }

  enrich(
    snapshot: NativeSessionSnapshot,
    signal?: AbortSignal,
  ): Promise<NativeSessionSnapshot> {
    return this.beginObservation().enrich(snapshot, signal);
  }
}
