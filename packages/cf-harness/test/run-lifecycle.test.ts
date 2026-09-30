/**
 * The run's outcome on disk, as a poller reads `run-state.json`: terminal
 * exactly when the run is over, and terminal after every way a run can die.
 * The loop and the setup phase are the only writers of that outcome, so each
 * case drives one of them and reads the file where a poller would.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import type { CfcSandboxResult } from "@commonfabric/runner/cfc";

import { readHarnessRunReport, readHarnessRunState } from "../src/artifacts.ts";
import { createCliPromptSlotBinding } from "../src/contracts/prompt-slot.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessModelClient } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { establishHarnessSessionContext } from "../src/session-assembly.ts";

const SPACE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const FOREIGN_REF = `/@did:key:z6MkforeignSpaceForRunLifecycleTest/of:fid1:${
  "B".repeat(43)
}/x`;

/** The mediation metadata a CFC sandbox attaches to a command's output. */
const mediated = (stdout: string): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "observed",
    label: { confidentiality: ["public"] },
    segments: [{ text: stdout, label: { confidentiality: ["public"] } }],
  },
  stderr: {
    channel: "stderr",
    policy: "observed",
    label: { confidentiality: ["public"] },
    segments: [{ text: "", label: { confidentiality: ["public"] } }],
  },
  exitCode: {
    policy: "observed",
    label: { confidentiality: ["public"] },
    value: 0,
  },
});

/** A sandbox that answers the capability probe and one canned shell result. */
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
        : {
          stdout: "one\n",
          stderr: "",
          exitCode: 0,
          cfcResult: mediated("one\n"),
        },
    );
  }
}

const runStatePath = (artifactRoot: string, runId: string): string =>
  join(artifactRoot, runId, "run-state.json");

/**
 * The prompt slot the command line binds a typed prompt to. The effectful
 * tool the model calls carries its authority from this binding.
 */
const directCommandSlot = createCliPromptSlotBinding({
  kernelName: "cf-harness",
  subject: "run-lifecycle",
});

const bashCallTurn = {
  assistant: {
    role: "assistant" as const,
    content: "",
    toolCalls: [{
      id: "call-1",
      type: "function" as const,
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "echo one" }),
      },
    }],
  },
};

/**
 * A loop whose model makes one tool call and then does whatever `then`
 * says. Before that second turn is answered, the run's file is read the way
 * a poller reads it, and the snapshot is kept in `seen`.
 */
const loopAfterOneToolCall = (
  artifactRoot: string,
  runId: string,
  then: () => Promise<Awaited<ReturnType<HarnessModelClient["complete"]>>>,
): { loop: CfHarnessPromptLoop; seen: HarnessRunState[] } => {
  const seen: HarnessRunState[] = [];
  let turns = 0;
  const modelClient: HarnessModelClient = {
    providerId: "test-provider",
    async complete() {
      turns += 1;
      if (turns === 1) {
        return bashCallTurn;
      }
      seen.push(await readHarnessRunState(runStatePath(artifactRoot, runId)));
      return await then();
    },
  };
  const loop = new CfHarnessPromptLoop({
    modelClient,
    engine: new CfHarnessEngine({
      artifactRoot,
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "test-model",
    }),
  });
  return { loop, seen };
};

const withArtifactRoot = async (
  body: (artifactRoot: string) => Promise<void>,
): Promise<void> => {
  const artifactRoot = await Deno.makeTempDir({
    prefix: "cf-harness-run-lifecycle-",
  });
  try {
    await body(artifactRoot);
  } finally {
    await Deno.remove(artifactRoot, { recursive: true });
  }
};

