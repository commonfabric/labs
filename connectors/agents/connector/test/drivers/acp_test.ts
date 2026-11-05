import { assertEquals, assertRejects } from "@std/assert";
import type {
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { AcpDriver, type AcpTransport } from "../../src/drivers/acp.ts";
import type { AgentDriver } from "../../src/types.ts";

function fakeTransport(
  overrides: Partial<AcpTransport> = {},
): AcpTransport {
  return {
    setSessionUpdateSink() {},
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
      }),
    listSessions: () => Promise.resolve({ sessions: [] }),
    loadSession: () => Promise.resolve({}),
    resumeSession: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    setSessionMode: () => Promise.resolve({}),
    setSessionConfigOption: () => Promise.resolve({ configOptions: [] }),
    stop: () => Promise.resolve(),
    ...overrides,
  };
}

const PROCESS_ACP_SERVER = String.raw`#!/usr/bin/env python3
import json, sys

print("fake ACP adapter started", file=sys.stderr, flush=True)
pending_prompt = None
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params", {})
    if method == "session/cancel":
        if pending_prompt is not None:
            print(json.dumps({"jsonrpc": "2.0", "id": pending_prompt, "result": {"stopReason": "cancelled"}}), flush=True)
            pending_prompt = None
        continue
    if "id" not in message:
        continue
    if method == "initialize":
        result = {
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": True,
                "sessionCapabilities": {"list": {}, "resume": {}},
            },
            "agentInfo": {"name": "process-acp", "version": "2"},
        }
    elif method == "session/list":
        result = {"sessions": [{"sessionId": "process-session", "cwd": "/tmp/process"}]}
    elif method in ("session/load", "session/resume"):
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": params["sessionId"],
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "from process"}},
            },
        }), flush=True)
        result = {
            "modes": {"currentModeId": "plan", "availableModes": [{"id": "plan", "name": "Plan"}]},
            "configOptions": [{"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": False}],
        }
    elif method == "session/prompt":
        pending_prompt = message["id"]
        continue
    elif method == "session/set_mode":
        result = {}
    elif method == "session/set_config_option":
        result = {"configOptions": []}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
`;

Deno.test("ACP driver enumerates and loads persisted sessions", async () => {
  const calls: string[] = [];
  let notify: ((notification: SessionNotification) => void) | undefined;
  const transport: AcpTransport = {
    setSessionUpdateSink(sink) {
      notify = sink;
    },
    initialize(): Promise<InitializeResponse> {
      return Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {} },
        },
        agentInfo: { name: "fake-acp", version: "1" },
      });
    },
    listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
      calls.push(`list:${params.cursor ?? ""}`);
      return Promise.resolve({
        sessions: [{
          sessionId: "session-1",
          cwd: "/tmp/project",
          title: "Persisted task",
          updatedAt: "2026-07-09T00:00:00Z",
        }],
      });
    },
    loadSession(params: LoadSessionRequest) {
      calls.push(`load:${params.sessionId}`);
      notify?.({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hello" },
        },
      });
      return Promise.resolve({});
    },
    resumeSession: () => Promise.resolve({}),
    prompt(_params: PromptRequest): Promise<PromptResponse> {
      return Promise.resolve({ stopReason: "end_turn" });
    },
    cancel: () => Promise.resolve(),
    setSessionMode(_params: SetSessionModeRequest) {
      return Promise.resolve({});
    },
    setSessionConfigOption(_params: SetSessionConfigOptionRequest) {
      return Promise.resolve({ configOptions: [] });
    },
    stop: () => Promise.resolve(),
  };
  const driver = new AcpDriver(
    { id: "other:default", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  const page = await driver.listSessions();
  assertEquals(page.sessions[0].title, "Persisted task");
  const snapshot = await driver.readSession("session-1");
  assertEquals(snapshot.complete, true);
  assertEquals(snapshot.events.length, 1);
  assertEquals(snapshot.normalizedMessages[0].role, "user");
  assertEquals(snapshot.normalizedMessages[0].textPreview, "hello");
  let cancellationReadyCalls = 0;
  let sessionActiveCalls = 0;
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" }, {
      onCancellationReady: () => {
        cancellationReadyCalls++;
      },
      onSessionActive: () => {
        sessionActiveCalls++;
        return Promise.resolve();
      },
    })).status,
    "succeeded",
  );
  assertEquals(cancellationReadyCalls, 1);
  assertEquals(sessionActiveCalls, 1);
  assertEquals(calls, ["list:", "load:session-1"]);
  assertEquals(driver.source.capabilities.rename, false);
  await driver.stop();
});

