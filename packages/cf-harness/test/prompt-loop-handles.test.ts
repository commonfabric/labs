/**
 * Wiring of the session-local handle table into the prompt loop: address
 * occurrences in model-bound tool output become tokens, tokens in model-
 * written tool input resolve back to addresses, and sealed structured-return
 * strings that name addresses come back as tokens.
 */

import { decodeBase64 } from "@std/encoding/base64";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { type Cell, isCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { HarnessArtifactStore } from "../src/artifacts.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
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

const ONE_PIXEL_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
);

const HASH_A = "A".repeat(43);
const HASH_B = "B".repeat(43);
const URI_A = `of:fid1:${HASH_A}`;
const LINK_B = `/of:fid1:${HASH_B}/items/0`;

class FakeSandboxRuntime implements SandboxRuntime {
  readonly shellRequests: SandboxShellRequest[] = [];

  readonly #shellResults: SandboxCommandResult[];

  constructor(shellResults: SandboxCommandResult[] = []) {
    this.#shellResults = shellResults;
  }

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
    this.shellRequests.push(request);
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve(
      this.#shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

/** Artifact store that records tool outputs in memory, touching no disk. */
class RecordingArtifactStore implements HarnessArtifactStore {
  readonly artifactRoot = "/artifacts";
  readonly runRoot: string;
  readonly toolOutputs: Array<{
    toolId: string;
    outputId: string;
    output: unknown;
  }> = [];

  constructor(runId: string) {
    this.runRoot = `${this.artifactRoot}/${runId}`;
  }

  persistRunState(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-state.json`);
  }

  persistTranscript(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/transcript.json`);
  }

  persistCapabilitySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/capabilities.json`);
  }

  persistCfcPolicySnapshot(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/policy-snapshot.json`);
  }

  persistRunReport(): Promise<string> {
    return Promise.resolve(`${this.runRoot}/run-report.json`);
  }

  persistToolOutput(
    toolId: string,
    outputId: string,
    output: unknown,
  ): Promise<string> {
    this.toolOutputs.push({ toolId, outputId, output });
    return Promise.resolve(
      `${this.runRoot}/tool-outputs/${outputId}-${toolId}.json`,
    );
  }
}

/**
 * Scripts the model side of a run: each call to the returned fetch function
 * consumes the next payload, recording the parsed request body.
 */
const scriptedFetch = (
  payloads: readonly unknown[],
  requestBodies: unknown[] = [],
): typeof fetch =>
(_input, init) => {
  requestBodies.push(JSON.parse(String(init?.body)));
  const payload = payloads[requestBodies.length - 1];
  if (payload === undefined) {
    throw new Error("scripted fetch ran out of payloads");
  }
  return Promise.resolve(
    new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
      status: 200,
    }),
  );
};

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

const finalTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

/** The model-bound tool message nearest the end of `transcript`. */
const lastToolMessageContent = (
  transcript: readonly { role: string; content?: string }[],
): string => {
  const message = transcript.at(-2);
  if (message?.role !== "tool" || typeof message.content !== "string") {
    throw new Error("expected a tool message before the final response");
  }
  return message.content;
};

