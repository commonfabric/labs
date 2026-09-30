/**
 * A parent's selected pattern references cross delegation from the trusted
 * record, not from model-retyped metadata or a delegation-time fetch. The
 * record is one the parent searched for, or one the task attached by id and
 * the run resolved before its first model turn.
 */

import { describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";

import { Identity } from "@commonfabric/identity";
import {
  computeEntryIdentity,
  ensureCompilerStack,
} from "@commonfabric/runner";

import { CfHarnessEngine } from "../src/engine.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import {
  HARNESS_RESEARCH_HANDLE_TYPE,
  type HarnessResearchHandleValue,
  type HarnessResearchRunSummary,
} from "../src/contracts/research.ts";
import {
  createHarnessHandleTable,
  mintReferentHandle,
} from "../src/handle-table.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

const signer = await Identity.fromPassphrase(
  "cf-harness prompt-loop pattern refs",
);

// Marks each prompt below as one a person typed. `search_patterns` and
// `delegate_task` dispatch under that authorization.
const directPromptSlotBinding = directPromptSlotBindingFor("pattern-refs");

const SEARCH_HIT = {
  patternId: "pat-expenses",
  description: "Totals an expense list",
  hashtags: ["expenses", "money"],
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  dependencies: [],
  signals: { uses: 12, score: 2 },
  quality: "proven",
  kind: "part",
  matchedTerms: 2,
  queryTerms: 3,
};

const PATTERN_RECORD = {
  patternId: SEARCH_HIT.patternId,
  ownerDid: SEARCH_HIT.ownerDid,
  createdAt: SEARCH_HIT.createdAt,
  description: SEARCH_HIT.description,
  hashtags: SEARCH_HIT.hashtags,
  dependencies: [],
  argumentSchema: {
    type: "object",
    properties: {
      amounts: { type: "array", items: { type: "number" } },
    },
    required: ["amounts"],
  },
  resultSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
  },
};

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const toolCallTurn = (
  id: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }],
    },
  }],
});

const assistantTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

interface IndexStub {
  fetchFn: HarnessFetch;
  calls: string[];
}

/** Index fixture which records every endpoint call. */
const stubIndex = (): IndexStub => {
  const calls: string[] = [];
  const fetchFn: HarnessFetch = (input) => {
    const fn = String(input).split("/").pop() ?? "";
    calls.push(fn);
    return Promise.resolve(
      new Response(
        JSON.stringify(
          fn === "searchPatterns"
            ? { results: [SEARCH_HIT] }
            : fn === "listPatterns"
            ? { patterns: [], eventTypes: {} }
            : PATTERN_RECORD,
        ),
        { status: 200 },
      ),
    );
  };
  return { fetchFn, calls };
};

interface DelegationFixture {
  childPrompt: string;
  indexCalls: readonly string[];
  delegateOutput: Record<string, unknown>;
  subagentRuns: number;
}

