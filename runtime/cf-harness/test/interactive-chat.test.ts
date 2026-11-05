import { assertEquals } from "@std/assert";
import {
  COMMENT_THREAD_HARNESS_CHAT_POLICY,
  createHarnessChatErrorResponse,
  createHarnessChatEventEnvelope,
  createHarnessChatOkResponse,
  createHarnessChatSessionStatus,
  DEFAULT_HARNESS_CHAT_CAPABILITIES,
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatBrowserAccessLease,
  type HarnessChatEventEnvelope,
  type HarnessChatPolicy,
  type HarnessChatRequestEnvelope,
  type HarnessChatSessionStatus,
  type HarnessChatStartSessionParams,
  type HarnessChatStartTurnParams,
  READONLY_HARNESS_CHAT_POLICY,
  reduceHarnessChatSessionStatus,
  resolveHarnessChatCapabilities,
  resolveHarnessChatPolicy,
} from "../src/contracts/interactive-chat.ts";

class InMemoryInteractiveChatContract {
  readonly events: HarnessChatEventEnvelope[] = [];
  readonly #sessions = new Map<string, HarnessChatSessionStatus>();
  #sequence = 0;

  startSession(params: HarnessChatStartSessionParams) {
    const session = createHarnessChatSessionStatus({
      sessionId: params.sessionId ?? "session-1",
      createdAt: "2026-05-22T00:00:00.000Z",
      workspace: params.workspace,
      context: params.context,
      model: params.model,
      capabilities: params.capabilities,
      policy: resolveHarnessChatPolicy(params.policy, params.context),
      browserAccess: params.browserAccess,
      metadata: params.metadata,
    });
    this.#sessions.set(session.sessionId, session);
    this.#emit(session.sessionId, undefined, {
      kind: "session_started",
      session,
    });
    return session;
  }

  startTurn(params: HarnessChatStartTurnParams) {
    const session = this.#requireSession(params.sessionId);
    const turnId = params.turnId ?? `turn-${session.turnCount + 1}`;
    this.#emit(params.sessionId, turnId, {
      kind: "turn_started",
      turn: {
        turnId,
        status: "running",
        startedAt: "2026-05-22T00:01:00.000Z",
        updatedAt: "2026-05-22T00:01:00.000Z",
      },
    });
    return this.#requireSession(params.sessionId).activeTurn;
  }

  cancelTurn(sessionId: string, reason: string) {
    const session = this.#requireSession(sessionId);
    const turnId = session.activeTurnId ?? "turn-unknown";
    this.#emit(sessionId, turnId, {
      kind: "turn_canceled",
      turnId,
      reason,
    });
    return this.#requireSession(sessionId);
  }

  completeTurn(sessionId: string, finalText: string) {
    const session = this.#requireSession(sessionId);
    const turnId = session.activeTurnId ?? "turn-unknown";
    this.#emit(sessionId, turnId, {
      kind: "assistant_delta",
      text: finalText,
    });
    this.#emit(sessionId, turnId, {
      kind: "assistant_completed",
      text: finalText,
    });
    this.#emit(sessionId, turnId, {
      kind: "turn_completed",
      turnId,
      finalText,
    });
    return this.#requireSession(sessionId);
  }

  closeSession(sessionId: string, reason: string) {
    this.#requireSession(sessionId);
    this.#emit(sessionId, undefined, {
      kind: "session_closed",
      reason,
    });
    return this.#requireSession(sessionId);
  }

  status() {
    return Array.from(this.#sessions.values());
  }

  #requireSession(sessionId: string) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`missing session ${sessionId}`);
    }
    return session;
  }

  #emit(
    sessionId: string,
    turnId: string | undefined,
    event: HarnessChatEventEnvelope["event"],
  ) {
    const envelope = createHarnessChatEventEnvelope({
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      sequence: ++this.#sequence,
      emittedAt: `2026-05-22T00:00:${
        String(this.#sequence).padStart(2, "0")
      }.000Z`,
      event,
    });
    this.events.push(envelope);
    const current = this.#sessions.get(sessionId);
    if (current) {
      this.#sessions.set(
        sessionId,
        reduceHarnessChatSessionStatus(current, envelope),
      );
    }
  }
}

Deno.test("interactive chat capabilities are explicit about v1 limits", () => {
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.partialTextStream, false);
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.toolTelemetry, true);
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.fileMutationEvents, true);
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.browserProfile, true);
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.browserAccessLease, true);
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.delegation, true);
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.readonlyMode, true);
  assertEquals(DEFAULT_HARNESS_CHAT_CAPABILITIES.cfcEnforcement, true);

  assertEquals(resolveHarnessChatCapabilities({ partialTextStream: true }), {
    ...DEFAULT_HARNESS_CHAT_CAPABILITIES,
    partialTextStream: true,
  });
});

Deno.test("interactive chat request envelopes bind methods to params", () => {
  const request = {
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-start-session",
    method: "start_session",
    params: {
      sessionId: "chat-session-1",
      workspace: { hostPath: "/workspace" },
      capabilities: {
        partialTextStream: false,
      },
    },
  } satisfies HarnessChatRequestEnvelope<"start_session">;

  assertEquals(request.params.workspace.hostPath, "/workspace");
});