describe("prompt-loop address handles", () => {
  it("replaces addresses in the model-bound tool output with tokens while artifacts and run state keep the raw forms", async () => {
    const runId = "run-handles-outbound";
    const expectedTokenA =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_A)).token;
    const expectedTokenB =
      (await mintAddressHandle(createHarnessHandleTable(runId), LINK_B)).token;
    const artifactStore = new RecordingArtifactStore(runId);
    const stdout = `uri ${URI_A} and link ${LINK_B} in prose`;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout, stderr: "", exitCode: 0 },
        ]),
        artifactStore,
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat refs.txt"),
        finalTurn("Done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Read the refs." });

    const toolContent = lastToolMessageContent(result.transcript);
    expect(toolContent).toContain(expectedTokenA);
    expect(toolContent).toContain(expectedTokenB);
    expect(toolContent).not.toContain(HASH_A);
    expect(toolContent).not.toContain(HASH_B);
    const persisted = JSON.stringify(artifactStore.toolOutputs[0]?.output);
    expect(persisted).toContain(URI_A);
    expect(persisted).toContain(LINK_B);
    expect(persisted).not.toContain("cfh:a:");
    expect(result.runState.handleTable?.salt).toBe(runId);
    expect(
      result.runState.handleTable?.entries.map((entry) => entry.token).sort(),
    ).toEqual([expectedTokenA, expectedTokenB].sort());
  });

  it("resolves a token in the next turn's tool input to the canonical address before dispatch", async () => {
    const runId = "run-handles-inbound";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const sandbox = new FakeSandboxRuntime([
      { stdout: `see ${URI_A}`, stderr: "", exitCode: 0 },
      { stdout: "ok", stderr: "", exitCode: 0 },
    ]);
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: sandbox,
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat a.txt"),
        bashCallTurn("call-2", `cf cell get ${minted.token}`),
        finalTurn("Done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Read then fetch." });

    // The bash tool prefixes the model-written command with cwd-marker shell
    // lines, so we match on the command's own text.
    const dispatched = sandbox.shellRequests.find((request) =>
      request.command.includes("cf cell get ")
    );
    expect(dispatched?.command).toContain(
      `cf cell get ${minted.table.entries[0]?.ref}`,
    );
    expect(dispatched?.command).not.toContain(minted.token);
  });

  it("returns the same token when the same address appears in two tool outputs", async () => {
    const runId = "run-handles-stable";
    const expectedToken =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_A)).token;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: `first ${URI_A}`, stderr: "", exitCode: 0 },
          { stdout: `second ${URI_A}`, stderr: "", exitCode: 0 },
        ]),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat a.txt"),
        bashCallTurn("call-2", "cat b.txt"),
        finalTurn("Done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Read both files." });

    const toolMessages = result.transcript.filter((
      message,
    ): message is typeof message & { content: string } =>
      message.role === "tool"
    );
    expect(toolMessages.length).toBe(2);
    for (const message of toolMessages) {
      expect(message.content).toContain(expectedToken);
      expect(message.content).not.toContain(HASH_A);
    }
    expect(result.runState.handleTable?.entries.length).toBe(1);
  });

  it("passes a token in a `delegate_task` goal to the child verbatim", async () => {
    const runId = "run-handles-delegate";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(minted.table);
    const requestBodies: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-delegate",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: `Inspect ${minted.token} and report.`,
                  }),
                },
              }],
            },
          }],
        },
        finalTurn("Child done."),
        finalTurn("Parent done."),
      ], requestBodies as unknown[]),
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const childUserPrompt =
      chatViewOfRequest(requestBodies[1]).messages[1]?.content ?? "";
    expect(childUserPrompt).toContain(minted.token);
    expect(childUserPrompt).not.toContain(HASH_A);
  });

  it("passes a token in a `delegate_task` return-schema property NAME to the child verbatim", async () => {
    // The exclusion covers the whole `delegate_task` input, keys included: a
    // child holds its own handle table, so a parent token resolved into an
    // address on the way past would hand the child a raw address to key its
    // return by.
    const runId = "run-handles-delegate-key";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(minted.table);
    const requestBodies: Array<{
      messages: Array<{ role: string; content: string }>;
    }> = [];
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-delegate",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: "Inspect and report.",
                    returnSchema: {
                      type: "object",
                      properties: { [minted.token]: { type: "string" } },
                    },
                  }),
                },
              }],
            },
          }],
        },
        finalTurn('{"' + minted.token + '": "done"}'),
        finalTurn("Parent done."),
      ], requestBodies as unknown[]),
    });

    await loop.runPrompt({ prompt: "Delegate the inspection." });

    const childUserPrompt =
      chatViewOfRequest(requestBodies[1]).messages[1]?.content ?? "";
    expect(childUserPrompt).toContain(minted.token);
    expect(childUserPrompt).not.toContain(HASH_A);
  });

  it("keeps a raw address out of the view_image tool and followup messages when a token resolves inside the path", async () => {
    const runId = "run-handles-view-image";
    const workspace = await Deno.realPath(await Deno.makeTempDir());
    const refDir = URI_A;
    await Deno.mkdir(join(workspace, refDir));
    await Deno.writeFile(join(workspace, refDir, "capture.png"), ONE_PIXEL_PNG);
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      workspaceHostPath: workspace,
      runId,
      model: "gpt-5.4",
      // `view_image` is a read, which this rung admits without direct-command
      // authorization; the assertions below read the tool's own result, so
      // the tool has to have run.
      cfcEnforcementMode: "enforce-explicit",
    });
    await engine.recordHandleTable(minted.table);
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-image",
                type: "function",
                function: {
                  name: "view_image",
                  arguments: JSON.stringify({
                    path: `/workspace/${minted.token}/capture.png`,
                  }),
                },
              }],
            },
          }],
        },
        finalTurn("Done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Look at the capture." });

    const toolMessage = result.transcript.at(-3);
    if (toolMessage?.role !== "tool") {
      throw new Error("expected a view_image tool message");
    }
    // Success proves the token resolved to the real address before dispatch:
    // the tool found the image inside the referent-named directory.
    expect(JSON.parse(toolMessage.content).imageAttached).toBe(true);
    expect(toolMessage.content).toContain("cfh:a:");
    expect(toolMessage.content).not.toContain(HASH_A);
    const followup = result.transcript.at(-2);
    if (followup?.role !== "user" || typeof followup.content !== "string") {
      throw new Error("expected a view_image followup user message");
    }
    expect(followup.content).toContain("cfh:a:");
    expect(followup.content).not.toContain(HASH_A);
  });

  it("returns a sealed structured-return string that names an address as a token while a free-form string stays opaque", async () => {
    const runId = "run-handles-post";
    const childRunId = `${runId}.subagent.1`;
    const expectedToken =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_A)).token;
    const returnSchema = {
      type: "object",
      properties: {
        link: { type: "string" },
        note: { type: "string" },
      },
      required: ["link", "note"],
      additionalProperties: false,
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-structured",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: "Find the cell.",
                    returnSchema,
                  }),
                },
              }],
            },
          }],
        },
        finalTurn(JSON.stringify({ link: URI_A, note: "free-form prose" })),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the lookup." });

    const output = JSON.parse(lastToolMessageContent(result.transcript)) as {
      subagent: {
        structuredReturn: { value: unknown; linkedStringCount: number };
      };
    };
    expect(output.subagent.structuredReturn.value).toEqual({
      link: expectedToken,
      note: { "@link": `opaque:${childRunId}#/note` },
    });
    expect(output.subagent.structuredReturn.linkedStringCount).toBe(1);
    expect(
      result.runState.handleTable?.entries.map((entry) => entry.token),
    ).toEqual([expectedToken]);
  });

  it("aligns sealed positions with their raw counterparts across nested arrays and objects in a structured return", async () => {
    const runId = "run-handles-tandem";
    const childRunId = `${runId}.subagent.1`;
    const expectedTokenA =
      (await mintAddressHandle(createHarnessHandleTable(runId), URI_A)).token;
    const expectedTokenB =
      (await mintAddressHandle(createHarnessHandleTable(runId), LINK_B)).token;
    const entrySchema = {
      type: "object",
      properties: {
        link: { type: "string" },
        note: { type: "string" },
      },
      required: ["link", "note"],
      additionalProperties: false,
    };
    const returnSchema = {
      type: "object",
      properties: {
        items: { type: "array", items: entrySchema },
        meta: {
          type: "object",
          properties: { primary: { type: "string" } },
          required: ["primary"],
          additionalProperties: false,
        },
      },
      required: ["items", "meta"],
      additionalProperties: false,
    };
    const childReturn = {
      items: [
        { link: URI_A, note: "free-form one" },
        { link: "free-form two", note: LINK_B },
      ],
      meta: { primary: URI_A },
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-tandem",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: "Find the cells.",
                    returnSchema,
                  }),
                },
              }],
            },
          }],
        },
        finalTurn(JSON.stringify(childReturn)),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the lookup." });

    const output = JSON.parse(lastToolMessageContent(result.transcript)) as {
      subagent: {
        structuredReturn: { value: unknown; linkedStringCount: number };
      };
    };
    expect(output.subagent.structuredReturn.value).toEqual({
      items: [
        {
          link: expectedTokenA,
          note: { "@link": `opaque:${childRunId}#/items/0/note` },
        },
        {
          link: { "@link": `opaque:${childRunId}#/items/1/link` },
          note: expectedTokenB,
        },
      ],
      meta: { primary: expectedTokenA },
    });
    // Five sealed string positions, three of which became tokens.
    expect(output.subagent.structuredReturn.linkedStringCount).toBe(2);
    expect(
      result.runState.handleTable?.entries.map((entry) => entry.token).sort(),
    ).toEqual([expectedTokenA, expectedTokenB].sort());
  });

  it("keeps a record sealed wholesale as an opaque link and passes a number through unchanged in a structured return", async () => {
    const runId = "run-handles-sealed-record";
    const childRunId = `${runId}.subagent.1`;
    // `payload` declares only `name` while opting in to free-form keys, so a
    // returned record carrying an undeclared key validates but is sealed
    // wholesale: the sealed position's raw counterpart is a whole record, not
    // a string, and no token is minted even though the record holds an
    // address.
    const returnSchema = {
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: true,
        },
        count: { type: "number" },
      },
      required: ["payload", "count"],
      additionalProperties: false,
    };
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        {
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-sealed-record",
                type: "function",
                function: {
                  name: "delegate_task",
                  arguments: JSON.stringify({
                    goal: "Find the cell.",
                    returnSchema,
                  }),
                },
              }],
            },
          }],
        },
        finalTurn(JSON.stringify({
          payload: { name: URI_A, extra: "surprise" },
          count: 7,
        })),
        finalTurn("Parent done."),
      ]),
    });

    const result = await loop.runPrompt({ prompt: "Delegate the lookup." });

    const output = JSON.parse(lastToolMessageContent(result.transcript)) as {
      subagent: {
        structuredReturn: { value: unknown; linkedStringCount: number };
      };
    };
    expect(output.subagent.structuredReturn.value).toEqual({
      payload: { "@link": `opaque:${childRunId}#/payload` },
      count: 7,
    });
    expect(output.subagent.structuredReturn.linkedStringCount).toBe(0);
    expect(result.runState.handleTable?.entries ?? []).toEqual([]);
  });

  it("reuses the rehydrated table on resume, re-swapping to the same token and resolving it inbound", async () => {
    const runId = "run-handles-resume";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const firstLoop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: `see ${URI_A}`, stderr: "", exitCode: 0 },
        ]),
        runId,
        model: "gpt-5.4",
        cfcEnforcementMode: "disabled",
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", "cat a.txt"),
        finalTurn("First run done."),
      ]),
    });
    const firstResult = await firstLoop.runPrompt({ prompt: "Read the ref." });
    expect(firstResult.runState.handleTable?.entries.length).toBe(1);

    const resumedSandbox = new FakeSandboxRuntime([
      { stdout: `again ${URI_A}`, stderr: "", exitCode: 0 },
      { stdout: "ok", stderr: "", exitCode: 0 },
    ]);
    const resumedLoop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine: new CfHarnessEngine({
        sandboxRuntime: resumedSandbox,
        runState: firstResult.runState,
      }),
      fetchFn: scriptedFetch([
        bashCallTurn("call-2", "cat a.txt"),
        bashCallTurn("call-3", `cf cell get ${minted.token}`),
        finalTurn("Resumed run done."),
      ]),
    });
    const resumedResult = await resumedLoop.runTranscript({
      transcript: [...firstResult.transcript, {
        role: "user",
        content: "Read it again, then fetch it.",
      }],
      model: "gpt-5.4",
    });

    const toolMessages = resumedResult.transcript.filter((
      message,
    ): message is typeof message & { content: string } =>
      message.role === "tool"
    );
    const reswapped = toolMessages.at(-2);
    expect(reswapped?.content).toContain(minted.token);
    expect(reswapped?.content).not.toContain(HASH_A);
    expect(resumedResult.runState.handleTable?.entries.length).toBe(1);
    const dispatched = resumedSandbox.shellRequests.find((request) =>
      request.command.includes("cf cell get ")
    );
    expect(dispatched?.command).toContain(
      `cf cell get ${minted.table.entries[0]?.ref}`,
    );
    expect(dispatched?.command).not.toContain(minted.token);
  });

  it("passes a token abutting alphabet characters through inbound substitution untouched", async () => {
    const runId = "run-handles-adjacency";
    const minted = await mintAddressHandle(
      createHarnessHandleTable(runId),
      URI_A,
    );
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId,
      model: "gpt-5.4",
      cfcEnforcementMode: "disabled",
    });
    await engine.recordHandleTable(minted.table);
    const sandbox = engine.sandbox as FakeSandboxRuntime;
    const command = `note ${minted.token}abc end`;
    const loop = new CfHarnessPromptLoop({
      apiKey: "test-key",
      engine,
      fetchFn: scriptedFetch([
        bashCallTurn("call-1", command),
        finalTurn("Done."),
      ]),
    });

    await loop.runPrompt({ prompt: "Note it down." });

    const dispatched = sandbox.shellRequests.find((request) =>
      request.command.includes("note ")
    );
    expect(dispatched?.command).toContain(command);
  });

  it("carries a `run_pattern` result ref to the model as a token and resolves that token in the next call's input back to the ref", async () => {
    const runId = "run-handles-run-pattern";
    const signer = await Identity.fromPassphrase("run-pattern handles");
    const storageManager = StorageManager.emulate({ as: signer });
    const fabricRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      fabricRuntime,
    );
    await pieces.synced();
    try {
      // Record each deployment so the second call's converted input — the
      // cell the tool resolved from the substituted ref — is observable.
      // The tool persists through `runPersistent`, the single path that
      // creates a piece.
      const created: Array<{
        input: Record<string, unknown> | undefined;
        piece: Cell<unknown>;
      }> = [];
      const originalRunPersistent = pieces.runPersistent.bind(pieces);
      pieces.runPersistent = (async (
        ...args: Parameters<PiecesController["runPersistent"]>
      ) => {
        const piece = await originalRunPersistent(...args);
        created.push({
          input: args[1] as Record<string, unknown> | undefined,
          piece,
        });
        return piece;
      }) as PiecesController["runPersistent"];
      const doublingSource = [
        "import { computed, pattern } from 'commonfabric';",
        "export default pattern<{ n: number }, { doubled: number }>(",
        "  ({ n }) => ({ doubled: computed(() => n * 2) }),",
        ");",
      ].join("\n");
      const echoSource = [
        "import { computed, pattern } from 'commonfabric';",
        "interface Source { doubled: number; }",
        "export default pattern<{ src: Source }, { copied: number }>(",
        "  ({ src }) => ({ copied: computed(() => src.doubled) }),",
        ");",
      ].join("\n");
      const runPatternTurn = (
        id: string,
        args: Record<string, unknown>,
      ) => ({
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id,
              type: "function",
              function: {
                name: "run_pattern",
                arguments: JSON.stringify(args),
              },
            }],
          },
        }],
      });
      // The second call's argument depends on the token minted during the
      // run, so the model side is scripted dynamically off the request
      // transcript rather than as fixed payloads.
      const requestBodies: unknown[] = [];
      let firstToolContent: string | undefined;
      const fetchFn: typeof fetch = (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const turn = requestBodies.length;
        let payload: unknown;
        if (turn === 1) {
          payload = runPatternTurn("call-1", {
            sourceText: doublingSource,
            inputs: { n: 3 },
            resultSchema: {
              type: "object",
              properties: { doubled: { type: "number" } },
            },
          });
        } else if (turn === 2) {
          const chat = chatViewOfRequest(requestBodies[1]);
          const toolMessage = [...chat.messages].reverse().find(
            (message) => message.role === "tool",
          );
          firstToolContent = toolMessage?.content ?? "";
          const token =
            (JSON.parse(firstToolContent) as { resultRef: string }).resultRef;
          payload = runPatternTurn("call-2", {
            sourceText: echoSource,
            inputs: { src: token },
          });
        } else {
          payload = finalTurn("Done.");
        }
        return Promise.resolve(
          new Response(JSON.stringify(responsesBodyFromChatFixture(payload)), {
            status: 200,
          }),
        );
      };
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId,
          model: "gpt-5.4",
          cfcEnforcementMode: "disabled",
          fabricSessionFactory: () => Promise.resolve({ pieces }),
        }),
        fetchFn,
      });

      await loop.runPrompt({ prompt: "Run the pattern twice." });

      // Outbound: the model-facing tool message carries a token where the
      // ref would be, and no raw address, raw result value, or bare piece
      // id.
      const firstOutput = JSON.parse(firstToolContent!) as {
        resultRef: string;
        value: { doubled: number };
      };
      expect(firstOutput.resultRef).toMatch(/^cfh:a:/);
      expect(firstToolContent).not.toContain("of:");
      expect(firstToolContent).not.toContain("fid1:");
      expect(firstOutput.value.doubled).toBe(6);
      expect(firstOutput).not.toHaveProperty("rawValue");
      expect(firstOutput).not.toHaveProperty("pieceId");
      // Inbound: the token the model wrote came back to the tool as the
      // canonical ref, which the tool converted to a live cell aimed at the
      // first piece's result — with zero handle code in the tool itself.
      expect(created.length).toBe(2);
      const src = created[1]?.input?.src;
      expect(isCell(src)).toBe(true);
      const firstResult = await new PieceController(pieces, created[0]!.piece)
        .result.getCell();
      expect((src as Cell<unknown>).getAsNormalizedFullLink().id).toBe(
        firstResult.getAsNormalizedFullLink().id,
      );
    } finally {
      await fabricRuntime.dispose();
      await storageManager.close();
    }
  });
});
