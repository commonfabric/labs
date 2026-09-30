import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  classifyPatternSource,
  describeError,
  emptyTotals,
  familyIdOf,
  foldTotals,
  importedPatternIdsOf,
  main,
  measureArtifactRoot,
  type MeasurementTotals,
  measureRun,
  measureTranscript,
  mergeTotals,
  renderReportLines,
  renderRunLines,
  renderToolSurfaceLines,
  renderTotalsLines,
  runFamiliesOf,
  type RunFamilyMeasurement,
  type RunMeasurement,
  toolOutcomeOf,
  totalsOf,
} from "../scripts/measure-runs.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";

const FIXTURE_ROOT = fromFileUrl(
  new URL("./support/measure-runs/runs", import.meta.url),
);

const measureFixture = async (
  runId: string,
  role: RunMeasurement["role"] = "parent",
): Promise<RunMeasurement> =>
  measureTranscript(
    runId,
    role,
    JSON.parse(
      await Deno.readTextFile(`${FIXTURE_ROOT}/${runId}/transcript.json`),
    ) as readonly HarnessTranscriptMessage[],
  );

const familyNamed = (
  families: readonly RunFamilyMeasurement[],
  familyId: string,
): RunFamilyMeasurement => {
  const family = families.find((entry) => entry.familyId === familyId);
  if (family === undefined) {
    throw new Error(`the report holds no family named ${familyId}`);
  }
  return family;
};

