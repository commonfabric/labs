import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { isAbsolute, resolve } from "@std/path";
import {
  ClaudeAgentSdkDriver,
  type ClaudeSdkAdapter,
  desktopAppInstalled,
  directoryExists,
  openWithCommand,
} from "../../src/drivers/claude-agent-sdk.ts";

function fakeQuery(messages: unknown[]) {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(generator, {
    interrupt: () => Promise.resolve(),
    setPermissionMode: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    close: () => undefined,
  });
}

Deno.test("Claude driver lists all-project sessions and reads system messages", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sdk = {
    listSessions: (options?: Record<string, unknown>) => {
      calls.push({ method: "listSessions", args: [options] });
      return Promise.resolve([{
        sessionId: "session-1",
        summary: "First task",
        customTitle: "Renamed task",
        cwd: "/tmp/project",
        createdAt: 1_000,
        lastModified: 2_000,
      }]);
    },
    getSessionInfo: (id: string) => {
      calls.push({ method: "getSessionInfo", args: [id] });
      return Promise.resolve({
        sessionId: id,
        summary: "First task",
        customTitle: "Renamed task",
        cwd: "/tmp/project",
        createdAt: 1_000,
        lastModified: 2_000,
      });
    },
    getSessionMessages: (id: string, options?: Record<string, unknown>) => {
      calls.push({ method: "getSessionMessages", args: [id, options] });
      return Promise.resolve([{
        type: "system",
        uuid: "message-1",
        session_id: id,
        message: { content: "compacted" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      }]);
    },
    renameSession: (id: string, title: string) => {
      calls.push({ method: "renameSession", args: [id, title] });
      return Promise.resolve();
    },
    query: () => {
      throw new Error("not used");
    },
  };
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  const page = await driver.listSessions();
  assertEquals(page.sessions[0].title, "Renamed task");
  assertEquals(page.sessions[0].nativeSessionId, "session-1");
  assertEquals(page.sessions[0].archived, null);
  assertEquals(page.sessions[0].active, null);

  const snapshot = await driver.readSession("session-1");
  assertEquals(snapshot.complete, true);
  assertEquals(snapshot.events.length, 1);
  assertEquals(snapshot.normalizedMessages[0].role, "system");
  assertEquals(
    calls.find((call) => call.method === "getSessionMessages")?.args[1],
    { includeSystemMessages: true },
  );

  assertEquals(
    (await driver.renameSession("session-1", "New title")).status,
    "succeeded",
  );
  assertEquals(calls.at(-1), {
    method: "renameSession",
    args: ["session-1", "New title"],
  });
  assertEquals((await driver.setMode("session-1", "plan")).status, "succeeded");
  assertEquals(
    (await driver.setConfigOption("session-1", "model", "claude-test")).status,
    "succeeded",
  );
});

Deno.test("Claude bypassPermissions mode requires explicit opt-in", () => {
  const source = {
    id: "claude-code:default",
    driver: "claude-agent-sdk" as const,
    enabled: true,
  };
  const safe = new ClaudeAgentSdkDriver(source);
  const dangerous = new ClaudeAgentSdkDriver({
    ...source,
    allowDangerFullAccess: true,
  });
  assertEquals(
    safe.source.capabilities.modes?.includes("bypassPermissions"),
    false,
  );
  assertEquals(
    dangerous.source.capabilities.modes?.includes("bypassPermissions"),
    true,
  );
});

Deno.test("Claude acknowledges bypass permission prompts", async () => {
  let queryOptions: Record<string, unknown> | undefined;
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: (params: { options?: Record<string, unknown> }) => {
      queryOptions = params.options;
      return fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver({
    id: "claude-code:default",
    driver: "claude-agent-sdk",
    enabled: true,
    allowDangerFullAccess: true,
  }, sdk);

  assertEquals(
    (await driver.setMode("session-1", "bypassPermissions")).status,
    "succeeded",
  );
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).status,
    "succeeded",
  );
  assertEquals(queryOptions?.permissionMode, "bypassPermissions");
  assertEquals(queryOptions?.allowDangerouslySkipPermissions, true);
});

Deno.test("aborted Claude startup retains the stopped state", async () => {
  let queryCalls = 0;
  const sdk = {
    getSessionInfo: () => Promise.resolve(undefined),
    query: () => {
      queryCalls++;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver({
    id: "claude-code:default",
    driver: "claude-agent-sdk",
    enabled: true,
  }, sdk);
  await driver.stop();
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => driver.start(controller.signal),
    DOMException,
    "aborted",
  );
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).error?.code,
    "claude-driver-stopped",
  );
  const started = driver.start();
  await driver.stop();
  await started;
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).error?.code,
    "claude-driver-stopped",
  );
  assertEquals(queryCalls, 0);
});

