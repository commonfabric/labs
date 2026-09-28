import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  computeEntryIdentity,
  ensureCompilerStack,
} from "@commonfabric/runner";

import { operatorProvisionedReferenceAtom } from "../../src/contracts/docs-corpus.ts";
import {
  PATTERN_AUTHORING_GUIDANCE,
  PATTERN_COMPOSITION_GUIDANCE,
} from "../../src/pattern-authoring.ts";
import {
  HARNESS_RESEARCH_HANDLE_TYPE,
  type HarnessResearchHandleValue,
  type HarnessResearchResult,
  type HarnessResearchRunSummary,
} from "../../src/contracts/research.ts";
import { RESEARCH_KIT_SCHEMA } from "../../src/contracts/research-schema.ts";
import { splitMarkdownSections } from "../../src/docs-corpus/sections.ts";
import type {
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "../../src/model/client.ts";
import {
  admitResearchResult,
  researchResultSchema,
} from "../../src/research/admission.ts";
import {
  researchPurposeOf,
  selectResearchContext,
} from "../../src/research/context.ts";
import { projectHarnessResearchKitForModel } from "../../src/research/model-projection.ts";
import {
  createResearchRunner,
  HarnessResearchError,
  type HarnessResearchRequest,
  MAX_RESEARCH_MODEL_TURNS,
  MAX_RESEARCH_TOOL_CALLS,
  MAX_RESEARCH_TOTAL_READ_CHARS,
} from "../../src/research/runner.ts";
import { validateStructuredResultValue } from "../../src/structured-result.ts";
import {
  BILLS_ANSWER_MISSING_BRACE,
  POMODORO_ANSWER_MISSING_BRACE,
} from "../fixtures/research-malformed-answers.ts";

const final = (value: object): HarnessModelTurnResult => ({
  assistant: { role: "assistant", content: JSON.stringify(value) },
});
const calls = (...entries: [string, object][]): HarnessModelTurnResult => ({
  assistant: {
    role: "assistant",
    content: "",
    toolCalls: entries.map(([name, input], i) => ({
      id: `${name}-${i}`,
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    })),
  },
});
const brief = () => ({
  status: "complete",
  summary: "No external input is currently available.",
  inputs: [],
  selectedPatternIds: [],
  rules: [],
  sourceIds: [],
  missing: [],
});
const output = (request: HarnessModelTurnRequest, name: string) =>
  request.transcript.filter((message) =>
    message.role === "tool" && message.toolName === name
  ).map((message) => JSON.parse(message.content));
const run = (
  steps: ((request: HarnessModelTurnRequest) => HarnessModelTurnResult)[],
  extra: Partial<HarnessResearchRequest> = {},
) => {
  const requests: HarnessModelTurnRequest[] = [];
  const modelClient: HarnessModelClient = {
    providerId: "test",
    complete(request) {
      requests.push(request);
      const step = steps.shift();
      if (!step) throw new Error("unexpected model turn");
      return Promise.resolve(step(request));
    },
  };
  return {
    requests,
    result: createResearchRunner({ modelClient })({
      task: "Build a checklist",
      purpose: "orient",
      researchRunId: "current",
      handleTokens: [],
      ...extra,
    }),
  };
};
const corpus = (text: string) => ({
  type: "cf-harness.docs-corpus" as const,
  roots: [],
  files: 1,
  truncated: false,
  sections: splitMarkdownSections({
    path: "common/iframe-react-guide.md",
    integrity: [operatorProvisionedReferenceAtom("docs")],
  }, text),
});
const record = (id: string): HarnessResearchRunSummary => ({
  type: "cf-harness.research-run",
  researchRunId: id,
  outputId: id,
  completedAt: "2026-09-16T00:00:00Z",
  confirmedPatterns: [],
  describedHandles: [],
  kit: {
    status: "complete",
    task: "Earlier question",
    summary: "Earlier finding",
    recommendation: { kind: "focused-api", rationale: "Exact read" },
    inputs: [],
    patterns: [],
    steps: [],
    rules: [],
    verification: [],
    sources: [],
    missing: [],
  },
});

describe("scoped research", () => {
  describe("a final answer that is not JSON", () => {
    // The bills answer is incomplete, so admission follows the re-ask; the
    // pomodoro answer is complete and cites a read this test call never
    // made, so the existing citation repair takes the turn after it.
    for (
      const [name, answer, citationRepair] of [
        ["bills", BILLS_ANSWER_MISSING_BRACE, false],
        ["pomodoro", POMODORO_ANSWER_MISSING_BRACE, true],
      ] as const
    ) {
      it(`admits the ${name} answer the model returns whole on one tools-withheld re-ask`, async () => {
        const trial = run([
          () => ({ assistant: { role: "assistant", content: answer } }),
          (request) => {
            expect(request.tools).toEqual([]);
            const ask = request.transcript.at(-1)?.content ?? "";
            expect(ask).toContain("JSON repair turn");
            expect(ask).toContain("The parser reported:");
            expect(ask).not.toContain(answer.slice(0, 40));
            return { assistant: { role: "assistant", content: answer + "}" } };
          },
          ...(citationRepair
            ? [(request: HarnessModelTurnRequest) => {
              expect(request.transcript.at(-1)?.content).toContain(
                "Citation repair turn",
              );
              return {
                assistant: {
                  role: "assistant" as const,
                  content: answer + "}",
                },
              };
            }]
            : []),
        ]);
        const reply = await trial.result;
        expect(trial.requests).toHaveLength(citationRepair ? 3 : 2);
        expect(reply.kit.summary).toBe(JSON.parse(answer + "}").summary);
      });
    }

    it("fails as before when the re-ask is not JSON either", async () => {
      const trial = run([
        () => ({
          assistant: {
            role: "assistant",
            content: POMODORO_ANSWER_MISSING_BRACE,
          },
        }),
        () => ({
          assistant: {
            role: "assistant",
            content: POMODORO_ANSWER_MISSING_BRACE,
          },
        }),
      ]);
      let failure: unknown;
      try {
        await trial.result;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HarnessResearchError);
      expect((failure as Error).message).toBe(
        "research result was not valid JSON",
      );
      expect(trial.requests).toHaveLength(2);
    });

    it("fails without a re-ask when the budget has no turn left for one", async () => {
      const turns = Array.from(
        { length: MAX_RESEARCH_MODEL_TURNS },
        (_, index) => () =>
          index < MAX_RESEARCH_MODEL_TURNS - 1
            ? calls(["search_docs", { query: `lead ${index}` }])
            : {
              assistant: {
                role: "assistant" as const,
                content: POMODORO_ANSWER_MISSING_BRACE,
              },
            },
      );
      const trial = run(turns, {
        corpus: corpus("# Guide\nA passage to search."),
      });
      let failure: unknown;
      try {
        await trial.result;
      } catch (error) {
        failure = error;
      }
      expect((failure as Error | undefined)?.message).toBe(
        "research result was not valid JSON",
      );
      expect(trial.requests).toHaveLength(MAX_RESEARCH_MODEL_TURNS);
    });
  });

  for (const purpose of ["orient", "answer"] as const) {
    it(`gives ${purpose} research the composition template and not the authoring rules`, async () => {
      const trial = run([(request) => {
        expect(request.transcript[0].content).not.toContain(
          PATTERN_AUTHORING_GUIDANCE,
        );
        expect(request.transcript[0].content).toContain(
          PATTERN_COMPOSITION_GUIDANCE,
        );
        return final(
          purpose === "orient"
            ? { ...brief(), leads: [], questions: [] }
            : { ...brief(), selectedPatternIds: [] },
        );
      }], { purpose });
      await trial.result;
    });
  }

  it("completes a factual orientation without requiring code", async () => {
    const trial = run([() => final({ ...brief(), leads: [], questions: [] })]);
    const reply = await trial.result;
    expect(reply.kit.status).toBe("complete");
    expect(reply.kit.example).toBeUndefined();
  });

  it("inspects indexed source during orientation and returns a usable invocation", async () => {
    await ensureCompilerStack();
    const program = {
      main: "/counter.ts",
      files: [{
        name: "/counter.ts",
        contents: "export default { count: 0 };",
      }],
    };
    const patternId = computeEntryIdentity(program.main, program.files);
    const trial = run([
      () => calls(["inspect_pattern", { patternId }]),
      () => calls(["open_pattern_file", { patternId, path: program.main }]),
      (request) =>
        final({
          ...brief(),
          summary: "Run the existing counter.",
          selectedPatternIds: [patternId],
          leads: [],
          questions: [],
          example: {
            kind: "run-pattern-input",
            invocation: { patternId },
            sourceIds: [output(request, "open_pattern_file")[0].sourceId],
          },
        }),
    ], {
      goal: "Track attendees using existing pieces",
      getPatternIndex: () =>
        Promise.resolve({
          searchPatterns: () => Promise.resolve({ results: [] }),
          getPattern: () =>
            Promise.resolve({
              patternId,
              description: "Counter",
              hashtags: [],
              dependencies: [],
              ownerDid: "did:key:publisher",
              createdAt: "2026-09-16",
              program,
            }),
        }),
    });
    const reply = await trial.result;
    expect(reply.kit.status).toBe("complete");
    expect(reply.kit.patterns[0].sourceIdentityVerified).toBe(true);
    expect(reply.kit.example?.content).toBe(JSON.stringify({ patternId }));
    expect(reply.record.goal).toBe("Track attendees using existing pieces");
    expect(trial.requests[0].transcript[1].content).toContain(
      "Current user goal:\nTrack attendees using existing pieces",
    );
  });

  it("returns exact searchable passages and reads selected outline sections together", async () => {
    const docs = corpus(
      "# Collections\n\n## Introduction\n" + "Background. ".repeat(1_000) +
        "\n\nUse computed for the filtered view.\n\n## Rendering\nMap the view into rows.",
    );
    const trial = run([
      () =>
        calls(["list_doc_sections", {
          pathPrefix: "common/iframe-react-guide.md",
          limit: 1,
        }], ["search_docs", {
          query: "computed filtered",
          pathPrefix: "common/iframe-react-guide.md",
          limit: 1,
        }]),
      (request) => {
        const outline = output(request, "list_doc_sections")[0];
        expect(outline.totalSections).toBe(2);
        expect(outline.nextOffset).toBe(1);
        const match = output(request, "search_docs")[0].results[0];
        expect(match.offset).toBeGreaterThan(8_000);
        expect(match.content).toContain("Use computed for the filtered view.");
        expect(match.sourceId).toMatch(/^documentation:/);
        return calls(["open_doc_section", {
          sectionIds: ["section-0", "section-1"],
        }]);
      },
      (request) => {
        const sections = output(request, "open_doc_section")[0].sections;
        expect(sections.map((entry: { complete: boolean }) => entry.complete))
          .toEqual([true, true]);
        expect(sections[0].content.length).toBeGreaterThan(8_000);
        return final({
          ...brief(),
          rules: [{
            rule: "Use computed for the filtered view.",
            sourceIds: [output(request, "search_docs")[0].results[0].sourceId],
          }],
          leads: [],
          questions: [],
        });
      },
    ], { corpus: docs });
    const reply = await trial.result;
    expect(reply.kit.status).toBe("complete");
    expect(reply.record.sourceReads).toHaveLength(3);
    expect(reply.kit.sources).toHaveLength(1);
    expect(reply.record.cfc.sourceLabel.integrity).toContainEqual(
      operatorProvisionedReferenceAtom("docs"),
    );
  });

  for (
    const prefix of ["common/guide", "common/guide/", "common/guide.md", ""]
  ) {
    it(`limits outlines and cited searches to the exact path or descendants for prefix '${prefix}'`, async () => {
      const paths = [
        "common/guide.md",
        "common/guide.md.extra",
        "common/guide/intro.md",
        "common/guidebook/intro.md",
      ];
      const expected = prefix === ""
        ? paths
        : prefix === "common/guide.md"
        ? [paths[0]]
        : [paths[2]];
      const docs = {
        ...corpus(""),
        files: paths.length,
        sections: paths.flatMap((path) =>
          splitMarkdownSections({
            path,
            integrity: [operatorProvisionedReferenceAtom("docs")],
          }, "# Collection\nUse computed to filter the collection.")
        ),
      };
      const trial = run([
        () =>
          calls(["list_doc_sections", { pathPrefix: prefix }], ["search_docs", {
            pathPrefix: prefix,
            query: "computed",
          }]),
        (request) => {
          expect(
            output(request, "list_doc_sections")[0].sections.map((
              section: { path: string },
            ) => section.path),
          ).toEqual(expected);
          expect(
            output(request, "search_docs")[0].results.map((
              section: { path: string },
            ) => section.path),
          ).toEqual(expected);
          return final({ ...brief(), leads: [], questions: [] });
        },
      ], { corpus: docs });
      const reply = await trial.result;
      expect(reply.record.sourceReads).toHaveLength(expected.length);
    });
  }

  it("refuses an over-budget batch without admitting any of its passages", async () => {
    const docs = corpus(
      "# One\n" + "a".repeat(32_000) + "\n# Two\n" + "b".repeat(32_000) +
        "\n# Three\n" + "c".repeat(32_000) + "\n# Four\nextra",
    );
    const trial = run([
      () =>
        calls(["open_doc_section", {
          sectionIds: ["section-0", "section-1", "section-2", "section-3"],
        }]),
      (request) => {
        expect(output(request, "open_doc_section")[0].error).toContain(
          String(MAX_RESEARCH_TOTAL_READ_CHARS),
        );
        return final({ ...brief(), leads: [], questions: [] });
      },
    ], { corpus: docs });
    const reply = await trial.result;
    expect(reply.record.sourceReads).toEqual([]);
    expect(reply.record.budgets.readChars).toBe(0);
  });

  it("finishes an outline without a continuation and rejects invalid section selectors without reading", async () => {
    const invalid = [
      {},
      { sectionId: "section-0", sectionIds: ["section-0"] },
      { sectionIds: [] },
      { sectionIds: [0] },
      { sectionIds: Array(9).fill("section-0") },
    ];
    const trial = run([
      () => calls(["list_doc_sections", { pathPrefix: "common/" }]),
      (request) => {
        const outline = output(request, "list_doc_sections")[0];
        expect(outline.totalSections).toBe(1);
        expect(
          outline.sections.map((entry: { sectionId: string }) =>
            entry.sectionId
          ),
        )
          .toEqual(["section-0"]);
        expect(outline).not.toHaveProperty("nextOffset");
        return calls(...invalid.map((input): [string, object] => [
          "open_doc_section",
          input,
        ]));
      },
      (request) => {
        expect(output(request, "open_doc_section").map((entry) => entry.error))
          .toEqual([
            "provide exactly one of sectionId or sectionIds",
            "provide exactly one of sectionId or sectionIds",
            "provide between one and eight section ids",
            "provide between one and eight section ids",
            "provide between one and eight section ids",
          ]);
        return final({ ...brief(), leads: [], questions: [] });
      },
    ], { corpus: corpus("# Items\nUse the indexed checklist.") });
    const reply = await trial.result;
    expect(reply.record.sourceReads).toEqual([]);
    expect(reply.record.budgets).toMatchObject({ toolCalls: 6, readChars: 0 });
  });

  it("keeps unverified selections and invented leads incomplete", async () => {
    const pattern = {
      patternId: "unverified",
      description: "A candidate awaiting full-compiler identity verification",
      hashtags: [],
      importHint: 'import Candidate from "cf:pattern:unverified"',
    };
    const kit = await admitResearchResult("Find a suitable component", {
      ...brief(),
      selectedPatternIds: [pattern.patternId],
      leads: [{ patternId: "invented", question: "Does it fit?" }],
      questions: [],
    }, {
      sourceReads: [],
      confirmedPatterns: new Map([[pattern.patternId, pattern]]),
      describedHandles: new Map(),
      searchedPatterns: new Map(),
    }, "orient");
    expect(kit.status).toBe("incomplete");
    expect(kit.missing).toEqual([
      "selected patterns require verified published source identities",
      "candidate invented was not returned by index search or task attachments",
    ]);
    expect(kit).toMatchObject({ patterns: [pattern], leads: [] });
  });

  it("returns a small cited code example in an answer without requiring an application", async () => {
    const trial = run([
      () => calls(["search_docs", { query: "computed" }]),
      (request) =>
        final({
          ...brief(),
          example: {
            kind: "pattern-source",
            content:
              'import { computed } from "commonfabric";\nconst total = computed(() => 2 + 3);',
            sourceIds: [output(request, "search_docs")[0].results[0].sourceId],
          },
        }),
    ], {
      purpose: "answer",
      corpus: corpus(
        "# computed\nUse computed(() => expression) for a derived value.",
      ),
    });
    const reply = await trial.result;
    expect(reply.kit.status).toBe("complete");
    expect(reply.kit.example).toMatchObject({
      kind: "pattern-source",
      syntax: { status: "valid", scope: "syntax-only" },
    });
    expect(reply.kit).not.toHaveProperty("steps");
    expect(() =>
      validateStructuredResultValue({
        schema: RESEARCH_KIT_SCHEMA,
        value: reply.kit,
      })
    ).not.toThrow();
  });

  it("returns uninspected leads separately from confirmed patterns", async () => {
    const trial = run([
      () => calls(["search_pattern_index", { text: "checklist" }]),
      (request) => {
        expect(request.tools.map((tool) => tool.toolId)).toContain(
          "inspect_pattern",
        );
        return final({
          ...brief(),
          leads: [{
            patternId: "candidate",
            question: "Does its item contract fit the task?",
          }],
          questions: ["Which item fields does this candidate accept?"],
        });
      },
    ], {
      getPatternIndex: () =>
        Promise.resolve({
          searchPatterns: () =>
            Promise.resolve({
              results: [{
                patternId: "candidate",
                description: "Checklist did:key:zDescription",
                hashtags: [],
                dependencies: [],
                ownerDid: "did:key:zPublisher",
                createdAt: "2026-09-16",
                kind: "app",
                quality: "unproven",
              }],
            }),
          getPattern: () => {
            throw new Error("source inspection is outside orientation");
          },
        }),
    });
    const reply = await trial.result;
    expect(reply.kit.status).toBe("complete");
    expect(reply.kit.patterns).toEqual([]);
    expect(reply.record.confirmedPatterns).toEqual([]);
    expect(reply.record.cfc.coverage).toBe("incomplete");
    expect(reply.kit).not.toHaveProperty("example");
    const projected = projectHarnessResearchKitForModel(reply.kit);
    expect(projected.kit.purpose).toBe("orient");
    if (projected.kit.purpose !== "orient") {
      throw new Error("expected orientation");
    }
    expect(projected.kit.leads[0].pattern.ownerDid).toBe("did:key:zPublisher");
    expect(projected.kit.leads[0].pattern.description).toBe(
      "Checklist [fabric-id]",
    );
    expect(projected.scrubbedPointers).toEqual([
      "/kit/leads/0/pattern/description",
    ]);
    expect(() =>
      validateStructuredResultValue({
        schema: RESEARCH_KIT_SCHEMA,
        value: projected.kit,
      })
    ).not.toThrow();
  });

  it("reserves synthesis within the shared turn and call bounds", async () => {
    const many = Array.from(
      { length: MAX_RESEARCH_TOOL_CALLS + 2 },
      () => ["list_handles", {}] as [string, object],
    );
    const trial = run([
      () => calls(...many),
      (request) => {
        expect(request.tools).toEqual([]);
        return final({ ...brief(), leads: [], questions: [] });
      },
    ]);
    const reply = await trial.result;
    expect(reply.record.budgets).toEqual({
      modelTurns: 2,
      toolCalls: MAX_RESEARCH_TOOL_CALLS,
      readChars: 0,
    });
    expect(
      output(trial.requests[1], "list_handles").filter((entry) => entry.error),
    ).toHaveLength(2);
    const reserved = run([
      ...Array.from(
        { length: MAX_RESEARCH_MODEL_TURNS - 1 },
        () => () => calls(["list_handles", {}]),
      ),
      (request) => {
        expect(request.tools).toEqual([]);
        return final({ ...brief(), leads: [], questions: [] });
      },
    ]);
    expect((await reserved.result).record.budgets.modelTurns).toBe(
      MAX_RESEARCH_MODEL_TURNS,
    );
  });

  it("reads a large section and records its document ancestry", async () => {
    const docs = corpus(
      "# Iframe React guest\n\n## Hooks\n\n### Cell reads\n" +
        "x".repeat(13_000),
    );
    const trial = run([
      () => calls(["open_doc_section", { sectionId: "section-0" }]),
      (request) => {
        const read = output(request, "open_doc_section")[0];
        expect(read.content).toHaveLength(13_000);
        expect(read.complete).toBe(true);
        expect(request.transcript[0].content).toContain(
          "React JSX pragma or React import belongs to an iframe guest",
        );
        return final({ ...brief(), leads: [], questions: [] });
      },
    ], { corpus: docs });
    const reply = await trial.result;
    expect(reply.record.budgets.readChars).toBe(13_000);
    expect(reply.record.sourceReads[0].headingPath).toEqual([
      "Iframe React guest",
      "Hooks",
      "Cell reads",
    ]);
  });

  /**
   * A research handle's content built from an earlier reply, so its sources
   * carry the digests the earlier read produced.
   */
  const handleFrom = (
    reply: { kit: HarnessResearchResult },
    describedHandles: HarnessResearchHandleValue["describedHandles"] = [],
    confirmedPatterns: HarnessResearchHandleValue["confirmedPatterns"] = [],
  ): HarnessResearchHandleValue => ({
    type: HARNESS_RESEARCH_HANDLE_TYPE,
    researchRunId: "earlier",
    kit: reply.kit,
    confirmedPatterns,
    describedHandles,
    cfc: {
      version: 1,
      sourceLabel: {},
      outputLabel: {},
      coverage: "complete",
      missingLabels: [],
    },
  });
  const TYPED_RENDERER =
    "# Typed renderer\nThis renderer accepts a typed collection.";
  const earlierRead = () =>
    run([
      (request) => {
        void request;
        return calls(["open_doc_section", { sectionId: "section-0" }]);
      },
      (request) =>
        final({
          ...brief(),
          summary: "Read once.",
          selectedPatternIds: [],
          rules: [{
            rule: "This renderer accepts a typed collection.",
            sourceIds: [output(request, "open_doc_section")[0].sourceId],
          }],
        }),
    ], {
      purpose: "answer",
      task: "What does the renderer take?",
      corpus: corpus(TYPED_RENDERER),
    }).result;

  it("cites a prior handle's source without reopening it when its bytes are unchanged", async () => {
    const earlier = await earlierRead();
    const priorId = earlier.kit.sources[0].sourceId;
    const trial = run([
      (request) => {
        expect(request.transcript[1].content).toContain(
          "Prior research carried in by handle",
        );
        expect(request.transcript[1].content).toContain(
          `citable by these sourceIds: ["${priorId}"]`,
        );
        expect(request.transcript[1].content).not.toContain(
          "reopen every source",
        );
        return final({
          ...brief(),
          summary: "The renderer takes a typed collection; SQLite is optional.",
          selectedPatternIds: [],
          rules: [{
            rule: "This renderer accepts a typed collection.",
            sourceIds: [priorId],
          }],
        });
      },
    ], {
      purpose: "answer",
      task: "Does this renderer require SQLite?",
      followUpTo: "cfh:v:earlier",
      priorResearch: handleFrom(earlier),
      corpus: corpus(TYPED_RENDERER),
    });
    const reply = await trial.result;
    expect(reply.kit.status).toBe("complete");
    expect(reply.kit.sources.map((source) => source.sourceId)).toEqual([
      priorId,
    ]);
    expect(reply.record.followUpTo).toBe("cfh:v:earlier");
    expect(reply.record.budgets.toolCalls).toBe(0);
  });

  it("reports a prior source whose bytes changed as stale, reopens it under a new id, and refuses the old one", async () => {
    const earlier = await earlierRead();
    const priorId = earlier.kit.sources[0].sourceId;
    const priorLocation = earlier.kit.sources[0].location;
    const trial = run([
      (request) => {
        expect(request.transcript[1].content).toContain(
          `changed since they were read, or could not be read, and their old ids are not citable — the current read, where one succeeded, is in the catalog under a new id: ["${priorLocation}"]`,
        );
        expect(request.transcript[1].content).toContain(
          "citable by these sourceIds: []",
        );
        return final({
          ...brief(),
          selectedPatternIds: [],
          rules: [{
            rule: "This renderer accepts a typed collection.",
            sourceIds: [priorId],
          }],
        });
      },
      (request) => {
        expect(request.tools).toEqual([]);
        return final({
          ...brief(),
          selectedPatternIds: [],
          rules: [{
            rule: "This renderer accepts a typed collection.",
            sourceIds: [priorId],
          }],
        });
      },
    ], {
      purpose: "answer",
      task: "Does this renderer require SQLite?",
      followUpTo: "cfh:v:earlier",
      priorResearch: handleFrom(earlier),
      corpus: corpus(
        "# Typed renderer\nThis renderer now accepts a typed map as well.",
      ),
    });
    const reply = await trial.result;
    expect(reply.kit.status).toBe("incomplete");
    expect(reply.kit.rules).toEqual([]);
    expect(reply.kit.missing).toContain(`source ${priorId} was not read`);
    expect(reply.record.sourceReads).toHaveLength(1);
    expect(reply.record.sourceReads[0].sourceId).not.toBe(priorId);
    expect(reply.record.sourceReads[0].location).toBe(priorLocation);
  });

  for (
    const [served, expected] of [
      ["the index serves the same program", "verified"],
      ["the index serves a changed program", "stale"],
      ["no index is configured", "stale"],
    ] as const
  ) {
    it(`reports a prior pattern's metadata and source as ${expected} when ${served}`, async () => {
      await ensureCompilerStack();
      const program = {
        main: "/counter.ts",
        files: [{
          name: "/counter.ts",
          contents: "export default { count: 0 };",
        }],
      };
      const patternId = computeEntryIdentity(program.main, program.files);
      const indexServing = (served: typeof program) => () =>
        Promise.resolve({
          searchPatterns: () => Promise.resolve({ results: [] }),
          getPattern: () =>
            Promise.resolve({
              patternId,
              description: "Counter",
              hashtags: [],
              dependencies: [],
              ownerDid: "did:key:publisher",
              createdAt: "2026-09-16",
              program: served,
            }),
        });
      const earlier = await run([
        () => calls(["inspect_pattern", { patternId }]),
        () => calls(["open_pattern_file", { patternId, path: program.main }]),
        (request) =>
          final({
            ...brief(),
            summary: "The counter starts at zero.",
            selectedPatternIds: [],
            rules: [{
              rule: "The counter's default count is zero.",
              sourceIds: [
                output(request, "inspect_pattern")[0].sourceId,
                output(request, "open_pattern_file")[0].sourceId,
              ],
            }],
          }),
      ], {
        purpose: "answer",
        task: "Where does the counter start?",
        getPatternIndex: indexServing(program),
      }).result;
      const priorIds = earlier.kit.sources.map((source) => source.sourceId);
      expect(priorIds).toHaveLength(2);

      const trial = run([
        (request) => {
          const prompt = request.transcript[1].content;
          if (expected === "verified") {
            for (const id of priorIds) expect(prompt).toContain(id);
            expect(prompt).toContain(
              "under a new id: []",
            );
          } else {
            expect(prompt).toContain("citable by these sourceIds: []");
          }
          return final({ ...brief(), selectedPatternIds: [] });
        },
      ], {
        purpose: "answer",
        task: "Does the counter reset?",
        followUpTo: "cfh:v:earlier",
        priorResearch: handleFrom(earlier),
        ...(served === "no index is configured" ? {} : {
          getPatternIndex: indexServing(
            served === "the index serves the same program" ? program : {
              ...program,
              files: [{
                name: "/counter.ts",
                contents: "export default { count: 1 };",
              }],
            },
          ),
        }),
      });
      await trial.result;
      expect(trial.requests).toHaveLength(1);
    });
  }

  it("reports a prior source it cannot locate as stale without reading anything", async () => {
    await ensureCompilerStack();
    const program = {
      main: "/counter.ts",
      files: [{ name: "/counter.ts", contents: "export default {};" }],
    };
    const patternId = computeEntryIdentity(program.main, program.files);
    const earlier = await earlierRead();
    const unlocatable = [
      "common/iframe-react-guide.md#Typed renderer (section-99)",
      "not-a-pattern-location",
      `cf:pattern:${patternId}:/missing.ts`,
    ];
    const prior = handleFrom({
      kit: {
        ...earlier.kit,
        sources: unlocatable.map((location, index) => ({
          ...earlier.kit.sources[0],
          sourceId: `carried-${index}`,
          kind: index === 0 ? "documentation" : "pattern-source",
          location,
        })),
      },
    });
    const trial = run([
      (request) => {
        expect(request.transcript[1].content).toContain(
          `under a new id: ${JSON.stringify(unlocatable)}`,
        );
        return final({ ...brief(), selectedPatternIds: [] });
      },
    ], {
      purpose: "answer",
      task: "Does this renderer require SQLite?",
      followUpTo: "cfh:v:earlier",
      priorResearch: prior,
      corpus: corpus(TYPED_RENDERER),
      getPatternIndex: () =>
        Promise.resolve({
          searchPatterns: () => Promise.resolve({ results: [] }),
          getPattern: () =>
            Promise.resolve({
              patternId,
              description: "Counter",
              hashtags: [],
              dependencies: [],
              ownerDid: "did:key:publisher",
              createdAt: "2026-09-16",
              program,
            }),
        }),
    });
    const reply = await trial.result;
    expect(
      reply.record.sourceReads.filter((read) =>
        read.kind !== "pattern-metadata"
      ),
    ).toEqual([]);
  });

  it("stops a follow-up that is cancelled before its prior sources are read again", async () => {
    const earlier = await earlierRead();
    const abort = new AbortController();
    abort.abort("stop before carrying");
    const trial = run([], {
      purpose: "answer",
      task: "Does this renderer require SQLite?",
      followUpTo: "cfh:v:earlier",
      priorResearch: handleFrom(earlier),
      corpus: corpus(TYPED_RENDERER),
      signal: abort.signal,
    });
    let failure: unknown;
    try {
      await trial.result;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe("stop before carrying");
    expect(trial.requests).toHaveLength(0);
  });

  it("reports a prior source whose section moved as stale without reading the section now at its index", async () => {
    const earlier = await earlierRead();
    const priorLocation = earlier.kit.sources[0].location;
    const moved = corpus(
      "# Unrelated guide\nNothing about renderers here.\n\n" + TYPED_RENDERER,
    );
    const trial = run([
      (request) => {
        expect(request.transcript[1].content).toContain(
          `under a new id: ["${priorLocation}"]`,
        );
        return final({ ...brief(), selectedPatternIds: [] });
      },
    ], {
      purpose: "answer",
      task: "Does this renderer require SQLite?",
      followUpTo: "cfh:v:earlier",
      priorResearch: handleFrom(earlier),
      corpus: moved,
    });
    const reply = await trial.result;
    expect(reply.record.sourceReads).toEqual([]);
  });

  it("selects a pattern the prior handle confirmed without inspecting it again", async () => {
    const earlier = await earlierRead();
    const confirmed = {
      patternId: "carried-reader",
      description: "Reads a typed collection.",
      hashtags: [],
      importHint: 'import Reader from "cf:pattern:carried-reader"',
      ownerDid: "did:key:owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      dependencies: [],
      sourceIdentityVerified: true as const,
    };
    const trial = run([
      () =>
        final({
          ...brief(),
          summary: "Use the carried reader.",
          selectedPatternIds: ["carried-reader"],
        }),
    ], {
      purpose: "answer",
      task: "Which reader fits?",
      followUpTo: "cfh:v:earlier",
      priorResearch: handleFrom(
        { kit: { ...earlier.kit, patterns: [confirmed] } },
        [],
        [confirmed],
      ),
      corpus: corpus(TYPED_RENDERER),
    });
    const reply = await trial.result;
    expect(reply.kit.patterns.map((pattern) => pattern.patternId)).toEqual([
      "carried-reader",
    ]);
    expect(reply.kit.missing).not.toContain(
      "pattern carried-reader was not inspected successfully",
    );
    expect(reply.record.budgets.toolCalls).toBe(0);
  });

  for (const held of [true, false]) {
    it(
      `${
        held ? "binds" : "refuses to bind"
      } a handle a prior kit described when this run ${
        held ? "still holds" : "no longer holds"
      } it`,
      async () => {
        const earlier = await earlierRead();
        const token = "cfh:a:mail22";
        const trial = run([
          (request) => {
            expect(request.transcript[1].content).toContain(
              held
                ? `already described for this call: ["${token}"]`
                : `which cannot be bound: ["${token}"]`,
            );
            return final({
              ...brief(),
              selectedPatternIds: [],
              inputs: [{ name: "mail", token, purpose: "Read the mailbox" }],
            });
          },
        ], {
          purpose: "answer",
          task: "Which input carries the mail?",
          followUpTo: "cfh:v:earlier",
          priorResearch: handleFrom(earlier, [{
            token,
            description: { outputId: "described-mail", token, known: true },
          }]),
          handleTokens: held ? [token] : [],
          corpus: corpus(TYPED_RENDERER),
        });
        const reply = await trial.result;
        if (held) {
          expect(reply.kit.inputs.map((input) => input.token)).toEqual([token]);
          expect(reply.record.describedHandles.map((entry) => entry.token))
            .toEqual([token]);
        } else {
          expect(reply.kit.inputs).toEqual([]);
          expect(reply.kit.missing).toContain(
            `handle ${token} was not described`,
          );
        }
      },
    );
  }

  it("keeps fresh citation admission when an answer copies an unread prior id", async () => {
    const trial = run([
      () =>
        final({
          ...brief(),
          selectedPatternIds: [],
          rules: [{
            rule: "Unsupported claim",
            sourceIds: ["documentation:earlier"],
          }],
        }),
      (request) => {
        expect(request.tools).toEqual([]);
        return final({
          ...brief(),
          selectedPatternIds: [],
          rules: [{
            rule: "Unsupported claim",
            sourceIds: ["documentation:earlier"],
          }],
        });
      },
    ], { purpose: "answer" });
    const reply = await trial.result;
    expect(reply.kit.status).toBe("incomplete");
    expect(reply.kit.sources).toEqual([]);
    expect(reply.kit.rules).toEqual([]);
  });

  it("serializes structured invocations and refuses TSX in their place", async () => {
    const evidence = {
      sourceReads: [{
        sourceId: "pattern-source:exact",
        kind: "pattern-source" as const,
        location: "cf:pattern:selected:/main.tsx",
        offset: 0,
        end: 1,
        totalChars: 1,
        digest: "sha256:exact",
      }],
      confirmedPatterns: new Map([["selected", {
        patternId: "selected",
        description: "Known pattern",
        hashtags: [],
        importHint: 'import X from "cf:pattern:selected"',
        sourceIdentityVerified: true as const,
      }]]),
      describedHandles: new Map(),
    };
    const candidate = {
      ...brief(),
      selectedPatternIds: ["selected"],
      example: {
        kind: "run-pattern-input",
        invocation: { patternId: "selected", inputs: { count: 3 } },
        sourceIds: ["pattern-source:exact"],
      },
    };
    const reply = await admitResearchResult(
      "Run the component",
      candidate,
      evidence,
      "answer",
    );
    expect(reply.status).toBe("complete");
    expect(() =>
      validateStructuredResultValue({
        schema: RESEARCH_KIT_SCHEMA,
        value: reply,
      })
    ).not.toThrow();
    expect(() =>
      validateStructuredResultValue({
        schema: RESEARCH_KIT_SCHEMA,
        value: {
          ...reply,
          recommendation: { kind: "focused-api", rationale: "One rule" },
        },
      })
    ).toThrow();
    expect(reply.example?.content).toBe(
      '{"patternId":"selected","inputs":{"count":3}}',
    );
    expect(() =>
      validateStructuredResultValue({
        schema: researchResultSchema("answer"),
        value: {
          ...candidate,
          example: {
            ...candidate.example,
            invocation: "import React from 'react'",
          },
        },
      })
    ).toThrow();
    expect(() =>
      validateStructuredResultValue({
        schema: researchResultSchema("answer"),
        value: {
          ...candidate,
          example: {
            kind: "run-pattern-input",
            content: "<Checklist />",
            sourceIds: [],
          },
        },
      })
    ).toThrow();
  });

  it("carries the labels of canonical guide outlines before any section is opened", async () => {
    const reference = operatorProvisionedReferenceAtom("canonical-guidance");
    const trial = run([() =>
      final({
        ...brief(),
        status: "incomplete",
        selectedPatternIds: [],
        missing: ["Open the relevant authoring section"],
      })], {
      purpose: "answer",
      corpus: {
        ...corpus(""),
        sections: splitMarkdownSections({
          path: "skills/pattern-dev/SKILL.md",
          integrity: [reference],
        }, "# Pattern development\n## Writable cells\nUse a writable cell."),
      },
    });
    const reply = await trial.result;
    expect(trial.requests[0].transcript[1].content).toContain(
      "Canonical authoring references",
    );
    expect(reply.record.cfc.sourceLabel.integrity).toContainEqual(reference);
    expect(reply.record.sourceReads).toEqual([]);
  });

  it("keeps failures within the private record when a scoped result violates its format", async () => {
    const trial = run([
      () =>
        final({ ...brief(), example: "invented", leads: [], questions: [] }),
    ]);
    await expect(trial.result).rejects.toBeInstanceOf(HarnessResearchError);
  });

  it("interprets saved focused answers and selects bounded findings", () => {
    const old = record("old");
    const recipe = record("implementation");
    if (old.kit.purpose !== undefined) {
      throw new Error("expected a saved unscoped kit");
    }
    recipe.kit = {
      ...old.kit,
      recommendation: { kind: "author", rationale: "Author" },
      steps: [],
      verification: [],
      example: {
        kind: "run-pattern-input",
        content: "old complete example",
        sourceIds: [],
      },
      patterns: [{
        patternId: "known-component",
        description: "A reusable component",
        hashtags: [],
        importHint: 'import Component from "cf:pattern:known-component"',
        argumentType: "{ count: number }",
        resultType: "{ total: number }",
        argumentSchema: {
          type: "object",
          description: "Private schema detail",
        },
      }],
    };
    const orient = record("orient");
    orient.kit = {
      ...brief(),
      task: "orient",
      purpose: "orient",
      status: "complete",
      availableHandleTokens: [],
      patterns: [],
      sources: [],
      leads: [],
      questions: [],
    };
    const runs = [old, recipe, orient, record("answer1"), record("answer2")];
    expect(researchPurposeOf(old.kit)).toBe("answer");
    expect(selectResearchContext(runs).map((entry) => entry.researchRunId))
      .toEqual(["orient", "answer1", "answer2"]);
  });
});
