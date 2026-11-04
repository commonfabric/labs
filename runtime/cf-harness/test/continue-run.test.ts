/**
 * Batch follow-ups retain checkpoint history and explicit authority under a new
 * run id. Scripted model requests and on-disk artifacts expose both sides of
 * the boundary; the predecessor's files must remain unchanged.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { decodeBase64 } from "@std/encoding/base64";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  buildCfHarnessBatchSystemPrompt,
  resolveCfHarnessCliSystemPrompt,
} from "../src/cli.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import { readHarnessRunArtifacts } from "../src/artifacts.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";
import {
  createHarnessHandleTable,
  markHandleDescribed,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import { materializeImageAttachmentContentPart } from "../src/image-attachments.ts";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import { OpenAICompatibleGatewayModelClient } from "../src/model/openai-compatible-gateway.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
  HarnessInteractiveChatService,
} from "../src/interactive-chat-service.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  createHarnessRunState,
  type HarnessRunState,
} from "../src/run-state.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { runCfHarnessCli } from "./support/on-linux.ts";

const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "runsc-cfc",
    defaultWorkingDirectory: "/workspace",
  }),
  defaultWorkingDirectory: () => "/workspace",
  resolvePath: (path) => path,
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};

const history: HarnessTranscriptMessage[] = [
  { role: "system", content: "Prior instructions" },
  { role: "user", content: "Prior task" },
  { role: "assistant", content: "Prior answer" },
];
const unpaired: HarnessTranscriptMessage = {
  role: "assistant",
  content: "",
  toolCalls: [{
    id: "unfinished",
    type: "function",
    function: { name: "read_file", arguments: '{"path":"/workspace/a"}' },
  }],
};

describe("continue-run", () => {
  let workspace: string;
  let priorRoot: string;
  let state: HarnessRunState;
  let requests: HarnessModelTurnRequest[];
  let errors: string[];
  let output: string[];
  let before: Map<string, string>;
  let scripted: HarnessAssistantTranscriptMessage[];
  let structuredHostFailures: boolean;
  let fabric: {
    runtime: Runtime;
    storage: ReturnType<typeof StorageManager.emulate>;
    session: HarnessFabricSession;
  } | undefined;

  const save = async (
    transcript: HarnessTranscriptMessage[] | undefined = history,
  ) => {
    await Deno.writeTextFile(
      join(priorRoot, "run-state.json"),
      JSON.stringify(state),
    );
    if (transcript !== undefined) {
      await Deno.writeTextFile(
        join(priorRoot, "transcript.json"),
        JSON.stringify(transcript),
      );
    }
    before = new Map();
    for await (const entry of Deno.readDir(priorRoot)) {
      if (entry.isFile) {
        before.set(
          entry.name,
          await Deno.readTextFile(join(priorRoot, entry.name)),
        );
      }
    }
  };
  const unchanged = async () => {
    for (const [name, bytes] of before) {
      expect(await Deno.readTextFile(join(priorRoot, name))).toBe(bytes);
    }
  };
  const run = (
    extra: string[] = [],
    root = priorRoot,
    prompt = ["--prompt=Next task"],
  ) =>
    runCfHarnessCli([
      "--continue-run",
      root,
      ...prompt,
      "--max-model-turns=4",
      ...extra,
    ], {
      fetchFn: () => {
        throw new Error("unexpected provider request");
      },
      cwd: workspace,
      structuredHostFailures,
      env: { CF_HARNESS_API_KEY: "test" },
      ...(fabric === undefined
        ? {}
        : { fabricSessionFactory: () => Promise.resolve(fabric!.session) }),
      io: {
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
      },
      createPromptLoop: (options) =>
        new CfHarnessPromptLoop({
          ...options,
          ...(fabric === undefined
            ? {}
            : { allowedToolIds: ["read_value", "describe_handle"] }),
          modelClient: {
            providerId: "openai-compatible-gateway",
            complete: (request) => {
              requests.push({
                ...request,
                transcript: structuredClone(request.transcript),
              });
              return Promise.resolve({
                assistant: scripted.shift() ??
                  { role: "assistant", content: "Next answer" },
              });
            },
          },
          engine: new CfHarnessEngine({
            ...options,
            runState: options.engine?.getRunState(),
            sandboxRuntime: sandbox,
            workspaceHostPath: workspace,
            ...(fabric === undefined ? {} : {
              fabricSessionFactory: () => Promise.resolve(fabric!.session),
            }),
          }),
        }),
    });
  const nextArtifacts = async () => {
    const roots = [];
    for await (
      const entry of Deno.readDir(join(workspace, ".cf-harness-artifacts"))
    ) {
      if (entry.isDirectory && entry.name !== "prior") roots.push(entry.name);
    }
    expect(roots).toHaveLength(1);
    return await readHarnessRunArtifacts(
      join(workspace, ".cf-harness-artifacts", roots[0]),
    );
  };

  const attachmentCells = async () => {
    const signer = await Identity.fromPassphrase("follow-up attachments");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcEnforcementMode: "disabled",
    });
    const pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: signer.did() }),
      runtime,
    );
    fabric = { runtime, storage, session: { pieces } };
    await pieces.synced();
    const tx = runtime.edit();
    const old = runtime.getCell(
      pieces.getSpace(),
      "old-attachment",
      undefined,
      tx,
    );
    const added = runtime.getCell(
      pieces.getSpace(),
      "new-attachment",
      undefined,
      tx,
    );
    old.set("old cell");
    added.set("new cell");
    expect((await tx.commit().settled).ok).toBeDefined();
    const refs = [old, added].map((cell) =>
      createLLMFriendlyLink(cell.getAsNormalizedFullLink(), pieces.getSpace())
    );
    const held = await mintAddressHandle(
      createHarnessHandleTable("prior"),
      refs[0],
      { schema: { type: "string" } },
    );
    state.handleTable = held.table;
    state.inputCells = [{ name: "original", ref: refs[0], token: held.token }];
    return { oldRef: refs[0], newRef: refs[1], oldToken: held.token };
  };

  beforeEach(async () => {
    workspace = await Deno.realPath(await Deno.makeTempDir());
    priorRoot = join(workspace, ".cf-harness-artifacts", "prior");
    await Deno.mkdir(priorRoot, { recursive: true });
    state = createHarnessRunState({
      runId: "prior",
      status: "completed",
      cfcEnforcementMode: "disabled",
      currentDir: "/workspace",
      model: "gpt-recorded",
      artifactRoot: priorRoot,
    });
    state.systemPromptInputs = {
      systemPrompt: "Prior instructions",
    };
    history[0] = {
      role: "system",
      content: resolveCfHarnessCliSystemPrompt({
        ...state.systemPromptInputs,
        outputMode: "operator",
        workspace,
      })!,
    };
    requests = [];
    errors = [];
    output = [];
    scripted = [];
    structuredHostFailures = false;
    await save();
  });
  afterEach(async () => {
    await fabric?.runtime.dispose();
    await fabric?.storage.close();
    fabric = undefined;
    await Deno.remove(workspace, { recursive: true });
  });

  it("attaches a snapshotted follow-up image to the new prompt in the first request", async () => {
    const bytes = decodeBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
    );
    const path = join(workspace, "follow-up.png");
    await Deno.writeFile(path, bytes);
    expect(await run(["--image", path])).toBe(0);
    const prompt = requests[0].transcript.at(-1);
    expect(prompt?.role).toBe("user");
    if (prompt?.role !== "user") throw new Error("missing new user prompt");
    expect(prompt.content).toBe("Next task");
    expect(prompt.imageAttachments).toHaveLength(1);
    const attachment = prompt.imageAttachments![0];
    expect(attachment.snapshotPath?.startsWith(workspace + "/")).toBe(true);
    expect(await Deno.readFile(attachment.snapshotPath!)).toEqual(bytes);
    await Deno.writeFile(path, new Uint8Array([1, 2, 3]));
    expect((await materializeImageAttachmentContentPart(attachment)).type).toBe(
      "image_url",
    );
    expect(
      requests[0].transcript.slice(0, -1).some((message) =>
        message.role === "user" && message.imageAttachments?.length
      ),
    ).toBe(false);
    await unchanged();
  });

  it("adds a follow-up input handle while retaining the prior token and naming records", async () => {
    const refs = await attachmentCells();
    await save();
    expect(await run(["--input-cell", `additional=${refs.newRef}`])).toBe(0);
    const next = await nextArtifacts();
    const added = next.runState.inputCells?.find((cell) =>
      cell.name === "additional"
    );
    expect(added).toBeDefined();
    expect(resolveHandleToken(next.runState.handleTable!, refs.oldToken)?.ref)
      .toBe(refs.oldRef);
    expect(resolveHandleToken(next.runState.handleTable!, added!.token)?.ref)
      .toBe(refs.newRef);
    expect(
      next.runState.inputCells?.find((cell) => cell.name === "original")?.token,
    ).toBe(refs.oldToken);
    const context = requests[0].transcript.filter((message) =>
      message.role === "user" && message.turnLocal
    ).map((message) => message.content).join("\n");
    expect(context).toContain(`${added!.token} — additional`);
    expect(
      await run(["--input-cell", `additional=${refs.oldRef}`], next.runRoot),
    ).toBe(1);
    expect(errors.join("")).toContain("already");
    expect(errors.join("")).toContain("additional");
    expect(requests).toHaveLength(1);
    await unchanged();
  });

  it("refuses a follow-up input name already held before any model request", async () => {
    const refs = await attachmentCells();
    await save();
    expect(await run(["--input-cell", `original=${refs.newRef}`])).toBe(1);
    expect(errors.join("")).toContain("already");
    expect(errors.join("")).toContain("original");
    expect(requests).toHaveLength(0);
    await unchanged();
  });

  for (const source of ["assigned piece", "grant"] as const) {
    it(`refuses an input name held by a prior ${source}`, async () => {
      const refs = await attachmentCells();
      const name = source === "grant" ? "piece-registry" : "assigned-ledger";
      if (source === "grant") {
        state.wellKnownGrants = [{
          name: "piece-registry",
          ref: refs.oldRef,
          token: refs.oldToken,
        }];
      } else state.assignedPieces = [{ slug: name, ref: refs.oldRef }];
      await save();
      expect(await run(["--input-cell", `${name}=${refs.newRef}`])).toBe(1);
      expect(errors.join("")).toContain("already");
      expect(errors.join("")).toContain(name);
      expect(requests).toHaveLength(0);
      await unchanged();
    });
  }

  it("carries assigned pieces and names them as attachments in the first request", async () => {
    const refs = await attachmentCells();
    state.assignedPieces = [{ slug: "assigned-ledger", ref: refs.newRef }];
    await save();
    expect(await run()).toBe(0);
    const next = await nextArtifacts();
    expect(next.runState.assignedPieces).toEqual(state.assignedPieces);
    const assigned = next.runState.inputCells?.find((cell) =>
      cell.name === "assigned-ledger"
    );
    expect(assigned).toBeDefined();
    expect(resolveHandleToken(next.runState.handleTable!, assigned!.token)?.ref)
      .toBe(refs.newRef);
    const context = requests[0].transcript.filter((message) =>
      message.role === "user" && message.turnLocal
    ).map((message) => message.content).join("\n");
    expect(context).toContain(`${assigned!.token} — assigned-ledger`);
    expect(await run([], next.runRoot)).toBe(0);
    const repeatedContext = requests[1].transcript.filter((message) =>
      message.role === "user" && message.turnLocal
    ).map((message) => message.content).join("\n");
    expect(repeatedContext).toContain(`${assigned!.token} — assigned-ledger`);
    await unchanged();
  });

  it("seeds the same durable history as chat with the same prior turn", async () => {
    const chatSeeds: (readonly HarnessTranscriptMessage[])[] = [];
    const service = new HarnessInteractiveChatService({
      systemPrompt: history[0].content,
      createPromptLoop: () => ({
        runTranscript: (options) => {
          chatSeeds.push([...options.transcript]);
          return Promise.resolve({
            model: "gpt-recorded",
            modelTurns: 1,
            finalAssistantText: "Prior answer",
            runState: state,
            transcript: [...options.transcript, {
              role: "assistant" as const,
              content: "Prior answer",
            }],
          });
        },
      }),
    });
    await service.startSession("session", {
      sessionId: "session",
      workspace: { hostPath: workspace },
      model: "gpt-recorded",
    });
    for (
      const [turnId, text] of [["one", "Prior task"], ["two", "Next task"]]
    ) {
      await service.startTurn(turnId, {
        sessionId: "session",
        turnId,
        input: { text },
      });
      await service.waitForTurn("session", turnId);
    }
    expect(await run()).toBe(0);
    const durable = (messages: readonly HarnessTranscriptMessage[]) =>
      messages.filter((message) =>
        message.role !== "user" || !message.turnLocal
      );
    expect(durable(chatSeeds[1])).toEqual(durable(requests[0].transcript));
    expect(
      chatSeeds[1].filter((message) =>
        message.role === "user" && message.turnLocal
      ).length,
    ).toBeGreaterThan(0);
    expect(
      requests[0].transcript.filter((message) =>
        message.role === "user" && message.turnLocal
      ).length,
    ).toBeGreaterThan(0);
  });

  it("creates a new run with predecessor lineage and leaves the predecessor unchanged", async () => {
    expect(await run()).toBe(0);
    const next = await nextArtifacts();
    expect(next.runState.runId).not.toBe("prior");
    expect(next.runState.lineage).toEqual({
      role: "continuation",
      rootRunId: "prior",
      parentRunId: "prior",
    });
    expect(next.runState.status).toBe("completed");
    await unchanged();
  });

  for (const grantMount of [false, true]) {
    it(`advertises a recorded host mount only when the follow-up ${grantMount ? "grants" : "omits"} it`, async () => {
      Object.assign(state.systemPromptInputs!, {
        hostMounts: [{
          name: "archive",
          hostPath: workspace,
          sandboxPath: "/archive",
          mode: "readonly",
        }],
      });
      await save();
      expect(
        await run(
          grantMount
            ? [
              "--host-mount",
              `name=archive,source=${workspace},target=/archive,mode=readonly`,
            ]
            : [],
        ),
      ).toBe(0);
      const system = requests[0].transcript.find((m) =>
        m.role === "system"
      )!.content;
      expect(system.includes("/archive")).toBe(grantMount);
    });
  }

  it("advertises no preloaded skills from the predecessor", async () => {
    Object.assign(state.systemPromptInputs!, {
      skillNames: ["prior-skill"],
      skillCatalogEnabled: true,
    });
    await save();
    expect(await run()).toBe(0);
    const system =
      requests[0].transcript.find((m) => m.role === "system")!.content;
    expect(system).not.toContain("Configured skills guidance:");
    expect(
      requests[0].transcript.some((m) => m.content.includes("<skill_context")),
    ).toBe(false);
  });

  it("uses only the follow-up's tool grants in its prompt and request", async () => {
    Object.assign(state.systemPromptInputs!, {
      allowedToolIds: ["read_file", "finish_task"],
    });
    await save();
    expect(await run(["--allow-tool=read_file"])).toBe(0);
    const system =
      requests[0].transcript.find((m) => m.role === "system")!.content;
    expect(system).not.toContain("Use finish_task to ask");
    expect(system).toContain("Act on reasonable defaults");
    expect(requests[0].tools.map((tool) => tool.toolId)).toEqual(["read_file"]);
  });

  for (const mode of [undefined, "batch"]) {
    it(`uses ${mode ?? "the default operator"} mode for both the continuation prompt and printed output`, async () => {
      Object.assign(state.systemPromptInputs!, { outputMode: "batch" });
      await save([
        {
          role: "system",
          content: buildCfHarnessBatchSystemPrompt({
            systemPrompt: "Prior instructions",
          }),
        },
        ...history.slice(1),
      ]);
      expect(await run(mode === undefined ? [] : ["--output-mode=batch"])).toBe(
        0,
      );
      const system = requests[0].transcript.find((m) =>
        m.role === "system"
      )!.content;
      const printed = output.join("");
      if (mode === undefined) {
        expect(system).toContain("Operator guidance for cf-harness runs");
        expect(printed).toContain("Next answer\n\nrunId:");
        expect(printed).toContain("status: completed");
      } else {
        expect(system).not.toContain("Operator guidance for cf-harness runs");
        expect(printed).toBe("Next answer\n");
      }
      expect((await nextArtifacts()).runState.systemPromptInputs).toEqual({
        systemPrompt: "Prior instructions",
      });
      await unchanged();
    });
  }

  for (const replacement of [undefined, "Replacement components"]) {
    it(`rebuilds a manual continuation with recorded instruction defaults ${replacement === undefined ? "without" : "with"} new instructions`, async () => {
      state.systemPromptInputs = {
        systemPrompt: "Recorded components",
      };
      state.taskClassification = {
        type: "cf-harness.task-classification",
        version: 1,
        tags: ["respond"],
        domains: [],
        path: "caller",
        durationMs: 0,
      };
      state.structuredResult = {
        schema: { type: "string" },
        path: join(workspace, "old-result.json"),
      };
      await Deno.writeTextFile(state.structuredResult.path, '"old"');
      await save([
        { role: "system", content: "Unusable recorded string" },
        ...history.slice(1),
      ]);
      const path = join(workspace, "new-result.json");
      await Deno.writeTextFile(path, '"new"');
      expect(
        await run([
          "--structured-result-path",
          path,
          ...(replacement === undefined
            ? []
            : [`--system-prompt=${replacement}`]),
        ]),
      ).toBe(0);
      const system = requests[0].transcript.find((message) =>
        message.role === "system"
      )!.content;
      expect(system).toContain(
        "You are cf-harness, an autonomous agent harness",
      );
      expect(system).toContain("Operator guidance for cf-harness runs");
      expect(system).toContain("/workspace/new-result.json");
      expect(system).not.toContain("old-result.json");
      expect(system).not.toContain("Unusable recorded string");
      expect(system).toContain(replacement ?? "Recorded components");
      if (replacement !== undefined) {
        expect(system).not.toContain("Recorded components");
      }
      const next = await nextArtifacts();
      expect(next.runState.systemPromptInputs).toEqual({
        systemPrompt: replacement ?? "Recorded components",
      });
      expect(next.runState.taskClassification).toEqual(
        state.taskClassification,
      );
      await unchanged();
    });
  }

  it("refuses a continuation without recorded system-prompt inputs before a model request", async () => {
    delete state.systemPromptInputs;
    await save();
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("recorded system-prompt inputs");
    expect(requests).toHaveLength(0);
  });

  it("uses a cause-neutral interrupted-turn notice", () => {
    expect(HARNESS_CHAT_INTERRUPTED_TURN_NOTICE).toBe(
      "Host turn notice: the previous turn stopped before it finished. Its request above was interrupted, not answered; the work shown after it is what completed before it stopped.",
    );
  });
  it("seeds the first model request with prior history and excludes turn-local notices", async () => {
    await save([
      ...history,
      {
        role: "user",
        content: "Host turn budget: old",
        turnLocal: true,
      } as HarnessTranscriptMessage,
    ]);
    expect(await run()).toBe(0);
    expect(
      requests[0].transcript.filter((message) =>
        message.role !== "user" || !message.turnLocal
      ),
    ).toEqual([...history, {
      role: "user",
      content: "Next task",
    }]);
    expect(requests[0].model).toBe("gpt-recorded");
  });
  it("persists live notices and removes them from the following run", async () => {
    scripted = [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "read",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"/workspace/a"}' },
      }],
    }];
    expect(await run(["--allow-tool=read_file"])).toBe(0);
    const first = await nextArtifacts();
    expect(
      first.transcript?.some((message) =>
        message.role === "user" && message.turnLocal
      ),
    ).toBe(true);
    expect(await run([], first.runRoot)).toBe(0);
    expect(
      requests[2].transcript.filter((message) =>
        message.role === "user" && message.turnLocal
      ).every((message) => !message.content.startsWith("Host turn budget:")),
    ).toBe(true);
    expect(
      requests[2].transcript.some((message) =>
        message.content.startsWith("Host turn budget:")
      ),
    ).toBe(false);
    await unchanged();
  });
  it("retains unmarked notices from older artifacts as ordinary history", async () => {
    const legacyNotice: HarnessTranscriptMessage = {
      role: "user",
      content: "Host turn budget: old",
    };
    await save([...history, legacyNotice]);
    expect(await run()).toBe(0);
    expect(
      requests[0].transcript.filter((message) =>
        message.role !== "user" || !message.turnLocal
      ),
    ).toEqual([...history, legacyNotice, {
      role: "user",
      content: "Next task",
    }]);
  });
  for (
    const route of [
      "gateway-chat",
      "gateway-responses",
      "codex-responses",
    ] as const
  ) {
    it(`omits the persisted notice marker from ${route} provider requests`, async () => {
      const bodies: Record<string, unknown>[] = [];
      const response = {
        id: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        }],
      };
      const fetchFn: typeof fetch = (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          route === "codex-responses"
            ? new Response(
              `data: ${
                JSON.stringify({ type: "response.completed", response })
              }\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
            : new Response(JSON.stringify(
              route === "gateway-chat"
                ? {
                  choices: [{
                    message: { role: "assistant", content: "Done" },
                  }],
                }
                : response,
            )),
        );
      };
      const client = route === "codex-responses"
        ? new OpenAICodexResponsesClient({
          transportRetries: 0,
          fetchFn,
          credentialResolver: {
            resolve: () =>
              Promise.resolve({
                type: "oauth",
                providerId: "openai-codex",
                accessToken: "test",
                refreshToken: "test",
                accountId: "test",
                expiresAt: Date.now() + 60_000,
              }),
          },
        })
        : new OpenAICompatibleGatewayModelClient(
          new OpenAICompatibleGatewayClient({
            baseUrl: "https://gateway.test",
            authMode: "none",
            fetchFn,
          }),
        );
      await client.complete({
        model: route === "gateway-chat" ? "gemini-3.5-flash" : "gpt-5.4",
        runId: "notice",
        tools: [],
        nativeModelToolIds: [],
        transcript: [{
          role: "user",
          content: "A marked host notice",
          turnLocal: true,
        }],
      });
      expect(bodies).toHaveLength(1);
      const payload = JSON.stringify(bodies[0]);
      expect(payload).toContain("A marked host notice");
      expect(payload).not.toContain("turnLocal");
    });
  }
  it("cuts an unpaired tail and places the interrupted notice before the new prompt", async () => {
    await save([...history, unpaired]);
    expect(await run()).toBe(0);
    expect(
      requests[0].transcript.filter((message) =>
        message.role !== "user" || !message.turnLocal
      ),
    ).toEqual([...history, {
      role: "user",
      content: HARNESS_CHAT_INTERRUPTED_TURN_NOTICE,
    }, { role: "user", content: "Next task" }]);
    await unchanged();
  });
  it("refuses a run whose first tool call never reached a complete checkpoint", async () => {
    await save([history[0], history[1], unpaired]);
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("no complete checkpoint");
    expect(requests).toHaveLength(0);
  });
  it("resolves a handle retained from the prior run", async () => {
    const held = await mintAddressHandle(
      createHarnessHandleTable("prior"),
      "/of:fid1:rszomt4Ti8MwDNpMJLZCjcENRtAH6MFBxgf0wYVNCs8/title",
      { schema: { type: "string" } },
    );
    state.handleTable = held.table;
    await save();
    scripted = [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "describe",
        type: "function",
        function: {
          name: "describe_handle",
          arguments: JSON.stringify({ token: held.token }),
        },
      }],
    }];
    expect(await run(["--allow-tool=describe_handle"])).toBe(0);
    const tool = requests[1].transcript.find((m) => m.role === "tool");
    expect(JSON.parse(tool!.content)).toMatchObject({
      known: true,
      schema: { type: "string" },
    });
    expect((await nextArtifacts()).runState.handleTable?.salt).toBe("prior");
  });
  for (const interrupted of [false, true]) {
    it(
      interrupted
        ? "requires a fresh description before reading a handle after a truncated turn"
        : "reads a previously described handle after a complete transcript",
      async () => {
        const signer = await Identity.fromPassphrase(
          "continue described handle",
        );
        const storage = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: storage,
          cfcEnforcementMode: "disabled",
        });
        const pieces = new PiecesController(
          createSession({ identity: signer, spaceDid: signer.did() }),
          runtime,
        );
        fabric = { runtime, storage, session: { pieces } };
        await pieces.synced();
        const tx = runtime.edit();
        const cell = runtime.getCell(
          pieces.getSpace(),
          "continued-description",
          undefined,
          tx,
        );
        cell.set("checkpoint value");
        expect((await tx.commit().settled).ok).toBeDefined();
        const held = await mintAddressHandle(
          createHarnessHandleTable("prior"),
          createLLMFriendlyLink(
            cell.getAsNormalizedFullLink(),
            pieces.getSpace(),
          ),
          { schema: { type: "string" } },
        );
        state.handleTable = markHandleDescribed(held.table, held.token);
        const call = (id: string, name: string) => ({
          id,
          type: "function" as const,
          function: { name, arguments: JSON.stringify({ token: held.token }) },
        });
        const priorDescription: HarnessTranscriptMessage[] = [{
          role: "assistant",
          content: "",
          toolCalls: [
            call("prior-describe", "describe_handle"),
            ...(interrupted ? [call("unfinished", "read_value")] : []),
          ],
        }, {
          role: "tool",
          toolCallId: "prior-describe",
          toolName: "describe_handle",
          content: JSON.stringify({
            token: held.token,
            known: true,
            schema: { type: "string" },
          }),
        }];
        await save([...history, ...priorDescription]);
        scripted = [
          {
            role: "assistant",
            content: "",
            toolCalls: [call("first-read", "read_value")],
          },
          ...(interrupted
            ? [{
              role: "assistant" as const,
              content: "",
              toolCalls: [call("new-description", "describe_handle")],
            }, {
              role: "assistant" as const,
              content: "",
              toolCalls: [call("second-read", "read_value")],
            }]
            : []),
        ];
        expect(await run()).toBe(0);
        const output = (id: string) =>
          JSON.parse(
            requests.at(-1)!.transcript.find((message) =>
              message.role === "tool" && message.toolCallId === id
            )!.content,
          );
        if (interrupted) {
          expect(output("first-read")).toMatchObject({
            status: "error",
            message: expect.stringContaining("describe it first"),
          });
          expect(output("new-description")).toMatchObject({ known: true });
          expect(output("second-read")).toMatchObject({
            status: "ok",
            value: "checkpoint value",
          });
          expect(
            requests[0].transcript.some((message) =>
              message.role === "tool" && message.toolCallId === "prior-describe"
            ),
          ).toBe(false);
        } else {
          expect(output("first-read")).toMatchObject({
            status: "ok",
            value: "checkpoint value",
          });
        }
        await unchanged();
      },
    );
  }
  it("refuses explicit submit_result without an effective result contract", async () => {
    expect(await run(["--allow-tool=submit_result"])).toBe(1);
    expect(errors).toEqual([
      "--allow-tool submit_result requires --structured-result-path and a schema\n",
    ]);
    expect(requests).toHaveLength(0);
  });
  it("classifies an unreadable prior artifact directory as an internal host error", async () => {
    structuredHostFailures = true;
    const unreadable = join(priorRoot, "unreadable");
    await Deno.mkdir(unreadable);
    await Deno.chmod(unreadable, 0o000);
    const readDir = Deno.readDir.bind(Deno);
    const probe = stub(Deno, "readDir", (path) => {
      // The probe also enforces unreadability when tests run as root.
      if (path === unreadable) {
        throw new Deno.errors.PermissionDenied(
          "unreadable prior artifact directory",
        );
      }
      return readDir(path);
    });
    let exitCode: number;
    try {
      exitCode = await run();
    } finally {
      probe.restore();
      await Deno.chmod(unreadable, 0o700);
    }
    expect(exitCode).toBe(1);
    const failure = JSON.parse(errors[0]);
    expect(failure.error.code).toBe("internal-error");
    expect(failure.error.message).toBe(
      "The local cf-harness host operation failed",
    );
    expect(requests).toHaveLength(0);
    await unchanged();
  });
  it("classifies an outward artifact link as the same control refusal as a subagent source", async () => {
    structuredHostFailures = true;
    state.lineage = {
      role: "subagent",
      rootRunId: "root",
      parentRunId: "root",
      parentToolCallId: "call",
      depth: 1,
    };
    await save();
    expect(await run()).toBe(1);
    const subagentFailure = JSON.parse(errors[0]).error;
    expect(subagentFailure.code).toBe("provider-mismatch");
    delete state.lineage;
    await save();
    errors = [];
    const outside = join(workspace, "outside");
    const entry = join(priorRoot, "outward-link");
    await Deno.mkdir(outside);
    await Deno.symlink(outside, entry);
    expect(await run()).toBe(1);
    const outwardFailure = JSON.parse(errors[0]).error;
    expect(outwardFailure.code).toBe(subagentFailure.code);
    expect(outwardFailure.message).toContain(entry);
    expect(outwardFailure.message).toContain("outside its run root");
    expect(requests).toHaveLength(0);
    await unchanged();
  });
  it("classifies a missing prior run as an invalid host request", async () => {
    structuredHostFailures = true;
    expect(await run([], join(workspace, "missing"))).toBe(1);
    expect(JSON.parse(errors[0]).error.code).toBe("invalid-request");
    expect(requests).toHaveLength(0);
  });
  it("refuses an outward transcript link before reading its target", async () => {
    const outside = join(workspace, "saved-transcript.json");
    const transcript = join(priorRoot, "transcript.json");
    await Deno.rename(transcript, outside);
    await Deno.symlink(outside, transcript);
    const bytes = await Deno.readTextFile(outside);
    const opened: (string | URL)[] = [];
    const readTextFile = Deno.readTextFile.bind(Deno);
    const probe = stub(Deno, "readTextFile", (path) => {
      if (path === transcript || path === outside) opened.push(path);
      return readTextFile(path);
    });
    let exitCode: number;
    try {
      exitCode = await run(["--result-json-path", outside]);
    } finally {
      probe.restore();
    }
    expect(exitCode).toBe(1);
    expect(errors.join("")).toContain("artifact entry");
    expect(errors.join("")).toContain(transcript);
    expect(errors.join("")).toContain("outside its run root");
    expect(opened).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(await Deno.readTextFile(outside)).toBe(bytes);
  });
  it("refuses an unreadable outward tree without opening it", async () => {
    const outside = join(workspace, "outside-tree");
    const unreadable = join(outside, "unreadable");
    await Deno.mkdir(unreadable, { recursive: true });
    await Deno.chmod(unreadable, 0o000);
    await Deno.symlink(outside, join(priorRoot, "linked-artifacts"));
    const opened: string[] = [];
    const readDir = Deno.readDir.bind(Deno);
    const probe = stub(Deno, "readDir", (path) => {
      if (path === outside || path === unreadable) opened.push(path);
      // The probe also enforces unreadability when tests run as root.
      if (path === unreadable) {
        throw new Deno.errors.PermissionDenied("unreadable subtree");
      }
      return readDir(path);
    });
    let exitCode: number;
    try {
      exitCode = await run();
    } finally {
      probe.restore();
      await Deno.chmod(unreadable, 0o700);
    }
    expect(exitCode).toBe(1);
    expect(errors.join("")).toContain(join(priorRoot, "linked-artifacts"));
    expect(errors.join("")).toContain("outside its run root");
    expect(opened).toEqual([]);
    expect(requests).toHaveLength(0);
    await unchanged();
  });
  it("refuses an outward artifact-directory link without opening it", async () => {
    const outside = join(workspace, "saved-artifacts");
    const entry = join(priorRoot, "linked-artifacts");
    await Deno.mkdir(outside);
    await Deno.symlink(outside, entry);
    const opened: (string | URL)[] = [];
    const readDir = Deno.readDir.bind(Deno);
    const probe = stub(Deno, "readDir", (path) => {
      if (path === outside) opened.push(path);
      return readDir(path);
    });
    let exitCode: number;
    try {
      exitCode = await run(["--artifact-root", join(outside, "new-output")]);
    } finally {
      probe.restore();
    }
    expect(exitCode).toBe(1);
    expect(errors.join("")).toContain(entry);
    expect(errors.join("")).toContain("outside its run root");
    expect(opened).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(Array.from(Deno.readDirSync(outside))).toEqual([]);
    await unchanged();
  });
  it("refuses a dotted output name inside an unaltered prior root", async () => {
    expect(await run(["--artifact-root", join(priorRoot, "..new-output")]))
      .toBe(1);
    expect(errors.join("")).toContain("must not modify the prior run");
    expect(requests).toHaveLength(0);
    await unchanged();
  });
  it("continues with an internal transcript link and directory-link cycle", async () => {
    const transcript = join(priorRoot, "transcript.json");
    const saved = join(priorRoot, "saved-transcript.json");
    await Deno.rename(transcript, saved);
    await Deno.symlink(saved, transcript);
    await Deno.symlink(priorRoot, join(priorRoot, "cycle"));
    expect(await run()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(
      requests[0].transcript.filter((message) =>
        message.role !== "user" || !message.turnLocal
      ),
    ).toEqual([...history, {
      role: "user",
      content: "Next task",
    }]);
    await unchanged();
  });
  for (const priorSubmitTool of [false, true]) {
    for (const replaceSystem of [false, true]) {
      it(`rebuilds result instructions for the new path with ${priorSubmitTool ? "submission" : "file-writing"} history${replaceSystem ? " and a replacement system prompt" : ""}`, async () => {
        state.structuredResult = {
          schema: { type: "string" },
          path: join(workspace, "old-result.json"),
        };
        await Deno.writeTextFile(state.structuredResult.path, '"prior result"');
        state.systemPromptInputs = {
          systemPrompt: "Keep this user instruction.",
        };
        const sourceSystem = buildCfHarnessBatchSystemPrompt({
          structuredResult: {
            ...state.structuredResult,
            sandboxPath: "/workspace/old-result.json",
          },
          allowedToolIds: priorSubmitTool ? undefined : ["bash"],
          systemPrompt: "Keep this user instruction.",
        });
        await save([
          { role: "system", content: sourceSystem },
          ...history.slice(1),
        ]);
        const flags = [
          "--structured-result-path",
          join(workspace, "new-result.json"),
          "--allow-tool=bash",
          ...(replaceSystem
            ? ["--system-prompt=Replacement user instruction."]
            : []),
        ];
        expect(await run(flags)).toBe(1);
        expect(requests).toHaveLength(1);
        const system = requests[0].transcript.filter((message) =>
          message.role === "system"
        ).map((message) => message.content).join("\n");
        expect(system).toContain("/workspace/new-result.json");
        expect(system).not.toContain("old-result.json");
        expect(system).toContain(
          replaceSystem
            ? "Replacement user instruction."
            : "Keep this user instruction.",
        );
        expect(await Deno.readTextFile(state.structuredResult.path)).toBe(
          '"prior result"',
        );
        await unchanged();
      });
    }
  }
  it("validates a new result with the carried schema and leaves the old result unchanged", async () => {
    const priorResult = join(priorRoot, "result.json");
    await Deno.writeTextFile(priorResult, '{"answer":"old"}\n');
    state.structuredResult = {
      path: priorResult,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    };
    await save();
    const submit = (
      id: string,
      result: unknown,
    ): HarnessAssistantTranscriptMessage => ({
      role: "assistant",
      content: "",
      toolCalls: [{
        id,
        type: "function",
        function: {
          name: "submit_result",
          arguments: JSON.stringify({ result }),
        },
      }],
    });
    scripted = [
      submit("invalid", { answer: 1 }),
      submit("valid", { answer: "new" }),
    ];
    const path = join(workspace, "next-result.json");
    expect(await run(["--structured-result-path", path])).toBe(0);
    expect(
      JSON.parse(
        requests[1].transcript.findLast((m) => m.role === "tool")!.content,
      ),
    ).toMatchObject({ code: "invalid_result" });
    expect(JSON.parse(await Deno.readTextFile(path))).toEqual({
      answer: "new",
    });
    expect((await nextArtifacts()).runState.structuredResult).toEqual({
      schema: state.structuredResult.schema,
      path,
    });
    await unchanged();
  });
  for (
    const target of [
      "prior-result",
      "prior-transcript",
      "nested-artifact-root",
    ] as const
  ) {
    it(`refuses a new output targeting ${target}`, async () => {
      const oldPath = join(workspace, "old-result.json");
      await Deno.writeTextFile(oldPath, '"old"');
      state.structuredResult = { schema: { type: "string" }, path: oldPath };
      await save();
      const alias = join(workspace, "result-alias.json");
      await Deno.symlink(oldPath, alias);
      const flags = target === "prior-result"
        ? ["--structured-result-path", alias]
        : target === "prior-transcript"
        ? ["--structured-result-path", join(priorRoot, "transcript.json")]
        : ["--artifact-root", join(priorRoot, "nested")];
      expect(await run(flags)).toBe(1);
      expect(errors.join("")).toContain("prior run");
      expect(requests).toHaveLength(0);
      expect(await Deno.readTextFile(oldPath)).toBe('"old"');
      await unchanged();
    });
  }
  for (
    const digest of ["valueDigest", "slotDigest", "snapshotDigest"] as const
  ) {
    it(`refuses a recorded ${digest} before any model request`, async () => {
      state.promptSlotBinding = {
        type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
        source: { type: "test", subject: "prior" },
        role: "direct-command",
        kernelName: "cf-harness",
        surface: "test",
        subject: "prior",
        eventId: "prior-binding",
        [digest]: "sha256:prior",
      };
      await save();
      expect(await run()).toBe(1);
      expect(errors.join("")).toContain(
        "cannot continue a digest-bound prompt-slot binding",
      );
      expect(errors.join("")).toContain("bind one exact prompt value");
      expect(requests).toHaveLength(0);
      await unchanged();
    });
  }
  it("refuses a broader read ceiling before any model request", async () => {
    state.runManifest = {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      cfc: { maxConfidentiality: [] },
    };
    await save();
    const manifest = join(workspace, "manifest.json");
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({
        ...state.runManifest,
        cfc: { maxConfidentiality: [{ anyOf: [{ type: "secret" }] }] },
      }),
    );
    expect(await run(["--run-manifest", manifest])).toBe(1);
    expect(errors.join("")).toContain("read ceiling mismatch");
    expect(requests).toHaveLength(0);
  });
  it("uses its own default result path", async () => {
    const oldPath = join(priorRoot, "result.json");
    await Deno.writeTextFile(oldPath, '"old"');
    state.structuredResult = { schema: { type: "string" }, path: oldPath };
    await save();
    scripted = [{
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "result",
        type: "function",
        function: { name: "submit_result", arguments: '{"result":"new"}' },
      }],
    }];
    expect(await run()).toBe(0);
    const next = await nextArtifacts();
    expect(next.runState.structuredResult?.path).toBe(
      join(next.runRoot, "result.json"),
    );
    expect(await Deno.readTextFile(next.runState.structuredResult!.path)).toBe(
      '"new"\n',
    );
    await unchanged();
  });
  it("retains CFC context, research, and the prior prompt-slot binding explicitly", async () => {
    state.cfcModelContext = {
      type: "cf-harness.cfc-model-context",
      version: 1,
      updatedAt: state.updatedAt,
      label: { confidentiality: [] },
      observations: [],
    };
    state.promptSlotBinding = {
      type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
      role: "context",
      kernelName: "cf-harness",
      surface: "test",
      subject: "prior",
      eventId: "prior-binding",
      source: { type: "test", subject: "prior" },
    };
    state.researchGoal = "Original research goal";
    await save();
    expect(await run()).toBe(0);
    const next = (await nextArtifacts()).runState;
    expect(next.cfcModelContext).toEqual(state.cfcModelContext);
    expect(next.promptSlotBinding).toEqual(state.promptSlotBinding);
    expect(next.researchGoal).toBe(state.researchGoal);
  });
  it("continues a continued root run and keeps its root lineage", async () => {
    state.lineage = {
      role: "continuation",
      rootRunId: "first",
      parentRunId: "previous",
    };
    await save();
    expect(await run([], join(priorRoot, "run-state.json"))).toBe(0);
    expect((await nextArtifacts()).runState.lineage).toEqual({
      role: "continuation",
      rootRunId: "first",
      parentRunId: "prior",
    });
  });
  it("accepts a prompt file and positional text", async () => {
    const promptFile = join(workspace, "prompt.txt");
    await Deno.writeTextFile(promptFile, "From file");
    expect(await run([], priorRoot, ["--prompt-file", promptFile])).toBe(0);
    expect(requests[0].transcript.at(-1)?.content).toBe("From file");
    expect(await run([], priorRoot, ["From", "positionals"])).toBe(0);
    expect(requests[1].transcript.at(-1)?.content).toBe("From positionals");
    await unchanged();
  });
  it("refuses missing transcript data before any model request", async () => {
    await Deno.remove(join(priorRoot, "transcript.json"));
    expect(await run()).toBe(1);
    expect(errors.join("")).toContain("no complete checkpoint");
    expect(requests).toHaveLength(0);
  });
  for (
    const [flag, value] of [
      ["--skill", "review"],
      ["--task-tags", "find"],
      ["--task-domains", "web"],
    ]
  ) {
    it(`refuses ${flag} when continuing`, async () => {
      expect(await run([flag, value])).toBe(1);
      expect(errors.join("")).toContain("not supported with");
      expect(requests).toHaveLength(0);
    });
  }
  for (const additionalInstructions of ["New instructions", ""]) {
    it(`rebuilds harness guidance with ${additionalInstructions === "" ? "empty" : "new"} additional instructions`, async () => {
      state.systemPromptInputs = {
        systemPrompt: "Prior additional instructions",
      };
      state.structuredResult = {
        schema: { type: "string" },
        path: join(workspace, "old-result.json"),
      };
      await Deno.writeTextFile(state.structuredResult.path, '"prior result"');
      await save([
        {
          role: "system",
          content: buildCfHarnessBatchSystemPrompt({
            structuredResult: {
              ...state.structuredResult,
              sandboxPath: "/workspace/old-result.json",
            },
            systemPrompt: "Prior additional instructions",
          }),
        },
        ...history.slice(1),
      ]);
      const resultPath = join(workspace, "new-result.json");
      await Deno.writeTextFile(resultPath, '"next result"');
      expect(
        await run([
          `--system-prompt=${additionalInstructions}`,
          "--structured-result-path",
          resultPath,
          "--allow-tool=bash",
        ]),
      ).toBe(0);
      expect(requests).toHaveLength(1);
      const systems = requests[0].transcript.filter((message) =>
        message.role === "system"
      );
      expect(systems).toHaveLength(1);
      const system = systems[0].content;
      expect(system).toContain(
        "You are cf-harness, an autonomous agent harness",
      );
      expect(system).toContain("Operator guidance for cf-harness runs:");
      expect(system).toContain("/workspace/new-result.json");
      expect(system).not.toContain("old-result.json");
      expect(system).not.toContain("Prior additional instructions");
      if (additionalInstructions === "") {
        expect(system).not.toContain("Additional instructions:");
      } else {
        expect(system).toContain(
          `Additional instructions:\n${additionalInstructions}`,
        );
      }
      expect(await Deno.readTextFile(state.structuredResult.path)).toBe(
        '"prior result"',
      );
      await unchanged();
    });
  }
  for (
    const [name, extra, mutate, message] of [
      ["subagent", [], () => {
        state.lineage = {
          role: "subagent",
          rootRunId: "root",
          parentRunId: "root",
          parentToolCallId: "call",
          depth: 1,
        };
      }, "subagent"],
      [
        "model switch",
        ["--model=different"],
        () => {},
        "continue model mismatch",
      ],
      [
        "provider switch",
        ["--model-provider=openai-codex"],
        () => {},
        "continue provider mismatch",
      ],
    ] as const
  ) {
    it(`refuses a ${name} before any model request`, async () => {
      mutate();
      await save();
      expect(await run([...extra])).toBe(1);
      expect(errors.join("")).toContain(message);
      expect(requests).toHaveLength(0);
    });
  }
  it("refuses a missing run root", async () => {
    expect(await run([], join(workspace, "missing"))).toBe(1);
    expect(errors.join("")).toContain("No such file");
    expect(requests).toHaveLength(0);
  });
  for (
    const [name, argv, message] of [
      ["missing prompt", [], "prompt is required"],
      [
        "resume and continue together",
        ["--resume-run", "/tmp/prior"],
        "--resume-run",
      ],
    ]
  ) {
    it(`refuses ${name}`, async () => {
      const code = await runCfHarnessCli(
        ["--continue-run", priorRoot, ...argv],
        {
          cwd: workspace,
          env: {},
          io: { stdout: () => {}, stderr: (text) => errors.push(text) },
        },
      );
      expect(code).toBe(1);
      expect(errors.join("")).toContain(message);
      expect(requests).toHaveLength(0);
    });
  }
});