/** Runs one parent search followed by one pattern-reference delegation. */
const runDelegation = async (
  patternRefs: readonly Record<string, unknown>[],
): Promise<DelegationFixture> => {
  const index = stubIndex();
  const modelRequests: unknown[] = [];
  const modelTurns = [
    toolCallTurn("call-search", "search_patterns", {
      text: "expense list totals",
    }),
    toolCallTurn("call-delegate", "delegate_task", {
      goal: "Use the selected pattern metadata to plan the focused task.",
      context: "Keep the answer concise.",
      patternRefs,
    }),
    assistantTurn("Child completed the focused task."),
    assistantTurn("Parent received the delegation result."),
  ];
  const fetchFn: typeof fetch = (_input, init) => {
    modelRequests.push(JSON.parse(String(init?.body)));
    const turn = modelTurns[modelRequests.length - 1];
    if (turn === undefined) {
      throw new Error("scripted model ran out of turns");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
        status: 200,
      }),
    );
  };
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `run-pattern-refs-${crypto.randomUUID()}`,
    model: "gpt-5.4",
    patternIndexClientFactory: () =>
      Promise.resolve(
        new PatternIndexClient({
          baseUrl: "https://index.test",
          fetchFn: index.fetchFn,
          signer,
        }),
      ),
  });
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["search_patterns", "delegate_task"],
    allowedSubagentProfiles: ["default"],
    fetchFn,
  });

  const result = await loop.runPrompt({
    prompt: "Search, then delegate.",
    promptSlotBinding: directPromptSlotBinding,
  });
  const delegateMessage = result.transcript.find((message) =>
    message.role === "tool" && message.toolName === "delegate_task"
  );
  if (delegateMessage?.role !== "tool") {
    throw new Error("expected a `delegate_task` tool result");
  }
  const childRequest = modelRequests[2] === undefined
    ? undefined
    : chatViewOfRequest(modelRequests[2]);

  return {
    childPrompt: childRequest?.messages.at(-1)?.content ?? "",
    indexCalls: index.calls,
    delegateOutput: JSON.parse(delegateMessage.content),
    subagentRuns: result.runState.subagentRuns?.length ?? 0,
  };
};

/** Starts a fresh parent loop over a transcript whose earlier loop searched. */
const runResumedDelegation = async (
  includeMalformedSearchResult = false,
): Promise<DelegationFixture> => {
  const index = stubIndex();
  const firstRequests: unknown[] = [];
  const firstTurns = [
    toolCallTurn("call-search", "search_patterns", {
      text: "expense list totals",
    }),
    assistantTurn("Search complete."),
  ];
  const firstFetch: typeof fetch = (_input, init) => {
    firstRequests.push(JSON.parse(String(init?.body)));
    const turn = firstTurns[firstRequests.length - 1];
    if (turn === undefined) {
      throw new Error("first scripted model ran out of turns");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
        status: 200,
      }),
    );
  };
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `run-pattern-refs-resume-${crypto.randomUUID()}`,
    model: "gpt-5.4",
    patternIndexClientFactory: () =>
      Promise.resolve(
        new PatternIndexClient({
          baseUrl: "https://index.test",
          fetchFn: index.fetchFn,
          signer,
        }),
      ),
  });
  const firstLoop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["search_patterns", "delegate_task"],
    allowedSubagentProfiles: ["default"],
    fetchFn: firstFetch,
  });
  const firstResult = await firstLoop.runPrompt({
    prompt: "Search first.",
    promptSlotBinding: directPromptSlotBinding,
  });

  const resumedRequests: unknown[] = [];
  const resumedTurns = [
    toolCallTurn("call-delegate", "delegate_task", {
      goal: "Use the pattern searched before this parent loop resumed.",
      patternRefs: [{ patternId: SEARCH_HIT.patternId }],
    }),
    assistantTurn("Child completed the resumed task."),
    assistantTurn("Parent received the resumed delegation result."),
  ];
  const resumedFetch: typeof fetch = (_input, init) => {
    resumedRequests.push(JSON.parse(String(init?.body)));
    const turn = resumedTurns[resumedRequests.length - 1];
    if (turn === undefined) {
      throw new Error("resumed scripted model ran out of turns");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
        status: 200,
      }),
    );
  };
  const resumedLoop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["search_patterns", "delegate_task"],
    allowedSubagentProfiles: ["default"],
    fetchFn: resumedFetch,
  });
  const result = await resumedLoop.runTranscript({
    transcript: [
      ...firstResult.transcript,
      ...(includeMalformedSearchResult
        ? [{
          role: "tool" as const,
          toolCallId: "malformed-search",
          toolName: "search_patterns",
          content: "not JSON",
        }]
        : []),
      { role: "user", content: "Delegate using the earlier search." },
    ],
    promptSlotBinding: directPromptSlotBinding,
  });
  const delegateMessage = result.transcript.findLast((message) =>
    message.role === "tool" && message.toolName === "delegate_task"
  );
  if (delegateMessage?.role !== "tool") {
    throw new Error("expected a resumed `delegate_task` tool result");
  }
  const childRequest = resumedRequests[1] === undefined
    ? undefined
    : chatViewOfRequest(resumedRequests[1]);
  return {
    childPrompt: childRequest?.messages.at(-1)?.content ?? "",
    indexCalls: index.calls,
    delegateOutput: JSON.parse(delegateMessage.content),
    subagentRuns: result.runState.subagentRuns?.length ?? 0,
  };
};

