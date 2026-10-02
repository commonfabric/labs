/**
 * Held results across the turns of one interactive session.
 *
 * Each turn is a fresh run with a fresh run id, but a token the model saw in
 * one turn is still in its history the next, so the session carries the
 * handle table forward with the transcript: the table follows the
 * checkpoint the service selects, survives a restart through the session
 * store, and keeps the salt its tokens were derived under.
 */

import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { HarnessChatSessionStore } from "../src/session-store.ts";
import {
  HARNESS_RESEARCH_HANDLE_TYPE,
  type HarnessResearchHandleValue,
} from "../src/contracts/research.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  mintReferentHandle,
} from "../src/handle-table.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import { createHarnessRunState } from "../src/run-state.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";
import {
  describeHandleTool,
  type DescribeHandleToolOutput,
} from "../src/tools/describe-handle.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";

/** A sandbox the engine can be built over; nothing here runs in it. */
class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = "/workspace"): string {
    return path.startsWith("/") ? path : `${cwd}/${path}`;
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

const WORK = "https://cfc.test/atom/facet/work";
const CELL = `/of:fid1:${"A".repeat(43)}`;

const FINDINGS: HarnessResearchHandleValue = {
  type: HARNESS_RESEARCH_HANDLE_TYPE,
  researchRunId: "turn-one:research:1",
  kit: {
    purpose: "answer",
    status: "complete",
    task: "Which reader fits?",
    summary: "The ledger reader fits.",
    inputs: [],
    patterns: [],
    rules: [],
    sources: [],
    missing: [],
  },
  confirmedPatterns: [],
  describedHandles: [],
  cfc: {
    version: 1,
    sourceLabel: { confidentiality: [WORK] },
    outputLabel: { confidentiality: [WORK] },
    coverage: "complete",
    missingLabels: [],
  },
};

/** The tokens one turn minted, by what they stand for. */
interface MintedTokens {
  json: string;
  string: string;
  research: string;
  cell: string;
}

/**
 * Mints a held JSON document, a sealed child string, a research kit, and a
 * cell address into `engine`'s table, each through the path a tool takes.
 */
const mintHeldResults = async (
  engine: CfHarnessEngine,
  tag: string,
): Promise<MintedTokens> => {
  const json = await engine.mintReferentHandle({
    source: "loom_search",
    value: { title: `Mail ${tag}`, snippet: "donuts on friday" },
    label: { confidentiality: [WORK] },
    labelSource: "query",
  });
  const returned = await mintReferentHandle(
    engine.handleTable ?? createHarnessHandleTable(engine.getRunState().runId),
    {
      kind: "return",
      source: "delegate_task:child",
      value: `https://shop.example/item/${tag}`,
      label: {},
      labelSource: "child",
    },
  );
  await engine.recordHandleTable(returned.table);
  const research = await engine.mintResearchHandle(
    { ...FINDINGS, researchRunId: `${tag}:research:1` },
    { confidentiality: [WORK] },
  );
  const cell = await mintAddressHandle(
    engine.handleTable!,
    `${CELL}/${tag}`,
  );
  await engine.recordHandleTable(cell.table);
  return { json, string: returned.token, research, cell: cell.token };
};

/** What `describe_handle` reports for `token` in `engine`'s run. */
const describeIn = async (
  engine: CfHarnessEngine,
  token: string,
): Promise<DescribeHandleToolOutput> =>
  await describeHandleTool.invoke(
    {
      nextOutputId: (toolId: string) =>
        createToolOutputId(engine.getRunState().runId, toolId, 1),
      handleTable: engine.handleTable,
    } as unknown as HarnessToolContext,
    { token },
  );

/** One turn's work against the engine its run was built with. */
type TurnWork = (
  engine: CfHarnessEngine,
  request: RunHarnessTranscriptOptions,
) => Promise<HarnessPromptLoopResult | void>;

/**
 * A prompt loop factory whose turns each build a real engine from the
 * options the service hands the turn, then run the next of `turns` on it.
 * A turn that returns nothing completes with one assistant message.
 */
const engineLoop = (
  turns: TurnWork[],
  engines: CfHarnessEngine[],
): HarnessInteractivePromptLoopFactory => {
  let next = 0;
  return (options) => ({
    runTranscript: async (request) => {
      const engine = new CfHarnessEngine({
        ...options,
        sandboxRuntime: new FakeSandboxRuntime(),
      });
      engines.push(engine);
      const work = turns[next];
      next += 1;
      const result = await work?.(engine, request);
      return result ?? {
        model: request.model ?? "gpt-test",
        modelTurns: 1,
        finalAssistantText: "Done",
        transcript: [...request.transcript, {
          role: "assistant",
          content: "Done",
        }],
        runState: engine.getRunState(),
      };
    },
  });
};

const startSession = async (
  service: HarnessInteractiveChatService,
): Promise<void> => {
  const started = await service.startSession("start", {
    sessionId: "session",
    workspace: { hostPath: "/workspace" },
    model: "gpt-test",
  });
  if (!started.ok) throw new Error("session did not start");
};

const runTurn = async (
  service: HarnessInteractiveChatService,
  turnId: string,
): Promise<void> => {
  const started = await service.startTurn(turnId, {
    sessionId: "session",
    turnId,
    input: { text: `request for ${turnId}` },
  });
  if (!started.ok) throw new Error(`turn ${turnId} did not start`);
  await service.waitForTurn("session", turnId);
};

/** A tool batch that completed: one call and its result. */
const completedBatch = (id: string): HarnessTranscriptMessage[] => [
  {
    role: "assistant",
    content: "",
    toolCalls: [{
      id,
      type: "function",
      function: { name: "loom_search", arguments: "{}" },
    }],
  },
  { role: "tool", toolCallId: id, toolName: "loom_search", content: "{}" },
];

describe("interactive chat handle continuity", () => {
  it("describes the JSON, string, research, and cell handles turn one minted in turn two", async () => {
    const engines: CfHarnessEngine[] = [];
    let minted: MintedTokens | undefined;
    const described: DescribeHandleToolOutput[] = [];
    const service = new HarnessInteractiveChatService({
      createPromptLoop: engineLoop([
        async (engine) => {
          minted = await mintHeldResults(engine, "one");
        },
        async (engine) => {
          for (const token of Object.values(minted!)) {
            described.push(await describeIn(engine, token));
          }
        },
      ], engines),
    });
    await startSession(service);

    await runTurn(service, "turn-one");
    await runTurn(service, "turn-two");

    expect(described.map((output) => output.known)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(described.map((output) => output.referent?.kind)).toEqual([
      "document",
      "return",
      "research",
      undefined,
    ]);
    expect(described[2].research).toBeDefined();
    expect(engines[1].getRunState().runId).not.toBe(
      engines[0].getRunState().runId,
    );
    expect(engines[1].handleTable?.salt).toBe(engines[0].getRunState().runId);
  });

  it("describes turn one's handles after the console restarts over the same SQLite store", async () => {
    const root = await Deno.makeTempDir();
    const url = toFileUrl(join(root, "chat.sqlite"));
    let store = await openSqliteHarnessChatSessionStore({ url });
    const engines: CfHarnessEngine[] = [];
    let minted: MintedTokens | undefined;
    const described: DescribeHandleToolOutput[] = [];
    const turns: TurnWork[] = [
      async (engine) => {
        minted = await mintHeldResults(engine, "one");
      },
      async (engine) => {
        for (const token of Object.values(minted!)) {
          described.push(await describeIn(engine, token));
        }
      },
    ];
    try {
      const first = new HarnessInteractiveChatService({
        sessionStore: store,
        createPromptLoop: engineLoop(turns.slice(0, 1), engines),
      });
      await startSession(first);
      await runTurn(first, "turn-one");
      store.close();

      store = await openSqliteHarnessChatSessionStore({ url });
      const restarted = new HarnessInteractiveChatService({
        sessionStore: store,
        createPromptLoop: engineLoop(turns.slice(1), engines),
      });
      await restarted.initializeFromStore();
      await runTurn(restarted, "turn-two");

      expect(described.map((output) => output.known)).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect(described.map((output) => output.referent?.kind)).toEqual([
        "document",
        "return",
        "research",
        undefined,
      ]);
      expect(engines[1].handleTable?.salt).toBe(
        engines[0].getRunState().runId,
      );
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("restores turn one's table after a restart with its labels, capabilities, and acquisitions intact", async () => {
    const root = await Deno.makeTempDir();
    const url = toFileUrl(join(root, "chat.sqlite"));
    let store = await openSqliteHarnessChatSessionStore({ url });
    const engines: CfHarnessEngine[] = [];
    const acquisition = {
      registryId: "owner/repo/ledger",
      commitSha: "a".repeat(40),
      sourceUrl: "https://example.test/owner/repo/ledger/SKILL.md",
      verification: "git-commit-sha" as const,
      valueDigest: "sha256:ledger",
      receivedAt: "2026-10-02T00:00:00.000Z",
    };
    let kept: HarnessHandleTable | undefined;
    let restored: HarnessHandleTable | undefined;
    let minted: MintedTokens | undefined;
    let skillToken: string | undefined;
    try {
      const first = new HarnessInteractiveChatService({
        sessionStore: store,
        createPromptLoop: engineLoop([async (engine) => {
          minted = await mintHeldResults(engine, "one");
          skillToken = await engine.mintSkillContextHandle(
            `${CELL}/skill`,
            acquisition,
          );
          kept = engine.handleTable;
        }], engines),
      });
      await startSession(first);
      await runTurn(first, "turn-one");
      store.close();

      store = await openSqliteHarnessChatSessionStore({ url });
      const restarted = new HarnessInteractiveChatService({
        sessionStore: store,
        createPromptLoop: engineLoop([(engine) => {
          restored = engine.handleTable;
          return Promise.resolve();
        }], engines),
      });
      await restarted.initializeFromStore();
      await runTurn(restarted, "turn-two");

      expect(restored).toEqual(kept);
      const document = restored?.referents?.find((referent) =>
        referent.token === minted?.json
      );
      expect(document?.label).toEqual({ confidentiality: [WORK] });
      expect(document?.labelSource).toBe("query");
      const skill = restored?.entries.find((entry) =>
        entry.token === skillToken
      );
      expect(skill?.capability).toBe("skill-context");
      expect(skill?.acquisition).toEqual(acquisition);
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("carries a canceled turn's handles up to its last checkpoint and none minted after it", async () => {
    const engines: CfHarnessEngine[] = [];
    const tokens: Record<string, string> = {};
    const described: Record<string, boolean> = {};
    let reachInFlight: (() => void) | undefined;
    const reachedInFlight = new Promise<void>((resolve) => {
      reachInFlight = resolve;
    });
    const mintJson = async (engine: CfHarnessEngine, tag: string) => {
      tokens[tag] = await engine.mintReferentHandle({
        source: "loom_search",
        value: { title: tag },
        label: {},
        labelSource: "query",
      });
    };
    const service = new HarnessInteractiveChatService({
      createPromptLoop: engineLoop([
        async (engine) => {
          await mintJson(engine, "completed");
        },
        async (engine, request) => {
          await mintJson(engine, "checkpointed");
          const transcript = [
            ...request.transcript,
            ...completedBatch("call-1"),
          ];
          await request.onCheckpoint?.({
            transcript,
            runState: engine.getRunState(),
          });
          await mintJson(engine, "in-flight");
          reachInFlight?.();
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            })
          );
          // A checkpoint the loop reports after the stop is not the turn's.
          await mintJson(engine, "late");
          await request.onCheckpoint?.({
            transcript: [...transcript, ...completedBatch("call-2")],
            runState: engine.getRunState(),
          });
          throw request.signal?.reason;
        },
        async (engine) => {
          for (const [tag, token] of Object.entries(tokens)) {
            described[tag] = (await describeIn(engine, token)).known;
          }
        },
      ], engines),
    });
    await startSession(service);

    await runTurn(service, "turn-completed");
    const started = await service.startTurn("turn-canceled", {
      sessionId: "session",
      turnId: "turn-canceled",
      input: { text: "request for turn-canceled" },
    });
    if (!started.ok) throw new Error("turn-canceled did not start");
    await reachedInFlight;
    await service.cancelTurn(
      "cancel",
      "session",
      "turn-canceled",
      "user_requested",
    );
    await service.waitForTurn("session", "turn-canceled");
    await runTurn(service, "turn-after");

    expect(described).toEqual({
      completed: true,
      checkpointed: true,
      "in-flight": false,
      late: false,
    });
  });

  for (
    const { finalizeOnTurnLimit, kept } of [
      { finalizeOnTurnLimit: true, kept: true },
      { finalizeOnTurnLimit: false, kept: false },
    ]
  ) {
    it(
      `${
        kept ? "keeps" : "drops"
      } a failed turn's checkpointed handles when the host ${
        finalizeOnTurnLimit ? "opts in" : "does not opt in"
      } to retaining its checkpoint`,
      async () => {
        const engines: CfHarnessEngine[] = [];
        const tokens: Record<string, string> = {};
        const described: Record<string, boolean> = {};
        const mintJson = async (engine: CfHarnessEngine, tag: string) => {
          tokens[tag] = await engine.mintReferentHandle({
            source: "loom_search",
            value: { title: tag },
            label: {},
            labelSource: "query",
          });
        };
        const service = new HarnessInteractiveChatService({
          basePromptLoopOptions: { finalizeOnTurnLimit },
          createPromptLoop: engineLoop([
            async (engine, request) => {
              await mintJson(engine, "checkpointed");
              await request.onCheckpoint?.({
                transcript: [
                  ...request.transcript,
                  ...completedBatch("call-1"),
                ],
                runState: engine.getRunState(),
              });
              await mintJson(engine, "after");
              throw new Error("provider unavailable");
            },
            async (engine) => {
              for (const [tag, token] of Object.entries(tokens)) {
                described[tag] = (await describeIn(engine, token)).known;
              }
            },
          ], engines),
        });
        await startSession(service);

        await runTurn(service, "turn-failed");
        await runTurn(service, "turn-after");

        expect(described).toEqual({ checkpointed: kept, after: false });
      },
    );
  }

  it("keeps a turn's handles out of the session when its completion fails to persist", async () => {
    const engines: CfHarnessEngine[] = [];
    let minted: string | undefined;
    let known: boolean | undefined;
    const root = await Deno.makeTempDir();
    const sqlite = await openSqliteHarnessChatSessionStore({
      url: toFileUrl(join(root, "chat.sqlite")),
    });
    // The first `turn_completed` write fails, as a full disk would fail it.
    let failed = false;
    const store: HarnessChatSessionStore = {
      saveSession: (snapshot) => sqlite.saveSession(snapshot),
      getSession: (sessionId) => sqlite.getSession(sessionId),
      listSessions: () => sqlite.listSessions(),
      saveSessionAndAppendEvent: (snapshot, event) =>
        sqlite.saveSessionAndAppendEvent(snapshot, event),
      saveSessionTurnAndAppendEvent: (mutation) => {
        if (!failed && mutation.event.event.kind === "turn_completed") {
          failed = true;
          throw new Error("disk full");
        }
        return sqlite.saveSessionTurnAndAppendEvent(mutation);
      },
      saveTurn: (turn) => sqlite.saveTurn(turn),
      getTurn: (sessionId, turnId) => sqlite.getTurn(sessionId, turnId),
      listTurns: (options) => sqlite.listTurns(options),
      appendEvent: (event) => sqlite.appendEvent(event),
      listEvents: (options) => sqlite.listEvents(options),
      latestSequence: () => sqlite.latestSequence(),
    };
    try {
      const service = new HarnessInteractiveChatService({
        sessionStore: store,
        createPromptLoop: engineLoop([
          async (engine) => {
            minted = await engine.mintReferentHandle({
              source: "loom_search",
              value: { title: "unsaved" },
              label: {},
              labelSource: "query",
            });
          },
          async (engine) => {
            known = (await describeIn(engine, minted!)).known;
          },
        ], engines),
      });
      await startSession(service);

      await runTurn(service, "turn-unsaved");
      await runTurn(service, "turn-after");

      expect(failed).toBe(true);
      expect(engines).toHaveLength(2);
      expect(known).toBe(false);
      expect(sqlite.getSession("session")?.handleTable).toEqual(
        engines[1].handleTable,
      );
    } finally {
      sqlite.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("keeps the table when the completed history carries server-side compaction", async () => {
    const engines: CfHarnessEngine[] = [];
    let minted: MintedTokens | undefined;
    const described: boolean[] = [];
    const service = new HarnessInteractiveChatService({
      createPromptLoop: engineLoop([
        async (engine, request) => {
          minted = await mintHeldResults(engine, "one");
          return {
            model: "gpt-test",
            modelTurns: 1,
            finalAssistantText: "Done",
            transcript: [...request.transcript, {
              role: "assistant",
              content: "Done",
              providerContinuation: {
                providerId: "openai-compatible-gateway",
                state: {
                  version: 1,
                  sourceModel: "gpt-test",
                  output: [{
                    type: "compaction",
                    id: "cmp-1",
                    encrypted_content: "encrypted-cmp-1",
                  }],
                },
              },
            }],
            runState: engine.getRunState(),
          };
        },
        async (engine) => {
          for (const token of Object.values(minted!)) {
            described.push((await describeIn(engine, token)).known);
          }
        },
      ], engines),
    });
    await startSession(service);

    await runTurn(service, "turn-compacted");
    await runTurn(service, "turn-after");

    expect(described).toEqual([true, true, true, true]);
  });

  describe("CfHarnessEngine inheritedHandleTable", () => {
    it("starts a fresh run on the inherited table and merges new mints under its salt", async () => {
      const earlier = await mintReferentHandle(
        createHarnessHandleTable("run-earlier"),
        {
          kind: "document",
          source: "loom_search",
          value: { title: "earlier" },
          label: {},
          labelSource: "query",
        },
      );
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: "run-later",
        model: "gpt-test",
        inheritedHandleTable: earlier.table,
      });

      const later = await engine.mintReferentHandle({
        source: "loom_search",
        value: { title: "later" },
        label: {},
        labelSource: "query",
      });

      expect(engine.getRunState().runId).toBe("run-later");
      expect(engine.handleTable?.salt).toBe("run-earlier");
      expect(
        engine.handleTable?.referents?.map((referent) => referent.token),
      ).toEqual([earlier.token, later]);
    });

    it("refuses an inherited table beside a resumed run state", () => {
      expect(() =>
        new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          model: "gpt-test",
          runState: createHarnessRunState({
            runId: "run-resumed",
            currentDir: "/workspace",
            cfcEnforcementMode: "enforce-explicit",
          }),
          inheritedHandleTable: createHarnessHandleTable("run-earlier"),
        })
      ).toThrow("an inherited handle table cannot accompany a resumed run");
    });
  });
});
