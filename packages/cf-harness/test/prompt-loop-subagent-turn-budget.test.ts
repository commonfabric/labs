/**
 * A delegated child spends its own model-turn budget. The parent's remaining
 * turns are not an input to it: a parent that delegates on its last available
 * turn still gets a child that runs to its own limit.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { DEFAULT_SUBAGENT_MAX_MODEL_TURNS } from "../src/contracts/subagent.ts";
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
      kind: "runsc-cfc",
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

const bashCallTurn = (id: string, command: string) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) },
      }],
    },
  }],
});

const delegateCallTurn = (id: string, input: Record<string, unknown>) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name: "delegate_task", arguments: JSON.stringify(input) },
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

interface DelegateTaskOutput {
  type: string;
  subagent: {
    status: string;
    modelTurns: number;
    runState: { status: string; terminalReason?: string };
    manifest: { maxModelTurns: number };
  };
}

/**
 * The prompt that starts the run, bound as a direct command. A tool call made
 * under this binding is authorized at every enforcement rung.
 */
const directPromptSlotBinding = directPromptSlotBindingFor(
  "subagent-turn-budget",
);

/**
 * The parent script: one turn spent on a `bash` call, then a `delegate_task`
 * call on the parent's last available turn under `maxModelTurns: 2`.
 */
const parentTurns = (delegateInput: Record<string, unknown>) => [
  bashCallTurn("call-parent-warmup", "echo warmup"),
  delegateCallTurn("call-delegate", delegateInput),
];

/** A child script of five `bash` turns followed by a final text turn. */
const childTurns = () => [
  ...Array.from(
    { length: 5 },
    (_value, index) => bashCallTurn(`call-child-${index + 1}`, "echo child"),
  ),
  finalTurn("Child done."),
];

/**
 * Runs a parent loop capped at two model turns whose second turn delegates,
 * and returns the `delegate_task` output the child produced. The parent
 * itself always ends at its turn limit, which is the condition under test.
 */
const delegateOutputFromExhaustedParent = async (options: {
  runId: string;
  delegateInput: Record<string, unknown>;
  childPayloads: readonly unknown[];
}): Promise<DelegateTaskOutput> => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: options.runId,
    model: "gpt-5.4",
  });
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    maxModelTurns: 2,
    fetchFn: scriptedFetch([
      ...parentTurns(options.delegateInput),
      ...options.childPayloads,
    ]),
  });
  const outputs: DelegateTaskOutput[] = [];

  await expect(loop.runPrompt({
    prompt: "Delegate the inspection.",
    promptSlotBinding: directPromptSlotBinding,
    onTranscriptEvent: ({ message }) => {
      if (
        message.role === "tool" &&
        message.content.includes("cf-harness.delegate-task-output")
      ) {
        outputs.push(JSON.parse(message.content) as DelegateTaskOutput);
      }
    },
  })).rejects.toThrow("exceeded max model turns (2)");

  expect(outputs.length).toBe(1);
  return outputs[0]!;
};

describe("prompt-loop subagent turn budget", () => {
  it("runs a child to its own final turn when the parent delegates on its last turn", async () => {
    const output = await delegateOutputFromExhaustedParent({
      runId: "run-subagent-budget-explicit",
      delegateInput: {
        goal: "Inspect the workspace and report.",
        maxModelTurns: 8,
      },
      childPayloads: childTurns(),
    });

    expect(output.subagent.modelTurns).toBe(6);
    expect(output.subagent.status).toBe("completed");
    expect(output.subagent.runState.status).toBe("completed");
    expect(output.subagent.manifest.maxModelTurns).toBe(8);
  });

  it("runs a child on the profile default budget to its own final turn when the parent delegates on its last turn", async () => {
    const output = await delegateOutputFromExhaustedParent({
      runId: "run-subagent-budget-default",
      delegateInput: { goal: "Inspect the workspace and report." },
      childPayloads: childTurns(),
    });

    expect(output.subagent.modelTurns).toBe(6);
    expect(output.subagent.status).toBe("completed");
    expect(output.subagent.runState.status).toBe("completed");
    expect(output.subagent.manifest.maxModelTurns).toBe(
      DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
    );
  });

  it("stops a child at the budget the delegation named, not at the parent's", async () => {
    const output = await delegateOutputFromExhaustedParent({
      runId: "run-subagent-budget-child-limit",
      delegateInput: {
        goal: "Inspect the workspace and report.",
        maxModelTurns: 3,
      },
      childPayloads: childTurns(),
    });

    expect(output.subagent.modelTurns).toBe(3);
    expect(output.subagent.status).toBe("failed");
    expect(output.subagent.runState.status).toBe("failed");
    expect(output.subagent.runState.terminalReason).toBe("max_model_turns");
  });
});
