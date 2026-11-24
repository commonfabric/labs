/**
 * Feeds the runners page: holds which jobs are queued and running, from the
 * GitHub webhook relay's deliveries and from GitHub's API, and which runners
 * the organization has, and passes them to every page open over a WebSocket.
 * A socket opens with a snapshot of everything held, then carries what each
 * relay delivery about a job or a run says, as it arrives, so that the page
 * follows the same changes the server does.
 *
 * What the relay delivers is complete only from when a connection to it is
 * first heard, and GitHub does not promise to make every delivery, so the
 * jobs under way are read from GitHub's API afresh whenever the relay does
 * not vouch for what was last read: when a page opens, on a delivery, or on
 * the server's tick while a page is open, but at most every five minutes. The runners are read when a page opens, at most twice a minute,
 * and on the server's tick while a page is open, every five minutes, since
 * no delivery says when a runner comes, goes, or loses its connection.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import type { LargerRunner, Runner, RunnersMessage } from "./runner-board.ts";
import { jobNewsOf, JobTracker, type News, newsOf, runNewsOf } from "./runner-jobs.ts";
import { runById, type RunRequest, runsUnderWay } from "./github-runs.ts";
import type { GitHubWebhooks, RelayStream } from "./github-webhooks.ts";
import type { GitHubCredential } from "./github-auth.ts";
import {
  dashboardGitHubCredential,
  github,
  GITHUB_ORGANIZATION,
  GITHUB_REQUEST_CONCURRENCY,
  GitHubAnswers,
  type GitHubPage,
  githubPage,
  GitHubStatusError,
  inParallel,
  PROCESS_ENV,
} from "./lib.ts";
import { organizationRepos } from "./organization-repos.ts";

/** What the feed reads from GitHub's API. */
export interface RunnersGitHub {
  /** Returns the repositories whose jobs to read, as "owner/name". */
  repositories(): Promise<readonly string[]>;

  /**
   * Returns the runs of `repo` under way, as GitHub describes them, looking
   * for runs long under way further down its list only when `deep`.
   */
  runsUnderWay(repo: string, deep: boolean): Promise<readonly unknown[]>;

  /** Returns run `run` of `repo`, as GitHub describes it, or `undefined` once it is deleted. */
  run(repo: string, run: number): Promise<unknown>;

  /** Returns the jobs of the latest attempt at run `run` of `repo`. */
  jobs(repo: string, run: number): Promise<readonly unknown[]>;

  /** Returns the organization's self-hosted runners. */
  runners(): Promise<readonly Runner[]>;

  /** Returns the organization's larger runners. */
  largerRunners(): Promise<readonly LargerRunner[]>;
}

/** The end of a page's socket that the feed writes to. */
export interface RunnersSocket {
  /** 1 while the socket is open, as `WebSocket.OPEN` is. */
  readonly readyState: number;
  /** How many bytes sent are still waiting to go. */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
}

/** How many pages may have the socket open at once. */
const MOST_SOCKETS = 64;

/** How many bytes a socket may leave waiting before it is closed. */
const MOST_BUFFERED = 64 * 1024 * 1024;

/** How old a repository's last push may be for its jobs to be read. */
const PUSHED_WITHIN_MS = 7 * 86_400_000;

/** How long a read of the runners serves the pages that open after it. */
const RUNNERS_REUSE_MS = 30_000;

/**
 * How long the runners and the jobs under way go unread at most while a page
 * is open, and at least between reads of the jobs.
 */
const REREAD_MS = 5 * 60_000;

/**
 * Returns what the feed reads from GitHub's API with the dashboard's own
 * credential: the jobs of the organization's repositories pushed to in the
 * last week, and its runners, each request conditional on the last answer
 * to it.
 */
