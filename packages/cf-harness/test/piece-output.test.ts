import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { readConsoleTurnResult } from "../console/turn-result.ts";
import type { HarnessFabricSessionConfig } from "../src/config.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessTranscriptEvent,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { PIECE_OUTPUT_GUIDANCE } from "../src/piece-output.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { createHarnessRunState } from "../src/run-state.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

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

const fabricSession: HarnessFabricSessionConfig = {
  apiUrl: "http://toolshed.test",
  identityKeyPath: "/unused/fixture.key",
  space: "piece-output",
};

/** A scripted model request through the ordinary tool dispatcher. */
const toolCall = (
  name: string,
  input: unknown,
  id: string,
): HarnessAssistantTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  }],
});

/** The result reference the preceding real tool call exposed to the model. */
const resultToken = (request: HarnessModelTurnRequest): string => {
  const output = request.transcript.findLast((message) =>
    message.role === "tool" && message.toolName === "run_pattern"
  );
  if (output === undefined) throw new Error("Missing run_pattern result");
  return JSON.parse(output.content).resultRef;
};

describe("piece-output", () => {
  it("turns the spending rehearsal's plain-text ending into a named UI piece through ordinary tools", async () => {
    // Row 1b, run 3318cbde, ended after data probes with no openable piece.
    // The sample here is synthetic; no connector contents enter the fixture.
    const artifactRoot = await Deno.makeTempDir();
    const signer = await Identity.fromPassphrase("piece-output fixture");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(fabricSession.apiUrl),
      storageManager,
    });
    const pieces = new PiecesController(
      await createSession({ identity: signer, spaceName: fabricSession.space }),
      runtime,
    );
    const requests: HarnessModelTurnRequest[] = [];
    try {
      await pieces.synced();
      const root = await pieces.create(
        `
        import { handler, pattern, type Cell, type Stream } from "commonfabric";
        const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(
          true,
          { type: "object", properties: { pieceRegistry: { type: "array", asCell: ["cell"] } } },
          ({ piece }, { pieceRegistry }) => { pieceRegistry.push(piece); },
        );
        export default pattern<
          { pieceRegistry: unknown[] },
          { pieceRegistry: unknown[]; addPiece: Stream<{ piece: unknown }> }
        >(({ pieceRegistry }) => ({ pieceRegistry, addPiece: addPiece({ pieceRegistry }) }));
      `,
        { input: { pieceRegistry: [] } },
      );
      await pieces.linkDefaultPattern(root.getCell());
      await runtime.idle();
      await pieces.synced();
      const loop = new CfHarnessPromptLoop({
        sandboxRuntime: sandbox,
        artifactRoot,
        runId: "spending",
        model: "test-model",
        fabricSession,
        fabricSessionFactory: () => Promise.resolve({ pieces }),
        allowedToolIds: ["run_pattern", "assign_slug", "finish_task"],
        modelClient: {
          providerId: "test-provider",
          complete: (request) => {
            requests.push({ ...request, transcript: [...request.transcript] });
            let assistant: HarnessAssistantTranscriptMessage;
            switch (requests.length) {
              case 1:
                assistant = toolCall("run_pattern", {
                  sourceText:
                    'import { pattern } from "commonfabric"; export default pattern(() => ({ total: 12 }));',
                }, "probe");
                break;
              case 2:
                assistant = { role: "assistant", content: "Your total is 12." };
                break;
              case 3:
                assistant = toolCall("assign_slug", {
                  token: resultToken(request),
                  slug: "spending-probe",
                }, "name-probe");
                break;
              case 4:
                assistant = {
                  role: "assistant",
                  content: "The probe is enough.",
                };
                break;
              case 5:
                assistant = toolCall("run_pattern", {
                  sourceText:
                    'import { pattern, UI } from "commonfabric"; export default pattern(() => ({ [UI]: <div>Your total is 12.</div> }));',
                }, "answer");
                break;
              case 6:
                assistant = toolCall("assign_slug", {
                  token: resultToken(request),
                  slug: "spending-summary",
                }, "name-answer");
                break;
              default:
                assistant = {
                  role: "assistant",
                  content: "Open your spending summary.",
                };
            }
            return Promise.resolve({ assistant });
          },
        },
      });
      const result = await loop.runPrompt({
        prompt: "what have I been spending money on",
        maxModelTurns: 7,
        promptSlotBinding: directPromptSlotBindingFor("spending"),
      });
      expect(requests).toHaveLength(7);
      expect(requests[0].transcript[0].content).toBe(PIECE_OUTPUT_GUIDANCE);
      expect(requests[2].transcript.at(-1)?.content).toContain(
        "no successful assign_slug receipt",
      );
      expect(requests[3].transcript.at(-1)?.content).toContain(
        "cannot confirm a UI",
      );
      expect(requests[4].transcript.at(-1)?.content).toContain(
        "no successful assign_slug receipt",
      );
      expect(result.taskOutcome).toEqual({ outcome: "completed" });
      expect(result.runState.assignedPieces?.map((piece) => piece.slug))
        .toEqual([
          "spending-summary",
        ]);
      expect(
        result.transcript.some((message) =>
          message.content.startsWith("Host completion")
        ),
      ).toBe(false);
      const report = JSON.parse(
        await Deno.readTextFile(
          join(artifactRoot, "spending", "run-report.json"),
        ),
      );
      expect(report.timeline).toContainEqual(expect.objectContaining({
        kind: "transcript_message",
        modelTurn: 2,
        role: "user",
      }));
      expect(
        await readConsoleTurnResult({
          artifactRoot,
          turnId: "spending",
          sessionId: "conversation",
          continuable: true,
          spaceName: fabricSession.space,
        }),
      ).toMatchObject({
        outcome: "completed",
        pieces: [{
          slug: "spending-summary",
          url: "http://toolshed.test/piece-output/spending-summary",
        }],
      });
      const namedToken = resultToken(requests[5]);
      const confirmed = await loop.engine.invokeBuiltinTool("assign_slug", {
        token: loop.engine.handleTable!.entries.find((entry) =>
          entry.token === namedToken
        )!.ref,
        slug: "spending-summary",
      });
      expect(confirmed.output).toMatchObject({ status: "ok" });
      expect(loop.engine.getRunState().assignedPieces).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
      await Deno.remove(artifactRoot, { recursive: true });
    }
  });

  it("keeps a denied naming call out of completion without writing a replacement for the model", async () => {
    const requests: HarnessModelTurnRequest[] = [];
    const events: HarnessTranscriptEvent[] = [];
    let fabricOpens = 0;
    const loop = new CfHarnessPromptLoop({
      sandboxRuntime: sandbox,
      model: "test-model",
      requirePieceOutput: true,
      allowedToolIds: ["finish_task"],
      fabricSessionFactory: () => {
        fabricOpens += 1;
        throw new Error("A refused call must not open Fabric");
      },
      modelClient: {
        providerId: "test-provider",
        complete: (request) => {
          requests.push({ ...request, transcript: [...request.transcript] });
          return Promise.resolve({
            assistant: requests.length === 1
              ? toolCall("assign_slug", {
                token: "cfh:a:unused",
                slug: "answer",
              }, "denied")
              : requests.length === 2
              ? { role: "assistant", content: "The task is complete." }
              : toolCall("finish_task", {
                outcome: "gave-up",
                message: "This session cannot publish the answer as a piece.",
              }, "finish"),
          });
        },
      },
    });
    const result = await loop.runPrompt({
      prompt: "Render my answer.",
      maxModelTurns: 3,
      promptSlotBinding: directPromptSlotBindingFor("denied"),
      onTranscriptEvent: (event) => {
        events.push({ ...event, transcript: [...event.transcript] });
      },
    });
    expect(requests).toHaveLength(3);
    expect(requests[2].transcript.at(-1)?.content).toContain(
      "no successful assign_slug receipt",
    );
    const correction = events.find(({ message }) =>
      message.content.startsWith("Host completion check:")
    );
    expect(correction?.message).toEqual(requests[2].transcript.at(-1));
    expect(correction?.transcript).toEqual(requests[2].transcript);
    expect(result.taskOutcome?.outcome).toBe("gave-up");
    expect(result.runState.assignedPieces).toBeUndefined();
    expect(fabricOpens).toBe(0);
  });

  it("keeps repeated plain-text refusals within the existing model-turn bound", async () => {
    let requests = 0;
    const loop = new CfHarnessPromptLoop({
      sandboxRuntime: sandbox,
      model: "test-model",
      requirePieceOutput: true,
      modelClient: {
        providerId: "test-provider",
        complete: () => {
          requests += 1;
          return Promise.resolve({
            assistant: { role: "assistant", content: "Done." },
          });
        },
      },
    });
    await expect(loop.runPrompt({
      prompt: "Make a page.",
      maxModelTurns: 2,
    })).rejects.toThrow("exceeded max model turns (2)");
    expect(requests).toBe(2);
    expect(loop.engine.getRunState().terminalReason).toBe("max_model_turns");
  });

  for (const outcome of ["question", "gave-up"] as const) {
    it(`allows a piece-less ${outcome} after refusing a plain-text ending`, async () => {
      const requests: HarnessModelTurnRequest[] = [];
      const loop = new CfHarnessPromptLoop({
        sandboxRuntime: sandbox,
        fabricSession,
        model: "test-model",
        allowedToolIds: ["finish_task"],
        modelClient: {
          providerId: "test-provider",
          complete: (request) => {
            requests.push({ ...request, transcript: [...request.transcript] });
            return Promise.resolve({
              assistant: requests.length === 1
                ? { role: "assistant", content: "Here is the answer." }
                : toolCall("finish_task", {
                  outcome,
                  message: "A spending source is needed to proceed.",
                }, "finish"),
            });
          },
        },
      });
      const result = await loop.runPrompt({
        prompt: "what have I been spending money on",
        maxModelTurns: 2,
        promptSlotBinding: directPromptSlotBindingFor("terminal"),
      });
      expect(requests).toHaveLength(2);
      expect(result.taskOutcome?.outcome).toBe(outcome);
      expect(result.runState.assignedPieces).toBeUndefined();
    });
  }

  for (const resumed of [false, true]) {
    it(`returns a structured document from a ${resumed ? "resumed" : "fresh"} Fabric agent request without requiring a UI piece`, async () => {
      const directory = await Deno.makeTempDir();
      const path = join(directory, "result.json");
      const requests: HarnessModelTurnRequest[] = [];
      let fabricOpens = 0;
      try {
        const configured = new CfHarnessEngine({
          sandboxRuntime: sandbox,
          model: "test-model",
          fabricSession,
          structuredResult: {
            path,
            schema: {
              type: "object",
              properties: { total: { type: "number" } },
              required: ["total"],
              additionalProperties: false,
            },
          },
          fabricSessionFactory: () => {
            fabricOpens += 1;
            throw new Error("Submitting a document does not open Fabric");
          },
        });
        const engine = resumed
          ? new CfHarnessEngine({
            sandboxRuntime: sandbox,
            model: "test-model",
            runState: configured.getRunState(),
          })
          : configured;
        const loop = new CfHarnessPromptLoop({
          engine,
          allowedToolIds: ["submit_result"],
          modelClient: {
            providerId: "test-provider",
            complete: (request) => {
              requests.push({
                ...request,
                transcript: [...request.transcript],
              });
              return Promise.resolve({
                assistant: requests.length === 1
                  ? toolCall(
                    "submit_result",
                    { result: { total: 12 } },
                    "result",
                  )
                  : {
                    role: "assistant" as const,
                    content: "Result submitted.",
                  },
              });
            },
          },
        });
        const result = await loop.runPrompt({
          prompt: "Return the total as a structured result.",
          maxModelTurns: 2,
          promptSlotBinding: {
            ...directPromptSlotBindingFor("agent-result"),
            role: "context",
          },
        });
        expect(result.taskOutcome?.outcome).toBe("completed");
        expect(JSON.parse(await Deno.readTextFile(path))).toEqual({
          total: 12,
        });
        expect(requests).toHaveLength(2);
        expect(result.runState.assignedPieces).toBeUndefined();
        expect(
          requests[0].transcript.some((message) =>
            message.content.startsWith("Host completion")
          ),
        ).toBe(false);
        expect(fabricOpens).toBe(0);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  }

  for (
    const mode of [
      "resume",
      "unconfigured-resume",
      "history",
      "child",
      "repository",
      "budget",
    ] as const
  ) {
    it(`uses the ${mode} completion contract without treating past conversation as a current naming receipt`, async () => {
      let requests = 0;
      const engine = new CfHarnessEngine({
        sandboxRuntime: sandbox,
        model: "test-model",
        ...(mode === "repository" || mode === "unconfigured-resume"
          ? {}
          : { fabricSession }),
        ...(mode === "resume"
          ? {
            runState: createHarnessRunState({
              runId: "resumed",
              currentDir: "/workspace",
              cfcEnforcementMode: "enforce-strict",
              assignedPieces: [{ slug: "answer", ref: "/of:fid1:fixture" }],
            }),
          }
          : {}),
        ...(mode === "unconfigured-resume"
          ? {
            runState: new CfHarnessEngine({
              sandboxRuntime: sandbox,
              fabricSession,
            }).getRunState(),
          }
          : {}),
        ...(mode === "child"
          ? {
            lineage: {
              role: "subagent" as const,
              rootRunId: "root",
              parentRunId: "root",
              parentToolCallId: "delegate",
              depth: 1,
            },
          }
          : {}),
      });
      const loop = new CfHarnessPromptLoop({
        engine,
        ...(mode === "child" ? { requirePieceOutput: true } : {}),
        finalizeOnTurnLimit: mode === "budget",
        allowedToolIds: ["finish_task"],
        modelClient: {
          providerId: "test-provider",
          complete: () => {
            requests += 1;
            return Promise.resolve({
              assistant:
                (mode === "history" || mode === "unconfigured-resume") &&
                  requests === 2
                  ? toolCall("finish_task", {
                    outcome: "question",
                    message: "Which source should the answer use?",
                  }, "question")
                  : { role: "assistant" as const, content: "A final answer." },
            });
          },
        },
      });
      const history: HarnessTranscriptMessage[] = mode === "history"
        ? [
          toolCall(
            "assign_slug",
            { token: "cfh:a:old", slug: "old-answer" },
            "old-call",
          ),
          {
            role: "tool",
            toolName: "assign_slug",
            toolCallId: "old-call",
            content: JSON.stringify({ status: "ok", slug: "old-answer" }),
          },
        ]
        : [];
      const result = await loop.runTranscript({
        transcript: [...history, { role: "user", content: "Continue." }],
        maxModelTurns: mode === "history" || mode === "unconfigured-resume"
          ? 2
          : 1,
        promptSlotBinding: directPromptSlotBindingFor("completion"),
      });
      expect(requests).toBe(
        mode === "history" || mode === "unconfigured-resume" ? 2 : 1,
      );
      expect(result.taskOutcome?.outcome).toBe(
        mode === "history" || mode === "unconfigured-resume"
          ? "question"
          : mode === "budget"
          ? "gave-up"
          : "completed",
      );
    });
  }
});
