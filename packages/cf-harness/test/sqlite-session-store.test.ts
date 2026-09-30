import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import {
  createHarnessChatEventEnvelope,
  createHarnessChatSessionStatus,
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatListEventsResult,
  type HarnessChatSessionStatus,
  type HarnessChatTurnStatus,
} from "../src/contracts/interactive-chat.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { LoomLocalHostBinding } from "../src/contracts/run-manifest.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";
import {
  type HarnessTranscriptMessage,
  inspectHarnessTranscriptPairing,
} from "../src/contracts/transcript.ts";
import { toResponsesInput } from "../src/model/responses-protocol.ts";
import {
  type ChatFault,
  FAULT_POINTS,
  faultingToolLoop,
  toolCall,
} from "./support/chat-fault-fixture.ts";
import {
  makeResult,
  nextIsoNow,
  unattachedTurnContext,
} from "./support/session-store-fixtures.ts";

/** Asserts a synthesized result states an unknown outcome without `ok`. */
const assertUnknownToolOutcome = (
  message: HarnessTranscriptMessage,
  toolCallId: string,
  toolName: string,
): void => {
  if (message.role !== "tool") {
    throw new Error(`expected synthetic tool result, got ${message.role}`);
  }
  assertEquals(message.toolCallId, toolCallId);
  assertEquals(message.toolName, toolName);
  const payload = JSON.parse(message.content) as Record<string, unknown>;
  assertEquals(payload.type, "cf-harness.tool-outcome-unknown");
  assertEquals(payload.outcome, "unknown");
  assertEquals(payload.reason, "process_interrupted");
  assertEquals(
    payload.message,
    "The run was interrupted after this tool call was recorded and before a result was recorded. Whether the tool ran or produced side effects is unknown. Inspect current state before deciding whether to retry.",
  );
  assertEquals("ok" in payload, false);
};

const localHostPromptLoopOptions = (
  binding: LoomLocalHostBinding,
  model?: string,
): CreateHarnessPromptLoopOptions => ({
  modelProvider: binding.modelProvider,
  modelAuthSource: binding.modelAuthSource,
  credentialOwner: binding.credentialOwner,
  credentialOwnerKey: binding.credentialOwner.ownerKey,
  harnessHomeIdentity: binding.harnessHomeIdentity,
  ...(model !== undefined ? { model } : {}),
  runManifest: {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    ...binding,
    ...(model !== undefined ? { model } : {}),
  },
});

Deno.test("sqlite session store rejects unsupported URL schemes", async () => {
  await assertRejects(
    () =>
      openSqliteHarnessChatSessionStore({
        url: new URL("https://example.com/chat.sqlite"),
      }),
    Error,
    "unsupported SQLite chat session store URL protocol: https:; expected file:",
  );
});

