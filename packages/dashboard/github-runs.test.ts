import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join, relative, SEPARATOR } from "@std/path";
import { walk } from "@std/fs/walk";
import { FakeTime } from "@std/testing/time";
import { type GitHubRun, RunLists, type RunReading } from "./github-runs.ts";
import {
  type GitHubRequestOptions,
  GitHubStatusError,
  RUN_LIST_ACCESS,
} from "./lib.ts";

const REPO = "example/repo";
const WORKFLOW = "ci.yml";

/** Long enough for a reading to read the top of the list again. */
const HEAD_REUSE_MS = 20_001;

/** A completed, successful push to main, created `id` seconds into 2026. */
function run(id: number, fields: Partial<GitHubRun> = {}): GitHubRun {
  const at = new Date(Date.UTC(2026, 0, 1) + id * 1_000).toISOString();
  return {
    id,
    event: "push",
    head_branch: "main",
    head_sha: `sha${id}`,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    display_title: `run ${id}`,
    created_at: at,
    run_started_at: at,
    updated_at: at,
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    head_commit: null,
    ...fields,
  };
}

/** Runs `from` down to `to`, newest first. */
function runs(from: number, to: number): GitHubRun[] {
  return Array.from({ length: from - to + 1 }, (_, i) => run(from - i));
}

/**
 * GitHub as far as its run lists and its runs: an unfiltered list that is
 * current, a filtered list that answers whatever it was last set to, and each
 * run by its id.
 */
class FakeGitHub {
  /** The workflow's runs, newest first. */
  list: GitHubRun[];
  /** What every filtered list answers. */
  filtered: GitHubRun[] = [];
  /** Every path requested, in order. */
  paths: string[] = [];
  /**
   * Called before each request is answered, with how many requests have been
   * made, so that a test can change the list between two requests.
   */
  before: (requests: number) => void = () => {};

  constructor(list: GitHubRun[]) {
    this.list = list;
  }

  /** The page requests made, as `page@size`. */
  get pages(): string[] {
    return this.paths.flatMap((path) => {
      const query = new URL(path, "https://api.github.com/").searchParams;
      return query.has("page") && !query.has("branch")
        ? [`${query.get("page")}@${query.get("per_page")}`]
        : [];
    });
  }

  /** The runs read by their ids. */
  get byId(): number[] {
    return this.paths.flatMap((path) => {
      const match = path.match(/\/actions\/runs\/(\d+)$/);
      return match ? [Number(match[1])] : [];
    });
  }

  request = <T>(path: string, options: GitHubRequestOptions): Promise<T> => {
    this.paths.push(path);
    this.before(this.paths.length);
    const url = new URL(path, "https://api.github.com/");
    const id = path.match(/\/actions\/runs\/(\d+)$/);
    if (id) {
      const found = this.list.find((held) => held.id === Number(id[1]));
      if (!found) {
        return Promise.reject(
          new GitHubStatusError(`GitHub API ${path} failed: HTTP 404`, 404),
        );
      }
      return Promise.resolve(found as T);
    }
    if (options.runListAccess !== RUN_LIST_ACCESS) {
      return Promise.reject(new Error(`no run list access for ${path}`));
    }
    const query = url.searchParams;
    if (query.has("branch") || query.has("event") || query.has("status")) {
      const size = Number(query.get("per_page"));
      const start = (Number(query.get("page")) - 1) * size;
      return Promise.resolve(
        { workflow_runs: this.filtered.slice(start, start + size) } as T,
      );
    }
    const size = Number(query.get("per_page"));
    const start = (Number(query.get("page")) - 1) * size;
    return Promise.resolve(
      { workflow_runs: this.list.slice(start, start + size) } as T,
    );
  };
}

/** Reads `github`'s workflow through `lists`, for `reading`. */
function read(
  lists: RunLists,
  github: FakeGitHub,
  reading: Partial<RunReading> = {},
): Promise<GitHubRun[]> {
  return lists.runs(github.request, REPO, WORKFLOW, {
    reader: "reader",
    recheck: [],
    wants: () => true,
    until: () => false,
    ...reading,
  });
}

const ids = (list: readonly GitHubRun[]) => list.map((held) => held.id);

