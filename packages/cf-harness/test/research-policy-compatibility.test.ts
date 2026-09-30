import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { parseCfHarnessCliArgs } from "../src/cli.ts";
import {
  createHarnessChatSessionStatus,
  type HarnessChatPolicy,
} from "../src/contracts/interactive-chat.ts";
import { HarnessInteractiveChatService } from "../src/interactive-chat-service.ts";
import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { HarnessChatSessionStore } from "../src/session-store.ts";

const nextIsoNow = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-09-14T00:00:${String(counter).padStart(2, "0")}.000Z`;
  };
};

const completedResult = (
  options: RunHarnessTranscriptOptions,
): HarnessPromptLoopResult => ({
  model: options.model ?? "gpt-test",
  finalAssistantText: "Done.",
  transcript: [...options.transcript, { role: "assistant", content: "Done." }],
  modelTurns: 1,
  runState: {} as HarnessPromptLoopResult["runState"],
});

describe("research policy compatibility", () => {
  it("maps the legacy CLI allowance to the canonical research tool", async () => {
    const parsed = await parseCfHarnessCliArgs(
      ["--allow-tool", "query_docs", "Ask"],
      { cwd: "/tmp/project", env: {} },
    );

    expect("help" in parsed).toBe(false);
    if ("help" in parsed) throw new Error("expected config result");
    expect(parsed.allowedToolIds).toEqual(["research"]);
  });

  it("uses a persisted query_docs allowance as research on follow-up without rewriting stored evidence", async () => {
    const legacyPolicy = {
      type: "cf-harness.chat-policy",
      toolMode: "workspace-write",
      allowedToolIds: ["query_docs"],
      allowedSubagentProfiles: [],
    } as unknown as HarnessChatPolicy;
    const snapshot = {
      session: createHarnessChatSessionStatus({
        sessionId: "legacy-research-session",
        createdAt: "2026-09-14T00:00:00.000Z",
        workspace: { hostPath: "/workspace" },
        policy: legacyPolicy,
      }),
      transcript: [{ role: "user" as const, content: "Earlier turn" }],
    };
    const storedPolicy = JSON.stringify(snapshot.session.policy);
    const storedTranscript = JSON.stringify(snapshot.transcript);
    const store: HarnessChatSessionStore = {
      saveSession: () => {},
      getSession: () => undefined,
      listSessions: () => [snapshot],
      saveSessionAndAppendEvent: () => {},
      saveSessionTurnAndAppendEvent: () => true,
      appendEvent: () => {},
      listEvents: () => [],
      latestSequence: () => 0,
      saveTurn: () => {},
      getTurn: () => undefined,
      listTurns: () => [],
    };
    const loopOptions: CreateHarnessPromptLoopOptions[] = [];
    const service = new HarnessInteractiveChatService({
      createPromptLoop: (options) => {
        loopOptions.push(options);
        return {
          runTranscript: (runOptions) =>
            Promise.resolve(completedResult(runOptions)),
        };
      },
      now: nextIsoNow(),
      sessionStore: store,
    });
    await service.initializeFromStore();

    const started = await service.startTurn("req-legacy-research", {
      sessionId: snapshot.session.sessionId,
      turnId: "follow-up",
      input: { text: "Continue" },
    });
    expect(started.ok).toBe(true);
    await service.waitForTurn(snapshot.session.sessionId, "follow-up");

    expect(loopOptions[0].allowedToolIds).toEqual(["research"]);
    expect(JSON.stringify(snapshot.session.policy)).toBe(storedPolicy);
    expect(JSON.stringify(snapshot.transcript)).toBe(storedTranscript);
  });
});