Deno.test("Claude driver reports connector-owned queries as active", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const info = {
    sessionId: "session-1",
    summary: "First task",
    cwd: "/tmp/project",
    createdAt: 1_000,
    lastModified: 2_000,
  };
  const sdk = {
    listSessions: () => Promise.resolve([info]),
    getSessionInfo: () => Promise.resolve(info),
    getSessionMessages: () => Promise.resolve([]),
    query: () => {
      const generator = (async function* () {
        await blocked;
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await driver.listSessions();
  try {
    const prompt = driver.prompt("session-1", { text: "continue" });
    assertEquals((await driver.listSessions()).sessions[0].active, true);
    assertEquals(
      (await driver.readSession("session-1")).summary.active,
      true,
    );
    release();
    assertEquals((await prompt).status, "succeeded");
    assertEquals((await driver.listSessions()).sessions[0].active, null);
  } finally {
    release();
  }
});

Deno.test("Claude session reads retain activity observed when the read starts", async () => {
  let releasePrompt!: () => void;
  const promptBlocked = new Promise<void>((resolve) => releasePrompt = resolve);
  let releaseRead!: () => void;
  const readBlocked = new Promise<void>((resolve) => releaseRead = resolve);
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => markReadStarted = resolve);
  const info = {
    sessionId: "session-1",
    summary: "First task",
    cwd: "/tmp/project",
    createdAt: 1_000,
    lastModified: 2_000,
  };
  const sdk = {
    listSessions: () => Promise.resolve([info]),
    getSessionInfo: async () => {
      markReadStarted();
      await readBlocked;
      return info;
    },
    getSessionMessages: async () => {
      await readBlocked;
      return [];
    },
    query: () => {
      const generator = (async function* () {
        await promptBlocked;
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await driver.listSessions();
  try {
    const prompt = driver.prompt("session-1", { text: "continue" });
    const read = driver.readSession("session-1");
    await readStarted;
    releasePrompt();
    assertEquals((await prompt).status, "succeeded");
    releaseRead();
    assertEquals((await read).summary.active, true);
  } finally {
    releasePrompt();
    releaseRead();
  }
});

Deno.test("Claude prompt maps terminal SDK errors to failed receipts", async () => {
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: () =>
      fakeQuery([{
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["turn limit reached"],
      }]),
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );
  const result = await driver.prompt("session-1", { text: "continue" });
  assertEquals(result.status, "failed");
  assertEquals(result.error?.code, "claude-error_max_turns");
  assertStringIncludes(result.error?.message ?? "", "turn limit reached");
});

Deno.test("Claude resumes a session from its recorded working directory", async () => {
  let queryOptions: Record<string, unknown> | undefined;
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: (params: { options?: Record<string, unknown> }) => {
      queryOptions = params.options;
      return fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver({
    id: "claude-code:default",
    driver: "claude-agent-sdk",
    enabled: true,
    cwd: "/host/default",
  }, sdk);

  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).status,
    "succeeded",
  );
  assertEquals(queryOptions?.cwd, "/session/worktree");
});

Deno.test("Claude rejects a second prompt while resolving session metadata", async () => {
  let releaseLookup!: () => void;
  const lookupBlocked = new Promise<void>((resolve) => releaseLookup = resolve);
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) =>
    markLookupStarted = resolve
  );
  const sdk = {
    getSessionInfo: async () => {
      markLookupStarted();
      await lookupBlocked;
      return {
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      };
    },
    query: () =>
      fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]),
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  try {
    const first = driver.prompt("session-1", { text: "First" });
    await lookupStarted;
    const second = await driver.prompt("session-1", { text: "Second" });
    assertEquals(second.status, "needs-confirmation");
    assertEquals(second.error?.code, "already-active");
    releaseLookup();
    assertEquals((await first).status, "succeeded");
  } finally {
    releaseLookup();
  }
});

Deno.test("Claude cancels a prompt while resolving session metadata", async () => {
  let releaseLookup!: () => void;
  const lookupBlocked = new Promise<void>((resolve) => releaseLookup = resolve);
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) =>
    markLookupStarted = resolve
  );
  let queryCalled = false;
  const sdk = {
    getSessionInfo: async () => {
      markLookupStarted();
      await lookupBlocked;
      return {
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      };
    },
    query: () => {
      queryCalled = true;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );
  let cancellationReadyCalls = 0;

  try {
    const prompt = driver.prompt("session-1", { text: "continue" }, {
      onCancellationReady: () => {
        cancellationReadyCalls++;
      },
    });
    await lookupStarted;
    assertEquals(cancellationReadyCalls, 1);
    assertEquals((await driver.cancel("session-1")).status, "succeeded");
    releaseLookup();
    const result = await prompt;
    assertEquals(result.status, "failed");
    assertEquals(result.error?.code, "cancelled");
    assertEquals(queryCalled, false);
  } finally {
    releaseLookup();
  }
});

Deno.test("stopping Claude prevents pending and later prompts from starting", async () => {
  let releaseLookup!: () => void;
  const lookupBlocked = new Promise<void>((resolve) => releaseLookup = resolve);
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) =>
    markLookupStarted = resolve
  );
  let queryCalled = false;
  const sdk = {
    getSessionInfo: async () => {
      markLookupStarted();
      await lookupBlocked;
      return {
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      };
    },
    query: () => {
      queryCalled = true;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  try {
    const pending = driver.prompt("session-1", { text: "continue" });
    await lookupStarted;
    await driver.stop();
    releaseLookup();
    const pendingResult = await pending;
    assertEquals(pendingResult.status, "failed");
    assertEquals(pendingResult.error?.code, "claude-driver-stopped");
    assertEquals(
      (await driver.prompt("session-2", { text: "later" })).error?.code,
      "claude-driver-stopped",
    );
    assertEquals(queryCalled, false);
  } finally {
    releaseLookup();
  }
});