Deno.test("ACP controls are discovered and enforced per session", async () => {
  const modeCalls: SetSessionModeRequest[] = [];
  const configCalls: SetSessionConfigOptionRequest[] = [];
  let firstLoads = 0;
  let inventoryIncludesSecond = true;
  const transport: AcpTransport = {
    setSessionUpdateSink() {},
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
      }),
    listSessions: () =>
      Promise.resolve({
        sessions: [
          { sessionId: "first", cwd: "/tmp/first" },
          ...(inventoryIncludesSecond
            ? [{ sessionId: "second", cwd: "/tmp/second" }]
            : []),
        ],
      }),
    loadSession: (params) => {
      if (params.sessionId === "first") firstLoads++;
      return Promise.resolve(
        params.sessionId === "first"
          ? firstLoads === 1
            ? {
              modes: {
                currentModeId: "plan",
                availableModes: [{ id: "plan", name: "Plan" }],
              },
              configOptions: [{
                id: "thinking",
                name: "Thinking",
                type: "boolean" as const,
                currentValue: false,
              }],
            }
            : {}
          : {
            modes: {
              currentModeId: "build",
              availableModes: [{ id: "build", name: "Build" }],
            },
            configOptions: [],
          },
      );
    },
    resumeSession: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    setSessionMode: (params) => {
      modeCalls.push(params);
      return Promise.resolve({});
    },
    setSessionConfigOption: (params) => {
      configCalls.push(params);
      return Promise.resolve({ configOptions: [] });
    },
    stop: () => Promise.resolve(),
  };
  const driver = new AcpDriver(
    { id: " ACP:Default ", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  await driver.listSessions();
  await driver.readSession("first");
  await driver.readSession("second");
  assertEquals(driver.source.id, "acp:default");
  assertEquals(driver.source.capabilities.modes, ["build", "plan"]);
  // ACP cannot start a session: the capability is absent, and the
  // operation says so.
  assertEquals("startSession" in driver.source.capabilities, false);
  assertEquals(
    (await (driver as AgentDriver).startSession("first", { text: "Hi" }))
      .status,
    "unsupported",
  );
  assertEquals(
    (await driver.setMode("first", "build")).status,
    "unsupported",
  );
  assertEquals((await driver.setMode("first", "plan")).status, "succeeded");
  assertEquals(
    (await driver.setConfigOption("second", "thinking", true)).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("first", "thinking", "yes")).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("first", "thinking", true)).status,
    "succeeded",
  );
  assertEquals(modeCalls.length, 1);
  assertEquals(configCalls.length, 1);
  await driver.readSession("first");
  assertEquals(driver.source.capabilities.modes, ["build"]);
  assertEquals(driver.source.capabilities.configOptions, {});
  assertEquals(
    (await driver.setMode("first", "plan")).status,
    "unsupported",
  );
  inventoryIncludesSecond = false;
  await driver.listSessions();
  assertEquals(driver.source.capabilities.modes, []);
  assertEquals(driver.source.capabilities.setMode, false);
});

Deno.test("ACP startup stops transports missing required capabilities", async () => {
  for (
    const agentCapabilities of [
      { loadSession: true },
      { sessionCapabilities: { list: {} } },
    ]
  ) {
    let stops = 0;
    const transport: AcpTransport = {
      setSessionUpdateSink() {},
      initialize: () =>
        Promise.resolve({ protocolVersion: 1, agentCapabilities }),
      listSessions: () => Promise.resolve({ sessions: [] }),
      loadSession: () => Promise.resolve({}),
      resumeSession: () => Promise.resolve({}),
      prompt: () => Promise.resolve({ stopReason: "end_turn" }),
      cancel: () => Promise.resolve(),
      setSessionMode: () => Promise.resolve({}),
      setSessionConfigOption: () => Promise.resolve({ configOptions: [] }),
      stop: () => {
        stops++;
        return Promise.resolve();
      },
    };
    const driver = new AcpDriver(
      { id: "acp:invalid", driver: "acp", enabled: true, command: ["fake"] },
      transport,
    );
    await assertRejects(() => driver.start(), Error, "must advertise");
    assertEquals(stops, 1);
  }
});

