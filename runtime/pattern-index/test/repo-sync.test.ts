import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeProgram } from "@commonfabric/runner";
import type {
  PatternIndexPublishRequest,
  PatternIndexRepoHead,
} from "../src/client.ts";
import {
  findEntries,
  programSourceHash,
  reportMarkdown,
  type RepoSyncDeps,
  type RepoSyncOptions,
  syncFailed,
  syncRepo,
} from "../src/repo-sync.ts";

const DESCRIBED = `/**
 * Doubles a number.
 *
 * @hashtags #Math
 * @keywords double
 */
import { pattern } from "commonfabric";
export default pattern(() => ({}));
`;

const UNDESCRIBED = `import { pattern } from "commonfabric";
export default pattern(() => ({}));
`;

const HELPER = `export const twice = (n: number) => n * 2;\n`;

const OPTIONS: RepoSyncOptions = {
  repository: "acme/patterns",
  commit: "c0ffee",
  repoRoot: "/repo",
  programRoot: "patterns",
  include: ["patterns/**"],
  exclude: ["patterns/dev/**"],
};

/** A program for one entry: its own file under the program root. */
const programFor = (entry: string, contents: string): RuntimeProgram => ({
  main: `/${entry.replace("/repo/patterns/", "")}`,
  files: [{ name: `/${entry.replace("/repo/patterns/", "")}`, contents }],
});

/**
 * Stand-ins for a repository holding `files` and an index holding `heads`.
 * Each compile returns the id `id:<entry>`; `brokenCompile` names entries
 * whose compile throws, and `listingRefused` makes every listing request
 * fail.
 */
const fakes = (
  files: Record<string, string>,
  heads: PatternIndexRepoHead[] = [],
  { brokenCompile = [] as string[], listingRefused = false } = {},
) => {
  const published: PatternIndexPublishRequest[] = [];
  const listed: string[] = [];
  const deps: RepoSyncDeps = {
    trackedFiles: () => Promise.resolve(Object.keys(files)),
    readTextFile: (path) => {
      const contents = files[path.replace("/repo/", "")];
      return contents === undefined
        ? Promise.reject(new Error(`no file ${path}`))
        : Promise.resolve(contents);
    },
    resolveProgram: (entry) =>
      Promise.resolve(programFor(entry, files[entry.replace("/repo/", "")])),
    compileProgram: (program) => {
      if (brokenCompile.some((path) => program.main.endsWith(path))) {
        return Promise.reject(new Error("type error at main.tsx:3"));
      }
      return Promise.resolve({ patternId: `id:${program.main}`, program });
    },
    client: {
      listRepoHeads: () => Promise.resolve({ heads }),
      publishPattern: (request) => {
        published.push(request);
        return Promise.resolve({
          patternId: request.patternId,
          created: true,
        });
      },
      requestListing: (request) => {
        if (listingRefused) {
          return Promise.reject(new Error("pattern index requestListing 429"));
        }
        listed.push(request.patternId);
        return Promise.resolve({
          patternId: request.patternId,
          listing: "pending",
        });
      },
    },
  };
  return { deps, published, listed };
};

