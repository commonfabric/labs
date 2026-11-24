/** Checks explicit CLI configuration and per-turn Loom context isolation. */

import {
  createLoomLocalCfHarnessHost,
  parseCfHarnessCliArgs,
  resolveConsoleConfig,
  runHarnessInteractiveChatStdioCli,
} from "./support/on-linux.ts";
import { InMemoryHarnessCredentialStore } from "../src/auth/credential-store.ts";
import { parseHarnessInteractiveChatStdioCliOptions } from "../src/interactive-chat-stdio.ts";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { HarnessInteractiveChatService } from "../src/interactive-chat-service.ts";
import type { CreateHarnessPromptLoopOptions } from "../src/prompt-loop.ts";
import { createHarnessRunState } from "../src/run-state.ts";
import { DEFAULT_HARNESS_CHAT_POLICY } from "../src/contracts/interactive-chat.ts";
import type { HarnessLoomAuthoringConfig } from "../src/loom-authoring.ts";

/** Host-owned direct routing, independent of a model turn id. */
const authoring: HarnessLoomAuthoringConfig = {
  cliPath: "/trusted/loom",
  transport: {
    kind: "direct",
    instanceDir: "/trusted/instance",
    runId: "owner-console",
    actor: "agent:cf-harness",
  },
};