/** A generator of numbers in [0, 1), the same for the same `seed`. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("github-runs", () => {
  describe("RunLists", () => {
    describe("instance members", () => {
      describe("runs()", () => {
        it("returns the runs from the newest down to the one `until` stops at", async () => {
          const github = new FakeGitHub(runs(50, 1));

          const read1 = await read(new RunLists(), github, {
            until: (held) => held.id === 45,
          });

          expect(ids(read1)).toEqual([50, 49, 48, 47, 46, 45]);
          expect(github.pages).toEqual(["1@20"]);
        });

        it("returns every run when `until` stops at none, reading each page once", async () => {
          const github = new FakeGitHub(runs(250, 1));

          const read1 = await read(new RunLists(), github);

          expect(ids(read1)).toEqual(ids(runs(250, 1)));
          // After the first page, each page read holds the last run held and
          // as many runs after it as a page of up to 100 can.
          expect(github.pages).toEqual(["1@20", "1@100", "2@99", "3@98"]);
        });

        it("reads only the top of the list once the runs below it are held", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(250, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 10 });
          github.paths = [];
          github.list = runs(253, 1);
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            until: (held) => held.id === 10,
          });

          expect(ids(read2)).toEqual(ids(runs(253, 10)));
          expect(github.pages).toEqual(["1@20"]);
        });

        it("reads the top of the list a page at a time until it reaches a run held", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(30, 1));
          const lists = new RunLists();
          await read(lists, github, {
            newest: 10,
            until: (held) => held.id === 21,
          });
          github.paths = [];
          github.list = runs(260, 1);
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            newest: 100,
            until: (held) => held.id === 21,
          });

          expect(ids(read2)).toEqual(ids(runs(260, 21)));
          expect(github.pages).toEqual(["1@100", "2@99", "3@98"]);
        });

        it("drops a held run that the top of the list no longer carries", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            newest: 100,
            until: (held) => held.id === 250,
          });
          github.list = runs(301, 1).filter((held) => held.id !== 290);
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            until: (held) => held.id === 250,
          });

          expect(ids(read2)).toEqual(
            ids(runs(301, 250)).filter((id) => id !== 290),
          );
        });

        it("reads on from the last run held when runs have landed above it", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "shallow",
            newest: 100,
            until: (held) => held.id === 201,
          });
          // The runs land after the top of the list was read, so the last
          // run held has moved further down the list than its place in the
          // runs held.
          github.list = runs(450, 1);

          const deep = await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 51,
          });

          expect(ids(deep)).toEqual(ids(runs(300, 51)));
        });

        it("reads on from the last run held when runs above it have been deleted", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "shallow",
            newest: 100,
            until: (held) => held.id === 201,
          });
          github.list = runs(300, 1).filter((held) =>
            held.id > 250 || held.id <= 210
          );

          const deep = await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 51,
          });

          // The deleted runs above the last run held are still held, since
          // this reading reads none of the list above that run.
          expect(ids(deep)).toEqual(ids(runs(300, 51)));
        });

        it("keeps the top of the list newest first when a run lands between its pages", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(100, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 81 });
          github.list = runs(250, 1);
          // One more run lands after the first page of the next read.
          github.before = (requests) => {
            if (requests === 2) github.list = runs(251, 1);
          };
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            until: (held) => held.id === 81,
          });

          expect(ids(read2)).toEqual(ids(runs(250, 81)));
        });

        it("loses no run when one is deleted between the pages of a read of the top", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(100, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 51 });
          github.list = runs(250, 1);
          // Run 200 is deleted after the first page of the next read.
          github.paths = [];
          github.before = (requests) => {
            if (requests === 2) {
              github.list = github.list.filter((held) => held.id !== 200);
            }
          };
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            newest: 100,
            until: (held) => held.id === 51,
          });

          // Run 200 was read before it was deleted, so it is still held; what
          // matters is that the runs after it are all there.
          expect(ids(read2)).toEqual(ids(runs(250, 51)));
        });

        it("loses no run when runs are deleted and land between the pages read below the head", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "shallow",
            newest: 100,
            until: (held) => held.id === 201,
          });
          // Deleted runs move the last run held up the list, and the runs
          // that land after the first page read move it back down.
          github.list = runs(300, 1).filter((held) =>
            held.id > 260 || held.id <= 250
          );
          github.paths = [];
          github.before = (requests) => {
            if (requests === 2) {
              github.list = [...runs(315, 301), ...github.list];
            }
          };

          const deep = await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 51,
          });

          expect(ids(deep).filter((id) => id < 201)).toEqual(
            ids(runs(200, 51)),
          );
        });

        it("drops a run below the head deleted as the list is read down", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "shallow",
            newest: 100,
            until: (held) => held.id === 201,
          });
          github.list = runs(300, 1).filter((held) => held.id !== 201);

          const deep = await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 151,
          });

          expect(ids(deep)).toEqual(
            ids(runs(300, 151)).filter((id) => id !== 201),
          );
        });

        it("drops a held run that is gone when it reads it again", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub([
            ...runs(250, 31),
            run(30, { status: "queued", conclusion: null }),
            ...runs(29, 1),
          ]);
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 1 });
          github.list = github.list.filter((held) => held.id !== 30);
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            until: (held) => held.id === 1,
          });

          expect(ids(read2)).toEqual(
            ids(runs(250, 1)).filter((id) => id !== 30),
          );
        });

        it("reads on past the run `until` stops at under `confirmStop` when it is gone", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(250, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 40 });
          github.list = github.list.filter((held) => held.id !== 40);
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            confirmStop: true,
            until: (held) => held.id <= 40,
          });

          expect(ids(read2)).toEqual(
            ids(runs(250, 39)).filter((id) => id !== 40),
          );
        });

        it("drops held runs a read of the top shows deleted from the end of the list", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(30, 1));
          const lists = new RunLists();
          await read(lists, github);
          github.list = runs(30, 11);
          time.tick(HEAD_REUSE_MS);

          expect(ids(await read(lists, github, { newest: 100 }))).toEqual(
            ids(runs(30, 11)),
          );
        });

        it("goes on without a filtered list that cannot be read, and reads it on the next reading", async () => {
          const github = new FakeGitHub(runs(30, 1));
          const request = github.request;
          let failing = true;
          github.request = <T>(
            path: string,
            options: GitHubRequestOptions,
          ): Promise<T> =>
            failing && path.includes("branch=")
              ? Promise.reject(new Error("HTTP 502"))
              : request<T>(path, options);
          const lists = new RunLists();
          const logged: string[] = [];
          const realError = console.error;
          console.error = (...parts: unknown[]) =>
            logged.push(parts.map(String).join(" "));
          try {
            const read1 = await read(lists, github, {
              recheck: [{ branch: "main" }],
            });
            expect(ids(read1)).toEqual(ids(runs(30, 1)));
          } finally {
            console.error = realError;
          }
          expect(logged.length).toBe(1);
          failing = false;
          github.paths = [];

          await read(lists, github, { recheck: [{ branch: "main" }] });

          expect(github.paths.some((path) => path.includes("branch="))).toBe(
            true,
          );
        });

        it("shares one read of each filtered list among readings made close together", async () => {
          const github = new FakeGitHub(runs(30, 1));
          const lists = new RunLists();
          const recheck = [{ branch: "main" }];
          await read(lists, github, { reader: "first", recheck });
          github.paths = [];

          await read(lists, github, { reader: "second", recheck });
          await read(lists, github, {
            reader: "third",
            recheck: [{ event: "pull_request" }],
          });

          expect(github.paths.map((path) => path.split("?")[1])).toEqual([
            "event=pull_request&per_page=100&page=1",
          ]);
        });

        it("keeps knowing where the list ends once it has read to its end", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github);
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github);

          expect(ids(read2)).toEqual(ids(runs(300, 1)));
          expect(github.pages).toEqual(["1@20"]);
        });

        it("offers no more than `limit` runs", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const offered: number[] = [];

          const read1 = await read(new RunLists(), github, {
            limit: 150,
            until: (held) => {
              offered.push(held.id);
              return false;
            },
          });

          expect(ids(read1)).toEqual(ids(runs(300, 151)));
          expect(offered.length).toBe(150);
        });

        it("rejects a `limit` that is not a whole number from 1", async () => {
          const github = new FakeGitHub(runs(30, 1));

          for (const limit of [0, -1, 2.5]) {
            await expect(read(new RunLists(), github, { limit })).rejects
              .toThrow("limit must be a whole number from 1");
          }
          expect(github.paths).toEqual([]);
        });

        it("rejects a read of the top that leaves out the newest run held while it still exists", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 250 });
          // The list comes back as it stood days ago, though run 300 is
          // still there to be read by its id.
          const current = github.list;
          const request = github.request;
          github.request = <T>(
            path: string,
            options: GitHubRequestOptions,
          ): Promise<T> => {
            github.list = path.includes("/workflows/")
              ? runs(280, 1)
              : current;
            return request<T>(path, options);
          };
          time.tick(HEAD_REUSE_MS);

          const stale = read(lists, github, {
            until: (held) => held.id === 250,
          });

          await expect(stale).rejects.toThrow("the list is behind");
        });

        it("rejects a walk from the top that passes the newest run held while it still exists", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 250 });
          // A hundred runs land, and the list comes back without run 300,
          // though it is still there to be read by its id.
          const current = runs(400, 1);
          const request = github.request;
          github.request = <T>(
            path: string,
            options: GitHubRequestOptions,
          ): Promise<T> => {
            github.list = path.includes("/workflows/")
              ? current.filter((held) => held.id !== 300)
              : current;
            return request<T>(path, options);
          };
          time.tick(HEAD_REUSE_MS);

          const stale = read(lists, github, {
            until: (held) => held.id === 250,
          });

          await expect(stale).rejects.toThrow("the list is behind");
        });

        it("accepts a read of the top that leaves out the newest run held once it is deleted", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 250 });
          github.list = runs(280, 1);
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            until: (held) => held.id === 250,
          });

          expect(ids(read2)).toEqual(ids(runs(280, 250)));
        });

        it("rejects a `newest` outside 1 to 100", async () => {
          const github = new FakeGitHub(runs(30, 1));

          for (const newest of [0, 101, 2.5]) {
            await expect(read(new RunLists(), github, { newest })).rejects
              .toThrow("newest must be 1 to 100");
          }
          expect(github.paths).toEqual([]);
        });

        it("rechecks the runs it holds before it offers them", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub([
            ...runs(250, 41),
            run(40, { conclusion: "failure" }),
            ...runs(39, 1),
          ]);
          const lists = new RunLists();
          const failed = (held: GitHubRun) => held.conclusion === "failure";
          expect(ids(await read(lists, github, { until: failed })).at(-1))
            .toBe(40);
          // Run 40 is run again and passes, below the top of the list.
          const passed = run(40, {
            run_attempt: 2,
            updated_at: "2026-02-01T00:00:00Z",
          });
          github.list = github.list.map((held) =>
            held.id === 40 ? passed : held
          );
          github.filtered = [passed];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            recheck: [{ branch: "main" }],
            until: failed,
          });

          expect(ids(read2)).toEqual(ids(runs(250, 1)));
        });

        it("stops keeping runs for a reader that has not read for a day", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 1,
          });
          // The shallow reader goes on reading through the day, so the
          // workflow is still read while the deep reader is not.
          const shallow = () =>
            read(lists, github, {
              reader: "shallow",
              until: (held) => held.id === 290,
            });
          time.tick(43_200_000);
          await shallow();
          time.tick(43_200_001);
          await shallow();
          github.paths = [];

          await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 1,
          });

          // The head was cut back to the shallow reader's depth, so the deep
          // reader reads the rest of the list again.
          expect(github.pages).toEqual(["1@100", "2@99", "3@98", "4@97"]);
        });

        it("forgets a workflow nobody has read for a day", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 1 });
          time.tick(86_400_001);
          github.paths = [];

          await read(lists, github, { until: (held) => held.id === 1 });

          // The whole list is read again, as it was the first time.
          expect(github.pages).toEqual([
            "1@20",
            "1@100",
            "2@99",
            "3@98",
            "4@97",
          ]);
        });

        it("rejects a reading whose read of a run by its id fails other than as deleted", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub([
            ...runs(250, 31),
            run(30, { status: "queued", conclusion: null }),
            ...runs(29, 1),
          ]);
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 1 });
          const request = github.request;
          github.request = <T>(
            path: string,
            options: GitHubRequestOptions,
          ): Promise<T> =>
            path.endsWith("/actions/runs/30")
              ? Promise.reject(
                new GitHubStatusError(`GitHub API ${path}: HTTP 502`, 502),
              )
              : request<T>(path, options);
          time.tick(HEAD_REUSE_MS);

          await expect(read(lists, github, { until: (held) => held.id === 1 }))
            .rejects.toThrow("HTTP 502");
        });

        it("drops the held runs a page shows are past the end of the list", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "shallow",
            newest: 100,
            until: (held) => held.id === 201,
          });
          github.list = runs(300, 251);

          const deep = await read(lists, github, { reader: "deep" });

          expect(ids(deep)).toEqual(ids(runs(300, 251)));
        });

        it("drops every held run once the list is empty", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "shallow",
            newest: 100,
            until: (held) => held.id === 201,
          });
          github.list = [];

          expect(await read(lists, github, { reader: "deep" })).toEqual([]);
        });

        it("returns only the runs the reader wants, and counts them against `limit`", async () => {
          const github = new FakeGitHub(
            runs(300, 1).map((held) =>
              held.id % 3 === 0 ? held : run(held.id, { head_branch: "x" })
            ),
          );

          const read1 = await read(new RunLists(), github, {
            wants: (held) => held.head_branch === "main",
            limit: 50,
          });

          expect(ids(read1)).toEqual(
            ids(runs(300, 1)).filter((id) => id % 3 === 0).slice(0, 50),
          );
        });

        it("reads again only the unfinished runs the reader wants", async () => {
          using time = new FakeTime();
          const stuck = (id: number, head_branch: string) =>
            run(id, { status: "queued", conclusion: null, head_branch });
          const github = new FakeGitHub([
            ...runs(250, 41),
            stuck(40, "feature"),
            stuck(39, "main"),
            ...runs(38, 1),
          ]);
          const lists = new RunLists();
          const wants = (held: GitHubRun) => held.head_branch === "main";
          await read(lists, github, { wants });
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          await read(lists, github, { wants });

          expect(github.byId).toEqual([39]);
        });

        it("reads a filtered list down to the oldest run held to find runs started again", async () => {
          // A day after the runs were created, well inside the thirty days
          // GitHub lets a run be started again.
          using time = new FakeTime(Date.UTC(2026, 0, 2));
          const github = new FakeGitHub(runs(400, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 101 });
          // Run 150 is started again and passes; the filtered list holds
          // every run, newest first, so it names run 150 on its third page.
          const again = run(150, {
            run_attempt: 2,
            updated_at: "2026-02-01T00:00:00Z",
          });
          github.list = github.list.map((held) =>
            held.id === 150 ? again : held
          );
          github.filtered = github.list;
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            recheck: [{ branch: "main" }],
            until: (held) => held.id === 101,
          });

          expect(read2.find((held) => held.id === 150)?.run_attempt).toBe(2);
          expect(
            github.paths.filter((path) => path.includes("branch=")).length,
          ).toBe(3);
        });

        it("starts the head again when every run it held has been deleted", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(5000, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 4990 });
          github.list = [
            ...runs(5005, 5001),
            ...runs(5000, 1).filter((held) => held.id < 4000),
          ];
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            until: (held) => held.id === 3990,
          });

          expect(ids(read2)).toEqual([
            ...ids(runs(5005, 5001)),
            ...ids(runs(3999, 3990)),
          ]);
          expect(github.pages.length).toBeLessThanOrEqual(2);
        });

        it("walks up the list a page at a time when runs above the last run held were deleted", async () => {
          const github = new FakeGitHub(runs(2000, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "shallow",
            until: (held) => held.id === 1001,
          });
          // Five hundred runs above the last run held are deleted, which
          // moves it five pages up the list.
          github.list = runs(2000, 1).filter((held) =>
            held.id > 1500 || held.id <= 1001
          );
          github.paths = [];

          const deep = await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 901,
          });

          expect(ids(deep).filter((id) => id <= 1001)).toEqual(
            ids(runs(1001, 901)),
          );
          expect(github.pages.length).toBeLessThanOrEqual(8);
        });

        it("loses, repeats, and misorders no run while runs land and are deleted between requests", async () => {
          // Two hundred seeded schedules of landings and deletions, each
          // over five readings to random depths by two readers. A run that
          // was in the list for the whole of a reading, and is no older than
          // the last run the reading returned, has to be among the runs it
          // returned.
          for (let seed = 1; seed <= 200; seed++) {
            using time = new FakeTime();
            const random = seeded(seed);
            let next = 3001;
            const github = new FakeGitHub(runs(3000, 1));
            const lists = new RunLists();
            for (let reading = 0; reading < 5; reading++) {
              const before = ids(github.list);
              github.before = () => {
                if (random() < 0.5) {
                  const landed = Math.floor(random() * 30);
                  github.list = [
                    ...runs(next + landed - 1, next),
                    ...github.list,
                  ];
                  next += landed;
                }
                if (random() < 0.5) {
                  const deleted = new Set(
                    Array.from(
                      { length: Math.floor(random() * 20) },
                      () => Math.floor(random() * github.list.length),
                    ),
                  );
                  github.list = github.list.filter((_, i) => !deleted.has(i));
                }
              };
              github.paths = [];
              const depth = 100 + Math.floor(random() * 1500);
              const got = ids(
                await read(lists, github, {
                  reader: `reader ${reading % 2}`,
                  until: (_, at) => at >= depth,
                }),
              );
              github.before = () => {};
              const lowest = got.at(-1) ?? Infinity;
              const after = new Set(ids(github.list));
              const returned = new Set(got);
              const lost = before.filter((id) =>
                after.has(id) && id >= lowest && !returned.has(id)
              );
              const misordered = got.filter((id, i) =>
                i > 0 && id >= got[i - 1]
              );
              expect({ seed, reading, lost, misordered }).toEqual({
                seed,
                reading,
                lost: [],
                misordered: [],
              });
              expect(github.pages.length).toBeLessThanOrEqual(
                Math.ceil(got.length / 50) + 12,
              );
              time.tick(HEAD_REUSE_MS);
            }
          }
        });

        it("reads a held run that was unfinished again by its id", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub([
            ...runs(250, 31),
            run(30, { status: "in_progress", conclusion: null }),
            ...runs(29, 1),
          ]);
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 1 });
          github.list = runs(250, 1);
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            reader: "second",
            until: (held) => held.id === 1,
          });

          const thirty = read2.find((held) => held.id === 30);
          expect(thirty?.status).toBe("completed");
          expect(github.byId).toEqual([30]);
        });

        it("reads the run `until` stops at again under `confirmStop`, and reads past it when it no longer stops", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(250, 1));
          const lists = new RunLists();
          const verdict = (held: GitHubRun) => held.conclusion !== null;
          await read(lists, github, {
            until: (held) => held.id === 40,
          });
          // Run 40 is started again, which leaves its place in the list.
          github.list = github.list.map((held) =>
            held.id === 40
              ? run(40, {
                status: "in_progress",
                conclusion: null,
                run_attempt: 2,
              })
              : held
          );
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            confirmStop: true,
            until: (held) => held.id <= 40 && verdict(held),
          });

          expect(ids(read2)).toEqual(ids(runs(250, 39)));
          expect(read2.find((held) => held.id === 40)?.run_attempt).toBe(2);
          // Run 39 lies below the runs the first reading kept, so it is read
          // from the list rather than by its id.
          expect(github.byId).toEqual([40]);
        });

        it("reads a run again when a `recheck` list shows it updated after the copy held", async () => {
          using time = new FakeTime();
          const github = new FakeGitHub(runs(250, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 1 });
          const rerun = run(5, {
            run_attempt: 2,
            updated_at: "2026-02-01T00:00:00Z",
          });
          github.list = github.list.map((held) => held.id === 5 ? rerun : held);
          github.filtered = [rerun];
          github.paths = [];
          time.tick(HEAD_REUSE_MS);

          const read2 = await read(lists, github, {
            reader: "second",
            recheck: [{ branch: "main" }],
            until: (held) => held.id === 1,
          });

          expect(read2.find((held) => held.id === 5)?.run_attempt).toBe(2);
          expect(github.byId).toEqual([5]);
        });

        it("takes neither which runs exist nor how they stand from a `recheck` list", async () => {
          const github = new FakeGitHub(runs(30, 1));
          github.filtered = [
            run(10, { conclusion: "failure" }),
            run(99, { conclusion: "failure" }),
          ];

          const read1 = await read(new RunLists(), github, {
            recheck: [{ branch: "main" }],
          });

          expect(ids(read1)).toEqual(ids(runs(30, 1)));
          expect(read1.every((held) => held.conclusion === "success")).toBe(
            true,
          );
          expect(github.byId).toEqual([]);
        });

        it("shares one read of the top among readings made close together", async () => {
          const github = new FakeGitHub(runs(30, 1));
          const lists = new RunLists();
          await read(lists, github, { reader: "first" });
          github.paths = [];

          await read(lists, github, { reader: "second" });

          expect(github.pages).toEqual([]);
        });

        it("keeps runs only as deep as its readers last read", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, { until: (held) => held.id === 1 });
          await read(lists, github, { until: (held) => held.id === 290 });
          github.paths = [];

          const deep = await read(lists, github, {
            until: (held) => held.id === 1,
          });

          expect(ids(deep)).toEqual(ids(runs(300, 1)));
          expect(github.pages).toEqual(["1@100", "2@99", "3@98", "4@97"]);
        });

        it("keeps the runs a deeper reader read when a shallower one reads", async () => {
          const github = new FakeGitHub(runs(300, 1));
          const lists = new RunLists();
          await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 1,
          });
          await read(lists, github, {
            reader: "shallow",
            until: (held) => held.id === 290,
          });
          github.paths = [];

          await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 1,
          });

          expect(github.pages).toEqual([]);
        });

        it("keeps the runs a failed reading read when another reader reads", async () => {
          const github = new FakeGitHub(runs(400, 1));
          const request = github.request;
          const page = (path: string) =>
            new URL(path, "https://api.github.com/").searchParams.get("page");
          github.request = <T>(
            path: string,
            options: GitHubRequestOptions,
          ): Promise<T> =>
            page(path) === "4"
              ? Promise.reject(new Error("HTTP 502"))
              : request<T>(path, options);
          const lists = new RunLists();
          await expect(
            read(lists, github, {
              reader: "deep",
              until: (held) => held.id === 1,
            }),
          ).rejects.toThrow("HTTP 502");
          github.request = request;
          await read(lists, github, {
            reader: "shallow",
            until: (held) => held.id === 390,
          });
          github.paths = [];

          await read(lists, github, {
            reader: "deep",
            until: (held) => held.id === 1,
          });

          expect(github.pages).toEqual(["4@97", "5@96"]);
        });

        it("rejects a page whose runs are not listed newest first", async () => {
          const github = new FakeGitHub([run(5), run(7), run(6)]);

          await expect(read(new RunLists(), github)).rejects.toThrow(
            "out of order",
          );
        });

        it("passes run list access with every run list it asks for", async () => {
          const seen: GitHubRequestOptions[] = [];
          const github = new FakeGitHub(runs(30, 1));
          const request = github.request;
          github.request = <T>(path: string, options: GitHubRequestOptions) => {
            if (path.includes("/workflows/")) seen.push(options);
            return request<T>(path, options);
          };

          await read(new RunLists(), github, {
            recheck: [{ status: "queued" }],
          });

          expect(seen.length).toBe(3);
          expect(
            seen.every((options) => options.runListAccess === RUN_LIST_ACCESS),
          ).toBe(true);
        });

        describe("given a file", () => {
          let directory: string;
          let file: string;

          beforeEach(async () => {
            directory = await Deno.makeTempDir({ prefix: "github-runs-" });
            file = join(directory, "run-lists.json");
          });

          afterEach(async () => {
            await Deno.remove(directory, { recursive: true });
          });

          it("reads only the top of the list after a restart once the runs below it are in the file", async () => {
            const github = new FakeGitHub(runs(250, 1));
            await read(new RunLists(file), github, {
              until: (held) => held.id === 10,
            });
            github.paths = [];
            github.list = runs(253, 1);

            const read2 = await read(new RunLists(file), github, {
              until: (held) => held.id === 10,
            });

            expect(ids(read2)).toEqual(ids(runs(253, 10)));
            expect(github.pages).toEqual(["1@20"]);
            expect(github.byId).toEqual([]);
          });

          it("reads from the top after a restart until it reaches the runs in the file", async () => {
            const github = new FakeGitHub(runs(250, 1));
            await read(new RunLists(file), github, {
              until: (held) => held.id === 10,
            });
            github.paths = [];
            github.list = runs(500, 1);

            const read2 = await read(new RunLists(file), github, {
              until: (held) => held.id === 10,
            });

            expect(ids(read2)).toEqual(ids(runs(500, 10)));
            expect(github.pages).toEqual(["1@20", "1@100", "2@99", "3@98"]);
          });

          it("drops a run in the file that was deleted from the top of the list before a restart", async () => {
            const github = new FakeGitHub(runs(300, 1));
            await read(new RunLists(file), github, {
              until: (held) => held.id === 250,
            });
            github.list = runs(301, 1).filter((held) => held.id !== 290);

            const read2 = await read(new RunLists(file), github, {
              until: (held) => held.id === 250,
            });

            expect(ids(read2)).toEqual(
              ids(runs(301, 250)).filter((id) => id !== 290),
            );
          });

          it("reads again by its id a run in the file that had not finished", async () => {
            const github = new FakeGitHub(runs(100, 1));
            github.list = github.list.map((held) =>
              held.id === 30
                ? run(30, { status: "in_progress", conclusion: null })
                : held
            );
            await read(new RunLists(file), github, {
              until: (held) => held.id === 10,
            });
            github.list = runs(100, 1);
            github.paths = [];

            const read2 = await read(new RunLists(file), github, {
              until: (held) => held.id === 10,
            });

            expect(github.byId).toEqual([30]);
            expect(read2.find((held) => held.id === 30)?.status).toBe(
              "completed",
            );
          });

          it("reads again by its id a run in the file that a `recheck` list shows run again", async () => {
            const github = new FakeGitHub(runs(250, 1));
            await read(new RunLists(file), github, {
              until: (held) => held.id === 1,
            });
            const rerun = run(5, {
              run_attempt: 2,
              updated_at: "2026-02-01T00:00:00Z",
            });
            github.list = github.list.map((held) =>
              held.id === 5 ? rerun : held
            );
            github.filtered = [rerun];
            github.paths = [];

            const read2 = await read(new RunLists(file), github, {
              recheck: [{ branch: "main" }],
              until: (held) => held.id === 1,
            });

            expect(github.byId).toEqual([5]);
            expect(read2.find((held) => held.id === 5)?.run_attempt).toBe(2);
          });

          it("keeps in the file the runs a reading read before it failed", async () => {
            const github = new FakeGitHub(runs(400, 1));
            const request = github.request;
            const page = (path: string) =>
              new URL(path, "https://api.github.com/").searchParams.get("page");
            github.request = <T>(
              path: string,
              options: GitHubRequestOptions,
            ): Promise<T> =>
              page(path) === "4"
                ? Promise.reject(new Error("HTTP 502"))
                : request<T>(path, options);
            await expect(
              read(new RunLists(file), github, {
                until: (held) => held.id === 1,
              }),
            ).rejects.toThrow("HTTP 502");
            github.request = request;
            github.paths = [];

            const read2 = await read(new RunLists(file), github, {
              until: (held) => held.id === 1,
            });

            expect(ids(read2)).toEqual(ids(runs(400, 1)));
            expect(github.pages).toEqual(["1@20", "4@97", "5@96"]);
          });

          it("reads only the top of the list after a restart when runs landed during the reading that filled the file", async () => {
            const github = new FakeGitHub(runs(300, 1));
            github.before = (requests) => {
              if (requests === 2) github.list = runs(305, 1);
            };
            await read(new RunLists(file), github, {
              until: (held) => held.id === 1,
            });
            github.before = () => {};
            github.paths = [];

            const read2 = await read(new RunLists(file), github, {
              until: (held) => held.id === 1,
            });

            expect(ids(read2)).toEqual(ids(runs(305, 1)));
            expect(github.pages).toEqual(["1@20"]);
          });

          it("logs a write of the file that fails, and writes it again after the next reading", async () => {
            const github = new FakeGitHub(runs(30, 1));
            const lists = new RunLists(join(directory, "absent", "lists.json"));
            const logged: string[] = [];
            const realError = console.error;
            console.error = (...parts: unknown[]) =>
              logged.push(parts.map(String).join(" "));
            try {
              const read1 = await read(lists, github);
              expect(ids(read1)).toEqual(ids(runs(30, 1)));
            } finally {
              console.error = realError;
            }
            expect(logged.length).toBe(1);
            expect(logged[0]).toContain("run lists could not be saved to");
            await Deno.mkdir(join(directory, "absent"));

            await read(lists, github, { reader: "second" });

            github.paths = [];
            await read(
              new RunLists(join(directory, "absent", "lists.json")),
              github,
            );
            expect(github.pages).toEqual(["1@20"]);
          });

          it("keeps in the file the heads of readings that finish together", async () => {
            // The heads are held already, so the three readings finish while
            // the file is still being written for the first of them.
            const github = new FakeGitHub(runs(30, 1));
            const lists = new RunLists(file);
            const workflows = ["a.yml", "b.yml", "c.yml"];
            const reading = (on: RunLists, workflow: string) =>
              on.runs(github.request, REPO, workflow, {
                reader: "reader",
                recheck: [],
                wants: () => true,
                until: () => false,
              });
            for (const workflow of workflows) await reading(lists, workflow);
            github.list = runs(32, 1);
            await Deno.remove(file);

            await Promise.all(
              workflows.map((workflow) => reading(lists, workflow)),
            );

            github.paths = [];
            const again = new RunLists(file);
            for (const workflow of workflows) await reading(again, workflow);
            expect(github.pages).toEqual(["1@20", "1@20", "1@20"]);
          });

          it("forgets a reader in the file that has not read for a day", async () => {
            using time = new FakeTime();
            const github = new FakeGitHub(runs(300, 1));
            const shallow = () =>
              read(new RunLists(file), github, {
                reader: "shallow",
                until: (held) => held.id === 290,
              });
            const deep = () =>
              read(new RunLists(file), github, {
                reader: "deep",
                until: (held) => held.id === 1,
              });
            await deep();
            await shallow();
            time.tick(13 * 3_600_000);
            await shallow();
            time.tick(13 * 3_600_000);
            await shallow();
            github.paths = [];

            await deep();

            expect(github.pages).toEqual([
              "1@20",
              "1@100",
              "2@99",
              "3@98",
              "4@97",
            ]);
          });

          it("keeps in the file a reader that has read within a day", async () => {
            using time = new FakeTime();
            const github = new FakeGitHub(runs(300, 1));
            await read(new RunLists(file), github, {
              reader: "deep",
              until: (held) => held.id === 1,
            });
            time.tick(23 * 3_600_000);
            github.paths = [];

            await read(new RunLists(file), github, {
              reader: "deep",
              until: (held) => held.id === 1,
            });

            expect(github.pages).toEqual(["1@20"]);
          });

          it("reads the whole list again after a day in which nobody read it", async () => {
            using time = new FakeTime();
            const github = new FakeGitHub(runs(300, 1));
            await read(new RunLists(file), github, {
              until: (held) => held.id === 1,
            });
            time.tick(24 * 3_600_000 + 1);
            github.paths = [];

            await read(new RunLists(file), github, {
              until: (held) => held.id === 1,
            });

            expect(github.pages).toEqual([
              "1@20",
              "1@100",
              "2@99",
              "3@98",
              "4@97",
            ]);
          });
        });
      });
    });
  });

  it("is the only dashboard module that names run list access", async () => {
    const root = dirname(fromFileUrl(import.meta.url));
    const holders: string[] = [];
    const files = walk(root, { exts: [".ts"], includeDirs: false });
    for await (const entry of files) {
      const file = relative(root, entry.path);
      if (file.endsWith(".test.ts") || file.startsWith(`test${SEPARATOR}`)) {
        continue;
      }
      if ((await Deno.readTextFile(entry.path)).includes("RUN_LIST_ACCESS")) {
        holders.push(file);
      }
    }

    expect(holders.sort()).toEqual(["github-runs.ts", "lib.ts"]);
  });
});