describe("repo-sync", () => {
  describe("findEntries()", () => {
    it("returns included, non-test modules with a default export, sorted", async () => {
      const { deps } = fakes({
        "patterns/b/main.tsx": DESCRIBED,
        "patterns/a/main.tsx": UNDESCRIBED,
        "patterns/a/helper.ts": HELPER,
        "patterns/a/main.test.tsx": DESCRIBED,
        "patterns/a/view_test.tsx": DESCRIBED,
        "patterns/a/README.md": "export default 1",
        "patterns/dev/fixture.tsx": DESCRIBED,
        "src/elsewhere.tsx": DESCRIBED,
      });
      expect(await findEntries(OPTIONS, deps)).toEqual([
        "patterns/a/main.tsx",
        "patterns/b/main.tsx",
      ]);
    });

    it("returns no module whose `export default` is not at a line start", async () => {
      const { deps } = fakes({
        "patterns/a/main.tsx": `// export default is mentioned here\n`,
      });
      expect(await findEntries(OPTIONS, deps)).toEqual([]);
    });
  });

  describe("programSourceHash()", () => {
    const program: RuntimeProgram = {
      main: "/a.tsx",
      files: [
        { name: "/a.tsx", contents: "a" },
        { name: "/b.ts", contents: "b" },
      ],
    };

    it("returns the same hash whatever order the files are in", async () => {
      expect(
        await programSourceHash({
          ...program,
          files: [...program.files].reverse(),
        }),
      ).toBe(await programSourceHash(program));
    });

    it("returns a different hash when an imported file's contents change", async () => {
      expect(
        await programSourceHash({
          ...program,
          files: [program.files[0], { name: "/b.ts", contents: "B" }],
        }),
      ).not.toBe(await programSourceHash(program));
    });

    it("returns a different hash when the export the program runs changes", async () => {
      expect(await programSourceHash({ ...program, mainExport: "other" }))
        .not.toBe(await programSourceHash(program));
    });
  });

  describe("syncRepo()", () => {
    it("publishes a changed entry with its source, doc metadata and no predecessor", async () => {
      const { deps, published, listed } = fakes({
        "patterns/a/main.tsx": DESCRIBED,
      });
      const report = await syncRepo(OPTIONS, deps);
      expect(report.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "published",
        patternId: "id:/a/main.tsx",
      }]);
      expect(published).toHaveLength(1);
      expect(published[0].description).toBe("Doubles a number.");
      expect(published[0].hashtags).toEqual(["math"]);
      expect(published[0].priorPatternId).toBeUndefined();
      expect(published[0].source).toEqual({
        repository: "acme/patterns",
        path: "patterns/a/main.tsx",
        commit: "c0ffee",
        sourceHash: await programSourceHash(
          programFor("/repo/patterns/a/main.tsx", DESCRIBED),
        ),
      });
      expect(listed).toEqual(["id:/a/main.tsx"]);
    });

    it("compiles and publishes nothing for an entry whose hash matches its head", async () => {
      const sourceHash = await programSourceHash(
        programFor("/repo/patterns/a/main.tsx", DESCRIBED),
      );
      const { deps, published } = fakes(
        { "patterns/a/main.tsx": DESCRIBED },
        [{
          path: "patterns/a/main.tsx",
          patternId: "old",
          sourceHash,
          commit: "beef",
        }],
        // A compile would throw, so reaching it would fail the entry.
        { brokenCompile: ["/a/main.tsx"] },
      );
      const report = await syncRepo(OPTIONS, deps);
      expect(report.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "unchanged",
        patternId: "old",
      }]);
      expect(published).toEqual([]);
    });

    it("reports an entry as unchanged when the index says its head already has the id", async () => {
      const { deps } = fakes({ "patterns/a/main.tsx": DESCRIBED });
      deps.client.publishPattern = (request) =>
        Promise.resolve({
          patternId: request.patternId,
          created: false,
          unchanged: true,
        });
      const report = await syncRepo(OPTIONS, deps);
      expect(report.entries[0].status).toBe("unchanged");
    });

    it("publishes nothing for an entry with no description, and reports it", async () => {
      const { deps, published } = fakes({
        "patterns/a/main.tsx": UNDESCRIBED,
      });
      const report = await syncRepo(OPTIONS, deps);
      expect(report.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "undescribed",
      }]);
      expect(published).toEqual([]);
      expect(syncFailed(report)).toBe(false);
    });

    it("records a failed compile and still publishes the other entries", async () => {
      const { deps, published } = fakes(
        {
          "patterns/a/main.tsx": DESCRIBED,
          "patterns/b/main.tsx": DESCRIBED,
        },
        [],
        { brokenCompile: ["/a/main.tsx"] },
      );
      const report = await syncRepo(OPTIONS, deps);
      expect(report.entries).toEqual([
        {
          path: "patterns/a/main.tsx",
          status: "failed",
          reason: "type error at main.tsx:3",
        },
        {
          path: "patterns/b/main.tsx",
          status: "published",
          patternId: "id:/b/main.tsx",
        },
      ]);
      expect(published.map((request) => request.source?.path)).toEqual([
        "patterns/b/main.tsx",
      ]);
      expect(syncFailed(report)).toBe(true);
    });

    it("records a refused publish as a failed entry", async () => {
      const { deps } = fakes({ "patterns/a/main.tsx": DESCRIBED });
      deps.client.publishPattern = () =>
        Promise.reject(new Error("pattern index publishPattern 403"));
      const report = await syncRepo(OPTIONS, deps);
      expect(report.entries[0]).toEqual({
        path: "patterns/a/main.tsx",
        status: "failed",
        reason: "pattern index publishPattern 403",
      });
      expect(syncFailed(report)).toBe(true);
    });

    it("reports a refused listing request without failing the entry", async () => {
      const { deps } = fakes({ "patterns/a/main.tsx": DESCRIBED }, [], {
        listingRefused: true,
      });
      const report = await syncRepo(OPTIONS, deps);
      expect(report.entries[0].status).toBe("published");
      expect(report.listingFailures).toEqual([{
        path: "patterns/a/main.tsx",
        reason: "pattern index requestListing 429",
      }]);
      expect(syncFailed(report)).toBe(false);
    });

    it("throws, publishing nothing, when the index refuses to list the heads", async () => {
      const { deps, published } = fakes({ "patterns/a/main.tsx": DESCRIBED });
      deps.client.listRepoHeads = () =>
        Promise.reject(new Error("pattern index listRepoHeads 401"));
      await expect(syncRepo(OPTIONS, deps)).rejects.toThrow("401");
      expect(published).toEqual([]);
    });

    it("returns the head paths that are no longer entries, and the gate findings heads carry", async () => {
      const { deps } = fakes({}, [
        {
          path: "patterns/gone.tsx",
          patternId: "g",
          sourceHash: "h",
          commit: "c",
          gates: {
            privacy: {
              status: "failed",
              attempt: 1,
              findings: [{
                file: "/gone.tsx",
                line: 4,
                category: "contact",
                why: "names a | person",
              }],
            },
            quality: { status: "passed", attempt: 1, findings: [] },
          },
        },
      ]);
      const report = await syncRepo(OPTIONS, deps);
      expect(report.gone).toEqual(["patterns/gone.tsx"]);
      expect(report.gardeners).toEqual([{
        path: "patterns/gone.tsx",
        gardener: "privacy",
        status: "failed",
        findings: [{
          file: "/gone.tsx",
          line: 4,
          category: "contact",
          why: "names a | person",
        }],
      }]);
    });
  });

  describe("reportMarkdown()", () => {
    it("returns a summary line counting each outcome, and a section per kind", () => {
      const markdown = reportMarkdown({
        repository: "acme/patterns",
        commit: "0123456789abcdef",
        entries: [
          { path: "p/a.tsx", status: "published", patternId: "A" },
          { path: "p/b.tsx", status: "unchanged", patternId: "B" },
          { path: "p/c.tsx", status: "undescribed" },
          { path: "p/d.tsx", status: "failed", reason: "bad | thing\nhere" },
        ],
        listingFailures: [],
        gone: ["p/e.tsx"],
        gardeners: [{
          path: "p/b.tsx",
          gardener: "privacy",
          status: "failed",
          findings: [{ category: "contact", why: "a | b" }],
        }],
      });
      expect(markdown).toContain(
        "At `0123456789ab`: 4 entries, 1 published, 1 unchanged, 1 without a description, 1 failed.",
      );
      expect(markdown).toContain("| `p/d.tsx` | bad \\| thing here |");
      expect(markdown).toContain("| `p/a.tsx` | `A` |");
      expect(markdown).toContain(
        "| `p/b.tsx` | privacy | failed | contact |  | a \\| b |",
      );
      expect(markdown).toContain("- `p/c.tsx`");
      expect(markdown).toContain("- `p/e.tsx`");
    });
  });
});
