/**
 * Lists the newest commits on the default branch of every repository in the
 * organization that the dashboard's credential can read, newest first and
 * interleaved across repositories: each commit that landed a pull request
 * opened by an account GitHub does not mark as a bot, and each commit that one
 * of the followed main CI workflows (those of labs, loom, and weaver) ran on
 * after a push. The rest are left out: a commit pushed without a pull request,
 * and a bot's pull request, such as an automated deployment's, unless a
 * followed workflow ran on it. Each row is tagged with its repository.
 *
 * A commit that a followed workflow ran on carries that run's result and
 * duration, and its text links to the run; the text of any other commit links
 * to the commit. A pull request number in the text links to that pull request.
 * The row's arrow links to the pull request that landed the commit, or to the
 * commit when its title names none. A row whose commit the repository's green
 * branch is or was at opens with a star saying so. The tile is full-width. Its
 * aggregate status is bad when the newest completed run of the followed
 * workflows failed, a warning when one of the RECENT_WINDOW newest did but the
 * newest passed, and good otherwise.
 *
 * The commits are read in the background, at most once every
 * COMMITS_REFRESH_MS: one listing of the organization's repositories, and
 * then the newest commits of each repository whose last push differs from the
 * one its commits were read after, each with its pull requests, in one GraphQL
 * query per repository. A collection never waits for that read, and when the
 * read finds new commits the tile asks to be collected again. The tile's sub
 * line counts the repositories GitHub refused to read.
 *
 * While the GitHub webhook relay vouches for the last listing, and no
 * `repository` delivery has arrived since, the listing is not read again.
 * A delivered push to a repository's default branch has that repository's
 * commits read at once, without waiting for COMMITS_REFRESH_MS, and read
 * again on each refresh until they start at the commit pushed. A push to a
 * repository the last listing leaves out has the repositories listed again,
 * and is dropped once a listing read after it still leaves the repository
 * out. While the relay vouches and nothing has been delivered, a refresh
 * reads nothing.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  runSource,
  type Run,
  type Status,
  type Tile,
  type TileView,
} from "../types.ts";
import {
  concDot,
  dashboardGitHubCredential,
  escapeHtml,
  friendlyError,
  GITHUB_REQUEST_CONCURRENCY,
  GitHubGraphqlError,
  githubGraphql,
  GitHubStatusError,
  humanDuration,
  inParallel,
  landingHref,
  messageOf,
  pullRequestLinks,
  runDurationMs,
} from "../lib.ts";
import type { GitHubCredential } from "../github-auth.ts";
import {
  CI_WORKFLOW,
  LOOM_CI_WORKFLOW,
  LOOM_REPO,
  RECENT_DISPLAY,
  RECENT_WINDOW,
  REPO,
  WEAVER_CI_WORKFLOW,
  WEAVER_REPO,
} from "../config.ts";
import { CI_HISTORY_SOURCES, GANTT_MAX_RUNS } from "../ci-job-history.ts";
import { greenStar } from "../green-star.ts";
import {
  Freshness,
  type GitHubDelivery,
  type GitHubWebhooks,
  githubWebhooks,
  pushOf,
} from "../github-webhooks.ts";
import {
  type OrganizationRepo,
  organizationRepos,
} from "../organization-repos.ts";

// How often the organization's repositories are listed to find new pushes.
const COMMITS_REFRESH_MS = 30_000;

/**
 * A commit on a repository's default branch that a person landed through a
 * pull request, or that a followed main CI workflow ran on after a push.
 */
export interface Commit {
  /** The repository the commit is on, as "owner/name". */
  readonly repo: string;

  /** The commit's hash. */
  readonly sha: string;

  /**
   * The row's title: the title and number of the pull request that landed
   * the commit, or the first line of the commit's message.
   */
  readonly title: string;

  /** When the commit landed. */
  readonly at: string;
}

