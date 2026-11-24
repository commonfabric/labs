import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  abbreviateHashes,
  type Board,
  boardTokens,
  type Box,
  boxOffline,
  boxRunning,
  buildBoard,
  compareTuples,
  forgetBeyond,
  type LargerRunner,
  MOST_PLACES,
  newSteadiness,
  type Pool,
  poolTitle,
  remembersMore,
  RUN_COLORS,
  type Runner,
  RunPalette,
  runTitle,
  stableHash,
  type Steadiness,
  steadyBoard,
  type Token,
} from "./runner-board.ts";
import type { ActiveJob } from "./runner-jobs.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MAC = ["self-hosted", "macOS", "ARM64", "ci-mac-01", "cf-mac"];
const AUTOSCALED = ["self-hosted", "Linux", "X64", "linux-autoscale", "cf-build"];
const AUTOSCALED_POOL = "labelled cf-build, linux-autoscale";
const LARGE: LargerRunner = {
  owner: "acme",
  name: "ubuntu-24.04-32-core",
  maximum: 4,
  cores: 32,
  memory: 128,
};
const LARGE_POOL = "larger acme/ubuntu-24.04-32-core";
const MAC_POOL = "machines ci-mac-01";

/** Job `id` of run 100 of `acme/labs`, queued for nothing, but for `fields`. */
function job(id: number, fields: Partial<ActiveJob> = {}): ActiveJob {
  return {
    id,
    runId: 100,
    attempt: 1,
    owner: "acme",
    repository: "labs",
    workflow: "CI",
    branch: "main",
    sha: SHA,
    name: `job ${id}`,
    running: false,
    since: null,
    labels: [],
    runner: null,
    runnerGroup: null,
    url: `https://github.com/acme/labs/actions/runs/100/job/${id}`,
    ...fields,
  };
}

/** Job `id`, running on self-hosted runner `runner`. */
function running(id: number, runner: string, fields: Partial<ActiveJob> = {}): ActiveJob {
  return job(id, {
    running: true,
    runner,
    runnerGroup: "Default",
    labels: ["self-hosted", "cf-mac"],
    ...fields,
  });
}

/** Job `id`, running on one of GitHub's runners with `labels`. */
function hosted(id: number, labels: string[], fields: Partial<ActiveJob> = {}): ActiveJob {
  return job(id, {
    running: true,
    runner: `GitHub Actions ${1001438680 + id}`,
    runnerGroup: "GitHub Actions",
    labels,
    ...fields,
  });
}

function runner(name: string, labels: readonly string[], online = true, owner = "acme"): Runner {
  return { owner, name, labels, online };
}

/** The runners `ci-mac-01-1` to `ci-mac-01-3` of the machine `ci-mac-01`. */
function macRunners(online = true): Runner[] {
  return [1, 2, 3].map((n) => runner(`ci-mac-01-${n}`, MAC, online));
}

/** Two autoscaled runners online, and one offline. */
function autoscaledRunners(): Runner[] {
  return [
    runner("linux-autoscale-x7k2-9f3a", AUTOSCALED),
    runner("linux-autoscale-p4m8-2c1d", AUTOSCALED),
    runner("linux-autoscale-q9z1-7b6e", AUTOSCALED, false),
  ];
}

function board(
  jobs: readonly ActiveJob[],
  listed: readonly Runner[] = [],
  larger: readonly LargerRunner[] = [],
): Board {
  return buildBoard(jobs, listed, larger, () => undefined, []);
}

function poolOf(board: Board, id: string): Pool {
  const pool = board.pools.find((candidate) => candidate.id === id);
  if (pool === undefined) {
    throw new Error(`No pool ${id} among ${board.pools.map((p) => p.id).join("; ")}`);
  }
  return pool;
}

function boxOf(board: Board, pool: string, id: string): Box {
  const box = poolOf(board, pool).boxes.find((candidate) => candidate.id === id);
  if (box === undefined) throw new Error(`No box ${id} in pool ${pool}`);
  return box;
}

function poolIds(board: Board): string[] {
  return board.pools.map((pool) => pool.id);
}

/** The ID of the job in each slot of `box`, or `null` for an empty one. */
function slotJobs(box: Box): (number | null)[] | null {
  return box.slots?.map((slot) => slot.job?.id ?? null) ?? null;
}

function queueIds(pool: Pool): number[] {
  return pool.queue.map((token) => token.id);
}

function token(fields: Partial<Token> = {}): Token {
  return {
    id: 1,
    job: "build",
    repository: "labs",
    workflow: "CI",
    branch: "main",
    pullRequest: null,
    commit: "0123456",
    runId: "100",
    running: true,
    since: null,
    labels: [],
    runner: null,
    url: "https://github.com/acme/labs/actions/runs/100/job/1",
    ...fields,
  };
}

