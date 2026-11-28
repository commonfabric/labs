/**
 * Pull requests on GitHub for the branch `P` pushes: the repository they go
 * to and the branches they merge, finding the open one, and creating and
 * merging them with GitHub's REST API.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";
import { githubRepositoryPage } from "./blame.ts";
import type { GitQuery } from "./push.ts";
import type { BeginStep } from "./tasklog.ts";

/** The repository a pull request for the pushed branch goes to, and the
 * branch it merges from. */
export interface PullRequestTarget {
  /** The repository the pull request goes to, as `owner/name`. */
  readonly repository: string;

  /** The remote that names {@link repository}. */
  readonly remote: string;

  /** The owner of `origin`'s repository, which the branch is pushed to. */
  readonly owner: string;

  /** The pushed branch as GitHub names a pull request's head: its name, or
   * `owner:name` when it is pushed to a repository other than
   * {@link repository}. */
  readonly head: string;

  /** The pushed branch's name. */
  readonly branch: string;
}

/** A pull request that is open on GitHub. */
export interface PullRequest {
  readonly number: number;

  /** Its page on GitHub. */
  readonly url: string;
}

/** How a merge combines a pull request's commits with its base branch. */
export type MergeMethod = "squash" | "merge" | "rebase";

/** A request to create a pull request. */
export interface CreateRequest {
  /** The repository, as `owner/name`. */
  readonly repository: string;

  /** The branch to merge from, as {@link PullRequestTarget.head} gives it. */
  readonly head: string;

  /** The branch to merge into. */
  readonly base: string;

  readonly title: string;

  /** The description, which may be empty. */
  readonly body: string;
}

/** A request to merge a pull request. */
export interface MergeRequest {
  /** The repository, as `owner/name`. */
  readonly repository: string;

  readonly number: number;
  readonly method: MergeMethod;

  /** The commit the pull request's head must be at for it to merge. */
  readonly sha: string;
}

/** Creates and merges pull requests. */
export interface PullRequestService {
  /**
   * Creates the pull request `request` describes, showing with `step` what
   * it waits for, and resolves with the new pull request's address. Rejects
   * with the reason when it cannot, or when `signal` aborts.
   */
  create(
    request: CreateRequest,
    step: BeginStep,
    signal: AbortSignal,
  ): Promise<string>;

  /**
   * Merges the pull request `request` describes, showing with `step` what it
   * waits for, and resolves once it has merged. Rejects with the reason when
   * it cannot, or when `signal` aborts.
   */
  merge(
    request: MergeRequest,
    step: BeginStep,
    signal: AbortSignal,
  ): Promise<void>;
}

/** The statuses with which GitHub says a request itself cannot succeed, so
 * that making it again gets the same answer: not found, not allowed, in
 * conflict, or not valid. */
const FINAL_STATUSES: ReadonlySet<number> = new Set([404, 405, 409, 422]);

/** GitHub's answer refusing a request: its status, and the reason its reply
 * gives. */
export class GitHubRefusal extends Error {
  #status: number;
  #reason: string;

  /** GitHub refused with `status`, replying `reply`, which is JSON that may
   * give a message and a list of errors, each with a message of its own. */
  constructor(status: number, reply: string) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(reply);
    } catch {
      // A reply that is not JSON says what it says as it stands.
    }
    const message = !isObjectNotArray(parsed)
      ? reply.trim()
      : typeof parsed.message === "string"
      ? parsed.message
      : "";
    const errors = isObjectNotArray(parsed) && Array.isArray(parsed.errors)
      ? parsed.errors.flatMap((error: unknown) =>
        isObjectNotArray(error) && typeof error.message === "string"
          ? [error.message]
          : []
      )
      : [];
    const parts = [message, ...errors].filter((m) => m !== "");
    // The parts are joined as sentences, and whoever reports the refusal
    // ends the last of them.
    const sentences = parts.map((m) => m.replace(/\.+$/, ""))
      .filter((m) => m !== "").join(". ");
    super(
      `GitHub answered ${status}${sentences === "" ? "" : `: ${sentences}`}`,
    );
    this.#status = status;
    this.#reason = parts.join("\n");
  }

  /** The status GitHub answered with. */
  get status(): number {
    return this.#status;
  }

  /** The reason GitHub's reply gave, a message per line as GitHub wrote
   * each, or "" when it gave none. */
  get reason(): string {
    return this.#reason;
  }

  /** Whether making the same request again could get another answer. */
  get retryable(): boolean {
    return !FINAL_STATUSES.has(this.#status);
  }
}

/** The remotes whose repository a pull request goes to, in the order they
 * are preferred. */
const BASE_REMOTES = ["upstream", "github", "origin"];

/** Returns the `owner/name` of the GitHub repository at `url`, or null when
 * `url` is not on GitHub. */
