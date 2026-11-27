import { expect } from "@std/expect";
import { exists } from "@std/fs/exists";
import type { JSONSchema } from "@commonfabric/runner";
import { recordsSpooledBy } from "@commonfabric/test-support/records";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import type { CommandOutput } from "./command-output.ts";
import type { AcceptedContractBreak } from "./pattern-compat-accepted-breaks.ts";
import {
  contractHash,
  type PatternContract,
  writeBaseline,
} from "./pattern-compat-lib.ts";
import {
  type CompatGateInput,
  judgeCompatibility,
  runPatternCompat,
} from "./pattern-compat.ts";

const ARGUMENT: JSONSchema = { type: "object", properties: {} };

const RESULT_WITH_TITLE: JSONSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};

/** `RESULT_WITH_TITLE` with `title` dropped, which breaks every reader of it. */
const RESULT_WITHOUT_TITLE: JSONSchema = { type: "object", properties: {} };

const WITH_TITLE: PatternContract = {
  argumentSchema: ARGUMENT,
  resultSchema: RESULT_WITH_TITLE,
};

const WITHOUT_TITLE: PatternContract = {
  argumentSchema: ARGUMENT,
  resultSchema: RESULT_WITHOUT_TITLE,
};

const RECORDED_AT = new Date("2026-01-02T03:04:05Z");

/** A module whose default export is a pattern declaring `contract`. */
const patternModule = (contract: PatternContract) => ({ default: contract });

