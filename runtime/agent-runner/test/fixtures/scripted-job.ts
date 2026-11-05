/** Runs the real job loop with scripted model replies and workspace file I/O. */

import { join } from "@std/path";
import type { RunCfHarnessCliDependencies } from "@commonfabric/cf-harness/cli";
import type { HarnessAssistantTranscriptMessage } from "@commonfabric/cf-harness/contracts/transcript";
import { CfHarnessEngine } from "@commonfabric/cf-harness/engine";
import type { HarnessModelTurnRequest } from "@commonfabric/cf-harness/model/client";
import { CfHarnessPromptLoop } from "@commonfabric/cf-harness/prompt-loop";

/** A model-authored call, executed by the real harness engine. */
export const toolReply = (
  name: string,
  input: Record<string, unknown>,
): HarnessAssistantTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  }],
});

/** Submits a job's answer through the harness's structured-result tool. */
export const answerReply = (answer: string) =>
  toolReply("submit_result", { result: { answer } });

/** Keeps request snapshots while leaving transcripts and results on disk. */
export const scriptedJob = (
  reply: (
    request: HarnessModelTurnRequest,
    index: number,
  ) =>
    | HarnessAssistantTranscriptMessage
    | Promise<HarnessAssistantTranscriptMessage>,
) => {
  const requests: HarnessModelTurnRequest[] = [];
  const workspaces: string[] = [];
  const deps: RunCfHarnessCliDependencies = {
    env: {
      CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
      CF_HARNESS_GATEWAY_AUTH_MODE: "none",
      CF_HARNESS_SANDBOX_RUNTIME: "runsc",
      CF_HARNESS_RUNSC_BINARY: "/nonexistent/scripted-job/runsc",
      CF_HARNESS_SANDBOX_ROOTFS: "/nonexistent/scripted-job/rootfs",
      CF_HARNESS_RUNSC_CFC_POLICY: "/nonexistent/scripted-job/policy.json",
    },
    createPromptLoop: (options) => {
      const workspace = options.engine!.workspaceHostPath!;
      workspaces.push(workspace);
      return new CfHarnessPromptLoop({
        ...options,
        engine: new CfHarnessEngine({
          ...options,
          runState: options.engine!.getRunState(),
          workspaceHostPath: workspace,
          sandboxRuntime: {
            describe: () => ({
              kind: "runsc-cfc",
              defaultWorkingDirectory: "/workspace",
            }),
            defaultWorkingDirectory: () => "/workspace",
            resolvePath: (path) => path,
            isPathWithinWorkspace: (path) => path.startsWith("/workspace/"),
            isPathWithinAllowedRoots: (path) => path.startsWith("/workspace/"),
            run: () => {
              throw new Error("unexpected sandbox command");
            },
            runShell: async (request) => {
              const path = request.args?.[0];
              if (path === undefined) {
                throw new Error("unexpected shell request");
              }
              const hostPath = join(
                workspace,
                path.slice("/workspace/".length),
              );
              if (request.stdinText !== undefined) {
                await Deno.writeTextFile(hostPath, request.stdinText);
                return { stdout: "", stderr: "", exitCode: 0 };
              }
              const stdout = await Deno.readTextFile(hostPath);
              return {
                stdout,
                stderr: "",
                exitCode: 0,
                cfcResult: {
                  version: 1,
                  stdout: {
                    channel: "stdout",
                    policy: "observed",
                    label: { confidentiality: ["public"] },
                    segments: [{
                      text: stdout,
                      label: { confidentiality: ["public"] },
                    }],
                  },
                  stderr: {
                    channel: "stderr",
                    policy: "observed",
                    label: {},
                    segments: [],
                  },
                  exitCode: { policy: "observed", label: {}, value: 0 },
                },
              };
            },
          },
        }),
        modelClient: {
          providerId: "fixture",
          complete: async (request) => {
            const index = requests.length;
            requests.push({
              ...request,
              transcript: structuredClone(request.transcript),
            });
            return {
              assistant: await reply(request, index),
              usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            };
          },
        },
      });
    },
  };
  return { deps, requests, workspaces };
};
