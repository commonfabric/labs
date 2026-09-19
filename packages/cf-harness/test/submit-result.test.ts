/**
 * `submit_result`: the host-side way a run hands back its structured result.
 *
 * A run whose task is bound to the prompt-slot role `context` is refused every
 * sandbox tool under the enforcing modes, so it cannot write the structured
 * result file itself. The tool takes the value as its input, validates it, and
 * the host writes the file the file-based path would have left.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  type PromptSlotBinding,
} from "../src/contracts/prompt-slot.ts";
import {
  parentToolIdsForBacking,
  withheldToolIds,
} from "../src/contracts/tool-descriptor.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { submitResultTool } from "../src/tools/submit-result.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";

// A pattern's task text: context for the run, not an operator's command.
const contextPromptSlotBinding: PromptSlotBinding = {
  type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
  source: { type: "test.prompt-slot", subject: "submit-result" },
  role: "context",
  kernelName: "cf-harness",
  surface: "test",
  subject: "submit-result",
  eventId: "event-submit-result",
};

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    source: { type: "string" },
  },
  required: ["answer"],
  additionalProperties: false,
} as const;

const NO_BACKING = {
  fabricSessionAvailable: false,
  patternIndexAvailable: false,
  skillsShSearchAvailable: false,
  skillsShAcquisitionAvailable: false,
  skillRegistryAvailable: false,
  docsCorpusAvailable: false,
};

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
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const toolCallTurn = (
  id: string,
  name: string,
  argumentsText: string,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: argumentsText },
      }],
    },
  }],
});

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

const scriptedFetch = (
  payloads: readonly unknown[],
  requestCount: { value: number },
  offeredTools: string[][] = [],
): typeof fetch =>
async (_input, init) => {
  offeredTools.push(
    chatViewOfRequest(JSON.parse(String(init?.body ?? "{}"))).tools,
  );
  const payload = payloads[requestCount.value];
  requestCount.value += 1;
  if (payload === undefined) {
    throw new Error("scripted fetch ran out of payloads");
  }
  return await Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
      status: 200,
    }),
  );
};

/** Every tool message's parsed content, in order. */
const toolOutputs = (
  transcript: readonly { role: string; content?: string }[],
): Record<string, unknown>[] =>
  transcript.filter((message) => message.role === "tool").map((message) =>
    JSON.parse(message.content ?? "{}")
  );