describe("run-lifecycle", () => {
  describe("CfHarnessPromptLoop", () => {
    it("reads `running` on disk between a tool call and the model's next turn", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-tool-call-then-answer";
        const { loop, seen } = loopAfterOneToolCall(
          artifactRoot,
          runId,
          () =>
            Promise.resolve({
              assistant: { role: "assistant", content: "done" },
            }),
        );

        await loop.runPrompt({
          prompt: "run one command",
          promptSlotBinding: directCommandSlot,
        });

        expect(seen).toHaveLength(1);
        expect(seen[0].status).toBe("running");
        expect(seen[0].endedAt).toBeUndefined();
        expect(seen[0].terminalReason).toBeUndefined();
        expect(seen[0].toolOutputs).toHaveLength(1);
        const settled = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(settled.status).toBe("completed");
        expect(settled.terminalReason).toBe("assistant_completed");
        expect(settled.endedAt).toBeDefined();
      });
    });

    it("settles to `failed` with `prompt_loop_error` when the model fails after a tool call", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-tool-call-then-provider-error";
        const { loop, seen } = loopAfterOneToolCall(
          artifactRoot,
          runId,
          () =>
            Promise.reject(
              new Error("model stream returned an error event"),
            ),
        );

        await expect(loop.runPrompt({
          prompt: "run one command",
          promptSlotBinding: directCommandSlot,
        })).rejects
          .toThrow("model stream returned an error event");

        expect(seen[0].status).toBe("running");
        expect(seen[0].endedAt).toBeUndefined();
        const settled = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(settled.status).toBe("failed");
        expect(settled.terminalReason).toBe("prompt_loop_error");
        expect(settled.endedAt).toBeDefined();
        expect(settled.primaryFailure?.detail).toBe(
          "model stream returned an error event",
        );
      });
    });

    it("records cancellation when an in-flight model returns after the run was aborted", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-canceled-model";
        const controller = new AbortController();
        const reason = new DOMException("stopped by the user", "AbortError");
        const loop = new CfHarnessPromptLoop({
          engine: new CfHarnessEngine({
            artifactRoot,
            runId,
            model: "test-model",
            sandboxRuntime: new FakeSandboxRuntime(),
          }),
          modelClient: {
            providerId: "test-provider",
            complete() {
              controller.abort(reason);
              return Promise.resolve({
                assistant: { role: "assistant", content: "too late" },
              });
            },
          },
        });

        await expect(loop.runPrompt({
          prompt: "start work",
          signal: controller.signal,
        })).rejects.toBe(reason);

        const state = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        const report = await readHarnessRunReport(
          join(artifactRoot, runId, "run-report.json"),
        );
        for (const artifact of [state, report]) {
          expect(artifact).toMatchObject({
            status: "canceled",
            terminalReason: "canceled",
            cancelReason: "stopped by the user",
            failureRecords: [],
          });
          expect(artifact.endedAt).toBeDefined();
          expect(artifact.primaryFailure).toBeUndefined();
        }
        expect(report.finalAssistantText).toBeUndefined();
        expect(await loop.engine.terminalizeInterruptedRun("SIGTERM"))
          .toMatchObject({ status: "canceled", terminalReason: "canceled" });
        const resumed = loop.engine.startRun();
        expect(resumed.status).toBe("running");
        expect(resumed.cancelReason).toBeUndefined();
        expect(resumed.endedAt).toBeUndefined();
      });
    });

    it("unwinds a canceled child without reclassifying it or the parent as a failure", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-canceled-child";
        const controller = new AbortController();
        const reason = new DOMException(
          "stopped during delegation",
          "AbortError",
        );
        let parentTurns = 0;
        const loop = new CfHarnessPromptLoop({
          engine: new CfHarnessEngine({
            artifactRoot,
            runId,
            model: "test-model",
            sandboxRuntime: new FakeSandboxRuntime(),
          }),
          modelClient: {
            providerId: "test-provider",
            complete(request) {
              if (request.runId === `${runId}.subagent.1`) {
                return Promise.resolve({
                  assistant: { role: "assistant", content: "first child done" },
                });
              }
              if (request.runId === `${runId}.subagent.2`) {
                controller.abort(reason);
                request.signal?.throwIfAborted();
              }
              request.signal?.throwIfAborted();
              parentTurns += 1;
              return Promise.resolve({
                assistant: {
                  role: "assistant",
                  content: "",
                  toolCalls: [{
                    id: `delegate-${parentTurns}`,
                    type: "function",
                    function: {
                      name: "delegate_task",
                      arguments: JSON.stringify({ goal: "perform one step" }),
                    },
                  }],
                },
              });
            },
          },
        });

        await expect(loop.runPrompt({
          prompt: "perform two steps",
          promptSlotBinding: directCommandSlot,
          signal: controller.signal,
        })).rejects.toBe(reason);

        for (const id of [runId, `${runId}.subagent.2`]) {
          const state = await readHarnessRunState(
            runStatePath(artifactRoot, id),
          );
          const report = await readHarnessRunReport(
            join(artifactRoot, id, "run-report.json"),
          );
          for (const artifact of [state, report]) {
            expect(artifact).toMatchObject({
              status: "canceled",
              terminalReason: "canceled",
              cancelReason: "stopped during delegation",
              failureRecords: [],
            });
            expect(artifact.endedAt).toBeDefined();
            expect(artifact.primaryFailure).toBeUndefined();
          }
        }
        const completedChild = await readHarnessRunState(
          runStatePath(artifactRoot, `${runId}.subagent.1`),
        );
        expect(completedChild).toMatchObject({
          status: "completed",
          terminalReason: "assistant_completed",
        });
        const parent = await readHarnessRunReport(
          join(artifactRoot, runId, "run-report.json"),
        );
        expect(parent.subagentRuns?.map((child) => child.status))
          .toEqual(["completed", "canceled"]);
        expect(parent.subagentRuns?.[1]).toMatchObject({
          childRunId: `${runId}.subagent.2`,
          runState: {
            status: "canceled",
            terminalReason: "canceled",
            failureCount: 0,
          },
        });
        expect(parent.toolActivity.map((activity) => activity.executionStatus))
          .toEqual(["completed", "canceled"]);
        expect(parent.toolOutputs).toHaveLength(1);
        expect(parentTurns).toBe(2);
      });
    });

    it("keeps an unrelated AbortError as a failure when the run signal is not aborted", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-provider-abort-error";
        const controller = new AbortController();
        const error = new DOMException(
          "provider request timed out",
          "AbortError",
        );
        const { loop } = loopAfterOneToolCall(
          artifactRoot,
          runId,
          () => Promise.reject(error),
        );

        await expect(loop.runPrompt({
          prompt: "run one command",
          promptSlotBinding: directCommandSlot,
          signal: controller.signal,
        })).rejects.toBe(error);

        const state = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(state).toMatchObject({
          status: "failed",
          terminalReason: "prompt_loop_error",
          primaryFailure: { detail: "provider request timed out" },
        });
        expect(controller.signal.aborted).toBe(false);
      });
    });

    for (const outcome of ["throws", "returns"] as const) {
      it(`retains tool evidence without a failure record when an aborted tool ${outcome}`, async () => {
        await withArtifactRoot(async (artifactRoot) => {
          const runId = `run-canceled-tool-${outcome}`;
          const controller = new AbortController();
          const reason = new DOMException(
            "stopped during a tool",
            "AbortError",
          );
          class CanceledToolSandbox extends FakeSandboxRuntime {
            override runShell(
              request: SandboxShellRequest,
            ): Promise<SandboxCommandResult> {
              if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
                return super.runShell(request);
              }
              controller.abort(reason);
              return outcome === "throws"
                ? Promise.reject(reason)
                : Promise.resolve({
                  stdout: "",
                  stderr: "bash: stopped-command: command not found",
                  exitCode: 127,
                  cfcResult: {
                    ...mediated(""),
                    exitCode: {
                      policy: "observed",
                      label: { confidentiality: ["public"] },
                      value: 127,
                    },
                  },
                });
            }
          }
          let modelTurns = 0;
          const loop = new CfHarnessPromptLoop({
            engine: new CfHarnessEngine({
              artifactRoot,
              runId,
              model: "test-model",
              sandboxRuntime: new CanceledToolSandbox(),
            }),
            modelClient: {
              providerId: "test-provider",
              complete() {
                modelTurns += 1;
                return Promise.resolve(bashCallTurn);
              },
            },
          });

          await expect(loop.runPrompt({
            prompt: "run one command",
            promptSlotBinding: directCommandSlot,
            signal: controller.signal,
          })).rejects.toBe(reason);

          const state = await readHarnessRunState(
            runStatePath(artifactRoot, runId),
          );
          const report = await readHarnessRunReport(
            join(artifactRoot, runId, "run-report.json"),
          );
          for (const artifact of [state, report]) {
            expect(artifact).toMatchObject({
              status: "canceled",
              terminalReason: "canceled",
              cancelReason: "stopped during a tool",
              failureRecords: [],
            });
            expect(artifact.toolOutputs).toHaveLength(
              outcome === "returns" ? 1 : 0,
            );
          }
          expect(
            report.toolActivity.map((activity) => activity.executionStatus),
          )
            .toEqual(["canceled"]);
          expect(modelTurns).toBe(1);
          if (outcome === "returns") {
            expect(report.toolActivity[0].resultRef).toEqual(
              state.toolOutputs[0],
            );
            const output = JSON.parse(
              await Deno.readTextFile(state.toolOutputs[0].artifactPath!),
            );
            expect(output).toMatchObject({
              stderr: "bash: stopped-command: command not found",
              exitCode: 127,
            });
          }
        });
      });
    }
  });

  describe("establishHarnessSessionContext()", () => {
    const engineWithInputCell = (
      artifactRoot: string,
      runId: string,
      ref: string,
    ): CfHarnessEngine =>
      new CfHarnessEngine({
        artifactRoot,
        runId,
        workspaceHostPath: "/host/project",
        inputCells: [{ name: "account", ref }],
        fabricSessionFactory: () =>
          Promise.resolve(
            {
              pieces: {
                getSpace: () => SPACE_DID,
                getSpaceName: () => undefined,
              },
              // deno-lint-ignore no-explicit-any
            } as any,
          ),
      });

    it("takes the run to `running` on disk before its first model turn", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-setup-succeeds";
        const engine = engineWithInputCell(
          artifactRoot,
          runId,
          `/of:fid1:${"A".repeat(43)}/account`,
        );

        await establishHarnessSessionContext({
          engine,
          config: { skillNames: [] },
        });

        const state = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(state.status).toBe("running");
        expect(state.endedAt).toBeUndefined();
        expect(state.inputCells).toHaveLength(1);
      });
    });

    it("leaves the run `failed` with `setup_error` on disk when an input cell cannot be minted", async () => {
      await withArtifactRoot(async (artifactRoot) => {
        const runId = "run-setup-fails";
        const engine = engineWithInputCell(artifactRoot, runId, FOREIGN_REF);

        await expect(
          establishHarnessSessionContext({
            engine,
            config: { skillNames: [] },
          }),
        ).rejects.toThrow("targets another space");

        const state = await readHarnessRunState(
          runStatePath(artifactRoot, runId),
        );
        expect(state.status).toBe("failed");
        expect(state.terminalReason).toBe("setup_error");
        expect(state.endedAt).toBeDefined();
        expect(state.primaryFailure?.detail).toContain("targets another space");
        expect(state.inputCells).toBeUndefined();
      });
    });
  });
});
