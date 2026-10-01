import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";

import type { HarnessClientActionRequester } from "../src/contracts/client-action.ts";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  type HarnessChatEventEnvelope,
  type HarnessChatRequestEnvelope,
} from "../src/contracts/interactive-chat.ts";
import {
  parentToolIdsForBacking,
  withheldToolIds,
} from "../src/contracts/tool-descriptor.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { SUPPORTED_POLICY_TOOL_IDS } from "../src/interactive-chat-stdio.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { weaverActionTool } from "../src/tools/weaver-action.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";

const LOOM = "loom-0123456789abcdef";
const open = { kind: "open_loom", loomId: LOOM } as const;
const command = { kind: "command", line: "/weave notes" } as const;
const url = { kind: "open_url", url: "https://example.com/a" } as const;

/** A host loop that calls the real tool, through the service's door. */
const harness = (
  options: { idleMs?: number; calls?: unknown[] } = {},
) => {
  const events: HarnessChatEventEnvelope[] = [];
  const toolResults: unknown[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const loopOptions: Record<string, unknown>[] = [];
  let ids = 0;
  const createPromptLoop: HarnessInteractivePromptLoopFactory = (opts) => {
    loopOptions.push(opts as unknown as Record<string, unknown>);
    return {
      runTranscript: async (run) => {
        const requestClientActions = (opts as {
          requestClientActions?: HarnessClientActionRequester;
        }).requestClientActions;
        const context = {
          nextOutputId: () => "out-1",
          signal: run.signal,
          requestClientActions,
        } as unknown as HarnessToolContext;
        started.resolve();
        for (const input of options.calls ?? [{ actions: [open] }]) {
          toolResults.push(
            await weaverActionTool.invoke(context, input as never),
          );
        }
        await release.promise;
        return {
          model: "m",
          finalAssistantText: "done",
          transcript: [...run.transcript, {
            role: "assistant" as const,
            content: "done",
          }],
        } as never;
      },
    };
  };
  const service = new HarnessInteractiveChatService({
    createPromptLoop,
    randomUUID: () => `id-${++ids}`,
    onEvent: (event) => void events.push(event),
    ...(options.idleMs !== undefined
      ? { clientActionIdleTimeoutMs: options.idleMs }
      : {}),
  });
  const request = <M extends HarnessChatRequestEnvelope["method"]>(
    method: M,
    params: Extract<HarnessChatRequestEnvelope, { method: M }>["params"],
  ) =>
    service.handleRequest({
      type: HARNESS_CHAT_REQUEST_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      requestId: "r",
      method,
      params,
    } as HarnessChatRequestEnvelope);
  const start = async (clientActions = true) => {
    await request("start_session", {
      sessionId: "s",
      workspace: { hostPath: "/w" },
      model: "m",
      ...(clientActions ? { clientActions } : {}),
    });
    await request("start_turn", {
      sessionId: "s",
      turnId: "t",
      input: { text: "go" },
    });
    await started.promise;
  };
  const kinds = (kind: string) =>
    events.map((e) => e.event).filter((e) => e.kind === kind) as Record<
      string,
      unknown
    >[];
  return {
    service,
    request,
    start,
    kinds,
    toolResults,
    release,
    loopOptions,
    events,
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("weaver_action emits a request per action in order and returns outcomes in input order", async () => {
  const h = harness({ calls: [{ actions: [open, command, url] }] });
  await h.start();
  await settle();
  const requested = h.kinds("client_action_requested");
  assertEquals(requested.map((e) => e.action), [open, command, url]);
  assertEquals(requested.map((e) => e.actionId), ["id-1", "id-2", "id-3"]);
  assertEquals(requested.every((e) => e.turnId === "t"), true);
  assertEquals(h.toolResults.length, 0);

  // Answer out of order: the outcomes still come back in input order.
  for (
    const [actionId, outcome, result] of [
      ["id-3", "declined", undefined],
      ["id-1", "done", "opened"],
      ["id-2", "failed", "no such command"],
    ] as const
  ) {
    const response = await h.request("resolve_client_action", {
      sessionId: "s",
      actionId,
      outcome,
      ...(result !== undefined ? { result } : {}),
    });
    assertEquals(response.ok, true);
  }
  await settle();
  assertEquals(h.toolResults, [{
    outputId: "out-1",
    status: "ok",
    outcomes: [
      { action: open, outcome: "done", result: "opened" },
      { action: command, outcome: "failed", result: "no such command" },
      { action: url, outcome: "declined" },
    ],
  }]);
  const resolved = h.kinds("client_action_resolved");
  assertEquals(resolved.map((e) => [e.actionId, e.outcome]), [
    ["id-3", "declined"],
    ["id-1", "done"],
    ["id-2", "failed"],
  ]);
  h.release.resolve();
  await h.service.waitForIdle();
});

Deno.test("resolve_client_action names unknown, repeated, and malformed answers", async () => {
  const h = harness();
  await h.start();
  await settle();
  const unknown = await h.request("resolve_client_action", {
    sessionId: "s",
    actionId: "nope",
    outcome: "done",
  });
  assertEquals(unknown.ok === false && unknown.error.code, "unknown_action");
  const bad = await h.request("resolve_client_action", {
    sessionId: "s",
    actionId: "id-1",
    outcome: "maybe" as never,
  });
  assertEquals(bad.ok === false && bad.error.code, "invalid_request");
  const long = await h.request("resolve_client_action", {
    sessionId: "s",
    actionId: "id-1",
    outcome: "done",
    result: "x".repeat(501),
  });
  assertEquals(long.ok === false && long.error.code, "invalid_request");
  assertEquals(
    (await h.request("resolve_client_action", {
      sessionId: "s",
      actionId: "id-1",
      outcome: "done",
    })).ok,
    true,
  );
  const again = await h.request("resolve_client_action", {
    sessionId: "s",
    actionId: "id-1",
    outcome: "declined",
  });
  assertEquals(again.ok === false && again.error.code, "action_resolved");
  h.release.resolve();
  await h.service.waitForIdle();
});

Deno.test("an idle call fails every unsettled action as timeout, and each settlement resets the clock", async () => {
  const h = harness({ idleMs: 60, calls: [{ actions: [open, command] }] });
  await h.start();
  await settle();
  // Settle one just before the first deadline; the second must get a fresh
  // full window rather than the remainder of the first.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await h.request("resolve_client_action", {
    sessionId: "s",
    actionId: "id-1",
    outcome: "done",
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assertEquals(h.toolResults.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assertEquals(h.toolResults, [{
    outputId: "out-1",
    status: "ok",
    outcomes: [
      { action: open, outcome: "done" },
      { action: command, outcome: "failed", result: "timeout" },
    ],
  }]);
  assertEquals(
    h.kinds("client_action_resolved").map((
      e,
    ) => [e.actionId, e.outcome, e.result]),
    [["id-1", "done", undefined], ["id-2", "failed", "timeout"]],
  );
  const late = await h.request("resolve_client_action", {
    sessionId: "s",
    actionId: "id-2",
    outcome: "done",
  });
  assertEquals(late.ok === false && late.error.code, "action_resolved");
  h.release.resolve();
  await h.service.waitForIdle();
});

Deno.test("canceling the turn declines every pending action as canceled, with a resolved event each", async () => {
  const h = harness({ calls: [{ actions: [open, command] }] });
  await h.start();
  await settle();
  await h.request("cancel_turn", { sessionId: "s", turnId: "t" });
  await settle();
  assertEquals(h.toolResults, [{
    outputId: "out-1",
    status: "ok",
    outcomes: [
      { action: open, outcome: "declined", result: "canceled" },
      { action: command, outcome: "declined", result: "canceled" },
    ],
  }]);
  const resolved = h.kinds("client_action_resolved");
  assertEquals(resolved.map((e) => [e.outcome, e.result]), [
    ["declined", "canceled"],
    ["declined", "canceled"],
  ]);
  // The resolved events precede the turn's own cancel event.
  const order = h.events.map((e) => e.event.kind);
  expect(order.lastIndexOf("client_action_resolved")).toBeLessThan(
    order.indexOf("turn_canceled"),
  );
  h.release.resolve();
  await h.service.waitForIdle();
});

Deno.test("closing the session settles pending actions the same way", async () => {
  const h = harness();
  await h.start();
  await settle();
  await h.request("close_session", { sessionId: "s" });
  await settle();
  assertEquals(h.kinds("client_action_resolved").map((e) => e.result), [
    "canceled",
  ]);
  h.release.resolve();
  await h.service.waitForIdle();
});

Deno.test("invalid input emits nothing and a session that did not opt in has no door", async () => {
  const h = harness({
    calls: [{ actions: [] }, {
      actions: [{ kind: "open_url", url: "ftp://x" }],
    }],
  });
  await h.start();
  await settle();
  assertEquals(h.kinds("client_action_requested"), []);
  assertEquals(
    h.toolResults.map((r) => (r as { status: string }).status),
    ["error", "error"],
  );
  h.release.resolve();
  await h.service.waitForIdle();

  const off = harness();
  await off.start(false);
  await settle();
  assertEquals(
    "requestClientActions" in off.loopOptions[0],
    false,
  );
  assertEquals(
    (off.toolResults[0] as { status: string }).status,
    "error",
  );
  off.release.resolve();
  await off.service.waitForIdle();
});

Deno.test("a turn can opt its session in, and the tool joins that turn's allowlist", async () => {
  const h = harness({ calls: [] });
  await h.request("start_session", {
    sessionId: "s",
    workspace: { hostPath: "/w" },
    model: "m",
  });
  await h.request("start_turn", {
    sessionId: "s",
    input: { text: "go" },
    clientActions: true,
  });
  await settle();
  assertEquals(
    (h.loopOptions[0].allowedToolIds as string[]).includes("weaver_action"),
    true,
  );
  assertEquals(typeof h.loopOptions[0].requestClientActions, "function");
  h.release.resolve();
  await h.service.waitForIdle();
});

const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "docker-runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  defaultWorkingDirectory: () => "/workspace",
  resolvePath: (path) => path,
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};

/** The tool names a one-turn run offers its model. */
const offeredTools = async (
  options: { optIn: boolean; subagent?: boolean },
): Promise<string[]> => {
  const requests: HarnessModelTurnRequest[] = [];
  const loop = new CfHarnessPromptLoop({
    engine: new CfHarnessEngine({
      sandboxRuntime: sandbox,
      runId: options.subagent ? "root.subagent.1" : "root",
      model: "gpt-test",
      ...(options.optIn
        ? { requestClientActions: () => Promise.resolve([]) }
        : {}),
      ...(options.subagent
        ? {
          lineage: {
            role: "subagent" as const,
            rootRunId: "root",
            parentRunId: "root",
            parentToolCallId: "delegate-child",
            depth: 1,
          },
        }
        : {}),
    }),
    modelClient: {
      providerId: "test-provider",
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({
          assistant: { role: "assistant", content: "ok" },
        });
      },
    },
    allowedToolIds: ["read_file", "finish_task", "weaver_action"],
  });
  await loop.runPrompt({ prompt: "hi" });
  return requests[0].tools.map((tool) => tool.toolId);
};

Deno.test("weaver_action is offered to a parent that opted in, never to one that did not or to a subagent", async () => {
  expect(await offeredTools({ optIn: true })).toContain("weaver_action");
  expect(await offeredTools({ optIn: false })).not.toContain("weaver_action");
  expect(await offeredTools({ optIn: true, subagent: true })).not.toContain(
    "weaver_action",
  );
});

Deno.test("weaver_action is gated by backing, absent from defaults, and nameable in a stdio policy", () => {
  const base = {
    fabricSessionAvailable: false,
    patternIndexAvailable: false,
    skillsShSearchAvailable: false,
    skillsShAcquisitionAvailable: false,
    skillRegistryAvailable: false,
    docsCorpusAvailable: false,
  };
  expect(withheldToolIds(base).has("weaver_action")).toBe(true);
  expect(parentToolIdsForBacking(base)).not.toContain("weaver_action");
  const backed = { ...base, clientActionsAvailable: true };
  expect(withheldToolIds(backed).has("weaver_action")).toBe(false);
  expect(parentToolIdsForBacking(backed)).toContain("weaver_action");
  expect(SUPPORTED_POLICY_TOOL_IDS.has("weaver_action")).toBe(true);
});