Deno.test("sqlite session store persists chat sessions and replayable events", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      const result = makeResult(options, "Persisted.");
      await options.onTranscriptEvent?.({
        message: result.transcript[result.transcript.length - 1],
        transcript: result.transcript,
      });
      return result;
    },
  });

  try {
    const service = new HarnessInteractiveChatService({
      createPromptLoop,
      now: nextIsoNow(),
      sessionStore: store,
    });

    await service.startSession("req-1", {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
      model: "gpt-test",
      metadata: { source: "sqlite-test" },
    });
    await service.startTurn("req-2", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Remember this" },
      metadata: { origin: "first-turn" },
    });
    await service.waitForTurn("session-1", "turn-1");

    assertEquals(
      (await store.listTurns({ sessionId: "session-1" })).map((turn) => ({
        turnId: turn.turn.turnId,
        status: turn.turn.status,
        input: turn.input,
        metadata: turn.metadata,
      })),
      [{
        turnId: "turn-1",
        status: "completed",
        input: { text: "Remember this" },
        metadata: { origin: "first-turn" },
      }],
    );
    assertEquals(
      (await store.listEvents({ sessionId: "session-1", afterSequence: 2 }))
        .map((event) => event.event.kind),
      ["assistant_delta", "assistant_completed", "turn_completed"],
    );
    assertEquals(await store.latestSequence(), 5);

    const restored = new HarnessInteractiveChatService({
      createPromptLoop,
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].status, "idle");
    assertEquals(restored.status("session-1").sessions[0].turnCount, 1);
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns.map((turn) =>
        turn.turn.status
      ),
      ["completed"],
    );
    assertEquals(
      restored.status("session-1").sessions[0].metadata,
      { source: "sqlite-test" },
    );
    assertEquals(
      restored.listEvents({ sessionId: "session-1", afterSequence: 1 }).events
        .map((event) => event.event.kind),
      [
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ],
    );

    await restored.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Continue after restart" },
    });
    await restored.waitForTurn("session-1", "turn-2");

    assertEquals(await store.latestSequence(), 9);
    assertEquals(
      restored.listEvents({ sessionId: "session-1", afterSequence: 5 }).events
        .map((event) => [event.sequence, event.event.kind]),
      [
        [6, "turn_started"],
        [7, "assistant_delta"],
        [8, "assistant_completed"],
        [9, "turn_completed"],
      ],
    );
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns.map((turn) => [
        turn.turn.turnId,
        turn.turn.status,
      ]),
      [["turn-1", "completed"], ["turn-2", "completed"]],
    );

    const duplicate = await new HarnessInteractiveChatService({
      createPromptLoop,
      sessionStore: store,
    }).startSession("req-duplicate", {
      sessionId: "session-1",
      workspace: { hostPath: "/other" },
    });
    assertEquals(duplicate.ok, false);
    assertEquals(
      duplicate.ok === false ? duplicate.error.code : "",
      "session_exists",
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restart rejects changed or missing local Loom bindings before model traffic", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const credentialOwner = {
    type: "cf-harness.credential-owner-ref",
    version: 1,
    ownerKey: "local",
  } as const;
  const gatewayBinding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    modelAuthSource: "api-key",
    credentialOwner,
    harnessHomeIdentity: "sha256:home-a",
  };
  const codexBinding: LoomLocalHostBinding = {
    ...gatewayBinding,
    modelProvider: "openai-codex",
    modelAuthSource: "cf-harness-local-store",
  };
  let promptLoopCreations = 0;
  let modelCalls = 0;

  try {
    const original = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(gatewayBinding),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    const started = await original.startSession("req-start", {
      sessionId: "session-gateway",
      workspace: { hostPath: "/workspace" },
      model: "gpt-session",
    });
    assertEquals(started.ok, true);
    assertEquals(store.getSession("session-gateway")?.session, {
      ...original.status("session-gateway").sessions[0],
      model: "gpt-session",
      loomLocalHostBinding: gatewayBinding,
    });

    store.saveSession({
      session: createHarnessChatSessionStatus({
        sessionId: "session-legacy",
        workspace: { hostPath: "/workspace" },
        model: "gpt-session",
      }),
      transcript: [],
    });

    const restored = new HarnessInteractiveChatService({
      credentialOwner,
      basePromptLoopOptions: {
        ...localHostPromptLoopOptions(codexBinding),
        modelClient: {
          providerId: "openai-codex",
          credentialOwner,
          complete: () => {
            modelCalls += 1;
            return Promise.reject(new Error("unexpected model call"));
          },
        },
      },
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    await restored.initializeFromStore();

    const changedProvider = await restored.startTurn("req-old", {
      sessionId: "session-gateway",
      turnId: "turn-old",
      input: { text: "Do not migrate this transcript" },
    });
    assertEquals(changedProvider.ok, false);
    assertEquals(
      changedProvider.ok === false ? changedProvider.error.code : undefined,
      "provider-mismatch",
    );

    const missingBinding = await restored.startTurn("req-legacy", {
      sessionId: "session-legacy",
      turnId: "turn-legacy",
      input: { text: "Do not use an unbound transcript" },
    });
    assertEquals(missingBinding.ok, false);
    assertEquals(
      missingBinding.ok === false ? missingBinding.error.code : undefined,
      "provider-mismatch",
    );

    const newSession = await restored.startSession("req-new", {
      sessionId: "session-codex",
      workspace: { hostPath: "/workspace" },
      model: "gpt-new-session",
    });
    assertEquals(newSession.ok, true);
    assertEquals(
      newSession.ok ? newSession.result.loomLocalHostBinding : undefined,
      codexBinding,
    );
    assertEquals(
      newSession.ok ? newSession.result.model : undefined,
      "gpt-new-session",
    );
    assertEquals(restored.listTurns().turns, []);
    assertEquals(promptLoopCreations, 0);
    assertEquals(modelCalls, 0);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restart rejects a changed local Loom model before model traffic", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const binding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    modelAuthSource: "none",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "local",
    },
    harnessHomeIdentity: "sha256:home-a",
  };
  let promptLoopCreations = 0;

  try {
    const original = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(binding, "gpt-a"),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    const started = await original.startSession("req-start", {
      sessionId: "session-model-a",
      workspace: { hostPath: "/workspace" },
    });
    assertEquals(started.ok ? started.result.model : undefined, "gpt-a");

    const restored = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(binding, "gpt-b"),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        return {
          runTranscript: (options) =>
            Promise.resolve(makeResult(options, "Should not run.")),
        };
      },
      sessionStore: store,
    });
    await restored.initializeFromStore();
    const turn = await restored.startTurn("req-turn", {
      sessionId: "session-model-a",
      turnId: "turn-model-a",
      input: { text: "Keep the original model" },
    });

    assertEquals(turn.ok, false);
    assertEquals(
      turn.ok === false ? turn.error.code : undefined,
      "provider-mismatch",
    );
    assertEquals(restored.listTurns().turns, []);
    assertEquals(promptLoopCreations, 0);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restart validates every durable local Loom binding field", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const binding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    modelAuthSource: "none",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "local",
      tenantKey: "tenant-a",
    },
    harnessHomeIdentity: "sha256:home-a",
  };
  const cases = [
    {
      name: "auth",
      binding: { ...binding, modelAuthSource: "api-key" as const },
    },
    {
      name: "owner",
      binding: {
        ...binding,
        credentialOwner: { ...binding.credentialOwner, tenantKey: "tenant-b" },
      },
    },
    {
      name: "home",
      binding: { ...binding, harnessHomeIdentity: "sha256:home-b" },
    },
    { name: "model", binding, model: undefined },
  ];
  let promptLoopCreations = 0;

  try {
    for (const testCase of cases) {
      store.saveSession({
        session: createHarnessChatSessionStatus({
          sessionId: `session-${testCase.name}`,
          workspace: { hostPath: "/workspace" },
          ...(testCase.model === undefined && testCase.name === "model"
            ? {}
            : { model: "gpt-a" }),
          loomLocalHostBinding: testCase.binding,
        }),
        transcript: [],
      });
    }

    const restored = new HarnessInteractiveChatService({
      basePromptLoopOptions: localHostPromptLoopOptions(binding, "gpt-a"),
      createPromptLoop: () => {
        promptLoopCreations += 1;
        throw new Error("must not create a prompt loop");
      },
      sessionStore: store,
    });
    await restored.initializeFromStore();

    for (const testCase of cases) {
      const result = await restored.startTurn(`req-${testCase.name}`, {
        sessionId: `session-${testCase.name}`,
        turnId: `turn-${testCase.name}`,
        input: { text: "Do not cross the durable binding" },
      });
      assertEquals(result.ok, false, testCase.name);
      assertEquals(
        result.ok === false ? result.error.code : undefined,
        "provider-mismatch",
        testCase.name,
      );
    }
    assertEquals(promptLoopCreations, 0);
    assertEquals(restored.listTurns().turns, []);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session replay survives bounded in-memory event retention", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  const createPromptLoop: HarnessInteractivePromptLoopFactory = () => ({
    runTranscript: async (options) => {
      const result = makeResult(options, "Pruned from memory.");
      await options.onTranscriptEvent?.({
        message: result.transcript[result.transcript.length - 1],
        transcript: result.transcript,
      });
      return result;
    },
  });

  try {
    const service = new HarnessInteractiveChatService({
      createPromptLoop,
      now: nextIsoNow(),
      sessionStore: store,
      maxInMemoryEvents: 2,
    });

    await service.startSession("req-1", {
      sessionId: "session-pruned",
      workspace: { hostPath: "/workspace" },
    });
    await service.startTurn("req-2", {
      sessionId: "session-pruned",
      turnId: "turn-1",
      input: { text: "Generate enough events to prune" },
    });
    await service.waitForTurn("session-pruned", "turn-1");

    assertEquals(
      service.events("session-pruned").map((event) => event.event.kind),
      ["assistant_completed", "turn_completed"],
    );

    const replay = await service.handleRequest({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "req-replay",
      method: "list_events",
      params: {
        sessionId: "session-pruned",
        afterSequence: 0,
      },
    });
    assertEquals(replay.ok, true);
    const result = replay.ok
      ? replay.result as HarnessChatListEventsResult
      : undefined;
    assertEquals(result?.latestSequence, 5);
    assertEquals(
      result?.events.map((event) => event.event.kind),
      [
        "session_started",
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session store persists session snapshots and events atomically", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const initialSession = createHarnessChatSessionStatus({
      sessionId: "session-atomic",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
      metadata: { version: "before" },
    });
    store.saveSessionAndAppendEvent(
      {
        session: initialSession,
        transcript: [],
      },
      createHarnessChatEventEnvelope({
        sessionId: "session-atomic",
        sequence: 1,
        emittedAt: "2026-05-27T00:00:01.000Z",
        event: {
          kind: "session_started",
          session: initialSession,
        },
      }),
    );

    const updatedSession = createHarnessChatSessionStatus({
      sessionId: "session-atomic",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
      metadata: { version: "after" },
    });
    assertThrows(() =>
      store.saveSessionAndAppendEvent(
        {
          session: updatedSession,
          transcript: [{ role: "assistant", content: "should rollback" }],
        },
        createHarnessChatEventEnvelope({
          sessionId: "session-atomic",
          sequence: 1,
          emittedAt: "2026-05-27T00:00:02.000Z",
          event: {
            kind: "status_changed",
            session: updatedSession,
          },
        }),
      )
    );

    assertEquals(
      store.getSession("session-atomic")?.session.metadata,
      { version: "before" },
    );
    assertEquals(store.getSession("session-atomic")?.transcript, []);
    assertEquals(await store.latestSequence(), 1);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session store persists turn session event mutations atomically", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const initialSession = createHarnessChatSessionStatus({
      sessionId: "session-turn-atomic",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
      metadata: { version: "before" },
    });
    store.saveSessionAndAppendEvent(
      {
        session: initialSession,
        transcript: [],
      },
      createHarnessChatEventEnvelope({
        sessionId: "session-turn-atomic",
        sequence: 1,
        emittedAt: "2026-05-27T00:00:01.000Z",
        event: {
          kind: "session_started",
          session: initialSession,
        },
      }),
    );

    const turn = {
      turnId: "turn-1",
      status: "running" as const,
      startedAt: "2026-05-27T00:00:02.000Z",
      updatedAt: "2026-05-27T00:00:02.000Z",
    };
    const updatedSession = {
      ...initialSession,
      status: "turn_running" as const,
      reusable: true,
      activeTurnId: turn.turnId,
      activeTurn: turn,
      turnCount: 1,
      updatedAt: "2026-05-27T00:00:02.000Z",
      metadata: { version: "after" },
    };

    assertThrows(() =>
      store.saveSessionTurnAndAppendEvent({
        session: {
          session: updatedSession,
          transcript: [{ role: "user", content: "should rollback" }],
        },
        turn: {
          sessionId: "session-turn-atomic",
          turn,
          input: { text: "should rollback" },
          policy: initialSession.policy,
        },
        createTurn: true,
        event: createHarnessChatEventEnvelope({
          sessionId: "session-turn-atomic",
          turnId: turn.turnId,
          sequence: 1,
          emittedAt: "2026-05-27T00:00:02.000Z",
          event: {
            kind: "turn_started",
            turn,
          },
        }),
      })
    );

    assertEquals(
      store.getSession("session-turn-atomic")?.session.metadata,
      { version: "before" },
    );
    assertEquals(store.getSession("session-turn-atomic")?.transcript, []);
    assertEquals(store.getTurn("session-turn-atomic", "turn-1"), undefined);
    assertEquals(await store.latestSequence(), 1);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session store restores and terminalizes active legacy transcripts", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    let legacyTranscript: HarnessTranscriptMessage[] | undefined;
    let resolvePartialTranscript: (() => void) | undefined;
    const partialTranscriptPersisted = new Promise<void>((resolve) => {
      resolvePartialTranscript = resolve;
    });
    const stalled = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: async (options) => {
          const assistant = {
            role: "assistant" as const,
            content: "",
            toolCalls: [{
              id: "call-interrupted",
              type: "function" as const,
              function: {
                name: "read_file",
                arguments: '{"path":"/workspace/note.md"}',
              },
            }],
          };
          const transcript = [...options.transcript, assistant];
          legacyTranscript = transcript;
          await options.onTranscriptEvent?.({
            message: assistant,
            transcript,
          });
          resolvePartialTranscript?.();
          return await new Promise<HarnessPromptLoopResult>(() => {
            // Simulates a process dying before the tool result is recorded.
          });
        },
      }),
      now: nextIsoNow(),
      sessionStore: store,
    });

    await stalled.startSession("req-1", {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
    });
    await stalled.startTurn("req-2", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "This will be interrupted" },
    });
    await partialTranscriptPersisted;
    const runningSnapshot = store.getSession("session-1");
    if (runningSnapshot === undefined || legacyTranscript === undefined) {
      throw new Error("expected an interrupted legacy session snapshot");
    }
    // Persist the live transcript shape written by the legacy bridge. Current
    // turns keep this partial history in their audit events instead.
    store.saveSession({
      session: runningSnapshot.session,
      transcript: legacyTranscript,
    });

    assertEquals(
      (await store.listTurns({ sessionId: "session-1" })).map((turn) =>
        turn.turn.status
      ),
      ["running"],
    );

    const restoredInputs: RunHarnessTranscriptOptions["transcript"][] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) => {
          restoredInputs.push([...options.transcript]);
          return Promise.resolve(makeResult(options, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:01:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].status, "idle");
    assertEquals(restored.status("session-1").sessions[0].reusable, true);
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns[0].turn.status,
      "failed",
    );
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns[0].turn.error
        ?.details,
      {
        terminalReason: "process_interrupted",
        priorStatus: "running",
      },
    );
    assertEquals(
      restored.listEvents({ sessionId: "session-1", afterSequence: 2 }).events
        .map((event) => [event.sequence, event.event.kind]),
      [[3, "tool_started"], [4, "turn_failed"]],
    );
    const recoveredTranscript = store.getSession("session-1")?.transcript ?? [];
    expect(recoveredTranscript.slice(0, legacyTranscript.length)).toEqual(
      legacyTranscript,
    );
    expect(recoveredTranscript.length).toBe(legacyTranscript.length + 1);
    assertUnknownToolOutcome(
      recoveredTranscript[legacyTranscript.length],
      "call-interrupted",
      "read_file",
    );

    const followUp = await restored.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Continue" },
    });
    assertEquals(followUp.ok, true);
    await restored.waitForTurn("session-1", "turn-2");
    expect(restoredInputs[0]).toEqual([
      ...recoveredTranscript,
      ...unattachedTurnContext(),
      { role: "user", content: "Continue" },
    ]);
    assertEquals(
      restored.listTurns({ sessionId: "session-1" }).turns.map((turn) => [
        turn.turn.turnId,
        turn.turn.status,
      ]),
      [["turn-1", "failed"], ["turn-2", "completed"]],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite restore normalizes legacy history through every terminalization branch", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const incompleteTranscript = (
      callId: string,
    ): readonly HarnessTranscriptMessage[] => [{
      role: "assistant",
      content: "Working.",
      toolCalls: [toolCall(callId)],
    }];
    const runningTurn = (turnId: string) => ({
      turnId,
      status: "running" as const,
      startedAt: "2026-05-27T00:00:01.000Z",
      updatedAt: "2026-05-27T00:00:01.000Z",
    });
    const cancelingTurn = (turnId: string) => ({
      ...runningTurn(turnId),
      status: "canceling" as const,
      cancelReason: "user_requested",
    });
    const saveTurn = (
      session: HarnessChatSessionStatus,
      turn: HarnessChatTurnStatus,
    ) =>
      store.saveTurn({
        sessionId: session.sessionId,
        turn,
        input: { text: "Continue" },
        policy: session.policy,
      });
    const activeSession = (
      sessionId: string,
      turn: HarnessChatTurnStatus,
    ): HarnessChatSessionStatus => ({
      ...createHarnessChatSessionStatus({
        sessionId,
        createdAt: "2026-05-27T00:00:00.000Z",
        workspace: { hostPath: "/workspace" },
      }),
      status: turn.status === "canceling" ? "canceling" : "turn_running",
      reusable: false,
      turnCount: 1,
      activeTurnId: turn.turnId,
      activeTurn: turn,
    });

    const missingTurn = runningTurn("turn-missing");
    const missingSession = activeSession("session-missing", missingTurn);
    store.saveSession({
      session: missingSession,
      transcript: incompleteTranscript("call-missing-active-turn"),
    });

    const completedTurn = {
      ...runningTurn("turn-completed"),
      status: "completed" as const,
      endedAt: "2026-05-27T00:00:02.000Z",
    };
    const completedSession = activeSession(
      "session-completed",
      completedTurn,
    );
    store.saveSession({
      session: completedSession,
      transcript: incompleteTranscript("call-terminal-active-turn"),
    });
    saveTurn(completedSession, completedTurn);

    const activeCancelingTurn = cancelingTurn("turn-canceling-active");
    const activeCancelingSession = activeSession(
      "session-canceling-active",
      activeCancelingTurn,
    );
    store.saveSession({
      session: activeCancelingSession,
      transcript: incompleteTranscript("call-canceling-active-turn"),
    });
    saveTurn(activeCancelingSession, activeCancelingTurn);

    const inactiveCancelingTurn = cancelingTurn("turn-canceling-inactive");
    const inactiveCancelingSession = createHarnessChatSessionStatus({
      sessionId: "session-canceling-inactive",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
    });
    store.saveSession({
      session: inactiveCancelingSession,
      transcript: incompleteTranscript("call-canceling-inactive-turn"),
    });
    saveTurn(inactiveCancelingSession, inactiveCancelingTurn);

    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Should not run.")),
      }),
      now: nextIsoNow(),
      sessionStore: store,
    });
    await restored.initializeFromStore();

    for (
      const [sessionId, callId] of [
        ["session-missing", "call-missing-active-turn"],
        ["session-completed", "call-terminal-active-turn"],
        ["session-canceling-active", "call-canceling-active-turn"],
        ["session-canceling-inactive", "call-canceling-inactive-turn"],
      ] as const
    ) {
      const transcript = store.getSession(sessionId)?.transcript ?? [];
      assertEquals(transcript.length, 2);
      assertUnknownToolOutcome(transcript[1], callId, "read_file");
      assertEquals(inspectHarnessTranscriptPairing(transcript).valid, true);
    }
    assertEquals(
      store.getTurn("session-completed", completedTurn.turnId)?.turn.status,
      "completed",
    );
    assertEquals(
      store.getTurn(
        "session-canceling-active",
        activeCancelingTurn.turnId,
      )?.turn.status,
      "canceled",
    );
    assertEquals(
      store.getTurn(
        "session-canceling-inactive",
        inactiveCancelingTurn.turnId,
      )?.turn.status,
      "canceled",
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restore heals terminal legacy transcripts idempotently", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const session = {
      ...createHarnessChatSessionStatus({
        sessionId: "session-legacy",
        createdAt: "2026-05-27T00:00:00.000Z",
        workspace: { hostPath: "/workspace" },
      }),
      turnCount: 1,
      updatedAt: "2026-05-27T00:00:03.000Z",
    };
    const interruptedAssistant: HarnessTranscriptMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-legacy",
        type: "function",
        function: { name: "bash", arguments: '{"command":"touch marker"}' },
      }],
    };
    store.saveSession({
      session,
      transcript: [
        { role: "user", content: "Create the marker" },
        interruptedAssistant,
      ],
    });
    store.saveTurn({
      sessionId: session.sessionId,
      turn: {
        turnId: "turn-legacy",
        status: "failed",
        startedAt: "2026-05-27T00:00:01.000Z",
        updatedAt: "2026-05-27T00:00:03.000Z",
        endedAt: "2026-05-27T00:00:03.000Z",
        error: {
          code: "internal_error",
          message: "legacy recovery already terminalized this turn",
        },
      },
      input: { text: "Create the marker" },
      policy: session.policy,
    });

    const restoredInputs: RunHarnessTranscriptOptions["transcript"][] = [];
    const createRestored = () =>
      new HarnessInteractiveChatService({
        createPromptLoop: () => ({
          runTranscript: async (options) => {
            restoredInputs.push([...options.transcript]);
            for (const message of options.transcript) {
              await options.onTranscriptEvent?.({
                message,
                transcript: options.transcript,
              });
            }
            const result = makeResult(options, "Recovered.");
            await options.onTranscriptEvent?.({
              message: result.transcript[result.transcript.length - 1],
              transcript: result.transcript,
            });
            return result;
          },
        }),
        now: () => "2026-05-27T00:01:00.000Z",
        sessionStore: store,
      });

    const firstRestore = createRestored();
    await firstRestore.initializeFromStore();
    const once = store.getSession(session.sessionId)?.transcript ?? [];
    assertEquals(once.slice(0, 2), [
      { role: "user", content: "Create the marker" },
      interruptedAssistant,
    ]);
    assertEquals(once.length, 3);
    assertUnknownToolOutcome(once[2], "call-legacy", "bash");
    const sequenceAfterFirstRestore = await store.latestSequence();
    const changesAfterFirstRestore = (store.database.prepare(
      "SELECT total_changes() AS count",
    ).get() as { count: number }).count;

    const secondRestore = createRestored();
    await secondRestore.initializeFromStore();
    assertEquals(store.getSession(session.sessionId)?.transcript, once);
    assertEquals(await store.latestSequence(), sequenceAfterFirstRestore);
    assertEquals(
      (store.database.prepare("SELECT total_changes() AS count").get() as {
        count: number;
      }).count,
      changesAfterFirstRestore,
    );

    const followUp = await secondRestore.startTurn("req-follow-up", {
      sessionId: session.sessionId,
      turnId: "turn-follow-up",
      input: { text: "Continue carefully" },
    });
    assertEquals(followUp.ok, true);
    await secondRestore.waitForTurn(session.sessionId, "turn-follow-up");
    expect(restoredInputs[0]).toEqual([
      ...once,
      ...unattachedTurnContext(),
      { role: "user", content: "Continue carefully" },
    ]);
    assertEquals(
      secondRestore.listEvents({
        sessionId: session.sessionId,
        afterSequence: sequenceAfterFirstRestore,
      }).events.map((event) => event.event.kind),
      [
        "turn_started",
        "assistant_delta",
        "assistant_completed",
        "turn_completed",
      ],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite chat resumes a canceled tool call from its checkpoint", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    let resolveToolCallPersisted: (() => void) | undefined;
    const toolCallPersisted = new Promise<void>((resolve) => {
      resolveToolCallPersisted = resolve;
    });
    const followUpInputs: RunHarnessTranscriptOptions["transcript"][] = [];
    let invocation = 0;
    const service = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: async (options) => {
          invocation += 1;
          if (invocation > 1) {
            followUpInputs.push([...options.transcript]);
            return makeResult(options, "Recovered.");
          }
          const assistant: HarnessTranscriptMessage = {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "call-canceled",
              type: "function",
              function: { name: "bash", arguments: '{"command":"sleep 600"}' },
            }],
          };
          await options.onTranscriptEvent?.({
            message: assistant,
            transcript: [...options.transcript, assistant],
          });
          resolveToolCallPersisted?.();
          return await new Promise<HarnessPromptLoopResult>(
            (_resolve, reject) => {
              options.signal?.addEventListener("abort", () => {
                reject(options.signal?.reason ?? new Error("aborted"));
              }, { once: true });
            },
          );
        },
      }),
      now: nextIsoNow(),
      sessionStore: store,
    });

    await service.startSession("req-1", {
      sessionId: "session-canceled",
      workspace: { hostPath: "/workspace" },
    });
    await service.startTurn("req-2", {
      sessionId: "session-canceled",
      turnId: "turn-canceled",
      input: { text: "Run the long command" },
    });
    await toolCallPersisted;
    await service.cancelTurn(
      "req-3",
      "session-canceled",
      "turn-canceled",
      "user_requested",
    );
    await service.waitForTurn("session-canceled", "turn-canceled");
    assertEquals(service.status("session-canceled").sessions[0].reusable, true);

    const followUp = await service.startTurn("req-4", {
      sessionId: "session-canceled",
      turnId: "turn-follow-up",
      input: { text: "Continue" },
    });
    assertEquals(followUp.ok, true);
    await service.waitForTurn("session-canceled", "turn-follow-up");
    expect(followUpInputs[0]).toEqual([...unattachedTurnContext(), {
      role: "user",
      content: "Continue",
    }]);
    assertEquals(
      store.getSession("session-canceled")?.transcript,
      [
        ...followUpInputs[0],
        { role: "assistant", content: "Recovered." },
      ],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restore preserves partial batches later history and compaction", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const session = createHarnessChatSessionStatus({
      sessionId: "session-partial-batch",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
    });
    const compaction = {
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
    };
    const partial: HarnessTranscriptMessage[] = [
      { role: "user", content: "Read both files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-complete",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"one"}' },
        }, {
          id: "call-missing",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"two"}' },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-complete",
        toolName: "read_file",
        content: '{"contents":"one"}',
      },
      { role: "user", content: "A later valid question" },
      {
        role: "assistant",
        content: "A later valid answer",
        providerContinuation: compaction,
      },
    ];
    store.saveSession({ session, transcript: partial });

    const service = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Should not run.")),
      }),
      now: () => "2026-05-27T00:01:00.000Z",
      sessionStore: store,
    });
    await service.initializeFromStore();

    const normalized = store.getSession(session.sessionId)?.transcript ?? [];
    assertEquals(normalized.length, partial.length + 1);
    assertEquals(normalized.slice(0, 3), partial.slice(0, 3));
    assertEquals(
      (normalized[partial.length] as Extract<
        HarnessTranscriptMessage,
        { role: "assistant" }
      >)
        .providerContinuation,
      compaction,
    );
    assertUnknownToolOutcome(
      normalized[3],
      "call-missing",
      "read_file",
    );
    assertEquals(normalized.slice(4), partial.slice(3));
    const { input } = await toResponsesInput(
      normalized,
      "gpt-test",
      "openai-compatible-gateway",
      "gateway Responses",
    );
    const calls = input.filter((item) => item.type === "function_call").map(
      (item) => item.call_id,
    );
    const results = input.filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id);
    assertEquals(results, calls);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restore leaves complete tool exchanges byte-for-byte unchanged", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const session = createHarnessChatSessionStatus({
      sessionId: "session-complete-batch",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
    });
    const complete: HarnessTranscriptMessage[] = [
      { role: "user", content: "Read it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-complete",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"one"}' },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-complete",
        toolName: "read_file",
        content: '{"contents":"one"}',
      },
      { role: "assistant", content: "Done" },
    ];
    store.saveSession({ session, transcript: complete });

    const service = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Should not run.")),
      }),
      sessionStore: store,
    });
    await service.initializeFromStore();

    assertEquals(store.getSession(session.sessionId)?.transcript, complete);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restore pairs late tool results across interleaved history", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const session = createHarnessChatSessionStatus({
      sessionId: "session-interleaved-result",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
    });
    const complete: HarnessTranscriptMessage[] = [
      {
        role: "assistant",
        content: "Reading it.",
        toolCalls: [toolCall("call-late")],
      },
      { role: "user", content: "Also summarize it." },
      { role: "assistant", content: "I will." },
      {
        role: "tool",
        toolCallId: "call-late",
        toolName: "read_file",
        content: '{"contents":"one"}',
      },
    ];
    store.saveSession({ session, transcript: complete });

    const service = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Should not run.")),
      }),
      sessionStore: store,
    });
    await service.initializeFromStore();

    assertEquals(service.status(session.sessionId).sessions[0].reusable, true);
    assertEquals(store.getSession(session.sessionId)?.transcript, complete);
    assertEquals(
      service.listEvents({ sessionId: session.sessionId }).events,
      [],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite restore closes a missing sibling without moving a late real result", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const session = createHarnessChatSessionStatus({
      sessionId: "session-mixed-result-order",
      createdAt: "2026-05-27T00:00:00.000Z",
      workspace: { hostPath: "/workspace" },
    });
    const recorded: HarnessTranscriptMessage[] = [
      {
        role: "assistant",
        content: "Reading both.",
        toolCalls: [toolCall("call-late"), toolCall("call-missing")],
      },
      { role: "user", content: "Also summarize them." },
      {
        role: "tool",
        toolCallId: "call-late",
        toolName: "read_file",
        content: '{"contents":"one"}',
      },
    ];
    store.saveSession({ session, transcript: recorded });

    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Should not run.")),
      }),
      sessionStore: store,
    });
    await restored.initializeFromStore();

    const normalized = store.getSession(session.sessionId)?.transcript ?? [];
    assertEquals(normalized[0], recorded[0]);
    assertUnknownToolOutcome(normalized[1], "call-missing", "read_file");
    assertEquals(normalized.slice(2), recorded.slice(1));
    assertEquals(inspectHarnessTranscriptPairing(normalized).valid, true);
    const { input } = await toResponsesInput(
      normalized,
      "gpt-test",
      "openai-compatible-gateway",
      "gateway Responses",
    );
    const calls = input.filter((item) => item.type === "function_call").map(
      (item) => item.call_id,
    ).sort();
    const results = input.filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id).sort();
    assertEquals(results, calls);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite chat fails closed on malformed tool exchanges", async () => {
  const cases: Array<{
    name: string;
    transcript: HarnessTranscriptMessage[];
    malformation:
      | "duplicate_tool_call_id"
      | "tool_result_without_pending_call";
    transcriptIndex: number;
  }> = [{
    name: "orphan",
    transcript: [
      { role: "user", content: "Question" },
      {
        role: "tool",
        toolCallId: "call-orphan",
        toolName: "read_file",
        content: "{}",
      },
    ],
    malformation: "tool_result_without_pending_call",
    transcriptIndex: 1,
  }, {
    name: "unexpected-result-in-batch",
    transcript: [
      { role: "user", content: "Question" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-expected",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-unexpected",
        toolName: "read_file",
        content: "{}",
      },
    ],
    malformation: "tool_result_without_pending_call",
    transcriptIndex: 2,
  }, {
    name: "duplicate",
    transcript: [
      { role: "user", content: "Question" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-duplicate",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-duplicate",
        toolName: "read_file",
        content: "{}",
      },
      {
        role: "tool",
        toolCallId: "call-duplicate",
        toolName: "read_file",
        content: "{}",
      },
    ],
    malformation: "tool_result_without_pending_call",
    transcriptIndex: 3,
  }, {
    name: "duplicate-call-id",
    transcript: [
      { role: "user", content: "Question" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-duplicate",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"one"}' },
        }, {
          id: "call-duplicate",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"two"}' },
        }],
      },
    ],
    malformation: "duplicate_tool_call_id",
    transcriptIndex: 1,
  }, {
    name: "reused-call-id",
    transcript: [
      { role: "user", content: "Question" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-reused",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"one"}' },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-reused",
        toolName: "read_file",
        content: '{"contents":"one"}',
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-reused",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"two"}' },
        }],
      },
    ],
    malformation: "duplicate_tool_call_id",
    transcriptIndex: 3,
  }];

  for (const testCase of cases) {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const store = await openSqliteHarnessChatSessionStore({
      url: toFileUrl(path),
    });
    try {
      const session = createHarnessChatSessionStatus({
        sessionId: `session-${testCase.name}`,
        createdAt: "2026-05-27T00:00:00.000Z",
        workspace: { hostPath: "/workspace" },
      });
      store.saveSession({ session, transcript: testCase.transcript });
      let providerCalls = 0;
      const service = new HarnessInteractiveChatService({
        createPromptLoop: () => ({
          runTranscript: (options) => {
            providerCalls += 1;
            return Promise.resolve(makeResult(options, "Must not run."));
          },
        }),
        now: nextIsoNow(),
        sessionStore: store,
      });
      await service.initializeFromStore();
      assertEquals(
        service.status(session.sessionId).sessions[0].reusable,
        false,
      );

      const result = await service.startTurn(`req-${testCase.name}`, {
        sessionId: session.sessionId,
        turnId: `turn-${testCase.name}`,
        input: { text: "Continue" },
      });
      assertEquals(result.ok, false);
      if (result.ok) {
        throw new Error("malformed transcript unexpectedly started a turn");
      }
      assertEquals(result.error.code, "internal_error");
      assertEquals(result.error.details, {
        reason: "malformed_transcript",
        malformation: testCase.malformation,
        transcriptIndex: testCase.transcriptIndex,
      });
      assertEquals(providerCalls, 0);
      assertEquals(await store.listTurns({ sessionId: session.sessionId }), []);
      assertEquals(
        store.getSession(session.sessionId)?.transcript,
        testCase.transcript,
      );
    } finally {
      store.close();
      await Deno.remove(path);
    }
  }
});

