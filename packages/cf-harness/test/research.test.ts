import { encodeHex } from "@std/encoding/hex";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { cfcAtom } from "@commonfabric/api/cfc";
import { sha256 } from "@commonfabric/content-hash";
import {
  computeEntryIdentity,
  ensureCompilerStack,
} from "@commonfabric/runner";

import {
  type HarnessDocsCorpusSection,
  operatorProvisionedReferenceAtom,
} from "../src/contracts/docs-corpus.ts";
import type { HarnessResearchRunSummary } from "../src/contracts/research.ts";
import type {
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "../src/model/client.ts";
import type {
  PatternIndexPattern,
  PatternIndexSearchResponse,
} from "../src/pattern-index/client.ts";
import {
  createResearchRunner,
  HarnessResearchError,
  type HarnessResearchPatternIndex,
  type HarnessResearchRequest,
  MAX_RESEARCH_EXAMPLE_CHARS,
  MAX_RESEARCH_MODEL_TURNS,
  MAX_RESEARCH_READ_CHARS,
  MAX_RESEARCH_TOOL_CALLS,
  MAX_RESEARCH_TOTAL_READ_CHARS,
} from "../src/research/runner.ts";
import {
  researchKitGuidance,
  researchToolDescriptor,
} from "../src/tools/research.ts";

type ModelStep = (
  request: HarnessModelTurnRequest,
) => HarnessModelTurnResult | Promise<HarnessModelTurnResult>;

class ScriptedModelClient implements HarnessModelClient {
  readonly providerId = "test-provider";
  readonly requests: HarnessModelTurnRequest[] = [];
  readonly #steps: ModelStep[];

  constructor(steps: readonly ModelStep[]) {
    this.#steps = [...steps];
  }

  async complete(request: HarnessModelTurnRequest) {
    this.requests.push(request);
    const step = this.#steps.shift();
    if (step === undefined) throw new Error("unexpected model turn");
    return await step(request);
  }
}

const assistant = (
  content: string,
  toolCalls?: readonly {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }[],
): HarnessModelTurnResult => ({
  assistant: {
    role: "assistant",
    content,
    ...(toolCalls !== undefined
      ? {
        toolCalls: toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input),
          },
        })),
      }
      : {}),
  },
});

const toolOutputs = (
  request: HarnessModelTurnRequest,
  toolName?: string,
): Record<string, unknown>[] =>
  request.transcript.flatMap((message) => {
    if (
      message.role !== "tool" ||
      (toolName !== undefined && message.toolName !== toolName)
    ) return [];
    return [JSON.parse(message.content) as Record<string, unknown>];
  });

const finalResult = (
  overrides: Record<string, unknown> = {},
): HarnessModelTurnResult =>
  assistant(JSON.stringify({
    status: "incomplete",
    summary: "The available evidence is not sufficient.",
    recommendation: {
      kind: "focused-api",
      rationale: "More evidence is required.",
    },
    inputs: [],
    selectedPatternIds: [],
    steps: [],
    rules: [],
    verification: [],
    sourceIds: [],
    missing: ["more evidence"],
    ...overrides,
  }));

const corpusWith = (
  sections: readonly Omit<HarnessDocsCorpusSection, "integrity">[],
) => ({
  type: "cf-harness.docs-corpus" as const,
  roots: [{ name: "docs", hostPath: "/trusted/docs" }],
  sections: sections.map((section) => ({
    ...section,
    integrity: [operatorProvisionedReferenceAtom("/trusted/docs")],
  })),
  files: new Set(sections.map((section) => section.path)).size,
  truncated: false,
});

const requestFor = (
  overrides: Partial<HarnessResearchRequest> = {},
): HarnessResearchRequest => ({
  task: "Research the Common Fabric contract.",
  researchRunId: `research-test-${crypto.randomUUID()}`,
  handleTokens: [],
  ...overrides,
});

