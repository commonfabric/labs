import { assertEquals } from "@std/assert";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
} from "../src/contracts/interactive-chat.ts";
import {
  HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";

const nextIsoNow = () => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-08-28T00:00:${String(counter).padStart(2, "0")}.000Z`;
  };
};

/**
 * A loop that records the transcript it was handed and answers with it
 * extended by one assistant message, which is what the service persists as the
 * session's next durable checkpoint.
 */
const recordingLoop = (
  seen: HarnessTranscriptMessage[][],
): HarnessInteractivePromptLoopFactory =>
() => ({
  runTranscript: (options: RunHarnessTranscriptOptions) => {
    seen.push([...options.transcript]);
    const result: HarnessPromptLoopResult = {
      model: options.model ?? "gpt-test",
      finalAssistantText: "done",
      transcript: [
        ...options.transcript,
        { role: "assistant", content: "done" },
      ],
      modelTurns: 1,
    } as HarnessPromptLoopResult;
    return Promise.resolve(result);
  },
} as unknown as ReturnType<HarnessInteractivePromptLoopFactory>);

const runTurn = async (
  service: HarnessInteractiveChatService,
  turnId: string,
  text: string,
): Promise<void> => {
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: `req-${turnId}`,
    method: "start_turn",
    params: { sessionId: "session-1", turnId, input: { text } },
  });
  await service.waitForTurn("session-1", turnId);
};

const startSession = async (
  service: HarnessInteractiveChatService,
): Promise<void> => {
  await service.handleRequest({
    type: HARNESS_CHAT_REQUEST_TYPE,
    protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
    requestId: "req-session",
    method: "start_session",
    params: {
      sessionId: "session-1",
      workspace: { hostPath: "/workspace", cwd: "/workspace/project" },
      model: "gpt-test",
    },
  });
};

Deno.test("interactive chat service system prompt", async (t) => {
  await t.step(
    "seeds the configured system prompt as the first message of a turn",
    async () => {
      const seen: HarnessTranscriptMessage[][] = [];
      const service = new HarnessInteractiveChatService({
        createPromptLoop: recordingLoop(seen),
        now: nextIsoNow(),
        randomUUID: () => "generated-id",
        systemPrompt: "COMPOSE FIRST",
      });
      await startSession(service);
      await runTurn(service, "turn-1", "Hi");

      assertEquals(seen.length, 1);
      assertEquals(seen[0][0], { role: "system", content: "COMPOSE FIRST" });
      assertEquals(seen[0][1].role, "user");
    },
  );

  await t.step(
    "seeds nothing when no system prompt is configured",
    async () => {
      const seen: HarnessTranscriptMessage[][] = [];
      const service = new HarnessInteractiveChatService({
        createPromptLoop: recordingLoop(seen),
        now: nextIsoNow(),
        randomUUID: () => "generated-id",
      });
      await startSession(service);
      await runTurn(service, "turn-1", "Hi");

      assertEquals(seen[0].filter((message) => message.role === "system"), []);
    },
  );

  await t.step(
    "seeds once, so a second turn does not carry two system messages",
    async () => {
      const seen: HarnessTranscriptMessage[][] = [];
      const service = new HarnessInteractiveChatService({
        createPromptLoop: recordingLoop(seen),
        now: nextIsoNow(),
        randomUUID: () => "generated-id",
        systemPrompt: "COMPOSE FIRST",
      });
      await startSession(service);
      await runTurn(service, "turn-1", "Hi");
      await runTurn(service, "turn-2", "Again");

      assertEquals(seen.length, 2);
      assertEquals(
        seen[1].filter((message) => message.role === "system").length,
        1,
      );
    },
  );
});