Deno.test("sqlite chat propagates unexpected transcript normalization faults", async () => {
  for (const phase of ["restore", "next-turn"] as const) {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const store = await openSqliteHarnessChatSessionStore({
      url: toFileUrl(path),
    });
    try {
      const session = createHarnessChatSessionStatus({
        sessionId: `session-unexpected-${phase}`,
        createdAt: "2026-05-27T00:00:00.000Z",
        workspace: { hostPath: "/workspace" },
      });
      const normalizationFault = new Error(
        `unexpected ${phase} normalization fault`,
      );
      let roleReads = 0;
      const allowedRoleReads = phase === "restore" ? 0 : 2;
      const faultingMessage: HarnessTranscriptMessage = {
        get role(): "user" {
          roleReads += 1;
          if (roleReads > allowedRoleReads) {
            throw normalizationFault;
          }
          return "user";
        },
        content: "Question",
      };
      store.listSessions = () => [{
        session,
        transcript: [faultingMessage],
      }];
      let providerCalls = 0;
      const service = new HarnessInteractiveChatService({
        createPromptLoop: () => ({
          runTranscript: (options) => {
            providerCalls += 1;
            return Promise.resolve(makeResult(options, "Must not run."));
          },
        }),
        sessionStore: store,
      });

      if (phase === "restore") {
        const error = await assertRejects(() => service.initializeFromStore());
        assertEquals(error, normalizationFault);
      } else {
        await service.initializeFromStore();
        const error = await assertRejects(() =>
          service.startTurn(`req-${phase}`, {
            sessionId: session.sessionId,
            turnId: `turn-${phase}`,
            input: { text: "Continue" },
          })
        );
        assertEquals(error, normalizationFault);
      }
      assertEquals(providerCalls, 0);
    } finally {
      store.close();
      await Deno.remove(path);
    }
  }
});