describe("pattern-compat", () => {
  let baselinesDir: string;

  beforeEach(async () => {
    baselinesDir = await Deno.makeTempDir({ prefix: "pattern-compat-" });
  });

  afterEach(async () => {
    await Deno.remove(baselinesDir, { recursive: true });
  });

  /** The records a run appended, as `[name, outcome]` pairs. */
  type RecordSink = { records: [string, string][] };

  /**
   * Judge `modules`, each a repository-relative file mapped to what evaluating
   * it returns, or to the `Error` evaluating it throws. The result carries the
   * progress lines the run printed, as `said`.
   */
  const judge = async (
    modules: Record<string, unknown>,
    overrides: Partial<CompatGateInput> = {},
    sink: RecordSink = { records: [] },
  ) => {
    const said: string[] = [];
    const shown = await judgeCompatibility({
      update: false,
      only: [],
      files: Object.keys(modules),
      baselinesDir,
      acceptedBreaks: [],
      unevaluable: new Set(),
      evaluate: (file) => {
        const module = modules[file];
        return module instanceof Error
          ? Promise.reject(module)
          : Promise.resolve(module);
      },
      say: (line) => said.push(line),
      records: {
        append: (record) => {
          if (record.line === "record") {
            sink.records.push([record.test.n, record.outcome]);
          }
        },
      },
      recordedAt: RECORDED_AT,
      ...overrides,
    });
    return { ...shown, said };
  };

  const record = (key: string, contract: PatternContract) =>
    writeBaseline(baselinesDir, key, contract, RECORDED_AT);

  describe("judgeCompatibility()", () => {
    describe("a main.tsx entry", () => {
      const NEEDS_IDS: PatternContract = {
        argumentSchema: {
          type: "object",
          properties: { ids: { type: "array" } },
          required: ["ids"],
        },
        resultSchema: RESULT_WITH_TITLE,
      };

      it("fails when it requires an input with no default, naming the input", async () => {
        await record("demo/main.tsx", NEEDS_IDS);

        const shown = await judge({
          "patterns/demo/main.tsx": patternModule(NEEDS_IDS),
        });

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(
          "demo/main.tsx\n  is a main.tsx entry, which is offered as " +
            "standalone, but requires ids with no default",
        );
      });

      it("passes for the same contract in a file of another name, or outside patterns/", async () => {
        await record("demo/part.tsx", NEEDS_IDS);
        await record("agent-sessions-debug/main.tsx", NEEDS_IDS);

        const shown = await judge({
          "patterns/demo/part.tsx": patternModule(NEEDS_IDS),
          "connectors/agents/debug-view/main.tsx": patternModule(NEEDS_IDS),
        });

        expect({ code: shown.code, err: shown.err })
          .toEqual({ code: 0, err: undefined });
      });
    });

    describe("a pattern with no baseline", () => {
      it("fails, naming the contract and the command that records it", async () => {
        const sink: RecordSink = { records: [] };
        const shown = await judge(
          { "patterns/demo/a.tsx": patternModule(WITH_TITLE) },
          {},
          sink,
        );

        expect(shown.code).toBe(1);
        expect(shown.said).toEqual([
          "Checking update compatibility for 1 patterns.",
          "[1/1] demo/a.tsx",
        ]);
        expect(shown.out).toBeUndefined();
        expect(shown.err).toContain(
          `demo/a.tsx\n  contract ${contractHash(WITH_TITLE)} is not ` +
            `recorded.\n  Run: deno task pattern-compat --update`,
        );
        expect(sink.records).toEqual([["pattern-compat demo/a.tsx", "fail"]]);
      });

      it("is recorded by `--update`, after which the plain run passes", async () => {
        const modules = { "patterns/demo/a.tsx": patternModule(WITH_TITLE) };
        const updated = await judge(modules, { update: true });

        expect(updated.code).toBe(0);
        expect(updated.err).toBeUndefined();
        const name = `20260102T030405Z-${contractHash(WITH_TITLE)}.json`;
        expect(updated.out).toContain(
          `\nRecorded 1 contract(s):\n  demo/a.tsx/${name}`,
        );
        expect(await exists(`${baselinesDir}/demo/a.tsx/${name}`)).toBe(true);

        const sink: RecordSink = { records: [] };
        const checked = await judge(modules, {}, sink);
        expect(checked.code).toBe(0);
        expect(checked.out).toContain(
          "\n1 pattern(s) can be updated from every recorded contract.",
        );
        expect(sink.records).toEqual([["pattern-compat demo/a.tsx", "pass"]]);
      });
    });

    describe("a contract that cannot be applied over a baseline", () => {
      it("fails, naming the pair once above each of its issues", async () => {
        const label = (await record("demo/a.tsx", WITH_TITLE))
          .replace(/\.json$/, "");
        const shown = await judge({
          "patterns/demo/a.tsx": patternModule(WITHOUT_TITLE),
        });

        expect(shown.code).toBe(1);
        expect(shown.err).toContain("\nPattern update compatibility failures:");
        const heading =
          `\ndemo/a.tsx\n  cannot be applied over baseline ${label}:`;
        expect(shown.err?.split(heading).length).toBe(2);
        expect(shown.err).toMatch(/:\n- \S/);
      });

      it("is not recorded by `--update`, which still fails", async () => {
        await record("demo/a.tsx", WITH_TITLE);
        const shown = await judge(
          { "patterns/demo/a.tsx": patternModule(WITHOUT_TITLE) },
          { update: true },
        );

        expect(shown.code).toBe(1);
        expect(shown.out).not.toContain("Recorded");
        expect(shown.err).toContain("cannot be applied over baseline");
        expect([...Deno.readDirSync(`${baselinesDir}/demo/a.tsx`)].length)
          .toBe(1);
      });
    });

    it("fails a contract whose schema is not valid on its own terms", async () => {
      const shown = await judge({
        "patterns/demo/a.tsx": {
          default: {
            argumentSchema: ARGUMENT,
            resultSchema: { type: "undefined", scope: "bogus" },
          },
        },
      });

      expect(shown.code).toBe(1);
      expect(shown.err).toContain(
        "\ndemo/a.tsx\n  result schema is not valid on its own terms: ",
      );
    });

    describe("a file that yields no contract", () => {
      it("is skipped when it never had a baseline", async () => {
        const shown = await judge({
          "patterns/demo/helpers.ts": { helper: () => 1 },
        });

        expect(shown.code).toBe(0);
        expect(shown.out).toContain(
          "\nSkipped 1 file(s) with no pattern contract " +
            "(0 from an evaluation error).",
        );
        expect(shown.out).toContain(
          "\n0 pattern(s) can be updated from every recorded contract.",
        );
      });

      it("fails as retired when baselines exist for it", async () => {
        await record("demo/a.tsx", WITH_TITLE);
        const shown = await judge({ "patterns/demo/a.tsx": {} });

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(
          "\ndemo/a.tsx\n  has 1 baseline(s) but yields no contract now: " +
            "no pattern default export.",
        );
        expect(shown.err).toContain(
          "Restore it, or delete its baseline directory",
        );
      });

      it("fails as retired when its file is gone but its baselines are not", async () => {
        await record("demo/gone.tsx", WITH_TITLE);
        const shown = await judge({
          "patterns/demo/a.tsx": patternModule(WITH_TITLE),
        }, { update: true });

        expect(shown.code).toBe(1);
        expect(shown.said).toEqual([
          "Checking update compatibility for 2 patterns.",
          "[1/2] demo/a.tsx",
          "[2/2] demo/gone.tsx",
        ]);
        expect(shown.err).toContain(
          "\ndemo/gone.tsx\n  has 1 baseline(s) but yields no contract now: " +
            "file is gone.",
        );
      });
    });

    describe("a pattern that fails to evaluate", () => {
      const failing = {
        "patterns/demo/a.tsx": new Error("cannot compile\nsecond line"),
      };

      it("fails when it is not listed as unevaluable", async () => {
        const sink: RecordSink = { records: [] };
        const shown = await judge(failing, {}, sink);

        expect(shown.code).toBe(1);
        expect(shown.out).toContain(
          "(1 from an evaluation error).\n  [NEW] demo/a.tsx: ",
        );
        expect(shown.out).toContain("cannot compile");
        expect(shown.out).not.toContain("second line");
        expect(shown.err).toContain("\n1 pattern(s) newly fail to evaluate.");
        expect(sink.records).toEqual([["pattern-compat demo/a.tsx", "fail"]]);
      });

      it("passes as known debt when it is listed as unevaluable", async () => {
        const sink: RecordSink = { records: [] };
        const shown = await judge(failing, {
          unevaluable: new Set(["demo/a.tsx"]),
        }, sink);

        expect(shown.code).toBe(0);
        expect(shown.out).toContain("  [known] demo/a.tsx: ");
        expect(sink.records).toEqual([["pattern-compat demo/a.tsx", "pass"]]);
      });

      it("fails when a listed pattern evaluates again", async () => {
        await record("demo/a.tsx", WITH_TITLE);
        const shown = await judge(
          { "patterns/demo/a.tsx": patternModule(WITH_TITLE) },
          { unevaluable: new Set(["demo/a.tsx"]) },
        );

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(
          "\n1 pattern(s) listed in tasks/pattern-compat-unevaluable.ts now " +
            "evaluate: demo/a.tsx. Remove them from that list so they are " +
            "gated.",
        );
      });
    });

    describe("accepted contract breaks", () => {
      const accepted = (
        label: string,
        paths: readonly string[],
        pattern = "demo/a.tsx",
      ): AcceptedContractBreak => ({
        pattern,
        baselines: [label],
        paths,
        reason: "the title was removed on purpose",
        record: "docs/history/demo-title-break.md",
      });

      /** Record `WITH_TITLE` and return the label of its baseline. */
      const recordedLabel = async () =>
        (await record("demo/a.tsx", WITH_TITLE)).replace(/\.json$/, "");

      it("forgives the issues at the paths an entry names, and records the new contract", async () => {
        const label = await recordedLabel();
        const shown = await judge(
          { "patterns/demo/a.tsx": patternModule(WITHOUT_TITLE) },
          {
            update: true,
            acceptedBreaks: [accepted(label, ["result.title"])],
          },
        );

        expect(shown.err).toBeUndefined();
        expect(shown.code).toBe(0);
        expect(shown.out).toMatch(
          new RegExp(
            `\\nForgave \\d+ issue\\(s\\) over 1 pair\\(s\\) as accepted ` +
              `contract breaks \\(tasks/pattern-compat-accepted-breaks\\.ts\\):` +
              `\\n  demo/a\\.tsx over ${label}: \\d+ issue\\(s\\)`,
          ),
        );
        expect(shown.out).toContain("\nRecorded 1 contract(s):");
      });

      it("leaves an issue at a path the entry does not name standing, and reports the unused path", async () => {
        const label = await recordedLabel();
        const shown = await judge({
          "patterns/demo/a.tsx": patternModule(WITHOUT_TITLE),
        }, { acceptedBreaks: [accepted(label, ["result.unrelated"])] });

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(`cannot be applied over baseline ${label}`);
        expect(shown.err).toContain(
          "names 1 path(s) that none of its pairs blames: result.unrelated.",
        );
      });

      it("fails an entry whose pair applies cleanly", async () => {
        const label = await recordedLabel();
        const shown = await judge(
          { "patterns/demo/a.tsx": patternModule(WITH_TITLE) },
          { acceptedBreaks: [accepted(label, ["result.title"])] },
        );

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(
          "\n1 accepted contract break(s) in " +
            "tasks/pattern-compat-accepted-breaks.ts forgive nothing: ",
        );
        expect(shown.err).toContain(label);
      });

      it("fails an entry naming a pattern that no longer exists, and that pattern's record", async () => {
        const sink: RecordSink = { records: [] };
        const shown = await judge(
          { "patterns/demo/a.tsx": patternModule(WITH_TITLE) },
          {
            update: true,
            acceptedBreaks: [accepted("v1", ["result"], "demo/gone.tsx")],
          },
          sink,
        );

        expect(shown.code).toBe(1);
        expect(shown.err).toContain(
          "\n1 accepted contract break(s) in " +
            "tasks/pattern-compat-accepted-breaks.ts name a pattern that no " +
            "longer exists: demo/gone.tsx.",
        );
        expect(sink.records).toEqual([
          ["pattern-compat demo/a.tsx", "pass"],
          ["pattern-compat demo/gone.tsx", "fail"],
        ]);
      });
    });

    it("says a counted line naming each pattern, in key order, as its judging starts", async () => {
      await record("demo/gone.tsx", WITH_TITLE);
      const events: string[] = [];
      const modules: Record<string, unknown> = {
        "patterns/demo/b.tsx": patternModule(WITH_TITLE),
        "patterns/demo/a.tsx": {},
      };
      await judge(modules, {
        evaluate: (file) => {
          events.push(`evaluate ${file}`);
          return Promise.resolve(modules[file]);
        },
        say: (line) => events.push(line),
        records: {
          append: (record) => {
            if (record.line === "record") events.push(record.test.n);
          },
        },
      });

      expect(events).toEqual([
        "Checking update compatibility for 3 patterns.",
        "[1/3] demo/a.tsx",
        "evaluate patterns/demo/a.tsx",
        "pattern-compat demo/a.tsx",
        "[2/3] demo/b.tsx",
        "evaluate patterns/demo/b.tsx",
        "pattern-compat demo/b.tsx",
        "[3/3] demo/gone.tsx",
        "pattern-compat demo/gone.tsx",
      ]);
    });

    describe("options", () => {
      it("judges only the patterns `--only` selects", async () => {
        const shown = await judge({
          "patterns/demo/a.tsx": {},
          "patterns/other/b.tsx": {},
        }, { only: ["demo/"] });

        expect(shown.said).toEqual([
          "Checking update compatibility for 1 patterns.",
          "[1/1] demo/a.tsx",
        ]);
        expect(shown.out).toContain("Skipped 1 file(s)");
      });

      it("reports the slowest compiles and the slow checks only when timing is asked for", async () => {
        const modules = { "patterns/demo/a.tsx": {} };

        const timed = await judge(modules, { slowCheckMs: -1 });
        expect(timed.said.join("\n")).toMatch(
          /\nSlowest compiles:\n {2}\d+ms {2}demo\/a\.tsx/,
        );
        expect(timed.said.join("\n")).toMatch(
          /\n {2}check \d+ms {2}demo\/a\.tsx/,
        );

        const untimed = await judge(modules);
        expect(untimed.said).toEqual([
          "Checking update compatibility for 1 patterns.",
          "[1/1] demo/a.tsx",
        ]);
      });

      it("reports no check faster than the threshold", async () => {
        const timed = await judge(
          { "patterns/demo/a.tsx": {} },
          { slowCheckMs: Number.MAX_SAFE_INTEGER },
        );

        expect(timed.said).toContain("\nSlowest compiles:");
        expect(timed.said.join("\n")).not.toContain("check ");
      });
    });
  });

  describe("runPatternCompat()", () => {
    it("returns exit code 2 for an argument it does not know", async () => {
      const shown = await runPatternCompat(["--frobnicate"]);

      expect(shown).toEqual({
        err: "Unknown argument: --frobnicate",
        code: 2,
      });
    });

    it("fails before judging any pattern when a system pattern URL maps to no pattern", async () => {
      const shown = await runPatternCompat([], {
        systemPatternUrls: ["https://example.com/not-a-pattern.tsx"],
      });

      expect(shown.code).toBe(1);
      expect(shown.err).toContain("https://example.com/not-a-pattern.tsx");
      expect(shown.out).toBeUndefined();
    });

    // The whole gate, over one pattern of this checkout and its baselines.

    const counter = ["--only", "examples/counter/main.tsx"];

    it("compiles a real pattern and proves it against its recorded baselines, writing no record unasked", async () => {
      const said: string[] = [];
      let shown: CommandOutput | undefined;
      const spooled = await recordsSpooledBy(async () => {
        shown = await runPatternCompat(counter, {
          say: (line) => said.push(line),
        });
      });

      expect(shown?.err).toBeUndefined();
      expect(shown?.code).toBe(0);
      expect(said).toEqual([
        "Checking update compatibility for 1 patterns.",
        "[1/1] examples/counter/main.tsx",
      ]);
      expect(shown?.out).toContain(
        "\n1 pattern(s) can be updated from every recorded contract.",
      );
      expect(spooled).toEqual([]);
    });

    it("writes one gate record per judged pattern when asked", async () => {
      const spooled = await recordsSpooledBy(() =>
        runPatternCompat(counter, { recordResults: true, say: () => {} })
      );

      expect(spooled.map((record) => [record.test.n, record.outcome]))
        .toEqual([["pattern-compat examples/counter/main.tsx", "pass"]]);
    });
  });
});