Deno.test("ACP driver stops an adapter blocked during initialization", async () => {
  const initializationStarted = Promise.withResolvers<void>();
  const initialization = Promise.withResolvers<InitializeResponse>();
  let observedSignal: AbortSignal | undefined;
  let stopCount = 0;
  const transport: AcpTransport = {
    setSessionUpdateSink() {},
    initialize(signal): Promise<InitializeResponse> {
      observedSignal = signal;
      initializationStarted.resolve();
      return initialization.promise;
    },
    listSessions: () => Promise.resolve({ sessions: [] }),
    loadSession: () => Promise.resolve({}),
    resumeSession: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    setSessionMode: () => Promise.resolve({}),
    setSessionConfigOption: () => Promise.resolve({ configOptions: [] }),
    stop: () => {
      stopCount++;
      return Promise.resolve();
    },
  };
  const driver = new AcpDriver(
    { id: "other:blocked", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );
  const controller = new AbortController();
  const started = driver.start(controller.signal);
  await initializationStarted.promise;
  controller.abort();
  const outcome = await started.then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );

  assertEquals(outcome.ok, false);
  if (outcome.ok) throw new Error("ACP initialization completed after abort");
  assertEquals((outcome.error as Error).name, "AbortError");
  assertEquals(observedSignal, controller.signal);
  assertEquals(stopCount, 1);
});

Deno.test("ACP driver serializes overlapping loads of the same session", async () => {
  let notify: ((notification: SessionNotification) => void) | undefined;
  const firstLoadStarted = Promise.withResolvers<void>();
  const releaseFirstLoad = Promise.withResolvers<void>();
  const promptLoadStarted = Promise.withResolvers<void>();
  const releasePromptLoad = Promise.withResolvers<void>();
  let loadCount = 0;
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  const transport: AcpTransport = {
    setSessionUpdateSink(sink) {
      notify = sink;
    },
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
      }),
    listSessions: () =>
      Promise.resolve({
        sessions: [{
          sessionId: "session-1",
          cwd: "/tmp/project",
        }],
      }),
    async loadSession(params) {
      loadCount++;
      const ordinal = loadCount;
      activeLoads++;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      try {
        notify?.({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `load-${ordinal}` },
          },
        });
        if (ordinal === 1) {
          firstLoadStarted.resolve();
          await releaseFirstLoad.promise;
        }
        if (ordinal === 4) {
          promptLoadStarted.resolve();
          await releasePromptLoad.promise;
        }
        return {};
      } finally {
        activeLoads--;
      }
    },
    resumeSession: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    setSessionMode: () => Promise.resolve({}),
    setSessionConfigOption: () => Promise.resolve({ configOptions: [] }),
    stop: () => Promise.resolve(),
  };
  const driver = new AcpDriver(
    { id: "other:default", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  await driver.listSessions();
  const first = driver.readSession("session-1");
  await firstLoadStarted.promise;
  const firstPrompt = driver.prompt("session-1", { text: "continue" });
  assertEquals(
    (await driver.prompt("session-1", { text: "duplicate" })).status,
    "needs-confirmation",
  );
  const second = driver.readSession("session-1");
  assertEquals(loadCount, 1);
  assertEquals(maximumActiveLoads, 1);
  releaseFirstLoad.resolve();

  const [firstSnapshot, firstPromptResult, secondSnapshot] = await Promise.all([
    first,
    firstPrompt,
    second,
  ]);
  assertEquals(firstPromptResult.status, "succeeded");
  assertEquals(loadCount, 3);
  assertEquals(
    firstSnapshot.normalizedMessages.map((message) => message.textPreview),
    ["load-1"],
  );
  assertEquals(
    secondSnapshot.normalizedMessages.map((message) => message.textPreview),
    ["load-3"],
  );

  const secondPrompt = driver.prompt("session-1", { text: "continue" });
  await promptLoadStarted.promise;
  const third = driver.readSession("session-1");
  assertEquals(loadCount, 4);
  assertEquals(maximumActiveLoads, 1);
  releasePromptLoad.resolve();
  const [secondPromptResult, thirdSnapshot] = await Promise.all([
    secondPrompt,
    third,
  ]);
  assertEquals(secondPromptResult.status, "succeeded");
  assertEquals(loadCount, 5);
  assertEquals(
    thirdSnapshot.normalizedMessages.map((message) => message.textPreview),
    ["load-5"],
  );
  assertEquals(maximumActiveLoads, 1);
  await driver.stop();
});