Deno.test("sqlite session restore keeps closed sessions closed while terminalizing turns", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });

  try {
    const turn = {
      turnId: "turn-closed",
      status: "running" as const,
      startedAt: "2026-05-27T00:00:01.000Z",
      updatedAt: "2026-05-27T00:00:01.000Z",
    };
    const session = {
      ...createHarnessChatSessionStatus({
        sessionId: "session-closed",
        createdAt: "2026-05-27T00:00:00.000Z",
        workspace: { hostPath: "/workspace" },
      }),
      status: "closed" as const,
      reusable: false,
      activeTurnId: turn.turnId,
      activeTurn: turn,
      closedAt: "2026-05-27T00:00:02.000Z",
      updatedAt: "2026-05-27T00:00:02.000Z",
    };
    store.saveSession({
      session,
      transcript: [],
    });
    store.saveTurn({
      sessionId: "session-closed",
      turn,
      input: { text: "interrupted under closed session" },
      policy: session.policy,
    });

    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (options) =>
          Promise.resolve(makeResult(options, "Should not run.")),
      }),
      now: () => "2026-05-27T00:01:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(
      restored.status("session-closed").sessions[0].status,
      "closed",
    );
    assertEquals(
      restored.status("session-closed").sessions[0].reusable,
      false,
    );
    assertEquals(
      restored.listTurns({ sessionId: "session-closed" }).turns[0].turn.status,
      "failed",
    );
    assertEquals(
      restored.listEvents({ sessionId: "session-closed" }).events.map((
        event,
      ) => event.event.kind),
      ["turn_failed"],
    );
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