Deno.test("a stopped Claude query cannot untrack its replacement", async () => {
  let releaseStopped!: () => void;
  const stoppedBlocked = new Promise<void>((resolve) =>
    releaseStopped = resolve
  );
  let releaseReplacement!: () => void;
  const replacementBlocked = new Promise<void>((resolve) =>
    releaseReplacement = resolve
  );
  let queryCount = 0;
  let replacementInterrupted = false;
  const info = {
    sessionId: "session-1",
    summary: "First task",
    cwd: "/session/worktree",
    createdAt: 1_000,
    lastModified: 2_000,
  };
  const sdk = {
    listSessions: () => Promise.resolve([info]),
    query: () => {
      const isReplacement = queryCount++ > 0;
      const generator = (async function* () {
        await (isReplacement ? replacementBlocked : stoppedBlocked);
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => {
          if (isReplacement) replacementInterrupted = true;
          return Promise.resolve();
        },
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await driver.listSessions();
  try {
    const stoppedPrompt = driver.prompt("session-1", { text: "First" });
    await driver.stop();
    await driver.start();
    const replacementPrompt = driver.prompt("session-1", { text: "Second" });

    releaseStopped();
    assertEquals((await stoppedPrompt).status, "succeeded");
    assertEquals((await driver.cancel("session-1")).status, "succeeded");
    assertEquals(replacementInterrupted, true);

    releaseReplacement();
    assertEquals((await replacementPrompt).status, "succeeded");
  } finally {
    releaseStopped();
    releaseReplacement();
  }
});

Deno.test("Claude reports a missing prompt session before starting a query", async () => {
  let queryCalled = false;
  const sdk = {
    getSessionInfo: () => Promise.resolve(undefined),
    query: () => {
      queryCalled = true;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  const result = await driver.prompt("missing-session", { text: "continue" });
  assertEquals(result.status, "failed");
  assertEquals(result.error?.code, "claude-session-not-found");
  assertEquals(queryCalled, false);
});

Deno.test("Claude reports session lookup failures as retryable", async () => {
  const sdk = {
    getSessionInfo: () => Promise.reject(new Error("metadata unavailable")),
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  const result = await driver.prompt("session-1", { text: "continue" });
  assertEquals(result.status, "failed");
  assertEquals(result.error?.code, "claude-session-lookup-failed");
  assertEquals(result.error?.retryable, true);
  assertStringIncludes(result.error?.message ?? "", "metadata unavailable");
});

Deno.test("Claude interrupted query without a terminal result is unknown", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const started = new Promise<void>((resolve) => markStarted = resolve);
  const generator = (async function* () {
    markStarted();
    await blocked;
  })();
  const query = Object.assign(generator, {
    interrupt: () => {
      release();
      return Promise.resolve();
    },
    setPermissionMode: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    close: () => release(),
  });
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/tmp/project",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: () => query,
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );
  const prompt = driver.prompt("session-1", { text: "continue" });
  await started;
  assertEquals((await driver.cancel("session-1")).status, "succeeded");
  assertEquals((await prompt).status, "unknown");
});

Deno.test("multiple Claude sources isolate config directories for short SDK operations", async () => {
  const previous = Deno.env.get("CLAUDE_CONFIG_DIR");
  Deno.env.set("CLAUDE_CONFIG_DIR", "/sentinel");
  const observed: string[] = [];
  const sdk = {
    listSessions: async () => {
      observed.push(`list:${Deno.env.get("CLAUDE_CONFIG_DIR")}`);
      await Promise.resolve();
      return [];
    },
    renameSession: async () => {
      observed.push(`rename:${Deno.env.get("CLAUDE_CONFIG_DIR")}`);
      await Promise.resolve();
    },
  } as unknown as ClaudeSdkAdapter;
  const first = new ClaudeAgentSdkDriver({
    id: "claude-code:first",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/first",
  }, sdk);
  const second = new ClaudeAgentSdkDriver({
    id: "claude-code:second",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/second",
  }, sdk);
  try {
    await Promise.all([first.listSessions(), second.listSessions()]);
    await Promise.all([
      first.renameSession("session-1", "First"),
      second.renameSession("session-2", "Second"),
    ]);
    assertEquals(observed, [
      "list:/claude/first",
      "list:/claude/second",
      "rename:/claude/first",
      "rename:/claude/second",
    ]);
    assertEquals(Deno.env.get("CLAUDE_CONFIG_DIR"), "/sentinel");
  } finally {
    if (previous === undefined) Deno.env.delete("CLAUDE_CONFIG_DIR");
    else Deno.env.set("CLAUDE_CONFIG_DIR", previous);
  }
});

Deno.test("Claude prompts use explicit source env and run concurrently", async () => {
  const previous = Deno.env.get("CLAUDE_CONFIG_DIR");
  Deno.env.set("CLAUDE_CONFIG_DIR", "/sentinel");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) =>
    markFirstStarted = resolve
  );
  const observed: Array<{ prompt: string; env: Record<string, string> }> = [];
  const sdk = {
    listSessions: () => {
      const firstSource = Deno.env.get("CLAUDE_CONFIG_DIR") === "/claude/first";
      const sessionId = firstSource ? "session-1" : "session-2";
      return Promise.resolve([{
        sessionId,
        summary: sessionId,
        cwd: `/${sessionId}`,
        createdAt: 1_000,
        lastModified: 2_000,
      }]);
    },
    getSessionInfo: (sessionId: string) =>
      Promise.resolve({
        sessionId,
        summary: sessionId,
        cwd: `/${sessionId}`,
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      observed.push({
        prompt: params.prompt,
        env: params.options?.env as Record<string, string>,
      });
      if (params.prompt === "First") markFirstStarted();
      const generator = (async function* () {
        await blocked;
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const first = new ClaudeAgentSdkDriver({
    id: "claude-code:first",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/first",
    env: { SOURCE_TOKEN: "first" },
  }, sdk);
  const second = new ClaudeAgentSdkDriver({
    id: "claude-code:second",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/second",
    env: { SOURCE_TOKEN: "second" },
  }, sdk);
  try {
    await Promise.all([first.listSessions(), second.listSessions()]);
    const firstPrompt = first.prompt("session-1", { text: "First" });
    await firstStarted;
    const secondPrompt = second.prompt("session-2", { text: "Second" });
    await Promise.resolve();
    const overlapped = observed.length === 2;
    release();
    await Promise.all([firstPrompt, secondPrompt]);
    assertEquals(overlapped, true);
    assertEquals(
      observed.map(({ prompt, env }) => ({
        prompt,
        configDir: env.CLAUDE_CONFIG_DIR,
        sourceToken: env.SOURCE_TOKEN,
      })),
      [
        { prompt: "First", configDir: "/claude/first", sourceToken: "first" },
        {
          prompt: "Second",
          configDir: "/claude/second",
          sourceToken: "second",
        },
      ],
    );
    assertEquals(Deno.env.get("CLAUDE_CONFIG_DIR"), "/sentinel");
  } finally {
    release();
    if (previous === undefined) Deno.env.delete("CLAUDE_CONFIG_DIR");
    else Deno.env.set("CLAUDE_CONFIG_DIR", previous);
  }
});

Deno.test("Claude driver handles message, cursor, and live control edges", async () => {
  const active = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const query = Object.assign(
    (async function* () {
      active.resolve();
      await release.promise;
      yield { type: "result", subtype: "success", result: "done" };
    })(),
    {
      interrupt: () => {
        calls.push("interrupt");
        return Promise.resolve();
      },
      setPermissionMode: (mode: string) => {
        calls.push(`mode:${mode}`);
        return Promise.resolve();
      },
      setModel: (model: string) => {
        calls.push(`model:${model}`);
        return Promise.resolve();
      },
      close: () => calls.push("close"),
    },
  );
  const sdk = {
    listSessions: () =>
      Promise.resolve([{
        sessionId: "session",
        firstPrompt: "First prompt",
        cwd: "/tmp/project",
        createdAt: Number.NaN,
      }]),
    getSessionInfo: (id: string) =>
      Promise.resolve(
        id === "missing" ? undefined : { sessionId: id, cwd: "/tmp/project" },
      ),
    getSessionMessages: () =>
      Promise.resolve([{
        type: "future",
        uuid: "nested",
        message: { content: ["one", { text: "two" }, null] },
      }]),
    renameSession: () => Promise.resolve(),
    query: () => query,
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude:edges", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await assertRejects(
    () => driver.listSessions("invalid"),
    Error,
    "invalid Claude cursor",
  );
  const page = await driver.listSessions();
  assertEquals(page.sessions[0].title, "First prompt");
  assertEquals(page.sessions[0].createdAt, null);
  await assertRejects(
    () => driver.readSession("missing"),
    Error,
    "Claude session not found",
  );
  const snapshot = await driver.readSession("session");
  assertEquals(snapshot.normalizedMessages[0].role, "unknown");
  assertEquals(snapshot.normalizedMessages[0].textPreview, "one\ntwo");
  assertEquals((await driver.cancel("session")).status, "unsupported");
  assertEquals(
    (await driver.setMode("session", "missing")).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("session", "unknown", true)).status,
    "unsupported",
  );

  const prompt = driver.prompt("session", { text: "continue" });
  await active.promise;
  assertEquals((await driver.setMode("session", "plan")).status, "succeeded");
  assertEquals(
    (await driver.setConfigOption("session", "model", "claude-test")).status,
    "succeeded",
  );
  assertEquals((await driver.cancel("session")).status, "succeeded");
  release.resolve();
  assertEquals((await prompt).status, "succeeded");
  assertEquals(calls, [
    "mode:plan",
    "model:claude-test",
    "interrupt",
    "close",
  ]);
});

Deno.test("Claude prompt env excludes another source's temporary globals", async () => {
  const key = "CLAUDE_TEST_FIRST_SOURCE_ONLY";
  const previous = Deno.env.get(key);
  Deno.env.delete(key);
  let releaseInventory!: () => void;
  let markInventoryStarted!: () => void;
  const inventoryBlocked = new Promise<void>((resolve) =>
    releaseInventory = resolve
  );
  const inventoryStarted = new Promise<void>((resolve) =>
    markInventoryStarted = resolve
  );
  let promptEnv: Record<string, string> | undefined;
  const sdk = {
    listSessions: async () => {
      if (Deno.env.get(key) === "private-to-first") {
        markInventoryStarted();
        await inventoryBlocked;
        return [];
      }
      return [{
        sessionId: "session-2",
        summary: "Second",
        cwd: "/second",
        createdAt: 1_000,
        lastModified: 2_000,
      }];
    },
    query: (params: { options?: Record<string, unknown> }) => {
      promptEnv = params.options?.env as Record<string, string>;
      return fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]);
    },
  } as unknown as ClaudeSdkAdapter;
  const first = new ClaudeAgentSdkDriver({
    id: "claude-code:first",
    driver: "claude-agent-sdk",
    enabled: true,
    env: { [key]: "private-to-first" },
  }, sdk);
  const second = new ClaudeAgentSdkDriver({
    id: "claude-code:second",
    driver: "claude-agent-sdk",
    enabled: true,
  }, sdk);
  try {
    await second.listSessions();
    const inventory = first.listSessions();
    await inventoryStarted;
    assertEquals(Deno.env.get(key), "private-to-first");
    assertEquals(
      (await second.prompt("session-2", { text: "Second" })).status,
      "succeeded",
    );
    assertEquals(promptEnv?.[key], undefined);
    releaseInventory();
    await inventory;
  } finally {
    releaseInventory();
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
});

function sdkWithoutSessions(calls: Array<{ method: string; args: unknown[] }>) {
  return {
    listSessions: (options?: Record<string, unknown>) => {
      calls.push({ method: "listSessions", args: [options] });
      return Promise.resolve([]);
    },
    getSessionInfo: (id: string) => {
      calls.push({ method: "getSessionInfo", args: [id] });
      return Promise.resolve(undefined);
    },
    getSessionMessages: () => Promise.resolve([]),
    renameSession: (id: string, title: string) => {
      calls.push({ method: "renameSession", args: [id, title] });
      return Promise.resolve();
    },
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      calls.push({ method: "query", args: [params] });
      return fakeQuery([
        { type: "system", subtype: "init", session_id: "ignored" },
        { type: "result", subtype: "success" },
      ]);
    },
  };
}

const NEW_SESSION_ID = "6f1a3c0e-9d2b-4c7a-8e5f-0123456789ab";

Deno.test("Claude driver lists the source directory's sessions when `cwd` is configured", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const scoped = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdkWithoutSessions(calls),
  );
  await scoped.listSessions();
  assertEquals(calls, [{
    method: "listSessions",
    args: [{ limit: 100, offset: 0, dir: "/work/labs" }],
  }]);

  calls.length = 0;
  const unscoped = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdkWithoutSessions(calls),
  );
  await unscoped.listSessions();
  assertEquals(calls, [{
    method: "listSessions",
    args: [{ limit: 100, offset: 0 }],
  }]);
});

Deno.test("Claude driver starts a session under a caller-chosen id in its source's directory, titled through the query", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const events: string[] = [];
  const sdk = {
    ...sdkWithoutSessions(calls),
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      calls.push({ method: "query", args: [params] });
      const generator = (async function* () {
        events.push("yield:init");
        yield { type: "system", subtype: "init", session_id: NEW_SESSION_ID };
        events.push("yield:result");
        yield { type: "result", subtype: "success" };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  };
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdk,
  );

  // The source's own directory, spelled with a trailing separator: the same
  // place once resolved.
  const outcome = await driver.startSession(NEW_SESSION_ID, {
    text: "Work on topic #7",
    cwd: "/work/labs/",
    title: "topic #7: the workbench",
  }, {
    onSessionActive: () => {
      events.push("active");
      return Promise.resolve();
    },
  });
  assertEquals(outcome.status, "succeeded");
  assertEquals(outcome.result, {
    nativeSessionId: NEW_SESSION_ID,
    cwd: "/work/labs",
    title: "topic #7: the workbench",
  });
  // The session is refreshed only once the SDK has emitted for it.
  assertEquals(events, ["yield:init", "active", "yield:result"]);
  const query = calls.find((call) => call.method === "query")?.args[0] as {
    prompt: string;
    options: Record<string, unknown>;
  };
  assertEquals(query.prompt, "Work on topic #7");
  assertEquals(query.options.sessionId, NEW_SESSION_ID);
  assertEquals(query.options.cwd, "/work/labs");
  assertEquals(query.options.title, "topic #7: the workbench");
  assertEquals(query.options.resume, undefined);
  // The SDK titles the session from its first message; nothing renames it.
  assertEquals(calls.some((call) => call.method === "renameSession"), false);

  // A prompt that follows resumes in the started directory without a lookup.
  calls.length = 0;
  const followUp = await driver.prompt(NEW_SESSION_ID, { text: "Continue" });
  assertEquals(followUp.status, "succeeded");
  assertEquals(calls.map((call) => call.method), ["query"]);
  const resumed = calls[0].args[0] as { options: Record<string, unknown> };
  assertEquals(resumed.options.resume, NEW_SESSION_ID);
  assertEquals(resumed.options.cwd, "/work/labs");
});

Deno.test("Claude driver starts an unscoped source's session in the directory the start names, made absolute", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdkWithoutSessions(calls),
  );
  const outcome = await driver.startSession(NEW_SESSION_ID, {
    text: "Hi",
    cwd: "relative/checkout",
  });
  assertEquals(outcome.status, "succeeded");
  const query = calls.find((call) => call.method === "query")?.args[0] as {
    options: Record<string, unknown>;
  };
  assertEquals(isAbsolute(String(query.options.cwd)), true);
  assertEquals(query.options.cwd, resolve("relative/checkout"));
  assertEquals(outcome.result?.cwd, resolve("relative/checkout"));
});

