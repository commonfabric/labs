import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { GitHubRun } from "./github-runs.ts";
import { RunListFile, type SavedHead } from "./run-list-file.ts";

const NOW = Date.UTC(2026, 0, 2);

/** A completed run, created `id` seconds into 2026 and updated at `updated`. */
function run(id: number, updated = id): GitHubRun {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 0, 1) + seconds * 1_000).toISOString();
  return {
    id,
    name: "CI",
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: `sha${id}`,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    display_title: `run ${id}`,
    created_at: at(id),
    run_started_at: at(id),
    updated_at: at(updated),
    html_url: `https://github.com/example/repo/actions/runs/${id}`,
    head_commit: { message: `commit ${id}` },
  };
}

/** Runs `from` down to `to`, newest first. */
function runs(from: number, to: number): GitHubRun[] {
  return Array.from({ length: from - to + 1 }, (_, i) => run(from - i));
}

/** A head of example/repo's ci.yml holding `held`, read at `readAt`. */
function head(held: GitHubRun[], fields: Partial<SavedHead> = {}): SavedHead {
  return {
    repo: "example/repo",
    workflow: "ci.yml",
    runs: held,
    complete: false,
    drift: 0,
    readAt: NOW - 1_000,
    usedAt: NOW - 1_000,
    readers: [{ reader: "reader", id: held[held.length - 1].id, at: NOW }],
    ...fields,
  };
}

const ids = (list: readonly GitHubRun[]) => list.map((held) => held.id);

/** A reader that read to the end of a list of runs numbered from 1. */
const DEEP = [{ reader: "deep", id: 1, at: NOW }];

