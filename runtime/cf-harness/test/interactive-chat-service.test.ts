import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { unattachedTurnContext } from "./support/session-store-fixtures.ts";
import {
  createPatternSkillsFixture,
  PATTERN_SKILL_FIXTURE_RESOURCE_PATH,
} from "./support/pattern-skills-fixture.ts";
import {
  createHarnessChatEventEnvelope,
  createHarnessChatSessionStatus,
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatBrowserAccessLease,
  type HarnessChatListEventsResult,
  type HarnessChatListTurnsResult,
  type HarnessChatRequestEnvelope,
  type HarnessChatSessionStatus,
  type HarnessChatTurnRecord,
  READONLY_HARNESS_CHAT_POLICY,
} from "../src/contracts/interactive-chat.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import { PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES } from "../src/contracts/subagent.ts";
import {
  HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import type {
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
} from "../src/sandbox/types.ts";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
  type RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { HarnessChatSessionStore } from "../src/session-store.ts";
import {
  type HarnessTranscriptMessage,
  inspectHarnessTranscriptPairing,
} from "../src/contracts/transcript.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";
import {
  FAULT_KINDS,
  FAULT_POINTS,
  faultingToolLoop,
  recordingStore,
  toolCall,
} from "./support/chat-fault-fixture.ts";
import { INERT_ENFORCING_RUNSC, INERT_RUNSC } from "./support/inert-runsc.ts";

const nextIsoNow = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-05-22T00:00:${String(counter).padStart(2, "0")}.000Z`;
  };
};

const makeResult = (
  options: RunHarnessTranscriptOptions,
  finalAssistantText: string,
): HarnessPromptLoopResult => ({
  model: options.model ?? "gpt-test",
  finalAssistantText,
  transcript: [
    ...options.transcript,
    { role: "assistant", content: finalAssistantText },
  ],
  modelTurns: 1,
  runState: {} as HarnessPromptLoopResult["runState"],
});

const browserAccess: HarnessChatBrowserAccessLease = {
  type: "cf-harness.chat.browser-access-lease",
  leaseId: "lease-1",
  cdpUrl: "http://127.0.0.1:9222",
  owner: "loom",
};

Deno.test("interactive service starts sessions and completes non-streaming turns", async () => {
  const loopOptions: unknown[] = [];
  const createPromptLoop: HarnessInteractivePromptLoopFactory = (options) => {
    loopOptions.push(options);
    return {
      runTranscript: async (runOptions) => {
        const result = makeResult(runOptions, "Done.");
        result.usage = {
          inputTokens: 2_000,
          cachedInputTokens: 1_500,
          cacheWriteTokens: 0,
          outputTokens: 100,
          totalTokens: 2_100,
        };
        await runOptions.onTranscriptEvent?.({
          message: result.transcript[result.transcript.length - 1],
          transcript: result.transcript,
        });
        return result;
      },
    };
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
    randomUUID: () => "generated-id",
  });

  const startSession = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-1",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace", cwd: "/workspace/project" },
      model: "gpt-test",
    },
  });
  assertEquals(startSession.ok, true);

  const startTurn = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-2",
    method: "start_turn",
    params: {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Hi" },
    },
  });
  assertEquals(startTurn.ok, true);
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].turnCount, 1);
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns.map((turn) =>
      turn.turn.status
    ),
    ["completed"],
  );
  assertEquals(
    service.listEvents({ sessionId: "session-1", afterSequence: 2 }).events
      .map((event) => event.event.kind),
    ["assistant_delta", "assistant_completed", "turn_completed"],
  );
  assertEquals(
    service.listEvents({ sessionId: "session-1" }).latestSequence,
    5,
  );
  assertEquals(service.events("session-1").at(-1)?.event, {
    kind: "turn_completed",
    outcome: "completed",
    turnId: "turn-1",
    finalText: "Done.",
    usage: {
      inputTokens: 2_000,
      cachedInputTokens: 1_500,
      cacheWriteTokens: 0,
      outputTokens: 100,
      totalTokens: 2_100,
    },
  });
  expect(loopOptions[0]).toEqual({
    workspaceHostPath: "/workspace",
    cwd: "/workspace/project",
    model: "gpt-test",
    taskText: "Hi",
    researchGoal: "Hi",
    cacheAffinityKey: "interactive:session-1",
    allowedToolIds: [
      "bash",
      "read_file",
      "view_image",
      "read_skill_resource",
      "edit_file",
      "write_file",
      "delegate_task",
      "describe_handle",
      "finish_task",
    ],
    allowedSubagentProfiles: ["default"],
  });
});

Deno.test("interactive service preserves an owner-bound Codex client across turns", async () => {
  const modelClient = {
    providerId: "openai-codex",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "loom:user-1",
      tenantKey: "loom-tenant-1",
    },
    complete: () => Promise.reject(new Error("unused in injected loop")),
  } as const;
  const loopOptions: CreateHarnessPromptLoopOptions[] = [];
  const service = new HarnessInteractiveChatService({
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "loom:user-1",
      tenantKey: "loom-tenant-1",
    },
    basePromptLoopOptions: {
      modelProvider: "openai-codex",
      credentialOwnerKey: "loom:user-1",
      modelClient,
    },
    createPromptLoop: (options) => {
      loopOptions.push(options);
      return {
        runTranscript: (runOptions) =>
          Promise.resolve(makeResult(runOptions, "Done.")),
      };
    },
    now: nextIsoNow(),
  });
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-owner-session",
    method: "start_session",
    params: {
      sessionId: "session-owner",
      workspace: { hostPath: "/workspace" },
      model: "gpt-5.4",
    },
  });
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-owner-turn",
    method: "start_turn",
    params: {
      sessionId: "session-owner",
      turnId: "turn-owner",
      input: { text: "Hi" },
    },
  });
  await service.waitForTurn("session-owner", "turn-owner");
  await service.startTurn("req-owner-turn-2", {
    sessionId: "session-owner",
    turnId: "turn-owner-2",
    input: { text: "Continue" },
  });
  await service.waitForTurn("session-owner", "turn-owner-2");

  assertEquals(loopOptions[0].modelProvider, "openai-codex");
  assertEquals(loopOptions[0].credentialOwnerKey, "loom:user-1");
  assertEquals(loopOptions[0].modelClient, modelClient);
  assertEquals(
    loopOptions.map((options) => options.cacheAffinityKey),
    ["interactive:session-owner", "interactive:session-owner"],
  );
});

Deno.test("interactive Codex services require one matching process owner", () => {
  const modelClient = {
    providerId: "openai-codex",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "loom:user-1",
      tenantKey: "tenant-a",
    },
    complete: () => Promise.reject(new Error("unused")),
  } as const;
  assertThrows(
    () =>
      new HarnessInteractiveChatService({
        basePromptLoopOptions: {
          modelProvider: "openai-codex",
          credentialOwnerKey: "loom:user-1",
          modelClient,
        },
      }),
    Error,
    "require one explicit authenticated credential owner",
  );
  assertThrows(
    () =>
      new HarnessInteractiveChatService({
        credentialOwner: {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "loom:user-2",
        },
        basePromptLoopOptions: {
          modelProvider: "openai-codex",
          credentialOwnerKey: "loom:user-1",
          modelClient,
        },
      }),
    Error,
    "does not match",
  );
  assertThrows(
    () =>
      new HarnessInteractiveChatService({
        credentialOwner: {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "loom:user-1",
          tenantKey: "tenant-b",
        },
        basePromptLoopOptions: {
          modelProvider: "openai-codex",
          credentialOwnerKey: "loom:user-1",
          modelClient,
        },
      }),
    Error,
    "full owner binding",
  );
});

Deno.test("interactive service refuses a turn run-id mapper with an injected engine", () => {
  assertThrows(
    () =>
      new HarnessInteractiveChatService({
        basePromptLoopOptions: {
          engine: new CfHarnessEngine({
            sandboxRuntime: new StubSandboxRuntime(),
          }),
        },
        runIdForTurn: (_sessionId, turnId) => turnId,
      }),
    Error,
    "turn run-id mapping cannot be combined with an injected engine",
  );
});

Deno.test("interactive service refuses a turn run-id mapper with an injected run state", () => {
  assertThrows(
    () =>
      new HarnessInteractiveChatService({
        basePromptLoopOptions: {
          runState: {} as HarnessPromptLoopResult["runState"],
        },
        runIdForTurn: (_sessionId, turnId) => turnId,
      }),
    Error,
    "turn run-id mapping cannot be combined with an injected run state",
  );
});

Deno.test("Loom-local interactive services require an explicit matching provider", () => {
  const credentialOwner = {
    type: "cf-harness.credential-owner-ref" as const,
    version: 1 as const,
    ownerKey: "local",
  };
  assertThrows(
    () =>
      new HarnessInteractiveChatService({
        credentialOwner,
        basePromptLoopOptions: {
          modelAuthSource: "cf-harness-local-store",
          credentialOwner,
          credentialOwnerKey: credentialOwner.ownerKey,
          harnessHomeIdentity: "sha256:opaque-home",
          runManifest: {
            type: "cf-harness.loom-run-manifest",
            version: 1,
            source: "loom",
            modelProvider: "openai-codex",
            modelAuthSource: "cf-harness-local-store",
            credentialOwner,
            harnessHomeIdentity: "sha256:opaque-home",
          },
        },
      }),
    Error,
    "provider does not match",
  );
});

Deno.test("Loom-local interactive services reject mismatched binding fields", () => {
  const credentialOwner = {
    type: "cf-harness.credential-owner-ref" as const,
    version: 1 as const,
    ownerKey: "local",
    tenantKey: "tenant-a",
  };
  const manifest = {
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    modelProvider: "openai-compatible-gateway" as const,
    modelAuthSource: "api-key" as const,
    credentialOwner,
    harnessHomeIdentity: "sha256:home-a",
    model: "gpt-a",
  };
  const baseOptions = (
    overrides: Partial<CreateHarnessPromptLoopOptions>,
  ): CreateHarnessPromptLoopOptions => ({
    modelProvider: manifest.modelProvider,
    modelAuthSource: manifest.modelAuthSource,
    credentialOwner,
    credentialOwnerKey: credentialOwner.ownerKey,
    harnessHomeIdentity: manifest.harnessHomeIdentity,
    model: manifest.model,
    runManifest: manifest,
    ...overrides,
  });
  const cases: Array<{
    overrides: Partial<CreateHarnessPromptLoopOptions>;
    message: string;
  }> = [
    {
      overrides: { modelAuthSource: "none" },
      message: "auth source does not match",
    },
    {
      overrides: {
        credentialOwner: { ...credentialOwner, tenantKey: "tenant-b" },
      },
      message: "credential owner does not match",
    },
    {
      overrides: { harnessHomeIdentity: "sha256:home-b" },
      message: "harness home does not match",
    },
    { overrides: { model: "gpt-b" }, message: "model does not match" },
  ];

  for (const testCase of cases) {
    assertThrows(
      () =>
        new HarnessInteractiveChatService({
          basePromptLoopOptions: baseOptions(testCase.overrides),
        }),
      Error,
      testCase.message,
    );
  }
});

Deno.test("Loom-local interactive sessions require a matching durable model", async () => {
  const credentialOwner = {
    type: "cf-harness.credential-owner-ref" as const,
    version: 1 as const,
    ownerKey: "local",
  };
  const binding = {
    source: "loom" as const,
    modelProvider: "openai-compatible-gateway" as const,
    modelAuthSource: "none" as const,
    credentialOwner,
    harnessHomeIdentity: "sha256:home-a",
  };
  const fixedModelService = new HarnessInteractiveChatService({
    basePromptLoopOptions: {
      ...binding,
      model: "gpt-fixed",
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        ...binding,
        model: "gpt-fixed",
      },
    },
  });
  const fixedModel = await fixedModelService.startSession("req-fixed", {
    sessionId: "session-fixed",
    workspace: { hostPath: "/workspace" },
    model: "gpt-requested",
  });
  assertEquals(fixedModel.ok, false);
  assertEquals(
    fixedModel.ok === false ? fixedModel.error.code : undefined,
    "provider-mismatch",
  );
  assertEquals(fixedModelService.status().sessions, []);

  const missingModelService = new HarnessInteractiveChatService({
    basePromptLoopOptions: {
      ...binding,
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        ...binding,
      },
    },
  });
  for (
    const testCase of [
      { requestId: "req-missing" },
      { requestId: "req-blank", model: "  " },
    ]
  ) {
    const response = await missingModelService.startSession(
      testCase.requestId,
      {
        sessionId: testCase.requestId,
        workspace: { hostPath: "/workspace" },
        ...(testCase.model !== undefined ? { model: testCase.model } : {}),
      },
    );
    assertEquals(response.ok, false);
    assertEquals(
      response.ok === false ? response.error.code : undefined,
      "provider-mismatch",
    );
  }
  assertEquals(missingModelService.status().sessions, []);
});

Deno.test("interactive service forces comment-thread turns to read-only prompt-loop options", async () => {
  const loopOptions: unknown[] = [];
  const createPromptLoop: HarnessInteractivePromptLoopFactory = (options) => {
    loopOptions.push(options);
    return {
      runTranscript: (runOptions) =>
        Promise.resolve(makeResult(runOptions, "Readonly.")),
    };
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
    context: {
      type: "comment-thread",
      threadId: "thread-1",
    },
    policy: {
      type: "cf-harness.chat-policy",
      toolMode: "workspace-write",
      allowedToolIds: [
        "bash",
        "read_file",
        "edit_file",
        "write_file",
        "delegate_task",
      ],
      allowedSubagentProfiles: ["default"],
    },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Read only please" },
  });
  await service.waitForTurn("session-1", "turn-1");

  expect(loopOptions[0]).toEqual({
    workspaceHostPath: "/workspace",
    cacheAffinityKey: "interactive:session-1",
    allowedToolIds: ["read_file", "view_image", "read_skill_resource"],
    taskText: "Read only please",
    researchGoal: "Read only please",
    allowedSubagentProfiles: [],
  });
  assertEquals(service.status("session-1").sessions[0].policy, {
    type: "cf-harness.chat-policy",
    toolMode: "read-only",
    allowedToolIds: ["read_file", "view_image", "read_skill_resource"],
    allowedSubagentProfiles: [],
  });
});

Deno.test("interactive service passes Browser Access leases to browser-profile turns", async () => {
  const loopOptions: unknown[] = [];
  const createPromptLoop: HarnessInteractivePromptLoopFactory = (options) => {
    loopOptions.push(options);
    return {
      runTranscript: (runOptions) =>
        Promise.resolve(makeResult(runOptions, "Browser.")),
    };
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
    browserAccess,
    policy: {
      type: "cf-harness.chat-policy",
      toolMode: "workspace-write",
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
    },
  });
  const turn = await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Inspect the browser" },
  });
  assertEquals(turn.ok, true);
  await service.waitForTurn("session-1", "turn-1");

  expect(loopOptions[0]).toEqual({
    workspaceHostPath: "/workspace",
    cacheAffinityKey: "interactive:session-1",
    allowedToolIds: ["delegate_task"],
    taskText: "Inspect the browser",
    researchGoal: "Inspect the browser",
    allowedSubagentProfiles: ["browser"],
    browserAccess,
  });
});

Deno.test("interactive service rejects browser-profile turns without Browser Access leases", async () => {
  let createdLoop = false;
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => {
      createdLoop = true;
      return {
        runTranscript: (runOptions) =>
          Promise.resolve(makeResult(runOptions, "Browser.")),
      };
    },
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
    policy: {
      type: "cf-harness.chat-policy",
      toolMode: "workspace-write",
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
    },
  });
  const turn = await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Inspect the browser" },
  });

  assertEquals(turn.ok, false);
  assertEquals(
    turn.ok === false ? turn.error.code : "",
    "browser_access_required",
  );
  // No request attaches a lease to a running session, so resending this turn
  // unchanged fails identically forever. Waiting is not the remedy, and the
  // response must not offer it as one.
  assertEquals(turn.ok === false ? turn.error.retryable : "unset", undefined);
  assertEquals(createdLoop, false);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    ["session_started"],
  );
});

Deno.test("interactive service maps tool transcript messages to tool and file events", async () => {
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (runOptions) => {
      const assistantMessage = {
        role: "assistant" as const,
        content: "",
        toolCalls: [{
          id: "tool-write-1",
          type: "function" as const,
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "notes.md",
              content: "hello",
            }),
          },
        }],
      };
      const toolMessage = {
        role: "tool" as const,
        toolCallId: "tool-write-1",
        toolName: "write_file",
        content: JSON.stringify({
          outputId: "run-1:write_file:1",
          path: "/workspace/notes.md",
          mode: "replace",
        }),
      };
      const finalMessage = {
        role: "assistant" as const,
        content: "Wrote notes.",
      };
      const transcript = [
        ...runOptions.transcript,
        assistantMessage,
        toolMessage,
        finalMessage,
      ];
      await runOptions.onTranscriptEvent?.({
        message: assistantMessage,
        transcript: [...runOptions.transcript, assistantMessage],
      });
      await runOptions.onTranscriptEvent?.({
        message: toolMessage,
        transcript: [...runOptions.transcript, assistantMessage, toolMessage],
      });
      await runOptions.onTranscriptEvent?.({
        message: finalMessage,
        transcript,
      });
      return {
        model: "gpt-test",
        finalAssistantText: "Wrote notes.",
        transcript,
        modelTurns: 2,
        runState: {} as HarnessPromptLoopResult["runState"],
      };
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Write notes" },
  });
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "tool_started",
      "tool_completed",
      "file_changed",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
  const fileEvent = service.events("session-1").find((event) =>
    event.event.kind === "file_changed"
  );
  assertEquals(fileEvent?.event, {
    kind: "file_changed",
    change: {
      kind: "update",
      path: "/workspace/notes.md",
      summary: "write_file replace",
    },
  });
});

Deno.test("interactive service aborts canceled turns without closing the session", async () => {
  let runCount = 0;
  let firstSignal: AbortSignal | undefined;
  let finishFirstTurn: (() => void) | undefined;
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      runCount += 1;
      if (runCount === 1) {
        firstSignal = options.signal;
        return await new Promise<HarnessPromptLoopResult>(
          (resolve) => {
            finishFirstTurn = () =>
              resolve(makeResult(options, "Ignored after cancel."));
          },
        );
      }
      const result = makeResult(options, "Second answer.");
      await options.onTranscriptEvent?.({
        message: result.transcript[result.transcript.length - 1],
        transcript: result.transcript,
      });
      return result;
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Start" },
  });
  const canceled = await service.cancelTurn(
    "req-3",
    "session-1",
    "turn-1",
    "user_requested",
  );
  assertEquals(canceled.ok, true);
  assertEquals(firstSignal instanceof AbortSignal, true);
  assertEquals(firstSignal?.aborted, true);
  assertEquals(service.status("session-1").sessions[0].status, "canceling");
  assertEquals(service.status("session-1").sessions[0].reusable, false);
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "canceling",
  );
  const earlySecondTurn = await service.startTurn("req-early", {
    sessionId: "session-1",
    turnId: "turn-early",
    input: { text: "Too soon" },
  });
  assertEquals(earlySecondTurn.ok, false);
  assertEquals(
    earlySecondTurn.ok === false ? earlySecondTurn.error.code : "",
    "turn_already_running",
  );

  finishFirstTurn?.();
  await service.waitForTurn("session-1", "turn-1");
  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].reusable, true);
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "canceled",
  );
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    ["session_started", "turn_started", "turn_canceled", "status_changed"],
  );

  const secondTurn = await service.startTurn("req-4", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Again" },
  });
  assertEquals(secondTurn.ok, true);
  await service.waitForTurn("session-1", "turn-2");

  assertEquals(runCount, 2);
  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].reusable, true);
  assertEquals(service.status("session-1").sessions[0].turnCount, 2);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "turn_canceled",
      "status_changed",
      "turn_started",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
});

Deno.test("a canceled turn keeps its request and completed work for the next turn", async () => {
  const lookup = {
    role: "assistant" as const,
    content: "Looking up the forecast.",
    toolCalls: [toolCall("call-forecast")],
  };
  const forecast = {
    role: "tool" as const,
    toolCallId: "call-forecast",
    toolName: "read_file",
    content: "Brisbane: 24C, sunny",
  };
  // Declared but never answered: the cancel lands while it is in flight.
  const inFlight = {
    role: "assistant" as const,
    content: "Checking the radar too.",
    toolCalls: [toolCall("call-radar")],
  };
  const { store, snapshots } = recordingStore();
  const requests: (readonly HarnessTranscriptMessage[])[] = [];
  let runCount = 0;
  let reachInFlight: (() => void) | undefined;
  const reachedInFlight = new Promise<void>((resolve) => {
    reachInFlight = resolve;
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: async (options) => {
        runCount += 1;
        requests.push([...options.transcript]);
        if (runCount > 1) return makeResult(options, "Still sunny.");
        const transcript = [...options.transcript, lookup];
        await options.onTranscriptEvent?.({ message: lookup, transcript });
        transcript.push(forecast);
        await options.onTranscriptEvent?.({ message: forecast, transcript });
        await options.onCheckpoint?.({
          transcript,
          runState: {} as HarnessPromptLoopResult["runState"],
        });
        transcript.push(inFlight);
        await options.onTranscriptEvent?.({ message: inFlight, transcript });
        reachInFlight?.();
        return await new Promise<HarnessPromptLoopResult>((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "weather in brisbane" },
  });
  await reachedInFlight;
  await service.cancelTurn("req-3", "session-1", "turn-1", "user_requested");
  await service.waitForTurn("session-1", "turn-1");
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "canceled",
  );

  await service.startTurn("req-4", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "go on" },
  });
  await service.waitForTurn("session-1", "turn-2");

  for (const snapshot of snapshots) {
    assertEquals(inspectHarnessTranscriptPairing(snapshot).valid, true);
  }
  expect(
    requests[1].filter((message) =>
      message.content === HARNESS_CHAT_INTERRUPTED_TURN_NOTICE
    ),
  ).toHaveLength(1);
  // The request, the completed lookup and the notice carry over; the radar
  // call whose result never arrived does not.
  expect(requests[1]).toEqual([
    { role: "user", content: "weather in brisbane" },
    lookup,
    forecast,
    { role: "user", content: HARNESS_CHAT_INTERRUPTED_TURN_NOTICE },
    ...unattachedTurnContext(),
    { role: "user", content: "go on" },
  ]);
});

Deno.test("waiting for a canceled turn includes its checkpoint commit", async () => {
  const ready = Promise.withResolvers<void>();
  const committing = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const cancellationRecorded = Promise.withResolvers<void>();
  const { store } = recordingStore();
  const service = new HarnessInteractiveChatService({
    onEvent: ({ event }) => {
      if (event.kind === "turn_canceled") cancellationRecorded.resolve();
    },
    sessionStore: {
      ...store,
      saveSessionTurnAndAppendEvent: async (mutation) => {
        if (mutation.turn.turn.status === "canceled") {
          committing.resolve();
          await commit.promise;
        }
        return true;
      },
    },
    createPromptLoop: () => ({
      runTranscript: (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            void cancellationRecorded.promise.then(() =>
              reject(options.signal?.reason)
            );
          }, { once: true });
          ready.resolve();
        }),
    }),
  });
  await service.startSession("session", {
    sessionId: "session",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("turn", {
    sessionId: "session",
    turnId: "turn",
    input: { text: "Work" },
  });
  await ready.promise;
  await service.cancelTurn("cancel", "session", "turn");
  await committing.promise;
  const order: string[] = [];
  const waiting = service.waitForTurn("session", "turn").then(() =>
    order.push("wait returned")
  );
  const release = Promise.resolve().then(() => {
    order.push("commit released");
    commit.resolve();
  });
  await Promise.all([waiting, release]);
  expect(order).toEqual(["commit released", "wait returned"]);
  expect(service.listTurns({ sessionId: "session" }).turns[0].turn.status).toBe(
    "canceled",
  );
});

Deno.test("a canceled turn ignores checkpoints it cannot resume from or that arrive after the cancel", async () => {
  const declared = {
    role: "assistant" as const,
    content: "Reading both files.",
    toolCalls: ["call-a", "call-b"].map(toolCall),
  };
  const result = (id: string) => ({
    role: "tool" as const,
    toolCallId: id,
    toolName: "read_file",
    content: `contents for ${id}`,
  });
  const { store, snapshots } = recordingStore();
  const requests: (readonly HarnessTranscriptMessage[])[] = [];
  let runCount = 0;
  let reachMidBatch: (() => void) | undefined;
  const reachedMidBatch = new Promise<void>((resolve) => {
    reachMidBatch = resolve;
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: async (options) => {
        runCount += 1;
        requests.push([...options.transcript]);
        if (runCount > 1) return makeResult(options, "Both read.");
        const transcript = [...options.transcript, declared, result("call-a")];
        // Half a batch: a provider would refuse this history, so it is not a
        // point the next turn can resume from.
        await options.onCheckpoint?.({
          transcript,
          runState: {} as HarnessPromptLoopResult["runState"],
        });
        reachMidBatch?.();
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        );
        // The batch completes after the person stopped the turn; work the
        // loop reports past the cancel is not the turn's to keep.
        transcript.push(result("call-b"));
        await options.onCheckpoint?.({
          transcript,
          runState: {} as HarnessPromptLoopResult["runState"],
        });
        throw options.signal?.reason;
      },
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Read both files" },
  });
  await reachedMidBatch;
  await service.cancelTurn("req-3", "session-1", "turn-1", "user_requested");
  await service.waitForTurn("session-1", "turn-1");
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "canceled",
  );

  await service.startTurn("req-4", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "go on" },
  });
  await service.waitForTurn("session-1", "turn-2");

  for (const snapshot of snapshots) {
    assertEquals(inspectHarnessTranscriptPairing(snapshot).valid, true);
  }
  // Neither checkpoint advanced the turn past its own request.
  expect(requests[1]).toEqual([
    { role: "user", content: "Read both files" },
    { role: "user", content: HARNESS_CHAT_INTERRUPTED_TURN_NOTICE },
    ...unattachedTurnContext(),
    { role: "user", content: "go on" },
  ]);
});

Deno.test("interactive service aborts active turns when closing a session", async () => {
  const ready = Promise.withResolvers<void>();
  let activeSignal: AbortSignal | undefined;
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      activeSignal = options.signal;
      ready.resolve();
      return await new Promise<HarnessPromptLoopResult>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason);
        }, { once: true });
      });
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Start" },
  });
  await ready.promise;
  const closed = await service.closeSession("req-3", "session-1", "done");
  assertEquals(closed.ok, true);
  assertEquals(activeSignal instanceof AbortSignal, true);
  assertEquals(activeSignal?.aborted, true);
  assertEquals(service.status("session-1").sessions[0].status, "closed");
  assertEquals(service.status("session-1").sessions[0].reusable, false);
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "canceled",
  );

  await service.waitForTurn("session-1", "turn-1");
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "turn_canceled",
      "status_changed",
      "session_closed",
    ],
  );
});

Deno.test("interactive service closes sessions and filters status", async () => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
  });
  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startSession("req-2", {
    sessionId: "session-2",
    workspace: { hostPath: "/other-workspace" },
  });

  assertEquals(service.status().sessions.length, 2);
  assertEquals(service.status("session-1").sessions.length, 1);

  const closed = await service.closeSession("req-3", "session-1", "done");
  assertEquals(closed.ok, true);
  assertEquals(service.status("session-1").sessions[0].status, "closed");
  assertEquals(service.status("session-1").sessions[0].reusable, false);

  const startTurn = await service.startTurn("req-4", {
    sessionId: "session-1",
    input: { text: "Hello again" },
  });
  assertEquals(startTurn.ok, false);
  assertEquals(
    startTurn.ok === false ? startTurn.error.code : "",
    "session_closed",
  );
});

Deno.test("interactive service releases a late runtime after a closed turn unwinds", async () => {
  const constructing = Promise.withResolvers<void>();
  const constructed = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let disposed = 0;
  const fabric = {
    pieces: {
      runtime: {
        dispose: () => {
          disposed++;
          return Promise.resolve();
        },
      },
    },
  } as unknown as HarnessFabricSession;
  const service = new HarnessInteractiveChatService({
    basePromptLoopOptions: {
      ...INERT_RUNSC,
      fabricSessionFactory: async () => {
        constructing.resolve();
        await constructed.promise;
        return fabric;
      },
    },
    createPromptLoop: (options) => {
      const engine = new CfHarnessEngine(options);
      return {
        runTranscript: async (runOptions) => {
          await engine.fabricSessionFactory!();
          acquired.resolve();
          await finish.promise;
          return makeResult(runOptions, "Done.");
        },
      };
    },
  });
  expect(
    (await service.startSession("open", {
      sessionId: "closing",
      workspace: { hostPath: "/workspace" },
    })).ok,
  ).toBe(true);
  expect(
    (await service.startTurn("start", {
      sessionId: "closing",
      input: { text: "Start" },
    })).ok,
  ).toBe(true);
  await Promise.race([
    constructing.promise,
    service.waitForIdle().then(() => {
      throw new Error(JSON.stringify(service.events("closing")));
    }),
  ]);
  try {
    expect((await service.closeSession("close", "closing")).ok).toBe(true);
    constructed.resolve();
    await acquired.promise;
    expect(disposed).toBe(0);
  } finally {
    constructed.resolve();
    finish.resolve();
    await service.waitForIdle();
  }
  expect(disposed).toBe(1);
});

Deno.test("interactive service releases runtimes when closed-event delivery fails", async () => {
  let disposed = 0;
  const fabric = {
    pieces: {
      runtime: {
        dispose: () => {
          disposed++;
          return Promise.resolve();
        },
      },
    },
  } as unknown as HarnessFabricSession;
  const service = new HarnessInteractiveChatService({
    basePromptLoopOptions: {
      ...INERT_RUNSC,
      fabricSessionFactory: () => Promise.resolve(fabric),
    },
    createPromptLoop: (options) => {
      const engine = new CfHarnessEngine(options);
      return {
        runTranscript: async (runOptions) => {
          await engine.fabricSessionFactory!();
          return makeResult(runOptions, "Done.");
        },
      };
    },
    onEvent: ({ event }) => {
      if (event.kind === "session_closed") throw new Error("Peer disconnected");
    },
    onEventDeliveryError: () => {},
  });
  await service.startSession("open", {
    sessionId: "closing",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("start", {
    sessionId: "closing",
    input: { text: "Start" },
  });
  await service.waitForIdle();
  expect(service.listTurns({ sessionId: "closing" }).turns[0].turn.status)
    .toBe("completed");
  await expect(service.closeSession("close", "closing")).rejects.toThrow(
    "Peer disconnected",
  );
  expect(service.status("closing").sessions[0].status).toBe("closed");
  expect(disposed).toBe(1);
});

Deno.test("interactive service rejects duplicate session ids", async () => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
  });
  const first = await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  const duplicate = await service.startSession("req-2", {
    sessionId: "session-1",
    workspace: { hostPath: "/other-workspace" },
  });

  assertEquals(first.ok, true);
  assertEquals(duplicate.ok, false);
  assertEquals(
    duplicate.ok === false ? duplicate.error.code : "",
    "session_exists",
  );
  assertEquals(service.status().sessions.length, 1);
  assertEquals(
    service.status("session-1").sessions[0].workspace?.hostPath,
    "/workspace",
  );
});

Deno.test("interactive service rejects concurrent duplicate session creation after durable checks", async () => {
  let releaseDurableCheck: (() => void) | undefined;
  const durableCheck = new Promise<undefined>((resolve) => {
    releaseDurableCheck = () => resolve(undefined);
  });
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => durableCheck,
    listSessions: () => [],
    saveSessionAndAppendEvent: () => {},
    saveSessionTurnAndAppendEvent: () => true,
    saveTurn: () => {},
    getTurn: () => undefined,
    listTurns: () => [],
    appendEvent: () => {},
    listEvents: () => [],
    latestSequence: () => 0,
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });

  const first = service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  const duplicate = service.startSession("req-2", {
    sessionId: "session-1",
    workspace: { hostPath: "/other-workspace" },
  });
  releaseDurableCheck?.();
  const [firstResult, duplicateResult] = await Promise.all([
    first,
    duplicate,
  ]);

  assertEquals(firstResult.ok, true);
  assertEquals(duplicateResult.ok, false);
  assertEquals(
    duplicateResult.ok === false ? duplicateResult.error.code : "",
    "session_exists",
  );
  assertEquals(service.status().sessions.length, 1);
  assertEquals(
    service.status("session-1").sessions[0].workspace?.hostPath,
    "/workspace",
  );
});

Deno.test("interactive service serializes concurrent emitted event sequences", async () => {
  const persistedSequences: number[] = [];
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => undefined,
    listSessions: () => [],
    saveSessionAndAppendEvent: async (_snapshot, event) => {
      await Promise.resolve();
      persistedSequences.push(event.sequence);
    },
    saveSessionTurnAndAppendEvent: async (mutation) => {
      await Promise.resolve();
      persistedSequences.push(mutation.event.sequence);
      return true;
    },
    appendEvent: async (event) => {
      await Promise.resolve();
      persistedSequences.push(event.sequence);
    },
    listEvents: () => [],
    latestSequence: () => 0,
    saveTurn: () => {},
    getTurn: () => undefined,
    listTurns: () => [],
  };
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      const first = { role: "assistant" as const, content: "First." };
      const second = { role: "assistant" as const, content: "Second." };
      const firstTranscript = [...options.transcript, first];
      const secondTranscript = [...firstTranscript, second];
      const firstEvent = options.onTranscriptEvent?.({
        message: first,
        transcript: firstTranscript,
      }) ?? Promise.resolve();
      const secondEvent = options.onTranscriptEvent?.({
        message: second,
        transcript: secondTranscript,
      }) ?? Promise.resolve();
      await Promise.all([firstEvent, secondEvent]);
      return {
        model: "gpt-test",
        finalAssistantText: "Second.",
        transcript: secondTranscript,
        modelTurns: 1,
        runState: {} as HarnessPromptLoopResult["runState"],
      };
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
    sessionStore: store,
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Hi" },
  });
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(
    service.events("session-1").map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assertEquals(persistedSequences, [1, 2, 3, 4, 5, 6, 7]);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "assistant_delta",
      "assistant_delta",
      "assistant_completed",
      "assistant_completed",
      "turn_completed",
    ],
  );
});

Deno.test("interactive service rolls back in-memory turn state when start persistence fails", async () => {
  let failTurnPersistence = true;
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => undefined,
    listSessions: () => [],
    saveSessionAndAppendEvent: () => {},
    saveSessionTurnAndAppendEvent: () => {
      if (failTurnPersistence) {
        throw new Error("turn persistence failed");
      }
      return true;
    },
    appendEvent: () => {},
    listEvents: () => [],
    latestSequence: () => 0,
    saveTurn: () => {},
    getTurn: () => undefined,
    listTurns: () => [],
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await assertRejects(
    () =>
      service.startTurn("req-2", {
        sessionId: "session-1",
        turnId: "turn-1",
        input: { text: "First attempt" },
      }),
    Error,
    "turn persistence failed",
  );

  assertEquals(service.listTurns({ sessionId: "session-1" }).turns, []);
  assertEquals(service.status("session-1").sessions[0].status, "idle");

  failTurnPersistence = false;
  const retry = await service.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Retry" },
  });
  assertEquals(retry.ok, true);
  await service.waitForTurn("session-1", "turn-1");
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns.map((turn) =>
      turn.turn.status
    ),
    ["completed"],
  );
});

Deno.test("interactive service reserves turn start before durable duplicate checks", async () => {
  let releaseDurableTurnCheck: (() => void) | undefined;
  const durableTurnCheck = new Promise<undefined>((resolve) => {
    releaseDurableTurnCheck = () => resolve(undefined);
  });
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => undefined,
    listSessions: () => [],
    saveSessionAndAppendEvent: () => {},
    saveSessionTurnAndAppendEvent: () => true,
    appendEvent: () => {},
    listEvents: () => [],
    latestSequence: () => 0,
    saveTurn: () => {},
    getTurn: () => durableTurnCheck,
    listTurns: () => [],
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  const first = service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "First" },
  });
  const second = await service.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Second" },
  });
  assertEquals(second.ok, false);
  assertEquals(
    second.ok === false ? second.error.code : "",
    "turn_already_running",
  );

  releaseDurableTurnCheck?.();
  const firstResult = await first;
  assertEquals(firstResult.ok, true);
  await service.waitForTurn("session-1", "turn-1");
});

Deno.test("interactive service handles replay requests from durable store", async () => {
  const session = createHarnessChatSessionStatus({
    sessionId: "durable-session",
    createdAt: "2026-05-22T00:00:00.000Z",
    workspace: { hostPath: "/workspace" },
  });
  const durableEvent = createHarnessChatEventEnvelope({
    sessionId: session.sessionId,
    sequence: 42,
    emittedAt: "2026-05-22T00:00:42.000Z",
    event: {
      kind: "session_started",
      session,
    },
  });
  const durableTurn: HarnessChatTurnRecord = {
    sessionId: session.sessionId,
    turn: {
      turnId: "durable-turn",
      status: "completed",
      startedAt: "2026-05-22T00:00:01.000Z",
      updatedAt: "2026-05-22T00:00:02.000Z",
      endedAt: "2026-05-22T00:00:02.000Z",
    },
    input: { text: "Persisted turn" },
    policy: session.policy,
  };
  let eventsOptions: unknown;
  let turnsOptions: unknown;
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => undefined,
    listSessions: () => [],
    saveSessionAndAppendEvent: () => {},
    saveSessionTurnAndAppendEvent: () => true,
    appendEvent: () => {},
    listEvents: (options) => {
      eventsOptions = options;
      return [durableEvent];
    },
    latestSequence: () => 77,
    saveTurn: () => {},
    getTurn: () => undefined,
    listTurns: (options) => {
      turnsOptions = options;
      return [durableTurn];
    },
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    sessionStore: store,
  });

  const events = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-events",
    method: "list_events",
    params: {
      sessionId: session.sessionId,
      afterSequence: 41,
      limit: 1,
    },
  });
  assertEquals(events.ok, true);
  assertEquals(
    events.ok ? (events.result as HarnessChatListEventsResult) : undefined,
    {
      events: [durableEvent],
      latestSequence: 77,
    },
  );
  assertEquals(eventsOptions, {
    sessionId: session.sessionId,
    afterSequence: 41,
    limit: 1,
  });

  const turns = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-turns",
    method: "list_turns",
    params: {
      sessionId: session.sessionId,
      status: "completed",
    },
  });
  assertEquals(turns.ok, true);
  assertEquals(
    turns.ok ? (turns.result as HarnessChatListTurnsResult) : undefined,
    {
      turns: [durableTurn],
    },
  );
  assertEquals(turnsOptions, {
    sessionId: session.sessionId,
    status: "completed",
  });
});

Deno.test("interactive service rejects missing sessions and concurrent turns", async () => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
  });

  const missing = await service.handleRequest(
    {
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-missing",
      method: "start_turn",
      params: {
        sessionId: "missing",
        input: { text: "Hi" },
      },
    } satisfies HarnessChatRequestEnvelope<"start_turn">,
  );
  assertEquals(missing.ok, false);
  assertEquals(
    missing.ok === false ? missing.error.code : "",
    "session_not_found",
  );

  const ready = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  const busyService = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult({ transcript: [] }, "Done."));
          ready.resolve();
        }),
    }),
    now: nextIsoNow(),
  });
  await busyService.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await busyService.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "First" },
  });
  const concurrent = await busyService.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Second" },
  });
  assertEquals(concurrent.ok, false);
  assertEquals(
    concurrent.ok === false ? concurrent.error.code : "",
    "turn_already_running",
  );
  // Waiting is the whole remedy here, and nothing else in this file can say
  // that: the busy turn ends on its own and the identical request then works.
  assertEquals(
    concurrent.ok === false ? concurrent.error.retryable : undefined,
    true,
  );
  assertEquals(
    missing.ok === false ? missing.error.retryable : "unset",
    undefined,
  );
  await ready.promise;
  release?.();
  await busyService.waitForTurn("session-1", "turn-1");
});

Deno.test("interactive service terminalizes failed turns without closing the session", async () => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: () => Promise.reject(new Error("gateway unavailable")),
    }),
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Start" },
  });
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].reusable, true);
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    ["session_started", "turn_started", "turn_failed"],
  );
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn,
    {
      turnId: "turn-1",
      status: "failed",
      startedAt: "2026-05-22T00:00:03.000Z",
      updatedAt: "2026-05-22T00:00:05.000Z",
      endedAt: "2026-05-22T00:00:05.000Z",
      error: {
        code: "internal_error",
        message: "gateway unavailable",
      },
    },
  );

  const nextTurn = await service.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Retry" },
  });
  assertEquals(nextTurn.ok, true);
  await service.waitForTurn("session-1", "turn-2");
});

Deno.test("interactive service terminalizes prompt-loop setup failures", async () => {
  let createCount = 0;
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => {
      createCount += 1;
      if (createCount === 1) {
        throw new Error("prompt loop setup failed");
      }
      return {
        runTranscript: (options) => Promise.resolve(makeResult(options, "OK.")),
      };
    },
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  const first = await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Start" },
  });
  assertEquals(first.ok, true);
  await service.waitForTurn("session-1", "turn-1");

  assertEquals(service.status("session-1").sessions[0].status, "idle");
  assertEquals(service.status("session-1").sessions[0].reusable, true);
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "failed",
  );
  assertEquals(
    service.events("session-1").map((event) => event.event.kind),
    ["session_started", "turn_started", "turn_failed"],
  );

  const second = await service.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Retry" },
  });
  assertEquals(second.ok, true);
  await service.waitForTurn("session-1", "turn-2");
  assertEquals(service.status("session-1").sessions[0].status, "idle");
});

Deno.test("interactive service preserves every typed provider blocker", async () => {
  for (
    const code of [
      "provider-configuration-required",
      "provider-auth-required",
      "provider-mismatch",
      "provider-unavailable",
    ] as const
  ) {
    const service = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: () =>
          Promise.reject(
            new HarnessControlError(code, `provider blocker: ${code}`),
          ),
      }),
      now: nextIsoNow(),
    });
    await service.startSession("req-1", {
      sessionId: `session-${code}`,
      workspace: { hostPath: "/workspace" },
    });
    await service.startTurn("req-2", {
      sessionId: `session-${code}`,
      turnId: `turn-${code}`,
      input: { text: "Start" },
    });
    await service.waitForTurn(`session-${code}`, `turn-${code}`);

    assertEquals(
      service.listTurns({ sessionId: `session-${code}` }).turns[0].turn.error,
      { code, message: `provider blocker: ${code}` },
    );
  }
});

Deno.test("a completed turn promotes its transcript independently of the loop's array", async () => {
  const returnedTranscripts: HarnessTranscriptMessage[][] = [];
  const seenTranscripts: (readonly HarnessTranscriptMessage[])[] = [];
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: (options) => {
      seenTranscripts.push([...options.transcript]);
      const transcript: HarnessTranscriptMessage[] = [
        ...options.transcript,
        { role: "assistant", content: "Done." },
      ];
      returnedTranscripts.push(transcript);
      return Promise.resolve({
        model: "gpt-test",
        finalAssistantText: "Done.",
        transcript,
        modelTurns: 1,
        runState: {} as HarnessPromptLoopResult["runState"],
      });
    },
  });
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Hi" },
  });
  await service.waitForTurn("session-1", "turn-1");

  // The loop owns the array it returned; the durable checkpoint must not track
  // an append made to it after the turn settled.
  returnedTranscripts[0].push({ role: "assistant", content: "Stray." });

  await service.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Again" },
  });
  await service.waitForTurn("session-1", "turn-2");

  expect(seenTranscripts[1]).toEqual([
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Done." },
    ...unattachedTurnContext(),
    { role: "user", content: "Again" },
  ]);
});

Deno.test("a completed turn whose transcript is unpaired is failed, not promoted", async () => {
  const { store, snapshots } = recordingStore();
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      // A loop that reports success while leaving a tool call unanswered. Its
      // history would be refused by a provider on the following turn.
      runTranscript: (options) =>
        Promise.resolve({
          model: "gpt-test",
          finalAssistantText: "Reading.",
          transcript: [...options.transcript, {
            role: "assistant" as const,
            content: "Reading.",
            toolCalls: [toolCall("call-a")],
          }],
          modelTurns: 1,
          runState: {} as HarnessPromptLoopResult["runState"],
        }),
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });
  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Read a file" },
  });
  await service.waitForTurn("session-1", "turn-1");

  for (const snapshot of snapshots) {
    assertEquals(inspectHarnessTranscriptPairing(snapshot).valid, true);
  }
  assertEquals(snapshots[snapshots.length - 1], []);
  const turn = service.listTurns({ sessionId: "session-1" }).turns[0];
  assertEquals(turn.turn.status, "failed");
  assertEquals(turn.turn.error?.code, "incomplete_transcript");
});

Deno.test("a completion whose persistence fails leaves the previous checkpoint durable", async () => {
  const snapshots: HarnessTranscriptMessage[][] = [];
  let failCompletion = false;
  const store: HarnessChatSessionStore = {
    saveSession: (snapshot) => {
      snapshots.push([...snapshot.transcript]);
    },
    getSession: () => undefined,
    listSessions: () => [],
    saveSessionAndAppendEvent: (snapshot) => {
      snapshots.push([...snapshot.transcript]);
    },
    saveSessionTurnAndAppendEvent: (mutation) => {
      if (failCompletion && mutation.event.event.kind === "turn_completed") {
        throw new Error("the session store went away mid-commit");
      }
      snapshots.push([...mutation.session.transcript]);
      return true;
    },
    saveTurn: () => {},
    getTurn: () => undefined,
    listTurns: () => [],
    appendEvent: () => {},
    listEvents: () => [],
    latestSequence: () => 0,
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });
  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Hi" },
  });
  await service.waitForTurn("session-1", "turn-1");
  const afterFirstTurn = snapshots[snapshots.length - 1];

  failCompletion = true;
  await service.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Again" },
  });
  await service.waitForTurn("session-1", "turn-2");

  // The completion never committed, so the turn is failed and the durable
  // checkpoint is still the one the first turn left behind.
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[1].turn.status,
    "failed",
  );
  assertEquals(snapshots[snapshots.length - 1], afterFirstTurn);
});

// The invariant the whole change exists to hold: whatever a turn does, nothing
// a provider would reject ever reaches durable storage, and a turn that does
// not complete leaves the checkpoint before it untouched. Enumerating the fault
// points beats picking two of them, and asserting over every persisted snapshot
// beats asserting over the last.
for (const resultsBeforeFault of FAULT_POINTS) {
  for (const fault of FAULT_KINDS) {
    Deno.test(`a turn that hits ${fault} after ${resultsBeforeFault} of two tool results keeps the checkpoint provider-safe`, async () => {
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      let reachFault: (() => void) | undefined;
      const reachedFault = new Promise<void>((resolve) => {
        reachFault = resolve;
      });
      const { store, snapshots } = recordingStore();
      const nextTurnTranscripts: (readonly HarnessTranscriptMessage[])[] = [];
      let turn = 0;
      const service = new HarnessInteractiveChatService({
        createPromptLoop: (options) => {
          turn += 1;
          return turn === 1
            ? faultingToolLoop(resultsBeforeFault, fault, {
              release: held,
              onFault: () => reachFault?.(),
            })(options)
            : {
              runTranscript: (runOptions) => {
                nextTurnTranscripts.push([...runOptions.transcript]);
                return Promise.resolve(makeResult(runOptions, "Done."));
              },
            };
        },
        now: nextIsoNow(),
        sessionStore: store,
      });
      await service.startSession("req-1", {
        sessionId: "session-1",
        workspace: { hostPath: "/workspace" },
      });
      await service.startTurn("req-2", {
        sessionId: "session-1",
        turnId: "turn-1",
        input: { text: "Read both files" },
      });
      if (fault === "cancel") {
        // Cancel mid-tool, once the loop has reported what it ever will.
        await reachedFault;
        await service.cancelTurn(
          "req-3",
          "session-1",
          "turn-1",
          "user_requested",
        );
      }
      release?.();
      await service.waitForTurn("session-1", "turn-1");

      for (const snapshot of snapshots) {
        assertEquals(
          inspectHarnessTranscriptPairing(snapshot).valid,
          true,
          `persisted history a provider would reject: ${
            JSON.stringify(snapshot)
          }`,
        );
      }
      // A failed turn rolls back whole, user message included: its tools
      // already ran and it is never replayed. A canceled one keeps its request
      // and the last complete batch, then says it was stopped; a batch still
      // missing a result is left out.
      const request = [{
        role: "user" as const,
        content: "Read both files",
      }];
      const kept: HarnessTranscriptMessage[] = fault === "error" ? [] : [
        ...request,
        ...(resultsBeforeFault === 2
          ? [
            {
              role: "assistant" as const,
              content: "Reading both files.",
              toolCalls: ["call-a", "call-b"].map(toolCall),
            },
            ...["call-a", "call-b"].map((id) => ({
              role: "tool" as const,
              toolCallId: id,
              toolName: "read_file",
              content: `contents for ${id}`,
            })),
          ]
          : []),
        { role: "user", content: HARNESS_CHAT_INTERRUPTED_TURN_NOTICE },
      ];
      expect(snapshots[snapshots.length - 1]).toEqual(kept);
      // A failed turn's own history stays on the audit trail even though its
      // model history went back. A canceled one is not checked here: cancelling
      // stops reporting the turn, so how much of it reached the log depends on
      // where the cancel landed.
      if (fault === "error") {
        const kinds = service.events("session-1").map((event) =>
          event.event.kind
        );
        assertEquals(kinds.filter((kind) => kind === "tool_started").length, 2);
        assertEquals(
          kinds.filter((kind) => kind === "tool_completed").length,
          resultsBeforeFault,
        );
      }

      // The turn after it starts from that checkpoint: no trace of a failed
      // turn, and a canceled one's request and completed work.
      await service.startTurn("req-4", {
        sessionId: "session-1",
        turnId: "turn-2",
        input: { text: "Try again" },
      });
      await service.waitForTurn("session-1", "turn-2");
      expect(nextTurnTranscripts).toEqual([[
        ...kept,
        ...unattachedTurnContext(),
        { role: "user", content: "Try again" },
      ]]);
    });
  }
}

Deno.test("a session stays reusable after a turn fails mid-tool", async () => {
  const { store } = recordingStore();
  const service = new HarnessInteractiveChatService({
    createPromptLoop: faultingToolLoop(1, "error"),
    now: nextIsoNow(),
    sessionStore: store,
  });
  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Read both files" },
  });
  await service.waitForTurn("session-1", "turn-1");

  const session = service.status("session-1").sessions[0];
  assertEquals(session.status, "idle");
  assertEquals(session.reusable, true);
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "failed",
  );
});

Deno.test("a normalization whose write fails leaves the record on the stored history", async () => {
  const corrupt: HarnessTranscriptMessage[] = [
    { role: "user", content: "Read both files" },
    {
      role: "assistant",
      content: "Reading both files.",
      toolCalls: [toolCall("call-a"), toolCall("call-b")],
    },
  ];
  const store: HarnessChatSessionStore = {
    saveSession: () => {},
    getSession: () => undefined,
    listSessions: () => [{
      session: createHarnessChatSessionStatus({
        sessionId: "session-1",
        createdAt: "2026-05-22T00:00:01.000Z",
        workspace: { hostPath: "/workspace" },
      }),
      transcript: corrupt,
    }],
    saveSessionAndAppendEvent: () => {
      throw new Error("the session store went away mid-commit");
    },
    saveSessionTurnAndAppendEvent: () => {
      throw new Error("the session store went away mid-commit");
    },
    saveTurn: () => {},
    getTurn: () => undefined,
    listTurns: () => [],
    appendEvent: () => {},
    listEvents: () => [],
    latestSequence: () => 0,
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
    sessionStore: store,
  });

  await assertRejects(() => service.initializeFromStore());

  // The normalization never committed, so the record still names the history
  // held by the store and remains unavailable for a provider request.
  const started = await service.startTurn("req-1", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Try again" },
  });
  assertEquals(started.ok, false);
  assertEquals(
    started.ok === false ? started.error.code : "",
    "incomplete_transcript",
  );
});

/** The console binds a person's typed prompt as the turn's direct command. */
const directPromptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "interactive-chat" },
  role: "direct-command",
  kernelName: "cf-harness",
  surface: "test",
  subject: "interactive-chat",
  eventId: "event-interactive-chat",
};

Deno.test("an interactive turn scans its configured skills root into the run and a pattern-author child inherits it", async () => {
  await using fixture = await createPatternSkillsFixture();
  const skillsRoot = fixture.skillsRoot;
  const loopOptions: CreateHarnessPromptLoopOptions[] = [];
  const requestBodies: unknown[] = [];
  const service = new HarnessInteractiveChatService({
    basePromptLoopOptions: {
      apiKey: "test-key",
      skillsRoot,
      runId: "run-interactive-skills",
      ...INERT_ENFORCING_RUNSC,
      fetchFn: (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requestBodies.push(body);
        const payload = requestBodies.length === 1
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-delegate-pattern-author",
                  type: "function",
                  function: {
                    name: "delegate_task",
                    arguments: JSON.stringify({
                      goal: "Author a counter pattern.",
                      profile: "pattern-author",
                    }),
                  },
                }],
              },
            }],
          }
          : requestBodies.length === 2
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call-read-skill-resource",
                  type: "function",
                  function: {
                    name: "read_skill_resource",
                    arguments: JSON.stringify({
                      skill: "pattern-ui",
                      path: PATTERN_SKILL_FIXTURE_RESOURCE_PATH,
                    }),
                  },
                }],
              },
            }],
          }
          : requestBodies.length === 3
          ? {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Read the component patterns reference.",
              },
            }],
          }
          : {
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Pattern authored.",
              },
            }],
          };
        return Promise.resolve(
          new Response(
            JSON.stringify(
              responsesBodyFromChatFixture(payload, init?.body ?? null),
            ),
            { status: 200 },
          ),
        );
      },
    },
    createPromptLoop: (options) => {
      loopOptions.push(options);
      return new CfHarnessPromptLoop(options);
    },
    now: nextIsoNow(),
    randomUUID: () => "generated-id",
  });

  const startSession = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-1",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
      model: "gpt-test",
      policy: {
        type: "cf-harness.chat-policy",
        toolMode: "workspace-write",
        allowedToolIds: ["delegate_task"],
        allowedSubagentProfiles: ["pattern-author"],
        promptSlot: directPromptSlotBinding,
      },
    },
  });
  assertEquals(startSession.ok, true);

  const startTurn = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-2",
    method: "start_turn",
    params: {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Author a counter pattern." },
    },
  });
  assertEquals(startTurn.ok, true);
  await service.waitForTurn("session-1", "turn-1");

  const registry = loopOptions[0].engine?.getRunState().skillRegistry;
  assertEquals(registry?.skillsRoot, skillsRoot);
  for (const name of PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES) {
    assertEquals(
      registry?.skills.some((skill) => skill.name === name),
      true,
      `run-start registry names ${name}`,
    );
  }

  // The child's first request carries the profile's preloaded skills, which
  // it can only have inherited from the parent run's registry.
  assertStringIncludes(
    chatViewOfRequest(requestBodies[1]).messages[1].content,
    '<skill_context name="pattern-dev"',
  );
  const readMessage = chatViewOfRequest(requestBodies[2]).messages.at(-1);
  assertEquals(readMessage?.role, "tool");
  const readOutput = JSON.parse(readMessage?.content ?? "") as {
    status: string;
    digestMatchesRegistry?: boolean;
    content?: string;
  };
  assertEquals(readOutput.status, "read");
  assertEquals(readOutput.digestMatchesRegistry, true);
  assertEquals((readOutput.content ?? "").length > 0, true);
});

/** A sandbox a no-tool turn never drives; enough to build an engine. */
class StubSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }
  resolvePath(path: string): string {
    return path.startsWith("/") ? path : `/workspace/${path}`;
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
  run(): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  runShell(): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

Deno.test("an interactive turn scans a skills root carried on an injected engine's config", async () => {
  // The console passes the skills root on the options directly; an injected
  // engine carries it on `engine.config` instead, with no top-level
  // `skillsRoot`. Both must scan — reading the options alone would miss this.
  await using fixture = await createPatternSkillsFixture();
  const engine = new CfHarnessEngine({
    sandboxRuntime: new StubSandboxRuntime(),
    runId: "run-interactive-injected-engine",
    model: "gpt-test",
    skillsRoot: fixture.skillsRoot,
  });
  const service = new HarnessInteractiveChatService({
    basePromptLoopOptions: {
      apiKey: "test-key",
      engine,
      fetchFn: (_input, init) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              responsesBodyFromChatFixture(
                {
                  choices: [{
                    index: 0,
                    message: { role: "assistant", content: "Done." },
                  }],
                },
                init?.body ?? null,
              ),
            ),
            { status: 200 },
          ),
        ),
    },
    createPromptLoop: (options) => new CfHarnessPromptLoop(options),
    now: nextIsoNow(),
    randomUUID: () => "generated-id",
  });

  const startSession = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-1",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
      model: "gpt-test",
      policy: {
        type: "cf-harness.chat-policy",
        toolMode: "workspace-write",
        allowedToolIds: ["read_file"],
        allowedSubagentProfiles: [],
      },
    },
  });
  assertEquals(startSession.ok, true);

  const startTurn = await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-2",
    method: "start_turn",
    params: {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Say hi." },
    },
  });
  assertEquals(startTurn.ok, true);
  await service.waitForTurn("session-1", "turn-1");

  // The scan ran against the injected engine even though no top-level
  // skillsRoot was set, so its run state now carries the registry.
  const registry = engine.getRunState().skillRegistry;
  assertEquals(registry?.skillsRoot, fixture.skillsRoot);
});

Deno.test("a listener that throws does not turn a completed turn into a failed one", async () => {
  const delivered: string[] = [];
  const deliveryFailures: [number, unknown][] = [];
  const service = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
    }),
    now: nextIsoNow(),
    onEvent: (envelope) => {
      if (envelope.event.kind === "turn_completed") {
        throw new Error("the peer stopped reading");
      }
      delivered.push(envelope.event.kind);
    },
    onEventDeliveryError: (envelope, error) => {
      deliveryFailures.push([envelope.sequence, error]);
    },
  });

  await service.startSession("req-1", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-2", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Hi" },
  });
  await service.waitForTurn("session-1", "turn-1");

  // Failing to hand an event to a listener is a delivery failure. The turn it
  // reports on already committed and stays committed.
  const kinds = service.events("session-1").map((event) => event.event.kind);
  assertEquals(kinds.filter((kind) => kind === "turn_failed").length, 0);
  assertEquals(kinds[kinds.length - 1], "turn_completed");
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
    "completed",
  );
  assertEquals(
    service.status("session-1").sessions[0].status,
    "idle",
  );
  // And it is reported rather than swallowed.
  assertEquals(deliveryFailures.length, 1);
  assertEquals(
    (deliveryFailures[0][1] as Error).message,
    "the peer stopped reading",
  );

  // A failed delivery does not stop the service delivering to that listener,
  // and the turn that follows it is decided the same way.
  await service.startTurn("req-3", {
    sessionId: "session-1",
    turnId: "turn-2",
    input: { text: "Again" },
  });
  await service.waitForTurn("session-1", "turn-2");

  assertEquals(delivered.includes("turn_started"), true);
  assertEquals(
    service.listTurns({ sessionId: "session-1" }).turns.map((entry) =>
      entry.turn.status
    ),
    ["completed", "completed"],
  );
  assertEquals(deliveryFailures.length, 2);
});

/** A store that holds nothing; each case overrides what it observes. */
const emptyStore = (
  overrides: Partial<HarnessChatSessionStore> = {},
): HarnessChatSessionStore => ({
  saveSession: () => {},
  getSession: () => undefined,
  listSessions: () => [],
  saveSessionAndAppendEvent: () => {},
  saveSessionTurnAndAppendEvent: () => true,
  saveTurn: () => {},
  getTurn: () => undefined,
  listTurns: () => [],
  appendEvent: () => {},
  listEvents: () => [],
  latestSequence: () => 0,
  ...overrides,
});

/** A loop that reports `messages` as its transcript events, then answers. */
const replayingLoop = (
  messages: readonly HarnessTranscriptMessage[],
): HarnessInteractivePromptLoopFactory =>
() => ({
  runTranscript: async (options) => {
    const transcript = [...options.transcript];
    for (const message of messages) {
      transcript.push(message);
      await options.onTranscriptEvent?.({
        message,
        transcript: [...transcript],
      });
    }
    return { ...makeResult(options, "Done."), transcript };
  },
});

/** Runs one turn of `createPromptLoop` in a fresh session. */
const runOneTurn = async (
  createPromptLoop: HarnessInteractivePromptLoopFactory,
): Promise<HarnessInteractiveChatService> => {
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    now: nextIsoNow(),
  });
  await service.startSession("req-session", {
    sessionId: "session-1",
    workspace: { hostPath: "/workspace" },
  });
  await service.startTurn("req-turn", {
    sessionId: "session-1",
    turnId: "turn-1",
    input: { text: "Go" },
  });
  await service.waitForTurn("session-1", "turn-1");
  return service;
};

const answeringLoop: HarnessInteractivePromptLoopFactory = () => ({
  runTranscript: (options) => Promise.resolve(makeResult(options, "Done.")),
});

const errorCodeOf = (response: { ok: boolean; error?: { code: string } }) =>
  response.ok ? undefined : response.error?.code;

describe("HarnessInteractiveChatService", () => {
  describe("constructor()", () => {
    it("refuses a Codex service whose model client names no credential owner", () => {
      expect(() =>
        new HarnessInteractiveChatService({
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "loom:user-1",
          },
          basePromptLoopOptions: {
            modelProvider: "openai-codex",
            credentialOwnerKey: "loom:user-1",
          },
        })
      ).toThrow("model client with an exact credential owner binding");
    });

    it("refuses an event retention limit that is negative or fractional", () => {
      for (const maxInMemoryEvents of [-1, 1.5]) {
        expect(() => new HarnessInteractiveChatService({ maxInMemoryEvents }))
          .toThrow("maxInMemoryEvents must be a non-negative integer");
      }
    });

    it("keeps only the newest events under an event retention limit", async () => {
      const service = new HarnessInteractiveChatService({
        maxInMemoryEvents: 1,
        now: nextIsoNow(),
      });
      for (const sessionId of ["session-1", "session-2"]) {
        await service.startSession(`req-${sessionId}`, {
          sessionId,
          workspace: { hostPath: "/workspace" },
        });
      }

      expect(service.events().map((event) => event.sessionId)).toEqual([
        "session-2",
      ]);
    });

    it("treats a Loom manifest without a local provider and auth source as no host binding", async () => {
      const credentialOwner = {
        type: "cf-harness.credential-owner-ref" as const,
        version: 1 as const,
        ownerKey: "local",
      };
      const binding = {
        source: "loom" as const,
        modelProvider: "openai-compatible-gateway" as const,
        modelAuthSource: "none" as const,
        credentialOwner,
        harnessHomeIdentity: "sha256:home-a",
      };
      const manifests = [
        { ...binding, modelProvider: undefined },
        { ...binding, modelAuthSource: "owner-bound-oauth" as const },
      ];
      for (const manifest of manifests) {
        const service = new HarnessInteractiveChatService({
          basePromptLoopOptions: {
            runManifest: {
              type: "cf-harness.loom-run-manifest",
              version: 1,
              ...manifest,
            },
          },
          now: nextIsoNow(),
        });
        // A bound service refuses a session with no model; an unbound one
        // takes it.
        const started = await service.startSession("req-1", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        expect(started.ok).toBe(true);
        expect(
          service.status("session-1").sessions[0].loomLocalHostBinding,
        ).toBeUndefined();
      }
    });
  });

  describe("instance members", () => {
    describe("startSession()", () => {
      it("forgets a session whose start the store refuses, and refuses a turn begun meanwhile", async () => {
        const saving = Promise.withResolvers<void>();
        const failSave = Promise.withResolvers<void>();
        const checkingTurn = Promise.withResolvers<void>();
        const finishTurnCheck = Promise.withResolvers<undefined>();
        const appended: string[] = [];
        let loops = 0;
        const service = new HarnessInteractiveChatService({
          createPromptLoop: (options) => {
            loops += 1;
            return answeringLoop(options);
          },
          now: nextIsoNow(),
          sessionStore: emptyStore({
            saveSessionAndAppendEvent: async () => {
              saving.resolve();
              await failSave.promise;
              throw new Error("the store refused the session");
            },
            getTurn: () => {
              checkingTurn.resolve();
              return finishTurnCheck.promise;
            },
            appendEvent: (event) => {
              appended.push(event.event.kind);
            },
          }),
        });

        const session = service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        await saving.promise;
        const turn = service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        });
        await checkingTurn.promise;
        failSave.resolve();
        await expect(session).rejects.toThrow("the store refused the session");
        expect(service.status().sessions).toEqual([]);

        finishTurnCheck.resolve(undefined);
        expect(errorCodeOf(await turn)).toBe("session_not_found");
        expect(appended).toEqual(["turn_started"]);
        expect(loops).toBe(0);
      });
    });

    describe("startTurn()", () => {
      it("refuses a turn id the session already ran and accepts a new one", async () => {
        const service = await runOneTurn(answeringLoop);

        const again = await service.startTurn("req-again", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Again" },
        });
        expect(errorCodeOf(again)).toBe("turn_exists");

        const next = await service.startTurn("req-next", {
          sessionId: "session-1",
          turnId: "turn-2",
          input: { text: "Next" },
        });
        expect(next.ok).toBe(true);
        await service.waitForTurn("session-1", "turn-2");
      });

      it("refuses a turn id the store already holds before running a loop", async () => {
        let loops = 0;
        const service = new HarnessInteractiveChatService({
          createPromptLoop: (options) => {
            loops += 1;
            return answeringLoop(options);
          },
          now: nextIsoNow(),
          sessionStore: emptyStore({
            getTurn: (sessionId, turnId) =>
              turnId === "turn-taken"
                ? {
                  sessionId,
                  turn: {
                    turnId,
                    status: "completed",
                    startedAt: "2026-05-22T00:00:00.000Z",
                    updatedAt: "2026-05-22T00:00:00.000Z",
                  },
                  input: { text: "Earlier" },
                  policy: READONLY_HARNESS_CHAT_POLICY,
                }
                : undefined,
          }),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });

        const taken = await service.startTurn("req-taken", {
          sessionId: "session-1",
          turnId: "turn-taken",
          input: { text: "Go" },
        });
        expect(errorCodeOf(taken)).toBe("turn_exists");
        expect(loops).toBe(0);
        expect(service.status("session-1").sessions[0].status).toBe("idle");
      });

      it("refuses a turn whose creation another writer won, and leaves the session free", async () => {
        const service = new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: nextIsoNow(),
          sessionStore: emptyStore({
            saveSessionTurnAndAppendEvent: (mutation) =>
              !(mutation.createTurn === true &&
                mutation.turn.turn.turnId === "turn-raced"),
          }),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });

        const raced = await service.startTurn("req-raced", {
          sessionId: "session-1",
          turnId: "turn-raced",
          input: { text: "Go" },
        });
        expect(errorCodeOf(raced)).toBe("turn_exists");

        const next = await service.startTurn("req-next", {
          sessionId: "session-1",
          turnId: "turn-2",
          input: { text: "Go" },
        });
        expect(next.ok).toBe(true);
        await service.waitForTurn("session-1", "turn-2");
      });

      it("refuses a turn begun while the previous turn's start is still being delivered", async () => {
        const concurrent: Promise<{ ok: boolean; error?: { code: string } }>[] =
          [];
        const service: HarnessInteractiveChatService =
          new HarnessInteractiveChatService({
            createPromptLoop: answeringLoop,
            now: nextIsoNow(),
            onEvent: (envelope) => {
              if (
                envelope.event.kind === "turn_started" &&
                envelope.turnId === "turn-1"
              ) {
                concurrent.push(service.startTurn("req-concurrent", {
                  sessionId: "session-1",
                  turnId: "turn-2",
                  input: { text: "Too soon" },
                }));
              }
            },
          });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        await service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        });
        await service.waitForTurn("session-1", "turn-1");

        expect((await Promise.all(concurrent)).map(errorCodeOf)).toEqual([
          "turn_already_running",
        ]);
        expect(
          service.listTurns({ sessionId: "session-1" }).turns.map((
            entry,
          ) => entry.turn.turnId),
        ).toEqual(["turn-1"]);
      });
    });

    describe("opening research progress", () => {
      /**
       * Runs one turn whose loop reports its opening research starting, then
       * waits for `settle` before reporting it completed, and returns the
       * research progress events the session recorded.
       */
      const researchEventsOfTurn = async (
        settle: (service: HarnessInteractiveChatService) => Promise<void>,
      ) => {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const research = { toolCallId: "opening-research:turn-1" };
        const service = new HarnessInteractiveChatService({
          createPromptLoop: () => ({
            runTranscript: async (options) => {
              await options.onOpeningResearch?.({
                ...research,
                status: "pending",
              });
              started.resolve();
              await release.promise;
              await options.onOpeningResearch?.({
                ...research,
                status: "completed",
              });
              return makeResult(options, "Done.");
            },
          }),
          now: nextIsoNow(),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        await service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Build a counter." },
        });
        await started.promise;
        await settle(service);
        release.resolve();
        await service.waitForTurn("session-1", "turn-1");
        return service.events("session-1").flatMap(({ event }) =>
          (event.kind === "tool_started" || event.kind === "tool_completed") &&
            event.tool.toolId === "research"
            ? [event.kind]
            : []
        );
      };

      it("reports the opening research starting and completing", async () => {
        expect(await researchEventsOfTurn(() => Promise.resolve())).toEqual([
          "tool_started",
          "tool_completed",
        ]);
      });

      it("reports no research progress once the turn is canceled", async () => {
        expect(
          await researchEventsOfTurn(async (service) => {
            await service.cancelTurn("req-cancel", "session-1", "turn-1");
          }),
        ).toEqual(["tool_started"]);
      });
    });

    describe("cancelTurn()", () => {
      it("records a turn that stops the moment it is canceled as canceled, leaving the session idle", async () => {
        const running = Promise.withResolvers<void>();
        const service = new HarnessInteractiveChatService({
          createPromptLoop: () => ({
            runTranscript: (options) =>
              new Promise((_, reject) => {
                options.signal?.addEventListener(
                  "abort",
                  () => reject(options.signal?.reason),
                  { once: true },
                );
                running.resolve();
              }),
          }),
          now: nextIsoNow(),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        await service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        });
        await running.promise;

        await service.cancelTurn("req-cancel", "session-1", "turn-1", "stop");
        await service.waitForTurn("session-1", "turn-1");
        expect(service.status("session-1").sessions[0].status).toBe("idle");
        expect(
          service.listTurns({ sessionId: "session-1" }).turns.map((entry) => [
            entry.turn.status,
            entry.turn.cancelReason,
          ]),
        ).toEqual([["canceled", "stop"]]);
      });

      it("refuses to cancel in a session it does not hold", async () => {
        const service = new HarnessInteractiveChatService({});
        expect(errorCodeOf(await service.cancelTurn("req-1", "missing")))
          .toBe("session_not_found");
      });

      it("refuses to cancel when no turn is running or another turn is", async () => {
        const running = Promise.withResolvers<() => void>();
        const service = new HarnessInteractiveChatService({
          createPromptLoop: () => ({
            runTranscript: (options) =>
              new Promise((resolve) => {
                running.resolve(() => resolve(makeResult(options, "Done.")));
              }),
          }),
          now: nextIsoNow(),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        expect(errorCodeOf(await service.cancelTurn("req-idle", "session-1")))
          .toBe("turn_not_found");

        await service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        });
        expect(
          errorCodeOf(
            await service.cancelTurn("req-other", "session-1", "turn-other"),
          ),
        ).toBe("turn_not_found");
        expect(service.status("session-1").sessions[0].status).toBe(
          "turn_running",
        );

        (await running.promise)();
        await service.waitForTurn("session-1", "turn-1");
      });
    });

    describe("waitForTurn()", () => {
      it("throws for a session or turn it does not hold", async () => {
        const service = new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: nextIsoNow(),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        await service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        });

        await expect(service.waitForTurn("session-1", "no-such-turn")).rejects
          .toThrow("session session-1 has no turn no-such-turn");
        await expect(service.waitForTurn("missing", "turn-1")).rejects
          .toThrow("no session missing");
        await service.waitForTurn("session-1", "turn-1");
        expect(
          service.listTurns({ sessionId: "session-1" }).turns.map((entry) =>
            entry.turn.status
          ),
        ).toEqual(["completed"]);
      });

      it("waits for a turn whose start is still being delivered", async () => {
        const delivering = Promise.withResolvers<void>();
        const delivered = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<() => void>();
        const service = new HarnessInteractiveChatService({
          createPromptLoop: () => ({
            runTranscript: (options) =>
              new Promise((resolve) => {
                answer.resolve(() => resolve(makeResult(options, "Done.")));
              }),
          }),
          now: nextIsoNow(),
          onEvent: async (envelope) => {
            if (envelope.event.kind !== "turn_started") return;
            delivering.resolve();
            await delivered.promise;
          },
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        const started = service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        });
        await delivering.promise;

        // The turn is recorded while its start is still being delivered, and
        // waiting for it then lasts until it has settled.
        const waited = service.waitForTurn("session-1", "turn-1").then(() =>
          service.listTurns({ sessionId: "session-1" }).turns[0].turn.status
        );
        delivered.resolve();
        await started;
        (await answer.promise)();
        expect(await waited).toBe("completed");
      });

      it("settles a turn whose start fails to be delivered, leaving the session free for the next", async () => {
        const undelivered: string[] = [];
        const service = new HarnessInteractiveChatService({
          createPromptLoop: answeringLoop,
          now: nextIsoNow(),
          onEventDeliveryError: (envelope) => {
            undelivered.push(envelope.event.kind);
          },
          onEvent: (envelope) => {
            if (
              envelope.event.kind === "turn_started" &&
              envelope.turnId === "turn-1"
            ) {
              throw new Error("the start was not delivered");
            }
          },
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });

        await expect(service.startTurn("req-turn", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        })).rejects.toThrow("the start was not delivered");
        expect(undelivered).toEqual(["turn_started"]);
        await service.waitForTurn("session-1", "turn-1");
        expect(service.status("session-1").sessions[0].status).toBe("idle");

        expect(
          errorCodeOf(
            await service.startTurn("req-next", {
              sessionId: "session-1",
              turnId: "turn-2",
              input: { text: "Again" },
            }),
          ),
        ).toBeUndefined();
        await service.waitForTurn("session-1", "turn-2");
        expect(
          service.listTurns({ sessionId: "session-1" }).turns.map((entry) =>
            entry.turn.status
          ),
        ).toEqual(["completed", "completed"]);
      });

      it("returns for a settled turn without waiting for the running one", async () => {
        const second = Promise.withResolvers<() => void>();
        let runs = 0;
        const service = new HarnessInteractiveChatService({
          createPromptLoop: () => ({
            runTranscript: (options) =>
              ++runs === 1
                ? Promise.resolve(makeResult(options, "First."))
                : new Promise((resolve) => {
                  second.resolve(() => resolve(makeResult(options, "Second.")));
                }),
          }),
          now: nextIsoNow(),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        await service.startTurn("req-first", {
          sessionId: "session-1",
          turnId: "turn-1",
          input: { text: "Go" },
        });
        await service.waitForTurn("session-1", "turn-1");
        await service.startTurn("req-second", {
          sessionId: "session-1",
          turnId: "turn-2",
          input: { text: "Again" },
        });
        const release = await second.promise;

        // Both racers are ready to settle, so the first in the list wins
        // unless waiting for turn-1 waits on the still-running turn-2.
        expect(
          await Promise.race([
            service.waitForTurn("session-1", "turn-1").then(() => "returned"),
            second.promise.then(() => "waited"),
          ]),
        ).toBe("returned");
        expect(service.status("session-1").sessions[0].activeTurnId).toBe(
          "turn-2",
        );

        release();
        await service.waitForTurn("session-1", "turn-2");
        expect(
          service.listTurns({ sessionId: "session-1" }).turns.map((entry) =>
            entry.turn.status
          ),
        ).toEqual(["completed", "completed"]);
      });
    });

    describe("closeSession()", () => {
      it("refuses to close a session it does not hold", async () => {
        const service = new HarnessInteractiveChatService({});
        expect(errorCodeOf(await service.closeSession("req-1", "missing")))
          .toBe("session_not_found");
      });
    });

    describe("releaseFabricRuntimes()", () => {
      /**
       * A service with one session whose turn has opened a real emulated
       * Fabric runtime for each of `releases`. Disposing of a runtime
       * disposes of it for real and then runs its release, whose failure is
       * the disposal's.
       */
      const serviceHoldingRuntimes = async (
        releases: readonly (() => Promise<void>)[],
      ) => {
        const signer = await Identity.fromPassphrase("cf-harness chat service");
        const spaceDid = (await Identity.generate()).did();
        const storages = releases.map(() =>
          StorageManager.emulate({ as: signer })
        );
        const sessions = releases.map((release, index) => {
          const runtime = new Runtime({
            apiUrl: new URL("http://toolshed.test"),
            storageManager: storages[index],
          });
          const dispose = runtime.dispose.bind(runtime);
          stub(runtime, "dispose", async () => {
            await dispose();
            await release();
          });
          return {
            pieces: new PiecesController(
              createSession({ identity: signer, spaceDid }),
              runtime,
            ),
          };
        });
        const service = new HarnessInteractiveChatService({
          basePromptLoopOptions: {
            ...INERT_RUNSC,
            fabricSessionFactory: () => Promise.resolve(sessions[0]),
          },
          createPromptLoop: (options) => ({
            runTranscript: (run) => {
              for (const session of sessions) {
                options.onFabricSessionCreated?.(session);
              }
              return Promise.resolve(makeResult(run, "Done."));
            },
          }),
        });
        await service.startSession("req-session", {
          sessionId: "session-1",
          workspace: { hostPath: "/workspace" },
        });
        await service.startTurn("req-turn", {
          sessionId: "session-1",
          input: { text: "Go" },
        });
        await service.waitForIdle();
        return {
          service,
          close: async () => {
            for (const storage of storages) await storage.close();
          },
        };
      };

      it("disposes of every runtime when one fails, and throws that failure", async () => {
        // Disposals run together, so the order they are released in is not
        // fixed.
        const released: string[] = [];
        const { service, close } = await serviceHoldingRuntimes([
          () => {
            released.push("first");
            return Promise.reject(new Error("the first runtime failed"));
          },
          () => {
            released.push("second");
            return Promise.resolve();
          },
        ]);
        try {
          const failure = await service.releaseFabricRuntimes().then(
            () => undefined,
            (error: unknown) => error,
          );

          expect(failure).not.toBeInstanceOf(AggregateError);
          expect(failure).toMatchObject({
            message: "the first runtime failed",
          });
          expect(released.toSorted()).toEqual(["first", "second"]);
          // The runtimes were released once, and are no longer held.
          await service.releaseFabricRuntimes();
          expect(released.toSorted()).toEqual(["first", "second"]);
        } finally {
          await close();
        }
      });

      it("throws an AggregateError of every failure once every disposal has settled", async () => {
        // The second disposal fails only after the first has, and is
        // reported all the same.
        const secondReleasing = Promise.withResolvers<void>();
        const failSecond = Promise.withResolvers<void>();
        const { service, close } = await serviceHoldingRuntimes([
          () => Promise.reject(new Error("the first runtime failed")),
          async () => {
            secondReleasing.resolve();
            await failSecond.promise;
            throw new Error("the second runtime failed");
          },
        ]);
        try {
          const releasing = service.releaseFabricRuntimes().then(
            () => undefined,
            (error: unknown) => error,
          );
          await secondReleasing.promise;
          failSecond.resolve();
          const failure = await releasing;

          expect(failure).toBeInstanceOf(AggregateError);
          // Disposals run together, so the failures are not ordered.
          expect(failure).toMatchObject({
            message: "2 Fabric runtimes failed to dispose",
            errors: expect.arrayContaining([
              expect.objectContaining({ message: "the first runtime failed" }),
              expect.objectContaining({ message: "the second runtime failed" }),
            ]),
          });
        } finally {
          await close();
        }
      });
    });

    describe("initializeFromStore()", () => {
      const turnRecord = (
        turnId: string,
        turn: Partial<HarnessChatTurnRecord["turn"]>,
      ): HarnessChatTurnRecord => ({
        sessionId: "session-1",
        turn: {
          turnId,
          status: "running",
          startedAt: "2026-05-22T00:00:01.000Z",
          updatedAt: "2026-05-22T00:00:01.000Z",
          ...turn,
        },
        input: { text: "Earlier" },
        policy: READONLY_HARNESS_CHAT_POLICY,
      });

      const restore = async (
        session: Partial<HarnessChatSessionStatus>,
        turns: readonly HarnessChatTurnRecord[],
      ) => {
        const service = new HarnessInteractiveChatService({
          now: nextIsoNow(),
          sessionStore: emptyStore({
            listSessions: () => [{
              session: {
                ...createHarnessChatSessionStatus({
                  sessionId: "session-1",
                  createdAt: "2026-05-22T00:00:00.000Z",
                  workspace: { hostPath: "/workspace" },
                }),
                ...session,
              },
              transcript: [],
            }],
            listTurns: () => turns,
          }),
        });
        await service.initializeFromStore();
        return service;
      };

      it("clears a finished active turn without reopening a closed session", async () => {
        const finished = turnRecord("turn-1", {
          status: "completed",
          endedAt: "2026-05-22T00:00:02.000Z",
        });
        const closed = await restore({
          status: "closed",
          reusable: false,
          activeTurnId: "turn-1",
          activeTurn: finished.turn,
        }, [finished]);
        const running = await restore({
          status: "turn_running",
          activeTurnId: "turn-1",
          activeTurn: finished.turn,
        }, [finished]);

        const [closedStatus] = closed.status().sessions;
        expect(closedStatus.status).toBe("closed");
        expect(closedStatus.reusable).toBe(false);
        expect(closedStatus.activeTurnId).toBeUndefined();
        const [runningStatus] = running.status().sessions;
        expect(runningStatus.status).toBe("idle");
        expect(runningStatus.reusable).toBe(true);
        expect(runningStatus.activeTurnId).toBeUndefined();
      });

      it("records an interrupted cancellation with no reason as a process interruption", async () => {
        const service = await restore({
          status: "canceling",
          activeTurnId: "turn-a",
        }, [
          turnRecord("turn-a", { status: "canceling" }),
          turnRecord("turn-b", {
            status: "canceling",
            cancelReason: "user_requested",
          }),
        ]);

        expect(
          service.listTurns({ sessionId: "session-1" }).turns.map((entry) => [
            entry.turn.turnId,
            entry.turn.status,
            entry.turn.cancelReason,
          ]),
        ).toEqual([
          ["turn-a", "canceled", "process_interrupted"],
          ["turn-b", "canceled", "user_requested"],
        ]);
      });
    });

    describe("tool transcript events", () => {
      const call = (id: string, name: string) => ({
        id,
        type: "function" as const,
        function: { name, arguments: "{}" },
      });
      const result = (
        toolCallId: string,
        toolName: string,
        content: Record<string, unknown>,
      ): HarnessTranscriptMessage => ({
        role: "tool",
        toolCallId,
        toolName,
        content: JSON.stringify(content),
      });

      it("reports a result with ok false as failed and announces no file change for it", async () => {
        const service = await runOneTurn(replayingLoop([
          {
            role: "assistant",
            content: "",
            toolCalls: [call("edit-1", "edit_file")],
          },
          result("edit-1", "edit_file", {
            ok: false,
            path: "/workspace/a.md",
          }),
          { role: "assistant", content: "Done." },
        ]));

        const events = service.events("session-1").map((event) => event.event);
        expect(
          events.filter((event) => event.kind === "tool_completed").map((
            event,
          ) => event.status),
        ).toEqual(["failed"]);
        expect(events.some((event) => event.kind === "file_changed")).toBe(
          false,
        );
      });

      it("summarizes an edit_file change with the counts its result reports", async () => {
        const service = await runOneTurn(replayingLoop([
          {
            role: "assistant",
            content: "",
            toolCalls: [
              call("edit-1", "edit_file"),
              call("edit-2", "edit_file"),
              call("edit-3", "edit_file"),
            ],
          },
          result("edit-1", "edit_file", {
            path: "/workspace/a.md",
            editsApplied: 2,
            replacements: 3,
          }),
          result("edit-2", "edit_file", {
            path: "/workspace/b.md",
            editsApplied: 1,
          }),
          result("edit-3", "edit_file", { path: "/workspace/c.md" }),
          { role: "assistant", content: "Done." },
        ]));

        expect(
          service.events("session-1").flatMap((event) =>
            event.event.kind === "file_changed" ? [event.event.change] : []
          ),
        ).toEqual([
          {
            kind: "update",
            path: "/workspace/a.md",
            summary: "edit_file applied 2 edit(s), 3 replacement(s)",
          },
          {
            kind: "update",
            path: "/workspace/b.md",
            summary: "edit_file applied 1 edit(s), ? replacement(s)",
          },
          {
            kind: "update",
            path: "/workspace/c.md",
            summary: "edit_file updated file",
          },
        ]);
      });

      it("reports no event for a user message the loop forwards", async () => {
        const service = await runOneTurn(replayingLoop([
          { role: "user", content: "A note from the host." },
          { role: "assistant", content: "Done." },
        ]));

        expect(
          service.events("session-1").map((event) => event.event.kind),
        ).toEqual([
          "session_started",
          "turn_started",
          "assistant_delta",
          "assistant_completed",
          "turn_completed",
        ]);
      });
    });
  });
});
