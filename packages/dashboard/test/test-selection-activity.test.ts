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

interface Publisher {
  // The workflow's newest page, as GitHub serves it current.
  newest?: { id: number; status: string; head_branch: string }[];
  // What the status index answers for each status, which may be stale.
  indexed?: Record<string, number[]>;
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
    const { newest = [], indexed = {}, current = {} } = publisher();
    const run = url.pathname.match(/\/actions\/runs\/(\d+)$/);
    if (run) {
      const id = Number(run[1]);
      return Promise.resolve(Response.json({
        id,
        status: current[id],
        head_branch: "main",
      }));
    }
    const status = url.searchParams.get("status");
    return Promise.resolve(Response.json({
      workflow_runs: status === null
        ? newest
        : (indexed[status] ?? []).slice(
          0,
          Number(url.searchParams.get("per_page")),
        ).map((id) => ({
          id,
          status,
          head_branch: "main",
        })),
    }));
  });
}

describe("test-selection-activity", () => {
  it("returns true for an unfinished run on main on the newest page", async () => {
    // The status index has not caught up with the run that just started.
    const requests: URL[] = [];
    using _fetch = serve(() => ({
      newest: [
        { id: 3, status: "in_progress", head_branch: "main" },
        { id: 2, status: "completed", head_branch: "main" },
      ],
    }), requests);
    expect(await publisherRunning(context())).toBe(true);
    const newest = requests.find((url) => !url.searchParams.has("status"));
    expect(newest?.pathname).toBe(runsPath);
    expect(newest?.searchParams.has("branch")).toBe(false);
  });

  it("returns true for old reruns the status index finds, once each is read", async () => {
    // This rerun's creation time predates the newest page.
    for (
      const status of [
        "queued",
        "in_progress",
        "waiting",
        "requested",
        "pending",
      ]
    ) {
      using _fetch = serve(() => ({
        indexed: { [status]: [221] },
        current: { 221: status },
      }));
      expect(await publisherRunning(context())).toBe(true);
    }
  });

  it("returns false when the status index lists a run that has finished", async () => {
    const requests: URL[] = [];
    using _fetch = serve(() => ({
      newest: [{ id: 5, status: "completed", head_branch: "main" }],
      indexed: { in_progress: [5] },
      current: { 5: "completed" },
    }), requests);
    expect(await publisherRunning(context())).toBe(false);
    // Run 5 is on the newest page, which is current, so it is not read again.
    expect(requests.some((url) => url.pathname.endsWith("/actions/runs/5")))
      .toBe(false);
  });

  it("finds an old rerun behind a finished run the status index still lists", async () => {
    using _fetch = serve(() => ({
      indexed: { in_progress: [90, 40] },
      current: { 90: "completed", 40: "in_progress" },
    }));
    expect(await publisherRunning(context())).toBe(true);
  });

  it("returns false for unfinished runs on other branches", async () => {
    using _fetch = serve(() => ({
      newest: [{ id: 7, status: "in_progress", head_branch: "feature" }],
    }));
    expect(await publisherRunning(context())).toBe(false);
  });

  it("shares activity reads between both tiles and refreshes after completion", async () => {
    using time = new FakeTime();
    const requests: URL[] = [];
    let running = true;
    using _fetch = serve(() => ({
      newest: [{
        id: 1,
        status: running ? "in_progress" : "completed",
        head_branch: "main",
      }],
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
    expect(requests).toBe(6);
  });
});
