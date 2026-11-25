import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import type { LargerRunner, Runner, RunnersMessage } from "./runner-board.ts";
import { jobNewsOf, type News, runNewsOf } from "./runner-jobs.ts";
import {
  dashboardRunnersGitHub,
  RunnersFeed,
  type RunnersGitHub,
  type RunnersSocket,
} from "./runners-feed.ts";
import { GITHUB_ORGANIZATION, GitHubStatusError } from "./lib.ts";
import type { GitHubRun } from "./github-runs.ts";
import { RELAY_QUIET_MS, RELAY_VOUCH_MS } from "./github-webhooks.ts";
import { FakeRelay, pushPayload, workflowRunPayload } from "./test/webhook-relay.ts";
import { afterEach, beforeEach, describe, it } from "@commonfabric/test-support/test";

const REPO = "example/repo";
const VERSION = "feed-test-version";
const SILENT =
  "The GitHub webhook relay has been silent for two minutes or more, so jobs may have started or ended unseen.";

/** How many bytes a socket may leave waiting before the feed closes it. */
const MOST_BUFFERED = 64 * 1024 * 1024;

/** How long the feed goes at least between reads of the jobs, and at most between reads while a page is open. */
const REREAD_MS = 5 * 60_000;

/** When each case that controls the clock starts it. */
const NOW = Date.UTC(2026, 10, 24, 12);

type Snapshot = Extract<RunnersMessage, { type: "snapshot" }>;
type RunnersUpdate = Extract<RunnersMessage, { type: "runners" }>;

/** A run of `REPO` under way, as GitHub's API describes it. */
function apiRun(id: number, fields: Record<string, unknown> = {}) {
  return {
    id,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    pull_requests: [],
    ...fields,
  };
}

/** A queued job of run `runId` of `REPO`, as GitHub's API describes it. */
function apiJob(id: number, runId: number, fields: Record<string, unknown> = {}) {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    name: `job ${id}`,
    status: "queued",
    conclusion: null,
    labels: ["ubuntu-latest"],
    html_url: `https://github.com/${REPO}/actions/runs/${runId}/job/${id}`,
    workflow_name: "CI",
    head_branch: "main",
    head_sha: "a".repeat(40),
    created_at: "2026-11-24T00:00:00Z",
    started_at: null,
    runner_name: null,
    runner_group_name: null,
    ...fields,
  };
}

/** The payload of a `workflow_job` delivery reporting `job` of `repo`. */
function jobPayload(job: ReturnType<typeof apiJob>, repo = REPO) {
  return { action: job.status, repository: { full_name: repo }, workflow_job: job };
}

/**
 * A run of `REPO` under way, as a `workflow_run` delivery describes it, for
 * pull request `pullRequest`.
 */
function deliveredRun(id: number, pullRequest: number) {
  const run: GitHubRun = {
    id,
    event: "pull_request",
    head_branch: "topic",
    head_sha: "b".repeat(40),
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
    display_title: `run ${id}`,
    created_at: "2026-11-24T00:00:00Z",
    run_started_at: "2026-11-24T00:00:00Z",
    updated_at: "2026-11-24T00:00:00Z",
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    head_commit: null,
  };
  const payload = workflowRunPayload(REPO, run);
  return { ...payload, workflow_run: { ...payload.workflow_run, pull_requests: [{ number: pullRequest }] } };
}

/** What the feed reads from GitHub, held in memory, counting each read. */
class FakeGitHub implements RunnersGitHub {
  repos: string[] = [REPO];
  /** The runs under way, by repository. */
  runs = new Map<string, unknown[]>();
  /** The jobs, by run. */
  jobsOf = new Map<number, unknown[]>();
  runnerList: Runner[] = [];
  largerList: LargerRunner[] = [];
  /** The repositories whose runs cannot be read, with why. */
  failingRepos = new Map<string, Error>();
  /** The runs whose jobs cannot be read, with why. */
  failingJobs = new Map<number, Error>();
  /** The runs read by their ids, by id; a run missing is one deleted. */
  runsById = new Map<number, unknown>();
  /** The runs that cannot be read by their ids, with why. */
  failingRunReads = new Map<number, Error>();
  /** The repositories whose runs were read, in order. */
  runsRead: string[] = [];
  /** Whether each read of a repository's runs looked deep, in order. */
  deep: boolean[] = [];
  /** The runs read by their ids, as "owner/name#id", in order. */
  runReads: string[] = [];
  /** How many repositories' runs are being read, and how many were at most. */
  readingRuns = 0;
  mostReadingRuns = 0;
  failRepositories: Error | undefined;
  failRunners: Error | undefined;
  repositoryReads = 0;
  runnerReads = 0;
  /** When set, the next read of the repositories waits for it to resolve. */
  holdRepositories: PromiseWithResolvers<void> | undefined;
  /** When set, the next read of the runners waits for it to resolve. */
  holdRunners: PromiseWithResolvers<void> | undefined;

  async repositories(): Promise<readonly string[]> {
    this.repositoryReads++;
    const hold = this.holdRepositories;
    this.holdRepositories = undefined;
    if (hold) await hold.promise;
    if (this.failRepositories) throw this.failRepositories;
    return this.repos;
  }

  async runsUnderWay(repo: string, deep: boolean): Promise<readonly unknown[]> {
    this.runsRead.push(repo);
    this.deep.push(deep);
    this.readingRuns++;
    this.mostReadingRuns = Math.max(this.mostReadingRuns, this.readingRuns);
    try {
      await Promise.resolve();
      const failure = this.failingRepos.get(repo);
      if (failure) throw failure;
      return this.runs.get(repo) ?? [];
    } finally {
      this.readingRuns--;
    }
  }

  run(repo: string, run: number): Promise<unknown> {
    this.runReads.push(`${repo}#${run}`);
    const failure = this.failingRunReads.get(run);
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.runsById.get(run));
  }

  jobs(_repo: string, run: number): Promise<readonly unknown[]> {
    const failure = this.failingJobs.get(run);
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.jobsOf.get(run) ?? []);
  }

  async runners(): Promise<readonly Runner[]> {
    this.runnerReads++;
    const hold = this.holdRunners;
    this.holdRunners = undefined;
    if (hold) await hold.promise;
    if (this.failRunners) throw this.failRunners;
    return this.runnerList;
  }

  largerRunners(): Promise<readonly LargerRunner[]> {
    return Promise.resolve(this.largerList);
  }
}

/** A page's socket, which keeps every message it is sent, by type. */
class FakeSocket implements RunnersSocket {
  readyState = 1;
  bufferedAmount = 0;
  closes = 0;
  /** When set, sending a snapshot throws it. */
  snapshotFailure: Error | undefined;
  snapshots: Snapshot[] = [];
  pings = 0;
  news: News[] = [];
  runnerUpdates: RunnersUpdate[] = [];
  #waiting: ((snapshot: Snapshot) => void)[] = [];