export function dashboardRunnersGitHub(): RunnersGitHub {
  const org = GITHUB_ORGANIZATION.name;
  const finished = new Map<number, string>();
  // Every read is conditional on what the last answer to it was, so that a
  // read of what has not changed costs nothing from the rate limit.
  const answers = new GitHubAnswers();
  const request: RunRequest = (path, options) => github(path, undefined, { ...options, answers });
  const all = async (path: string, key: string): Promise<unknown[]> => {
    const items: unknown[] = [];
    let next: string | undefined = path;
    while (next !== undefined) {
      const page: GitHubPage<unknown> = await githubPage<unknown>(next, undefined, { answers });
      const list = isObjectNotArray(page.value) ? page.value[key] : undefined;
      if (!Array.isArray(list)) throw new Error(`GitHub API ${path} returned invalid data`);
      for (const item of list) items.push(item);
      next = page.next;
    }
    return items;
  };
  const number = (value: unknown) => typeof value === "number" ? value : null;
  return {
    async repositories() {
      const repos = await organizationRepos(dashboardCredential(), { answers });
      const now = Date.now();
      return repos.filter((repo) =>
        repo.pushedAt !== null && now - Date.parse(repo.pushedAt) < PUSHED_WITHIN_MS
      ).map((repo) => repo.name);
    },
    runsUnderWay: (repo, deep) => runsUnderWay(request, repo, finished, deep),
    run: (repo, run) => runById(request, repo, run),
    jobs: (repo, run) => all(`repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`, "jobs"),
    async runners() {
      return (await all(`orgs/${org}/actions/runners?per_page=100`, "runners")).filter(isObjectNotArray)
        .flatMap(({ name, labels, status }) =>
          typeof name === "string"
            ? [{
              owner: org,
              name,
              labels: Array.isArray(labels)
                ? labels.filter(isObjectNotArray).flatMap((label) =>
                  typeof label.name === "string" ? [label.name] : []
                )
                : [],
              online: status === "online",
            }]
            : []
        );
    },
    async largerRunners() {
      return (await all(`orgs/${org}/actions/hosted-runners?per_page=100`, "runners"))
        .filter(isObjectNotArray).flatMap((runner) => {
          const name = runner.name;
          if (typeof name !== "string") return [];
          const size = isObjectNotArray(runner.machine_size_details) ? runner.machine_size_details : {};
          return [{
            owner: org,
            name,
            maximum: number(runner.maximum_runners),
            cores: number(size.cpu_cores),
            memory: number(size.memory_gb),
          }];
        });
    },
  };
}

/**
 * Helper for `dashboardRunnersGitHub()`, which returns the dashboard's
 * credential, and throws when the environment configures none.
 */
function dashboardCredential(): GitHubCredential {
  const credential = dashboardGitHubCredential(PROCESS_ENV);
  if (credential === undefined) {
    throw new Error("set `GH_TOKEN` or `GITHUB_TOKEN`, or `GH_APP_CLIENT_ID` and `GH_APP_PRIVATE_KEY`");
  }
  return credential;
}

/**
 * The jobs and runners the runners page shows, and the sockets of the pages
 * open.
 */
export class RunnersFeed {
  #github: RunnersGitHub;
  #webhooks: GitHubWebhooks;
  #version: string;
  #key = crypto.randomUUID();
  #tracker = new JobTracker();
  #sockets = new Set<RunnersSocket>();
  #hidden = new Set<RunnersSocket>();
  #runners: readonly Runner[] = [];
  #larger: readonly LargerRunner[] = [];
  #runnerProblems: readonly string[] = [];
  #runnersReadAt = -Infinity;
  #readingRunners: Promise<void> | undefined;
  #jobProblems: readonly string[] = [];
  #readUnder: RelayStream | undefined;
  #readAt = -Infinity;
  #triedAt = -Infinity;
  #priming: Promise<void> | undefined;
  #held: News[] | undefined;
  #toldSilent = false;
  #watching = 0;

