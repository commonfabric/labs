import { expect } from "@std/expect";

import type { GitHubDelivery } from "@commonfabric/github-webhooks/relay";
import { describe, it } from "@commonfabric/test-support/test";
import {
  mergedPullRequest,
  openedPullRequest,
  type PullRequestHead,
  pushedHead,
  watchForPullRequest,
} from "../lib/view/pullrequest.ts";
import {
  fakeRelay,
  mergedPayload,
  pullRequestPayload,
} from "./view-helpers.ts";

const HEAD: PullRequestHead = {
  repository: "https://github.com/fork/repo",
  branch: "feature",
  commit: "c0ffee",
};

const URL = "https://github.com/commonfabric/labs/pull/7";

/** Returns the address of the pull request opened with {@link HEAD} that a
 * delivery reports. */
const OPENED = (delivery: GitHubDelivery) => openedPullRequest(delivery, HEAD);

/** Git's answers for a checkout at `c0ffee`, pushing to `origin` on
 * GitHub. */
const CHECKOUT: Readonly<Record<string, string | null>> = {
  "remote get-url --push origin": "git@github.com:fork/repo.git\n",
  "rev-parse --verify --quiet HEAD": "c0ffee\n",
};

/** A git that answers as {@link CHECKOUT} does, except as `answers` says. */
function git(answers: Readonly<Record<string, string | null>> = {}) {
  const all = { ...CHECKOUT, ...answers };
  return (args: readonly string[]) => all[args.join(" ")] ?? null;
}

