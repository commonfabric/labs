import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeProgram } from "@commonfabric/runner";
import type {
  PatternIndexClient,
  PatternIndexPublishRequest,
  PatternIndexRepoHead,
} from "../src/client.ts";
import {
  findEntries,
  type PlanDeps,
  planRepo,
  type RepoEntryOptions,
} from "../src/repo-plan.ts";
import {
  type PlannedEntry,
  planProblem,
  programSourceHash,
  publishPlan,
  reportMarkdown,
  syncFailed,
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

const FLAGS = { contentAddressedSchemas: true };

const OPTIONS: RepoEntryOptions = {
  repoRoot: "/repo",
  programRoot: "patterns",
  include: ["patterns/**"],
  exclude: ["patterns/dev/**"],
};

const PUBLISH_OPTIONS = { repository: "acme/patterns", commit: "c0ffee" };

/** A program for one entry: its own file under the program root. */
const programFor = (entry: string, contents: string): RuntimeProgram => {
  const name = `/${entry.replace("/repo/patterns/", "")}`;
  return { main: name, files: [{ name, contents }] };
};

/**
 * Plan-phase stand-ins for a repository holding `files`. Each compile returns
 * the id `id:<entry>`; `brokenCompile` names entries whose compile throws.
 */
const planDeps = (
  files: Record<string, string>,
  brokenCompile: readonly string[] = [],
): PlanDeps => ({
  trackedFiles: () => Promise.resolve(Object.keys(files)),
  readTextFile: (path) => {
    const contents = files[path.replace("/repo/", "")];
    return contents === undefined
      ? Promise.reject(new Error(`no file ${path}`))
      : Promise.resolve(contents);
  },
  resolveProgram: (entry) =>
    Promise.resolve(programFor(entry, files[entry.replace("/repo/", "")])),
  compileProgram: (program) =>
    brokenCompile.some((path) => program.main.endsWith(path))
      ? Promise.reject(new Error("type error at main.tsx:3"))
      : Promise.resolve({ patternId: `id:${program.main}`, program }),
  experimental: FLAGS,
});

/** A compiled plan entry for `path`, as the plan phase writes one. */
const compiledEntry = (path: string, sourceHash = `hash:${path}`) => ({
  path,
  status: "compiled" as const,
  sourceHash,
  request: {
    patternId: `id:${path}`,
    description: "Doubles a number.",
    hashtags: [],
    program: { main: "/a.tsx", files: [{ name: "/a.tsx", contents: "" }] },
  },
});

/**
 * Publish-phase stand-in for an index holding `heads`. `listingRefused`
 * makes every listing request fail.
 */
const fakeIndex = (
  heads: PatternIndexRepoHead[] = [],
  { listingRefused = false } = {},
) => {
  const published: PatternIndexPublishRequest[] = [];
  const listed: string[] = [];
  const client: Pick<
    PatternIndexClient,
    "listRepoHeads" | "publishPattern" | "requestListing"
  > = {
    listRepoHeads: () => Promise.resolve({ heads }),
    publishPattern: (request) => {
      published.push(request);
      return Promise.resolve({ patternId: request.patternId, created: true });
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
  };
  return { client, published, listed };
};

describe("repo-sync", () => {
  describe("findEntries()", () => {
    it("returns included, non-test modules with a default export, sorted", async () => {
      const deps = planDeps({
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

    it("returns a module that exports its default through an export list", async () => {
      const deps = planDeps({
        "patterns/a/main.tsx": "const app = 1;\nexport { app as default };\n",
      });
      expect(await findEntries(OPTIONS, deps)).toEqual([
        "patterns/a/main.tsx",
      ]);
    });

    it("returns no module whose `export default` is not at a line start", async () => {
      const deps = planDeps({
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

    it("returns the same hash whatever order the files and flags are in", async () => {
      expect(
        await programSourceHash(
          { ...program, files: [...program.files].reverse() },
          { b: true, a: false },
        ),
      ).toBe(await programSourceHash(program, { a: false, b: true }));
    });

    it("returns a different hash when an imported file's contents change", async () => {
      expect(
        await programSourceHash(
          {
            ...program,
            files: [program.files[0], { name: "/b.ts", contents: "B" }],
          },
          FLAGS,
        ),
      ).not.toBe(await programSourceHash(program, FLAGS));
    });

    it("returns a different hash when the export the program runs changes", async () => {
      expect(await programSourceHash({ ...program, mainExport: "x" }, FLAGS))
        .not.toBe(await programSourceHash(program, FLAGS));
    });

    it("returns a different hash when the files attached as data change", async () => {
      expect(
        await programSourceHash({ ...program, dataFiles: ["/b.ts"] }, FLAGS),
      ).not.toBe(await programSourceHash(program, FLAGS));
    });

    it("returns a different hash when a compiler flag changes", async () => {
      expect(
        await programSourceHash(program, { contentAddressedSchemas: false }),
      ).not.toBe(await programSourceHash(program, FLAGS));
    });
  });

  describe("planRepo()", () => {
    it("returns a publish request carrying the doc comment's metadata", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({ "patterns/a/main.tsx": DESCRIBED }),
      );
      const sourceHash = await programSourceHash(
        programFor("/repo/patterns/a/main.tsx", DESCRIBED),
        FLAGS,
      );
      expect(plan.entries).toHaveLength(1);
      const [entry] = plan.entries;
      expect(entry.status).toBe("compiled");
      if (entry.status !== "compiled") return;
      expect(entry.sourceHash).toBe(sourceHash);
      expect(entry.request.patternId).toBe("id:/a/main.tsx");
      expect(entry.request.description).toBe("Doubles a number.");
      expect(entry.request.hashtags).toEqual(["math"]);
      expect(entry.request.priorPatternId).toBeUndefined();
    });

    it("returns an entry with no description as failed when it does not compile", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({ "patterns/a/main.tsx": UNDESCRIBED }, ["/a/main.tsx"]),
      );
      expect(plan.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "failed",
        reason: "type error at main.tsx:3",
      }]);
    });

    it("returns a failed compile beside the entries that compiled", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({
          "patterns/a/main.tsx": DESCRIBED,
          "patterns/b/main.tsx": UNDESCRIBED,
        }, ["/a/main.tsx"]),
      );
      expect(plan.entries.map((entry) => [entry.path, entry.status])).toEqual([
        ["patterns/a/main.tsx", "failed"],
        ["patterns/b/main.tsx", "undescribed"],
      ]);
    });

    it("throws when the program root lies outside the repository", async () => {
      await expect(
        planRepo({ ...OPTIONS, programRoot: ".." }, planDeps({})),
      ).rejects.toThrow("outside the repository");
    });
  });

  describe("planProblem()", () => {
    it("returns `undefined` for a plan the plan phase wrote", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({
          "patterns/a/main.tsx": DESCRIBED,
          "patterns/b/main.tsx": UNDESCRIBED,
        }, ["/b/main.tsx"]),
      );
      expect(planProblem(JSON.parse(JSON.stringify(plan)))).toBeUndefined();
    });

    it("returns what is wrong with a malformed plan", () => {
      expect(planProblem([])).toBe("the plan has no list of entries");
      expect(planProblem({ entries: [{ status: "compiled" }] })).toBe(
        "entries[0] has no path",
      );
      expect(planProblem({ entries: [{ path: "a", status: "compiled" }] }))
        .toBe("entries[0] has no source hash");
      expect(
        planProblem({
          entries: [{ path: "a", status: "compiled", sourceHash: "h" }],
        }),
      ).toBe("entries[0] has no publish request");
      expect(
        planProblem({
          entries: [{ path: "a", status: "shipped", sourceHash: "h" }],
        }),
      ).toBe("entries[0] has an unknown status");
    });
  });

  describe("publishPlan()", () => {
    it("publishes a changed entry with the job's repository and commit as its source, and asks for listing", async () => {
      const { client, published, listed } = fakeIndex();
      const report = await publishPlan(
        { entries: [compiledEntry("patterns/a/main.tsx")] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "published",
        patternId: "id:patterns/a/main.tsx",
      }]);
      expect(published[0].source).toEqual({
        repository: "acme/patterns",
        path: "patterns/a/main.tsx",
        commit: "c0ffee",
        sourceHash: "hash:patterns/a/main.tsx",
      });
      expect(listed).toEqual(["id:patterns/a/main.tsx"]);
    });

    it("publishes nothing for an entry whose hash matches its head", async () => {
      const { client, published } = fakeIndex([{
        path: "patterns/a/main.tsx",
        patternId: "old",
        sourceHash: "same",
        commit: "beef",
      }]);
      const report = await publishPlan(
        { entries: [compiledEntry("patterns/a/main.tsx", "same")] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "unchanged",
        patternId: "old",
      }]);
      expect(published).toEqual([]);
    });

    it("returns an entry as unchanged when the index says its head already has the id", async () => {
      const { client } = fakeIndex();
      client.publishPattern = (request) =>
        Promise.resolve({
          patternId: request.patternId,
          created: false,
          unchanged: true,
        });
      const report = await publishPlan(
        { entries: [compiledEntry("patterns/a/main.tsx")] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries[0].status).toBe("unchanged");
    });

    it("returns a publish the index dropped the source from as failed", async () => {
      const { client } = fakeIndex();
      client.publishPattern = (request) =>
        Promise.resolve({
          patternId: request.patternId,
          created: true,
          ignored: ["source"],
        });
      const report = await publishPlan(
        { entries: [compiledEntry("patterns/a/main.tsx")] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries[0]).toEqual({
        path: "patterns/a/main.tsx",
        status: "failed",
        reason: "the index ignored the repository source",
      });
    });

    it("returns a refused publish as failed and still publishes the other entries", async () => {
      const { client, published } = fakeIndex();
      const publishPattern = client.publishPattern;
      client.publishPattern = (request) =>
        request.patternId === "id:patterns/a/main.tsx"
          ? Promise.reject(new Error("pattern index publishPattern 403"))
          : publishPattern(request);
      const report = await publishPlan(
        {
          entries: [
            compiledEntry("patterns/a/main.tsx"),
            compiledEntry("patterns/b/main.tsx"),
          ],
        },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries.map((entry) => entry.status)).toEqual([
        "failed",
        "published",
      ]);
      expect(published.map((request) => request.source?.path)).toEqual([
        "patterns/b/main.tsx",
      ]);
      expect(syncFailed(report)).toBe(true);
    });

    it("carries the plan's failed and undescribed entries into the report, publishing neither", async () => {
      const failed: PlannedEntry = {
        path: "patterns/a/main.tsx",
        status: "failed",
        reason: "type error",
      };
      const { client, published } = fakeIndex();
      const report = await publishPlan(
        {
          entries: [failed, {
            path: "patterns/b/main.tsx",
            status: "undescribed",
            sourceHash: "h",
          }],
        },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries).toEqual([failed, {
        path: "patterns/b/main.tsx",
        status: "undescribed",
      }]);
      expect(published).toEqual([]);
      expect(syncFailed(report)).toBe(true);
    });

    it("returns a refused listing request without failing the entry", async () => {
      const { client } = fakeIndex([], { listingRefused: true });
      const report = await publishPlan(
        { entries: [compiledEntry("patterns/a/main.tsx")] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries[0].status).toBe("published");
      expect(report.listingFailures).toEqual([{
        path: "patterns/a/main.tsx",
        reason: "pattern index requestListing 429",
      }]);
      expect(syncFailed(report)).toBe(false);
    });

    it("throws, publishing nothing, when the index refuses to list the heads", async () => {
      const { client, published } = fakeIndex();
      client.listRepoHeads = () =>
        Promise.reject(new Error("pattern index listRepoHeads 401"));
      await expect(
        publishPlan(
          { entries: [compiledEntry("patterns/a/main.tsx")] },
          PUBLISH_OPTIONS,
          client,
        ),
      ).rejects.toThrow("401");
      expect(published).toEqual([]);
    });

    it("returns the head paths that are no longer entries, and the gate findings heads carry", async () => {
      const finding = {
        file: "/gone.tsx",
        line: 4,
        category: "contact",
        why: "names a | person",
      };
      const { client } = fakeIndex([{
        path: "patterns/gone.tsx",
        patternId: "g",
        sourceHash: "h",
        commit: "c",
        gates: {
          privacy: { status: "failed", attempt: 1, findings: [finding] },
          quality: { status: "passed", attempt: 1, findings: [] },
        },
      }]);
      const report = await publishPlan(
        { entries: [] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.gone).toEqual(["patterns/gone.tsx"]);
      expect(report.gardeners).toEqual([{
        path: "patterns/gone.tsx",
        gardener: "privacy",
        status: "failed",
        findings: [finding],
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