Deno.test("ACP driver normalizes updates and prunes stale controls", async () => {
  let notify: ((notification: SessionNotification) => void) | undefined;
  let inventory: ListSessionsResponse["sessions"] = [{
    sessionId: "stale",
    cwd: "/tmp/stale",
    additionalDirectories: ["/tmp/shared"],
  }];
  const loadRequests: LoadSessionRequest[] = [];
  const transport = fakeTransport({
    setSessionUpdateSink(sink) {
      notify = sink;
    },
    listSessions: (params) => {
      assertEquals(params, {});
      return Promise.resolve({ sessions: inventory });
    },
    loadSession: (params) => {
      loadRequests.push(params);
      for (
        const update of [
          {
            id: "thought",
            sessionUpdate: "agent_thought_chunk",
            content: ["thinking", { text: "carefully" }],
          },
          {
            sessionUpdate: "tool_call",
            content: { content: { text: "running a tool" } },
          },
          { sessionUpdate: "unrecognized", content: 42 },
        ]
      ) {
        notify?.(
          { sessionId: params.sessionId, update } as SessionNotification,
        );
      }
      return Promise.resolve({
        modes: {
          currentModeId: "plan",
          availableModes: [{ id: "plan", name: "Plan" }],
        },
      });
    },
  });
  const driver = new AcpDriver(
    { id: "acp:updates", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  await driver.listSessions();
  const snapshot = await driver.readSession("stale");
  assertEquals(loadRequests[0].additionalDirectories, ["/tmp/shared"]);
  assertEquals(
    snapshot.normalizedMessages.map(({ id, role, textPreview }) => ({
      id,
      role,
      textPreview,
    })),
    [
      {
        id: "thought",
        role: "assistant",
        textPreview: "thinking\ncarefully",
      },
      {
        id: "update-1",
        role: "tool",
        textPreview: "running a tool",
      },
      { id: "update-2", role: "unknown", textPreview: null },
    ],
  );
  assertEquals(driver.source.capabilities.modes, ["plan"]);

  inventory = [{ sessionId: "current", cwd: "/tmp/current" }];
  await driver.listSessions();
  assertEquals(driver.source.capabilities.modes, []);
  await assertRejects(
    () => driver.readSession("stale"),
    Error,
    "not listed or missing cwd",
  );
});

Deno.test("ACP prompt admission covers resumed and uncertain outcomes", async () => {
  const promptStarted = Promise.withResolvers<void>();
  const promptResult = Promise.withResolvers<PromptResponse>();
  let promptCalls = 0;
  let resumeCalls = 0;
  let cancelCalls = 0;
  const transport = fakeTransport({
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {} },
        },
      }),
    listSessions: () =>
      Promise.resolve({
        sessions: [{ sessionId: "session", cwd: "/tmp/project" }],
      }),
    resumeSession: () => {
      resumeCalls++;
      return Promise.resolve({});
    },
    prompt: () => {
      promptCalls++;
      if (promptCalls === 1) {
        promptStarted.resolve();
        return promptResult.promise;
      }
      return Promise.reject(new Error("adapter disconnected"));
    },
    cancel: () => {
      cancelCalls++;
      return Promise.resolve();
    },
  });
  const driver = new AcpDriver(
    { id: "acp:prompt", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  assertEquals(
    (await driver.prompt("missing", { text: "hello" })).status,
    "unsupported",
  );
  assertEquals((await driver.cancel("session")).status, "unsupported");
  assertEquals(
    (await driver.renameSession("session", "New title")).status,
    "unsupported",
  );
  await driver.listSessions();

  const first = driver.prompt("session", { text: "continue" });
  await promptStarted.promise;
  assertEquals(
    (await driver.prompt("session", { text: "again" })).status,
    "needs-confirmation",
  );
  assertEquals((await driver.cancel("session")).status, "succeeded");
  assertEquals(cancelCalls, 1);
  promptResult.resolve({ stopReason: "cancelled" });
  const cancelled = await first;
  assertEquals(cancelled.status, "failed");
  assertEquals(cancelled.error?.code, "cancelled");

  const uncertain = await driver.prompt("session", { text: "retry" });
  assertEquals(uncertain.status, "unknown");
  assertEquals(uncertain.error?.code, "prompt-outcome-unknown");
  assertEquals(resumeCalls, 2);
});