/** Runs one delegation over the patterns the task attached, with no search. */
const runAttachedDelegation = async (): Promise<
  DelegationFixture & {
    recorded: readonly string[];
    openedResearch: boolean;
  }
> => {
  const index = stubIndex();
  const modelRequests: unknown[] = [];
  const modelTurns = [
    toolCallTurn("call-delegate", "delegate_task", {
      goal: "Use the attached pattern to plan the focused task.",
      patternRefs: [{ patternId: SEARCH_HIT.patternId }],
    }),
    assistantTurn("Child completed the focused task."),
    assistantTurn("Parent received the delegation result."),
  ];
  const fetchFn: typeof fetch = (_input, init) => {
    modelRequests.push(JSON.parse(String(init?.body)));
    const turn = modelTurns[modelRequests.length - 1];
    if (turn === undefined) {
      throw new Error("scripted model ran out of turns");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
        status: 200,
      }),
    );
  };
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `run-attached-pattern-refs-${crypto.randomUUID()}`,
    model: "gpt-5.4",
    cfcEnforcementMode: "disabled",
    patternRefs: [{ patternId: SEARCH_HIT.patternId }],
    patternIndexClientFactory: () =>
      Promise.resolve(
        new PatternIndexClient({
          baseUrl: "https://index.test",
          fetchFn: index.fetchFn,
          signer,
        }),
      ),
  });
  // What the session context does before a turn's first model turn.
  await engine.establishPatternRefs();
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["search_patterns", "delegate_task", "research"],
    allowedSubagentProfiles: ["default"],
    fetchFn,
  });

  const result = await loop.runPrompt({
    prompt: "Delegate over it.",
    openingResearchTask: "Delegate over it.",
  });
  const delegateMessage = result.transcript.find((message) =>
    message.role === "tool" && message.toolName === "delegate_task"
  );
  if (delegateMessage?.role !== "tool") {
    throw new Error("expected a `delegate_task` tool result");
  }
  const childRequest = modelRequests[1] === undefined
    ? undefined
    : chatViewOfRequest(modelRequests[1]);

  return {
    childPrompt: childRequest?.messages.at(-1)?.content ?? "",
    indexCalls: index.calls,
    delegateOutput: JSON.parse(delegateMessage.content),
    subagentRuns: result.runState.subagentRuns?.length ?? 0,
    recorded: (result.runState.patternRefs ?? []).map((ref) => ref.patternId),
    openedResearch: result.runState.openingResearch !== undefined,
  };
};