Deno.test("Claude driver refuses a start it cannot begin: a stopped driver, a failed lookup, a cancellation during the lookup", async () => {
  const source = {
    id: "claude-code:labs",
    driver: "claude-agent-sdk" as const,
    enabled: true,
    cwd: "/work/labs",
  };

  // A stopped driver refuses before touching the SDK.
  const stoppedCalls: Array<{ method: string; args: unknown[] }> = [];
  const stopped = new ClaudeAgentSdkDriver(
    source,
    sdkWithoutSessions(stoppedCalls),
  );
  await stopped.stop();
  assertEquals(
    (await stopped.startSession(NEW_SESSION_ID, { text: "Hi" })).error?.code,
    "claude-driver-stopped",
  );
  assertEquals(stoppedCalls, []);

  // A lookup the SDK cannot answer fails the start, retryably.
  const unanswered = new ClaudeAgentSdkDriver(source, {
    ...sdkWithoutSessions([]),
    getSessionInfo: () => Promise.reject(new Error("metadata unavailable")),
  });
  const lookupFailed = await unanswered.startSession(NEW_SESSION_ID, {
    text: "Hi",
  });
  assertEquals(lookupFailed.error?.code, "claude-session-lookup-failed");
  assertEquals(lookupFailed.error?.retryable, true);

  // A cancellation admitted during the lookup wins over the lookup's
  // answer, whether it resolves or rejects.
  for (const lookupRejects of [false, true]) {
    let releaseLookup!: () => void;
    const lookupBlocked = new Promise<void>((resolve) =>
      releaseLookup = resolve
    );
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) =>
      markLookupStarted = resolve
    );
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const driver = new ClaudeAgentSdkDriver(source, {
      ...sdkWithoutSessions(calls),
      getSessionInfo: async () => {
        markLookupStarted();
        await lookupBlocked;
        if (lookupRejects) throw new Error("metadata unavailable");
        return undefined;
      },
    });
    try {
      const start = driver.startSession(NEW_SESSION_ID, { text: "Hi" });
      await lookupStarted;
      assertEquals((await driver.cancel(NEW_SESSION_ID)).status, "succeeded");
      releaseLookup();
      const outcome = await start;
      assertEquals(outcome.status, "failed", String(lookupRejects));
      assertEquals(outcome.error?.code, "cancelled", String(lookupRejects));
      assertEquals(calls.some((call) => call.method === "query"), false);
    } finally {
      releaseLookup();
    }
  }
});