const utcFallback = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isFinite(at)
    ? `${new Date(at).toISOString().slice(11, 16)} UTC`
    : iso;
};

const repoOf = (run: Run): string => run.repo ?? REPO;

const shortRepo = (repo: string): string => repo.split("/")[1] ?? repo;

// How many of a repository's newest commits are read. The history follows
// every parent, so the commits of a branch a merge commit brought in take
// places too, and the window is wider than the rows the tile shows.
const HISTORY_DEPTH = 2 * RECENT_DISPLAY;

// A repository's newest commits on its default branch, each with the pull
// request GitHub associates with it. A commit that landed a pull request is
// that pull request's merge commit: the squashed commit, the merge commit, or
// the last of the commits rebased onto the branch.
const HISTORY_QUERY = `query($owner: String!, $name: String!, $count: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: $count) {
            nodes {
              oid
              associatedPullRequests(first: 1) {
                nodes {
                  number
                  title
                  baseRefName
                  mergedAt
                  mergeCommit { oid }
                  author { __typename }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Returns the repository, as "owner/name", that a `repository` delivery
 * reports, and whether the delivery takes it out of the listing, by deleting
 * or archiving it, or puts it back, by creating or unarchiving it. Returns
 * `undefined` for any other delivery, a transfer among them, whose direction
 * the next listing shows.
 */
function repositoryChangeOf(
  delivery: GitHubDelivery,
): { repo: string; gone: boolean } | undefined {
  if (delivery.event !== "repository") return undefined;
  const payload = delivery.payload;
  if (!isObjectNotArray(payload) || typeof payload.action !== "string") {
    return undefined;
  }
  const gone = GONE.has(payload.action);
  if (!gone && !BACK.has(payload.action)) return undefined;
  const repository = payload.repository;
  return isObjectNotArray(repository) && typeof repository.full_name === "string"
    ? { repo: repository.full_name, gone }
    : undefined;
}

// The actions of a `repository` delivery that take a repository out of the
// listing, and those that put one back.
const GONE = new Set(["deleted", "archived"]);
const BACK = new Set(["created", "unarchived"]);

// The commit a push names as the one a deleted branch was moved to.
const DELETED = "0".repeat(40);

// The GraphQL error types that asking again unchanged would not alter.
const REFUSALS = new Set(["FORBIDDEN", "NOT_FOUND"]);

/**
 * Returns the commit `node`, one of the history of `repo`'s default branch,
 * when it is the merge commit of a pull request into that branch that an
 * account GitHub does not mark as a bot opened, and nothing otherwise.
 */
function landedCommitOf(repo: OrganizationRepo, node: unknown): Commit[] {
  const pulls = isObjectNotArray(node) &&
      isObjectNotArray(node.associatedPullRequests)
    ? node.associatedPullRequests.nodes
    : undefined;
  if (
    !isObjectNotArray(node) || typeof node.oid !== "string" ||
    !Array.isArray(pulls)
  ) {
    throw new Error("GitHub commit history returned invalid data");
  }
  for (const pull of pulls) {
    if (
      !isObjectNotArray(pull) || !Number.isSafeInteger(pull.number) ||
      typeof pull.title !== "string" || typeof pull.baseRefName !== "string" ||
      (pull.mergedAt !== null && typeof pull.mergedAt !== "string") ||
      (pull.mergeCommit !== null && !isObjectNotArray(pull.mergeCommit)) ||
      (pull.author !== null && !isObjectNotArray(pull.author))
    ) {
      throw new Error("GitHub commit history returned invalid data");
    }
    if (
      typeof pull.mergedAt === "string" && pull.mergeCommit?.oid === node.oid &&
      pull.baseRefName === repo.branch && pull.author?.__typename !== "Bot"
    ) {
      return [{
        repo: repo.name,
        sha: node.oid,
        title: `${pull.title} (#${pull.number})`,
        at: pull.mergedAt,
      }];
    }
  }
  return [];
}

