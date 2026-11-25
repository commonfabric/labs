import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type JobNews,
  jobNewsOf,
  JobTracker,
  newsOf,
  outcomeOf,
  type RunNews,
  runNewsOf,
} from "./runner-jobs.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CREATED = "2026-11-24T10:00:00Z";
const STARTED = "2026-11-24T10:05:00Z";

/** News of job `id` of run 100, queued for `ubuntu-latest`, but for `fields`. */
function jobNews(id: number, fields: Partial<JobNews> = {}): JobNews {
  return {
    kind: "job",
    id,
    runId: 100,
    attempt: 1,
    owner: "acme",
    repository: "labs",
    workflow: "CI",
    branch: "main",
    sha: SHA,
    name: "build",
    status: "queued",
    conclusion: null,
    labels: ["ubuntu-latest"],
    runner: null,
    runnerGroup: null,
    createdAt: CREATED,
    startedAt: null,
    url: `https://github.com/acme/labs/actions/runs/100/job/${id}`,
    ...fields,
  };
}

/** News of run `id`, in progress, but for `fields`. */
function runNews(id: number, fields: Partial<RunNews> = {}): RunNews {
  return {
    kind: "run",
    id,
    attempt: 1,
    status: "in_progress",
    conclusion: null,
    pullRequest: null,
    ...fields,
  };
}

/** News that job `id` of run 100 runs on `ci-mac-01-2`. */
function runningNews(id: number, fields: Partial<JobNews> = {}): JobNews {
  return jobNews(id, {
    status: "in_progress",
    labels: ["self-hosted", "cf-mac"],
    runner: "ci-mac-01-2",
    runnerGroup: "Default",
    startedAt: STARTED,
    ...fields,
  });
}