Deno.test("Claude driver refuses to start a session that already exists", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sdk = {
    ...sdkWithoutSessions(calls),
    getSessionInfo: (id: string) => {
      calls.push({ method: "getSessionInfo", args: [id] });
      return Promise.resolve({
        sessionId: id,
        summary: "Existing",
        cwd: "/work/labs",
        lastModified: 1_000,
      });
    },
  };
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdk,
  );
  const outcome = await driver.startSession(NEW_SESSION_ID, { text: "Hi" });
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.error?.code, "claude-session-exists");
  assertEquals(calls.map((call) => call.method), ["getSessionInfo"]);
});

Deno.test("Claude driver refuses a start whose id or directory is unusable", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const scoped = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdkWithoutSessions(calls),
  );
  assertEquals(
    (await scoped.startSession("not-a-uuid", { text: "Hi" })).error?.code,
    "claude-session-id-invalid",
  );
  // A start runs in the source's directory, so any other directory is
  // refused: another checkout, a sibling that shares the prefix, a
  // subdirectory the SDK would list as a project of its own, a relative path.
  for (
    const cwd of [
      "/work/other",
      "/work/labs-sibling",
      "/work/labs/packages/patterns",
      "labs",
    ]
  ) {
    assertEquals(
      (await scoped.startSession(NEW_SESSION_ID, { text: "Hi", cwd })).error
        ?.code,
      "claude-start-cwd-not-source",
      cwd,
    );
  }
  const unscoped = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdkWithoutSessions(calls),
  );
  assertEquals(
    (await unscoped.startSession(NEW_SESSION_ID, { text: "Hi" })).error?.code,
    "claude-start-cwd-required",
  );
  assertEquals(calls, []);
});