const RESUMED_AFTER_FIRST_TURN: readonly HarnessTranscriptMessage[] = [
  ...unattachedTurnContext(),
  { role: "user", content: "Read the first file" },
  { role: "assistant", content: "Read the first." },
  ...unattachedTurnContext(),
  { role: "user", content: "Try again" },
];

/**
 * Complete one turn, lose a second to `fault` after `resultsBeforeFault` of its
 * two tool results, rebuild the service from the same store, and report the
 * transcript the next turn's prompt loop is handed.
 */
const transcriptAfterFaultedTurn = async (
  resultsBeforeFault: number,
  fault: ChatFault,
): Promise<readonly HarnessTranscriptMessage[]> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    let turn = 0;
    const service = new HarnessInteractiveChatService({
      createPromptLoop: (options) => {
        turn += 1;
        return turn === 1
          ? {
            runTranscript: (runOptions) =>
              Promise.resolve(makeResult(runOptions, "Read the first.")),
          }
          : faultingToolLoop(resultsBeforeFault, fault)(options);
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
      input: { text: "Read the first file" },
    });
    await service.waitForTurn("session-1", "turn-1");
    await service.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Read both files" },
    });
    await service.waitForTurn("session-1", "turn-2");

    let next: readonly HarnessTranscriptMessage[] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          next = [...runOptions.transcript];
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();
    const followUp = await restored.startTurn("req-4", {
      sessionId: "session-1",
      turnId: "turn-3",
      input: { text: "Try again" },
    });
    assertEquals(followUp.ok, true);
    await restored.waitForTurn("session-1", "turn-3");
    return next;
  } finally {
    store.close();
    await Deno.remove(path);
  }
};