describe("prompt-loop pattern references", () => {
  for (const inspected of [true, false]) {
    const name = inspected
      ? "delegates a pattern inspected by the opening research pass"
      : "delegates an orientation lead without claiming source inspection";
    it(name, async () => {
      await ensureCompilerStack();
      const files = [{ name: "/main.tsx", contents: "export default 1;\n" }];
      const patternId = computeEntryIdentity("/main.tsx", files);
      const runId = "run-opening-pattern-delegation";
      const task = "Inspect the indexed pattern and delegate its use.";
      const indexCalls: string[] = [];
      const requests: HarnessModelTurnRequest[] = [];
      let researchTurns = 0;
      let parentTurns = 0;
      const loop = new CfHarnessPromptLoop({
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId,
          model: "gpt-test",
          patternIndexClientFactory: () =>
            Promise.resolve(
              new PatternIndexClient({
                baseUrl: "https://index.test",
                signer,
                fetchFn: (input) => {
                  const fn = String(input).split("/").pop() ?? "";
                  indexCalls.push(fn);
                  return Promise.resolve(
                    new Response(
                      JSON.stringify(
                        fn === "listPatterns"
                          ? { patterns: [], eventTypes: {} }
                          : inspected
                          ? {
                            ...PATTERN_RECORD,
                            patternId,
                            program: { main: "/main.tsx", files },
                          }
                          : { results: [{ ...SEARCH_HIT, patternId }] },
                      ),
                      { status: 200 },
                    ),
                  );
                },
              }),
            ),
        }),
        allowedToolIds: ["research", "delegate_task"],
        allowedSubagentProfiles: ["default"],
        modelClient: {
          providerId: "test-provider",
          complete: (request) => {
            requests.push({
              ...request,
              transcript: structuredClone(request.transcript),
            });
            if (request.runId.includes(":research:")) {
              researchTurns += 1;
              return Promise.resolve(
                researchTurns === 1
                  ? {
                    assistant: {
                      role: "assistant",
                      content: "",
                      toolCalls: [{
                        id: "research-pattern",
                        type: "function",
                        function: {
                          name: inspected
                            ? "inspect_pattern"
                            : "search_pattern_index",
                          arguments: JSON.stringify(
                            inspected ? { patternId } : { text: "expense" },
                          ),
                        },
                      }],
                    },
                  }
                  : {
                    assistant: {
                      role: "assistant",
                      content: JSON.stringify({
                        status: "incomplete",
                        summary: inspected
                          ? "The indexed source is confirmed; inspect the caller's requirements next."
                          : "The index returned a candidate whose applicability needs inspection.",
                        inputs: [],
                        selectedPatternIds: inspected ? [patternId] : [],
                        leads: inspected ? [] : [{
                          patternId,
                          question: "Does the input contract fit?",
                        }],
                        questions: ["Which input should be used?"],
                        rules: [],
                        sourceIds: [],
                        missing: ["caller requirements"],
                      }),
                    },
                  },
              );
            }
            if (request.runId === runId && parentTurns++ === 0) {
              return Promise.resolve({
                assistant: {
                  role: "assistant",
                  content: "",
                  toolCalls: [{
                    id: "delegate-pattern",
                    type: "function",
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({
                        goal: "Read the inherited component contract.",
                        patternRefs: [{ patternId }],
                      }),
                    },
                  }],
                },
              });
            }
            return Promise.resolve({
              assistant: { role: "assistant", content: "Contract received." },
            });
          },
        },
      });
      const result = await loop.runPrompt({
        prompt: task,
        openingResearchTask: task,
        promptSlotBinding: directPromptSlotBinding,
      });
      const child = requests.find((request) =>
        request.runId.includes(".subagent.")
      );
      expect(child?.transcript.at(-1)?.content).toContain(patternId);
      expect(child?.transcript.at(-1)?.content).toContain(
        SEARCH_HIT.description,
      );
      const delegated = result.transcript.find((message) =>
        message.role === "tool" && message.toolName === "delegate_task"
      );
      expect(JSON.parse(delegated?.content ?? "null")).toMatchObject({
        subagent: { status: "completed" },
      });
      expect(delegated?.content).not.toContain("patternRefRefusals");
      const patterns = inspected
        ? [expect.objectContaining({ patternId, sourceIdentityVerified: true })]
        : [];
      expect(result.runState.researchRuns?.[0].confirmedPatterns).toEqual(
        patterns,
      );
      expect(result.runState.researchRuns?.[0].kit.patterns).toEqual(patterns);
      expect(result.runState.researchRuns?.[0].kit).toMatchObject({
        purpose: "orient",
        leads: inspected ? [] : [{ pattern: { patternId } }],
      });
      expect(indexCalls).toEqual(
        inspected ? ["getPattern"] : ["searchPatterns", "listPatterns"],
      );
      expect(researchTurns).toBe(2);
    });
  }

  it("rehydrates a selected hit into neutral child context", async () => {
    const result = await runDelegation([{
      patternId: SEARCH_HIT.patternId,
      note: "Use this as available evidence; do not assume it is mandatory.",
    }]);

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toBe(
      `Task:
Use the selected pattern metadata to plan the focused task.

Context:
Keep the answer concise.

Published pattern references selected by the parent:
These records from the parent's earlier searches or host-confirmed research are available for this delegated task.

Pattern 1: pat-expenses
Kind: part
Quality: proven
Description: Totals an expense list
Match: 2 of 3 stopword-free query terms
Import: import X from "cf:pattern:pat-expenses"
Argument shape:
{
  amounts: number[]
}
Result shape:
{
  total: number
}
Parent note:
Use this as available evidence; do not assume it is mandatory.`,
    );
  });

  it("names each unseen id as an inert refusal and omits it from child context", async () => {
    const result = await runDelegation([{
      patternId: SEARCH_HIT.patternId,
    }, {
      patternId: "pat-never-searched",
      note: "This note must not make an unseen id trusted.",
    }]);

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.childPrompt).not.toContain("pat-never-searched");
    expect(result.delegateOutput.patternRefRefusals).toEqual([{
      patternId: "pat-never-searched",
      reason: "not-searched-by-parent",
    }]);
  });

  it("performs no index call while resolving a delegation", async () => {
    const result = await runDelegation([{
      patternId: SEARCH_HIT.patternId,
    }]);

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.indexCalls).toEqual([
      "searchPatterns",
      "listPatterns",
      "getPattern",
    ]);
  });

  it("rehydrates an earlier search after the parent loop resumes", async () => {
    const result = await runResumedDelegation();

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.delegateOutput.patternRefRefusals).toBeUndefined();
    expect(result.indexCalls).toEqual([
      "searchPatterns",
      "listPatterns",
      "getPattern",
    ]);
  });

  it("ignores malformed persisted search output while restoring later hits", async () => {
    const result = await runResumedDelegation(true);

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.delegateOutput.patternRefRefusals).toBeUndefined();
    expect(result.indexCalls).toEqual([
      "searchPatterns",
      "listPatterns",
      "getPattern",
    ]);
  });

  it("rehydrates a pattern the task attached, which no turn searched for", async () => {
    const result = await runAttachedDelegation();

    expect(result.openedResearch).toBe(false);
    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.childPrompt).toContain(PATTERN_RECORD.description);
    expect(result.delegateOutput.patternRefRefusals).toBeUndefined();
    // The one read is the attachment's own, made before the first model turn.
    expect(result.indexCalls).toEqual(["getPattern"]);
  });

  it("records the patterns the task attached in the run's own state", async () => {
    const result = await runAttachedDelegation();

    expect(result.recorded).toEqual([SEARCH_HIT.patternId]);
  });

  it("rehydrates a host-confirmed research pattern from resumed run state", async () => {
    const confirmedPattern = {
      patternId: PATTERN_RECORD.patternId,
      ownerDid: PATTERN_RECORD.ownerDid,
      createdAt: PATTERN_RECORD.createdAt,
      description: PATTERN_RECORD.description,
      hashtags: PATTERN_RECORD.hashtags,
      dependencies: [],
      importHint: `import X from "cf:pattern:${SEARCH_HIT.patternId}"`,
      argumentType: "{ amounts: number[] }",
      resultType: "{ total: number }",
      main: "/main.tsx",
      files: ["/main.tsx"],
      sourceIdentityVerified: true,
      identityVerification: {
        status: "verified",
        method: "light-entry-identity",
      },
    } as const;
    const researchRun = {
      type: "cf-harness.research-run",
      researchRunId: "run-research-resume:research:1",
      outputId: "run-research-resume:research:1",
      kit: {
        status: "complete",
        task: "Reuse the expense total.",
        summary: "Run the confirmed pattern.",
        recommendation: {
          kind: "direct-run",
          rationale: "Its indexed source identity was verified.",
        },
        inputs: [],
        patterns: [confirmedPattern],
        steps: ["Run the published pattern."],
        example: {
          kind: "run-pattern-input",
          content: JSON.stringify({
            patternId: SEARCH_HIT.patternId,
            inputs: { amounts: [] },
          }),
          sourceIds: ["pattern-metadata:resume"],
        },
        rules: [],
        verification: ["Check the total."],
        sources: [{
          sourceId: "pattern-metadata:resume",
          kind: "pattern-metadata",
          location: `cf:pattern:${SEARCH_HIT.patternId}`,
          offset: 0,
          end: 1,
          totalChars: 1,
          digest: `sha256:${"0".repeat(64)}`,
        }],
        missing: [],
      },
      confirmedPatterns: [confirmedPattern],
      describedHandles: [],
      completedAt: "2026-09-14T00:00:00.000Z",
    } satisfies HarnessResearchRunSummary;
    // The kit is also held as a research handle, as the research tool leaves
    // it; naming that token is how the delegation hands the findings over.
    const heldResearch = await mintReferentHandle(
      createHarnessHandleTable("run-research-resume"),
      {
        kind: "research",
        source: "research",
        labelSource: "research",
        label: {},
        value: {
          type: HARNESS_RESEARCH_HANDLE_TYPE,
          researchRunId: researchRun.researchRunId,
          kit: researchRun.kit,
          confirmedPatterns: researchRun.confirmedPatterns,
          describedHandles: [],
          cfc: {
            version: 1,
            sourceLabel: {},
            outputLabel: {},
            coverage: "complete",
            missingLabels: [],
          },
        } satisfies HarnessResearchHandleValue as unknown as FabricValue,
      },
    );
    const resumedState: HarnessRunState = {
      runId: "run-research-resume",
      status: "failed",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:01.000Z",
      cfcEnforcementMode: "disabled",
      currentDir: "/workspace",
      model: "gpt-5.4",
      researchRuns: [researchRun],
      handleTable: heldResearch.table,
      policyEvents: [],
      toolOutputs: [],
      failureRecords: [],
    };
    const requests: unknown[] = [];
    const turns = [
      toolCallTurn("call-delegate", "delegate_task", {
        goal: `Use the confirmed research pattern in ${heldResearch.token}.`,
        patternRefs: [{ patternId: SEARCH_HIT.patternId }],
      }),
      assistantTurn("Child used the confirmed pattern."),
      assistantTurn("Parent received the result."),
    ];
    const fetchFn: typeof fetch = (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const turn = turns[requests.length - 1];
      if (turn === undefined) {
        throw new Error("scripted model ran out of turns");
      }
      return Promise.resolve(
        new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
          status: 200,
        }),
      );
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: resumedState,
      }),
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
      fetchFn,
    });

    const result = await loop.runTranscript({
      transcript: [{ role: "user", content: "Continue the resumed run." }],
      promptSlotBinding: directPromptSlotBinding,
    });
    const childPrompt = chatViewOfRequest(requests[1]).messages.at(-1)
      ?.content ?? "";
    const delegateMessage = result.transcript.find((message) =>
      message.role === "tool" && message.toolName === "delegate_task"
    );
    if (delegateMessage?.role !== "tool") {
      throw new Error("expected a delegate result");
    }
    const delegateOutput = JSON.parse(delegateMessage.content) as {
      patternRefRefusals?: unknown;
    };

    expect(childPrompt).toContain(SEARCH_HIT.patternId);
    expect(childPrompt).toContain(PATTERN_RECORD.description);
    // The findings reach the child as the named handle, not as prompt text.
    expect(childPrompt).toContain(heldResearch.token);
    expect(childPrompt).not.toContain("Run the confirmed pattern.");
    expect(delegateOutput.patternRefRefusals).toBeUndefined();
    expect(result.runState.researchRuns).toEqual([researchRun]);
  });
});
