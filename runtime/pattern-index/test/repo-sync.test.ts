import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  BrandSyncError,
  type BrandSyncPattern,
  type BrandSyncRequest,
} from "../src/brand-sync-client.ts";
import {
  findEntries,
  type PlanDeps,
  planRepo,
  type RepoEntryOptions,
} from "../src/repo-plan.ts";
import {
  type BrandSync,
  type PlannedEntry,
  planProblem,
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
  { brokenCompile = [] as readonly string[], deletedPaths = [] as string[] } =
    {},
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
  deletedPaths,
});

/** A compiled plan entry for `path`. */
const compiled = (path: string): PlannedEntry & { status: "compiled" } => ({
  path,
  status: "compiled",
  pattern: {
    path,
    patternId: `id:${path}`,
    program: { main: "/a.tsx", files: [{ name: "/a.tsx", contents: "" }] },
    meta: { description: "Doubles a number.", hashtags: [] },
  },
});

/**
 * An index stand-in. It records each call, answers `created: true` for every
 * pattern unless `unchanged` names its path, withdraws every removed path,
 * and refuses with 400 any call carrying a path in `malformed`.
 */
const fakeIndex = (
  { malformed = [] as string[], unchanged = [] as string[] } = {},
) => {
  const calls: BrandSyncRequest[] = [];
  const sync: BrandSync = (request) => {
    calls.push(request);
    const patterns = request.patterns ?? [];
    const bad = patterns.find((pattern) => malformed.includes(pattern.path));
    if (bad !== undefined) {
      const index = patterns.indexOf(bad);
      return Promise.reject(
        new BrandSyncError(400, `patterns[${index}].program is malformed`),
      );
    }
    return Promise.resolve({
      brand: { githubOrg: "acme", displayName: "Acme" },
      results: patterns.map((pattern: BrandSyncPattern) => ({
        path: pattern.path,
        patternId: pattern.patternId,
        lineageId: `lineage:${pattern.path}`,
        created: !unchanged.includes(pattern.path),
      })),
      removed: (request.removed ?? []).map((path) => ({
        path,
        withdrawn: true,
      })),
    });
  };
  return { sync, calls };
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

  describe("planRepo()", () => {
    it("returns the pattern the index is sent, with the doc comment's metadata", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({ "patterns/a/main.tsx": DESCRIBED }),
      );
      expect(plan.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "compiled",
        pattern: {
          path: "patterns/a/main.tsx",
          patternId: "id:/a/main.tsx",
          program: {
            main: "/a/main.tsx",
            files: [{ name: "/a/main.tsx", contents: DESCRIBED }],
          },
          meta: {
            description: "Doubles a number.",
            hashtags: ["math"],
            keywords: ["double"],
          },
          dependencies: [],
        },
      }]);
    });

    it("returns an entry with no description as undescribed", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({ "patterns/a/main.tsx": UNDESCRIBED }),
      );
      expect(plan.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "undescribed",
      }]);
    });

    it("returns an entry with no description as failed when it does not compile", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({ "patterns/a/main.tsx": UNDESCRIBED }, {
          brokenCompile: ["/a/main.tsx"],
        }),
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
          "patterns/b/main.tsx": DESCRIBED,
        }, { brokenCompile: ["/a/main.tsx"] }),
      );
      expect(plan.entries.map((entry) => [entry.path, entry.status])).toEqual([
        ["patterns/a/main.tsx", "failed"],
        ["patterns/b/main.tsx", "compiled"],
      ]);
    });

    it("returns as removed the deleted paths the globs select and the tree no longer holds", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({ "patterns/back/main.tsx": DESCRIBED }, {
          deletedPaths: [
            "patterns/gone/main.tsx",
            "patterns/gone/main.tsx",
            "patterns/back/main.tsx",
            "patterns/dev/old.tsx",
            "patterns/gone/main.test.tsx",
            "patterns/gone/README.md",
          ],
        }),
      );
      expect(plan.removed).toEqual(["patterns/gone/main.tsx"]);
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
          "patterns/c/main.tsx": DESCRIBED,
        }, { brokenCompile: ["/c/main.tsx"] }),
      );
      expect(planProblem(JSON.parse(JSON.stringify(plan)))).toBeUndefined();
    });

    it("returns what is wrong with a malformed plan", () => {
      expect(planProblem([])).toBe("the plan has no list of entries");
      expect(planProblem({ entries: [] })).toBe(
        "the plan has no list of removed paths",
      );
      expect(planProblem({ entries: [{ status: "compiled" }], removed: [] }))
        .toBe("entries[0] has no path");
      expect(
        planProblem({
          entries: [{ path: "a", status: "shipped" }],
          removed: [],
        }),
      ).toBe("entries[0] has an unknown status");
      expect(
        planProblem({
          entries: [{ ...compiled("a"), pattern: compiled("b").pattern }],
          removed: [],
        }),
      ).toBe("entries[0] has no pattern for its path");
    });
  });

  describe("publishPlan()", () => {
    it("sends the job's repository and commit, with the removals in the first call", async () => {
      const { sync, calls } = fakeIndex();
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx")], removed: ["p/gone.tsx"] },
        PUBLISH_OPTIONS,
        sync,
      );
      expect(calls).toEqual([{
        repository: "acme/patterns",
        commit: "c0ffee",
        patterns: [compiled("p/a.tsx").pattern],
        removed: ["p/gone.tsx"],
      }]);
      expect(report.brand).toBe("Acme");
      expect(report.entries).toEqual([{
        path: "p/a.tsx",
        status: "published",
        patternId: "id:p/a.tsx",
      }]);
      expect(report.withdrawn).toEqual(["p/gone.tsx"]);
    });

    it("sends at most 25 patterns a call", async () => {
      const { sync, calls } = fakeIndex();
      const entries = Array.from(
        { length: 26 },
        (_, i) => compiled(`p/${String(i).padStart(2, "0")}.tsx`),
      );
      await publishPlan({ entries, removed: [] }, PUBLISH_OPTIONS, sync);
      expect(calls.map((call) => call.patterns?.length)).toEqual([25, 1]);
    });

    it("returns an entry the lineage already had as unchanged", async () => {
      const { sync } = fakeIndex({ unchanged: ["p/a.tsx"] });
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx")], removed: [] },
        PUBLISH_OPTIONS,
        sync,
      );
      expect(report.entries[0].status).toBe("unchanged");
    });

    it("sends a refused call's patterns one to a call, failing only the malformed one", async () => {
      const { sync, calls } = fakeIndex({ malformed: ["p/b.tsx"] });
      const report = await publishPlan(
        {
          entries: [compiled("p/a.tsx"), compiled("p/b.tsx")],
          removed: ["p/gone.tsx"],
        },
        PUBLISH_OPTIONS,
        sync,
      );
      expect(calls.map((call) => [
        call.patterns?.map((pattern) => pattern.path),
        call.removed,
      ])).toEqual([
        [["p/a.tsx", "p/b.tsx"], ["p/gone.tsx"]],
        [[], ["p/gone.tsx"]],
        [["p/a.tsx"], undefined],
        [["p/b.tsx"], undefined],
      ]);
      expect(report.entries).toEqual([
        { path: "p/a.tsx", status: "published", patternId: "id:p/a.tsx" },
        {
          path: "p/b.tsx",
          status: "failed",
          reason:
            "pattern index syncBrandPatterns 400: patterns[0].program is malformed",
        },
      ]);
      expect(report.withdrawn).toEqual(["p/gone.tsx"]);
      expect(syncFailed(report)).toBe(true);
    });

    it("sends removals alone when there is no pattern to send", async () => {
      const { sync, calls } = fakeIndex();
      await publishPlan(
        { entries: [], removed: ["p/gone.tsx"] },
        PUBLISH_OPTIONS,
        sync,
      );
      expect(calls.map((call) => call.removed)).toEqual([["p/gone.tsx"]]);
    });

    it("makes no call when there is nothing to send", async () => {
      const { sync, calls } = fakeIndex();
      await publishPlan(
        { entries: [{ path: "p/a.tsx", status: "undescribed" }], removed: [] },
        PUBLISH_OPTIONS,
        sync,
      );
      expect(calls).toEqual([]);
    });

    it("throws when the index refuses the caller", async () => {
      await expect(
        publishPlan(
          { entries: [compiled("p/a.tsx")], removed: [] },
          PUBLISH_OPTIONS,
          () => Promise.reject(new BrandSyncError(403, "repo not enrolled")),
        ),
      ).rejects.toThrow("403");
    });

    it("returns an entry the index answered nothing for as failed", async () => {
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx")], removed: [] },
        PUBLISH_OPTIONS,
        () =>
          Promise.resolve({
            brand: { githubOrg: "acme", displayName: "Acme" },
            results: [],
            removed: [],
          }),
      );
      expect(report.entries).toEqual([{
        path: "p/a.tsx",
        status: "failed",
        reason: "the index returned no result for it",
      }]);
    });

    it("carries the plan's failed and undescribed entries into the report", async () => {
      const failed: PlannedEntry = {
        path: "p/a.tsx",
        status: "failed",
        reason: "type error",
      };
      const { sync } = fakeIndex();
      const report = await publishPlan(
        {
          entries: [failed, { path: "p/b.tsx", status: "undescribed" }],
          removed: [],
        },
        PUBLISH_OPTIONS,
        sync,
      );
      expect(report.entries).toEqual([failed, {
        path: "p/b.tsx",
        status: "undescribed",
      }]);
      expect(syncFailed(report)).toBe(true);
    });
  });

  describe("reportMarkdown()", () => {
    it("returns a summary line counting each outcome, and a section per kind", () => {
      const markdown = reportMarkdown({
        repository: "acme/patterns",
        commit: "0123456789abcdef",
        brand: "Acme",
        entries: [
          { path: "p/a.tsx", status: "published", patternId: "A" },
          { path: "p/b.tsx", status: "unchanged", patternId: "B" },
          { path: "p/c.tsx", status: "undescribed" },
          { path: "p/d.tsx", status: "failed", reason: "bad | thing\nhere" },
        ],
        withdrawn: ["p/e.tsx"],
      });
      expect(markdown).toContain(
        "At `0123456789ab`, as Acme: 4 entries, 1 published, 1 unchanged, 1 without a description, 1 failed.",
      );
      expect(markdown).toContain("| `p/d.tsx` | bad \\| thing here |");
      expect(markdown).toContain("| `p/a.tsx` | `A` |");
      expect(markdown).toContain("- `p/c.tsx`");
      expect(markdown).toContain("- `p/e.tsx`");
    });
  });
});
