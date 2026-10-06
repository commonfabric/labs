/**
 * A console-shaped turn — its run named by its turn id, an input cell
 * attached — ends with the labels its space holds recorded under its own run
 * and under the run of the child it delegated to. Nothing above the runs
 * records them: each run writes its labels as it ends, and the event that
 * closes the turn follows.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";

import { readHarnessRunState } from "../src/artifacts.ts";
import type { HarnessCellLabels } from "../src/contracts/cell-labels.ts";
import { HANDLE_TOKEN_PATTERN } from "../src/contracts/handle-table.ts";
import {
  DEFAULT_HARNESS_CHAT_POLICY,
  type HarnessChatEventEnvelope,
  type HarnessChatPolicy,
} from "../src/contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { HarnessInteractiveChatService } from "../src/interactive-chat-service.ts";
import type {
  HarnessModelClient,
  HarnessModelTurnResult,
} from "../src/model/client.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  LABELED_CELL_ID,
  seedSpaceDb,
  SPACE_DB_DID,
} from "./support/space-db.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

/** A sandbox that answers the capability probe and nothing else. */
class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve(
      request.command.includes(CAPABILITY_PROBE_SENTINEL)
        ? {
          stdout:
            "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
          stderr: "",
          exitCode: 0,
        }
        : { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

/** The handle token the turn announced for its input cell. */
const announcedToken = (
  transcript: readonly HarnessTranscriptMessage[],
): string => {
  for (const message of transcript) {
    const match = message.content.match(new RegExp(HANDLE_TOKEN_PATTERN));
    if (match !== null) {
      return match[0];
    }
  }
  throw new Error("the turn announced no input cell token to the model");
};

const answer = (content: string): HarnessModelTurnResult => ({
  assistant: { role: "assistant", content },
});

/**
 * A model that delegates the turn's input cell to a child by naming its
 * token in the goal, so the child's table holds the cell too, and then
 * reports that no answer was produced; the child answers at once. Both loops
 * share it, and the child's one turn falls between the parent's two.
 */
const delegatingModel = (): HarnessModelClient => {
  let turns = 0;
  return {
    providerId: "test-provider",
    complete(request) {
      turns += 1;
      switch (turns) {
        case 1:
          return Promise.resolve({
            assistant: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "call-delegate",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    profile: "default",
                    goal: `Inspect ${
                      announcedToken(request.transcript)
                    } and report what it holds.`,
                  }),
                },
              }],
            },
          });
        case 2:
          return Promise.resolve(answer("Child done."));
        default:
          return Promise.resolve({
            assistant: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "call-finish",
                type: "function",
                function: {
                  name: "finish_task",
                  arguments: JSON.stringify({
                    outcome: "gave-up",
                    message: "The inspection produced no answer to display.",
                  }),
                },
              }],
            },
          });
      }
    },
  };
};

const readCellLabels = async (runRoot: string): Promise<HarnessCellLabels> =>
  JSON.parse(
    await Deno.readTextFile(join(runRoot, "cell-labels.json")),
  ) as HarnessCellLabels;

/** The console binds a person's typed prompt as the turn's direct command. */
const directPromptSlotBinding = directPromptSlotBindingFor("cell-labels");

/** The default console policy, with the turn carried as a direct command. */
const directCommandPolicy: HarnessChatPolicy = {
  ...DEFAULT_HARNESS_CHAT_POLICY,
  promptSlot: directPromptSlotBinding,
};

describe("interactive chat cell labels", () => {
  it("ends a turn that minted an input cell with `cell-labels.json` read from the space under its run and under its child's", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "cf-harness-interactive-chat-cell-labels-",
    });
    try {
      const artifactRoot = join(directory, "runs");
      const spaceDbPath = seedSpaceDb(directory);
      const closed = Promise.withResolvers<HarnessChatEventEnvelope>();
      const service = new HarnessInteractiveChatService({
        basePromptLoopOptions: {
          modelClient: delegatingModel(),
          sandboxRuntime: new FakeSandboxRuntime(),
          artifactRoot,
          model: "test-model",
          fabricSession: {
            apiUrl: "http://fabric.test",
            identityKeyPath: join(directory, "key.pkcs8"),
            space: SPACE_DB_DID,
          },
          fabricSessionFactory: () =>
            Promise.resolve(
              {
                pieces: {
                  getSpace: () => SPACE_DB_DID,
                  getSpaceName: () => undefined,
                },
                // deno-lint-ignore no-explicit-any
              } as any,
            ),
          spaceDbPath,
        },
        // The console names a turn's run by the turn's id.
        runIdForTurn: (_sessionId, turnId) => turnId,
        onEvent: (envelope) => {
          switch (envelope.event.kind) {
            case "turn_completed":
              closed.resolve(envelope);
              break;
            case "turn_failed":
              closed.reject(new Error(envelope.event.error.message));
              break;
            case "turn_canceled":
              closed.reject(new Error("the turn was canceled"));
              break;
          }
        },
      });
      const started = await service.startSession("request-1", {
        workspace: { hostPath: join(directory, "workspace") },
      });
      if (!started.ok) {
        throw new Error(started.error.message);
      }
      const turn = await service.startTurn("request-2", {
        sessionId: started.result.sessionId,
        input: { text: "Have a subagent inspect the secret." },
        policy: directCommandPolicy,
        inputCells: [{
          name: "secret",
          ref: `/${LABELED_CELL_ID}/value/secret`,
        }],
      });
      if (!turn.ok) {
        throw new Error(turn.error.message);
      }

      const envelope = await closed.promise;

      expect(envelope.event.kind).toBe("turn_completed");
      expect(envelope.event).toMatchObject({ outcome: "gave-up" });
      const parentRoot = join(artifactRoot, turn.result.turnId);
      const childRoot = join(artifactRoot, `${turn.result.turnId}.subagent.1`);
      for (const runRoot of [parentRoot, childRoot]) {
        const state = await readHarnessRunState(
          join(runRoot, "run-state.json"),
        );
        expect(state.status).toBe("completed");
        expect(state.cellLabelsPath).toBe(join(runRoot, "cell-labels.json"));
        const labels = await readCellLabels(runRoot);
        expect(labels.status).toBe("read");
        expect(labels.space?.dbPath).toBe(spaceDbPath);
        expect(labels.cells.map((cell) => cell.entityId)).toEqual([
          LABELED_CELL_ID,
        ]);
        expect(labels.cells[0].unreadReason).toBeUndefined();
        expect(
          labels.cells[0].entries.map((entry) =>
            entry.confidentiality.map((atom) => atom.type)
          ),
        ).toEqual([["demo-secret"]]);
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
