/**
 * Tests of the runners feed's WebSockets, opened by a client over TCP on this
 * machine. The dashboard's other tests may not open a connection, so the
 * package's `deno-test` task runs this file under `--allow-all`; what the feed
 * does with a socket once it has one is tested with fakes in
 * ../runners-feed.test.ts.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import type { LargerRunner, Runner, RunnersMessage } from "../runner-board.ts";
import { RunnersFeed, type RunnersGitHub, type RunnersSocket } from "../runners-feed.ts";
import { RawWebSocket } from "./raw-websocket.ts";
import { FakeRelay } from "./webhook-relay.ts";
import { beforeEach, describe, it } from "@commonfabric/test-support/test";

const REPO = "example/repo";
const VERSION = "feed-socket-test-version";

/** How long the feed goes at least between reads of the jobs. */
const REREAD_MS = 5 * 60_000;

/** The feed's limit on the pages open at once. */
const MOST_SOCKETS = 64;

/**
 * GitHub, as far as the feed reads it: one run of `REPO` under way, with job
 * 11 queued, and no runners. It counts each read.
 */
class FakeGitHub implements RunnersGitHub {
  repositoryReads = 0;
  runnerReads = 0;
  /** When set, the next read of the repositories waits for it to resolve. */
  hold: PromiseWithResolvers<void> | undefined;

  async repositories(): Promise<readonly string[]> {
    this.repositoryReads++;
    const hold = this.hold;
    this.hold = undefined;
    await hold?.promise;
    return [REPO];
  }

  runsUnderWay(): Promise<readonly unknown[]> {
    return Promise.resolve([{ id: 1, run_attempt: 1, status: "in_progress", conclusion: null, pull_requests: [] }]);
  }

  run(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  jobs(): Promise<readonly unknown[]> {
    return Promise.resolve([{
      id: 11,
      run_id: 1,
      run_attempt: 1,
      name: "job 11",
      status: "queued",
      conclusion: null,
      labels: ["ubuntu-latest"],
      html_url: `https://github.com/${REPO}/actions/runs/1/job/11`,
      workflow_name: "CI",
      head_branch: "main",
      head_sha: "a".repeat(40),
      created_at: "2026-11-24T00:00:00Z",
      started_at: null,
      runner_name: null,
      runner_group_name: null,
    }]);
  }

  runners(): Promise<readonly Runner[]> {
    this.runnerReads++;
    return Promise.resolve([]);
  }

  largerRunners(): Promise<readonly LargerRunner[]> {
    return Promise.resolve([]);
  }
}

/** A page's socket that takes whatever it is sent, unless it is a snapshot while `failing` says to fail. */
function page(failing: () => boolean = () => false): RunnersSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send(data: string) {
      if (failing() && JSON.parse(data).type === "snapshot") throw new Error("the page went away");
    },
    close() {},
  };
}

/** Reads frames from `socket` until one is a message of `type`, and returns it. */
async function next(socket: RawWebSocket, type: RunnersMessage["type"]): Promise<RunnersMessage> {
  for (let frame = await socket.receive(); frame !== undefined; frame = await socket.receive()) {
    const message: RunnersMessage = JSON.parse(frame.text);
    if (message.type === type) return message;
  }
  throw new Error(`the socket ended before a ${type} message`);
}

/** The IDs of the jobs `message` holds, when it is a snapshot. */
function jobIds(message: RunnersMessage): number[] | undefined {
  return message.type === "snapshot" ? message.tracker.jobs.map((job) => job.id) : undefined;
}

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

    /** The request for a page's socket that carries the feed's key, as `open()` is given one. */
    const keyed = () => new Request(`http://localhost/runners/socket?key=${encodeURIComponent(feed.key)}`);

    /**
     * Serves the feed's sockets on this machine, each request answered by
     * `handle`, for the length of `body`, which opens a page's socket with
     * `open`.
     */
    async function serving(
      body: (open: () => ReturnType<typeof RawWebSocket.open>) => Promise<void>,
      handle: (request: Request) => Response = (request) => feed.open(request),
    ): Promise<void> {
      const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handle);
      try {
        await body(() => RawWebSocket.open(server.addr.port, `/runners/socket?key=${encodeURIComponent(feed.key)}`));
      } finally {
        await server.shutdown();
      }
    }

    describe("instance members", () => {
      describe("open()", () => {
        describe("given a WebSocket request with the key", () => {
          it("upgrades it to a socket that opens with a snapshot, and forgets the jobs once that last page closes", async () => {
            await relay.open();
            await serving(async (open) => {
              const { socket, status } = await open();
              expect(status).toBe(101);
              const first = await next(socket, "snapshot");
              expect([first.type === "snapshot" && first.version, jobIds(first)]).toEqual([VERSION, []]);
              expect(jobIds(await next(socket, "snapshot"))).toEqual([11]);
              expect(heldJobs()).toEqual([11]);

              await socket.close();
              expect(heldJobs()).toEqual([]);
            });
          });

          it("counts the socket against the limit on pages open from its upgrade, before it opens, until it closes", async () => {
            await relay.open();
            for (let i = 0; i < MOST_SOCKETS - 1; i++) await feed.serve(page());
            const statuses: number[] = [];
            const probe = async () => {
              const response = feed.open(keyed());
              statuses.push(response.status);
              await response.body?.cancel();
            };
            await serving(async (open) => {
              const { socket } = await open();
              await next(socket, "snapshot");
              await probe();
              await socket.close();
              await probe();
            }, (request) => {
              const response = feed.open(request);
              void probe();
              return response;
            });
            // The first is refused while the socket is being upgraded, the
            // second while it is open, and the third, once it has closed, is
            // not a WebSocket request.
            expect(statuses).toEqual([503, 503, 400]);
          });

          it("takes in what the page says of whether a reader can see it", async () => {
            await relay.open();
            await serving(async (open) => {
              const { socket } = await open();
              await next(socket, "snapshot");
              await next(socket, "snapshot");
              expect([github.repositoryReads, github.runnerReads]).toEqual([1, 1]);
              await relay.end();
              using time = new FakeTime();
              time.tick(REREAD_MS);

              // A page that only one reader saw, hidden and shown again,
              // catches up.
              await socket.send(JSON.stringify({ type: "visible", visible: false }));
              await socket.send(JSON.stringify({ type: "visible", visible: true }));
              expect(jobIds(await next(socket, "snapshot"))).toEqual([11]);
              expect([github.repositoryReads, github.runnerReads]).toEqual([2, 2]);
              await socket.close();
            });
          });

          it("logs a failure to serve the socket once it opens, and nothing while serving it succeeds", async () => {
            using error = stub(console, "error");
            github.hold = Promise.withResolvers();
            const reading = github.hold;
            let failing = false;
            const served = feed.serve(page(() => failing)).catch((failure: Error) => failure.message);
            failing = true;
            await serving(async (open) => {
              const { socket } = await open();
              await next(socket, "snapshot");
              expect(error.calls).toEqual([]);

              reading.resolve();
              expect(await served).toBe("the page went away");
              // Closing the socket waits on the server, by which time the
              // failure has reached whatever handles it.
              await socket.close();
            });
            expect(error.calls.map((call) => call.args)).toEqual([[
              "runners page: serving a socket failed:",
              "the page went away",
            ]]);
          });
        });
      });
    });
  });
});