/**
 * Returns whether `error` is GitHub refusing a request, which asking again
 * unchanged would not alter.
 */
function isRefusal(error: unknown): boolean {
  return error instanceof GitHubStatusError
    ? error.status >= 400 && error.status < 500 && !error.rateLimited
    : error instanceof GitHubGraphqlError &&
      error.types.some((type) => REFUSALS.has(type));
}

/**
 * Reads the commits among the newest HISTORY_DEPTH on a repository's default
 * branch that people landed through pull requests, newest first, and the
 * commit the branch is at.
 */
async function readCommits(
  repo: OrganizationRepo,
  credential: GitHubCredential,
): Promise<{ head: string | undefined; commits: Commit[] }> {
  const [owner, name] = repo.name.split("/");
  const data = await githubGraphql(
    HISTORY_QUERY,
    { owner, name, count: HISTORY_DEPTH },
    credential,
  );
  const repository = isObjectNotArray(data) ? data.repository : undefined;
  if (repository === null) {
    // GitHub hides a repository the token may not read as missing.
    throw new GitHubGraphqlError(
      `GitHub GraphQL found no repository ${repo.name}`,
      ["NOT_FOUND"],
    );
  }
  const branch = isObjectNotArray(repository)
    ? repository.defaultBranchRef
    : undefined;
  if (branch === null) return { head: undefined, commits: [] };
  const target = isObjectNotArray(branch) ? branch.target : undefined;
  const history = isObjectNotArray(target) ? target.history : undefined;
  const nodes = isObjectNotArray(history) ? history.nodes : undefined;
  if (!Array.isArray(nodes)) {
    throw new Error("GitHub commit history returned invalid data");
  }
  const commits = nodes.flatMap((node) => landedCommitOf(repo, node));
  const newest: unknown = nodes[0];
  const head = isObjectNotArray(newest) && typeof newest.oid === "string"
    ? newest.oid
    : undefined;
  return { head, commits };
}

/**
 * The newest commits that people landed through pull requests on the default
 * branch of every repository in the organization, each repository's read
 * again after each new push to it.
 */
export class OrganizationCommits {
  // Each repository's newest commits, newest first, by "owner/name", and the
  // push they were read after.
  #held = new Map<
    string,
    { pushedAt: string | null; commits: readonly Commit[] }
  >();

  // The repositories, by "owner/name", whose commits GitHub refused to list
  // when they were last read.
  #refused = new Set<string>();

  // The last listing of the organization's repositories, and whether the
  // relay vouches that no repository has been added, removed or changed
  // since.
  #repos: OrganizationRepo[] | undefined;
  #listing: Freshness;

  // The commit each repository's default branch was last delivered as pushed
  // to, and how many deliveries had arrived with it, by "owner/name" in lower
  // case, until its commits are read starting at that commit, or a listing
  // started after it leaves the repository out.
  #pushed = new Map<string, { after: string; delivery: number }>();

  // The repositories a delivery said left the organization, by "owner/name"
  // in lower case, which are left out of every listing until one leaves them
  // out itself.
  #gone = new Set<string>();

  // Whether a delivery has dropped commits since the last refresh.
  #dropped = false;

  #webhooks: GitHubWebhooks;