Deno.test("Claude driver applies a start's mode to the first turn, drops it when the start fails, and refuses one it does not advertise", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdkWithoutSessions(calls),
  );
  assertEquals(
    (await driver.startSession(NEW_SESSION_ID, {
      text: "Hi",
      mode: "bypassPermissions",
    })).status,
    "unsupported",
  );
  assertEquals(calls.map((call) => call.method), []);

  const outcome = await driver.startSession(NEW_SESSION_ID, {
    text: "Hi",
    mode: "acceptEdits",
  });
  assertEquals(outcome.status, "succeeded");
  const query = calls.find((call) => call.method === "query")?.args[0] as {
    options: Record<string, unknown>;
  };
  assertEquals(query.options.permissionMode, "acceptEdits");
  assertEquals(query.options.allowDangerouslySkipPermissions, undefined);

  // A start that fails keeps no mode, so a retry under the same id without
  // one runs in the driver's default mode.
  const retries: Array<{ method: string; args: unknown[] }> = [];
  let queries = 0;
  const flaky = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    {
      ...sdkWithoutSessions(retries),
      query: (
        params: { prompt: string; options?: Record<string, unknown> },
      ) => {
        retries.push({ method: "query", args: [params] });
        queries++;
        return queries === 1
          ? fakeQuery([{ type: "result", subtype: "error_during_execution" }])
          : fakeQuery([
            { type: "system", subtype: "init", session_id: NEW_SESSION_ID },
            { type: "result", subtype: "success" },
          ]);
      },
    },
  );
  assertEquals(
    (await flaky.startSession(NEW_SESSION_ID, { text: "Hi", mode: "plan" }))
      .status,
    "failed",
  );
  assertEquals(
    (await flaky.startSession(NEW_SESSION_ID, { text: "Hi" })).status,
    "succeeded",
  );
  const retried = retries.filter((call) => call.method === "query").at(-1)
    ?.args[0] as { options: Record<string, unknown> };
  assertEquals(retried.options.permissionMode, undefined);

  // An SDK that throws while constructing the query fails the start the
  // same way, and the mode is dropped the same way.
  const throwing: Array<{ method: string; args: unknown[] }> = [];
  let constructions = 0;
  const brittle = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    {
      ...sdkWithoutSessions(throwing),
      query: (
        params: { prompt: string; options?: Record<string, unknown> },
      ) => {
        throwing.push({ method: "query", args: [params] });
        constructions++;
        if (constructions === 1) throw new Error("no claude binary");
        return fakeQuery([
          { type: "system", subtype: "init", session_id: NEW_SESSION_ID },
          { type: "result", subtype: "success" },
        ]);
      },
    },
  );
  // A mode set before the start is what a failed start restores.
  assertEquals(
    (await brittle.setMode(NEW_SESSION_ID, "plan")).status,
    "succeeded",
  );
  const thrown = await brittle.startSession(NEW_SESSION_ID, {
    text: "Hi",
    mode: "acceptEdits",
  });
  assertEquals(thrown.status, "failed");
  assertEquals(thrown.error?.code, "claude-query-failed");
  assertEquals(
    (await brittle.startSession(NEW_SESSION_ID, { text: "Hi" })).status,
    "succeeded",
  );
  const afterThrow = throwing.filter((call) => call.method === "query").at(-1)
    ?.args[0] as { options: Record<string, unknown> };
  assertEquals(afterThrow.options.permissionMode, "plan");
});