Deno.test("interactive chat request envelopes carry a typed settlement on resolve_client_action", () => {
  const typed = {
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-resolve-typed",
    method: "resolve_client_action",
    params: {
      sessionId: "chat-session-1",
      actionId: "action-1",
      settlement: {
        status: "failed_to_deliver",
        reason: "the Weaver could not reach the service",
        landed: "no",
      },
    },
  } satisfies HarnessChatRequestEnvelope<"resolve_client_action">;
  const answer = {
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-resolve-answer",
    method: "resolve_client_action",
    params: {
      sessionId: "chat-session-1",
      actionId: "action-2",
      outcome: "done",
      result: "Opened Reading.",
    },
  } satisfies HarnessChatRequestEnvelope<"resolve_client_action">;

  assertEquals(typed.params.settlement.status, "failed_to_deliver");
  assertEquals(answer.params.outcome, "done");
});

Deno.test("interactive chat contract supports reusable turn cancel", () => {
  const service = new InMemoryInteractiveChatContract();
  const browserAccess: HarnessChatBrowserAccessLease = {
    type: "cf-harness.chat.browser-access-lease",
    leaseId: "chat-browser-lease-1",
    cdpUrl: "http://127.0.0.1:9222",
    owner: "loom",
  };
  const policy: HarnessChatPolicy = {
    ...READONLY_HARNESS_CHAT_POLICY,
    allowedSubagentProfiles: ["browser"],
  };

  const session = service.startSession({
    sessionId: "chat-session-1",
    workspace: { hostPath: "/workspace", cwd: "/workspace/project" },
    model: "gpt-5.4",
    capabilities: {
      browserProfile: true,
      browserAccessLease: true,
    },
    browserAccess,
    policy,
  });
  assertEquals(session.status, "idle");
  assertEquals(session.policy.toolMode, "read-only");
  assertEquals(session.policy.allowedToolIds, [
    "read_file",
    "view_image",
    "read_skill_resource",
  ]);
  assertEquals(session.capabilities.browserAccessLease, true);

  const turn = service.startTurn({
    sessionId: "chat-session-1",
    turnId: "turn-1",
    input: { text: "Summarize this comment thread." },
  });
  assertEquals(turn?.status, "running");
  assertEquals(service.status()[0].status, "turn_running");
  assertEquals(service.status()[0].activeTurnId, "turn-1");

  const canceled = service.cancelTurn("chat-session-1", "user_requested");
  assertEquals(canceled.status, "canceling");
  assertEquals(canceled.reusable, false);
  assertEquals(canceled.turnCount, 1);
  assertEquals(canceled.activeTurnId, "turn-1");
  assertEquals(canceled.activeTurn?.status, "canceling");
  assertEquals(
    service.events.map((event) => event.event.kind),
    ["session_started", "turn_started", "turn_canceled"],
  );
});

Deno.test("interactive chat contract forces comment threads into read-only policy", () => {
  const service = new InMemoryInteractiveChatContract();
  const session = service.startSession({
    sessionId: "comment-session-1",
    workspace: { hostPath: "/workspace" },
    context: {
      type: "comment-thread",
      threadId: "comment-thread-1",
      subject: "review comment",
    },
  });

  assertEquals(session.context, {
    type: "comment-thread",
    threadId: "comment-thread-1",
    subject: "review comment",
  });
  assertEquals(session.policy, COMMENT_THREAD_HARNESS_CHAT_POLICY);
  assertEquals(
    resolveHarnessChatPolicy({
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
    }, { type: "comment-thread" }),
    COMMENT_THREAD_HARNESS_CHAT_POLICY,
  );
});

Deno.test("interactive chat contract keeps file events structured", () => {
  const service = new InMemoryInteractiveChatContract();
  service.startSession({
    sessionId: "chat-session-2",
    workspace: { hostPath: "/workspace" },
  });
  service.startTurn({
    sessionId: "chat-session-2",
    turnId: "turn-1",
    input: { text: "Edit the file." },
  });

  const fileEvent = createHarnessChatEventEnvelope({
    sessionId: "chat-session-2",
    turnId: "turn-1",
    sequence: 99,
    emittedAt: "2026-05-22T00:02:00.000Z",
    event: {
      kind: "file_changed",
      change: {
        kind: "update",
        path: "/workspace/notes.md",
        oldContent: "old",
        newContent: "new",
        summary: "Updated notes",
      },
    },
  });
  assertEquals(fileEvent.protocolVersion, HARNESS_CHAT_PROTOCOL_VERSION);
  assertEquals(fileEvent.event, {
    kind: "file_changed",
    change: {
      kind: "update",
      path: "/workspace/notes.md",
      oldContent: "old",
      newContent: "new",
      summary: "Updated notes",
    },
  });

  const completed = service.completeTurn("chat-session-2", "Done.");
  assertEquals(completed.status, "idle");
  assertEquals(completed.reusable, true);
  assertEquals(
    service.events.map((event) => event.event.kind),
    [
      "session_started",
      "turn_started",
      "assistant_delta",
      "assistant_completed",
      "turn_completed",
    ],
  );
});

Deno.test("interactive chat responses carry protocol version and errors", () => {
  assertEquals(createHarnessChatOkResponse("req-1", { accepted: true }), {
    type: "cf-harness.chat.response",
    protocolVersion: 1,
    requestId: "req-1",
    ok: true,
    result: { accepted: true },
  });
  assertEquals(
    createHarnessChatErrorResponse("req-2", {
      code: "turn_already_running",
      message: "session session-1 already has active turn turn-1",
      retryable: true,
    }),
    {
      type: "cf-harness.chat.response",
      protocolVersion: 1,
      requestId: "req-2",
      ok: false,
      error: {
        code: "turn_already_running",
        message: "session session-1 already has active turn turn-1",
        retryable: true,
      },
    },
  );
});