function repositoryName(url: string | undefined): string | null {
  const page = url === undefined ? null : githubRepositoryPage(url);
  return page?.slice("https://github.com/".length) ?? null;
}

/**
 * Returns where a pull request for `branch`, pushed to `origin`, goes: to the
 * GitHub repository of the remote named `upstream`, `github`, or `origin`,
 * whichever is first to name one. Throws when `origin` is not on GitHub.
 */
export function pullRequestTarget(
  git: GitQuery,
  branch: string,
): PullRequestTarget {
  const origin = repositoryName(
    git(["remote", "get-url", "--push", "origin"])?.trim(),
  );
  if (origin === null) throw new Error("origin is not a GitHub repository");
  let remote = "origin";
  let repository = origin;
  for (const name of BASE_REMOTES) {
    const found = repositoryName(git(["remote", "get-url", name])?.trim());
    if (found === null) continue;
    remote = name;
    repository = found;
    break;
  }
  const owner = origin.split("/")[0];
  const same = origin.toLowerCase() === repository.toLowerCase();
  return {
    repository,
    remote,
    owner,
    head: same ? branch : `${owner}:${branch}`,
    branch,
  };
}

/**
 * Returns the title and description of a pull request for the checked-out
 * commit into branch `baseBranch` of `target`'s remote: the subject and the
 * rest of the message of its oldest commit that the base branch, as last
 * fetched, does not have, leaving out merges and commits whose changes the
 * base branch has. Throws when there is no such commit, or git cannot compare
 * the two, as when the base branch has never been fetched.
 */
export function pullRequestText(
  git: GitQuery,
  target: PullRequestTarget,
  baseBranch: string,
): { readonly title: string; readonly body: string } {
  const base = `refs/remotes/${target.remote}/${baseBranch}`;
  const listed = git([
    "rev-list",
    "--reverse",
    "--no-merges",
    "--right-only",
    "--cherry-pick",
    "--end-of-options",
    `${base}...HEAD`,
    "--",
  ]);
  if (listed === null) {
    throw new Error(
      `git cannot compare the branch with ${base}. ` +
        `Fetching ${target.remote} may fix that`,
    );
  }
  const [first] = listed.split("\n").filter((line) => line !== "");
  if (first === undefined) {
    throw new Error(`the branch has no commits that ${base} does not have`);
  }
  const message = git([
    "-c",
    "log.showSignature=false",
    "log",
    "-1",
    "--format=%s%x00%b",
    first,
    "--",
  ]);
  if (message === null) throw new Error(`git cannot read commit ${first}`);
  const [title, ...body] = message.split("\0");
  return { title: title.trim(), body: body.join("\0").trim() };
}

/** The address of pull request `number` of `repository`. */
export function pullRequestUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

/**
 * Returns the pull request that `list` names for `target`'s branch, or null
 * when it names none, or several, as it can when branches of the same name
 * in different forks each have one. Each line of `list` names an open pull
 * request by its repository, its branch, and its number, separated by tabs.
 */
export function listedPullRequest(
  list: string,
  target: PullRequestTarget,
): PullRequest | null {
  const numbers = list.split("\n").flatMap((line) => {
    const [repository, branch, number] = line.split("\t");
    return repository?.toLowerCase() === target.repository.toLowerCase() &&
        branch === target.branch && /^[1-9]\d*$/.test(number ?? "")
      ? [Number(number)]
      : [];
  });
  return numbers.length === 1
    ? {
      number: numbers[0],
      url: pullRequestUrl(target.repository, numbers[0]),
    }
    : null;
}

/** Settles as `promise` does, or rejects with `signal`'s reason once it
 * aborts first, whether or not `promise` itself can be stopped. */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      // What the promise settles to no longer matters.
      promise.catch(() => {});
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort)
    );
  });
}

/** GitHub's REST API, authenticated with a token when there is one. */
export interface GitHubApi extends PullRequestService {
  /** Resolves with the open pull request from `target`'s branch, or null
   * when there is none. Rejects when GitHub cannot say. */
  find(
    target: PullRequestTarget,
    signal: AbortSignal,
  ): Promise<PullRequest | null>;

  /** Resolves with the default branch of `repository`, an `owner/name`.
   * Rejects when GitHub cannot say. */
  defaultBranch(repository: string, signal: AbortSignal): Promise<string>;

  /** Resolves with the method GitHub's page for a pull request in
   * `repository` would merge it by: the one the token's account last used,
   * or else the repository's default. Rejects when there is no token, or
   * GitHub cannot say. */
  mergeMethod(repository: string, signal: AbortSignal): Promise<MergeMethod>;
}