describe("RunListFile", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "run-list-file-" });
    path = join(directory, "run-lists.json");
  });

  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  /** Writes `value` to the file as JSON, bypassing `save()`. */
  const write = (value: unknown) =>
    Deno.writeTextFile(path, JSON.stringify(value));

  /** Reads the file's head of `repo`'s `workflow`. */
  const load = (workflow: string | number = "ci.yml", repo = "example/repo") =>
    new RunListFile(path).load(repo, workflow);

  /** Reads the file's head of example/repo's ci.yml, which it must hold. */
  async function loadHead(): Promise<SavedHead> {
    const saved = await load();
    if (saved === undefined) throw new Error("The file holds no head.");
    return saved;
  }

  describe("instance members", () => {
    describe("load()", () => {
      it("returns the heads `save()` wrote", async () => {
        const saved = head(runs(30, 21), {
          complete: true,
          drift: 2,
          workflow: 1234,
        });
        await new RunListFile(path).save(() => [saved], 0);

        expect(await load(1234)).toEqual(saved);
      });

      it("returns a head whose last run was found further down than its place", async () => {
        await new RunListFile(path).save(
          () => [head(runs(30, 21), { drift: -3 })],
          0,
        );

        expect((await loadHead()).drift).toBe(-3);
      });

      it("returns no heads when the file does not exist", async () => {
        expect(await load()).toBeUndefined();
      });

      it("returns no heads when the file is not JSON", async () => {
        await Deno.writeTextFile(path, "{ not json");

        expect(await load()).toBeUndefined();
      });

      it("returns no heads when the file holds JSON that does not list heads", async () => {
        await write([head(runs(30, 21))]);

        expect(await load()).toBeUndefined();
      });

      it("drops a head that is not an object, or whose reader or newest run is not one", async () => {
        await write({
          heads: [
            7,
            { ...head(runs(30, 21), { repo: "example/reader" }), readers: [7] },
            { ...head(runs(30, 21), { repo: "example/run" }), runs: [7] },
            head(runs(30, 21), { repo: "example/kept" }),
          ],
        });

        expect(await load("ci.yml", "example/kept")).toBeDefined();
        expect(await load("ci.yml", "example/reader")).toBeUndefined();
        expect(await load("ci.yml", "example/run")).toBeUndefined();
      });

      it("returns a run whose name and path GitHub left out without them", async () => {
        // A run read from GitHub holds every field, even one GitHub left out.
        const bare = { ...run(30), name: undefined, path: undefined };
        await new RunListFile(path).save(() => [head([bare])], 0);

        const loaded = await loadHead();

        expect(loaded.runs).toEqual([bare]);
        expect(JSON.parse(await Deno.readTextFile(path)).heads[0].runs[0])
          .toMatchObject({ name: null, path: null });
      });

      it("ignores fields it does not know", async () => {
        await write({
          later: true,
          heads: [{
            ...head(runs(30, 21)),
            later: [1, 2],
            runs: runs(30, 21).map((held) => ({ ...held, later: "x" })),
          }],
        });

        const loaded = await loadHead();

        expect(loaded).toEqual(head(runs(30, 21)));
      });

      it("cuts a head back above the first run that lacks a field it reads", async () => {
        const { display_title: _, ...untitled } = run(27);
        const held = [...runs(30, 28), untitled, ...runs(26, 21)];
        await write({
          heads: [{ ...head(runs(30, 21), { complete: true }), runs: held }],
        });

        const loaded = await loadHead();

        expect(ids(loaded.runs)).toEqual([30, 29, 28]);
        expect(loaded.complete).toBe(false);
      });

      it("cuts a head back above the first run held out of order", async () => {
        await write({ heads: [head([run(30), run(29), run(31), run(28)])] });

        const loaded = await loadHead();

        expect(ids(loaded.runs)).toEqual([30, 29]);
      });

      it("drops a head whose newest run cannot be used", async () => {
        const held = [{ ...run(30), run_attempt: "1" }, ...runs(29, 21)];
        await write({ heads: [{ ...head(runs(30, 21)), runs: held }] });

        expect(await load()).toBeUndefined();
      });

      it("drops a head that lacks a field it reads", async () => {
        const { drift: _, ...driftless } = head(runs(30, 21));
        await write({ heads: [driftless] });

        expect(await load()).toBeUndefined();
      });

      it("drops a head that records a time later than the present", async () => {
        const later = Date.now() + 60_000;
        await write({
          heads: [
            head(runs(30, 21), { readAt: later }),
            head(runs(30, 21), { repo: "example/used", usedAt: later }),
            head(runs(30, 21), {
              repo: "example/reader",
              readers: [{ reader: "reader", id: 21, at: later }],
            }),
            head(runs(30, 21), { repo: "example/kept" }),
          ],
        });

        const repos = ["example/repo", "example/used", "example/reader"];

        expect(await load("ci.yml", "example/kept")).toBeDefined();
        for (const repo of repos) {
          expect(await load("ci.yml", repo)).toBeUndefined();
        }
      });
    });

    describe("save()", () => {
      it("rejects, leaving no temporary file, when it cannot replace the file", async () => {
        await Deno.mkdir(join(path, "in-the-way"), { recursive: true });

        await expect(
          new RunListFile(path).save(() => [head(runs(30, 21))], 0),
        ).rejects.toThrow();

        const names: string[] = [];
        for await (const entry of Deno.readDir(directory)) {
          names.push(entry.name);
        }
        expect(names.sort()).toEqual(["run-lists.json", "run-lists.json.lock"]);
      });

      it("replaces a file that is not JSON", async () => {
        await Deno.writeTextFile(path, "{ not json");

        await new RunListFile(path).save(() => [head(runs(30, 21))], 0);

        expect(await load()).toEqual(head(runs(30, 21)));
      });

      it("keeps the heads the file holds of other lists", async () => {
        const other = head(runs(50, 41), { workflow: "other.yml" });
        await new RunListFile(path).save(() => [other], 0);

        await new RunListFile(path).save(() => [head(runs(30, 21))], 0);

        expect(await load("other.yml")).toEqual(other);
        expect(await load()).toEqual(head(runs(30, 21)));
      });

      it("keeps every head when several files save at once", async () => {
        await Promise.all(
          ["a.yml", "b.yml", "c.yml"].map((workflow) =>
            new RunListFile(path).save(
              () => [head(runs(30, 21), { workflow })],
              0,
            )
          ),
        );

        for (const workflow of ["a.yml", "b.yml", "c.yml"]) {
          expect(await load(workflow)).toBeDefined();
        }
      });

      it("drops the heads last used before `since`", async () => {
        await new RunListFile(path).save(
          () => [head(runs(30, 21), { usedAt: NOW - 10 })],
          0,
        );

        await new RunListFile(path).save(
          () => [head(runs(50, 41), { workflow: "other.yml", usedAt: NOW })],
          NOW - 5,
        );

        expect(await load()).toBeUndefined();
        expect(await load("other.yml")).toBeDefined();
      });

      it("does not save a head that holds no runs", async () => {
        await new RunListFile(path).save(() => [head(runs(30, 21))], 0);

        await new RunListFile(path).save(
          () => [{ ...head(runs(30, 21)), runs: [], readAt: NOW }],
          0,
        );

        expect(await load()).toEqual(head(runs(30, 21)));
      });

      it("keeps the head of a list whose top was read last", async () => {
        await new RunListFile(path).save(
          () => [head(runs(30, 1), { readAt: NOW - 5, readers: DEEP })],
          0,
        );

        await new RunListFile(path).save(
          () => [head(runs(40, 20), { readAt: NOW })],
          0,
        );

        expect(await load()).toEqual(head(runs(40, 20), { readAt: NOW }));
      });

      it("keeps of two heads of a list whose tops were read at the same moment the one holding more runs", async () => {
        await new RunListFile(path).save(
          () => [head(runs(30, 1), { readAt: NOW, readers: DEEP })],
          0,
        );

        await new RunListFile(path).save(
          () => [head(runs(30, 20), { readAt: NOW })],
          0,
        );

        expect(ids((await loadHead()).runs)).toEqual(ids(runs(30, 1)));

        await new RunListFile(path).save(
          () => [head(runs(31, 1), { readAt: NOW, readers: DEEP })],
          0,
        );

        expect(ids((await loadHead()).runs)).toEqual(ids(runs(31, 1)));
      });

      it("keeps the file's head of a list when its top was read more recently", async () => {
        await new RunListFile(path).save(
          () => [head(runs(40, 20), { readAt: NOW })],
          0,
        );

        await new RunListFile(path).save(
          () => [head(runs(30, 1), { readAt: NOW - 5, readers: DEEP })],
          0,
        );

        expect(await load()).toEqual(head(runs(40, 20), { readAt: NOW }));
      });
    });
  });
});
