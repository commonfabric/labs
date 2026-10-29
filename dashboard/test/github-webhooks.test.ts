import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import {
  Freshness,
  type GitHubDelivery,
  GitHubWebhooks,
  pushOf,
  RELAY_QUIET_MS,
  RELAY_VOUCH_MS,
  relayAddress,
  workflowRunOf,
} from "../github-webhooks.ts";
import type { GitHubRun } from "../github-runs.ts";
import { FakeRelay, pushPayload, workflowRunPayload } from "./webhook-relay.ts";

const REPO = "example/repo";
const ENCODER = new TextEncoder();

const RUN: GitHubRun = {
  id: 7,
  event: "push",
  head_branch: "main",
  head_sha: "sha7",
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
  display_title: "run 7",
  created_at: "2026-10-20T12:00:00Z",
  run_started_at: "2026-10-20T12:00:00Z",
  updated_at: "2026-10-20T12:05:00Z",
  html_url: `https://github.com/${REPO}/actions/runs/7`,
  head_commit: { message: "Fix the thing" },
};

/** The request a webhook delivery of `event` carrying `body` arrives as. */
function request(event: string, body: string): Uint8Array {
  return ENCODER.encode(
    `POST /webhook HTTP/1.1\r\nX-GitHub-Event: ${event}\r\n\r\n${body}`,
  );
}