Deno.test("ACP select controls accept only advertised values", async () => {
  const configCalls: SetSessionConfigOptionRequest[] = [];
  const transport = fakeTransport({
    listSessions: () =>
      Promise.resolve({
        sessions: [{ sessionId: "session", cwd: "/tmp/project" }],
      }),
    loadSession: () =>
      Promise.resolve({
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select" as const,
            currentValue: "fast",
            options: [{
              name: "Models",
              options: [
                { name: "Fast", value: "fast" },
                { name: "Careful", value: "careful" },
              ],
            }],
          },
          {
            id: "mystery",
            name: "Mystery",
            type: "future-type",
            currentValue: null,
          },
        ],
      } as unknown as LoadSessionResponse),
    setSessionConfigOption: (params) => {
      configCalls.push(params);
      return Promise.resolve({
        configOptions: [{
          id: "model",
          name: "Model",
          type: "select" as const,
          currentValue: "careful",
          options: [{ name: "Careful", value: "careful" }],
        }],
      });
    },
  });
  const driver = new AcpDriver(
    { id: "acp:config", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  await driver.listSessions();
  await driver.readSession("session");
  assertEquals(
    (await driver.setConfigOption("session", "missing", "value")).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("session", "mystery", "value")).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("session", "model", true)).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("session", "model", "unknown")).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("session", "model", "careful")).status,
    "succeeded",
  );
  assertEquals(configCalls, [{
    sessionId: "session",
    configId: "model",
    value: "careful",
  }]);
});

Deno.test("default ACP transport rejects invalid startup order", async () => {
  const driver = new AcpDriver({
    id: "acp:default",
    driver: "acp",
    enabled: true,
  });

  await assertRejects(
    () => driver.listSessions(),
    Error,
    "transport is not initialized",
  );
  await assertRejects(
    () => driver.start(),
    Error,
    "requires a command",
  );

  const controller = new AbortController();
  controller.abort(new Error("cancelled before start"));
  await assertRejects(
    () => driver.start(controller.signal),
    Error,
    "cancelled before start",
  );
});

Deno.test("default ACP transport serves a complete process session", async () => {
  const directory = await Deno.makeTempDir();
  const server = `${directory}/fake-acp`;
  await Deno.writeTextFile(server, PROCESS_ACP_SERVER);
  await Deno.chmod(server, 0o755);
  const driver = new AcpDriver({
    id: "acp:process",
    driver: "acp",
    enabled: true,
    command: [server],
  });
  try {
    await driver.start();
    assertEquals(driver.source.version, "2");
    assertEquals((await driver.listSessions()).sessions.length, 1);
    const snapshot = await driver.readSession("process-session");
    assertEquals(snapshot.normalizedMessages[0].textPreview, "from process");
    assertEquals(
      (await driver.setMode("process-session", "plan")).status,
      "succeeded",
    );
    assertEquals(
      (await driver.setConfigOption("process-session", "thinking", true))
        .status,
      "succeeded",
    );

    const active = Promise.withResolvers<void>();
    const prompt = driver.prompt("process-session", { text: "continue" }, {
      onSessionActive: () => {
        active.resolve();
        return Promise.resolve();
      },
    });
    await active.promise;
    assertEquals((await driver.cancel("process-session")).status, "succeeded");
    assertEquals((await prompt).error?.code, "cancelled");

    await assertRejects(
      () => driver.start(),
      Error,
      "already initialized",
    );
  } finally {
    await driver.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