// Whichever fault point a turn dies at, a service rebuilt from the same store
// resumes from the last completed turn and nothing else.
for (const resultsBeforeFault of FAULT_POINTS) {
  Deno.test(`sqlite session restore resumes from the last completed turn after a fault with ${resultsBeforeFault} of two tool results`, async () => {
    const next = await transcriptAfterFaultedTurn(resultsBeforeFault, "error");
    assertEquals(next, RESUMED_AFTER_FIRST_TURN);
    assertEquals(inspectHarnessTranscriptPairing(next).valid, true);
  });
}

Deno.test("sqlite session restore keeps a reusable checkpoint when a turn is interrupted mid-tool", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    let turn = 0;
    // Resolves once the interrupted turn has durably emitted everything it is
    // ever going to, so the restore below reads a settled store rather than
    // racing the writes.
    let reachFault: (() => void) | undefined;
    const reachedFault = new Promise<void>((resolve) => {
      reachFault = () => resolve();
    });
    const stalled = new HarnessInteractiveChatService({
      createPromptLoop: (options) => {
        turn += 1;
        if (turn === 1) {
          return {
            runTranscript: (runOptions) =>
              Promise.resolve(makeResult(runOptions, "Read the first.")),
          };
        }
        return faultingToolLoop(1, "interrupt", { onFault: reachFault })(
          options,
        );
      },
      now: nextIsoNow(),
      sessionStore: store,
    });
    await stalled.startSession("req-1", {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace" },
    });
    await stalled.startTurn("req-2", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Read the first file" },
    });
    await stalled.waitForTurn("session-1", "turn-1");
    await stalled.startTurn("req-3", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Read both files" },
    });
    await reachedFault;
    assertEquals(
      (await store.listTurns({ sessionId: "session-1" })).map((record) => [
        record.turn.turnId,
        record.turn.status,
      ]),
      [["turn-1", "completed"], ["turn-2", "running"]],
    );

    let next: readonly HarnessTranscriptMessage[] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          next = [...runOptions.transcript];
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    const session = restored.status("session-1").sessions[0];
    assertEquals(session.status, "idle");
    assertEquals(session.reusable, true);
    const interrupted = restored.listTurns({ sessionId: "session-1" }).turns
      .find((record) => record.turn.turnId === "turn-2");
    assertEquals(interrupted?.turn.status, "failed");
    assertEquals(interrupted?.turn.error?.details, {
      terminalReason: "process_interrupted",
      priorStatus: "running",
    });
    // The interrupted turn's tool history is still on the audit trail even
    // though its model history was rolled back.
    assertEquals(
      restored.listEvents({ sessionId: "session-1" }).events.filter((event) =>
        event.event.kind === "tool_started"
      ).length,
      2,
    );

    await restored.startTurn("req-4", {
      sessionId: "session-1",
      turnId: "turn-3",
      input: { text: "Try again" },
    });
    await restored.waitForTurn("session-1", "turn-3");
    assertEquals(next, RESUMED_AFTER_FIRST_TURN);
    assertEquals(inspectHarnessTranscriptPairing(next).valid, true);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