  /**
   * Constructs an instance holding no commits, which learns of pushes and of
   * changes to the organization's repositories from `webhooks`.
   */
  constructor(webhooks: GitHubWebhooks = githubWebhooks) {
    this.#webhooks = webhooks;
    this.#listing = new Freshness(
      webhooks,
      (delivery) => delivery.event === "repository",
    );
    webhooks.listen((delivery) => {
      const push = pushOf(delivery);
      if (push !== undefined && push.ref === `refs/heads/${push.defaultBranch}`) {
        this.#pushed.set(push.repo.toLowerCase(), {
          after: push.after,
          delivery: webhooks.deliveries,
        });
      }
      const change = repositoryChangeOf(delivery);
      if (change === undefined) return;
      const key = change.repo.toLowerCase();
      if (change.gone) {
        // A repository that leaves the organization takes its pushes and its
        // commits with it.
        this.#gone.add(key);
        this.#pushed.delete(key);
        for (const name of this.#held.keys()) {
          if (name.toLowerCase() === key && this.#held.delete(name)) {
            this.#dropped = true;
          }
        }
      } else this.#gone.delete(key);
    });
  }

  /**
   * Whether a refresh would read nothing: the relay vouches for the last
   * listing, no push has been delivered that the commits held do not show,
   * and every repository listed has had its commits read since its last push
   * or been refused.
   */
  get current(): boolean {
    const repos = this.#repos;
    return repos !== undefined && this.#listing.current &&
      this.#pushed.size === 0 &&
      repos.every((repo) =>
        this.#held.get(repo.name)?.pushedAt === repo.pushedAt ||
        this.#refused.has(repo.name)
      );
  }

  /** Every commit held, of every repository. */
  get commits(): Commit[] {
    return [...this.#held.values()].flatMap((held) => held.commits);
  }

  /**
   * The repositories, as "owner/name", whose commits GitHub refused to list
   * when they were last read.
   */
  get refused(): ReadonlySet<string> {
    return new Set(this.#refused);
  }

  /**
   * Lists the organization's repositories, unless the relay vouches for the
   * last listing and it holds every repository delivered as pushed to, and
   * reads the commits of each one pushed to since its commits were read, or
   * delivered as pushed to. A repository a delivery said left the
   * organization is left out of every listing until one leaves it out
   * itself. A repository whose commits
   * cannot be read keeps those it had. It is read again by the next refresh
   * when GitHub failed, and after its next push when GitHub refused the
   * request. Returns whether the commits held, or the repositories refused,
   * changed.
   */
  async refresh(credential: GitHubCredential): Promise<boolean> {
    if (
      this.#repos === undefined || !this.#listing.current ||
      this.#pushedUnlisted()
    ) {
      const listed = this.#listing.reading();
      const listedAfter = this.#webhooks.deliveries;
      const repos = await organizationRepos(credential);
      listed();
      const names = new Set(repos.map((repo) => repo.name.toLowerCase()));
      for (const key of this.#gone) if (!names.has(key)) this.#gone.delete(key);
      this.#repos = repos.filter((repo) =>
        !this.#gone.has(repo.name.toLowerCase())
      );
      // A push to a repository this listing still leaves out is to one the
      // credential cannot see, or one the listing is behind, which the next
      // listing finds when its own push or the relay's vouching runs out.
      for (const [key, pending] of this.#pushed) {
        if (!names.has(key) && pending.delivery <= listedAfter) {
          this.#pushed.delete(key);
        }
      }
    }
    const repos = this.#repos;
    const listed = new Set(repos.map((repo) => repo.name));
    let changed = this.#dropped;
    this.#dropped = false;
    for (const name of this.#held.keys()) {
      if (!listed.has(name)) {
        this.#held.delete(name);
        changed = true;
      }
    }
    for (const name of this.#refused) {
      if (!listed.has(name)) {
        this.#refused.delete(name);
        changed = true;
      }
    }
    const pushed = repos.filter((repo) =>
      this.#held.get(repo.name)?.pushedAt !== repo.pushedAt ||
      this.#pushed.has(repo.name.toLowerCase())
    );
    await inParallel(
      GITHUB_REQUEST_CONCURRENCY,
      pushed.map((repo) => async () => {
        const before = this.#held.get(repo.name)?.commits;
        const key = repo.name.toLowerCase();
        const expected = this.#pushed.get(key);
        try {
          const { head, commits } = await readCommits(repo, credential);
          // A push delivered while the read ran stays, for the next one, and
          // so does one the history does not show yet.
          if (
            this.#pushed.get(key) === expected &&
            (head ?? DELETED) === expected?.after
          ) this.#pushed.delete(key);
          if (before === undefined || before[0]?.sha !== commits[0]?.sha) {
            changed = true;
          }
          if (this.#refused.delete(repo.name)) changed = true;
          this.#held.set(repo.name, { pushedAt: repo.pushedAt, commits });
        } catch (error) {
          console.error(
            `recent commits: could not read ${repo.name}'s commits:`,
            messageOf(error),
          );
          if (isRefusal(error)) {
            if (!this.#refused.has(repo.name)) changed = true;
            this.#refused.add(repo.name);
            if (this.#pushed.get(key) === expected) this.#pushed.delete(key);
            this.#held.set(repo.name, {
              pushedAt: repo.pushedAt,
              commits: before ?? [],
            });
          }
        }
      }),
    );
    return changed;
  }

  /**
   * Helper for `refresh()`, which returns whether a push has been delivered
   * to a repository the last listing does not hold, which the next listing
   * may.
   */
  #pushedUnlisted(): boolean {
    const names = new Set(
      (this.#repos ?? []).map((repo) => repo.name.toLowerCase()),
    );
    return [...this.#pushed.keys()].some((key) => !names.has(key));
  }
}

/** A commit the tile lists, and the newest run of a followed workflow on it. */
export interface CommitRow {
  /** The commit the row lists. */
  readonly commit: Commit;

  /** The newest run of a followed workflow on the commit, if any. */
  readonly run?: Run;
}

/**
 * Returns the rows for `commits` and `runs`, newest commit first. A run is put
 * on the row of its commit, the newest run of each commit winning. A run
 * started by a push to a commit missing from `commits` brings a row for its
 * commit, dated when the run was created, so every commit a followed workflow
 * judged on its main branch is listed whether or not a pull request landed it.
 */
export function commitRows(
  commits: readonly Commit[],
  runs: readonly Run[],
): CommitRow[] {
  const keyOf = (repo: string, sha: string) => `${repo} ${sha}`;
  const newest = new Map<string, Run>();
  for (const run of runs) {
    const key = keyOf(repoOf(run), run.head_sha);
    const held = newest.get(key);
    if (!held || Date.parse(held.created_at) < Date.parse(run.created_at)) {
      newest.set(key, run);
    }
  }
  const listed = new Map<string, Commit>(
    commits.map((commit) => [keyOf(commit.repo, commit.sha), commit]),
  );
  for (const run of runs) {
    const key = keyOf(repoOf(run), run.head_sha);
    if (run.event !== "push" || listed.has(key)) continue;
    listed.set(key, {
      repo: repoOf(run),
      sha: run.head_sha,
      title: (run.head_commit?.message ?? run.display_title).split("\n", 1)[0],
      at: run.created_at,
    });
  }
  return [...listed].map(([key, commit]) => ({ commit, run: newest.get(key) }))
    .sort((a, b) => Date.parse(b.commit.at) - Date.parse(a.commit.at));
}

/**
 * Returns the dot a run is marked with and the words its result is given: running
 * until it completes, green when it passed, saying which attempt passed when
 * it took more than one, and otherwise its conclusion.
 */
export function runOutcome(run: Run): { dot: string; text: string } {
  if (run.status !== "completed") {
    return {
      dot: "run",
      text: `running${run.run_attempt > 1 ? ` · attempt ${run.run_attempt}` : ""}`,
    };
  }
  return {
    dot: concDot(run.conclusion, run.run_attempt),
    text: run.conclusion === "success"
      ? (run.run_attempt > 1 ? `green on retry #${run.run_attempt}` : "green")
      : (run.conclusion ?? "done"),
  };
}

function runDuration(run: Run): string | null {
  const ran = runDurationMs(run);
  return ran === undefined ? null : humanDuration(ran);
}

/**
 * Returns the link to the commit CI Gantt page for every successful push run on `run`'s commit
 * among `candidates`, or null when `run` is not such a run, its repository's
 * runs are not charted there, or there are too many runs to chart.
 */
export function commitGanttHref(
  run: Run,
  candidates: readonly Run[],
): string | null {
  const charted = Object.values(CI_HISTORY_SOURCES).find((source) =>
    source.repo === repoOf(run)
  );
  if (
    !charted || !run.head_sha || run.status !== "completed" ||
    run.conclusion !== "success" || run.event !== "push"
  ) return null;
  const selected = new Map<number, Run>();
  for (const candidate of candidates) {
    if (
      repoOf(candidate) !== repoOf(run) ||
      candidate.head_sha !== run.head_sha ||
      candidate.status !== "completed" ||
      candidate.conclusion !== "success" || candidate.event !== "push"
    ) continue;
    const current = selected.get(candidate.id);
    if (!current || current.run_attempt < candidate.run_attempt) {
      selected.set(candidate.id, candidate);
    }
  }
  if (!selected.size || selected.size > GANTT_MAX_RUNS) return null;
  const parameters = new URLSearchParams({
    repo: charted.key,
    sha: run.head_sha,
    limit: String(selected.size),
    mainOnly: "1",
  });
  for (const selectedRun of selected.values()) {
    parameters.append(
      "run",
      `${selectedRun.id}:${selectedRun.run_attempt}`,
    );
  }
  return `/ci-gantt?${parameters}`;
}

/** Returns the markup of a row of the tile, whose commit ran `runs`. */
function rowHtml({ commit, run }: CommitRow, runs: readonly Run[]): string {
  const short = shortRepo(commit.repo);
  const key = `${short}-${commit.sha}`;
  const { title } = commit;
  const outcome = run && runOutcome(run);
  const ganttHref = run && commitGanttHref(run, runs);
  const duration = run && runDuration(run);
  const durationHtml = ganttHref && duration
    ? `<a class="evdur" data-focus-key="gantt-${escapeHtml(key)}" href="${
      escapeHtml(ganttHref)
    }" title="View CI Gantt for ${escapeHtml(commit.sha.slice(0, 7))}">${
      escapeHtml(duration)
    }</a>`
    : `<span class="evdur">${
      escapeHtml(
        !run
          ? ""
          : duration ?? (run.status !== "completed" ? "running" : "—"),
      )
    }</span>`;
  const at = escapeHtml(commit.at);
  return `<div class="ev"><time class="t" datetime="${at}" data-viewer-time>${
    escapeHtml(utcFallback(commit.at))
  }</time><span class="dot${
    outcome ? ` ${outcome.dot}` : ""
  }"></span><span class="evtxt">${greenStar(run?.green)}${
    pullRequestLinks(
      outcome ? `${short} · ${outcome.text} · ${title}` : `${short} · ${title}`,
      commit.repo,
      run?.html_url ?? `https://github.com/${commit.repo}/commit/${commit.sha}`,
      `title-${key}`,
    )
  }</span>${durationHtml}<a class="evarrow" data-focus-key="pr-arrow-${
    escapeHtml(key)
  }" href="${
    escapeHtml(landingHref(title, commit.sha, commit.repo))
  }" target="_blank" rel="noopener" aria-label="Open landed change on GitHub">↗</a></div>`;
}