describe("research", () => {
  describe("the public descriptor", () => {
    it("takes one whole task through a read-effect capability", () => {
      expect(researchToolDescriptor.toolId).toBe("research");
      expect(researchToolDescriptor.effectClass).toBe("read");
      const schema = researchToolDescriptor.inputSchema as {
        required: readonly string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
      expect(schema.required).toEqual(["task"]);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties)).toEqual([
        "task",
        "purpose",
        "followUpTo",
      ]);
    });
  });

  describe("private tool boundaries", () => {
    for (
      const task of [
        "what's on my calendar",
        "show me my documents",
        "email my landlord, the heater is broken",
      ]
    ) {
      it(`orients the rehearsal request ${JSON.stringify(task)} within the private loop's reading capability`, async () => {
        const model = new ScriptedModelClient([
          () =>
            assistant(JSON.stringify({
              status: "incomplete",
              summary: "Inspect the relevant input and action path.",
              inputs: [],
              selectedPatternIds: [],
              rules: [],
              sourceIds: [],
              missing: ["source description"],
              leads: [],
              questions: [],
            })),
        ]);
        await createResearchRunner({ modelClient: model })(requestFor({
          task,
          purpose: "orient",
        }));
        const request = model.requests[0];
        const system = request.transcript.find((message) =>
          message.role === "system"
        )?.content;
        expect(system).toContain(
          "inspect unresolved relevant handles with describe_handle before asking",
        );
        expect(system).toContain(
          "Private research inspects candidates and tells the parent what to run; it cannot execute them",
        );
        expect(system).toContain(
          "If sending is unavailable, say so immediately",
        );
        expect(system).toContain(
          "Never ask the user to release aggregates or change a sink ceiling through a control that does not exist",
        );
        expect(
          request.transcript.some((message) =>
            message.role === "user" && message.content.includes(task)
          ),
        ).toBe(true);
        expect(request.tools.some((tool) => tool.toolId === "run_pattern"))
          .toBe(false);
      });
    }

    for (const attached of [true, false]) {
      it(`distinguishes explicit input attachments from general grants when attached is ${attached}`, async () => {
        const token = "cfh:a:attached";
        const ref = `/of:fid1:${"A".repeat(43)}`;
        const model = new ScriptedModelClient([() => finalResult()]);
        await createResearchRunner({ modelClient: model })(requestFor({
          handleTokens: ["cfh:a:registry", token],
          inputCells: attached ? [{ name: "pattern_1", token, ref }] : [],
        }));
        const prompt = model.requests[0].transcript.find((message) =>
          message.role === "user"
        )?.content;
        expect(prompt).toContain("cfh:a:registry");
        expect(prompt).not.toContain(ref);
        if (attached) {
          expect(prompt).toContain(`${token} — pattern_1`);
          expect(prompt).not.toContain("No input cells are attached");
          expect(prompt).toContain("passed directly to read_piece_source");
        } else {
          expect(prompt).toContain("No input cells are attached");
          expect(prompt).not.toContain("pattern_1");
        }
      });
    }

    it("returns unresolved piece selection to the parent without proposing a registry crawl", async () => {
      const model = new ScriptedModelClient([
        () =>
          assistant(JSON.stringify({
            status: "incomplete",
            summary: "The parent must identify the target piece.",
            inputs: [],
            rules: [],
            sourceIds: [],
            missing: ["target piece"],
            selectedPatternIds: [],
            leads: [],
            questions: ["Which piece should be edited?"],
          })),
      ]);
      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({
          task: "Add a total to this bills pane.",
          purpose: "orient",
        }),
      );
      expect(reply.kit.status).toBe("incomplete");
      expect(reply.kit).toHaveProperty("questions", [
        "Which piece should be edited?",
      ]);
      expect(
        reply.record.messages.filter((message) => message.role === "tool"),
      ).toEqual([]);
      const system = model.requests[0].transcript.find((message) =>
        message.role === "system"
      )?.content;
      expect(system).toContain("make zero registry reads");
      expect(system).toContain("at most one registry read");
      expect(system).toContain("exactly one matching piece");
      expect(system).toContain(
        "Research and authoring children return an unresolved target to the parent",
      );
    });

    it("pairs invalid requests without admitting their outputs", async () => {
      const token = "cfh:a:available";
      const corpus = corpusWith([{
        path: "docs/contract.md",
        heading: "Contract",
        text: "short",
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "short-query",
            name: "search_docs",
            input: { query: "x" },
          }, {
            id: "past-end",
            name: "open_doc_section",
            input: { sectionId: "section-0", offset: 99 },
          }, {
            id: "unknown-section",
            name: "open_doc_section",
            input: { sectionId: "section-99" },
          }, {
            id: "search-without-index",
            name: "search_pattern_index",
            input: { text: "contract" },
          }, {
            id: "inspect-without-index",
            name: "inspect_pattern",
            input: { patternId: "missing-pattern" },
          }, {
            id: "inventory",
            name: "list_handles",
            input: {},
          }, {
            id: "restricted-handle",
            name: "describe_handle",
            input: { token: "cfh:a:restricted" },
          }, {
            id: "unavailable-description",
            name: "describe_handle",
            input: { token },
          }, {
            id: "unknown-tool",
            name: "future_research_tool",
            input: {},
          }]),
        () => finalResult(),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus, handleTokens: [token] }),
      );
      const outputs = toolOutputs(model.requests[1]);

      expect(outputs).toEqual([
        { error: "query must be at least 2 characters" },
        { error: "offset 99 exceeds 5 characters" },
        { error: "unknown documentation section section-99" },
        { error: "this run has no configured pattern index" },
        { error: "this run has no configured pattern index" },
        { tokens: [token] },
        { error: "unknown or restricted handle cfh:a:restricted" },
        { error: "handle description is unavailable" },
        { error: "unknown research tool future_research_tool" },
      ]);
      expect(reply.record.budgets).toEqual({
        modelTurns: 2,
        toolCalls: 9,
        readChars: 0,
      });
      expect(reply.record.sourceReads).toEqual([]);
    });

    it("validates index queries and records an empty result's label gap", async () => {
      let searches = 0;
      const index: HarnessResearchPatternIndex = {
        searchPatterns: () => {
          searches += 1;
          return Promise.resolve({ results: [] });
        },
        getPattern: () => Promise.reject(new Error("unexpected inspection")),
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "empty-query",
            name: "search_pattern_index",
            input: {},
          }, {
            id: "empty-result",
            name: "search_pattern_index",
            input: { tags: ["missing"] },
          }, {
            id: "empty-pattern-id",
            name: "inspect_pattern",
            input: { patternId: "" },
          }]),
        () => finalResult(),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ getPatternIndex: () => Promise.resolve(index) }),
      );
      const outputs = toolOutputs(model.requests[1]);

      expect(outputs).toEqual([
        { error: "pattern search requires text, tags, or both" },
        { results: [] },
        { error: "patternId is required" },
      ]);
      expect(searches).toBe(1);
      expect(reply.record.cfc.missingLabels).toEqual([{
        source: "pattern-index-metadata",
        detail: "empty search_pattern_index response",
      }]);
    });
  });

  describe("documentation research", () => {
    it("continues through a section to evidence beyond 4,000 characters", async () => {
      const tailRule = "late-contract: call pattern() with the database handle";
      const tailExample =
        "export default pattern(({ database }) => ({ database }));";
      const text = `${"intro ".repeat(720)}\n${tailRule}\n${tailExample}`;
      const corpus = corpusWith([{
        path: "docs/patterns.md",
        heading: "Database patterns",
        text,
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "search",
            name: "search_docs",
            input: { query: "late-contract" },
          }]),
        (request) => {
          const result = toolOutputs(request, "search_docs")[0];
          const matches = result.results as Record<string, unknown>[];
          return assistant("", [{
            id: "open-first",
            name: "open_doc_section",
            input: { sectionId: matches[0].sectionId, maxChars: 4_000 },
          }]);
        },
        (request) => {
          const first = toolOutputs(request, "open_doc_section")[0];
          return assistant("", [{
            id: "open-tail",
            name: "open_doc_section",
            input: {
              sectionId: "section-0",
              offset: first.nextOffset,
              maxChars: 4_000,
            },
          }]);
        },
        (request) => {
          const reads = toolOutputs(request, "open_doc_section");
          return finalResult({
            status: "complete",
            summary: "The late database contract is established.",
            recommendation: {
              kind: "author",
              rationale: "The exact section supplies the complete source.",
            },
            example: {
              kind: "pattern-source",
              content: tailExample,
              sourceIds: [reads[1].sourceId],
            },
            rules: [{
              rule: tailRule,
              sourceIds: [reads[1].sourceId],
            }],
            sourceIds: [reads[1].sourceId],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );

      expect(corpus.sections[0].text.length).toBeGreaterThan(4_000);
      expect(reply.kit.status).toBe("complete");
      expect(reply.kit.rules[0].rule).toContain("late-contract");
      expect(reply.kit.example?.content).toBe(tailExample);
      expect(reply.kit.example?.syntax).toEqual({
        status: "valid",
        scope: "syntax-only",
        diagnostics: [],
      });
      expect(reply.kit.sources[0].offset).toBe(4_000);
      const tailRead = toolOutputs(
        model.requests[3],
        "open_doc_section",
      )[1];
      expect(tailRead.content).toContain(tailRule);
      expect(tailRead.content).toContain(tailExample);
      expect(tailRead.complete).toBe(true);
      expect(tailRead.sectionId).toBe("section-0");
      expect(reply.kit.sources[0].cfcLabel).toEqual({
        integrity: [operatorProvisionedReferenceAtom("/trusted/docs")],
      });
      expect(reply.record.cfc).toEqual({
        version: 1,
        sourceLabel: {
          integrity: [operatorProvisionedReferenceAtom("/trusted/docs")],
        },
        outputLabel: {},
        coverage: "complete",
        missingLabels: [],
      });
    });

    it("keeps duplicate headings as distinct exact sources", async () => {
      const corpus = corpusWith([{
        path: "docs/repeated.md",
        heading: "Example",
        text: "first implementation contract",
      }, {
        path: "docs/repeated.md",
        heading: "Example",
        text: "second implementation contract",
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "first",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }, {
            id: "second",
            name: "open_doc_section",
            input: { sectionId: "section-1" },
          }]),
        (request) => {
          const reads = toolOutputs(request, "open_doc_section");
          return finalResult({
            status: "complete",
            summary: "Both examples were read independently.",
            recommendation: {
              kind: "focused-api",
              rationale: "The repeated sections state two rules.",
            },
            rules: [{
              rule: "Apply both implementation contracts.",
              sourceIds: reads.map((read) => read.sourceId),
            }],
            sourceIds: reads.map((read) => read.sourceId),
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );

      expect(reply.kit.sources).toHaveLength(2);
      expect(reply.kit.sources[0].sourceId).not.toBe(
        reply.kit.sources[1].sourceId,
      );
      expect(reply.kit.sources[0].digest).not.toBe(
        reply.kit.sources[1].digest,
      );
      expect(reply.kit.sources.map((source) => source.location)).toEqual([
        "docs/repeated.md#Example (section-0)",
        "docs/repeated.md#Example (section-1)",
      ]);
      const opened = toolOutputs(model.requests[1], "open_doc_section");
      expect(opened.map((read) => read.sectionId)).toEqual([
        "section-0",
        "section-1",
      ]);
    });

    it("refuses a read beyond the cumulative budget without losing completed citations", async () => {
      const successfulReads = MAX_RESEARCH_TOTAL_READ_CHARS /
        MAX_RESEARCH_READ_CHARS;
      const corpus = corpusWith([{
        path: "docs/long-contract.md",
        heading: "Long contract",
        text: "contract".repeat(
          (MAX_RESEARCH_TOTAL_READ_CHARS + MAX_RESEARCH_READ_CHARS) / 8,
        ),
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant(
            "",
            Array.from({ length: successfulReads + 1 }, (_, index) => ({
              id: `read-${index}`,
              name: "open_doc_section",
              input: {
                sectionId: "section-0",
                offset: index * MAX_RESEARCH_READ_CHARS,
                maxChars: MAX_RESEARCH_READ_CHARS,
              },
            })),
          ),
        (request) => {
          const outputs = toolOutputs(request, "open_doc_section");
          const sourceId = outputs[successfulReads - 1].sourceId;
          return finalResult({
            status: "complete",
            summary: "The final completed window establishes the contract.",
            recommendation: {
              kind: "focused-api",
              rationale: "The cited window contains the required rule.",
            },
            rules: [{
              rule: "Use the contract from the final completed window.",
              sourceIds: [sourceId],
            }],
            sourceIds: [sourceId],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );
      const outputs = toolOutputs(model.requests[1], "open_doc_section");

      expect(outputs).toHaveLength(successfulReads + 1);
      expect(outputs.at(-1)?.error).toBe(
        `research read budget of ${MAX_RESEARCH_TOTAL_READ_CHARS} characters is exhausted`,
      );
      expect(reply.record.budgets.readChars).toBe(
        MAX_RESEARCH_TOTAL_READ_CHARS,
      );
      expect(reply.record.sourceReads).toHaveLength(successfulReads);
      expect(reply.kit.status).toBe("complete");
      expect(reply.kit.sources).toEqual([
        reply.record.sourceReads[successfulReads - 1],
      ]);
    });

    it("repairs one misspelled citation on the final available turn", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Pattern contract",
        text: "Use the exact documented pattern contract.",
      }]);
      const intermediateTurns: ModelStep[] = Array.from(
        { length: MAX_RESEARCH_MODEL_TURNS - 3 },
        (_, index) => () =>
          assistant("", [{
            id: `search-${index}`,
            name: "search_docs",
            input: { query: "pattern contract" },
          }]),
      );
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        ...intermediateTurns,
        (request) => {
          const sourceId = String(
            toolOutputs(request, "open_doc_section")[0].sourceId,
          );
          const misspelled = sourceId.slice(0, -1);
          return finalResult({
            status: "complete",
            summary: "The exact contract is available.",
            recommendation: {
              kind: "focused-api",
              rationale: "The opened section establishes the rule.",
            },
            rules: [{
              rule: "Use the documented pattern contract.",
              sourceIds: [misspelled],
            }],
            sourceIds: [misspelled],
            missing: [],
          });
        },
        (request) => {
          const sourceId = String(
            toolOutputs(request, "open_doc_section")[0].sourceId,
          );
          expect(request.tools).toEqual([]);
          expect(request.transcript.at(-1)?.content).toContain(sourceId);
          expect(request.transcript.at(-1)?.content).toContain("section-0");
          return finalResult({
            status: "complete",
            summary: "The exact contract is available.",
            recommendation: {
              kind: "focused-api",
              rationale: "The opened section establishes the rule.",
            },
            rules: [{
              rule: "Use the documented pattern contract.",
              sourceIds: [sourceId],
            }],
            sourceIds: [sourceId],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );

      expect(model.requests).toHaveLength(MAX_RESEARCH_MODEL_TURNS);
      expect(reply.record.budgets.modelTurns).toBe(MAX_RESEARCH_MODEL_TURNS);
      expect(reply.record.budgets.toolCalls).toBe(
        MAX_RESEARCH_MODEL_TURNS - 2,
      );
      expect(reply.kit.status).toBe("complete");
      expect(reply.kit.sources).toHaveLength(1);
    });

    it("keeps strict admission after the single citation repair", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Pattern contract",
        text: "Use the exact documented pattern contract.",
      }]);
      const misspelledResult = (request: HarnessModelTurnRequest) => {
        const sourceId = String(
          toolOutputs(request, "open_doc_section")[0].sourceId,
        );
        const misspelled = `${sourceId}-wrong`;
        return finalResult({
          status: "complete",
          recommendation: {
            kind: "focused-api",
            rationale: "The opened section establishes the rule.",
          },
          rules: [{ rule: "Use the contract.", sourceIds: [misspelled] }],
          sourceIds: [misspelled],
          missing: [],
        });
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        misspelledResult,
        misspelledResult,
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );

      expect(model.requests).toHaveLength(3);
      expect(reply.kit.status).toBe("incomplete");
      expect(reply.kit.sources).toEqual([]);
      expect(reply.kit.missing.some((item) => item.includes("was not read")))
        .toBe(true);
    });

    it("rejects tool use during citation repair and retains the original candidate", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Pattern contract",
        text: "Use the exact documented pattern contract.",
      }]);
      const usage: (number | undefined)[] = [];
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        (request) => {
          const sourceId = String(
            toolOutputs(request, "open_doc_section")[0].sourceId,
          );
          return finalResult({
            status: "complete",
            summary: "Original candidate",
            recommendation: {
              kind: "focused-api",
              rationale: "The opened section establishes the rule.",
            },
            rules: [{
              rule: "Use the documented pattern contract.",
              sourceIds: [`${sourceId}-wrong`],
            }],
            sourceIds: [`${sourceId}-wrong`],
            missing: [],
          });
        },
        (request) => {
          const sourceId = String(
            toolOutputs(request, "open_doc_section")[0].sourceId,
          );
          const corrected = finalResult({
            status: "complete",
            summary: "Corrected candidate",
            recommendation: {
              kind: "focused-api",
              rationale: "The opened section establishes the rule.",
            },
            rules: [{
              rule: "Use the documented pattern contract.",
              sourceIds: [sourceId],
            }],
            sourceIds: [sourceId],
            missing: [],
          }).assistant.content;
          return {
            ...assistant(corrected, [{
              id: "forbidden-repair-read",
              name: "open_doc_section",
              input: { sectionId: "section-0" },
            }]),
            usage: { totalTokens: 23 },
          };
        },
      ]);

      const reply = await createResearchRunner({
        modelClient: model,
        onUsage: (entry) => {
          usage.push(entry?.totalTokens);
        },
      })(requestFor({ corpus }));

      expect(usage).toEqual([undefined, undefined, 23]);
      expect(model.requests[2].tools).toEqual([]);
      expect(reply.record.messages.at(-1)).toEqual({
        role: "tool",
        toolCallId: "forbidden-repair-read",
        toolName: "open_doc_section",
        content: JSON.stringify({
          error: "private tools are withheld on the citation repair turn",
        }),
      });
      expect(reply.kit.summary).toBe("Original candidate");
      expect(reply.kit.status).toBe("incomplete");
    });

    it("retains the original candidate when citation repair is malformed", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Pattern contract",
        text: "Use the exact documented pattern contract.",
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        (request) => {
          const sourceId = String(
            toolOutputs(request, "open_doc_section")[0].sourceId,
          );
          return finalResult({
            status: "complete",
            summary: "Original malformed-repair candidate",
            recommendation: {
              kind: "focused-api",
              rationale: "The opened section establishes the rule.",
            },
            rules: [{
              rule: "Use the documented pattern contract.",
              sourceIds: [`${sourceId}-wrong`],
            }],
            sourceIds: [`${sourceId}-wrong`],
            missing: [],
          });
        },
        () => assistant("not repair JSON"),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );

      expect(model.requests).toHaveLength(3);
      expect(reply.kit.summary).toBe("Original malformed-repair candidate");
      expect(reply.kit.sources).toEqual([]);
      expect(reply.kit.missing.some((item) => item.includes("was not read")))
        .toBe(true);
    });
  });

  describe("published pattern research", () => {
    it("returns a complete zero-handle direct-run kit from verified multi-file source", async () => {
      await ensureCompilerStack();
      const files = [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "import { title } from './title.ts';",
          "export default pattern(() => ({ $UI: <h1>{title}</h1> }));",
        ].join("\n"),
      }, {
        name: "/title.ts",
        contents: "export const title = 'Dinner party';\n",
      }];
      const patternId = computeEntryIdentity("/main.tsx", files);
      const pattern: PatternIndexPattern = {
        patternId,
        ownerDid: "did:key:zPublisher",
        createdAt: "2026-09-01T00:00:00.000Z",
        description: "Displays a dinner-party heading",
        hashtags: ["dinner-party", "ui"],
        dependencies: [],
        argumentSchema: {
          type: "object",
          properties: {},
          description: "x".repeat(MAX_RESEARCH_READ_CHARS + 1),
        },
        resultSchema: { type: "object" },
        program: { main: "/main.tsx", files },
      };
      const index: HarnessResearchPatternIndex = {
        searchPatterns: () =>
          Promise.resolve({
            results: [{
              patternId,
              description: pattern.description,
              hashtags: pattern.hashtags,
              ownerDid: pattern.ownerDid,
              createdAt: pattern.createdAt,
              dependencies: [],
              kind: "app",
              quality: "proven",
              signals: { uses: 3, score: 2 },
            }],
          }),
        getPattern: () => Promise.resolve(pattern),
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "search",
            name: "search_pattern_index",
            input: { text: "dinner party heading" },
          }]),
        () =>
          assistant("", [{
            id: "inspect",
            name: "inspect_pattern",
            input: { patternId },
          }]),
        () =>
          assistant("", [{
            id: "main",
            name: "open_pattern_file",
            input: { patternId, path: "/main.tsx" },
          }, {
            id: "title",
            name: "open_pattern_file",
            input: { patternId, path: "/title.ts" },
          }]),
        (request) => {
          const inspection = toolOutputs(request, "inspect_pattern")[0];
          const reads = toolOutputs(request, "open_pattern_file");
          return finalResult({
            status: "complete",
            summary: "Run the published dinner-party app directly.",
            recommendation: {
              kind: "direct-run",
              rationale: "Its verified source implements the whole UI.",
            },
            selectedPatternIds: [patternId],
            example: {
              kind: "run-pattern-input",
              content: JSON.stringify({ patternId, inputs: {} }),
              sourceIds: [
                inspection.sourceId,
                ...reads.map((read) => read.sourceId),
              ],
            },
            sourceIds: [
              inspection.sourceId,
              ...reads.map((read) => read.sourceId),
            ],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({
          task: "Build a dinner-party UI.",
          getPatternIndex: () => Promise.resolve(index),
        }),
      );

      expect(reply.kit.status).toBe("complete");
      expect(reply.kit.inputs).toEqual([]);
      expect(reply.kit.patterns[0].patternId).toBe(patternId);
      expect(reply.kit.patterns[0].sourceIdentityVerified).toBe(true);
      expect(reply.kit.patterns[0].files).toEqual([
        "/main.tsx",
        "/title.ts",
      ]);
      expect(reply.record.cfc.coverage).toBe("incomplete");
      expect(reply.record.cfc.missingLabels).toEqual([
        {
          source: "pattern-index-metadata",
          detail:
            `pattern ${patternId} metadata returned by search_pattern_index`,
        },
        {
          source: "pattern-index-metadata",
          detail: `pattern ${patternId} metadata returned by inspect_pattern`,
        },
        {
          source: "pattern-index-source",
          detail: `pattern ${patternId} source returned by inspect_pattern`,
        },
      ]);
      const inspection = toolOutputs(
        model.requests[3],
        "inspect_pattern",
      )[0];
      const evidenceText = JSON.stringify(inspection.evidence);
      expect(inspection.evidence).not.toHaveProperty("argumentSchema");
      expect(inspection.evidence).not.toHaveProperty("resultSchema");
      expect(evidenceText.length).toBeLessThanOrEqual(MAX_RESEARCH_READ_CHARS);
      expect(reply.record.confirmedPatterns[0].argumentSchema).toEqual(
        pattern.argumentSchema,
      );
      expect(JSON.stringify(reply.record.confirmedPatterns[0]).length)
        .toBeGreaterThan(MAX_RESEARCH_READ_CHARS);
      const evidenceDigest = encodeHex(
        sha256(new TextEncoder().encode(evidenceText)),
      );
      const metadataRead = reply.record.sourceReads.find((read) =>
        read.kind === "pattern-metadata"
      );
      expect(metadataRead?.totalChars).toBe(evidenceText.length);
      expect(metadataRead?.digest).toBe(
        `sha256:${evidenceDigest}`,
      );
      expect(
        reply.record.sourceReads.filter((read) =>
          read.kind === "pattern-source"
        ),
      ).toHaveLength(2);
    });

    it("refuses to confirm source whose computed identity differs", async () => {
      const patternId = "wrong-index-identity";
      const pattern: PatternIndexPattern = {
        patternId,
        ownerDid: "did:key:zPublisher",
        createdAt: "2026-09-01T00:00:00.000Z",
        description: "Mismatched source",
        hashtags: [],
        dependencies: [],
        program: {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default 1;\n" }],
        },
      };
      const index: HarnessResearchPatternIndex = {
        searchPatterns: () =>
          Promise.resolve({ results: [] } as PatternIndexSearchResponse),
        getPattern: () => Promise.resolve(pattern),
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "inspect",
            name: "inspect_pattern",
            input: { patternId },
          }]),
        () =>
          finalResult({
            status: "complete",
            recommendation: {
              kind: "direct-run",
              rationale: "Use the claimed id.",
            },
            selectedPatternIds: [patternId],
            example: {
              kind: "run-pattern-input",
              content: JSON.stringify({ patternId, inputs: {} }),
            },
            missing: [],
          }),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ getPatternIndex: () => Promise.resolve(index) }),
      );

      expect(reply.record.confirmedPatterns).toEqual([]);
      expect(reply.kit.patterns).toEqual([]);
      expect(reply.kit.status).toBe("incomplete");
      expect(reply.kit.missing).toContain(
        `pattern ${patternId} was not inspected successfully`,
      );
    });

    it("rejects malformed index inspection responses without retaining evidence", async () => {
      await ensureCompilerStack();
      const base = {
        ownerDid: "did:key:zPublisher",
        createdAt: "2026-09-01T00:00:00.000Z",
        description: "Malformed index fixture",
        hashtags: [],
        dependencies: [],
      };
      const index: HarnessResearchPatternIndex = {
        searchPatterns: () => Promise.resolve({ results: [] }),
        getPattern: ({ patternId }) => {
          if (patternId === "wrong-response") {
            return Promise.resolve({
              ...base,
              patternId: "different-pattern",
            });
          }
          if (patternId === "missing-program") {
            return Promise.resolve({ ...base, patternId });
          }
          return Promise.resolve({
            ...base,
            patternId,
            program: {
              main: "/main.tsx",
              files: [{
                name: "/main.tsx",
                contents:
                  'import value from "./missing.ts";\nexport default value;\n',
              }],
            },
          });
        },
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "wrong-response",
            name: "inspect_pattern",
            input: { patternId: "wrong-response" },
          }, {
            id: "missing-program",
            name: "inspect_pattern",
            input: { patternId: "missing-program" },
          }, {
            id: "incomplete-closure",
            name: "inspect_pattern",
            input: { patternId: "incomplete-closure" },
          }]),
        () => finalResult(),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ getPatternIndex: () => Promise.resolve(index) }),
      );
      const outputs = toolOutputs(model.requests[1], "inspect_pattern");

      expect(outputs).toEqual([{
        error: "pattern index returned different-pattern for wrong-response",
      }, {
        error: "pattern missing-program has no indexed source program",
      }, {
        error:
          "incomplete closure: './missing.ts' imported by '/main.tsx' did not resolve to an included file",
      }]);
      expect(reply.record.sourceReads).toEqual([]);
      expect(reply.record.confirmedPatterns).toEqual([]);
    });

    it("retains deferred fabric-import evidence but refuses direct execution", async () => {
      await ensureCompilerStack();
      const patternId = "fabric-import-pattern";
      const pattern: PatternIndexPattern = {
        patternId,
        ownerDid: "did:key:zPublisher",
        createdAt: "2026-09-01T00:00:00.000Z",
        description: "Composes another published pattern",
        hashtags: ["composition"],
        dependencies: ["dependency-pattern"],
        program: {
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              'import Part from "cf:pattern:dependency-pattern";',
              "export default Part;",
            ].join("\n"),
          }],
        },
      };
      const index: HarnessResearchPatternIndex = {
        searchPatterns: () => Promise.resolve({ results: [] }),
        getPattern: () => Promise.resolve(pattern),
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "inspect",
            name: "inspect_pattern",
            input: { patternId },
          }, {
            id: "missing-file",
            name: "open_pattern_file",
            input: { patternId, path: "/missing.ts" },
          }]),
        (request) => {
          const inspection = toolOutputs(request, "inspect_pattern")[0];
          return finalResult({
            status: "complete",
            recommendation: {
              kind: "direct-run",
              rationale: "Run the inspected pattern.",
            },
            selectedPatternIds: [patternId],
            sourceIds: [inspection.sourceId],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ getPatternIndex: () => Promise.resolve(index) }),
      );
      const inspection = toolOutputs(
        model.requests[1],
        "inspect_pattern",
      )[0];
      const missingFile = toolOutputs(
        model.requests[1],
        "open_pattern_file",
      )[0];

      expect(
        (inspection.evidence as Record<string, unknown>).identityVerification,
      ).toEqual({
        status: "deferred",
        method: "full-fabric-compiler",
        detail:
          "fabric import 'cf:pattern:dependency-pattern' in '/main.tsx' is not supported by the light identity path",
      });
      expect(missingFile).toEqual({
        error: `pattern ${patternId} has no file /missing.ts`,
      });
      expect(reply.record.confirmedPatterns).toHaveLength(1);
      expect(reply.kit.patterns[0]?.identityVerification?.status).toBe(
        "deferred",
      );
      expect(reply.kit.missing).toEqual(expect.arrayContaining([
        "direct-run requires verified published source identities",
        "direct-run requires a complete run_pattern input example",
      ]));
      expect(reply.kit.status).toBe("incomplete");
    });

    it("commits no pattern when its inspection evidence exceeds the read budget", async () => {
      await ensureCompilerStack();
      const files = [{
        name: "/main.tsx",
        contents: "export default 1;\n",
      }];
      const patternId = computeEntryIdentity("/main.tsx", files);
      const pattern: PatternIndexPattern = {
        patternId,
        ownerDid: "did:key:zPublisher",
        createdAt: "2026-09-01T00:00:00.000Z",
        description: "x".repeat(MAX_RESEARCH_READ_CHARS + 1),
        hashtags: [],
        dependencies: [],
        program: { main: "/main.tsx", files },
      };
      const index: HarnessResearchPatternIndex = {
        searchPatterns: () => Promise.resolve({ results: [] }),
        getPattern: () => Promise.resolve(pattern),
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "inspect",
            name: "inspect_pattern",
            input: { patternId },
          }, {
            id: "open-after-refusal",
            name: "open_pattern_file",
            input: { patternId, path: "/main.tsx" },
          }]),
        () =>
          finalResult({
            status: "complete",
            recommendation: {
              kind: "direct-run",
              rationale: "Use the claimed id.",
            },
            selectedPatternIds: [patternId],
            example: {
              kind: "run-pattern-input",
              content: JSON.stringify({ patternId, inputs: {} }),
              sourceIds: [],
            },
            missing: [],
          }),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ getPatternIndex: () => Promise.resolve(index) }),
      );
      const results = toolOutputs(model.requests[1]);

      expect(results[0].error).toContain("read budget");
      expect(results[1].error).toContain("inspect pattern");
      expect(reply.record.sourceReads).toEqual([]);
      expect(reply.record.confirmedPatterns).toEqual([]);
      expect(reply.kit.patterns).toEqual([]);
      expect(reply.kit.status).toBe("incomplete");
    });
  });

  describe("CFC metadata", () => {
    it("retains fail-closed labels and partial evidence when an error cannot be stringified", async () => {
      const token = "cfh:a:label-failed";
      const restrictive = cfcAtom.resource("UnclassifiedInput", "handle");
      const model = new ScriptedModelClient([
        () =>
          assistant("", [
            {
              id: "read",
              name: "open_doc_section",
              input: { sectionId: "section-0" },
            },
            { id: "describe", name: "describe_handle", input: { token } },
          ]),
        () => {
          throw Object.create(null);
        },
      ]);
      let failure: unknown;
      try {
        await createResearchRunner({ modelClient: model })(requestFor({
          corpus: corpusWith([{
            path: "docs/api.md",
            heading: "API",
            text: "Read the contract.",
          }]),
          handleTokens: [token],
          describeHandle: () =>
            Promise.resolve({
              output: {
                outputId: "described",
                token,
                known: true,
                hasSchema: false,
              },
              cfcLabelAvailable: false,
              cfcLabel: { confidentiality: [restrictive] },
            }),
        }));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HarnessResearchError);
      if (!(failure instanceof HarnessResearchError)) {
        throw new Error("expected retained failure evidence");
      }
      expect(failure.message).toBe("error could not be converted to text");
      expect(failure.record.sourceReads).toHaveLength(1);
      expect(failure.record.cfc.sourceLabel.integrity).toEqual([
        operatorProvisionedReferenceAtom("/trusted/docs"),
      ]);
      expect(failure.record.cfc.outputLabel.confidentiality).toContainEqual(
        restrictive,
      );
      expect(failure.record.cfc.coverage).toBe("incomplete");
      expect(failure.record.cfc.missingLabels).toEqual([{
        source: "handle-description",
        detail: `handle ${token} metadata returned by describe_handle`,
      }]);
      expect(
        failure.record.messages.filter((message) => message.role === "tool"),
      ).toHaveLength(2);
    });

    it("separates a complete kit from partial label coverage across all observations", async () => {
      const docsA = operatorProvisionedReferenceAtom("/trusted/docs-a");
      const docsB = operatorProvisionedReferenceAtom("/trusted/docs-b");
      const taskSecret = cfcAtom.resource("ResearchTaskSecret", "task");
      const handleSecret = cfcAtom.resource("HandleSecret", "handle");
      const handleIntegrity = cfcAtom.resource("HandleIntegrity", "handle");
      const corpus = {
        type: "cf-harness.docs-corpus" as const,
        roots: [{ name: "docs-a", hostPath: "/trusted/docs-a" }, {
          name: "docs-b",
          hostPath: "/trusted/docs-b",
        }],
        sections: [{
          path: "docs-a/api.md",
          heading: "Dinner API",
          text: "Use the documented dinner API.",
          integrity: [docsA],
        }, {
          path: "docs-b/unselected.md",
          heading: "Other material",
          text: "This unselected section still influenced lexical ranking.",
          integrity: [docsB],
        }],
        files: 2,
        truncated: false,
      };
      const results: PatternIndexSearchResponse["results"] = [
        "unselected-a",
        "unselected-b",
      ].map((patternId) => ({
        patternId,
        description: `Published lead ${patternId}`,
        hashtags: ["dinner"],
        ownerDid: "did:key:zPublisher",
        createdAt: "2026-09-01T00:00:00.000Z",
        dependencies: [],
        kind: "part" as const,
        quality: "unproven" as const,
      }));
      const index: HarnessResearchPatternIndex = {
        searchPatterns: () => Promise.resolve({ results }),
        getPattern: () => Promise.reject(new Error("not inspected")),
      };
      const token = "cfh:a:labelled";
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "search-docs",
            name: "search_docs",
            input: { query: "dinner API" },
          }, {
            id: "open-doc",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }, {
            id: "search-patterns",
            name: "search_pattern_index",
            input: { text: "dinner" },
          }, {
            id: "describe",
            name: "describe_handle",
            input: { token },
          }]),
        (request) => {
          const read = toolOutputs(request, "open_doc_section")[0];
          return finalResult({
            status: "complete",
            summary: "The focused API rule is established.",
            recommendation: {
              kind: "focused-api",
              rationale: "The exact documentation read states the rule.",
            },
            rules: [{
              rule: "Use the documented dinner API.",
              sourceIds: [read.sourceId],
            }],
            sourceIds: [read.sourceId],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({
          corpus,
          getPatternIndex: () => Promise.resolve(index),
          handleTokens: [token],
          taskCfcLabel: { confidentiality: [taskSecret] },
          describeHandle: () =>
            Promise.resolve({
              output: {
                outputId: "describe-labelled",
                token,
                known: true,
                hasSchema: false,
              },
              cfcLabel: {
                confidentiality: [handleSecret],
                integrity: [handleIntegrity],
              },
              cfcLabelAvailable: true,
            }),
        }),
      );

      expect(reply.kit.status).toBe("complete");
      expect(reply.record.cfc.coverage).toBe("incomplete");
      expect(reply.record.cfc.sourceLabel.confidentiality).toEqual([
        taskSecret,
        handleSecret,
      ]);
      expect(reply.record.cfc.sourceLabel.integrity).toEqual([
        docsA,
        docsB,
        handleIntegrity,
      ]);
      expect(reply.record.cfc.outputLabel).toEqual({
        confidentiality: [taskSecret, handleSecret],
      });
      expect(reply.record.cfc.missingLabels).toEqual([
        {
          source: "pattern-index-metadata",
          detail:
            "pattern unselected-a metadata returned by search_pattern_index",
        },
        {
          source: "pattern-index-metadata",
          detail:
            "pattern unselected-b metadata returned by search_pattern_index",
        },
      ]);
      expect(reply.record.sourceReads[0].cfcLabel).toEqual({
        integrity: [docsA],
      });
    });
  });

  describe("host admission", () => {
    it("drops invented sources and undescribed handles from a claimed complete kit", async () => {
      const claimedResult = () =>
        finalResult({
          status: "complete",
          recommendation: {
            kind: "author",
            rationale: "Write a new pattern.",
          },
          inputs: [{
            name: "mail",
            token: "cfh:a:fake2",
            purpose: "Read mail",
          }],
          example: {
            kind: "pattern-source",
            content: "export default 1;",
          },
          sourceIds: ["documentation:invented"],
          missing: [],
        });
      const model = new ScriptedModelClient([claimedResult, claimedResult]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor(),
      );

      expect(reply.kit.status).toBe("incomplete");
      expect(model.requests).toHaveLength(2);
      expect(reply.kit.inputs).toEqual([]);
      expect(reply.kit.sources).toEqual([]);
      expect(reply.kit.missing).toContain(
        "handle cfh:a:fake2 was not described",
      );
      expect(reply.kit.missing).toContain(
        "source documentation:invented was not read",
      );
    });

    it("preserves an explicit missing grant in an incomplete kit", async () => {
      const model = new ScriptedModelClient([
        () =>
          finalResult({
            missing: ["mail database handle was not granted"],
          }),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ task: "Research a monthly mail digest." }),
      );

      expect(reply.kit.status).toBe("incomplete");
      expect(reply.kit.missing).toContain(
        "mail database handle was not granted",
      );
    });

    it("rejects a binding whose handle description returned an error", async () => {
      const token = "cfh:a:stale";
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "describe-stale",
            name: "describe_handle",
            input: { token },
          }]),
        () =>
          finalResult({
            status: "complete",
            recommendation: {
              kind: "author",
              rationale: "Write a pattern over the supplied input.",
            },
            inputs: [{ name: "mail", token, purpose: "Read mail" }],
            example: {
              kind: "pattern-source",
              content: "export default 1;",
            },
            missing: [],
          }),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({
          handleTokens: [token],
          describeHandle: () =>
            Promise.resolve({
              output: {
                outputId: "describe-error",
                token,
                known: true,
                hasSchema: false,
                error: "referent is no longer available",
              },
              cfcLabelAvailable: false,
            }),
        }),
      );

      expect(reply.record.describedHandles).toEqual([]);
      expect(reply.kit.inputs).toEqual([]);
      expect(reply.kit.status).toBe("incomplete");
      expect(reply.kit.missing).toContain(
        `handle ${token} was not described`,
      );
      const described = toolOutputs(
        model.requests[1],
        "describe_handle",
      )[0];
      expect(described.error).toBe("referent is no longer available");
    });

    it("reports malformed bindings and admits none of them", async () => {
      const token = "cfh:a:mail2";
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Pattern contract",
        text: "Use the documented pattern contract.",
      }]);
      const malformedResult = (request: HarnessModelTurnRequest) => {
        const read = toolOutputs(request, "open_doc_section")[0];
        return finalResult({
          status: "complete",
          recommendation: {
            kind: "author",
            rationale: "The documented contract supports new source.",
          },
          inputs: [{
            name: "mail",
            purpose: "Read mail",
          }, {
            name: "   ",
            token,
            purpose: "Read mail",
          }, {
            name: "mail",
            token,
            purpose: "   ",
          }],
          example: {
            kind: "pattern-source",
            content: "export default 1;",
            sourceIds: [read.sourceId, "documentation:unread"],
          },
          sourceIds: [read.sourceId],
          missing: [],
        });
      };
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "describe",
            name: "describe_handle",
            input: { token },
          }, {
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        malformedResult,
        malformedResult,
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({
          corpus,
          handleTokens: [token],
          describeHandle: () =>
            Promise.resolve({
              output: {
                outputId: "describe-mail",
                token,
                known: true,
                hasSchema: false,
              },
              cfcLabelAvailable: false,
            }),
        }),
      );

      expect(reply.kit.inputs).toEqual([]);
      expect(reply.kit.missing).toContain(
        "an input binding has no nonempty handle token",
      );
      expect(reply.kit.missing).toContain(
        `handle ${token} has no nonempty input name`,
      );
      expect(reply.kit.missing).toContain(
        `handle ${token} has no nonempty binding purpose`,
      );
      expect(reply.kit.missing).toContain(
        "the example cited one or more unread sources",
      );
      expect(reply.kit.example?.sourceIds).toHaveLength(1);
      expect(model.requests).toHaveLength(3);
      expect(reply.kit.status).toBe("incomplete");
    });

    it("returns no clipped prefix for an example above the size limit", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Pattern contract",
        text: "Use the documented pattern contract.",
      }]);
      const oversizedExample = "x".repeat(MAX_RESEARCH_EXAMPLE_CHARS + 1);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        (request) => {
          const read = toolOutputs(request, "open_doc_section")[0];
          return finalResult({
            status: "complete",
            recommendation: {
              kind: "author",
              rationale: "The documented contract supports new source.",
            },
            example: {
              kind: "pattern-source",
              content: oversizedExample,
              sourceIds: [read.sourceId],
            },
            sourceIds: [read.sourceId],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );

      expect(reply.kit.example).toBeUndefined();
      expect(reply.kit.missing).toContain(
        `complete example exceeds ${MAX_RESEARCH_EXAMPLE_CHARS} characters`,
      );
      expect(reply.kit.status).toBe("incomplete");
    });

    it("retains complete source and exact parser diagnostics for invalid syntax", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Pattern contract",
        text: "Import pattern and Writable from commonfabric.",
      }]);
      const source = [
        'import { new Writable, pattern } from "commonfabric";',
        "export default pattern(() => ({ value: new Writable(0) }));",
      ].join("\n");
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        (request) => {
          const read = toolOutputs(request, "open_doc_section")[0];
          return finalResult({
            status: "complete",
            recommendation: {
              kind: "author",
              rationale: "The documented contract supports new source.",
            },
            example: {
              kind: "pattern-source",
              content: source,
              sourceIds: [read.sourceId],
            },
            sourceIds: [read.sourceId],
            missing: [],
          });
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus }),
      );

      expect(reply.kit.example?.content).toBe(source);
      expect(reply.kit.example?.sourceIds).toHaveLength(1);
      expect(reply.kit.example?.syntax).toEqual({
        status: "invalid",
        scope: "syntax-only",
        diagnostics: [{
          code: 1003,
          message: "Identifier expected.",
          line: 1,
          column: 10,
        }, {
          code: 1005,
          message: "',' expected.",
          line: 1,
          column: 14,
        }],
      });
      expect(reply.kit.missing).toEqual(expect.arrayContaining([
        "pattern-source example has a syntax error: TS1003 at 1:10: Identifier expected.",
        "pattern-source example has a syntax error: TS1005 at 1:14: ',' expected.",
      ]));
      expect(reply.kit.status).toBe("incomplete");
      expect(researchKitGuidance(reply.kit)).toContain(
        "Correct those errors locally without repeating research",
      );
      expect(researchKitGuidance(reply.kit)).toContain(
        "Syntax acceptance alone will not establish",
      );
    });
  });

  describe("bounded execution", () => {
    it("stops before the first model turn when already cancelled", async () => {
      const abort = new AbortController();
      abort.abort(new Error("cancel before research"));
      const model = new ScriptedModelClient([() => finalResult()]);

      let failure: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: model })(requestFor({
          signal: abort.signal,
        }));
      } catch (error) {
        if (error instanceof HarnessResearchError) failure = error;
      }

      expect(model.requests).toEqual([]);
      expect(failure?.message).toBe("cancel before research");
      expect(failure?.record.budgets).toEqual({
        modelTurns: 0,
        toolCalls: 0,
        readChars: 0,
      });
    });

    it("reserves the final model turn for tool-free synthesis", async () => {
      const steps: ModelStep[] = Array.from(
        { length: MAX_RESEARCH_MODEL_TURNS - 1 },
        (_, index) => () =>
          assistant("", [{
            id: `search-${index}`,
            name: "search_docs",
            input: { query: "absent contract" },
          }]),
      );
      steps.push(() => finalResult());
      const model = new ScriptedModelClient(steps);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ corpus: corpusWith([]) }),
      );

      expect(model.requests).toHaveLength(MAX_RESEARCH_MODEL_TURNS);
      expect(model.requests.at(-1)?.tools).toEqual([]);
      expect(model.requests.at(-1)?.transcript.at(-1)?.role).toBe("user");
      expect(model.requests.at(-1)?.transcript.at(-1)?.content).toContain(
        "Current citable source catalog",
      );
      expect(reply.kit.status).toBe("incomplete");
    });

    it("reports calls beyond the private tool budget without executing them", async () => {
      const model = new ScriptedModelClient([
        () =>
          assistant(
            "",
            Array.from(
              { length: MAX_RESEARCH_TOOL_CALLS + 1 },
              (_, index) => ({
                id: `inventory-${index}`,
                name: "list_handles",
                input: {},
              }),
            ),
          ),
        () => finalResult(),
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor(),
      );
      const outputs = toolOutputs(model.requests[1], "list_handles");

      expect(outputs).toHaveLength(MAX_RESEARCH_TOOL_CALLS + 1);
      expect(outputs.at(-1)).toEqual({
        error:
          `research tool-call budget of ${MAX_RESEARCH_TOOL_CALLS} is exhausted`,
      });
      expect(reply.record.budgets).toEqual({
        modelTurns: 2,
        toolCalls: MAX_RESEARCH_TOOL_CALLS,
        readChars: 0,
      });
    });

    it("fails after a tool call on the reserved synthesis turn", async () => {
      const model = new ScriptedModelClient(
        Array.from(
          { length: MAX_RESEARCH_MODEL_TURNS },
          (_, index) => () =>
            assistant("", [{
              id: `inventory-${index}`,
              name: "list_handles",
              input: {},
            }]),
        ),
      );

      let failure: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: model })(requestFor());
      } catch (error) {
        if (error instanceof HarnessResearchError) failure = error;
      }
      if (failure === undefined) {
        throw new Error("expected synthesis-turn tool use to fail research");
      }
      const finalTool = failure.record.messages.at(-1);
      if (finalTool?.role !== "tool") {
        throw new Error("expected paired synthesis-turn tool result");
      }

      expect(model.requests).toHaveLength(MAX_RESEARCH_MODEL_TURNS);
      expect(model.requests.at(-1)?.tools).toEqual([]);
      expect(JSON.parse(finalTool.content)).toEqual({
        error: "private tools are withheld on the synthesis turn",
      });
      expect(failure.message).toBe(
        `research exceeded ${MAX_RESEARCH_MODEL_TURNS} model turns without a final kit`,
      );
      expect(failure.record.budgets).toEqual({
        modelTurns: MAX_RESEARCH_MODEL_TURNS,
        toolCalls: MAX_RESEARCH_MODEL_TURNS - 1,
        readChars: 0,
      });
    });

    it("carries exact reads when final JSON is malformed", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Contract",
        text: "Use the exact API contract.",
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        () => assistant("not json"),
      ]);

      let failure: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: model })(
          requestFor({ corpus }),
        );
      } catch (error) {
        if (error instanceof HarnessResearchError) failure = error;
      }

      expect(failure).toBeInstanceOf(HarnessResearchError);
      if (failure === undefined) {
        throw new Error("expected malformed JSON to fail research");
      }
      expect(failure.name).toBe("HarnessResearchError");
      expect(Object.keys(failure)).toEqual([]);
      expect(failure?.message).toContain("not valid JSON");
      expect(failure?.record.sourceReads).toHaveLength(1);
      expect(
        failure?.record.messages.filter((message) => message.role === "tool"),
      ).toHaveLength(1);
    });

    it("preserves an existing research failure without wrapping it again", async () => {
      const failingModel = new ScriptedModelClient([() => {
        throw new Error("initial research failure");
      }]);
      let existing: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: failingModel })(requestFor());
      } catch (error) {
        if (error instanceof HarnessResearchError) existing = error;
      }
      if (existing === undefined) {
        throw new Error("expected an initial research failure");
      }
      const forwardingModel = new ScriptedModelClient([() => {
        throw existing;
      }]);
      let forwarded: unknown;
      try {
        await createResearchRunner({ modelClient: forwardingModel })(
          requestFor(),
        );
      } catch (error) {
        forwarded = error;
      }

      expect(forwarded).toBe(existing);
    });

    it("carries partial provenance when the provider fails after a read", async () => {
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Contract",
        text: "Use the exact API contract.",
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        () => {
          throw new Error("provider unavailable");
        },
      ]);

      let failure: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: model })(
          requestFor({ corpus }),
        );
      } catch (error) {
        if (error instanceof HarnessResearchError) failure = error;
      }

      expect(failure?.message).toContain("provider unavailable");
      expect(failure?.record.sourceReads[0].location).toContain("docs/api.md");
      expect(failure?.record.budgets.modelTurns).toBe(1);
    });

    it("stops before citation repair when cancellation follows the candidate", async () => {
      const abort = new AbortController();
      const corpus = corpusWith([{
        path: "docs/api.md",
        heading: "Contract",
        text: "Use the exact API contract.",
      }]);
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "read",
            name: "open_doc_section",
            input: { sectionId: "section-0" },
          }]),
        () => {
          abort.abort(new Error("cancel before citation repair"));
          return finalResult({
            status: "complete",
            sourceIds: ["documentation:unread"],
            missing: [],
          });
        },
      ]);

      let failure: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: model })(requestFor({
          corpus,
          signal: abort.signal,
        }));
      } catch (error) {
        if (error instanceof HarnessResearchError) failure = error;
      }

      expect(model.requests).toHaveLength(2);
      expect(failure?.message).toBe("cancel before citation repair");
      expect(failure?.record.sourceReads).toHaveLength(1);
      expect(failure?.record.budgets).toEqual({
        modelTurns: 2,
        toolCalls: 1,
        readChars: 27,
      });
      expect(
        failure?.record.messages.some((message) =>
          message.role === "user" &&
          message.content.includes("Citation repair turn")
        ),
      ).toBe(false);
    });

    for (const repairing of [false, true]) {
      it(`retains the response but cancels admission during awaited ${repairing ? "citation repair" : "synthesis"} usage`, async () => {
        const abort = new AbortController();
        const waiting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const usage: (number | undefined)[] = [];
        const finalTurn = repairing ? 3 : 2;
        const corpus = corpusWith([{
          path: "docs/api.md",
          heading: "Contract",
          text: "Use the exact API contract.",
        }]);
        const model = new ScriptedModelClient([
          () =>
            assistant("", [{
              id: "read",
              name: "open_doc_section",
              input: { sectionId: "section-0" },
            }]),
          ...(repairing
            ? [() =>
              finalResult({
                status: "complete",
                sourceIds: ["documentation:unread"],
                missing: [],
              })]
            : []),
          () => ({ ...finalResult(), usage: { totalTokens: 17 } }),
        ]);
        const pending = createResearchRunner({
          modelClient: model,
          onUsage: async (entry) => {
            usage.push(entry?.totalTokens);
            if (usage.length === finalTurn) {
              waiting.resolve();
              await release.promise;
            }
          },
        })(requestFor({ corpus, signal: abort.signal })).then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await Promise.race([
            waiting.promise,
            pending.then(() => {
              throw new Error(
                "research ended before its usage callback waited",
              );
            }),
          ]);
          abort.abort(new Error("cancel during usage delivery"));
          release.resolve();
          const failure = await pending;
          expect(failure).toBeInstanceOf(HarnessResearchError);
          if (!(failure instanceof HarnessResearchError)) {
            throw new Error("research admitted a canceled response");
          }
          expect(failure.message).toBe("cancel during usage delivery");
          expect(failure.record.budgets).toEqual({
            modelTurns: finalTurn,
            toolCalls: 1,
            readChars: 27,
          });
          expect(failure.record.sourceReads).toHaveLength(1);
          expect(failure.record.messages.at(-1)).toEqual(
            finalResult().assistant,
          );
          expect(usage).toEqual(
            repairing ? [undefined, undefined, 17] : [undefined, 17],
          );
        } finally {
          release.resolve();
          await pending;
        }
      });
    }

    it("pairs current and pending calls when cancellation interrupts a tool", async () => {
      const abort = new AbortController();
      let descriptions = 0;
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "first",
            name: "describe_handle",
            input: { token: "cfh:a:first" },
          }, {
            id: "second",
            name: "describe_handle",
            input: { token: "cfh:a:second" },
          }]),
      ]);

      let failure: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: model })(requestFor({
          handleTokens: ["cfh:a:first", "cfh:a:second"],
          signal: abort.signal,
          describeHandle: (token) => {
            descriptions += 1;
            abort.abort("stop research");
            throw new Error(`description failed for ${token}`);
          },
        }));
      } catch (error) {
        if (error instanceof HarnessResearchError) failure = error;
      }

      expect(descriptions).toBe(1);
      const results =
        failure?.record.messages.filter((message) => message.role === "tool") ??
          [];
      expect(results).toHaveLength(2);
      expect(results[0].role === "tool" ? results[0].content : "").toContain(
        "cancelled during",
      );
      expect(results[1].role === "tool" ? results[1].content : "").toContain(
        "cancelled before",
      );
    });

    it("pairs pending calls after a successful tool cancels the run", async () => {
      const abort = new AbortController();
      let descriptions = 0;
      const model = new ScriptedModelClient([
        () =>
          assistant("", [{
            id: "first",
            name: "describe_handle",
            input: { token: "cfh:a:first" },
          }, {
            id: "second",
            name: "describe_handle",
            input: { token: "cfh:a:second" },
          }]),
      ]);

      let failure: HarnessResearchError | undefined;
      try {
        await createResearchRunner({ modelClient: model })(requestFor({
          handleTokens: ["cfh:a:first", "cfh:a:second"],
          signal: abort.signal,
          describeHandle: (token) => {
            descriptions += 1;
            abort.abort("stop research");
            return Promise.resolve({
              output: {
                outputId: `describe-${descriptions}`,
                token,
                known: true,
                hasSchema: false,
              },
              cfcLabelAvailable: false,
            });
          },
        }));
      } catch (error) {
        if (error instanceof HarnessResearchError) failure = error;
      }

      const results =
        failure?.record.messages.filter((message) => message.role === "tool") ??
          [];
      expect(descriptions).toBe(1);
      expect(results.map((message) => JSON.parse(message.content))).toEqual([{
        outputId: "describe-1",
        token: "cfh:a:first",
        known: true,
        hasSchema: false,
      }, {
        error: "research cancelled before this call executed",
      }]);
      expect(failure?.message).toBe("stop research");
      expect(failure?.record.budgets).toEqual({
        modelTurns: 1,
        toolCalls: 1,
        readChars: 0,
      });
    });

    it("reports private usage through the parent accounting hook", async () => {
      const usage: (number | undefined)[] = [];
      const model = new ScriptedModelClient([
        () => ({
          ...finalResult(),
          usage: { totalTokens: 17 },
        }),
      ]);

      await createResearchRunner({
        modelClient: model,
        onUsage: (entry) => {
          usage.push(entry?.totalTokens);
        },
      })(requestFor());

      expect(usage).toEqual([17]);
    });

    it("presents attached patterns as trusted leads that still require inspection", async () => {
      const model = new ScriptedModelClient([
        (request) => {
          const user = request.transcript.find((message) =>
            message.role === "user"
          );
          expect(user?.content).toContain(
            "Authoritative index-resolved pattern attachments",
          );
          expect(user?.content).toContain("attached-checklist");
          const attachments = user?.content.split("\n").find((line) =>
            line.startsWith('[{"patternId":"attached-checklist"')
          );
          expect(JSON.parse(attachments ?? "[]")).toEqual([
            expect.objectContaining({
              patternId: "attached-checklist",
              importHint:
                'import CheckList from "cf:pattern:attached-checklist"',
            }),
          ]);
          expect(user?.content).toContain("trusted search leads");
          expect(user?.content).toContain(
            "Call inspect_pattern before selecting one",
          );
          return finalResult();
        },
      ]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({
          attachedPatterns: [{
            patternId: "attached-checklist",
            description: "A reusable checklist.",
            hashtags: ["checklist"],
            importHint: 'import CheckList from "cf:pattern:attached-checklist"',
            kind: "part",
            quality: "proven",
            argumentType: "{ items: CheckItem[] }",
            resultType: "{ items: CheckItem[]; ui: VNode }",
          }],
        }),
      );

      expect(model.requests).toHaveLength(1);
      expect(reply.record.cfc).toEqual({
        version: 1,
        sourceLabel: {},
        outputLabel: {},
        coverage: "incomplete",
        missingLabels: [{
          source: "pattern-index-metadata",
          detail:
            "pattern attached-checklist metadata supplied as a task attachment",
        }],
      });
    });

    it("includes prior kits in a focused follow-up prompt", async () => {
      const priorSecret = cfcAtom.resource("PriorResearchSecret", "prior");
      const prior = {
        type: "cf-harness.research-run" as const,
        researchRunId: "prior-research",
        outputId: "prior-output",
        kit: {
          status: "incomplete" as const,
          task: "Initial task",
          summary: "Need the mail grant.",
          recommendation: {
            kind: "author" as const,
            rationale: "No reusable pattern was found.",
          },
          inputs: [],
          patterns: [],
          steps: [],
          rules: [],
          verification: [],
          sources: [],
          missing: ["mail grant"],
        },
        confirmedPatterns: [],
        describedHandles: [],
        cfc: {
          version: 1 as const,
          sourceLabel: { confidentiality: [priorSecret] },
          outputLabel: { confidentiality: [priorSecret] },
          coverage: "incomplete" as const,
          missingLabels: [{
            source: "pattern-index-source" as const,
            detail: "pattern prior source returned by inspect_pattern",
          }],
        },
        completedAt: "2026-09-14T00:00:00.000Z",
      } satisfies HarnessResearchRunSummary;
      const model = new ScriptedModelClient([() => finalResult()]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({
          task: "Follow up after receiving mail.",
          priorResearchRuns: [prior],
        }),
      );

      const user = model.requests[0].transcript.find((message) =>
        message.role === "user"
      );
      const system = model.requests[0].transcript.find((message) =>
        message.role === "system"
      );
      expect(user?.content).toContain("prior-research");
      expect(user?.content).toContain("mail grant");
      expect(user?.content).toContain("not citations for this fresh research");
      expect(user?.content).toContain("section-N");
      expect(system?.content).toContain(
        "outputId returned by describe_handle records binding provenance only",
      );
      expect(system?.content).toContain(
        "Only an exact value returned in a field named sourceId",
      );
      expect(reply.record.cfc).toEqual(prior.cfc);
    });

    it("records missing CFC coverage for a legacy prior kit", async () => {
      const legacyPrior = {
        type: "cf-harness.research-run" as const,
        researchRunId: "legacy-prior-research",
        outputId: "legacy-prior-output",
        kit: {
          status: "incomplete" as const,
          task: "Initial task",
          summary: "Use the previously researched checklist rules.",
          recommendation: {
            kind: "author" as const,
            rationale: "A small authored composition remains appropriate.",
          },
          inputs: [],
          patterns: [],
          steps: [],
          rules: [{
            rule: "Preserve the researched checklist behavior.",
            sourceIds: [],
          }],
          verification: [],
          sources: [],
          missing: ["exact composition"],
        },
        confirmedPatterns: [],
        describedHandles: [],
        completedAt: "2026-09-13T00:00:00.000Z",
      } satisfies HarnessResearchRunSummary;
      const model = new ScriptedModelClient([() => finalResult()]);

      const reply = await createResearchRunner({ modelClient: model })(
        requestFor({ priorResearchRuns: [legacyPrior] }),
      );

      const user = model.requests[0].transcript.find((message) =>
        message.role === "user"
      );
      expect(user?.content).toContain("legacy-prior-research");
      expect(user?.content).toContain(
        "Preserve the researched checklist behavior.",
      );
      expect(reply.kit.status).toBe("incomplete");
      expect(reply.record.cfc).toEqual({
        version: 1,
        sourceLabel: {},
        outputLabel: {},
        coverage: "incomplete",
        missingLabels: [{
          source: "prior-research",
          detail:
            "prior research run legacy-prior-research summary did not retain CFC metadata",
        }],
      });
    });
  });
});