  send(data: string): void {
    const message: RunnersMessage = JSON.parse(data);
    if (message.type === "snapshot" && this.snapshotFailure) throw this.snapshotFailure;
    if (message.type === "snapshot") {
      this.snapshots.push(message);
      for (const resolve of this.#waiting.splice(0)) resolve(message);
    } else if (message.type === "news") {
      this.news.push(message.news);
    } else if (message.type === "ping") {
      this.pings++;
    } else {
      this.runnerUpdates.push(message);
    }
  }

  close(): void {
    this.closes++;
  }

  /** How many messages it has been sent. */
  get count(): number {
    return this.snapshots.length + this.news.length + this.pings + this.runnerUpdates.length;
  }

  /** Resolves with the next snapshot it is sent. */
  nextSnapshot(): Promise<Snapshot> {
    const next = Promise.withResolvers<Snapshot>();
    this.#waiting.push(next.resolve);
    return next.promise;
  }
}

/** The IDs of the jobs `snapshot` holds. */
const jobIds = (snapshot: Snapshot | undefined) => snapshot?.tracker.jobs.map((job) => job.id);

describe("runners-feed", () => {
  describe("RunnersFeed", () => {
    let github: FakeGitHub;
    let relay: FakeRelay;
    let feed: RunnersFeed;

    beforeEach(() => {
      github = new FakeGitHub();
      relay = new FakeRelay();
      feed = new RunnersFeed(github, relay.webhooks, VERSION);
    });

    /** The IDs of the jobs the feed holds. */
    const heldJobs = () => [...feed.accessForTestingOnly.tracker.jobs.keys()];

    /** Opens the relay and a page, and returns the page's socket once what it reads is read. */
    async function openPage(): Promise<FakeSocket> {
      await relay.open();
      const socket = new FakeSocket();
      await feed.serve(socket);
      return socket;
    }

    describe("constructor()", () => {
      it("forwards a `workflow_job` delivery to every open page as news", async () => {
        await relay.open();
        const socket = new FakeSocket();
        await feed.serve(socket);
        const job = apiJob(11, 1);

        await relay.deliver("workflow_job", jobPayload(job));

        expect(socket.news).toEqual([jobNewsOf(job, REPO)]);
        expect(heldJobs()).toEqual([11]);
        expect(github.repositoryReads).toBe(1);
      });

      it("forwards a `workflow_run` delivery to every open page as news", async () => {
        await relay.open();
        const socket = new FakeSocket();
        await feed.serve(socket);
        const payload = deliveredRun(1, 42);

        await relay.deliver("workflow_run", payload);

        expect(socket.news).toEqual([runNewsOf(payload.workflow_run)]);
        expect(feed.accessForTestingOnly.tracker.pullRequest(1)).toBe(42);
      });

      it("sends nothing for a delivery of another event", async () => {
        await relay.open();
        const socket = new FakeSocket();
        await feed.serve(socket);
        const before = socket.count;

        await relay.deliver("push", pushPayload(REPO, "refs/heads/main"));
        await relay.deliver("workflow_job", { repository: { full_name: REPO }, workflow_job: "nonsense" });

        expect(socket.count).toBe(before);
        expect(github.repositoryReads).toBe(1);
      });

      it("sends nothing to a socket that is no longer open", async () => {
        await relay.open();
        const open = new FakeSocket();
        const closing = new FakeSocket();
        await feed.serve(open);
        await feed.serve(closing);
        const sent = closing.count;
        closing.readyState = 3;

        await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));

        expect(closing.count).toBe(sent);
        expect(open.news.map((news) => news.id)).toEqual([11]);
      });

      it("closes and drops a socket with more than 64 MiB waiting, and sends it nothing", async () => {
        await relay.open();
        const full = new FakeSocket();
        const behind = new FakeSocket();
        await feed.serve(full);
        await feed.serve(behind);
        const sent = full.count;
        full.bufferedAmount = MOST_BUFFERED + 1;
        behind.bufferedAmount = MOST_BUFFERED;

        await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));
        full.bufferedAmount = 0;
        await relay.deliver("workflow_job", jobPayload(apiJob(12, 1)));

        expect(full.closes).toBe(1);
        expect(full.count).toBe(sent);
        expect(behind.closes).toBe(0);
        expect(behind.news.map((news) => news.id)).toEqual([11, 12]);
      });

      it("reads the jobs again for a delivery on a new relay connection once `REREAD_MS` has passed since the last read was tried, and not before", async () => {
        using time = new FakeTime(NOW);
        await relay.open();
        const socket = new FakeSocket();
        await feed.serve(socket);
        github.runs.set(REPO, [apiRun(1)]);
        github.jobsOf.set(1, [apiJob(11, 1)]);
        await relay.end();

        time.tick(REREAD_MS - 1);
        await relay.deliver("workflow_run", deliveredRun(2, 7));
        expect(github.repositoryReads).toBe(1);

        time.tick(1);
        const read = socket.nextSnapshot();
        await relay.deliver("workflow_run", deliveredRun(3, 7));
        expect(jobIds(await read)).toEqual([11]);
        expect(github.repositoryReads).toBe(2);
      });

      it("takes in nothing, and reads nothing, for a delivery heard while no page is open", async () => {
        await relay.open();
        await relay.end();

        await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));

        expect(github.repositoryReads).toBe(0);
        expect(heldJobs()).toEqual([]);
      });

      it("reads the jobs again for a delivery once the last read that succeeded started `RELAY_VOUCH_MS` ago, and not before", async () => {
        using time = new FakeTime(NOW);
        await relay.open();
        const socket = new FakeSocket();
        await feed.serve(socket);

        time.tick(RELAY_VOUCH_MS - 1);
        await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));
        expect(github.repositoryReads).toBe(1);