describe("measure-runs", () => {
  it("reports malformed saved source instead of measuring the transcript preview", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/root/tool-outputs`, { recursive: true });
      await Deno.writeTextFile(
        `${root}/root/transcript.json`,
        JSON.stringify([
          {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "compile",
              type: "function",
              function: {
                name: "run_pattern",
                arguments: JSON.stringify({ sourceText: "export default 1;" }),
              },
            }],
          },
          {
            role: "tool",
            toolName: "run_pattern",
            toolCallId: "compile",
            content: JSON.stringify({ outputId: "source-1", status: "ok" }),
          },
        ]),
      );
      await Deno.writeTextFile(
        `${root}/root/tool-outputs/unidentified-run-pattern-source.json`,
        JSON.stringify({ sourceText: "export default 2;" }),
      );
      await Deno.writeTextFile(
        `${root}/root/tool-outputs/malformed-run-pattern-source.json`,
        JSON.stringify({ outputId: "source-1", sourceText: 2 }),
      );
      const measured = await measureRun(root, "root", "parent");
      expect(measured.runPatterns[0].target).toEqual({
        kind: "unread",
        reason: "the source artifact for source-1 is malformed",
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reports unread research when the report belongs to another run or is a directory", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/root`);
      await Deno.writeTextFile(`${root}/root/transcript.json`, "[]");
      await Deno.writeTextFile(
        `${root}/root/run-report.json`,
        JSON.stringify({ runId: "other", toolActivity: [] }),
      );
      const mismatched = await measureRun(root, "root", "parent");
      expect(mismatched.research).toEqual({
        kind: "unread",
        reason:
          "run-report.json has no matching run identity and activity list",
      });
      expect(renderRunLines(mismatched)).toContain(
        "  [parent] research NOT READ (run-report.json has no matching run identity and activity list)",
      );
      await Deno.remove(`${root}/root/run-report.json`);
      await Deno.mkdir(`${root}/root/run-report.json`);
      const unread = await measureRun(root, "root", "parent");
      expect(unread.research).toMatchObject({
        kind: "unread",
        reason: expect.stringContaining("directory"),
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("returns unread research for malformed activity rows", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/root`);
      await Deno.writeTextFile(`${root}/root/transcript.json`, "[]");
      const measurements: RunMeasurement[] = [];
      for (
        const row of [
          null,
          {},
          { toolId: "research", toolCallId: "research-call" },
          {
            toolId: "research",
            toolCallId: "research-call",
            startedAt: "2026-09-15T00:00:00.000Z",
            endedAt: "2026-09-15T00:00:01.000Z",
            resultRef: {
              outputId: "research-output",
              artifactPath: 1,
            },
          },
        ]
      ) {
        await Deno.writeTextFile(
          `${root}/root/run-report.json`,
          JSON.stringify({ runId: "root", toolActivity: [row] }),
        );
        measurements.push(await measureRun(root, "root", "parent"));
      }

      expect(measurements.map((measurement) => measurement.research)).toEqual([
        {
          kind: "unread",
          reason: "`run-report.json` has malformed `.toolActivity[0]`",
        },
        {
          kind: "unread",
          reason: "`run-report.json` has malformed `.toolActivity[0]`",
        },
        {
          kind: "unread",
          reason: "`run-report.json` has malformed `.toolActivity[0]`",
        },
        {
          kind: "unread",
          reason: "`run-report.json` has malformed `.toolActivity[0]`",
        },
      ]);
      expect(measurements.map((measurement) => renderRunLines(measurement)))
        .toEqual([
          [
            "  [parent] research NOT READ (`run-report.json` has malformed `.toolActivity[0]`)",
          ],
          [
            "  [parent] research NOT READ (`run-report.json` has malformed `.toolActivity[0]`)",
          ],
          [
            "  [parent] research NOT READ (`run-report.json` has malformed `.toolActivity[0]`)",
          ],
          [
            "  [parent] research NOT READ (`run-report.json` has malformed `.toolActivity[0]`)",
          ],
        ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("distinguishes a missing activity list, unrelated activity, and a research call without a result reference", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/root`);
      await Deno.writeTextFile(`${root}/root/transcript.json`, "[]");
      await Deno.writeTextFile(
        `${root}/root/run-report.json`,
        JSON.stringify({ runId: "root" }),
      );
      const missing = await measureRun(root, "root", "parent");
      await Deno.writeTextFile(
        `${root}/root/run-report.json`,
        JSON.stringify({
          runId: "root",
          toolActivity: [{ toolId: "bash" }],
        }),
      );
      const unrelated = await measureRun(root, "root", "parent");
      await Deno.writeTextFile(
        `${root}/root/run-report.json`,
        JSON.stringify({
          runId: "root",
          toolActivity: [{
            toolId: "research",
            toolCallId: "research-call",
            startedAt: "2026-09-15T00:00:00.000Z",
            endedAt: "2026-09-15T00:00:01.000Z",
          }],
        }),
      );
      const withoutResult = await measureRun(root, "root", "parent");

      expect(missing.research).toEqual({
        kind: "unread",
        reason: "`run-report.json` has no activity list",
      });
      expect(unrelated).not.toHaveProperty("research");
      expect(withoutResult.research).toEqual({
        kind: "read",
        value: [{
          outputId: "research-call",
          origin: "model",
          wallMs: 1_000,
          work: {
            kind: "unread",
            reason: "research has no output artifact",
          },
        }],
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("preserves a research activity whose output artifact is missing", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/root`);
      await Deno.writeTextFile(`${root}/root/transcript.json`, "[]");
      await Deno.writeTextFile(
        `${root}/root/run-report.json`,
        JSON.stringify({
          runId: "root",
          toolActivity: [{
            toolId: "research",
            toolCallId: "opening",
            origin: "opening-research",
            startedAt: "2026-09-15T00:00:00.000Z",
            endedAt: "2026-09-15T00:00:01.000Z",
            resultRef: {
              outputId: "root:research:1",
              artifactPath: "/original/tool-outputs/missing.json",
            },
          }],
        }),
      );
      const measured = await measureRun(root, "root", "parent");
      expect(measured.toolOutcomes.research).toEqual({ unread: 1 });
      expect(measured.research).toEqual({
        kind: "read",
        value: [{
          outputId: "root:research:1",
          origin: "opening-research",
          wallMs: 1000,
          work: {
            kind: "unread",
            reason: expect.stringContaining("missing.json could not be read:"),
          },
        }],
      });
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("throws when the source artifact directory is a file", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/root`);
      await Deno.writeTextFile(`${root}/root/transcript.json`, "[]");
      await Deno.writeTextFile(`${root}/root/tool-outputs`, "not a directory");
      await expect(measureRun(root, "root", "parent")).rejects.toThrow(
        Deno.errors.NotADirectory,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reads saved composition drafts and counts host research once with its private work", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/root/tool-outputs`, { recursive: true });
      const source =
        'import P from "cf:pattern:part"; export default () => P({ items: [] });';
      const transcript: HarnessTranscriptMessage[] = [
        {
          role: "user",
          content: "Host opening research",
          toolResultProvenance: {
            type: "cf-harness.tool-result-provenance",
            toolCallId: "opening",
            toolId: "research",
            outputId: createToolOutputId("root", "research", 1),
          },
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "compile",
            type: "function",
            function: {
              name: "run_pattern",
              arguments: JSON.stringify({
                sourceText:
                  "[cf-harness: superseded run_pattern source collapsed for model context]",
              }),
            },
          }],
        },
        {
          role: "tool",
          toolName: "run_pattern",
          toolCallId: "compile",
          content: JSON.stringify({
            outputId: "root:run_pattern:2",
            status: "ok",
          }),
        },
      ];
      await Deno.writeTextFile(
        `${root}/root/transcript.json`,
        JSON.stringify(transcript),
      );
      await Deno.writeTextFile(
        `${root}/root/tool-outputs/draft-run-pattern-source.json`,
        JSON.stringify({
          type: "cf-harness.run-pattern-source",
          outputId: "root:run_pattern:2",
          sourceText: source,
        }),
      );
      await Deno.writeTextFile(
        `${root}/root/tool-outputs/research.json`,
        JSON.stringify({
          status: "ok",
          outputId: "root:research:1",
          researchRecord: {
            researchRunId: "root:research:1",
            budgets: { modelTurns: 5, toolCalls: 18, readChars: 30610 },
            sourceReads: [{ sourceId: "one" }, { sourceId: "two" }],
          },
        }),
      );
      await Deno.writeTextFile(
        `${root}/root/run-report.json`,
        JSON.stringify({
          runId: "root",
          toolActivity: [{
            toolId: "research",
            toolCallId: "opening",
            origin: "opening-research",
            startedAt: "2026-09-14T21:07:17.372Z",
            endedAt: "2026-09-14T21:08:21.161Z",
            resultRef: {
              outputId: "root:research:1",
              artifactPath: "/original-location/tool-outputs/research.json",
            },
          }],
        }),
      );
      const measured = await measureRun(root, "root", "parent");
      expect(measured.runPatterns[0].target).toEqual({
        kind: "read",
        value: {
          kind: "source",
          sourceBytes: new TextEncoder().encode(source).length,
          importedPatternIds: ["part"],
          composition: "composition",
        },
      });
      expect(measured.toolOutcomes.research).toEqual({ ok: 1 });
      expect(measured.research).toEqual({
        kind: "read",
        value: [{
          outputId: "root:research:1",
          origin: "opening-research",
          wallMs: 63789,
          work: {
            kind: "read",
            value: {
              modelTurns: 5,
              toolCalls: 18,
              readChars: 30610,
              sourceReads: 2,
            },
          },
        }],
      });
      expect(renderRunLines(measured).join("\n")).toContain(
        "5 turns, 18 private calls, 2 reads, 30610 characters",
      );
      await Deno.writeTextFile(
        `${root}/root/tool-outputs/draft-run-pattern-source.json`,
        "{",
      );
      await Deno.writeTextFile(
        `${root}/root/tool-outputs/research.json`,
        JSON.stringify({ outputId: "another-run", status: "ok" }),
      );
      const unread = await measureRun(root, "root", "parent");
      expect(unread.runPatterns[0].target.kind).toBe("unread");
      expect(unread.toolOutcomes.research).toEqual({ unread: 1 });
      expect(
        unread.research?.kind === "read" && unread.research.value[0].work.kind,
      ).toBe("unread");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("does not count inherited research summaries as child work", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/child`);
      await Deno.writeTextFile(
        `${root}/child/transcript.json`,
        JSON.stringify([{ role: "user", content: "Inherited kit" }]),
      );
      await Deno.writeTextFile(
        `${root}/child/run-state.json`,
        JSON.stringify({
          researchRuns: [{ researchRunId: "parent:research:1" }],
        }),
      );
      await Deno.writeTextFile(
        `${root}/child/run-report.json`,
        JSON.stringify({ runId: "child", toolActivity: [] }),
      );
      const measured = await measureRun(root, "child", "subagent");
      expect(measured.research).toBeUndefined();
      expect(measured.toolOutcomes).toEqual({});
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  describe("importedPatternIdsOf()", () => {
    it("returns each `cf:pattern:` specifier once, sorted", () => {
      expect(
        importedPatternIdsOf(
          'import A from "cf:pattern:beta";\n' +
            'import B from "cf:pattern:alpha";\n' +
            'import C from "cf:pattern:beta";\n',
        ),
      ).toEqual(["alpha", "beta"]);
    });

    it("returns the specifier of a bare import, which binds nothing and has no `from`", () => {
      expect(importedPatternIdsOf('import "cf:pattern:sideEffect";'))
        .toEqual(["sideEffect"]);
    });

    it("returns an empty list for source importing no published pattern", () => {
      expect(importedPatternIdsOf('import { cell } from "commontools";'))
        .toEqual([]);
    });
  });

  describe("classifyPatternSource()", () => {
    it("returns `re-export` for source that imports a published pattern and exports it unchanged", () => {
      expect(classifyPatternSource(
        'import PackingList from "cf:pattern:abc";\nexport default PackingList;\n',
      )).toBe("re-export");
    });

    it("returns `re-export` for source that re-exports the default through `export … from`", () => {
      expect(classifyPatternSource('export { default } from "cf:pattern:abc";'))
        .toBe("re-export");
    });

    it("returns `re-export` past a comment, which composes nothing", () => {
      expect(classifyPatternSource(
        '// the packing list, already published\nimport P from "cf:pattern:abc";\nexport default P;\n',
      )).toBe("re-export");
    });

    it("returns `composition` for source that puts an imported pattern in a body of its own", () => {
      expect(classifyPatternSource(
        'import Rating from "cf:pattern:abc";\nexport default () => ({ rating: Rating });\n',
      )).toBe("composition");
    });

    it("returns `composition` for source that re-exports one pattern and uses another", () => {
      expect(classifyPatternSource(
        'import A from "cf:pattern:abc";\nimport B from "cf:pattern:def";\nexport default () => ({ a: A, b: B });\n',
      )).toBe("composition");
    });

    it("returns `bare-import` for source whose only pattern reference binds nothing", () => {
      // A bare import references a published pattern and cannot put it to
      // work, so counting it as composition would inflate the one figure the
      // composing/re-export split exists to isolate.
      expect(classifyPatternSource(
        'import "cf:pattern:abc";\nexport default () => ({ n: 1 });\n',
      )).toBe("bare-import");
    });

    it("returns `composition` for source that bare-imports one pattern and uses another", () => {
      expect(classifyPatternSource(
        'import "cf:pattern:abc";\nimport R from "cf:pattern:def";\nexport default () => ({ r: R });\n',
      )).toBe("composition");
    });

    it("returns `no-imports` for source importing no published pattern", () => {
      expect(classifyPatternSource(
        'import { cell } from "commontools";\nexport default () => ({ n: cell(0) });\n',
      )).toBe("no-imports");
    });

    it("returns `composition` for a re-export of a module that is not a published pattern", () => {
      expect(classifyPatternSource(
        'import Rating from "cf:pattern:abc";\nimport Local from "./local.ts";\nexport default Local;\n',
      )).toBe("composition");
    });
  });

  describe("describeError()", () => {
    it("returns an `Error`'s message", () => {
      expect(describeError(new Error("fetch failed"))).toBe("fetch failed");
    });

    it("returns the string form of a thrown value that is not an `Error`", () => {
      // A rejected fetch is not the only way into a catch here, and a thrown
      // string would otherwise render as the word "undefined".
      expect(describeError("the socket went away")).toBe(
        "the socket went away",
      );
      expect(describeError(undefined)).toBe("undefined");
    });
  });

  describe("familyIdOf()", () => {
    it("returns the run's own id for a parent run", () => {
      expect(familyIdOf("fixture-run")).toBe("fixture-run");
    });

    it("returns the parent's id for a `delegate_task` child", () => {
      expect(familyIdOf("fixture-run.subagent.12")).toBe("fixture-run");
    });
  });

  describe("runFamiliesOf()", () => {
    it("groups each child under its parent, parent first", () => {
      expect([
        ...runFamiliesOf([
          "b.subagent.2",
          "a",
          "b",
          "a.subagent.1",
          "b.subagent.1",
        ]),
      ]).toEqual([
        ["a", ["a", "a.subagent.1"]],
        ["b", ["b", "b.subagent.1", "b.subagent.2"]],
      ]);
    });

    it("groups a child whose parent directory is absent under the parent's id", () => {
      expect([...runFamiliesOf(["orphan.subagent.1"])]).toEqual([
        ["orphan", ["orphan.subagent.1"]],
      ]);
    });
  });

  describe("measureTranscript()", () => {
    it("pairs a call to its result by tool call id rather than by position", async () => {
      const run = await measureFixture("fixture-run");
      // The fixture records these two results in the opposite order from the
      // calls. Positional pairing would report the composed source as the
      // compile error and the plain source as the run that worked.
      const [plain, composed] = run.runPatterns.filter((call) =>
        call.target.kind === "read" && call.target.value.kind === "source"
      );
      expect(plain.outcome).toEqual({
        kind: "read",
        value: { status: "compile-error" },
      });
      expect(composed.outcome).toEqual({
        kind: "read",
        value: { status: "ok" },
      });
    });

    it("reads a search's query and the number of hits the index answered with", async () => {
      const run = await measureFixture("fixture-run");
      expect(run.searches[0].query).toEqual({
        kind: "read",
        value: { tags: ["reading"], text: "reading list" },
      });
      expect(run.searches[0].answer).toEqual({
        kind: "read",
        value: { status: "ok", hits: 2 },
      });
    });

    it("reads a search that found nothing as zero hits", async () => {
      const run = await measureFixture("fixture-run");
      expect(run.searches[1].query).toEqual({
        kind: "read",
        value: { tags: [], text: "nothing at all" },
      });
      expect(run.searches[1].answer).toEqual({
        kind: "read",
        value: { status: "ok", hits: 0 },
      });
    });

    it("records a search the index refused as refused rather than as a search that found nothing", async () => {
      const run = await measureFixture("fixture-run");
      expect(run.searches[2].answer).toEqual({
        kind: "read",
        value: {
          status: "error",
          message:
            "pattern index searchPatterns failed (403): DID is not allowlisted",
        },
      });
    });

    it("records a search whose result the run never wrote as unread", async () => {
      const run = await measureFixture("fixture-run");
      expect(run.searches[3].answer).toEqual({
        kind: "unread",
        reason: "the run recorded no result for this call",
      });
    });

    it("splits `run_pattern` calls by whether they named a published pattern", async () => {
      const run = await measureFixture("fixture-run");
      expect(
        run.runPatterns.map((call) =>
          call.target.kind === "read" ? call.target.value.kind : "unread"
        ),
      ).toEqual(["pattern-id", "source", "source"]);
      const named = run.runPatterns[0].target;
      expect(
        named.kind === "read" && named.value.kind === "pattern-id"
          ? named.value.patternId
          : undefined,
      ).toBe("pub-reading-shelf");
    });

    it("reads the patterns a `run_pattern` source composed", async () => {
      const run = await measureFixture("fixture-run");
      const composed = run.runPatterns[2].target;
      expect(
        composed.kind === "read" && composed.value.kind === "source"
          ? composed.value.importedPatternIds
          : undefined,
      ).toEqual(["pub-rating", "pub-reading-shelf"]);
    });

    it("reads each delegation's profile and each slug assigned", async () => {
      const run = await measureFixture("fixture-run");
      expect(run.delegations).toEqual([
        { profile: { kind: "read", value: "pattern-author" } },
      ]);
      expect(run.slugs).toEqual([
        {
          slug: { kind: "read", value: "reading-list" },
          outcome: { kind: "read", value: { status: "ok" } },
        },
      ]);
    });

    it("returns no calls for a transcript that made none", () => {
      const run = measureTranscript("empty", "parent", [
        { role: "user", content: "hello" },
      ]);
      expect(run.searches).toEqual([]);
      expect(run.runPatterns).toEqual([]);
      expect(run.transcript).toEqual({ kind: "read", value: { messages: 1 } });
    });

    it("records a search whose arguments are not JSON as an unread query", () => {
      const run = measureTranscript("bad-args", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "q1",
            type: "function",
            function: { name: "search_patterns", arguments: "{oops" },
          }],
        },
      ]);
      expect(run.searches[0].query.kind).toBe("unread");
      expect(renderRunLines(run)[0]).toContain("search (unread:");
    });

    it("records a search reporting `ok` with no results as unread rather than as no hits", () => {
      const run = measureTranscript("no-results", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "q1",
            type: "function",
            function: { name: "search_patterns", arguments: "{}" },
          }],
        },
        {
          role: "tool",
          toolCallId: "q1",
          toolName: "search_patterns",
          content: JSON.stringify({ status: "ok" }),
        },
      ]);
      expect(run.searches[0].answer).toEqual({
        kind: "unread",
        reason: "a search reported `ok` and carried no results array",
      });
      expect(totalsOf(run).searchesUnread).toBe(1);
      expect(totalsOf(run).searchesEmpty).toBe(0);
    });

    it("records a search reporting a status this reader does not know as unread", () => {
      const run = measureTranscript("odd-status", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "q1",
            type: "function",
            function: { name: "search_patterns", arguments: "{}" },
          }],
        },
        {
          role: "tool",
          toolCallId: "q1",
          toolName: "search_patterns",
          content: JSON.stringify({ status: "throttled" }),
        },
      ]);
      expect(run.searches[0].answer.kind).toBe("unread");
      expect(
        run.searches[0].answer.kind === "unread"
          ? run.searches[0].answer.reason
          : "",
      ).toContain("throttled");
    });

    it("skips a transcript entry that is not a message rather than failing the whole report", () => {
      const run = measureTranscript("ragged", "parent", [
        null as unknown as HarnessTranscriptMessage,
        { role: "user", content: "hello" },
      ]);
      expect(run.transcript).toEqual({ kind: "read", value: { messages: 1 } });
    });

    it("records a call whose arguments are not JSON as unread rather than as a call carrying source", () => {
      const run = measureTranscript("malformed", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "x1",
            type: "function",
            function: { name: "run_pattern", arguments: "{not json" },
          }],
        },
      ]);
      expect(run.runPatterns[0].target.kind).toBe("unread");
      expect(totalsOf(run).runPatternsUnreadTarget).toBe(1);
      expect(totalsOf(run).runPatternsFromSource).toBe(0);
    });
  });

  describe("toolOutcomeOf()", () => {
    it("returns `denied` for a result the sandbox refused to let the run observe", () => {
      expect(toolOutcomeOf({
        kind: "read",
        value: {
          type: "cf-harness.observation-denied",
          reason: "not-observable",
        },
      })).toBe("denied");
    });

    it("returns `denied` for a result carrying a reason and no status", () => {
      expect(toolOutcomeOf({ kind: "read", value: { reason: "not-allowed" } }))
        .toBe("denied");
    });

    it("returns `error` for a tool that ran and failed", () => {
      expect(toolOutcomeOf({
        kind: "read",
        value: { ok: false, error: { message: "read_file failed" } },
      })).toBe("error");
    });

    it("returns `error` for a status the tool did not report as `ok`", () => {
      expect(
        toolOutcomeOf({ kind: "read", value: { status: "compile-error" } }),
      )
        .toBe("error");
    });

    it("returns `ok` for a status the tool reported as `ok`", () => {
      expect(toolOutcomeOf({ kind: "read", value: { status: "ok" } }))
        .toBe("ok");
    });

    it("returns `ok` for a result that reported neither a status nor a failure", () => {
      expect(toolOutcomeOf({ kind: "read", value: {} })).toBe("ok");
    });

    it("returns `unread` for the result the harness synthesizes when a run was interrupted", () => {
      // It carries a `reason` and no `status`, which is the shape of a denial.
      // Counted as denied it would report the surface WITHHELD — a claim about
      // what was allowed, from evidence about what was interrupted.
      expect(toolOutcomeOf({
        kind: "read",
        value: {
          type: "cf-harness.tool-outcome-unknown",
          outcome: "unknown",
          reason: "process_interrupted",
        },
      })).toBe("unread");
    });

    it("returns `unread` for a call the run recorded no result for", () => {
      expect(toolOutcomeOf({ kind: "unread", reason: "no result" }))
        .toBe("unread");
    });
  });

  describe("renderToolSurfaceLines()", () => {
    it("marks a surface whose every call was denied as withheld", () => {
      expect(renderToolSurfaceLines({ bash: { denied: 38 } })).toEqual([
        "  tool surfaces:",
        "    bash: denied=38 — WITHHELD: every call denied",
      ]);
    });

    it("marks a surface that ran and never succeeded apart from one that was withheld", () => {
      expect(renderToolSurfaceLines({ read_file: { denied: 5, error: 13 } }))
        .toEqual([
          "  tool surfaces:",
          "    read_file: denied=5 error=13 — never once succeeded",
        ]);
    });

    it("marks nothing for a surface that answered at least once", () => {
      expect(renderToolSurfaceLines({ run_pattern: { error: 218, ok: 41 } }))
        .toEqual([
          "  tool surfaces:",
          "    run_pattern: error=218 ok=41",
        ]);
    });

    it("returns one line for a run that called no tool", () => {
      expect(renderToolSurfaceLines({})).toEqual([
        "  tool surfaces: none called",
      ]);
    });
  });

  describe("totalsOf()", () => {
    it("partitions every search into exactly one outcome", async () => {
      const totals = totalsOf(await measureFixture("fixture-run"));
      expect(totals.searches).toBe(4);
      expect(
        totals.searchesWithHits + totals.searchesEmpty +
          totals.searchesRefused + totals.searchesUnread,
      ).toBe(totals.searches);
      expect(totals.searchesWithHits).toBe(1);
      expect(totals.searchesEmpty).toBe(1);
      expect(totals.searchesRefused).toBe(1);
      expect(totals.searchesUnread).toBe(1);
    });

    it("partitions every `run_pattern` call into exactly one target kind", async () => {
      const totals = totalsOf(await measureFixture("fixture-run"));
      expect(
        totals.runPatternsByPatternId + totals.runPatternsFromSource +
          totals.runPatternsUnreadTarget,
      ).toBe(totals.runPatterns);
      expect(totals.runPatternsByPatternId).toBe(1);
      expect(totals.runPatternsFromSource).toBe(2);
      expect(totals.runPatternsImportingPatterns).toBe(1);
      expect(totals.runPatternsComposing).toBe(1);
      expect(totals.runPatternsReexporting).toBe(0);
      expect(totals.runPatternsBareImporting).toBe(0);
      // The three partition the calls that import a published pattern.
      expect(
        totals.runPatternsComposing + totals.runPatternsReexporting +
          totals.runPatternsBareImporting,
      ).toBe(totals.runPatternsImportingPatterns);
    });

    it("counts a bare import apart from both a composition and a re-export", () => {
      const run = measureTranscript("bare", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "r1",
            type: "function",
            function: {
              name: "run_pattern",
              arguments: JSON.stringify({
                sourceText:
                  'import "cf:pattern:pub-rating";\nexport default () => ({});\n',
              }),
            },
          }],
        },
        {
          role: "tool",
          toolCallId: "r1",
          toolName: "run_pattern",
          content: JSON.stringify({ status: "ok" }),
        },
      ]);
      const totals = totalsOf(run);
      expect(totals.runPatternsImportingPatterns).toBe(1);
      expect(totals.runPatternsBareImporting).toBe(1);
      expect(totals.runPatternsComposing).toBe(0);
      expect(totals.runPatternsReexporting).toBe(0);
      // Referenced, and composed by nothing — so it must not appear in the
      // report's account of what composed what.
      expect(totals.importedPatternIds).toEqual(["pub-rating"]);
      expect(totals.composedPatternIds).toEqual([]);
      // The two lines are what stop a reference reading as a composition in
      // the totals block, where only one label used to carry both.
      const lines = renderTotalsLines(totals);
      expect(lines).toContain("  referenced patterns: pub-rating");
      expect(lines).toContain("  composed patterns: none");
      expect(renderRunLines(run)[0]).toContain("bare-imports pub-rating");
    });

    it("counts a bare re-export apart from a composition", async () => {
      const totals = totalsOf(await measureFixture("alias-run"));
      expect(totals.runPatternsImportingPatterns).toBe(1);
      expect(totals.runPatternsReexporting).toBe(1);
      expect(totals.runPatternsComposing).toBe(0);
      expect(totals.composedPatternIds).toEqual([]);
    });

    it("counts `run_pattern` outcomes by the status the tool reported", async () => {
      const totals = totalsOf(await measureFixture("fixture-run"));
      expect(totals.runPatternOutcomes).toEqual({
        "ok": 2,
        "compile-error": 1,
      });
    });

    it("counts a delegation whose profile the call omitted, and a slug whose result the run never wrote", () => {
      const run = measureTranscript("ragged-calls", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "d1",
              type: "function",
              function: { name: "delegate_task", arguments: "{}" },
            },
            {
              id: "s1",
              type: "function",
              function: {
                name: "assign_slug",
                arguments: JSON.stringify({ slug: "orphan" }),
              },
            },
            {
              id: "r1",
              type: "function",
              function: { name: "run_pattern", arguments: "{}" },
            },
          ],
        },
      ]);
      const totals = totalsOf(run);
      expect(totals.delegationProfilesUnread).toBe(1);
      expect(totals.slugsUnread).toBe(1);
      expect(totals.slugsAssigned).toBe(0);
      expect(totals.runPatternsUnreadTarget).toBe(1);
      expect(run.runPatterns[0].target).toEqual({
        kind: "unread",
        reason: "a run_pattern call named neither patternId nor sourceText",
      });
    });

    it("records a delegation whose arguments are not JSON as an unread profile", () => {
      const run = measureTranscript("bad-delegate", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "d1",
            type: "function",
            function: { name: "delegate_task", arguments: "{nope" },
          }],
        },
      ]);
      expect(run.delegations[0].profile.kind).toBe("unread");
      expect(totalsOf(run).delegationProfilesUnread).toBe(1);
    });

    it("reports a search the index refused without a message as carrying none", () => {
      const run = measureTranscript("no-message", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "q1",
            type: "function",
            function: { name: "search_patterns", arguments: "{}" },
          }],
        },
        {
          role: "tool",
          toolCallId: "q1",
          toolName: "search_patterns",
          content: JSON.stringify({ status: "error" }),
        },
      ]);
      expect(run.searches[0].answer).toEqual({
        kind: "read",
        value: { status: "error", message: "(no message)" },
      });
    });

    it("skips a tool message whose call id is not a string rather than indexing by it", () => {
      const run = measureTranscript("odd-id", "parent", [
        {
          role: "tool",
          toolCallId: 7 as unknown as string,
          toolName: "search_patterns",
          content: "{}",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "q1",
            type: "function",
            function: { name: "search_patterns", arguments: "{}" },
          }],
        },
      ]);
      expect(run.searches[0].answer).toEqual({
        kind: "unread",
        reason: "the run recorded no result for this call",
      });
    });

    it("counts a slug the tool refused as requested rather than as assigned", () => {
      const run = measureTranscript("refused-slug", "parent", [
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "s1",
            type: "function",
            function: {
              name: "assign_slug",
              arguments: JSON.stringify({ token: "t", slug: "taken" }),
            },
          }],
        },
        {
          role: "tool",
          toolCallId: "s1",
          toolName: "assign_slug",
          content: JSON.stringify({ status: "error", message: "slug in use" }),
        },
      ]);
      const totals = totalsOf(run);
      expect(totals.slugs).toBe(1);
      expect(totals.slugsAssigned).toBe(0);
      expect(totals.slugsRefused).toBe(1);
      expect(totals.slugNames).toEqual([]);
      // The message is what separates a name already taken in this space from
      // a tool that failed, and only one of those is a fact about the run.
      expect(renderRunLines(run)).toContain(
        "  [parent] assign_slug taken -> error (slug in use)",
      );
    });

    it("counts every tool the run called by how each call ended", async () => {
      const totals = totalsOf(await measureFixture("fixture-run"));
      expect(totals.toolOutcomes).toEqual({
        search_patterns: { ok: 2, error: 1, unread: 1 },
        run_pattern: { ok: 2, error: 1 },
        delegate_task: { ok: 1 },
        bash: { denied: 1 },
        read_file: { error: 1 },
        assign_slug: { ok: 1 },
      });
    });

    it("counts a run whose transcript could not be read as a run not read", () => {
      const totals = totalsOf({
        runId: "gone",
        role: "parent",
        transcript: { kind: "unread", reason: "no transcript.json" },
        searches: [],
        runPatterns: [],
        delegations: [],
        slugs: [],
        toolOutcomes: {},
      });
      expect(totals.runs).toBe(1);
      expect(totals.runsUnread).toBe(1);
    });
  });

  describe("mergeTotals()", () => {
    const totalsUnderTest = async (): Promise<readonly MeasurementTotals[]> => [
      totalsOf(await measureFixture("fixture-run")),
      totalsOf(await measureFixture("fixture-run.subagent.1", "subagent")),
      emptyTotals(),
    ];

    it("returns the same totals whichever order the runs are folded in", async () => {
      const [first, second, third] = await totalsUnderTest();
      expect(foldTotals([first, second, third])).toEqual(
        foldTotals([third, second, first]),
      );
      expect(foldTotals([second, first, third])).toEqual(
        foldTotals([first, third, second]),
      );
    });

    it("returns the same totals whichever way the merges associate", async () => {
      const [first, second, third] = await totalsUnderTest();
      expect(mergeTotals(mergeTotals(first, second), third)).toEqual(
        mergeTotals(first, mergeTotals(second, third)),
      );
    });

    it("returns the other operand when merged with empty totals", async () => {
      const [first] = await totalsUnderTest();
      expect(mergeTotals(first, emptyTotals())).toEqual(first);
      expect(mergeTotals(emptyTotals(), first)).toEqual(first);
    });

    it("unions the imported pattern identifiers rather than counting them twice", async () => {
      const [first, second] = await totalsUnderTest();
      expect(mergeTotals(first, second).importedPatternIds).toEqual([
        "pub-rating",
        "pub-reading-shelf",
      ]);
      expect(mergeTotals(first, second).composedPatternIds).toEqual([
        "pub-rating",
        "pub-reading-shelf",
      ]);
    });
  });

  describe("measureArtifactRoot()", () => {
    it("measures every family under the root, a child folded into its parent", async () => {
      const report = await measureArtifactRoot(FIXTURE_ROOT);
      expect(report.families.map((family) => family.familyId)).toEqual([
        "alias-run",
        "bad-transcript",
        "fixture-run",
        "no-transcript",
        "unreadable-transcript",
      ]);
      const family = familyNamed(report.families, "fixture-run");
      expect(family.runs.map((run) => run.role)).toEqual([
        "parent",
        "subagent",
      ]);
      expect(family.totals.searches).toBe(5);
      expect(family.totals.searchesWithHits).toBe(2);
      expect(family.totals.runPatterns).toBe(4);
      expect(family.totals.delegations).toBe(1);
      expect(family.totals.slugNames).toEqual(["reading-list"]);
    });

    it("reports a run directory holding no transcript as a run not read", async () => {
      const report = await measureArtifactRoot(FIXTURE_ROOT, ["no-transcript"]);
      expect(report.families[0].runs[0].transcript).toEqual({
        kind: "unread",
        reason: "the run directory holds no transcript.json",
      });
      expect(report.totals.runsUnread).toBe(1);
    });

    it("reports a transcript that is not a message list as a run not read", async () => {
      const report = await measureArtifactRoot(FIXTURE_ROOT, [
        "bad-transcript",
      ]);
      expect(report.families[0].runs[0].transcript).toEqual({
        kind: "unread",
        reason: "transcript.json is not an array of messages",
      });
    });

    it("reports a transcript that is not JSON at all as its own reading", async () => {
      // Built here rather than committed: a deliberately malformed `.json`
      // fixture is a file `deno fmt` refuses, and excluding it from formatting
      // to keep it would be a worse trade than making it at test time.
      const root = await Deno.makeTempDir();
      try {
        await Deno.mkdir(`${root}/unparsable`);
        await Deno.writeTextFile(
          `${root}/unparsable/transcript.json`,
          "not json at all\n",
        );
        const report = await measureArtifactRoot(root, ["unparsable"]);
        const transcript = report.families[0].runs[0].transcript;
        expect(transcript.kind).toBe("unread");
        expect(transcript.kind === "unread" ? transcript.reason : "").toContain(
          "transcript.json is not JSON",
        );
        expect(
          renderReportLines(report).every((line) => !line.includes("\n")),
        ).toBe(true);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("reports a transcript that could not be read for a reason other than absence as its own reading", async () => {
      const report = await measureArtifactRoot(FIXTURE_ROOT, [
        "unreadable-transcript",
      ]);
      const transcript = report.families[0].runs[0].transcript;
      expect(transcript.kind).toBe("unread");
      // Not the "holds no transcript.json" reading: a run that wrote nothing
      // and a file this reader could not open are different facts.
      expect(transcript.kind === "unread" ? transcript.reason : "").toContain(
        "transcript.json could not be read",
      );
    });

    it("reports a named family with no directory as a run not read", async () => {
      const report = await measureArtifactRoot(FIXTURE_ROOT, ["never-ran"]);
      expect(report.families[0].runs[0].transcript).toEqual({
        kind: "unread",
        reason: "no run directory of this name is under the artifact root",
      });
      expect(report.totals.runsUnread).toBe(1);
    });

    it("counts the runs it did read alongside the ones it did not", async () => {
      const report = await measureArtifactRoot(FIXTURE_ROOT);
      expect(report.totals.runs).toBe(6);
      expect(report.totals.runsUnread).toBe(3);
    });
  });

  describe("main()", () => {
    const runMain = async (
      args: readonly string[],
    ): Promise<{ code: number; out: string }> => {
      const logs: string[] = [];
      const code = await main(args, (line) => logs.push(line));
      return { code, out: logs.join("\n") };
    };

    it("returns 0 and reports every family under the root it is given", async () => {
      const { code, out } = await runMain([`--artifact-root=${FIXTURE_ROOT}`]);
      expect(code).toBe(0);
      expect(out).toContain(`artifact root: ${FIXTURE_ROOT}`);
      expect(out).toContain("===== RUN fixture-run (2 runs)");
      expect(out).toContain("===== ALL 5 FAMILIES");
    });

    it("reports only the families it is named", async () => {
      const { out } = await runMain([
        `--artifact-root=${FIXTURE_ROOT}`,
        "alias-run",
      ]);
      expect(out).toContain("===== RUN alias-run");
      expect(out).not.toContain("===== RUN fixture-run");
      expect(out).toContain("===== ALL 1 FAMILIES");
    });

    it("returns the whole report as JSON when asked", async () => {
      const { out } = await runMain([
        `--artifact-root=${FIXTURE_ROOT}`,
        "--json",
        "fixture-run",
      ]);
      const report = JSON.parse(out);
      expect(report.artifactRoot).toBe(FIXTURE_ROOT);
      expect(report.families[0].familyId).toBe("fixture-run");
      expect(report.totals.searches).toBe(5);
      expect(report.totals.toolOutcomes.bash).toEqual({ denied: 1 });
    });
  });

  describe("renderReportLines()", () => {
    it("names every reading it could not take", async () => {
      const lines = renderReportLines(await measureArtifactRoot(FIXTURE_ROOT));
      expect(
        lines.filter((line) => line.includes("NOT READ")).map((line) =>
          // The engine's own parse message is not this repository's to pin.
          line.split("(")[0].trim().replace(
            /is not JSON:[\s\S]*/,
            "is not JSON",
          )
        ),
      ).toEqual([
        "[parent] NOT READ: transcript.json is not an array of messages",
        "[parent] search tags=abandoned -> NOT READ",
        "[parent] NOT READ: the run directory holds no transcript.json",
        "[parent] NOT READ: transcript.json could not be read: Is a directory",
      ]);
    });

    it("names the refusal the index answered a search with", async () => {
      const lines = renderReportLines(await measureArtifactRoot(FIXTURE_ROOT));
      expect(
        lines.some((line) =>
          line.includes("search tags=refused -> refused (pattern index")
        ),
      ).toBe(true);
    });

    it("marks a surface every one of whose calls was denied", async () => {
      const lines = renderReportLines(
        await measureArtifactRoot(FIXTURE_ROOT, ["fixture-run"]),
      );
      expect(lines).toContain(
        "    bash: denied=1 — WITHHELD: every call denied",
      );
      expect(lines).toContain("    read_file: error=1 — never once succeeded");
    });

    it("names the patterns a composed run imported", async () => {
      const lines = renderReportLines(await measureArtifactRoot(FIXTURE_ROOT));
      expect(
        lines.some((line) =>
          line.includes("composes pub-rating,pub-reading-shelf")
        ),
      ).toBe(true);
    });

    it("names a bare re-export as one rather than as a composition", async () => {
      const lines = renderReportLines(
        await measureArtifactRoot(FIXTURE_ROOT, ["alias-run"]),
      );
      expect(
        lines.some((line) =>
          line.includes("BARE RE-EXPORT of pub-packing-list")
        ),
      ).toBe(true);
      expect(
        lines.some((line) =>
          line.includes(
            "importing a published pattern: 1 = 0 composing + 1 bare re-export",
          )
        ),
      ).toBe(true);
    });
  });
});