describe("github-webhooks", () => {
  let time: FakeTime;
  let errors: string[];
  const realError = console.error;

  beforeEach(() => {
    time = new FakeTime(Date.UTC(2026, 9, 20, 12));
    errors = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    time.restore();
    console.error = realError;
  });

  describe("GitHubWebhooks", () => {
    describe("instance members", () => {
      describe("listen()", () => {
        it("hands each delivery to every listener, with its event and parsed payload", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const heard: GitHubDelivery[] = [];
          relay.webhooks.listen((delivery) => heard.push(delivery));
          await relay.deliver("push", pushPayload(REPO, "refs/heads/main"));
          expect(heard).toEqual([{
            event: "push",
            payload: pushPayload(REPO, "refs/heads/main"),
          }]);
        });

        it("reads a frame that arrives a byte at a time", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const delivery = await relay.write(
            request("issues", '{"ref":"x"}'),
            1,
          );
          expect(delivery).toEqual({ event: "issues", payload: { ref: "x" } });
        });

        it("reads several frames that arrive together", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const heard: unknown[] = [];
          const all = Promise.withResolvers<void>();
          relay.webhooks.listen((delivery) => {
            if (heard.push(delivery.payload) === 3) all.resolve();
          });
          const frames = [1, 2, 3].map((n) =>
            frameOf(request("issues", `{"n":${n}}`))
          );
          relay.writeBytes(
            new Uint8Array(frames.flatMap((frame) => [...frame])),
          );
          await all.promise;
          expect(heard).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
        });

        it("reads a form-encoded payload", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const delivery = await relay.deliver("issues", { ref: "y" }, true);
          expect(delivery.payload).toEqual({ ref: "y" });
        });

        it("ends and replaces a connection that carries a request naming no event, carrying no JSON, or with no end to its head, and counts none of them", async () => {
          const unreadable = [
            ENCODER.encode("POST /webhook HTTP/1.1\r\n\r\n{}"),
            request("issues", "not json"),
            ENCODER.encode("no head end"),
          ];
          const relay = new FakeRelay();
          await relay.open();
          const before = relay.webhooks.deliveries;
          const heard: unknown[] = [];
          relay.webhooks.listen((delivery) => heard.push(delivery.payload));
          for (const bytes of unreadable) {
            const stream = relay.webhooks.stream;
            const closing = relay.closed();
            relay.writeBytes(frameOf(bytes));
            await closing;
            await relay.deliver("ping", {});
            expect(relay.webhooks.stream).not.toBe(stream);
          }
          expect(relay.connections).toBe(4);
          expect(heard).toEqual([{}, {}, {}]);
          expect(relay.webhooks.deliveries).toBe(before + 3);
          expect(errors).toHaveLength(3);
        });

        it("ends and replaces a connection that carries a workflow_run or push delivery missing what the dashboard reads of one", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const heard: string[] = [];
          relay.webhooks.listen((delivery) => heard.push(delivery.event));
          const { updated_at: _, ...partial } = RUN;
          for (
            const [event, payload] of [
              ["workflow_run", {
                ...workflowRunPayload(REPO, RUN),
                workflow_run: { ...partial, path: "x", workflow_id: 1 },
              }],
              ["push", { ref: "refs/heads/main" }],
            ] as const
          ) {
            const closing = relay.closed();
            relay.writeBytes(frameOf(request(event, JSON.stringify(payload))));
            await closing;
            await relay.deliver("ping", {});
          }
          expect(heard).toEqual(["ping", "ping"]);
          expect(relay.connections).toBe(3);
        });

        it("hands a delivery to the other listeners when one throws, and then replaces the connection", async () => {
          const relay = new FakeRelay();
          await relay.open();
          relay.webhooks.listen(() => {
            throw new Error("listener broke");
          });
          const closing = relay.closed();
          const delivery = await relay.deliver("issues", { ref: "w" });
          await closing;
          expect(delivery.payload).toEqual({ ref: "w" });
          expect(errors.some((error) => error.includes("listener broke")))
            .toBe(true);
          expect(relay.connections).toBe(2);
        });

        it("stops calling a listener once it unsubscribes", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const heard: unknown[] = [];
          const stop = relay.webhooks.listen((delivery) =>
            heard.push(delivery.payload)
          );
          await relay.deliver("issues", { ref: "a" });
          stop();
          await relay.deliver("issues", { ref: "b" });
          expect(heard).toEqual([{ ref: "a" }]);
        });
      });

      describe("stream", () => {
        it("is undefined before a connection opens", () => {
          expect(new FakeRelay().webhooks.stream).toBeUndefined();
        });

        it("is undefined until the connection open has carried a delivery", async () => {
          const relay = new FakeRelay();
          await relay.webhooks.connect();
          expect(relay.webhooks.stream).toBeUndefined();
          await relay.deliver("ping", {});
          expect(relay.webhooks.stream).toBeDefined();
        });

        it("names the connection open while it is heard", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const stream = relay.webhooks.stream;
          expect(stream).toBeDefined();
          time.tick(RELAY_QUIET_MS - 1);
          expect(relay.webhooks.stream).toBe(stream);
        });

        it("is undefined once the connection has carried nothing for RELAY_QUIET_MS, and names it again once it carries a delivery", async () => {
          const relay = new FakeRelay();
          await relay.open();
          const stream = relay.webhooks.stream;
          time.tick(RELAY_QUIET_MS);
          expect(relay.webhooks.stream).toBeUndefined();
          await relay.deliver("issues", { ref: "a" });
          expect(relay.webhooks.stream).toBe(stream);
        });

        it("is undefined once the connection ends", async () => {
          const relay = new FakeRelay();
          await relay.open();
          relay.refusing = true;
          await relay.end();
          expect(relay.webhooks.stream).toBeUndefined();
        });
      });

      describe("vouchesFor()", () => {
        it("vouches for a recent read under the connection open, and for no other", async () => {
          const relay = new FakeRelay();
          const now = Date.now();
          expect(relay.webhooks.vouchesFor(undefined, now)).toBe(false);
          await relay.open();
          const first = relay.webhooks.stream;
          expect(relay.webhooks.vouchesFor(first, now)).toBe(true);
          expect(
            relay.webhooks.vouchesFor(first, now - RELAY_VOUCH_MS),
          ).toBe(false);
          await relay.end();
          await relay.deliver("ping", {});
          expect(relay.webhooks.vouchesFor(relay.webhooks.stream, now))
            .toBe(true);
          expect(relay.webhooks.vouchesFor(first, now)).toBe(false);
        });
      });

      describe("connect()", () => {
        it("opens one connection however often it is called", async () => {
          const relay = new FakeRelay();
          const first = relay.webhooks.connect();
          const second = relay.webhooks.connect();
          await Promise.all([first, second]);
          await relay.webhooks.connect();
          expect(relay.connections).toBe(1);
        });

        it("replaces at once a connection that carried a delivery and ended", async () => {
          const relay = new FakeRelay();
          await relay.open();
          await relay.end();
          expect(relay.connections).toBe(2);
        });

        it("leaves a connection that carried nothing and ended for the next call", async () => {
          const relay = new FakeRelay();
          await relay.webhooks.connect();
          await relay.end();
          expect(relay.connections).toBe(1);
          await relay.webhooks.connect();
          expect(relay.connections).toBe(2);
        });

        it("logs a connection that cannot be opened, and tries again when called again", async () => {
          const relay = new FakeRelay();
          relay.refusing = true;
          await relay.webhooks.connect();
          expect(errors).toEqual([
            "GitHub webhook relay: could not connect: connection refused",
          ]);
          relay.refusing = false;
          await relay.open();
          expect(relay.webhooks.stream).toBeDefined();
        });

        it("logs only the first of a series of connections that cannot be opened, until one opens", async () => {
          const refused =
            "GitHub webhook relay: could not connect: connection refused";
          const relay = new FakeRelay();
          relay.refusing = true;
          await relay.webhooks.connect();
          await relay.webhooks.connect();
          relay.refusing = false;
          await relay.open();
          expect(errors).toEqual([refused]);

          await relay.end();
          relay.refusing = true;
          await relay.end();
          await relay.webhooks.connect();
          expect(errors).toEqual([refused, refused]);
        });

        it("ends and replaces a connection that has carried nothing for RELAY_QUIET_MS", async () => {
          const relay = new FakeRelay();
          await relay.open();
          time.tick(RELAY_QUIET_MS - 1);
          await relay.webhooks.connect();
          expect(relay.connections).toBe(1);
          time.tick(1);
          const closing = relay.closed();
          await relay.webhooks.connect();
          await closing;
          expect(relay.connections).toBe(2);
        });

        it("never connects without a way to", async () => {
          const webhooks = new GitHubWebhooks();
          await webhooks.connect();
          expect(webhooks.stream).toBeUndefined();
        });
      });
    });
  });

  describe("relayAddress()", () => {
    it("turns the relay off for an empty address", () => {
      expect(relayAddress("")).toBeUndefined();
    });

    it("fails each connection to an address with no port", async () => {
      await expect(relayAddress("relay.example")?.()).rejects.toThrow(
        "names no port",
      );
    });

    it("accepts a host and port", () => {
      expect(relayAddress("relay.example:8081")).toBeInstanceOf(Function);
    });
  });

  describe("Freshness", () => {
    const changes = (delivery: GitHubDelivery) => delivery.event === "member";

    it("is not current before a read, nor after a read with no connection open", () => {
      const freshness = new Freshness(new GitHubWebhooks(), changes);
      expect(freshness.current).toBe(false);
      freshness.reading()();
      expect(freshness.current).toBe(false);
    });

    it("is current after a read under the open connection, until a delivery it picks out arrives", async () => {
      const relay = new FakeRelay();
      await relay.open();
      const freshness = new Freshness(relay.webhooks, changes);
      freshness.reading()();
      await relay.deliver("issues", {});
      expect(freshness.current).toBe(true);
      await relay.deliver("member", {});
      expect(freshness.current).toBe(false);
      freshness.reading()();
      expect(freshness.current).toBe(true);
    });

    it("is not current after a read during which a delivery it picks out arrived", async () => {
      const relay = new FakeRelay();
      await relay.open();
      const freshness = new Freshness(relay.webhooks, changes);
      const read = freshness.reading();
      await relay.deliver("member", {});
      read();
      expect(freshness.current).toBe(false);
    });

    it("is not current once RELAY_VOUCH_MS has passed since the read started", async () => {
      const relay = new FakeRelay();
      await relay.open();
      const freshness = new Freshness(relay.webhooks, changes);
      freshness.reading()();
      time.tick(RELAY_VOUCH_MS - 1);
      await relay.deliver("issues", {});
      expect(freshness.current).toBe(true);
      time.tick(1);
      expect(freshness.current).toBe(false);
    });

    it("is not current once the connection it was read under ends", async () => {
      const relay = new FakeRelay();
      await relay.open();
      const freshness = new Freshness(relay.webhooks, changes);
      freshness.reading()();
      await relay.end();
      await relay.deliver("ping", {});
      expect(freshness.current).toBe(false);
    });
  });

  describe("workflowRunOf()", () => {
    it("reads the run, its workflow, and its repository", () => {
      const activity = workflowRunOf({
        event: "workflow_run",
        payload: workflowRunPayload(REPO, RUN, ".github/workflows/ci.yml", 9),
      });
      expect(activity).toEqual({
        repo: REPO,
        defaultBranch: "main",
        workflowId: 9,
        workflowFile: "ci.yml",
        run: { ...RUN, name: "CI", path: ".github/workflows/ci.yml" },
      });
    });

    it("reads a run that has not started yet as starting when it was created", () => {
      const payload = workflowRunPayload(REPO, RUN);
      const activity = workflowRunOf({
        event: "workflow_run",
        payload: {
          ...payload,
          workflow_run: { ...payload.workflow_run, run_started_at: null },
        },
      });
      expect(activity?.run.run_started_at).toBe(RUN.created_at);
    });

    it("keeps only the fields of the run the dashboard reads", () => {
      const payload = workflowRunPayload(REPO, RUN);
      const activity = workflowRunOf({
        event: "workflow_run",
        payload: {
          ...payload,
          workflow_run: {
            ...payload.workflow_run,
            actor: { login: "someone" },
            head_commit: { message: "Fix the thing", tree_id: "t" },
          },
        },
      });
      expect(activity?.run).toEqual({
        ...RUN,
        name: "CI",
        path: ".github/workflows/ci.yml",
      });
    });

    it("reads nothing from another event, or from a run missing a field", () => {
      const payload = workflowRunPayload(REPO, RUN);
      expect(workflowRunOf({ event: "workflow_job", payload })).toBeUndefined();
      const { updated_at: _, ...partial } = payload.workflow_run;
      expect(workflowRunOf({
        event: "workflow_run",
        payload: { ...payload, workflow_run: partial },
      })).toBeUndefined();
      expect(workflowRunOf({
        event: "workflow_run",
        payload: { workflow_run: payload.workflow_run },
      })).toBeUndefined();
      expect(workflowRunOf({ event: "workflow_run", payload: [] }))
        .toBeUndefined();
    });
  });

  describe("pushOf()", () => {
    it("reads the ref and the repository", () => {
      expect(pushOf({
        event: "push",
        payload: pushPayload(REPO, "refs/heads/main-green", "b".repeat(40)),
      })).toEqual({
        repo: REPO,
        defaultBranch: "main",
        ref: "refs/heads/main-green",
        after: "b".repeat(40),
      });
    });

    it("reads nothing from another event, or from a push naming no ref", () => {
      expect(pushOf({ event: "create", payload: pushPayload(REPO, "x") }))
        .toBeUndefined();
      expect(pushOf({
        event: "push",
        payload: { repository: { full_name: REPO, default_branch: "main" } },
      })).toBeUndefined();
    });
  });
});

/** `request` as the relay frames it. */
function frameOf(request: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + request.length);
  new DataView(frame.buffer).setUint32(0, request.length);
  frame.set(request, 4);
  return frame;
}
