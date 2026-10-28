/** Distinct run families and payloads in competing console and runner roots. */

import { join } from "@std/path";
import { createHarnessRunState } from "../../src/run-state.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";

/** Writes a family whose neighbor resolves the same token differently per root. */
export const writeRunRootFixture = async (base: string) => {
  const console = join(base, "console-runs");
  const agentRuns = join(base, "agent-runs");
  const ask = join(agentRuns, "local", "job-1", "artifacts");
  const child = "asked.subagent.1";
  const token = "cfh:a:abcd2";
  const outputName = "payload.json";
  const call = (
    id: string,
    name: string,
    args: unknown,
  ): HarnessTranscriptMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [{
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }],
  });
  const result = (
    id: string,
    name: string,
    content: unknown,
  ): HarnessTranscriptMessage => ({
    role: "tool",
    toolCallId: id,
    toolName: name,
    content: JSON.stringify(content),
  });
  for (
    const [root, marker] of [
      [console, "console-decoy"],
      [join(agentRuns, "local", "job-2", "artifacts"), "ask-decoy"],
      [join(agentRuns, "Key_abc-1", "artifacts"), "agent-decoy"],
      [ask, "selected"],
    ]
  ) {
    for (const runId of ["asked", child, "neighbor"]) {
      const runRoot = join(root, runId);
      await Deno.mkdir(join(runRoot, "tool-outputs"), { recursive: true });
      // Stateless console files must not shadow a valid /ask family.
      if (root !== console || runId === "neighbor") {
        await Deno.writeTextFile(
          join(runRoot, "run-state.json"),
          JSON.stringify({
            ...createHarnessRunState({
              runId,
              currentDir: "/workspace",
              cfcEnforcementMode: "observe",
              now: "2026-01-01T00:00:00.000Z",
            }),
            ...(runId === "neighbor"
              ? {
                handleTable: {
                  type: "cf-harness.handle-table",
                  version: 1,
                  salt: marker,
                  entries: [{
                    token,
                    kind: "address",
                    ref: `/of:fid1:${marker}`,
                    addressKey: `/of:fid1:${marker}`,
                  }],
                },
              }
              : {}),
          }),
        );
      }
      const transcript: HarnessTranscriptMessage[] = runId === "asked"
        ? [
          { role: "user", content: `${marker} parent` },
          call("parent-pattern", "run_pattern", {
            patternId: `${marker}-parent`,
            inputs: { data: token },
          }),
          result("parent-pattern", "run_pattern", { status: "ok" }),
          call("delegate", "delegate_task", { task: "child task" }),
          result("delegate", "delegate_task", {
            status: "ok",
            subagent: { childRunId: child, status: "completed" },
          }),
        ]
        : runId === child
        ? [
          { role: "user", content: `${marker} child` },
          call("child-pattern", "run_pattern", {
            patternId: `${marker}-child`,
            inputs: { data: token },
          }),
          result("child-pattern", "run_pattern", { status: "ok" }),
        ]
        : [];
      await Deno.writeTextFile(
        join(runRoot, "transcript.json"),
        JSON.stringify(transcript),
      );
      await Deno.writeTextFile(
        join(runRoot, "tool-outputs", outputName),
        JSON.stringify({ marker, runId }),
      );
    }
  }
  return { roots: { console, agentRuns }, ask, child, token, outputName };
};
