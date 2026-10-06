import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";

import { REPO, TEST_SELECTION_WORKFLOW } from "../config.ts";
import { publisherRunning } from "../test-selection-activity.ts";
import { makeTestFlakes } from "../tiles/test-flakes.ts";
import { makeTestSelection } from "../tiles/test-selection.ts";
import type { Ctx } from "../types.ts";

function context(token = "test-token"): Ctx {
  return {
    env: (key) => key === "GITHUB_TOKEN" ? token : undefined,
    runs: () => Promise.reject(new Error("history is not activity")),
    runsFor: () => Promise.reject(new Error("history is not activity")),
  };
}

const runsPath =
  `/repos/${REPO}/actions/workflows/${TEST_SELECTION_WORKFLOW}/runs`;

interface ListedRun {
  id: number;
  status: string;
  head_branch: string;
  created_at: string;
  updated_at: string;
}

// A run on `branch` created `daysAgo` days ago, and last updated then.
function listed(
  id: number,
  status: string,
  daysAgo = 0,
  branch = "main",
): ListedRun {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return { id, status, head_branch: branch, created_at: at, updated_at: at };
}

// `run` started again, now `status`, keeping its place in the list.
function again(run: ListedRun, status: string): ListedRun {
  return { ...run, status, updated_at: new Date().toISOString() };
}

interface Publisher {
  // The workflow's whole run list, newest first, as GitHub serves it current.
  list?: ListedRun[];
  // What the status index answers for each status, which may be stale: the
  // runs it names, each as it stood when last updated.
  indexed?: Record<string, ListedRun[]>;
  // Each run's current status, as a read of the run itself answers.
  current?: Record<number, string>;
}

// Answers the publisher's reads from `publisher`, recording each request and
// checking that it carries the token and asks the status index for main's runs.
function serve(publisher: () => Publisher, requests: URL[] = []) {
  return stub(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    if (url.searchParams.has("status")) {
      expect(url.searchParams.get("branch")).toBe("main");
    }
    const { list = [], indexed = {}, current = {} } = publisher();
    const run = url.pathname.match(/\/actions\/runs\/(\d+)$/);
    if (run) {
      const id = Number(run[1]);
      return Promise.resolve(Response.json({
        ...list.find((held) => held.id === id),
        id,
        status: current[id],
        updated_at: new Date().toISOString(),
      }));
    }
    const status = url.searchParams.get("status");
    const size = Number(url.searchParams.get("per_page"));
    const start = (Number(url.searchParams.get("page") ?? 1) - 1) * size;
    return Promise.resolve(Response.json({
      workflow_runs: (status === null ? list : indexed[status] ?? [])
        .slice(start, start + size),
    }));
  });
}

describe("test-selection-activity", () => {
  it("returns true for an unfinished run on main on the newest page", async () => {
    // The status index has not caught up with the run that just started.
    const requests: URL[] = [];
    using _fetch = serve(() => ({
      list: [listed(3, "in_progress"), listed(2, "completed")],
    }), requests);
    expect(await publisherRunning(context())).toBe(true);
    const newest = requests.find((url) => !url.searchParams.has("status"));
    expect(newest?.pathname).toBe(runsPath);
    expect(newest?.searchParams.has("branch")).toBe(false);
  });

  it("returns true for old reruns the status index finds, once each is read", async () => {
    // Run 221 was created days before the runs at the top of the list, and
    // was finished when a first read held it. It is started again afterwards,
    // and the next read of the top of the list does not reach it.
    for (
      const status of [
        "queued",
        "in_progress",
        "waiting",
        "requested",
        "pending",
      ]
    ) {
      using time = new FakeTime();
      const top = Array.from(
        { length: 30 },
        (_, i) => listed(300 - i, "completed"),
      );
      const old = listed(221, "completed", 10);
      let publisher: Publisher = { list: [...top, old] };
      using _fetch = serve(() => publisher);
      const ctx = context();
      expect(await publisherRunning(ctx)).toBe(false);

      time.tick(30_001);
      const rerun = again(old, status);
      publisher = {
        list: [...top, rerun],
        indexed: { [status]: [rerun] },
        current: { 221: status },
      };
      expect(await publisherRunning(ctx)).toBe(true);
    }
  });

  it("returns false when the status index lists a run that has finished", async () => {
    const requests: URL[] = [];
    using _fetch = serve(() => ({
      list: [listed(5, "completed")],
      indexed: { in_progress: [listed(5, "in_progress", 1)] },
      current: { 5: "completed" },
    }), requests);
    expect(await publisherRunning(context())).toBe(false);
    // Run 5 is at the top of the list, which is current, so it is not read
    // again.
    expect(requests.some((url) => url.pathname.endsWith("/actions/runs/5")))
      .toBe(false);
  });

  it("finds an old rerun behind a finished run the status index still lists", async () => {
    using time = new FakeTime();
    const top = Array.from(
      { length: 30 },
      (_, i) => listed(300 - i, "completed"),
    );
    const ninety = listed(90, "completed", 5);
    const forty = listed(40, "completed", 6);
    let publisher: Publisher = { list: [...top, ninety, forty] };
    using _fetch = serve(() => publisher);
    const ctx = context();
    expect(await publisherRunning(ctx)).toBe(false);

    // Run 90 ran again and has finished, though the index still lists it;
    // run 40 is running again.
    time.tick(30_001);
    publisher = {
      list: [...top, again(ninety, "completed"), again(forty, "in_progress")],
      indexed: {
        in_progress: [
          again(ninety, "in_progress"),
          again(forty, "in_progress"),
        ],
      },
      current: { 90: "completed", 40: "in_progress" },
    };
    expect(await publisherRunning(ctx)).toBe(true);
  });

  it("returns false for unfinished runs on other branches", async () => {
    using _fetch = serve(() => ({
      list: [listed(7, "in_progress", 0, "feature")],
    }));
    expect(await publisherRunning(context())).toBe(false);
  });

  it("shares activity reads between both tiles and refreshes after completion", async () => {
    using time = new FakeTime();
    const requests: URL[] = [];
    let running = true;
    using _fetch = serve(() => ({
      list: [listed(1, running ? "in_progress" : "completed")],
    }), requests);
    const ctx = context();
    const tiles = [makeTestFlakes(), makeTestSelection()];
    expect(tiles.map((tile) => tile.intervalMs)).toEqual([30_000, 30_000]);
    const read = () =>
      Promise.all(tiles.map((tile) => tile.collectActivity!(ctx)));
    expect(await read()).toEqual([true, true]);
    expect(requests.length).toBe(6);
    expect(await read()).toEqual([true, true]);
    expect(requests.length).toBe(6);
    time.tick(30_001);
    running = false;
    expect(await read()).toEqual([false, false]);
    expect(requests.length).toBe(12);
  });

  it("returns undefined without credentials and rejects failed reads", async () => {
    let requests = 0;
    using _fetch = stub(globalThis, "fetch", () => {
      requests++;
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    expect(await publisherRunning(context(""))).toBeUndefined();
    expect(requests).toBe(0);
    await expect(publisherRunning(context())).rejects.toThrow();
    expect(requests).toBe(1);
  });
});