describe("runner-jobs", () => {
  describe("outcomeOf()", () => {
    it("returns `passed` for `success` and `neutral`", () => {
      expect(outcomeOf("success")).toBe("passed");
      expect(outcomeOf("neutral")).toBe("passed");
    });

    it("returns `failed` for each conclusion that means the job failed", () => {
      for (
        const conclusion of [
          "failure",
          "timed_out",
          "startup_failure",
          "action_required",
        ]
      ) {
        expect(outcomeOf(conclusion)).toBe("failed");
      }
    });

    it("returns `neither` for `cancelled`, `skipped`, and no conclusion", () => {
      expect(outcomeOf("cancelled")).toBe("neither");
      expect(outcomeOf("skipped")).toBe("neither");
      expect(outcomeOf(null)).toBe("neither");
    });
  });

  describe("JobTracker", () => {
    describe("instance members", () => {
      describe("jobs", () => {
        it("holds no jobs at first", () => {
          expect(new JobTracker().jobs.size).toBe(0);
        });
      });

      describe("take()", () => {
        it("holds a queued job, queued since it was made, with no runner", () => {
          const tracker = new JobTracker();

          expect(
            tracker.take(jobNews(1, { runner: "ci-mac-01-2", runnerGroup: "Default" })),
          ).toBe(true);
          expect(tracker.jobs.get(1)).toEqual({
            id: 1,
            runId: 100,
            attempt: 1,
            owner: "acme",
            repository: "labs",
            workflow: "CI",
            branch: "main",
            sha: SHA,
            name: "build",
            running: false,
            since: Date.parse(CREATED),
            labels: ["ubuntu-latest"],
            runner: null,
            runnerGroup: "Default",
            url: "https://github.com/acme/labs/actions/runs/100/job/1",
          });
        });

        it("holds the runner group a queued job asks for, or `null` when it asks for none", () => {
          const tracker = new JobTracker();

          tracker.take(jobNews(1, { labels: [], runnerGroup: "labs" }));
          tracker.take(jobNews(2, { runnerGroup: null }));
          tracker.take(jobNews(3, { runnerGroup: "" }));
          expect(tracker.jobs.get(1)?.runnerGroup).toBe("labs");
          expect(tracker.jobs.get(2)?.runnerGroup).toBeNull();
          expect(tracker.jobs.get(3)?.runnerGroup).toBeNull();
        });

        it("treats a `waiting` job as queued", () => {
          const tracker = new JobTracker();

          expect(tracker.take(jobNews(1, { status: "waiting" }))).toBe(true);
          expect(tracker.jobs.get(1)?.running).toBe(false);
        });

        it("moves a queued job to running, since it started, on its runner", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(1));

          expect(tracker.take(runningNews(1))).toBe(true);
          const job = tracker.jobs.get(1);
          expect(job?.running).toBe(true);
          expect(job?.since).toBe(Date.parse(STARTED));
          expect(job?.runner).toBe("ci-mac-01-2");
          expect(job?.runnerGroup).toBe("Default");
        });

        it("counts a running job that does not say when it started from when it was made", () => {
          const tracker = new JobTracker();

          tracker.take(runningNews(1, { startedAt: null }));
          expect(tracker.jobs.get(1)?.since).toBe(Date.parse(CREATED));
        });

        it("holds `null` as the time of a job that says neither when it was made nor started", () => {
          const tracker = new JobTracker();

          tracker.take(runningNews(1, { startedAt: null, createdAt: null }));
          expect(tracker.jobs.get(1)?.since).toBeNull();
        });

        it("holds `null` as the time of a job whose time does not parse", () => {
          const tracker = new JobTracker();

          tracker.take(jobNews(1, { createdAt: "yesterday-ish" }));
          tracker.take(runningNews(2, { startedAt: "soon", createdAt: "" }));
          tracker.take(jobNews(3));
          expect(tracker.jobs.get(1)?.since).toBeNull();
          expect(tracker.jobs.get(2)?.since).toBeNull();
          expect(tracker.jobs.get(3)?.since).toBe(Date.parse(CREATED));
        });

        it("holds `null` for an empty runner name and runner group", () => {
          const tracker = new JobTracker();

          tracker.take(runningNews(1, { runner: "", runnerGroup: "" }));
          expect(tracker.jobs.get(1)?.runner).toBeNull();
          expect(tracker.jobs.get(1)?.runnerGroup).toBeNull();
        });

        it("returns `false` and keeps a job running when news that it is queued comes after", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));

          expect(tracker.take(jobNews(1))).toBe(false);
          expect(tracker.take(jobNews(1, { status: "waiting" }))).toBe(false);
          expect(tracker.jobs.get(1)?.running).toBe(true);
          expect(tracker.jobs.get(1)?.runner).toBe("ci-mac-01-2");
        });

        it("takes news of a running job that moves it to another runner", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));

          expect(tracker.take(runningNews(1, { runner: "ci-mac-01-3" }))).toBe(true);
          expect(tracker.jobs.get(1)?.runner).toBe("ci-mac-01-3");
        });

        it("ends a held job that completes, returning `true`, and notes how it ended", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));

          expect(
            tracker.take(jobNews(1, { status: "completed", conclusion: "failure" })),
          ).toBe(true);
          expect(tracker.jobs.has(1)).toBe(false);
          expect(tracker.outcome(1)).toBe("failed");
        });

        it("returns `false` for a job not held that completes, but notes how it ended", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(2));

          expect(
            tracker.take(jobNews(1, { status: "completed", conclusion: "success" })),
          ).toBe(false);
          expect(tracker.outcome(1)).toBe("passed");
          expect([...tracker.jobs.keys()]).toEqual([2]);
        });

        it("returns `false` for news of a job after news that it ended", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(1, { status: "completed", conclusion: "cancelled" }));

          expect(tracker.take(runningNews(1))).toBe(false);
          expect(tracker.take(jobNews(1))).toBe(false);
          expect(tracker.jobs.size).toBe(0);
          expect(tracker.outcome(1)).toBe("neither");
        });

        it("drops the jobs of an earlier attempt when news of a later attempt of their run arrives", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));
          tracker.take(jobNews(2));
          tracker.take(jobNews(3, { runId: 200 }));

          expect(tracker.take(jobNews(4, { attempt: 2 }))).toBe(true);
          expect([...tracker.jobs.keys()].sort()).toEqual([3, 4]);
        });

        it("drops the jobs of an earlier attempt on news that their run is attempted again", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));
          tracker.take(jobNews(3, { runId: 200 }));

          tracker.take(runNews(100, { attempt: 2 }));
          expect([...tracker.jobs.keys()]).toEqual([3]);
        });

        it("returns `true` for news of a later attempt that drops the jobs of an earlier one", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(1));
          tracker.take(jobNews(3, { runId: 200 }));

          expect(tracker.take(runNews(100, { attempt: 2, status: "requested" }))).toBe(true);
          expect([...tracker.jobs.keys()]).toEqual([3]);
          expect(tracker.take(runningNews(4, { runId: 200, attempt: 1 }))).toBe(true);
          expect(
            tracker.take(jobNews(5, {
              runId: 200,
              attempt: 2,
              status: "completed",
              conclusion: "success",
            })),
          ).toBe(true);
          expect(tracker.jobs.size).toBe(0);
        });

        it("keeps the jobs of the attempt news is of, when it had not heard of their run's attempt", () => {
          const tracker = new JobTracker();
          const held = new JobTracker();
          held.take(jobNews(1, { attempt: 2 }));
          tracker.restore({ ...held.snapshot(), runs: [] });

          expect(tracker.take(jobNews(2, { attempt: 2 }))).toBe(true);
          expect([...tracker.jobs.keys()]).toEqual([1, 2]);
          expect(tracker.take(jobNews(3, { attempt: 3 }))).toBe(true);
          expect([...tracker.jobs.keys()]).toEqual([3]);
        });

        it("returns `false` for news of a later attempt of a run with no jobs held", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(3, { runId: 200 }));
          tracker.take(runNews(100));

          expect(tracker.take(runNews(100, { attempt: 2, status: "requested" }))).toBe(false);
          expect(
            tracker.take(jobNews(5, {
              runId: 100,
              attempt: 3,
              status: "completed",
              conclusion: "success",
            })),
          ).toBe(false);
          expect([...tracker.jobs.keys()]).toEqual([3]);
        });

        it("returns `false` for news of an earlier attempt than one heard of", () => {
          const tracker = new JobTracker();
          tracker.take(runNews(100, { attempt: 2 }));

          expect(tracker.take(jobNews(1, { attempt: 1 }))).toBe(false);
          expect(tracker.take(runNews(100, { attempt: 1, pullRequest: 7 }))).toBe(false);
          expect(tracker.jobs.size).toBe(0);
          expect(tracker.pullRequest(100)).toBeUndefined();
          expect(tracker.take(jobNews(2, { attempt: 2 }))).toBe(true);
        });

        it("ends every held job of a run that passes as passed", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));
          tracker.take(jobNews(2));
          tracker.take(jobNews(3, { runId: 200 }));

          expect(
            tracker.take(runNews(100, { status: "completed", conclusion: "success" })),
          ).toBe(true);
          expect([...tracker.jobs.keys()]).toEqual([3]);
          expect(tracker.outcome(1)).toBe("passed");
          expect(tracker.outcome(2)).toBe("passed");
          expect(tracker.outcome(3)).toBeUndefined();
        });

        it("ends every held job of a run that fails as neither, since nothing says they failed", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));

          expect(
            tracker.take(runNews(100, { status: "completed", conclusion: "failure" })),
          ).toBe(true);
          expect(tracker.jobs.size).toBe(0);
          expect(tracker.outcome(1)).toBe("neither");
        });

        it("returns `false` for a run that completes with none of its jobs held", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(3, { runId: 200 }));

          expect(
            tracker.take(runNews(100, { status: "completed", conclusion: "success" })),
          ).toBe(false);
          expect([...tracker.jobs.keys()]).toEqual([3]);
        });

        it("returns `false` for news of a run that has not completed", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(1));

          expect(tracker.take(runNews(100, { status: "queued" }))).toBe(false);
          expect([...tracker.jobs.keys()]).toEqual([1]);
        });

        it("returns `false` for news of a job of a run attempt that has completed", () => {
          const tracker = new JobTracker();
          tracker.take(runNews(100, { status: "completed", conclusion: "cancelled" }));

          expect(tracker.take(jobNews(1))).toBe(false);
          expect(tracker.take(runningNews(2))).toBe(false);
          expect(tracker.jobs.size).toBe(0);
        });

        it("holds jobs of the next attempt of a run whose earlier attempt completed", () => {
          const tracker = new JobTracker();
          tracker.take(runNews(100, { status: "completed", conclusion: "failure" }));

          expect(tracker.take(jobNews(1, { attempt: 2 }))).toBe(true);
          expect([...tracker.jobs.keys()]).toEqual([1]);
        });

        it("returns `true` for news that gives a run with jobs held a new pull request, and `false` otherwise", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(1));

          expect(tracker.take(runNews(100, { pullRequest: 12 }))).toBe(true);
          expect(tracker.take(runNews(100, { pullRequest: 12 }))).toBe(false);
          expect(tracker.take(runNews(100, { pullRequest: 13 }))).toBe(true);
          expect(tracker.take(runNews(100))).toBe(false);
          expect(tracker.pullRequest(100)).toBe(13);
          expect(tracker.take(runNews(200, { pullRequest: 14 }))).toBe(false);
          expect(tracker.pullRequest(200)).toBe(14);
        });

        it("notes the pull request a run is for, whatever its status", () => {
          const tracker = new JobTracker();

          tracker.take(runNews(100, { pullRequest: 12 }));
          tracker.take(runNews(200));
          expect(tracker.pullRequest(100)).toBe(12);
          expect(tracker.pullRequest(200)).toBeUndefined();
        });
      });

      describe("outcome()", () => {
        it("returns `undefined` for a job that has not ended", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(1));

          expect(tracker.outcome(1)).toBeUndefined();
        });
      });

      describe("pullRequest()", () => {
        it("returns `undefined` for a run nothing has been heard of", () => {
          expect(new JobTracker().pullRequest(100)).toBeUndefined();
        });
      });

      describe("replace()", () => {
        it("holds only the jobs of the news given, and still knows how jobs ended", () => {
          const tracker = new JobTracker();
          tracker.take(runningNews(1));
          tracker.take(jobNews(2, { status: "completed", conclusion: "failure" }));

          tracker.replace([jobNews(3, { runId: 200 }), runningNews(4, { runId: 300 })]);
          expect([...tracker.jobs.keys()].sort()).toEqual([3, 4]);
          expect(tracker.outcome(2)).toBe("failed");
          expect(tracker.take(runningNews(2))).toBe(false);
        });

        it("keeps the jobs `keep` picks out, and the attempts of their runs", () => {
          const tracker = new JobTracker();
          tracker.take(jobNews(1, { attempt: 2 }));
          tracker.take(jobNews(2, { runId: 200 }));

          tracker.replace([jobNews(3, { runId: 300 })], (job) => job.runId === 100);
          expect([...tracker.jobs.keys()]).toEqual([1, 3]);
          expect(tracker.take(jobNews(4, { attempt: 1 }))).toBe(false);
          expect(tracker.take(jobNews(5, { runId: 200, attempt: 1 }))).toBe(true);
          expect([...tracker.jobs.keys()]).toEqual([1, 3, 5]);
        });

        it("keeps which attempt of each run is the latest", () => {
          const tracker = new JobTracker();
          tracker.take(runNews(100, { attempt: 2 }));

          tracker.replace([jobNews(1, { attempt: 1 }), jobNews(2, { attempt: 2 })]);
          expect([...tracker.jobs.keys()]).toEqual([2]);
        });

        it("keeps which runs have finished, so that late news of a job of one is taken for nothing", () => {
          const tracker = new JobTracker();
          tracker.take(runNews(100, { status: "completed", conclusion: "success" }));

          tracker.replace([]);
          expect(tracker.take(jobNews(1))).toBe(false);
          expect(tracker.take(jobNews(2, { runId: 200 }))).toBe(true);
          expect([...tracker.jobs.keys()]).toEqual([2]);
        });
      });

      describe("snapshot()", () => {
        it("returns the jobs, runs, pull requests, and outcomes held", () => {
          const tracker = new JobTracker();
          tracker.take(runNews(100, { pullRequest: 12 }));
          tracker.take(jobNews(1));
          tracker.take(runNews(200, { status: "completed", conclusion: "success" }));
          tracker.take(jobNews(2, { runId: 300, status: "completed", conclusion: "failure" }));

          const snapshot = tracker.snapshot();
          expect(snapshot.jobs.map((job) => job.id)).toEqual([1]);
          expect(snapshot.runs).toEqual([[100, 1, 0], [200, 1, 1], [300, 1, 0]]);
          expect(snapshot.pullRequests).toEqual([[100, 12]]);
          expect(snapshot.outcomes).toEqual([[2, "failed"]]);
        });

        it("survives JSON unchanged", () => {
          const tracker = new JobTracker();
          tracker.take(runNews(100, { pullRequest: 12 }));
          tracker.take(runningNews(1));

          const snapshot = tracker.snapshot();
          expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
        });
      });

      describe("restore()", () => {
        it("holds what the snapshot held, and acts as the tracker it came from did", () => {
          const original = new JobTracker();
          original.take(runNews(100, { pullRequest: 12 }));
          original.take(runningNews(1));
          original.take(runNews(200, { status: "completed", conclusion: "success" }));
          original.take(jobNews(5, { runId: 300, status: "completed", conclusion: "failure" }));

          const restored = new JobTracker();
          restored.take(jobNews(9, { runId: 900 }));
          restored.restore(original.snapshot());
          expect(restored.snapshot()).toEqual(original.snapshot());
          expect([...restored.jobs.keys()]).toEqual([1]);
          expect(restored.pullRequest(100)).toBe(12);
          expect(restored.outcome(5)).toBe("failed");
          // Run 200 finished, so its jobs are refused; run 100 did not.
          expect(restored.take(jobNews(2, { runId: 200 }))).toBe(false);
          expect(restored.take(jobNews(3, { runId: 100 }))).toBe(true);
          // The job that ended stays ended.
          expect(restored.take(runningNews(5, { runId: 300 }))).toBe(false);
        });
      });
    });

    describe("static members", () => {
      describe("remembered", () => {
        it("is 4000", () => {
          expect(JobTracker.remembered).toBe(4000);
        });

        it("never forgets the attempt of a run with jobs held", () => {
          const tracker = new JobTracker();
          const limit = JobTracker.remembered + JobTracker.remembered / 5;
          tracker.take(jobNews(1, { runId: 1, attempt: 2 }));
          for (let id = 2; id <= limit + 1; id++) tracker.take(runNews(id));

          const runs = tracker.snapshot().runs.map(([run, attempt]) => [run, attempt]);
          expect(runs).toContainEqual([1, 2]);
          expect(runs.some(([run]) => run === 2)).toBe(false);
          expect([...tracker.jobs.keys()]).toEqual([1]);
          expect(tracker.take(jobNews(3, { runId: 1, attempt: 1 }))).toBe(false);
        });

        it("bounds the runs, pull requests, and outcomes held, forgetting the oldest", () => {
          // Nothing is forgotten until a fifth more than `remembered` are
          // held, and then everything but the newest `remembered` is.

          const tracker = new JobTracker();
          const most = JobTracker.remembered;
          const limit = most + most / 5;
          for (let id = 1; id <= limit; id++) {
            tracker.take(
              runNews(id, { pullRequest: id, status: "completed", conclusion: "success" }),
            );
            tracker.take(jobNews(id, { runId: id, status: "completed", conclusion: "success" }));
          }
          expect(tracker.snapshot().runs.length).toBe(limit);
          expect(tracker.outcome(1)).toBe("passed");

          tracker.take(runNews(limit + 1, {
            pullRequest: limit + 1,
            status: "completed",
            conclusion: "success",
          }));
          tracker.take(jobNews(limit + 1, {
            runId: limit + 1,
            status: "completed",
            conclusion: "success",
          }));
          const snapshot = tracker.snapshot();
          expect(snapshot.runs.length).toBe(most);
          expect(snapshot.runs.every(([, , finished]) => finished === 1)).toBe(true);
          expect(snapshot.pullRequests.length).toBe(most);
          expect(snapshot.outcomes.length).toBe(most);
          const oldest = limit + 1 - most + 1;
          expect(tracker.pullRequest(oldest - 1)).toBeUndefined();
          expect(tracker.pullRequest(oldest)).toBe(oldest);
          expect(tracker.outcome(oldest - 1)).toBeUndefined();
          expect(tracker.outcome(oldest)).toBe("passed");
        });
      });
    });
  });

  describe("jobNewsOf()", () => {
    it("reads a job as a `workflow_job` delivery describes it", () => {
      expect(jobNewsOf({
        id: 1,
        run_id: 100,
        run_attempt: 2,
        workflow_name: "CI",
        head_branch: "main",
        head_sha: SHA,
        name: "build",
        status: "in_progress",
        conclusion: null,
        labels: ["self-hosted", 7, "cf-mac"],
        runner_name: "ci-mac-01-2",
        runner_group_name: "Default",
        created_at: CREATED,
        started_at: STARTED,
        html_url: "https://github.com/acme/labs/actions/runs/100/job/1",
      }, "acme/labs")).toEqual({
        kind: "job",
        id: 1,
        runId: 100,
        attempt: 2,
        owner: "acme",
        repository: "labs",
        workflow: "CI",
        branch: "main",
        sha: SHA,
        name: "build",
        status: "in_progress",
        conclusion: null,
        labels: ["self-hosted", "cf-mac"],
        runner: "ci-mac-01-2",
        runnerGroup: "Default",
        createdAt: CREATED,
        startedAt: STARTED,
        url: "https://github.com/acme/labs/actions/runs/100/job/1",
      });
    });

    it("fills in what a job does not say, linking to its run", () => {
      expect(jobNewsOf({
        id: 1,
        run_id: 100,
        run_attempt: 1,
        name: "build",
        status: "completed",
        conclusion: "success",
        labels: [],
      }, "acme/labs")).toEqual({
        kind: "job",
        id: 1,
        runId: 100,
        attempt: 1,
        owner: "acme",
        repository: "labs",
        workflow: "",
        branch: "",
        sha: "",
        name: "build",
        status: "completed",
        conclusion: "success",
        labels: [],
        runner: null,
        runnerGroup: null,
        createdAt: null,
        startedAt: null,
        url: "https://github.com/acme/labs/actions/runs/100",
      });
    });

    it("returns `undefined` for something that is not a job", () => {
      const job = {
        id: 1,
        run_id: 100,
        run_attempt: 1,
        name: "build",
        status: "queued",
        labels: ["ubuntu-latest"],
      };
      expect(jobNewsOf(job, "acme/labs")).toBeDefined();
      expect(jobNewsOf(null, "acme/labs")).toBeUndefined();
      expect(jobNewsOf([job], "acme/labs")).toBeUndefined();
      expect(jobNewsOf({ ...job, id: "1" }, "acme/labs")).toBeUndefined();
      expect(jobNewsOf({ ...job, run_id: undefined }, "acme/labs")).toBeUndefined();
      expect(jobNewsOf({ ...job, name: 3 }, "acme/labs")).toBeUndefined();
      expect(jobNewsOf({ ...job, status: null }, "acme/labs")).toBeUndefined();
    });

    it("returns `undefined` for a job that does not say its attempt", () => {
      const job = { id: 1, run_id: 100, name: "build", status: "queued", labels: [] };
      expect(jobNewsOf({ ...job, run_attempt: 2 }, "acme/labs")?.attempt).toBe(2);
      expect(jobNewsOf(job, "acme/labs")).toBeUndefined();
      expect(jobNewsOf({ ...job, run_attempt: "2" }, "acme/labs")).toBeUndefined();
    });

    it("returns `undefined` for a job whose labels are not a list", () => {
      const job = { id: 1, run_id: 100, run_attempt: 1, name: "build", status: "queued" };
      expect(jobNewsOf({ ...job, labels: [] }, "acme/labs")?.labels).toEqual([]);
      expect(jobNewsOf(job, "acme/labs")).toBeUndefined();
      expect(jobNewsOf({ ...job, labels: "ubuntu-latest" }, "acme/labs")).toBeUndefined();
    });

    it("returns `undefined` for a repository name without its owner's", () => {
      expect(
        jobNewsOf(
          { id: 1, run_id: 100, run_attempt: 1, name: "build", status: "queued", labels: [] },
          "labs",
        ),
      ).toBeUndefined();
    });
  });

  describe("runNewsOf()", () => {
    it("reads a run as a `workflow_run` delivery describes it, with its first pull request", () => {
      expect(runNewsOf({
        id: 100,
        run_attempt: 3,
        status: "completed",
        conclusion: "failure",
        pull_requests: ["12", { number: 12 }, { number: 13 }],
      })).toEqual({
        kind: "run",
        id: 100,
        attempt: 3,
        status: "completed",
        conclusion: "failure",
        pullRequest: 12,
      });
    });

    it("fills in what a run does not say", () => {
      expect(runNewsOf({ id: 100, status: "queued", conclusion: 1 })).toEqual({
        kind: "run",
        id: 100,
        attempt: 1,
        status: "queued",
        conclusion: null,
        pullRequest: null,
      });
      expect(runNewsOf({ id: 100, status: "queued", pull_requests: [] })?.pullRequest)
        .toBeNull();
      expect(
        runNewsOf({ id: 100, status: "queued", pull_requests: [{ number: "12" }] })
          ?.pullRequest,
      ).toBeNull();
    });

    it("returns `undefined` for something that is not a run", () => {
      expect(runNewsOf({ id: 100, status: "queued" })).toBeDefined();
      expect(runNewsOf("run")).toBeUndefined();
      expect(runNewsOf({ id: "100", status: "queued" })).toBeUndefined();
      expect(runNewsOf({ id: 100 })).toBeUndefined();
    });
  });

  describe("newsOf()", () => {
    const repository = { full_name: "acme/labs" };

    it("reads the job of a `workflow_job` delivery in the delivery's repository", () => {
      const news = newsOf("workflow_job", {
        repository,
        workflow_job: {
          id: 1,
          run_id: 100,
          run_attempt: 1,
          name: "build",
          status: "queued",
          labels: ["ubuntu-latest"],
        },
      });
      expect(news?.kind).toBe("job");
      expect(news?.id).toBe(1);
      expect(news?.kind === "job" ? [news.owner, news.repository] : []).toEqual(["acme", "labs"]);
    });

    it("reads the run of a `workflow_run` delivery", () => {
      expect(newsOf("workflow_run", {
        repository,
        workflow_run: { id: 100, status: "completed", conclusion: "success" },
      })).toEqual({
        kind: "run",
        id: 100,
        attempt: 1,
        status: "completed",
        conclusion: "success",
        pullRequest: null,
      });
    });

    it("returns `undefined` for a delivery of another event", () => {
      expect(newsOf("push", { repository, workflow_run: { id: 100, status: "completed" } }))
        .toBeUndefined();
    });

    it("returns `undefined` for a delivery without a repository named in full", () => {
      const workflow_run = { id: 100, status: "completed" };
      expect(newsOf("workflow_run", null)).toBeUndefined();
      expect(newsOf("workflow_run", { workflow_run })).toBeUndefined();
      expect(newsOf("workflow_run", { repository: "acme/labs", workflow_run })).toBeUndefined();
      expect(newsOf("workflow_run", { repository: { name: "labs" }, workflow_run }))
        .toBeUndefined();
    });

    it("returns `undefined` for a delivery whose job or run does not have its shape", () => {
      expect(newsOf("workflow_job", { repository, workflow_job: { id: 1 } })).toBeUndefined();
      expect(newsOf("workflow_run", { repository })).toBeUndefined();
    });
  });
});
