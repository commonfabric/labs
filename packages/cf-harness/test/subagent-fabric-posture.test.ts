/**
 * A delegated child runs on the session its parent built, so it records the
 * posture that session is at rather than none. The child is where
 * `run_pattern` runs, which makes it the run an audit most needs a sink
 * registry from.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";

import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { harnessFabricSessionPosture } from "../src/cfc-posture.ts";
import { readHarnessRunState } from "../src/artifacts.ts";
import { responsesBodyFromChatFixture } from "./support/responses-fixture.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

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
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "ok", stderr: "", exitCode: 0 });
  }
}

/**
 * The session the parent is configured for. Nothing constructs it: the
 * factory is built lazily on the first `run_pattern` call, and this run makes
 * none, which is the case the record exists to speak for.
 */
const SESSION = {
  apiUrl: "https://toolshed.example/",
  identityKeyPath: "/keys/agent.pkcs8",
  space: "my-space",
  cfcPosture: "max-enforcement",
} as const;

/**
 * The authority the prompt carries. `delegate_task` has an effect, so the
 * enforcing modes admit it only from a prompt bound as a direct command.
 */
const directPromptSlotBinding = directPromptSlotBindingFor(
  "subagent-fabric-posture",
);

const delegateCallTurn = (id: string, goal: string) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: {
          name: "delegate_task",
          arguments: JSON.stringify({ goal }),
        },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

const scriptedFetch = (payloads: readonly unknown[]): typeof fetch => {
  let served = 0;
  return () => {
    const payload = payloads[served];
    served += 1;
    if (payload === undefined) {
      throw new Error("scripted fetch ran out of payloads");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
        status: 200,
      }),
    );
  };
};

describe("subagent fabric-session posture", () => {
  for (const ceiling of [undefined, [{ anyOf: ["did:key:A", "did:key:B"] }]]) {
    it(
      ceiling === undefined
        ? "records the parent's posture on the delegated child, stamped inherited"
        : "carries the parent's group ceiling into the child runtime configuration",
      async () => {
        const artifactRoot = await Deno.makeTempDir({
          prefix: "cf-harness-subagent-posture-",
        });
        try {
          const runId = "run-subagent-posture";
          const loop = new CfHarnessPromptLoop({
            apiKey: "test-key",
            engine: new CfHarnessEngine({
              artifactRoot,
              sandboxRuntime: new FakeSandboxRuntime(),
              runId,
              model: "gpt-5.4",
              fabricSession: {
                ...SESSION,
                ...(ceiling === undefined
                  ? {}
                  : { cfcReadMaxConfidentiality: ceiling }),
              },
            }),
            fetchFn: scriptedFetch([
              delegateCallTurn("call-delegate", "Inspect the workspace."),
              finalTurn("Child done."),
              {
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                      id: "call-finish",
                      type: "function",
                      function: {
                        name: "finish_task",
                        arguments: JSON.stringify({
                          outcome: "gave-up",
                          message:
                            "The inspection produced no user-facing result.",
                        }),
                      },
                    }],
                  },
                }],
              },
            ]),
          });

          const result = await loop.runPrompt({
            prompt: "Delegate the inspection.",
            promptSlotBinding: directPromptSlotBinding,
          });

          const parentState = await readHarnessRunState(
            join(artifactRoot, runId, "run-state.json"),
          );
          const childState = await readHarnessRunState(
            join(artifactRoot, `${runId}.subagent.1`, "run-state.json"),
          );

          expect(result.taskOutcome?.outcome).toBe("gave-up");

          // The parent's own record is the projection its session config
          // resolves; the child's is that record and says where it came from.
          expect(parentState.fabricSessionCfc?.record).toEqual(
            harnessFabricSessionPosture(SESSION),
          );
          expect(childState.fabricSessionCfc?.record).toEqual({
            ...harnessFabricSessionPosture(SESSION),
            provenance: "inherited",
          });
          expect(childState.fabricSessionCfc?.readMaxConfidentiality).toEqual(
            ceiling,
          );
          // The itemized dials the child records are the parent's too: one
          // session, one set of dials, whichever run reads them.
          expect(childState.fabricSessionCfc?.enforcementMode).toBe(
            parentState.fabricSessionCfc?.enforcementMode,
          );
          expect(childState.fabricSessionCfc?.flowLabels).toBe(
            parentState.fabricSessionCfc?.flowLabels,
          );
          expect(childState.fabricSessionCfc?.posture).toBe("max-enforcement");
          expect(parentState.subagentRuns?.[0].manifest).toMatchObject({
            confidentialityCeiling: {
              source: "parent",
              mode: ceiling === undefined ? "owner-view" : "bounded",
            },
          });
        } finally {
          await Deno.remove(artifactRoot, { recursive: true });
        }
      },
    );
  }
});
