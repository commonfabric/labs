import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { existsSync } from "@std/fs";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  readDenoConfig,
  runDenoCommandWithTemporaryLock,
} from "@commonfabric/test-support/isolated-deno";
import {
  acceptedInPart,
  acceptedMoveProblems,
  compareDumps,
  describeCompileErrors,
  describeFailures,
  dumperConfig,
  dumperEnvironment,
  dumpTree,
  failureReports,
  type GateCheckout,
  inPart,
  main,
  parseArguments,
  unevaluableIn,
  workspacePackages,
} from "./check-cause-assignments.ts";
import type { DumpOutput } from "./cause-assignments-dump.ts";
import { UNEVALUABLE_PATTERNS } from "./pattern-compat-unevaluable.ts";
import {
  assignmentDigest,
  type PatternAssignment,
} from "./cause-assignments-lib.ts";
import {
  ACCEPTED_MOVES,
  type AcceptedMove,
} from "./cause-assignments-accepted-moves.ts";
import { CONNECTOR_PATTERN_SOURCES } from "../connectors/pattern-sources.ts";

const CHILD = "cell, computed, written by sub-pattern child#Child";
const LIFT = "cell, computed, written by function";
const IF_ELSE = "cell, computed, written by builtin ifElse";

/** One pattern's build, of one source, holding `cells` in number order. */
const build = (
  pattern: string,
  source: string,
  cells: readonly string[],
): PatternAssignment => ({
  pattern,
  source,
  levels: [{
    key: "",
    cells: cells.map((description, number) => ({
      number,
      description,
      hasState: description === CHILD,
    })),
  }],
});

const dump = (...assignments: PatternAssignment[]) => ({
  assignments,
  unassigned: [],
  errors: [],
});

/** A dump of a side that compiled each of `builds`' sources to no assignment. */
const dumpUnassigned = (...builds: PatternAssignment[]) => ({
  assignments: [],
  unassigned: builds.map(({ pattern, source }) => ({ pattern, source })),
  errors: [],
});

const NOTHING_UNEVALUABLE = {
  base: new Set<string>(),
  head: new Set<string>(),
};

const NUMBERED = build("room.tsx", "s", [LIFT, CHILD]);
const RENUMBERED = build("room.tsx", "s", [CHILD]);

// Three children of one pattern, and the first removed: the pairing by order
// reads the other two as unmoved.
const THREE_CHILDREN = build("lobby.tsx", "s", [CHILD, CHILD, CHILD]);
const TWO_CHILDREN = build("lobby.tsx", "s", [CHILD, CHILD]);

const ROOT = fromFileUrl(new URL("..", import.meta.url));

/**
 * A stand-in for the compiler of a checkout, at the paths the dump loads: a
 * module whose source names a pattern evaluates to one, and any other to no
 * default export.
 */
const STAND_IN_COMPILER: Readonly<Record<string, string>> = {
  "runtime/cli/lib/dev.ts": `
    import { evaluate } from "../../runner/src/harness/evaluate.ts";
    export const createRuntime = () => ({
      harness: {
        resolve: () => {},
        compileToRecordGraph: () => ({ id: "", graph: {}, mainSpecifier: "" }),
        evaluateRecordGraph: (_id, _graph, _main, program) => evaluate(program),
      },
      patternManager: {
        registerEvaluatedModules: () => {},
        getArtifactEntryRef: () => undefined,
      },
      dispose: () => {},
    });
  `,
  "runtime/runner/src/harness/local-program.deno.ts": `
    export const resolveLocalProgram = async (_resolve, { main }) => ({
      main,
      files: [{ name: "/main.tsx", contents: await Deno.readTextFile(main) }],
    });
  `,
  "runtime/runner/src/harness/evaluate.ts": `
    export const evaluate = (program) => ({
      main: program.files[0].contents.includes("pattern")
        ? { default: { nodes: [], argumentSchema: {}, result: {} } }
        : {},
    });
  `,
  "runtime/runner/src/harness/read-by-no-build.ts": "// a comment\n",
};

/** A change to a file under the gate's watched paths that no build reads. */
const WATCHED_EDIT: Readonly<Record<string, string>> = {
  "runtime/runner/src/harness/read-by-no-build.ts": "// an edited comment\n",
};

/** Writes `files`, each a path under `root` and its contents. */
async function write(root: string, files: Readonly<Record<string, string>>) {
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(join(root, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, path), text);
  }
}