describe("submit_result", () => {
  let dir: string;
  let resultPath: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "submit-result-test-" });
    resultPath = join(dir, "workspace", "result.json");
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  /** Runs `turns` under the `context` role at the default enforcement mode. */
  const run = async (
    runId: string,
    turns: readonly unknown[],
    options: { schema?: boolean; allowedToolIds?: string[] } = {},
  ) => {
    const offeredTools: string[][] = [];
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      ...(options.schema === false ? {} : {
        structuredResult: { schema: RESULT_SCHEMA, path: resultPath },
      }),
    });
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      ...(options.allowedToolIds !== undefined
        // deno-lint-ignore no-explicit-any
        ? { allowedToolIds: options.allowedToolIds as any }
        : {}),
      fetchFn: scriptedFetch(turns, { value: 0 }, offeredTools),
    });
    const result = await loop.runPrompt({
      prompt: "Recommend a book.",
      promptSlotBinding: contextPromptSlotBinding,
    });
    return { result, offeredTools, engine };
  };

  const submit = (id: string, result: unknown) =>
    toolCallTurn(id, "submit_result", JSON.stringify({ result }));

  it("is withheld from a run that configures no structured-result schema", async () => {
    expect(withheldToolIds(NO_BACKING).has("submit_result")).toBe(true);
    expect(parentToolIdsForBacking(NO_BACKING)).not.toContain("submit_result");
    expect(
      parentToolIdsForBacking({
        ...NO_BACKING,
        structuredResultAvailable: true,
      }),
    ).toContain("submit_result");

    const { result, offeredTools } = await run("run-no-schema", [
      submit("call-1", { answer: "Hyperion" }),
      finalTurn("Done."),
    ], { schema: false, allowedToolIds: ["submit_result", "describe_handle"] });

    expect(offeredTools[0]).not.toContain("submit_result");
    // A tool outside the run's surface is refused as not allowed.
    expect(toolOutputs(result.transcript)[0]).toMatchObject({
      type: "cf-harness.observation-denied",
    });
    await expect(Deno.stat(resultPath)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("offers the tool when a schema is configured, under an explicit allowlist too", async () => {
    const byDefault = await run("run-offered", [finalTurn("Done.")]);
    const allowlisted = await run("run-offered-allowlist", [
      finalTurn("Done."),
    ], { allowedToolIds: ["describe_handle", "submit_result"] });

    expect(byDefault.offeredTools[0]).toContain("submit_result");
    expect(allowlisted.offeredTools[0]).toEqual([
      "describe_handle",
      "submit_result",
    ]);
  });

  it("records a valid submission as the structured result, under the `context` role at `enforce-strict`", async () => {
    const { result, engine } = await run("run-valid", [
      submit("call-1", { answer: "Hyperion" }),
      finalTurn("Done."),
    ]);

    expect(engine.getRunState().cfcEnforcementMode).toBe("enforce-strict");
    expect(toolOutputs(result.transcript)[0]).toMatchObject({
      status: "ok",
      replaced: false,
    });
    expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
      answer: "Hyperion",
    });
  });

  it("still refuses the same run a sandbox tool", async () => {
    const { result } = await run("run-bash-refused", [
      toolCallTurn("call-1", "bash", JSON.stringify({ command: "true" })),
      finalTurn("Done."),
    ]);

    expect(toolOutputs(result.transcript)[0]).toMatchObject({
      type: "cf-harness.observation-denied",
      reason: "not-authorized",
    });
  });

  it("returns a typed validation error, writes nothing, and takes a corrected resubmission", async () => {
    const { result } = await run("run-invalid-then-valid", [
      submit("call-1", { answer: 7 }),
      submit("call-2", { answer: "Hyperion" }),
      finalTurn("Done."),
    ]);

    const [refused, accepted] = toolOutputs(result.transcript);
    expect(refused).toMatchObject({ status: "error", code: "invalid_result" });
    expect(typeof refused.message).toBe("string");
    expect(accepted).toMatchObject({ status: "ok", replaced: false });
    expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
      answer: "Hyperion",
    });
  });

  it("leaves no file behind a submission that was only ever invalid", async () => {
    await run("run-only-invalid", [
      submit("call-1", { wrong: true }),
      finalTurn("Done."),
    ]);

    await expect(Deno.stat(resultPath)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("replaces an earlier submission with a later valid one", async () => {
    const { result } = await run("run-replace", [
      submit("call-1", { answer: "Hyperion" }),
      submit("call-2", { answer: "Ubik" }),
      finalTurn("Done."),
    ]);

    expect(toolOutputs(result.transcript)[1]).toMatchObject({
      status: "ok",
      replaced: true,
    });
    expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
      answer: "Ubik",
    });
  });

  it("keeps a handle token in the result a token", async () => {
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: "run-token",
      model: "gpt-5.4",
      structuredResult: { schema: RESULT_SCHEMA, path: resultPath },
    });
    const minted = await mintAddressHandle(
      createHarnessHandleTable("run-token"),
      "/of:fid1:rszomt4Ti8MwDNpMJLZCjcENRtAH6MFBxgf0wYVNCs8/title",
    );
    await engine.recordHandleTable(minted.table);
    const token = minted.token;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        submit("call-1", { answer: "Hyperion", source: token }),
        finalTurn("Done."),
      ], { value: 0 }),
    });

    await loop.runPrompt({
      prompt: "Recommend a book.",
      promptSlotBinding: contextPromptSlotBinding,
    });

    expect(JSON.parse(await Deno.readTextFile(resultPath))).toEqual({
      answer: "Hyperion",
      source: token,
    });
  });

  it("returns `not_configured` when invoked outside a run that takes a result", async () => {
    const output = await submitResultTool.invoke(
      {
        nextOutputId: (toolId: string) =>
          createToolOutputId("run-direct", toolId, 1),
      } as unknown as HarnessToolContext,
      { result: { answer: "Hyperion" } },
    );

    expect(output).toMatchObject({ status: "error", code: "not_configured" });
  });
});
