/**
 * recent-runs: the dot and the words a run is given, which the tile and the
 * repository pages both show, and the rows the tile draws.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { LOOM_REPO } from "../config.ts";
import type { Ctx, Run } from "../types.ts";
import { recentRuns, runOutcome } from "./recent-runs.ts";

function run(over: Partial<Run> = {}): Run {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "a".repeat(40),
    display_title: "a change",
    created_at: "2026-09-30T10:00:00Z",
    run_started_at: "2026-09-30T10:00:00Z",
    updated_at: "2026-09-30T10:30:00Z",
    html_url: "https://github.com/commonfabric/labs/actions/runs/1",
    head_commit: null,
    ...over,
  };
}

describe("recent-runs", () => {
  describe("runOutcome()", () => {
    it("returns a green dot and `green` for a run that passed on its first attempt", () => {
      expect(runOutcome(run())).toEqual({ dot: "green", text: "green" });
    });

    it("returns a gray dot and names the attempt for a run that passed only on a retry", () => {
      expect(runOutcome(run({ run_attempt: 3 }))).toEqual({
        dot: "gray",
        text: "green on retry #3",
      });
    });

    it("returns a red dot and the conclusion for a run that failed", () => {
      expect(runOutcome(run({ conclusion: "timed_out" }))).toEqual({
        dot: "red",
        text: "timed_out",
      });
    });

    it("returns a gray dot and `done` for a finished run with no conclusion", () => {
      expect(runOutcome(run({ conclusion: null }))).toEqual({
        dot: "gray",
        text: "done",
      });
    });

    it("returns the running dot, naming any attempt past the first, for a run still going", () => {
      const going = run({ status: "in_progress", conclusion: null });
      expect(runOutcome(going)).toEqual({ dot: "run", text: "running" });
      expect(runOutcome({ ...going, run_attempt: 2 })).toEqual({
        dot: "run",
        text: "running · attempt 2",
      });
    });
  });

  describe("recentRuns", () => {
    describe("collect()", () => {
      it("opens the text of a row whose commit the green branch is or was at with a star, solid only for the commit it is at now", async () => {
        const loom = [
          run({
            repo: LOOM_REPO,
            id: 3,
            run_started_at: "2026-09-30T12:00:00Z",
            green: { branch: "main-green", current: true },
          }),
          run({
            repo: LOOM_REPO,
            id: 2,
            run_started_at: "2026-09-30T11:00:00Z",
            green: { branch: "main-green", current: false },
          }),
          run({ repo: LOOM_REPO, id: 1 }),
        ];
        const ctx: Ctx = {
          runs: () => Promise.resolve([]),
          runsFor: (source) =>
            Promise.resolve(source.repo === LOOM_REPO ? loom : []),
          env: () => undefined,
        };
        const view = await recentRuns.collect(ctx);
        const [current, former, unmarked] = (view.extra ?? "").split(
          `<div class="ev">`,
        ).slice(1);
        expect(current).toContain(
          `<span class="evtxt"><span class="green-star" role="img" aria-label="main-green is at this commit" title="main-green is at this commit">★</span><a`,
        );
        expect(former).toContain(
          `<span class="evtxt"><span class="green-star" role="img" aria-label="main-green was at this commit" title="main-green was at this commit">☆</span><a`,
        );
        expect(unmarked).toContain(`<span class="evtxt"><a`);
        expect(unmarked).not.toContain("green-star");
      });
    });
  });
});
