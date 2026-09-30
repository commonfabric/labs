import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createCfHarnessCliCapabilities } from "../src/cli.ts";
import { createHarnessChatSessionStatus } from "../src/contracts/interactive-chat.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { getHarnessSubagentProfileConfig } from "../src/contracts/subagent.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { OpenAICompatibleGatewayClient } from "../src/gateway/openai-client.ts";
import {
  codexSearchSources,
  searchSourceSummary,
} from "../src/model/codex-search-evidence.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { OpenAICompatibleGatewayModelClient } from "../src/model/openai-compatible-gateway.ts";
import {
  normalizeTerminalResponse,
  toResponsesInput,
} from "../src/model/responses-protocol.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { openSqliteHarnessChatSessionStore } from "../src/sqlite-session-store.ts";

const model = "gpt-5.6-terra";
const provider = "openai-codex";
const owner = {
  type: "cf-harness.credential-owner-ref" as const,
  version: 1 as const,
  ownerKey: "synthetic-owner",
};
const sandbox: SandboxRuntime = {
  describe: () => ({
    kind: "docker-runsc-cfc",
    defaultWorkingDirectory: "/workspace",
    cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
  }),
  resolvePath: (path) => path.startsWith("/") ? path : `/workspace/${path}`,
  isPathWithinWorkspace: (
    path,
  ) => (path === "/workspace" || path.startsWith("/workspace/")),
  isPathWithinAllowedRoots: (
    path,
  ) => (path === "/workspace" || path.startsWith("/workspace/")),
  defaultWorkingDirectory: () => "/workspace",
  run: () => Promise.reject(new Error("unexpected sandbox command")),
  runShell: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
};
const searchOutput = [
  { type: "reasoning", id: "rs_one", encrypted_content: "synthetic-reasoning" },
  {
    type: "web_search_call",
    id: "ws_one",
    status: "completed",
    action: { type: "search", query: "synthetic public source" },
  },
  {
    type: "message",
    id: "msg_one",
    role: "assistant",
    status: "completed",
    content: [{
      type: "output_text",
      text: "A sourced answer.",
      annotations: [{
        type: "url_citation",
        start_index: 0,
        end_index: 16,
        url: "https://example.test/source",
        title: "Example source",
      }],
    }],
  },
];
const terminal = (output: unknown[]) => ({ status: "completed", output });
const sse = (output: unknown[]) =>
  new Response(
    [...output.map((item) => ({ type: "response.output_item.done", item })), {
      type: "response.completed",
      response: terminal([]),
    }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

describe("codex-native-search", () => {
  for (const structured of [false, true]) {
    it(`delegates ${structured ? "structured" : "plain"} search with the parent model, owner, and provider`, async () => {
      const requests: Record<string, unknown>[] = [];
      const client = new OpenAICodexResponsesClient({
        transportRetries: 0,
        credentialResolver: {
          credentialOwner: owner,
          resolve: () =>
            Promise.resolve({
              type: "oauth",
              providerId: provider,
              accessToken: "synthetic-access",
              refreshToken: "synthetic-refresh",
              accountId: "synthetic-account",
              expiresAt: Date.now() + 60000,
            }),
        },
        fetchFn: (url, init) => {
          expect(String(url)).toBe(
            "https://chatgpt.com/backend-api/codex/responses",
          );
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer synthetic-access",
          );
          const body = JSON.parse(String(init?.body));
          requests.push(body);
          if (requests.length === 1) {
            return Promise.resolve(sse([{
              type: "function_call",
              id: "fc_delegate",
              call_id: "delegate_one",
              name: "delegate_task",
              arguments: JSON.stringify({
                goal: "Find a public source.",
                profile: "web_search",
                ...(structured
                  ? {
                    returnSchema: {
                      type: "object",
                      properties: { answer: { type: "string" } },
                      required: ["answer"],
                      additionalProperties: false,
                    },
                  }
                  : {}),
              }),
            }]));
          }
          if (requests.length === 2 && body.tools?.[0]?.type === "web_search") {
            const output = structuredClone(searchOutput);
            if (structured) {
              output[2].content![0].text = JSON.stringify({
                answer: "A sourced answer.",
              });
            }
            return Promise.resolve(sse(output));
          }
          return Promise.resolve(sse([{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Parent finished." }],
          }]));
        },
      });
      const loop = new CfHarnessPromptLoop({
        modelClient: client,
        allowedToolIds: ["delegate_task"],
        allowedSubagentProfiles: ["web_search"],
        engine: new CfHarnessEngine({
          sandboxRuntime: sandbox,
          runId: "synthetic-native-search",
          model,
          modelProvider: provider,
          credentialOwnerKey: owner.ownerKey,
          credentialOwner: owner,
        }),
      });
      const result = await loop.runPrompt({
        prompt: "Find a public source.",
        promptSlotBinding: {
          type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
          role: "direct-command",
          source: { type: "synthetic", subject: "search" },
          kernelName: "cf-harness",
          surface: "test",
          subject: "search",
          eventId: "one",
        },
      });
      expect(requests).toHaveLength(3);
      expect(requests.map((r) => r.model)).toEqual([model, model, model]);
      expect(requests[1].tools).toEqual([{
        type: "web_search",
        external_web_access: true,
      }]);
      const child = result.runState.subagentRuns?.[0];
      expect(child?.manifest.modelProvider).toBe(provider);
      expect(child?.manifest.credentialOwner).toEqual(owner);
      expect(child?.manifest.modelSource).toBe("parent");
      expect(child?.manifest.allowedToolIds).toEqual([]);
      expect(child?.manifest.hostToolIds).toEqual([]);
      expect(child?.manifest.nativeModelToolIds).toEqual(["openai_web_search"]);
      const policy = result.runState.cfcPolicySnapshot?.subagents.profileConfigs
        .find((p) => p.profile === "web_search");
      expect(policy?.modelOverride).toBeUndefined();
      expect(policy?.nativeModelToolIds).toEqual(["openai_web_search"]);
      expect(policy?.allowedToolIds).toEqual([]);
      const toolMessage = result.transcript.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("https://example.test/source");
      expect(toolMessage?.content).toContain("openai_web_search");
      const returned = JSON.parse(toolMessage!.content).subagent;
      expect(returned.status).toBe("completed");
      expect(returned.nativeModelToolResults[0].sources).toEqual([{
        url: "https://example.test/source",
        title: "Example source",
      }]);
      if (structured) expect(returned.structuredReturn).toBeDefined();
      else {expect(returned.summary).toContain(
          "[Example source](<https://example.test/source>)",
        );}
      expect(JSON.stringify(requests[2].input)).toContain(
        "https://example.test/source",
      );
    });
  }

  it("retains search evidence and replays provider items in order", async () => {
    const assistant = normalizeTerminalResponse(
      terminal(searchOutput),
      model,
      provider,
      "test",
    );
    expect(JSON.stringify(assistant.nativeModelToolResults)).toContain(
      "https://example.test/source",
    );
    const input = await toResponsesInput([assistant], model, provider, "test");
    expect(input.input).toEqual(searchOutput);
  });

  it("reconstructs edited assistant text without stale sources", async () => {
    const assistant = normalizeTerminalResponse(
      terminal(searchOutput),
      model,
      provider,
      "test",
    );
    const edited = { ...assistant, content: "Filtered answer." };
    const input = await toResponsesInput([edited], model, provider, "test");
    expect(JSON.stringify(input.input)).not.toContain("example.test/source");
    expect(JSON.stringify(input.input)).not.toContain("A sourced answer.");
    expect(JSON.stringify(input.input)).toContain("Filtered answer.");
  });

  it("does not resurrect native evidence a host edited before persisting and resuming", async () => {
    const assistant = normalizeTerminalResponse(
      terminal(searchOutput),
      model,
      provider,
      "test",
    );
    const native = assistant.nativeModelToolResults![0];
    if (native.toolId !== "openai_web_search") {
      throw new Error("Expected Codex evidence");
    }
    const edits = [
      { ...assistant, nativeModelToolResults: [] },
      { ...assistant, nativeModelToolResults: [{ ...native, sources: [] }] },
      {
        ...assistant,
        nativeModelToolResults: [{
          ...native,
          providerMetadata: {
            searchCalls: [{
              ...native.providerMetadata.searchCalls[0],
              action: { type: "search", query: "Host-filtered query" },
            }],
          },
        }],
      },
    ];
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const store = await openSqliteHarnessChatSessionStore({
      url: toFileUrl(path),
    });
    const requests: Record<string, unknown>[] = [];
    const client = new OpenAICodexResponsesClient({
      credentialResolver: {
        credentialOwner: owner,
        resolve: () =>
          Promise.resolve({
            type: "oauth",
            providerId: provider,
            accessToken: "synthetic-access",
            refreshToken: "synthetic-refresh",
            accountId: "synthetic-account",
            expiresAt: Date.now() + 60000,
          }),
      },
      fetchFn: (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Promise.resolve(sse([{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Continued." }],
        }]));
      },
    });
    try {
      for (const [i, edited] of edits.entries()) {
        const sessionId = `edited-search-${i}`;
        store.saveSession({
          session: createHarnessChatSessionStatus({
            sessionId,
            createdAt: "2026-09-15T00:00:00Z",
            workspace: { hostPath: "/workspace" },
          }),
          transcript: [edited],
        });
        const restored = store.getSession(sessionId)!.transcript;
        expect(restored).toEqual([edited]);
        await client.complete({
          model,
          transcript: restored,
          tools: [],
          runId: sessionId,
          nativeModelToolIds: [],
        });
        const input = JSON.stringify(requests.at(-1)!.input);
        expect(input).toContain("A sourced answer.");
        expect(input).not.toContain("web_search_call");
        expect(input).not.toContain("url_citation");
        expect(input).not.toContain("example.test/source");
      }
    } finally {
      store.close();
      await Deno.remove(path);
    }
  });

  it("keeps gateway profiles and provider capabilities distinct", () => {
    expect(getHarnessSubagentProfileConfig("web_search")).toMatchObject({
      modelOverride: "gemini-3.5-flash",
      nativeModelToolIds: ["google_search"],
    });
    const capabilities = createCfHarnessCliCapabilities();
    expect(capabilities.nativeModelToolIdsByProvider).toEqual({
      "openai-codex": ["openai_web_search"],
      "openai-compatible-gateway": ["google_search"],
    });
    expect(capabilities.nativeModelToolIds).toEqual([
      "google_search",
      "openai_web_search",
    ]);
  });

  it("rejects unsupported native tools before resolving credentials or making requests", async () => {
    const client = new OpenAICodexResponsesClient({
      credentialResolver: {
        credentialOwner: owner,
        resolve: () => {
          throw new Error("credential boundary reached");
        },
      },
      fetchFn: () => {
        throw new Error("network boundary reached");
      },
    });
    await expect(
      client.complete({
        model,
        transcript: [],
        tools: [],
        nativeModelToolIds: ["google_search"],
        runId: "synthetic",
      }),
    ).rejects.toThrow("does not support native tools");
    const gateway = new OpenAICompatibleGatewayModelClient(
      new OpenAICompatibleGatewayClient({
        baseUrl: "https://gateway.test",
        authMode: "none",
        fetchFn: () => {
          throw new Error("gateway boundary reached");
        },
      }),
    );
    await expect(
      gateway.complete({
        model: "gemini-3.5-flash",
        transcript: [],
        tools: [],
        nativeModelToolIds: ["openai_web_search"],
        runId: "synthetic",
      }),
    ).rejects.toThrow("does not support native tool openai_web_search");
  });

  it("replays mixed search, messages, and function calls once and reconstructs changed calls", async () => {
    const call = {
      type: "function_call",
      id: "fc_one",
      call_id: "call_one",
      name: "read_file",
      arguments: '{"path":"one"}',
    };
    const output = [...searchOutput, call];
    const assistant = normalizeTerminalResponse(
      terminal(output),
      model,
      provider,
      "test",
    );
    const tool = {
      role: "tool" as const,
      toolCallId: "call_one",
      toolName: "read_file",
      content: "result",
    };
    const input = await toResponsesInput(
      [assistant, tool],
      model,
      provider,
      "test",
    );
    expect(input.input).toEqual([...output, {
      type: "function_call_output",
      call_id: "call_one",
      output: "result",
    }]);
    for (
      const calls of [[], [{
        ...assistant.toolCalls![0],
        id: "changed_call",
        function: { name: "changed_reader", arguments: '{"path":"two"}' },
      }]]
    ) {
      const edited = { ...assistant, toolCalls: calls };
      const reconstructed = await toResponsesInput(
        [edited],
        model,
        provider,
        "test",
      );
      expect(JSON.stringify(reconstructed.input)).not.toContain("url_citation");
      expect(JSON.stringify(reconstructed.input)).not.toContain(
        "web_search_call",
      );
      expect(
        reconstructed.input.filter((i) => i.type === "function_call").map(
          ({ call_id, name, arguments: args }) => ({
            call_id,
            name,
            arguments: args,
          }),
        ),
      ).toEqual(calls.map((editedCall) => ({
        call_id: editedCall.id,
        name: editedCall.function.name,
        arguments: editedCall.function.arguments,
      })));
      expect(edited.nativeModelToolResults).toEqual(
        assistant.nativeModelToolResults,
      );
    }
  });

  it("does not replay another model's or provider's search state", async () => {
    const assistant = normalizeTerminalResponse(
      terminal(searchOutput),
      model,
      provider,
      "test",
    );
    await expect(toResponsesInput([assistant], "gpt-other", provider, "test"))
      .rejects.toThrow("does not match");
    const dropped = await toResponsesInput(
      [assistant],
      "gpt-other",
      provider,
      "test",
      undefined,
      "drop",
    );
    const foreign = await toResponsesInput(
      [assistant],
      model,
      "openai-compatible-gateway",
      "test",
    );
    for (const result of [dropped, foreign]) {
      expect(JSON.stringify(result.input)).not.toContain("web_search_call");
      expect(JSON.stringify(result.input)).not.toContain("example.test/source");
      expect(result.input[0].content).toEqual([{
        type: "output_text",
        text: "A sourced answer.",
        annotations: [],
      }]);
    }
  });

  it("restores v1 continuations and SQLite search history without duplicating the answer", async () => {
    const assistant = normalizeTerminalResponse(
      terminal(searchOutput),
      model,
      provider,
      "test",
    );
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const store = await openSqliteHarnessChatSessionStore({
      url: toFileUrl(path),
    });
    try {
      store.saveSession({
        session: createHarnessChatSessionStatus({
          sessionId: "search",
          createdAt: "2026-09-15T00:00:00Z",
          workspace: { hostPath: "/workspace" },
        }),
        transcript: [assistant],
      });
      const restored = store.getSession("search")!.transcript;
      expect(restored).toEqual([assistant]);
      const input = await toResponsesInput(restored, model, provider, "test");
      expect(input.input).toEqual(searchOutput);
    } finally {
      store.close();
      await Deno.remove(path);
    }
    const old = {
      role: "assistant" as const,
      content: "Old answer",
      providerContinuation: {
        providerId: provider,
        state: { version: 1, sourceModel: model, output: [searchOutput[0]] },
      },
    };
    const input = await toResponsesInput([old], model, provider, "test");
    expect(input.input[0]).toEqual(searchOutput[0]);
    expect(input.input.filter((i) => i.type === "message")).toHaveLength(1);
  });

  it("preserves source evidence while bounding and escaping the summary footer", () => {
    const output = [{
      type: "message",
      content: [{
        type: "output_text",
        annotations: [
          { type: "url_citation", url: "javascript:alert(1)", title: "no" },
          {
            type: "url_citation",
            url: "https://user:secret@example.test/private",
            title: "no",
          },
          ...Array.from(
            { length: 40 },
            (_, i) => ({
              type: "url_citation",
              url: `https://example.test/${i}`,
              title: "Title [injected](bad)\n" + "a".repeat(400),
            }),
          ),
        ],
      }],
    }];
    const sources = codexSearchSources(output);
    expect(sources).toHaveLength(40);
    const summary = searchSourceSummary([{
      type: "cf-harness.native-model-tool-result",
      toolId: "openai_web_search",
      provider,
      providerMetadata: { searchCalls: [] },
      sources,
    }]);
    expect(summary.split("\n- ")).toHaveLength(33);
    expect(summary).not.toContain("Title [injected]");
    expect(summary).not.toContain("javascript:");
    expect(summary).not.toContain("secret");
    expect(summary.length).toBeLessThan(12000);
  });
  it("bounds the entire source footer without cutting links and reports omissions", () => {
    const sources = Array.from({ length: 32 }, (_, index) => ({
      url: `https://example.test/${index}/` + "x".repeat(4050),
      title: "Long source " + index,
    }));
    sources.push({ url: "https://example.test/short", title: "Short source" });
    const summary = searchSourceSummary([{
      type: "cf-harness.native-model-tool-result",
      toolId: "openai_web_search",
      provider,
      providerMetadata: { searchCalls: [] },
      sources,
    }]);
    expect(summary.length).toBeLessThanOrEqual(12000);
    expect(summary).toContain("omitted");
    expect(summary).toContain("https://example.test/short");
    const links = summary.split("\n").filter((line) => line.startsWith("- ["));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(
        sources.some((source) =>
          link === `- [${source.title}](<${source.url}>)`
        ),
      ).toBe(true);
    }
    expect(sources).toHaveLength(33);
  });

  it("retains citation-only follow-up answers after an earlier search", async () => {
    const output = [searchOutput[2]];
    const assistant = normalizeTerminalResponse(
      terminal(output),
      model,
      provider,
      "test",
    );
    expect(assistant.nativeModelToolResults?.[0].sources).toEqual([{
      url: "https://example.test/source",
      title: "Example source",
    }]);
    expect((await toResponsesInput([assistant], model, provider, "test")).input)
      .toEqual(output);
  });

  it("reconstructs current text when optional search replay state is malformed", async () => {
    const assistant = normalizeTerminalResponse(
      terminal(searchOutput),
      model,
      provider,
      "test",
    );
    for (
      const output of [[null], [{
        type: "message",
        content: [{ type: "output_text", text: "Stale replacement" }],
      }]]
    ) {
      const broken = {
        ...assistant,
        providerContinuation: {
          providerId: provider,
          state: {
            ...(assistant.providerContinuation!.state as Record<
              string,
              unknown
            >),
            searchOutput: output,
          },
        },
      };
      const restored =
        (await toResponsesInput([broken], model, provider, "test")).input;
      expect(JSON.stringify(restored)).toContain("A sourced answer.");
      expect(JSON.stringify(restored)).not.toContain("Stale replacement");
      expect(JSON.stringify(restored)).not.toContain("url_citation");
    }
  });
});