const sources = [
  runSource(REPO, CI_WORKFLOW, "main"),
  runSource(LOOM_REPO, LOOM_CI_WORKFLOW, "main"),
  runSource(WEAVER_REPO, WEAVER_CI_WORKFLOW, "main"),
];

/** The recent commits tile, and what lets a test wait for its reading. */
export interface RecentCommitsTile extends Tile {
  /** Settles once the read of the organization's commits under way ends. */
  reading(): Promise<void>;
}

/**
 * Creates a recent commits tile that reads the organization's commits into
 * `organization`, which holds none until the tile's first collection, and
 * learns from `webhooks` of the pushes and repository changes that ask for a
 * read at once.
 */
export function createRecentCommits(
  organization = new OrganizationCommits(),
  webhooks: GitHubWebhooks = githubWebhooks,
): RecentCommitsTile {
  let reading: Promise<void> | undefined;
  let readStartedAt = -Infinity;
  let failure: string | undefined;
  let read = false;
  let wanted = false;
  let collectedWith:
    | { collectAgain: (() => void) | undefined; credential: GitHubCredential }
    | undefined;

  // Starts a read of the organization's commits when one is due, which a
  // delivery makes it at once, and never while the relay vouches that it
  // would read nothing. Once it ends, the tile asks to be collected again if
  // what it shows has changed, and a read a delivery asked for meanwhile
  // starts.
  const startReading = (
    collectAgain: (() => void) | undefined,
    credential: GitHubCredential,
  ): void => {
    if (reading || organization.current) return;
    if (!wanted && Date.now() - readStartedAt < COMMITS_REFRESH_MS) return;
    wanted = false;
    readStartedAt = Date.now();
    const failedBefore = failure;
    reading = organization.refresh(credential).then(
      (changed) => {
        failure = undefined;
        read = true;
        if (changed || failedBefore !== undefined) collectAgain?.();
      },
      (error) => {
        failure = messageOf(error);
        console.error(
          "recent commits: could not list the organization's repositories:",
          failure,
        );
        if (failure !== failedBefore) collectAgain?.();
      },
    ).finally(() => {
      reading = undefined;
      if (wanted && collectedWith) {
        startReading(collectedWith.collectAgain, collectedWith.credential);
      }
    });
  };

  webhooks.listen((delivery) => {
    const push = pushOf(delivery);
    if (
      delivery.event !== "repository" &&
      (push === undefined || push.ref !== `refs/heads/${push.defaultBranch}`)
    ) return;
    wanted = true;
    if (collectedWith) {
      startReading(collectedWith.collectAgain, collectedWith.credential);
    }
  });

  return {
    label: "recent commits",
    intervalMs: 30_000,
    wide: true,
    runSources: sources,
    reading: () => reading ?? Promise.resolve(),
    async collect(ctx): Promise<TileView> {
      const credential = dashboardGitHubCredential(ctx);
      if (credential) {
        collectedWith = { collectAgain: ctx.collectAgain, credential };
        startReading(ctx.collectAgain, credential);
      }
      const runs = (await Promise.all(
        sources.map((source) => ctx.runsFor(source)),
      )).flat();
      const rows = commitRows(organization.commits, runs).slice(
        0,
        RECENT_DISPLAY,
      );

      const completedOutcomes = runs
        .filter((run) => run.status === "completed" && run.conclusion)
        .sort((a, b) =>
          Date.parse(b.run_started_at) - Date.parse(a.run_started_at)
        )
        .map((run) => concDot(run.conclusion, run.run_attempt));
      const status: Status = completedOutcomes.length === 0
        ? "unknown"
        : completedOutcomes[0] === "red"
        ? "bad"
        : completedOutcomes.slice(0, RECENT_WINDOW).includes("red")
        ? "warn"
        : "good";

      const refused = organization.refused.size;
      const sub = failure !== undefined
        ? friendlyError(failure)
        : refused > 0
        ? `${refused} ${refused === 1 ? "repository" : "repositories"} unreadable`
        : undefined;
      const html = rows.map((row) => rowHtml(row, runs)).join("") ||
        `<div class="ev"><span class="dot gray"></span><span>${
          read ? "no commits found" : "waiting for first poll…"
        }</span></div>`;
      const count = `${rows.length} in window`;
      return {
        status,
        ...(sub === undefined ? {} : { sub }),
        aside: `<span class="hfacet" title="${count}">${count}</span>`,
        extra: `<div class="evscroll" data-focus-key="commits">${html}</div>`,
      };
    },
  };
}

/** The dashboard's recent commits tile. */
export const recentCommits = createRecentCommits();