describe("pullrequest", () => {
  describe("pushedHead()", () => {
    it("returns origin's GitHub page, the branch, and the checked-out commit", () => {
      expect(pushedHead(git(), "feature")).toEqual(HEAD);
    });

    it("reads the address origin is pushed to, in any form GitHub offers", () => {
      expect(
        pushedHead(
          git({
            "remote get-url --push origin": "https://github.com/fork/repo\n",
          }),
          "feature",
        ),
      ).toEqual(HEAD);
    });

    it("returns null when origin is missing or not on GitHub, or nothing is checked out", () => {
      const unpushable: Array<Record<string, string | null>> = [
        { "remote get-url --push origin": null },
        {
          "remote get-url --push origin": "https://gitlab.example.test/x.git",
        },
        { "rev-parse --verify --quiet HEAD": null },
      ];

      for (const answers of unpushable) {
        expect(pushedHead(git(answers), "feature")).toBeNull();
      }
    });
  });

  describe("openedPullRequest()", () => {
    it("returns the address of a pull request opened with the head", () => {
      expect(
        openedPullRequest(
          { event: "pull_request", payload: pullRequestPayload() },
          HEAD,
        ),
      ).toBe(URL);
    });

    it("compares the repository's page without regard to letter case", () => {
      const payload = pullRequestPayload({
        repository: "https://github.com/Fork/Repo",
      });

      expect(openedPullRequest({ event: "pull_request", payload }, HEAD))
        .toBe(URL);
    });

    it("returns null for a pull request with another head, not just opened, or whose address is not a GitHub pull request's", () => {
      for (
        const payload of [
          pullRequestPayload({ action: "synchronize" }),
          pullRequestPayload({ repository: "https://github.com/other/repo" }),
          pullRequestPayload({ branch: "other" }),
          pullRequestPayload({ commit: "decade" }),
          {
            ...pullRequestPayload(),
            pull_request: {
              ...pullRequestPayload().pull_request,
              html_url: "https://github.com/x/y/pull/7\x1b[2J",
            },
          },
        ]
      ) {
        expect(openedPullRequest({ event: "pull_request", payload }, HEAD))
          .toBeNull();
      }
    });

    it("returns null for another event, or a payload missing what it reads", () => {
      const opened = pullRequestPayload();
      const { head } = opened.pull_request;

      for (
        const [event, payload] of [
          ["issues", opened],
          ["pull_request", []],
          ["pull_request", { action: "opened" }],
          ["pull_request", { action: "opened", pull_request: { head } }],
          ["pull_request", {
            action: "opened",
            pull_request: { html_url: URL, head: "feature" },
          }],
          ["pull_request", {
            action: "opened",
            pull_request: { html_url: URL, head: { ...head, repo: null } },
          }],
        ] as const
      ) {
        expect(openedPullRequest({ event, payload }, HEAD)).toBeNull();
      }
    });
  });

  describe("mergedPullRequest()", () => {
    it("returns the address of the pull request that merged, comparing its repository without regard to letter case", () => {
      for (const repository of ["commonfabric/labs", "CommonFabric/Labs"]) {
        expect(
          mergedPullRequest(
            { event: "pull_request", payload: mergedPayload() },
            repository,
            7,
          ),
        ).toBe(URL);
      }
    });

    it("returns null for a pull request closed without merging, another pull request, another repository, or an address that is not a GitHub pull request's", () => {
      const merged = mergedPayload();
      for (
        const payload of [
          mergedPayload({ merged: false }),
          mergedPayload({ action: "opened" }),
          mergedPayload({ number: 8 }),
          mergedPayload({ repository: "other/labs" }),
          {
            ...merged,
            pull_request: {
              ...merged.pull_request,
              html_url: "https://github.com/x/y/pull/7\x1b[2J",
            },
          },
        ]
      ) {
        expect(
          mergedPullRequest(
            { event: "pull_request", payload },
            "commonfabric/labs",
            7,
          ),
        ).toBeNull();
      }
    });

    it("returns null for another event, or a payload missing what it reads", () => {
      for (
        const [event, payload] of [
          ["issues", mergedPayload()],
          ["pull_request", []],
          ["pull_request", { action: "closed" }],
          ["pull_request", {
            action: "closed",
            pull_request: { merged: true, number: 7, html_url: URL },
          }],
          ["pull_request", {
            action: "closed",
            pull_request: {
              merged: true,
              number: 7,
              html_url: URL,
              base: { repo: "commonfabric/labs" },
            },
          }],
        ] as const
      ) {
        expect(mergedPullRequest({ event, payload }, "commonfabric/labs", 7))
          .toBeNull();
      }
    });
  });

  describe("watchForPullRequest()", () => {
    it("resolves with the address once the pull request opens, passing over other deliveries, and closes the connection", async () => {
      const relay = fakeRelay();
      const watch = watchForPullRequest(
        relay.connect,
        OPENED,
        new AbortController().signal,
      );
      await relay.connected;

      relay.deliver("push", { ref: "refs/heads/feature" });
      relay.deliver("pull_request", pullRequestPayload({ branch: "other" }));
      relay.deliver("pull_request", pullRequestPayload());

      expect(await watch).toBe(URL);
      await relay.closed();
    });

    it("calls `connected` once the connection is open, and before any delivery", async () => {
      const relay = fakeRelay();
      const connecting = Promise.withResolvers<void>();
      const said: string[] = [];
      const watch = watchForPullRequest(
        async () => {
          await connecting.promise;
          said.push("connecting");
          return relay.connect();
        },
        OPENED,
        new AbortController().signal,
        () => said.push("connected"),
      );

      expect(said).toEqual([]);
      connecting.resolve();
      await relay.connected;
      relay.deliver("pull_request", pullRequestPayload());

      expect(await watch).toBe(URL);
      expect(said).toEqual(["connecting", "connected"]);
    });

    it("passes over a frame that carries no delivery it can read", async () => {
      const relay = fakeRelay();
      const watch = watchForPullRequest(
        relay.connect,
        OPENED,
        new AbortController().signal,
      );
      await relay.connected;

      relay.deliver("pull_request", undefined);
      relay.deliver("pull_request", pullRequestPayload());

      expect(await watch).toBe(URL);
    });

    it("rejects when the relay ends the connection first", async () => {
      const relay = fakeRelay();
      const watch = watchForPullRequest(
        relay.connect,
        OPENED,
        new AbortController().signal,
      );
      await relay.connected;

      relay.end();

      await expect(watch).rejects.toThrow(
        "the webhook relay closed the connection",
      );
      await relay.closed();
    });

    it("rejects when the connection cannot be opened", async () => {
      await expect(
        watchForPullRequest(
          () => Promise.reject(new Error("connection refused")),
          OPENED,
          new AbortController().signal,
        ),
      ).rejects.toThrow("connection refused");
    });

    it("rejects, closing the connection, when its signal aborts", async () => {
      const relay = fakeRelay();
      const controller = new AbortController();
      const watch = watchForPullRequest(
        relay.connect,
        OPENED,
        controller.signal,
      );
      await relay.connected;

      controller.abort(new Error("the dialog closed"));

      await expect(watch).rejects.toThrow("the dialog closed");
      await relay.closed();
    });

    it("rejects, closing the connection, when its signal aborts while it connects", async () => {
      const relay = fakeRelay();
      const controller = new AbortController();
      const connecting = Promise.withResolvers<void>();
      const watch = watchForPullRequest(
        async () => {
          await connecting.promise;
          return relay.connect();
        },
        OPENED,
        controller.signal,
      );

      controller.abort(new Error("the dialog closed"));
      connecting.resolve();

      await expect(watch).rejects.toThrow("the dialog closed");
      await relay.closed();
    });

    it("rejects when the connection carries a frame the relay would not send", async () => {
      const { readable, writable } = new TransformStream<Uint8Array>();
      const writer = writable.getWriter();
      const watch = watchForPullRequest(
        () => Promise.resolve({ readable, close: () => {} }),
        OPENED,
        new AbortController().signal,
      );

      void writer.write(new TextEncoder().encode("HTTP/1.1 400"));

      await expect(watch).rejects.toThrow("longer than the relay sends");
    });

    it("hands its signal to the connect, and connects to nothing once it has aborted", async () => {
      const controller = new AbortController();
      const signals: Array<AbortSignal | undefined> = [];
      const relay = fakeRelay();
      const watch = watchForPullRequest(
        (signal) => {
          signals.push(signal);
          return relay.connect();
        },
        OPENED,
        controller.signal,
      );
      await relay.connected;
      controller.abort();
      await expect(watch).rejects.toThrow();

      expect(signals).toEqual([controller.signal]);
    });

    it("connects to nothing when its signal has already aborted", async () => {
      const relay = fakeRelay();

      await expect(
        watchForPullRequest(relay.connect, OPENED, AbortSignal.abort()),
      ).rejects.toThrow();
      expect(relay.connections).toBe(0);
    });

    it("closes a connection that has already closed without failing", async () => {
      const relay = fakeRelay();
      const watch = watchForPullRequest(
        async () => {
          const connection = await relay.connect();
          return {
            readable: connection.readable,
            close: () => {
              connection.close();
              throw new Error("already closed");
            },
          };
        },
        OPENED,
        new AbortController().signal,
      );
      await relay.connected;

      relay.deliver("pull_request", pullRequestPayload());

      expect(await watch).toBe(URL);
      await relay.closed();
    });
  });
});
