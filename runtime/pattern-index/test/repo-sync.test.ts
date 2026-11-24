import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  PatternIndexError,
  type PatternIndexPublishRequest,
  type PatternIndexRepoHead,
} from "../src/client.ts";
import {
  findEntries,
  formerPathsByKey,
  type PlanDeps,
  planRepo,
  type RepoEntryOptions,
} from "../src/repo-plan.ts";
import {
  type PlannedEntry,
  planProblem,
  programSizeLimit,
  programSourceHash,
  type PublishClient,
  publishPlan,
  reasonOf,
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
const compiled = (path: string, sourceHash = `hash:${path}`) => ({
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

/** A head the index holds for `path`. */
const head = (
  path: string,
  sourceHash = `old:${path}`,
  patternId = `head:${path}`,
): PatternIndexRepoHead => ({
  path,
  patternId,
  sourceHash,
  commit: "beef",
});

/**
 * An index stand-in holding `heads`. It records what it publishes and what
 * it is asked to withdraw, and withdraws every path asked about that it holds
 * a head for.
 */
const fakeIndex = (heads: PatternIndexRepoHead[] = []) => {
  const published: PatternIndexPublishRequest[] = [];
  const withdrawals: (readonly string[])[] = [];
  const client: PublishClient = {
    listRepoHeads: () => Promise.resolve({ heads }),
    publishPattern: (request) => {
      published.push(request);
      return Promise.resolve({ patternId: request.patternId, created: true });
    },
    withdrawRepoPaths: (request) => {
      withdrawals.push(request.paths);
      return Promise.resolve({
        withdrawn: request.paths.map((path) => ({
          path,
          withdrawn: heads.some((held) => held.path === path),
        })),
      });
    },
  };
  return { client, published, withdrawals };
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
      const changed = {
        ...program,
        files: [program.files[0], { name: "/b.ts", contents: "B" }],
      };
      expect(await programSourceHash(changed, FLAGS)).not.toBe(
        await programSourceHash(program, FLAGS),
      );
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
    it("returns a publish request carrying the doc comment's metadata, and its source hash", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({ "patterns/a/main.tsx": DESCRIBED }),
      );
      const [entry] = plan.entries;
      expect(entry.status).toBe("compiled");
      if (entry.status !== "compiled") return;
      expect(entry.sourceHash).toBe(
        await programSourceHash(
          programFor("/repo/patterns/a/main.tsx", DESCRIBED),
          FLAGS,
        ),
      );
      expect(entry.request.patternId).toBe("id:/a/main.tsx");
      expect(entry.request.description).toBe("Doubles a number.");
      expect(entry.request.hashtags).toEqual(["math"]);
      expect(entry.request.keywords).toEqual(["double"]);
    });

    it("returns a `main.tsx` entry as standalone and any other entry as a part", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({
          "patterns/a/main.tsx": DESCRIBED,
          "patterns/a/card.tsx": DESCRIBED,
          "patterns/b.tsx": DESCRIBED,
        }),
      );
      expect(
        plan.entries.map((entry) => [
          entry.path,
          entry.status === "compiled" ? entry.request.standalone : undefined,
        ]),
      ).toEqual([
        ["patterns/a/card.tsx", false],
        ["patterns/a/main.tsx", true],
        ["patterns/b.tsx", false],
      ]);
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
        planDeps({ "patterns/a/main.tsx": UNDESCRIBED }, ["/a/main.tsx"]),
      );
      expect(plan.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "failed",
        reason: "type error at main.tsx:3",
      }]);
    });

    it("returns an entry whose compile produced no pattern id as failed", async () => {
      const deps = planDeps({ "patterns/a/main.tsx": DESCRIBED });
      deps.compileProgram = (program) => Promise.resolve({ program });
      const plan = await planRepo(OPTIONS, deps);
      expect(plan.entries).toEqual([{
        path: "patterns/a/main.tsx",
        status: "failed",
        reason: "the compile produced no durable pattern id",
      }]);
    });

    it("returns a failed compile beside the entries that compiled", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({
          "patterns/a/main.tsx": DESCRIBED,
          "patterns/b/main.tsx": DESCRIBED,
        }, ["/a/main.tsx"]),
      );
      expect(plan.entries.map((entry) => [entry.path, entry.status])).toEqual([
        ["patterns/a/main.tsx", "failed"],
        ["patterns/b/main.tsx", "compiled"],
      ]);
    });

    it("returns every path the globs select as selected, entries and helpers alike", async () => {
      const plan = await planRepo(
        OPTIONS,
        planDeps({
          "patterns/a/main.tsx": DESCRIBED,
          "patterns/a/helper.ts": HELPER,
          "patterns/a/main.test.tsx": DESCRIBED,
          "patterns/dev/fixture.tsx": DESCRIBED,
        }),
      );
      expect(plan.selected).toEqual([
        "patterns/a/helper.ts",
        "patterns/a/main.tsx",
      ]);
    });

    it("returns a selected file it cannot read as failed beside the entries that compiled", async () => {
      const deps = planDeps({ "patterns/b/main.tsx": DESCRIBED });
      deps.trackedFiles = () =>
        Promise.resolve(["patterns/a/main.tsx", "patterns/b/main.tsx"]);
      const plan = await planRepo(OPTIONS, deps);
      expect(plan.entries.map((entry) => [entry.path, entry.status])).toEqual([
        ["patterns/a/main.tsx", "failed"],
        ["patterns/b/main.tsx", "compiled"],
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
          "patterns/c/main.tsx": DESCRIBED,
        }, ["/c/main.tsx"]),
      );
      expect(planProblem(JSON.parse(JSON.stringify(plan)))).toBeUndefined();
    });

    it("returns what is wrong with a malformed plan", () => {
      expect(planProblem([])).toBe("the plan has no list of entries");
      expect(planProblem({ entries: [] })).toBe(
        "the plan has no list of selected paths",
      );
      const plan = (entry: unknown) => ({ entries: [entry], selected: [] });
      expect(planProblem(plan({ status: "compiled" }))).toBe(
        "entries[0] has no path",
      );
      expect(planProblem(plan({ path: "a", status: "failed" }))).toBe(
        "entries[0] has no reason",
      );
      expect(planProblem(plan({ path: "a", status: "shipped" }))).toBe(
        "entries[0] has an unknown status",
      );
      expect(planProblem(plan({ path: "a", status: "compiled" }))).toBe(
        "entries[0] has no source hash",
      );
      expect(
        planProblem(plan({ path: "a", status: "compiled", sourceHash: "h" })),
      ).toBe("entries[0] has no publish request");
      expect(
        planProblem(plan({
          path: "a",
          status: "compiled",
          sourceHash: "h",
          request: { patternId: "id" },
          formerPaths: "b",
        })),
      ).toBe("entries[0] has former paths that are not a list of paths");
    });
  });

  describe("formerPathsByKey()", () => {
    // Two moves of one file, and a key that maps to itself.
    const moves: Record<string, string> = {
      "apps/notes/main.tsx": "apps/notes/notes.tsx",
      "apps/notes/notes.tsx": "notes.tsx",
    };
    const formerKey = (key: string) => moves[key] ?? key;

    it("returns every path a file had, nearest first", () => {
      expect(
        formerPathsByKey("patterns", formerKey)("patterns/apps/notes/main.tsx"),
      ).toEqual(["patterns/apps/notes/notes.tsx", "patterns/notes.tsx"]);
    });

    it("returns none for a file that never moved or lies outside the program root", () => {
      const former = formerPathsByKey("patterns/", formerKey);
      expect(former("patterns/apps/other/main.tsx")).toEqual([]);
      expect(former("elsewhere/apps/notes/main.tsx")).toEqual([]);
    });

    it("reads keys from the repository root when that is the program root", () => {
      const moves: Record<string, string> = {
        "src/patterns/cf-calendar/main.tsx": "src/patterns/cf-calendar.tsx",
      };
      for (const root of [".", "./"]) {
        expect(
          formerPathsByKey(root, (key) => moves[key] ?? key)(
            "src/patterns/cf-calendar/main.tsx",
          ),
        ).toEqual(["src/patterns/cf-calendar.tsx"]);
      }
    });

    it("stops at a key it already passed", () => {
      const cycle: Record<string, string> = {
        "a.tsx": "b.tsx",
        "b.tsx": "a.tsx",
      };
      expect(
        formerPathsByKey("p", (key) => cycle[key] ?? key)("p/a.tsx"),
      ).toEqual(["p/b.tsx"]);
    });

    it("is what the plan records for each compiled entry", async () => {
      const plan = await planRepo(
        { ...OPTIONS, formerPaths: formerPathsByKey("patterns", formerKey) },
        planDeps({
          "patterns/apps/notes/main.tsx": DESCRIBED,
          "patterns/b.tsx": DESCRIBED,
        }),
      );
      expect(plan.entries.map((entry) => [
        entry.path,
        entry.status === "compiled" ? entry.formerPaths : undefined,
      ])).toEqual([
        ["patterns/apps/notes/main.tsx", [
          "patterns/apps/notes/notes.tsx",
          "patterns/notes.tsx",
        ]],
        ["patterns/b.tsx", undefined],
      ]);
    });
  });

  describe("publishPlan()", () => {
    it("publishes a changed entry with the job's repository and commit as its source", async () => {
      const { client, published } = fakeIndex([head("p/a.tsx")]);
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries).toEqual([{
        path: "p/a.tsx",
        status: "published",
        patternId: "id:p/a.tsx",
      }]);
      expect(published[0].source).toEqual({
        repository: "acme/patterns",
        path: "p/a.tsx",
        commit: "c0ffee",
        sourceHash: "hash:p/a.tsx",
      });
      expect(published[0].priorPatternId).toBeUndefined();
    });

    it("names the head of the path a new entry moved from as its predecessor", async () => {
      const { client, published } = fakeIndex([head("p/old.tsx")]);
      await publishPlan(
        {
          entries: [{
            ...compiled("p/new/main.tsx"),
            formerPaths: ["p/gone.tsx", "p/old.tsx"],
          }],
          selected: ["p/new/main.tsx"],
        },
        PUBLISH_OPTIONS,
        client,
      );
      expect(published[0].source?.path).toBe("p/new/main.tsx");
      expect(published[0].priorPatternId).toBe("head:p/old.tsx");
    });

    it("names no predecessor for an entry with its own head, or whose former path is still selected or already claimed", async () => {
      const { client, published } = fakeIndex([
        head("p/own.tsx"),
        head("p/kept.tsx"),
        head("p/old.tsx"),
      ]);
      await publishPlan(
        {
          entries: [
            { ...compiled("p/own.tsx"), formerPaths: ["p/old.tsx"] },
            { ...compiled("p/a/main.tsx"), formerPaths: ["p/kept.tsx"] },
            { ...compiled("p/b/main.tsx"), formerPaths: ["p/old.tsx"] },
            { ...compiled("p/c/main.tsx"), formerPaths: ["p/old.tsx"] },
          ],
          selected: [
            "p/own.tsx",
            "p/kept.tsx",
            "p/a/main.tsx",
            "p/b/main.tsx",
            "p/c/main.tsx",
          ],
        },
        PUBLISH_OPTIONS,
        client,
      );
      expect(
        published.map((
          request,
        ) => [request.source?.path, request.priorPatternId]),
      ).toEqual([
        ["p/own.tsx", undefined],
        ["p/a/main.tsx", undefined],
        ["p/b/main.tsx", "head:p/old.tsx"],
        ["p/c/main.tsx", undefined],
      ]);
    });

    it("publishes nothing for an entry whose hash and id match its head", async () => {
      const { client, published } = fakeIndex([
        head("p/a.tsx", "same", "id:p/a.tsx"),
      ]);
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx", "same")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries).toEqual([{
        path: "p/a.tsx",
        status: "unchanged",
        patternId: "id:p/a.tsx",
      }]);
      expect(published).toEqual([]);
    });

    it("publishes an entry whose hash matches its head but whose id does not", async () => {
      // A newer Labs compiling the same source to a different pattern.

      const { client, published } = fakeIndex([head("p/a.tsx", "same")]);
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx", "same")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries[0].status).toBe("published");
      expect(published.map((request) => request.patternId)).toEqual([
        "id:p/a.tsx",
      ]);
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
        { entries: [compiled("p/a.tsx")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries[0].status).toBe("unchanged");
    });

    it("returns an entry whose source is public under someone else as public elsewhere", async () => {
      const { client } = fakeIndex();
      client.publishPattern = (request) =>
        Promise.resolve({
          patternId: request.patternId,
          created: true,
          visibility: "private",
        });
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries[0].status).toBe("public-elsewhere");
      expect(reportMarkdown(report)).toContain(
        "### Already public under another publisher",
      );
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
        { entries: [compiled("p/a.tsx")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries[0]).toEqual({
        path: "p/a.tsx",
        status: "failed",
        reason: "the index ignored the repository source",
      });
    });

    it("returns a publish refused as too large as oversize, not failed, and still publishes the other entries", async () => {
      const { client, published } = fakeIndex();
      const publishPattern = client.publishPattern;
      client.publishPattern = (request) =>
        request.patternId === "id:p/a.tsx"
          ? Promise.reject(
            new PatternIndexError(
              "publishPattern",
              400,
              "program exceeds 819200 bytes of source",
            ),
          )
          : publishPattern(request);
      const report = await publishPlan(
        {
          entries: [compiled("p/a.tsx"), compiled("p/b.tsx")],
          selected: ["p/a.tsx", "p/b.tsx"],
        },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries).toEqual([
        { path: "p/a.tsx", status: "oversize", limit: "819200" },
        { path: "p/b.tsx", status: "published", patternId: "id:p/b.tsx" },
      ]);
      expect(published.map((request) => request.source?.path)).toEqual([
        "p/b.tsx",
      ]);
      expect(syncFailed(report)).toBe(false);
      const markdown = reportMarkdown(report);
      expect(markdown).toContain("1 too large for the index, 0 failed.");
      expect(markdown).toContain(
        "### Not published: too large for the index",
      );
      expect(markdown).toContain("over 819200 bytes of source");
      expect(markdown).toContain("- `p/a.tsx`");
      expect(markdown).not.toContain("### Failed");
    });

    it("returns any other refused publish as failed and still publishes the other entries", async () => {
      for (
        const error of [
          new PatternIndexError("publishPattern", 400, "bad request"),
          new PatternIndexError(
            "publishPattern",
            500,
            "program exceeds 819200 bytes of source",
          ),
          new PatternIndexError("publishPattern", 401),
          new TypeError("error sending request"),
        ]
      ) {
        const { client, published } = fakeIndex();
        const publishPattern = client.publishPattern;
        client.publishPattern = (request) =>
          request.patternId === "id:p/a.tsx"
            ? Promise.reject(error)
            : publishPattern(request);
        const report = await publishPlan(
          {
            entries: [compiled("p/a.tsx"), compiled("p/b.tsx")],
            selected: ["p/a.tsx", "p/b.tsx"],
          },
          PUBLISH_OPTIONS,
          client,
        );
        expect(report.entries.map((entry) => entry.status)).toEqual([
          "failed",
          "published",
        ]);
        expect(published.map((request) => request.source?.path)).toEqual([
          "p/b.tsx",
        ]);
        expect(syncFailed(report)).toBe(true);
        expect(reportMarkdown(report)).toContain(
          `| \`p/a.tsx\` | ${error.message} |`,
        );
      }
    });

    it("returns a sync with an oversize entry and a failed one as failed", async () => {
      const { client } = fakeIndex();
      client.publishPattern = (request) =>
        Promise.reject(
          request.patternId === "id:p/a.tsx"
            ? new PatternIndexError(
              "publishPattern",
              400,
              "program exceeds 819200 bytes of source",
            )
            : new PatternIndexError("publishPattern", 503),
        );
      const report = await publishPlan(
        {
          entries: [compiled("p/a.tsx"), compiled("p/b.tsx")],
          selected: ["p/a.tsx", "p/b.tsx"],
        },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries.map((entry) => entry.status)).toEqual([
        "oversize",
        "failed",
      ]);
      expect(syncFailed(report)).toBe(true);
    });

    it("carries the plan's failed and undescribed entries into the report, publishing neither", async () => {
      const failed: PlannedEntry = {
        path: "p/a.tsx",
        status: "failed",
        reason: "type error",
      };
      const undescribed: PlannedEntry = {
        path: "p/b.tsx",
        status: "undescribed",
      };
      const { client, published } = fakeIndex();
      const report = await publishPlan(
        { entries: [failed, undescribed], selected: ["p/a.tsx", "p/b.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries).toEqual([failed, undescribed]);
      expect(published).toEqual([]);
      expect(syncFailed(report)).toBe(true);
    });

    it("withdraws the lineages of paths no longer selected, and reports the ones still here", async () => {
      const { client, withdrawals } = fakeIndex([
        head("p/a.tsx"),
        head("p/gone.tsx"),
        head("p/helper.ts"),
      ]);
      const report = await publishPlan(
        {
          entries: [compiled("p/a.tsx")],
          selected: ["p/a.tsx", "p/helper.ts"],
        },
        PUBLISH_OPTIONS,
        client,
      );
      expect(withdrawals).toEqual([["p/gone.tsx"]]);
      expect(report.withdrawn).toEqual(["p/gone.tsx"]);
      expect(report.dormant).toEqual(["p/helper.ts"]);
    });

    it("returns the published entries and the withdrawal's refusal when the index refuses to withdraw", async () => {
      const { client } = fakeIndex([head("p/gone.tsx")]);
      client.withdrawRepoPaths = () =>
        Promise.reject(new Error("pattern index withdrawRepoPaths 503"));
      const report = await publishPlan(
        { entries: [compiled("p/a.tsx")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.entries.map((entry) => entry.status)).toEqual([
        "published",
      ]);
      expect(report.withdrawn).toEqual([]);
      expect(report.withdrawFailure).toBe(
        "pattern index withdrawRepoPaths 503",
      );
      expect(syncFailed(report)).toBe(true);
      expect(reportMarkdown(report)).toContain("### Withdrawal failed");
    });

    it("asks to withdraw nothing when every head is still selected", async () => {
      const { client, withdrawals } = fakeIndex([head("p/a.tsx")]);
      await publishPlan(
        { entries: [compiled("p/a.tsx")], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(withdrawals).toEqual([]);
    });

    it("throws, publishing nothing, when the index refuses to list the heads", async () => {
      const { client, published } = fakeIndex();
      client.listRepoHeads = () =>
        Promise.reject(new Error("pattern index listRepoHeads 403"));
      await expect(
        publishPlan(
          { entries: [compiled("p/a.tsx")], selected: ["p/a.tsx"] },
          PUBLISH_OPTIONS,
          client,
        ),
      ).rejects.toThrow("403");
      expect(published).toEqual([]);
    });

    it("returns the gate findings the heads carry", async () => {
      const finding = {
        file: "/a.tsx",
        line: 4,
        category: "contact",
        why: "names a | person",
      };
      const { client } = fakeIndex([{
        ...head("p/a.tsx"),
        gates: {
          privacy: { status: "failed", attempt: 1, findings: [finding] },
          quality: { status: "passed", attempt: 1, findings: [] },
        },
      }]);
      const report = await publishPlan(
        { entries: [], selected: ["p/a.tsx"] },
        PUBLISH_OPTIONS,
        client,
      );
      expect(report.gardeners).toEqual([{
        path: "p/a.tsx",
        gardener: "privacy",
        status: "failed",
        findings: [finding],
      }]);
    });
  });

  describe("programSizeLimit()", () => {
    it("returns the limit of a recognized program-size refusal", () => {
      const error = new PatternIndexError(
        "publishPattern",
        400,
        "program exceeds 123456 bytes of source",
      );
      expect(programSizeLimit(error)).toBe("123456");
    });

    it("returns `undefined` for every other refusal, near misses included", () => {
      const sizeRefusal = "program exceeds 819200 bytes of source";
      for (
        const error of [
          new PatternIndexError("publishPattern", 400),
          new PatternIndexError("publishPattern", 400, "private source text"),
          new PatternIndexError(
            "publishPattern",
            400,
            `${sizeRefusal}: secret`,
          ),
          new PatternIndexError("publishPattern", 400, `${sizeRefusal}\n`),
          new PatternIndexError(
            "publishPattern",
            400,
            `${sizeRefusal}\nsecret`,
          ),
          new PatternIndexError(
            "publishPattern",
            400,
            `${sizeRefusal}\x1b[31m`,
          ),
          new PatternIndexError(
            "publishPattern",
            400,
            `${sizeRefusal} | secret`,
          ),
          new PatternIndexError(
            "publishPattern",
            400,
            "program exceeds 1234567890123 bytes of source",
          ),
          new PatternIndexError("publishPattern", 500, sizeRefusal),
          new PatternIndexError("listRepoHeads", 400, sizeRefusal),
        ]
      ) {
        expect(programSizeLimit(error)).toBeUndefined();
        expect(reasonOf(error)).toBe(error.message);
      }
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
          { path: "p/g.tsx", status: "oversize", limit: "819200" },
        ],
        withdrawn: ["p/e.tsx"],
        dormant: ["p/f.tsx"],
        gardeners: [{
          path: "p/b.tsx",
          gardener: "privacy",
          status: "failed",
          findings: [{ category: "contact", why: "a | b" }],
        }],
      });
      expect(markdown).toContain(
        "At `0123456789ab`: 5 entries, 1 published, 1 unchanged, 1 without a description, 1 too large for the index, 1 failed.",
      );
      expect(markdown).toContain("| `p/d.tsx` | bad \\| thing here |");
      expect(markdown).toContain("| `p/a.tsx` | `A` |");
      expect(markdown).toContain(
        "| `p/b.tsx` | privacy | failed | contact |  | a \\| b |",
      );
      expect(markdown).toContain("- `p/c.tsx`");
      expect(markdown).toContain("- `p/e.tsx`");
      expect(markdown).toContain("- `p/f.tsx`");
      expect(markdown).toContain("- `p/g.tsx`");
    });
  });
});