/** The merge methods, as GitHub's GraphQL API names them. */
const MERGE_METHODS: ReadonlyMap<string, MergeMethod> = new Map([
  ["SQUASH", "squash"],
  ["MERGE", "merge"],
  ["REBASE", "rebase"],
]);

/**
 * Returns GitHub's REST API, reached with `send`, authenticated with the
 * token `token` returns when it returns one. Finding a pull request works
 * without one, for a public repository; creating and merging do not.
 */
export function githubApi(
  token: () => Promise<string | null> | string | null,
  send: typeof fetch = fetch,
): GitHubApi {
  const call = async (
    method: string,
    path: string,
    signal: AbortSignal,
    body?: string,
    required = true,
  ): Promise<unknown> => {
    const key = await abortable(Promise.resolve(token()), signal);
    if (key === null && required) {
      throw new Error(
        "there is no GitHub token: set GH_TOKEN, or sign in with `gh auth login`",
      );
    }
    const response = await send(`https://api.github.com${path}`, {
      method,
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubRefusal(response.status, text);
    try {
      return JSON.parse(text);
    } catch {
      // A successful reply that is not JSON carries nothing to read.
      return null;
    }
  };
  return {
    find: async (target, signal) => {
      const head = encodeURIComponent(`${target.owner}:${target.branch}`);
      const reply = await call(
        "GET",
        `/repos/${target.repository}/pulls?state=open&head=${head}`,
        signal,
        undefined,
        false,
      );
      const [first] = Array.isArray(reply) ? reply : [];
      const number = isObjectNotArray(first) ? first.number : undefined;
      return typeof number === "number"
        ? { number, url: pullRequestUrl(target.repository, number) }
        : null;
    },
    defaultBranch: async (repository, signal) => {
      const reply = await call(
        "GET",
        `/repos/${repository}`,
        signal,
        undefined,
        false,
      );
      const branch = isObjectNotArray(reply) ? reply.default_branch : undefined;
      if (typeof branch !== "string" || branch === "") {
        throw new Error(
          `GitHub did not say which branch is ${repository}'s default`,
        );
      }
      return branch;
    },
    // GitHub's merge API merges by "merge" unless told otherwise, which a
    // repository that allows only squashing or rebasing refuses, so the
    // method comes from the GraphQL API, which knows the one its page would
    // use.
    mergeMethod: async (repository, signal) => {
      const [owner, name] = repository.split("/");
      const reply = await call(
        "POST",
        "/graphql",
        signal,
        JSON.stringify({
          query: "query($owner: String!, $name: String!) { " +
            "repository(owner: $owner, name: $name) " +
            "{ viewerDefaultMergeMethod } }",
          variables: { owner, name },
        }),
      );
      const data = isObjectNotArray(reply) ? reply.data : undefined;
      const found = isObjectNotArray(data) ? data.repository : undefined;
      const method = isObjectNotArray(found)
        ? found.viewerDefaultMergeMethod
        : undefined;
      const known = typeof method === "string"
        ? MERGE_METHODS.get(method)
        : undefined;
      if (known === undefined) {
        throw new Error(
          `GitHub did not say how ${repository} merges: ${
            JSON.stringify(reply)
          }`,
        );
      }
      return known;
    },
    create: async ({ repository, ...fields }, _step, signal) => {
      const reply = await call(
        "POST",
        `/repos/${repository}/pulls`,
        signal,
        JSON.stringify(fields),
      );
      const url = isObjectNotArray(reply) ? reply.html_url : undefined;
      if (typeof url !== "string") {
        throw new Error("GitHub did not say which pull request it created");
      }
      return url;
    },
    merge: async ({ repository, number, method, sha }, _step, signal) => {
      await call(
        "PUT",
        `/repos/${repository}/pulls/${number}/merge`,
        signal,
        JSON.stringify({ merge_method: method, sha }),
      );
    },
  };
}

/**
 * Returns the token to use GitHub's REST API with: `GH_TOKEN` or
 * `GITHUB_TOKEN` from `env`, or else the one that `gh auth token` prints, or
 * null when there is none.
 */
export async function githubToken(
  env: Readonly<Record<string, string>> = Deno.env.toObject(),
  gh = "gh",
): Promise<string | null> {
  const set = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (set) return set;
  try {
    const result = await new Deno.Command(gh, {
      args: ["auth", "token"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    const token = new TextDecoder().decode(result.stdout).trim();
    return result.success && token !== "" ? token : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/**
 * Returns the list of open pull requests in the file at `path`, as
 * {@link listedPullRequest} reads it, or null when there is no such file.
 * The file is read while holding a shared lock on it, as the program that
 * rewrites it in place expects.
 */
export async function readPullRequestList(
  path: string,
): Promise<string | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  try {
    await file.lock(false);
    return await Deno.readTextFile(path);
  } finally {
    file.close();
  }
}
