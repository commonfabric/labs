import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CompletedAttempts } from "../completed-attempts.ts";
import type { Run } from "../types.ts";
import { byUrl, type GithubAnswer, withGithubAttempt } from "./github-attempts.ts";

const REPO = "example/repo";

/** A run of `REPO` whose latest attempt is `attempts`, completed with `conclusion`. */
function run(attempts: number, conclusion = "success"): Run {
  const at = new Date(Date.UTC(2026, 9, 22, 15)).toISOString();
  return {
    id: 7,
    status: "completed",
    conclusion,
    run_attempt: attempts,
    event: "push",
    head_sha: "sha",
    display_title: "t",
    created_at: at,
    run_started_at: at,
    updated_at: at,
    html_url: "",
    head_commit: null,
  };
}

/**
 * Attempt `attempt` of `of`, as GitHub returns one it left in progress without
 * a conclusion.
 */
function inProgress(of: Run, attempt: number): Run {
  return { ...of, run_attempt: attempt, status: "in_progress", conclusion: null };
}

function attemptUrl(of: Run, attempt: number): string {
  return `https://api.github.com/repos/${REPO}/actions/runs/${of.id}/attempts/${attempt}`;
}

function jobsUrl(of: Run, attempt: number): string {
  return `${attemptUrl(of, attempt)}/jobs?per_page=100&page=1`;
}

/** A job listing holding one job for each of `conclusions`, run on a runner. */
function listing(conclusions: readonly (string | null)[]): GithubAnswer {
  return {
    total_count: conclusions.length,
    jobs: conclusions.map((conclusion, id) => ({
      id,
      conclusion,
      runner_name: "GitHub Actions 1",
    })),
  };
}

describe("CompletedAttempts", () => {
  describe("instance members", () => {
    describe("get()", () => {
      it("returns an earlier attempt GitHub left in progress as completed with the conclusion its jobs give it", async () => {
        const cases: { jobs: string[]; conclusion: string }[] = [
          { jobs: ["success", "skipped"], conclusion: "success" },
          { jobs: ["success", "failure", "cancelled"], conclusion: "failure" },
          { jobs: ["success", "timed_out"], conclusion: "failure" },
          { jobs: ["neutral"], conclusion: "failure" },
          { jobs: ["success", "cancelled"], conclusion: "cancelled" },
          { jobs: [], conclusion: "cancelled" },
        ];
        for (const { jobs, conclusion } of cases) {
          const rerun = run(2);
          const first = inProgress(rerun, 1);
          const attempt = await withGithubAttempt(
            byUrl([
              [attemptUrl(rerun, 1), first],
              [jobsUrl(rerun, 1), listing(jobs)],
            ]),
            () => new CompletedAttempts(REPO).get(rerun, 1),
          );
          expect({ jobs, status: attempt.status, conclusion: attempt.conclusion })
            .toEqual({ jobs, status: "completed", conclusion });
        }
      });

      it("requests such an attempt and its job listing once, however often either is read", async () => {
        const rerun = run(2);
        const attempts = new CompletedAttempts(REPO);
        const urls = await withGithubAttempt(
          byUrl([
            [attemptUrl(rerun, 1), inProgress(rerun, 1)],
            // A job a newer run replaced while it was queued, which no runner
            // picked up.
            [jobsUrl(rerun, 1), {
              total_count: 1,
              jobs: [{ id: 1, conclusion: "cancelled", runner_name: "" }],
            }],
          ]),
          async (urls) => {
            const first = await attempts.get(rerun, 1);
            expect(await attempts.get(rerun, 1)).toBe(first);
            expect(await attempts.cancelledWithoutVerdict(first)).toBe(true);
            expect(await attempts.jobCounts(first)).toEqual({ ran: 1, skipped: 0 });
            return urls;
          },
        );
        expect(urls).toEqual([attemptUrl(rerun, 1), jobsUrl(rerun, 1)]);
      });

      it("rejects an earlier attempt GitHub left in progress that lists a job that has not ended", async () => {
        const rerun = run(2);
        await withGithubAttempt(
          byUrl([
            [attemptUrl(rerun, 1), inProgress(rerun, 1)],
            [jobsUrl(rerun, 1), listing(["success", null])],
          ]),
          async () => {
            await expect(new CompletedAttempts(REPO).get(rerun, 1)).rejects
              .toThrow("lists job 1, which has not ended");
          },
        );
      });

      it("rejects the latest attempt GitHub returns other than completed with a conclusion, without reading its jobs", async () => {
        // A run listed as completed whose attempt endpoint says otherwise has
        // no later attempt to show that this one ended.
        const listed = run(1);
        const answers = [
          inProgress(listed, 1),
          { ...inProgress(listed, 1), conclusion: "success" },
          { ...listed, conclusion: null },
        ];
        for (const answer of answers) {
          const urls = await withGithubAttempt(answer, async (urls) => {
            await expect(new CompletedAttempts(REPO).get(listed, 1)).rejects
              .toThrow("did not include a completed conclusion");
            return urls;
          });
          expect(urls).toEqual([attemptUrl(listed, 1)]);
        }
      });

      it("returns an earlier attempt GitHub gives a conclusion as it is, without reading its jobs", async () => {
        const rerun = run(2);
        const first = { ...inProgress(rerun, 1), conclusion: "failure" };
        const urls = await withGithubAttempt(first, async (urls) => {
          const attempt = await new CompletedAttempts(REPO).get(rerun, 1);
          expect(attempt.conclusion).toBe("failure");
          return urls;
        });
        expect(urls).toEqual([attemptUrl(rerun, 1)]);
      });

      it("rejects an answer for another run or another attempt", async () => {
        const rerun = run(3);
        for (const answer of [{ ...run(1), id: 8 }, run(2)]) {
          await withGithubAttempt(answer, async () => {
            await expect(new CompletedAttempts(REPO).get(rerun, 1)).rejects
              .toThrow("when asked for run 7 attempt 1");
          });
        }
      });
    });
  });
});