Deno.test("Claude driver starts a session on the desktop: opens the app's link with the folder and the prompt, runs no query, and pairs the session the app makes", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const listed: Array<Record<string, unknown>> = [];
  const sdk = {
    ...sdkWithoutSessions(calls),
    listSessions: (options?: Record<string, unknown>) => {
      calls.push({ method: "listSessions", args: [options] });
      return Promise.resolve(listed as never);
    },
  };
  const opened: string[] = [];
  let now = 1_000_000;
  const desktop = {
    installed: () => Promise.resolve(true),
    openUrl: (url: string) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    isDirectory: () => Promise.resolve(true),
    os: "darwin",
    now: () => now,
  };
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdk,
    desktop,
  );
  assertEquals(driver.source.capabilities.surfaces, ["headless", "desktop"]);

  // Longer than the 200 characters the SDK lists of a first prompt, with
  // the cut landing on a space (the SDK trims the cut before its ellipsis).
  const text = "Work on topic #7\n\nContext: the topic's living document " +
    "begins: a topic filed on the local board so the topic workbench has " +
    "something to read, with links to the two pull requests it tracks " +
    "and the rig\n\nLinks:\n- labs #7383\n- labs #7384";
  // A session listed before the start is sent is never the one the app
  // makes for it, however well it fits; nor is one in another directory.
  const before = "00000000-0000-4000-8000-000000000000";
  const elsewhere = "00000000-0000-4000-8000-000000000001";
  const listedPrompt = text.replace(/\n/g, " ").slice(0, 200).trim() + "…";
  listed.push(
    {
      sessionId: before,
      summary: listedPrompt,
      firstPrompt: listedPrompt,
      cwd: "/work/labs",
      lastModified: now,
      createdAt: now,
    },
    {
      sessionId: elsewhere,
      summary: listedPrompt,
      firstPrompt: listedPrompt,
      cwd: "/work/other",
      lastModified: now,
      createdAt: now,
    },
  );
  assertEquals((await driver.listSessions()).sessions.length, 2);
  let readiness = 0;
  const outcome = await driver.startSession(NEW_SESSION_ID, {
    text,
    title: "topic #7: the workbench",
    surface: "desktop",
  }, { onCancellationReady: () => readiness++ });
  assertEquals(outcome.status, "succeeded");
  // Nothing runs here for a desktop start, so no readiness is signalled.
  assertEquals(readiness, 0);
  // No session exists yet, so there is nothing for the worker to refresh.
  assertEquals(outcome.affectedSession, null);
  assertEquals(outcome.result, {
    nativeSessionId: NEW_SESSION_ID,
    cwd: "/work/labs",
    title: "topic #7: the workbench",
    surface: "desktop",
  });
  assertEquals(calls.some((call) => call.method === "query"), false);
  assertEquals(opened.length, 1);
  const link = new URL(opened[0]);
  assertEquals(link.protocol, "claude:");
  assertEquals(link.host, "code");
  assertEquals(link.pathname, "/new");
  assertEquals(link.searchParams.get("folder"), "/work/labs");
  assertEquals(link.searchParams.get("q"), text);

  // Until the person sends the prompt, nothing pairs: the sessions listed
  // before the start stay unpaired.
  assertEquals(
    (await driver.listSessions()).sessions.map((s) => s.startedAs),
    [undefined, undefined],
  );

  // Nor does a session first listed after the start that is in another
  // directory, or one created well before the start was sent.
  const otherDir = "00000000-0000-4000-8000-000000000002";
  const tooEarly = "00000000-0000-4000-8000-000000000003";
  listed.push(
    {
      sessionId: otherDir,
      summary: listedPrompt,
      firstPrompt: listedPrompt,
      cwd: "/work/other",
      lastModified: now,
      createdAt: now,
    },
    {
      sessionId: tooEarly,
      summary: listedPrompt,
      firstPrompt: listedPrompt,
      cwd: "/work/labs",
      lastModified: now,
      createdAt: now - 60_000,
    },
  );
  assertEquals(
    (await driver.listSessions()).sessions.map((s) => s.startedAs),
    [undefined, undefined, undefined, undefined],
  );

  // The app makes the session: the start's directory, after the start,
  // opening with the start's text. The SDK lists the first prompt with its
  // newlines as spaces, cut to 200 characters, trimmed, and marked with an
  // ellipsis that is no part of the prompt (@anthropic-ai/claude-agent-sdk
  // 0.3.206). Another session made meanwhile stays what it is.
  now += 30_000;
  const made = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  assertEquals(text.replace(/\n/g, " ")[199], " ");
  assertEquals(listedPrompt.length, 200);
  listed.push(
    {
      sessionId: made,
      summary: listedPrompt,
      firstPrompt: listedPrompt,
      cwd: "/work/labs",
      lastModified: now,
      createdAt: now,
    },
    {
      sessionId: other,
      summary: "Something else",
      firstPrompt: "Something else",
      cwd: "/work/labs",
      lastModified: now,
      createdAt: now,
    },
  );
  const page = await driver.listSessions();
  const paired = page.sessions.find((s) => s.nativeSessionId === made);
  assertEquals(paired?.startedAs, NEW_SESSION_ID);
  assertEquals(paired?.title, "topic #7: the workbench");
  const unrelated = page.sessions.find((s) => s.nativeSessionId === other);
  assertEquals(unrelated?.startedAs, undefined);
  assertEquals(unrelated?.title, "Something else");

  // The pairing holds on later listings and reads; a title the person gives
  // the session wins over the start's.
  const madeAt = listed.findIndex((s) => s.sessionId === made);
  listed[madeAt] = { ...listed[madeAt], customTitle: "my own title" };
  const again = (await driver.listSessions()).sessions.find((s) =>
    s.nativeSessionId === made
  );
  assertEquals(again?.startedAs, NEW_SESSION_ID);
  assertEquals(again?.title, "my own title");

  // The same start sent again (the person closed the app's New session UI,
  // or declined its folder, and clicked Start once more): the session the
  // app then makes pairs with the newest start, not the earlier one the
  // workbench may have withdrawn since.
  now += 60_000;
  const earlier = "44444444-4444-4444-8444-444444444444";
  const latest = "55555555-5555-4555-8555-555555555555";
  assertEquals(
    (await driver.startSession(earlier, {
      text,
      surface: "desktop",
      title: "topic #7: the workbench",
    })).status,
    "succeeded",
  );
  now += 30_000;
  assertEquals(
    (await driver.startSession(latest, {
      text,
      surface: "desktop",
      title: "topic #7: the workbench",
    })).status,
    "succeeded",
  );
  now += 30_000;
  const resent = "66666666-6666-4666-8666-666666666666";
  listed.push({
    sessionId: resent,
    summary: listedPrompt,
    firstPrompt: listedPrompt,
    cwd: "/work/labs",
    lastModified: now,
    createdAt: now,
  });
  const afterResend = (await driver.listSessions()).sessions.find((s) =>
    s.nativeSessionId === resent
  );
  assertEquals(afterResend?.startedAs, latest);

  // Two pending starts whose texts share the prefix the SDK lists but differ
  // after it: a session opening with that prefix could be either, so it
  // stays unpaired rather than go to the wrong one.
  now += 60_000;
  const alpha = "77777777-7777-4777-8777-777777777777";
  const beta = "88888888-8888-4888-8888-888888888888";
  const sameHead = text.replace(/\n/g, " ").slice(0, 200);
  for (const [id, tail] of [[alpha, " alpha"], [beta, " beta"]]) {
    assertEquals(
      (await driver.startSession(id, {
        text: sameHead + tail,
        surface: "desktop",
      })).status,
      "succeeded",
    );
    now += 1_000;
  }
  const ambiguous = "99999999-9999-4999-8999-999999999999";
  listed.push({
    sessionId: ambiguous,
    summary: listedPrompt,
    firstPrompt: listedPrompt,
    cwd: "/work/labs",
    lastModified: now,
    createdAt: now,
  });
  const unpaired = (await driver.listSessions()).sessions.find((s) =>
    s.nativeSessionId === ambiguous
  );
  assertEquals(unpaired?.startedAs, undefined);

  // A start the person never sends is forgotten after a day: a matching
  // session made later is not paired with it.
  const stale = "3f1a3c0e-9d2b-4c7a-8e5f-0123456789ab";
  assertEquals(
    (await driver.startSession(stale, { text: "Later", surface: "desktop" }))
      .status,
    "succeeded",
  );
  now += 25 * 60 * 60 * 1000;
  listed.push({
    sessionId: "33333333-3333-4333-8333-333333333333",
    summary: "Later",
    firstPrompt: "Later",
    cwd: "/work/labs",
    lastModified: now,
    createdAt: now,
  });
  const late = (await driver.listSessions()).sessions.find((s) =>
    s.nativeSessionId === "33333333-3333-4333-8333-333333333333"
  );
  assertEquals(late?.startedAs, undefined);
});

