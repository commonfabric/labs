import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import {
  createUnifiedDiff,
  defineFixtureSuite,
  type Fixture,
  type FixtureContext,
  type FixtureSuiteConfig,
  planFixtureSuite,
  runFixture,
  shouldUpdateGoldens,
} from "./fixture-runner.ts";

/** Writes `files`, keyed by path relative to `root`, creating directories. */
function writeTreeSync(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    Deno.mkdirSync(dirname(absolute), { recursive: true });
    Deno.writeTextFileSync(absolute, contents);
  }
}

const TREE = {
  "b.input.ts": "b",
  "a.input.tsx": "a",
  "a.expected.tsx": "A",
  "b.expected.ts": "B",
  "nested/c.input.ts": "c",
  "nested/c.expected.ts": "C",
  "notes.md": "not a fixture",
};

const expectedBeside = ({ stem, extension }: {
  stem: string;
  extension: string;
}) => `${stem}.expected${extension}`;

describe("fixture-runner", () => {
  describe("createUnifiedDiff()", () => {
    it("returns the empty string for identical texts", () => {
      expect(createUnifiedDiff("a\nb", "a\nb")).toBe("");
    });

    it("returns one hunk with surrounding context for a changed line", () => {
      const expected = "1\n2\n3\n4\n5\n6\n7";
      const actual = "1\n2\n3\nfour\n5\n6\n7";

      expect(createUnifiedDiff(expected, actual, 1)).toBe(
        "@@ -3,3 +3,3 @@\n  3\n- 4\n+ four\n  5",
      );
    });

    it("returns one hunk per run of changes too far apart to share context", () => {
      const expected = "a\n1\n2\n3\n4\n5\nb";
      const actual = "A\n1\n2\n3\n4\n5\nB";

      expect(createUnifiedDiff(expected, actual, 1)).toBe(
        "@@ -1,2 +1,2 @@\n- a\n+ A\n  1\n\n" +
          "@@ -6,2 +6,2 @@\n  5\n- b\n+ B",
      );
    });

    it("returns one hunk for changes whose context overlaps", () => {
      const expected = "a\n1\nb";
      const actual = "A\n1\nB";

      expect(createUnifiedDiff(expected, actual, 1)).toBe(
        "@@ -1,3 +1,3 @@\n- a\n+ A\n  1\n- b\n+ B",
      );
    });

    it("returns only an addition for a line the expected text lacks", () => {
      expect(createUnifiedDiff("a", "a\nb", 1)).toBe(
        "@@ -1,1 +1,2 @@\n  a\n+ b",
      );
    });
  });

  describe("shouldUpdateGoldens()", () => {
    let saved: string | undefined;

    beforeAll(() => {
      saved = Deno.env.get("UPDATE_GOLDENS");
    });

    afterAll(() => {
      if (saved === undefined) Deno.env.delete("UPDATE_GOLDENS");
      else Deno.env.set("UPDATE_GOLDENS", saved);
    });

    it("returns `true` when `UPDATE_GOLDENS` is `1`", () => {
      Deno.env.set("UPDATE_GOLDENS", "1");

      expect(shouldUpdateGoldens()).toBe(true);
    });

    it("returns `false` when `UPDATE_GOLDENS` is anything else", () => {
      Deno.env.set("UPDATE_GOLDENS", "true");
      expect(shouldUpdateGoldens()).toBe(false);

      Deno.env.delete("UPDATE_GOLDENS");
      expect(shouldUpdateGoldens()).toBe(false);
    });
  });

  describe("planFixtureSuite()", () => {
    let root: string;

    beforeAll(async () => {
      root = await Deno.makeTempDir({ prefix: "fixture-runner-plan-" });
      writeTreeSync(root, TREE);
    });

    afterAll(async () => {
      await Deno.remove(root, { recursive: true });
    });

    it("returns each input fixture under the root, sorted by id", () => {
      const plan = planFixtureSuite({
        rootDir: root,
        expectedPath: expectedBeside,
      });

      expect(plan.rootDir).toBe(root);
      expect(plan.groups).toEqual([]);
      expect(plan.ungrouped).toEqual([
        {
          rootDir: root,
          inputPath: join(root, "a.input.tsx"),
          expectedPath: join(root, "a.expected.tsx"),
          relativeInputPath: "a.input.tsx",
          relativeExpectedPath: "a.expected.tsx",
          stem: "a",
          extension: ".tsx",
          id: "a",
          baseName: "a",
        },
        {
          rootDir: root,
          inputPath: join(root, "b.input.ts"),
          expectedPath: join(root, "b.expected.ts"),
          relativeInputPath: "b.input.ts",
          relativeExpectedPath: "b.expected.ts",
          stem: "b",
          extension: ".ts",
          id: "b",
          baseName: "b",
        },
        {
          rootDir: root,
          inputPath: join(root, "nested", "c.input.ts"),
          expectedPath: join(root, "nested", "c.expected.ts"),
          relativeInputPath: join("nested", "c.input.ts"),
          relativeExpectedPath: join("nested", "c.expected.ts"),
          stem: "nested/c",
          extension: ".ts",
          id: "nested/c",
          baseName: "c",
        },
      ]);
    });

    it("returns an absolute expected path as given", () => {
      const golden = join(root, "goldens", "one.txt");

      const plan = planFixtureSuite({
        rootDir: root,
        expectedPath: () => golden,
      });

      expect(plan.ungrouped.map((f) => f.expectedPath)).toEqual([
        golden,
        golden,
        golden,
      ]);
      expect(plan.ungrouped[0]?.relativeExpectedPath).toBe(
        join("goldens", "one.txt"),
      );
    });

    it("returns no fixture that `skip` accepts", () => {
      const plan = planFixtureSuite({
        rootDir: root,
        expectedPath: expectedBeside,
        skip: (fixture) => fixture.id === "b",
      });

      expect(plan.ungrouped.map((f) => f.id)).toEqual(["a", "nested/c"]);
    });

    it("returns fixtures in the order `sortFixtures` gives", () => {
      const plan = planFixtureSuite({
        rootDir: root,
        expectedPath: expectedBeside,
        sortFixtures: (a, b) => b.id.localeCompare(a.id),
      });

      expect(plan.ungrouped.map((f) => f.id)).toEqual(["nested/c", "b", "a"]);
    });

    it("returns the fixtures `groupBy` names in groups and the rest ungrouped", () => {
      const plan = planFixtureSuite({
        rootDir: root,
        expectedPath: expectedBeside,
        groupBy: (fixture) =>
          fixture.id === "b" ? undefined : fixture.extension,
      });

      expect(
        plan.groups.map((group) => ({
          name: group.name,
          ids: group.fixtures.map((f) => f.id),
        })),
      ).toEqual([
        { name: ".tsx", ids: ["a"] },
        { name: ".ts", ids: ["nested/c"] },
      ]);
      expect(plan.ungrouped.map((f) => f.id)).toEqual(["b"]);
    });

    it("returns every match of a global pattern", async () => {
      // A global pattern keeps its position between `test()` calls. Here the
      // only two files have names of one length, so a pattern that was not
      // reset would start the second test past the end of the second name.

      const globalRoot = await Deno.makeTempDir({
        prefix: "fixture-runner-global-",
      });
      try {
        writeTreeSync(globalRoot, { "x.input.ts": "", "y.input.ts": "" });

        const plan = planFixtureSuite({
          rootDir: globalRoot,
          inputPattern: /\.input\.ts$/g,
          expectedPath: expectedBeside,
        });

        expect(plan.ungrouped.map((f) => f.id)).toEqual(["x", "y"]);
      } finally {
        await Deno.remove(globalRoot, { recursive: true });
      }
    });

    it("returns the whole path as the stem of a file without `.input.`", () => {
      const plan = planFixtureSuite({
        rootDir: root,
        inputPattern: /\.md$/,
        expectedPath: ({ stem }) => `${stem}.golden`,
      });

      expect(plan.ungrouped.map((f) => [f.stem, f.extension, f.baseName]))
        .toEqual([["notes.md", "", "notes.md"]]);
      expect(plan.ungrouped[0]?.expectedPath).toBe(
        join(root, "notes.md.golden"),
      );
    });

    it("throws for a root it cannot walk for a reason other than absence", () => {
      const file = join(root, "b.input.ts");

      expect(() =>
        planFixtureSuite({
          rootDir: join(file, "beneath"),
          expectedPath: expectedBeside,
        })
      ).toThrow(Deno.errors.NotADirectory);
    });

    it("returns no fixtures for a root that does not exist", () => {
      const plan = planFixtureSuite({
        rootDir: join(root, "missing"),
        expectedPath: expectedBeside,
      });

      expect(plan.ungrouped).toEqual([]);
      expect(plan.groups).toEqual([]);
    });
  });

  describe("runFixture()", () => {
    const fixture: Fixture = {
      rootDir: "/fixtures",
      inputPath: "/fixtures/x.input.ts",
      expectedPath: "/fixtures/x.expected.ts",
      relativeInputPath: "x.input.ts",
      relativeExpectedPath: "x.expected.ts",
      stem: "x",
      extension: ".ts",
      id: "x",
      baseName: "x",
    };

    /** A suite whose every hook appends its name to `calls`. */
    function recordingSuite(
      calls: string[],
      overrides: Partial<FixtureSuiteConfig<string, string, number>> = {},
    ): FixtureSuiteConfig<string, string, number> {
      return {
        suiteName: "recording",
        rootDir: "/fixtures",
        expectedPath: expectedBeside,
        beforeEach: (f, ctx) => {
          calls.push(`beforeEach ${f.id} ${ctx.warmup}`);
        },
        execute: (f) => {
          calls.push(`execute ${f.id}`);
          return "actual";
        },
        determinismCheck: (actual) => {
          calls.push(`determinismCheck ${actual}`);
        },
        loadExpected: () => {
          calls.push("loadExpected");
          return "expected";
        },
        compare: (actual, expected) => {
          calls.push(`compare ${actual} ${expected}`);
        },
        updateGolden: (actual) => {
          calls.push(`updateGolden ${actual}`);
        },
        ...overrides,
      };
    }

    function context(shouldUpdateGolden: boolean): FixtureContext<number> {
      return { warmup: 7, shouldUpdateGolden, rootDir: "/fixtures" };
    }

    it("runs the hooks in order and compares against the expected output", async () => {
      const calls: string[] = [];

      await runFixture(recordingSuite(calls), fixture, context(false));

      expect(calls).toEqual([
        "beforeEach x 7",
        "execute x",
        "determinismCheck actual",
        "loadExpected",
        "compare actual expected",
      ]);
    });

    it("updates the golden instead of comparing when asked to", async () => {
      const calls: string[] = [];

      await runFixture(recordingSuite(calls), fixture, context(true));

      expect(calls).toEqual([
        "beforeEach x 7",
        "execute x",
        "determinismCheck actual",
        "updateGolden actual",
      ]);
    });

    it("runs only the required hooks when the optional ones are absent", async () => {
      const calls: string[] = [];

      const { beforeEach: _, determinismCheck: __, ...required } =
        recordingSuite(calls);

      await runFixture(required, fixture, context(false));

      expect(calls).toEqual([
        "execute x",
        "loadExpected",
        "compare actual expected",
      ]);
    });

    it("throws naming the suite when asked to update without a handler", async () => {
      const calls: string[] = [];
      const { updateGolden: _, ...withoutUpdate } = recordingSuite(calls);

      await expect(runFixture(withoutUpdate, fixture, context(true))).rejects
        .toThrow(
          'UPDATE_GOLDENS=1, but no updateGolden handler provided for fixture suite "recording".',
        );
      expect(calls).not.toContain("loadExpected");
    });

    it("rejects with the comparison's failure", async () => {
      const failure = new Error("mismatch");

      await expect(
        runFixture(
          recordingSuite([], {
            compare: () => {
              throw failure;
            },
          }),
          fixture,
          context(false),
        ),
      ).rejects.toBe(failure);
    });
  });

  describe("defineFixtureSuite()", () => {
    // The suite below is registered while this file loads, so its fixtures
    // are written synchronously here. Each registered test checks its own
    // output against its golden, and the warmup value the suite was given.

    const root = Deno.makeTempDirSync({ prefix: "fixture-runner-suite-" });
    writeTreeSync(root, TREE);
    let warmups = 0;

    afterAll(async () => {
      await Deno.remove(root, { recursive: true });
    });

    defineFixtureSuite<string, string, string>({
      suiteName: "a registered suite",
      rootDir: root,
      expectedPath: expectedBeside,
      groupBy: (fixture) => fixture.id.includes("/") ? "nested" : undefined,
      formatTestName: (fixture) => `uppercases ${fixture.id}`,
      warmup: () => {
        warmups++;
        return "warm";
      },
      execute: async (fixture, ctx) => {
        expect(ctx.warmup).toBe("warm");
        expect(ctx.rootDir).toBe(root);
        expect(warmups).toBe(1);
        return (await Deno.readTextFile(fixture.inputPath)).toUpperCase();
      },
      loadExpected: (fixture) => Deno.readTextFile(fixture.expectedPath),
      compare: (actual, expected) => {
        expect(actual).toBe(expected);
      },
    });
  });
});