describe("check-cause-assignments", () => {
  describe("compareDumps()", () => {
    it("returns a failure for a pattern whose child moves under the same source", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.compared).toBe(1);
      expect(
        comparison.failing.map(({ pattern, moved }) => ({
          pattern,
          moved: moved.map((
            { from, to, hasState },
          ) => [from, to, hasState]),
        })),
      ).toEqual([{ pattern: "room.tsx", moved: [[1, 0, true]] }]);
    });

    it("returns a failure for a pattern whose count of children of one pattern differs, where the pairing reports no move", () => {
      const comparison = compareDumps(
        dump(THREE_CHILDREN),
        dump(TWO_CHILDREN),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(
        comparison.failing.map(({ pattern, moved, ambiguous }) => ({
          pattern,
          moved,
          ambiguous: ambiguous.map(({ before, after }) => [before, after]),
        })),
      ).toEqual([{
        pattern: "lobby.tsx",
        moved: [],
        ambiguous: [[[0, 1, 2], [0, 1]]],
      }]);
    });

    it("returns no move for children of one pattern whose cells cannot be matched, only their numbers on each side", () => {
      const comparison = compareDumps(
        dump(build("lobby.tsx", "s", [LIFT, CHILD, CHILD])),
        dump(TWO_CHILDREN),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(
        comparison.failing.map(({ moved, ambiguous }) => ({
          moved,
          ambiguous: ambiguous.filter(({ hasState }) => hasState).map((
            { before, after },
          ) => [before, after]),
        })),
      ).toEqual([{ moved: [], ambiguous: [[[1, 2], [0, 1]]] }]);
    });

    it("returns as forgiven children of one pattern whose count differs, where an accepted entry names both builds' digests", () => {
      const comparison = compareDumps(
        dump(THREE_CHILDREN),
        dump(TWO_CHILDREN),
        [{
          pattern: "lobby.tsx",
          base: assignmentDigest(THREE_CHILDREN),
          head: assignmentDigest(TWO_CHILDREN),
          reason: "test",
        }],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.failing).toEqual([]);
      expect(comparison.forgiven).toEqual(["lobby.tsx"]);
    });

    describe("for cells holding no state", () => {
      it("returns a failure where the pairing reports a move, giving both builds' numbers for a description whose count differs in place of its moves", () => {
        // A lift is added ahead of a lift and an `ifElse`: the pairing reads
        // the later lift under its neighbor's number, and the `ifElse` as
        // moved 1 to 2.
        const comparison = compareDumps(
          dump(build("note.tsx", "s", [LIFT, IF_ELSE, LIFT])),
          dump(build("note.tsx", "s", [LIFT, LIFT, IF_ELSE, LIFT])),
          [],
          NOTHING_UNEVALUABLE,
        );

        expect(
          comparison.failing.map(({ moved, ambiguous }) => ({
            moved: moved.map(({ description, from, to }) => [
              description,
              from,
              to,
            ]),
            ambiguous: ambiguous.map((
              { description, before, after, hasState },
            ) => [description, before, after, hasState]),
          })),
        ).toEqual([{
          moved: [[IF_ELSE, 1, 2]],
          ambiguous: [[LIFT, [0, 2], [0, 1, 3], false]],
        }]);
      });

      it("returns a description whose count differs where the pattern fails for a move of another description", () => {
        const comparison = compareDumps(
          dump(build("note.tsx", "s", [LIFT, LIFT, LIFT, CHILD])),
          dump(build("note.tsx", "s", [LIFT, LIFT, CHILD])),
          [],
          NOTHING_UNEVALUABLE,
        );

        expect(
          comparison.failing.map(({ moved, ambiguous }) => ({
            moved: moved.map(({ from, to, hasState }) => [
              from,
              to,
              hasState,
            ]),
            ambiguous: ambiguous.map(({ before, after, hasState }) => [
              before,
              after,
              hasState,
            ]),
          })),
        ).toEqual([{
          moved: [[3, 2, true]],
          ambiguous: [[[0, 1, 2], [0, 1], false]],
        }]);
      });

      it("returns no failure for a description whose count differs where the pairing reports no move", () => {
        // TODO(danfuzz): This pins the gate as it stands, not as it should
        // be: the first of three lifts is removed and the other two move, but
        // the pairing by order reports no move and the gate passes. Invert it
        // to a failure once how cells holding no state are to be matched is
        // settled; `compareDumps()` carries the matching `TODO`.
        const comparison = compareDumps(
          dump(build("note.tsx", "s", [LIFT, LIFT, LIFT])),
          dump(build("note.tsx", "s", [LIFT, LIFT])),
          [],
          NOTHING_UNEVALUABLE,
        );

        expect(comparison.compared).toBe(1);
        expect(comparison.failing).toEqual([]);
      });
    });

    it("returns no failure for a pattern numbered alike on both sides", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(build("room.tsx", "s", [LIFT, CHILD])),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison).toEqual({
        failing: [],
        forgiven: [],
        unused: [],
        compared: 1,
        dropped: [],
        built: { base: 1, head: 1 },
        compileErrors: [],
      });
    });

    it("returns no comparison of a pattern whose source differs between the two sides", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(build("room.tsx", "edited", [CHILD])),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.compared).toBe(0);
      expect(comparison.failing).toEqual([]);
    });

    it("returns as forgiven a move an accepted entry names by both builds' digests", () => {
      const entry: AcceptedMove = {
        pattern: "room.tsx",
        base: assignmentDigest(NUMBERED),
        head: assignmentDigest(RENUMBERED),
        reason: "test",
      };

      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [entry],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.failing).toEqual([]);
      expect(comparison.forgiven).toEqual(["room.tsx"]);
      expect(comparison.unused).toEqual([]);
    });

    it("returns as a failure a move an accepted entry names by another build, and the entry as unused", () => {
      const entry: AcceptedMove = {
        pattern: "room.tsx",
        base: assignmentDigest(NUMBERED),
        head: assignmentDigest(build("room.tsx", "s", [CHILD, LIFT])),
        reason: "test",
      };

      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [entry],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.failing.map(({ pattern }) => pattern)).toEqual([
        "room.tsx",
      ]);
      expect(comparison.unused).toEqual([entry]);
    });

    it("returns each pattern either side failed to compile", () => {
      const comparison = compareDumps(
        {
          assignments: [],
          unassigned: [],
          errors: [{ pattern: "a.tsx", error: "base broke" }],
        },
        {
          assignments: [NUMBERED],
          unassigned: [],
          errors: [{ pattern: "b.tsx", error: "head broke" }],
        },
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.compileErrors).toEqual([
        { side: "base", pattern: "a.tsx", error: "base broke" },
        { side: "head", pattern: "b.tsx", error: "head broke" },
      ]);
      expect(describeCompileErrors(comparison)).toContain(
        "b.tsx (head build): head broke",
      );
    });

    it("returns no compile error for a pattern its side lists as unevaluable", () => {
      const comparison = compareDumps(
        dump(),
        {
          assignments: [],
          unassigned: [],
          errors: [{ pattern: "listed.tsx", error: "never evaluates" }],
        },
        [],
        { base: new Set(), head: new Set(["listed.tsx"]) },
      );

      expect(comparison.compileErrors).toEqual([]);
    });

    it("returns no compile error for a base failure the base lists, where the change makes the pattern evaluate and takes it off the list", () => {
      const comparison = compareDumps(
        {
          assignments: [],
          unassigned: [],
          errors: [{ pattern: "room.tsx", error: "never evaluates" }],
        },
        dump(NUMBERED),
        [],
        { base: new Set(["room.tsx"]), head: new Set() },
      );

      expect(comparison.compileErrors).toEqual([]);
    });

    it("returns a compile error for a head failure that only the base lists", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        {
          assignments: [],
          unassigned: [],
          errors: [{ pattern: "room.tsx", error: "broke" }],
        },
        [],
        { base: new Set(["room.tsx"]), head: new Set() },
      );

      expect(comparison.compileErrors).toEqual([
        { side: "head", pattern: "room.tsx", error: "broke" },
      ]);
    });

    it("returns as dropped a pattern the base built and the head compiled from the same source to no assignment", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dumpUnassigned(NUMBERED),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.dropped).toEqual(["room.tsx"]);
      expect(comparison.compared).toBe(0);
    });

    it("returns nothing as dropped where the head compiled an edited source to no assignment", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dumpUnassigned(build("room.tsx", "edited", [])),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.dropped).toEqual([]);
    });

    it("returns nothing as dropped for a module neither side builds an assignment of", () => {
      const helper = build("schemas.ts", "s", []);

      const comparison = compareDumps(
        dumpUnassigned(helper),
        dumpUnassigned(helper),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.dropped).toEqual([]);
    });

    it("returns nothing as dropped, and a compile error, where the head failed to compile a pattern the base built", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        {
          assignments: [],
          unassigned: [],
          errors: [{ pattern: "room.tsx", error: "broke" }],
        },
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.dropped).toEqual([]);
      expect(comparison.compileErrors.length).toBe(1);
    });
  });

  describe("failureReports()", () => {
    const OTHER = build("other.tsx", "s", [LIFT]);
    const HELPER = build("schemas.ts", "s", []);

    it("returns no report for patterns numbered alike on both sides, beside a module neither side builds an assignment of", () => {
      const side = {
        ...dump(NUMBERED, OTHER),
        unassigned: dumpUnassigned(HELPER).unassigned,
      };

      expect(
        failureReports(compareDumps(side, side, [], NOTHING_UNEVALUABLE)),
      ).toEqual([]);
    });

    it("returns a report naming each pattern, and a report of nothing compared, for a head side whose builds all return `undefined`", () => {
      const reports = failureReports(
        compareDumps(
          dump(NUMBERED, OTHER),
          dumpUnassigned(NUMBERED, OTHER),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(reports.length).toBe(2);
      expect(reports[0]).toContain("room.tsx");
      expect(reports[0]).toContain("other.tsx");
      expect(reports[1]).toContain("gave 2 patterns an assignment");
      expect(reports[1]).toContain("this build 0");
    });

    it("returns a report naming the one pattern the head side stopped building, while the others compare", () => {
      const reports = failureReports(
        compareDumps(
          dump(NUMBERED, OTHER),
          { ...dumpUnassigned(NUMBERED), assignments: [OTHER] },
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(reports.length).toBe(1);
      expect(reports[0]).toContain("room.tsx");
      expect(reports[0]).not.toContain("other.tsx");
    });

    it("returns a report of nothing compared where neither side built a pattern", () => {
      const reports = failureReports(
        compareDumps(
          dumpUnassigned(HELPER),
          dumpUnassigned(HELPER),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(reports.length).toBe(1);
      expect(reports[0]).toContain("compared no patterns");
    });

    it("returns a report of nothing compared where every pattern's source differs", () => {
      const reports = failureReports(
        compareDumps(
          dump(NUMBERED),
          dump(build("room.tsx", "edited", [LIFT, CHILD])),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(reports.length).toBe(1);
      expect(reports[0]).toContain("compared no patterns");
    });

    it("returns no report for one edited pattern beside one compared", () => {
      expect(
        failureReports(
          compareDumps(
            dump(NUMBERED, OTHER),
            dump(build("room.tsx", "edited", [CHILD]), OTHER),
            [],
            NOTHING_UNEVALUABLE,
          ),
        ),
      ).toEqual([]);
    });

    it("returns a report of a moved cell and a report of a compile error", () => {
      const reports = failureReports(
        compareDumps(
          dump(NUMBERED),
          {
            ...dump(RENUMBERED),
            errors: [{ pattern: "broken.tsx", error: "broke" }],
          },
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(reports.length).toBe(2);
      expect(reports[0]).toContain("broken.tsx (head build): broke");
      expect(reports[1]).toContain("room.tsx");
    });
  });

  describe("parseArguments()", () => {
    it("names no base revision and compares every pattern when given nothing", () => {
      expect(parseArguments([])).toEqual({
        baseRef: undefined,
        part: { index: 0, count: 1 },
      });
    });

    it("reads a base revision and a part counted from one", () => {
      expect(parseArguments(["HEAD~2", "--part", "2/3"])).toEqual({
        baseRef: "HEAD~2",
        part: { index: 1, count: 3 },
      });
    });

    it("throws on a part outside its count, malformed, or missing", () => {
      for (
        const part of [
          "0/3",
          "4/3",
          "two/3",
          "1/",
          "1/9007199254740993",
          undefined,
        ]
      ) {
        expect(() =>
          parseArguments(part === undefined ? ["--part"] : ["--part", part])
        ).toThrow("--part takes K/N");
      }
    });

    it("throws on a second base revision", () => {
      expect(() => parseArguments(["HEAD", "HEAD~1"])).toThrow(
        "a second base revision, HEAD~1",
      );
    });

    it("throws on an option it does not know", () => {
      expect(() => parseArguments(["--parts", "1/2"])).toThrow(
        "unknown argument --parts",
      );
    });
  });

  describe("inPart()", () => {
    it("deals every item into exactly one of the parts", () => {
      const items = ["a", "b", "c", "d", "e", "f", "g"];
      const parts = [0, 1, 2].map((index) =>
        inPart(items, { index, count: 3 })
      );
      expect(parts).toEqual([["a", "d", "g"], ["b", "e"], ["c", "f"]]);
      expect(parts.flat().toSorted()).toEqual(items);
    });
  });

  describe("acceptedInPart()", () => {
    const entry = (pattern: string): AcceptedMove => ({
      pattern,
      base: "0123456789abcdef",
      head: "fedcba9876543210",
      reason: "a reason",
    });
    const files = ["patterns/a.tsx", "patterns/b.tsx"];
    const accepted = [entry("a.tsx"), entry("b.tsx"), entry("gone.tsx")];

    it("gives each part the entries naming its own patterns", () => {
      expect(
        acceptedInPart(accepted, files, { index: 1, count: 2 })
          .map(({ pattern }) => pattern),
      ).toEqual(["b.tsx"]);
    });

    it("gives the first part the entries naming no pattern the tree holds", () => {
      expect(
        acceptedInPart(accepted, files, { index: 0, count: 2 })
          .map(({ pattern }) => pattern),
      ).toEqual(["a.tsx", "gone.tsx"]);
    });
  });

  describe("acceptedMoveProblems()", () => {
    const entry = (overrides: Partial<AcceptedMove> = {}): AcceptedMove => ({
      pattern: "room.tsx",
      base: assignmentDigest(NUMBERED),
      head: assignmentDigest(RENUMBERED),
      reason: "the transformer reads `row[UI]` in place",
      ...overrides,
    });

    it("returns nothing for an entry with a reason and two digests", () => {
      expect(acceptedMoveProblems([entry()])).toEqual([]);
    });

    it("returns a problem for an entry whose reason is blank", () => {
      expect(acceptedMoveProblems([entry({ reason: "  " })])).toEqual([
        `room.tsx (${assignmentDigest(NUMBERED)} -> ${
          assignmentDigest(RENUMBERED)
        }) gives no reason`,
      ]);
    });

    it("returns a problem for a digest not spelled as the gate prints one", () => {
      expect(acceptedMoveProblems([entry({ head: "abc" })]).length).toBe(1);
    });

    it("returns a problem for a pattern and pair of builds named twice", () => {
      expect(acceptedMoveProblems([entry(), entry()]).length).toBe(1);
    });

    it("returns nothing for the moves the repository accepts", () => {
      expect(acceptedMoveProblems(ACCEPTED_MOVES)).toEqual([]);
    });
  });

  describe("describeFailures()", () => {
    it("returns a description only the base build has as removed, and one only this build has as added, with its numbers", () => {
      // A lift and a child are removed, and an `ifElse` is added: the child's
      // move fails the pattern, and each description one side lacks is named
      // with the numbers the other side gives it.
      const text = describeFailures(
        compareDumps(
          dump(build("note.tsx", "s", [LIFT, CHILD])),
          dump(build("note.tsx", "s", [IF_ELSE])),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(text).toContain(`  removed: [0]: ${LIFT} (entry pattern)`);
      expect(text).toContain(
        `  removed, holds state: [1]: ${CHILD} (entry pattern)`,
      );
      expect(text).toContain(`  added: [0]: ${IF_ELSE} (entry pattern)`);
      expect(text).not.toContain("ambiguous");
    });

    it("returns a description of cells holding no state that cannot be matched, with both builds' numbers and no mention of state", () => {
      const text = describeFailures(
        compareDumps(
          dump(build("note.tsx", "s", [LIFT, IF_ELSE, LIFT])),
          dump(build("note.tsx", "s", [LIFT, LIFT, IF_ELSE, LIFT])),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(text).toContain(
        `  ambiguous: [0, 2] -> [0, 1, 3]: ${LIFT} (entry pattern)`,
      );
      expect(text).toContain(`  1 -> 2: ${IF_ELSE} (entry pattern)`);
      expect(text).not.toContain(`2 -> 1: ${LIFT}`);
    });

    it("returns each moved cell with its two numbers, whether it holds state, and both builds' digests", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [],
        NOTHING_UNEVALUABLE,
      );
      const text = describeFailures(comparison);

      expect(text).toContain(
        `room.tsx (base build ${
          assignmentDigest(
            NUMBERED,
          )
        }, this build ${assignmentDigest(RENUMBERED)}):`,
      );
      expect(text).toContain(`  1 -> 0, holds state: ${CHILD} (entry pattern)`);
    });

    it("returns each description of cells holding state that cannot be matched, with both builds' numbers for it", () => {
      const text = describeFailures(
        compareDumps(
          dump(THREE_CHILDREN),
          dump(TWO_CHILDREN),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(text).toContain(
        `  ambiguous, holds state: [0, 1, 2] -> [0, 1]: ${CHILD} (entry pattern)`,
      );
    });
  });
  describe("dumperConfig()", () => {
    /**
     * Runs `test` against a base checkout with package `@t/a` and a change
     * that adds `@t/b`, and removes both afterwards.
     */
    async function withCheckouts(
      test: (checkouts: { base: string; head: string }) => Promise<void>,
    ): Promise<void> {
      const scratch = await Deno.makeTempDir({ prefix: "dumper-config-" });
      const a = {
        "base/a/deno.json": JSON.stringify({
          name: "@t/a",
          exports: "./src/m.ts",
        }),
        "base/a/src/m.ts": "export const m = 1;\n",
      };
      const base = join(scratch, "base");
      await write(base, {
        ...a,
        "deno.jsonc": JSON.stringify({
          workspace: ["./base/a"],
          imports: { "@std/path": "jsr:@std/path@^1" },
        }),
      });
      const head = join(scratch, "head");
      await write(head, {
        ...a,
        "deno.jsonc": JSON.stringify({ workspace: ["./base/a", "./base/b"] }),
        "base/b/deno.jsonc": JSON.stringify({
          name: "@t/b",
          imports: { "@/": "./src/" },
          exports: { ".": "./src/index.ts", "./n": "./src/n.ts" },
        }),
        "base/b/src/index.ts": 'export { n as b } from "@/n.ts";\n',
        "base/b/src/n.ts": "export const n = 3;\n",
        "tasks/use.ts":
          'import { n } from "@t/b/n";\nimport { b } from "@t/b";\n' +
          "console.log(n, b);\n",
      });
      try {
        await test({ base, head });
      } finally {
        await Deno.remove(scratch, { recursive: true });
      }
    }

    it("lists each workspace package with its directory, the file each export names, and its own imports", () =>
      withCheckouts(async ({ head }) => {
        const url = (path: string) => toFileUrl(join(head, path)).href;
        expect(await workspacePackages(head)).toEqual(
          new Map([
            ["@t/a", {
              dir: url("base/a/"),
              exports: new Map([["@t/a", url("base/a/src/m.ts")]]),
              imports: {},
            }],
            ["@t/b", {
              dir: url("base/b/"),
              exports: new Map([
                ["@t/b", url("base/b/src/index.ts")],
                ["@t/b/n", url("base/b/src/n.ts")],
              ]),
              imports: { "@/": url("base/b/src/") },
            }],
          ]),
        );
      }));

    it("returns the checkout's own configuration where the change adds no package", () =>
      withCheckouts(async ({ head }) => {
        expect(await dumperConfig(head, head)).toBe(join(head, "deno.jsonc"));
      }));

    it("adds an import for each module of a package only the change has, and that package's own imports, and nothing for one both have", () =>
      withCheckouts(async ({ base, head }) => {
        const config = JSON.parse(
          await Deno.readTextFile(await dumperConfig(base, head)),
        );
        expect(config.workspace).toEqual(["./base/a"]);
        expect(config.imports).toEqual({
          "@std/path": "jsr:@std/path@^1",
          "@t/b": toFileUrl(join(head, "base/b/src/index.ts")).href,
          "@t/b/n": toFileUrl(join(head, "base/b/src/n.ts")).href,
        });
        expect(config.scopes).toEqual({
          [toFileUrl(join(head, "base/b/")).href]: {
            "@/": toFileUrl(join(head, "base/b/src/")).href,
          },
        });
      }));

    it("lets a module of the change name its new package while the base checkout's configuration is in force", () =>
      withCheckouts(async ({ base, head }) => {
        const run = (config: string) =>
          new Deno.Command(Deno.execPath(), {
            args: ["run", "--config", config, join(head, "tasks/use.ts")],
            cwd: base,
            stdout: "piped",
            stderr: "piped",
          }).output();
        const without = await run(join(base, "deno.jsonc"));
        expect(without.code).not.toBe(0);
        expect(new TextDecoder().decode(without.stderr)).toContain(
          'not a dependency and not in import map from "' +
            toFileUrl(join(head, "tasks/use.ts")).href,
        );
        const withAdded = await run(await dumperConfig(base, head));
        expect(new TextDecoder().decode(withAdded.stdout)).toBe("3 3\n");
      }));

    it("throws where the checkout's own configuration is not an object", () =>
      withCheckouts(async ({ base, head }) => {
        await Deno.writeTextFile(join(base, "deno.jsonc"), "[]");
        await expect(dumperConfig(base, head)).rejects.toThrow(
          `${join(base, "deno.jsonc")} is not an object`,
        );
      }));
  });

  describe("workspacePackages()", () => {
    let root: string;

    beforeEach(async () => {
      root = await Deno.makeTempDir({ prefix: "workspace-packages-" });
    });
    afterEach(async () => {
      await Deno.remove(root, { recursive: true });
    });

    it("returns only the string entries of a manifest, and nothing for a member with no manifest", async () => {
      await write(root, {
        "deno.jsonc": JSON.stringify({
          workspace: [3, "./base/a", "./base/bare"],
        }),
        "base/a/deno.json": JSON.stringify({
          name: "@t/a",
          exports: { ".": "./m.ts", "./x": 4 },
          imports: { "@/": "./src/", "odd": 5 },
        }),
        "base/bare/README.md": "no manifest\n",
      });
      const url = (path: string) => toFileUrl(join(root, path)).href;

      expect(await workspacePackages(root)).toEqual(
        new Map([["@t/a", {
          dir: url("base/a/"),
          exports: new Map([["@t/a", url("base/a/m.ts")]]),
          imports: { "@/": url("base/a/src/") },
        }]]),
      );
    });

    it("throws for a member manifest that does not parse", async () => {
      await write(root, {
        "deno.jsonc": JSON.stringify({ workspace: ["./base/a"] }),
        "base/a/deno.jsonc": "{ not json",
      });

      await expect(workspacePackages(root)).rejects.toThrow(SyntaxError);
    });
  });

  describe("unevaluableIn()", () => {
    it("returns the list this checkout keeps", async () => {
      expect(await unevaluableIn(ROOT)).toBe(UNEVALUABLE_PATTERNS);
    });

    it("returns an empty set for a checkout that keeps no list", async () => {
      const root = await Deno.makeTempDir({ prefix: "unevaluable-" });
      try {
        expect(await unevaluableIn(root)).toEqual(new Set());
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("throws where the checkout cannot be read", async () => {
      const file = await Deno.makeTempFile({ prefix: "unevaluable-" });
      try {
        await expect(unevaluableIn(file)).rejects.toThrow(
          Deno.errors.NotADirectory,
        );
      } finally {
        await Deno.remove(file);
      }
    });
  });

  describe("dumpTree()", () => {
    it("throws with the dumper's own error where the dumper fails", async () => {
      // The checkout holds no compiler for the dumper to load.
      const root = await Deno.makeTempDir({ prefix: "dump-tree-" });
      try {
        await expect(
          dumpTree(
            root,
            join(ROOT, "deno.jsonc"),
            ["patterns/room.tsx"],
            1,
            root,
            "base",
          ),
        ).rejects.toThrow(
          /^dumping the base build failed:\n[^]*runtime\/cli\/lib\/dev\.ts/,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("main()", () => {
    const MERGE_BASE = "0123456789abcdef0123456789abcdef01234567";

    let head: string;
    let asked: string[][];
    let baseTree: string | undefined;
    let dumped: Record<string, readonly string[]>;

    beforeEach(async () => {
      head = await Deno.makeTempDir({ prefix: "cause-assignments-main-" });
      await write(head, {
        "deno.jsonc": "{}",
        "patterns/room.tsx": "// a pattern\n",
        "patterns/added.tsx": "// a pattern the base lacks\n",
      });
      for (const tree of CONNECTOR_PATTERN_SOURCES) {
        await Deno.mkdir(join(head, tree.directory), { recursive: true });
      }
      asked = [];
      baseTree = undefined;
      dumped = {};
    });
    afterEach(async () => {
      await Deno.remove(head, { recursive: true });
    });

    /**
     * A checkout at `head` whose git finds `changed` changed since the merge
     * base and checks out a base tree holding `baseFiles`, failing to remove it
     * again where `removal` says so, and whose dump of each side is the one
     * `dumps` gives. Each call's arguments go to `asked`.
     */
    const checkout = (
      {
        changed = "runtime/runner/src/harness/x.ts\n",
        baseFiles,
        dumps,
        removal = "succeeds",
      }: {
        changed?: string;
        baseFiles?: Readonly<Record<string, string>>;
        dumps?: { base: DumpOutput; head: DumpOutput };
        removal?: "succeeds" | "fails";
      } = {},
    ): GateCheckout => ({
      git: async (...args) => {
        asked.push(args);
        switch (args[0]) {
          case "merge-base":
            if (args[1] !== "main") throw new Error("no such ref");
            return `${MERGE_BASE}\n`;
          case "diff":
            return changed;
          case "rev-parse":
            return `${head}\n`;
          case "for-each-ref":
            return "refs/remotes/upstream/main\n";
          case "worktree":
            if (args[1] === "add") {
              baseTree = args[3];
              await write(baseTree, {
                "deno.jsonc": "{}",
                ...(baseFiles ?? { "patterns/room.tsx": "// a pattern\n" }),
              });
            } else if (removal === "fails") {
              throw new Error("the worktree is locked");
            } else {
              await Deno.remove(args[3], { recursive: true });
            }
            return "";
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      dumpTree: (_root, _config, files, _shards, _outDir, label) => {
        dumped[label] = files;
        const side = dumps ?? { base: dump(NUMBERED), head: dump(NUMBERED) };
        return Promise.resolve(label === "base" ? side.base : side.head);
      },
    });

    /** The directory the gate checked the base out under. */
    function baseScratch(): string {
      if (baseTree === undefined) throw new Error("no base was checked out");
      return join(baseTree, "..");
    }

    const forgiving: AcceptedMove = {
      pattern: "room.tsx",
      base: assignmentDigest(NUMBERED),
      head: assignmentDigest(RENUMBERED),
      reason: "test",
    };

    it("returns 1 naming each problem with the accepted moves, before asking git anything", async () => {
      expect(
        await main(["main"], checkout(), [{ ...forgiving, reason: " " }]),
      ).toEqual({
        err: "tasks/cause-assignments-accepted-moves.ts:\n" +
          `  room.tsx (${forgiving.base} -> ${forgiving.head}) gives no reason`,
        code: 1,
      });
      expect(asked).toEqual([]);
    });

    it("returns 2 with its usage for a part it cannot read, before asking git anything", async () => {
      expect(await main(["main", "--part", "0/2"], checkout(), [])).toEqual({
        err: "Error: --part takes K/N with 1 <= K <= N, not 0/2\n" +
          "Usage: check-cause-assignments.ts [base-ref] [--part K/N]",
        code: 2,
      });
      expect(asked).toEqual([]);
    });

    it("returns 2 and asks for real history where git finds no merge base", async () => {
      expect(await main(["nowhere"], checkout(), [])).toEqual({
        err: "Could not resolve a merge base against nowhere. This check " +
          "needs real history — CI must check out with fetch-depth: 0.",
        code: 2,
      });
      expect(asked).toEqual([["merge-base", "nowhere", "HEAD"]]);
    });

    it("measures from the default base where it is named none", async () => {
      // The fake git has an `upstream/main`, so that is the default, and it
      // finds no merge base with it.
      expect(await main([], checkout(), [])).toEqual({
        err: "Could not resolve a merge base against " +
          "refs/remotes/upstream/main. This check needs real history — CI " +
          "must check out with fetch-depth: 0.",
        code: 2,
      });
      expect(asked).toContainEqual([
        "merge-base",
        "refs/remotes/upstream/main",
        "HEAD",
      ]);
    });

    it("returns 2 against a ref this checkout's own git does not know", async () => {
      const { code, err } = await main(["refs/heads/no-such-branch-anywhere"]);

      expect(code).toBe(2);
      expect(err).toContain(
        "Could not resolve a merge base against " +
          "refs/heads/no-such-branch-anywhere.",
      );
    });

    it("returns 0 without checking out the base, where nothing it watches changed", async () => {
      expect(await main(["main"], checkout({ changed: "\n" }), [])).toEqual({
        out: "check-cause-assignments: nothing a pattern's numbering is " +
          "built by changed since 0123456789.",
        code: 0,
      });
      expect(asked.map(([command]) => command)).toEqual(["merge-base", "diff"]);
    });

    it("dumps on the base side only the patterns the base checkout holds, and removes that checkout afterwards", async () => {
      const { code, out, err } = await main(["main"], checkout(), []);

      expect(code).toBe(0);
      expect(err).toBeUndefined();
      expect(out).toMatch(
        /^check-cause-assignments: compared 1 patterns built from the same source by 0123456789 and this change, in \d+s\.$/,
      );
      expect(dumped).toEqual({
        base: ["patterns/room.tsx"],
        head: ["patterns/added.tsx", "patterns/room.tsx"],
      });
      expect(asked.slice(-2)).toEqual([
        [
          "worktree",
          "add",
          "--detach",
          join(baseScratch(), "base"),
          MERGE_BASE,
        ],
        ["worktree", "remove", "--force", join(baseScratch(), "base")],
      ]);
      expect(existsSync(baseScratch())).toBe(false);
    });

    it("returns 1 with what the run found and the base checkout it could not remove", async () => {
      try {
        const { code, out, err } = await main(
          ["main"],
          checkout({
            dumps: { base: dump(NUMBERED), head: dump(RENUMBERED) },
            removal: "fails",
          }),
          [],
        );

        expect(code).toBe(1);
        expect(out).toContain("compared 1 patterns");
        expect(err).toContain("A compiler change moves anonymous cells");
        expect(err).toMatch(
          /\nCould not clean up the base checkout at .*: Error: the worktree is locked$/,
        );
      } finally {
        await Deno.remove(baseScratch(), { recursive: true });
      }
    });

    it("returns 1 for a run that passed but could not remove the base checkout", async () => {
      try {
        const { code, out, err } = await main(
          ["main"],
          checkout({ removal: "fails" }),
          [],
        );

        expect(code).toBe(1);
        expect(out).toContain("compared 1 patterns");
        expect(err).toBe(
          `Could not clean up the base checkout at ${
            join(baseScratch(), "base")
          }: Error: the worktree is locked`,
        );
      } finally {
        await Deno.remove(baseScratch(), { recursive: true });
      }
    });

    it("throws both the error that ended the run and the base checkout it could not remove", async () => {
      try {
        const run = main(
          ["main"],
          checkout({
            baseFiles: { "patterns": "a file\n" },
            removal: "fails",
          }),
          [],
        );

        await expect(run).rejects.toThrow(/NotADirectory/);
        await expect(run).rejects.toThrow(
          /\nCould not clean up the base checkout at .*: Error: the worktree is locked$/,
        );
      } finally {
        await Deno.remove(baseScratch(), { recursive: true });
      }
    });

    it("dumps only the patterns its part holds, and names the part", async () => {
      const { code, out } = await main(
        ["main", "--part", "2/2"],
        checkout(),
        [],
      );

      expect(code).toBe(0);
      expect(out).toContain(
        "check-cause-assignments part 2 of 2: compared 1 patterns",
      );
      expect(dumped).toEqual({
        base: ["patterns/room.tsx"],
        head: ["patterns/room.tsx"],
      });
    });

    it("returns 0 naming a move an accepted entry forgives, and an entry that forgives nothing", async () => {
      const unused: AcceptedMove = { ...forgiving, pattern: "lobby.tsx" };

      const { code, out, err } = await main(
        ["main"],
        checkout({ dumps: { base: dump(NUMBERED), head: dump(RENUMBERED) } }),
        [forgiving, unused],
      );

      expect(code).toBe(0);
      expect(err).toBeUndefined();
      expect(out).toContain(
        "\n  room.tsx: moves forgiven by an accepted entry\n" +
          `  the accepted entry for lobby.tsx (${forgiving.base} -> ` +
          `${forgiving.head}) forgives nothing in this run and can be removed`,
      );
    });

    it("returns 1 with the report of a move no accepted entry forgives", async () => {
      const { code, out, err } = await main(
        ["main"],
        checkout({ dumps: { base: dump(NUMBERED), head: dump(RENUMBERED) } }),
        [],
      );

      expect(code).toBe(1);
      expect(out).toContain("compared 1 patterns");
      expect(err).toContain("A compiler change moves anonymous cells");
      expect(err).toContain("room.tsx (base build");
    });

    it("returns 1 with each report, one after another, for a run that compared nothing and dropped a pattern", async () => {
      const { code, err } = await main(
        ["main"],
        checkout({
          dumps: { base: dump(NUMBERED), head: dumpUnassigned(NUMBERED) },
        }),
        [],
      );

      expect(code).toBe(1);
      expect(err).toBe(
        failureReports(
          compareDumps(dump(NUMBERED), dumpUnassigned(NUMBERED), [], {
            base: new Set(),
            head: UNEVALUABLE_PATTERNS,
          }),
        ).join("\n"),
      );
      expect(err).toContain("compared no patterns");
      expect(err).toContain("\nroom.tsx");
    });

    it("throws, and removes the base checkout, where a pattern's path in it cannot be read", async () => {
      await expect(
        main(["main"], checkout({ baseFiles: { "patterns": "a file\n" } }), []),
      ).rejects.toThrow(Deno.errors.NotADirectory);
      expect(existsSync(baseScratch())).toBe(false);
    });
  });

  describe("dumperEnvironment()", () => {
    it("leaves out each variable that sets an experimental flag, and keeps the rest", () => {
      expect(
        dumperEnvironment({
          PATH: "/bin",
          EXPERIMENTAL_LOCAL_FOLD: "true",
          EXPERIMENTAL_MODERN_CELL_REP: "false",
          EXPERIMENTAL_UNMAPPED_NAME: "true",
          LOG_LEVEL: "debug",
        }),
      ).toStrictEqual({
        PATH: "/bin",
        EXPERIMENTAL_UNMAPPED_NAME: "true",
        LOG_LEVEL: "error",
      });
    });

    it("leaves out the coverage directory, so the dumper writes no profile", () => {
      expect(
        dumperEnvironment({ PATH: "/bin", DENO_COVERAGE_DIR: "coverage/raw" }),
      ).toStrictEqual({ PATH: "/bin", LOG_LEVEL: "error" });
    });
  });

  describe("the script", () => {
    /** Runs git in `repo`, under a configuration no developer's can change. */
    async function git(repo: string, ...args: string[]): Promise<void> {
      const { code, stderr } = await new Deno.Command("git", {
        args: [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        cwd: repo,
        stdout: "null",
        stderr: "piped",
      }).output();
      if (code !== 0) {
        throw new Error(
          `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`,
        );
      }
    }

    /**
     * Commits a repository holding a pattern, a helper module, a note, and the
     * stand-in compiler, applies `change` to its working tree, and returns the
     * result of running the gate there against that commit, with this
     * checkout's own git and dumper. The repository's
     * configuration lets the dump, whose modules are this checkout's, name the
     * packages it imports, and compiles them with this checkout's compiler
     * options. Deno caches one compiled copy of each module, so a dump compiled
     * under other options replaces the copy a coverage profile of this test
     * process was taken against, and that profile then fails to convert.
     */
    async function runGate(
      change: Readonly<Record<string, string>>,
    ): Promise<{ code: number; stdout: string; stderr: string }> {
      const repo = await Deno.makeTempDir({
        prefix: "cause-assignments-gate-",
      });
      try {
        const { imports, compilerOptions } = await readDenoConfig(
          join(ROOT, "deno.jsonc"),
        );
        await write(repo, {
          ...STAND_IN_COMPILER,
          "patterns/room.tsx": "// a pattern\n",
          "patterns/schemas.ts": "// a helper\n",
          "deno.jsonc": JSON.stringify({ imports, compilerOptions }),
          "notes.md": "a note\n",
        });
        await Deno.rename(
          await dumperConfig(repo, ROOT),
          join(repo, "deno.jsonc"),
        );
        await Deno.copyFile(join(ROOT, "deno.lock"), join(repo, "deno.lock"));
        await Deno.mkdir(join(repo, "patterns"), { recursive: true });
        for (const tree of CONNECTOR_PATTERN_SOURCES) {
          await Deno.mkdir(join(repo, tree.directory), { recursive: true });
        }
        await git(repo, "init", "--quiet");
        await git(repo, "add", ".");
        await git(repo, "commit", "--quiet", "--no-verify", "-m", "base");
        await write(repo, change);
        const output = await runDenoCommandWithTemporaryLock({
          root: ROOT,
          cwd: repo,
          args: (lockPath) => [
            "run",
            "--config",
            join(ROOT, "deno.jsonc"),
            "--lock",
            lockPath,
            "-A",
            join(ROOT, "tasks/check-cause-assignments.ts"),
            "HEAD",
          ],
        });
        return {
          code: output.code,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
        };
      } finally {
        await Deno.remove(repo, { recursive: true });
      }
    }

    it("exits 0 having compared the pattern, for a change that builds each pattern as the base does", async () => {
      // The one run through real git and the real dumper; `main()` above
      // holds each outcome to the facts a checkout supplies.

      const { code, stdout } = await runGate(WATCHED_EDIT);

      expect(stdout).toContain("compared 1 patterns");
      expect(code).toBe(0);
    });
  });
});