describe("runner-board", () => {
  describe("compareTuples()", () => {
    it("returns the order of the first elements that differ", () => {
      expect(compareTuples([1, "b"], [1, "a"])).toBe(1);
      expect(compareTuples([1, "z"], [2, "a"])).toBe(-1);
      expect(compareTuples(["a", Infinity], ["a", 3])).toBe(1);
    });

    it("returns 0 for equal tuples", () => {
      expect(compareTuples([1, "a"], [1, "a"])).toBe(0);
    });

    it("sorts a tuple before a longer one it starts", () => {
      expect(compareTuples([1], [1, "a"])).toBeLessThan(0);
      expect(compareTuples([1, "a"], [1])).toBeGreaterThan(0);
    });
  });

  describe("abbreviateHashes()", () => {
    it("cuts each full commit hash to seven digits", () => {
      expect(abbreviateHashes(`build ${SHA} and ${SHA}`)).toBe("build 0123456 and 0123456");
    });

    it("leaves alone what is not a whole hash", () => {
      const short = SHA.slice(1);
      expect(abbreviateHashes(short)).toBe(short);
      expect(abbreviateHashes(SHA.toUpperCase())).toBe(SHA.toUpperCase());
      expect(abbreviateHashes(`x${SHA}`)).toBe(`x${SHA}`);
    });
  });

  describe("runTitle()", () => {
    it("names a run by its pull request when it has one", () => {
      expect(runTitle(token({ pullRequest: 12 }))).toBe("labs PR #12 · CI @ 0123456");
    });

    it("names a run by its branch, its hashes cut short, when it has no pull request", () => {
      expect(runTitle(token())).toBe("labs · CI on main @ 0123456");
      expect(runTitle(token({ branch: `backport-${SHA}` }))).toBe(
        "labs · CI on backport-0123456 @ 0123456",
      );
    });

    it("leaves out the commit when it is not known", () => {
      expect(runTitle(token({ commit: "" }))).toBe("labs · CI on main");
    });
  });

  describe("poolTitle()", () => {
    it("returns the name of a single machine, and nothing for none", () => {
      expect(poolTitle(["ci-mac-01"])).toBe("ci-mac-01");
      expect(poolTitle([])).toBe("");
    });

    it("returns what the machines' names start with, without the numbers that tell them apart", () => {
      expect(poolTitle(["ci-mac-01", "ci-mac-02", "ci-mac-10"])).toBe("ci-mac");
    });

    it("returns every name when the names share no start but numbers", () => {
      expect(poolTitle(["alpha", "beta"])).toBe("alpha, beta");
      expect(poolTitle(["01", "02"])).toBe("01, 02");
    });
  });

  describe("buildBoard()", () => {
    describe("machines", () => {
      it("gives a machine a box with a slot for each of its runners", () => {
        const built = board([], macRunners());

        expect(built.pools).toEqual([{
          id: MAC_POOL,
          kind: 0,
          title: "ci-mac-01",
          detail: "self-hosted macOS ARM64 · cf-mac",
          boxes: [{
            id: "ci-mac-01",
            title: "ci-mac-01",
            slots: [1, 2, 3].map((n) => ({
              id: `acme/ci-mac-01-${n}`,
              name: `ci-mac-01-${n}`,
              label: `${n}`,
              online: true,
              job: null,
              place: false,
            })),
            jobs: [],
            idle: 0,
            capacity: null,
          }],
          queue: [],
        }]);
      });

      it("orders slots by number, then by name", () => {
        const built = board(
          [],
          ["b", "10", "a", "2"].map((label) => runner(`ci-mac-01-${label}`, MAC)),
        );

        expect(boxOf(built, MAC_POOL, "ci-mac-01").slots?.map((slot) => slot.label))
          .toEqual(["2", "10", "a", "b"]);
      });

      it("marks the slot of an offline runner offline", () => {
        const built = board([], [runner("ci-mac-01-1", MAC, false), runner("ci-mac-01-2", MAC)]);

        expect(boxOf(built, MAC_POOL, "ci-mac-01").slots?.map((slot) => slot.online))
          .toEqual([false, true]);
      });

      it("puts a running job in its runner's slot", () => {
        const built = board([running(7, "ci-mac-01-2")], macRunners());

        expect(slotJobs(boxOf(built, MAC_POOL, "ci-mac-01"))).toEqual([null, 7, null]);
        expect(boxOf(built, MAC_POOL, "ci-mac-01").jobs).toEqual([]);
      });

      it("puts the second of two jobs that say they run on one runner beside the slots", () => {
        const built = board(
          [running(8, "ci-mac-01-2"), running(7, "ci-mac-01-2")],
          macRunners(),
        );

        const box = boxOf(built, MAC_POOL, "ci-mac-01");
        expect(slotJobs(box)).toEqual([null, 7, null]);
        expect(box.jobs.map((token) => token.id)).toEqual([8]);
      });

      it("names a slot whose runner is named after its machine by the runner's name", () => {
        const built = board([], [runner("builder", ["self-hosted", "builder", "docs"])]);

        expect(built.pools.map((pool) => pool.kind)).toEqual([0]);
        expect(boxOf(built, "machines builder", "builder").slots?.map((slot) => slot.label))
          .toEqual(["builder"]);
      });

      it("takes the longest label a runner is named after as its machine", () => {
        const built = board([], [runner("build-a", ["self-hosted", "build", "build-a", "docs"])]);

        expect(poolIds(built)).toEqual(["machines build-a"]);
      });

      it("pools a runner named after its only distinctive label by its labels, not as a machine", () => {
        const built = board([], [runner("ci-mac-01-1", ["self-hosted", "macOS", "ci-mac-01"])]);

        expect(built.pools.map((pool) => [pool.id, pool.kind])).toEqual([
          ["labelled ci-mac-01", 1],
        ]);
      });

      it("pools machines that share a role, and keeps apart those that do not", () => {
        const second = ["self-hosted", "macOS", "ARM64", "ci-mac-02", "cf-mac"];
        const linux = ["self-hosted", "Linux", "X64", "ci-linux-01", "cf-linux"];
        const built = board([], [
          ...macRunners(),
          runner("ci-mac-02-1", second),
          runner("ci-linux-01-1", linux),
        ]);

        expect(built.pools.map((pool) => [pool.id, pool.title])).toEqual([
          ["machines ci-linux-01", "ci-linux-01"],
          ["machines ci-mac-01, ci-mac-02", "ci-mac"],
        ]);
        expect(poolOf(built, "machines ci-mac-01, ci-mac-02").boxes.map((box) => box.id))
          .toEqual(["ci-mac-01", "ci-mac-02"]);
      });

      it("pools every machine that shares a role with any machine of a pool", () => {
        const machine = (name: string, roles: string[]) =>
          runner(`${name}-1`, ["self-hosted", name, ...roles]);
        const apart = board([], [machine("box-a", ["red"]), machine("box-b", ["blue"])]);
        const joined = board([], [
          machine("box-a", ["red"]),
          machine("box-b", ["blue"]),
          machine("box-c", ["red", "blue"]),
        ]);

        expect(poolIds(apart)).toEqual(["machines box-a", "machines box-b"]);
        expect(joined.pools.map((pool) => [pool.id, pool.title, pool.detail])).toEqual([
          ["machines box-a, box-b, box-c", "box", "self-hosted · blue, red"],
        ]);
      });

      it("gives a machine that a running job names, unlisted, a slot holding the job", () => {
        const labels = ["self-hosted", "macOS", "ARM64", "ci-mac-02", "cf-mac"];
        const built = board([running(7, "ci-mac-02-1", { labels })], macRunners());

        const pool = "machines ci-mac-01, ci-mac-02";
        expect(slotJobs(boxOf(built, pool, "ci-mac-02"))).toEqual([7]);
        expect(boxOf(built, pool, "ci-mac-02").slots?.[0].online).toBe(true);
      });

      it("tells apart runners of the same name of two owners", () => {
        const built = board(
          [running(7, "ci-mac-01-1", { owner: "other" })],
          [runner("ci-mac-01-1", MAC), runner("ci-mac-01-1", MAC, true, "other")],
        );

        const slots = boxOf(built, MAC_POOL, "ci-mac-01").slots ?? [];
        expect(slots.map((slot) => [slot.id, slot.job?.id ?? null])).toEqual([
          ["acme/ci-mac-01-1", null],
          ["other/ci-mac-01-1", 7],
        ]);
      });
    });

    describe("runners that come and go", () => {
      it("pools autoscaled runners by their labels, counting those online and idle", () => {
        const built = board(
          [running(7, "linux-autoscale-x7k2-9f3a", { labels: ["self-hosted", "cf-build"] })],
          autoscaledRunners(),
        );

        expect(built.pools.map(({ id, kind, title, detail }) => ({ id, kind, title, detail })))
          .toEqual([{
            id: AUTOSCALED_POOL,
            kind: 1,
            title: "cf-build, linux-autoscale",
            detail: "self-hosted Linux X64",
          }]);
        const box = boxOf(built, AUTOSCALED_POOL, "cf-build, linux-autoscale");
        expect(box.title).toBe("");
        expect(box.slots).toBeNull();
        expect(box.jobs.map((token) => token.id)).toEqual([7]);
        expect(box.idle).toBe(1);
      });

      it("counts every online runner of a pool with no jobs idle", () => {
        const built = board([], autoscaledRunners());

        expect(boxOf(built, AUTOSCALED_POOL, "cf-build, linux-autoscale").idle).toBe(2);
      });

      it("pools a runner that a running job names, unlisted, by the labels the job asked for", () => {
        const built = board(
          [running(7, "gpu-vm-1234-abcd", { labels: ["self-hosted", "Linux", "gpu"] })],
        );

        expect(built.pools.map(({ id, title, detail }) => [id, title, detail])).toEqual([
          ["labelled gpu", "gpu", "self-hosted Linux"],
        ]);
        const box = boxOf(built, "labelled gpu", "gpu");
        expect(box.jobs.map((token) => token.id)).toEqual([7]);
        expect(box.idle).toBe(0);
      });

      it("pools the runner of a job that asked for a runner group by that group", () => {
        const built = board([running(7, "labs-runner-77", { labels: [], runnerGroup: "labs" })]);

        expect(built.pools.map(({ id, title }) => [id, title])).toEqual([
          ["labelled runner group labs", "runner group labs"],
        ]);
      });

      it("calls the pool of a runner with no labels `unlabelled`", () => {
        const built = board([running(7, "mystery", { labels: [], runnerGroup: null })]);

        expect(built.pools.map(({ kind, title }) => [kind, title])).toEqual([[1, "unlabelled"]]);
      });

      it("pools a running self-hosted job that does not yet say its runner by its labels", () => {
        const built = board(
          [running(7, "", { runner: null, runnerGroup: null, labels: ["self-hosted", "gpu"] })],
        );

        expect(boxOf(built, "labelled gpu", "gpu").jobs.map((token) => token.id)).toEqual([7]);
      });
    });

    describe("larger runners", () => {
      it("gives a larger runner a pool of its own, with its jobs, while it has jobs", () => {
        const built = board(
          [
            running(7, "ubuntu-24.04-32-core-1001427100", {
              runnerGroup: "Default Larger Runners",
              labels: ["ubuntu-24.04-32-core"],
            }),
          ],
          [],
          [LARGE],
        );

        const pool = poolOf(built, LARGE_POOL);
        expect([pool.kind, pool.title, pool.detail]).toEqual([
          2,
          "ubuntu-24.04-32-core",
          "GitHub-hosted · 32 cores, 128 GB",
        ]);
        expect(pool.boxes.map(({ id, title, slots, capacity }) => ({ id, title, slots, capacity })))
          .toEqual([{ id: "ubuntu-24.04-32-core", title: "", slots: null, capacity: 4 }]);
        expect(pool.boxes[0].jobs.map((token) => token.id)).toEqual([7]);
        expect(poolIds(board([], [], [LARGE]))).toEqual([]);
      });

      it("finds a job's larger runner by its runner's name, the longest name that fits", () => {
        const smaller = { ...LARGE, name: "ubuntu-24.04", cores: null, memory: null };
        const exact = board(
          [running(7, "ubuntu-24.04", { runnerGroup: "Default Larger Runners", labels: ["big"] })],
          [],
          [LARGE, smaller],
        );
        const longest = board(
          [running(7, "ubuntu-24.04-32-core-1", { runnerGroup: null, labels: ["big"] })],
          [],
          [smaller, LARGE],
        );

        expect(exact.pools.map(({ id, detail }) => [id, detail])).toEqual([
          ["larger acme/ubuntu-24.04", "GitHub-hosted"],
        ]);
        expect(poolIds(longest)).toEqual([LARGE_POOL]);
      });

      it("does not take a job of another owner, or one asking for a self-hosted runner, to be on a larger runner", () => {
        const theirs = { ...LARGE, owner: "other" };
        const elsewhere = board(
          [
            running(7, "ubuntu-24.04-32-core-1", {
              runnerGroup: "Default Larger Runners",
              labels: ["ubuntu-24.04-32-core"],
            }),
          ],
          [],
          [theirs],
        );
        const selfHosted = board(
          [
            running(8, "ubuntu-24.04-32-core-1", {
              labels: ["self-hosted", "ubuntu-24.04-32-core"],
            }),
          ],
          [],
          [LARGE],
        );

        expect(poolIds(elsewhere)).toEqual(["labelled ubuntu-24.04-32-core"]);
        expect(poolIds(selfHosted)).toEqual(["labelled ubuntu-24.04-32-core"]);
      });
    });

    describe("GitHub-hosted runners", () => {
      it("gives GitHub's runners one pool, with a box for each set of labels, in order", () => {
        const built = board([
          hosted(1, ["ubuntu-latest"]),
          hosted(2, ["macos-latest"], { runnerGroup: null }),
          job(3, { running: true, labels: ["Windows-Latest"] }),
          job(4, { running: true }),
        ]);

        const pool = poolOf(built, "github-hosted");
        expect([pool.kind, pool.title, pool.detail]).toEqual([
          3,
          "GitHub-hosted",
          "a fresh runner for each job",
        ]);
        expect(pool.boxes.map((box) => [box.id, box.title, box.jobs.map((token) => token.id)]))
          .toEqual([
            ["windows-latest", "Windows-Latest", [3]],
            ["any runner", "any runner", [4]],
            ["macos-latest", "macos-latest", [2]],
            ["ubuntu-latest", "ubuntu-latest", [1]],
          ]);
        expect(poolIds(built)).toEqual(["github-hosted"]);
      });

      it("puts jobs asking for the same labels, however written, in one box", () => {
        const built = board([hosted(1, ["ubuntu-latest"]), hosted(2, ["Ubuntu-Latest"])]);

        expect(poolOf(built, "github-hosted").boxes.map((box) => box.jobs.length)).toEqual([2]);
      });

      it("takes a running job that says no runner and asks for none self-hosted to be on one of GitHub's", () => {
        const githubs = board([job(1, { running: true, labels: ["ubuntu-latest"] })]);
        const selfHosted = board([job(1, { running: true, labels: ["self-hosted"] })]);

        expect(poolIds(githubs)).toEqual(["github-hosted"]);
        expect(poolIds(selfHosted)).toEqual(["labelled "]);
      });
    });

    describe("queued jobs", () => {
      it("queues a job in the pool of a runner with every label it asks for, however written", () => {
        const built = board(
          [job(1, { labels: ["Self-Hosted", "MACOS", "CF-MAC"] })],
          [...autoscaledRunners(), ...macRunners()],
        );

        expect(queueIds(poolOf(built, MAC_POOL))).toEqual([1]);
        expect(queueIds(poolOf(built, AUTOSCALED_POOL))).toEqual([]);
      });

      it("queues a job for an online runner before an offline one, or for an offline one when none is online", () => {
        const vm = (online: boolean) =>
          runner("mac-vm-ab12-cd34", ["self-hosted", "macOS", "cf-mac", "ephemeral"], online);
        const queued = [job(1, { labels: ["self-hosted", "cf-mac"] })];
        const online = board(queued, [...macRunners(false), vm(true)]);
        const offline = board(queued, [...macRunners(false), vm(false)]);

        expect(queueIds(poolOf(online, "labelled cf-mac, ephemeral"))).toEqual([1]);
        expect(queueIds(poolOf(online, MAC_POOL))).toEqual([]);
        expect(queueIds(poolOf(offline, MAC_POOL))).toEqual([1]);
      });

      it("queues a job naming a larger runner in that runner's pool", () => {
        const built = board([job(1, { labels: ["ubuntu-24.04-32-core"] })], macRunners(), [LARGE]);

        expect(queueIds(poolOf(built, LARGE_POOL))).toEqual([1]);
        expect(poolOf(built, LARGE_POOL).boxes[0].jobs).toEqual([]);
      });

      it("queues a job asking for a self-hosted runner no runner can be in a pool made for it", () => {
        const built = board([job(1, { labels: ["self-hosted", "gpu"] })], macRunners());

        const pool = poolOf(built, "labelled gpu");
        expect([pool.kind, pool.title, queueIds(pool)]).toEqual([1, "gpu", [1]]);
      });

      it("queues a job in the pool of runners with its labels, if there is one, else for GitHub's", () => {
        const withPool = board([
          job(1, { labels: ["gpu"] }),
          job(2, { running: true, labels: ["self-hosted", "gpu"] }),
        ]);
        const without = board([job(1, { labels: ["gpu"] })]);

        expect(queueIds(poolOf(withPool, "labelled gpu"))).toEqual([1]);
        expect(poolIds(without)).toEqual(["github-hosted"]);
        expect(queueIds(poolOf(without, "github-hosted"))).toEqual([1]);
        expect(boxOf(without, "github-hosted", "gpu").jobs).toEqual([]);
      });

      it("queues a job asking for no labels for GitHub's runners", () => {
        const built = board([job(1)], macRunners());

        expect(queueIds(poolOf(built, "github-hosted"))).toEqual([1]);
        expect(poolOf(built, "github-hosted").boxes.map((box) => box.title)).toEqual([
          "any runner",
        ]);
        expect(queueIds(poolOf(built, MAC_POOL))).toEqual([]);
      });

      it("queues a job asking for a runner group and no labels in that group's pool, where its running jobs run", () => {
        const group = "labelled runner group labs";
        const alone = board([job(1, { runnerGroup: "labs" })], macRunners());
        const beside = board([
          job(1, { runnerGroup: "labs" }),
          running(2, "labs-runner-77", { labels: [], runnerGroup: "labs" }),
        ]);

        expect(alone.pools.map((pool) => [pool.id, pool.kind, pool.title, queueIds(pool)])).toEqual(
          [
            [MAC_POOL, 0, "ci-mac-01", []],
            [group, 1, "runner group labs", [1]],
          ],
        );
        expect(poolIds(beside)).toEqual([group]);
        expect(queueIds(poolOf(beside, group))).toEqual([1]);
        expect(poolOf(beside, group).boxes[0].jobs.map((token) => token.id)).toEqual([2]);
      });

      it("queues a job asking for labels by its labels, whatever runner group it names", () => {
        const built = board([job(1, { labels: ["ubuntu-latest"], runnerGroup: "labs" })]);

        expect(poolIds(built)).toEqual(["github-hosted"]);
        expect(queueIds(poolOf(built, "github-hosted"))).toEqual([1]);
      });

      it("orders a queue and a box's jobs the oldest first, those of no known age last", () => {
        const labels = ["ubuntu-latest"];
        const built = board([
          job(1, { since: 300, labels }),
          job(2, { since: null, labels }),
          job(3, { since: 100, labels }),
          job(4, { since: 100, labels }),
          hosted(5, labels, { since: 50 }),
          hosted(6, labels, { since: 20 }),
        ]);

        const pool = poolOf(built, "github-hosted");
        expect(queueIds(pool)).toEqual([3, 4, 1, 2]);
        expect(pool.boxes[0].jobs.map((token) => token.id)).toEqual([6, 5]);
      });
    });

    describe("tokens and runs", () => {
      it("makes a token of each job with its run's pull request and hashes cut short", () => {
        const built = buildBoard(
          [
            hosted(1, ["ubuntu-latest"], {
              name: `test ${SHA}`,
              workflow: `CI ${SHA}`,
              branch: `backport-${SHA}`,
              since: 1000,
            }),
          ],
          [],
          [],
          (runId) => runId === 100 ? 12 : undefined,
          [],
        );

        expect(boxOf(built, "github-hosted", "ubuntu-latest").jobs).toEqual([{
          id: 1,
          job: "test 0123456",
          repository: "labs",
          workflow: "CI 0123456",
          branch: `backport-${SHA}`,
          pullRequest: 12,
          commit: "0123456",
          runId: "100",
          running: true,
          since: 1000,
          labels: ["ubuntu-latest"],
          runner: "GitHub Actions 1001438681",
          url: "https://github.com/acme/labs/actions/runs/100/job/1",
        }]);
      });

      it("gives a token of a run with no pull request `null`", () => {
        const built = board([job(1, { runId: 200 })]);

        expect(poolOf(built, "github-hosted").queue[0].pullRequest).toBeNull();
      });

      it("lists the runs on the board, those with the most jobs first, then by ID", () => {
        const built = board([
          job(1, { runId: 200 }),
          hosted(2, ["ubuntu-latest"], { runId: 100 }),
          running(3, "ci-mac-01-1", { runId: 100 }),
          job(4, { runId: 50, labels: ["self-hosted", "cf-mac"] }),
          job(5, { runId: 50 }),
        ], macRunners());

        expect(built.runs).toEqual([
          { id: "100", jobs: 2 },
          { id: "50", jobs: 2 },
          { id: "200", jobs: 1 },
        ]);
      });

      it("carries the problems it is given", () => {
        const built = buildBoard([], [], [], () => undefined, ["runners of acme: 403"]);

        expect(built.problems).toEqual(["runners of acme: 403"]);
        expect(built.pools).toEqual([]);
        expect(built.runs).toEqual([]);
      });
    });
  });

  describe("boardTokens()", () => {
    it("returns every token, queued, in slots, and beside them", () => {
      const built = board([
        job(1, { labels: ["self-hosted", "cf-mac"] }),
        running(2, "ci-mac-01-1"),
        running(3, "ci-mac-01-1"),
        hosted(4, ["ubuntu-latest"]),
      ], macRunners());

      expect(boardTokens(built).map((token) => token.id).sort()).toEqual([1, 2, 3, 4]);
    });
  });

  describe("boxRunning()", () => {
    it("returns how many jobs run in slots and beside them", () => {
      const built = board(
        [running(2, "ci-mac-01-1"), running(3, "ci-mac-01-1"), running(4, "ci-mac-01-3")],
        macRunners(),
      );

      expect(boxRunning(boxOf(built, MAC_POOL, "ci-mac-01"))).toBe(3);
      expect(boxRunning(boxOf(board([], macRunners()), MAC_POOL, "ci-mac-01"))).toBe(0);
    });

    it("returns how many jobs run in a box with no slots", () => {
      const built = board([hosted(1, ["ubuntu-latest"]), hosted(2, ["ubuntu-latest"])]);

      expect(boxRunning(boxOf(built, "github-hosted", "ubuntu-latest"))).toBe(2);
    });
  });

  describe("boxOffline()", () => {
    it("returns how many of a box's runners are offline", () => {
      const built = board([], [runner("ci-mac-01-1", MAC, false), ...macRunners().slice(1)]);

      expect(boxOffline(boxOf(built, MAC_POOL, "ci-mac-01"))).toBe(1);
      expect(boxOffline(boxOf(board([], macRunners()), MAC_POOL, "ci-mac-01"))).toBe(0);
    });

    it("returns 0 for a box with no slots", () => {
      const built = board([], autoscaledRunners());

      expect(boxOffline(boxOf(built, AUTOSCALED_POOL, "cf-build, linux-autoscale"))).toBe(0);
    });
  });

  describe("MOST_PLACES", () => {
    it("is 64", () => {
      expect(MOST_PLACES).toBe(64);
    });
  });

  describe("newSteadiness()", () => {
    it("returns a memory of nothing", () => {
      const memory = newSteadiness();

      expect(memory.pools).toEqual([]);
      expect(memory.places.size).toBe(0);
      expect(memory.counts.size).toBe(0);
    });
  });

  describe("steadyBoard()", () => {
    const BOX = "cf-build, linux-autoscale";
    const [first, second, third] = autoscaledRunners().map((runner) => runner.name);
    const on = (id: number, name: string) =>
      running(id, name, { labels: ["self-hosted", "cf-build"] });
    const steadied = (jobs: ActiveJob[], memory = newSteadiness()) =>
      boxOf(steadyBoard(board(jobs, autoscaledRunners()), memory), AUTOSCALED_POOL, BOX);

    it("gives each job in a box that is not a machine's a numbered place", () => {
      const box = steadied([on(1, first), on(2, second)]);

      expect(box.slots).toEqual([1, 2].map((id, place) => ({
        id: `${AUTOSCALED_POOL}\n${BOX}#${place}`,
        name: `${BOX} place ${place + 1}`,
        label: "",
        online: true,
        job: expect.objectContaining({ id }),
        place: true,
      })));
      expect(box.jobs).toEqual([]);
    });

    it("leaves a box with no jobs, which has never had any, without places", () => {
      const box = steadied([]);

      expect(box.slots).toBeNull();
      expect(box.idle).toBe(2);
    });

    it("keeps a job's place when another leaves, and gives the empty place to the next job", () => {
      const memory = newSteadiness();
      steadied([on(1, first), on(2, second)], memory);

      expect(slotJobs(steadied([on(2, second)], memory))).toEqual([null, 2]);
      expect(slotJobs(steadied([on(2, second), on(3, first)], memory))).toEqual([3, 2]);
      expect(slotJobs(steadied([on(2, second), on(3, first), on(4, third)], memory)))
        .toEqual([3, 2, 4]);
      expect(slotJobs(steadied([], memory))).toEqual([null, null, null]);
    });

    it("leaves a machine's box as it is", () => {
      const built = board([running(7, "ci-mac-01-2")], macRunners());

      const steady = steadyBoard(built, newSteadiness());
      expect(steady.pools).toEqual(built.pools);
    });

    it("keeps the queues of the pools on the board", () => {
      const built = board([job(1), job(2, { labels: ["self-hosted", "cf-mac"] })], macRunners());

      const steady = steadyBoard(built, newSteadiness());
      expect(queueIds(poolOf(steady, "github-hosted"))).toEqual([1]);
      expect(queueIds(poolOf(steady, MAC_POOL))).toEqual([2]);
    });

    describe("a box of known capacity", () => {
      const large = (ids: number[], maximum: number | null = 4) =>
        board(
          ids.map((id) =>
            running(id, `ubuntu-24.04-32-core-${id}`, { labels: [], runnerGroup: null })
          ),
          [],
          [{ ...LARGE, maximum }],
        );

      it("has a place for each job it can run at once", () => {
        const box = boxOf(
          steadyBoard(large([1]), newSteadiness()),
          LARGE_POOL,
          "ubuntu-24.04-32-core",
        );

        expect(slotJobs(box)).toEqual([1, null, null, null]);
      });

      it("puts the jobs that do not fit beside its places", () => {
        const box = boxOf(
          steadyBoard(large([1, 2, 3, 4, 5]), newSteadiness()),
          LARGE_POOL,
          "ubuntu-24.04-32-core",
        );

        expect(slotJobs(box)).toEqual([1, 2, 3, 4]);
        expect(box.jobs.map((token) => token.id)).toEqual([5]);
      });

      it("moves a job whose place it no longer has to the first free one", () => {
        const memory = newSteadiness();
        steadyBoard(large([1, 2, 3, 4]), memory);

        const box = boxOf(steadyBoard(large([4], 2), memory), LARGE_POOL, "ubuntu-24.04-32-core");
        expect(slotJobs(box)).toEqual([4, null]);
      });

      it("grows with its jobs when it can run more than `MOST_PLACES` at once, or does not say", () => {
        const many = boxOf(
          steadyBoard(large([1], MOST_PLACES + 1), newSteadiness()),
          LARGE_POOL,
          "ubuntu-24.04-32-core",
        );
        const unknown = boxOf(
          steadyBoard(large([1, 2], null), newSteadiness()),
          LARGE_POOL,
          "ubuntu-24.04-32-core",
        );

        expect(slotJobs(many)).toEqual([1]);
        expect(slotJobs(unknown)).toEqual([1, 2]);
      });
    });

    describe("pools and boxes that leave the board", () => {
      it("keeps an emptied pool where it was until it is forgotten", () => {
        const memory = newSteadiness();
        steadyBoard(
          board([running(7, "ci-mac-01-2"), hosted(8, ["ubuntu-latest"])], macRunners()),
          memory,
        );
        const later = board([hosted(9, ["ubuntu-latest"])]);

        const steady = steadyBoard(later, memory);
        expect(poolIds(steady)).toEqual([MAC_POOL, "github-hosted"]);
        expect(slotJobs(boxOf(steady, MAC_POOL, "ci-mac-01"))).toEqual([null, null, null]);
        expect(poolOf(steady, MAC_POOL).queue).toEqual([]);
        expect(slotJobs(boxOf(steady, "github-hosted", "ubuntu-latest"))).toEqual([9]);
        expect(remembersMore(memory, later)).toBe(true);

        forgetBeyond(memory, later);
        expect(remembersMore(memory, later)).toBe(false);
        expect(poolIds(steadyBoard(later, memory))).toEqual(["github-hosted"]);
      });

      it("keeps an emptied box, with its places, in a pool still on the board until it is forgotten", () => {
        const memory = newSteadiness();
        steadyBoard(board([hosted(1, ["ubuntu-latest"])]), memory);
        steadyBoard(board([hosted(1, ["ubuntu-latest"]), hosted(2, ["macos-latest"])]), memory);
        const later = board([hosted(3, ["ubuntu-latest"])]);

        const steady = steadyBoard(later, memory);
        expect(poolOf(steady, "github-hosted").boxes.map((box) => [box.id, slotJobs(box)]))
          .toEqual([["ubuntu-latest", [3]], ["macos-latest", [null]]]);
        expect(remembersMore(memory, later)).toBe(true);

        forgetBeyond(memory, later);
        expect(remembersMore(memory, later)).toBe(false);
        expect(memory.pools.map((pool) => pool.id)).toEqual(["github-hosted"]);
        expect(poolOf(steadyBoard(later, memory), "github-hosted").boxes.map((box) => box.id))
          .toEqual(["ubuntu-latest"]);
      });

      it("puts pools that come onto the board after those it has shown", () => {
        const memory = newSteadiness();
        steadyBoard(board([hosted(1, ["ubuntu-latest"])]), memory);
        const later = board([hosted(1, ["ubuntu-latest"])], macRunners());

        expect(poolIds(later)).toEqual([MAC_POOL, "github-hosted"]);
        expect(poolIds(steadyBoard(later, memory))).toEqual(["github-hosted", MAC_POOL]);
        expect(remembersMore(memory, later)).toBe(false);
      });
    });
  });

  describe("remembersMore()", () => {
    it("returns `false` for a memory of nothing", () => {
      expect(remembersMore(newSteadiness(), board([job(1)]))).toBe(false);
    });
  });

  describe("forgetBeyond()", () => {
    it("keeps the pools and boxes the board has", () => {
      const memory = newSteadiness();
      const built = board([hosted(1, ["ubuntu-latest"])], macRunners());
      steadyBoard(built, memory);

      forgetBeyond(memory, built);
      expect(memory.pools.map((pool) => [pool.id, pool.boxes.map((box) => box.id)])).toEqual([
        [MAC_POOL, ["ci-mac-01"]],
        ["github-hosted", ["ubuntu-latest"]],
      ]);
    });

    it("forgets how many places a box it forgets had, and keeps those of a box still shown", () => {
      const many = Array.from({ length: 120 }, (_, n) => hosted(n + 1, ["ubuntu-latest"]));
      const macs = [201, 202, 203].map((id) => hosted(id, ["macos-latest"]));
      const later = board([macs[1]]);
      const back = board([hosted(300, ["ubuntu-latest"]), macs[1]]);
      const shown = (forget: boolean) => {
        const memory = newSteadiness();
        steadyBoard(board([...many, ...macs]), memory);
        steadyBoard(later, memory);
        if (forget) forgetBeyond(memory, later);
        return steadyBoard(back, memory);
      };

      const forgotten = shown(true);
      expect(slotJobs(boxOf(forgotten, "github-hosted", "ubuntu-latest"))).toEqual([300]);
      expect(slotJobs(boxOf(forgotten, "github-hosted", "macos-latest"))).toEqual([
        null,
        202,
        null,
      ]);
      const kept = shown(false);
      expect(boxOf(kept, "github-hosted", "ubuntu-latest").slots?.length).toBe(120);
    });

    it("forgets how many places the boxes of a pool it forgets had", () => {
      const names = autoscaledRunners().map((runner) => runner.name);
      const on = (id: number) =>
        running(id, names[id % 2], { labels: ["self-hosted", "cf-build"] });
      const box = (memory: Steadiness) =>
        boxOf(
          steadyBoard(board([on(9)], autoscaledRunners()), memory),
          AUTOSCALED_POOL,
          "cf-build, linux-autoscale",
        );
      const forgotten = newSteadiness();
      const kept = newSteadiness();
      for (const memory of [forgotten, kept]) {
        steadyBoard(board([1, 2, 3, 4, 5].map(on), autoscaledRunners()), memory);
        steadyBoard(board([]), memory);
      }

      forgetBeyond(forgotten, board([]));
      expect(slotJobs(box(forgotten))).toEqual([9]);
      expect(box(kept).slots?.length).toBe(5);
    });
  });

  describe("stableHash()", () => {
    it("returns FNV-1a's 32-bit hash", () => {
      expect(stableHash("")).toBe(0x811c9dc5);
      expect(stableHash("a")).toBe(0xe40c292c);
      expect(stableHash("foobar")).toBe(0xbf9cf968);
    });
  });

  describe("RUN_COLORS", () => {
    it("holds twenty-four different colors", () => {
      expect(new Set(RUN_COLORS).size).toBe(24);
      expect(RUN_COLORS.length).toBe(24);
    });
  });

  describe("RunPalette", () => {
    const STRONG = 12;
    const preferred = (id: string) => stableHash(id) % STRONG;
    const runs = (ids: readonly string[]) => ids.map((id) => ({ id, jobs: 1 }));
    /** Two run IDs that hash to strong color `color`. */
    const clashing = (color = 0): [string, string] => {
      const ids: string[] = [];
      for (let n = 1; ids.length < 2; n++) {
        if (preferred(String(n)) === color) ids.push(String(n));
      }
      return [ids[0], ids[1]];
    };

    describe("instance members", () => {
      describe("update()", () => {
        it("gives a run the strong color its ID hashes to", () => {
          const palette = new RunPalette();

          palette.update(runs(["100"]));
          expect(palette.color("100")).toBe(RUN_COLORS[preferred("100")]);
        });

        it("gives a run whose color another has the next strong color", () => {
          const [a, b] = clashing();
          const palette = new RunPalette();

          palette.update(runs([a, b]));
          expect(palette.color(a)).toBe(RUN_COLORS[preferred(a)]);
          expect(palette.color(b)).toBe(RUN_COLORS[(preferred(a) + 1) % STRONG]);
        });

        it("wraps round to the first strong color before taking a pale one", () => {
          const [a, b] = clashing(STRONG - 1);
          const palette = new RunPalette();

          palette.update(runs([a, b]));
          expect(palette.color(a)).toBe(RUN_COLORS[STRONG - 1]);
          expect(palette.color(b)).toBe(RUN_COLORS[0]);
        });

        it("keeps a run's color while it stays on the board", () => {
          const [a, b] = clashing();
          const palette = new RunPalette();
          palette.update(runs([b]));

          palette.update(runs([a, b]));
          expect(palette.color(b)).toBe(RUN_COLORS[preferred(b)]);
          expect(palette.color(a)).toBe(RUN_COLORS[(preferred(a) + 1) % STRONG]);
        });

        it("forgets runs no longer on the board, freeing their colors", () => {
          const [a, b] = clashing();
          const palette = new RunPalette();
          palette.update(runs([a]));

          palette.update(runs([b]));
          expect(palette.color(b)).toBe(RUN_COLORS[preferred(b)]);
        });

        it("gives pale colors only once the strong ones are all in use", () => {
          const ids = Array.from({ length: STRONG + 1 }, (_, n) => `run ${n}`);
          const palette = new RunPalette();

          palette.update(runs(ids.slice(0, STRONG)));
          expect(new Set(ids.slice(0, STRONG).map((id) => palette.color(id))))
            .toEqual(new Set(RUN_COLORS.slice(0, STRONG)));
          palette.update(runs(ids));
          expect(palette.color(ids[STRONG])).toBe(RUN_COLORS[STRONG]);
        });

        it("gives a run its strong color, shared, once every color is in use", () => {
          const ids = Array.from({ length: RUN_COLORS.length + 1 }, (_, n) => `run ${n}`);
          const palette = new RunPalette();

          palette.update(runs(ids));
          const last = ids[RUN_COLORS.length];
          expect(palette.color(last)).toBe(RUN_COLORS[preferred(last)]);
          expect(new Set(ids.slice(0, -1).map((id) => palette.color(id))).size)
            .toBe(RUN_COLORS.length);
        });
      });

      describe("color()", () => {
        it("returns the color a run's ID hashes to among all of them for a run it has not been given", () => {
          expect(new RunPalette().color("100")).toBe(
            RUN_COLORS[stableHash("100") % RUN_COLORS.length],
          );
        });
      });
    });
  });
});