  /**
   * Constructs an instance that reads from `github`, takes in what `webhooks`
   * delivers, and tells each page it serves `version`, so that a page served
   * by another version reloads.
   */
  constructor(github: RunnersGitHub, webhooks: GitHubWebhooks, version: string) {
    this.#github = github;
    this.#webhooks = webhooks;
    this.#version = version;
    webhooks.listen((delivery) => {
      this.#hear(newsOf(delivery.event, delivery.payload));
      // Any delivery shows the relay heard, which pages told it was silent
      // are told.
      if (this.#toldSilent) this.#tellProblems();
    });
  }

  /** What tests read of the feed. */
  get accessForTestingOnly(): { readonly tracker: JobTracker } {
    return { tracker: this.#tracker };
  }

  /**
   * The key a socket's request must carry. Only a page of the dashboard's
   * own origin can read it, from `RUNNERS_KEY_PATH` in runners-paths.ts, so another site a
   * reader visits cannot open a socket and read the organization's jobs.
   */
  get key(): string {
    return this.#key;
  }

  /**
   * Upgrades `request` to the WebSocket of a runners page, which opens with
   * a snapshot, and reads from GitHub what is not current, unless `request`
   * does not carry the key, which is refused.
   */
  open(request: Request): Response {
    if (new URL(request.url).searchParams.get("key") !== this.#key) {
      return new Response("The runners socket needs the page's key.", { status: 403 });
    }
    if (this.#sockets.size >= MOST_SOCKETS) {
      return new Response("The runners page is open in too many places.", { status: 503 });
    }
    let upgraded: { socket: WebSocket; response: Response };
    try {
      upgraded = Deno.upgradeWebSocket(request);
    } catch (error) {
      return new Response(`Not a WebSocket request: ${describeFailure(error)}`, { status: 400 });
    }
    const { socket, response } = upgraded;
    socket.addEventListener("open", () => {
      this.serve(socket).catch((error) =>
        console.error("runners page: serving a socket failed:", describeFailure(error))
      );
    });
    socket.addEventListener("message", (event) => this.hear(socket, event.data));
    socket.addEventListener("close", () => this.forget(socket));
    return response;
  }

  /**
   * Sends `socket`, newly open, a snapshot, and from then on what changes,
   * and, while a reader can see a page, reads the runners, and the jobs under
   * way unless what was last read is current or being read. Resolves once those reads are done.
   */
  async serve(socket: RunnersSocket): Promise<void> {
    this.#sockets.add(socket);
    this.#send(socket, JSON.stringify(this.#snapshot()));
    if (!this.#watched) return;
    await Promise.all([this.#readRunners(RUNNERS_REUSE_MS), this.#readJobs()]);
  }

  /**
   * Stops sending to `socket`, which has closed. Once no page is open, the
   * feed forgets the jobs it holds and stops taking in deliveries, since no
   * read keeps them current then, and the next page to open reads them
   * afresh.
   */
  forget(socket: RunnersSocket): void {
    this.#sockets.delete(socket);
    this.#hidden.delete(socket);
    if (this.#sockets.size > 0) return;
    this.#watching++;
    this.#priming = undefined;
    this.#held = undefined;
    this.#tracker.replace([]);
    this.#readUnder = undefined;
    this.#readAt = -Infinity;
    this.#triedAt = -Infinity;
  }

  /**
   * Takes in `data`, a message the page of `socket` sent. A page says only
   * whether a reader can see it; anything else is not from a runners page,
   * and is ignored.
   */
  hear(socket: RunnersSocket, data: unknown): void {
    let message: unknown;
    try {
      message = typeof data === "string" ? JSON.parse(data) : undefined;
    } catch {
      return;
    }
    if (isObjectNotArray(message) && message.type === "visible" && typeof message.visible === "boolean") {
      this.see(socket, message.visible);
    }
  }

  /**
   * Notes whether a reader can see the page of `socket`, as the page says.
   * Only a page someone can see has GitHub read for it: a hidden page is
   * sent every delivery, which costs nothing, and when one becomes visible
   * while none other is, what is not current is read.
   */
  see(socket: RunnersSocket, visible: boolean): void {
    if (!this.#sockets.has(socket)) return;
    const watched = this.#watched;
    if (visible) this.#hidden.delete(socket);
    else this.#hidden.add(socket);
    if (watched || !this.#watched) return;
    Promise.all([this.#readRunners(RUNNERS_REUSE_MS), this.#readJobs()]).catch((error) =>
      console.error("runners page: catching up for a page shown again failed:", describeFailure(error))
    );
  }

  /** Helper for the methods that read GitHub, which returns whether a reader can see any page. */
  get #watched(): boolean {
    return this.#sockets.size > this.#hidden.size;
  }

  /**
   * Keeps what open pages show current where no delivery says what changed,
   * on the server's tick: tells them the server is still there, and when the
   * relay falls silent, and, while a reader can see one, reads
   * again the jobs under way the relay no longer vouches for, and the
   * runners, each at most every `REREAD_MS`. Resolves once those reads are
   * done. Does nothing while no page is open.
   */
  async tick(): Promise<void> {
    if (this.#sockets.size === 0) return;
    this.#broadcast({ type: "ping" });
    if (this.#toldSilent !== (this.#webhooks.stream === undefined)) this.#tellProblems();
    if (!this.#watched) return;
    await Promise.all([this.#readRunners(REREAD_MS), this.#readJobs()]);
  }

  /**
   * Helper for `serve()` and `tick()`, which resolves once the jobs under way
   * are current: at once when the relay vouches for what was last read, or
   * when that was tried within `REREAD_MS`, and otherwise once a read, the
   * one in flight or a new one, is done.
   */
  #readJobs(): Promise<void> | undefined {
    if (this.#priming) return this.#priming;
    if (this.#current || Date.now() - this.#triedAt < REREAD_MS) return undefined;
    return this.prime();
  }

  /**
   * Reads the jobs under way from GitHub's API, and starts afresh from them,
   * taking in again what the relay delivered during the read, and sends every
   * page a snapshot. Asked to read while reading, it returns the read in
   * flight. The jobs read count as current, for as long as the relay vouches
   * for them, only when every read succeeded.
   */
  prime(): Promise<void> {
    if (this.#priming) return this.#priming;
    const held: News[] = [];
    this.#held = held;
    const priming = this.#primeOnce(held).finally(() => {
      if (this.#priming !== priming) return;
      this.#priming = undefined;
      this.#held = undefined;
    });
    this.#priming = priming;
    return priming;
  }

  /**
   * Helper for `prime()`, which reads the jobs under way, of the
   * repositories `github` names and those of the jobs held, and starts afresh
   * from them and `held`, what the relay delivered since the read started, keeping the jobs held of each repository or run that could not
   * be read. A read that cannot list the repositories leaves the jobs held as
   * they were.
   */
  async #primeOnce(held: readonly News[]): Promise<void> {
    const stream = this.#webhooks.stream;
    const startedAt = Date.now();
    this.#triedAt = startedAt;
    // Runs long under way are looked for further down the lists once for
    // each relay connection: after one read under it succeeds, every run
    // that has started since has been delivered.
    const deep = stream === undefined || stream !== this.#readUnder;
    const news: News[] = [];
    const problems: string[] = [];
    const watching = this.#watching;
    const unread = new Set<string>();
    const unreadRuns = new Set<number>();
    const gone = new Set<string>();
    const heldRuns = new Map<number, string>();
    const ended: News[] = [];
    for (const job of this.#tracker.jobs.values()) heldRuns.set(job.runId, `${job.owner}/${job.repository}`);
    try {
      const repositories = new Set([...await this.#github.repositories(), ...heldRuns.values()]);
      // Each repository's runs take several requests at once.
      const runs = (await inParallel(
        GITHUB_REQUEST_CONCURRENCY / 4,
        [...repositories].map((repo) => async () => {
          try {
            return (await this.#github.runsUnderWay(repo, deep)).flatMap((run) => {
              const read = runNewsOf(run);
              return read ? [{ repo, read }] : [];
            });
          } catch (error) {
            // A repository GitHub no longer shows the dashboard has no runs
            // for it to show.
            if (
              error instanceof GitHubStatusError && !error.rateLimited &&
              (error.status === 403 || error.status === 404)
            ) {
              gone.add(repo);
              return [];
            }
            problems.push(`${repo}: ${describeFailure(error)}`);
            unread.add(repo);
            return [];
          }
        }),
      )).flat();
      // A run held that no list named, as a list can leave out a run long
      // under way, is read again by its id.
      const named = new Set(runs.map(({ read }) => read.id));
      const missing = [...heldRuns].filter(([run, repo]) => !named.has(run) && !unread.has(repo) && !gone.has(repo));
      for (
        const found of await inParallel(
          GITHUB_REQUEST_CONCURRENCY,
          missing.map(([run, repo]) => async () => {
            try {
              const read = runNewsOf(await this.#github.run(repo, run));
              if (read?.status === "completed") ended.push(read);
              return read && read.status !== "completed" ? [{ repo, read }] : [];
            } catch (error) {
              problems.push(`${repo}: ${describeFailure(error)}`);
              unreadRuns.add(run);
              return [];
            }
          }),
        )
      ) {
        for (const run of found) runs.push(run);
      }
      await inParallel(
        GITHUB_REQUEST_CONCURRENCY,
        runs.map(({ repo, read }) => async () => {
          news.push(read);
          try {
            for (const job of await this.#github.jobs(repo, read.id)) {
              const jobNews = jobNewsOf(job, repo);
              if (jobNews) news.push(jobNews);
            }
          } catch (error) {
            problems.push(`${repo}: ${describeFailure(error)}`);
            unreadRuns.add(read.id);
          }
        }),
      );
    } catch (error) {
      if (watching !== this.#watching) return;
      this.#jobProblems = [`The jobs under way could not be read: ${describeFailure(error)}`];
      this.#tellProblems();
      return;
    }
    // A read that ends after every page closed is of no use: the next page
    // to open reads afresh.
    if (watching !== this.#watching) return;
    // A run held that ended unseen ends its jobs as it ended, for every page.
    for (const read of ended) {
      this.#tracker.take(read);
      this.#broadcast({ type: "news", news: read });
    }
    this.#tracker.replace(
      [...news, ...held],
      (job) => unread.has(`${job.owner}/${job.repository}`) || unreadRuns.has(job.runId),
    );
    this.#jobProblems = problems;
    if (problems.length === 0) {
      this.#readUnder = stream;
      this.#readAt = startedAt;
    }
    this.#broadcast(this.#snapshot());
  }

  /**
   * Helper for the methods that decide whether to read the jobs under way,
   * which returns whether the relay vouches for the last read that
   * succeeded: whether the connection it was read under is still heard, and
   * the read is younger than the relay vouches for.
   */
  get #current(): boolean {
    return this.#webhooks.vouchesFor(this.#readUnder, this.#readAt);
  }

  /**
   * Helper for `serve()` and `tick()`, which reads the runners unless they
   * were read within `reuse` or are being read, and sends every page what it
   * read. A list that cannot be read is kept as it was.
   */
  #readRunners(reuse: number): Promise<void> {
    if (this.#readingRunners) return this.#readingRunners;
    if (Date.now() - this.#runnersReadAt < reuse) return Promise.resolve();
    this.#readingRunners = (async () => {
      const problems: string[] = [];
      const read = async <T>(
        what: string,
        list: () => Promise<readonly T[]>,
        held: readonly T[],
      ): Promise<readonly T[]> => {
        try {
          return await list();
        } catch (error) {
          problems.push(`The organization's ${what} could not be read: ${describeFailure(error)}`);
          return held;
        }
      };
      const [runners, larger] = await Promise.all([
        read("runners", () => this.#github.runners(), this.#runners),
        read("larger runners", () => this.#github.largerRunners(), this.#larger),
      ]);
      this.#runners = runners;
      this.#larger = larger;
      this.#runnerProblems = problems;
      this.#runnersReadAt = Date.now();
      this.#broadcast({ type: "runners", runners, larger, problems: this.#problems() });
    })().finally(() => {
      this.#readingRunners = undefined;
    });
    return this.#readingRunners;
  }

  /**
   * Helper for the constructor's listener, which takes in what a delivery
   * says about a job or a run and passes it to every page, while any is
   * open. While a page is
   * open, it has the jobs under way read again when the relay does not vouch
   * for the last read that succeeded, as when the delivery came on a new
   * connection, since GitHub does not promise to make every delivery, unless
   * a read was tried within `REREAD_MS`.
   */
  #hear(news: News | undefined): void {
    if (news === undefined || this.#sockets.size === 0) return;
    if (
      this.#watched && !this.#current && Date.now() - this.#triedAt >= REREAD_MS
    ) {
      this.prime().catch((error) =>
        console.error("runners page: reading the jobs under way failed:", describeFailure(error))
      );
    }
    this.#held?.push(news);
    this.#tracker.take(news);
    this.#broadcast({ type: "news", news });
  }

  /** Helper for the methods that tell pages what is wrong, which tells them. */
  #tellProblems(): void {
    this.#broadcast({ type: "runners", runners: this.#runners, larger: this.#larger, problems: this.#problems() });
  }

  /** Helper for the methods that tell pages what is held, which returns all of it. */
  #snapshot(): RunnersMessage {
    return {
      type: "snapshot",
      version: this.#version,
      tracker: this.#tracker.snapshot(),
      runners: this.#runners,
      larger: this.#larger,
      problems: this.#problems(),
    };
  }

  /** Helper for the methods that tell pages what is held, which returns what is wrong. */
  #problems(): string[] {
    const problems = [...this.#jobProblems, ...this.#runnerProblems];
    if (this.#webhooks.stream === undefined) {
      problems.unshift(
        "The GitHub webhook relay has been silent for two minutes or more, so jobs may have started or ended unseen.",
      );
    }
    return problems;
  }

  /** Helper for the methods that tell pages what changed, which sends `message` to every page. */
  #broadcast(message: RunnersMessage): void {
    // What every open page was last told of whether the relay is silent.
    if (message.type === "snapshot" || message.type === "runners") {
      this.#toldSilent = this.#webhooks.stream === undefined;
    }
    const data = JSON.stringify(message);
    for (const socket of this.#sockets) this.#send(socket, data);
  }

  /**
   * Helper for the methods that tell pages what changed, which sends `data`
   * to `socket` when it is open, and closes it instead when it has not
   * taken in what it was sent before, a sixteenth of a gigabyte, so that a
   * page that stops reading cannot make the server hold ever more for it.
   */
  #send(socket: RunnersSocket, data: string): void {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > MOST_BUFFERED) {
      this.forget(socket);
      socket.close();
      return;
    }
    socket.send(data);
  }
}
