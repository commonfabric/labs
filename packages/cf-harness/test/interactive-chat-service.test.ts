import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { expect } from "@std/expect";
import { unattachedTurnContext } from "./support/session-store-fixtures.ts";
import { join } from "@std/path";
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
  type HarnessChatTurnRecord,
} from "../src/contracts/interactive-chat.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import { PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES } from "../src/contracts/subagent.ts";
import {
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

Deno.test("interactive service aborts active turns when closing a session", async () => {
  let activeSignal: AbortSignal | undefined;
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      activeSignal = options.signal;
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

  let release: (() => void) | undefined;
  const busyService = new HarnessInteractiveChatService({
    createPromptLoop: () => ({
      runTranscript: () =>
        new Promise((resolve) => {
          release = () => resolve(makeResult({ transcript: [] }, "Done."));
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
    ...unattachedTurnContext(),
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
      const { store, snapshots } = recordingStore();
      const nextTurnTranscripts: (readonly HarnessTranscriptMessage[])[] = [];
      let turn = 0;
      const service = new HarnessInteractiveChatService({
        createPromptLoop: (options) => {
          turn += 1;
          return turn === 1
            ? faultingToolLoop(resultsBeforeFault, fault, { release: held })(
              options,
            )
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
      // The turn rolls back whole, user message included: its tools already ran
      // and it is never replayed.
      assertEquals(snapshots[snapshots.length - 1], []);
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

      // What the rollback is for: the turn after it starts from the checkpoint
      // and carries no trace of the turn that died.
      await service.startTurn("req-4", {
        sessionId: "session-1",
        turnId: "turn-2",
        input: { text: "Try again" },
      });
      await service.waitForTurn("session-1", "turn-2");
      expect(nextTurnTranscripts).toEqual([[...unattachedTurnContext(), {
        role: "user",
        content: "Try again",
      }]]);
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

/**
 * The two sidecar directories a runsc sandbox exchanges CFC invocation
 * contexts and CFC results through. A run that mediates observations refuses
 * to start unless both are named.
 */
const makeCfcTransportDirs = async (): Promise<{
  cfcInvocationContextDir: string;
  cfcResultDir: string;
}> => {
  const root = await Deno.makeTempDir();
  const cfcInvocationContextDir = join(root, "cfc-invocation-context");
  const cfcResultDir = join(root, "cfc-result");
  await Deno.mkdir(cfcInvocationContextDir);
  await Deno.mkdir(cfcResultDir);
  return { cfcInvocationContextDir, cfcResultDir };
};

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
  const cfcTransport = await makeCfcTransportDirs();
  const loopOptions: CreateHarnessPromptLoopOptions[] = [];
  const requestBodies: unknown[] = [];
  const service = new HarnessInteractiveChatService({
    basePromptLoopOptions: {
      apiKey: "test-key",
      skillsRoot,
      runId: "run-interactive-skills",
      ...cfcTransport,
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
      kind: "docker-runsc-cfc",
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
