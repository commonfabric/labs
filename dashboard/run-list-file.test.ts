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

  /**
   * Changes what the file holds without changing its version, which no writer
   * does, so that a read of the file can be told from a read of what an
   * instance last wrote.
   */
  async function overwriteInPlace(file: string): Promise<void> {
    const { size, mtime } = await Deno.stat(file);
    await Deno.writeTextFile(file, " ".repeat(size));
    await Deno.utime(file, mtime!, mtime!);
  }

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

      it("returns only the first line of a run's head commit message", async () => {
        await write({
          heads: [head([
            { ...run(30), head_commit: { message: "Fix it\n\nAt length." } },
            run(29),
          ])],
        });

        expect((await loadHead()).runs.map((held) => held.head_commit))
          .toEqual([{ message: "Fix it" }, { message: "commit 29" }]);
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

      it("returns the heads it last wrote while the file is at the version it wrote", async () => {
        const file = new RunListFile(path);
        await file.save(() => [head(runs(30, 21))], 0);
        await overwriteInPlace(path);

        expect(await file.load("example/repo", "ci.yml")).toEqual(
          head(runs(30, 21)),
        );
        expect(await load()).toBeUndefined();
      });

      it("returns a head as it was saved after the runs given to `save()` change", async () => {
        const file = new RunListFile(path);
        const held = runs(30, 21);
        await file.save(() => [head(held)], 0);
        held.length = 0;

        const loaded = await file.load("example/repo", "ci.yml");
        loaded?.runs.splice(5);

        expect(await file.load("example/repo", "ci.yml")).toEqual(
          head(runs(30, 21)),
        );
      });

      it("returns no heads, and logs why, when the file cannot be checked", async () => {
        await Deno.mkdir(join(directory, "nested"));
        const file = new RunListFile(
          join(directory, "nested", "run-lists.json"),
        );
        await file.save(() => [head(runs(30, 21))], 0);
        await Deno.remove(join(directory, "nested"), { recursive: true });
        await Deno.writeTextFile(join(directory, "nested"), "");
        const logged: string[] = [];
        const realError = console.error;
        console.error = (...parts: unknown[]) =>
          void logged.push(parts.map(String).join(" "));
        try {
          expect(await file.load("example/repo", "ci.yml")).toBeUndefined();
        } finally {
          console.error = realError;
        }

        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("could not be read");
      });

      it("keeps a head another instance saved while a load of an older version was in progress", async () => {
        const file = new RunListFile(path);
        await file.save(() => [head(runs(30, 21), { workflow: "a.yml" })], 0);
        await new RunListFile(path).save(
          () => [head(runs(30, 21), { workflow: "b.yml" })],
          0,
        );
        // The load opens the version holding a.yml and b.yml, and is held
        // there until `file` has taken the lock to save, by which time another
        // instance has saved c.yml.
        const opened = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const realOpen = Deno.open;
        const realLock = Deno.FsFile.prototype.lock;
        Deno.open = (async (target, options) => {
          const handle = await realOpen(target, options);
          if (target === path && options === undefined) {
            Deno.open = realOpen;
            opened.resolve();
            await release.promise;
          }
          return handle;
        }) as typeof Deno.open;
        try {
          const loading = file.load("example/repo", "a.yml");
          await opened.promise;
          await new RunListFile(path).save(
            () => [head(runs(30, 21), { workflow: "c.yml" })],
            0,
          );
          Deno.FsFile.prototype.lock = async function (exclusive) {
            await realLock.call(this, exclusive);
            release.resolve();
          };

          await file.save(
            () => [head(runs(30, 21), { workflow: "d.yml" })],
            0,
          );
          await loading;
        } finally {
          Deno.open = realOpen;
          Deno.FsFile.prototype.lock = realLock;
        }

        for (const workflow of ["a.yml", "b.yml", "c.yml", "d.yml"]) {
          expect(await load(workflow)).toBeDefined();
        }
      });

      it("returns a head another instance saved since it last read the file", async () => {
        const file = new RunListFile(path);
        await file.save(() => [head(runs(30, 21))], 0);

        const other = head(runs(50, 41), { workflow: "other.yml" });
        await new RunListFile(path).save(() => [other], 0);

        expect(await file.load("example/repo", "other.yml")).toEqual(other);
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

      it("removes the temporary files that interrupted saves left beside the file", async () => {
        const leftover = `run-lists.json.${crypto.randomUUID()}.tmp`;
        const other = `other.json.${crypto.randomUUID()}.tmp`;
        await Deno.writeTextFile(join(directory, leftover), "{");
        await Deno.writeTextFile(join(directory, other), "{");

        await new RunListFile(path).save(() => [head(runs(30, 21))], 0);

        const names: string[] = [];
        for await (const entry of Deno.readDir(directory)) {
          names.push(entry.name);
        }
        expect(names.sort()).toEqual(
          [other, "run-lists.json", "run-lists.json.lock"].sort(),
        );
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