describe("loom-authoring-session", () => {
  it("rejects invalid originating Loom identities before admitting a turn", async () => {
    const service = new HarnessInteractiveChatService();
    for (const loomId of [null, 4, "../other", "loom-not-an-id"]) {
      const result = await service.startTurn("invalid-origin", {
        sessionId: "not-yet-admitted",
        input: { text: "Collect", loomId: loomId as unknown as string },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
  });

  it("admits only dedicated Loom tools to comment threads when the host explicitly grants them", async () => {
    for (const allowCommentThreads of [false, true]) {
      const observed: CreateHarnessPromptLoopOptions[] = [];
      const service = new HarnessInteractiveChatService({
        basePromptLoopOptions: {
          loomAuthoring: { ...authoring, allowCommentThreads },
        },
        createPromptLoop: (options) => {
          observed.push(options);
          return {
            runTranscript: (request) =>
              Promise.resolve({
                model: "test",
                finalAssistantText: "Done",
                transcript: [...request.transcript, {
                  role: "assistant",
                  content: "Done",
                }],
                modelTurns: 1,
                runState: createHarnessRunState({
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                }),
              }),
          };
        },
      });
      await service.startSession("start", {
        sessionId: "comments",
        workspace: { hostPath: "/tmp" },
        context: { type: "comment-thread" },
        policy: {
          ...DEFAULT_HARNESS_CHAT_POLICY,
          allowedToolIds: [
            "bash",
            "write_file",
            "delegate_task",
            "loom_compose",
            "loom_inspect",
            "loom_authoring_context",
          ],
        },
      });
      const turn = await service.startTurn("turn", {
        sessionId: "comments",
        turnId: "turn",
        input: { text: "Make a Loom" },
      });
      expect(turn.ok).toBe(true);
      await service.waitForTurn("comments", "turn");
      const ids = observed[0].allowedToolIds;
      if (allowCommentThreads) expect(ids).toContain("loom_compose");
      else expect(ids).not.toContain("loom_compose");
      expect(ids).not.toContain("bash");
      expect(ids).not.toContain("write_file");
      expect(ids).not.toContain("delegate_task");
      expect(observed[0].allowedSubagentProfiles).toEqual([]);
    }
  });

  it("provisions authoring through both interactive executables and the host environment", async () => {
    const home = await Deno.makeTempDir();
    const path = home + "/authoring.json";
    try {
      await Deno.writeTextFile(path, JSON.stringify(authoring));
      const observed: unknown[] = [];
      await runHarnessInteractiveChatStdioCli(
        ["--loom-authoring-config", path],
        home,
        (options) => {
          observed.push(options.basePromptLoopOptions?.loomAuthoring);
          return Promise.resolve();
        },
      );
      for (const args of [["--loom-authoring-config=" + path], []]) {
        const host = await createLoomLocalCfHarnessHost({
          harnessHome: home,
          env: {
            CF_HARNESS_LOOM_AUTHORING_CONFIG: path,
            CF_HARNESS_GATEWAY_AUTH_MODE: "none",
          },
          credentialStore: new InMemoryHarnessCredentialStore(),
          providerSettingsStore: {
            inspect: () =>
              Promise.resolve({
                state: "configured",
                settings: {
                  version: 1,
                  modelProvider: "openai-compatible-gateway",
                },
              }),
          },
          interactiveStdioRunner: (options) => {
            observed.push(options.basePromptLoopOptions?.loomAuthoring);
            return Promise.resolve();
          },
        });
        await host.runInteractive(args);
      }
      expect(observed).toEqual([authoring, authoring, authoring]);
      expect(() =>
        parseHarnessInteractiveChatStdioCliOptions(
          ["--loom-authoring-config"],
          {},
        )
      ).toThrow();
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });

  it("loads the same explicit host configuration for CLI and console", async () => {
    const path = await Deno.makeTempFile();
    try {
      await Deno.writeTextFile(path, JSON.stringify(authoring));
      const cli = await parseCfHarnessCliArgs([
        "--loom-authoring-config",
        path,
        "Make a Loom",
      ], { env: {}, cwd: "/tmp" });
      if ("help" in cli) throw new Error("Expected CLI configuration");
      const consoleConfig = await resolveConsoleConfig([], {
        CF_HARNESS_LOOM_AUTHORING_CONFIG: path,
        CF_HARNESS_FABRIC_IDENTITY: "/trusted/key",
        CF_HARNESS_FABRIC_SPACE: "test-space",
      }, "/tmp");
      expect(cli.loomAuthoring).toEqual(authoring);
      expect(consoleConfig.loomAuthoring).toEqual(authoring);
    } finally {
      await Deno.remove(path);
    }
  });

  it("keeps authoring identity stable while clearing the previous turn's Loom target", async () => {
    const observed: CreateHarnessPromptLoopOptions[] = [];
    const service = new HarnessInteractiveChatService({
      basePromptLoopOptions: {
        loomAuthoring: { ...authoring, boundLoomId: "loom-3333333333333333" },
      },
      runIdForTurn: (_session, turn) => turn,
      createPromptLoop: (options) => {
        observed.push(options);
        return {
          runTranscript: (request) =>
            Promise.resolve({
              model: "test-model",
              finalAssistantText: "Done",
              transcript: [...request.transcript, {
                role: "assistant",
                content: "Done",
              }],
              modelTurns: 1,
              runState: createHarnessRunState({
                runId: options.runId,
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
              }),
            }),
        };
      },
    });
    const started = await service.startSession("start", {
      sessionId: "session-one",
      workspace: { hostPath: "/tmp" },
    });
    expect(started.ok).toBe(true);
    for (
      const [turnId, loomId] of [["turn-one", "loom-1111111111111111"], [
        "turn-two",
        undefined,
      ]] as const
    ) {
      const turn = await service.startTurn(turnId, {
        sessionId: "session-one",
        turnId,
        input: {
          text: "Continue",
          ...(loomId === undefined ? {} : { loomId }),
        },
      });
      expect(turn.ok).toBe(true);
      await service.waitForTurn("session-one", turnId);
    }
    expect(observed).toHaveLength(2);
    expect(observed[0].runId).not.toBe(observed[1].runId);
    expect(observed[0].loomAuthoring?.transport).toEqual(
      observed[1].loomAuthoring?.transport,
    );
    expect(observed[0].loomAuthoring?.boundLoomId).toBe(
      "loom-1111111111111111",
    );
    expect(observed[1].loomAuthoring?.boundLoomId).toBeUndefined();
    expect(service.turns("session-one")[0].input.loomId).toBe(
      "loom-1111111111111111",
    );
    expect(authoring.transport).toMatchObject({ runId: "owner-console" });
  });
});