const recordedSession = (
  transcript: readonly HarnessTranscriptMessage[],
  status: HarnessChatSessionStatus["status"] = "idle",
) => ({
  session: {
    ...createHarnessChatSessionStatus({
      sessionId: "session-1",
      createdAt: "2026-05-27T00:00:01.000Z",
      workspace: { hostPath: "/workspace" },
    }),
    status,
  },
  transcript,
});

const ORPHAN_TRANSCRIPT: readonly HarnessTranscriptMessage[] = [
  { role: "user", content: "Read the first file" },
  {
    role: "tool",
    toolCallId: "call-ghost",
    toolName: "read_file",
    content: "contents nobody asked for",
  },
];

// Malformation is independent of session status. In particular, a `failed`
// session otherwise accepts a new turn, so transcript validation must refuse it.
for (const status of ["idle", "failed"] as const) {
  Deno.test(`sqlite session restore keeps ${status} malformed sessions refused without deleting evidence`, async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const store = await openSqliteHarnessChatSessionStore({
      url: toFileUrl(path),
    });
    try {
      await store.saveSession(recordedSession(ORPHAN_TRANSCRIPT, status));
      for (const attempt of [1, 2]) {
        const restored = new HarnessInteractiveChatService({
          createPromptLoop: () => ({
            runTranscript: (runOptions) =>
              Promise.resolve(makeResult(runOptions, "Recovered.")),
          }),
          now: () => `2026-05-27T00:0${attempt}:00.000Z`,
          sessionStore: store,
        });
        await restored.initializeFromStore();
        assertEquals(
          restored.status("session-1").sessions[0].reusable,
          false,
          `restart ${attempt} lost the refusal`,
        );
        const followUp = await restored.startTurn(`req-${attempt}`, {
          sessionId: "session-1",
          turnId: `turn-${attempt}`,
          input: { text: "Try again" },
        });
        assertEquals(followUp.ok, false, `restart ${attempt} reopened it`);
        assertEquals(
          followUp.ok === false ? followUp.error.code : "",
          "internal_error",
        );
        assertEquals(
          followUp.ok === false ? followUp.error.details : undefined,
          {
            reason: "malformed_transcript",
            malformation: "tool_result_without_pending_call",
            transcriptIndex: 1,
          },
        );
        assertEquals(
          (await store.getSession("session-1"))?.transcript,
          ORPHAN_TRANSCRIPT,
        );
      }
    } finally {
      store.close();
      await Deno.remove(path);
    }
  });
}