Deno.test("Claude driver refuses a desktop start it cannot make: off macOS, with a mode, a prompt the app would cut, a folder that is not a directory, an app that is not installed, a link the app did not open, or a surface it does not offer", async () => {
  const ok = {
    installed: () => Promise.resolve(true),
    openUrl: () => Promise.resolve(true),
    isDirectory: () => Promise.resolve(true),
    os: "darwin",
    now: () => 0,
  };
  const make = (desktop: typeof ok) =>
    new ClaudeAgentSdkDriver(
      {
        id: "claude-code:labs",
        driver: "claude-agent-sdk",
        enabled: true,
        cwd: "/work/labs",
      },
      sdkWithoutSessions([]),
      desktop,
    );
  const linux = make({ ...ok, os: "linux" });
  assertEquals(linux.source.capabilities.surfaces, ["headless"]);
  assertEquals(
    (await linux.startSession(NEW_SESSION_ID, {
      text: "Hi",
      surface: "desktop",
    }))
      .status,
    "unsupported",
  );
  assertEquals(
    (await make(ok).startSession(NEW_SESSION_ID, {
      text: "Hi",
      surface: "desktop",
      mode: "acceptEdits",
    })).error?.code,
    "claude-desktop-mode-unsupported",
  );
  assertEquals(
    (await make(ok).startSession(NEW_SESSION_ID, {
      text: "x".repeat(14337),
      surface: "desktop",
    })).error?.code,
    "claude-desktop-prompt-too-long",
  );
  assertEquals(
    (await make({ ...ok, isDirectory: () => Promise.resolve(false) })
      .startSession(NEW_SESSION_ID, { text: "Hi", surface: "desktop" })).error
      ?.code,
    "claude-desktop-cwd-not-directory",
  );
  assertEquals(
    (await make({ ...ok, installed: () => Promise.resolve(false) })
      .startSession(NEW_SESSION_ID, { text: "Hi", surface: "desktop" })).error
      ?.code,
    "claude-desktop-not-installed",
  );
  assertEquals(
    (await make({ ...ok, openUrl: () => Promise.resolve(false) })
      .startSession(NEW_SESSION_ID, { text: "Hi", surface: "desktop" })).error
      ?.code,
    "claude-desktop-open-failed",
  );
  assertEquals(
    (await make(ok).startSession(NEW_SESSION_ID, {
      text: "Hi",
      surface: "browser",
    })).status,
    "unsupported",
  );
});

Deno.test("the desktop helpers answer false for an app that is not there, a folder that is not a directory, and an opener that is missing or refuses, without opening anything", async () => {
  assertEquals(await desktopAppInstalled("/nonexistent/Claude.app"), false);
  assertEquals(await desktopAppInstalled(Deno.cwd()), true);
  assertEquals(await directoryExists(Deno.cwd()), true);
  assertEquals(await directoryExists("/nonexistent/folder"), false);
  assertEquals(await directoryExists(import.meta.filename ?? ""), false);
  assertEquals(
    await openWithCommand("/nonexistent/opener", "claude://code/new"),
    false,
  );
  assertEquals(await openWithCommand("false", "claude://code/new"), false);
  assertEquals(await openWithCommand("true", "claude://code/new"), true);
});
