/**
 * A delegated child's transcript reaches the parent's transcript handler. The
 * parent hands one handler to `runPrompt`, and the child's messages arrive on
 * it tagged with the `delegate_task` call that started the child, so a single
 * activity feed carries both loops in the order they happened.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import type { HarnessTranscriptEvent } from "../src/contracts/transcript.ts";
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
    return Promise.resolve({ stdout: "child output", stderr: "", exitCode: 0 });
  }
}

const toolCallTurn = (
  id: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
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

const GOAL = "Inspect the workspace and report.";

/**
 * The prompt that starts the run, bound as a direct command. A tool call made
 * under this binding is authorized at every enforcement rung.
 */
const directPromptSlotBinding = directPromptSlotBindingFor(
  "subagent-transcript-events",
);

/**
 * Runs a parent that delegates once, and returns every transcript event the
 * parent's handler saw, in order.
 */
const eventsFromDelegatingRun = async (): Promise<HarnessTranscriptEvent[]> => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-subagent-transcript-events",
    model: "gpt-5.4",
  });
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    maxModelTurns: 4,
    // The child's turns are served between the parent's two, because that is
    // the order the two loops call the provider in.
    fetchFn: scriptedFetch([
      toolCallTurn("call-delegate", "delegate_task", {
        goal: GOAL,
        maxModelTurns: 4,
      }),
      toolCallTurn("call-child-bash", "bash", { command: "echo child" }),
      finalTurn("Child done."),
      finalTurn("Parent done."),
    ]),
  });
  const events: HarnessTranscriptEvent[] = [];

  await loop.runPrompt({
    prompt: "Delegate the inspection.",
    promptSlotBinding: directPromptSlotBinding,
    onTranscriptEvent: (event) => {
      events.push(event);
    },
  });
  return events;
};

describe("prompt-loop subagent transcript events", () => {
  it("forwards the child's messages tagged with the delegating tool call", async () => {
    const events = await eventsFromDelegatingRun();

    const childEvents = events.filter((event) => event.subagent !== undefined);
    expect(childEvents.length).toBeGreaterThan(0);
    for (const event of childEvents) {
      expect(event.subagent).toEqual({
        parentToolCallId: "call-delegate",
        childRunId: "run-subagent-transcript-events.subagent.1",
        profile: "default",
        goal: GOAL,
      });
    }

    const childToolResults = childEvents.filter((event) =>
      event.message.role === "tool"
    );
    expect(
      childToolResults.map((event) =>
        event.message.role === "tool" ? event.message.toolName : undefined
      ),
    ).toEqual(["bash"]);
  });

  it("leaves the parent's own messages untagged", async () => {
    const events = await eventsFromDelegatingRun();

    const parentToolResults = events.filter((event) =>
      event.subagent === undefined && event.message.role === "tool"
    );
    expect(
      parentToolResults.map((event) =>
        event.message.role === "tool" ? event.message.toolName : undefined
      ),
    ).toEqual(["delegate_task"]);
  });

  it("delivers every child message before the delegate_task result", async () => {
    const events = await eventsFromDelegatingRun();

    const lastChildIndex = events.findLastIndex((event) =>
      event.subagent !== undefined
    );
    const delegateResultIndex = events.findIndex((event) =>
      event.subagent === undefined && event.message.role === "tool" &&
      event.message.toolName === "delegate_task"
    );
    expect(lastChildIndex).toBeGreaterThanOrEqual(0);
    expect(delegateResultIndex).toBeGreaterThan(lastChildIndex);
  });
});