Deno.test("sqlite session restore normalizes a truncated transcript without deleting history", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    const incomplete: readonly HarnessTranscriptMessage[] = [
      { role: "user", content: "Read the first file" },
      { role: "assistant", content: "Read the first." },
      {
        role: "assistant",
        content: "Reading both files.",
        toolCalls: [toolCall("call-a"), toolCall("call-b")],
      },
    ];
    await store.saveSession(recordedSession(incomplete));

    let next: readonly HarnessTranscriptMessage[] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          next = [...runOptions.transcript];
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].reusable, true);
    assertEquals(
      restored.listEvents({ sessionId: "session-1" }).events.map((event) =>
        event.event.kind
      ),
      ["status_changed"],
    );
    const normalized = (await store.getSession("session-1"))?.transcript ?? [];
    assertEquals(normalized.slice(0, 3), incomplete);
    assertEquals(normalized.length, 5);
    assertUnknownToolOutcome(normalized[3], "call-a", "read_file");
    assertUnknownToolOutcome(normalized[4], "call-b", "read_file");

    const followUp = await restored.startTurn("req-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Try again" },
    });
    assertEquals(followUp.ok, true);
    await restored.waitForTurn("session-1", "turn-1");
    expect(next).toEqual([
      ...normalized,
      ...unattachedTurnContext(),
      { role: "user", content: "Try again" },
    ]);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("a listener failure after normalization commit does not poison the session", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    const incomplete: readonly HarnessTranscriptMessage[] = [
      { role: "user", content: "Read it" },
      {
        role: "assistant",
        content: "Reading it.",
        toolCalls: [toolCall("call-interrupted")],
      },
    ];
    await store.saveSession(recordedSession(incomplete));

    const listenerError = new Error("listener rejected the recovery event");
    let listenerCalls = 0;
    let next: readonly HarnessTranscriptMessage[] = [];
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          next = [...runOptions.transcript];
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: nextIsoNow(),
      onEvent: () => {
        listenerCalls += 1;
        if (listenerCalls === 1) {
          throw listenerError;
        }
      },
      sessionStore: store,
    });

    const error = await assertRejects(() => restored.initializeFromStore());
    assertEquals(error, listenerError);
    const normalized = (await store.getSession("session-1"))?.transcript ?? [];
    assertEquals(normalized.slice(0, 2), incomplete);
    assertEquals(normalized.length, 3);
    assertUnknownToolOutcome(
      normalized[2],
      "call-interrupted",
      "read_file",
    );

    const followUp = await restored.startTurn("req-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Continue" },
    });
    assertEquals(followUp.ok, true);
    await restored.waitForTurn("session-1", "turn-1");
    expect(next).toEqual([
      ...normalized,
      ...unattachedTurnContext(),
      { role: "user", content: "Continue" },
    ]);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});

Deno.test("sqlite session restore refuses structural corruption without deleting evidence", async () => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const store = await openSqliteHarnessChatSessionStore({
    url: toFileUrl(path),
  });
  try {
    await store.saveSession(recordedSession(ORPHAN_TRANSCRIPT));

    let reachedTheLoop = false;
    const restored = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          reachedTheLoop = true;
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:02:00.000Z",
      sessionStore: store,
    });
    await restored.initializeFromStore();

    assertEquals(restored.status("session-1").sessions[0].reusable, false);
    const followUp = await restored.startTurn("req-1", {
      sessionId: "session-1",
      turnId: "turn-1",
      input: { text: "Try again" },
    });
    assertEquals(followUp.ok, false);
    assertEquals(
      followUp.ok === false ? followUp.error.code : "",
      "internal_error",
    );
    assertEquals(
      followUp.ok === false ? followUp.error.details : undefined,
      {
        reason: "malformed_transcript",
        malformation: "tool_result_without_pending_call",
        transcriptIndex: 1,
      },
    );
    assertEquals(reachedTheLoop, false);
    const stored = (await store.getSession("session-1"))?.transcript ?? [];
    assertEquals(stored, ORPHAN_TRANSCRIPT);
    assertEquals(inspectHarnessTranscriptPairing(stored).valid, false);

    // A restart derives the refusal from the intact evidence again.
    const secondRestart = new HarnessInteractiveChatService({
      createPromptLoop: () => ({
        runTranscript: (runOptions) => {
          reachedTheLoop = true;
          return Promise.resolve(makeResult(runOptions, "Recovered."));
        },
      }),
      now: () => "2026-05-27T00:03:00.000Z",
      sessionStore: store,
    });
    await secondRestart.initializeFromStore();
    assertEquals(secondRestart.status("session-1").sessions[0].reusable, false);
    const afterRestart = await secondRestart.startTurn("req-2", {
      sessionId: "session-1",
      turnId: "turn-2",
      input: { text: "Try again" },
    });
    assertEquals(afterRestart.ok, false);
    assertEquals(
      afterRestart.ok === false ? afterRestart.error.code : "",
      "internal_error",
    );
    assertEquals(
      (await store.getSession("session-1"))?.transcript,
      ORPHAN_TRANSCRIPT,
    );
    assertEquals(reachedTheLoop, false);
  } finally {
    store.close();
    await Deno.remove(path);
  }
});