        time.tick(1);
        const read = socket.nextSnapshot();
        await relay.deliver("workflow_job", jobPayload(apiJob(12, 1)));
        await read;
        expect(github.repositoryReads).toBe(2);
      });

      it("logs a read started by a delivery that fails", async () => {
        using time = new FakeTime(NOW);
        const logged = Promise.withResolvers<void>();
        using error = stub(console, "error", () => logged.resolve());
        await relay.open();
        const socket = new FakeSocket();
        await feed.serve(socket);
        await relay.end();
        time.tick(REREAD_MS);
        socket.snapshotFailure = new Error("the page went away");

        await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));
        await logged.promise;

        expect(error.calls.map((call) => call.args)).toEqual([[
          "runners page: reading the jobs under way failed:",
          "the page went away",
        ]]);
      });

      describe("a new relay connection heard while a page is open", () => {
        // The jobs are read under one connection, the connection ends, and,
        // once a read may be tried again, on the next connection job 11 is
        // delivered, which starts a read that GitHub answers with no runs,
        // and job 12 is delivered during that read.

        /** Runs that sequence for `socket`, and resolves once every read is done. */
        async function deliverAcrossReconnection(socket: FakeSocket, time: FakeTime): Promise<void> {
          await relay.open();
          await feed.serve(socket);
          await relay.end();
          time.tick(REREAD_MS);
          github.holdRepositories = Promise.withResolvers();
          const hold = github.holdRepositories;
          const read = socket.nextSnapshot();
          await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));
          await relay.deliver("workflow_job", jobPayload(apiJob(12, 1)));
          hold.resolve();
          await read;
          // A page opening under the connection the jobs were read under
          // waits for any read still under way.
          await feed.serve(new FakeSocket());
        }

        it("reads the jobs once more, however many deliveries arrive during that read", async () => {
          using time = new FakeTime(NOW);
          await deliverAcrossReconnection(new FakeSocket(), time);

          expect(github.repositoryReads).toBe(2);
        });

        it("keeps the jobs delivered on it that GitHub's API does not list", async () => {
          using time = new FakeTime(NOW);
          const socket = new FakeSocket();
          await deliverAcrossReconnection(socket, time);

          expect(heldJobs()).toEqual([11, 12]);
          expect(jobIds(socket.snapshots.at(-1))).toEqual([11, 12]);
        });
      });

      describe("the relay heard again after pages were told it was silent", () => {
        const recovered = { type: "runners", runners: [], larger: [], problems: [] };

        it("sends every page the problems without the relay's silence once, for a `ping`", async () => {
          const socket = new FakeSocket();
          await feed.serve(socket);
          expect(socket.runnerUpdates.at(-1)?.problems).toEqual([SILENT]);
          const updates = socket.runnerUpdates.length;

          await relay.open();
          await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));
          await relay.deliver("ping", {});

          expect(socket.runnerUpdates.slice(updates)).toEqual([recovered]);
        });

        it("sends every page the problems without the relay's silence for a `push`", async () => {
          const socket = new FakeSocket();
          await feed.serve(socket);
          const updates = socket.runnerUpdates.length;

          await relay.webhooks.connect();
          await relay.deliver("push", pushPayload(REPO, "refs/heads/main"));

          expect(socket.runnerUpdates.slice(updates)).toEqual([recovered]);
        });

        it("sends no problems for a delivery when pages were not told the relay was silent", async () => {
          await relay.open();
          const socket = new FakeSocket();
          await feed.serve(socket);
          const updates = socket.runnerUpdates.length;

          await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));
          await relay.deliver("ping", {});

          expect(socket.runnerUpdates.length).toBe(updates);
        });
      });
    });

    describe("instance members", () => {
      describe("key", () => {
        it("is a different string for each feed", () => {
          const other = new RunnersFeed(github, relay.webhooks, VERSION);

          expect(feed.key.length).toBeGreaterThan(0);
          expect(other.key).not.toBe(feed.key);
        });
      });

      describe("open()", () => {
        it("returns a 403 for a request without the key", async () => {
          const response = feed.open(new Request("http://localhost/runners/socket"));

          expect(response.status).toBe(403);
          expect(await response.text()).toBe("The runners socket needs the page's key.");
        });

        it("returns a 400 for a request with the key that is not a WebSocket upgrade", async () => {
          const response = feed.open(new Request(`http://localhost/runners/socket?key=${encodeURIComponent(feed.key)}`));

          expect(response.status).toBe(400);
          expect(await response.text()).toMatch(/^Not a WebSocket request: /);
        });

        it("returns a 503 once 64 pages are open, and not before", async () => {
          await relay.open();
          const request = () => new Request(`http://localhost/runners/socket?key=${encodeURIComponent(feed.key)}`);
          for (let i = 0; i < 63; i++) await feed.serve(new FakeSocket());
          const below = feed.open(request());
          expect(below.status).toBe(400);
          await below.body?.cancel();

          await feed.serve(new FakeSocket());
          const full = feed.open(request());
          expect(full.status).toBe(503);
          expect(await full.text()).toBe("The runners page is open in too many places.");
        });

        it("returns a 403 for a request with another feed's key", async () => {
          const other = new RunnersFeed(github, relay.webhooks, VERSION);
          const response = feed.open(
            new Request(`http://localhost/runners/socket?key=${encodeURIComponent(other.key)}`, {
              headers: { upgrade: "websocket" },
            }),
          );

          expect(response.status).toBe(403);
          await response.body?.cancel();
        });
      });

      describe("serve()", () => {
        it("sends the socket a snapshot of what is held, with the server's version, before anything is read", () => {
          github.holdRepositories = Promise.withResolvers();
          github.holdRunners = Promise.withResolvers();
          const socket = new FakeSocket();

          void feed.serve(socket);

          expect(socket.snapshots).toEqual([{
            type: "snapshot",
            version: VERSION,
            tracker: { jobs: [], runs: [], pullRequests: [], outcomes: [] },
            runners: [],
            larger: [],
            problems: [SILENT],
          }]);
        });

        it("reads the jobs under way and the runners, and sends every page what it read", async () => {
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1), apiJob(12, 1, { status: "in_progress" })]);
          const runner: Runner = { owner: "example", name: "mac-1", labels: ["mac"], online: true };
          const larger: LargerRunner = { owner: "example", name: "big", maximum: 4, cores: 8, memory: 32 };
          github.runnerList = [runner];
          github.largerList = [larger];
          const socket = new FakeSocket();

          await feed.serve(socket);

          expect(jobIds(socket.snapshots.at(-1))).toEqual([11, 12]);
          expect(socket.runnerUpdates).toEqual([{
            type: "runners",
            runners: [runner],
            larger: [larger],
            problems: [SILENT],
          }]);
        });

        it("reads the jobs again for a page while the relay is not heard once `REREAD_MS` has passed since the last read was tried, and not before", async () => {
          using time = new FakeTime(NOW);
          await feed.serve(new FakeSocket());

          time.tick(REREAD_MS - 1);
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(1);

          time.tick(1);
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(2);
        });

        it("reads the jobs once for the pages that open under one relay connection", async () => {
          await relay.open();
          await feed.serve(new FakeSocket());
          await feed.serve(new FakeSocket());

          expect(github.repositoryReads).toBe(1);
        });

        it("reads the jobs again for a page that opens `RELAY_VOUCH_MS` after the last read started, and not before", async () => {
          using time = new FakeTime(NOW);
          await relay.open();
          await feed.serve(new FakeSocket());

          time.tick(RELAY_VOUCH_MS - 1);
          await relay.deliver("ping", {});
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(1);

          time.tick(1);
          await relay.deliver("ping", {});
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(2);
        });

        it("reads the jobs again for a page after a read some of which failed, once it may, and after one that succeeded, not", async () => {
          using time = new FakeTime(NOW);
          await relay.open();
          github.failingRepos.set(REPO, new Error("HTTP 502"));
          await feed.serve(new FakeSocket());

          time.tick(REREAD_MS);
          await relay.deliver("ping", {});
          github.failingRepos.clear();
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(2);

          time.tick(REREAD_MS);
          await relay.deliver("ping", {});
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(2);
        });

        it("lists the relay's silence as a problem until the relay is heard", async () => {
          const before = new FakeSocket();
          await feed.serve(before);
          await relay.open();
          const after = new FakeSocket();
          await feed.serve(after);

          expect(before.snapshots[0].problems).toEqual([SILENT]);
          expect(after.snapshots[0].problems).toEqual([]);
        });

        it("reads the jobs once for pages opening during a read under the relay connection still heard", async () => {
          await relay.open();
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);
          github.holdRepositories = Promise.withResolvers();
          const hold = github.holdRepositories;
          const first = new FakeSocket();
          const second = new FakeSocket();
          const serving = [feed.serve(first), feed.serve(second)];
          hold.resolve();
          await Promise.all(serving);

          expect(github.repositoryReads).toBe(1);
          expect(jobIds(second.snapshots.at(-1))).toEqual([11]);
        });

        it("reads the runners once for pages opening while they are read", async () => {
          github.holdRunners = Promise.withResolvers();
          const hold = github.holdRunners;
          const first = feed.serve(new FakeSocket());
          const second = feed.serve(new FakeSocket());
          hold.resolve();
          await Promise.all([first, second]);

          expect(github.runnerReads).toBe(1);
        });

        it("reuses a read of the runners for thirty seconds", async () => {
          using time = new FakeTime(NOW);
          github.runnerList = [{ owner: "example", name: "mac-1", labels: [], online: true }];
          await feed.serve(new FakeSocket());

          time.tick(29_999);
          const reused = new FakeSocket();
          await feed.serve(reused);
          expect(github.runnerReads).toBe(1);
          expect(reused.snapshots[0].runners).toEqual(github.runnerList);
          expect(reused.runnerUpdates).toEqual([]);

          time.tick(1);
          await feed.serve(new FakeSocket());
          expect(github.runnerReads).toBe(2);
        });

        it("lists a failure to read the runners as a problem, and keeps what else it read", async () => {
          await relay.open();
          github.failRunners = new Error("HTTP 502");
          const larger: LargerRunner = { owner: "example", name: "big", maximum: 4, cores: 8, memory: 32 };
          github.largerList = [larger];
          const socket = new FakeSocket();

          await feed.serve(socket);

          expect(socket.runnerUpdates).toEqual([{
            type: "runners",
            runners: [],
            larger: [larger],
            problems: ["The organization's runners could not be read: HTTP 502"],
          }]);
          expect(socket.snapshots.at(-1)?.problems).toEqual([
            "The organization's runners could not be read: HTTP 502",
          ]);
        });

        it("keeps the runners it last read when they cannot be read again", async () => {
          using time = new FakeTime(NOW);
          await relay.open();
          const runner: Runner = { owner: "example", name: "mac-1", labels: [], online: true };
          github.runnerList = [runner];
          await feed.serve(new FakeSocket());

          time.tick(30_000);
          await relay.deliver("ping", {});
          github.failRunners = new Error("HTTP 502");
          github.runnerList = [];
          const socket = new FakeSocket();
          await feed.serve(socket);

          expect(socket.runnerUpdates).toEqual([{
            type: "runners",
            runners: [runner],
            larger: [],
            problems: ["The organization's runners could not be read: HTTP 502"],
          }]);
        });
      });

      describe("hear()", () => {
        // Each case lets the jobs and runners read when the page opened go
        // out of date, so that whether the page is taken for seen shows in
        // whether a tick reads them again.

        it("takes a page's `visible` message for whether a reader can see it, and ignores anything else", async () => {
          using time = new FakeTime(NOW);
          const socket = await openPage();
          time.tick(REREAD_MS);

          feed.hear(socket, JSON.stringify({ type: "visible", visible: false }));
          await feed.tick();
          for (
            const data of [
              "not JSON",
              JSON.stringify({ type: "visible", visible: "yes" }),
              JSON.stringify({ type: "shown", visible: true }),
              JSON.stringify([{ type: "visible", visible: true }]),
              new TextEncoder().encode(JSON.stringify({ type: "visible", visible: true })),
            ]
          ) {
            feed.hear(socket, data);
          }
          await feed.tick();
          expect(socket.pings).toBe(2);
          expect([github.repositoryReads, github.runnerReads]).toEqual([1, 1]);

          const read = socket.nextSnapshot();
          feed.hear(socket, JSON.stringify({ type: "visible", visible: true }));
          await read;
          expect([github.repositoryReads, github.runnerReads]).toEqual([2, 2]);
        });
      });

      describe("see()", () => {
        it("reads what is not current when a page becomes visible while none other is", async () => {
          using time = new FakeTime(NOW);
          const socket = await openPage();
          feed.see(socket, false);
          time.tick(REREAD_MS);

          const read = socket.nextSnapshot();
          feed.see(socket, true);
          await read;

          expect([github.repositoryReads, github.runnerReads]).toEqual([2, 2]);
        });

        it("reads nothing current when a page becomes visible: runners read within thirty seconds, jobs the relay vouches for", async () => {
          using time = new FakeTime(NOW);
          const socket = await openPage();
          feed.see(socket, false);
          time.tick(29_999);
          await relay.deliver("ping", {});

          feed.see(socket, true);
          await feed.tick();

          expect([github.repositoryReads, github.runnerReads]).toEqual([1, 1]);
        });

        it("reads nothing when a page becomes visible while another is", async () => {
          using time = new FakeTime(NOW);
          const shown = await openPage();
          const other = new FakeSocket();
          await feed.serve(other);
          feed.see(other, false);
          time.tick(REREAD_MS);

          feed.see(other, true);

          expect([github.repositoryReads, github.runnerReads]).toEqual([1, 1]);
          expect(shown.runnerUpdates.length).toBe(1);
        });

        it("ignores a socket that is not open", async () => {
          using time = new FakeTime(NOW);
          const socket = await openPage();
          time.tick(REREAD_MS);

          feed.see(new FakeSocket(), false);

          await feed.tick();
          expect(socket.pings).toBe(1);
          expect([github.repositoryReads, github.runnerReads]).toEqual([2, 2]);
        });

        it("logs a read for a page shown again that fails", async () => {
          using time = new FakeTime(NOW);
          const logged = Promise.withResolvers<void>();
          using error = stub(console, "error", () => logged.resolve());
          const socket = await openPage();
          feed.see(socket, false);
          time.tick(REREAD_MS);
          socket.snapshotFailure = new Error("the page went away");

          feed.see(socket, true);
          await logged.promise;

          expect(error.calls.map((call) => call.args)).toEqual([[
            "runners page: catching up for a page shown again failed:",
            "the page went away",
          ]]);
        });
      });

      describe("while no open page is visible", () => {
        it("sends a page served again its snapshot, and reads nothing for it", async () => {
          using time = new FakeTime(NOW);
          const socket = await openPage();
          feed.see(socket, false);
          time.tick(REREAD_MS);
          const snapshots = socket.snapshots.length;

          await feed.serve(socket);

          expect(socket.snapshots.length).toBe(snapshots + 1);
          expect([github.repositoryReads, github.runnerReads]).toEqual([1, 1]);
        });

        it("still pings and tells of the relay's silence on a tick, and reads nothing", async () => {
          using time = new FakeTime(NOW);
          const socket = await openPage();
          feed.see(socket, false);
          const updates = socket.runnerUpdates.length;
          time.tick(REREAD_MS);

          await feed.tick();

          expect(socket.pings).toBe(1);
          expect(socket.runnerUpdates.slice(updates).map((update) => update.problems)).toEqual([[SILENT]]);
          expect([github.repositoryReads, github.runnerReads]).toEqual([1, 1]);
        });

        it("takes in and forwards deliveries, and reads nothing for them", async () => {
          using time = new FakeTime(NOW);
          const socket = await openPage();
          feed.see(socket, false);
          await relay.end();
          time.tick(REREAD_MS);

          await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));

          expect(socket.news.map((news) => news.id)).toEqual([11]);
          expect(heldJobs()).toEqual([11]);
          expect(github.repositoryReads).toBe(1);
        });
      });

      describe("forget()", () => {
        it("stops sending to the socket, and keeps the jobs and takes in deliveries while another page is open", async () => {
          const gone = await openPage();
          const open = new FakeSocket();
          await feed.serve(open);
          const sent = gone.count;

          feed.forget(gone);
          await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));

          expect(gone.count).toBe(sent);
          expect(open.news.map((news) => news.id)).toEqual([11]);
          expect(heldJobs()).toEqual([11]);
        });

        it("forgets whether the page was visible, so that a visible page left open is read for", async () => {
          using time = new FakeTime(NOW);
          const hidden = await openPage();
          const shown = new FakeSocket();
          await feed.serve(shown);
          feed.see(hidden, false);

          feed.forget(hidden);
          time.tick(REREAD_MS);
          await feed.tick();

          expect([github.repositoryReads, github.runnerReads]).toEqual([2, 2]);
        });

        it("is how a hidden page with more than 64 MiB waiting is dropped, so that a visible page left open is read for", async () => {
          using time = new FakeTime(NOW);
          const hidden = await openPage();
          const shown = new FakeSocket();
          await feed.serve(shown);
          feed.see(hidden, false);
          hidden.bufferedAmount = MOST_BUFFERED + 1;

          await relay.deliver("workflow_job", jobPayload(apiJob(11, 1)));
          expect(hidden.closes).toBe(1);
          time.tick(REREAD_MS);
          await feed.tick();

          expect(shown.pings).toBe(1);
          expect(hidden.pings).toBe(0);
          expect([github.repositoryReads, github.runnerReads]).toEqual([2, 2]);
        });

        it("forgets the jobs once no page is open, takes in no deliveries, and has the next page read at once", async () => {
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);
          const socket = await openPage();
          expect(heldJobs()).toEqual([11]);

          feed.forget(socket);
          expect(heldJobs()).toEqual([]);
          await relay.deliver("workflow_job", jobPayload(apiJob(12, 1)));
          expect(heldJobs()).toEqual([]);
          expect(github.repositoryReads).toBe(1);

          const next = new FakeSocket();
          await feed.serve(next);
          expect(jobIds(next.snapshots[0])).toEqual([]);
          expect(github.repositoryReads).toBe(2);
          expect(heldJobs()).toEqual([11]);
        });
      });

      describe("a read still under way when the last page closes", () => {
        it("is discarded, and the next page to open reads afresh", async () => {
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);
          await relay.open();
          github.holdRepositories = Promise.withResolvers();
          const hold = github.holdRepositories;
          const first = new FakeSocket();
          const stale = feed.serve(first);
          feed.forget(first);
          hold.resolve();
          await stale;
          expect(heldJobs()).toEqual([]);

          github.jobsOf.set(1, [apiJob(12, 1)]);
          const next = new FakeSocket();
          await feed.serve(next);

          expect(github.repositoryReads).toBe(2);
          expect(jobIds(next.snapshots.at(-1))).toEqual([12]);
        });

        it("does not hold back a page that opens while it is still held, which reads and shows its own", async () => {
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(12, 1)]);
          await relay.open();
          github.holdRepositories = Promise.withResolvers();
          const hold = github.holdRepositories;
          const first = new FakeSocket();
          const stale = feed.serve(first);
          feed.forget(first);

          const next = new FakeSocket();
          await feed.serve(next);
          expect(github.repositoryReads).toBe(2);
          expect(jobIds(next.snapshots.at(-1))).toEqual([12]);
          const snapshots = next.snapshots.length;

          github.jobsOf.set(1, [apiJob(13, 1)]);
          hold.resolve();
          await stale;
          expect(heldJobs()).toEqual([12]);
          expect(next.snapshots.length).toBe(snapshots);
        });

        it("is discarded when it fails, telling no page its problem", async () => {
          await relay.open();
          github.holdRepositories = Promise.withResolvers();
          const hold = github.holdRepositories;
          github.failRepositories = new Error("HTTP 500");
          const first = new FakeSocket();
          const stale = feed.serve(first);
          feed.forget(first);
          hold.resolve();
          await stale;

          github.failRepositories = undefined;
          const next = new FakeSocket();
          await feed.serve(next);

          expect(next.snapshots[0].problems).toEqual([]);
          expect(next.runnerUpdates.flatMap((update) => update.problems)).toEqual([]);
          expect(github.repositoryReads).toBe(2);
        });
      });

      describe("tick()", () => {
        it("does nothing while no page is open", async () => {
          await feed.tick();

          expect(github.repositoryReads).toBe(0);
          expect(github.runnerReads).toBe(0);
        });

        it("sends every open page a ping", async () => {
          await relay.open();
          const socket = new FakeSocket();
          await feed.serve(socket);

          await feed.tick();

          expect(socket.pings).toBe(1);
        });

        it("tells every page once when the relay falls silent, and nothing before", async () => {
          using time = new FakeTime(NOW);
          await relay.open();
          const socket = new FakeSocket();
          await feed.serve(socket);
          const updates = socket.runnerUpdates.length;

          time.tick(RELAY_QUIET_MS - 1);
          await feed.tick();
          expect(socket.runnerUpdates.length).toBe(updates);

          time.tick(1);
          await feed.tick();
          await feed.tick();
          expect(socket.runnerUpdates.slice(updates).map((update) => update.problems)).toEqual([[SILENT]]);
        });

        it("tells the pages already open that the relay fell silent, though a page opening since was shown it", async () => {
          using time = new FakeTime(NOW);
          const open = await openPage();
          const updates = open.runnerUpdates.length;
          time.tick(RELAY_QUIET_MS);
          github.holdRunners = Promise.withResolvers();
          const hold = github.holdRunners;
          const later = new FakeSocket();
          const serving = feed.serve(later);
          expect(later.snapshots[0].problems).toEqual([SILENT]);

          const ticking = feed.tick();
          expect(open.runnerUpdates.slice(updates).map((update) => update.problems)).toEqual([[SILENT]]);
          hold.resolve();
          await Promise.all([serving, ticking]);
        });

        it("reads the runners again once `REREAD_MS` has passed since they were read, and not before", async () => {
          using time = new FakeTime(NOW);
          await relay.open();
          await feed.serve(new FakeSocket());

          time.tick(REREAD_MS - 1);
          await feed.tick();
          expect(github.runnerReads).toBe(1);

          time.tick(1);
          await feed.tick();
          expect(github.runnerReads).toBe(2);
        });

        it("reads the jobs again once the relay no longer vouches for them and `REREAD_MS` has passed, and not while it does", async () => {
          using time = new FakeTime(NOW);
          await relay.open();
          await feed.serve(new FakeSocket());

          time.tick(REREAD_MS);
          await relay.deliver("ping", {});
          await feed.tick();
          expect(github.repositoryReads).toBe(1);

          time.tick(RELAY_QUIET_MS);
          await feed.tick();
          expect(github.repositoryReads).toBe(2);
        });
      });

      describe("prime()", () => {
        it("replaces the jobs held with those GitHub's API lists, and sends every page a snapshot", async () => {
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);
          const socket = await openPage();
          await relay.deliver("workflow_job", jobPayload(apiJob(10, 9)));
          const snapshotsBefore = socket.snapshots.length;

          github.jobsOf.set(1, [apiJob(12, 1)]);
          await feed.prime();

          expect(heldJobs()).toEqual([12]);
          expect(socket.snapshots.length).toBe(snapshotsBefore + 1);
          expect(jobIds(socket.snapshots.at(-1))).toEqual([12]);
        });

        it("takes in again what the relay delivered during the read, after what the read said", async () => {
          await openPage();
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1), apiJob(12, 1)]);
          github.holdRepositories = Promise.withResolvers();
          const hold = github.holdRepositories;
          const priming = feed.prime();

          await relay.deliver(
            "workflow_job",
            jobPayload(apiJob(11, 1, { status: "completed", conclusion: "success" })),
          );
          await relay.deliver("workflow_job", jobPayload(apiJob(13, 1)));
          hold.resolve();
          await priming;

          expect(heldJobs()).toEqual([12, 13]);
          expect(feed.accessForTestingOnly.tracker.outcome(11)).toBe("passed");
        });

        it("returns the read in flight when asked during one, and reads nothing more for it", async () => {
          github.holdRepositories = Promise.withResolvers();
          const hold = github.holdRepositories;
          const first = feed.prime();
          const second = feed.prime();

          expect(second).toBe(first);
          hold.resolve();
          await first;
          expect(github.repositoryReads).toBe(1);

          await feed.prime();
          expect(github.repositoryReads).toBe(2);
        });

        it("looks deep for runs long under way until a read under the relay connection heard succeeds", async () => {
          using time = new FakeTime(NOW);
          await feed.prime();
          await relay.open();
          github.failingRepos.set(REPO, new Error("HTTP 502"));
          await feed.prime();
          github.failingRepos.clear();
          await feed.prime();
          await feed.prime();
          expect(github.deep).toEqual([true, true, true, false]);

          time.tick(RELAY_VOUCH_MS);
          await relay.deliver("ping", {});
          await feed.prime();
          await relay.end();
          await relay.deliver("ping", {});
          await feed.prime();
          expect(github.deep.slice(4)).toEqual([false, true]);
        });

        it("drops the jobs held of a repository GitHub no longer shows, listing no problem, and counts the read current", async () => {
          const other = "example/gone";
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);
          const socket = await openPage();
          await relay.deliver("workflow_job", jobPayload(apiJob(30, 3), other));
          github.failingRepos.set(other, new GitHubStatusError(`GitHub API repos/${other} failed: HTTP 404`, 404));

          await feed.prime();
          await feed.serve(new FakeSocket());

          expect(heldJobs()).toEqual([11]);
          expect(socket.snapshots.at(-1)?.problems).toEqual([]);
          expect(github.repositoryReads).toBe(2);
        });

        it("keeps the jobs held of a repository the dashboard may not read, lists the problem, and counts the read current", async () => {
          using time = new FakeTime(NOW);
          const other = "example/hidden";
          const message = `GitHub API repos/${other} failed: HTTP 403`;
          github.repos = [other, REPO];
          const socket = await openPage();
          await relay.deliver("workflow_job", jobPayload(apiJob(30, 3), other));
          // A new connection, so that what was read before is no longer
          // vouched for, and only this read could count as current.
          await relay.end();
          await relay.deliver("ping", {});
          github.failingRepos.set(other, new GitHubStatusError(message, 403));

          await feed.prime();
          expect(heldJobs()).toEqual([30]);
          expect(github.runReads).toEqual([]);
          expect(socket.snapshots.at(-1)?.problems).toEqual([`${other}: ${message}`]);

          time.tick(REREAD_MS);
          await relay.deliver("ping", {});
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(2);
        });

        it("counts a read not current when a run held cannot be read again by id, or a run's jobs cannot be read", async () => {
          for (const fail of ["run", "jobs"]) {
            using time = new FakeTime(NOW);
            github = new FakeGitHub();
            relay = new FakeRelay();
            feed = new RunnersFeed(github, relay.webhooks, VERSION);
            await openPage();
            await relay.deliver("workflow_job", jobPayload(apiJob(30, 3)));
            await relay.end();
            await relay.deliver("ping", {});
            if (fail === "run") github.failingRunReads.set(3, new Error("HTTP 502"));
            else {
              github.runs.set(REPO, [apiRun(3)]);
              github.failingJobs.set(3, new Error("HTTP 502"));
            }

            await feed.prime();
            expect(heldJobs()).toEqual([30]);

            time.tick(REREAD_MS);
            await relay.deliver("ping", {});
            await feed.serve(new FakeSocket());
            expect(github.repositoryReads).toBe(3);
          }
        });

        it("keeps the jobs held of a repository whose runs GitHub refuses for its rate limit, lists the problem, and counts the read not current", async () => {
          for (const status of [403, 429]) {
            using time = new FakeTime(NOW);
            github = new FakeGitHub();
            relay = new FakeRelay();
            feed = new RunnersFeed(github, relay.webhooks, VERSION);
            const other = "example/busy";
            const message = `GitHub API repos/${other} failed: HTTP ${status} (rate-limited)`;
            github.repos = [other, REPO];
            const socket = await openPage();
            await relay.deliver("workflow_job", jobPayload(apiJob(30, 3), other));
            // A new connection, so that what was read before is no longer
            // vouched for, and only this read could count as current.
            await relay.end();
            await relay.deliver("ping", {});
            github.failingRepos.set(other, new GitHubStatusError(message, status, true));

            await feed.prime();
            expect(heldJobs()).toEqual([30]);
            expect(github.runReads).toEqual([]);
            expect(socket.snapshots.at(-1)?.problems).toEqual([`${other}: ${message}`]);

            time.tick(REREAD_MS);
            await relay.deliver("ping", {});
            await feed.serve(new FakeSocket());
            expect(github.repositoryReads).toBe(3);
          }
        });

        it("skips runs and jobs that do not have GitHub's shape", async () => {
          github.runs.set(REPO, ["nonsense", { id: "1" }, apiRun(1)]);
          github.jobsOf.set(1, [{ id: 11 }, apiJob(12, 1)]);

          await feed.prime();

          expect(heldJobs()).toEqual([12]);
        });

        it("reads the runs of the repositories of the jobs held as well as those listed, two at a time", async () => {
          const others = ["example/a", "example/b", "example/c"];
          await openPage();
          for (const [index, repo] of others.entries()) {
            await relay.deliver("workflow_job", jobPayload(apiJob(20 + index, 20 + index), repo));
            github.runs.set(repo, [apiRun(20 + index)]);
          }
          github.jobsOf.set(20, [apiJob(20, 20)]);
          github.runsRead = [];

          await feed.prime();

          expect(github.runsRead.sort()).toEqual([...others, REPO].sort());
          expect(github.mostReadingRuns).toBe(2);
          expect(heldJobs()).toEqual([20]);
          expect(github.runReads).toEqual([]);
        });

        it("reads again by id each run held that no list names, keeping its jobs while it is not completed", async () => {
          const socket = await openPage();
          for (const run of [5, 6, 7]) await relay.deliver("workflow_job", jobPayload(apiJob(run * 10, run)));
          github.runsById.set(5, apiRun(5));
          github.runsById.set(6, apiRun(6, { status: "completed", conclusion: "success" }));
          github.jobsOf.set(5, [apiJob(50, 5, { status: "in_progress" })]);
          github.jobsOf.set(6, [apiJob(60, 6)]);

          await feed.prime();

          expect(github.runReads.sort()).toEqual([`${REPO}#5`, `${REPO}#6`, `${REPO}#7`]);
          expect(heldJobs()).toEqual([50]);
          expect(socket.snapshots.at(-1)?.problems).toEqual([]);
        });

        it("ends the jobs of a run held that is found completed by id as it ended, and sends every page the news", async () => {
          const socket = await openPage();
          for (const run of [5, 6, 7, 8]) await relay.deliver("workflow_job", jobPayload(apiJob(run * 10, run)));
          github.runsById.set(5, apiRun(5));
          github.runsById.set(6, apiRun(6, { status: "completed", conclusion: "success" }));
          github.runsById.set(7, apiRun(7, { status: "completed", conclusion: "failure" }));
          github.jobsOf.set(5, [apiJob(50, 5)]);

          await feed.prime();

          const tracker = feed.accessForTestingOnly.tracker;
          expect(tracker.outcome(60)).toBe("passed");
          expect(tracker.outcome(70)).toBe("neither");
          expect(tracker.outcome(50)).toBeUndefined();
          expect(tracker.outcome(80)).toBeUndefined();
          expect(heldJobs()).toEqual([50]);
          expect(socket.news.filter((news) => news.kind === "run")).toEqual(
            [6, 7].map((run) => runNewsOf(github.runsById.get(run))),
          );
          expect(jobIds(socket.snapshots.at(-1))).toEqual([50]);
        });

        it("keeps the jobs of a run held that cannot be read again by id, and lists the problem", async () => {
          const socket = await openPage();
          await relay.deliver("workflow_job", jobPayload(apiJob(50, 5)));
          await relay.deliver("workflow_job", jobPayload(apiJob(60, 6)));
          github.failingRunReads.set(5, new Error("HTTP 502"));

          await feed.prime();

          expect(heldJobs()).toEqual([50]);
          expect(socket.snapshots.at(-1)?.problems).toEqual([`${REPO}: HTTP 502`]);
        });

        it("lists a repository whose runs cannot be read as a problem, and keeps its jobs held and the others' jobs read", async () => {
          const other = "example/other";
          const socket = await openPage();
          await relay.deliver("workflow_job", jobPayload(apiJob(30, 3), other));
          github.repos = [other, REPO];
          github.failingRepos.set(other, new GitHubStatusError(`GitHub API repos/${other} failed: HTTP 502`, 502));
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);

          await feed.prime();

          expect(jobIds(socket.snapshots.at(-1))).toEqual([30, 11]);
          expect(socket.snapshots.at(-1)?.problems).toEqual([`${other}: GitHub API repos/${other} failed: HTTP 502`]);
          expect(github.runReads).toEqual([]);
        });

        it("lists a run whose jobs cannot be read as a problem, and keeps its jobs held and the other runs' jobs read", async () => {
          const socket = await openPage();
          await relay.deliver("workflow_job", jobPayload(apiJob(21, 2)));
          await relay.deliver("workflow_job", jobPayload(apiJob(31, 3)));
          github.runs.set(REPO, [apiRun(1), apiRun(2), apiRun(3)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);
          github.failingJobs.set(2, new Error("HTTP 500"));

          await feed.prime();

          expect(heldJobs().sort()).toEqual([11, 21]);
          expect(socket.snapshots.at(-1)?.problems).toEqual([`${REPO}: HTTP 500`]);
        });

        it("leaves the jobs as they were when the repositories cannot be read, and sends every page the problem", async () => {
          await relay.open();
          github.runs.set(REPO, [apiRun(1)]);
          github.jobsOf.set(1, [apiJob(11, 1)]);
          const socket = new FakeSocket();
          await feed.serve(socket);
          const snapshots = socket.snapshots.length;
          const updates = socket.runnerUpdates.length;
          github.failRepositories = new Error("HTTP 500");
          github.jobsOf.set(1, [apiJob(12, 1)]);

          await feed.prime();

          expect(heldJobs()).toEqual([11]);
          expect(socket.snapshots.length).toBe(snapshots);
          expect(socket.runnerUpdates.slice(updates)).toEqual([{
            type: "runners",
            runners: [],
            larger: [],
            problems: ["The jobs under way could not be read: HTTP 500"],
          }]);
        });

        it("leaves a read that cannot list the repositories to be tried again by a page opening once it may", async () => {
          using time = new FakeTime(NOW);
          await relay.open();
          github.failRepositories = new Error("HTTP 500");
          await feed.serve(new FakeSocket());

          time.tick(REREAD_MS - 1);
          await relay.deliver("ping", {});
          github.failRepositories = undefined;
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(1);

          time.tick(1);
          await feed.serve(new FakeSocket());
          expect(github.repositoryReads).toBe(2);
        });
      });
    });
  });

  describe("dashboardRunnersGitHub()", () => {
    const org = GITHUB_ORGANIZATION.name;
    const KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_APP_CLIENT_ID", "GH_APP_PRIVATE_KEY"];
    let saved: (readonly [string, string | undefined])[];

    // Each case configures the credential it reads with; whatever the process
    // had is put back afterwards.
    beforeEach(() => {
      saved = KEYS.map((key) => [key, Deno.env.get(key)] as const);
      for (const key of KEYS) Deno.env.delete(key);
    });

    afterEach(() => {
      for (const [key, value] of saved) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    });

    /**
     * Answers each GitHub request with what `answer` returns for its path
     * and query, and keeps those.
     */
    function wire(answer: (path: string) => Response) {
      const requested: string[] = [];
      const fetch = stub(globalThis, "fetch", (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const path = url.pathname + url.search;
        requested.push(path);
        return Promise.resolve(answer(path));
      });
      return { requested, [Symbol.dispose]: () => fetch.restore() };
    }

    it("returns the organization's repositories pushed to in the last week", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      using _wire = wire(() =>
        Response.json([
          { full_name: `${org}/fresh`, default_branch: "main", archived: false, pushed_at: ago(6) },
          { full_name: `${org}/stale`, default_branch: "main", archived: false, pushed_at: ago(8) },
          { full_name: `${org}/empty`, default_branch: "main", archived: false, pushed_at: null },
        ])
      );

      expect(await dashboardRunnersGitHub().repositories()).toEqual([`${org}/fresh`]);
    });

    it("throws for the repositories when the environment configures no credential", async () => {
      await expect(dashboardRunnersGitHub().repositories()).rejects.toThrow(
        "set `GH_TOKEN` or `GITHUB_TOKEN`, or `GH_APP_CLIENT_ID` and `GH_APP_PRIVATE_KEY`",
      );
    });

    it("returns the runs of a repository not completed", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      using requests = wire(() =>
        Response.json({ workflow_runs: [apiRun(1), apiRun(2, { status: "completed" })], total_count: 2 })
      );

      expect(await dashboardRunnersGitHub().runsUnderWay(REPO, true)).toEqual([apiRun(1)]);
      expect(requests.requested).toEqual([`/repos/${REPO}/actions/runs?per_page=100`]);
    });

    it("remembers between reads the runs read again by id and found completed", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      const full = Array.from({ length: 100 }, (_, i) => apiRun(1000 + i, { status: "completed" }));
      using requests = wire((path) => {
        if (path === `/repos/${REPO}/actions/runs?per_page=100`) return Response.json({ workflow_runs: full });
        if (path.includes("status=queued")) {
          return Response.json({ workflow_runs: [apiRun(50, { status: "queued", updated_at: "2026-11-24T00:00:00Z" })] });
        }
        if (path === `/repos/${REPO}/actions/runs/50`) return Response.json(apiRun(50, { status: "completed" }));
        return Response.json({ workflow_runs: [] });
      });
      const github = dashboardRunnersGitHub();
      const rereads = () => requests.requested.filter((path) => path === `/repos/${REPO}/actions/runs/50`).length;

      expect(await github.runsUnderWay(REPO, true)).toEqual([]);
      expect(rereads()).toBe(1);
      expect(await github.runsUnderWay(REPO, true)).toEqual([]);
      expect(rereads()).toBe(1);
      await dashboardRunnersGitHub().runsUnderWay(REPO, true);
      expect(rereads()).toBe(2);
      const before = requests.requested.length;
      await github.runsUnderWay(REPO, false);
      expect(requests.requested.slice(before)).toEqual([`/repos/${REPO}/actions/runs?per_page=100`]);
    });

    it("returns a run read by its id, `undefined` for one deleted, and throws for another failure", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      using _wire = wire((path) =>
        path.endsWith("/5")
          ? Response.json(apiRun(5))
          : path.endsWith("/6")
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json({ message: "Bad Gateway" }, { status: 502 })
      );
      const github = dashboardRunnersGitHub();

      expect(await github.run(REPO, 5)).toEqual(apiRun(5));
      expect(await github.run(REPO, 6)).toBeUndefined();
      await expect(github.run(REPO, 7)).rejects.toThrow("HTTP 502");
    });

    it("makes a read asked again conditional on the last answer, and returns the same from a 304", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      const asked: (string | null)[] = [];
      using _fetch = stub(globalThis, "fetch", (_input, init) => {
        const etag = new Headers(init?.headers).get("if-none-match");
        asked.push(etag);
        return Promise.resolve(
          etag === null
            ? Response.json({ runners: [{ name: "mac-1", status: "online", labels: [] }] }, { headers: { etag: '"r"' } })
            : new Response(null, { status: 304 }),
        );
      });
      const github = dashboardRunnersGitHub();

      const first = await github.runners();
      const again = await github.runners();
      await dashboardRunnersGitHub().runners();

      expect(again).toEqual(first);
      expect(first).toEqual([{ owner: org, name: "mac-1", labels: [], online: true }]);
      expect(asked).toEqual([null, '"r"', null]);
    });

    it("returns every page of the jobs of a run's latest attempt", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      const second = `/repos/${REPO}/actions/runs/1/jobs?filter=latest&per_page=100&page=2`;
      using requests = wire((path) =>
        path === second ? Response.json({ jobs: [apiJob(12, 1)] }) : Response.json(
          { jobs: [apiJob(11, 1)] },
          { headers: { link: `<https://api.github.com${second}>; rel="next"` } },
        )
      );

      expect(await dashboardRunnersGitHub().jobs(REPO, 1)).toEqual([apiJob(11, 1), apiJob(12, 1)]);
      expect(requests.requested).toEqual([
        `/repos/${REPO}/actions/runs/1/jobs?filter=latest&per_page=100`,
        second,
      ]);
    });

    it("throws for a page that does not hold the list asked for", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      using _wire = wire((path) => path.includes("/jobs") ? Response.json({ total_count: 0 }) : Response.json([]));

      await expect(dashboardRunnersGitHub().jobs(REPO, 1)).rejects.toThrow(
        `GitHub API repos/${REPO}/actions/runs/1/jobs?filter=latest&per_page=100 returned invalid data`,
      );
      await expect(dashboardRunnersGitHub().runners()).rejects.toThrow(
        `GitHub API orgs/${GITHUB_ORGANIZATION.name}/actions/runners?per_page=100 returned invalid data`,
      );
    });

    it("returns the organization's self-hosted runners, with their labels and whether each is online", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      using requests = wire(() =>
        Response.json({
          runners: [
            {
              name: "mac-1",
              status: "online",
              labels: [{ name: "self-hosted" }, { id: 3 }, { name: "mac" }, { name: 7 }, "odd"],
            },
            { name: "mac-2", status: "offline", labels: "none" },
            "nonsense",
            { status: "online", labels: [] },
          ],
        })
      );

      expect(await dashboardRunnersGitHub().runners()).toEqual([
        { owner: org, name: "mac-1", labels: ["self-hosted", "mac"], online: true },
        { owner: org, name: "mac-2", labels: [], online: false },
      ]);
      expect(requests.requested).toEqual([`/orgs/${org}/actions/runners?per_page=100`]);
    });

    it("returns the organization's larger runners, with their size where GitHub says", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      const groups = `/orgs/${org}/actions/runner-groups?per_page=100`;
      const group = (id: number) => `/orgs/${org}/actions/runner-groups/${id}/hosted-runners?per_page=100`;
      using requests = wire((path) =>
        path === groups
          ? Response.json({ runner_groups: [{ id: 1 }, { id: "two" }, { id: 3 }, 4] })
          : path === group(1)
          ? Response.json({
            runners: [
              { name: "big", maximum_runners: 4, machine_size_details: { cpu_cores: 8, memory_gb: 32 } },
              { name: "vague", maximum_runners: "many" },
              { maximum_runners: 2 },
              7,
            ],
          })
          : path === group(3)
          ? Response.json({ runners: [{ name: "small", maximum_runners: 1 }] })
          : Response.json({ message: "Not Found" }, { status: 404 })
      );

      expect(await dashboardRunnersGitHub().largerRunners()).toEqual([
        { owner: org, name: "big", maximum: 4, cores: 8, memory: 32 },
        { owner: org, name: "vague", maximum: null, cores: null, memory: null },
        { owner: org, name: "small", maximum: 1, cores: null, memory: null },
      ]);
      expect(requests.requested).toEqual([groups, group(1), group(3)]);
    });

    it("returns no larger runners, after one request, for an organization with no runner groups", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      using requests = wire((path) =>
        path.endsWith("/runner-groups?per_page=100")
          ? Response.json({ runner_groups: [] })
          : Response.json({ runners: [{ name: "big" }] })
      );

      expect(await dashboardRunnersGitHub().largerRunners()).toEqual([]);
      expect(requests.requested).toEqual([`/orgs/${org}/actions/runner-groups?per_page=100`]);
    });

    it("throws for the larger runners when one runner group's list of them cannot be read", async () => {
      Deno.env.set("GH_TOKEN", "runners-feed-test");
      using _wire = wire((path) =>
        path.endsWith("/runner-groups?per_page=100")
          ? Response.json({ runner_groups: [{ id: 1 }, { id: 2 }] })
          : path.includes("/runner-groups/2/")
          ? Response.json({ message: "Forbidden" }, { status: 403 })
          : Response.json({ runners: [{ name: "big" }] })
      );

      await expect(dashboardRunnersGitHub().largerRunners()).rejects.toThrow(
        `GitHub API orgs/${org}/actions/runner-groups/2/hosted-runners?per_page=100 failed: HTTP 403`,
      );
    });
  });
});
