import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import {
  annotateHarnessUserResultOmissions,
  createHarnessTranscriptOmissions,
} from "../src/contracts/transcript-omissions.ts";
import { createHarnessRunState } from "../src/run-state.ts";
import { HarnessInteractiveChatService } from "../src/interactive-chat-service.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";
import { faultingToolLoop } from "./support/chat-fault-fixture.ts";
import { makeResult } from "./support/session-store-fixtures.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";

describe("Interactive budget checkpoints", () => {
  for (const completed of [1, 2]) {
    it(`restores only balanced research after ${completed} tool results and a provider failure`, async () => {
      const dir = await Deno.makeTempDir();
      let store = await openSqliteHarnessChatSessionStore({
        url: new URL(`file://${dir}/chat.sqlite3`),
      });
      try {
        const service = new HarnessInteractiveChatService({
          sessionStore: store,
          basePromptLoopOptions: { finalizeOnTurnLimit: true },
          createPromptLoop: (options) => {
            const loop = faultingToolLoop(completed, "error")(options);
            return {
              runTranscript: (request) =>
                loop.runTranscript({
                  ...request,
                  onCheckpoint: async (checkpoint) => {
                    const handoff = annotateHarnessUserResultOmissions({
                      role: "user",
                      content: "Observed private research",
                      toolResultProvenance: {
                        type: "cf-harness.tool-result-provenance",
                        toolCallId: "research-handoff",
                        toolId: "research",
                        outputId: createToolOutputId("research", "research", 1),
                      },
                    }, [{
                      rule: "artifact-only",
                      locations: [{
                        artifactPath: "/artifacts/private.json",
                        jsonPointer: "/researchRecord",
                      }],
                    }]);
                    await request.onCheckpoint?.({
                      transcript: [...checkpoint.transcript, handoff],
                      runState: createHarnessRunState({
                        currentDir: "/workspace",
                        cfcEnforcementMode: "enforce-explicit",
                        cfcModelContext: {
                          type: "cf-harness.cfc-model-context",
                          version: 1,
                          updatedAt: "2026-09-17T00:00:00Z",
                          label: { confidentiality: ["private-observation"] },
                          observations: [],
                        },
                      }),
                    });
                  },
                }),
            };
          },
        });
        await service.startSession("start", {
          sessionId: "research",
          workspace: { hostPath: "/workspace" },
        });
        await service.startTurn("turn", {
          sessionId: "research",
          turnId: "failed",
          input: { text: "Read sources" },
        });
        await service.waitForTurn("research", "failed");
        expect(
          service.listTurns({ sessionId: "research" }).turns[0].turn.status,
        ).toBe("failed");
        store.close();
        store = await openSqliteHarnessChatSessionStore({
          url: new URL(`file://${dir}/chat.sqlite3`),
        });
        let resumed: readonly HarnessTranscriptMessage[] = [];
        let confidentiality: readonly unknown[] = [];
        let restoredLoops = 0;
        const restored = new HarnessInteractiveChatService({
          sessionStore: store,
          basePromptLoopOptions: { finalizeOnTurnLimit: true },
          createPromptLoop: (options) => {
            restoredLoops += 1;
            confidentiality =
              options.inheritedCfcModelContext?.label.confidentiality ?? [];
            return {
              runTranscript: (options) => {
                resumed = options.transcript;
                return Promise.resolve(
                  makeResult(options, "Here are the findings."),
                );
              },
            };
          },
        });
        await restored.initializeFromStore();
        await restored.startTurn("followup", {
          sessionId: "research",
          turnId: "next",
          input: { text: "Summarize" },
        });
        await restored.waitForTurn("research", "next");
        expect(restoredLoops).toBe(1);
        expect(
          restored.listTurns({ sessionId: "research" }).turns.find((entry) =>
            entry.turn.turnId === "next"
          )?.turn.status,
        ).toBe("completed");
        expect(resumed.filter((m) => m.role === "tool").length).toBe(
          completed === 2 ? 2 : 0,
        );
        expect(resumed.some((m) => m.content === "Read sources")).toBe(
          completed === 2,
        );
        expect(confidentiality).toEqual(
          completed === 2 ? ["private-observation"] : [],
        );
        expect(createHarnessTranscriptOmissions(resumed).results).toHaveLength(
          completed === 2 ? 1 : 0,
        );
      } finally {
        store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});
